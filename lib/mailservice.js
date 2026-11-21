/**
 * MailService — every email operation the agent tools and the settings page
 * share. One implementation, two callers; the UI never holds a password and
 * the tools never receive one.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { ImapClient, formatImapDate } from './imap.js'
import { SmtpClient } from './smtp.js'
import { buildMessage, parseMessage, quoteReply, replyReferences } from './mime.js'
import { PROVIDERS, PROVIDER_IDS, guessProvider, resolveEndpoints, validateEndpoints } from './providers.js'
import { describeRoute, isDirect, parseProxy } from './proxy.js'
import { AccountError, AccountStore, PasswordVault, newAccountId } from './accounts.js'

const DEFAULT_MAILBOX = 'INBOX'

/** Content types guessed by extension for outgoing attachments. */
const CONTENT_TYPES = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.eml': 'message/rfc822',
  '.pcap': 'application/vnd.tcpdump.pcap',
  '.pcapng': 'application/vnd.tcpdump.pcap',
}

/** Escape one IMAP quoted string. */
function imapQuote(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')}"`
}

/** Whether a criterion needs CHARSET UTF-8. */
function isAscii(text) {
  // eslint-disable-next-line no-control-regex
  return !/[^\x00-\x7f]/.test(text)
}

/** ISO date (YYYY-MM-DD, or anything Date can read) -> IMAP date. */
function toImapDate(value, label) {
  const text = String(value ?? '').trim()
  if (text === '') return undefined
  const direct = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text)
  if (direct !== null) return text
  const date = new Date(text.length === 10 ? `${text}T00:00:00Z` : text)
  if (Number.isNaN(date.getTime())) throw new AccountError(`无法解析 ${label} 日期: ${text}`, 'BAD_DATE')
  return formatImapDate(date)
}

/** Turn a tool's account fields into one connected IMAP/SMTP client's options. */
function endpointOptions(endpoint, credentials, route) {
  return {
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure === true,
    starttls: endpoint.starttls === true && endpoint.secure !== true,
    rejectUnauthorized: endpoint.rejectUnauthorized !== false,
    username: credentials.username,
    password: credentials.password,
    sendId: endpoint.sendId === true,
    proxy: route?.proxy ?? '',
    bypass: route?.bypass ?? [],
  }
}

/** Remove `\Seen` bookkeeping from flags for display. */
function normalizeFlags(flags) {
  return Array.isArray(flags) ? flags.map(flag => String(flag).replace(/^\\/, '').toLowerCase()) : []
}

/** Stages that mean "the network route failed", as opposed to bad credentials. */
const TRANSPORT_STAGES = new Set(['connect', 'greeting', 'starttls'])
const TRANSPORT_CODES = new Set(['IMAP_CONNECT', 'SMTP_CONNECT', 'IMAP_TIMEOUT', 'SMTP_TIMEOUT'])

/**
 * Whether an error happened before any protocol work, so another route may work.
 * An authentication failure is never a route problem and must not be retried.
 * @param {unknown} error thrown error
 * @returns {boolean} true when a different route is worth trying
 */
function isTransportFailure(error) {
  if (error === null || typeof error !== 'object') return false
  if (error.code === 'IMAP_TIMEOUT' || error.code === 'SMTP_TIMEOUT') return error.stage === undefined || TRANSPORT_STAGES.has(error.stage)
  return TRANSPORT_STAGES.has(error.stage) || TRANSPORT_CODES.has(error.code)
}

/** Short preview of a message body. */
function snippetOf(text, length = 220) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length <= length ? clean : `${clean.slice(0, length)}…`
}

/** The whole email capability. */
export class MailService {
  /**
   * @param {{ctx: any, config: {dataDir?: string, requestTimeoutMs?: number, maxBodyBytes?: number, maxAttachmentBytes?: number}}} options wiring
   */
  constructor(options) {
    this.config = {
      requestTimeoutMs: 20_000,
      maxBodyBytes: 262_144,
      maxAttachmentBytes: 8 * 1024 * 1024,
      proxy: '',
      proxyBypass: [],
      routeFallback: true,
      proxyConnectTimeoutMs: 8000,
      ...options.config,
    }
    /** Route that last worked, per account+transport, so a blocked proxy is not
     *  re-tried on every single operation. */
    this.routeMemory = new Map()
    this.log = (level, message) => {
      try {
        options.ctx?.logger?.[level]?.(message)
      } catch { /* logging must never break a mail operation */ }
    }
    // Fail fast on a malformed proxy instead of at the first login attempt.
    parseProxy(this.config.proxy)
    this.store = new AccountStore({ dataDir: this.config.dataDir })
    this.vault = new PasswordVault(options.ctx)
  }

  /* ---------------- accounts ---------------- */

  /**
   * Which route an account uses for one transport: its own override (IMAP:
   * `proxy`, SMTP: `smtpProxy` falling back to `proxy`), else the provider's
   * default (domestic providers stay direct), else the plugin-wide proxy.
   * @param {{provider?: string, proxy?: string, smtpProxy?: string}} account stored account or login draft
   * @param {'imap'|'smtp'} [transport] which half of the account
   * @returns {{proxy: string, bypass: string[]}} route settings for one connection
   */
  resolveRoute(account, transport = 'imap') {
    const bypass = Array.isArray(this.config.proxyBypass) ? this.config.proxyBypass : []
    const own = transport === 'smtp' && typeof account?.smtpProxy === 'string' && account.smtpProxy.trim() !== ''
      ? account.smtpProxy
      : account?.proxy
    const explicit = typeof own === 'string' ? own.trim() : ''
    if (explicit !== '') return { proxy: isDirect(explicit) ? '' : explicit, bypass }
    const preset = PROVIDERS[account?.provider]
    if (preset?.direct === true) return { proxy: '', bypass }
    return { proxy: this.config.proxy ?? '', bypass }
  }

  /**
   * Routes to try for one account, in order. The configured proxy comes first;
   * with `routeFallback` a direct connection follows, because proxy nodes often
   * allow 993 but refuse 465/587.
   * @param {{provider?: string, proxy?: string}} account account record or login draft
   * @returns {{proxy: string, bypass: string[]}[]} candidate routes
   */
  routeCandidates(account, transport = 'imap') {
    const primary = this.resolveRoute(account, transport)
    const candidates = [primary]
    if ((primary.proxy ?? '') !== '' && this.config.routeFallback !== false) {
      candidates.push({ ...primary, proxy: '' })
    }
    return candidates
  }

  /** Memory key for one account + transport + configured proxy. */
  routeKey(account, transport) {
    const primary = this.resolveRoute(account, transport)
    const id = account?.id ?? account?.email ?? ''
    return `${id}:${transport}:${primary.proxy ?? ''}`
  }

  /**
   * Ordered routes to try: the one that worked last time first, then the
   * configured order.
   * @param {{provider?: string, proxy?: string, id?: string}} account account
   * @param {'imap'|'smtp'} transport transport
   * @returns {{proxy: string, bypass: string[]}[]} routes
   */
  orderedRoutes(account, transport) {
    const candidates = this.routeCandidates(account, transport)
    const remembered = this.routeMemory.get(this.routeKey(account, transport))
    if (remembered === undefined) return candidates
    return [remembered, ...candidates.filter(candidate => candidate.proxy !== remembered.proxy)]
  }

  /** Connect timeout for one attempt: a proxied attempt must not stall a user. */
  connectTimeoutFor(route) {
    return (route.proxy ?? '') === ''
      ? this.config.requestTimeoutMs
      : Math.min(this.config.requestTimeoutMs, this.config.proxyConnectTimeoutMs)
  }

  /**
   * Open an IMAP session on the first route that answers, falling back only on
   * transport failures.
   * @param {{imap: object}} endpointOwner object holding the imap endpoint
   * @param {{username: string, password: string}} credentials login
   * @param {{provider?: string, proxy?: string}} account route owner
   * @returns {Promise<{client: ImapClient, route: string, fellBack: boolean}>} open session
   */
  async openImap(endpointOwner, credentials, account) {
    const candidates = this.orderedRoutes(account, 'imap')
    let lastError
    for (const [index, route] of candidates.entries()) {
      const client = new ImapClient({
        ...endpointOptions(endpointOwner.imap, credentials, route),
        timeoutMs: this.connectTimeoutFor(route),
      })
      try {
        await client.connect()
        this.routeMemory.set(this.routeKey(account, 'imap'), route)
        return { client, route: describeRoute(route, endpointOwner.imap.host), fellBack: index > 0 }
      } catch (error) {
        lastError = error
        client.destroy()
        if (index === candidates.length - 1 || isTransportFailure(error) === false) throw error
        this.log?.('warn', `IMAP 走代理失败（${error.message}），回退直连`)
      }
    }
    throw lastError
  }

  /**
   * Open an SMTP session on the first route that answers.
   * @param {{smtp: object}} endpointOwner object holding the smtp endpoint
   * @param {{username: string, password: string}} credentials login
   * @param {{provider?: string, proxy?: string}} account route owner
   * @returns {Promise<{client: SmtpClient, route: string, fellBack: boolean}>} open session
   */
  async openSmtp(endpointOwner, credentials, account) {
    const candidates = this.orderedRoutes(account, 'smtp')
    let lastError
    for (const [index, route] of candidates.entries()) {
      const client = new SmtpClient({
        ...endpointOptions(endpointOwner.smtp, credentials, route),
        timeoutMs: this.connectTimeoutFor(route),
      })
      try {
        await client.connect()
        this.routeMemory.set(this.routeKey(account, 'smtp'), route)
        return { client, route: describeRoute(route, endpointOwner.smtp.host), fellBack: index > 0 }
      } catch (error) {
        lastError = error
        client.destroy()
        if (index === candidates.length - 1 || isTransportFailure(error) === false) throw error
        this.log?.('warn', `SMTP 走代理失败（${error.message}），回退直连`)
      }
    }
    throw lastError
  }

  /** Close an IMAP session without masking the caller's error. */
  async closeImap(client) {
    try {
      await client.logout()
    } catch { /* ignore */ }
    client.destroy()
  }

  /** Close an SMTP session without masking the caller's error. */
  async closeSmtp(client) {
    try {
      await client.quit()
    } catch { /* ignore */ }
    client.destroy()
  }

  /**
   * Human-readable route for one account and endpoint.
   * @param {{provider?: string, proxy?: string}} account account record
   * @param {{host: string}} endpoint endpoint
   * @returns {string} `direct` or a proxy address
   */
  routeLabel(account, endpoint, transport = 'imap') {
    const route = this.resolveRoute(account, transport)
    return describeRoute({ proxy: route.proxy, bypass: route.bypass }, endpoint.host)
  }

  /** Provider presets, defaults included, for the login form. */
  catalog() {
    return PROVIDER_IDS.map(id => {
      const preset = PROVIDERS[id]
      return {
        id: preset.id,
        label: preset.label,
        domains: preset.domains,
        imap: preset.imap,
        smtp: preset.smtp,
        auth: preset.auth,
        hint: preset.hint,
        ...(preset.doc === undefined ? {} : { doc: preset.doc }),
      }
    })
  }

  /** Plugin-wide defaults the settings page shows as placeholders. */
  defaults() {
    return {
      proxy: this.config.proxy ?? '',
      proxyBypass: this.config.proxyBypass ?? [],
    }
  }

  /** @returns {Promise<object[]>} accounts without secrets, plus password presence */
  async listAccounts() {
    const accounts = this.store.refresh().list()
    return Promise.all(accounts.map(async account => ({
      ...account,
      hasPassword: await this.vault.has(account.id),
      route: this.routeLabel(account, account.imap, 'imap'),
      smtpRoute: this.routeLabel(account, account.smtp, 'smtp'),
    })))
  }

  /**
   * Log in a new account: verify, then persist metadata + secret.
   * @param {{
   *   email: string, password: string, provider?: string, label?: string,
   *   imap?: object, smtp?: object, proxy?: string, smtpProxy?: string,
   * }} input login form
   * @returns {Promise<object>} the created account, its test report, and warnings
   */
  async addAccount(input) {
    const email = String(input.email ?? '').trim()
    const password = String(input.password ?? '')
    if (email === '' || email.includes('@') === false) throw new AccountError('邮箱地址格式不正确', 'BAD_EMAIL')
    if (password === '') throw new AccountError('请输入密码或授权码', 'PASSWORD_EMPTY')
    const providerId = PROVIDERS[input.provider] !== undefined ? input.provider : guessProvider(email)
    const endpoints = resolveEndpoints(providerId, { imap: input.imap, smtp: input.smtp })
    const problems = validateEndpoints(endpoints)
    if (problems.length > 0) throw new AccountError(problems.join('；'), 'BAD_ENDPOINTS')

    const draft = { provider: providerId, proxy: String(input.proxy ?? '').trim(), smtpProxy: String(input.smtpProxy ?? '').trim() }
    const report = await this.verify(endpoints, { username: email, password }, draft)
    if (report.imap.ok !== true) {
      throw new AccountError(`IMAP 登录失败: ${report.imap.error ?? '未知错误'}`, 'IMAP_LOGIN_FAILED')
    }
    const warnings = []
    if (report.smtp.ok !== true) {
      warnings.push(`IMAP 已通过，但 SMTP 登录失败（可以收信、暂时不能发信）：${report.smtp.error ?? '未知错误'}`)
    }

    const now = new Date().toISOString()
    const existing = this.store.refresh().findByEmail(email)
    const id = existing === undefined ? newAccountId() : existing.id
    const record = {
      id,
      provider: providerId,
      providerLabel: PROVIDERS[providerId].label,
      email,
      label: String(input.label ?? '').trim(),
      proxy: draft.proxy,
      smtpProxy: String(input.smtpProxy ?? '').trim(),
      imap: endpoints.imap,
      smtp: endpoints.smtp,
      createdAt: existing === undefined ? now : (existing.createdAt ?? now),
      updatedAt: now,
      lastTest: { at: new Date().toISOString(), ok: report.imap.ok === true && report.smtp.ok === true, report },
    }
    this.store.upsert(record)
    await this.vault.write(id, password)
    return { account: this.store.publicView(record), report, warnings }
  }

  /**
   * Change the routes of an existing account without touching its password.
   * @param {string} id account id or address
   * @param {{proxy?: string, smtpProxy?: string}} patch route overrides (`''` = follow global, `off` = direct)
   * @returns {Promise<object[]>} the account list with fresh route labels
   */
  async updateRoutes(id, patch) {
    const account = this.store.get(id) ?? this.store.findByEmail(id)
    if (account === undefined) throw new AccountError(`没有找到账户 "${id}"`, 'ACCOUNT_NOT_FOUND')
    if (patch.proxy !== undefined) account.proxy = String(patch.proxy).trim()
    if (patch.smtpProxy !== undefined) account.smtpProxy = String(patch.smtpProxy).trim()
    account.updatedAt = new Date().toISOString()
    this.store.upsert(account)
    // New routes mean the remembered one is stale.
    this.routeMemory.delete(this.routeKey(account, 'imap'))
    this.routeMemory.delete(this.routeKey(account, 'smtp'))
    return this.listAccounts()
  }

  /**
   * Delete an account and its secret.
   * @param {string} id account id or address
   * @returns {Promise<object>} the remaining accounts
   */
  async removeAccount(id) {
    const account = this.store.get(id) ?? this.store.list().find(item => item.email === id)
    if (account === undefined) throw new AccountError(`没有找到账户 "${id}"`, 'ACCOUNT_NOT_FOUND')
    this.store.remove(account.id)
    await this.vault.remove(account.id)
    return this.listAccounts()
  }

  /**
   * @param {string} id account id or address
   * @returns {Promise<object[]>} the account list with the new default set
   */
  async setDefaultAccount(id) {
    const account = this.store.get(id) ?? this.store.list().find(item => item.email === id)
    if (account === undefined) throw new AccountError(`没有找到账户 "${id}"`, 'ACCOUNT_NOT_FOUND')
    this.store.setDefault(account.id)
    return this.listAccounts()
  }

  /**
   * Re-run the connection test for a stored account using its saved password.
   * @param {string} id account id or address
   * @returns {Promise<{account: object, report: object}>} test outcome
   */
  async testAccount(id) {
    const account = this.store.refresh().resolve(id)
    const password = await this.vault.read(account.id)
    const report = await this.verify(account, { username: account.email, password }, account)
    const fresh = this.store.get(account.id)
    if (fresh !== undefined) {
      fresh.lastTest = { at: new Date().toISOString(), ok: report.imap.ok === true && report.smtp.ok === true, report }
      this.store.upsert(fresh)
    }
    return { account: this.store.publicView(fresh ?? account), report }
  }

  /**
   * Probe IMAP and SMTP without sending anything.
   * @param {{imap: object, smtp: object}} endpoints endpoints
   * @param {{username: string, password: string}} credentials login
   * @param {{provider?: string, proxy?: string}} [account] account whose route should be used
   * @returns {Promise<{imap: object, smtp: object}>} per-transport reports (with `route` and failing `stage`)
   */
  async verify(endpoints, credentials, account) {
    const imapReport = await (async () => {
      const startedAt = Date.now()
      let session
      try {
        session = await this.openImap(endpoints, credentials, account ?? {})
        const mailboxes = await session.client.listMailboxes()
        return { ok: true, ms: Date.now() - startedAt, mailboxes: mailboxes.length, route: session.route, fellBack: session.fellBack }
      } catch (error) {
        return {
          ok: false,
          ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          stage: error?.stage,
          route: describeRoute(this.resolveRoute(account ?? {}, 'imap'), endpoints.imap.host),
        }
      } finally {
        if (session !== undefined) await this.closeImap(session.client)
      }
    })()

    const smtpReport = await (async () => {
      const startedAt = Date.now()
      let session
      try {
        session = await this.openSmtp(endpoints, credentials, account ?? {})
        return { ok: true, ms: Date.now() - startedAt, capabilities: session.client.capabilities, route: session.route, fellBack: session.fellBack }
      } catch (error) {
        return {
          ok: false,
          ms: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
          stage: error?.stage,
          route: describeRoute(this.resolveRoute(account ?? {}, 'smtp'), endpoints.smtp.host),
        }
      } finally {
        if (session !== undefined) await this.closeSmtp(session.client)
      }
    })()

    return { imap: imapReport, smtp: smtpReport }
  }

  /**
   * Resolve an account handle and its password.
   * @param {string|undefined} id account id, address, or empty for the default
   * @returns {Promise<{account: object, password: string}>} connection material
   */
  async connect(handle) {
    const account = this.store.refresh().resolve(handle)
    const password = await this.vault.read(account.id)
    return { account, password }
  }

  /* ---------------- reading ---------------- */

  /**
   * List folders for an account.
   * @param {{account?: string}} input account selector
   * @returns {Promise<{account: string, mailboxes: object[]}>} folder list
   */
  async mailboxes(input = {}) {
    const { account, password } = await this.connect(input.account)
    const session = await this.openImap(account, { username: account.email, password }, account)
    const client = session.client
    try {
      const mailboxes = await client.listMailboxes()
      return {
        account: account.email,
        mailboxes: mailboxes.map(mailbox => ({
          name: mailbox.name,
          label: mailbox.display,
          selectable: mailbox.flags.includes('\\Noselect') === false,
          flags: normalizeFlags(mailbox.flags),
        })),
      }
    } finally {
      await this.closeImap(client)
    }
  }

  /**
   * Search a mailbox and return newest-first summaries.
   * @param {{
   *   account?: string, mailbox?: string, from?: string, to?: string, subject?: string,
   *   text?: string, since?: string, before?: string, unseen?: boolean, limit?: number,
   *   offset?: number, uidFrom?: number,
   * }} input search
   * @returns {Promise<object>} rows and mailbox state
   */
  async search(input = {}) {
    const { account, password } = await this.connect(input.account)
    if (account.imap?.host === '') throw new AccountError('该账户没有配置 IMAP 服务器', 'BAD_ENDPOINTS')
    const mailbox = String(input.mailbox ?? DEFAULT_MAILBOX)
    const limit = Math.min(Math.max(Number(input.limit ?? 20), 1), 100)
    const offset = Math.max(Number(input.offset ?? 0), 0)

    const criteria = []
    if (input.unseen === true) criteria.push('UNSEEN')
    if (input.from !== undefined && input.from !== '') criteria.push(`FROM ${imapQuote(input.from)}`)
    if (input.to !== undefined && input.to !== '') criteria.push(`TO ${imapQuote(input.to)}`)
    if (input.subject !== undefined && input.subject !== '') criteria.push(`SUBJECT ${imapQuote(input.subject)}`)
    if (input.text !== undefined && input.text !== '') criteria.push(`TEXT ${imapQuote(input.text)}`)
    const since = toImapDate(input.since, 'since')
    if (since !== undefined) criteria.push(`SINCE ${since}`)
    const before = toImapDate(input.before, 'before')
    if (before !== undefined) criteria.push(`BEFORE ${before}`)
    if (Number.isFinite(Number(input.uidFrom)) && Number(input.uidFrom) > 0) criteria.push(`UID ${Number(input.uidFrom)}:*`)
    if (criteria.length === 0) criteria.push('ALL')
    const needsUtf8 = criteria.some(item => !isAscii(item))
    const criteriaText = `${needsUtf8 ? 'CHARSET UTF-8 ' : ''}${criteria.join(' ')}`

    const session = await this.openImap(account, { username: account.email, password }, account)
    const client = session.client
    try {
      const state = await client.select(mailbox)
      const uids = await client.uidSearch(criteriaText)
      const end = uids.length - offset
      const start = Math.max(0, end - limit)
      const page = end <= start ? [] : uids.slice(start, end)
      const summaries = await client.fetchSummaries(page)
      const rows = summaries
        .map(row => {
          const parsed = parseMessage(row.headers ?? Buffer.alloc(0))
          return {
            uid: row.uid,
            mailbox,
            from: parsed.from,
            to: parsed.to,
            subject: parsed.subject,
            date: parsed.date === '' ? row.internalDate : parsed.date,
            flags: normalizeFlags(row.flags),
            unread: normalizeFlags(row.flags).includes('seen') === false,
            size: row.size,
          }
        })
        .sort((a, b) => b.uid - a.uid)
      return {
        account: account.email,
        mailbox,
        matched: uids.length,
        returned: rows.length,
        offset,
        messages: rows,
      }
    } finally {
      await this.closeImap(client)
    }
  }

  /**
   * Read one message in full.
   * @param {{account?: string, mailbox?: string, uid: number, maxBytes?: number, includeHtml?: boolean}} input selection
   * @returns {Promise<object>} message content (no credentials)
   */
  async read(input = {}) {
    const uid = Number(input.uid)
    if (!Number.isInteger(uid) || uid <= 0) throw new AccountError('uid 必须是正整数', 'BAD_UID')
    const { account, password } = await this.connect(input.account)
    const mailbox = String(input.mailbox ?? DEFAULT_MAILBOX)
    const maxBytes = Math.min(Math.max(Number(input.maxBytes ?? this.config.maxBodyBytes), 4096), 8 * 1024 * 1024)
    const session = await this.openImap(account, { username: account.email, password }, account)
    const client = session.client
    try {
      await client.select(mailbox)
      const message = await client.fetchMessage(uid, maxBytes)
      const parsed = parseMessage(message.body, { maxAttachmentBytes: this.config.maxAttachmentBytes })
      const bodyText = parsed.text.length > maxBytes ? `${parsed.text.slice(0, maxBytes)}…` : parsed.text
      return {
        account: account.email,
        mailbox,
        uid,
        subject: parsed.subject,
        from: parsed.from,
        to: parsed.to,
        cc: parsed.cc,
        replyTo: parsed.replyTo,
        date: parsed.date === '' ? message.internalDate : parsed.date,
        messageId: parsed.messageId,
        flags: normalizeFlags(message.flags),
        size: message.size,
        truncated: message.truncated || parsed.truncated,
        text: bodyText,
        ...(input.includeHtml === true ? { html: parsed.html } : {}),
        attachments: parsed.attachments.map(attachment => ({
          index: attachment.index,
          filename: attachment.filename,
          contentType: attachment.contentType,
          size: attachment.size,
        })),
      }
    } finally {
      await this.closeImap(client)
    }
  }

  /**
   * Fetch one parsed message (internal helper shared by reply/download).
   * @param {object} account stored account
   * @param {string} password secret
   * @param {string} mailbox mailbox name
   * @param {number} uid uid
   * @param {number} [maxBytes] body cap
   * @returns {Promise<{message: object, parsed: object}>} raw and parsed message
   */
  async #fetchParsed(account, password, mailbox, uid, maxBytes = this.config.maxBodyBytes) {
    const session = await this.openImap(account, { username: account.email, password }, account)
    const client = session.client
    try {
      await client.select(mailbox)
      const message = await client.fetchMessage(uid, maxBytes)
      return { message, parsed: parseMessage(message.body, { maxAttachmentBytes: this.config.maxAttachmentBytes }) }
    } finally {
      await this.closeImap(client)
    }
  }

  /* ---------------- sending ---------------- */

  /**
   * Send a message.
   * @param {{
   *   account?: string, to: string|string[], cc?: string|string[], bcc?: string|string[],
   *   subject?: string, text?: string, html?: string, replyTo?: string,
   *   attachments?: {path: string, filename?: string, contentType?: string}[],
   *   headers?: Record<string, string>, cwd?: string,
   * }} input message
   * @returns {Promise<object>} delivery outcome
   */
  async send(input) {
    const { account, password } = await this.connect(input.account)
    const recipients = []
    for (const field of [input.to, input.cc, input.bcc]) {
      if (field === undefined) continue
      for (const item of Array.isArray(field) ? field : String(field).split(',')) {
        const address = item.trim()
        if (address !== '') recipients.push(address)
      }
    }
    if (recipients.length === 0) throw new AccountError('至少需要一个收件人', 'NO_RECIPIENTS')
    const subject = String(input.subject ?? '').trim()
    const text = String(input.text ?? '')
    if (subject === '' && text === '') throw new AccountError('主题和正文都为空，拒绝发送', 'EMPTY_MESSAGE')

    const attachments = (input.attachments ?? []).map(item => this.#loadAttachment(item, input.cwd))
    const built = buildMessage({
      from: account.label === '' ? account.email : `${account.label} <${account.email}>`,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject,
      text,
      html: input.html,
      replyTo: input.replyTo,
      inReplyTo: input.inReplyTo,
      references: input.references,
      attachments,
      headers: input.headers,
    })
    const session = await this.openSmtp(account, { username: account.email, password }, account)
    const client = session.client
    try {
      const outcome = await client.send({ from: account.email, recipients, data: built.data })
      return {
        ok: true,
        account: account.email,
        from: account.email,
        to: recipients,
        subject,
        messageId: built.messageId,
        bytes: built.data.length,
        route: session.route,
        routeFallback: session.fellBack,
        accepted: outcome.accepted,
        rejected: outcome.rejected,
      }
    } finally {
      await this.closeSmtp(client)
    }
  }

  /**
   * Read one attachment source from disk.
   * @param {{path: string, filename?: string, contentType?: string}} item attachment spec
   * @param {string} [cwd] base directory for relative paths
   * @returns {{filename: string, contentType: string, content: Buffer}} attachment payload
   */
  #loadAttachment(item, cwd) {
    const requested = String(item?.path ?? '').trim()
    if (requested === '') throw new AccountError('附件缺少 path', 'BAD_ATTACHMENT')
    const base = cwd !== undefined && cwd !== '' ? cwd : process.cwd()
    const full = isAbsolute(requested) ? requested : resolve(base, requested)
    if (!existsSync(full)) throw new AccountError(`附件不存在: ${full}`, 'ATTACHMENT_MISSING')
    const stat = statSync(full)
    if (!stat.isFile()) throw new AccountError(`附件不是文件: ${full}`, 'ATTACHMENT_NOT_FILE')
    if (stat.size > this.config.maxAttachmentBytes) {
      throw new AccountError(`附件超过上限 ${this.config.maxAttachmentBytes} 字节: ${full}`, 'ATTACHMENT_TOO_LARGE')
    }
    return {
      filename: item.filename ?? full.split('/').pop() ?? 'attachment',
      contentType: item.contentType ?? CONTENT_TYPES[extname(full).toLowerCase()] ?? 'application/octet-stream',
      content: readFileSync(full),
    }
  }

  /**
   * Reply to a message, threading headers included.
   * @param {{
   *   account?: string, mailbox?: string, uid: number, text?: string, html?: string,
   *   replyAll?: boolean, quote?: boolean, cwd?: string,
   *   attachments?: {path: string, filename?: string, contentType?: string}[],
   * }} input reply
   * @returns {Promise<object>} delivery outcome
   */
  async reply(input) {
    const uid = Number(input.uid)
    if (!Number.isInteger(uid) || uid <= 0) throw new AccountError('uid 必须是正整数', 'BAD_UID')
    const { account, password } = await this.connect(input.account)
    const mailbox = String(input.mailbox ?? DEFAULT_MAILBOX)
    const { parsed } = await this.#fetchParsed(account, password, mailbox, uid, 128 * 1024)
    const senderAddress = /<([^>]+)>/.exec(parsed.from)?.[1] ?? parsed.from
    if (senderAddress === '') throw new AccountError('原邮件没有可用的 From 地址，无法回复', 'NO_SENDER')
    const subject = /^re:/i.test(parsed.subject) ? parsed.subject : `Re: ${parsed.subject}`

    const cc = []
    if (input.replyAll === true) {
      for (const field of [parsed.to, parsed.cc]) {
        for (const token of String(field ?? '').split(',')) {
          const address = /<([^>]+)>/.exec(token)?.[1] ?? token.trim()
          if (address === '' || address.toLowerCase() === account.email.toLowerCase()) continue
          if (address.toLowerCase() === senderAddress.toLowerCase()) continue
          if (cc.includes(address) === false) cc.push(address)
        }
      }
    }

    const body = input.quote === false
      ? String(input.text ?? '')
      : quoteReply(parsed, String(input.text ?? ''))

    return this.send({
      account: account.id,
      to: senderAddress,
      cc,
      subject,
      text: body,
      html: input.html,
      inReplyTo: parsed.messageId,
      references: replyReferences(parsed),
      attachments: input.attachments,
      cwd: input.cwd,
    })
  }

  /**
   * Poll for mail that arrives after a given UID — the "wait for the
   * verification email" primitive.
   * @param {{
   *   account?: string, mailbox?: string, sinceUid?: number, timeoutSeconds?: number,
   *   intervalSeconds?: number, from?: string, subject?: string, limit?: number,
   * }} input wait
   * @returns {Promise<{found: object[], lastUid: number, timedOut: boolean}>} arrivals
   */
  async wait(input = {}) {
    const { account, password } = await this.connect(input.account)
    const mailbox = String(input.mailbox ?? DEFAULT_MAILBOX)
    const timeoutMs = Math.min(Math.max(Number(input.timeoutSeconds ?? 30), 1), 120) * 1000
    const intervalMs = Math.min(Math.max(Number(input.intervalSeconds ?? 5), 1), 30) * 1000
    const limit = Math.min(Math.max(Number(input.limit ?? 5), 1), 20)
    const deadline = Date.now() + timeoutMs
    const session = await this.openImap(account, { username: account.email, password }, account)
    const client = session.client
    let sinceUid = Number(input.sinceUid ?? 0)
    try {
      await client.select(mailbox)
      if (!Number.isFinite(sinceUid) || sinceUid <= 0) {
        const current = await client.allUids()
        sinceUid = current.length === 0 ? 0 : Math.max(...current)
      }
      for (;;) {
        await client.noop()
        const uids = (await client.allUids()).filter(uid => uid > sinceUid)
        if (uids.length > 0) {
          const summaries = await client.fetchSummaries(uids.slice(-limit))
          const found = summaries
            .map(row => {
              const parsed = parseMessage(row.headers ?? Buffer.alloc(0))
              return {
                uid: row.uid,
                mailbox,
                from: parsed.from,
                to: parsed.to,
                subject: parsed.subject,
                date: parsed.date === '' ? row.internalDate : parsed.date,
                flags: normalizeFlags(row.flags),
              }
            })
            .filter(row => this.#matches(row, input))
            .sort((a, b) => a.uid - b.uid)
          if (found.length > 0) {
            return { account: account.email, mailbox, found, lastUid: Math.max(...found.map(row => row.uid)), timedOut: false }
          }
          sinceUid = Math.max(...uids)
        }
        if (Date.now() + intervalMs > deadline) {
          return { account: account.email, mailbox, found: [], lastUid: sinceUid, timedOut: true }
        }
        await new Promise(resolve => {
          const timer = setTimeout(resolve, intervalMs)
          timer.unref?.()
        })
      }
    } finally {
      await this.closeImap(client)
    }
  }

  /** Case-insensitive filter shared by the wait loop. */
  #matches(row, input) {
    const from = String(input.from ?? '').trim().toLowerCase()
    if (from !== '' && String(row.from).toLowerCase().includes(from) === false) return false
    const subject = String(input.subject ?? '').trim().toLowerCase()
    if (subject !== '' && String(row.subject).toLowerCase().includes(subject) === false) return false
    return true
  }

  /**
   * Save one attachment from a message to disk.
   * @param {{account?: string, mailbox?: string, uid: number, index?: number, filename?: string, savePath?: string}} input selection
   * @returns {Promise<object>} saved file details
   */
  async downloadAttachment(input = {}) {
    const uid = Number(input.uid)
    if (!Number.isInteger(uid) || uid <= 0) throw new AccountError('uid 必须是正整数', 'BAD_UID')
    const { account, password } = await this.connect(input.account)
    const mailbox = String(input.mailbox ?? DEFAULT_MAILBOX)
    const { parsed } = await this.#fetchParsed(account, password, mailbox, uid)
    if (parsed.attachments.length === 0) throw new AccountError('这封邮件没有附件', 'NO_ATTACHMENTS')
    const index = Number(input.index ?? -1)
    let attachment
    if (Number.isInteger(index) && index >= 0) {
      attachment = parsed.attachments.find(item => item.index === index)
    } else if (input.filename !== undefined && input.filename !== '') {
      attachment = parsed.attachments.find(item => item.filename === input.filename)
        ?? parsed.attachments.find(item => item.filename.includes(String(input.filename)))
    } else {
      attachment = parsed.attachments[0]
    }
    if (attachment === undefined) {
      throw new AccountError(`没有该附件；可用附件: ${parsed.attachments.map(item => `${item.index}:${item.filename}`).join(', ')}`, 'ATTACHMENT_NOT_FOUND')
    }
    if (attachment.content === null) throw new AccountError('附件过大，未随邮件取回', 'ATTACHMENT_TOO_LARGE')
    const safeName = attachment.filename.replace(/[/\\\u0000]/g, '_').replace(/^\.+/, '_')
    const target = input.savePath !== undefined && input.savePath !== ''
      ? (isAbsolute(input.savePath) ? input.savePath : resolve(input.cwd ?? process.cwd(), input.savePath))
      : join(input.cwd ?? process.cwd(), 'mail-attachments', String(uid), safeName)
    const directory = target.endsWith('/') ? target : resolve(target, '..')
    mkdirSync(directory, { recursive: true })
    const finalPath = target.endsWith('/') ? join(target, safeName) : target
    writeFileSync(finalPath, attachment.content)
    return {
      account: account.email,
      mailbox,
      uid,
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.content.length,
      path: finalPath,
      savedAs: finalPath.split('/').pop(),
    }
  }

  /**
   * Digest of what is configured, for the system-prompt section and the tools.
   * @returns {Promise<string>} one-line summary
   */
  async summary() {
    try {
      const accounts = await this.listAccounts()
      if (accounts.length === 0) return '还没有登录任何邮箱（设置 → 邮件）。'
      return accounts
        .map(account => `${account.email}${account.default ? '（默认）' : ''}${account.hasPassword ? '' : '（缺密码）'}`)
        .join('、')
    } catch {
      return '邮箱状态不可用。'
    }
  }
}

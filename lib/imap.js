/**
 * Minimal IMAP4rev1 client for dsh-email — dependency-free.
 *
 * Scope is deliberately small: connect (TLS / STARTTLS / plain), LOGIN,
 * LIST, SELECT, UID SEARCH, UID FETCH (headers, flags, full body), NOOP.
 * That is everything the agent tools need; no IDLE, no BODYSTRUCTURE, no
 * server-side MIME parsing (lib/mime.js parses the message itself).
 */

import tls from 'node:tls'
import { openMailSocket } from './proxy.js'

/** A failure that carries the protocol stage, so callers can explain it. */
export class ImapError extends Error {
  /**
   * @param {string} message human readable cause
   * @param {{code?: string, stage?: string}} [info] machine hints
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'ImapError'
    this.code = info.code ?? 'IMAP_ERROR'
    this.stage = info.stage ?? 'unknown'
  }
}

/* ------------------------------------------------------------------ */
/* Modified UTF-7 (RFC 3501 section 5.1.3) mailbox names               */
/* ------------------------------------------------------------------ */

/**
 * Decode a modified-UTF-7 mailbox name into readable text.
 * @param {string} name wire name
 * @returns {string} readable name
 */
export function decodeMailboxName(name) {
  if (typeof name !== 'string' || !name.includes('&')) return name
  return name.replace(/&([A-Za-z0-9+,]*)-/g, (all, chunk) => {
    if (chunk === '') return '&'
    const base64 = chunk.replace(/,/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    try {
      const buf = Buffer.from(padded, 'base64')
      let out = ''
      for (let i = 0; i + 1 < buf.length; i += 2) out += String.fromCharCode(buf.readUInt16BE(i))
      return out
    } catch {
      return all
    }
  })
}

/**
 * Encode a readable mailbox name for the wire (modified UTF-7).
 * @param {string} name readable name
 * @returns {string} wire name
 */
export function encodeMailboxName(name) {
  const text = String(name ?? '')
  let out = ''
  let pending = []
  const flush = () => {
    if (pending.length === 0) return
    const units = pending
    pending = []
    const buf = Buffer.alloc(units.length * 2)
    units.forEach((unit, index) => buf.writeUInt16BE(unit.charCodeAt(0), index * 2))
    out += `&${buf.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`
  }
  for (const ch of text) {
    if (ch.codePointAt(0) < 0x80) {
      flush()
      out += ch === '&' ? '&-' : ch
    } else {
      pending.push(ch)
    }
  }
  flush()
  return out
}

/* ------------------------------------------------------------------ */
/* String helpers                                                      */
/* ------------------------------------------------------------------ */

/** Quote an IMAP astring. */
function quote(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Strip optional surrounding quotes. */
function unquote(value) {
  const text = String(value ?? '').trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return text
}

/** IMAP INTERNALDATE/SINCE date: 01-Jan-2025 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Format a date as an IMAP date (dd-Mon-yyyy).
 * @param {Date} date when
 * @returns {string} IMAP date
 */
export function formatImapDate(date) {
  const day = String(date.getDate()).padStart(2, '0')
  return `${day}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`
}

/**
 * Parse an IMAP INTERNALDATE ("01-Jan-2025 10:00:00 +0800").
 * @param {string} value INTERNALDATE text
 * @returns {string} ISO timestamp, or the input when unparsable
 */
function parseInternalDate(value) {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(value.trim())
  if (match === null) return value
  const [, day, monthName, year, hour, minute, second, sign, offHour, offMinute] = match
  const month = MONTHS.indexOf(monthName)
  if (month < 0) return value
  const offsetMs = (sign === '-' ? -1 : 1) * (Number(offHour) * 60 + Number(offMinute)) * 60_000
  const utc = Date.UTC(Number(year), month, Number(day), Number(hour), Number(minute), Number(second))
  return new Date(utc - offsetMs).toISOString()
}

/* ------------------------------------------------------------------ */
/* Client                                                              */
/* ------------------------------------------------------------------ */

/** One parsed protocol response: text lines plus any literal payloads. */
class Response {
  constructor(parts) {
    this.parts = parts
  }

  /** Full text with literals omitted. */
  get text() {
    return this.parts.map(part => part.text).join('\r\n')
  }

  /** First literal, if the response carried one. */
  get literal() {
    const hit = this.parts.find(part => part.literal !== undefined)
    return hit === undefined ? undefined : hit.literal
  }

  /** Whether this is a tagged completion ("A3 OK ..."). */
  get tagged() {
    return /^A\d+\s/.test(this.parts[0]?.text ?? '')
  }

  /** Status word of a tagged response (OK/NO/BAD), upper case. */
  get status() {
    const match = /^A\d+\s+([A-Za-z]+)/.exec(this.parts[0]?.text ?? '')
    return match === null ? '' : match[1].toUpperCase()
  }
}

/** Blocking, timeout-guarded IMAP session. */
export class ImapClient {
  /**
   * @param {{
   *   host: string, port?: number, secure?: boolean, starttls?: boolean,
   *   rejectUnauthorized?: boolean, username: string, password: string,
   *   timeoutMs?: number, sendId?: boolean, clientName?: string,
   *   proxy?: string, bypass?: string[],
   * }} options connection settings
   */
  constructor(options) {
    this.options = {
      port: 993,
      secure: true,
      starttls: false,
      rejectUnauthorized: true,
      timeoutMs: 20_000,
      sendId: false,
      clientName: 'dsh-email',
      proxy: '',
      bypass: [],
      ...options,
    }
    if (this.options.sendId === 'auto') this.options.sendId = true
    this.socket = undefined
    this.buffer = Buffer.alloc(0)
    this.counter = 0
    this.queue = []
    this.continuations = []
    this.unsolicited = []
    this.unsolicitedWaiters = []
    this.connected = false
    this.failure = undefined
    this.capabilities = []
  }

  /* ---------------- socket plumbing ---------------- */

  #attach(socket, stage) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    socket.setNoDelay?.(true)
    socket.on('data', chunk => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.#pump()
    })
    socket.on('error', err => this.#fail(new ImapError(`IMAP ${stage} error: ${err.message}`, { code: 'IMAP_SOCKET', stage })))
    socket.on('close', () => this.#fail(new ImapError('IMAP connection closed by the server', { code: 'IMAP_CLOSED', stage })))
    // A proxied socket arrives paused (so no greeting byte is lost); attach to
    // the data listener, then resume explicitly to flush what is buffered.
    socket.resume?.()
  }

  #fail(error) {
    if (this.failure !== undefined) return
    this.failure = error
    const pending = this.queue.splice(0)
    for (const entry of pending) entry.reject(error)
    for (const continuation of this.continuations.splice(0)) continuation.reject?.(error)
    try {
      this.socket?.destroy()
    } catch { /* ignore */ }
  }

  #parseOne() {
    let cursor = 0
    const parts = []
    for (;;) {
      const newline = this.buffer.indexOf('\r\n', cursor)
      if (newline < 0) return undefined
      const line = this.buffer.toString('latin1', cursor, newline)
      cursor = newline + 2
      const literalMatch = /\{(\d+)\+?\}$/.exec(line)
      if (literalMatch === null) {
        parts.push({ text: line })
        return { parts, end: cursor }
      }
      const size = Number(literalMatch[1])
      if (this.buffer.length < cursor + size) return undefined
      const literal = this.buffer.subarray(cursor, cursor + size)
      cursor += size
      parts.push({ text: line, literal })
    }
  }

  #pump() {
    for (;;) {
      const parsed = this.#parseOne()
      if (parsed === undefined) return
      this.buffer = this.buffer.subarray(parsed.end)
      const response = new Response(parsed.parts)
      const head = parsed.parts[0]?.text ?? ''
      if (head.startsWith('+')) {
        const continuation = this.continuations.shift()
        if (continuation !== undefined) continuation.resolve(response)
        continue
      }
      if (head.startsWith('*')) {
        const current = this.queue[0]
        if (current !== undefined) current.untagged.push(response)
        else {
          this.unsolicited.push(response)
          const waiter = this.unsolicitedWaiters.shift()
          if (waiter !== undefined) waiter(response)
        }
        continue
      }
      const tag = /^(A\d+)\s/.exec(head)?.[1]
      const index = this.queue.findIndex(entry => entry.tag === tag)
      if (index >= 0) {
        const [entry] = this.queue.splice(index, 1)
        response.untagged = entry.untagged
        entry.resolve(response)
      }
    }
  }

  /** Resolve with the next untagged line that arrives outside any command (the greeting). */
  #awaitUntagged(timeoutMs) {
    if (this.unsolicited.length > 0) return Promise.resolve(this.unsolicited.shift())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ImapError(`IMAP timed out waiting for the greeting after ${timeoutMs}ms`, { code: 'IMAP_TIMEOUT', stage: 'greeting' }))
      }, timeoutMs)
      timer.unref?.()
      this.unsolicitedWaiters.push(response => {
        clearTimeout(timer)
        resolve(response)
      })
    })
  }

  /**
   * Send one tagged command and return its tagged response (untagged lines are
   * collected on it).
   * @param {string} command command text without the tag
   * @param {{timeoutMs?: number}} [options] overrides
   * @returns {Promise<Response & {untagged: Response[]}>} tagged response
   */
  async command(command, options = {}) {
    if (this.socket === undefined) throw new ImapError('IMAP client is not connected', { code: 'IMAP_NOT_CONNECTED' })
    if (this.failure !== undefined) throw this.failure
    const tag = `A${++this.counter}`
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new ImapError(`IMAP command timed out after ${timeoutMs}ms`, { code: 'IMAP_TIMEOUT', stage: 'command' }))
      }, timeoutMs)
      timer.unref?.()
      this.queue.push({
        tag,
        untagged: [],
        resolve: value => { clearTimeout(timer); resolve(value) },
        reject: error => { clearTimeout(timer); reject(error) },
      })
    })
    this.socket.write(`${tag} ${command}\r\n`)
    const response = await promise
    if (response.status !== 'OK') {
      const detail = response.text.replace(/\r\n/g, ' | ')
      throw new ImapError(`IMAP ${command.split(' ')[0]} failed: ${detail}`, {
        code: response.status === 'NO' ? 'IMAP_NO' : 'IMAP_BAD',
        stage: command.split(' ')[0].toLowerCase(),
      })
    }
    return response
  }

  /* ---------------- connection ---------------- */

  /**
   * Open the connection, negotiate TLS, and authenticate.
   * @returns {Promise<void>} resolves after a successful LOGIN
   */
  async connect() {
    const { host, port, secure, rejectUnauthorized } = this.options
    let socket
    try {
      socket = await openMailSocket({
        host,
        port,
        secure: secure === true,
        rejectUnauthorized,
        proxy: this.options.proxy,
        bypass: this.options.bypass,
        timeoutMs: this.options.timeoutMs,
      })
    } catch (error) {
      throw new ImapError(`IMAP 连接失败：${error instanceof Error ? error.message : String(error)}`, {
        code: 'IMAP_CONNECT',
        stage: 'connect',
      })
    }
    this.#attach(socket, 'connect')
    // Greeting: "* OK ..." (or "* PREAUTH"), arriving outside any command.
    this.unsolicited = []
    const greeting = await this.#awaitUntagged(this.options.timeoutMs)
    const greetingText = greeting.text
    if (!/^\* (OK|PREAUTH)/i.test(greetingText)) {
      throw new ImapError(`IMAP server refused the session: ${greetingText}`, { code: 'IMAP_GREETING', stage: 'greeting' })
    }
    this.connected = true

    if (this.options.starttls) {
      await this.#startTls()
    }

    const capabilitiesLine = await this.command('CAPABILITY').catch(() => undefined)
    if (capabilitiesLine !== undefined) {
      this.capabilities = capabilitiesLine.untagged
        .map(response => response.text)
        .filter(text => text.startsWith('* CAPABILITY'))
        .flatMap(text => text.replace(/^\* CAPABILITY\s*/i, '').split(/\s+/))
        .filter(Boolean)
    }

    if (this.options.sendId) {
      await this.command('ID ("name" "dsh-email" "version" "0.1.0" "vendor" "DeepSeek Harness")').catch(() => undefined)
    }

    await this.login()
  }

  async #startTls() {
    const { host, rejectUnauthorized } = this.options
    await this.command('STARTTLS').catch(error => {
      throw new ImapError(`IMAP STARTTLS refused: ${error.message}`, { code: 'IMAP_STARTTLS', stage: 'starttls' })
    })
    const plain = this.socket
    plain.removeAllListeners('data')
    plain.removeAllListeners('close')
    plain.removeAllListeners('error')
    this.socket = undefined
    const secured = tls.connect({ socket: plain, servername: host, rejectUnauthorized })
    this.#attach(secured, 'starttls')
    await new Promise((resolve, reject) => {
      secured.once('secureConnect', resolve)
      secured.once('error', error => reject(new ImapError(`IMAP STARTTLS handshake failed: ${error.message}`, { code: 'IMAP_STARTTLS', stage: 'starttls' })))
    })
  }

  async login() {
    const { username, password } = this.options
    const attempt = async () => this.command(`LOGIN ${quote(username)} ${quote(password)}`)
    try {
      await attempt()
    } catch (error) {
      // Some providers (163/126/QQ) answer LOGIN with "Unsafe Login" until the
      // client identifies itself with an RFC 2971 ID command.
      if (/unsafe|security|please contact|请|拒绝|untrusted/i.test(error.message)) {
        await this.command('ID ("name" "dsh-email" "version" "0.1.0" "vendor" "DeepSeek Harness")').catch(() => undefined)
        await attempt()
        return
      }
      throw error
    }
  }

  /** Measure round-trip liveness without changing state. */
  async noop() {
    await this.command('NOOP')
  }

  /** Close politely, then hard. */
  async logout() {
    try {
      await this.command('LOGOUT', { timeoutMs: 5_000 })
    } catch { /* the server may already be gone */ }
    this.destroy()
  }

  /** Hard close. */
  destroy() {
    this.failure ??= new ImapError('IMAP client closed', { code: 'IMAP_CLOSED' })
    try {
      this.socket?.destroy()
    } catch { /* ignore */ }
    this.socket = undefined
  }

  /* ---------------- mailbox operations ---------------- */

  /**
   * List mailboxes.
   * @returns {Promise<{name: string, display: string, flags: string[], delimiter: string}[]>} mailboxes
   */
  async listMailboxes() {
    const response = await this.command('LIST "" "*"')
    const out = []
    for (const entry of response.untagged) {
      const text = entry.text
      if (!text.startsWith('* LIST')) continue
      const match = /^\* LIST \(([^)]*)\) ("([^"]*)"|NIL) (.*)$/.exec(text.split('\r\n')[0])
      if (match === null) continue
      const flags = match[1].split(/\s+/).filter(Boolean)
      const delimiter = match[3] ?? ''
      let name = entry.literal !== undefined ? entry.literal.toString('utf8') : unquote(match[4])
      name = name.trim()
      if (name === '') continue
      out.push({ name, display: decodeMailboxName(name), flags, delimiter })
    }
    return out
  }

  /**
   * Select a mailbox.
   * @param {string} mailbox readable or wire name
   * @returns {Promise<{exists: number, uidValidity: string, uidNext: string}>} mailbox state
   */
  async select(mailbox) {
    const response = await this.command(`SELECT ${quote(encodeMailboxName(mailbox))}`)
    const text = response.text
    const exists = /\*\s+(\d+)\s+EXISTS/i.exec(text)
    const uidValidity = /\[UIDVALIDITY\s+(\d+)\]/i.exec(text)
    const uidNext = /\[UIDNEXT\s+(\d+)\]/i.exec(text)
    return {
      exists: exists === null ? 0 : Number(exists[1]),
      uidValidity: uidValidity === null ? '' : uidValidity[1],
      uidNext: uidNext === null ? '' : uidNext[1],
    }
  }

  /**
   * UID SEARCH with a raw criterion list.
   * @param {string} criteria IMAP search criteria (already built)
   * @returns {Promise<number[]>} matching UIDs, ascending
   */
  async uidSearch(criteria) {
    const response = await this.command(`UID SEARCH ${criteria}`.trim(), { timeoutMs: Math.max(this.options.timeoutMs, 60_000) })
    const uids = []
    for (const entry of response.untagged) {
      const match = /^\* SEARCH(?: (.*))?$/m.exec(entry.text)
      if (match === null) continue
      for (const token of (match[1] ?? '').split(/\s+/)) {
        if (/^\d+$/.test(token)) uids.push(Number(token))
      }
    }
    return [...new Set(uids)].sort((a, b) => a - b)
  }

  /**
   * Fetch metadata and raw headers for UIDs.
   * @param {number[]} uids uids to fetch
   * @returns {Promise<{uid: number, flags: string[], internalDate: string, size: number, headers: import('node:buffer').Buffer|undefined}[]>} summary rows
   */
  async fetchSummaries(uids) {
    if (uids.length === 0) return []
    const set = uids.join(',')
    const response = await this.command(
      `UID FETCH ${set} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)])`,
      { timeoutMs: Math.max(this.options.timeoutMs, 60_000) },
    )
    const rows = []
    for (const entry of response.untagged) {
      if (!entry.text.startsWith('* ') || !/FETCH/i.test(entry.text)) continue
      const uid = /UID (\d+)/.exec(entry.text)
      if (uid === null) continue
      const flags = /FLAGS \(([^)]*)\)/.exec(entry.text)
      const internalDate = /INTERNALDATE "([^"]*)"/.exec(entry.text)
      const size = /RFC822\.SIZE (\d+)/.exec(entry.text)
      rows.push({
        uid: Number(uid[1]),
        flags: flags === null ? [] : flags[1].split(/\s+/).filter(Boolean),
        internalDate: internalDate === null ? '' : parseInternalDate(internalDate[1]),
        size: size === null ? 0 : Number(size[1]),
        headers: entry.literal,
      })
    }
    return rows
  }

  /**
   * Fetch one full message body.
   * @param {number} uid message uid
   * @param {number} maxBytes byte cap for the body
   * @returns {Promise<{uid: number, flags: string[], internalDate: string, size: number, body: import('node:buffer').Buffer, truncated: boolean}>} message
   */
  async fetchMessage(uid, maxBytes = 512 * 1024) {
    const limit = Math.max(4096, Math.floor(maxBytes))
    const response = await this.command(
      `UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[]<0.${limit}>)`,
      { timeoutMs: Math.max(this.options.timeoutMs, 90_000) },
    )
    const entry = response.untagged.find(item => /FETCH/i.test(item.text))
    if (entry === undefined) {
      throw new ImapError(`message ${uid} not found in this mailbox`, { code: 'IMAP_NOT_FOUND', stage: 'fetch' })
    }
    const flags = /FLAGS \(([^)]*)\)/.exec(entry.text)
    const internalDate = /INTERNALDATE "([^"]*)"/.exec(entry.text)
    const size = /RFC822\.SIZE (\d+)/.exec(entry.text)
    const body = entry.literal ?? Buffer.alloc(0)
    const declaredSize = size === null ? body.length : Number(size[1])
    return {
      uid,
      flags: flags === null ? [] : flags[1].split(/\s+/).filter(Boolean),
      internalDate: internalDate === null ? '' : parseInternalDate(internalDate[1]),
      size: declaredSize,
      body,
      truncated: declaredSize > body.length,
    }
  }

  /**
   * Current UID list of a mailbox (newest last), used by the wait tool.
   * @returns {Promise<number[]>} uids
   */
  async allUids() {
    return this.uidSearch('ALL')
  }
}

/** Convenience: connect, run, always logout. */
export async function withImap(options, operation) {
  const client = new ImapClient(options)
  try {
    await client.connect()
    return await operation(client)
  } finally {
    try {
      await client.logout()
    } catch { /* ignore */ }
    client.destroy()
  }
}

export { DAYS }

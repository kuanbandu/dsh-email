/**
 * Account registry and secret storage for dsh-email.
 *
 * Splitting the two is the whole point: `accounts.json` holds only routing
 * metadata (provider, address, endpoints), so it is safe to read, copy, and
 * show; the password lives in the Harness credential store under
 * `credentialKey('dsh-email', <account id>)` and is read once per operation.
 * Neither ever enters the agent's tool results.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const STORE_VERSION = 1

/**
 * Brand a `<scope>/<id>` credential-record key the same way the Harness
 * credentials package does, without importing it: this module stays runnable
 * under plain `node` for the self-test, and the runtime value is identical.
 * @param {string} scope plugin scope, `[a-z][a-z0-9-]*`
 * @param {string} id record id, `[a-z][a-z0-9-]*`
 * @returns {string} record key
 */
export function credentialRecordKey(scope, id) {
  const pattern = /^[a-z][a-z0-9-]*$/
  for (const segment of [scope, id]) {
    if (pattern.test(segment) === false) throw new TypeError(`credential key segment "${segment}" is invalid`)
  }
  return `${scope}/${id}`
}
const FILE_NAME = 'accounts.json'

/** Default on-disk location, under the Harness home so it survives upgrades. */
export function defaultDataDir() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'plugin-data', 'dsh-email')
}

/** A stable, credential-key-safe account id: `acc-1a2b3c4d`. */
export function newAccountId() {
  return `acc-${randomBytes(4).toString('hex')}`
}

/**
 * Read the store from disk, repairing or discarding a damaged file.
 * @param {string} dataDir directory holding accounts.json
 * @returns {{version: number, defaultId: string|undefined, accounts: object[]}} store
 */
function readStore(dataDir) {
  const file = join(dataDir, FILE_NAME)
  if (!existsSync(file)) return { version: STORE_VERSION, defaultId: undefined, accounts: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts.filter(account => typeof account?.id === 'string') : []
    return {
      version: STORE_VERSION,
      defaultId: typeof parsed?.defaultId === 'string' ? parsed.defaultId : undefined,
      accounts,
    }
  } catch {
    // Keep the unreadable file for forensics rather than silently overwriting it.
    try {
      renameSync(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* ignore */ }
    return { version: STORE_VERSION, defaultId: undefined, accounts: [] }
  }
}

/** Account registry backed by one small JSON file. */
export class AccountStore {
  /** @param {{dataDir?: string}} [options] store options */
  constructor(options = {}) {
    this.dataDir = options.dataDir !== undefined && options.dataDir !== '' ? options.dataDir : defaultDataDir()
    this.store = readStore(this.dataDir)
  }

  get file() {
    return join(this.dataDir, FILE_NAME)
  }

  /** Persist atomically with owner-only permissions. */
  #persist() {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(this.store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch { /* best effort on filesystems without modes */ }
  }

  /** Reload from disk (the file may have been edited between operations). */
  refresh() {
    this.store = readStore(this.dataDir)
    return this
  }

  /** @returns {object[]} every account, secrets excluded by construction */
  list() {
    return this.store.accounts.map(account => this.publicView(account))
  }

  /** @returns {object|undefined} the stored account record */
  get(id) {
    return this.store.accounts.find(account => account.id === id)
  }

  /**
   * Look up one account by address.
   * @param {string} email address
   * @returns {object|undefined} the stored record
   */
  findByEmail(email) {
    const wanted = String(email ?? '').toLowerCase()
    return this.store.accounts.find(account => String(account.email ?? '').toLowerCase() === wanted)
  }

  /** @returns {object|undefined} the record a caller gets when it names no account */
  resolve(id) {
    const wanted = id !== undefined && id !== '' ? id : this.store.defaultId
    if (wanted !== undefined) {
      const hit = this.store.accounts.find(account => account.id === wanted || account.email === wanted)
      if (hit !== undefined) return hit
      if (id !== undefined && id !== '') {
        throw new AccountError(`没有找到账户 "${id}"；先用 email_accounts 列出可用账户`, 'ACCOUNT_NOT_FOUND')
      }
    }
    if (this.store.accounts.length === 0) {
      throw new AccountError('还没有登录任何邮箱。请在 设置 → 邮件 里添加一个账号', 'NO_ACCOUNTS')
    }
    if (this.store.accounts.length === 1) return this.store.accounts[0]
    throw new AccountError(`配置了多个邮箱，请用 account 参数指定其中一个：${this.store.accounts.map(a => a.email).join(', ')}`, 'ACCOUNT_AMBIGUOUS')
  }

  /**
   * Insert or replace one account.
   * @param {object} record full account record
   * @returns {object} the stored record
   */
  upsert(record) {
    const index = this.store.accounts.findIndex(account => account.id === record.id)
    if (index >= 0) this.store.accounts[index] = record
    else this.store.accounts.push(record)
    if (this.store.defaultId === undefined) this.store.defaultId = record.id
    this.#persist()
    return record
  }

  /**
   * Remove an account and its secret.
   * @param {string} id account id
   * @returns {object|undefined} the removed record
   */
  remove(id) {
    const index = this.store.accounts.findIndex(account => account.id === id)
    if (index < 0) return undefined
    const [removed] = this.store.accounts.splice(index, 1)
    if (this.store.defaultId === id) this.store.defaultId = this.store.accounts[0]?.id
    this.#persist()
    return removed
  }

  /**
   * Mark one account as the default used when a tool omits `account`.
   * @param {string} id account id
   * @returns {object[]} the public account list
   */
  setDefault(id) {
    if (this.get(id) === undefined) throw new AccountError(`没有找到账户 "${id}"`, 'ACCOUNT_NOT_FOUND')
    this.store.defaultId = id
    this.#persist()
    return this.list()
  }

  /**
   * Address-free view for UI and tool output.
   * @param {object} account stored record
   * @returns {object} public view
   */
  publicView(account) {
    return {
      id: account.id,
      provider: account.provider,
      providerLabel: account.providerLabel ?? account.provider,
      email: account.email,
      label: account.label ?? '',
      proxy: account.proxy ?? '',
      smtpProxy: account.smtpProxy ?? '',
      imap: account.imap,
      smtp: account.smtp,
      createdAt: account.createdAt,
      lastTest: account.lastTest ?? null,
      default: this.store.defaultId === account.id,
    }
  }
}

/** Error with a stable code the tools and the HTTP API both report. */
export class AccountError extends Error {
  /**
   * @param {string} message human readable cause
   * @param {string} code stable code
   */
  constructor(message, code = 'ACCOUNT_ERROR') {
    super(message)
    this.name = 'AccountError'
    this.code = code
  }
}

/** Password storage in the Harness credential store. */
export class PasswordVault {
  /** @param {{credentials: {readRecord: Function, modifyRecord: Function, deleteRecord: Function}}} ctx host context with credentials */
  constructor(ctx) {
    this.credentials = ctx.credentials
  }

  /**
   * @param {string} accountId account id
   * @returns {string} record key
   */
  key(accountId) {
    return credentialRecordKey('dsh-email', accountId)
  }

  /**
   * Read the stored password for an account.
   * @param {string} accountId account id
   * @returns {Promise<string>} the secret
   * @throws {AccountError} when nothing is stored
   */
  async read(accountId) {
    const record = await this.credentials.readRecord(this.key(accountId))
    if (record === undefined) {
      throw new AccountError('该账户没有保存密码，请在 设置 → 邮件 重新登录一次', 'PASSWORD_MISSING')
    }
    if (record.kind === 'api-key') {
      if (typeof record.key !== 'string' || record.key === '') {
        throw new AccountError('该账户保存的密码为空，请重新登录一次', 'PASSWORD_MISSING')
      }
      return record.key
    }
    const payload = record.payload
    if (typeof payload === 'string' && payload !== '') return payload
    if (payload !== null && typeof payload === 'object' && typeof payload.password === 'string') return payload.password
    throw new AccountError('该账户保存的凭据格式无法识别，请重新登录一次', 'PASSWORD_INVALID')
  }

  /**
   * Replace the stored password.
   * @param {string} accountId account id
   * @param {string} password non-empty secret
   * @returns {Promise<void>} after the write commits
   */
  async write(accountId, password) {
    const value = String(password ?? '')
    if (value === '') throw new AccountError('密码不能为空', 'PASSWORD_EMPTY')
    await this.credentials.modifyRecord(this.key(accountId), async () => ({ kind: 'api-key', key: value }))
  }

  /**
   * Forget one password; missing records are a no-op.
   * @param {string} accountId account id
   * @returns {Promise<void>} after the delete
   */
  async remove(accountId) {
    await this.credentials.deleteRecord(this.key(accountId))
  }

  /**
   * Whether a password is present, without reading it into a caller.
   * @param {string} accountId account id
   * @returns {Promise<boolean>} presence
   */
  async has(accountId) {
    try {
      return (await this.read(accountId)) !== ''
    } catch {
      return false
    }
  }
}

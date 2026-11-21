/**
 * Minimal SMTP submission client for dsh-email — dependency-free.
 *
 * Supports implicit TLS (465), STARTTLS (587/proton bridge) and plain
 * loopback transports, with AUTH PLAIN / AUTH LOGIN and one message per
 * connection. Enough for agent-driven sending without any npm dependency.
 */

import tls from 'node:tls'
import { hostname as osHostname } from 'node:os'
import { openMailSocket } from './proxy.js'

/** SMTP failure carrying the failing stage. */
export class SmtpError extends Error {
  /**
   * @param {string} message human readable cause
   * @param {{code?: string, stage?: string, replyCode?: number}} [info] machine hints
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'SmtpError'
    this.code = info.code ?? 'SMTP_ERROR'
    this.stage = info.stage ?? 'unknown'
    this.replyCode = info.replyCode
  }
}

/** Address-list helper: keep only the address part of "Name <addr>". */
function bareAddress(address) {
  const text = String(address ?? '').trim()
  const angle = /<([^>]+)>/.exec(text)
  return angle === null ? text : angle[1].trim()
}

function sanitizeHostname() {
  const raw = osHostname().replace(/[^A-Za-z0-9.-]/g, '')
  return raw === '' || raw.includes('.') === false ? 'dsh-email.local' : raw
}

/** Blocking, timeout-guarded SMTP session. */
export class SmtpClient {
  /**
   * @param {{
   *   host: string, port?: number, secure?: boolean, starttls?: boolean,
   *   rejectUnauthorized?: boolean, username?: string, password?: string,
   *   timeoutMs?: number, proxy?: string, bypass?: string[],
   * }} options connection settings
   */
  constructor(options) {
    this.options = {
      port: 465,
      secure: true,
      starttls: false,
      rejectUnauthorized: true,
      timeoutMs: 20_000,
      proxy: '',
      bypass: [],
      ...options,
    }
    this.socket = undefined
    this.buffer = Buffer.alloc(0)
    this.waiters = []
    this.capabilities = []
    this.failure = undefined
  }

  #attach(socket, stage) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    socket.setNoDelay?.(true)
    socket.on('data', chunk => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
      this.#drain()
    })
    socket.on('error', error => this.#fail(new SmtpError(`SMTP ${stage} error: ${error.message}`, { code: 'SMTP_SOCKET', stage })))
    socket.on('close', () => this.#fail(new SmtpError('SMTP connection closed by the server', { code: 'SMTP_CLOSED', stage })))
    // A proxied socket arrives paused (so no greeting byte is lost); attach to
    // the data listener, then resume explicitly to flush what is buffered.
    socket.resume?.()
  }

  #fail(error) {
    if (this.failure !== undefined) return
    this.failure = error
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    try {
      this.socket?.destroy()
    } catch { /* ignore */ }
  }

  #parseResponse() {
    let cursor = 0
    const lines = []
    for (;;) {
      const newline = this.buffer.indexOf('\n', cursor)
      if (newline < 0) return undefined
      let line = this.buffer.toString('utf8', cursor, newline)
      cursor = newline + 1
      if (line.endsWith('\r')) line = line.slice(0, -1)
      lines.push(line)
      if (/^\d{3}(?: |$)/.test(line)) {
        this.buffer = this.buffer.subarray(cursor)
        return { code: Number(line.slice(0, 3)), lines, text: lines.join('\n') }
      }
    }
  }

  #drain() {
    for (;;) {
      const parsed = this.#parseResponse()
      if (parsed === undefined) return
      const waiter = this.waiters.shift()
      if (waiter === undefined) continue
      clearTimeout(waiter.timer)
      waiter.resolve(parsed)
    }
  }

  #read(timeoutMs = this.options.timeoutMs) {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SmtpError(`SMTP timed out after ${timeoutMs}ms`, { code: 'SMTP_TIMEOUT' }))
      }, timeoutMs)
      timer.unref?.()
      this.waiters.push({ resolve, reject, timer })
      this.#drain()
    })
  }

  async #write(text) {
    if (this.socket === undefined) throw new SmtpError('SMTP client is not connected', { code: 'SMTP_NOT_CONNECTED' })
    await new Promise((resolve, reject) => {
      this.socket.write(text, error => (error ? reject(new SmtpError(`SMTP write failed: ${error.message}`, { code: 'SMTP_WRITE' })) : resolve()))
    })
  }

  /**
   * Send one command and require an expected reply code.
   * @param {string} line command line (without CRLF)
   * @param {number[]} expected accepted reply codes
   * @param {string} stage stage name for errors
   * @returns {Promise<{code: number, text: string}>} the reply
   */
  async #command(line, expected, stage) {
    await this.#write(`${line}\r\n`)
    const reply = await this.#read()
    if (!expected.includes(reply.code)) {
      throw new SmtpError(`SMTP ${stage} rejected (${reply.code}): ${reply.text}`, {
        code: 'SMTP_REJECTED',
        stage,
        replyCode: reply.code,
      })
    }
    return reply
  }

  /** Connect, greet, negotiate TLS, and authenticate. */
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
      throw new SmtpError(`SMTP 连接失败：${error instanceof Error ? error.message : String(error)}`, {
        code: 'SMTP_CONNECT',
        stage: 'connect',
      })
    }
    this.#attach(socket, 'connect')
    const greeting = await this.#read()
    if (greeting.code !== 220) {
      throw new SmtpError(`SMTP server refused the session (${greeting.code}): ${greeting.text}`, { code: 'SMTP_GREETING', stage: 'greeting', replyCode: greeting.code })
    }
    await this.ehlo()
    if (this.options.starttls && !this.options.secure) {
      await this.#startTls()
      await this.ehlo()
    }
    if (this.options.username !== undefined && this.options.username !== '') {
      await this.authenticate()
    }
  }

  /** EHLO with a HELO fallback. */
  async ehlo() {
    try {
      const reply = await this.#command(`EHLO ${sanitizeHostname()}`, [250], 'ehlo')
      this.capabilities = reply.text.split('\n').slice(1).map(line => line.replace(/^\d{3}[- ]?/, '').trim())
    } catch (error) {
      if (error instanceof SmtpError && error.code === 'SMTP_REJECTED') {
        await this.#command(`HELO ${sanitizeHostname()}`, [250], 'helo')
        this.capabilities = []
        return
      }
      throw error
    }
  }

  async #startTls() {
    const { host, rejectUnauthorized } = this.options
    const reply = await this.#command('STARTTLS', [220], 'starttls')
    if (reply.code !== 220) throw new SmtpError(`SMTP STARTTLS refused: ${reply.text}`, { code: 'SMTP_STARTTLS', stage: 'starttls' })
    const plain = this.socket
    plain.removeAllListeners('data')
    plain.removeAllListeners('close')
    plain.removeAllListeners('error')
    this.socket = undefined
    this.buffer = Buffer.alloc(0)
    const secured = tls.connect({ socket: plain, servername: host, rejectUnauthorized })
    this.#attach(secured, 'starttls')
    await new Promise((resolve, reject) => {
      secured.once('secureConnect', resolve)
      secured.once('error', error => reject(new SmtpError(`SMTP STARTTLS handshake failed: ${error.message}`, { code: 'SMTP_STARTTLS', stage: 'starttls' })))
    })
  }

  /** AUTH PLAIN when offered, otherwise AUTH LOGIN. */
  async authenticate() {
    const { username, password } = this.options
    const join = this.capabilities.join(' ').toUpperCase()
    const offersPlain = /AUTH[=\s][^\n]*PLAIN/.test(join) || /AUTH=PLAIN/.test(join)
    if (offersPlain || !join.includes('AUTH')) {
      try {
        const token = Buffer.from(`\u0000${username}\u0000${password}`, 'utf8').toString('base64')
        await this.#command(`AUTH PLAIN ${token}`, [235], 'auth')
        return
      } catch (error) {
        if (!(error instanceof SmtpError) || error.replyCode !== 504) throw error
      }
    }
    await this.#command('AUTH LOGIN', [334], 'auth')
    await this.#command(Buffer.from(username, 'utf8').toString('base64'), [334], 'auth')
    await this.#command(Buffer.from(password, 'utf8').toString('base64'), [235], 'auth')
  }

  /**
   * Send one message.
   * @param {{from: string, recipients: string[], data: Buffer}} mail message
   * @returns {Promise<{accepted: string[], rejected: string[]}>} per-recipient outcome
   */
  async send(mail) {
    const from = bareAddress(mail.from)
    const recipients = [...new Set((mail.recipients ?? []).map(bareAddress).filter(address => address !== ''))]
    if (recipients.length === 0) throw new SmtpError('no recipient address', { code: 'SMTP_NO_RECIPIENTS', stage: 'mail' })
    await this.#command(`MAIL FROM:<${from}>`, [250], 'mail from')
    const accepted = []
    const rejected = []
    for (const recipient of recipients) {
      try {
        await this.#command(`RCPT TO:<${recipient}>`, [250, 251], 'rcpt to')
        accepted.push(recipient)
      } catch (error) {
        if (error instanceof SmtpError && error.code === 'SMTP_REJECTED') rejected.push(recipient)
        else throw error
      }
    }
    if (accepted.length === 0) {
      throw new SmtpError(`every recipient was rejected: ${rejected.join(', ')}`, { code: 'SMTP_ALL_REJECTED', stage: 'rcpt to' })
    }
    await this.#command('DATA', [354], 'data')
    const normalized = mail.data.toString('utf8').replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
    const body = normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`
    await this.#write(`${body}.\r\n`)
    const reply = await this.#read(Math.max(this.options.timeoutMs, 60_000))
    if (reply.code !== 250) {
      throw new SmtpError(`SMTP message rejected (${reply.code}): ${reply.text}`, { code: 'SMTP_REJECTED', stage: 'data', replyCode: reply.code })
    }
    return { accepted, rejected }
  }

  /** Polite end of session. */
  async quit() {
    try {
      await this.#command('QUIT', [221, 250], 'quit')
    } catch { /* the server may already be gone */ }
    this.destroy()
  }

  /** Hard close. */
  destroy() {
    this.failure ??= new SmtpError('SMTP client closed', { code: 'SMTP_CLOSED' })
    try {
      this.socket?.destroy()
    } catch { /* ignore */ }
    this.socket = undefined
  }
}

/**
 * Verify credentials without sending mail: connect + EHLO + AUTH + QUIT.
 * @param {ConstructorParameters<typeof SmtpClient>[0]} options connection settings
 * @returns {Promise<{ok: true, capabilities: string[]}>} verification result
 */
export async function verifySmtp(options) {
  const client = new SmtpClient(options)
  try {
    await client.connect()
    return { ok: true, capabilities: client.capabilities }
  } finally {
    try {
      await client.quit()
    } catch { /* ignore */ }
    client.destroy()
  }
}

/**
 * Proxy support for mail connections.
 *
 * A mail client cannot ask an HTTP library for a tunnel, so this module opens
 * one itself: HTTP `CONNECT` (what Clash/mihomo "mixed" ports answer) or
 * SOCKS5 no-auth. The returned socket is a plain TCP stream to the target, so
 * the IMAP/SMTP clients wrap it in TLS exactly as they do a direct connection,
 * and STARTTLS keeps working on top of the tunnel.
 */

import net from 'node:net'
import tls from 'node:tls'

/** Values that mean "do not use the configured proxy for this account". */
const DIRECT_WORDS = /^(off|none|direct|no|直连)$/i

/**
 * Whether a configured proxy value means "connect directly".
 * @param {unknown} value raw setting
 * @returns {boolean} true when no proxy should be used
 */
export function isDirect(value) {
  return typeof value === 'string' && DIRECT_WORDS.test(value.trim())
}

/**
 * Parse a proxy setting.
 *
 * Accepts `host:port`, `http://host:port`, `https://host:port`,
 * `socks5://host:port` and `socks5h://host:port`; the port is required.
 * @param {unknown} value raw setting
 * @returns {{protocol: 'http'|'socks5', host: string, port: number} | undefined} parsed proxy, undefined when unset
 * @throws {Error} when the value is present but unusable
 */
export function parseProxy(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  if (text === '' || isDirect(text)) return undefined

  let protocol = 'http'
  let rest = text
  const scoped = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(text)
  if (scoped !== null) {
    const scheme = scoped[1].toLowerCase()
    rest = scoped[2]
    if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks') protocol = 'socks5'
    else if (scheme === 'http' || scheme === 'https') protocol = 'http'
    else throw new Error(`不支持的代理协议 "${scoped[1]}"（只支持 http/https/socks5）`)
  }
  rest = rest.replace(/\/+$/, '')
  const at = rest.lastIndexOf('@')
  if (at >= 0) rest = rest.slice(at + 1) // credentials are not supported; ignore them rather than leak them

  const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(rest) ?? /^([^:\s]+):(\d{1,5})$/.exec(rest)
  if (match === null) {
    throw new Error(`代理地址格式不对: "${text}"（应为 host:port，例如 127.0.0.1:7890）`)
  }
  const host = match[1]
  const port = Number(match[2])
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`代理端口无效: ${match[2]}`)
  return { protocol, host, port }
}

/** Loopback and link-local names that must never be sent to a remote proxy. */
const ALWAYS_BYPASS = ['127.', 'localhost', '::1', '[::1]', '0.0.0.0', '.local', 'host.docker.internal']

/**
 * Whether a target host should skip the proxy.
 * @param {string} host target hostname
 * @param {string[]} [extra] additional host suffixes taken from configuration
 * @returns {boolean} true when the connection must be direct
 */
export function shouldBypass(host, extra = []) {
  const target = String(host ?? '').toLowerCase()
  if (target === '') return true
  const rules = [...ALWAYS_BYPASS, ...extra.map(entry => String(entry).toLowerCase()).filter(Boolean)]
  return rules.some(rule => (rule.startsWith('.') ? target.endsWith(rule) : target === rule || target.startsWith(rule)))
}

/** Wait for a socket to connect, with a deadline. */
function waitConnect(socket, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`${label} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref?.()
    socket.once('connect', () => { clearTimeout(timer); resolve() })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

/**
 * Read one chunk in paused ("readable") mode.
 *
 * Flowing mode (`on('data')`) is unusable here: a proxy answers CONNECT and the
 * server greeting can arrive in the same packet, and any byte the handshake
 * does not want must be pushed back — `unshift()` is only reliable while the
 * stream stays paused. Reading with `read()` keeps it that way, so the caller
 * can hand a pristine, paused socket to the IMAP/SMTP client.
 */
function readChunk(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const done = (fn, value) => {
      clearTimeout(timer)
      socket.removeListener('readable', onReadable)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      fn(value)
    }
    const onReadable = () => {
      const chunk = socket.read()
      if (chunk === null) return
      done(resolve, chunk)
    }
    const onError = error => done(reject, error)
    const onClose = () => done(reject, new Error('代理连接在握手完成前被关闭'))
    const timer = setTimeout(() => done(reject, new Error(`代理应答超时（${timeoutMs}ms）`)), timeoutMs)
    timer.unref?.()
    socket.on('readable', onReadable)
    socket.on('error', onError)
    socket.on('close', onClose)
    onReadable()
  })
}

/** Read exactly `count` bytes, keeping the remainder buffered in `state`. */
async function readExact(socket, count, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (state.buffer.length < count) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`代理应答超时（${timeoutMs}ms）`)
    state.buffer = Buffer.concat([state.buffer, await readChunk(socket, remaining)])
  }
  const out = state.buffer.subarray(0, count)
  state.buffer = state.buffer.subarray(count)
  return out
}

/** HTTP CONNECT tunnel through a forward proxy. */
async function httpConnect(socket, proxy, host, port, timeoutMs) {
  socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: keep-alive\r\n\r\n`)
  const deadline = Date.now() + timeoutMs
  let buffer = Buffer.alloc(0)
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error(`HTTP 代理 CONNECT 超时（${timeoutMs}ms）`)
    buffer = Buffer.concat([buffer, await readChunk(socket, remaining)])
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) continue
    const head = buffer.subarray(0, end).toString('latin1')
    const rest = buffer.subarray(end + 4)
    if (rest.length > 0) socket.unshift(rest)
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0)
    if (status !== 200) {
      throw new Error(`HTTP 代理拒绝 CONNECT ${host}:${port}：${head.split('\r\n')[0]}`)
    }
    return
  }
}

/** SOCKS5 (no authentication) CONNECT tunnel. */
async function socks5Connect(socket, proxy, host, port, timeoutMs) {
  const state = { buffer: Buffer.alloc(0) }
  socket.write(Buffer.from([0x05, 0x01, 0x00]))
  const greeting = await readExact(socket, 2, state, timeoutMs)
  if (greeting[0] !== 0x05) throw new Error('SOCKS5 代理应答无效（该端口不是 SOCKS5？）')
  if (greeting[1] !== 0x00) throw new Error('SOCKS5 代理要求认证，本插件只支持无认证代理')

  const name = Buffer.from(host, 'utf8')
  if (name.length > 255) throw new Error('SOCKS5 目标域名过长')
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
    name,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
  ]))
  const head = await readExact(socket, 4, state, timeoutMs)
  if (head[0] !== 0x05) throw new Error('SOCKS5 代理应答无效')
  if (head[1] !== 0x00) {
    const reasons = { 1: '一般失败', 2: '规则不允许', 3: '网络不可达', 4: '主机不可达', 5: '连接被拒绝', 6: 'TTL 超时', 7: '不支持的命令', 8: '不支持的地址类型' }
    throw new Error(`SOCKS5 代理拒绝连接 ${host}:${port}（${reasons[head[1]] ?? `错误码 ${head[1]}`}）`)
  }
  const atyp = head[3]
  if (atyp === 0x01) await readExact(socket, 4 + 2, state, timeoutMs)
  else if (atyp === 0x04) await readExact(socket, 16 + 2, state, timeoutMs)
  else if (atyp === 0x03) {
    const length = await readExact(socket, 1, state, timeoutMs)
    await readExact(socket, length[0] + 2, state, timeoutMs)
  } else throw new Error(`SOCKS5 应答的地址类型未知: ${atyp}`)
  if (state.buffer.length > 0) socket.unshift(state.buffer)
}

/**
 * Open a TCP tunnel to `host:port` through `proxy`.
 * @param {{host: string, port: number, protocol: 'http'|'socks5'}} proxy parsed proxy
 * @param {string} host target host
 * @param {number} port target port
 * @param {number} timeoutMs deadline for the whole handshake
 * @returns {Promise<import('node:net').Socket>} connected, paused plain socket to the target
 */
export async function openTunnel(proxy, host, port, timeoutMs = 20_000) {
  const socket = net.connect({ host: proxy.host, port: proxy.port })
  socket.setNoDelay?.(true)
  try {
    await waitConnect(socket, timeoutMs, `连接代理 ${proxy.host}:${proxy.port}`)
    if (proxy.protocol === 'socks5') await socks5Connect(socket, proxy, host, port, timeoutMs)
    else await httpConnect(socket, proxy, host, port, timeoutMs)
    // Everything the handshake did not consume was unshifted back; the socket
    // stays paused so the caller's first listener receives it.
    socket.pause()
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/**
 * Open a mail socket, directly or through a proxy, and optionally wrap it in TLS.
 *
 * This is the one place that knows how a socket to `host:port` is obtained, so
 * IMAP and SMTP connect identically whether the route is direct, HTTP CONNECT
 * or SOCKS5.
 * @param {{
 *   host: string, port: number, secure?: boolean, rejectUnauthorized?: boolean,
 *   proxy?: string, bypass?: string[], timeoutMs?: number,
 * }} options connection settings
 * @returns {Promise<import('node:net').Socket | import('node:tls').TLSSocket>} ready socket
 */
export async function openMailSocket(options) {
  const timeoutMs = options.timeoutMs ?? 20_000
  const parsed = parseProxy(options.proxy)
  const direct = parsed === undefined || shouldBypass(options.host, options.bypass ?? [])
  const raw = direct
    ? await (async () => {
      const socket = net.connect({ host: options.host, port: options.port })
      socket.setNoDelay?.(true)
      await waitConnect(socket, timeoutMs, `连接 ${options.host}:${options.port}`)
      return socket
    })()
    : await openTunnel(parsed, options.host, options.port, timeoutMs)

  if (options.secure !== true) return raw

  const secured = tls.connect({
    socket: raw,
    servername: options.host,
    rejectUnauthorized: options.rejectUnauthorized !== false,
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      secured.destroy()
      reject(new Error(`TLS 握手超时（${options.host}:${options.port}，${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref?.()
    secured.once('secureConnect', () => { clearTimeout(timer); resolve() })
    secured.once('error', error => { clearTimeout(timer); reject(error) })
  })
  return secured
}

/**
 * One-line description of the route, for reports and the settings page.
 * @param {{proxy?: string, bypass?: string[]}} options connection settings
 * @param {string} host target host
 * @returns {string} `direct` or the proxy address
 */
export function describeRoute(options, host) {
  const parsed = parseProxy(options.proxy)
  if (parsed === undefined || shouldBypass(host, options.bypass ?? [])) return 'direct'
  return `${parsed.protocol}://${parsed.host}:${parsed.port}`
}

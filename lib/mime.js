/**
 * MIME codec for dsh-email — dependency-free.
 *
 * Two directions:
 *  - parse:  raw RFC 5322 message bytes -> headers, decoded text, html, attachments
 *  - build:  structured message -> raw bytes for SMTP DATA
 *
 * Everything works on Buffers, so 8-bit headers and GBK/GB18030 bodies survive.
 */

const CRLF = '\r\n'
const HEADER_SEPARATOR = Buffer.from(`${CRLF}${CRLF}`)

// ---------------------------------------------------------------------------
// Charset
// ---------------------------------------------------------------------------

/** Map common aliases onto labels Node's TextDecoder understands with full ICU. */
export function normalizeCharset(charset) {
  const raw = String(charset ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase()
  if (raw === '') return 'utf-8'
  const alias = {
    utf8: 'utf-8',
    utf_8: 'utf-8',
    'utf-8': 'utf-8',
    gb2312: 'gb18030',
    gbk: 'gb18030',
    cp936: 'gb18030',
    gb18030: 'gb18030',
    big5: 'big5',
    'big5-hkscs': 'big5',
    latin1: 'iso-8859-1',
    'iso8859-1': 'iso-8859-1',
    'iso-8859-1': 'iso-8859-1',
    ascii: 'iso-8859-1',
    'us-ascii': 'iso-8859-1',
    windows1252: 'windows-1252',
    sjis: 'shift_jis',
    'shift-jis': 'shift_jis',
    euckr: 'euc-kr',
  }
  return alias[raw] ?? raw
}

/**
 * Decode bytes with the declared charset, degrading instead of throwing.
 * @param {Buffer} buf bytes
 * @param {string} charset charset label from MIME
 * @returns {string} decoded text
 */
export function decodeText(buf, charset) {
  if (buf == null) return ''
  const label = normalizeCharset(charset)
  try {
    return new TextDecoder(label, { fatal: false }).decode(buf)
  } catch {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

// ---------------------------------------------------------------------------
// Encoded words (RFC 2047)
// ---------------------------------------------------------------------------

const ENCODED_WORD = '=\\?[^?\\s]+\\?[BbQq]\\?[^?\\s]*\\?='

function decodeQ(text) {
  const spaced = text.replace(/_/g, ' ')
  const bytes = []
  for (let i = 0; i < spaced.length; i += 1) {
    const ch = spaced[i]
    if (ch === '=' && /^[0-9a-fA-F]{2}$/.test(spaced.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(spaced.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(spaced.charCodeAt(i) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

function decodeWord(word) {
  const match = /^=\?([^?]+)\?([BbQq])\?([^?]*)\?=$/.exec(word)
  if (match === null) return word
  const [, charset, encoding, payload] = match
  let bytes
  try {
    bytes = encoding.toLowerCase() === 'b'
      ? Buffer.from(payload, 'base64')
      : decodeQ(payload)
  } catch {
    return word
  }
  return decodeText(bytes, charset)
}

/**
 * Decode RFC 2047 encoded words in a header value; adjacent encoded words are
 * joined without the whitespace between them, per the RFC.
 * @param {string} value raw header value
 * @returns {string} readable text
 */
export function decodeEncodedWords(value) {
  if (typeof value !== 'string' || !value.includes('=?')) return value ?? ''
  const joined = new RegExp(`(${ENCODED_WORD})(\\s+(?=${ENCODED_WORD}))?`, 'g')
  return value.replace(joined, (_all, word) => decodeWord(word))
}

function encodeWord(text) {
  // Split on code points so no multi-byte character is cut in half; each
  // encoded word stays under the 75-character limit.
  const words = []
  let current = []
  let bytes = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (bytes + size > 45 && current.length > 0) {
      words.push(current.join(''))
      current = []
      bytes = 0
    }
    current.push(ch)
    bytes += size
  }
  if (current.length > 0) words.push(current.join(''))
  return words.map(word => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join(`${CRLF} `)
}

/** Whether a header value must be RFC 2047 encoded to survive transit. */
function needsEncoding(value) {
  // eslint-disable-next-line no-control-regex
  return /[^\x20-\x7e]/.test(value)
}

/**
 * Encode one header value (subject, display name) for transport.
 * @param {string} value readable text
 * @returns {string} transport-safe header value
 */
export function encodeHeaderValue(value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim()
  return needsEncoding(text) ? encodeWord(text) : text
}

// ---------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------

/** Locate the blank line separating headers from body. */
function findHeaderEnd(raw) {
  const index = raw.indexOf(HEADER_SEPARATOR)
  if (index >= 0) return { headerEnd: index, bodyStart: index + 4 }
  const lf = raw.indexOf(Buffer.from('\n\n'))
  if (lf >= 0) return { headerEnd: lf, bodyStart: lf + 2 }
  return { headerEnd: raw.length, bodyStart: raw.length }
}

/**
 * Parse a raw header block into ordered name/value pairs (values unfolded, but
 * still RFC 2047 encoded).
 * @param {Buffer|string} block header bytes
 * @returns {{name: string, value: string}[]} ordered headers
 */
export function parseHeaderBlock(block) {
  const text = Buffer.isBuffer(block) ? decodeText(block, 'utf-8') : String(block)
  const out = []
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1].value += ` ${line.trim()}`
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    out.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() })
  }
  return out
}

/**
 * Case-insensitive header lookup over {@link parseHeaderBlock} output.
 * @param {{name: string, value: string}[]} headers parsed headers
 * @param {string} name header name
 * @returns {string} decoded first value, or ''
 */
export function headerValue(headers, name) {
  const lower = name.toLowerCase()
  const hit = headers.find(h => h.name.toLowerCase() === lower)
  return hit === undefined ? '' : decodeEncodedWords(hit.value)
}

/**
 * Parse a structured header value with parameters, e.g.
 * `multipart/mixed; boundary="x"` -> `{ value: 'multipart/mixed', params: { boundary: 'x' } }`.
 * @param {string} raw header value
 * @returns {{value: string, params: Record<string, string>}} structure
 */
export function parseParams(raw) {
  const text = String(raw ?? '')
  const params = {}
  let value = text
  const firstSemi = text.indexOf(';')
  if (firstSemi >= 0) value = text.slice(0, firstSemi)
  value = value.trim().toLowerCase()

  const pattern = /;\s*([^=;\s]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^;]*)/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const key = match[1].toLowerCase()
    let raw2 = match[2].trim()
    if (raw2.startsWith('"') && raw2.endsWith('"') && raw2.length >= 2) {
      raw2 = raw2.slice(1, -1).replace(/\\(.)/g, '$1')
    }
    params[key] = raw2
  }
  return { value, params }
}

/** Resolve `name` / `name*` (RFC 2231) parameter pairs into one decoded string. */
function fetchParam(params, name) {
  const extended = params[`${name}*`]
  if (extended !== undefined) {
    const match = /^([^']*)'([^']*)'(.*)$/.exec(extended)
    if (match !== null) {
      const [, charset, , encoded] = match
      const bytes = []
      for (const piece of encoded.match(/%[0-9a-fA-F]{2}|[^%]+/g) ?? []) {
        if (piece.startsWith('%')) bytes.push(Number.parseInt(piece.slice(1), 16))
        else for (const byte of Buffer.from(piece, 'utf8')) bytes.push(byte)
      }
      return decodeText(Buffer.from(bytes), charset)
    }
    return extended
  }
  const plain = params[name]
  return plain === undefined ? undefined : decodeEncodedWords(plain)
}

// ---------------------------------------------------------------------------
// Transfer decoding
// ---------------------------------------------------------------------------

/**
 * Undo a Content-Transfer-Encoding.
 * @param {Buffer} buf body bytes
 * @param {string} encoding declared encoding
 * @returns {Buffer} decoded bytes
 */
export function decodeTransfer(buf, encoding) {
  const mode = String(encoding ?? '').trim().toLowerCase()
  if (mode === 'base64') {
    const compact = buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, '')
    try {
      return Buffer.from(compact, 'base64')
    } catch {
      return buf
    }
  }
  if (mode === 'quoted-printable') {
    const text = buf.toString('latin1')
    const bytes = []
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]
      if (ch === '=') {
        if (text[i + 1] === '\r' && text[i + 2] === '\n') { i += 2; continue }
        if (text[i + 1] === '\n') { i += 1; continue }
        const hex = text.slice(i + 1, i + 3)
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          bytes.push(Number.parseInt(hex, 16))
          i += 2
          continue
        }
      }
      bytes.push(ch.charCodeAt(0) & 0xff)
    }
    return Buffer.from(bytes)
  }
  return buf
}

// ---------------------------------------------------------------------------
// HTML -> text
// ---------------------------------------------------------------------------

/**
 * Crude but predictable HTML-to-text: drops script/style, turns block
 * boundaries into newlines, decodes the common entities. Links keep their href
 * when the anchor text alone loses information.
 * @param {string} html markup
 * @returns {string} readable text
 */
export function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return ''
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript)[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (all, href, inner) => {
      const label = String(inner).replace(/<[^>]+>/g, '').trim()
      if (label === '' ) return ` ${href} `
      return label === href ? label : `${label} (${href})`
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_all, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_all, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  return text
    .split('\n')
    .map(line => line.replace(/[ \t\u00a0]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// Message parsing
// ---------------------------------------------------------------------------

/** Split a multipart body on its boundary delimiters. */
function splitMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`)
  const pieces = []
  let cursor = 0
  const hits = []
  while (cursor < body.length) {
    const at = body.indexOf(delimiter, cursor)
    if (at < 0) break
    hits.push(at)
    cursor = at + delimiter.length
  }
  for (let i = 0; i < hits.length; i += 1) {
    const startOfLine = hits[i]
    const afterDelimiter = startOfLine + delimiter.length
    // Closing delimiter: --boundary--
    if (body[afterDelimiter] === 0x2d && body[afterDelimiter + 1] === 0x2d) break
    const nextHit = i + 1 < hits.length ? hits[i + 1] : body.length
    let start = afterDelimiter
    while (start < nextHit && (body[start] === 0x0d || body[start] === 0x0a)) start += 1
    let end = nextHit
    if (end >= delimiter.length) {
      // Strip the CRLF that belongs to the next delimiter line.
      if (body[end - 1] === 0x0a) end -= 1
      if (body[end - 1] === 0x0d) end -= 1
    }
    pieces.push(body.subarray(start, Math.max(start, end)))
  }
  return pieces
}

/**
 * Parse one raw message.
 * @param {Buffer} raw full message bytes
 * @param {{maxAttachmentBytes?: number, maxDepth?: number}} [options] limits
 * @returns {{
 *   headers: {name: string, value: string}[],
 *   subject: string, from: string, to: string, cc: string, date: string,
 *   messageId: string, inReplyTo: string, references: string,
 *   text: string, html: string,
 *   attachments: {index: number, filename: string, contentType: string, size: number, content: Buffer|null}[],
 *   truncated: boolean,
 * }} parsed message
 */
export function parseMessage(raw, options = {}) {
  const maxAttachmentBytes = options.maxAttachmentBytes ?? 8 * 1024 * 1024
  const maxDepth = options.maxDepth ?? 20
  const { headerEnd, bodyStart } = findHeaderEnd(raw)
  const headers = parseHeaderBlock(raw.subarray(0, headerEnd))
  const body = raw.subarray(bodyStart)

  const textParts = []
  const htmlParts = []
  const attachments = []
  let truncated = false

  const walk = (partHeaders, partBody, depth) => {
    if (depth > maxDepth) return
    const contentType = parseParams(headerValue(partHeaders, 'content-type') || 'text/plain')
    const disposition = parseParams(headerValue(partHeaders, 'content-disposition'))
    const transfer = headerValue(partHeaders, 'content-transfer-encoding')
    const decoded = decodeTransfer(partBody, transfer)

    if (contentType.value.startsWith('multipart/') && contentType.params.boundary !== undefined) {
      for (const child of splitMultipart(decoded, contentType.params.boundary)) {
        const { headerEnd: childEnd, bodyStart: childStart } = findHeaderEnd(child)
        walk(parseHeaderBlock(child.subarray(0, childEnd)), child.subarray(childStart), depth + 1)
      }
      return
    }

    const filename = fetchParam(contentType.params, 'name') ?? fetchParam(disposition.params, 'filename')
    const isAttachment = disposition.value === 'attachment'
      || (filename !== undefined && disposition.value !== 'inline')

    if (isAttachment) {
      const tooBig = decoded.length > maxAttachmentBytes
      if (tooBig) truncated = true
      attachments.push({
        index: attachments.length,
        filename: filename ?? `attachment-${attachments.length + 1}`,
        contentType: contentType.value === '' ? 'application/octet-stream' : contentType.value,
        size: decoded.length,
        content: tooBig ? null : decoded,
      })
      return
    }

    if (contentType.value === 'message/rfc822') {
      // Nested message: surface its text as a quoted part.
      const nested = parseMessage(decoded, options)
      if (nested.text !== '') textParts.push(`--- Forwarded message ---\n${nested.text}`)
      return
    }

    if (contentType.value === 'text/plain') {
      textParts.push(decodeText(decoded, contentType.params.charset))
    } else if (contentType.value === 'text/html') {
      htmlParts.push(decodeText(decoded, contentType.params.charset))
    } else if (filename !== undefined) {
      const tooBig = decoded.length > maxAttachmentBytes
      if (tooBig) truncated = true
      attachments.push({
        index: attachments.length,
        filename,
        contentType: contentType.value,
        size: decoded.length,
        content: tooBig ? null : decoded,
      })
    }
  }

  walk(headers, body, 0)

  const html = htmlParts.join('\n').trim()
  let text = textParts.join('\n').trim()
  if (text === '' && html !== '') text = htmlToText(html)

  return {
    headers,
    subject: headerValue(headers, 'subject'),
    from: headerValue(headers, 'from'),
    to: headerValue(headers, 'to'),
    cc: headerValue(headers, 'cc'),
    date: headerValue(headers, 'date'),
    messageId: headerValue(headers, 'message-id'),
    inReplyTo: headerValue(headers, 'in-reply-to'),
    references: headerValue(headers, 'references'),
    replyTo: headerValue(headers, 'reply-to'),
    text,
    html,
    attachments,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

function wrapBase64(buffer) {
  const base64 = buffer.toString('base64')
  const lines = []
  for (let i = 0; i < base64.length; i += 76) lines.push(base64.slice(i, i + 76))
  return lines.join(CRLF)
}

function formatDate(date) {
  const utc = date.toUTCString() // "Tue, 01 Jan 2025 00:00:00 GMT"
  return utc.replace(/GMT$/, '+0000')
}

function boundary() {
  const rand = Math.random().toString(16).slice(2, 10)
  return `----=_dsh_email_${Date.now().toString(36)}_${rand}`
}

/**
 * Normalize one address into `Name <addr>` with the display name encoded when
 * it is not pure ASCII.
 * @param {string} address user-supplied address
 * @returns {string} header-safe address
 */
export function formatAddress(address) {
  const text = String(address ?? '').trim()
  if (text === '') return ''
  const angle = /^(.*?)\s*<([^>]+)>\s*$/.exec(text)
  if (angle === null) return text
  const name = angle[1].trim().replace(/^"|"$/g, '')
  const addr = angle[2].trim()
  if (name === '') return addr
  return `${needsEncoding(name) ? encodeHeaderValue(name) : `"${name.replace(/"/g, '\\"')}"`} <${addr}>`
}

/** Join several address-list strings into one header value. */
export function formatAddressList(list) {
  const items = Array.isArray(list) ? list : String(list ?? '').split(',')
  return items.map(formatAddress).filter(item => item !== '').join(', ')
}

function encodeFilenameParam(filename) {
  const name = String(filename ?? 'file')
  if (!needsEncoding(name)) return `filename="${name.replace(/"/g, '')}"`
  const encoded = encodeURIComponent(name).replace(/['()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `filename*=UTF-8''${encoded}`
}

/**
 * Build a complete RFC 5322 message for SMTP DATA.
 * @param {{
 *   from: string, to: string[]|string, cc?: string[]|string, bcc?: string[]|string,
 *   subject?: string, text?: string, html?: string,
 *   attachments?: {filename: string, contentType?: string, content: Buffer}[],
 *   inReplyTo?: string, references?: string[], messageId?: string,
 *   date?: Date, headers?: Record<string, string>, replyTo?: string,
 * }} input message
 * @returns {{data: Buffer, messageId: string}} wire bytes and the generated id
 */
export function buildMessage(input) {
  const from = formatAddress(input.from)
  const to = formatAddressList(input.to)
  const cc = formatAddressList(input.cc ?? [])
  const bcc = formatAddressList(input.bcc ?? [])
  const subject = encodeHeaderValue(input.subject ?? '')
  const domain = (/@([^>\s]+)/.exec(from)?.[1] ?? 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost'
  const messageId = input.messageId ?? `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}@${domain}>`
  const attachments = Array.isArray(input.attachments) ? input.attachments : []

  const headers = []
  headers.push(`From: ${from}`)
  if (to !== '') headers.push(`To: ${to}`)
  if (cc !== '') headers.push(`Cc: ${cc}`)
  if (bcc !== '') headers.push(`Bcc: ${bcc}`)
  if (input.replyTo !== undefined && input.replyTo !== '') headers.push(`Reply-To: ${formatAddress(input.replyTo)}`)
  headers.push(`Subject: ${subject}`)
  headers.push(`Date: ${formatDate(input.date ?? new Date())}`)
  headers.push(`Message-ID: ${messageId}`)
  if (input.inReplyTo !== undefined && input.inReplyTo !== '') headers.push(`In-Reply-To: ${input.inReplyTo}`)
  const references = Array.isArray(input.references) ? input.references.filter(Boolean) : []
  if (references.length > 0) headers.push(`References: ${references.join(' ')}`)
  headers.push('MIME-Version: 1.0')
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (/^[A-Za-z0-9-]+$/.test(name) && /[\r\n]/.test(String(value)) === false) headers.push(`${name}: ${value}`)
  }

  const textPart = String(input.text ?? '')
  const htmlPart = input.html === undefined || input.html === null ? '' : String(input.html)
  const wantsHtml = htmlPart.trim() !== ''

  // The message content is built as (part headers, part body) so the same
  // bytes can sit top-level or inside a multipart/mixed wrapper.
  let contentHeaders
  let contentBody
  if (wantsHtml) {
    const altBoundary = boundary()
    contentHeaders = [`Content-Type: multipart/alternative; boundary="${altBoundary}"`]
    contentBody = [
      `--${altBoundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(textPart === '' ? htmlToText(htmlPart) : textPart, 'utf8')),
      `--${altBoundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      wrapBase64(Buffer.from(htmlPart, 'utf8')),
      `--${altBoundary}--`,
    ].join(CRLF)
  } else {
    contentHeaders = ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64']
    contentBody = wrapBase64(Buffer.from(textPart, 'utf8'))
  }

  let body
  if (attachments.length === 0) {
    headers.push(...contentHeaders)
    body = contentBody
  } else {
    const mixedBoundary = boundary()
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`)
    const chunks = [
      `--${mixedBoundary}`,
      ...contentHeaders,
      '',
      contentBody,
    ]
    for (const attachment of attachments) {
      const filename = attachment.filename ?? 'attachment'
      const contentType = attachment.contentType ?? 'application/octet-stream'
      chunks.push(`--${mixedBoundary}`)
      chunks.push([
        `Content-Type: ${contentType}; ${encodeFilenameParam(filename)}`,
        `Content-Disposition: attachment; ${encodeFilenameParam(filename)}`,
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(attachment.content ?? Buffer.alloc(0)),
      ].join(CRLF))
    }
    chunks.push(`--${mixedBoundary}--`)
    body = chunks.join(CRLF)
  }

  const data = Buffer.from(`${headers.join(CRLF)}${CRLF}${CRLF}${body}`, 'utf8')
  return { data, messageId }
}

/** Build a quoted reply body from an original message. */
export function quoteReply(original, body) {
  const attribution = `On ${original.date === '' ? '' : original.date}, ${original.from} wrote:`
  const quoted = String(original.text ?? '').split('\n').map(line => `> ${line}`).join('\n')
  return `${String(body ?? '').trim()}\n\n${attribution}\n${quoted}`.trim()
}

/** References chain for threading a reply. */
export function replyReferences(original) {
  const chain = String(original.references ?? '').split(/\s+/).filter(item => item.startsWith('<'))
  if (original.messageId !== '' && original.messageId.startsWith('<')) chain.push(original.messageId)
  return chain
}

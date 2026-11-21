/**
 * Loopback IMAP + SMTP test double for dsh-email.
 *
 * Purpose: exercise lib/imap.js, lib/smtp.js and lib/mailservice.js without
 * touching a real mailbox. Not a protocol-complete server — it implements
 * exactly the verbs the client uses, plus the malformed-input cases we care
 * about (rejected login, rejected recipient).
 *
 * Standalone use:  node scripts/mock-mail-server.mjs   (prints both ports)
 */

import net from 'node:net'
import { buildMessage, parseMessage } from '../lib/mime.js'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** IMAP INTERNALDATE form: 01-Jan-2025 10:00:00 +0000 */
function internalDate(date) {
  const value = new Date(date)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(value.getUTCDate())}-${MONTHS[value.getUTCMonth()]}-${value.getUTCFullYear()} `
    + `${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())} +0000`
}

/** @typedef {{uid: number, flags: string[], internalDate: string, raw: Buffer}} StoredMessage */

/**
 * Start both listeners.
 * @param {{user?: string, password?: string, host?: string}} [options] fixture account
 * @returns {Promise<{imapPort: number, smtpPort: number, messages: StoredMessage[], sent: Buffer[], addMessage: (raw: Buffer, flags?: string[]) => number, deleteAll: () => void, close: () => Promise<void>}>} fixture
 */
export async function startMockMail(options = {}) {
  const user = options.user ?? 'kali@example.com'
  const password = options.password ?? 'test-pass'
  const host = options.host ?? '127.0.0.1'

  /** @type {StoredMessage[]} */
  const messages = []
  /** @type {Buffer[]} */
  const sent = []
  let nextUid = 1

  const addMessage = (raw, flags = []) => {
    const uid = nextUid++
    messages.push({ uid, flags, internalDate: new Date().toISOString(), raw })
    return uid
  }

  // Two fixture messages: plain Chinese subject, and multipart with attachment.
  addMessage(buildMessage({
    from: 'Alice <alice@example.com>',
    to: user,
    subject: '验证码 123456',
    text: '你的验证码是 123456，5 分钟内有效。\n',
  }).data, ['\\Seen'])
  addMessage(buildMessage({
    from: 'Bob <bob@example.com>',
    to: user,
    cc: 'carol@example.com',
    subject: 'Report attached',
    text: 'see attached',
    attachments: [{ filename: '证据.txt', contentType: 'text/plain', content: Buffer.from('attachment-body', 'utf8') }],
  }).data)

  /* ----------------------------- IMAP ----------------------------- */

  const imapServer = net.createServer(socket => {
    socket.setNoDelay(true)
    let buffer = Buffer.alloc(0)
    let authenticated = false
    socket.write('* OK [CAPABILITY IMAP4rev1] mock imap ready\r\n')

    const reply = (text) => socket.write(text)

    const fetchResponse = (command, tag) => {
      const setMatch = /UID FETCH (\S+) \((.*)\)/i.exec(command)
      if (setMatch === null) {
        reply(`${tag} BAD malformed FETCH\r\n`)
        return
      }
      const [, set, items] = setMatch
      const uids = set.split(',').flatMap(part => {
        const range = /^(\d+):(\d+|\*)$/.exec(part)
        if (range === null) return [Number(part)]
        const start = Number(range[1])
        const end = range[2] === '*' ? Number.MAX_SAFE_INTEGER : Number(range[2])
        return messages.filter(message => message.uid >= start && message.uid <= end).map(message => message.uid)
      })
      const partial = /<0\.(\d+)>/.exec(command)
      const maxBytes = partial === null ? Number.MAX_SAFE_INTEGER : Number(partial[1])
      messages
        .filter(message => uids.includes(message.uid))
        .forEach((message, seq) => {
          const headerEnd = message.raw.indexOf('\r\n\r\n')
          const header = message.raw.subarray(0, Math.max(0, headerEnd))
          const wantsBody = /BODY\.PEEK\[\]/i.test(items)
          const payload = wantsBody ? message.raw.subarray(0, maxBytes) : header
          const itemName = wantsBody ? 'BODY[]' : 'BODY[HEADER.FIELDS (FROM TO CC SUBJECT DATE MESSAGE-ID)]'
          reply(`* ${seq + 1} FETCH (UID ${message.uid} FLAGS (${message.flags.join(' ')}) INTERNALDATE "${internalDate(message.internalDate)}" RFC822.SIZE ${message.raw.length} ${itemName} {${payload.length}}\r\n`)
          socket.write(payload)
          reply(')\r\n')
        })
      reply(`${tag} OK FETCH completed\r\n`)
    }

    const handle = (line) => {
      const match = /^([A-Za-z0-9]+)\s+([\s\S]*)$/.exec(line)
      if (match === null) return
      const [, tag, rest] = match
      const verb = rest.split(' ')[0].toUpperCase()

      if (verb === 'CAPABILITY') {
        reply('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n')
        reply(`${tag} OK CAPABILITY completed\r\n`)
        return
      }
      if (verb === 'NOOP') {
        reply(`* ${messages.length} EXISTS\r\n`)
        reply(`${tag} OK NOOP completed\r\n`)
        return
      }
      if (verb === 'LOGOUT') {
        reply('* BYE logging out\r\n')
        reply(`${tag} OK LOGOUT completed\r\n`)
        socket.end()
        return
      }
      if (verb === 'ID') {
        reply('* ID ("name" "mock" "version" "1.0")\r\n')
        reply(`${tag} OK ID completed\r\n`)
        return
      }
      if (verb === 'LOGIN') {
        const parts = /LOGIN\s+"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/i.exec(rest)
        const givenUser = parts?.[1]?.replace(/\\(.)/g, '$1')
        const givenPass = parts?.[2]?.replace(/\\(.)/g, '$1')
        if (givenPass === password) {
          authenticated = true
          reply(`${tag} OK LOGIN completed\r\n`)
        } else {
          reply(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
        }
        return
      }
      if (authenticated === false) {
        reply(`${tag} NO not authenticated\r\n`)
        return
      }
      if (verb === 'LIST') {
        reply('* LIST (\\HasNoChildren) "/" "INBOX"\r\n')
        reply('* LIST (\\HasNoChildren \\Sent) "/" "Sent"\r\n')
        reply('* LIST (\\HasNoChildren \\Trash) "/" "Trash"\r\n')
        reply(`${tag} OK LIST completed\r\n`)
        return
      }
      if (verb === 'SELECT') {
        reply(`* ${messages.length} EXISTS\r\n`)
        reply('* 0 RECENT\r\n')
        reply('* OK [UIDVALIDITY 1] UIDs valid\r\n')
        reply(`* OK [UIDNEXT ${nextUid}] Predicted next UID\r\n`)
        reply('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)\r\n')
        reply(`${tag} OK [READ-WRITE] SELECT completed\r\n`)
        return
      }
      if (verb === 'UID' && /^UID SEARCH/i.test(rest)) {
        const criteria = rest.replace(/^UID SEARCH\s*/i, '')
        const matched = messages.filter(message => matchesCriteria(message, criteria)).map(message => message.uid)
        reply(`* SEARCH ${matched.join(' ')}\r\n`)
        reply(`${tag} OK SEARCH completed\r\n`)
        return
      }
      if (verb === 'UID' && /^UID FETCH/i.test(rest)) {
        fetchResponse(rest, tag)
        return
      }
      reply(`${tag} BAD unsupported command ${verb}\r\n`)
    }

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const newline = buffer.indexOf('\r\n')
        if (newline < 0) return
        const line = buffer.toString('utf8', 0, newline)
        buffer = buffer.subarray(newline + 2)
        handle(line)
      }
    })
    socket.on('error', () => { /* client vanished */ })
  })

  const matchesCriteria = (message, criteria) => {
    const lower = criteria.toLowerCase()
    if (lower.includes('unseen') && message.flags.some(flag => flag.toLowerCase() === '\\seen')) return false
    // Decode the real headers, so a UTF-8 SUBJECT search matches what a client sees.
    const parsed = parseMessage(message.raw)
    const from = /from "((?:[^"\\]|\\.)*)"/i.exec(criteria)
    if (from !== null && parsed.from.toLowerCase().includes(from[1].toLowerCase()) === false) return false
    const subject = /subject "((?:[^"\\]|\\.)*)"/i.exec(criteria)
    if (subject !== null && parsed.subject.toLowerCase().includes(subject[1].toLowerCase()) === false) return false
    const text = /text "((?:[^"\\]|\\.)*)"/i.exec(criteria)
    if (text !== null && `${parsed.subject}\n${parsed.text}`.toLowerCase().includes(text[1].toLowerCase()) === false) return false
    const since = /since (\d{1,2}-[A-Za-z]{3}-\d{4})/i.exec(criteria)
    if (since !== null && new Date(message.internalDate) < new Date(since[1])) return false
    return true
  }

  /* ----------------------------- SMTP ----------------------------- */

  const smtpServer = net.createServer(socket => {
    socket.setNoDelay(true)
    let buffer = Buffer.alloc(0)
    let mode = 'command'
    let dataLines = []
    let inAuth = false
    let authUser = ''
    let waitAuthUser = false
    socket.write('220 mock ESMTP ready\r\n')
    const say = (text) => socket.write(text)

    const handleCommand = (line) => {
      const upper = line.toUpperCase()
      if (inAuth === true) {
        if (waitAuthUser === true) {
          authUser = Buffer.from(line, 'base64').toString('utf8')
          waitAuthUser = false
          say('334 UGFzc3dvcmQ6\r\n')
          return
        }
        const pass = Buffer.from(line, 'base64').toString('utf8')
        inAuth = false
        if (pass === password) say('235 2.7.0 Authentication successful\r\n')
        else say('535 5.7.8 Authentication credentials invalid\r\n')
        return
      }
      if (upper.startsWith('EHLO')) {
        say('250-mock greets you\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 33554432\r\n')
        return
      }
      if (upper.startsWith('HELO')) { say('250 mock\r\n'); return }
      if (upper.startsWith('AUTH PLAIN')) {
        const token = line.split(/\s+/)[2] ?? ''
        const decoded = Buffer.from(token, 'base64').toString('utf8').split('\u0000')
        const [, authUserPlain, pass] = decoded
        if (pass === password) say('235 2.7.0 Authentication successful\r\n')
        else say('535 5.7.8 Authentication credentials invalid\r\n')
        return
      }
      if (upper.startsWith('AUTH LOGIN')) {
        inAuth = true
        waitAuthUser = true
        say('334 VXNlcm5hbWU6\r\n')
        return
      }
      if (upper.startsWith('MAIL FROM')) { say('250 2.1.0 Ok\r\n'); return }
      if (upper.startsWith('RCPT TO')) {
        if (line.toLowerCase().includes('reject@')) say('550 5.1.1 No such user\r\n')
        else say('250 2.1.5 Ok\r\n')
        return
      }
      if (upper === 'DATA') { mode = 'data'; dataLines = []; say('354 End data with <CR><LF>.<CR><LF>\r\n'); return }
      if (upper === 'QUIT') { say('221 2.0.0 Bye\r\n'); socket.end(); return }
      if (upper === 'RSET') { say('250 2.0.0 Ok\r\n'); return }
      say('502 5.5.2 Command not implemented\r\n')
    }

    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const newline = buffer.indexOf('\r\n')
        if (newline < 0) return
        const line = buffer.toString('utf8', 0, newline)
        buffer = buffer.subarray(newline + 2)
        if (mode === 'data') {
          if (line === '.') {
            mode = 'command'
            sent.push(Buffer.from(`${dataLines.join('\r\n')}\r\n`, 'utf8'))
            say('250 2.0.0 Ok: queued as mock\r\n')
          } else {
            dataLines.push(line.startsWith('..') ? line.slice(1) : line)
          }
          continue
        }
        handleCommand(line)
      }
    })
    socket.on('error', () => { /* client vanished */ })
  })

  /* --------------------- CONNECT proxy (test only) ---------------------
   * A minimal HTTP CONNECT proxy that always dials 127.0.0.1 on the requested
   * port, so a client can be told to use a non-loopback hostname
   * (`mail.mock.test`) and still reach this fixture. It counts tunnels so a
   * test can prove the proxy was used (or deliberately bypassed). */
  const proxyHits = { count: 0, targets: [] }
  /** A proxy that accepts the TCP connection then drops it, so the client's
   *  route fallback can be exercised without touching a real network. */
  const brokenProxyServer = net.createServer(socket => { socket.destroy() })

  /** Minimal SOCKS5 (no auth) server that dials 127.0.0.1 on the asked port. */
  const socksServer = net.createServer(socket => {
    socket.setNoDelay(true)
    let stage = 'greeting'
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== 0x05) { socket.destroy(); return }
        if (buffer.length < 2 + buffer[1]) return
        buffer = buffer.subarray(2 + buffer[1])
        socket.write(Buffer.from([0x05, 0x00]))
        stage = 'request'
        onData(Buffer.alloc(0))
        return
      }
      if (stage === 'request') {
        if (buffer.length < 5) return
        const atyp = buffer[3]
        let host = ''
        let offset = 4
        if (atyp === 0x01) { host = Array.from(buffer.subarray(4, 8)).join('.'); offset = 8 }
        else if (atyp === 0x03) { const n = buffer[4]; host = buffer.subarray(5, 5 + n).toString('utf8'); offset = 5 + n }
        else if (atyp === 0x04) { socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); return }
        if (buffer.length < offset + 2) return
        const port = buffer.readUInt16BE(offset)
        stage = 'piping'
        socket.removeListener('data', onData)
        const upstream = net.connect({ host: '127.0.0.1', port })
        upstream.on('connect', () => {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, (port >> 8) & 0xff, port & 0xff]))
          socket.pipe(upstream)
          upstream.pipe(socket)
        })
        upstream.on('error', () => socket.destroy())
        socket.on('error', () => upstream.destroy())
      }
    }
    socket.on('data', onData)
    socket.on('error', () => { /* client vanished */ })
  })

  const proxyServer = net.createServer(socket => {
    socket.setNoDelay(true)
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.removeListener('data', onData)
      const head = buffer.subarray(0, end).toString('latin1')
      const match = /^CONNECT ([^:\s]+):(\d{1,5}) /.exec(head)
      if (match === null) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return }
      proxyHits.count += 1
      proxyHits.targets.push(`${match[1]}:${match[2]}`)
      const upstream = net.connect({ host: '127.0.0.1', port: Number(match[2]) })
      upstream.on('connect', () => {
        socket.write('HTTP/1.1 200 Connection established\r\n\r\n')
        socket.pipe(upstream)
        upstream.pipe(socket)
      })
      upstream.on('error', () => { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
      socket.on('error', () => upstream.destroy())
    }
    socket.on('data', onData)
    socket.on('error', () => { /* client vanished */ })
  })

  // 0.0.0.0 so a test can also reach the fixture by its LAN address, which is
  // what exercises "proxy fails → direct succeeds".
  const listenHost = '0.0.0.0'
  await Promise.all([
    new Promise(resolve => imapServer.listen(0, listenHost, resolve)),
    new Promise(resolve => smtpServer.listen(0, listenHost, resolve)),
    new Promise(resolve => proxyServer.listen(0, listenHost, resolve)),
    new Promise(resolve => brokenProxyServer.listen(0, listenHost, resolve)),
    new Promise(resolve => socksServer.listen(0, listenHost, resolve)),
  ])

  const closeServer = server => new Promise(resolve => {
    server.close(() => resolve())
    server.unref()
  })

  return {
    imapPort: imapServer.address().port,
    smtpPort: smtpServer.address().port,
    proxyPort: proxyServer.address().port,
    brokenProxyPort: brokenProxyServer.address().port,
    socksPort: socksServer.address().port,
    proxyHits,
    messages,
    sent,
    addMessage,
    deleteAll: () => { messages.length = 0 },
    close: async () => {
      await Promise.all([closeServer(imapServer), closeServer(smtpServer), closeServer(proxyServer), closeServer(brokenProxyServer), closeServer(socksServer)])
    },
  }
}

// Direct invocation: stay up and print the ports so a human can point the
// settings form at this fixture.
if (import.meta.url === `file://${process.argv[1]}`) {
  const fixture = await startMockMail()
  console.log(`IMAP 127.0.0.1:${fixture.imapPort}  SMTP 127.0.0.1:${fixture.smtpPort}`)
  console.log('账号 kali@example.com  密码 test-pass  （自定义服务器，关闭 TLS）')
}

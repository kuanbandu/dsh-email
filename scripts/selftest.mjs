/**
 * Self-test for dsh-email: protocol codecs + a full read/send/reply/wait cycle
 * against the loopback IMAP/SMTP fixture. No real mailbox, no credentials.
 *
 *   node scripts/selftest.mjs
 */

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { startMockMail } from './mock-mail-server.mjs'
import { buildMessage, decodeEncodedWords, decodeText, htmlToText, parseMessage } from '../lib/mime.js'
import { decodeMailboxName, encodeMailboxName } from '../lib/imap.js'
import { parseProxy, shouldBypass } from '../lib/proxy.js'
import { MailService } from '../lib/mailservice.js'

let failures = 0
let checks = 0

/**
 * Run one named check.
 * @param {string} name what is asserted
 * @param {() => any|Promise<any>} body check body
 */
async function check(name, body) {
  checks += 1
  try {
    await body()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${name}\n       ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

/** In-memory stand-in for ctx.credentials. */
function fakeCredentials() {
  const records = new Map()
  return {
    records,
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return next
    },
    async deleteRecord(key) { records.delete(key) },
  }
}

async function main() {
  console.log('dsh-email selftest')
  console.log('\n[mime]')
  await check('RFC 2047 base64 word decodes to Chinese', () => {
    assert.equal(decodeEncodedWords('=?UTF-8?B?6aqM6K+B56CBIDEyMzQ1Ng==?='), '验证码 123456')
  })
  await check('adjacent encoded words join without the separating space', () => {
    assert.equal(decodeEncodedWords('=?UTF-8?B?5L2g?= =?UTF-8?B?5aW9?='), '你好')
  })
  await check('quoted-printable encoded word decodes', () => {
    assert.equal(decodeEncodedWords('=?utf-8?Q?caf=C3=A9?='), 'café')
  })
  await check('GB18030 body decodes', () => {
    const bytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // 中文
    assert.equal(decodeText(bytes, 'gb2312'), '中文')
  })
  await check('HTML becomes readable text with links kept', () => {
    const text = htmlToText('<p>Hello <b>world</b></p><a href="https://x.test/a">click</a>')
    assert.match(text, /Hello world/)
    assert.match(text, /click \(https:\/\/x\.test\/a\)/)
  })
  await check('build -> parse round-trip keeps subject, body and attachment', () => {
    const built = buildMessage({
      from: 'Kali <kali@example.com>',
      to: 'target@example.com',
      subject: '扫描报告 v1',
      text: '正文内容\nsecond line',
      attachments: [{ filename: '证据.txt', contentType: 'text/plain', content: Buffer.from('payload') }],
    })
    const parsed = parseMessage(built.data)
    assert.equal(parsed.subject, '扫描报告 v1')
    assert.match(parsed.text, /正文内容/)
    assert.equal(parsed.attachments.length, 1)
    assert.equal(parsed.attachments[0].filename, '证据.txt')
    assert.equal(parsed.attachments[0].content.toString(), 'payload')
  })
  await check('modified UTF-7 mailbox names round-trip', () => {
    const encoded = encodeMailboxName('已发送')
    assert.equal(decodeMailboxName(encoded), '已发送')
  })

  console.log('\n[proxy]')
  await check('parseProxy accepts the shapes users type', () => {
    assert.deepEqual(parseProxy('10.0.0.5:7890'), { protocol: 'http', host: '10.0.0.5', port: 7890 })
    assert.deepEqual(parseProxy('http://10.0.0.5:7890'), { protocol: 'http', host: '10.0.0.5', port: 7890 })
    assert.deepEqual(parseProxy('socks5://127.0.0.1:1080'), { protocol: 'socks5', host: '127.0.0.1', port: 1080 })
    assert.deepEqual(parseProxy('[::1]:7897'), { protocol: 'http', host: '::1', port: 7897 })
    assert.equal(parseProxy('off'), undefined)
    assert.equal(parseProxy(''), undefined)
    assert.throws(() => parseProxy('10.0.0.5'), /格式不对/)
    assert.throws(() => parseProxy('ftp://1.2.3.4:21'), /不支持的代理协议/)
  })
  await check('loopback targets always bypass a configured proxy', () => {
    assert.equal(shouldBypass('127.0.0.1'), true)
    assert.equal(shouldBypass('localhost'), true)
    assert.equal(shouldBypass('imap.gmail.com'), false)
    assert.equal(shouldBypass('mail.corp.local'), true)
    assert.equal(shouldBypass('imap.example.com', ['.example.com']), true)
  })

  const fixture = await startMockMail()
  const dataDir = mkdtempSync(join(tmpdir(), 'dsh-email-test-'))
  const ctx = { credentials: fakeCredentials() }
  const mail = new MailService({ ctx, config: { dataDir, requestTimeoutMs: 8000 } })

  console.log(`\n[service] fixture imap=${fixture.imapPort} smtp=${fixture.smtpPort}`)

  await check('addAccount verifies IMAP and SMTP, persists metadata only', async () => {
    const result = await mail.addAccount({
      email: 'kali@example.com',
      password: 'test-pass',
      provider: 'custom',
      label: 'Kali 测试',
      imap: { host: '127.0.0.1', port: fixture.imapPort, secure: false, starttls: false },
      smtp: { host: '127.0.0.1', port: fixture.smtpPort, secure: false, starttls: false },
    })
    assert.equal(result.report.imap.ok, true, JSON.stringify(result.report.imap))
    assert.equal(result.report.smtp.ok, true, JSON.stringify(result.report.smtp))
    const file = readFileSync(join(dataDir, 'accounts.json'), 'utf8')
    assert.equal(file.includes('test-pass'), false, 'password leaked into accounts.json')
    assert.equal(ctx.credentials.records.size, 1)
  })

  await check('wrong password is rejected at IMAP login', async () => {
    await assert.rejects(() => mail.addAccount({
      email: 'nobody@example.com',
      password: 'wrong',
      provider: 'custom',
      imap: { host: '127.0.0.1', port: fixture.imapPort, secure: false, starttls: false },
      smtp: { host: '127.0.0.1', port: fixture.smtpPort, secure: false, starttls: false },
    }), /IMAP 登录失败/)
  })

  await check('mailboxes lists INBOX and Sent', async () => {
    const result = await mail.mailboxes({})
    const names = result.mailboxes.map(mailbox => mailbox.name)
    assert.deepEqual(names.slice(0, 2), ['INBOX', 'Sent'])
  })

  await check('search returns newest-first summaries with decoded subject', async () => {
    const result = await mail.search({ limit: 10 })
    assert.equal(result.matched, 2)
    assert.equal(result.messages[0].subject, 'Report attached')
    assert.equal(result.messages[1].subject, '验证码 123456')
    assert.equal(result.messages[0].unread, true)
    assert.equal(result.messages[1].unread, false)
  })

  await check('search filters by subject keyword', async () => {
    const result = await mail.search({ subject: '验证码' })
    assert.equal(result.matched, 1)
  })

  await check('read returns the body and does not mark it seen', async () => {
    const listed = await mail.search({ subject: '验证码' })
    const uid = listed.messages[0].uid
    const message = await mail.read({ uid })
    assert.match(message.text, /123456/)
    const after = await mail.search({ unseen: true })
    assert.equal(after.matched, 1, 'reading changed the \\Seen flag')
  })

  await check('read exposes attachment metadata and download saves bytes', async () => {
    const listed = await mail.search({ subject: 'Report' })
    const uid = listed.messages[0].uid
    const message = await mail.read({ uid })
    assert.equal(message.attachments.length, 1)
    assert.equal(message.attachments[0].filename, '证据.txt')
    const saved = await mail.downloadAttachment({ uid, index: 0, savePath: join(dataDir, 'saved', 'evidence.txt') })
    assert.equal(existsSync(saved.path), true)
    assert.equal(readFileSync(saved.path, 'utf8'), 'attachment-body')
  })

  await check('send delivers a UTF-8 message with an attachment', async () => {
    const attachmentPath = join(dataDir, 'note.txt')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(attachmentPath, 'hello attachment', 'utf8')
    const result = await mail.send({
      to: 'target@example.com',
      subject: '测试主题',
      text: '这是正文',
      attachments: [{ path: attachmentPath }],
    })
    assert.equal(result.ok, true)
    assert.deepEqual(result.accepted, ['target@example.com'])
    const wire = fixture.sent.at(-1).toString('utf8')
    assert.match(wire, /Subject: =\?UTF-8\?B\?/)
    const parsed = parseMessage(fixture.sent.at(-1))
    assert.equal(parsed.subject, '测试主题')
    assert.match(parsed.text, /这是正文/)
    assert.equal(parsed.attachments[0]?.filename, 'note.txt')
  })

  await check('a rejected recipient is reported, not fatal', async () => {
    const result = await mail.send({ to: 'reject@example.com, ok@example.com', subject: 's', text: 't' })
    assert.deepEqual(result.rejected, ['reject@example.com'])
    assert.deepEqual(result.accepted, ['ok@example.com'])
  })

  await check('reply threads with In-Reply-To and quotes the original', async () => {
    const listed = await mail.search({ subject: '验证码' })
    const uid = listed.messages[0].uid
    const originalMessageId = (await mail.read({ uid })).messageId
    const result = await mail.reply({ uid, text: '收到，谢谢' })
    assert.equal(result.subject, 'Re: 验证码 123456')
    const parsed = parseMessage(fixture.sent.at(-1))
    assert.equal(parsed.inReplyTo, originalMessageId)
    assert.match(parsed.references, new RegExp(originalMessageId.replace(/[<>]/g, '.')))
    assert.match(parsed.text, /收到，谢谢/)
    assert.match(parsed.text, /^> /m)
  })

  await check('wait returns mail that arrives during the poll window', async () => {
    const before = await mail.search({ limit: 1 })
    const sinceUid = before.messages[0].uid
    const pending = mail.wait({ sinceUid, timeoutSeconds: 20, intervalSeconds: 1 })
    await new Promise(resolve => setTimeout(resolve, 600))
    fixture.addMessage(buildMessage({
      from: 'noreply@target.test',
      to: 'kali@example.com',
      subject: 'Your verification code',
      text: 'code 998877',
    }).data)
    const result = await pending
    assert.equal(result.timedOut, false)
    assert.equal(result.found.length, 1)
    assert.match(result.found[0].subject, /verification code/)
  })

  await check('wait times out without arrivals', async () => {
    const latest = await mail.search({ limit: 1 })
    const result = await mail.wait({ sinceUid: latest.messages[0].uid, timeoutSeconds: 2, intervalSeconds: 1 })
    assert.equal(result.timedOut, true)
    assert.equal(result.found.length, 0)
  })

  await check('a proxied account tunnels IMAP and SMTP through CONNECT', async () => {
    const before = fixture.proxyHits.count
    const result = await mail.addAccount({
      email: 'proxy@example.com',
      password: 'test-pass',
      provider: 'gmail',
      label: 'Proxied',
      proxy: `http://127.0.0.1:${fixture.proxyPort}`,
      imap: { host: 'mail.mock.test', port: fixture.imapPort, secure: false, starttls: false },
      smtp: { host: 'mail.mock.test', port: fixture.smtpPort, secure: false, starttls: false },
    })
    assert.equal(result.report.imap.ok, true, JSON.stringify(result.report.imap))
    assert.equal(result.report.smtp.ok, true, JSON.stringify(result.report.smtp))
    assert.equal(result.report.imap.route, `http://127.0.0.1:${fixture.proxyPort}`)
    assert.ok(fixture.proxyHits.count - before >= 2, `expected >=2 tunnels, got ${fixture.proxyHits.count - before}`)

    // A proxied account reads and sends through the same tunnel path.
    const listed = await mail.search({ account: 'proxy@example.com', limit: 2 })
    assert.ok(listed.matched >= 2, `expected at least 2 messages, got ${listed.matched}`)
    const sent = await mail.send({ account: 'proxy@example.com', to: 'target@example.com', subject: 'via proxy', text: 'x' })
    assert.equal(sent.route, `http://127.0.0.1:${fixture.proxyPort}`)
  })

  await check('a loopback account stays direct even with a proxy configured', async () => {
    const before = fixture.proxyHits.count
    const result = await mail.addAccount({
      email: 'bypass@example.com',
      password: 'test-pass',
      provider: 'custom',
      proxy: `http://127.0.0.1:${fixture.proxyPort}`,
      imap: { host: '127.0.0.1', port: fixture.imapPort, secure: false, starttls: false },
      smtp: { host: '127.0.0.1', port: fixture.smtpPort, secure: false, starttls: false },
    })
    assert.equal(result.report.imap.ok, true)
    assert.equal(result.report.imap.route, 'direct')
    assert.equal(fixture.proxyHits.count, before, 'loopback target used the proxy')
  })

  await check('SOCKS5 proxy tunnels as well as HTTP CONNECT', async () => {
    const result = await mail.addAccount({
      email: 'socks@example.com',
      password: 'test-pass',
      provider: 'gmail',
      proxy: `socks5://127.0.0.1:${fixture.socksPort}`,
      imap: { host: 'mail.mock.test', port: fixture.imapPort, secure: false, starttls: false },
      smtp: { host: 'mail.mock.test', port: fixture.smtpPort, secure: false, starttls: false },
    })
    assert.equal(result.report.imap.ok, true, JSON.stringify(result.report.imap))
    assert.equal(result.report.imap.route, `socks5://127.0.0.1:${fixture.socksPort}`)
    assert.equal(result.report.smtp.ok, true, JSON.stringify(result.report.smtp))
  })

  await check('SMTP can stay direct while IMAP uses the proxy', async () => {
    const before = fixture.proxyHits.count
    const result = await mail.addAccount({
      email: 'split@example.com',
      password: 'test-pass',
      provider: 'gmail',
      proxy: `http://127.0.0.1:${fixture.proxyPort}`,
      smtpProxy: 'off',
      imap: { host: 'mail.mock.test', port: fixture.imapPort, secure: false, starttls: false },
      smtp: { host: 'mail.mock.test', port: fixture.smtpPort, secure: false, starttls: false },
    })
    assert.equal(result.report.imap.route, `http://127.0.0.1:${fixture.proxyPort}`)
    assert.equal(result.report.smtp.route, 'direct')
    assert.equal(fixture.proxyHits.count - before, 1, 'only the IMAP connection should be tunnelled')
    const listed = await mail.listAccounts()
    const split = listed.find(account => account.email === 'split@example.com')
    assert.equal(split.route, `http://127.0.0.1:${fixture.proxyPort}`)
    assert.equal(split.smtpRoute, 'direct')

    // updating routes does not need the password again
    const updated = await mail.updateRoutes('split@example.com', { smtpProxy: `http://127.0.0.1:${fixture.proxyPort}` })
    assert.equal(updated.find(account => account.email === 'split@example.com').smtpRoute, `http://127.0.0.1:${fixture.proxyPort}`)
  })

  await check('a failing proxy route falls back to a direct connection', async () => {
    const lan = Object.values(networkInterfaces()).flat()
      .filter(entry => entry !== undefined && entry.family === 'IPv4' && entry.internal === false)
      .map(entry => entry.address)[0]
    if (lan === undefined) {
      console.log('       (skipped: no non-internal IPv4 address to test fallback with)')
      return
    }
    const before = fixture.proxyHits.count
    const result = await mail.addAccount({
      email: 'fallback@example.com',
      password: 'test-pass',
      provider: 'gmail',
      proxy: `http://127.0.0.1:${fixture.brokenProxyPort}`,
      imap: { host: lan, port: fixture.imapPort, secure: false, starttls: false },
      smtp: { host: lan, port: fixture.smtpPort, secure: false, starttls: false },
    })
    assert.equal(result.report.imap.ok, true, JSON.stringify(result.report.imap))
    assert.equal(result.report.imap.fellBack, true, 'IMAP did not fall back to the direct route')
    assert.equal(result.report.imap.route, 'direct')
    assert.equal(result.report.smtp.ok, true, JSON.stringify(result.report.smtp))
    assert.equal(result.report.smtp.fellBack, true, 'SMTP did not fall back to the direct route')
    assert.equal(fixture.proxyHits.count, before, 'the broken proxy unexpectedly tunnelled')
  })

  await check('a wrong password never falls back (route is not the problem)', async () => {
    const lan = Object.values(networkInterfaces()).flat()
      .filter(entry => entry !== undefined && entry.family === 'IPv4' && entry.internal === false)
      .map(entry => entry.address)[0]
    if (lan === undefined) return
    await assert.rejects(() => mail.addAccount({
      email: 'badpass@example.com',
      password: 'nope',
      provider: 'gmail',
      proxy: `http://127.0.0.1:${fixture.brokenProxyPort}`,
      imap: { host: lan, port: fixture.imapPort, secure: false, starttls: false },
      smtp: { host: lan, port: fixture.smtpPort, secure: false, starttls: false },
    }), /IMAP 登录失败/)
  })

  await check('domestic providers default to a direct route', async () => {
    const route = mail.resolveRoute({ provider: '163' })
    assert.equal(route.proxy, '')
    const gmail = mail.resolveRoute({ provider: 'gmail' })
    assert.equal(gmail.proxy, '', 'no global proxy configured in this fixture')
  })

  await check('removing accounts also removes their secrets', async () => {
    for (const email of ['kali@example.com', 'proxy@example.com', 'bypass@example.com', 'fallback@example.com', 'socks@example.com', 'split@example.com']) {
      await mail.removeAccount(email).catch(() => {})
    }
    const accounts = await mail.listAccounts()
    assert.equal(accounts.length, 0)
    assert.equal(ctx.credentials.records.size, 0)
  })

  fixture.close()
  rmSync(dataDir, { recursive: true, force: true })

  console.log(`\n${checks - failures}/${checks} checks passed`)
  if (failures > 0) process.exitCode = 1
}

await main()

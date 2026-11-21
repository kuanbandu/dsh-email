/**
 * Local diagnostic: test every saved account and print its route + timing.
 * Reads the credential record straight from the harness store so it works
 * outside the running Harness; the secret is handed to the socket layer only
 * and is never printed. Usage: node scripts/verify-accounts.mjs [proxy]
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MailService } from '../lib/mailservice.js'

// Minimal read-only credentials provider over the harness store. The secret is
// passed straight to the socket layer and never printed.
const storeFile = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
const yaml = readFileSync(storeFile, 'utf8')
function recordFor(key) {
  const block = new RegExp(`^  ${key.replace(/[/\\-]/g, ch => `\\${ch}`)}:\\n((?:    .*\\n)+)`, 'm').exec(yaml)
  if (block === null) return undefined
  const value = /key:\s*(.+)$/m.exec(block[1])
  return value === null ? undefined : { kind: 'api-key', key: value[1].trim() }
}

const ctx = {
  credentials: {
    async readRecord(key) { return recordFor(key) },
    async modifyRecord() { return undefined },
    async deleteRecord() { return undefined },
  },
  logger: { info() {}, warn: message => console.log('  [warn]', message), error() {} },
}

const mail = new MailService({
  ctx,
  config: { proxy: process.argv[2] ?? '', proxyBypass: [], routeFallback: true, proxyConnectTimeoutMs: 8000 },
})

for (const account of await mail.listAccounts()) {
  const started = Date.now()
  try {
    const result = await mail.testAccount(account.email)
    const imap = result.report.imap
    const smtp = result.report.smtp
    console.log(`${account.email}`)
    console.log(`  IMAP ${imap.ok ? 'OK ' : 'FAIL'} ${String(imap.ms).padStart(5)}ms route=${imap.route}${imap.fellBack ? ' (fallback)' : ''}${imap.error ? ` error=${imap.error}` : ''}${imap.mailboxes !== undefined ? ` folders=${imap.mailboxes}` : ''}`)
    console.log(`  SMTP ${smtp.ok ? 'OK ' : 'FAIL'} ${String(smtp.ms).padStart(5)}ms route=${smtp.route}${smtp.fellBack ? ' (fallback)' : ''}${smtp.error ? ` error=${smtp.error}` : ''}`)
  } catch (error) {
    console.log(`${account.email}  FAILED ${Date.now() - started}ms: ${error.message}`)
  }
}

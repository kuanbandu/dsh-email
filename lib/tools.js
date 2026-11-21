/**
 * Model-facing tools for dsh-email.
 *
 * Every tool is a thin, well-described wrapper over one {@link MailService}
 * operation; none of them can read a password, change credentials, or delete
 * an account — those live in the settings page only.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Deep-clean a tool result: drop `undefined` members (the registry requires
 * lossless JSON) and turn non-finite numbers into null.
 * @param {unknown} value any tool return value
 * @returns {unknown} JSON-lossless value
 */
function clean(value) {
  if (value === undefined) return null
  if (value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => clean(item))
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = clean(item)
  }
  return out
}

/**
 * Working directory for this call: the calling agent's session workspace, so a
 * relative attachment path means what the user sees in their file tools.
 * @param {any} exec tool run context
 * @returns {string} absolute directory
 */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** Tool result rendering: structured JSON as text, plus a compact summary line. */
function renderJson(_args, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  const clipped = text.length > 60_000 ? `${text.slice(0, 60_000)}\n… (输出已截断)` : text
  return [{ type: 'text', text: clipped }]
}

const output = (description) => ({
  schema: { type: 'object', additionalProperties: true, description },
  render: renderJson,
})

const ACCOUNT_PARAM = {
  type: 'string',
  description: '邮箱账号（地址或 account id）。省略时使用默认账号；只配置了一个账号时也可以省略。',
}

const MAILBOX_PARAM = {
  type: 'string',
  description: '邮箱文件夹名，默认 INBOX。常见值：INBOX、Sent、Drafts、Trash、Junk；中文服务商可能是「已发送」。',
}

/**
 * Register every email tool on the host context.
 * @param {{tools: {register: Function}, mail: import('./mailservice.js').MailService}} ctx host context
 * @returns {(() => void)[]} disposers, for the plugin's own effect
 */
export function registerEmailTools(ctx) {
  const mail = ctx.mail
  const disposed = []
  const register = (definition) => {
    disposed.push(ctx.tools.register(definition))
  }

  register(defineTool({
    name: 'email_accounts',
    description: '查看/测试已登录的邮箱账号。action=list 列出账号（不含密码）；action=catalog 列出内置服务商（Gmail、163、126、QQ、Proton Bridge、Outlook、iCloud、Yahoo、自定义）及其 IMAP/SMTP 默认地址；action=test 用已保存的密码重新测试某个账号的连通性。开始任何收信/发信之前先调用一次 list 确认可用账号。',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'catalog', 'test'],
        description: 'list（默认）列出账号；catalog 列出服务商预设；test 测试连通性。',
      },
      account: ACCOUNT_PARAM,
    },
    output: output('账号列表或测试报告'),
    timeoutMs: 130_000,
    async execute(args) {
      const action = args.action ?? 'list'
      if (action === 'catalog') return clean({ ok: true, providers: mail.catalog() })
      if (action === 'test') {
        const result = await mail.testAccount(args.account)
        return clean({ ok: result.report.imap.ok === true && result.report.smtp.ok === true, ...result })
      }
      return clean({ ok: true, accounts: await mail.listAccounts() })
    },
  }))

  register(defineTool({
    name: 'email_mailboxes',
    description: '列出一个邮箱账号的全部文件夹（INBOX、Sent、Trash 等）。在不确定文件夹名时先调用它，再用返回的 label 作为 email_search / email_read 的 mailbox 参数。',
    parameters: { account: ACCOUNT_PARAM },
    output: output('文件夹列表'),
    timeoutMs: 60_000,
    async execute(args) {
      return clean({ ok: true, ...await mail.mailboxes({ account: args.account }) })
    },
  }))

  register(defineTool({
    name: 'email_search',
    description: '在邮箱里按发件人/收件人/主题/正文关键词/日期/未读状态检索邮件，返回最新优先的摘要列表（uid、发件人、主题、时间、大小、是否未读），不含正文。检索是只读的，不会把邮件标记为已读。拿到 uid 后用 email_read 读正文，或 email_reply 回复。典型用途：找目标站点发来的验证邮件、找凭据/邀请链接、找某个漏洞报告的回信。',
    parameters: {
      account: ACCOUNT_PARAM,
      mailbox: MAILBOX_PARAM,
      from: { type: 'string', description: '按发件人匹配（子串或地址）。' },
      to: { type: 'string', description: '按收件人匹配。' },
      subject: { type: 'string', description: '按主题匹配（支持中文/UTF-8）。' },
      text: { type: 'string', description: '在正文/头部里匹配关键词。' },
      since: { type: 'string', description: '起始日期，YYYY-MM-DD（含当天）。' },
      before: { type: 'string', description: '截止日期，YYYY-MM-DD（不含当天）。' },
      unseen: { type: 'boolean', description: '只看未读邮件。' },
      limit: { type: 'number', description: '返回条数，默认 20，最大 100。' },
      offset: { type: 'number', description: '跳过最新的 N 条，用于翻页。' },
    },
    output: output('匹配数量与摘要列表'),
    timeoutMs: 130_000,
    async execute(args) {
      return clean({ ok: true, ...await mail.search(args) })
    },
  }))

  register(defineTool({
    name: 'email_read',
    description: '读取一封邮件的完整内容：解码后的头部、纯文本正文、附件清单（含 index 供 email_attachment 下载）。默认不返回 HTML，需要时设 include_html=true。读取使用 PEEK，不会把邮件标记为已读。正文过大时按 max_bytes 截断并在 truncated 标记。',
    parameters: {
      account: ACCOUNT_PARAM,
      mailbox: MAILBOX_PARAM,
      uid: { type: 'number', required: true, description: 'email_search 返回的 uid（IMAP UID，不是序号）。' },
      max_bytes: { type: 'number', description: '正文字节上限，默认 262144。' },
      include_html: { type: 'boolean', description: '同时返回原始 HTML 正文。' },
    },
    output: output('邮件正文与附件清单'),
    timeoutMs: 130_000,
    async execute(args) {
      return clean({
        ok: true,
        ...await mail.read({
          account: args.account,
          mailbox: args.mailbox,
          uid: args.uid,
          maxBytes: args.max_bytes,
          includeHtml: args.include_html === true,
        }),
      })
    },
  }))

  register(defineTool({
    name: 'email_send',
    description: '用已登录的邮箱发送新邮件。支持纯文本、HTML、抄送/密送、Reply-To 和工作区里的文件作为附件（attachments 里写路径，相对路径以当前工作目录为基准）。发送前请确认收件人正确——这是不可撤销的外部动作；如果只是回复收到的邮件，优先用 email_reply 以保留会话线索。',
    parameters: {
      account: ACCOUNT_PARAM,
      to: { type: 'string', required: true, description: '收件人，多个用逗号分隔。' },
      cc: { type: 'string', description: '抄送。' },
      bcc: { type: 'string', description: '密送。' },
      subject: { type: 'string', description: '主题（支持中文，自动做 RFC 2047 编码）。' },
      text: { type: 'string', description: '纯文本正文。' },
      html: { type: 'string', description: 'HTML 正文；与 text 同时给出时按 multipart/alternative 发送。' },
      reply_to: { type: 'string', description: 'Reply-To 地址。' },
      attachments: {
        type: 'array',
        description: '附件文件路径列表。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: '文件路径（相对当前工作目录或绝对路径）。' },
            filename: { type: 'string', description: '收件人看到的文件名，默认取磁盘文件名。' },
            content_type: { type: 'string', description: 'MIME 类型，默认按扩展名推断。' },
          },
        },
      },
    },
    output: output('发送结果：messageId、收件人与被拒收件人'),
    timeoutMs: 130_000,
    async execute(args, exec) {
      const result = await mail.send({
        account: args.account,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        text: args.text,
        html: args.html,
        replyTo: args.reply_to,
        attachments: (args.attachments ?? []).map(item => ({
          path: item.path,
          filename: item.filename,
          contentType: item.content_type,
        })),
        cwd: cwdOf(exec),
      })
      return clean({ ...result })
    },
  }))

  register(defineTool({
    name: 'email_reply',
    description: '回复某一封已收到的邮件：自动带上 In-Reply-To / References 保证会话线程正确，默认把原文按 "> " 引用附在末尾，主题自动加 Re:。reply_all=true 时把原邮件的 To/Cc 一并带入抄送（自动去重并排除自己）。',
    parameters: {
      account: ACCOUNT_PARAM,
      mailbox: MAILBOX_PARAM,
      uid: { type: 'number', required: true, description: '要回复的邮件 uid。' },
      text: { type: 'string', required: true, description: '回复正文（纯文本）。' },
      reply_all: { type: 'boolean', description: '是否回复全部收件人。' },
      include_quote: { type: 'boolean', description: '是否附带原文引用，默认 true。' },
      html: { type: 'string', description: 'HTML 正文（可选）。' },
      attachments: {
        type: 'array',
        description: '附件文件路径列表。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', required: true, description: '文件路径。' },
            filename: { type: 'string', description: '附件显示名。' },
            content_type: { type: 'string', description: 'MIME 类型。' },
          },
        },
      },
    },
    output: output('回复发送结果'),
    timeoutMs: 130_000,
    async execute(args, exec) {
      const result = await mail.reply({
        account: args.account,
        mailbox: args.mailbox,
        uid: args.uid,
        text: args.text,
        html: args.html,
        replyAll: args.reply_all === true,
        quote: args.include_quote !== false,
        attachments: (args.attachments ?? []).map(item => ({
          path: item.path,
          filename: item.filename,
          contentType: item.content_type,
        })),
        cwd: cwdOf(exec),
      })
      return clean({ ...result })
    },
  }))

  register(defineTool({
    name: 'email_wait',
    description: '等待新邮件到达：可选按 from/subject 过滤，轮询到有匹配邮件或超时（最长 120 秒）为止。这是注册账号后"等验证邮件"的关键工具——比反复 email_search 更省步骤。省略 since_uid 时等待从现在开始之后到达的邮件；返回 found 列表中的 uid 可直接交给 email_read。',
    parameters: {
      account: ACCOUNT_PARAM,
      mailbox: MAILBOX_PARAM,
      since_uid: { type: 'number', description: '从这个 uid 之后开始找；省略则从当前最新 uid 开始。' },
      timeout_seconds: { type: 'number', description: '最长等待秒数，默认 30，最大 120。' },
      interval_seconds: { type: 'number', description: '轮询间隔秒数，默认 5。' },
      from: { type: 'string', description: '只看这个发件人的新邮件。' },
      subject: { type: 'string', description: '只看主题含该关键词的新邮件。' },
    },
    output: output('新到邮件列表；timedOut=true 表示超时未收到'),
    timeoutMs: 150_000,
    async execute(args) {
      return clean({ ok: true, ...await mail.wait({
        account: args.account,
        mailbox: args.mailbox,
        sinceUid: args.since_uid,
        timeoutSeconds: args.timeout_seconds,
        intervalSeconds: args.interval_seconds,
        from: args.from,
        subject: args.subject,
      }) })
    },
  }))

  register(defineTool({
    name: 'email_attachment',
    description: '把邮件附件保存到本地磁盘（默认存到工作区 mail-attachments/<uid>/<文件名>）。用 email_read 返回的附件 index 指定哪一个；不指定时取第一个附件。保存后返回绝对路径，可以继续用 read/其他工具分析该文件。',
    parameters: {
      account: ACCOUNT_PARAM,
      mailbox: MAILBOX_PARAM,
      uid: { type: 'number', required: true, description: '邮件 uid。' },
      index: { type: 'number', description: 'email_read 返回的附件 index（从 0 开始）。' },
      filename: { type: 'string', description: '按文件名（子串）选择附件，index 优先。' },
      save_path: { type: 'string', description: '保存路径（相对当前工作目录或绝对路径），省略则自动命名。' },
    },
    output: output('保存结果与绝对路径'),
    timeoutMs: 130_000,
    async execute(args, exec) {
      return clean({
        ok: true,
        ...await mail.downloadAttachment({
          account: args.account,
          mailbox: args.mailbox,
          uid: args.uid,
          index: args.index,
          filename: args.filename,
          savePath: args.save_path,
          cwd: cwdOf(exec),
        }),
      })
    },
  }))

  return disposed
}

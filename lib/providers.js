/**
 * Provider presets for dsh-email.
 *
 * Each preset is a pair of IMAP/SMTP endpoints plus the human step the user
 * must take before a password works (2FA app password, 163 authorization
 * code, Proton Bridge). `custom` lets the user type endpoints themselves,
 * which is also how a local test server is addressed.
 */

/** @typedef {{host: string, port: number, secure: boolean, starttls?: boolean, rejectUnauthorized?: boolean, sendId?: boolean}} Endpoint */

/**
 * @typedef {object} ProviderPreset
 * @property {string} id
 * @property {string} label
 * @property {string[]} domains
 * @property {Endpoint} imap
 * @property {Endpoint} smtp
 * @property {'app-password'|'authorization-code'|'bridge'|'password'} auth
 * @property {boolean} [direct] this provider is reached without the configured proxy
 * @property {{en: string, zh: string}} hint
 * @property {string} [doc]
 */

/** @type {Record<string, ProviderPreset>} */
export const PROVIDERS = {
  gmail: {
    id: 'gmail',
    label: 'Gmail / Google Workspace',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true, rejectUnauthorized: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true, rejectUnauthorized: true },
    auth: 'app-password',
    hint: {
      en: 'Google needs an App Password: enable 2-Step Verification, then create one at myaccount.google.com/apppasswords. Your normal password will be rejected.',
      zh: 'Google 需要「应用专用密码」：先开启两步验证，再到 myaccount.google.com/apppasswords 生成 16 位密码；账号主密码会被拒绝。',
    },
    doc: 'https://support.google.com/mail/answer/185833',
  },
  '163': {
    id: '163',
    label: '网易 163 邮箱',
    domains: ['163.com'],
    imap: { host: 'imap.163.com', port: 993, secure: true, rejectUnauthorized: true, sendId: true },
    smtp: { host: 'smtp.163.com', port: 465, secure: true, rejectUnauthorized: true },
    auth: 'authorization-code',
    direct: true,
    hint: {
      en: '163 needs the client authorization code from Settings → POP3/SMTP/IMAP (not the web login password), and IMAP must be enabled.',
      zh: '163 需要「客户端授权密码」：在网页版 设置 → POP3/SMTP/IMAP 中开启 IMAP 并生成授权码，不能用于登录的网页密码。',
    },
  },
  '126': {
    id: '126',
    label: '网易 126 邮箱',
    domains: ['126.com'],
    imap: { host: 'imap.126.com', port: 993, secure: true, rejectUnauthorized: true, sendId: true },
    smtp: { host: 'smtp.126.com', port: 465, secure: true, rejectUnauthorized: true },
    auth: 'authorization-code',
    direct: true,
    hint: {
      en: '126 needs the client authorization code from Settings → POP3/SMTP/IMAP, with IMAP enabled.',
      zh: '126 需要「客户端授权密码」：在网页版 设置 → POP3/SMTP/IMAP 中开启 IMAP 并生成授权码。',
    },
  },
  qq: {
    id: 'qq',
    label: 'QQ 邮箱',
    domains: ['qq.com', 'foxmail.com'],
    imap: { host: 'imap.qq.com', port: 993, secure: true, rejectUnauthorized: true, sendId: true },
    smtp: { host: 'smtp.qq.com', port: 465, secure: true, rejectUnauthorized: true },
    auth: 'authorization-code',
    direct: true,
    hint: {
      en: 'QQ Mail needs the authorization code from Settings → Account → IMAP/SMTP service.',
      zh: 'QQ 邮箱需要「授权码」：设置 → 账号 → 开启 IMAP/SMTP 服务后生成。',
    },
  },
  proton: {
    id: 'proton',
    label: 'Proton Mail (Bridge)',
    domains: ['proton.me', 'protonmail.com', 'pm.me'],
    imap: { host: '127.0.0.1', port: 1143, secure: false, starttls: true, rejectUnauthorized: false, sendId: false },
    smtp: { host: '127.0.0.1', port: 1025, secure: false, starttls: true, rejectUnauthorized: false },
    auth: 'bridge',
    direct: true,
    hint: {
      en: 'Proton has no direct IMAP. Install Proton Mail Bridge, then log in here with the Bridge credentials it shows (usually 127.0.0.1:1143 / 1025).',
      zh: 'Proton 不提供直连 IMAP。请先安装 Proton Mail Bridge，再填 Bridge 显示的账号和密码（默认 127.0.0.1:1143 / 1025）。',
    },
    doc: 'https://proton.me/mail/bridge',
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook / Microsoft 365',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'office365.com'],
    imap: { host: 'outlook.office365.com', port: 993, secure: true, rejectUnauthorized: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, starttls: true, rejectUnauthorized: true },
    auth: 'app-password',
    hint: {
      en: 'Microsoft accounts with 2FA need an app password; IMAP must be enabled on the mailbox.',
      zh: '开启了两步验证的微软账号需要「应用密码」，且邮箱需启用 IMAP。',
    },
  },
  icloud: {
    id: 'icloud',
    label: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, secure: true, rejectUnauthorized: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, starttls: true, rejectUnauthorized: true },
    auth: 'app-password',
    hint: {
      en: 'iCloud needs an app-specific password from appleid.apple.com → Sign-In and Security.',
      zh: 'iCloud 需要「App 专用密码」：appleid.apple.com → 登录与安全 中生成。',
    },
  },
  yahoo: {
    id: 'yahoo',
    label: 'Yahoo Mail',
    domains: ['yahoo.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true, rejectUnauthorized: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true, rejectUnauthorized: true },
    auth: 'app-password',
    hint: {
      en: 'Yahoo needs an app password generated in Account Security; IMAP access must be enabled.',
      zh: 'Yahoo 需要在「账号安全」中生成应用密码，并确保已开启 IMAP 访问。',
    },
  },
  custom: {
    id: 'custom',
    label: '自定义 / 自建服务器',
    domains: [],
    imap: { host: '', port: 993, secure: true, rejectUnauthorized: true },
    smtp: { host: '', port: 465, secure: true, rejectUnauthorized: true },
    auth: 'password',
    direct: true,
    hint: {
      en: 'Point IMAP and SMTP at your own server; uncheck TLS verification only for a self-signed local bridge.',
      zh: '自行填写 IMAP/SMTP 地址；仅在对端是自签名本地桥接时才关闭 TLS 校验。',
    },
  },
}

/** Provider ids in display order — an explicit list, because integer-like keys
 *  ("163", "126") would otherwise sort ahead of Gmail in `Object.keys`. */
export const PROVIDER_IDS = ['gmail', '163', '126', 'qq', 'proton', 'outlook', 'icloud', 'yahoo', 'custom']

/**
 * Guess a provider from the address domain.
 * @param {string} email address
 * @returns {string} provider id, `custom` when unknown
 */
export function guessProvider(email) {
  const domain = String(email ?? '').toLowerCase().split('@')[1] ?? ''
  if (domain === '') return 'custom'
  for (const id of PROVIDER_IDS) {
    const preset = PROVIDERS[id]
    if (preset.domains.some(candidate => domain === candidate || domain.endsWith(`.${candidate}`))) return id
  }
  return 'custom'
}

/**
 * Build the endpoint pair for one account, layering explicit overrides from
 * the login form over the provider preset.
 * @param {string} providerId preset id
 * @param {{imap?: Partial<Endpoint>, smtp?: Partial<Endpoint>}} [overrides] user values
 * @returns {{imap: Endpoint, smtp: Endpoint}} endpoints
 */
export function resolveEndpoints(providerId, overrides = {}) {
  const preset = PROVIDERS[providerId] ?? PROVIDERS.custom
  const merge = (base, patch) => {
    const next = { ...base }
    for (const [key, value] of Object.entries(patch ?? {})) {
      if (value === undefined || value === null || value === '') continue
      if (key === 'port') next.port = Number(value)
      else if (key === 'secure' || key === 'starttls' || key === 'rejectUnauthorized' || key === 'sendId') next[key] = Boolean(value)
      else next[key] = String(value)
    }
    return next
  }
  return {
    imap: merge(preset.imap, overrides.imap),
    smtp: merge(preset.smtp, overrides.smtp),
  }
}

/**
 * Validate an endpoint pair before it is used.
 * @param {{imap: Endpoint, smtp: Endpoint}} endpoints endpoints
 * @returns {string[]} problems (empty when usable)
 */
export function validateEndpoints(endpoints) {
  const problems = []
  if (endpoints.imap.host === '') problems.push('IMAP 服务器地址为空')
  if (endpoints.smtp.host === '') problems.push('SMTP 服务器地址为空')
  for (const [name, endpoint] of Object.entries(endpoints)) {
    if (!Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65_535) {
      problems.push(`${name.toUpperCase()} 端口无效: ${String(endpoint.port)}`)
    }
    if (endpoint.secure === true && endpoint.starttls === true) {
      problems.push(`${name.toUpperCase()} 不能同时启用隐式 TLS 与 STARTTLS`)
    }
  }
  return problems
}

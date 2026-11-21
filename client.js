window.__ModuleLoader__.load({
  id: 'dsh-email',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useState } = React
    const h = React.createElement

    /** Same-origin endpoint served by index.js (absolute, like the HMR channel). */
    const API_PATH = 'plugins/dsh-email/api'
    const HEADER = { 'content-type': 'application/json', 'x-dsh-email': '1' }

    const DICTS = {
      zh: {
        nav: '邮件',
        title: '邮件账号',
        subtitle: '在这里登录一次，harness 就能用 email_* 工具收发邮件。密码保存在本机凭据库，不会进入对话、报告或日志。',
        addAccount: '添加邮箱账号',
        cancel: '取消',
        provider: '服务商',
        email: '邮箱地址',
        password: '密码 / 授权码',
        passwordHint: 'Gmail/Outlook 用应用专用密码；163/QQ 用客户端授权码；Proton 用 Bridge 显示的密码。',
        label: '显示名（可选）',
        advanced: '高级：自定义服务器',
        imapHost: 'IMAP 地址',
        imapPort: '端口',
        smtpHost: 'SMTP 地址',
        smtpPort: '端口',
        implicitTls: '隐式 TLS（465）',
        starttls: 'STARTTLS（587/1143）',
        skipVerify: '跳过 TLS 证书校验（仅本地桥接）',
        proxy: '代理（可选）',
        proxyHint: '用于这条邮箱的代理。留空 = 跟随全局设置；填 off = 强制直连。支持 host:port / http:// / socks5://。',
        proxyOff: '直连',
        proxyGlobal: '全局代理',
        smtpProxy: 'SMTP 代理（可选）',
        smtpProxyHint: '留空 = 与 IMAP 相同；填 off = SMTP 直连。很多代理节点会封 465/587，收信走代理、发信直连是常见组合。',
        save: '登录并保存',
        saving: '正在验证 IMAP/SMTP…',
        testing: '测试中…',
        test: '测试',
        setDefault: '设为默认',
        remove: '删除',
        removeConfirm: '确认删除？',
        noAccounts: '还没有登录任何邮箱。点下面的「添加邮箱账号」开始。',
        defaultBadge: '默认',
        missingPassword: '缺密码，请重新登录',
        lastTestFailed: '上次测试失败',
        lastTestOk: '上次测试通过',
        note: '工具能力：email_accounts · email_mailboxes · email_search · email_read · email_send · email_reply · email_wait · email_attachment',
        imap: 'IMAP',
        smtp: 'SMTP',
        loadFailed: '加载失败',
        formError: '登录失败',
        ok: '已保存',
        deleteFailed: '删除失败',
        testFailed: '测试失败',
        defaultFailed: '设置默认失败',
        mailboxes: '个文件夹',
        security: '读取邮件使用 PEEK，不会把邮件标记为已读。',
        loading: '加载中…',
      },
      en: {
        nav: 'Email',
        title: 'Email accounts',
        subtitle: 'Log in once here and the agent can use the email_* tools. Passwords stay in the local credential store — never in the conversation, reports, or logs.',
        addAccount: 'Add account',
        cancel: 'Cancel',
        provider: 'Provider',
        email: 'Address',
        password: 'Password / app password',
        passwordHint: 'Gmail/Outlook need an app password, 163/QQ an authorization code, Proton the Bridge password.',
        label: 'Display name (optional)',
        advanced: 'Advanced: custom servers',
        imapHost: 'IMAP host',
        imapPort: 'Port',
        smtpHost: 'SMTP host',
        smtpPort: 'Port',
        implicitTls: 'Implicit TLS (465)',
        starttls: 'STARTTLS (587/1143)',
        skipVerify: 'Skip TLS verification (local bridge only)',
        proxy: 'Proxy (optional)',
        proxyHint: 'Proxy for this mailbox. Empty = follow the global setting; "off" = always direct. Accepts host:port / http:// / socks5://.',
        proxyOff: 'direct',
        proxyGlobal: 'global proxy',
        smtpProxy: 'SMTP proxy (optional)',
        smtpProxyHint: 'Empty = same as IMAP; "off" = send directly. Many proxy nodes block 465/587, so proxied IMAP + direct SMTP is a common split.',
        save: 'Log in and save',
        saving: 'Verifying IMAP/SMTP…',
        testing: 'Testing…',
        test: 'Test',
        setDefault: 'Make default',
        remove: 'Remove',
        removeConfirm: 'Confirm remove?',
        noAccounts: 'No account yet. Use “Add account” below.',
        defaultBadge: 'default',
        missingPassword: 'password missing — log in again',
        lastTestFailed: 'last test failed',
        lastTestOk: 'last test passed',
        note: 'Tools: email_accounts · email_mailboxes · email_search · email_read · email_send · email_reply · email_wait · email_attachment',
        imap: 'IMAP',
        smtp: 'SMTP',
        loadFailed: 'Failed to load',
        formError: 'Login failed',
        ok: 'Saved',
        deleteFailed: 'Remove failed',
        testFailed: 'Test failed',
        defaultFailed: 'Could not set default',
        mailboxes: 'folders',
        security: 'Reading uses PEEK, so messages are not marked as read.',
        loading: 'Loading…',
      },
    }

    const STYLES = `
.dsh-email-section { display:flex; flex-direction:column; gap:16px; padding:8px 0; font-size:13px; line-height:22px; color:var(--dsw-alias-label-primary); }
.dsh-email-head { display:flex; flex-direction:column; gap:4px; }
.dsh-email-title { font-size:16px; font-weight:600; line-height:24px; }
.dsh-email-sub { color:var(--dsw-alias-label-secondary); }
.dsh-email-list { display:flex; flex-direction:column; gap:8px; }
.dsh-email-card { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 16px; border:0.5px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
.dsh-email-ident { display:flex; align-items:center; gap:10px; min-width:0; }
.dsh-email-avatar { flex:none; display:flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:50%; font-weight:600; text-transform:uppercase; color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-2); }
.dsh-email-copy { display:flex; flex-direction:column; min-width:0; }
.dsh-email-address { font-size:14px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-email-meta { color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dsh-email-actions { display:flex; align-items:center; gap:8px; flex:none; flex-wrap:wrap; }
.dsh-email-badges { display:flex; gap:6px; flex-wrap:wrap; margin-top:2px; }
.dsh-email-badge { font-size:11px; line-height:16px; padding:1px 6px; border-radius:6px; border:0.5px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.dsh-email-badge.is-default { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }
.dsh-email-badge.is-warn { color:var(--dsw-alias-state-warn-primary); border-color:var(--dsw-alias-state-warn-primary); }
.dsh-email-badge.is-error { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dsh-email-badge.is-ok { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }
.dsh-email-btn { display:inline-flex; align-items:center; gap:6px; height:28px; padding:0 10px; border-radius:8px; border:0.5px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); font-size:12px; font-family:inherit; cursor:pointer; }
.dsh-email-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.dsh-email-btn:disabled { opacity:.55; cursor:default; }
.dsh-email-btn:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.dsh-email-btn.is-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-bg-base); }
.dsh-email-btn.is-danger { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-state-error-primary); }
.dsh-email-form { display:flex; flex-direction:column; gap:12px; padding:16px; border:0.5px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
.dsh-email-row { display:flex; gap:12px; flex-wrap:wrap; }
.dsh-email-field { display:flex; flex-direction:column; gap:4px; flex:1 1 200px; min-width:0; }
.dsh-email-caption { font-size:12px; color:var(--dsw-alias-label-secondary); }
.dsh-email-input, .dsh-email-select { height:32px; padding:0 10px; border-radius:8px; border:0.5px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-base); color:inherit; font-size:13px; font-family:inherit; }
.dsh-email-input:focus-visible, .dsh-email-select:focus-visible { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.dsh-email-check { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--dsw-alias-label-secondary); min-height:32px; }
.dsh-email-hint { font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; }
.dsh-email-error { font-size:12px; line-height:18px; color:var(--dsw-alias-state-error-primary); white-space:pre-wrap; }
.dsh-email-report { display:flex; gap:8px; flex-wrap:wrap; }
.dsh-email-empty { padding:16px; border:0.5px dashed var(--dsw-alias-border-l2); border-radius:12px; color:var(--dsw-alias-label-secondary); text-align:center; }
.dsh-email-foot { font-size:12px; color:var(--dsw-alias-label-secondary); }
.dsh-email-details { border-top:0.5px solid var(--dsw-alias-border-l1); padding-top:12px; display:flex; flex-direction:column; gap:12px; }
.dsh-email-details > summary { cursor:pointer; font-size:12px; color:var(--dsw-alias-label-secondary); }
`

    /** One same-origin POST to the plugin API. */
    async function call(op, payload, signal) {
      const response = await fetch(`${location.origin}/${API_PATH}`, {
        method: 'POST',
        headers: HEADER,
        body: JSON.stringify({ op, ...(payload ?? {}) }),
        signal,
      })
      if (response.ok === false) throw new Error(`HTTP ${response.status}`)
      const json = await response.json()
      if (json.ok === false) {
        const error = new Error(json.error ?? 'operation failed')
        error.code = json.code
        throw error
      }
      return json
    }

    /** Current UI language id, 'zh' or 'en'. */
    function readLang(ctx) {
      try {
        const locale = serviceOf(ctx, 'locale')
        const snapshot = locale?.getSnapshot?.() ?? locale?.getLocale?.() ?? {}
        const id = String(snapshot.active ?? snapshot.id ?? snapshot.locale ?? 'zh').toLowerCase()
        return id.startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }

    /** Read one service defensively: an undeclared service throws on access. */
    function serviceOf(ctx, name) {
      try {
        return ctx?.[name] ?? undefined
      } catch {
        return undefined
      }
    }

    /** Translate + re-render on locale change; degrades to Chinese without a locale service. */
    function useTranslate(ctx) {
      const [tick, setTick] = useState(0)
      useEffect(() => {
        try {
          const locale = serviceOf(ctx, 'locale')
          if (typeof locale?.subscribe !== 'function') return undefined
          const dispose = locale.subscribe(() => setTick(value => value + 1))
          return typeof dispose === 'function' ? dispose : undefined
        } catch {
          return undefined
        }
      }, [ctx])
      return useCallback(key => DICTS[readLang(ctx)][key] ?? DICTS.en[key] ?? key, [ctx, tick])
    }

    /** Badge chip. */
    function Badge({ text, kind }) {
      return h('span', { className: kind === undefined ? 'dsh-email-badge' : `dsh-email-badge is-${kind}` }, text)
    }

    /** Labelled field wrapper. */
    function Field({ label, children }) {
      return h('div', { className: 'dsh-email-field' },
        h('div', { className: 'dsh-email-caption' }, label),
        children)
    }

    /** One account row. */
    function AccountCard({ account, t, busy, confirming, onTest, onDefault, onRemove }) {
      const endpointLine = `${account.providerLabel ?? account.provider} · IMAP ${account.imap.host}:${account.imap.port} · SMTP ${account.smtp.host}:${account.smtp.port}`
      const badges = []
      if (account.default === true) badges.push(h(Badge, { key: 'default', text: t('defaultBadge'), kind: 'default' }))
      if (account.hasPassword === false) badges.push(h(Badge, { key: 'nopass', text: t('missingPassword'), kind: 'warn' }))
      if (account.lastTest?.ok === true) badges.push(h(Badge, { key: 'ok', text: t('lastTestOk'), kind: 'ok' }))
      if (account.lastTest?.ok === false) badges.push(h(Badge, { key: 'fail', text: t('lastTestFailed'), kind: 'error' }))
      const imapRoute = account.route === undefined || account.route === 'direct' ? t('proxyOff') : account.route
      const smtpRoute = account.smtpRoute === undefined || account.smtpRoute === 'direct' ? t('proxyOff') : account.smtpRoute
      badges.push(h(Badge, {
        key: 'route',
        text: imapRoute === smtpRoute ? `IMAP/SMTP ${imapRoute === t('proxyOff') ? imapRoute : `via ${imapRoute}`}` : `IMAP ${imapRoute === t('proxyOff') ? imapRoute : `via ${imapRoute}`} · SMTP ${smtpRoute === t('proxyOff') ? smtpRoute : `via ${smtpRoute}`}`,
      }))

      return h('div', { className: 'dsh-email-card' },
        h('div', { className: 'dsh-email-ident' },
          h('div', { className: 'dsh-email-avatar', 'aria-hidden': 'true' }, account.email.slice(0, 1)),
          h('div', { className: 'dsh-email-copy' },
            h('div', { className: 'dsh-email-address' }, account.label === '' ? account.email : `${account.label} · ${account.email}`),
            h('div', { className: 'dsh-email-meta', title: endpointLine }, endpointLine),
            badges.length === 0 ? null : h('div', { className: 'dsh-email-badges' }, ...badges))),
        h('div', { className: 'dsh-email-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-email-btn',
            disabled: busy,
            onClick: () => onTest(account),
          }, busy ? t('testing') : t('test')),
          account.default === true ? null : h('button', {
            type: 'button',
            className: 'dsh-email-btn',
            disabled: busy,
            onClick: () => onDefault(account),
          }, t('setDefault')),
          h('button', {
            type: 'button',
            className: 'dsh-email-btn is-danger',
            disabled: busy,
            onClick: () => onRemove(account),
          }, confirming ? t('removeConfirm') : t('remove'))))
    }

    /** The add-account form. */
    function AddAccountForm({ form, providers, t, lang, defaults, busy, onChange, onProvider, onSubmit, onCancel }) {
      const provider = providers.find(item => item.id === form.provider)
      const hint = provider === undefined ? '' : (lang === 'zh' ? provider.hint.zh : provider.hint.en)
      const set = (patch) => onChange({ ...form, ...patch })

      const providerField = h(Field, { key: 'provider', label: t('provider') },
        h('select', {
          className: 'dsh-email-select',
          'aria-label': t('provider'),
          value: form.provider,
          onChange: event => onProvider(event.target.value),
        }, ...providers.map(item => h('option', { key: item.id, value: item.id }, item.label))))

      const emailField = h(Field, { key: 'email', label: t('email') },
        h('input', {
          className: 'dsh-email-input',
          'aria-label': t('email'),
          type: 'email',
          required: true,
          autoComplete: 'username',
          value: form.email,
          onChange: event => set({ email: event.target.value }),
        }))

      const labelField = h(Field, { key: 'label', label: t('label') },
        h('input', {
          className: 'dsh-email-input',
          'aria-label': t('label'),
          type: 'text',
          placeholder: 'Kali',
          value: form.label,
          onChange: event => set({ label: event.target.value }),
        }))

      const passwordField = h(Field, { key: 'password', label: t('password') },
        h('input', {
          className: 'dsh-email-input',
          'aria-label': t('password'),
          type: 'password',
          required: true,
          autoComplete: 'current-password',
          value: form.password,
          onChange: event => set({ password: event.target.value }),
        }))

      const advanced = h('details', {
        key: 'advanced',
        className: 'dsh-email-details',
        open: form.advanced,
        onToggle: event => set({ advanced: event.target.open }),
      },
        h('summary', null, t('advanced')),
        h('div', { className: 'dsh-email-row' },
          h(Field, { label: t('imapHost') },
            h('input', {
              className: 'dsh-email-input',
              'aria-label': t('imapHost'),
              value: form.imap.host,
              onChange: event => set({ imap: { ...form.imap, host: event.target.value } }),
            })),
          h(Field, { label: t('imapPort') },
            h('input', {
              className: 'dsh-email-input',
              'aria-label': t('imapPort'),
              type: 'number',
              value: form.imap.port,
              onChange: event => set({ imap: { ...form.imap, port: event.target.value } }),
            })),
          h('label', { className: 'dsh-email-check' },
            h('input', {
              type: 'checkbox',
              'aria-label': `IMAP ${t('implicitTls')}`,
              checked: form.imap.secure === true,
              onChange: event => set({ imap: { ...form.imap, secure: event.target.checked, starttls: event.target.checked ? false : form.imap.starttls } }),
            }),
            t('implicitTls')),
          h('label', { className: 'dsh-email-check' },
            h('input', {
              type: 'checkbox',
              'aria-label': `IMAP ${t('starttls')}`,
              checked: form.imap.starttls === true,
              onChange: event => set({ imap: { ...form.imap, starttls: event.target.checked, secure: event.target.checked ? false : form.imap.secure } }),
            }),
            t('starttls'))),
        h('div', { className: 'dsh-email-row' },
          h(Field, { label: t('smtpHost') },
            h('input', {
              className: 'dsh-email-input',
              'aria-label': t('smtpHost'),
              value: form.smtp.host,
              onChange: event => set({ smtp: { ...form.smtp, host: event.target.value } }),
            })),
          h(Field, { label: t('smtpPort') },
            h('input', {
              className: 'dsh-email-input',
              'aria-label': t('smtpPort'),
              type: 'number',
              value: form.smtp.port,
              onChange: event => set({ smtp: { ...form.smtp, port: event.target.value } }),
            })),
          h('label', { className: 'dsh-email-check' },
            h('input', {
              type: 'checkbox',
              'aria-label': `SMTP ${t('implicitTls')}`,
              checked: form.smtp.secure === true,
              onChange: event => set({ smtp: { ...form.smtp, secure: event.target.checked, starttls: event.target.checked ? false : form.smtp.starttls } }),
            }),
            t('implicitTls')),
          h('label', { className: 'dsh-email-check' },
            h('input', {
              type: 'checkbox',
              'aria-label': `SMTP ${t('starttls')}`,
              checked: form.smtp.starttls === true,
              onChange: event => set({ smtp: { ...form.smtp, starttls: event.target.checked, secure: event.target.checked ? false : form.smtp.secure } }),
            }),
            t('starttls'))),
        h('label', { className: 'dsh-email-check' },
          h('input', {
            type: 'checkbox',
            checked: form.rejectUnauthorized === false,
            onChange: event => set({ rejectUnauthorized: event.target.checked === false }),
          }),
          t('skipVerify')),
        h('div', { className: 'dsh-email-row' },
          h(Field, { label: t('proxy') },
            h('input', {
              className: 'dsh-email-input',
              'aria-label': t('proxy'),
              type: 'text',
              placeholder: defaults?.proxy === undefined || defaults.proxy === '' ? 'off' : defaults.proxy,
              value: form.proxy,
              onChange: event => set({ proxy: event.target.value }),
            }))),
        h('div', { className: 'dsh-email-row' },
          h(Field, { label: t('smtpProxy') },
            h('input', {
              className: 'dsh-email-input',
              'aria-label': t('smtpProxy'),
              type: 'text',
              placeholder: '-',
              value: form.smtpProxy,
              onChange: event => set({ smtpProxy: event.target.value }),
            }))),
        h('div', { className: 'dsh-email-hint' },
          `${t('proxyHint')}${defaults?.proxy === undefined || defaults.proxy === '' ? '' : `（${t('proxyGlobal')}: ${defaults.proxy}）`}`),
        h('div', { className: 'dsh-email-hint' }, t('smtpProxyHint')))

      const actions = h('div', { key: 'actions', className: 'dsh-email-actions' },
        h('button', { type: 'submit', className: 'dsh-email-btn is-primary', disabled: busy },
          busy ? t('saving') : t('save')),
        h('button', { type: 'button', className: 'dsh-email-btn', disabled: busy, onClick: onCancel }, t('cancel')))

      return h('form', { className: 'dsh-email-form', onSubmit },
        h('div', { className: 'dsh-email-row' }, providerField, emailField, labelField),
        passwordField,
        hint === '' ? null : h('div', { className: 'dsh-email-hint' }, hint),
        h('div', { className: 'dsh-email-hint' }, t('passwordHint')),
        advanced,
        actions)
    }

    /** The settings page. */
    function EmailSettings(props) {
      const ctx = props.ctx
      const t = useTranslate(ctx)
      const lang = readLang(ctx)
      const [accounts, setAccounts] = useState(undefined)
      const [providers, setProviders] = useState([])
      const [defaults, setDefaults] = useState(undefined)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busyId, setBusyId] = useState('')
      const [confirmId, setConfirmId] = useState('')
      const [form, setForm] = useState(undefined)
      const [report, setReport] = useState(undefined)

      useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const [catalog, list] = await Promise.all([call('catalog'), call('list')])
            if (alive === false) return
            setProviders(catalog.providers ?? [])
            setDefaults(catalog.defaults)
            setAccounts(list.accounts ?? [])
          } catch (failure) {
            if (alive === false) return
            setError(`${t('loadFailed')}: ${failure.message}`)
            setAccounts([])
          }
        })()
        return () => { alive = false }
      }, [t])

      const reload = useCallback(async () => {
        try {
          const list = await call('list')
          setAccounts(list.accounts ?? [])
        } catch { /* the next user action surfaces the failure */ }
      }, [])

      const openForm = useCallback(() => {
        const first = providers[0]
        setError('')
        setNotice('')
        setReport(undefined)
        setConfirmId('')
        setForm({
          provider: first?.id ?? 'gmail',
          email: '',
          password: '',
          label: '',
          imap: {
            host: first?.imap?.host ?? '',
            port: first?.imap?.port ?? 993,
            secure: first?.imap?.secure !== false,
            starttls: first?.imap?.starttls === true,
          },
          smtp: {
            host: first?.smtp?.host ?? '',
            port: first?.smtp?.port ?? 465,
            secure: first?.smtp?.secure !== false,
            starttls: first?.smtp?.starttls === true,
          },
          advanced: false,
          rejectUnauthorized: true,
          proxy: '',
          smtpProxy: '',
        })
      }, [providers])

      const pickProvider = useCallback((id) => {
        const preset = providers.find(item => item.id === id)
        setForm(current => current === undefined ? current : {
          ...current,
          provider: id,
          imap: {
            host: preset?.imap?.host ?? '',
            port: preset?.imap?.port ?? 993,
            secure: preset?.imap?.secure !== false,
            starttls: preset?.imap?.starttls === true,
          },
          smtp: {
            host: preset?.smtp?.host ?? '',
            port: preset?.smtp?.port ?? 465,
            secure: preset?.smtp?.secure !== false,
            starttls: preset?.smtp?.starttls === true,
          },
          rejectUnauthorized: preset?.imap?.rejectUnauthorized !== false,
        })
      }, [providers])

      const submit = useCallback(async (event) => {
        event.preventDefault()
        if (form === undefined) return
        setBusyId('form')
        setError('')
        setNotice('')
        setReport(undefined)
        try {
          const result = await call('add', {
            email: form.email.trim(),
            password: form.password,
            provider: form.provider,
            label: form.label,
            proxy: form.proxy.trim(),
            smtpProxy: form.smtpProxy.trim(),
            imap: {
              host: form.imap.host.trim(),
              port: Number(form.imap.port),
              secure: form.imap.secure === true,
              starttls: form.imap.starttls === true,
              rejectUnauthorized: form.rejectUnauthorized !== false,
            },
            smtp: {
              host: form.smtp.host.trim(),
              port: Number(form.smtp.port),
              secure: form.smtp.secure === true,
              starttls: form.smtp.starttls === true,
              rejectUnauthorized: form.rejectUnauthorized !== false,
            },
          })
          setAccounts(result.accounts ?? [])
          setReport(result.report)
          const warnings = result.warnings ?? []
          setNotice(warnings.length > 0 ? warnings.join('\n') : t('ok'))
          if (warnings.length === 0) setForm(undefined)
        } catch (failure) {
          setError(`${t('formError')}: ${failure.message}`)
        } finally {
          setBusyId('')
        }
      }, [form, t])

      const runOp = useCallback(async (op, account, failureLabel) => {
        setBusyId(account.id)
        setError('')
        setNotice('')
        try {
          const result = await call(op, { account: account.id })
          if (result.accounts !== undefined) setAccounts(result.accounts)
          if (result.report !== undefined) setReport(result.report)
          if (op === 'test') setNotice(`${account.email} — ${result.ok === true ? t('lastTestOk') : t('lastTestFailed')}`)
          else setNotice(t('ok'))
        } catch (failure) {
          setError(`${failureLabel}: ${failure.message}`)
        } finally {
          setBusyId('')
        }
      }, [t])

      const remove = useCallback(async (account) => {
        if (confirmId !== account.id) {
          setConfirmId(account.id)
          return
        }
        setConfirmId('')
        setBusyId(account.id)
        try {
          const result = await call('remove', { account: account.id })
          setAccounts(result.accounts ?? [])
          setNotice(t('ok'))
        } catch (failure) {
          setError(`${t('deleteFailed')}: ${failure.message}`)
          await reload()
        } finally {
          setBusyId('')
        }
      }, [confirmId, reload, t])

      const reportNode = report === undefined ? null : h('div', { className: 'dsh-email-report' },
        h(Badge, {
          text: report.imap?.ok === true
            ? `IMAP OK · ${report.imap.ms}ms · ${report.imap.mailboxes} ${t('mailboxes')}`
            : `IMAP ✗ ${report.imap?.error ?? ''}`,
          kind: report.imap?.ok === true ? 'ok' : 'error',
        }),
        h(Badge, {
          text: report.smtp?.ok === true ? `SMTP OK · ${report.smtp.ms}ms` : `SMTP ✗ ${report.smtp?.error ?? ''}`,
          kind: report.smtp?.ok === true ? 'ok' : 'error',
        }))

      let body
      if (accounts === undefined) body = h('div', { className: 'dsh-email-empty' }, t('loading'))
      else if (accounts.length === 0) body = h('div', { className: 'dsh-email-empty' }, t('noAccounts'))
      else {
        body = h('div', { className: 'dsh-email-list' }, ...accounts.map(account => h(AccountCard, {
          key: account.id,
          account,
          t,
          busy: busyId === account.id,
          confirming: confirmId === account.id,
          onTest: item => runOp('test', item, t('testFailed')),
          onDefault: item => runOp('default', item, t('defaultFailed')),
          onRemove: item => remove(item),
        })))
      }

      const formNode = form === undefined
        ? h('div', null, h('button', { type: 'button', className: 'dsh-email-btn is-primary', onClick: openForm }, t('addAccount')))
        : h(AddAccountForm, {
          form,
          providers,
          t,
          lang,
          defaults,
          busy: busyId === 'form',
          onChange: setForm,
          onProvider: pickProvider,
          onSubmit: submit,
          onCancel: () => { setForm(undefined); setError('') },
        })

      return h('div', { className: 'dsh-email-section' },
        h('style', null, STYLES),
        h('div', { className: 'dsh-email-head' },
          h('div', { className: 'dsh-email-title' }, t('title')),
          h('div', { className: 'dsh-email-sub' }, t('subtitle'))),
        error === '' ? null : h('div', { className: 'dsh-email-error', role: 'alert' }, error),
        notice === '' ? null : h('div', { className: 'dsh-email-hint', role: 'status' }, notice),
        body,
        reportNode,
        formNode,
        h('div', { className: 'dsh-email-foot' }, t('note')),
        h('div', { className: 'dsh-email-foot' }, t('security')))
    }

    /** Nav label, localized at render time by the settings shell. */
    function makeLabel(ctx) {
      return () => DICTS[readLang(ctx)].nav
    }

    return {
      // `locale` must be declared: a Cordis client context throws when a
      // plugin reads a service it did not inject.
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-email',
          order: 30,
          label: makeLabel(ctx),
        }, props => h(EmailSettings, { ...props, ctx }))), 'dsh-email: settings section')
      },
    }
  },
})

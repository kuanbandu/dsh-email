# 发布清单

> 这个仓库已经公开、可以安装；npm 上的 `@kuanbandu/dsh-email` **尚未发布**，
> 因为账号开了 `auth-and-writes` 2FA，而发布必须过一道 OTP。

## 需要拿到的东西（三选一，都只需做一次）

npm 账号的 2FA 是「安全钥匙优先」。以下三条路任选：

### ① 加一个身份验证器（一劳永逸）

手机 Chrome 打开 `https://www.npmjs.com/settings/kuanbandu/tfa`（先开"桌面版网站"）
→ **Two-Factor Authentication** → **Edit** → 选 **Authenticator app**
→ 复制页面上的 **setup key**（"无法扫描？"里那串）
→ 手机装 Google Authenticator → **输入设置密钥** → 粘贴 → 保存
→ 之后手机随时有 6 位码，电脑也能登录。

发布：

```bash
cd dsh-email
npm publish --otp=<手机上当前的 6 位码>
```

### ② 临时允许无 2FA 写入

同一个 2FA 页面 → **Edit** → 选 **Authorization only** → 保存
→ `npm publish`（不用验证码）→ 发完改回 **Authorization and writes**。

### ③ 建一个 Automation token

`https://www.npmjs.com/settings/kuanbandu/tokens` → **Generate New Token**
→ **Classic Token** → 类型 **Automation** → 复制 `npm_…`

```bash
printf '//registry.npmjs.org/:_authToken=%s\n' 'npm_…' > ~/.npmrc-publish
chmod 600 ~/.npmrc-publish
npm publish --userconfig ~/.npmrc-publish
rm -f ~/.npmrc-publish
```

## 或者交给 CI（推荐，凭据不落地）

1. 把上面的 Automation token 存成仓库 secret：**Settings → Secrets and variables → Actions → New repository secret**，名字 `NPM_TOKEN`
2. 打一个 tag：
   ```bash
   git tag v0.1.1 && git push origin v0.1.1
   ```
3. `.github/workflows/publish.yml` 会自动 `npm test` + `npm publish --access public`

## 发布后要改的地方

- `README.md` 顶部加回 npm 徽章，安装方式以 `pnpm add @kuanbandu/dsh-email` 为主
- `package.json` 的 `version` 递增，打 tag 并写 release notes

## 安全提醒

- 不要把 token / 恢复码贴进对话或 issue；只用文件、环境变量或仓库 secret。
- 一旦某个 token 出现在日志或聊天里，立刻去 Access Tokens 页删除。

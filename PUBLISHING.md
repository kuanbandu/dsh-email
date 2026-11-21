# 发布清单

## 现状

`@kuanbandu/dsh-email` **已发布到 npm**：`0.1.0`、`0.1.1`，`latest = 0.1.1`。

```bash
pnpm add @kuanbandu/dsh-email
```

> 首次发布遇到过 npm 的暂存占位：`latest` 一度指向 `0.0.0-stage`。修正命令：
> ```bash
> npm dist-tag add @kuanbandu/dsh-email@0.1.1 latest
> ```

## 长期备用：三条命令

| 想做的事 | 命令 | 说明 |
| --- | --- | --- |
| 推代码到 GitHub | `git push` | 仓库本地已设 `http.proxy=""`（本机全局代理连不上 GitHub）；换机器时用 `git -c http.proxy= push` |
| 提插件市场 PR | `bash scripts/open-registry-pr.sh` | 幂等：建 fork → 建分支 → 写条目 → 开 PR；`--dry-run` 只检查不写 |
| 发新版本 | `bash scripts/release.sh patch` | 跑测试 → 升版本 → 打 tag → 推送 → CI 用 OIDC 发布（不需要 token） |

已经排好的定时任务：仓库满 24 小时后自动执行一次 `open-registry-pr.sh`
（`systemctl --user list-timers 'dsh-email-*'` 可查，日志在 `~/dsh-email/.registry-pr.log`）。

## 以后怎么发版（两种，任选）

### A. OIDC 无令牌发布（推荐，已配好 workflow）

仓库里的 `.github/workflows/publish.yml` 已改为 Trusted Publishing：
不需要任何 token，GitHub Actions 用 OIDC 向 npm 证明「我是这个仓库的这个工作流」。

一次性配置（npm 网页端，只做一次）：
包页面 → **Settings** → **Trusted Publisher** → **GitHub Actions**

| 字段 | 填 |
| --- | --- |
| Organization or user | `kuanbandu` |
| Repository | `dsh-email` |
| Workflow filename | `publish.yml`（必须与文件名完全一致） |
| Environment | 留空 |

之后发版只要：

```bash
npm version patch          # 或 minor / major
git push && git push --tags
```

CI 会跑 `npm test` 然后 `npm publish --access public --provenance`。
成功发布后，建议在 **Publishing access** 里收紧为
「Require two-factor authentication and disallow tokens」——从此任何传统 token 都不能发布。

### B. 本地手动发布（需要一次性 2FA）

见下面的历史记录：拿到 `Read and write (publish and stage)` 的 token 后

```bash
printf '//registry.npmjs.org/:_authToken=%s\n' 'npm_…' > ~/.npmrc-publish
chmod 600 ~/.npmrc-publish
npm publish --userconfig ~/.npmrc-publish
rm -f ~/.npmrc-publish
```

> ⚠️ 不要在聊天/日志里贴 token。用完即删。

---

## （备查）当初为拿到发布凭据的三条路

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

---

# 上架 DSH 插件市场（awesome-dsh-plugin）

市场数据源：`awesome-dsh-plugin/awesome-dsh-plugin` 仓库里的 `data/plugins/<owner>__<repo>.yml`，
一个插件一个文件，合并后自动生成 README 与 `plugins.json`。

**本仓库已满足的条件**：`package.json` 声明了 `dsh.bundle`、有真实代码、已挂 `dsh-plugin` topic、
Release 里挂了预构建 tgz（`tarball` 字段指向它）。

**唯一还差的条件**：CI 要求 **仓库创建满 1 天**。仓库建于 2026-11-21，所以最早 **2026-11-22** 提 PR 才会变绿。

## 条目文件（直接照抄）

路径：`data/plugins/kuanbandu__dsh-email.yml`

```yaml
url: https://github.com/kuanbandu/dsh-email
name: kuanbandu/dsh-email
category: identity
description:
  en: 'Email for DeepSeek Harness: after one login in Settings → Email, the agent reads, searches, replies and sends mail through eight email_* tools. Reads use IMAP PEEK so messages are never marked as seen; passwords stay in the harness credential store; IMAP/SMTP can go through an HTTP CONNECT or SOCKS5 proxy with separate routes per direction.'
  zh: '给 DeepSeek Harness 装邮箱：在「设置 → 邮件」里登录一次后，agent 可用 8 个 email_* 工具读信、检索、回复、发信、等验证邮件、下载附件。读信用 IMAP PEEK，不会把邮件标记为已读；密码存在 harness 凭据库；IMAP/SMTP 可走 HTTP CONNECT 或 SOCKS5 代理，并支持收/发分别指定路由。'
tarball: https://github.com/kuanbandu/dsh-email/releases/latest/download/kuanbandu-dsh-email.tgz
```

> 分类选 `identity`（"身份与通信"）。写作者自己的原话：分类选得不贴切不会被打回，维护者会直接改。

## 提 PR（仓库满 1 天后）

### 首选：纯 GitHub API（不需要 git 传输，绕开 GnuTLS 握手问题）

```bash
cd /home/kali/dsh-email
# 1) 把条目存成文件
cat > /tmp/kuanbandu__dsh-email.yml <<'YAML'
url: https://github.com/kuanbandu/dsh-email
name: kuanbandu/dsh-email
category: identity
description:
  en: 'Email for DeepSeek Harness: after one login in Settings → Email, the agent reads, searches, replies and sends mail through eight email_* tools. Reads use IMAP PEEK so messages are never marked as seen; passwords stay in the harness credential store; IMAP/SMTP can go through an HTTP CONNECT or SOCKS5 proxy with separate routes per direction.'
  zh: '给 DeepSeek Harness 装邮箱：在「设置 → 邮件」里登录一次后，agent 可用 8 个 email_* 工具读信、检索、回复、发信、等验证邮件、下载附件。读信用 IMAP PEEK，不会把邮件标记为已读；密码存在 harness 凭据库；IMAP/SMTP 可走 HTTP CONNECT 或 SOCKS5 代理，并支持收/发分别指定路由。'
tarball: https://github.com/kuanbandu/dsh-email/releases/latest/download/kuanbandu-dsh-email.tgz
YAML

# 2) fork（不 clone）
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false

# 3) 在 fork 上建分支，再放文件（contents API）
SHA=$(gh api repos/awesome-dsh-plugin/awesome-dsh-plugin/commits/main --jq .sha)
gh api -X POST repos/kuanbandu/awesome-dsh-plugin/git/refs \
  -f ref=refs/heads/add-kuanbandu-dsh-email -f sha="$SHA" >/dev/null
gh api -X PUT repos/kuanbandu/awesome-dsh-plugin/contents/data/plugins/kuanbandu__dsh-email.yml \
  -f message="feat(registry): add kuanbandu/dsh-email" \
  -f content="$(base64 -w0 /tmp/kuanbandu__dsh-email.yml)" \
  -f branch=add-kuanbandu-dsh-email >/dev/null

# 4) 开 PR
gh pr create -R awesome-dsh-plugin/awesome-dsh-plugin \
  --head kuanbandu:add-kuanbandu-dsh-email --base main \
  --title "feat(registry): add kuanbandu/dsh-email" \
  --body "Adds kuanbandu/dsh-email: IMAP/SMTP email tools for the harness (8 email_* tools, PEEK reads, credential-store passwords, proxy aware). Prebuilt tarball attached to the v0.1.0 release."
```

### 备选：git 命令行（若本机 git 能直连 GitHub）

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone --remote
cd awesome-dsh-plugin
mkdir -p data/plugins
# 把上面的 YAML 存成 data/plugins/kuanbandu__dsh-email.yml
git checkout -b add-kuanbandu-dsh-email
git add data/plugins/kuanbandu__dsh-email.yml
git commit -m "feat(registry): add kuanbandu/dsh-email"
git push -u origin add-kuanbandu-dsh-email
gh pr create --title "feat(registry): add kuanbandu/dsh-email" --body "Adds kuanbandu/dsh-email: IMAP/SMTP email tools for the harness (8 email_* tools, PEEK reads, credential-store passwords, proxy aware). Prebuilt tarball attached to the v0.1.0 release."
```

审稿看的是：代码是否与描述一致（我们写的是 8 个工具、PEEK 读信、代理支持——都对得上）、分类是否贴切、是否已有同类条目、有没有可疑代码。

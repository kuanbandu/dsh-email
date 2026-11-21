#!/usr/bin/env bash
# 把 dsh-email 的条目提给 awesome-dsh-plugin（DSH 插件市场）。
#
# 只在 GitHub API 上操作，不依赖 git 传输（这台机器的 git 走代理时连不上 GitHub）。
# 幂等：重复运行会更新已有分支/文件，已存在的 PR 会被复用。
#
#   bash scripts/open-registry-pr.sh            # 真正执行
#   bash scripts/open-registry-pr.sh --dry-run  # 只做只读检查，不写任何东西
set -uo pipefail

REPO="kuanbandu/dsh-email"
REGISTRY="awesome-dsh-plugin/awesome-dsh-plugin"
FORK="kuanbandu/awesome-dsh-plugin"
BRANCH="add-kuanbandu-dsh-email"
PATH_IN_REPO="data/plugins/kuanbandu__dsh-email.yml"
LOG="${HOME}/dsh-email/.registry-pr.log"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

log() { echo "[$(date -Is)] $*" | tee -a "$LOG"; }

# 条目内容（与 README/PUBLISHING.md 保持一致）
entry() {
  cat <<'YAML'
url: https://github.com/kuanbandu/dsh-email
name: kuanbandu/dsh-email
category: identity
description:
  en: 'Email for DeepSeek Harness: after one login in Settings → Email, the agent reads, searches, replies and sends mail through eight email_* tools. Reads use IMAP PEEK so messages are never marked as seen; passwords stay in the harness credential store; IMAP/SMTP can go through an HTTP CONNECT or SOCKS5 proxy with separate routes per direction.'
  zh: '给 DeepSeek Harness 装邮箱：在「设置 → 邮件」里登录一次后，agent 可用 8 个 email_* 工具读信、检索、回复、发信、等验证邮件、下载附件。读信用 IMAP PEEK，不会把邮件标记为已读；密码存在 harness 凭据库；IMAP/SMTP 可走 HTTP CONNECT 或 SOCKS5 代理，并支持收/发分别指定路由。'
tarball: https://github.com/kuanbandu/dsh-email/releases/latest/download/kuanbandu-dsh-email.tgz
YAML
}

log "=== 开始：把 $REPO 提交到 $REGISTRY（dry-run=$DRY_RUN）"

# 0) 前置条件
CREATED=$(gh api "repos/$REPO" --jq .created_at 2>/dev/null) || { log "读不到仓库信息，退出"; exit 1; }
AGE_HOURS=$(( ( $(date -u +%s) - $(date -u -d "$CREATED" +%s) ) / 3600 ))
log "仓库创建于 $CREATED（约 ${AGE_HOURS}h 前）"
if [ "$AGE_HOURS" -lt 24 ]; then
  WAIT=$(( (24 * 3600) - ( $(date -u +%s) - $(date -u -d "$CREATED" +%s) ) + 60 ))
  log "未满 24 小时，等待 ${WAIT}s 后再提（CI 会检查这一项）"
  [ "$DRY_RUN" -eq 1 ] && exit 0
  sleep "$WAIT"
fi

# 1) fork（已存在则忽略）
if [ "$DRY_RUN" -eq 0 ]; then
  gh repo fork "$REGISTRY" --clone=false >/dev/null 2>&1 || true
  log "fork 就绪：$FORK"
fi

# 2) 建分支（已存在则忽略）
BASE_SHA=$(gh api "repos/$REGISTRY/commits/main" --jq .sha 2>/dev/null) || { log "读不到上游 main"; exit 1; }
log "上游 main = $BASE_SHA"
if [ "$DRY_RUN" -eq 0 ]; then
  gh api -X POST "repos/$FORK/git/refs" \
    -f ref="refs/heads/$BRANCH" -f sha="$BASE_SHA" >/dev/null 2>&1 || true
fi

# 3) 放/更新条目文件
EXISTING_SHA=$(gh api "repos/$FORK/contents/$PATH_IN_REPO?ref=$BRANCH" --jq .sha 2>/dev/null || true)
CONTENT_B64=$(entry | base64 -w0)
if [ "$DRY_RUN" -eq 1 ]; then
  log "dry-run：将写入 $PATH_IN_REPO（${#CONTENT_B64} 字节 base64，existing=${EXISTING_SHA:-none}）"
  entry | head -3
  exit 0
fi
if [ -n "${EXISTING_SHA:-}" ]; then
  gh api -X PUT "repos/$FORK/contents/$PATH_IN_REPO" \
    -f message="feat(registry): update kuanbandu/dsh-email" \
    -f content="$CONTENT_B64" -f branch="$BRANCH" -f sha="$EXISTING_SHA" >/dev/null || { log "更新文件失败"; exit 1; }
  log "已更新 $PATH_IN_REPO"
else
  gh api -X PUT "repos/$FORK/contents/$PATH_IN_REPO" \
    -f message="feat(registry): add kuanbandu/dsh-email" \
    -f content="$CONTENT_B64" -f branch="$BRANCH" >/dev/null || { log "写入文件失败"; exit 1; }
  log "已写入 $PATH_IN_REPO"
fi

# 4) 开 PR（已存在则打印链接）
PR_URL=$(gh pr create -R "$REGISTRY" \
  --head "kuanbandu:$BRANCH" --base main \
  --title "feat(registry): add kuanbandu/dsh-email" \
  --body "Adds **kuanbandu/dsh-email** — IMAP/SMTP email tools for DeepSeek Harness.

- 8 \`email_*\` tools: accounts, mailboxes, search, read, send, reply, wait, attachment
- reads with \`BODY.PEEK\` so messages are never marked as seen
- passwords live in the harness credential store, never in tool results
- HTTP CONNECT / SOCKS5 proxy support with per-direction routes
- declared \`dsh.bundle\` manifest; prebuilt tarball attached to the release
- 29 protocol self-tests + 8 client render checks (\`npm test\`)" 2>&1 | tail -1)

if [ -n "$PR_URL" ]; then
  log "PR: $PR_URL"
else
  log "创建 PR 失败或已存在；当前打开的 PR："
  gh pr list -R "$REGISTRY" --head "kuanbandu:$BRANCH" --json url,state --jq '.[] | "\(.state) \(.url)"' | tee -a "$LOG"
fi
log "=== 完成"

#!/usr/bin/env bash
# 发一版：跑测试 → 升版本 → 打 tag → 推送（推送 tag 会触发 OIDC 自动发布到 npm）。
#
#   bash scripts/release.sh patch         # 0.1.1 -> 0.1.2
#   bash scripts/release.sh minor
#   bash scripts/release.sh 0.2.0         # 指定版本
#
# 前提：npm 包页面已配置 Trusted Publisher（见 PUBLISHING.md）。
# 不需要任何 npm token —— .github/workflows/publish.yml 用 OIDC 发布。
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="${1:-patch}"
echo "== 1/5 自检"
npm test

echo "== 2/5 升版本到 $TARGET"
npm version "$TARGET" -m "chore(release): %s" >/dev/null
VERSION=$(node -p "require('./package.json').version")
echo "   新版本：$VERSION"

echo "== 3/5 推送 main"
git push origin main

echo "== 4/5 推送 tag v$VERSION（触发 OIDC 发布）"
git push origin "v$VERSION"

echo "== 5/5 等 CI 发布结果"
sleep 20
gh run list --limit 3 --json name,status,conclusion,url \
  --jq '.[] | "\(.status)/\(.conclusion // "-")  \(.name)  \(.url)"'

cat <<EOF

完成。手动核对：
  npm view @kuanbandu/dsh-email version
  gh release create v$VERSION --title "dsh-email $VERSION" --notes "…"
EOF

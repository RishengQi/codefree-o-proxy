#!/usr/bin/env bash
# 启动 CodeFree-O OpenAI 兼容代理（Linux / macOS）
# 需要 Node >= 20（系统 node 较旧时可用 CODEFREE_NODE 指定绝对路径，例如
#   CODEFREE_NODE=/root/.nvm/versions/node/v22.22.3/bin/node ./start.sh）
set -euo pipefail
cd "$(dirname "$0")"
exec "${CODEFREE_NODE:-node}" server.mjs "$@"

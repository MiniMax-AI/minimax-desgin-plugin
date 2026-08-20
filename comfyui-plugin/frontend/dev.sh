#!/usr/bin/env bash
# 本地起 ComfyUI 全栈：Python 后端 (8188) + 前端 vite dev server。
# 前端离开后端无法工作（节点定义/模型列表/执行队列都在后端），所以两个都要起。
set -e

FRONTEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${COMFYUI_BACKEND_DIR:-/Users/minimax/Desktop/ComfyUI}"

if [ ! -x "$BACKEND_DIR/.venv/bin/python" ]; then
  echo "找不到后端 venv: $BACKEND_DIR/.venv"
  echo "先执行: cd $BACKEND_DIR && uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -r requirements.txt"
  exit 1
fi

# 前端 engines 要求 node >=25 <26
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use 25 >/dev/null

cleanup() { kill $BACKEND_PID 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "[1/2] 启动 ComfyUI 后端 (127.0.0.1:8188)…"
(cd "$BACKEND_DIR" && .venv/bin/python main.py --port 8188) &
BACKEND_PID=$!

# 后端首次启动要跑数据库迁移 + 加载 800+ 节点，约需 60s
echo "     等待后端就绪（首次启动约 60s）…"
for i in $(seq 1 60); do
  if curl -s -o /dev/null http://127.0.0.1:8188/system_stats; then
    echo "     后端就绪。"
    break
  fi
  sleep 2
done

echo "[2/2] 启动前端 dev server…"
cd "$FRONTEND_DIR"
pnpm dev

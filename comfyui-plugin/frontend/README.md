# ComfyUI Web（本地开发副本）

从 `~/Desktop/ComfyUI_frontend` 抽出的前端工程，可在本地独立运行。

## License and attribution

Please note that this independent module is derived from ComfyUI ([https://github.com/comfy-org/comfyui?tab=contributing-ov-file](https://github.com/comfy-org/comfyui?tab=contributing-ov-file)), which is licensed under GPL 3.0 License: [https://github.com/comfy-org/comfyui?tab=GPL-3.0-1-ov-file](https://github.com/comfy-org/comfyui?tab=GPL-3.0-1-ov-file). This module is correspondingly open-sourced under GPL 3.0 License.

## 快速开始

```bash
./dev.sh
```

脚本会先起 Python 后端（127.0.0.1:8188），等它就绪后再起前端 dev server。
浏览器打开终端里打印的地址（5173，被占用时自动顺延到 5174）。

手动分两步起也可以：

```bash
# 终端 1 —— 后端
cd /Users/minimax/Desktop/ComfyUI && .venv/bin/python main.py --port 8188

# 终端 2 —— 前端
nvm use 25 && pnpm dev
```

## 前端必须连后端

这不是可配置项。节点定义（`/api/object_info`）、模型列表、执行队列、进度 WebSocket
全部来自 Python 后端。后端没起时页面能打开，但节点面板是空的、无法运行工作流。

`vite.config.mts` 把 `/api`、`/ws` 等路径代理到 `DEV_SERVER_COMFYUI_URL`，
默认 `http://127.0.0.1:8188`。要连别的后端就设这个环境变量。

## 环境要求

- **Node 25**（`package.json` 的 `engines` 限定 `>=25 <26`），通过 `nvm use 25`
- pnpm 11（已用 `npm i -g pnpm@11.13.1` 装在 node 25 下；corepack 在本机 enable 失败）
- 后端 venv：Python 3.12，位于 `/Users/minimax/Desktop/ComfyUI/.venv`

## 与上游仓库的差异

复制时剔除了本地跑用不到的部分，以缩小体积、加快安装：

- `apps/`（desktop-ui、website）—— 同时从 `pnpm-workspace.yaml` 的 packages 列表移除
- `browser_tests/`（25MB）、`.storybook/`、`docs/`、`.github/`
- `package.json` 移除了指向 `apps/` 的脚本（`build:desktop`、`dev:desktop`、
  `typecheck:website` 等）和 `prepare`（husky git 钩子，此处非独立 git 仓库）
- 包名改为 `@plugin/comfyui`

`packages/` 下 7 个内部包（`@comfyorg/design-system` 等）全部保留——`src/` 直接依赖它们。

## 关于 hub 插件

本目录**没有**注册进 `plugin-src/pnpm-workspace.yaml`，也没有加进
`scripts/build-plugin.mjs` 的 `PLUGINS` 列表。它是个自带 workspace 的独立工程，
不参与 `pnpm build:all`。

原因：hub 插件的产物是纯静态 iframe 页面，而 ComfyUI 前端需要常驻 Python 后端，
无法作为静态插件发布。

## 首次运行的正常 404

控制台会有几条 404，都是"用户数据还不存在"，不是故障：

- `/api/userdata/user.css` —— 自定义样式，没建过
- `/api/userdata?dir=workflows` —— 还没保存过工作流
- `/api/userdata?dir=subgraphs`、`/api/userdata/comfy.templates.json` —— 同上

## 出图需要模型

后端已就位但 `/Users/minimax/Desktop/ComfyUI/models/` 里没有模型权重。
界面、节点、工作流编辑都能用，实际生成需要自行下载 checkpoint 放进
`models/checkpoints/`。

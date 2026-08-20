# ComfyUI 后端 fork 出处与改动记录

本目录是 Hub「统一下发」ComfyUI 后端的源码（vendor 自上游，不含 git 历史）。
打包下发流程见仓库根 `scripts/release-comfyui-backend.py`。

## License and attribution

Please note that this independent module is derived from ComfyUI ([https://github.com/comfy-org/comfyui?tab=contributing-ov-file](https://github.com/comfy-org/comfyui?tab=contributing-ov-file)), which is licensed under GPL 3.0 License: [https://github.com/comfy-org/comfyui?tab=GPL-3.0-1-ov-file](https://github.com/comfy-org/comfyui?tab=GPL-3.0-1-ov-file). This module is correspondingly open-sourced under GPL 3.0 License.

## 上游出处

- 上游仓库：https://github.com/comfyanonymous/ComfyUI
- 基线提交：`6f7cd7fc`（Bump comfyui-frontend-package to 1.48.6, #15301）
- 基线版本：v0.30.0（`comfyui_version.py`）
- vendor 时间：2026-02（自 `~/Desktop/ComfyUI` 工作树复制）

## 与上游的差异（改一处记一处）

| 文件 | 改动 | 原因 |
|---|---|---|
| `server.py` | CORS `Access-Control-Allow-Headers` 增加 `Comfy-User` | 插件前端跑在 gateway origin（iframe 跨源），ComfyUI 前端所有请求都带 `Comfy-User` 头，原版 CORS 白名单没有它会被预检拦下 |

## 不入库的内容

`.git` `.venv` `models/` `output/` `input/` `temp/` `user/` `__pycache__`
（运行数据由客户端 `--base-directory` 指到 plugin-data 的 `userdata/`，与源码无关；
本目录内如需直接跑后端调试，产生的这些目录已被仓库 .gitignore 覆盖。）

## 同步上游更新的方法

1. 另取一份上游 checkout，checkout 到目标 tag/commit；
2. 用 `git diff` 核对上表中的本地改动，逐个重放到新代码上；
3. 覆盖式 rsync 回本目录（沿用上面的排除清单），更新本文件的基线提交/版本；
4. 跑 `scripts/release-comfyui-backend.py` 发新 bundle（记得 bump 版本）。

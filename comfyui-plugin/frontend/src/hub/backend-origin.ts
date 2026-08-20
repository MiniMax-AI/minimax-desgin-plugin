/**
 * Hub 插件模式下的后端 origin 解析。
 *
 * 独立运行时（`pnpm dev` / 直接开 8188）前端与 ComfyUI 后端同源，
 * `api.ts` 用 `location.host` 推导即可。但作为 Hub 画布插件运行时，
 * iframe 的 origin 是 gateway（`*.hilo.localhost`），后端在另一个端口
 * （默认 127.0.0.1:8188），必须显式指向。
 *
 * 值由 `index.html` 里的 bootstrap 内联脚本在 SPA 模块加载前写入
 * `window.__COMFY_BACKEND_ORIGIN__` —— 必须早于 `api.ts` 的
 * `export const api = new ComfyApi()`，因为 origin 在构造函数里就固化了。
 *
 * 只认端口、不认路径：谁在本地起了 ComfyUI 都能连上，与它装在哪个
 * 目录无关。目录只在「插件代启动后端」时才需要，那是另一条路径
 * （plugin-config 里的可选配置）。
 */

/** 全局键名 —— bootstrap 脚本与本模块的唯一约定。 */
export const BACKEND_ORIGIN_GLOBAL = '__COMFY_BACKEND_ORIGIN__'

/**
 * 返回归一化后的后端 origin（形如 `http://127.0.0.1:8188`，无尾斜杠），
 * 未配置或非法时返回 `null`，调用方回退到同源推导。
 *
 * 只接受 http/https；拒绝其它协议以免把 `javascript:` 之类的值
 * 拼进请求 URL。
 */
export function hubBackendOrigin(): string | null {
  const raw = (globalThis as Record<string, unknown>)[BACKEND_ORIGIN_GLOBAL]
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

const DEFAULT_FIT_VIEW_ZOOM = 0.75
const HUB_EMBEDDED_FIT_VIEW_ZOOM = 0.85

interface HubEmbeddedWindow extends Window {
  __COMFY_HUB_EMBEDDED__?: boolean
}

export function isHubEmbedded(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window as HubEmbeddedWindow).__COMFY_HUB_EMBEDDED__ === true
  )
}

export function resolveCanvasInfoVisibility(settingValue: boolean): boolean {
  return !isHubEmbedded() && settingValue
}

export function resolveFitViewZoom(): number {
  return isHubEmbedded() ? HUB_EMBEDDED_FIT_VIEW_ZOOM : DEFAULT_FIT_VIEW_ZOOM
}

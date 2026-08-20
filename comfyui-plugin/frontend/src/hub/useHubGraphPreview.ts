import { onMounted, onUnmounted, readonly, ref } from 'vue'

interface HubFullscreenChangedPayload {
  kind: 'hub:event'
  topic: 'fullscreen:changed'
  payload: {
    fullscreen: boolean
  }
}

interface HubFullscreenUi {
  isFullscreen?: () => boolean
  onFullscreenChange?: (callback: (fullscreen: boolean) => void) => () => void
}

interface HubFullscreenApi {
  ready?: Promise<unknown>
  ui?: HubFullscreenUi
}

const HUB_BRIDGE_WAIT_INTERVAL_MS = 50
const HUB_BRIDGE_WAIT_TIMEOUT_MS = 10_000

export function scheduleAfterCanvasLayout(callback: () => void): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(callback)
  })
}

export function resolveHubGraphPreview(
  isEmbedded: boolean,
  fullscreen: boolean
): boolean {
  return isEmbedded && !fullscreen
}

export function getHubFullscreenPreviewState(
  message: unknown
): boolean | undefined {
  if (!message || typeof message !== 'object') return
  const frame = message as Partial<HubFullscreenChangedPayload>
  if (frame.kind !== 'hub:event' || frame.topic !== 'fullscreen:changed') return
  const fullscreen = frame.payload?.fullscreen
  return typeof fullscreen === 'boolean' ? fullscreen : undefined
}

/**
 * The embedded node is a graph-only preview. Hub keeps the same iframe alive
 * while entering fullscreen, so switching this flag never reloads a workflow
 * or interrupts an in-progress execution.
 */
export function useHubGraphPreview() {
  const isHubGraphPreview = ref(false)
  const isEmbedded = window.parent !== window
  let mounted = false
  let dispose: (() => void) | undefined

  const update = (fullscreen: boolean) => {
    isHubGraphPreview.value = resolveHubGraphPreview(isEmbedded, fullscreen)
  }

  const waitForHubFullscreenApi = async () => {
    const deadline = Date.now() + HUB_BRIDGE_WAIT_TIMEOUT_MS
    let hub = window.hub as HubFullscreenApi | undefined
    while (mounted && !hub?.ui?.onFullscreenChange && Date.now() < deadline) {
      await new Promise((resolve) =>
        window.setTimeout(resolve, HUB_BRIDGE_WAIT_INTERVAL_MS)
      )
      hub = window.hub as HubFullscreenApi | undefined
    }
    return hub?.ui?.onFullscreenChange ? hub : undefined
  }

  const handleHubMessage = (event: MessageEvent) => {
    if (event.source !== window.parent) return
    const fullscreen = getHubFullscreenPreviewState(event.data)
    if (fullscreen !== undefined) update(fullscreen)
  }

  onMounted(async () => {
    if (!isEmbedded) return
    mounted = true
    window.addEventListener('message', handleHubMessage)

    const hub = await waitForHubFullscreenApi()
    if (!hub || !mounted) return
    try {
      await hub.ready
    } catch {
      return
    }
    if (!mounted) return

    update(hub.ui?.isFullscreen?.() ?? false)
    dispose = hub.ui?.onFullscreenChange?.(update)
  })

  onUnmounted(() => {
    mounted = false
    window.removeEventListener('message', handleHubMessage)
    dispose?.()
    dispose = undefined
  })

  return { isHubGraphPreview: readonly(isHubGraphPreview) }
}

interface HubCanvasApi {
  getCurrentNodeId(): string
}

interface HubApi {
  ready?: Promise<unknown>
  canvas?: HubCanvasApi
}

/**
 * Hand off an accepted ComfyUI prompt to the workspace Gateway.
 *
 * The iframe may disappear as soon as fullscreen closes, so it must not own
 * output delivery. The Gateway persists this receipt and continues tracking
 * every prompt independently of the plugin's lifetime.
 */
export async function registerComfyRunWithHub(promptId: string): Promise<void> {
  const hub = window.hub as unknown as HubApi | undefined
  if (!hub?.canvas) return
  await hub.ready
  const sourceNodeId = hub.canvas.getCurrentNodeId()
  if (!sourceNodeId) return

  const response = await fetch('/api/comfyui/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt_id: promptId, source_node_id: sourceNodeId })
  })
  if (!response.ok) {
    throw new Error(
      `Failed to register ComfyUI prompt with Hub (HTTP ${response.status})`
    )
  }
}

import { updateWorkflowDraftIdentity } from '@/hub/workflow-draft'
import type { ComfyWorkflow } from '@/platform/workflow/management/stores/comfyWorkflow'
import type {
  ComfyApiWorkflow,
  ComfyWorkflowJSON
} from '@/platform/workflow/validation/schemas/workflowSchema'

interface HubWorkflowCanvasApi {
  getCurrentNodeId(): string
  updateNodeData(nodeId: string, patch: Record<string, unknown>): Promise<void>
}

interface HubWorkflowApi {
  ready?: Promise<unknown>
  canvas?: HubWorkflowCanvasApi
}

interface ExecutableWorkflowSnapshot {
  output: ComfyApiWorkflow
  workflow: ComfyWorkflowJSON
}

export function encodeUserWorkflowId(workflowKey: string): string {
  const bytes = new TextEncoder().encode(workflowKey)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `user:${encoded}`
}

/** Persist the saved ComfyUI identity back onto the launcher canvas node. */
export async function syncSavedWorkflowToCanvas(
  workflow: ComfyWorkflow,
  options: { syncCanvasIdentity?: boolean } = {}
): Promise<void> {
  const hub = window.hub as unknown as HubWorkflowApi | undefined
  if (!hub?.canvas) return
  await hub.ready
  const nodeId = hub.canvas.getCurrentNodeId()
  if (!nodeId) return
  const workflowId = encodeUserWorkflowId(workflow.key)
  const identity = window as unknown as {
    __COMFY_HUB_WORKFLOW_ID__?: string
    __COMFY_HUB_WORKFLOW_NAME__?: string
    __COMFY_HUB_WORKFLOW_SOURCE__?: string
  }
  const previousWorkflowId = identity.__COMFY_HUB_WORKFLOW_ID__
  const previousWorkflowName = identity.__COMFY_HUB_WORKFLOW_NAME__
  const previousWorkflowSource = identity.__COMFY_HUB_WORKFLOW_SOURCE__
  const syncCanvasIdentity = options.syncCanvasIdentity !== false

  if (syncCanvasIdentity) {
    await hub.canvas.updateNodeData(nodeId, {
      currentWorkflowId: workflowId,
      currentWorkflowName: workflow.filename,
      comfyuiWorkflowDirty: false
    })
  }
  identity.__COMFY_HUB_WORKFLOW_ID__ = workflowId
  identity.__COMFY_HUB_WORKFLOW_NAME__ = workflow.filename
  identity.__COMFY_HUB_WORKFLOW_SOURCE__ = 'user'

  try {
    await updateWorkflowDraftIdentity(workflowId, workflow.filename, {
      dirty: false
    })
  } catch (error) {
    identity.__COMFY_HUB_WORKFLOW_ID__ = previousWorkflowId
    identity.__COMFY_HUB_WORKFLOW_NAME__ = previousWorkflowName
    identity.__COMFY_HUB_WORKFLOW_SOURCE__ = previousWorkflowSource
    if (syncCanvasIdentity && previousWorkflowId) {
      await hub.canvas
        .updateNodeData(nodeId, {
          currentWorkflowId: previousWorkflowId,
          currentWorkflowName: previousWorkflowName
        })
        .catch((rollbackError: unknown) => {
          console.error(
            '[ComfyUI] Failed to roll back canvas workflow identity',
            rollbackError
          )
        })
    }
    throw error
  }
  window.dispatchEvent(new CustomEvent('hub-comfyui:workflow-saved'))
}

/** Persist graphToPrompt() output so Hub Agent can execute without an iframe. */
export async function syncExecutableWorkflowToHub(
  workflow: ComfyWorkflow,
  snapshot: ExecutableWorkflowSnapshot
): Promise<void> {
  const hub = window.hub as unknown as HubWorkflowApi | undefined
  if (!hub) return
  await hub.ready
  const workflowId = encodeUserWorkflowId(workflow.key)
  const response = await fetch(
    `/api/comfyui/workflows/${encodeURIComponent(workflowId)}/executable`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(snapshot)
    }
  )
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1000)
    throw new Error(
      `Failed to save executable workflow snapshot (HTTP ${response.status}): ${detail}`
    )
  }
}

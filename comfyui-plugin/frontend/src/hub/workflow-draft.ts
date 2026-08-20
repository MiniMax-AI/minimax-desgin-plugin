import { recordHubComfyDiagnostic } from '@/hub/hub-diagnostics'
import type { ComfyWorkflowJSON } from '@/platform/workflow/validation/schemas/workflowSchema'

export const COMFYUI_WORKFLOW_DRAFT_KEY = 'comfyui.workflow-draft.v1'

export interface ComfyUiWorkflowDraft {
  version: 1
  workflowId: string
  workflowName: string
  graph: ComfyWorkflowJSON
  baseSourceSha256?: string
  dirty?: boolean
  updatedAt: number
}

interface SaveWorkflowDraftOptions {
  baseSourceSha256?: string
  dirty?: boolean
}

interface HubStorageLike {
  ready?: Promise<unknown>
  canvas?: {
    getCurrentNodeId(): string
  }
  storage?: {
    get<T = unknown>(key: string): Promise<T | undefined>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
}

function getHub(): HubStorageLike | undefined {
  return window.hub as unknown as HubStorageLike | undefined
}

async function storage() {
  const hub = getHub()
  if (!hub?.storage) return undefined
  await hub.ready
  return hub.storage
}

export async function getWorkflowDraft(): Promise<
  ComfyUiWorkflowDraft | undefined
> {
  try {
    const nodeId = getHub()?.canvas?.getCurrentNodeId()
    const value = await (
      await storage()
    )?.get<ComfyUiWorkflowDraft>(COMFYUI_WORKFLOW_DRAFT_KEY)
    if (!value || value.version !== 1 || typeof value.workflowId !== 'string') {
      recordHubComfyDiagnostic('draft:read', { found: false, nodeId })
      return undefined
    }
    if (
      !value.graph ||
      !Array.isArray(value.graph.nodes) ||
      !Array.isArray(value.graph.links)
    ) {
      recordHubComfyDiagnostic('draft:read', {
        found: false,
        nodeId,
        workflowId: value.workflowId,
        workflowName: value.workflowName
      })
      return undefined
    }
    recordHubComfyDiagnostic('draft:read', {
      found: true,
      nodeId,
      workflowId: value.workflowId,
      workflowName: value.workflowName,
      nodeCount: value.graph.nodes.length,
      dirty: value.dirty !== false
    })
    return value
  } catch (error) {
    recordHubComfyDiagnostic('draft:read:error', {
      message: error instanceof Error ? error.message : String(error)
    })
    console.warn('[hub-comfyui] failed to read workflow draft', error)
    return undefined
  }
}

export async function saveWorkflowDraft(
  graph: ComfyWorkflowJSON,
  workflowId: string,
  workflowName: string,
  options: SaveWorkflowDraftOptions = {}
): Promise<void> {
  try {
    const nodeId = getHub()?.canvas?.getCurrentNodeId()
    const draftStorage = await storage()
    if (!draftStorage) {
      throw new Error('Hub workflow Draft storage is unavailable')
    }
    const current = await getWorkflowDraft()
    const preservedBaseSourceSha256 =
      current?.workflowId === workflowId ? current.baseSourceSha256 : undefined
    recordHubComfyDiagnostic('draft:write', {
      nodeId,
      workflowId,
      workflowName,
      nodeCount: graph.nodes.length,
      dirty: options.dirty ?? true
    })
    await draftStorage.set(COMFYUI_WORKFLOW_DRAFT_KEY, {
      version: 1,
      workflowId,
      workflowName,
      graph,
      ...((options.baseSourceSha256 ?? preservedBaseSourceSha256)
        ? {
            baseSourceSha256:
              options.baseSourceSha256 ?? preservedBaseSourceSha256
          }
        : {}),
      dirty: options.dirty ?? true,
      updatedAt: Date.now()
    } satisfies ComfyUiWorkflowDraft)
  } catch (error) {
    recordHubComfyDiagnostic('draft:write:error', {
      workflowId,
      message: error instanceof Error ? error.message : String(error)
    })
    console.warn('[hub-comfyui] failed to save workflow draft', error)
    throw error
  }
}

export async function updateWorkflowDraftIdentity(
  workflowId: string,
  workflowName: string,
  options: SaveWorkflowDraftOptions = {}
): Promise<void> {
  const draft = await getWorkflowDraft()
  if (!draft) return
  await saveWorkflowDraft(draft.graph, workflowId, workflowName, {
    baseSourceSha256: options.baseSourceSha256 ?? draft.baseSourceSha256,
    dirty: options.dirty ?? draft.dirty
  })
}

export async function clearWorkflowDraft(): Promise<void> {
  try {
    recordHubComfyDiagnostic('draft:clear', {})
    await (await storage())?.delete(COMFYUI_WORKFLOW_DRAFT_KEY)
  } catch (error) {
    console.warn('[hub-comfyui] failed to clear workflow draft', error)
  }
}

let flushHandler: (() => Promise<void>) | undefined
let clearHandler: (() => Promise<void>) | undefined

export function registerWorkflowDraftHandlers(
  flush: () => Promise<void>,
  clear: () => Promise<void>
): void {
  flushHandler = flush
  clearHandler = clear
}

export async function flushWorkflowDraft(): Promise<void> {
  await flushHandler?.()
}

export async function clearRegisteredWorkflowDraft(): Promise<void> {
  await clearHandler?.()
  await clearWorkflowDraft()
  window.dispatchEvent(new CustomEvent('hub-comfyui:workflow-discarded'))
}

import { onMounted, onUnmounted } from 'vue'

import { recordHubComfyDiagnostic } from '@/hub/hub-diagnostics'
import {
  registerWorkflowDraftHandlers,
  saveWorkflowDraft
} from '@/hub/workflow-draft'
import type { ComfyWorkflowJSON } from '@/platform/workflow/validation/schemas/workflowSchema'
import { api } from '@/scripts/api'
import { app as comfyApp } from '@/scripts/app'

const DEBOUNCE_MS = 500
const EXTERNAL_DRAFT_EVENT = 'hub-comfyui:external-draft'

interface HubWorkflowCanvasApi {
  getCurrentNodeId(): string
  updateNodeData(nodeId: string, patch: Record<string, unknown>): Promise<void>
}

interface HubWorkflowApi {
  canvas?: HubWorkflowCanvasApi
}

function getHub(): HubWorkflowApi | undefined {
  return window.hub as unknown as HubWorkflowApi | undefined
}

function isDraftPersistenceReady(): boolean {
  return (
    (window as unknown as { __COMFY_HUB_DRAFT_READY__?: boolean })
      .__COMFY_HUB_DRAFT_READY__ === true
  )
}

function restoredDraftIsDirty(): boolean {
  return (
    (window as unknown as { __COMFY_HUB_WORKFLOW_DRAFT_DIRTY__?: boolean })
      .__COMFY_HUB_WORKFLOW_DRAFT_DIRTY__ === true
  )
}

function workflowIdentity(): { id: string; name: string } | undefined {
  const globalId = (window as unknown as { __COMFY_HUB_WORKFLOW_ID__?: string })
    .__COMFY_HUB_WORKFLOW_ID__
  const globalName = (
    window as unknown as { __COMFY_HUB_WORKFLOW_NAME__?: string }
  ).__COMFY_HUB_WORKFLOW_NAME__
  if (globalId) return { id: globalId, name: globalName || globalId }
  const params = new URLSearchParams(window.location.search)
  const id = (
    params.get('hubWorkflowId') ||
    params.get('hubWorkflow') ||
    ''
  ).trim()
  if (!id) return undefined
  return { id, name: params.get('hubWorkflow') || id }
}

function hasGraphContent(graph: ComfyWorkflowJSON | undefined): boolean {
  return Array.isArray(graph?.nodes) && graph.nodes.length > 0
}

export function useHubWorkflowDraftPersistence(): void {
  let timer: number | undefined
  let ready = isDraftPersistenceReady()
  let lastHasWorkflowContent: boolean | undefined
  let lastDirty: boolean | undefined
  let dirty = restoredDraftIsDirty()

  const syncWorkflowContent = async (graph: ComfyWorkflowJSON | undefined) => {
    const hasWorkflowContent = hasGraphContent(graph)
    if (lastHasWorkflowContent === hasWorkflowContent) return
    const canvas = getHub()?.canvas
    const nodeId = canvas?.getCurrentNodeId()
    if (!canvas || !nodeId) return
    await canvas.updateNodeData(nodeId, { hasWorkflowContent })
    lastHasWorkflowContent = hasWorkflowContent
  }

  const syncWorkflowDirty = async (nextDirty: boolean) => {
    if (lastDirty === nextDirty) return
    const canvas = getHub()?.canvas
    const nodeId = canvas?.getCurrentNodeId()
    if (!canvas || !nodeId) return
    await canvas.updateNodeData(nodeId, { comfyuiWorkflowDirty: nextDirty })
    lastDirty = nextDirty
  }

  const handleWorkflowReady = () => {
    ready = true
    dirty = restoredDraftIsDirty()
    recordHubComfyDiagnostic('draft:ready', {
      ...workflowIdentity(),
      restoredDirty: dirty,
      nodeCount: comfyApp.rootGraph?.nodes?.length ?? 0
    })
    void syncWorkflowContent(
      comfyApp.rootGraph?.serialize?.() as ComfyWorkflowJSON | undefined
    )
    void syncWorkflowDirty(dirty)
  }

  const handleWorkflowSaved = () => {
    dirty = false
    void syncWorkflowDirty(false)
  }

  const handleExternalDraft = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
    ready = false
  }

  const flush = async () => {
    if (!ready || !isDraftPersistenceReady()) return
    if (!comfyApp.rootGraph?.serialize) return
    const identity = workflowIdentity()
    if (!identity) return
    recordHubComfyDiagnostic('draft:flush', {
      ...identity,
      nodeCount: comfyApp.rootGraph._nodes?.length ?? 0,
      dirty
    })
    await saveWorkflowDraft(
      comfyApp.rootGraph.serialize() as unknown as ComfyWorkflowJSON,
      identity.id,
      identity.name,
      { dirty }
    )
  }

  const schedule = (event: Event) => {
    if (!ready || !isDraftPersistenceReady()) return
    const graph = (event as CustomEvent<ComfyWorkflowJSON>).detail
    recordHubComfyDiagnostic('graph:changed', {
      ...workflowIdentity(),
      nodeCount: graph.nodes?.length ?? 0,
      ready
    })
    void syncWorkflowContent(graph)
    dirty = true
    void syncWorkflowDirty(true)
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = undefined
      void flush().catch((error) => {
        console.error('[hub-comfyui] failed to autosave workflow Draft', error)
      })
    }, DEBOUNCE_MS)
  }

  onMounted(() => {
    ready = isDraftPersistenceReady()
    api.addEventListener('graphChanged', schedule)
    window.addEventListener('hub-comfyui:workflow-ready', handleWorkflowReady)
    window.addEventListener('hub-comfyui:workflow-saved', handleWorkflowSaved)
    window.addEventListener(
      'hub-comfyui:workflow-discarded',
      handleWorkflowSaved
    )
    window.addEventListener(EXTERNAL_DRAFT_EVENT, handleExternalDraft)
    registerWorkflowDraftHandlers(flush, async () => {
      if (timer !== undefined) window.clearTimeout(timer)
      timer = undefined
    })
  })

  onUnmounted(() => {
    recordHubComfyDiagnostic('draft:unmounted', {
      ...workflowIdentity(),
      ready,
      dirty,
      pendingDebounce: timer !== undefined,
      nodeCount: comfyApp.rootGraph?._nodes?.length ?? 0
    })
    api.removeEventListener('graphChanged', schedule)
    window.removeEventListener(
      'hub-comfyui:workflow-ready',
      handleWorkflowReady
    )
    window.removeEventListener(
      'hub-comfyui:workflow-saved',
      handleWorkflowSaved
    )
    window.removeEventListener(
      'hub-comfyui:workflow-discarded',
      handleWorkflowSaved
    )
    window.removeEventListener(EXTERNAL_DRAFT_EVENT, handleExternalDraft)
    if (timer !== undefined) window.clearTimeout(timer)
    timer = undefined
    recordHubComfyDiagnostic('draft:flush-on-unmount', {
      ...workflowIdentity(),
      dirty
    })
    void flush().catch((error) => {
      console.error('[hub-comfyui] failed to flush workflow Draft', error)
    })
    ready = false
  })
}

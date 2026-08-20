import { readonly, shallowRef } from 'vue'

import { t } from '@/i18n'
import { useToastStore } from '@/platform/updates/common/toastStore'
import { api } from '@/scripts/api'

export type IncomingResourceType = 'image' | 'video' | 'audio' | 'text' | 'file'

export interface IncomingResource {
  nodeId: string
  assetId: string
  type: IncomingResourceType
  name: string
  url: string
  path: string
  width?: number
  height?: number
  durationSec?: number
  fileSize?: number
  metadata?: Record<string, unknown>
}

interface UploadResponse {
  name: string
  subfolder?: string
}

const resources = shallowRef<IncomingResource[]>([])
const isLoading = shallowRef(false)
const error = shallowRef<Error | null>(null)
const importedPaths = new Map<string, string>()

const workspaceResources = shallowRef<IncomingResource[]>([])
const isWorkspaceLoading = shallowRef(false)
const workspaceError = shallowRef<Error | null>(null)

let incomingDisposer: (() => void) | null = null
let syncGeneration = 0

interface RefreshRun {
  generation: number
  promise: Promise<void>
}

let refreshRun: RefreshRun | null = null
let workspaceSyncGeneration = 0
let workspaceRefreshRun: RefreshRun | null = null

function isUploadResponse(value: unknown): value is UploadResponse {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.name === 'string' && candidate.name.length > 0
}

function getSafeFilename(resource: IncomingResource): string {
  const name = resource.name.trim().split(/[\\/]/).pop() ?? ''
  return name || `hub-upstream-${resource.assetId}`
}

async function refreshIncomingResources(): Promise<void> {
  const generation = syncGeneration
  if (refreshRun?.generation === generation) return refreshRun.promise

  const promise = (async () => {
    const hub = window.hub
    if (!hub?.canvas?.getIncomingResources) {
      if (generation === syncGeneration) resources.value = []
      return
    }

    isLoading.value = true
    error.value = null
    try {
      await hub.ready
      const next = await hub.canvas.getIncomingResources()
      if (generation !== syncGeneration) return
      resources.value = Array.isArray(next) ? next : []
    } catch (cause) {
      if (generation !== syncGeneration) return
      const nextError =
        cause instanceof Error ? cause : new Error(String(cause))
      error.value = nextError
      console.warn('[ComfyUI] Failed to load incoming resources', nextError)
    } finally {
      if (generation === syncGeneration) isLoading.value = false
    }
  })()
  refreshRun = { generation, promise }

  try {
    await promise
  } finally {
    if (refreshRun?.promise === promise) refreshRun = null
  }
}

export function startIncomingResourceSync(): Promise<void> {
  return (async () => {
    const hub = window.hub
    if (!hub?.canvas) return
    await hub.ready
    if (!incomingDisposer && hub.canvas.onIncomingChange) {
      incomingDisposer = hub.canvas.onIncomingChange(() => {
        void refreshIncomingResources()
      })
    }
    await refreshIncomingResources()
  })()
}

export function stopIncomingResourceSync(): void {
  syncGeneration += 1
  incomingDisposer?.()
  incomingDisposer = null
  resources.value = []
  isLoading.value = false
  error.value = null
}

export function useIncomingResources() {
  return {
    resources: readonly(resources),
    isLoading: readonly(isLoading),
    error: readonly(error)
  }
}

async function refreshWorkspaceResources(): Promise<void> {
  const generation = workspaceSyncGeneration
  if (workspaceRefreshRun?.generation === generation) {
    return workspaceRefreshRun.promise
  }

  const promise = (async () => {
    const hub = window.hub
    if (!hub?.canvas?.getWorkspaceResources) {
      if (generation === workspaceSyncGeneration) workspaceResources.value = []
      return
    }

    isWorkspaceLoading.value = true
    workspaceError.value = null
    try {
      await hub.ready
      const next = await hub.canvas.getWorkspaceResources({
        type: ['image', 'video']
      })
      if (generation !== workspaceSyncGeneration) return
      workspaceResources.value = Array.isArray(next) ? next : []
    } catch (cause) {
      if (generation !== workspaceSyncGeneration) return
      const nextError =
        cause instanceof Error ? cause : new Error(String(cause))
      workspaceError.value = nextError
      console.warn('[ComfyUI] Failed to load workspace resources', nextError)
    } finally {
      if (generation === workspaceSyncGeneration)
        isWorkspaceLoading.value = false
    }
  })()
  workspaceRefreshRun = { generation, promise }

  try {
    await promise
  } finally {
    if (workspaceRefreshRun?.promise === promise) workspaceRefreshRun = null
  }
}

/** Refreshes the current workspace's Design-canvas media on demand. */
export function startWorkspaceResourceSync(): Promise<void> {
  return refreshWorkspaceResources()
}

export function stopWorkspaceResourceSync(): void {
  workspaceSyncGeneration += 1
  workspaceResources.value = []
  isWorkspaceLoading.value = false
  workspaceError.value = null
}

export function useWorkspaceResources() {
  return {
    resources: readonly(workspaceResources),
    isLoading: readonly(isWorkspaceLoading),
    error: readonly(workspaceError)
  }
}

export function getIncomingResource(
  resourceId: string
): IncomingResource | undefined {
  return resources.value.find(
    (resource) => `${resource.nodeId}:${resource.assetId}` === resourceId
  )
}

/** Finds a Design-canvas resource by the media asset ID used in the sidebar. */
export function getWorkspaceResource(
  resourceId: string
): IncomingResource | undefined {
  return workspaceResources.value.find(
    (resource) => `${resource.nodeId}:${resource.assetId}` === resourceId
  )
}

export async function importIncomingResource(
  resource: IncomingResource
): Promise<string> {
  const cacheKey = `${resource.nodeId}:${resource.assetId}`
  const cachedPath = importedPaths.get(cacheKey)
  if (cachedPath) return cachedPath

  const response = await fetch(resource.url)
  if (!response.ok) {
    throw new Error(`Failed to download ${resource.name}: ${response.status}`)
  }

  const blob = await response.blob()
  const file = new File([blob], getSafeFilename(resource), {
    type: blob.type || 'application/octet-stream'
  })
  const body = new FormData()
  body.append('image', file)
  body.append('subfolder', 'hub-upstream')
  body.append('type', 'input')

  const uploadResponse = await api.fetchApi('/upload/image', {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(120_000)
  })

  if (uploadResponse.status !== 200) {
    throw new Error(
      `Failed to upload ${resource.name}: ${uploadResponse.status} ${uploadResponse.statusText}`
    )
  }

  const payload: unknown = await uploadResponse.json()
  if (!isUploadResponse(payload)) {
    throw new Error('ComfyUI returned an invalid upload response')
  }

  const path = payload.subfolder
    ? `${payload.subfolder}/${payload.name}`
    : payload.name
  importedPaths.set(cacheKey, path)
  return path
}

export async function importIncomingResourceWithToast(
  resource: IncomingResource
): Promise<string | null> {
  try {
    return await importIncomingResource(resource)
  } catch (cause) {
    console.error('[ComfyUI] Failed to import incoming resource', cause)
    useToastStore().addAlert(t('toastMessages.fileUploadFailed'))
    return null
  }
}

/** Workspace resources use the same Comfy input importer as upstream ones. */
export async function importWorkspaceResourceWithToast(
  resource: IncomingResource
): Promise<string | null> {
  return importIncomingResourceWithToast(resource)
}

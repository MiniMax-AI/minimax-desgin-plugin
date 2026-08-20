import { onMounted, onUnmounted } from 'vue'

import { getMediaTypeFromFilename } from '@comfyorg/shared-frontend-utils/formatUtil'

import { t } from '@/i18n'
import { useToastStore } from '@/platform/updates/common/toastStore'
import type { ExecutedWsMessage, ResultItem } from '@/schemas/apiSchema'
import { api } from '@/scripts/api'
import { useExecutionStore } from '@/stores/executionStore'

type OutputKind = 'image' | 'video' | 'audio' | 'file'

interface HubCanvasOutputApi {
  getCurrentNodeId(): string
  insertImageNode(args: HubCanvasOutputNodeArgs): Promise<unknown>
  insertVideoNode(args: HubCanvasOutputNodeArgs): Promise<unknown>
  insertAudioNode(args: HubCanvasOutputNodeArgs): Promise<unknown>
  insertFileNode(args: HubCanvasOutputNodeArgs): Promise<unknown>
}

interface HubCanvasOutputNodeArgs {
  source: File
  name: string
  sourceNodeId: string
}

interface HubOutputPublisherApi {
  ready?: Promise<unknown>
  canvas?: Partial<HubCanvasOutputApi>
}

interface OutputFile {
  item: ResultItem
  kind: OutputKind
}

export interface HubCanvasOutputPublisherDependencies {
  getHub(): HubOutputPublisherApi | undefined
  getActiveJobId(): string | null
  getOutputUrl(item: ResultItem): string
  fetchOutput(url: string): Promise<Response>
  onError(error: unknown): void
}

function outputKind(filename: string): OutputKind {
  switch (getMediaTypeFromFilename(filename)) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'audio':
      return 'audio'
    default:
      return 'file'
  }
}

function collectOutputFiles(output: ExecutedWsMessage['output']): OutputFile[] {
  const items = [
    ...(output.images ?? []),
    ...(output.video ?? []),
    ...(output.audio ?? [])
  ]

  return items.flatMap((item) => {
    if (item.type !== 'output' || !item.filename) return []
    return [{ item, kind: outputKind(item.filename) }]
  })
}

function outputKey(promptId: string, nodeId: string, item: ResultItem): string {
  return [
    promptId,
    nodeId,
    item.type,
    item.subfolder ?? '',
    item.filename
  ].join(':')
}

function isHubCanvasOutputApi(
  canvas: HubOutputPublisherApi['canvas']
): canvas is HubCanvasOutputApi {
  return Boolean(
    canvas?.getCurrentNodeId &&
    canvas.insertImageNode &&
    canvas.insertVideoNode &&
    canvas.insertAudioNode &&
    canvas.insertFileNode
  )
}

async function insertOutput(
  canvas: HubCanvasOutputApi,
  sourceNodeId: string,
  output: OutputFile,
  fetchOutput: (url: string) => Promise<Response>,
  getOutputUrl: (item: ResultItem) => string
): Promise<void> {
  const filename = output.item.filename
  if (!filename) return

  const response = await fetchOutput(getOutputUrl(output.item))
  if (!response.ok) {
    throw new Error(`Failed to download ComfyUI output: ${response.status}`)
  }

  const blob = await response.blob()
  const file = new File([blob], filename, {
    type: blob.type || 'application/octet-stream'
  })
  const args = { source: file, name: filename, sourceNodeId }

  switch (output.kind) {
    case 'image':
      await canvas.insertImageNode(args)
      return
    case 'video':
      await canvas.insertVideoNode(args)
      return
    case 'audio':
      await canvas.insertAudioNode(args)
      return
    case 'file':
      await canvas.insertFileNode(args)
  }
}

export function createHubCanvasOutputPublisher({
  getHub,
  getActiveJobId,
  getOutputUrl,
  fetchOutput,
  onError
}: HubCanvasOutputPublisherDependencies) {
  const publishedKeys = new Set<string>()

  const publish = async (event: ExecutedWsMessage): Promise<void> => {
    if (event.prompt_id !== getActiveJobId()) return

    const hub = getHub()
    if (!hub || !isHubCanvasOutputApi(hub.canvas)) return
    await hub.ready

    const sourceNodeId = hub.canvas.getCurrentNodeId()
    if (!sourceNodeId) return

    for (const output of collectOutputFiles(event.output)) {
      const key = outputKey(event.prompt_id, String(event.node), output.item)
      if (publishedKeys.has(key)) continue
      publishedKeys.add(key)

      try {
        await insertOutput(
          hub.canvas,
          sourceNodeId,
          output,
          fetchOutput,
          getOutputUrl
        )
      } catch (error) {
        publishedKeys.delete(key)
        onError(error)
      }
    }
  }

  return { publish }
}

function getComfyOutputUrl(item: ResultItem): string {
  const params = new URLSearchParams({
    filename: item.filename ?? '',
    type: 'output'
  })
  if (item.subfolder) params.set('subfolder', item.subfolder)
  return api.apiURL(`/view?${params.toString()}`)
}

export function useHubCanvasOutputPublisher(): void {
  const executionStore = useExecutionStore()
  const toastStore = useToastStore()
  const publisher = createHubCanvasOutputPublisher({
    getHub: () =>
      (window as Window & { hub?: HubOutputPublisherApi }).hub,
    getActiveJobId: () => executionStore.activeJobId,
    getOutputUrl: getComfyOutputUrl,
    fetchOutput: (url) => fetch(url),
    onError: (error) => {
      console.error('[ComfyUI] Failed to add output to Hub canvas', error)
      toastStore.addAlert(t('toastMessages.fileUploadFailed'))
    }
  })

  const handleExecuted = (event: Event) => {
    void publisher.publish((event as CustomEvent<ExecutedWsMessage>).detail)
  }

  onMounted(() => {
    api.addEventListener('executed', handleExecuted)
  })

  onUnmounted(() => {
    api.removeEventListener('executed', handleExecuted)
  })
}

/// <reference types="vite/client" />

import type { HubBillingNodeType } from '@/hub/node-price-descriptions'

declare module 'virtual:icons/*' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}

declare module '~icons/*' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}

declare global {
  interface HubIncomingResource {
    nodeId: string
    assetId: string
    type: 'image' | 'video' | 'audio' | 'text' | 'file'
    name: string
    url: string
    path: string
    width?: number
    height?: number
    durationSec?: number
    fileSize?: number
    metadata?: Record<string, unknown>
  }

  interface Window {
    __COMFYUI_FRONTEND_VERSION__: string
    hub?: {
      ready?: Promise<unknown>
      billing?: {
        getNodePriceDescription?: (
          nodeType: HubBillingNodeType
        ) => Promise<string | null>
        onChange?: (callback: () => void) => () => void
      }
      ui?: {
        enterFullscreen?: () => void
        isFullscreen?: () => boolean
        onFullscreenChange?: (
          callback: (fullscreen: boolean) => void
        ) => () => void
      }
      canvas?: {
        getCurrentNodeId?: () => string
        updateNodeData?: (
          nodeId: string,
          data: Record<string, unknown>
        ) => Promise<void>
        getIncomingResources?: (filter?: {
          type?: string | string[]
        }) => Promise<HubIncomingResource[]>
        getWorkspaceResources?: (filter?: {
          type?: string | string[]
        }) => Promise<HubIncomingResource[]>
        onIncomingChange?: (callback: () => void) => () => void
        insertImageNode?: (args: {
          source: Blob
          name?: string
          sourceNodeId?: string
        }) => Promise<unknown>
        insertVideoNode?: (args: {
          source: Blob
          name?: string
          sourceNodeId?: string
        }) => Promise<unknown>
        insertAudioNode?: (args: {
          source: Blob
          name?: string
          sourceNodeId?: string
        }) => Promise<unknown>
        insertFileNode?: (args: {
          source: Blob
          name?: string
          sourceNodeId?: string
        }) => Promise<unknown>
      }
    }
  }

  interface ImportMetaEnv {
    VITE_APP_VERSION?: string
    VITE_STAGING_API_BASE_URL?: string
    VITE_STAGING_PLATFORM_BASE_URL?: string
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}

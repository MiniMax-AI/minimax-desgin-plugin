import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  importIncomingResource,
  startIncomingResourceSync,
  startWorkspaceResourceSync,
  stopIncomingResourceSync,
  stopWorkspaceResourceSync,
  useIncomingResources,
  useWorkspaceResources
} from '@/services/incomingAssetService'
import type { IncomingResource } from '@/services/incomingAssetService'

const mockFetchApi = vi.hoisted(() => vi.fn())

vi.mock('@/scripts/api', () => ({
  api: {
    fetchApi: mockFetchApi
  }
}))

vi.mock('@/i18n', () => ({
  t: (key: string) => key
}))

vi.mock('@/platform/updates/common/toastStore', () => ({
  useToastStore: () => ({ addAlert: vi.fn() })
}))

const resource: IncomingResource = {
  nodeId: 'node-1',
  assetId: 'asset-1',
  type: 'file',
  name: 'scene/model.glb',
  url: 'http://127.0.0.1:8001/files/model.glb',
  path: 'outputs/model.glb'
}

describe('incomingAssetService', () => {
  beforeEach(() => {
    stopIncomingResourceSync()
    stopWorkspaceResourceSync()
    vi.restoreAllMocks()
    mockFetchApi.mockReset()
    window.hub = undefined
  })

  it('loads incoming resources and refreshes them when links change', async () => {
    const onIncomingChange = vi.fn<(callback: () => void) => () => void>(
      () => () => {}
    )
    let onChange: (() => void) | undefined
    onIncomingChange.mockImplementation((callback: () => void) => {
      onChange = callback
      return () => {}
    })
    const getIncomingResources = vi
      .fn<() => Promise<HubIncomingResource[]>>()
      .mockResolvedValueOnce([resource])
      .mockResolvedValueOnce([])
    window.hub = {
      ready: Promise.resolve(),
      canvas: { getIncomingResources, onIncomingChange }
    }

    await startIncomingResourceSync()

    expect(useIncomingResources().resources.value).toEqual([resource])
    expect(onIncomingChange).toHaveBeenCalledOnce()

    onChange?.()
    await vi.waitFor(() => {
      expect(useIncomingResources().resources.value).toEqual([])
    })
  })

  it('starts a fresh load after an in-flight sync is stopped', async () => {
    let resolveFirstLoad: ((value: HubIncomingResource[]) => void) | undefined
    const firstLoad = new Promise<HubIncomingResource[]>((resolve) => {
      resolveFirstLoad = resolve
    })
    const getIncomingResources = vi
      .fn<() => Promise<HubIncomingResource[]>>()
      .mockReturnValueOnce(firstLoad)
      .mockResolvedValueOnce([resource])
    window.hub = {
      ready: Promise.resolve(),
      canvas: {
        getIncomingResources,
        onIncomingChange: vi.fn(() => () => {})
      }
    }

    const staleSync = startIncomingResourceSync()
    await vi.waitFor(() => {
      expect(getIncomingResources).toHaveBeenCalledOnce()
    })

    stopIncomingResourceSync()
    const currentSync = startIncomingResourceSync()
    await vi.waitFor(() => {
      expect(getIncomingResources).toHaveBeenCalledTimes(2)
    })

    resolveFirstLoad?.([])
    await Promise.all([staleSync, currentSync])

    expect(useIncomingResources().resources.value).toEqual([resource])
  })

  it('loads only image and video resources from the current workspace', async () => {
    const getWorkspaceResources = vi
      .fn<() => Promise<HubIncomingResource[]>>()
      .mockResolvedValue([resource])
    window.hub = {
      ready: Promise.resolve(),
      canvas: { getWorkspaceResources }
    }

    await startWorkspaceResourceSync()

    expect(getWorkspaceResources).toHaveBeenCalledWith({
      type: ['image', 'video']
    })
    expect(useWorkspaceResources().resources.value).toEqual([resource])
  })

  it('uploads an upstream file to the Comfy input directory once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(new Blob(['mesh'], { type: 'model/gltf-binary' }))
        )
      )
    )
    mockFetchApi.mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({ name: 'model.glb', subfolder: 'hub-upstream' })
    })

    const path = await importIncomingResource(resource)
    const secondPath = await importIncomingResource(resource)

    expect(path).toBe('hub-upstream/model.glb')
    expect(secondPath).toBe(path)
    expect(fetch).toHaveBeenCalledOnce()
    expect(mockFetchApi).toHaveBeenCalledOnce()

    const body = mockFetchApi.mock.calls[0][1].body as FormData
    expect(body.get('subfolder')).toBe('hub-upstream')
    expect(body.get('type')).toBe('input')
    expect((body.get('image') as File).name).toBe('model.glb')
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  encodeUserWorkflowId,
  syncExecutableWorkflowToHub,
  syncSavedWorkflowToCanvas
} from '@/hub/workflow-node-sync'
import type { ComfyWorkflow } from '@/platform/workflow/management/stores/comfyWorkflow'

const { updateWorkflowDraftIdentity } = vi.hoisted(() => ({
  updateWorkflowDraftIdentity: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/hub/workflow-draft', () => ({ updateWorkflowDraftIdentity }))

afterEach(() => {
  window.hub = undefined
  delete (window as unknown as { __COMFY_HUB_WORKFLOW_ID__?: string })
    .__COMFY_HUB_WORKFLOW_ID__
  delete (window as unknown as { __COMFY_HUB_WORKFLOW_NAME__?: string })
    .__COMFY_HUB_WORKFLOW_NAME__
  updateWorkflowDraftIdentity.mockReset().mockResolvedValue(undefined)
  vi.unstubAllGlobals()
})

describe('workflow node sync', () => {
  it('encodes a UTF-8 workflow key as the Gateway user workflow id', () => {
    expect(encodeUserWorkflowId('测试图片workflow.json')).toBe(
      'user:5rWL6K-V5Zu-54mHd29ya2Zsb3cuanNvbg'
    )
  })

  it('updates the launcher node after a workflow is saved', async () => {
    const updateNodeData = vi.fn().mockResolvedValue(undefined)
    window.hub = {
      ready: Promise.resolve(),
      canvas: {
        getCurrentNodeId: () => 'node-1',
        updateNodeData
      }
    } as never

    await syncSavedWorkflowToCanvas({
      key: 'saved.json',
      filename: 'saved'
    } as ComfyWorkflow)

    expect(updateNodeData).toHaveBeenCalledWith('node-1', {
      currentWorkflowId: 'user:c2F2ZWQuanNvbg',
      currentWorkflowName: 'saved',
      comfyuiWorkflowDirty: false
    })
    expect(updateWorkflowDraftIdentity).toHaveBeenCalledWith(
      'user:c2F2ZWQuanNvbg',
      'saved',
      { dirty: false }
    )
  })

  it('marks an existing workflow draft saved without rewriting node identity', async () => {
    const updateNodeData = vi.fn().mockResolvedValue(undefined)
    window.hub = {
      ready: Promise.resolve(),
      canvas: {
        getCurrentNodeId: () => 'node-1',
        updateNodeData
      }
    } as never

    await syncSavedWorkflowToCanvas(
      { key: 'saved.json', filename: 'saved' } as ComfyWorkflow,
      { syncCanvasIdentity: false }
    )

    expect(updateNodeData).not.toHaveBeenCalled()
    expect(updateWorkflowDraftIdentity).toHaveBeenCalledWith(
      'user:c2F2ZWQuanNvbg',
      'saved',
      { dirty: false }
    )
  })

  it('rolls the canvas identity back when saving the draft identity fails', async () => {
    const updateNodeData = vi.fn().mockResolvedValue(undefined)
    window.hub = {
      ready: Promise.resolve(),
      canvas: {
        getCurrentNodeId: () => 'node-1',
        updateNodeData
      }
    } as never
    const identity = window as unknown as {
      __COMFY_HUB_WORKFLOW_ID__?: string
      __COMFY_HUB_WORKFLOW_NAME__?: string
    }
    identity.__COMFY_HUB_WORKFLOW_ID__ = 'template:source'
    identity.__COMFY_HUB_WORKFLOW_NAME__ = 'source'
    updateWorkflowDraftIdentity.mockRejectedValueOnce(
      new Error('draft storage unavailable')
    )

    await expect(
      syncSavedWorkflowToCanvas({
        key: 'saved.json',
        filename: 'saved'
      } as ComfyWorkflow)
    ).rejects.toThrow('draft storage unavailable')

    expect(updateNodeData).toHaveBeenNthCalledWith(1, 'node-1', {
      currentWorkflowId: 'user:c2F2ZWQuanNvbg',
      currentWorkflowName: 'saved',
      comfyuiWorkflowDirty: false
    })
    expect(updateNodeData).toHaveBeenNthCalledWith(2, 'node-1', {
      currentWorkflowId: 'template:source',
      currentWorkflowName: 'source'
    })
    expect(identity.__COMFY_HUB_WORKFLOW_ID__).toBe('template:source')
    expect(identity.__COMFY_HUB_WORKFLOW_NAME__).toBe('source')
  })

  it('is a no-op outside the Hub plugin host', async () => {
    await expect(
      syncSavedWorkflowToCanvas({
        key: 'saved.json',
        filename: 'saved'
      } as ComfyWorkflow)
    ).resolves.toBeUndefined()
  })

  it('persists graphToPrompt output for headless Agent execution', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    window.hub = { ready: Promise.resolve() } as never
    const snapshot = {
      output: { '1': { class_type: 'SaveImage', inputs: {} } },
      workflow: { nodes: [], links: [] }
    }

    await syncExecutableWorkflowToHub(
      { key: 'saved.json' } as ComfyWorkflow,
      snapshot as never
    )

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/comfyui/workflows/user%3Ac2F2ZWQuanNvbg/executable',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot)
      }
    )
  })
})

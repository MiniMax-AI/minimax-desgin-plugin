import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  COMFYUI_WORKFLOW_DRAFT_KEY,
  saveWorkflowDraft
} from '@/hub/workflow-draft'

afterEach(() => {
  window.hub = undefined
  vi.restoreAllMocks()
})

describe('workflow draft persistence', () => {
  it('preserves the bound workflow baseline hash across graph autosaves', async () => {
    const set = vi.fn().mockResolvedValue(undefined)
    window.hub = {
      ready: Promise.resolve(),
      storage: {
        get: vi.fn().mockResolvedValue({
          version: 1,
          workflowId: 'template:source',
          workflowName: 'Source',
          graph: { nodes: [{ id: 1 }], links: [] },
          baseSourceSha256: 'a'.repeat(64),
          dirty: false,
          updatedAt: 1
        }),
        set,
        delete: vi.fn()
      }
    } as never

    await saveWorkflowDraft(
      { nodes: [{ id: 2 }], links: [] } as never,
      'template:source',
      'Source'
    )

    expect(set).toHaveBeenCalledWith(
      COMFYUI_WORKFLOW_DRAFT_KEY,
      expect.objectContaining({
        workflowId: 'template:source',
        graph: { nodes: [{ id: 2 }], links: [] },
        baseSourceSha256: 'a'.repeat(64),
        dirty: true
      })
    )
  })

  it('does not carry a baseline hash across different workflow identities', async () => {
    const set = vi.fn().mockResolvedValue(undefined)
    window.hub = {
      ready: Promise.resolve(),
      storage: {
        get: vi.fn().mockResolvedValue({
          version: 1,
          workflowId: 'template:old',
          workflowName: 'Old',
          graph: { nodes: [{ id: 1 }], links: [] },
          baseSourceSha256: 'b'.repeat(64),
          dirty: true,
          updatedAt: 1
        }),
        set,
        delete: vi.fn()
      }
    } as never

    await saveWorkflowDraft(
      { nodes: [{ id: 3 }], links: [] } as never,
      'template:new',
      'New'
    )

    expect(set.mock.calls[0]?.[1]).not.toHaveProperty('baseSourceSha256')
  })

  it('fails visibly when the node Draft cannot be persisted', async () => {
    window.hub = {
      ready: Promise.resolve(),
      storage: {
        get: vi.fn().mockResolvedValue(undefined),
        set: vi.fn().mockRejectedValue(new Error('storage write failed')),
        delete: vi.fn()
      }
    } as never

    await expect(
      saveWorkflowDraft(
        { nodes: [{ id: 1 }], links: [] } as never,
        'template:source',
        'Source'
      )
    ).rejects.toThrow('storage write failed')
  })

  it('fails visibly when Hub node Draft storage is unavailable', async () => {
    window.hub = { ready: Promise.resolve() } as never

    await expect(
      saveWorkflowDraft(
        { nodes: [{ id: 1 }], links: [] } as never,
        'template:source',
        'Source'
      )
    ).rejects.toThrow('Hub workflow Draft storage is unavailable')
  })
})

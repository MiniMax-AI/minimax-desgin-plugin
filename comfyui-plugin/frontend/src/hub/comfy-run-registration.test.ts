import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerComfyRunWithHub } from '@/hub/comfy-run-registration'

describe('registerComfyRunWithHub', () => {
  beforeEach(() => {
    window.hub = undefined
    vi.restoreAllMocks()
  })

  it('registers an accepted prompt against the current canvas node', async () => {
    window.hub = {
      ready: Promise.resolve(),
      canvas: { getCurrentNodeId: () => 'comfy-node-1' }
    }
    const fetchMock = vi
      .spyOn(window, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }))

    await registerComfyRunWithHub('prompt-1')

    expect(fetchMock).toHaveBeenCalledWith('/api/comfyui/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt_id: 'prompt-1',
        source_node_id: 'comfy-node-1'
      })
    })
  })

  it('does nothing outside the Hub canvas host', async () => {
    const fetchMock = vi.spyOn(window, 'fetch')

    await registerComfyRunWithHub('prompt-1')

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

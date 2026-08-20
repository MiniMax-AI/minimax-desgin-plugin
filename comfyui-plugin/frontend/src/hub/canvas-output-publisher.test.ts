import { describe, expect, it, vi } from 'vitest'

import { createHubCanvasOutputPublisher } from '@/hub/canvas-output-publisher'
import type { HubCanvasOutputPublisherDependencies } from '@/hub/canvas-output-publisher'
import type { ExecutedWsMessage } from '@/schemas/apiSchema'

function createDependencies(
  overrides: Partial<HubCanvasOutputPublisherDependencies> = {}
) {
  const insertImageNode = vi.fn(() => Promise.resolve())
  const insertVideoNode = vi.fn(() => Promise.resolve())
  const insertAudioNode = vi.fn(() => Promise.resolve())
  const insertFileNode = vi.fn(() => Promise.resolve())
  const dependencies: HubCanvasOutputPublisherDependencies = {
    getHub: () => ({
      ready: Promise.resolve(),
      canvas: {
        getCurrentNodeId: () => 'comfy-node',
        insertImageNode,
        insertVideoNode,
        insertAudioNode,
        insertFileNode
      }
    }),
    getActiveJobId: () => 'job-1',
    getOutputUrl: (item) => `http://comfy.test/view/${item.filename}`,
    fetchOutput: vi.fn(() =>
      Promise.resolve(new Response(new Blob(['output'], { type: 'image/png' })))
    ),
    onError: vi.fn(),
    ...overrides
  }

  return {
    dependencies,
    insertImageNode,
    insertVideoNode,
    insertAudioNode,
    insertFileNode
  }
}

describe('canvas output publisher', () => {
  it('adds a completed image to the canvas from the current ComfyUI node', async () => {
    const { dependencies, insertImageNode } = createDependencies()
    const publisher = createHubCanvasOutputPublisher(dependencies)

    await publisher.publish({
      prompt_id: 'job-1',
      node: '42',
      display_node: '42',
      output: {
        images: [{ filename: 'result.png', subfolder: 'runs', type: 'output' }]
      }
    })

    expect(insertImageNode).toHaveBeenCalledWith({
      source: expect.any(File),
      name: 'result.png',
      sourceNodeId: 'comfy-node'
    })
  })

  it('does not publish output from another ComfyUI run', async () => {
    const { dependencies, insertImageNode } = createDependencies()
    const publisher = createHubCanvasOutputPublisher(dependencies)

    await publisher.publish({
      prompt_id: 'other-job',
      node: '42',
      display_node: '42',
      output: { images: [{ filename: 'result.png', type: 'output' }] }
    })

    expect(insertImageNode).not.toHaveBeenCalled()
  })

  it('publishes each output once when ComfyUI repeats an executed event', async () => {
    const { dependencies, insertImageNode } = createDependencies()
    const publisher = createHubCanvasOutputPublisher(dependencies)
    const event: ExecutedWsMessage = {
      prompt_id: 'job-1',
      node: '42',
      display_node: '42',
      output: { images: [{ filename: 'result.png', type: 'output' }] }
    }

    await publisher.publish(event)
    await publisher.publish(event)

    expect(insertImageNode).toHaveBeenCalledTimes(1)
  })
})

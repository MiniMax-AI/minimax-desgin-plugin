import { render, screen } from '@testing-library/vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'

import {
  applyHubNodePriceDescriptions,
  resetHubNodePriceDescriptionsForTest
} from '@/hub/node-price-descriptions'
import type { ComfyNodeDef } from '@/schemas/nodeDefSchema'
import type { ComfyNodeDefImpl } from '@/stores/nodeDefStore'

import NodePreviewCard from './NodePreviewCard.vue'

vi.mock('@vueuse/core', () => ({ useResizeObserver: vi.fn() }))
vi.mock('@/components/node/NodePricingBadge.vue', () => ({ default: true }))
vi.mock('@/components/node/NodeProviderBadge.vue', () => ({ default: true }))
vi.mock(
  '@/renderer/extensions/vueNodes/components/LGraphNodePreview.vue',
  () => ({ default: true })
)

const nodeDef = {
  name: 'MinimaxHailuo03TextToVideoNode',
  display_name: 'MiniMax H3 Text to Video',
  description: 'Generate a video from text.',
  category: 'api/video',
  inputs: {},
  outputs: []
} as unknown as ComfyNodeDefImpl

afterEach(() => {
  resetHubNodePriceDescriptionsForTest()
  delete window.hub
})

describe('NodePreviewCard', () => {
  it('shows current Hub price rules in the hover preview', async () => {
    window.hub = {
      ready: Promise.resolve(),
      billing: {
        getNodePriceDescription: vi
          .fn()
          .mockResolvedValue('### Price details\n\n- 768P: 56 credits/second'),
        onChange: vi.fn(() => vi.fn())
      }
    }
    await applyHubNodePriceDescriptions({
      MinimaxHailuo03TextToVideoNode: nodeDef as unknown as ComfyNodeDef
    })

    render(NodePreviewCard, {
      props: { nodeDef },
      global: {
        plugins: [
          createI18n({ legacy: false, locale: 'en', messages: { en: {} } })
        ]
      }
    })

    expect(
      screen.getByTestId('node-preview-price-description')
    ).toHaveTextContent('Price details')
    expect(
      screen.getByTestId('node-preview-price-description')
    ).toHaveTextContent('768P: 56 credits/second')
  })
})

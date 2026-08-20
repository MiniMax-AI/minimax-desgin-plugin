import { render, screen } from '@testing-library/vue'
import { describe, expect, it, vi } from 'vitest'
import { getMediaAssetGridColumns } from '@/platform/assets/components/mediaAssetViewOptions'

import IncomingResourcesPanel from './IncomingResourcesPanel.vue'

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({
    t: (key: string) => key
  })
}))

vi.mock('@/services/incomingAssetService', async () => {
  const { ref } = await import('vue')

  return {
    importIncomingResourceWithToast: vi.fn(),
    importWorkspaceResourceWithToast: vi.fn(),
    startIncomingResourceSync: vi.fn(),
    startWorkspaceResourceSync: vi.fn(),
    useIncomingResources: () => ({
      resources: ref([
        {
          nodeId: 'upstream-node',
          assetId: 'asset-1',
          type: 'image',
          name: 'upstream.png',
          url: 'http://localhost/upstream.png'
        }
      ]),
      isLoading: ref(false)
    }),
    useWorkspaceResources: () => ({
      resources: ref([]),
      isLoading: ref(false)
    })
  }
})

function renderPanel(viewMode: 'list' | 'grid-small' | 'grid') {
  return render(IncomingResourcesPanel, {
    props: { viewMode },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: {
        AssetsListItem: {
          props: ['primaryText'],
          template: '<span>{{ primaryText }}</span>'
        },
        Button: true,
        MediaAssetCard: {
          props: ['asset'],
          template: '<span>{{ asset.name }}</span>'
        },
        MediaAssetContextMenu: true,
        MediaLightbox: true
      }
    }
  })
}

describe('IncomingResourcesPanel view modes', () => {
  it('uses list, small-grid, and large-grid layouts from the shared view mode', async () => {
    const view = renderPanel('list')
    const getGridColumns = () => {
      const layout = view.container.querySelector(
        '[style*="grid-template-columns"]'
      )
      expect(layout).toBeInstanceOf(HTMLElement)
      return (layout as HTMLElement).style.gridTemplateColumns
    }

    expect(getGridColumns()).toBe('minmax(0, 1fr)')
    expect(screen.getByText('upstream.png')).toBeVisible()

    await view.rerender({ viewMode: 'grid-small' })
    expect(getGridColumns()).toBe(getMediaAssetGridColumns('grid-small'))

    await view.rerender({ viewMode: 'grid' })
    expect(getGridColumns()).toBe(getMediaAssetGridColumns('grid'))
  })
})

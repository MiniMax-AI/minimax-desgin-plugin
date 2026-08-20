import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ComfyNodeDef } from '@/schemas/nodeDefSchema'
import type { LGraphNode } from '@/lib/litegraph/src/litegraph'

import {
  applyHubNodePriceDescriptions,
  formatHubNodePriceDescriptionForTooltip,
  getHubPriceBadgeAppearance,
  getHubNodePriceDescription,
  getHubSubgraphPriceDescription,
  resolveHubBillingNodeType,
  resetHubNodePriceDescriptionsForTest
} from './node-price-descriptions'

function nodeDef(name: string): ComfyNodeDef {
  return {
    name,
    description: 'Original description',
    price_badge: { expr: 'old hardcoded price' }
  } as ComfyNodeDef
}

afterEach(() => {
  resetHubNodePriceDescriptionsForTest()
  delete window.hub
})

describe('applyHubNodePriceDescriptions', () => {
  it('resolves the canonical backend node name before the serialized node type', () => {
    expect(
      resolveHubBillingNodeType(
        'translated-or-legacy-type',
        'MinimaxHailuo03TextToVideoNode'
      )
    ).toBe('MinimaxHailuo03TextToVideoNode')
    expect(resolveHubBillingNodeType('KSampler', 'KSampler')).toBeNull()
  })

  it('leaves standalone ComfyUI node definitions unchanged', async () => {
    const original = nodeDef('MinimaxHailuo03ReferenceNode')

    const result = await applyHubNodePriceDescriptions({
      MinimaxHailuo03ReferenceNode: original
    })

    expect(result.MinimaxHailuo03ReferenceNode).toBe(original)
    expect(result.MinimaxHailuo03ReferenceNode.price_badge).toBeDefined()
  })

  it('removes the old badge and appends current Hub price rules', async () => {
    window.hub = {
      ready: Promise.resolve(),
      billing: {
        getNodePriceDescription: vi
          .fn()
          .mockResolvedValue('### 价格说明\n\n- 生成视频：96 积分/秒'),
        onChange: vi.fn(() => vi.fn())
      }
    }

    const result = await applyHubNodePriceDescriptions({
      MinimaxHailuo03ReferenceNode: nodeDef('MinimaxHailuo03ReferenceNode')
    })

    expect(result.MinimaxHailuo03ReferenceNode.price_badge).toBeUndefined()
    expect(result.MinimaxHailuo03ReferenceNode.description).toBe(
      'Original description'
    )
    expect(getHubNodePriceDescription('MinimaxHailuo03ReferenceNode')).toBe(
      '### 价格说明\n\n- 生成视频：96 积分/秒'
    )
  })

  it('never falls back to hardcoded prices when the host has no price details', async () => {
    window.hub = {
      ready: Promise.resolve(),
      billing: {
        getNodePriceDescription: vi.fn().mockResolvedValue(null),
        onChange: vi.fn(() => vi.fn())
      }
    }

    const result = await applyHubNodePriceDescriptions({
      Banana2Node: nodeDef('Banana2Node')
    })

    expect(result.Banana2Node.price_badge).toBeUndefined()
    expect(result.Banana2Node.description).toBe('Original description')
  })

  it('keeps node definitions usable when the Hub handshake fails', async () => {
    window.hub = {
      ready: Promise.reject(new Error('host unavailable'))
    }

    const result = await applyHubNodePriceDescriptions({
      BananaProNode: nodeDef('BananaProNode')
    })

    expect(result.BananaProNode.description).toBe('Original description')
    expect(result.BananaProNode.price_badge).toBeUndefined()
  })

  it('refreshes descriptions when Hub prices change', async () => {
    let notifyPriceChanged: (() => void) | undefined
    const getNodePriceDescription = vi.fn().mockResolvedValue(null)
    window.hub = {
      ready: Promise.resolve(),
      billing: {
        getNodePriceDescription,
        onChange: vi.fn((callback) => {
          notifyPriceChanged = callback
          return vi.fn()
        })
      }
    }

    await applyHubNodePriceDescriptions({
      GImage2Node: nodeDef('GImage2Node')
    })
    notifyPriceChanged?.()
    await Promise.resolve()

    expect(
      getNodePriceDescription.mock.calls.filter(
        ([nodeType]) => nodeType === 'GImage2Node'
      )
    ).toHaveLength(2)
  })

  it('loads Context IR pricing even when definitions arrive without that node', async () => {
    window.hub = {
      ready: Promise.resolve(),
      billing: {
        getNodePriceDescription: vi.fn(async (nodeType) =>
          nodeType === 'MinimaxH3PromptExpandNode'
            ? '### 价格说明\n\n- 输入 Token：850 积分/百万 Token'
            : null
        ),
        onChange: vi.fn(() => vi.fn())
      }
    }

    await applyHubNodePriceDescriptions({
      Banana2Node: nodeDef('Banana2Node')
    })

    expect(getHubNodePriceDescription('MinimaxH3PromptExpandNode')).toContain(
      '850 积分/百万 Token'
    )
  })
})

describe('getHubSubgraphPriceDescription', () => {
  it('groups all priced descendants by child node title', async () => {
    window.hub = {
      ready: Promise.resolve(),
      billing: {
        getNodePriceDescription: vi.fn(async (nodeType) => {
          if (nodeType === 'MinimaxH3PromptExpandNode') {
            return '### 价格说明\n\n- 输入 Token：850 积分/百万 Token'
          }
          if (nodeType === 'MinimaxH3VideoEnhancementNode') {
            return '### 价格说明\n\n- 视频超分：40 积分/秒'
          }
          return null
        }),
        onChange: vi.fn(() => vi.fn())
      }
    }
    await applyHubNodePriceDescriptions({})

    const child = (title: string, type: string): LGraphNode =>
      ({
        title,
        type,
        isSubgraphNode: () => false
      }) as LGraphNode
    const wrapper = {
      title: 'H3 工作流',
      type: 'subgraph:workflow',
      isSubgraphNode: () => true,
      subgraph: {
        id: 'workflow',
        nodes: [
          child('官方扩写', 'MinimaxH3PromptExpandNode'),
          child('2K 超分', 'MinimaxH3VideoEnhancementNode')
        ]
      }
    } as LGraphNode

    expect(getHubSubgraphPriceDescription(wrapper)).toBe(
      '### 价格说明\n\n#### 官方扩写\n\n- 输入 Token：850 积分/百万 Token\n\n#### 2K 超分\n\n- 视频超分：40 积分/秒'
    )
  })
})

describe('formatHubNodePriceDescriptionForTooltip', () => {
  it('converts the Hub markdown rules into readable tooltip text', () => {
    expect(
      formatHubNodePriceDescriptionForTooltip(
        '### 价格说明\n\n- **生成视频 (768P)**：56 积分/秒\n- `2K`：96 积分/秒'
      )
    ).toBe('• 生成视频 (768P)：56 积分/秒\n• 2K：96 积分/秒')
  })

  it('keeps multiple child price sections visually grouped', () => {
    expect(
      formatHubNodePriceDescriptionForTooltip(
        [
          '### 价格说明',
          '',
          '#### 官方提示词扩写 / Prompt expansion',
          '',
          '- 输入 Token：8,500 积分/百万 Token',
          '- 输出 Token：32,000 积分/百万 Token',
          '',
          '#### 官方 2K 超清增强 / 2K enhancement',
          '',
          '- 视频超分 (2K)：50 积分/秒'
        ].join('\n')
      )
    ).toBe(
      '官方提示词扩写 / Prompt expansion\n' +
        '  输入 Token：8,500 积分/百万 Token\n' +
        '  输出 Token：32,000 积分/百万 Token\n\n' +
        '官方 2K 超清增强 / 2K enhancement\n' +
        '  视频超分 (2K)：50 积分/秒'
    )
  })
})

describe('getHubPriceBadgeAppearance', () => {
  it('uses a localized label with the standard widget palette', () => {
    expect(
      getHubPriceBadgeAppearance('### 价格说明', '价格说明', {
        WIDGET_TEXT_COLOR: '#ddd',
        WIDGET_BGCOLOR: '#222'
      })
    ).toEqual({
      text: '价格说明',
      fgColor: '#ddd',
      bgColor: '#222'
    })
  })

  it('hides the label when no current price description is available', () => {
    expect(
      getHubPriceBadgeAppearance('', '价格说明', {
        WIDGET_TEXT_COLOR: '#ddd',
        WIDGET_BGCOLOR: '#222'
      }).text
    ).toBe('')
  })
})

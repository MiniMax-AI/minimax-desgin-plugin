import type { ComfyNodeDef } from '@/schemas/nodeDefSchema'
import type { LGraph, LGraphNode } from '@/lib/litegraph/src/litegraph'
import type { MaybeRefOrGetter } from 'vue'
import { computed, reactive, toValue } from 'vue'

const HUB_BILLING_NODE_TYPES = [
  'Banana2Node',
  'BananaProNode',
  'GImage2Node',
  'MinimaxH3PromptExpandNode',
  'MinimaxH3VideoEnhancementNode',
  'MinimaxHailuo03TextToVideoNode',
  'MinimaxHailuo03FirstLastFrameNode',
  'MinimaxHailuo03ReferenceNode'
] as const

export type HubBillingNodeType = (typeof HUB_BILLING_NODE_TYPES)[number]

interface HubPriceBadgeColors {
  WIDGET_TEXT_COLOR: string
  WIDGET_BGCOLOR: string
}

interface HubPriceBadgeAppearance {
  text: string
  fgColor: string
  bgColor: string
}

const hubBillingNodeTypes = new Set<string>(HUB_BILLING_NODE_TYPES)
let disposeBillingChange: (() => void) | undefined
let requestRevision = 0
const nodePriceDescriptions = reactive(new Map<string, string>())

export function isHubBillingNodeType(
  value: string
): value is HubBillingNodeType {
  return hubBillingNodeTypes.has(value)
}

export function resolveHubBillingNodeType(
  serializedType: string | undefined,
  definitionName: string | undefined
): HubBillingNodeType | null {
  if (definitionName && isHubBillingNodeType(definitionName)) {
    return definitionName
  }
  return serializedType && isHubBillingNodeType(serializedType)
    ? serializedType
    : null
}

function clearNodePriceDescriptions(): void {
  nodePriceDescriptions.clear()
}

async function refreshDescriptions(): Promise<void> {
  const revision = ++requestRevision
  clearNodePriceDescriptions()
  const getDescription = window.hub?.billing?.getNodePriceDescription
  if (!getDescription) return

  const entries = await Promise.all(
    HUB_BILLING_NODE_TYPES.map(async (nodeType) => {
      try {
        return [nodeType, await getDescription(nodeType)] as const
      } catch {
        return [nodeType, null] as const
      }
    })
  )
  if (revision !== requestRevision) return
  for (const [nodeType, description] of entries) {
    if (description) nodePriceDescriptions.set(nodeType, description)
  }
}

function subscribeToBillingChanges(): void {
  if (disposeBillingChange || !window.hub?.billing?.onChange) return
  disposeBillingChange = window.hub.billing.onChange(() => {
    void refreshDescriptions()
  })
}

export async function applyHubNodePriceDescriptions(
  defs: Record<string, ComfyNodeDef>
): Promise<Record<string, ComfyNodeDef>> {
  if (!window.hub) return defs

  const strippedDefs = Object.fromEntries(
    Object.entries(defs).map(([nodeName, definition]) => {
      if (!isHubBillingNodeType(nodeName)) return [nodeName, definition]
      const next = { ...definition }
      delete next.price_badge
      return [nodeName, next]
    })
  )
  try {
    await window.hub.ready
  } catch {
    return strippedDefs
  }
  subscribeToBillingChanges()
  await refreshDescriptions()
  return strippedDefs
}

export function useHubNodePriceDescription(nodeType: MaybeRefOrGetter<string>) {
  return computed(() => nodePriceDescriptions.get(toValue(nodeType)) || '')
}

export function getHubNodePriceDescription(nodeType: string): string {
  return nodePriceDescriptions.get(nodeType) || ''
}

interface SubgraphPriceSection {
  title: string
  description: string
}

function collectSubgraphPriceSections(
  graph: LGraph,
  visited = new Set<LGraph>()
): SubgraphPriceSection[] {
  if (visited.has(graph)) return []
  visited.add(graph)

  return graph.nodes.flatMap((node) => {
    if (node.isSubgraphNode()) {
      return collectSubgraphPriceSections(node.subgraph, visited)
    }

    const nodeType = resolveHubBillingNodeType(
      node.type,
      node.constructor.nodeData?.name
    )
    if (!nodeType) return []
    const description = getHubNodePriceDescription(nodeType)
    if (!description) return []
    return [
      {
        title: node.title.replace(/\s+/g, ' ').trim() || nodeType,
        description
      }
    ]
  })
}

function splitPriceDescription(description: string): {
  heading: string
  body: string
} {
  const lines = description.split('\n')
  const firstContentIndex = lines.findIndex((line) => line.trim().length > 0)
  const firstContent = lines[firstContentIndex]?.trim() ?? ''
  if (!/^#{1,6}\s+/.test(firstContent)) {
    return { heading: '', body: description.trim() }
  }
  return {
    heading: firstContent,
    body: lines
      .filter((_, index) => index !== firstContentIndex)
      .join('\n')
      .trim()
  }
}

export function getHubSubgraphPriceDescription(node: LGraphNode): string {
  if (!node.isSubgraphNode()) return ''
  const sections = collectSubgraphPriceSections(node.subgraph)
  if (sections.length === 0) return ''

  const first = splitPriceDescription(sections[0].description)
  const heading = first.heading
  const details = sections.map(({ title, description }) => {
    const { body } = splitPriceDescription(description)
    return `#### ${title}\n\n${body}`
  })
  return [heading, ...details].filter(Boolean).join('\n\n')
}

export function formatHubNodePriceDescriptionForTooltip(
  description: string
): string {
  const lines = description
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const detailLines = /^#{1,6}\s+/.test(lines[0] ?? '') ? lines.slice(1) : lines
  const hasSections = detailLines.some((line) => /^#{2,6}\s+/.test(line))
  const formatted: string[] = []

  for (const line of detailLines) {
    const isSection = /^#{2,6}\s+/.test(line)
    const isListItem = /^([-*+]|\d+\.)\s+/.test(line)
    const text = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^([-*+]|\d+\.)\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')

    if (isSection && formatted.length > 0) formatted.push('')
    formatted.push(isListItem ? `${hasSections ? '  ' : '• '}${text}` : text)
  }

  return formatted.join('\n')
}

export function getHubPriceBadgeAppearance(
  description: string,
  label: string,
  colors: HubPriceBadgeColors
): HubPriceBadgeAppearance {
  return {
    text: description ? label : '',
    fgColor: colors.WIDGET_TEXT_COLOR,
    bgColor: colors.WIDGET_BGCOLOR
  }
}

export function resetHubNodePriceDescriptionsForTest(): void {
  disposeBillingChange?.()
  disposeBillingChange = undefined
  requestRevision += 1
  clearNodePriceDescriptions()
}

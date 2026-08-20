interface WorkflowMetadataTarget {
  extra?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function normalizeHubWorkflowAgentHint(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, 200)
}

export function hasHubWorkflowAgentHint(
  workflow: WorkflowMetadataTarget
): boolean {
  const hub = asRecord(asRecord(workflow.extra)?.hub)
  return hub ? Object.hasOwn(hub, 'agent_hint') : false
}

export function readHubWorkflowAgentHint(
  workflow: WorkflowMetadataTarget
): string {
  return normalizeHubWorkflowAgentHint(
    asRecord(asRecord(workflow.extra)?.hub)?.agent_hint
  )
}

export function setHubWorkflowAgentHint(
  workflow: WorkflowMetadataTarget,
  value: unknown
): string {
  const normalized = normalizeHubWorkflowAgentHint(value)
  const existingExtra = asRecord(workflow.extra)
  const extra = existingExtra ? { ...existingExtra } : {}
  const existingHub = asRecord(extra.hub)
  const hub = existingHub ? { ...existingHub } : {}

  hub.schema_version = 1
  hub.agent_hint = normalized
  extra.hub = hub
  workflow.extra = extra
  return normalized
}

const DIAGNOSTIC_KEY = '__hiloDiag'
const MAX_ENTRIES = 40

interface HubDiagnosticTarget {
  __hiloDiag?: Array<Record<string, unknown>>
}

function append(target: HubDiagnosticTarget, entry: Record<string, unknown>) {
  const entries = target[DIAGNOSTIC_KEY] ?? []
  entries.push(entry)
  target[DIAGNOSTIC_KEY] = entries.slice(-MAX_ENTRIES)
}

export function recordHubComfyDiagnostic(
  event: string,
  details: Record<string, unknown>
): void {
  const entry = {
    marker: 'TEMP DIAGNOSTIC — remove before commit',
    scope: 'comfyui',
    event,
    at: Date.now(),
    ...details
  }
  append(globalThis as HubDiagnosticTarget, entry)
  try {
    if (window.parent !== window)
      append(window.parent as HubDiagnosticTarget, entry)
  } catch (_) {}
}

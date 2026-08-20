import { hubBackendOrigin } from '@/hub/backend-origin'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function extractComfyBaseDirectory(value: unknown): string | null {
  const argv = asRecord(asRecord(value)?.system)?.argv
  if (!Array.isArray(argv)) return null

  const index = argv.indexOf('--base-directory')
  const directory = index >= 0 ? argv[index + 1] : undefined
  return typeof directory === 'string' && directory.trim()
    ? directory.trim()
    : null
}

export function replaceComfyModelPaths(
  markdown: string,
  baseDirectory: string
): string {
  const modelsDirectory = `${baseDirectory.replace(/[\\/]+$/, '')}/models`
  return markdown.replace(/ComfyUI[\\/]models(?=[\\/])/g, modelsDirectory)
}

export async function fetchHubComfyBaseDirectory(): Promise<string | null> {
  const origin = hubBackendOrigin()
  if (!origin) return null

  try {
    const response = await fetch(`${origin}/system_stats`)
    if (!response.ok) return null
    return extractComfyBaseDirectory(await response.json())
  } catch {
    return null
  }
}

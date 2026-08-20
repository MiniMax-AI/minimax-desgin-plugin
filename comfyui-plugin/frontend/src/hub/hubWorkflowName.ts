export function resolveUniqueHubWorkflowPath(
  basePath: string,
  isOccupied: (path: string) => boolean
): string {
  const extensionIndex = basePath.lastIndexOf('.json')
  if (extensionIndex < 0) return basePath
  const stem = basePath.slice(0, extensionIndex)
  for (let index = 0; index <= 9_999; index += 1) {
    const candidate = index === 0 ? basePath : `${stem}-${index}.json`
    if (!isOccupied(candidate)) return candidate
  }
  throw new Error('Too many workflows with the same name')
}

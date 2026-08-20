export function shouldReuseActiveWorkflow(
  requestedReuse: boolean | undefined,
  isHubMode: boolean
): boolean {
  return requestedReuse ?? isHubMode
}

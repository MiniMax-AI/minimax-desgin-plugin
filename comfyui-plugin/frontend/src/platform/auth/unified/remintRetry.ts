import type { AxiosInstance } from 'axios'

/** Cloud token re-minting is intentionally disabled in the local build. */
export async function shouldRemintCloudRequest(): Promise<boolean> {
  return false
}

/** Pass-through fetch; never retries 401 responses or rebuilds a session. */
export async function fetchWithUnifiedRemint(
  input: RequestInfo | URL,
  init: RequestInit,
  _shouldRetryOn401: boolean
): Promise<Response> {
  return fetch(input, init)
}

/** No interceptor is installed for local requests. */
export function attachUnifiedRemintInterceptor(_client: AxiosInstance): void {}

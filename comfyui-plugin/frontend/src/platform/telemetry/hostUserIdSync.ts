import type { WatchStopHandle } from 'vue'

/** Firebase user IDs are never synchronized to host telemetry. */
export function syncHostUserIdWithFirebaseAuth(): WatchStopHandle | undefined {
  return undefined
}

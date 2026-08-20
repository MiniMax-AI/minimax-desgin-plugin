/**
 * Local ComfyUI does not have an authenticated server session.  These methods
 * remain as no-ops for callers shared with cloud builds.
 */
export const useSessionCookie = () => ({
  createSession: async (): Promise<void> => {},
  createSessionOrThrow: async (): Promise<void> => {},
  ensureSessionCookie: async (): Promise<void> => {},
  deleteSession: async (): Promise<void> => {}
})

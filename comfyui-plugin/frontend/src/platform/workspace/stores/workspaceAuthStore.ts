import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'

import type { AuthHeader } from '@/types/authTypes'
import type { WorkspaceWithRole } from '@/platform/workspace/workspaceTypes'

/**
 * Local-only workspace auth facade. Workspace JWT minting, refresh and session
 * cookies are cloud account features and are deliberately unavailable.
 */
export class WorkspaceAuthError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message)
    this.name = 'WorkspaceAuthError'
  }
}

export const useWorkspaceAuthStore = defineStore('workspaceAuth', () => {
  const currentWorkspace = shallowRef<WorkspaceWithRole | null>(null)
  const workspaceToken = ref<string | null>(null)
  const unifiedToken = ref<string | null>(null)
  const isLoading = ref(false)
  const error = ref<Error | null>(null)
  const isAuthenticated = computed(() => false)

  const init = async (): Promise<void> => {}
  const destroy = (): void => clearWorkspaceContext()
  const initializeFromSession = (): boolean => false
  const switchWorkspace = async (_workspaceId: string): Promise<void> => {}
  const refreshToken = async (): Promise<void> => {}
  const mintAtLogin = async (): Promise<boolean> => false
  const remintUnifiedOnce = async (_expectedToken: string): Promise<string | null> => null
  const getWorkspaceAuthHeader = (): AuthHeader | null => null
  const ensureWorkspaceAuthHeader = async (_preferredWorkspaceId?: string): Promise<AuthHeader | null> => null
  const ensureWorkspaceToken = async (_preferredWorkspaceId?: string): Promise<string | null> => null
  const getWorkspaceToken = (): string | undefined => undefined
  const getUnifiedToken = (): string | undefined => undefined

  function clearWorkspaceContext(): void {
    currentWorkspace.value = null
    workspaceToken.value = null
    unifiedToken.value = null
    error.value = null
    isLoading.value = false
  }

  return {
    currentWorkspace,
    workspaceToken,
    unifiedToken,
    isLoading,
    error,
    isAuthenticated,
    init,
    destroy,
    initializeFromSession,
    switchWorkspace,
    refreshToken,
    mintAtLogin,
    remintUnifiedOnce,
    getWorkspaceAuthHeader,
    ensureWorkspaceAuthHeader,
    ensureWorkspaceToken,
    getWorkspaceToken,
    getUnifiedToken,
    clearWorkspaceContext
  }
})

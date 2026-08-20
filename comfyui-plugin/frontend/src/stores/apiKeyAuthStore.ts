import { defineStore } from 'pinia'

import type { ApiKeyAuthHeader } from '@/types/authTypes'

export const useApiKeyAuthStore = defineStore('apiKeyAuth', () => {
  type ApiKeyUser = { id: string; name?: string; email?: string }
  const getApiKey = (): null => null
  const getAuthHeader = (): ApiKeyAuthHeader | null => null
  const storeApiKey = async (_apiKey?: string): Promise<boolean> => false
  const clearStoredApiKey = async (): Promise<boolean> => true

  return {
    currentUser: null as ApiKeyUser | null,
    isAuthenticated: false,
    storeApiKey,
    clearStoredApiKey,
    getAuthHeader,
    getApiKey
  }
})

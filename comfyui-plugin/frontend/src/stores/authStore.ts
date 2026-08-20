import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { User } from 'firebase/auth'

import type { AuthHeader } from '@/types/authTypes'
import type { operations } from '@/types/comfyRegistryTypes'

export type BillingPortalTargetTier = string

export class AuthStoreError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'AuthStoreError'
    this.status = status
  }
}

type Customer =
  operations['createCustomer']['responses']['201']['content']['application/json']
type Balance = {
  amount_micros: number
  effective_balance_micros?: number
  prepaid_balance_micros?: number
  cloud_credit_balance_micros?: number
  currency?: string
}

const disabledError = () =>
  new AuthStoreError('Cloud authentication is disabled in the local build.')

export const useAuthStore = defineStore('auth', () => {
  const loading = ref(false)
  const currentUser = ref<User | null>(null)
  const isInitialized = ref(true)
  const customerCreated = ref(false)
  const balance = ref<Balance | null>(null)
  const lastBalanceUpdateTime = ref<Date | null>(null)
  const isFetchingBalance = ref(false)
  const tokenRefreshTrigger = ref(0)

  const isAuthenticated = computed(() => false)
  const userEmail = computed<string | undefined>(() => undefined)
  const userId = computed<string | undefined>(() => undefined)

  const getIdToken = async (): Promise<string | undefined> => undefined
  const getAuthHeader = async (): Promise<AuthHeader | null> => null
  const getFirebaseAuthHeader = async (): Promise<AuthHeader | null> => null
  const getAuthToken = async (): Promise<string | undefined> => undefined

  const getAuthHeaderOrThrow = async (): Promise<AuthHeader> => {
    throw disabledError()
  }

  const getFirebaseAuthHeaderOrThrow = async (): Promise<AuthHeader> => {
    throw disabledError()
  }

  const fetchWithCustomerRecovery = async (
    input: string,
    init?: RequestInit
  ): Promise<Response> => fetch(input, init)

  const createCustomer = async (..._args: unknown[]): Promise<Customer> => {
    throw disabledError()
  }

  const fetchBalance = async (): Promise<null> => {
    isFetchingBalance.value = false
    return null
  }

  const initiateCreditPurchase = async (..._args: unknown[]): Promise<never> => {
    throw disabledError()
  }

  const accessBillingPortal = async (..._args: unknown[]): Promise<never> => {
    throw disabledError()
  }

  const login = async (..._args: unknown[]): Promise<undefined> => {
    throw disabledError()
  }

  const register = async (..._args: unknown[]): Promise<undefined> => {
    throw disabledError()
  }

  const loginWithGoogle = async (..._args: unknown[]): Promise<undefined> => {
    throw disabledError()
  }

  const loginWithGithub = async (..._args: unknown[]): Promise<undefined> => {
    throw disabledError()
  }

  const sendPasswordReset = async (..._args: unknown[]): Promise<undefined> => {
    throw disabledError()
  }

  const updatePassword = async (..._args: unknown[]): Promise<undefined> => {
    throw disabledError()
  }

  const logout = async (): Promise<void> => {
    currentUser.value = null
    customerCreated.value = false
    balance.value = null
    lastBalanceUpdateTime.value = null
    tokenRefreshTrigger.value++
  }

  const notifyTokenRefreshed = (): void => {
    tokenRefreshTrigger.value++
  }

  return {
    loading,
    currentUser,
    isInitialized,
    customerCreated,
    balance,
    lastBalanceUpdateTime,
    isFetchingBalance,
    tokenRefreshTrigger,
    isAuthenticated,
    userEmail,
    userId,
    login,
    register,
    logout,
    createCustomer,
    fetchBalance,
    fetchWithCustomerRecovery,
    getIdToken,
    loginWithGoogle,
    loginWithGithub,
    initiateCreditPurchase,
    accessBillingPortal,
    sendPasswordReset,
    updatePassword,
    getAuthHeader,
    getAuthHeaderOrThrow,
    getFirebaseAuthHeader,
    getFirebaseAuthHeaderOrThrow,
    getAuthToken,
    notifyTokenRefreshed
  }
})

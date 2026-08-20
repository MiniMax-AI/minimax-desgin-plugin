import { ref } from 'vue'

import type { BillingPortalTargetTier } from '@/stores/authStore'

export const useAuthActions = () => {
  const accessError = ref(false)
  const reportError = (_error: unknown): void => {}

  const logout = async (): Promise<void> => {}
  const sendPasswordReset = async (_email: string): Promise<void> => {}
  const purchaseCredits = async (_amount: number): Promise<void> => {}
  const purchaseCreditsDirect = async (_amount: number): Promise<void> => {}
  const accessBillingPortal = async (
    _targetTier?: BillingPortalTargetTier,
    _openInNewTab = true
  ): Promise<boolean> => false
  const fetchBalance = async (): Promise<null> => null
  const signInWithGoogle = async (_options?: {
    isNewUser?: boolean
  }): Promise<undefined> => undefined
  const signInWithGithub = async (_options?: {
    isNewUser?: boolean
  }): Promise<undefined> => undefined
  const signInWithEmail = async (
    _email: string,
    _password: string
  ): Promise<undefined> => undefined
  const signUpWithEmail = async (
    _email: string,
    _password: string,
    _turnstileToken?: string
  ): Promise<undefined> => undefined
  const updatePassword = async (_newPassword: string): Promise<void> => {}

  return {
    logout,
    sendPasswordReset,
    purchaseCredits,
    purchaseCreditsDirect,
    accessBillingPortal,
    fetchBalance,
    signInWithGoogle,
    signInWithGithub,
    signInWithEmail,
    signUpWithEmail,
    updatePassword,
    accessError,
    reportError
  }
}

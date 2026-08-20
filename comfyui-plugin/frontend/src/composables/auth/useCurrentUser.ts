import { computed } from 'vue'
import type { AuthUserInfo } from '@/types/authTypes'

export const useCurrentUser = () => {
  const isLoggedIn = computed(() => false)
  const isApiKeyLogin = computed(() => false)
  const resolvedUserInfo = computed<AuthUserInfo | null>(() => null)
  const userDisplayName = computed<string | undefined>(() => undefined)
  const userEmail = computed<string | undefined>(() => undefined)
  const userPhotoUrl = computed<string | null>(() => null)
  const providerName = computed<string | undefined>(() => undefined)
  const providerIcon = computed(() => 'pi pi-user')
  const isEmailProvider = computed(() => false)

  const onUserResolved = (_callback: (user: AuthUserInfo) => void) => () => {}
  const onTokenRefreshed = (_callback: () => void) => () => {}
  const onUserLogout = (_callback: () => void) => () => {}
  const handleSignOut = async (): Promise<void> => {}
  const handleSignIn = async (): Promise<void> => {}

  return {
    loading: computed(() => false),
    isLoggedIn,
    isApiKeyLogin,
    isEmailProvider,
    userDisplayName,
    userEmail,
    userPhotoUrl,
    providerName,
    providerIcon,
    resolvedUserInfo,
    handleSignOut,
    handleSignIn,
    onUserResolved,
    onTokenRefreshed,
    onUserLogout
  }
}

import { computed, ref } from 'vue'
import { createSharedComposable } from '@vueuse/core'

import type { TierKey } from '@/platform/cloud/subscription/constants/tierPricing'
import type { SubscriptionDialogOptions } from '@/platform/cloud/subscription/composables/useSubscriptionDialog'
import type {
  PreviewSubscribeOptions,
  SubscribeOptions
} from '@/platform/workspace/api/workspaceApi'

import type {
  BalanceInfo,
  BillingContext,
  SubscriptionInfo
} from './types'

/**
 * Local-only billing facade.
 *
 * Billing, credits, subscriptions and checkout are cloud account features.
 * Keeping this inert facade preserves the public composable contract for
 * extensions while guaranteeing that a local instance never starts auth,
 * workspace or payment requests.
 */
function useBillingContextInternal(): BillingContext {
  const type = computed(() => 'legacy' as const)
  const isInitialized = ref(true)
  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const subscription = computed<SubscriptionInfo | null>(() => null)
  const balance = computed<BalanceInfo | null>(() => null)
  const plans = computed<never[]>(() => [])
  const currentPlanSlug = computed<string | null>(() => null)
  const teamCreditStops = computed<null>(() => null)
  const currentTeamCreditStop = computed<null>(() => null)
  const maxSeats = computed<number | null>(() => null)
  const occupiedSeats = computed<number | null>(() => null)
  const canAccessSubscriptionFeatures = computed(() => false)
  const isActiveSubscription = canAccessSubscriptionFeatures
  const isFreeTier = computed(() => false)
  // Local execution is never paywalled.
  const canRunWorkflows = computed(() => true)
  const isLegacyTeamPlan = computed(() => false)
  const isTeamPlan = computed(() => false)
  const billingStatus = computed<null>(() => null)
  const subscriptionStatus = computed<null>(() => null)
  const tier = computed<null>(() => null)
  const renewalDate = computed<null>(() => null)

  const initialize = async (): Promise<void> => {}
  const fetchStatus = async (): Promise<void> => {}
  const fetchBalance = async (): Promise<void> => {}
  const reconcileSubscriptionSuccess = async (): Promise<void> => {}
  const subscribe = async (_planSlug: string, _options?: SubscribeOptions): Promise<void> => {}
  const previewSubscribe = async (_planSlug: string, _options?: PreviewSubscribeOptions) => null
  const manageSubscription = async (): Promise<void> => {}
  const cancelSubscription = async (): Promise<void> => {}
  const resubscribe = async (): Promise<void> => {}
  const topup = async (_amountCents: number): Promise<void> => {}
  const fetchPlans = async (): Promise<void> => {}
  const requireActiveSubscription = async (): Promise<void> => {}
  const showSubscriptionDialog = (_options?: SubscriptionDialogOptions): void => {}
  const getMaxSeats = (_tierKey: TierKey): number => 0

  return {
    type,
    isInitialized,
    subscription,
    balance,
    plans,
    currentPlanSlug,
    teamCreditStops,
    currentTeamCreditStop,
    maxSeats,
    occupiedSeats,
    isLoading,
    error,
    isActiveSubscription,
    canRunWorkflows,
    canAccessSubscriptionFeatures,
    isFreeTier,
    isLegacyTeamPlan,
    isTeamPlan,
    billingStatus,
    subscriptionStatus,
    tier,
    renewalDate,
    getMaxSeats,
    initialize,
    fetchStatus,
    fetchBalance,
    reconcileSubscriptionSuccess,
    subscribe,
    previewSubscribe,
    manageSubscription,
    cancelSubscription,
    resubscribe,
    topup,
    fetchPlans,
    requireActiveSubscription,
    showSubscriptionDialog
  }
}

export const useBillingContext = createSharedComposable(useBillingContextInternal)

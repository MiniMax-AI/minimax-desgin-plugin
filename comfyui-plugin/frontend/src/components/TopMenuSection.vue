<template>
  <div
    v-if="!workspaceStore.focusMode"
    class="ml-1 flex flex-col gap-1 pt-2"
    @mouseenter="isTopMenuHovered = true"
    @mouseleave="isTopMenuHovered = false"
  >
    <div class="flex gap-x-0.5">
      <div class="min-w-0 flex-1">
        <SubgraphBreadcrumb />
      </div>

      <div class="mx-1 flex flex-col items-end gap-1">
        <div class="flex items-start gap-2">
          <div
            v-if="managerState.shouldShowManagerButtons.value || isCloud"
            class="pointer-events-auto flex h-12 shrink-0 items-center rounded-lg border border-interface-stroke bg-comfy-menu-bg px-2 shadow-interface"
          >
            <Button
              v-tooltip.bottom="customNodesManagerTooltipConfig"
              variant="secondary"
              :aria-label="t('menu.manageExtensions')"
              class="relative"
              @click="openCustomNodeManager"
            >
              <i class="icon-[comfy--extensions-blocks] size-4" />
              <span class="not-md:hidden">
                {{ t('menu.manageExtensions') }}
              </span>
              <span
                v-if="shouldShowRedDot"
                class="absolute top-0.5 right-1 size-2 rounded-full bg-red-500"
              />
            </Button>
          </div>

          <div
            class="pointer-events-auto z-1 flex flex-col rounded-lg border border-interface-stroke bg-comfy-menu-bg px-2 py-1.75 shadow-interface"
          >
            <div
              ref="actionbarContainerRef"
              class="actionbar-container relative flex items-start gap-2"
            >
              <ActionBarButtons />
              <!-- Support for legacy topbar elements attached by custom scripts, hidden if no elements present -->
              <div
                ref="legacyCommandsContainerRef"
                data-testid="legacy-topbar-container"
                class="[&:not(:has(*>*:not(:empty)))]:hidden"
              ></div>

              <ComfyActionbar
                :top-menu-container="actionbarContainerRef"
                :queue-overlay-expanded="isQueueOverlayExpanded"
              >
                <template #sidebar-toggle>
                  <div v-if="!isRightSidePanelOpen" class="relative">
                    <Button
                      v-tooltip.bottom="rightSidePanelTooltipConfig"
                      :class="
                        cn(
                          showErrorIndicatorOnPanelButton &&
                            'outline-1 outline-destructive-background'
                        )
                      "
                      variant="secondary"
                      size="icon"
                      :aria-label="t('rightSidePanel.togglePanel')"
                      data-testid="right-side-panel-toggle"
                      @click="openRightSidePanel"
                    >
                      <i class="icon-[lucide--panel-right] size-4" />
                    </Button>
                    <StatusBadge
                      v-if="showErrorIndicatorOnPanelButton"
                      variant="dot"
                      severity="danger"
                      class="absolute -top-1 -right-1"
                    />
                  </div>
                </template>
              </ComfyActionbar>
            </div>
          </div>
        </div>
        <ErrorOverlay />
        <QueueProgressOverlay
          v-if="isQueueProgressOverlayEnabled"
          v-model:expanded="isQueueOverlayExpanded"
          :menu-hovered="isTopMenuHovered"
        />
      </div>
    </div>

    <div class="flex flex-col items-end gap-1">
      <QueueInlineProgressSummary
        v-if="shouldShowInlineProgressSummary"
        class="pr-1"
        :hidden="shouldHideInlineProgressSummary"
      />
      <QueueNotificationBannerHost
        v-if="shouldShowQueueNotificationBanners"
        class="pr-1"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMutationObserver } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import ComfyActionbar from '@/components/actionbar/ComfyActionbar.vue'
import SubgraphBreadcrumb from '@/components/breadcrumb/SubgraphBreadcrumb.vue'
import QueueInlineProgressSummary from '@/components/queue/QueueInlineProgressSummary.vue'
import QueueNotificationBannerHost from '@/components/queue/QueueNotificationBannerHost.vue'
import QueueProgressOverlay from '@/components/queue/QueueProgressOverlay.vue'
import ErrorOverlay from '@/components/error/ErrorOverlay.vue'
import ActionBarButtons from '@/components/topbar/ActionBarButtons.vue'
import StatusBadge from '@/components/common/StatusBadge.vue'
import Button from '@/components/ui/button/Button.vue'
import { useQueueFeatureFlags } from '@/composables/queue/useQueueFeatureFlags'
import { useErrorHandling } from '@/composables/useErrorHandling'
import { buildTooltipConfig } from '@/composables/useTooltipConfig'
import { useSettingStore } from '@/platform/settings/settingStore'
import { useTelemetry } from '@/platform/telemetry'
import { app } from '@/scripts/app'
import { useExecutionErrorStore } from '@/stores/executionErrorStore'
import { useQueueUIStore } from '@/stores/queueStore'
import { useRightSidePanelStore } from '@/stores/workspace/rightSidePanelStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { isCloud } from '@/platform/distribution/types'
import { useConflictAcknowledgment } from '@/workbench/extensions/manager/composables/useConflictAcknowledgment'
import { useManagerState } from '@/workbench/extensions/manager/composables/useManagerState'
import { useManagerSurveyDialog } from '@/workbench/extensions/manager/composables/useManagerSurveyDialog'
import { ManagerTab } from '@/workbench/extensions/manager/types/comfyManagerTypes'
import { cn } from '@comfyorg/tailwind-utils'

const settingStore = useSettingStore()
const workspaceStore = useWorkspaceStore()
const rightSidePanelStore = useRightSidePanelStore()
const managerState = useManagerState()
const managerSurveyDialog = useManagerSurveyDialog()
const { t } = useI18n()
const { toastErrorHandler } = useErrorHandling()
const executionErrorStore = useExecutionErrorStore()
const queueUIStore = useQueueUIStore()
const { isOverlayExpanded: isQueueOverlayExpanded } = storeToRefs(queueUIStore)
const { shouldShowRedDot: shouldShowConflictRedDot } =
  useConflictAcknowledgment()
const isTopMenuHovered = ref(false)
const actionbarContainerRef = ref<HTMLElement>()
const { isQueuePanelV2Enabled, isRunProgressBarEnabled } =
  useQueueFeatureFlags()
const isQueueProgressOverlayEnabled = computed(
  () => !isQueuePanelV2Enabled.value
)
const shouldShowInlineProgressSummary = computed(
  () =>
    isQueuePanelV2Enabled.value &&
    isRunProgressBarEnabled.value
)
const shouldShowQueueNotificationBanners = computed(() => true)
const shouldHideInlineProgressSummary = computed(
  () => isQueueProgressOverlayEnabled.value && isQueueOverlayExpanded.value
)
const customNodesManagerTooltipConfig = computed(() =>
  buildTooltipConfig(t('menu.manageExtensions'))
)

const shouldShowRedDot = computed((): boolean => {
  return shouldShowConflictRedDot.value
})

const { hasAnyError, isErrorOverlayOpen } = storeToRefs(executionErrorStore)

const isErrorsTabEnabled = computed(() =>
  settingStore.get('Comfy.RightSidePanel.ShowErrorsTab')
)

const showErrorIndicatorOnPanelButton = computed(
  () =>
    isErrorsTabEnabled.value &&
    hasAnyError.value &&
    !isRightSidePanelOpen.value &&
    !isErrorOverlayOpen.value
)

// Right side panel toggle
const { isOpen: isRightSidePanelOpen } = storeToRefs(rightSidePanelStore)
const rightSidePanelTooltipConfig = computed(() =>
  buildTooltipConfig(t('rightSidePanel.togglePanel'))
)

function openRightSidePanel() {
  useTelemetry()?.trackUiButtonClicked({
    button_id: 'right_side_panel_opened',
    element_group: 'top_menu'
  })
  rightSidePanelStore.togglePanel()
}

// Maintain support for legacy topbar elements attached by custom scripts
const legacyCommandsContainerRef = ref<HTMLElement>()
const hasLegacyContent = ref(false)
let legacyContentCheckRafId: number | null = null

function checkLegacyContent() {
  const el = legacyCommandsContainerRef.value
  if (!el) {
    hasLegacyContent.value = false
    return
  }
  // Mirror the CSS: [&:not(:has(*>*:not(:empty)))]:hidden
  hasLegacyContent.value =
    el.querySelector(':scope > * > *:not(:empty)') !== null
}

function scheduleLegacyContentCheck() {
  if (legacyContentCheckRafId !== null) return

  legacyContentCheckRafId = requestAnimationFrame(() => {
    legacyContentCheckRafId = null
    checkLegacyContent()
  })
}

useMutationObserver(legacyCommandsContainerRef, scheduleLegacyContentCheck, {
  childList: true,
  subtree: true
})

onMounted(() => {
  if (legacyCommandsContainerRef.value) {
    app.menu.element.style.width = 'fit-content'
    legacyCommandsContainerRef.value.appendChild(app.menu.element)
    checkLegacyContent()
  }
})

onBeforeUnmount(() => {
  if (legacyContentCheckRafId === null) return

  cancelAnimationFrame(legacyContentCheckRafId)
  legacyContentCheckRafId = null
})

const openCustomNodeManager = async () => {
  if (isCloud) {
    managerSurveyDialog.show()
    return
  }
  try {
    await managerState.openManager({
      initialTab: ManagerTab.All,
      showToastOnLegacyError: false
    })
  } catch (error) {
    try {
      toastErrorHandler(error)
    } catch (toastError) {
      console.error(error)
      console.error(toastError)
    }
  }
}
</script>

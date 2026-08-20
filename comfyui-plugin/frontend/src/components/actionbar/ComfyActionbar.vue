<template>
  <div class="actionbar pointer-events-auto flex flex-col gap-1 select-none">
    <div class="flex items-center gap-1">
      <Button
        v-tooltip.bottom="cancelJobTooltipConfig"
        variant="destructive"
        size="icon"
        :disabled="isExecutionIdle"
        :aria-label="t('menu.interrupt')"
        @click="cancelCurrentJob"
      >
        <i class="icon-[lucide--x] size-4" />
      </Button>
      <Button
        v-tooltip.bottom="queueHistoryTooltipConfig"
        variant="secondary"
        size="md"
        :aria-pressed="
          isQueuePanelV2Enabled
            ? activeSidebarTabId === 'job-history'
            : queueOverlayExpanded
        "
        class="relative px-3"
        data-testid="queue-overlay-toggle"
        @click="toggleQueueOverlay"
        @contextmenu.stop.prevent="showQueueContextMenu"
      >
        <span class="text-sm font-normal tabular-nums">
          {{ activeJobsLabel }}
        </span>
        <StatusBadge
          v-if="activeJobsCount > 0"
          data-testid="active-jobs-indicator"
          variant="dot"
          class="pointer-events-none absolute -top-0.5 -right-0.5 animate-pulse"
        />
        <span class="sr-only">
          {{
            isQueuePanelV2Enabled
              ? t('sideToolbar.queueProgressOverlay.viewJobHistory')
              : t('sideToolbar.queueProgressOverlay.expandCollapsedQueue')
          }}
        </span>
      </Button>
      <slot name="sidebar-toggle" />
    </div>
    <ContextMenu ref="queueContextMenu" :model="queueContextMenuItems" />
  </div>

  <Teleport v-if="inlineProgressTarget" :to="inlineProgressTarget">
    <QueueInlineProgress
      :hidden="shouldHideInlineProgress"
      radius-class="rounded-[7px]"
      data-testid="queue-inline-progress"
    />
  </Teleport>
</template>

<script lang="ts" setup>
import { storeToRefs } from 'pinia'
import ContextMenu from 'primevue/contextmenu'
import type { MenuItem } from 'primevue/menuitem'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import StatusBadge from '@/components/common/StatusBadge.vue'
import QueueInlineProgress from '@/components/queue/QueueInlineProgress.vue'
import Button from '@/components/ui/button/Button.vue'
import { useQueueFeatureFlags } from '@/composables/queue/useQueueFeatureFlags'
import { buildTooltipConfig } from '@/composables/useTooltipConfig'
import { useCommandStore } from '@/stores/commandStore'
import { useExecutionStore } from '@/stores/executionStore'
import { useQueueStore } from '@/stores/queueStore'
import { useSidebarTabStore } from '@/stores/workspace/sidebarTabStore'

const { topMenuContainer, queueOverlayExpanded = false } = defineProps<{
  topMenuContainer?: HTMLElement | null
  queueOverlayExpanded?: boolean
}>()

const emit = defineEmits<{
  (event: 'update:progressTarget', target: HTMLElement | null): void
}>()

const commandStore = useCommandStore()
const executionStore = useExecutionStore()
const queueStore = useQueueStore()
const sidebarTabStore = useSidebarTabStore()
const { t, n } = useI18n()
const { isIdle: isExecutionIdle } = storeToRefs(executionStore)
const { activeJobsCount } = storeToRefs(queueStore)
const { activeSidebarTabId } = storeToRefs(sidebarTabStore)
const { isQueuePanelV2Enabled, isRunProgressBarEnabled } =
  useQueueFeatureFlags()

const inlineProgressTarget = computed(() => {
  if (!isQueuePanelV2Enabled.value || !isRunProgressBarEnabled.value) {
    return null
  }
  return topMenuContainer ?? null
})
const shouldHideInlineProgress = computed(
  () => !isQueuePanelV2Enabled.value && queueOverlayExpanded
)
watch(
  () => topMenuContainer,
  (target) => {
    emit('update:progressTarget', target ?? null)
  },
  { immediate: true }
)

const cancelJobTooltipConfig = computed(() =>
  buildTooltipConfig(t('menu.interrupt'))
)
const queueHistoryTooltipConfig = computed(() =>
  buildTooltipConfig(
    t(
      isQueuePanelV2Enabled.value
        ? 'sideToolbar.queueProgressOverlay.viewJobHistory'
        : 'sideToolbar.queueProgressOverlay.expandCollapsedQueue'
    )
  )
)
const activeJobsLabel = computed(() => {
  const count = activeJobsCount.value
  return t(
    'sideToolbar.queueProgressOverlay.activeJobsShort',
    { count: n(count) },
    count
  )
})
const queueContextMenu = ref<InstanceType<typeof ContextMenu> | null>(null)
const queueContextMenuItems = computed<MenuItem[]>(() => [
  {
    label: t('sideToolbar.queueProgressOverlay.clearQueueTooltip'),
    icon: 'icon-[lucide--list-x] text-destructive-background',
    class: '*:text-destructive-background',
    disabled: queueStore.pendingTasks.length === 0,
    command: () => {
      void handleClearQueue()
    }
  }
])

const cancelCurrentJob = async () => {
  if (isExecutionIdle.value) return
  await commandStore.execute('Comfy.Interrupt')
}
const toggleQueueOverlay = () => {
  if (isQueuePanelV2Enabled.value) {
    sidebarTabStore.toggleSidebarTab('job-history')
    return
  }
  commandStore.execute('Comfy.Queue.ToggleOverlay')
}
const showQueueContextMenu = (event: MouseEvent) => {
  queueContextMenu.value?.show(event)
}
const handleClearQueue = async () => {
  const pendingJobIds = queueStore.pendingTasks
    .map((task) => task.jobId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)

  await commandStore.execute('Comfy.ClearPendingTasks')
  executionStore.clearInitializationByJobIds(pendingJobIds)
}
</script>

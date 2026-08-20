<template>
  <div v-if="isHub" class="flex items-center gap-1 px-1">
    <Suspense>
      <ComfyRunButton
        v-coachmark="FIRST_RUN_COACH_IDS.runButton"
        :tooltip="t('hubWorkflowTopbar.runTooltip')"
      />
    </Suspense>
    <Button
      v-if="hasBoundWorkflow"
      v-tooltip.bottom="{
        value: t('hubWorkflowTopbar.updateTooltip'),
        showDelay: 600
      }"
      size="unset"
      class="h-8 gap-1.5 rounded-lg px-4 font-light"
      variant="secondary"
      :disabled="isSaving || !isModified"
      :aria-busy="isSaving || undefined"
      data-action-ui-id="hub-workflow-update-save"
      @click="handleUpdateWorkflow"
    >
      <i
        v-if="isSaving"
        class="pi pi-spin pi-spinner"
        aria-hidden="true"
      />
      <i
        v-else
        class="icon-[lucide--save-pen] size-4"
        aria-hidden="true"
      />
      {{ updateButtonLabel }}
    </Button>
    <Button
      v-tooltip.bottom="{
        value: t('hubWorkflowTopbar.saveAsTooltip'),
        showDelay: 600
      }"
      variant="secondary"
      size="unset"
      class="h-8 gap-1.5 rounded-lg px-4 font-light"
      :disabled="isSaving"
      @click="showSaveWorkflowCopyDialog"
    >
      <i class="icon-[lucide--plus] size-4" aria-hidden="true" />
      {{
        isTemplateWorkflow
          ? t('hubWorkflowTopbar.saveAsCopy')
          : t('hubWorkflowTopbar.saveAsNewWorkflow')
      }}
    </Button>
    <Button
      v-tooltip.bottom="{
        value: t('g.close'),
        showDelay: 600,
        pt: { text: { class: 'w-max whitespace-nowrap' } }
      }"
      variant="secondary"
      size="unset"
      class="h-8 rounded-lg px-2"
      :aria-label="t('g.close')"
      @click="requestFullscreenClose"
    >
      <i class="icon-[lucide--x] size-4" aria-hidden="true" />
    </Button>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import ComfyRunButton from '@/components/actionbar/ComfyRunButton'
import Button from '@/components/ui/button/Button.vue'
import { useErrorHandling } from '@/composables/useErrorHandling'
import { FIRST_RUN_COACH_IDS } from '@/platform/onboarding/onboardingTours'
import { vCoachmark } from '@/platform/onboarding/vCoachmark'
import { useToastStore } from '@/platform/updates/common/toastStore'
import { useWorkflowService } from '@/platform/workflow/core/services/workflowService'
import { readHubWorkflowAgentHint } from '@/platform/workflow/core/utils/hubWorkflowAgentHint'
import type { ComfyWorkflow } from '@/platform/workflow/management/stores/workflowStore'
import { useWorkflowStore } from '@/platform/workflow/management/stores/workflowStore'
import { useDialogStore } from '@/stores/dialogStore'

import HubSaveWorkflowCopyDialog from './HubSaveWorkflowCopyDialog.vue'

const { t } = useI18n()
const { toastErrorHandler } = useErrorHandling()
const dialogStore = useDialogStore()
const toastStore = useToastStore()
const workflowStore = useWorkflowStore()
const workflowService = useWorkflowService()
const isHub = window.parent !== window
const workflowId = ref<string | null>(null)
const isSaving = ref(false)
const hasSaveSucceeded = ref(false)

const hasBoundWorkflow = computed(
  () => workflowId.value !== null && workflowId.value !== 'empty'
)
const isTemplateWorkflow = computed(
  () => workflowId.value?.startsWith('template:') === true
)
const isModified = computed(
  () => workflowStore.activeWorkflow?.isModified === true
)
const updateButtonLabel = computed(() => {
  if (isSaving.value) return t('hubWorkflowTopbar.saving')
  if (hasSaveSucceeded.value) return t('hubWorkflowTopbar.saved')
  return t('hubWorkflowTopbar.updateWorkflow')
})

watch(isModified, (modified) => {
  if (modified) hasSaveSucceeded.value = false
})

const refreshBoundWorkflow = () => {
  workflowId.value =
    (window as unknown as { __COMFY_HUB_WORKFLOW_ID__?: string })
      .__COMFY_HUB_WORKFLOW_ID__ ?? null
}

onMounted(() => {
  refreshBoundWorkflow()
  window.addEventListener('hub-comfyui:workflow-ready', refreshBoundWorkflow)
  window.addEventListener('hub-comfyui:request-update-save', handleUpdateWorkflow)
})

onUnmounted(() => {
  window.removeEventListener('hub-comfyui:workflow-ready', refreshBoundWorkflow)
  window.removeEventListener(
    'hub-comfyui:request-update-save',
    handleUpdateWorkflow
  )
})

function getWorkflowName(workflow: ComfyWorkflow): string {
  const hubWorkflowName = (
    window as unknown as { __COMFY_HUB_WORKFLOW_NAME__?: string }
  ).__COMFY_HUB_WORKFLOW_NAME__?.trim()
  return (
    workflow.filename ||
    hubWorkflowName ||
    t('hubWorkflowTopbar.untitledWorkflow')
  )
}

function closeDialog(key: string) {
  dialogStore.closeDialog({ key })
}

function requestFullscreenClose() {
  window.dispatchEvent(new CustomEvent('hub-comfyui:request-close'))
}

function handleUpdateWorkflow() {
  const workflow = workflowStore.activeWorkflow
  if (!workflow || isSaving.value) return
  hasSaveSucceeded.value = false
  void updateWorkflow(workflow)
}

function showSaveWorkflowCopyDialog(
  selectedWorkflow = workflowStore.activeWorkflow
) {
  if (!selectedWorkflow || isSaving.value) return

  const workflowName = getWorkflowName(selectedWorkflow)
  dialogStore.showDialog({
    key: 'hub-save-workflow-copy',
    title: t('hubWorkflowTopbar.saveAsDialogTitle'),
    component: HubSaveWorkflowCopyDialog,
    props: {
      workflowName,
      defaultName: `${workflowName}${t('hubWorkflowTopbar.copySuffix')}`,
      defaultAgentHint: selectedWorkflow.activeState
        ? readHubWorkflowAgentHint(selectedWorkflow.activeState)
        : '',
      onCancel: () => closeDialog('hub-save-workflow-copy'),
      onConfirm: (name: string, agentHint: string) => {
        closeDialog('hub-save-workflow-copy')
        // The editor can finish restoring a Hub draft while this dialog is
        // open. Resolve the workflow at confirmation time so we never save a
        // stale startup workflow that has already been replaced.
        const currentWorkflow = workflowStore.activeWorkflow
        if (!currentWorkflow) return
        void saveWorkflowCopy(currentWorkflow, name, agentHint)
      }
    },
    dialogComponentProps: {
      renderer: 'reka',
      size: 'md'
    }
  })
}

async function updateWorkflow(workflow: ComfyWorkflow) {
  if (isSaving.value) return
  isSaving.value = true
  try {
    const saved = await workflowService.saveWorkflow(workflow)
    if (!saved) return
    hasSaveSucceeded.value = true
  } catch (error) {
    toastErrorHandler(error)
  } finally {
    isSaving.value = false
  }
}

async function saveWorkflowCopy(
  workflow: ComfyWorkflow,
  name: string,
  agentHint: string
) {
  if (isSaving.value) return
  isSaving.value = true
  try {
    const saved = await workflowService.saveWorkflowAs(workflow, {
      filename: name,
      agentHint
    })
    if (!saved) return
    toastStore.add({
      severity: 'success',
      summary: t('hubWorkflowTopbar.createdSuccess', { workflowName: name })
    })
  } catch (error) {
    toastErrorHandler(error)
  } finally {
    isSaving.value = false
  }
}
</script>

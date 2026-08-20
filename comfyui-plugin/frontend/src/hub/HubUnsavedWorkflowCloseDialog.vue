<template>
  <section class="m-2 mt-4 flex flex-col gap-6">
    <div class="flex flex-col gap-3 text-sm/6 text-base-foreground">
      <p>
        {{
          t('hubWorkflowCloseDialog.unsavedWarning', {
            workflowName
          })
        }}
      </p>
      <ul class="m-0 flex list-disc flex-col gap-1 pl-5 text-muted-foreground">
        <li v-if="canUpdate">
          {{
            t('hubWorkflowCloseDialog.updateExplanation', {
              workflowName
            })
          }}
        </li>
        <li>
          {{ t('hubWorkflowCloseDialog.saveAsExplanation') }}
        </li>
      </ul>
    </div>
    <div class="flex shrink-0 flex-wrap justify-end gap-2">
      <Button variant="secondary" @click="handleDecision('close')">
        {{ t('g.cancel') }}
      </Button>
      <Button
        v-if="canUpdate"
        autofocus
        variant="secondary"
        @click="handleDecision('save')"
      >
        {{ t('hubWorkflowTopbar.updateWorkflow') }}
      </Button>
      <Button
        :autofocus="!canUpdate"
        @click="handleDecision('saveAs')"
      >
        {{ t('hubWorkflowTopbar.saveAsNewWorkflow') }}
      </Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import Button from '@/components/ui/button/Button.vue'
import { useDialogStore } from '@/stores/dialogStore'

const { workflowName, canUpdate, onConfirm } = defineProps<{
  workflowName: string
  canUpdate: boolean
  onConfirm: (decision: 'save' | 'saveAs' | 'close' | null) => void
}>()

const { t } = useI18n()

function handleDecision(decision: 'save' | 'saveAs' | 'close' | null) {
  onConfirm(decision)
  useDialogStore().closeDialog()
}
</script>

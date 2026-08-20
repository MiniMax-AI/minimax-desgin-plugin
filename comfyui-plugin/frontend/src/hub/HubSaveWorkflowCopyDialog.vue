<template>
  <div class="flex flex-col gap-6 pt-2">
    <p class="text-sm/6 text-muted-foreground">
      {{ t('hubWorkflowTopbar.saveAsDialogDescription', { workflowName }) }}
    </p>
    <label class="flex flex-col gap-2 text-sm text-base-foreground">
      {{ t('hubWorkflowTopbar.workflowName') }}
      <Input
        v-model="workflowNameInput"
        autofocus
        @keyup.enter="handleConfirm"
      />
    </label>
    <label class="flex flex-col gap-2 text-sm text-base-foreground">
      {{ t('workflowService.agentHintPrompt') }}
      <Textarea
        v-model="agentHint"
        :maxlength="200"
        :placeholder="t('workflowService.agentHintPlaceholder')"
        rows="3"
      />
      <span class="self-end text-xs text-muted-foreground">
        {{ agentHint.length }}/200
      </span>
    </label>
    <div class="flex flex-wrap justify-end gap-2">
      <Button variant="secondary" @click="onCancel">
        {{ t('g.cancel') }}
      </Button>
      <Button :disabled="!workflowNameInput.trim()" @click="handleConfirm">
        {{ t('hubWorkflowTopbar.confirmCreate') }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Textarea from '@/components/ui/textarea/Textarea.vue'

const { workflowName, defaultName, defaultAgentHint, onCancel, onConfirm } =
  defineProps<{
    workflowName: string
    defaultName: string
    defaultAgentHint: string
    onCancel: () => void
    onConfirm: (name: string, agentHint: string) => void
  }>()

const { t } = useI18n()
const workflowNameInput = ref(defaultName)
const agentHint = ref(defaultAgentHint)

function handleConfirm() {
  const name = workflowNameInput.value.trim()
  if (!name) return
  onConfirm(name, agentHint.value)
}
</script>

<template>
  <div class="prompt-dialog-content flex flex-col gap-2 pt-8">
    <label class="flex flex-col gap-1 text-sm text-muted-foreground">
      {{ message }}
      <Input
        ref="inputRef"
        v-model="inputValue"
        type="text"
        :placeholder
        autofocus
        @keyup.enter="handleConfirm"
        @focus="inputRef?.selectAll()"
      />
    </label>
    <label
      v-if="secondaryMessage"
      class="flex flex-col gap-1 text-sm text-muted-foreground"
    >
      {{ secondaryMessage }}
      <Textarea
        v-model="secondaryValue"
        :maxlength="secondaryMaxLength"
        :placeholder="secondaryPlaceholder"
        rows="3"
      />
      <span
        v-if="secondaryMaxLength"
        class="self-end text-xs text-muted-foreground"
      >
        {{ secondaryValue.length }}/{{ secondaryMaxLength }}
      </span>
    </label>
    <Button @click="handleConfirm">
      {{ $t('g.confirm') }}
    </Button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'

import Button from '@/components/ui/button/Button.vue'
import Input from '@/components/ui/input/Input.vue'
import Textarea from '@/components/ui/textarea/Textarea.vue'
import { useDialogStore } from '@/stores/dialogStore'

const {
  message,
  defaultValue,
  onConfirm,
  placeholder,
  secondaryMessage,
  secondaryDefaultValue = '',
  secondaryPlaceholder,
  secondaryMaxLength
} = defineProps<{
  message: string
  defaultValue: string
  onConfirm: (value: string, secondaryValue?: string) => void
  placeholder?: string
  secondaryMessage?: string
  secondaryDefaultValue?: string
  secondaryPlaceholder?: string
  secondaryMaxLength?: number
}>()

const inputValue = ref<string>(defaultValue)
const secondaryValue = ref<string>(secondaryDefaultValue)

function handleConfirm() {
  if (secondaryMessage) onConfirm(inputValue.value, secondaryValue.value)
  else onConfirm(inputValue.value)
  useDialogStore().closeDialog()
}

const inputRef = ref<InstanceType<typeof Input>>()
</script>

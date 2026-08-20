import { render, screen, waitFor } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createI18n } from 'vue-i18n'

const mockSaveWorkflow = vi.hoisted(() => vi.fn())
const mockSaveWorkflowAs = vi.hoisted(() => vi.fn())
const mockShowDialog = vi.hoisted(() => vi.fn())
const mockCloseDialog = vi.hoisted(() => vi.fn())
const mockToastAdd = vi.hoisted(() => vi.fn())
const mockToastErrorHandler = vi.hoisted(() => vi.fn())
const mockRequestClose = vi.hoisted(() => vi.fn())

const mockActiveWorkflow = ref<{
  filename: string
  isModified: boolean
  activeState: null
} | null>(null)

vi.mock('@/components/actionbar/ComfyRunButton', () => ({
  default: { template: '<button type="button">运行</button>' }
}))

vi.mock('@/components/ui/button/Button.vue', () => ({
  default: {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: `
      <button
        type="button"
        :disabled="disabled || loading"
        :aria-busy="loading || undefined"
        @click="$emit('click')"
      >
        <slot />
      </button>
    `
  }
}))

vi.mock('@/composables/useErrorHandling', () => ({
  useErrorHandling: () => ({ toastErrorHandler: mockToastErrorHandler })
}))

vi.mock('@/platform/onboarding/onboardingTours', () => ({
  FIRST_RUN_COACH_IDS: { runButton: 'run-button' }
}))

vi.mock('@/platform/onboarding/vCoachmark', () => ({
  vCoachmark: {}
}))

vi.mock('@/platform/updates/common/toastStore', () => ({
  useToastStore: () => ({ add: mockToastAdd })
}))

vi.mock('@/platform/workflow/core/services/workflowService', () => ({
  useWorkflowService: () => ({
    saveWorkflow: mockSaveWorkflow,
    saveWorkflowAs: mockSaveWorkflowAs
  })
}))

vi.mock('@/platform/workflow/management/stores/workflowStore', () => ({
  useWorkflowStore: () => ({
    get activeWorkflow() {
      return mockActiveWorkflow.value
    }
  })
}))

vi.mock('@/stores/dialogStore', () => ({
  useDialogStore: () => ({
    showDialog: mockShowDialog,
    closeDialog: mockCloseDialog
  })
}))

vi.mock('./HubSaveWorkflowCopyDialog.vue', () => ({
  default: { template: '<div />' }
}))

const originalParent = window.parent
Object.defineProperty(window, 'parent', { configurable: true, value: {} })
const { default: HubWorkflowTopbarActions } = await import(
  './HubWorkflowTopbarActions.vue'
)

const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  messages: {
    zh: {
      g: { close: '关闭' },
      hubWorkflowTopbar: {
        updateWorkflow: '保存修改',
        saveAsCopy: '存为副本',
        saveAsNewWorkflow: '存为新工作流',
        updateTooltip: '更新原工作流',
        saveAsTooltip: '保存为新工作流，原工作流保持不变',
        runTooltip: '使用当前草稿直接运行',
        saving: '保存中',
        saved: '保存成功'
      }
    }
  }
})

describe('HubWorkflowTopbarActions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.addEventListener('hub-comfyui:request-close', mockRequestClose)
    mockActiveWorkflow.value = {
      filename: '模板 A',
      isModified: true,
      activeState: null
    }
    ;(
      window as unknown as { __COMFY_HUB_WORKFLOW_ID__?: string }
    ).__COMFY_HUB_WORKFLOW_ID__ = 'template:workflow-a'
  })

  afterEach(() => {
    window.removeEventListener('hub-comfyui:request-close', mockRequestClose)
  })

  afterAll(() => {
    Object.defineProperty(window, 'parent', {
      configurable: true,
      value: originalParent
    })
  })

  it('saves directly with loading and success feedback in the button', async () => {
    let resolveSave: ((value: boolean) => void) | undefined
    mockSaveWorkflow.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveSave = resolve
      })
    )
    const user = userEvent.setup()

    render(HubWorkflowTopbarActions, {
      global: { plugins: [i18n] }
    })

    const updateButton = await screen.findByRole('button', {
      name: '保存修改'
    })
    await user.click(updateButton)

    expect(mockSaveWorkflow).toHaveBeenCalledWith(mockActiveWorkflow.value)
    expect(mockShowDialog).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '保存中' })).toHaveAttribute(
      'aria-busy',
      'true'
    )

    mockActiveWorkflow.value = {
      ...mockActiveWorkflow.value!,
      isModified: false
    }
    resolveSave?.(true)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: '保存成功' })).toBeDisabled()
    })
    expect(mockToastAdd).not.toHaveBeenCalled()
  })

  it('handles update save requests from the Cmd+S command', async () => {
    mockSaveWorkflow.mockResolvedValueOnce(true)

    render(HubWorkflowTopbarActions, {
      global: { plugins: [i18n] }
    })

    window.dispatchEvent(new CustomEvent('hub-comfyui:request-update-save'))

    await waitFor(() => {
      expect(mockSaveWorkflow).toHaveBeenCalledWith(mockActiveWorkflow.value)
    })
  })

  it('requests fullscreen close from the topbar close button', async () => {
    const user = userEvent.setup()

    render(HubWorkflowTopbarActions, {
      global: { plugins: [i18n] }
    })

    await user.click(await screen.findByRole('button', { name: '关闭' }))

    expect(mockRequestClose).toHaveBeenCalledOnce()
  })

  it('uses the active workflow when confirming Save as New Workflow', async () => {
    mockSaveWorkflowAs.mockResolvedValueOnce(true)
    const user = userEvent.setup()

    render(HubWorkflowTopbarActions, {
      global: { plugins: [i18n] }
    })

    await user.click(
      await screen.findByRole('button', { name: '存为副本' })
    )
    const dialog = mockShowDialog.mock.calls[0][0]
    const restoredWorkflow = {
      filename: '已恢复工作流',
      isModified: true,
      activeState: null
    }
    mockActiveWorkflow.value = restoredWorkflow

    dialog.props.onConfirm('新工作流', '')

    await waitFor(() => {
      expect(mockSaveWorkflowAs).toHaveBeenCalledWith(restoredWorkflow, {
        filename: '新工作流',
        agentHint: ''
      })
    })
  })
})

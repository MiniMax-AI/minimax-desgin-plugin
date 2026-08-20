import { render, screen } from '@testing-library/vue'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'vue-component-type-helpers'
import { createI18n } from 'vue-i18n'

const mockCloseDialog = vi.hoisted(() => vi.fn())

vi.mock('@/stores/dialogStore', () => ({
  useDialogStore: () => ({ closeDialog: mockCloseDialog })
}))

import HubSaveWorkflowCopyDialog from './HubSaveWorkflowCopyDialog.vue'
import HubUnsavedWorkflowCloseDialog from './HubUnsavedWorkflowCloseDialog.vue'

const i18n = createI18n({
  legacy: false,
  locale: 'zh',
  messages: {
    zh: {
      g: { cancel: '取消' },
      hubWorkflowTopbar: {
        saveAsDialogDescription:
          '将当前草稿保存为一个新的工作流，原工作流「{workflowName}」不会被修改。',
        workflowName: '工作流名称',
        confirmCreate: '确认创建',
        updateWorkflow: '保存修改',
        saveAsNewWorkflow: '存为新工作流'
      },
      hubWorkflowCloseDialog: {
        unsavedWarning:
          '你已修改工作流「{workflowName}」。如果直接关闭，当前修改不会保存，可能导致工作流模板的本次修改丢失。',
        updateExplanation:
          '更新保存：使用当前草稿覆盖原工作流「{workflowName}」。',
        saveAsExplanation:
          '存为新工作流：保留原工作流，并将当前草稿创建为新的工作流。'
      }
    }
  },
  missingWarn: false,
  fallbackWarn: false
})

type SaveCopyDialogProps = ComponentProps<typeof HubSaveWorkflowCopyDialog>
type UnsavedCloseDialogProps = ComponentProps<
  typeof HubUnsavedWorkflowCloseDialog
>

describe('Hub workflow dialogs', () => {
  it('uses the requested default copy name and passes a trimmed name', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()

    render(HubSaveWorkflowCopyDialog, {
      global: { plugins: [i18n] },
      props: {
        workflowName: '模板 A',
        defaultName: '模板 A 副本',
        defaultAgentHint: '',
        onCancel: vi.fn(),
        onConfirm
      } satisfies SaveCopyDialogProps
    })

    const nameInput = screen.getByRole('textbox', { name: '工作流名称' })
    const agentHintInput = screen.getAllByRole('textbox')[1]
    expect(nameInput).toHaveValue('模板 A 副本')

    await user.clear(nameInput)
    await user.type(nameInput, '  新工作流  ')
    await user.type(agentHintInput, '生成商品图')
    await user.click(screen.getByRole('button', { name: '确认创建' }))

    expect(onConfirm).toHaveBeenCalledWith('新工作流', '生成商品图')
  })

  it('does not submit an empty workflow name', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()

    render(HubSaveWorkflowCopyDialog, {
      global: { plugins: [i18n] },
      props: {
        workflowName: '模板 A',
        defaultName: '',
        defaultAgentHint: '',
        onCancel: vi.fn(),
        onConfirm
      } satisfies SaveCopyDialogProps
    })

    const confirmButton = screen.getByRole('button', { name: '确认创建' })
    expect(confirmButton).toBeDisabled()

    await user.click(confirmButton)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('explains both save choices and returns the selected action', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()

    render(HubUnsavedWorkflowCloseDialog, {
      global: { plugins: [i18n] },
      props: {
        workflowName: '模板 A',
        canUpdate: true,
        onConfirm
      } satisfies UnsavedCloseDialogProps
    })

    expect(
      screen.getByText('你已修改工作流「模板 A」。如果直接关闭，当前修改不会保存，可能导致工作流模板的本次修改丢失。')
    ).toBeInTheDocument()
    expect(
      screen.getByText('更新保存：使用当前草稿覆盖原工作流「模板 A」。')
    ).toBeInTheDocument()
    expect(
      screen.getByText('存为新工作流：保留原工作流，并将当前草稿创建为新的工作流。')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '存为新工作流' }))

    expect(onConfirm).toHaveBeenCalledWith('saveAs')
  })

  it('closes fullscreen while retaining the unsaved draft on Cancel', async () => {
    const onConfirm = vi.fn()
    const user = userEvent.setup()
    mockCloseDialog.mockClear()

    render(HubUnsavedWorkflowCloseDialog, {
      global: { plugins: [i18n] },
      props: {
        workflowName: '模板 A',
        canUpdate: true,
        onConfirm
      } satisfies UnsavedCloseDialogProps
    })

    await user.click(screen.getByRole('button', { name: '取消' }))

    expect(onConfirm).toHaveBeenCalledWith('close')
    expect(mockCloseDialog).toHaveBeenCalledOnce()
  })

  it('hides update save when there is no original workflow to update', () => {
    render(HubUnsavedWorkflowCloseDialog, {
      global: { plugins: [i18n] },
      props: {
        workflowName: '未命名工作流',
        canUpdate: false,
        onConfirm: vi.fn()
      } satisfies UnsavedCloseDialogProps
    })

    expect(
      screen.queryByRole('button', { name: '保存修改' })
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: '存为新工作流' })
    ).toBeInTheDocument()
  })
})

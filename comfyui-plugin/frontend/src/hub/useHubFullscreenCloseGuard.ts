import { onMounted, onUnmounted } from 'vue'

import { t } from '@/i18n'
import { useToastStore } from '@/platform/updates/common/toastStore'
import { useWorkflowService } from '@/platform/workflow/core/services/workflowService'
import { useWorkflowStore } from '@/platform/workflow/management/stores/workflowStore'
import type { SaveBeforeCloseDecision } from '@/services/dialogService'
import { ChangeTracker } from '@/scripts/changeTracker'
import type { ComfyWorkflow } from '@/platform/workflow/management/stores/comfyWorkflow'
import { useDialogStore } from '@/stores/dialogStore'
import {
  clearRegisteredWorkflowDraft,
  flushWorkflowDraft
} from '@/hub/workflow-draft'
import { recordHubComfyDiagnostic } from '@/hub/hub-diagnostics'

import HubUnsavedWorkflowCloseDialog from './HubUnsavedWorkflowCloseDialog.vue'

interface HubFullscreenUi {
  enterFullscreen(): void
  exitFullscreen(): void
  onFullscreenChange(callback: (fullscreen: boolean) => void): () => void
}

interface HubFullscreenApi {
  ready: Promise<unknown>
  ui: HubFullscreenUi
}

interface HubFullscreenChangedPayload {
  kind: 'hub:event'
  topic: 'fullscreen:changed'
  payload: {
    fullscreen: boolean
  }
}

interface WaitForHubFullscreenApiOptions {
  getHub(): HubFullscreenApi | undefined
  isActive(): boolean
  intervalMs?: number
  timeoutMs?: number
}

const HUB_BRIDGE_WAIT_INTERVAL_MS = 50
const HUB_BRIDGE_WAIT_TIMEOUT_MS = 10_000

function summarizeWorkflowChangeState(workflow: ComfyWorkflow) {
  const tracker = workflow.changeTracker
  if (!tracker?.initialState || !tracker.activeState) {
    return {
      trackerPresent: Boolean(tracker),
      snapshotAvailable: false,
      isModified: workflow.isModified
    }
  }
  const initial = tracker.initialState
  const active = tracker.activeState
  return {
    trackerPresent: true,
    isModified: workflow.isModified,
    initialNodeCount: initial.nodes?.length ?? 0,
    activeNodeCount: active.nodes?.length ?? 0,
    initialLinkCount: initial.links?.length ?? 0,
    activeLinkCount: active.links?.length ?? 0,
    initialEqualsActive: ChangeTracker.graphEqual(initial, active)
  }
}

function getHubWorkflowName(workflow: ComfyWorkflow): string {
  const hubWorkflowName = (
    window as unknown as { __COMFY_HUB_WORKFLOW_NAME__?: string }
  ).__COMFY_HUB_WORKFLOW_NAME__?.trim()
  return hubWorkflowName || workflow.filename || workflow.path
}

function hasHubBoundWorkflow(): boolean {
  const workflowId = (
    window as unknown as { __COMFY_HUB_WORKFLOW_ID__?: string }
  ).__COMFY_HUB_WORKFLOW_ID__
  return Boolean(workflowId && workflowId !== 'empty')
}

export async function waitForHubFullscreenApi({
  getHub,
  isActive,
  intervalMs = HUB_BRIDGE_WAIT_INTERVAL_MS,
  timeoutMs = HUB_BRIDGE_WAIT_TIMEOUT_MS
}: WaitForHubFullscreenApiOptions): Promise<HubFullscreenApi | undefined> {
  const deadline = Date.now() + timeoutMs
  let hub = getHub()
  while (isActive() && !hub?.ui?.onFullscreenChange && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, intervalMs))
    hub = getHub()
  }
  return hub?.ui?.onFullscreenChange ? hub : undefined
}

export function getHubFullscreenState(message: unknown): boolean | undefined {
  if (!message || typeof message !== 'object') return
  const frame = message as Partial<HubFullscreenChangedPayload>
  if (frame.kind !== 'hub:event' || frame.topic !== 'fullscreen:changed') return
  const fullscreen = frame.payload?.fullscreen
  return typeof fullscreen === 'boolean' ? fullscreen : undefined
}

export function collectUnsavedWorkflows(
  activeWorkflow: ComfyWorkflow | null
): ComfyWorkflow[] {
  if (!activeWorkflow) return []
  // The tracker normally updates isModified asynchronously. Flush the active
  // canvas before checking it so an edit immediately followed by closing the
  // fullscreen is not mistaken for an untouched Hub template.
  const beforePrepare = summarizeWorkflowChangeState(activeWorkflow)
  activeWorkflow.changeTracker?.prepareForSave()
  const afterPrepare = summarizeWorkflowChangeState(activeWorkflow)
  recordHubComfyDiagnostic('fullscreen:dirty-state-evaluated', {
    beforePrepare,
    afterPrepare
  })

  // A Hub template starts as a temporary workflow, but its selected template
  // identity is already persisted on the launcher node. Closing an untouched
  // template can therefore safely reload it next time; only actual edits need
  // the save-before-close guard.
  return activeWorkflow.isModified ? [activeWorkflow] : []
}

type FullscreenCloseDecision = SaveBeforeCloseDecision | 'close'

interface FullscreenCloseGuardDependencies {
  hubUi: Pick<HubFullscreenUi, 'enterFullscreen' | 'exitFullscreen'>
  getUnsavedWorkflows(): ComfyWorkflow[]
  confirm(workflows: ComfyWorkflow[]): Promise<FullscreenCloseDecision>
  save(workflow: ComfyWorkflow): Promise<boolean>
  saveAs(workflow: ComfyWorkflow): Promise<boolean>
  onSaveError(error: unknown): void
}

interface HubFullscreenCloseController {
  handleFullscreenChange(fullscreen: boolean): Promise<void>
  requestClose(): Promise<void>
}

export function createHubFullscreenCloseController({
  hubUi,
  getUnsavedWorkflows,
  confirm,
  save,
  saveAs,
  onSaveError
}: FullscreenCloseGuardDependencies): HubFullscreenCloseController {
  let closeInFlight = false
  let allowNextClose = false

  const handleClose = async (hostAlreadyClosed: boolean) => {
    if (allowNextClose) {
      allowNextClose = false
      recordHubComfyDiagnostic('fullscreen:close-completed', {})
      return
    }
    if (closeInFlight) {
      recordHubComfyDiagnostic('fullscreen:close-ignored-in-flight', {})
      return
    }

    await flushWorkflowDraft()
    const workflows = getUnsavedWorkflows()
    recordHubComfyDiagnostic('fullscreen:close-checked', {
      unsavedWorkflowCount: workflows.length,
      workflows: workflows.map((workflow) => ({
        isModified: workflow.isModified,
        isTemporary: workflow.isTemporary
      }))
    })
    if (workflows.length === 0) {
      if (!hostAlreadyClosed) {
        allowNextClose = true
        hubUi.exitFullscreen()
      }
      return
    }

    closeInFlight = true
    if (hostAlreadyClosed) {
      // The host has already processed ESC/close. Re-enter immediately so the
      // iframe and the confirmation dialog remain visible during the decision.
      hubUi.enterFullscreen()
      recordHubComfyDiagnostic('fullscreen:close-reopened-for-confirmation', {})
    }
    try {
      const decision = await confirm(workflows)
      recordHubComfyDiagnostic('fullscreen:close-decision', {
        decision: decision ?? 'dismissed',
        unsavedWorkflowCount: workflows.length
      })
      if (decision === null) {
        // The host's fullscreen-close event can arrive after the dialog has
        // opened. Re-assert fullscreen after cancelling so that late event
        // cannot leave the editor closed behind a dismissed confirmation.
        hubUi.enterFullscreen()
        recordHubComfyDiagnostic('fullscreen:close-cancelled', {})
      } else if (decision === 'close') {
        // The draft was flushed before opening this dialog. Leave it intact so
        // the user can resume editing after reopening the fullscreen plugin.
        allowNextClose = true
        recordHubComfyDiagnostic('fullscreen:close-preserving-draft', {})
        hubUi.exitFullscreen()
      } else if (decision === 'discard') {
        await clearRegisteredWorkflowDraft()
        allowNextClose = true
        recordHubComfyDiagnostic('fullscreen:close-discarded', {})
        hubUi.exitFullscreen()
      } else if (decision === 'save' || decision === 'saveAs') {
        try {
          for (const workflow of workflows) {
            recordHubComfyDiagnostic('fullscreen:close-save-started', {
              decision,
              isModified: workflow.isModified,
              isTemporary: workflow.isTemporary
            })
            const saved = await (decision === 'save'
              ? save(workflow)
              : saveAs(workflow))
            // A cancelled Save As keeps the editor open without showing an
            // error, because the user explicitly chose not to finish saving.
            if (!saved) {
              recordHubComfyDiagnostic('fullscreen:close-save-cancelled', {
                decision
              })
              return
            }
            recordHubComfyDiagnostic('fullscreen:close-save-succeeded', {
              decision
            })
          }
          allowNextClose = true
          recordHubComfyDiagnostic('fullscreen:close-after-save', { decision })
          hubUi.exitFullscreen()
        } catch (error) {
          recordHubComfyDiagnostic('fullscreen:close-save-failed', {
            decision,
            message: error instanceof Error ? error.message : String(error)
          })
          onSaveError(error)
        }
      }
      // Unsaved workflows must stay open unless saving succeeds. Both the
      // Dismissing the dialog keeps the editor open; the Cancel button closes
      // fullscreen while retaining the already-persisted draft.
    } finally {
      closeInFlight = false
    }
  }

  return {
    handleFullscreenChange: async (fullscreen: boolean) => {
      recordHubComfyDiagnostic('fullscreen:changed', {
        fullscreen,
        closeInFlight,
        allowNextClose
      })
      if (fullscreen) return
      await handleClose(true)
    },
    requestClose: async () => {
      recordHubComfyDiagnostic('fullscreen:close-requested', {
        closeInFlight,
        allowNextClose
      })
      await handleClose(false)
    }
  }
}

export function useHubFullscreenCloseGuard() {
  const workflowStore = useWorkflowStore()
  const workflowService = useWorkflowService()
  const dialogStore = useDialogStore()
  const toastStore = useToastStore()
  let dispose: (() => void) | null = null
  let mounted = false

  onMounted(async () => {
    mounted = true
    const hub = await waitForHubFullscreenApi({
      getHub: () => window.hub as unknown as HubFullscreenApi | undefined,
      isActive: () => mounted
    })
    if (!hub || !mounted) return
    try {
      await hub.ready
    } catch {
      return
    }
    if (!mounted) return
    const closeController = createHubFullscreenCloseController({
      hubUi: hub.ui,
      getUnsavedWorkflows: () =>
        collectUnsavedWorkflows(workflowStore.activeWorkflow),
      confirm: (workflows) =>
        new Promise((resolve) => {
          const workflow = workflows[0]
          const workflowName = getHubWorkflowName(workflow)
          dialogStore.showDialog({
            key: 'hub-save-before-close',
            title: t('hubWorkflowCloseDialog.title', { workflowName }),
            component: HubUnsavedWorkflowCloseDialog,
            props: {
              workflowName,
              canUpdate: hasHubBoundWorkflow(),
              onConfirm: resolve
            },
            dialogComponentProps: {
              renderer: 'reka',
              size: 'md',
              onClose: () => resolve(null)
            }
          })
        }),
      save: (workflow) => workflowService.saveWorkflow(workflow),
      saveAs: (workflow) => workflowService.saveWorkflowAs(workflow),
      onSaveError: (error) => {
        console.error(
          '[ComfyUI] Failed to save workflow before fullscreen close',
          error
        )
        toastStore.add({
          severity: 'error',
          summary: t('g.error'),
          detail: t('toastMessages.failedToSaveDraft')
        })
      }
    })
    const handleHubMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return
      const fullscreen = getHubFullscreenState(event.data)
      if (fullscreen === undefined) return
      void closeController.handleFullscreenChange(fullscreen)
    }
    const handleCloseRequest = () => void closeController.requestClose()
    // Listen to the host event directly. The SDK cache can still be `false`
    // during a fast open-and-close, which causes its listener fan-out to drop
    // the host's closing `false` as a duplicate before this guard sees it.
    window.addEventListener('message', handleHubMessage)
    window.addEventListener('hub-comfyui:request-close', handleCloseRequest)
    dispose = () => {
      window.removeEventListener('message', handleHubMessage)
      window.removeEventListener(
        'hub-comfyui:request-close',
        handleCloseRequest
      )
    }
  })

  onUnmounted(() => {
    mounted = false
    dispose?.()
    dispose = null
  })
}

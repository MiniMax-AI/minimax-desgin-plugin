import { describe, expect, it, vi } from 'vitest'

import {
  collectUnsavedWorkflows,
  createHubFullscreenCloseController,
  getHubFullscreenState,
  waitForHubFullscreenApi
} from '@/hub/useHubFullscreenCloseGuard'
import type { ComfyWorkflow } from '@/platform/workflow/management/stores/comfyWorkflow'
import type { SaveBeforeCloseDecision } from '@/services/dialogService'

function makeGuard(options: {
  decision: SaveBeforeCloseDecision | 'close'
  saved?: boolean
  savedResults?: boolean[]
  savedAs?: boolean
  saveError?: unknown
  modified?: boolean
  temporary?: boolean
  workflowCount?: number
}) {
  const enterFullscreen = vi.fn()
  const exitFullscreen = vi.fn()
  const confirm = vi.fn().mockResolvedValue(options.decision)
  const savedResults = [...(options.savedResults ?? [])]
  const save = options.saveError
    ? vi.fn().mockRejectedValue(options.saveError)
    : vi
        .fn()
        .mockImplementation(
          async () => savedResults.shift() ?? options.saved ?? true
        )
  const saveAs = vi.fn().mockResolvedValue(options.savedAs ?? true)
  const onSaveError = vi.fn()
  const isUnsaved = options.modified ?? true
  const workflowCount = isUnsaved ? (options.workflowCount ?? 1) : 0
  const workflows = Array.from(
    { length: workflowCount },
    (_, index) =>
      ({
        isModified: options.modified ?? true,
        isTemporary: options.temporary ?? false,
        path: `workflows/test-${index + 1}.json`
      }) as ComfyWorkflow
  )
  const controller = createHubFullscreenCloseController({
    hubUi: { enterFullscreen, exitFullscreen },
    getUnsavedWorkflows: () => workflows,
    confirm,
    save,
    saveAs,
    onSaveError
  })
  return {
    handle: controller.handleFullscreenChange,
    requestClose: controller.requestClose,
    enterFullscreen,
    exitFullscreen,
    confirm,
    save,
    saveAs,
    onSaveError,
    workflows
  }
}

describe('createHubFullscreenCloseController', () => {
  it('keeps the editor visible, saves, then closes fullscreen', async () => {
    const guard = makeGuard({ decision: 'save' })

    await guard.handle(false)

    expect(guard.enterFullscreen).toHaveBeenCalledOnce()
    expect(guard.save).toHaveBeenCalledWith(guard.workflows[0])
    expect(guard.exitFullscreen).toHaveBeenCalledOnce()
  })

  it('asks before closing when the close request starts in the topbar', async () => {
    const guard = makeGuard({ decision: 'discard' })

    await guard.requestClose()

    expect(guard.confirm).toHaveBeenCalledWith(guard.workflows)
    expect(guard.enterFullscreen).not.toHaveBeenCalled()
    expect(guard.exitFullscreen).toHaveBeenCalledOnce()
  })

  it('records the close decision and save result for manual diagnosis', async () => {
    const diagnosticTarget = globalThis as typeof globalThis & {
      __hiloDiag?: Array<Record<string, unknown>>
    }
    diagnosticTarget.__hiloDiag = []
    const guard = makeGuard({ decision: 'save' })

    await guard.handle(false)

    expect(diagnosticTarget.__hiloDiag?.map((entry) => entry.event)).toEqual(
      expect.arrayContaining([
        'fullscreen:changed',
        'fullscreen:close-checked',
        'fullscreen:close-decision',
        'fullscreen:close-save-started',
        'fullscreen:close-save-succeeded',
        'fullscreen:close-after-save'
      ])
    )
  })

  it('keeps fullscreen open when Save As is cancelled', async () => {
    const guard = makeGuard({ decision: 'save', saved: false })

    await guard.handle(false)

    expect(guard.enterFullscreen).toHaveBeenCalledOnce()
    expect(guard.exitFullscreen).not.toHaveBeenCalled()
    expect(guard.onSaveError).not.toHaveBeenCalled()
  })

  it('closes an untouched temporary workflow without reopening fullscreen', async () => {
    const guard = makeGuard({
      decision: 'discard',
      modified: false,
      temporary: true
    })

    await guard.handle(false)

    expect(guard.enterFullscreen).not.toHaveBeenCalled()
    expect(guard.confirm).not.toHaveBeenCalled()
    expect(guard.exitFullscreen).not.toHaveBeenCalled()
  })

  it('saves every modified open workflow before closing', async () => {
    const guard = makeGuard({ decision: 'save', workflowCount: 3 })

    await guard.handle(false)

    expect(guard.confirm).toHaveBeenCalledWith(guard.workflows)
    expect(guard.save).toHaveBeenCalledTimes(3)
    expect(guard.exitFullscreen).toHaveBeenCalledOnce()
  })

  it('keeps fullscreen open when saving any modified workflow is cancelled', async () => {
    const guard = makeGuard({
      decision: 'save',
      workflowCount: 2,
      savedResults: [true, false]
    })

    await guard.handle(false)

    expect(guard.save).toHaveBeenCalledTimes(2)
    expect(guard.exitFullscreen).not.toHaveBeenCalled()
  })

  it('closes fullscreen without saving when the user discards changes', async () => {
    const guard = makeGuard({ decision: 'discard' })

    await guard.handle(false)

    expect(guard.confirm).toHaveBeenCalledOnce()
    expect(guard.save).not.toHaveBeenCalled()
    expect(guard.saveAs).not.toHaveBeenCalled()
    expect(guard.exitFullscreen).toHaveBeenCalledOnce()
  })

  it('closes fullscreen while keeping the draft when the user chooses Cancel', async () => {
    const guard = makeGuard({ decision: 'close' })

    await guard.handle(false)

    expect(guard.save).not.toHaveBeenCalled()
    expect(guard.saveAs).not.toHaveBeenCalled()
    expect(guard.exitFullscreen).toHaveBeenCalledOnce()
  })

  it('keeps fullscreen open when the confirmation is cancelled', async () => {
    const guard = makeGuard({ decision: null })

    await guard.handle(false)

    expect(guard.enterFullscreen).toHaveBeenCalledTimes(2)
    expect(guard.exitFullscreen).not.toHaveBeenCalled()
  })

  it('keeps fullscreen open and reports an error when saving fails', async () => {
    const error = new Error('save failed')
    const guard = makeGuard({ decision: 'save', saveError: error })

    await guard.handle(false)

    expect(guard.exitFullscreen).not.toHaveBeenCalled()
    expect(guard.onSaveError).toHaveBeenCalledWith(error)
  })

  it('closes directly when the workflow has no unsaved changes', async () => {
    const guard = makeGuard({ decision: 'save', modified: false })

    await guard.handle(false)

    expect(guard.enterFullscreen).not.toHaveBeenCalled()
    expect(guard.confirm).not.toHaveBeenCalled()
  })

  it('saves under a new name before closing when Save As is chosen', async () => {
    const guard = makeGuard({ decision: 'saveAs' })

    await guard.handle(false)

    expect(guard.save).not.toHaveBeenCalled()
    expect(guard.saveAs).toHaveBeenCalledWith(guard.workflows[0])
    expect(guard.exitFullscreen).toHaveBeenCalledOnce()
  })
})

describe('waitForHubFullscreenApi', () => {
  it('waits for the asynchronously injected Hub bridge', async () => {
    const hub = {
      ready: Promise.resolve(),
      ui: {
        enterFullscreen: vi.fn(),
        exitFullscreen: vi.fn(),
        onFullscreenChange: vi.fn()
      }
    }
    let attempts = 0

    const result = await waitForHubFullscreenApi({
      getHub: () => (++attempts > 1 ? hub : undefined),
      isActive: () => true,
      intervalMs: 0,
      timeoutMs: 100
    })

    expect(result).toBe(hub)
  })

  it('stops waiting after the editor unmounts', async () => {
    const result = await waitForHubFullscreenApi({
      getHub: () => undefined,
      isActive: () => false,
      intervalMs: 0,
      timeoutMs: 100
    })

    expect(result).toBeUndefined()
  })
})

describe('getHubFullscreenState', () => {
  it('reads raw fullscreen host events even when the SDK cache is stale', () => {
    expect(
      getHubFullscreenState({
        kind: 'hub:event',
        topic: 'fullscreen:changed',
        payload: { fullscreen: false }
      })
    ).toBe(false)
  })

  it('ignores unrelated host messages', () => {
    expect(
      getHubFullscreenState({
        kind: 'hub:event',
        topic: 'incoming',
        payload: null
      })
    ).toBeUndefined()
  })
})

describe('collectUnsavedWorkflows', () => {
  it('ignores an untouched temporary workflow', () => {
    const active = {
      isTemporary: true,
      isModified: false
    } as ComfyWorkflow

    expect(collectUnsavedWorkflows(active)).toEqual([])
  })

  it('includes a modified temporary workflow', () => {
    const active = {
      isTemporary: true,
      isModified: true
    } as ComfyWorkflow

    expect(collectUnsavedWorkflows(active)).toEqual([active])
  })

  it('flushes the active canvas before deciding whether to save', () => {
    const active = {
      isTemporary: true,
      isModified: false,
      changeTracker: {
        prepareForSave: vi.fn(() => {
          active.isModified = true
        })
      }
    } as unknown as ComfyWorkflow

    expect(collectUnsavedWorkflows(active)).toEqual([active])
    expect(active.changeTracker?.prepareForSave).toHaveBeenCalledOnce()
  })

  it('ignores hidden stale tabs by only evaluating the active workflow', () => {
    const active = {
      isTemporary: false,
      isModified: false
    } as ComfyWorkflow

    expect(collectUnsavedWorkflows(active)).toEqual([])
  })
})

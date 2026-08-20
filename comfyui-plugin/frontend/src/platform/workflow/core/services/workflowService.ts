import { toRaw } from 'vue'

import { downloadBlob } from '@/base/common/downloadUtil'
import { t } from '@/i18n'
import { LGraph, LGraphCanvas } from '@/lib/litegraph/src/litegraph'
import type { Point, SerialisableGraph } from '@/lib/litegraph/src/litegraph'
import { useSettingStore } from '@/platform/settings/settingStore'
import { useToastStore } from '@/platform/updates/common/toastStore'
import {
  normalizePendingWarnings,
  updatePendingWarnings
} from '@/platform/workflow/core/utils/pendingWarnings'
import {
  hasHubWorkflowAgentHint,
  readHubWorkflowAgentHint,
  setHubWorkflowAgentHint
} from '@/platform/workflow/core/utils/hubWorkflowAgentHint'
import { useWorkflowDraftStoreV2 } from '@/platform/workflow/persistence/stores/workflowDraftStoreV2'
import {
  ComfyWorkflow,
  useWorkflowStore
} from '@/platform/workflow/management/stores/workflowStore'
import { useTelemetry } from '@/platform/telemetry'
import type { ComfyWorkflowJSON } from '@/platform/workflow/validation/schemas/workflowSchema'
// eslint-disable-next-line import-x/no-restricted-paths
import { useWorkflowThumbnail } from '@/renderer/core/thumbnail/useWorkflowThumbnail'
import { app } from '@/scripts/app'
import { blankGraph, defaultGraph } from '@/scripts/defaultGraph'
import { useDialogService } from '@/services/dialogService'
import { useAppMode } from '@/composables/useAppMode'
import { useDomWidgetStore } from '@/stores/domWidgetStore'
import { useAppModeStore } from '@/stores/appModeStore'
import { useExecutionErrorStore } from '@/stores/executionErrorStore'
import { useSubgraphNavigationStore } from '@/stores/subgraphNavigationStore'
import { useMissingNodesErrorStore } from '@/platform/nodeReplacement/missingNodesErrorStore'
import { useMissingModelStore } from '@/platform/missingModel/missingModelStore'
import { useMissingMediaStore } from '@/platform/missingMedia/missingMediaStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import {
  appendJsonExt,
  appendWorkflowJsonExt,
  generateUUID
} from '@/utils/formatUtil'
import type { AppMode } from '@/utils/appMode'
import { hubBackendOrigin } from '@/hub/backend-origin'
import { recordHubComfyDiagnostic } from '@/hub/hub-diagnostics'
import { resolveUniqueHubWorkflowPath } from '@/hub/hubWorkflowName'
import {
  syncExecutableWorkflowToHub,
  syncSavedWorkflowToCanvas
} from '@/hub/workflow-node-sync'

function linearModeToAppMode(linearMode: unknown): AppMode | null {
  if (typeof linearMode !== 'boolean') return null
  return linearMode ? 'app' : 'graph'
}

function isHubTemplateWorkflow(workflow: ComfyWorkflow): boolean {
  return (
    hubBackendOrigin() !== null &&
    workflow.isTemporary &&
    (window as unknown as { __COMFY_HUB_WORKFLOW_SOURCE__?: string })
      .__COMFY_HUB_WORKFLOW_SOURCE__ === 'template'
  )
}

function recordHubWorkflowSaveDiagnostic(
  event: string,
  workflow: ComfyWorkflow,
  details: Record<string, unknown> = {}
): void {
  if (hubBackendOrigin() === null) return
  recordHubComfyDiagnostic(event, {
    isModified: workflow.isModified,
    isTemporary: workflow.isTemporary,
    ...details
  })
}

export const useWorkflowService = () => {
  const settingStore = useSettingStore()
  const workflowStore = useWorkflowStore()
  const toastStore = useToastStore()
  const dialogService = useDialogService()
  const workflowThumbnail = useWorkflowThumbnail()
  const domWidgetStore = useDomWidgetStore()
  const missingNodesErrorStore = useMissingNodesErrorStore()
  const workflowDraftStore = useWorkflowDraftStoreV2()

  const getCollectionSize = (value: unknown): number => {
    if (Array.isArray(value)) return value.length
    if (value && typeof value === 'object') return Object.keys(value).length
    return 0
  }

  const summarizeWorkflowGraph = (workflow: ComfyWorkflow) => {
    const state = workflow.activeState as
      | { nodes?: unknown; links?: unknown }
      | undefined
    return {
      isActive: workflowStore.activeWorkflow === workflow,
      isLoaded: workflow.isLoaded,
      rootGraphNodeCount: getCollectionSize(app.rootGraph?._nodes),
      rootGraphLinkCount: getCollectionSize(app.rootGraph?.links),
      workflowStateNodeCount: getCollectionSize(state?.nodes),
      workflowStateLinkCount: getCollectionSize(state?.links)
    }
  }

  const showFailedToSaveDraftToast = () => {
    toastStore.add({
      severity: 'error',
      summary: t('g.error'),
      detail: t('toastMessages.failedToSaveDraft')
    })
  }

  const syncSavedWorkflowToNode = async (
    workflow: ComfyWorkflow,
    syncCanvasIdentity: boolean
  ) => {
    await syncSavedWorkflowToCanvas(workflow, { syncCanvasIdentity })
  }

  type ExecutableWorkflowSnapshot = Awaited<
    ReturnType<typeof app.graphToPrompt>
  >

  const buildExecutableWorkflowSnapshot =
    async (): Promise<ExecutableWorkflowSnapshot | null> => {
      if (hubBackendOrigin() === null) return null
      try {
        return await app.graphToPrompt()
      } catch (error) {
        console.error(
          '[ComfyUI] Failed to build executable workflow snapshot for Hub',
          error
        )
        return null
      }
    }

  const syncSavedWorkflowToHub = async (
    workflow: ComfyWorkflow,
    snapshot: ExecutableWorkflowSnapshot | null,
    options: { syncCanvasIdentity: boolean }
  ) => {
    await Promise.all([
      syncSavedWorkflowToNode(workflow, options.syncCanvasIdentity),
      snapshot
        ? syncExecutableWorkflowToHub(workflow, snapshot).catch((error) => {
            console.error(
              '[ComfyUI] Failed to save executable workflow snapshot to Hub',
              error
            )
          })
        : Promise.resolve()
    ])
  }

  const persistActiveWorkflowDraft = (activeWorkflow: ComfyWorkflow) => {
    if (!settingStore.get('Comfy.Workflow.Persist') || !activeWorkflow.path) {
      return
    }

    const activeState = activeWorkflow.activeState
    if (!activeState) return

    try {
      const saved = workflowDraftStore.saveDraft(
        activeWorkflow.path,
        JSON.stringify(activeState),
        {
          name: activeWorkflow.key,
          isTemporary: activeWorkflow.isTemporary
        }
      )

      if (!saved) {
        showFailedToSaveDraftToast()
      }
    } catch (err) {
      console.error('Failed to persist active workflow draft', err)
      showFailedToSaveDraftToast()
    }
  }

  function confirmOverwrite(targetPath: string) {
    return dialogService.confirm({
      title: t('sideToolbar.workflowTab.confirmOverwriteTitle'),
      type: 'overwrite',
      message: t('sideToolbar.workflowTab.confirmOverwrite'),
      itemList: [targetPath]
    })
  }

  async function getFilename(defaultName: string): Promise<string | null> {
    if (settingStore.get('Comfy.PromptFilename')) {
      let filename = await dialogService.prompt({
        title: t('workflowService.exportWorkflow'),
        message: t('workflowService.enterFilenamePrompt'),
        defaultValue: defaultName
      })
      if (!filename) return null
      if (!filename.toLowerCase().endsWith('.json')) {
        filename += '.json'
      }
      return filename
    }
    return defaultName
  }

  /**
   * Adds scale and offset from litegraph canvas to the workflow JSON.
   * @param workflow The workflow to add the view restore data to
   */
  function addViewRestore(workflow: ComfyWorkflowJSON) {
    if (!settingStore.get('Comfy.EnableWorkflowViewRestore')) return

    const { offset, scale } = app.canvas.ds
    const [x, y] = offset

    workflow.extra ??= {}
    workflow.extra.ds = { scale, offset: [x, y] }
  }

  /**
   * Export the current workflow as a JSON file
   * @param filename The filename to save the workflow as
   * @param promptProperty The property of the prompt to export
   */
  const exportWorkflow = async (
    filename: string,
    promptProperty: 'workflow' | 'output'
  ): Promise<void> => {
    const workflow = workflowStore.activeWorkflow
    if (workflow?.path) {
      filename = workflow.filename
    }
    const p = await app.graphToPrompt()

    addViewRestore(p.workflow)
    const json = JSON.stringify(p[promptProperty], null, 2)
    const blob = new Blob([json], { type: 'application/json' })
    const file = await getFilename(filename)
    if (!file) return
    downloadBlob(file, blob)
  }

  const editHubWorkflowAgentHint = async (
    workflow: ComfyWorkflow
  ): Promise<boolean> => {
    if (hubBackendOrigin() === null) return false

    const value = await dialogService.prompt({
      title: t('workflowService.agentHintTitle'),
      message: t('workflowService.agentHintPrompt'),
      defaultValue: workflow.activeState
        ? readHubWorkflowAgentHint(workflow.activeState)
        : ''
    })
    if (value === null) return false

    if (workflow.activeState) {
      setHubWorkflowAgentHint(workflow.activeState, value)
    }
    setHubWorkflowAgentHint(app.rootGraph, value)
    return true
  }

  const promptSaveWorkflow = async (
    workflow: ComfyWorkflow
  ): Promise<string | null> => {
    if (
      hubBackendOrigin() === null ||
      !workflow.activeState ||
      hasHubWorkflowAgentHint(workflow.activeState)
    ) {
      return await workflow.promptSave()
    }

    const result = await dialogService.promptWithSecondary({
      title: t('workflowService.saveWorkflow'),
      message: t('workflowService.enterFilenamePrompt'),
      defaultValue: workflow.filename,
      secondaryMessage: t('workflowService.agentHintPrompt'),
      secondaryDefaultValue: '',
      secondaryPlaceholder: t('workflowService.agentHintPlaceholder'),
      secondaryMaxLength: 200
    })
    if (result === null) return null

    setHubWorkflowAgentHint(workflow.activeState, result.secondaryValue)
    setHubWorkflowAgentHint(app.rootGraph, result.secondaryValue)
    return result.value
  }

  /**
   * Save a workflow as a new file
   * @param workflow The workflow to save
   * @param options.filename Pre-supplied filename (skips the prompt dialog)
   */
  const saveWorkflowAs = async (
    workflow: ComfyWorkflow,
    options: { filename?: string; isApp?: boolean; agentHint?: string } = {}
  ): Promise<boolean> => {
    recordHubWorkflowSaveDiagnostic('workflow:save-as-started', workflow, {
      hasProvidedFilename: options.filename !== undefined,
      isApp: options.isApp,
      ...summarizeWorkflowGraph(workflow)
    })
    const newFilename = options.filename ?? (await promptSaveWorkflow(workflow))
    if (!newFilename) {
      recordHubWorkflowSaveDiagnostic('workflow:save-as-cancelled', workflow, {
        stage: 'filename'
      })
      return false
    }

    if (hubBackendOrigin() !== null && workflow.activeState) {
      if (options.agentHint !== undefined) {
        setHubWorkflowAgentHint(workflow.activeState, options.agentHint)
        setHubWorkflowAgentHint(app.rootGraph, options.agentHint)
      } else if (!hasHubWorkflowAgentHint(workflow.activeState)) {
        await editHubWorkflowAgentHint(workflow)
      }
    }

    const isApp = options.isApp ?? workflow.initialMode === 'app'
    let newPath =
      workflow.directory + '/' + appendWorkflowJsonExt(newFilename, isApp)
    if (isHubTemplateWorkflow(workflow)) {
      newPath = resolveUniqueHubWorkflowPath(newPath, (candidate) => {
        const candidateWorkflow = workflowStore.getWorkflowByPath(candidate)
        return !!candidateWorkflow && candidateWorkflow !== workflow
      })
    }
    const existingWorkflow = workflowStore.getWorkflowByPath(newPath)

    const isSelfOverwrite =
      existingWorkflow?.path === workflow.path && !existingWorkflow?.isTemporary

    if (existingWorkflow && !existingWorkflow.isTemporary) {
      if ((await confirmOverwrite(newPath)) !== true) {
        recordHubWorkflowSaveDiagnostic(
          'workflow:save-as-cancelled',
          workflow,
          {
            stage: 'overwrite-confirmation'
          }
        )
        return false
      }

      if (!isSelfOverwrite) {
        const deleted = await deleteWorkflow(existingWorkflow, true)
        if (!deleted) {
          recordHubWorkflowSaveDiagnostic(
            'workflow:save-as-cancelled',
            workflow,
            {
              stage: 'replace-existing'
            }
          )
          return false
        }
      }
    }

    let savedWorkflow = workflow
    let executableSnapshot: ExecutableWorkflowSnapshot | null
    if (isSelfOverwrite) {
      recordHubWorkflowSaveDiagnostic(
        'workflow:save-as-self-overwrite',
        workflow,
        {
          ...summarizeWorkflowGraph(workflow)
        }
      )
      workflow.changeTracker?.prepareForSave()
      executableSnapshot = await buildExecutableWorkflowSnapshot()
      // Call workflowStore.saveWorkflow directly: saveWorkflowAs emits its own is_new:true event below, so delegating to saveWorkflow() would also fire is_new:false and run prepareForSave a second time.
      await workflowStore.saveWorkflow(workflow)
    } else {
      let target: ComfyWorkflow
      if (workflow.isTemporary) {
        await renameWorkflow(workflow, newPath)
        target = workflow
        recordHubWorkflowSaveDiagnostic(
          'workflow:save-as-temporary-renamed',
          target,
          {
            ...summarizeWorkflowGraph(target)
          }
        )
      } else {
        // Take the canvas snapshot before cloning. Hub keeps the original
        // workflow active while a copy is saved, so the copy cannot rely on
        // an activation cycle to populate its ChangeTracker state.
        workflow.changeTracker?.prepareForSave()
        target = workflowStore.saveAs(workflow, newPath)
        await target.load()
        recordHubWorkflowSaveDiagnostic(
          'workflow:save-as-copy-created',
          target,
          {
            sourceIsStillActive: workflowStore.activeWorkflow === workflow,
            ...summarizeWorkflowGraph(target)
          }
        )
        await openWorkflow(target)
        recordHubWorkflowSaveDiagnostic(
          'workflow:save-as-copy-opened',
          target,
          {
            sourceIsStillActive: workflowStore.activeWorkflow === workflow,
            ...summarizeWorkflowGraph(target)
          }
        )
      }

      if (options.isApp !== undefined) {
        app.rootGraph.extra ??= {}
        app.rootGraph.extra.linearMode = isApp
        target.initialMode = isApp ? 'app' : 'graph'
      }
      target.changeTracker?.prepareForSave()
      executableSnapshot = await buildExecutableWorkflowSnapshot()
      recordHubWorkflowSaveDiagnostic(
        'workflow:save-as-before-persist',
        target,
        {
          ...summarizeWorkflowGraph(target),
          snapshotWorkflowNodeCount: getCollectionSize(
            executableSnapshot?.workflow?.nodes
          ),
          snapshotWorkflowLinkCount: getCollectionSize(
            executableSnapshot?.workflow?.links
          )
        }
      )
      await workflowStore.saveWorkflow(target)
      recordHubWorkflowSaveDiagnostic('workflow:save-as-persisted', target, {
        ...summarizeWorkflowGraph(target)
      })
      savedWorkflow = target
    }

    useTelemetry()?.trackWorkflowSaved({ is_app: isApp, is_new: true })
    await syncSavedWorkflowToHub(savedWorkflow, executableSnapshot, {
      syncCanvasIdentity: true
    })
    recordHubWorkflowSaveDiagnostic(
      'workflow:save-as-succeeded',
      savedWorkflow,
      {
        ...summarizeWorkflowGraph(savedWorkflow)
      }
    )
    return true
  }

  /**
   * Save a workflow
   * @param workflow The workflow to save
   */
  const saveWorkflow = async (workflow: ComfyWorkflow): Promise<boolean> => {
    recordHubWorkflowSaveDiagnostic('workflow:save-started', workflow, {})
    if (workflow.isTemporary) {
      recordHubWorkflowSaveDiagnostic(
        'workflow:save-routed-to-save-as',
        workflow,
        {}
      )
      return await saveWorkflowAs(workflow)
    }

    workflow.changeTracker?.prepareForSave()
    const executableSnapshot = await buildExecutableWorkflowSnapshot()
    const isApp = workflow.initialMode === 'app'
    const expectedPath =
      workflow.directory + '/' + appendWorkflowJsonExt(workflow.filename, isApp)
    if (workflow.path !== expectedPath) {
      const existing = workflowStore.getWorkflowByPath(expectedPath)
      if (existing && !existing.isTemporary) {
        if ((await confirmOverwrite(expectedPath)) !== true) {
          await workflowStore.saveWorkflow(workflow)
          await syncSavedWorkflowToHub(workflow, executableSnapshot, {
            syncCanvasIdentity: false
          })
          recordHubWorkflowSaveDiagnostic('workflow:save-succeeded', workflow, {
            identitySynced: false,
            reason: 'rename-conflict-not-replaced'
          })
          return true
        }
        await deleteWorkflow(existing, true)
      }
      await renameWorkflow(workflow, expectedPath)
      toastStore.add({
        severity: 'info',
        summary: t(
          isApp
            ? 'workflowService.savedAsApp'
            : 'workflowService.savedAsWorkflow'
        ),
        life: 3000
      })
    }

    await workflowStore.saveWorkflow(workflow)
    useTelemetry()?.trackWorkflowSaved({ is_app: isApp, is_new: false })
    await syncSavedWorkflowToHub(workflow, executableSnapshot, {
      syncCanvasIdentity: false
    })
    recordHubWorkflowSaveDiagnostic('workflow:save-succeeded', workflow, {
      identitySynced: false
    })
    return true
  }

  /**
   * Load the default workflow
   */
  const loadDefaultWorkflow = async () => {
    if (hubBackendOrigin() !== null && workflowStore.activeWorkflow) return
    await app.loadGraphData(defaultGraph)
  }

  /**
   * Load a blank workflow
   */
  const loadBlankWorkflow = async () => {
    if (hubBackendOrigin() !== null && workflowStore.activeWorkflow) return
    await app.loadGraphData(blankGraph)
  }

  /**
   * Reload the current workflow
   * This is used to refresh the node definitions update, e.g. when the locale changes.
   */
  const reloadCurrentWorkflow = async () => {
    const workflow = workflowStore.activeWorkflow
    if (workflow) {
      await openWorkflow(workflow, { force: true })
    }
  }

  /**
   * Open a workflow in the current workspace
   * @param workflow The workflow to open
   * @param options The options for opening the workflow
   */
  const openWorkflow = async (
    workflow: ComfyWorkflow,
    options: { force: boolean } = { force: false }
  ) => {
    recordHubWorkflowSaveDiagnostic('workflow:open-requested', workflow, {
      force: options.force,
      ...summarizeWorkflowGraph(workflow)
    })
    // A Hub iframe represents exactly one canvas node. Opening another
    // workflow from a sidebar/menu must not create a second tab.
    if (
      hubBackendOrigin() !== null &&
      workflowStore.activeWorkflow &&
      !workflowStore.isActive(workflow)
    ) {
      recordHubWorkflowSaveDiagnostic(
        'workflow:open-skipped-other-active',
        workflow,
        {
          ...summarizeWorkflowGraph(workflow)
        }
      )
      return
    }
    if (workflowStore.isActive(workflow) && !options.force) {
      recordHubWorkflowSaveDiagnostic(
        'workflow:open-skipped-already-active',
        workflow,
        {
          ...summarizeWorkflowGraph(workflow)
        }
      )
      return
    }

    const loadFromRemote = !workflow.isLoaded
    if (loadFromRemote) {
      await workflow.load()
      recordHubWorkflowSaveDiagnostic('workflow:open-loaded', workflow, {
        ...summarizeWorkflowGraph(workflow)
      })
    }

    await app.loadGraphData(
      toRaw(workflow.activeState) as ComfyWorkflowJSON,
      /* clean=*/ true,
      /* restore_view=*/ true,
      workflow,
      {
        checkForRerouteMigration: false,
        deferWarnings: true,
        skipAssetScans: !loadFromRemote && !options.force
      }
    )
    recordHubWorkflowSaveDiagnostic('workflow:open-rendered', workflow, {
      ...summarizeWorkflowGraph(workflow)
    })
    showPendingWarnings(undefined, {
      silent: !loadFromRemote && !options.force
    })
  }

  /**
   * Close a workflow with confirmation if there are unsaved changes
   * @param workflow The workflow to close
   * @returns true if the workflow was closed, false if the user cancelled
   */
  const closeWorkflow = async (
    workflow: ComfyWorkflow,
    options: { warnIfUnsaved: boolean; hint?: string } = {
      warnIfUnsaved: true
    }
  ): Promise<boolean> => {
    if (workflow.isModified && options.warnIfUnsaved) {
      const decision = await dialogService.confirmSaveBeforeClose({
        title: t('sideToolbar.workflowTab.dirtyCloseTitle'),
        type: 'saveBeforeClose',
        message: t('sideToolbar.workflowTab.dirtyClose'),
        itemList: [workflow.path],
        hint: options.hint
      })
      // Cancel
      if (decision === null) return false

      if (decision === 'save' || decision === 'saveAs') {
        const saved = await (decision === 'save'
          ? saveWorkflow(workflow)
          : saveWorkflowAs(workflow))
        if (!saved) return false
      }
    }

    workflowDraftStore.removeDraft(workflow.path)

    // If this is the last workflow, create a new default temporary workflow
    if (workflowStore.openWorkflows.length === 1) {
      await loadDefaultWorkflow()
    }
    // If this is the active workflow, load the most recent workflow from history
    if (workflowStore.isActive(workflow)) {
      const mostRecentWorkflow = workflowStore.getMostRecentWorkflow()
      if (mostRecentWorkflow) {
        await openWorkflow(mostRecentWorkflow)
      } else {
        // Fallback to next workflow if no history
        await loadNextOpenedWorkflow()
      }
    }

    await workflowStore.closeWorkflow(workflow)
    return true
  }

  const renameWorkflow = async (workflow: ComfyWorkflow, newPath: string) => {
    await workflowStore.renameWorkflow(workflow, newPath)
  }

  /**
   * Delete a workflow
   * @param workflow The workflow to delete
   * @returns `true` if the workflow was deleted, `false` if the user cancelled
   */
  const deleteWorkflow = async (
    workflow: ComfyWorkflow,
    silent = false
  ): Promise<boolean> => {
    const bypassConfirm = !settingStore.get('Comfy.Workflow.ConfirmDelete')
    let confirmed: boolean | null = bypassConfirm || silent

    if (!confirmed) {
      confirmed = await dialogService.confirm({
        title: t('sideToolbar.workflowTab.confirmDeleteTitle'),
        type: 'delete',
        message: t('sideToolbar.workflowTab.confirmDelete'),
        itemList: [workflow.path]
      })
      if (!confirmed) return false
    }

    if (workflowStore.isOpen(workflow)) {
      const closed = await closeWorkflow(workflow, {
        warnIfUnsaved: !confirmed
      })
      if (!closed) return false
    }
    await workflowStore.deleteWorkflow(workflow)
    if (!silent) {
      toastStore.add({
        severity: 'info',
        summary: t('sideToolbar.workflowTab.deleted'),
        life: 1000
      })
    }
    return true
  }

  /**
   * This method is called before loading a new graph.
   * There are 3 major functions that loads a new graph to the graph editor:
   * 1. loadGraphData
   * 2. loadApiJson
   * 3. importA1111
   *
   * This function is used to save the current workflow states before loading
   * a new graph.
   */
  const beforeLoadNewGraph = () => {
    // Use workspaceStore here as it is patched in unit tests.
    const workflowStore = useWorkspaceStore().workflow
    const activeWorkflow = workflowStore.activeWorkflow
    if (activeWorkflow) {
      activeWorkflow.changeTracker?.deactivate()
      persistActiveWorkflowDraft(activeWorkflow)
      // Cache missing model/media/node state for restore on tab switch.
      // Always overwrite to reflect the current store state (e.g. after
      // muting a node cleared its errors).
      const modelCandidates = useMissingModelStore().missingModelCandidates
      const mediaCandidates = useMissingMediaStore().missingMediaCandidates
      const nodeTypes = missingNodesErrorStore.missingNodesError?.nodeTypes
      updatePendingWarnings(activeWorkflow, {
        missingNodeTypes: nodeTypes?.length ? [...nodeTypes] : undefined,
        missingModelCandidates: modelCandidates ?? undefined,
        missingMediaCandidates: mediaCandidates ?? undefined
      })

      // Capture thumbnail before loading new graph
      void workflowThumbnail.storeThumbnail(activeWorkflow)
      domWidgetStore.clear()

      // Save subgraph viewport before the canvas gets overwritten
      useSubgraphNavigationStore().saveCurrentViewport()
    }
  }

  /**
   * Set the active workflow after the new graph is loaded.
   *
   * The call relationship is
   * useWorkflowService().openWorkflow -> app.loadGraphData -> useWorkflowService().afterLoadNewGraph
   * app.loadApiJson -> useWorkflowService().afterLoadNewGraph
   * app.importA1111 -> useWorkflowService().afterLoadNewGraph
   *
   * @param value The value to set as the active workflow.
   * @param workflowData The initial workflow data loaded to the graph editor.
   */
  const afterLoadNewGraph = async (
    value: string | ComfyWorkflow | null,
    workflowData: ComfyWorkflowJSON,
    shareId?: string
  ) => {
    const workflowStore = useWorkspaceStore().workflow
    const { isAppMode } = useAppMode()
    const wasAppMode = isAppMode.value

    // Determine the initial app mode for fresh loads from serialized state.
    // null means linearMode was never explicitly set (not builder-saved).
    const freshLoadMode = linearModeToAppMode(workflowData.extra?.linearMode)
    useAppModeStore().loadSelections(workflowData.extra?.linearData)

    function trackIfEnteringApp(workflow: ComfyWorkflow) {
      if (!wasAppMode && workflow.initialMode === 'app') {
        useTelemetry()?.trackEnterLinear({ source: 'workflow' })
      }
    }

    if (value === null || typeof value === 'string') {
      const path = value as string | null

      // Check if a persisted workflow with this path exists
      if (path) {
        const fullPath = ComfyWorkflow.basePath + appendJsonExt(path)
        const existingWorkflow = workflowStore.getWorkflowByPath(fullPath)

        // Reuse an existing workflow when this is a restoration case
        // (persisted but currently unloaded) or an idempotent repeated load
        // of the currently active same-path workflow.
        //
        // This prevents accidental duplicate tabs when startup/load flows
        // invoke loadGraphData more than once for the same workflow name.
        const isSameActiveWorkflowLoad =
          !!existingWorkflow &&
          workflowStore.isActive(existingWorkflow) &&
          (existingWorkflow.activeState?.id === undefined ||
            workflowData.id === undefined ||
            existingWorkflow.activeState.id === workflowData.id)

        if (
          existingWorkflow &&
          ((existingWorkflow.isPersisted && !existingWorkflow.isLoaded) ||
            isSameActiveWorkflowLoad)
        ) {
          const loadedWorkflow =
            await workflowStore.openWorkflow(existingWorkflow)
          if (loadedWorkflow.initialMode === undefined) {
            // Prefer the file's linearMode over the draft's since the file
            // is the authoritative saved state.
            loadedWorkflow.initialMode =
              linearModeToAppMode(
                loadedWorkflow.initialState?.extra?.linearMode
              ) ?? freshLoadMode
            trackIfEnteringApp(loadedWorkflow)
          }
          if (shareId) {
            loadedWorkflow.shareId = shareId
          }
          loadedWorkflow.changeTracker.reset(workflowData)
          loadedWorkflow.changeTracker.restore()
          return
        }
      }

      const tempWorkflow = workflowStore.createNewTemporary(
        path ? appendJsonExt(path) : undefined,
        workflowData
      )
      tempWorkflow.initialMode = freshLoadMode
      if (shareId) {
        tempWorkflow.shareId = shareId
      }
      trackIfEnteringApp(tempWorkflow)
      await workflowStore.openWorkflow(tempWorkflow)
      if (hubBackendOrigin() !== null) {
        await workflowStore.keepOnlyWorkflow(tempWorkflow)
      }
      return
    }

    const loadedWorkflow = await workflowStore.openWorkflow(value)
    if (shareId) {
      loadedWorkflow.shareId = shareId
    }
    if (loadedWorkflow.initialMode === undefined) {
      loadedWorkflow.initialMode = freshLoadMode
      trackIfEnteringApp(loadedWorkflow)
    }
    loadedWorkflow.changeTracker.reset(workflowData)
    loadedWorkflow.changeTracker.restore()
    if (hubBackendOrigin() !== null) {
      await workflowStore.keepOnlyWorkflow(loadedWorkflow)
    }
  }

  /**
   * Insert the given workflow into the current graph editor.
   */
  const insertWorkflow = async (
    workflow: ComfyWorkflow,
    options: { position?: Point } = {}
  ) => {
    const loadedWorkflow = await workflow.load()
    const workflowJSON = toRaw(loadedWorkflow.initialState)
    const old = localStorage.getItem('litegrapheditor_clipboard')
    // unknown conversion: ComfyWorkflowJSON is stricter than LiteGraph's
    // serialisation schema.
    const graph = new LGraph(workflowJSON as unknown as SerialisableGraph)
    const canvasElement = document.createElement('canvas')
    const canvas = new LGraphCanvas(canvasElement, graph, {
      skip_events: true,
      skip_render: true
    })
    canvas.selectItems()
    canvas.copyToClipboard()
    app.canvas.pasteFromClipboard(options)
    if (old !== null) {
      localStorage.setItem('litegrapheditor_clipboard', old)
    }
  }

  const loadNextOpenedWorkflow = async () => {
    const nextWorkflow = workflowStore.openedWorkflowIndexShift(1)
    if (nextWorkflow) {
      await openWorkflow(nextWorkflow)
    }
  }

  const loadPreviousOpenedWorkflow = async () => {
    const previousWorkflow = workflowStore.openedWorkflowIndexShift(-1)
    if (previousWorkflow) {
      await openWorkflow(previousWorkflow)
    }
  }

  /**
   * Takes an existing workflow and duplicates it with a new name
   */
  const duplicateWorkflow = async (workflow: ComfyWorkflow) => {
    if (!workflow.isLoaded) await workflow.load()
    const state = JSON.parse(JSON.stringify(workflow.activeState))
    // Ensure duplicates are always treated as distinct workflows.
    if (state) state.id = generateUUID()
    const suffix = workflow.isPersisted ? ' (Copy)' : ''
    // Remove the suffix `(2)` or similar
    const filename = workflow.filename.replace(/\s*\(\d+\)$/, '') + suffix

    await app.loadGraphData(state, true, true, filename)
  }

  /**
   * Show and clear any pending warnings (missing nodes/models) stored on the
   * active workflow. Called after a workflow becomes visible so dialogs don't
   * overlap with subsequent loads.
   */
  function showPendingWarnings(
    workflow?: ComfyWorkflow | null,
    options?: { silent?: boolean }
  ) {
    const wf = workflow ?? workflowStore.activeWorkflow
    if (!wf) return

    const { missingNodeTypes, missingModelCandidates, missingMediaCandidates } =
      wf.pendingWarnings ?? {}

    // Always sync missing nodes store (clear when empty).
    if (
      missingNodesErrorStore.surfaceMissingNodes(missingNodeTypes ?? []) &&
      !options?.silent
    ) {
      useExecutionErrorStore().showErrorOverlay()
    }
    if (missingModelCandidates?.length) {
      useMissingModelStore().setMissingModels(missingModelCandidates)
    }
    if (missingMediaCandidates?.length) {
      useMissingMediaStore().setMissingMedia(missingMediaCandidates)
    }

    // Keep cache for future tab switches
    if (
      missingNodeTypes?.length ||
      missingModelCandidates?.length ||
      missingMediaCandidates?.length
    ) {
      wf.pendingWarnings = normalizePendingWarnings({
        missingNodeTypes,
        missingModelCandidates,
        missingMediaCandidates
      })
    } else {
      wf.pendingWarnings = null
    }
  }

  return {
    exportWorkflow,
    editHubWorkflowAgentHint,
    saveWorkflowAs,
    saveWorkflow,
    loadDefaultWorkflow,
    loadBlankWorkflow,
    reloadCurrentWorkflow,
    openWorkflow,
    closeWorkflow,
    renameWorkflow,
    deleteWorkflow,
    insertWorkflow,
    loadNextOpenedWorkflow,
    loadPreviousOpenedWorkflow,
    duplicateWorkflow,
    showPendingWarnings,
    afterLoadNewGraph,
    beforeLoadNewGraph
  }
}

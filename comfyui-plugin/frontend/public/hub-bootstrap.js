/**
 * Hub 画布插件的启动引导。必须在 SPA 的 module 入口之前同步执行 ——
 * `api.ts` 的 `export const api = new ComfyApi()` 在模块加载时就把后端
 * origin 固化进实例了，晚一步就来不及。
 *
 * ## 两种运行形态
 *
 *   独立跑（`pnpm dev` 或直接开后端端口）——前端与后端同源，这里什么都不做。
 *   Hub 插件（iframe 嵌在 gateway origin 下）——写入 `__COMFY_BACKEND_ORIGIN__`
 *     指向托管后端端口，并接管「安装 / 更新 / 启动」引导。
 *
 * ## 后端统一下发（不接受用户自装目录）
 *
 * 后端是我们维护的 fork，随 hub/backend-bundle.json 版本下发：
 *   未安装      → 提示下载（尺寸来自 install-backend.py --info），detached
 *                 worker 后台安装，进度轮询 /api/plugins/comfyui/data/install-state.json
 *   版本不符    → 提示更新（同一条安装链路）
 *   已装未运行  → 打开节点即自动拉起（start-backend.py，detached）
 * 端口用 18188 专用值，避免撞上用户本机 8188 的官方 ComfyUI。
 *
 * ## 为什么轮询状态文件而不是等 RPC
 *
 * hub.python.run 有 10 分钟硬顶，GB 级下载必超时。安装 RPC 只负责 spawn
 * detached worker 立刻返回；进度/终态全部落在 plugin-data 的 JSON 上。
 */
;(function () {
  'use strict'

  var PORT = 18188
  var PLUGIN_ID = 'comfyui'
  var DATA_URL = '/api/plugins/' + PLUGIN_ID + '/data/'
  var NVIDIA_DRIVER_REQUIRED_STATE = 'nvidia-driver-required'
  var START_TIMEOUT_MS = 200000
  var RPC_TIMEOUT_MS = 30000
  var POLL_INTERVAL_MS = 1500
  /** worker 心跳（5s 一跳）超过此值视为安装进程已死。 */
  var STATE_STALE_MS = 60000
  /** hub.config 键：内部调试用 bundle 地址覆写（灰度/预发包）。 */
  var URL_OVERRIDE_KEY = 'bundleUrlOverride'
  var WORKFLOW_APP_READY_TIMEOUT_MS = 60000

  var embedded = window.parent !== window
  window.__COMFY_HUB_EMBEDDED__ = embedded
  var backendOrigin = 'http://127.0.0.1:' + PORT
  var launchParams = new URLSearchParams(location.search)
  var requestedWorkflow = (launchParams.get('hubWorkflow') || '').trim()
  var workflowRequestId = (
    launchParams.get('hubWorkflowRequestId') || ''
  ).trim()
  var workflowId = (launchParams.get('hubWorkflowId') || '').trim()
  if (!workflowId && /^(?:user|template):/i.test(requestedWorkflow)) {
    workflowId = requestedWorkflow
    requestedWorkflow = ''
  }
  var workflowCommand = (
    launchParams.get('hubWorkflowCommand') || 'comfyui:load-workflow'
  ).trim()
  var workflowTarget = (launchParams.get('hubWorkflowTarget') || 'new').trim()
  // Converter mode is a top-level utility page. Normal canvas nodes are
  // editor instances, so they continue through backendReady()/loadRequestedWorkflow().
  var converterMode = launchParams.get('hubConverter') === '1'
  window.__COMFY_HUB_DRAFT_READY__ = false
  window.__COMFY_HUB_WORKFLOW_DRAFT_DIRTY__ = false
  var workflowLabel =
    requestedWorkflow || (workflowTarget === 'empty' ? '空画布' : '工作流')

  function recordHubComfyDiagnostic(event, details) {
    var entry = Object.assign(
      {
        marker: 'TEMP DIAGNOSTIC — remove before commit',
        scope: 'comfyui',
        event: event,
        at: Date.now()
      },
      details || {}
    )
    var append = function (target) {
      if (!target) return
      var entries = Array.isArray(target.__hiloDiag) ? target.__hiloDiag : []
      entries.push(entry)
      target.__hiloDiag = entries.slice(-40)
    }
    append(window)
    try {
      if (window.parent !== window) append(window.parent)
    } catch (_) {}
  }

  /**
   * 捕获加载时的规范 URL：SPA 的 vue-router 曾把地址 replaceState 成
   * …/index.html/（尾斜杠），此时 location.reload() 会按坏地址重载，
   * 全部相对资源 404，页面永远停在内联 splash。重载一律回到这个
   * 地址，不信任当前 location。（router 侧已改 hash 模式根治，此为防御）
   */
  var INITIAL_HREF = location.href

  function markWorkflowDraftReady() {
    window.__COMFY_HUB_DRAFT_READY__ = true
    window.dispatchEvent(new CustomEvent('hub-comfyui:workflow-ready'))
  }

  function reloadClean() {
    try {
      location.replace(INITIAL_HREF)
    } catch (_) {
      location.reload()
    }
  }

  // —— 同步部分：SPA 加载前必须完成 ——
  if ((embedded || converterMode) && location.port !== String(PORT)) {
    window.__COMFY_BACKEND_ORIGIN__ = backendOrigin
  }

  // 独立形态无需引导，后续全部跳过；隐藏编译器虽是顶层页面，但仍须
  // 连接托管后端并暴露 converter API。
  if (!embedded && !converterMode) return

  function probe() {
    return fetch(backendOrigin + '/system_stats', { method: 'GET' })
      .then(function (r) {
        return r.ok
      })
      .catch(function () {
        return false
      })
  }

  function loadSdk() {
    if (window.hub) return Promise.resolve(window.hub)
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script')
      s.src = '/__hub-sdk__.js'
      s.onload = function () {
        resolve(window.hub)
      }
      s.onerror = function () {
        reject(new Error('Hub SDK 加载失败'))
      }
      document.head.appendChild(s)
    })
  }

  function normalizeWorkflowName(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s_\-—–:：/\\「」『』【】()[\]（）]+/g, '')
  }

  /**
   * Product-facing aliases whose wording does not exist in ComfyUI's English
   * template index. Keep this deliberately small and deterministic: fuzzy
   * matching an arbitrary Chinese phrase to a large model template could load
   * a costly or incompatible workflow without the user choosing it.
   */
  var WORKFLOW_ALIASES = {
    文生图最简: 'default',
    最简文生图: 'default',
    默认文生图: 'default',
    texttoimageminimal: 'default',
    minimaltexttoimage: 'default',
    imagegeneration: 'default'
  }

  function flattenTemplates(index) {
    var out = []
    if (!Array.isArray(index)) return out
    index.forEach(function (category) {
      ;(category && Array.isArray(category.templates)
        ? category.templates
        : []
      ).forEach(function (template) {
        if (template && template.name) out.push(template)
      })
    })
    return out
  }

  function resolveTemplate(templates, workflowName) {
    var normalized = normalizeWorkflowName(workflowName)
    var alias = WORKFLOW_ALIASES[normalized]
    if (alias) {
      return (
        templates.find(function (template) {
          return template.name === alias
        }) || {
          name: alias,
          title: workflowName
        }
      )
    }

    var exact = templates.filter(function (template) {
      return (
        normalizeWorkflowName(template.name) === normalized ||
        normalizeWorkflowName(template.title) === normalized
      )
    })
    if (exact.length === 1) return exact[0]

    var partial = templates.filter(function (template) {
      var name = normalizeWorkflowName(template.name)
      var title = normalizeWorkflowName(template.title)
      return (
        normalized.length >= 4 &&
        (name.includes(normalized) || title.includes(normalized))
      )
    })
    return partial.length === 1 ? partial[0] : null
  }

  function waitForComfyApp() {
    var startedAt = Date.now()
    return new Promise(function (resolve, reject) {
      var tick = function () {
        var app =
          window.comfyAPI && window.comfyAPI.app && window.comfyAPI.app.app
        // `loadGraphData` is exposed before the Vue/Pinia workflow store and
        // LiteGraph canvas finish initializing. Calling it in that gap fails
        // inside ComfyUI with "reading '_s'" and leaves the previous graph in
        // place, so readiness must include the state it actually consumes.
        if (
          app &&
          typeof app.loadGraphData === 'function' &&
          app.vueAppReady === true &&
          app.rootGraphInternal &&
          app.canvas &&
          typeof app.canvas.setGraph === 'function' &&
          // GraphCanvas assigns these globals only after app.setup() and
          // canvasStore.canvas are both ready. vueAppReady flips earlier.
          window.app === app &&
          window.graph
        ) {
          resolve(app)
          return
        }
        if (Date.now() - startedAt >= WORKFLOW_APP_READY_TIMEOUT_MS) {
          reject(new Error('ComfyUI 前端初始化超时'))
          return
        }
        setTimeout(tick, 100)
      }
      tick()
    })
  }

  function notifyWorkflow(message, type) {
    loadSdk()
      .then(function (hub) {
        hub.ui.notify(message, type || 'info')
      })
      .catch(function () {
        console.log('[hub-comfyui] ' + message)
      })
  }

  function currentWorkflowDisplayName() {
    return (
      String(
        window.__COMFY_HUB_WORKFLOW_NAME__ || workflowLabel || '工作流'
      ).trim() || '工作流'
    )
  }

  function syncWorkflowNameToCanvas(hub) {
    var canvas = hub && hub.canvas
    if (!canvas || typeof canvas.getCurrentNodeId !== 'function')
      return Promise.resolve()
    var nodeId = canvas.getCurrentNodeId()
    if (!nodeId || typeof canvas.updateNodeData !== 'function')
      return Promise.resolve()
    recordHubComfyDiagnostic('bootstrap:sync-name', {
      nodeId: nodeId,
      workflowId: window.__COMFY_HUB_WORKFLOW_ID__,
      workflowName: currentWorkflowDisplayName()
    })
    return Promise.resolve(
      canvas.updateNodeData(nodeId, {
        currentWorkflowName: currentWorkflowDisplayName()
      })
    ).catch(function () {})
  }

  function syncBackendReadyToCanvas(hub, backendReady) {
    var canvas = hub && hub.canvas
    if (!canvas || typeof canvas.getCurrentNodeId !== 'function')
      return Promise.resolve()
    var nodeId = canvas.getCurrentNodeId()
    if (!nodeId || typeof canvas.updateNodeData !== 'function')
      return Promise.resolve()
    return Promise.resolve(
      canvas.updateNodeData(nodeId, {
        comfyuiBackendReady: backendReady
      })
    ).catch(function () {})
  }

  function acknowledgeWorkflow(status, extra) {
    if (!workflowRequestId) return Promise.resolve()
    var body = Object.assign({ status: status }, extra || {})
    return fetch(
      '/api/comfyui/commands/' + encodeURIComponent(workflowRequestId) + '/ack',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    ).then(function (response) {
      if (!response.ok)
        throw new Error(
          'Hub workflow ack failed (HTTP ' + response.status + ')'
        )
    })
  }

  function fetchRequestedWorkflow() {
    if (workflowId) {
      recordHubComfyDiagnostic('bootstrap:fetch-workflow', {
        workflowId: workflowId,
        requestedWorkflow: requestedWorkflow
      })
      return fetch(
        '/api/comfyui/workflows/' +
          encodeURIComponent(workflowId) +
          '?include_graph=true',
        { cache: 'no-store' }
      )
        .then(function (response) {
          if (!response.ok)
            throw new Error(
              '工作流详情加载失败（HTTP ' + response.status + '）'
            )
          return response.json()
        })
        .then(function (detail) {
          if (!detail || !detail.graph) throw new Error('工作流详情缺少 graph')
          return {
            graph: detail.graph,
            openSource: detail.source || 'workflow',
            workflowId: workflowId,
            workflowName: detail.title || detail.filename || workflowLabel,
            sourceSha256: detail.source_sha256
          }
        })
    }

    return fetch(backendOrigin + '/templates/index.json', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok)
          throw new Error(
            '无法读取 ComfyUI 工作流模板列表（HTTP ' + response.status + '）'
          )
        return response.json()
      })
      .then(function (index) {
        var template = resolveTemplate(
          flattenTemplates(index),
          requestedWorkflow
        )
        if (!template)
          throw new Error('未找到唯一匹配的工作流：' + requestedWorkflow)
        return fetch(
          backendOrigin +
            '/templates/' +
            encodeURIComponent(template.name) +
            '.json',
          { cache: 'no-store' }
        )
          .then(function (response) {
            if (!response.ok)
              throw new Error(
                '工作流模板加载失败（HTTP ' + response.status + '）'
              )
            return response.json()
          })
          .then(function (graph) {
            return {
              graph: graph,
              openSource: 'template',
              workflowId: template.name,
              workflowName: template.title || template.name
            }
          })
      })
  }

  function queueCurrentWorkflow(app) {
    var api = window.comfyAPI && window.comfyAPI.api && window.comfyAPI.api.api
    if (
      !api ||
      typeof api.queuePrompt !== 'function' ||
      typeof app.graphToPrompt !== 'function'
    ) {
      return Promise.reject(new Error('ComfyUI 执行 API 尚未就绪'))
    }
    return app
      .graphToPrompt()
      .then(function (prompt) {
        applyWorkflowOutputPrefix(prompt)
        return api.queuePrompt(0, prompt)
      })
      .then(function (response) {
        if (!response || !response.prompt_id)
          throw new Error('ComfyUI 未返回 prompt_id')
        return response.prompt_id
      })
  }

  function workflowOutputPrefix() {
    var name = String(
      window.__COMFY_HUB_WORKFLOW_NAME__ || workflowLabel || 'workflow'
    )
      .replace(/\.json$/i, '')
      .replace(/[\\/:*?"<>|]/g, '-')
      .trim()
    return name || 'workflow'
  }

  function applyWorkflowOutputPrefix(prompt, explicitWorkflowName) {
    if (!prompt || !prompt.output || typeof prompt.output !== 'object') return
    var prefix = explicitWorkflowName
      ? String(explicitWorkflowName)
          .replace(/\.json$/i, '')
          .replace(/[\\/:*?"<>|]/g, '-')
          .trim() || 'workflow'
      : workflowOutputPrefix()
    Object.keys(prompt.output).forEach(function (nodeId) {
      var node = prompt.output[nodeId]
      if (
        !node ||
        typeof node !== 'object' ||
        !node.inputs ||
        typeof node.inputs !== 'object'
      )
        return
      if (
        Object.prototype.hasOwnProperty.call(node.inputs, 'filename_prefix')
      ) {
        node.inputs.filename_prefix = prefix
      }
    })
  }

  function queueLoadedWorkflow(app) {
    if (workflowCommand !== 'comfyui:run-workflow') return Promise.resolve(null)
    return queueCurrentWorkflow(app)
  }

  function resolveEditedNode(graph, nodeRefs, nodeId, nodeRef) {
    var resolvedId = nodeRef ? nodeRefs[nodeRef] : nodeId
    if (resolvedId === undefined || resolvedId === null || resolvedId === '') {
      throw new Error('编辑操作缺少有效节点引用')
    }
    var node = graph.getNodeById(resolvedId)
    if (!node && /^\d+$/.test(String(resolvedId)))
      node = graph.getNodeById(Number(resolvedId))
    if (!node) throw new Error('找不到 ComfyUI 节点：' + resolvedId)
    return node
  }

  function resolveNodeSlot(node, direction, selector) {
    if (
      typeof selector === 'number' &&
      Number.isInteger(selector) &&
      selector >= 0
    )
      return selector
    var method = direction === 'input' ? 'findInputSlot' : 'findOutputSlot'
    if (
      typeof selector !== 'string' ||
      !selector.trim() ||
      typeof node[method] !== 'function'
    ) {
      throw new Error(
        '无效的节点' + (direction === 'input' ? '输入' : '输出') + '端口'
      )
    }
    var slot = node[method](selector)
    if (!Number.isInteger(slot) || slot < 0)
      throw new Error('节点不存在端口：' + selector)
    return slot
  }

  function setNodeParameter(node, name, value) {
    var widgets = Array.isArray(node.widgets) ? node.widgets : []
    var widget = widgets.find(function (candidate) {
      return candidate && candidate.name === name
    })
    if (!widget)
      throw new Error('节点 ' + node.id + ' 不存在可编辑参数：' + name)
    widget.value = value
    if (typeof widget.callback === 'function')
      widget.callback(value, node, widget)
    if (typeof node.setDirtyCanvas === 'function')
      node.setDirtyCanvas(true, true)
  }

  function applyWorkflowEdits(app, edit) {
    if (!edit) return {}
    var graph = app.rootGraphInternal || window.graph
    if (!graph || typeof graph.getNodeById !== 'function')
      throw new Error('ComfyUI 图尚未就绪')
    var operations = Array.isArray(edit.operations) ? edit.operations : []
    if (!operations.length) throw new Error('编辑操作不能为空')
    var nodeRefs = {}
    operations.forEach(function (operation) {
      if (!operation || typeof operation !== 'object')
        throw new Error('无效的 workflow 编辑操作')
      if (operation.type === 'add_node') {
        if (
          !window.LiteGraph ||
          typeof window.LiteGraph.createNode !== 'function'
        ) {
          throw new Error('ComfyUI 节点注册表尚未就绪')
        }
        if (nodeRefs[operation.ref])
          throw new Error('重复的新增节点引用：' + operation.ref)
        var node = window.LiteGraph.createNode(operation.node_type)
        if (!node)
          throw new Error('本机 ComfyUI 未注册节点：' + operation.node_type)
        if (operation.title) node.title = operation.title
        if (Array.isArray(operation.position))
          node.pos = operation.position.slice(0, 2)
        graph.add(node)
        nodeRefs[operation.ref] = String(node.id)
        Object.keys(operation.parameters || {}).forEach(function (name) {
          setNodeParameter(node, name, operation.parameters[name])
        })
        return
      }
      if (operation.type === 'set_node_parameter') {
        setNodeParameter(
          resolveEditedNode(
            graph,
            nodeRefs,
            operation.node_id,
            operation.node_ref
          ),
          operation.parameter,
          operation.value
        )
        return
      }
      if (operation.type === 'remove_node') {
        graph.remove(
          resolveEditedNode(graph, nodeRefs, operation.node_id, null)
        )
        return
      }
      if (operation.type === 'connect') {
        var source = resolveEditedNode(
          graph,
          nodeRefs,
          operation.from_node_id,
          operation.from_node_ref
        )
        var target = resolveEditedNode(
          graph,
          nodeRefs,
          operation.to_node_id,
          operation.to_node_ref
        )
        var connected = source.connect(
          resolveNodeSlot(source, 'output', operation.from_output),
          target,
          resolveNodeSlot(target, 'input', operation.to_input)
        )
        if (connected === null || connected === false)
          throw new Error('ComfyUI 拒绝了不兼容的节点连线')
        return
      }
      if (operation.type === 'disconnect') {
        var disconnectNode = resolveEditedNode(
          graph,
          nodeRefs,
          operation.node_id,
          null
        )
        disconnectNode.disconnectInput(
          resolveNodeSlot(disconnectNode, 'input', operation.input)
        )
        return
      }
      throw new Error('不支持的 workflow 编辑操作：' + operation.type)
    })
    return nodeRefs
  }

  // The hidden compiler page turns a saved workflow into an executable prompt.
  function compileWorkflow(workflowIdArg, workflowNameArg, editArg, sourceArg) {
    var id = String(workflowIdArg || '').trim()
    var name = String(workflowNameArg || '').trim()
    var edit = editArg || null
    var source = sourceArg || null
    var nodeRefs = {}
    if (!id) return Promise.reject(new Error('workflow_id 不能为空'))
    return Promise.all([
      fetch(
        source && source.source_node_id
          ? '/api/comfyui/node-workflows/' + encodeURIComponent(source.source_node_id) + '?include_graph=true'
          : '/api/comfyui/workflows/' + encodeURIComponent(id) + '?include_graph=true',
        { cache: 'no-store' }
      ).then(function (response) {
        if (!response.ok)
          throw new Error('工作流详情加载失败（HTTP ' + response.status + '）')
        return response.json()
      }),
      waitForComfyApp()
    ]).then(function (parts) {
      var detail = parts[0]
      var app = parts[1]
      if (!detail || !detail.graph) throw new Error('工作流详情缺少 graph')
      if (
        source &&
        source.expected_source_sha256 &&
        detail.source_sha256 !== source.expected_source_sha256
      ) throw new Error('画布工作流已发生变化，请重新读取后再操作')
      return Promise.resolve(
        app.loadGraphData(
          detail.graph,
          true,
          true,
          name || detail.filename || detail.title || null,
          {
            openSource: detail.source || 'workflow',
            reuseActiveWorkflow: false
          }
        )
      )
        .then(function () {
          var graph = app.rootGraphInternal || app.rootGraph || window.graph
          nodeRefs = applyWorkflowEdits(app, edit)
          if (typeof app.graphToPrompt !== 'function')
            throw new Error('ComfyUI graphToPrompt 尚未就绪')
          return app.graphToPrompt(graph)
        })
        .then(function (snapshot) {
          if (!snapshot || !snapshot.output || !snapshot.workflow) {
            throw new Error('ComfyUI 未生成有效的执行快照')
          }
          applyWorkflowOutputPrefix(
            snapshot,
            name || detail.filename || detail.title
          )
          if (source && source.source_node_id) {
            return {
              compiled: true,
              workflow_id: id,
              node_refs: nodeRefs,
              output: snapshot.output,
              workflow: snapshot.workflow,
              source_sha256: detail.source_sha256
            }
          }
          var endpoint = edit ? 'editable' : 'executable'
          var body = { output: snapshot.output, workflow: snapshot.workflow }
          if (edit) {
            body.expected_source_sha256 = edit.expected_source_sha256
            body.node_refs = nodeRefs
          }
          return fetch(
            '/api/comfyui/workflows/' + encodeURIComponent(id) + '/' + endpoint,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            }
          )
        })
        .then(function (response) {
          if (source && source.source_node_id) return response
          if (!response.ok)
            throw new Error('执行快照保存失败（HTTP ' + response.status + '）')
          var result = { compiled: true, workflow_id: id }
          if (edit) result.node_refs = nodeRefs
          return result
        })
    })
  }

  if (converterMode) {
    window.__HILO_COMFYUI_CONVERTER__ = { convert: compileWorkflow }
  }

  function registerRunWithHub(hub, promptId) {
    var canvas = hub && hub.canvas
    var sourceNodeId =
      canvas && typeof canvas.getCurrentNodeId === 'function'
        ? canvas.getCurrentNodeId()
        : ''
    if (!sourceNodeId) return Promise.resolve(promptId)
    return fetch('/api/comfyui/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt_id: promptId,
        source_node_id: sourceNodeId
      })
    }).then(function (response) {
      if (!response.ok) {
        throw new Error('Hub 运行结果登记失败（HTTP ' + response.status + '）')
      }
      return promptId
    })
  }

  // The canvas card invokes this through the Hub SDK. Queue the graph that
  // is already open in this iframe so unsaved parameter edits are preserved.
  function registerCanvasRunHandler() {
    return loadSdk()
      .then(function (hub) {
        if (!hub || typeof hub.onRun !== 'function') return
        hub.onRun(function () {
          return waitForComfyApp()
            .then(queueCurrentWorkflow)
            .then(function (promptId) {
              return registerRunWithHub(hub, promptId)
            })
            .then(function (promptId) {
              notifyWorkflow(
                '工作流已进入队列：' + currentWorkflowDisplayName(),
                'success'
              )
              return promptId
            })
            .catch(function (err) {
              var message = String((err && err.message) || err)
              notifyWorkflow('工作流执行失败：' + message, 'error')
            })
        })
      })
      .catch(function (err) {
        console.error('[hub-comfyui] failed to register run handler:', err)
      })
  }

  // Converter mode runs as a top-level utility page and has no card action.
  if (!converterMode) void registerCanvasRunHandler()

  function replaceCurrentWorkflow(app, graphData, workflowName, openSource) {
    if (
      !app.rootGraphInternal ||
      !app.canvas ||
      typeof app.canvas.setGraph !== 'function'
    ) {
      return Promise.reject(new Error('ComfyUI 当前工作流尚未就绪'))
    }
    app.canvas.setGraph(app.rootGraphInternal)
    return Promise.resolve(
      app.loadGraphData(graphData, true, true, workflowName || null, {
        // Bind the restored graph to its persisted workflow rather than the
        // startup temporary tab. Otherwise a later save can overwrite the
        // template-bound workflow identity.
        reuseActiveWorkflow: false,
        openSource: openSource || 'workflow'
      })
    )
  }

  function applyRequestedWorkflow(app, requested) {
    if (workflowTarget === 'empty') {
      return replaceCurrentWorkflow(
        app,
        {
          last_node_id: 0,
          last_link_id: 0,
          nodes: [],
          links: [],
          groups: [],
          config: {},
          extra: { ds: { offset: [0, 0], scale: 1 } },
          version: 0.4
        },
        null,
        'workflow'
      )
    }
    return replaceCurrentWorkflow(
      app,
      requested.graph,
      requested.workflowName || requestedWorkflow,
      requested.openSource
    )
  }

  function registerExternalDraftSync(hub, app) {
    if (!hub.storage || typeof hub.storage.onChange !== 'function') return
    var applying = false
    hub.storage.onChange(function () {
      if (applying || !window.__COMFY_HUB_DRAFT_READY__) return
      hub.storage
        .get('comfyui.workflow-draft.v1')
        .then(function (draft) {
          var identity = window.__COMFY_HUB_WORKFLOW_ID__
          if (
            !draft ||
            draft.version !== 1 ||
            typeof draft.workflowId !== 'string' ||
            !draft.workflowId ||
            !draft.graph ||
            !Array.isArray(draft.graph.nodes) ||
            !Array.isArray(draft.graph.links)
          ) {
            return
          }
          window.__COMFY_HUB_DRAFT_READY__ = false
          window.dispatchEvent(new CustomEvent('hub-comfyui:external-draft'))
          if (draft.workflowId !== identity) {
            window.__COMFY_HUB_WORKFLOW_ID__ = draft.workflowId
            window.__COMFY_HUB_WORKFLOW_NAME__ =
              draft.workflowName || draft.workflowId
            window.__COMFY_HUB_WORKFLOW_SOURCE__ = draft.workflowId.indexOf('template:') === 0
              ? 'template'
              : 'workflow'
            recordHubComfyDiagnostic('draft:identity-synchronized', {
              previousWorkflowId: identity,
              workflowId: draft.workflowId
            })
          }
          var current =
            app.rootGraph && typeof app.rootGraph.serialize === 'function'
              ? app.rootGraph.serialize()
              : undefined
          if (current && JSON.stringify(current) === JSON.stringify(draft.graph)) {
            markWorkflowDraftReady()
            return
          }
          applying = true
          return replaceCurrentWorkflow(
            app,
            draft.graph,
            draft.workflowName || window.__COMFY_HUB_WORKFLOW_NAME__,
            'workflow'
          ).finally(function () {
            applying = false
            markWorkflowDraftReady()
          })
        })
        .catch(function (err) {
          console.warn('[hub-comfyui] failed to synchronize workflow draft:', err)
          applying = false
          markWorkflowDraftReady()
        })
    })
  }

  function loadRequestedWorkflow() {
    if (!workflowRequestId) return Promise.resolve()
    if (workflowTarget !== 'empty' && !requestedWorkflow && !workflowId) {
      return Promise.resolve()
    }
    // sessionStorage is shared by every same-origin iframe in this browser
    // tab. It must not be used as a workflow restore marker: after ComfyUI
    // finishes booting and resets its graph, a remounted iframe would see the
    // old marker and permanently keep the blank graph. Scope de-duplication
    // to this iframe window instead, so every editor mount restores its own
    // template or draft.
    if (window.__COMFY_HUB_APPLIED_WORKFLOW_REQUEST_ID__ === workflowRequestId) {
      recordHubComfyDiagnostic('bootstrap:skip-already-applied', {
        workflowRequestId: workflowRequestId,
        workflowId: workflowId
      })
      return Promise.resolve()
    }
    window.__COMFY_HUB_APPLIED_WORKFLOW_REQUEST_ID__ = workflowRequestId
    recordHubComfyDiagnostic('bootstrap:load-start', {
      workflowRequestId: workflowRequestId,
      workflowId: workflowId,
      workflowTarget: workflowTarget
    })

    var requestedData =
      workflowTarget === 'empty'
        ? Promise.resolve({ graph: null, openSource: 'workflow' })
        : fetchRequestedWorkflow()

    return Promise.all([requestedData, waitForComfyApp()])
      .then(function (parts) {
        var requested = parts[0]
        var app = parts[1]
        window.__COMFY_HUB_WORKFLOW_ID__ =
          requested.workflowId || workflowId || requestedWorkflow || 'empty'
        window.__COMFY_HUB_WORKFLOW_NAME__ =
          requested.workflowName || workflowLabel
        window.__COMFY_HUB_WORKFLOW_SOURCE__ =
          requested.openSource === 'template' ? 'template' : 'workflow'
        recordHubComfyDiagnostic('bootstrap:resolved-workflow', {
          workflowId: window.__COMFY_HUB_WORKFLOW_ID__,
          workflowName: window.__COMFY_HUB_WORKFLOW_NAME__,
          source: window.__COMFY_HUB_WORKFLOW_SOURCE__,
          nodeCount:
            requested.graph && Array.isArray(requested.graph.nodes)
              ? requested.graph.nodes.length
              : 0
        })
        return loadSdk()
          .then(function (hub) {
            return syncWorkflowNameToCanvas(hub).then(function () {
              return hub.storage
                .get('comfyui.workflow-draft.v1')
                .catch(function () {
                  return undefined
                })
            })
          })
          .then(function (draft) {
            var identity = window.__COMFY_HUB_WORKFLOW_ID__
            var validDraft =
              draft &&
              draft.version === 1 &&
              draft.workflowId === identity &&
              draft.graph &&
              Array.isArray(draft.graph.nodes) &&
              Array.isArray(draft.graph.links)
            if (validDraft) {
              recordHubComfyDiagnostic('bootstrap:draft-match', {
                matched: true,
                workflowId: identity,
                draftWorkflowId: draft.workflowId,
                draftNodeCount: draft.graph.nodes.length,
                dirty: draft.dirty !== false
              })
              requested.graph = draft.graph
              requested.openSource = 'workflow'
              window.__COMFY_HUB_WORKFLOW_DRAFT_DIRTY__ = draft.dirty !== false
            } else if (requested.graph) {
              recordHubComfyDiagnostic('bootstrap:draft-match', {
                matched: false,
                workflowId: identity,
                draftWorkflowId: draft && draft.workflowId,
                draftNodeCount:
                  draft && draft.graph && Array.isArray(draft.graph.nodes)
                    ? draft.graph.nodes.length
                    : 0
              })
              return loadSdk()
                .then(function (hub) {
                  return hub.storage.set('comfyui.workflow-draft.v1', {
                    version: 1,
                    workflowId: identity,
                    workflowName: window.__COMFY_HUB_WORKFLOW_NAME__,
                    graph: requested.graph,
                    ...(requested.sourceSha256
                      ? { baseSourceSha256: requested.sourceSha256 }
                      : {}),
                    dirty: false,
                    updatedAt: Date.now()
                  })
                })
                .then(function () {
                  return applyRequestedWorkflow(app, requested)
                })
            }
            return applyRequestedWorkflow(app, requested)
          })
          .then(function () {
            // graphChanged fires while ComfyUI is booting. Only enable the
            // node-draft writer after the requested template/draft/empty
            // graph has replaced that startup graph, otherwise a blank graph
            // can overwrite the template draft before the user edits it.
            markWorkflowDraftReady()
            return loadSdk().then(function (hub) {
              registerExternalDraftSync(hub, app)
              return queueLoadedWorkflow(app)
            })
          })
      })
      .then(function (promptId) {
        if (promptId) {
          notifyWorkflow(
            '工作流已进入队列：' + currentWorkflowDisplayName(),
            'success'
          )
          return acknowledgeWorkflow('queued', { prompt_id: promptId })
        }
        return acknowledgeWorkflow('loaded')
      })
      .catch(function (err) {
        if (window.__COMFY_HUB_APPLIED_WORKFLOW_REQUEST_ID__ === workflowRequestId) {
          window.__COMFY_HUB_APPLIED_WORKFLOW_REQUEST_ID__ = ''
        }
        var message = String((err && err.message) || err)
        console.error('[hub-comfyui] workflow load failed:', message)
        notifyWorkflow('工作流加载失败：' + message, 'error')
        return acknowledgeWorkflow('failed', { error: message }).catch(
          function (ackErr) {
            console.error('[hub-comfyui] workflow failure ack failed:', ackErr)
          }
        )
      })
  }

  function backendReady(hub) {
    dismiss()
    return syncBackendReadyToCanvas(hub, true).then(loadRequestedWorkflow)
  }

  /** 跑一个 hub python 脚本并解析 stdout 最后一行 JSON。 */
  function runJson(hub, script, args, timeoutMs) {
    return hub.python
      .run({
        script: script,
        args: args,
        timeoutMs: timeoutMs || RPC_TIMEOUT_MS
      })
      .then(function (res) {
        try {
          return JSON.parse((res.stdout || '').trim().split('\n').pop())
        } catch (_) {
          throw new Error(
            res.stderr ||
              res.stdout ||
              '脚本无输出（exit ' + res.exitCode + '）'
          )
        }
      })
  }

  function fmtGb(n) {
    return (n / 1073741824).toFixed(2) + ' GB'
  }

  // —— 引导 UI ——

  var ui = null

  function exitFullscreen() {
    var hub = window.hub
    if (!hub || !hub.ui || typeof hub.ui.exitFullscreen !== 'function') return
    hub.ui.exitFullscreen()
  }

  function overlay() {
    if (ui) return ui
    var root = document.createElement('div')
    root.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:#202020;color:#eee;' +
      'display:flex;align-items:center;justify-content:center;' +
      'font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    root.innerHTML =
      '<button data-role="close" type="button" aria-label="关闭" title="关闭" style="position:absolute;top:16px;right:16px;' +
      'width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:24px;line-height:1">×</button>' +
      '<div style="max-width:520px;padding:32px;text-align:center">' +
      '<div data-role="title" style="font-size:16px;margin-bottom:12px"></div>' +
      '<div data-role="msg" style="opacity:.7;white-space:pre-wrap"></div>' +
      '<div data-role="bar" style="display:none;margin:18px auto 6px;width:320px;height:6px;' +
      'border-radius:3px;background:#3a3a3a;overflow:hidden">' +
      '<div data-role="fill" style="width:0%;height:100%;background:#2d7ff9;transition:width .4s"></div></div>' +
      '<div data-role="pct" style="display:none;font-size:12px;opacity:.6"></div>' +
      '<button data-role="go" style="display:none;margin-top:20px;padding:8px 24px;border-radius:6px;' +
      'border:0;background:#2d7ff9;color:#fff;cursor:pointer;font-size:14px"></button>' +
      '<div data-role="log" style="display:none;margin-top:14px;font-size:12px">' +
      '<a data-role="log-link" href="' +
      DATA_URL +
      'install.log" target="_blank" style="color:#6aa5ff">查看安装日志</a></div>' +
      '</div>'
    document.body.appendChild(root)
    ui = {
      root: root,
      title: root.querySelector('[data-role=title]'),
      msg: root.querySelector('[data-role=msg]'),
      bar: root.querySelector('[data-role=bar]'),
      fill: root.querySelector('[data-role=fill]'),
      pct: root.querySelector('[data-role=pct]'),
      go: root.querySelector('[data-role=go]'),
      log: root.querySelector('[data-role=log]'),
      logLink: root.querySelector('[data-role=log-link]'),
      close: root.querySelector('[data-role=close]')
    }
    ui.close.onclick = exitFullscreen
    return ui
  }

  function show(title, msg, opts) {
    opts = opts || {}
    var u = overlay()
    u.title.textContent = title
    u.msg.textContent = msg || ''
    u.bar.style.display = opts.progress ? 'block' : 'none'
    u.pct.style.display = opts.progress ? 'block' : 'none'
    u.log.style.display = opts.log ? 'block' : 'none'
    if (opts.logHref) u.logLink.href = opts.logHref
    if (opts.logText) u.logLink.textContent = opts.logText
    if (opts.button) {
      u.go.textContent = opts.button
      u.go.style.display = 'inline-block'
      u.go.onclick = opts.onClick || null
    } else {
      u.go.style.display = 'none'
      u.go.onclick = null
    }
  }

  function setProgress(pctVal, text) {
    var u = overlay()
    var clamped = Math.max(0, Math.min(100, pctVal || 0))
    u.fill.style.width = clamped + '%'
    u.pct.textContent = text || (pctVal != null ? clamped.toFixed(1) + '%' : '')
  }

  /** 后端已就绪：撤掉引导层，让下面的 SPA 正常显示。 */
  function dismiss() {
    if (ui) {
      ui.root.remove()
      ui = null
    }
  }

  // —— 安装 / 启动流程 ——

  var PHASE_TEXT = {
    preparing: '准备安装…',
    download: '下载后端包…',
    verify: '校验完整性…',
    extract: '解压后端包…',
    venv: '创建 Python 环境…',
    deps: '安装依赖（约需几分钟）…',
    finalize: '收尾…'
  }

  var START_PHASES = {
    checking: { progress: 12, label: '检查本机后端' },
    validating: { progress: 28, label: '检查安装完整性' },
    preparing: { progress: 42, label: '准备运行目录' },
    spawning: { progress: 56, label: '创建后端进程' },
    loading: { progress: 72, label: '加载节点和模型索引' },
    ready: { progress: 100, label: '后端已就绪' },
    error: { progress: 100, label: '启动失败' }
  }

  var polling = null
  var startPolling = null
  var latestStartState = null

  function pollProgress(hub, verb) {
    if (polling) return
    show('正在' + verb + ' ComfyUI 后端', '关闭节点不会中断，安装在后台继续', {
      progress: true
    })
    var tick = function () {
      fetch(DATA_URL + 'install-state.json?t=' + Date.now(), {
        cache: 'no-store'
      })
        .then(function (r) {
          return r.ok ? r.json() : null
        })
        .then(function (st) {
          if (!st) return
          if (st.phase === 'done') {
            stopPoll()
            try {
              hub.ui.notify('ComfyUI 后端' + verb + '完成', 'success')
            } catch (_) {}
            startBackend(hub)
            return
          }
          if (st.phase === 'error') {
            stopPoll()
            showInstallError(hub, verb, st.error || '未知错误')
            return
          }
          var stale =
            st.updatedAt &&
            Date.now() / 1000 - st.updatedAt > STATE_STALE_MS / 1000
          if (stale) {
            stopPoll()
            showInstallError(
              hub,
              verb,
              '安装进程失去响应（可能被系统清理），请重试'
            )
            return
          }
          var text = PHASE_TEXT[st.phase] || st.message || st.phase
          show(
            '正在' + verb + ' ComfyUI 后端',
            '关闭节点不会中断，安装在后台继续',
            { progress: true }
          )
          if (st.phase === 'download' && st.totalBytes) {
            setProgress(
              st.pct,
              fmtGb(st.downloadedBytes || 0) +
                ' / ' +
                fmtGb(st.totalBytes) +
                '（' +
                (st.pct || 0).toFixed(1) +
                '%）'
            )
          } else {
            setProgress(st.pct != null ? st.pct : 0, text)
          }
        })
        .catch(function () {
          /* 单次轮询失败无所谓，下一跳再试 */
        })
    }
    polling = setInterval(tick, POLL_INTERVAL_MS)
    tick()
  }

  function stopPoll() {
    if (polling) {
      clearInterval(polling)
      polling = null
    }
  }

  function stopStartPoll() {
    if (startPolling) {
      clearInterval(startPolling)
      startPolling = null
    }
  }

  function startStateLogUrl(state) {
    var name = String((state && state.log) || '')
      .split(/[\\/]/)
      .pop()
    return name ? DATA_URL + encodeURIComponent(name) : DATA_URL + 'install.log'
  }

  function formatElapsed(seconds) {
    var value = Math.max(0, Math.floor(seconds || 0))
    if (value < 60) return value + ' 秒'
    return Math.floor(value / 60) + ' 分 ' + (value % 60) + ' 秒'
  }

  function formatStartStateDetails(state) {
    var phase = START_PHASES[state.phase] || {
      progress: 6,
      label: state.message || state.phase || '获取启动状态'
    }
    var now = Date.now() / 1000
    var elapsed = state.startedAt ? now - state.startedAt : 0
    var heartbeatAge = state.heartbeatAt ? now - state.heartbeatAt : 0
    var details = [state.message || phase.label]
    details.push('当前阶段：' + phase.label)
    if (state.launcherPid) details.push('启动进程 PID：' + state.launcherPid)
    if (state.backendPid) details.push('后端进程 PID：' + state.backendPid)
    if (state.startedAt) details.push('已用时：' + formatElapsed(elapsed))
    if (state.heartbeatAt)
      details.push('最后心跳：' + formatElapsed(heartbeatAge) + '前')
    if (state.error) details.push('最终错误：' + state.error)
    return details.join('\n')
  }

  function renderStartState(state) {
    latestStartState = state
    var phase = START_PHASES[state.phase] || {
      progress: 6,
      label: state.message || state.phase || '获取启动状态'
    }
    var elapsed = state.startedAt ? Date.now() / 1000 - state.startedAt : 0
    var progress = phase.progress
    if (state.phase === 'loading')
      progress += Math.min(20, Math.floor(elapsed / 9))

    show(
      state.phase === 'error'
        ? 'ComfyUI 后端启动失败'
        : '正在启动 ComfyUI 后端',
      formatStartStateDetails(state),
      {
        progress: state.phase !== 'error',
        log: Boolean(state.log),
        logHref: startStateLogUrl(state),
        logText: '查看后端启动日志'
      }
    )
    setProgress(progress, '阶段：' + phase.label)
  }

  function pollStartProgress(requestedAt) {
    stopStartPoll()
    var tick = function () {
      fetch(DATA_URL + 'backend-start-state.json?t=' + Date.now(), {
        cache: 'no-store'
      })
        .then(function (response) {
          return response.ok ? response.json() : null
        })
        .then(function (state) {
          if (
            !state ||
            !state.updatedAt ||
            state.updatedAt * 1000 < requestedAt - 1000
          )
            return
          renderStartState(state)
          if (state.phase === 'ready' || state.phase === 'error')
            stopStartPoll()
        })
        .catch(function () {})
    }
    startPolling = setInterval(tick, POLL_INTERVAL_MS)
    tick()
  }

  function showInstallError(hub, verb, err) {
    show('后端' + verb + '失败', err, {
      log: true,
      button: '重试',
      onClick: function () {
        beginInstall(hub, verb)
      }
    })
  }

  function beginInstall(hub, verb) {
    syncBackendReadyToCanvas(hub, false)
    show('正在' + verb + ' ComfyUI 后端', '正在启动安装任务…', {
      progress: true
    })
    hub.config
      .get(URL_OVERRIDE_KEY)
      .catch(function () {
        return ''
      })
      .then(function (override) {
        var region = (hub.env && hub.env.region) || 'domestic'
        var args = ['--start', '--region', region]
        if (override) args = args.concat(['--url', String(override)])
        return runJson(hub, 'hub/install-backend.py', args)
      })
      .then(function (out) {
        if (out.state === 'already-installed') return startBackend(hub)
        if (out.state === 'spawned' || out.state === 'in-progress')
          return pollProgress(hub, verb)
        showInstallError(hub, verb, out.error || '意外状态：' + out.state)
      })
      .catch(function (err) {
        showInstallError(hub, verb, String((err && err.message) || err))
      })
  }

  function offerInstall(hub, info) {
    syncBackendReadyToCanvas(hub, false)
    var isUpdate = !!info.installedVersion
    var verb = isUpdate ? '更新' : '安装'
    var size = info.sizeBytes
      ? '（需下载约 ' + fmtGb(info.sizeBytes) + '）'
      : ''
    var versionChanged = info.installedVersion !== info.targetVersion
    var title = isUpdate
      ? versionChanged
        ? '需要更新 ComfyUI 后端 ' +
          info.installedVersion +
          ' → ' +
          info.targetVersion
        : '需要切换适配当前显卡的 ComfyUI 后端'
      : '首次使用需要安装 ComfyUI 后端'
    show(
      title,
      '后端将下载到本机并在后台安装' +
        size +
        '。\n安装期间可关闭该节点，完成后会有提示。',
      {
        button: verb === '更新' ? '立即更新' : '下载并安装',
        onClick: function () {
          beginInstall(hub, verb)
        }
      }
    )
  }

  function startBackend(hub) {
    syncBackendReadyToCanvas(hub, false)
    var requestedAt = Date.now()
    latestStartState = null
    show('正在启动 ComfyUI 后端', '正在获取启动状态…', { progress: true })
    setProgress(4, '准备启动')
    pollStartProgress(requestedAt)
    runJson(hub, 'hub/start-backend.py', [String(PORT)], START_TIMEOUT_MS)
      .then(function (out) {
        stopStartPoll()
        if (out.ok) {
          // python 侧探活成功≠插件可达：若 18188 上是别人的服务（或未开
          // CORS 的野生 ComfyUI），直接 reload 会陷入「探测失败→
          // already-running→reload」死循环。浏览器侧再确认一次才重载；
          // 自己刚拉起的后端带 CORS *，必然通过，不影响正常路径。
          return probe().then(function (alive) {
            if (alive) {
              // 后端刚起来，但 SPA 早已在没有后端的情况下初始化过一轮，
              // 重载让它重新拉节点定义，比逐个补状态可靠。
              reloadClean()
              return
            }
            show(
              '端口 ' + PORT + ' 被占用',
              '该端口上有服务应答，但插件无法访问（可能是其他程序或未启用 CORS 的 ComfyUI）。\n请释放该端口后重试。',
              {
                button: '重试',
                onClick: function () {
                  startBackend(hub)
                }
              }
            )
          })
        }
        if (out.state === 'not-installed') {
          // 指针损坏 / 安装不完整 → 回到安装流程。
          return runJson(hub, 'hub/install-backend.py', ['--info']).then(
            function (info) {
              offerInstall(hub, info)
            }
          )
        }
        show(
          '后端启动失败',
          latestStartState
            ? formatStartStateDetails(latestStartState)
            : out.error || '未知错误',
          {
            log: true,
            logHref: startStateLogUrl(latestStartState),
            logText: '查看后端启动日志',
            button: '重试',
            onClick: function () {
              startBackend(hub)
            }
          }
        )
      })
      .catch(function (err) {
        stopStartPoll()
        var message = String((err && err.message) || err)
        if (latestStartState)
          message = formatStartStateDetails(latestStartState)
        show('后端启动失败', message, {
          log: true,
          logHref: startStateLogUrl(latestStartState),
          logText: '查看后端启动日志',
          button: '重试',
          onClick: function () {
            startBackend(hub)
          }
        })
      })
  }

  function boot() {
    var initialHub
    loadSdk().then(function (hub) {
      initialHub = hub
      return probe()
    }).then(function (alive) {
      if (alive) return backendReady(initialHub)

      syncBackendReadyToCanvas(initialHub, false)
      show('正在检测 ComfyUI 后端…', '')
      loadSdk()
        .then(function (hub) {
          return hub.python
            .ensureEnv()
            .then(function (envRes) {
              if (envRes && envRes.ready === false) {
                throw new Error(envRes.error || 'Python 环境准备失败')
              }
              return runJson(hub, 'hub/install-backend.py', ['--info'])
            })
            .then(function (info) {
              if (info.ok === false) {
                // 脚本明确报错（如老客户端缺 HUB_PLUGIN_DATA_DIR）。此时 payload
                // 没有 platform/supported 字段，绝不能走「不支持」分支误报设备问题。
                show(
                  '无法检测 ComfyUI 后端',
                  info.error || '检测失败（' + (info.state || '未知') + '）',
                  {
                    button: '重试',
                    onClick: function () {
                      reloadClean()
                    }
                  }
                )
                return
              }
              if (!info.supported) {
                if (info.deviceState === NVIDIA_DRIVER_REQUIRED_STATE) {
                  show(
                    '需要安装显卡驱动',
                    info.unsupportedReason ||
                      '未检测到可用的显卡驱动。请先安装或升级驱动，重启电脑后再试。'
                  )
                  return
                }
                show(
                  '当前设备暂不支持',
                  info.unsupportedReason ||
                    '平台 ' + info.platform + ' 暂无 ComfyUI 后端包'
                )
                return
              }
              if (info.bundleAvailable === false) {
                show(
                  'ComfyUI 后端暂不可用',
                  info.bundleError || '无法获取 ComfyUI 后端信息，请稍后重试',
                  {
                    button: '重试',
                    onClick: function () {
                      reloadClean()
                    }
                  }
                )
                return
              }
              if (info.installing)
                return pollProgress(
                  hub,
                  info.installedVersion ? '更新' : '安装'
                )
              if (info.alreadyInstalled)
                return startBackend(hub)
              offerInstall(hub, info)
            })
        })
        .catch(function (err) {
          show('无法连接 ComfyUI 后端', String((err && err.message) || err), {
            button: '重试',
            onClick: function () {
              reloadClean()
            }
          })
        })
    })
  }

  // The hidden compiler is launched only after the managed backend is ready.
  // It exposes its API above and must not create an install/start overlay.
  if (converterMode) return

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()

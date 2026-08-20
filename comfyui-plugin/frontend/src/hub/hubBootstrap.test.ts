import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

interface OverlayElement {
  style: Record<string, string>
  textContent: string
  onclick: (() => void) | null
}

function launchBootstrapWithInfo(info: Record<string, unknown>) {
  const exitFullscreen = vi.fn()
  const pythonRun = vi.fn().mockResolvedValue({
    stdout: JSON.stringify(info),
    stderr: '',
    exitCode: 0
  })
  const elements = Object.fromEntries(
    [
      'title',
      'msg',
      'bar',
      'fill',
      'pct',
      'go',
      'log',
      'log-link',
      'close'
    ].map((role) => [
      role,
      {
        style: {},
        textContent: '',
        onclick: null
      }
    ])
  ) as Record<string, OverlayElement>
  const overlay = {
    style: {},
    innerHTML: '',
    remove: vi.fn(),
    querySelector: (selector: string) => {
      const role = selector.match(/data-role=([^\]]+)/)?.[1]
      return role ? elements[role] : null
    }
  }
  const location = {
    href: 'http://workspace.hilo.localhost/api/plugins/comfyui/static/index.html',
    port: '8002',
    search: '',
    reload: vi.fn(),
    replace: vi.fn()
  }
  const windowObject: Record<string, unknown> = {
    parent: {},
    location
  }
  const document = {
    readyState: 'complete',
    createElement: (tagName: string) => {
      if (tagName === 'div') return overlay
      return {
        src: '',
        onload: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined
      }
    },
    body: { appendChild: vi.fn() },
    head: {
      appendChild: (script: { onload?: () => void }) => {
        windowObject.hub = {
          ui: { exitFullscreen },
          python: {
            ensureEnv: vi.fn().mockResolvedValue({ ready: true }),
            run: pythonRun
          }
        }
        script.onload?.()
      }
    }
  }
  const fetchMock = vi.fn().mockResolvedValue({ ok: false })
  const source = readFileSync('public/hub-bootstrap.js', 'utf8')

  runInNewContext(source, {
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    document,
    fetch: fetchMock,
    location,
    Promise,
    setInterval,
    setTimeout,
    window: windowObject
  })

  return { elements, exitFullscreen, overlay, pythonRun }
}

describe('Hub ComfyUI bootstrap', () => {
  it('derives converterMode from the launch parameter before using it', () => {
    const source = readFileSync('public/hub-bootstrap.js', 'utf8')
    const declaration = source.indexOf(
      "var converterMode = launchParams.get('hubConverter') === '1'"
    )
    const usage = source.indexOf('if (!converterMode)')

    expect(declaration).toBeGreaterThanOrEqual(0)
    expect(usage).toBeGreaterThan(declaration)
  })

  it('marks Hub iframe runs before the ComfyUI application starts', () => {
    const source = readFileSync('public/hub-bootstrap.js', 'utf8')
    const embeddedDeclaration = source.indexOf(
      'var embedded = window.parent !== window'
    )
    const embeddedMarker = source.indexOf(
      'window.__COMFY_HUB_EMBEDDED__ = embedded'
    )

    expect(embeddedDeclaration).toBeGreaterThanOrEqual(0)
    expect(embeddedMarker).toBeGreaterThan(embeddedDeclaration)
  })

  it('loads a persisted workflow by its filename instead of reusing the startup draft', () => {
    const source = readFileSync('public/hub-bootstrap.js', 'utf8')

    expect(source).toContain('requested.workflowName')
    expect(source).toContain('reuseActiveWorkflow: false')
    expect(source).not.toContain(
      "reuseActiveWorkflow: workflowTarget === 'current'"
    )
  })

  it('offers a retry when a supported device cannot fetch its backend bundle', () => {
    const source = readFileSync('public/hub-bootstrap.js', 'utf8')

    expect(source).toContain('if (info.bundleAvailable === false)')
    expect(source).toContain("'ComfyUI 后端暂不可用'")
    expect(source).toContain(
      "info.bundleError || '无法获取 ComfyUI 后端信息，请稍后重试'"
    )
  })

  it('syncs backend readiness separately from workflow-node state', () => {
    const source = readFileSync('public/hub-bootstrap.js', 'utf8')

    expect(source).toContain(
      'function syncBackendReadyToCanvas(hub, backendReady)'
    )
    expect(source).toContain('comfyuiBackendReady: backendReady')
    expect(source).toContain(
      'return syncBackendReadyToCanvas(hub, true).then(loadRequestedWorkflow)'
    )
    expect(source).toContain('syncBackendReadyToCanvas(initialHub, false)')
  })

  it('loads the Hub SDK before probing an already-running backend', async () => {
    const events: string[] = []
    const fetchMock = vi.fn(async () => {
      events.push('backend-probe')
      return { ok: true }
    })
    const location = {
      href: 'http://workspace.hilo.localhost/api/plugins/comfyui/static/index.html',
      port: '8002',
      search: '',
      reload: vi.fn(),
      replace: vi.fn()
    }
    const windowObject: Record<string, unknown> = {
      parent: {},
      location
    }
    const document = {
      readyState: 'complete',
      createElement: () => ({
        src: '',
        onload: undefined as (() => void) | undefined,
        onerror: undefined as (() => void) | undefined
      }),
      head: {
        appendChild: (script: { src: string; onload?: () => void }) => {
          events.push(script.src)
          windowObject.hub = {}
          script.onload?.()
        }
      }
    }
    const source = readFileSync('public/hub-bootstrap.js', 'utf8')

    runInNewContext(source, {
      URLSearchParams,
      clearInterval,
      clearTimeout,
      console,
      document,
      fetch: fetchMock,
      location,
      Promise,
      setInterval,
      setTimeout,
      window: windowObject
    })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    expect(events).toEqual(['/__hub-sdk__.js', 'backend-probe'])
  })

  it('lets a backend status overlay exit Hub fullscreen', async () => {
    const { elements, exitFullscreen, overlay } = launchBootstrapWithInfo({
      supported: false,
      platform: 'test'
    })

    await vi.waitFor(() =>
      expect(elements.close.onclick).toBeTypeOf('function')
    )
    elements.close.onclick?.()

    expect(exitFullscreen).toHaveBeenCalledOnce()
    expect(overlay.remove).not.toHaveBeenCalled()
  })

  it('prompts users to install a GPU driver without naming a vendor', async () => {
    const { elements } = launchBootstrapWithInfo({
      supported: false,
      platform: 'win32-x64',
      deviceState: 'nvidia-driver-required',
      unsupportedReason:
        '检测到显卡，但未检测到可用的显卡驱动。请先安装或升级驱动，重启电脑后再试。'
    })

    await vi.waitFor(() =>
      expect(elements.title.textContent).toBe('需要安装显卡驱动')
    )
    expect(elements.msg.textContent).toContain('请先安装或升级驱动')
    expect(elements.msg.textContent).not.toContain('NVIDIA')
  })

  it('offers a backend switch when the version matches but the target differs', async () => {
    const { elements } = launchBootstrapWithInfo({
      supported: true,
      bundleAvailable: true,
      installing: false,
      installedVersion: '0.1.10',
      targetVersion: '0.1.10',
      alreadyInstalled: false,
      sizeBytes: 0
    })

    await vi.waitFor(() =>
      expect(elements.title.textContent).toBe(
        '需要切换适配当前显卡的 ComfyUI 后端'
      )
    )
    expect(elements.go.textContent).toBe('立即更新')
  })
})

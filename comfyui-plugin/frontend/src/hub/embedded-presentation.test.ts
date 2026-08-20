import { afterEach, describe, expect, it } from 'vitest'

import {
  isHubEmbedded,
  resolveCanvasInfoVisibility,
  resolveFitViewZoom
} from './embedded-presentation'

describe('embedded presentation', () => {
  afterEach(() => {
    delete (window as Window & { __COMFY_HUB_EMBEDDED__?: boolean })
      .__COMFY_HUB_EMBEDDED__
  })

  it('keeps the standard ComfyUI presentation outside Hub', () => {
    expect(isHubEmbedded()).toBe(false)
    expect(resolveCanvasInfoVisibility(true)).toBe(true)
    expect(resolveCanvasInfoVisibility(false)).toBe(false)
    expect(resolveFitViewZoom()).toBe(0.75)
  })

  it('hides canvas diagnostics and tightens the view in Hub', () => {
    ;(window as Window & { __COMFY_HUB_EMBEDDED__?: boolean }).__COMFY_HUB_EMBEDDED__ = true

    expect(isHubEmbedded()).toBe(true)
    expect(resolveCanvasInfoVisibility(true)).toBe(false)
    expect(resolveFitViewZoom()).toBe(0.85)
  })
})

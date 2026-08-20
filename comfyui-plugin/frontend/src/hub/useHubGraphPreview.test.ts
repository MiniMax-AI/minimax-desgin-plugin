import { describe, expect, it, vi } from 'vitest'

import {
  getHubFullscreenPreviewState,
  resolveHubGraphPreview,
  scheduleAfterCanvasLayout
} from '@/hub/useHubGraphPreview'

describe('resolveHubGraphPreview', () => {
  it('uses graph preview only for an embedded non-fullscreen editor', () => {
    expect(resolveHubGraphPreview(true, false)).toBe(true)
    expect(resolveHubGraphPreview(true, true)).toBe(false)
    expect(resolveHubGraphPreview(false, false)).toBe(false)
  })
})

describe('getHubFullscreenPreviewState', () => {
  it('reads fullscreen state from a Hub host event', () => {
    expect(
      getHubFullscreenPreviewState({
        kind: 'hub:event',
        topic: 'fullscreen:changed',
        payload: { fullscreen: false }
      })
    ).toBe(false)
  })

  it('ignores unrelated messages', () => {
    expect(
      getHubFullscreenPreviewState({
        kind: 'hub:event',
        topic: 'incoming',
        payload: null
      })
    ).toBeUndefined()
  })
})

describe('scheduleAfterCanvasLayout', () => {
  it('waits for two animation frames before fitting the graph', () => {
    const frames: FrameRequestCallback[] = []
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const callback = vi.fn()

    const originalRequestAnimationFrame = window.requestAnimationFrame
    window.requestAnimationFrame = requestAnimationFrame
    try {
      scheduleAfterCanvasLayout(callback)
      expect(callback).not.toHaveBeenCalled()

      frames.shift()?.(0)
      expect(callback).not.toHaveBeenCalled()

      frames.shift()?.(0)
      expect(callback).toHaveBeenCalledOnce()
    } finally {
      window.requestAnimationFrame = originalRequestAnimationFrame
    }
  })
})

import { describe, expect, it } from 'vitest'

import { shouldReuseActiveWorkflow } from './workflowLoadTarget'

describe('shouldReuseActiveWorkflow', () => {
  it('lets an explicit false create a fresh workflow in Hub mode', () => {
    expect(shouldReuseActiveWorkflow(false, true)).toBe(false)
  })

  it('reuses the active workflow by default in Hub mode', () => {
    expect(shouldReuseActiveWorkflow(undefined, true)).toBe(true)
  })

  it('respects an explicit reuse request outside Hub mode', () => {
    expect(shouldReuseActiveWorkflow(true, false)).toBe(true)
  })
})

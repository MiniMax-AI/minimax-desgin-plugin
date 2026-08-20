import { describe, expect, it } from 'vitest'

import { resolveUniqueHubWorkflowPath } from '@/hub/hubWorkflowName'

describe('resolveUniqueHubWorkflowPath', () => {
  it('keeps the template name when it is available', () => {
    expect(
      resolveUniqueHubWorkflowPath('workflows/模板.json', () => false)
    ).toBe('workflows/模板.json')
  })

  it('uses hyphenated suffixes for existing template workflow names', () => {
    const occupied = new Set(['workflows/模板.json', 'workflows/模板-1.json'])
    expect(
      resolveUniqueHubWorkflowPath('workflows/模板.json', (path) =>
        occupied.has(path)
      )
    ).toBe('workflows/模板-2.json')
  })
})

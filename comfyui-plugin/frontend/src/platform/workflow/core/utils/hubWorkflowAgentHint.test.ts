import { describe, expect, it } from 'vitest'

import {
  hasHubWorkflowAgentHint,
  normalizeHubWorkflowAgentHint,
  readHubWorkflowAgentHint,
  setHubWorkflowAgentHint
} from './hubWorkflowAgentHint'

describe('hubWorkflowAgentHint', () => {
  it('normalizes whitespace and length', () => {
    expect(normalizeHubWorkflowAgentHint(`  ${'a'.repeat(250)}  `)).toBe(
      'a'.repeat(200)
    )
  })

  it('preserves unrelated workflow metadata', () => {
    const workflow = { extra: { ds: { scale: 1 }, hub: { custom: true } } }

    setHubWorkflowAgentHint(workflow, ' Product photos ')

    expect(workflow.extra).toEqual({
      ds: { scale: 1 },
      hub: {
        custom: true,
        schema_version: 1,
        agent_hint: 'Product photos'
      }
    })
  })

  it('distinguishes an empty saved hint from missing metadata', () => {
    const workflow = { extra: {} }

    expect(hasHubWorkflowAgentHint(workflow)).toBe(false)
    setHubWorkflowAgentHint(workflow, '')
    expect(hasHubWorkflowAgentHint(workflow)).toBe(true)
    expect(readHubWorkflowAgentHint(workflow)).toBe('')
  })
})

import { describe, expect, it } from 'vitest'

import {
  extractComfyBaseDirectory,
  replaceComfyModelPaths
} from '@/hub/model-path'

describe('Hub ComfyUI model paths', () => {
  it('extracts the managed base directory from system stats', () => {
    expect(
      extractComfyBaseDirectory({
        system: {
          argv: [
            '/backend/ComfyUI/main.py',
            '--port',
            '18188',
            '--base-directory',
            '/Users/test/.hub-dev/plugin-data/comfyui/userdata'
          ]
        }
      })
    ).toBe('/Users/test/.hub-dev/plugin-data/comfyui/userdata')
  })

  it('returns null for malformed system stats', () => {
    expect(
      extractComfyBaseDirectory({ system: { argv: 'invalid' } })
    ).toBeNull()
    expect(
      extractComfyBaseDirectory({ system: { argv: ['--base-directory'] } })
    ).toBeNull()
  })

  it('replaces embedded-doc model paths with the managed path', () => {
    expect(
      replaceComfyModelPaths(
        'Models are detected in `ComfyUI/models/diffusion_models`.',
        '/Users/test/.hub-dev/plugin-data/comfyui/userdata/'
      )
    ).toBe(
      'Models are detected in `/Users/test/.hub-dev/plugin-data/comfyui/userdata/models/diffusion_models`.'
    )
  })
})

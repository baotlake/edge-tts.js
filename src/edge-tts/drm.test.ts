import { describe, expect, it } from 'vitest'

import { DRM } from './drm'

describe('DRM.headersWithMuid', () => {
  it('adds a random uppercase MUID cookie without mutating the source headers', () => {
    const headers = { Accept: '*/*' }
    const withMuid = DRM.headersWithMuid(headers)

    expect(withMuid).toMatchObject({
      Accept: '*/*',
    })
    expect(withMuid.Cookie).toMatch(/^muid=[0-9A-F]{32};$/)
    expect(headers).toEqual({ Accept: '*/*' })
  })

  it('rejects existing cookie headers', () => {
    expect(() => DRM.headersWithMuid({ Cookie: 'foo=bar' })).toThrow(
      'Cookie header already set.',
    )
  })
})

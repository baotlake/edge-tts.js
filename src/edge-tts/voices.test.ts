import { afterEach, describe, expect, it, vi } from 'vitest'

import { DRM } from './drm'
import { listVoices } from './voices'

describe('listVoices', () => {
  afterEach(() => {
    DRM.clockSkewSeconds = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('fills in missing VoiceTag arrays from the API response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            Name: 'Example Voice',
            ShortName: 'en-US-ExampleNeural',
            Gender: 'Female',
            Locale: 'en-US',
            SuggestedCodec: 'audio-24khz-48kbitrate-mono-mp3',
            FriendlyName: 'Example Voice',
            Status: 'GA',
          },
        ]),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    )

    vi.stubGlobal('fetch', fetchMock)

    const [voice] = await listVoices()

    expect(voice.VoiceTag).toEqual({
      ContentCategories: [],
      VoicePersonalities: [],
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        Cookie: expect.stringMatching(/^muid=[0-9A-F]{32};$/),
      }),
    })
  })

  it('retries a 403 response after reading the Date header', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('Forbidden', {
          status: 403,
          headers: {
            date: 'Wed, 27 May 2026 00:00:00 GMT',
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              Name: 'Example Voice',
              ShortName: 'en-US-ExampleNeural',
              Gender: 'Female',
              Locale: 'en-US',
              SuggestedCodec: 'audio-24khz-48kbitrate-mono-mp3',
              FriendlyName: 'Example Voice',
              Status: 'GA',
              VoiceTag: {
                ContentCategories: ['General'],
                VoicePersonalities: ['Friendly'],
              },
            },
          ]),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
            },
          },
        ),
      )

    vi.stubGlobal('fetch', fetchMock)

    const voices = await listVoices()

    expect(voices).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(DRM.clockSkewSeconds).not.toBe(0)
  })
})

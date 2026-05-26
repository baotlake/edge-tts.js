/**
 * This module contains functions to list all available voices and a class to find the
 * correct voice based on their attributes.
 */

import {
  SEC_MS_GEC_VERSION,
  VOICE_HEADERS,
  VOICE_LIST,
} from './constants'
import { DRM, type HttpClientResponseError } from './drm'
import { Voice, VoicesManagerFind, VoicesManagerVoice } from './typing'

// --- Private Helper Function ---

/**
 * A custom error class to handle HTTP responses that are not OK.
 * This helps in differentiating fetch errors from other exceptions.
 */
class HttpResponseError extends Error implements HttpClientResponseError {
  public status: number
  public headers: Record<string, string>

  constructor(response: Response) {
    super(`HTTP Error: ${response.status} ${response.statusText}`)
    this.name = 'HttpResponseError'
    this.status = response.status
    this.headers = Object.fromEntries(response.headers.entries())
  }
}

/**
 * Private function that makes the request to the voice list URL and parses the JSON response.
 * @private
 */
async function _listVoices(proxy?: string): Promise<Voice[]> {
  const url = new URL(VOICE_LIST)
  url.searchParams.append('Sec-MS-GEC', DRM.generateSecMsGec())
  url.searchParams.append('Sec-MS-GEC-Version', SEC_MS_GEC_VERSION)

  const finalUrl = proxy ? proxy + url.toString() : url.toString()

  const response = await fetch(finalUrl, {
    headers: DRM.headersWithMuid(VOICE_HEADERS),
  })

  if (!response.ok) {
    throw new HttpResponseError(response)
  }

  const data = (await response.json()) as Array<Partial<Voice>>

  return data.map((voice) => ({
    ...voice,
    VoiceTag: {
      ContentCategories: voice.VoiceTag?.ContentCategories ?? [],
      VoicePersonalities: voice.VoiceTag?.VoicePersonalities ?? [],
    },
  })) as Voice[]
}

// --- Public API ---

/**
 * Lists all available voices and their attributes by fetching them from Microsoft's service.
 *
 * @param proxy Optional. The proxy server URL to use for the request.
 * @returns A promise that resolves to a list of voices and their attributes.
 */
export async function listVoices(proxy?: string): Promise<Voice[]> {
  try {
    return await _listVoices(proxy)
  } catch (error) {
    if (error instanceof HttpResponseError && error.status === 403) {
      DRM.handleClientResponseError(error)
      return await _listVoices(proxy)
    }
    throw error
  }
}

/**
 * A class to easily find voices based on their attributes.
 */
export class VoicesManager {
  public voices: VoicesManagerVoice[] = []
  private calledCreate: boolean = false

  // A private constructor ensures that instances are only created via the async `create` method.
  private constructor() {}

  /**
   * Asynchronously creates and initializes a VoicesManager instance.
   *
   * @param customVoices Optional. A pre-existing list of voices to use instead of fetching them.
   * @returns A promise that resolves to a fully initialized VoicesManager instance.
   */
  public static async create(
    customVoices?: Voice[],
  ): Promise<VoicesManager> {
    const manager = new VoicesManager()
    const voices = customVoices ?? (await listVoices())

    manager.voices = voices.map((voice) => ({
      ...voice,
      Language: voice.Locale.split('-')[0] as string,
    }))

    manager.calledCreate = true
    return manager
  }

  /**
   * Finds all matching voices based on the provided filter attributes.
   *
   * @param filters An object containing the criteria to filter voices by (e.g., { Gender: 'Male', Language: 'en' }).
   * @returns A list of voices that match the criteria.
   */
  public find(filters: VoicesManagerFind): VoicesManagerVoice[] {
    if (!this.calledCreate) {
      throw new Error(
        'VoicesManager.find() was called before VoicesManager.create() completed.',
      )
    }

    const filterEntries = Object.entries(filters)
    if (filterEntries.length === 0) {
      return this.voices
    }

    return this.voices.filter((voice) => {
      return filterEntries.every(([key, value]) => {
        return voice[key as keyof VoicesManagerVoice] === value
      })
    })
  }
}

/**
 * Communicate with the service. Only the Communicate class should be used by
 * end-users. The other classes and functions are for internal use only.
 */

import { WebSocket } from 'ws'
import {
  DEFAULT_VOICE,
  MP3_BITRATE_BPS,
  SEC_MS_GEC_VERSION,
  TICKS_PER_SECOND,
  WSS_HEADERS,
  WSS_URL,
} from './constants'
import { TTSConfig } from './data_classes'
import { DRM, type HttpClientResponseError } from './drm'
import {
  NoAudioReceived,
  UnexpectedResponse,
  UnknownResponse,
  WebSocketError,
} from './exceptions'
import type { CommunicateState, TTSChunk } from './typing'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder('utf-8')

/**
 * A simple XML escaper.
 */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A simple XML unescaper.
 */
function unescapeXml(text: string): string {
  return text.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

// FIX: Added a helper to find a subarray, necessary for correct header parsing.
function findSubarray(arr: Uint8Array, sub: Uint8Array): number {
  for (let i = 0; i <= arr.length - sub.length; i++) {
    let found = true
    for (let j = 0; j < sub.length; j++) {
      if (arr[i + j] !== sub[j]) {
        found = false
        break
      }
    }
    if (found) return i
  }
  return -1
}

export function getHeadersAndData(
  data: Uint8Array,
  headerLength: number,
): [Record<string, string>, Uint8Array] {
  const headers: Record<string, string> = {}
  const headerStr = textDecoder.decode(data.subarray(0, headerLength))

  for (const line of headerStr.split('\r\n')) {
    const [key, value] = line.split(':', 2)
    if (key && value) {
      headers[key.trim()] = value.trim()
    }
  }

  // Body starts after the header block and the \r\n\r\n separator.
  return [headers, data.subarray(headerLength + 4)]
}

export function removeIncompatibleCharacters(text: string): string {
  let result = ''
  for (const char of text) {
    const code = char.charCodeAt(0)
    if (
      (code >= 0 && code <= 8) ||
      (code >= 11 && code <= 12) ||
      (code >= 14 && code <= 31)
    ) {
      result += ' '
    } else {
      result += char
    }
  }
  return result
}

export function connectId(): string {
  // Use crypto.randomUUID for modern environments
  return crypto.randomUUID().replace(/-/g, '')
}

function _findLastIndexOf(
  arr: Uint8Array,
  search: number,
  limit: number,
): number {
  for (let i = Math.min(limit, arr.length) - 1; i >= 0; i--) {
    if (arr[i] === search) {
      return i
    }
  }
  return -1
}

function _findLastNewlineOrSpaceWithinLimit(
  text: Uint8Array,
  limit: number,
): number {
  let splitAt = _findLastIndexOf(text, 10, limit) // \n
  if (splitAt < 0) {
    splitAt = _findLastIndexOf(text, 32, limit) // space
  }
  return splitAt
}

function _findSafeUtf8SplitPoint(textSegment: Uint8Array): number {
  let splitAt = textSegment.length
  const decoder = new TextDecoder('utf-8', { fatal: true })
  while (splitAt > 0) {
    try {
      decoder.decode(textSegment.subarray(0, splitAt))
      return splitAt
    } catch {
      splitAt--
    }
  }
  return splitAt
}

function _adjustSplitPointForXmlEntity(
  text: Uint8Array,
  splitAt: number,
): number {
  const ampersand = 38 // '&'
  const semicolon = 59 // ';'

  let lastAmp = _findLastIndexOf(text, ampersand, splitAt)
  while (lastAmp !== -1) {
    // Check if a semicolon exists between the ampersand and the split point
    let hasSemicolon = false
    for (let i = lastAmp; i < splitAt; i++) {
      if (text[i] === semicolon) {
        hasSemicolon = true
        break
      }
    }

    if (hasSemicolon) {
      // Found a terminated entity (like &amp;), safe to break
      break
    }

    // Ampersand is not terminated, move split_at to it
    splitAt = lastAmp
    lastAmp = _findLastIndexOf(text, ampersand, splitAt)
  }
  return splitAt
}

function trimUint8Array(arr: Uint8Array): Uint8Array {
  let start = 0
  while (
    start < arr.length &&
    (arr[start] === 32 ||
      arr[start] === 10 ||
      arr[start] === 13 ||
      arr[start] === 9)
  ) {
    start++
  }
  let end = arr.length
  while (
    end > start &&
    (arr[end - 1] === 32 ||
      arr[end - 1] === 10 ||
      arr[end - 1] === 13 ||
      arr[end - 1] === 9)
  ) {
    end--
  }
  return arr.subarray(start, end)
}

export function* splitTextByByteLength(
  text: string,
  byteLength: number,
): Generator<Uint8Array, void, unknown> {
  if (byteLength <= 0) {
    throw new Error('byte_length must be greater than 0')
  }

  let buffer = textEncoder.encode(text)

  while (buffer.length > byteLength) {
    let splitAt = _findLastNewlineOrSpaceWithinLimit(buffer, byteLength)

    if (splitAt < 0) {
      splitAt = _findSafeUtf8SplitPoint(buffer.subarray(0, byteLength))
    }

    splitAt = _adjustSplitPointForXmlEntity(buffer, splitAt)

    if (splitAt <= 0) {
      throw new Error(
        'Maximum byte length is too small or invalid text structure.',
      )
    }

    const chunk = buffer.subarray(0, splitAt)
    // FIX: Trim whitespace from chunks to match Python's .strip() behavior.
    const trimmedChunk = trimUint8Array(chunk)
    if (trimmedChunk.length > 0) {
      yield trimmedChunk
    }

    buffer = buffer.subarray(splitAt)
  }

  const remainingChunk = trimUint8Array(buffer)
  if (remainingChunk.length > 0) {
    yield remainingChunk
  }
}

export function mkssml(tc: TTSConfig, escapedText: string): string {
  return (
    "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${tc.voice}'>` +
    `<prosody pitch='${tc.pitch}' rate='${tc.rate}' volume='${tc.volume}'>` +
    `${escapedText}` +
    '</prosody>' +
    '</voice>' +
    '</speak>'
  )
}

// FIX: Corrected the date format to exactly match the Python implementation.
// The original `toUTCString()` adds a comma which the service may reject.
export function dateToString(): string {
  const d = new Date()
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]

  return [
    days[d.getUTCDay()],
    months[d.getUTCMonth()],
    d.getUTCDate().toString(), // No padding needed based on Python's %d
    d.getUTCFullYear(),
    [
      d.getUTCHours().toString().padStart(2, '0'),
      d.getUTCMinutes().toString().padStart(2, '0'),
      d.getUTCSeconds().toString().padStart(2, '0'),
    ].join(':'),
    'GMT+0000 (Coordinated Universal Time)',
  ].join(' ')
}

export function ssmlHeadersPlusData(
  requestId: string,
  timestamp: string,
  ssml: string,
): string {
  return (
    `X-RequestId:${requestId}\r\n` +
    'Content-Type:application/ssml+xml\r\n' +
    `X-Timestamp:${timestamp}Z\r\n` +
    'Path:ssml\r\n\r\n' +
    `${ssml}`
  )
}

type Connect = (
  ...args: ConstructorParameters<typeof WebSocket>
) => Promise<WebSocket | globalThis.WebSocket>

function canUseBrowserWebSocket(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof document !== 'undefined' &&
    typeof globalThis.WebSocket === 'function'
  )
}

class WebSocketHandshakeError
  extends Error
  implements HttpClientResponseError
{
  headers: Record<string, string>
  status: number | undefined

  constructor(status: number | undefined, headers: Record<string, string>) {
    super(
      typeof status === 'number'
        ? `WebSocket handshake failed: ${status}`
        : 'WebSocket handshake failed',
    )
    this.name = 'WebSocketHandshakeError'
    this.status = status
    this.headers = headers
  }
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {}

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalized[key] = value
      continue
    }

    if (Array.isArray(value)) {
      normalized[key] = value.join(', ')
    }
  }

  return normalized
}

export class Communicate {
  private tts_config: TTSConfig
  private texts: Generator<Uint8Array, void, unknown>
  private proxy: string
  private state: CommunicateState
  private connect: Connect

  constructor(
    text: string,
    voice: string = DEFAULT_VOICE,
    options: {
      rate?: string
      volume?: string
      pitch?: string
      boundary?: 'WordBoundary' | 'SentenceBoundary'
      proxy?: string
      connect?: Connect
    } = {},
  ) {
    const {
      rate = '+0%',
      volume = '+0%',
      pitch = '+0Hz',
      boundary = 'SentenceBoundary',
      proxy,
      connect,
    } = options

    this.tts_config = new TTSConfig(voice, rate, volume, pitch, boundary)
    this.texts = splitTextByByteLength(
      escapeXml(removeIncompatibleCharacters(text)),
      4096,
    )
    this.proxy = proxy || ''
    this.state = {
      partial_text: new Uint8Array(),
      offset_compensation: 0,
      last_duration_offset: 0,
      stream_was_called: false,
      chunk_audio_bytes: 0,
      cumulative_audio_bytes: 0,
    }
    this.connect = async (...args) => {
      if (canUseBrowserWebSocket()) {
        return new globalThis.WebSocket(args[0], args[1])
      }
      const WebSocket = (await import('ws')).default
      return new WebSocket(...args)
    }
    this.connect = connect || this.connect
  }

  private compensateOffset(): void {
    this.state.cumulative_audio_bytes += this.state.chunk_audio_bytes
    this.state.offset_compensation = Math.floor(
      (this.state.cumulative_audio_bytes * 8 * TICKS_PER_SECOND) /
        MP3_BITRATE_BPS,
    )
    this.state.chunk_audio_bytes = 0
  }

  private parseMetadata(data: string): TTSChunk {
    const metadata = JSON.parse(data)
    for (const metaObj of metadata['Metadata']) {
      const metaType = metaObj['Type']
      if (metaType === 'WordBoundary' || metaType === 'SentenceBoundary') {
        const parsed = {
          type: metaType,
          offset: metaObj['Data']['Offset'] + this.state.offset_compensation,
          duration: metaObj['Data']['Duration'],
          text: unescapeXml(metaObj['Data']['text']['Text']),
        }
        this.state.last_duration_offset = parsed.offset + parsed.duration
        return parsed
      } else if (metaType === 'SessionEnd') {
        continue
      }
    }
    throw new UnexpectedResponse(
      'No WordBoundary or SentenceBoundary metadata found',
    )
  }

  private async *_stream(): AsyncGenerator<TTSChunk, void, unknown> {
    const url = new URL(this.proxy + WSS_URL)
    url.searchParams.append('Sec-MS-GEC', DRM.generateSecMsGec())
    url.searchParams.append('Sec-MS-GEC-Version', SEC_MS_GEC_VERSION)
    url.searchParams.append('ConnectionId', connectId())

    const websocket = await this.connect(url.toString(), undefined, {
      headers: DRM.headersWithMuid(WSS_HEADERS),
    })

    websocket.binaryType = 'arraybuffer'
    let handshakeError: WebSocketHandshakeError | null = null

    const websocketWithEvents = websocket as typeof websocket & {
      once?: (
        event: string,
        listener: (...args: unknown[]) => void,
      ) => void
    }

    websocketWithEvents.once?.(
      'unexpected-response',
      (_request: unknown, response: unknown) => {
        const handshakeResponse = response as {
          statusCode?: number
          headers?: Record<string, string | string[] | undefined>
        }

        handshakeError = new WebSocketHandshakeError(
          handshakeResponse.statusCode,
          normalizeHeaders(handshakeResponse.headers ?? {}),
        )
      },
    )

    let audioWasReceived = false

    let messageQueue: (
      | { type: 'message'; data: string | ArrayBuffer }
      | { type: 'close'; code: number; reason: string }
      | { type: 'error'; message: string }
    )[] = []
    let waiter: ((value: void) => void) | null = null

    const waitForMessage = () => {
      return new Promise<void>((resolve) => {
        waiter = resolve
      })
    }

    try {
      await new Promise<void>((resolve, reject) => {
        if (websocket.readyState === websocket.OPEN) {
          resolve()
          return
        }
        websocket.onopen = () => resolve()
        websocket.onerror = (e: Event) => {
          if (handshakeError) {
            reject(handshakeError)
            return
          }

          reject(new WebSocketError((e as ErrorEvent).message))
        }
        websocket.onclose = (e: CloseEvent | number, reason?: string) => {
          if (handshakeError) {
            reject(handshakeError)
            return
          }

          const code = e instanceof Event ? e.code : e
          const closeReason = e instanceof Event ? e.reason : reason || ''
          reject(
            new WebSocketError(
              `WebSocket closed before opening: ${code} ${closeReason}`,
            ),
          )
        }
      })

      websocket.onmessage = (e: MessageEvent) => {
        messageQueue.push({ type: 'message', data: e.data })
        waiter?.()
      }
      websocket.onerror = (e: Event) => {
        messageQueue.push({ type: 'error', message: (e as ErrorEvent).message })
        waiter?.()
      }
      websocket.onclose = (e: CloseEvent | number, reason?: string) => {
        const code = e instanceof Event ? e.code : e
        const closeReason = e instanceof Event ? e.reason : reason || ''
        messageQueue.push({ type: 'close', code, reason: closeReason })
        waiter?.()
      }

      // Send speech config
      const wordBoundary = this.tts_config.boundary === 'WordBoundary'
      const config = {
        context: {
          synthesis: {
            audio: {
              metadataoptions: {
                sentenceBoundaryEnabled: (!wordBoundary).toString(),
                wordBoundaryEnabled: wordBoundary.toString(),
              },
              outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
            },
          },
        },
      }

      const configStr =
        `X-Timestamp:${dateToString()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        JSON.stringify(config) +
        '\r\n'
      websocket.send(configStr)

      // Send SSML
      const ssml = mkssml(
        this.tts_config,
        textDecoder.decode(this.state.partial_text),
      )
      websocket.send(ssmlHeadersPlusData(connectId(), dateToString(), ssml))

      while (true) {
        if (messageQueue.length === 0) {
          await waitForMessage()
        }
        const event = messageQueue.shift()!
        if (event.type == 'message') {
          if (typeof event.data === 'string') {
            const data = textEncoder.encode(event.data)

            const separator = textEncoder.encode('\r\n\r\n')
            const headerLength = findSubarray(data, separator)
            if (headerLength === -1) continue

            const [headers, body] = getHeadersAndData(data, headerLength)
            const path = headers['Path']

            if (path === 'audio.metadata') {
              const parsed = this.parseMetadata(textDecoder.decode(body))
              yield parsed
            } else if (path === 'turn.end') {
              this.compensateOffset()
              break
            } else if (path !== 'response' && path !== 'turn.start') {
              throw new UnknownResponse('Unknown path received')
            }
          } else if (event.data instanceof ArrayBuffer) {
            // FIX: This block is entirely rewritten for correct binary message parsing.
            const data = new Uint8Array(event.data)
            if (data.length < 2) continue

            const headerLength = new DataView(data.buffer).getUint16(0, false)
            const headersData = data.subarray(2, 2 + headerLength)
            const body = data.subarray(2 + headerLength)

            // Manually parse the headers from the header block.
            const headers: Record<string, string> = {}
            const headerStr = textDecoder.decode(headersData)
            for (const line of headerStr.split('\r\n')) {
              if (!line) continue
              const [key, value] = line.split(':', 2)
              if (key && value) {
                headers[key.trim()] = value.trim()
              }
            }

            // Perform checks to see if this is a valid audio packet.
            if (
              headers['Path'] === 'audio' &&
              headers['Content-Type'] === 'audio/mpeg'
            ) {
              if (body.length > 0) {
                audioWasReceived = true
                this.state.chunk_audio_bytes += body.length
                yield { type: 'audio', data: body }
              }
            }
          }
        } else if (event.type == 'close') {
          if (event.code !== 1000 && event.code !== 1005) {
            throw new WebSocketError(
              `WebSocket closed abnormally: ${event.code} ${event.reason}`,
            )
          }
          break
        } else if (event.type == 'error') {
          throw new WebSocketError(`WebSocket error: ${event.message}`)
        }
      }
    } finally {
      if (websocket.readyState === websocket.OPEN) {
        websocket.close(1000)
      }
    }

    if (!audioWasReceived) {
      throw new NoAudioReceived('No audio was received from the service.')
    }
  }

  async *stream(): AsyncGenerator<TTSChunk, void, unknown> {
    if (this.state.stream_was_called) {
      throw new Error('stream can only be called once.')
    }
    this.state.stream_was_called = true

    for (const textChunk of this.texts) {
      this.state.partial_text = textChunk
      this.state.chunk_audio_bytes = 0

      try {
        for await (const message of this._stream()) {
          yield message
        }
      } catch (error) {
        if (
          !(error instanceof WebSocketHandshakeError) ||
          error.status !== 403
        ) {
          throw error
        }

        DRM.handleClientResponseError(error)
        this.state.chunk_audio_bytes = 0

        for await (const message of this._stream()) {
          yield message
        }
      }
    }
  }

  async save(audio_fname: string, metadata_fname?: string): Promise<void> {
    if (typeof window !== 'undefined') {
      const audioChunks: Uint8Array<ArrayBuffer>[] = []
      const metadataChunks: string[] = []

      // Collect all chunks from the stream
      for await (const chunk of this.stream()) {
        if (chunk.type === 'audio' && chunk.data) {
          audioChunks.push(chunk.data)
        } else if (metadata_fname && chunk.type !== 'audio') {
          metadataChunks.push(JSON.stringify(chunk))
        }
      }

      // Helper function to trigger a download in the browser
      const triggerDownload = (blob: Blob, filename: string) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        URL.revokeObjectURL(url)
      }

      // Create and download the audio file
      if (audioChunks.length > 0) {
        // Assuming the audio data can be concatenated directly.
        // You might need to specify a MIME type if you know the audio format,
        // e.g., { type: 'audio/wav' }
        const audioBlob = new Blob(audioChunks, {
          type: 'application/octet-stream',
        })
        triggerDownload(audioBlob, audio_fname)
      }

      // Create and download the metadata file
      if (metadata_fname && metadataChunks.length > 0) {
        const metadataBlob = new Blob([metadataChunks.join('\n')], {
          type: 'application/json',
        })
        triggerDownload(metadataBlob, metadata_fname)
      }

      return
    }

    const { createWriteStream } = await import('fs')

    const audioStream = createWriteStream(audio_fname)
    const metadataStream = metadata_fname
      ? createWriteStream(metadata_fname)
      : null

    try {
      for await (const chunk of this.stream()) {
        if (chunk.type === 'audio' && chunk.data) {
          audioStream.write(chunk.data)
        } else if (metadataStream && chunk.type !== 'audio') {
          metadataStream.write(JSON.stringify(chunk) + '\n')
        }
      }
    } finally {
      audioStream.end()
      metadataStream?.end()
    }
  }
}

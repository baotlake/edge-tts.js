/**
 * Custom types for edge-tts.
 */

// #region TTSChunk Types

/**
 * Represents a chunk of data for a Word or Sentence boundary.
 */
interface BoundaryChunk {
  type: 'WordBoundary' | 'SentenceBoundary'
  duration: number
  offset: number
  text: string
}

/**
 * Represents a chunk of audio data.
 */
interface AudioChunk {
  type: 'audio'
  data: Uint8Array<ArrayBuffer>
}

/**
 * TTS chunk data.
 * This is a discriminated union type. Based on the `type` property,
 * TypeScript will know which other properties are available.
 */
export type TTSChunk = AudioChunk | BoundaryChunk

// #endregion

// #region Voice & VoiceTag Types

export type ContentCategory =
  | 'Cartoon'
  | 'Conversation'
  | 'Copilot'
  | 'Dialect'
  | 'General'
  | 'News'
  | 'Novel'
  | 'Sports'

export type VoicePersonality =
  | 'Approachable'
  | 'Authentic'
  | 'Authority'
  | 'Bright'
  | 'Caring'
  | 'Casual'
  | 'Cheerful'
  | 'Clear'
  | 'Comfort'
  | 'Confident'
  | 'Considerate'
  | 'Conversational'
  | 'Cute'
  | 'Expressive'
  | 'Friendly'
  | 'Honest'
  | 'Humorous'
  | 'Lively'
  | 'Passion'
  | 'Pleasant'
  | 'Positive'
  | 'Professional'
  | 'Rational'
  | 'Reliable'
  | 'Sincere'
  | 'Sunshine'
  | 'Warm'

/**
 * VoiceTag data.
 */
export interface VoiceTag {
  ContentCategories: string[]
  VoicePersonalities: string[]
}

/**
 * Voice data.
 */
export interface Voice {
  Name: string
  ShortName: string
  Gender: 'Female' | 'Male'
  Locale: string
  SuggestedCodec: string
  FriendlyName: string
  Status: 'Deprecated' | 'GA' | 'Preview'
  VoiceTag: VoiceTag
}

/**
 * Voice data for VoicesManager.
 * Extends the base Voice interface with an additional `Language` property.
 */
export interface VoicesManagerVoice extends Voice {
  Language: string
}

/**
 * Search criteria for VoicesManager.find().
 * All properties are optional.
 */
export interface VoicesManagerFind {
  Gender?: 'Female' | 'Male'
  Locale?: string
  Language?: string
}

// #endregion

// #region Communicate State Type

/**
 * Communicate state data.
 */
export interface CommunicateState {
  partial_text: Uint8Array
  offset_compensation: number
  last_duration_offset: number
  stream_was_called: boolean
  chunk_audio_bytes: number
  cumulative_audio_bytes: number
}

// #endregion

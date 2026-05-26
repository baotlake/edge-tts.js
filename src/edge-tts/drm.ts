// DRM module is used to handle DRM operations with clock skew correction.
// Currently the only DRM operation is generating the Sec-MS-GEC token value
// used in all API requests to Microsoft Edge's online text-to-speech service.

import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex } from '@noble/hashes/utils'
import { TRUSTED_CLIENT_TOKEN } from './constants'
import { SkewAdjustmentError } from './exceptions'

// --- Constants ---
export const WIN_EPOCH = 11644473600 // Seconds between Unix epoch (1970-01-01) and Windows file time epoch (1601-01-01)
export const S_TO_NS = 1e9 // Seconds to nanoseconds conversion factor

// --- Placeholder for HTTP Client Response Error ---
/**
 * Interface for a generic HTTP client response error.
 * This is a placeholder for actual HTTP client error types in TypeScript
 * (e.g., from `fetch` or `axios`). It assumes the error object might have a `headers` property.
 */
export interface HttpClientResponseError extends Error {
  headers: Record<string, string> | undefined
  status: number | undefined
}

/**
 * Class to handle DRM operations with clock skew correction.
 * Currently, the main operation is generating the Sec-MS-GEC token.
 */
export class DRM {
  static clockSkewSeconds: number = 0.0

  /**
   * Adjust the clock skew in seconds in case the system clock is off.
   *
   * This method updates the `clockSkewSeconds` static property of the DRM class
   * to the specified number of seconds.
   *
   * @param skewSeconds The number of seconds to adjust the clock skew to.
   */
  static adjClockSkewSeconds(skewSeconds: number): void {
    DRM.clockSkewSeconds += skewSeconds
  }

  /**
   * Gets the current timestamp in Unix format (seconds since 1970-01-01 UTC)
   * with clock skew correction applied.
   *
   * @returns The current timestamp in Unix format with clock skew correction.
   */
  static getUnixTimestamp(): number {
    // Date.now() returns milliseconds since epoch, so divide by 1000 for seconds.
    return Date.now() / 1000 + DRM.clockSkewSeconds
  }

  /**
   * Parses an RFC 2616 date string into a Unix timestamp.
   *
   * This function attempts to parse a date string commonly found in HTTP headers
   * (e.g., "Date" header) into a Unix timestamp (seconds since epoch).
   *
   * @param dateString RFC 2616 date string to parse.
   * @returns Unix timestamp of the parsed date string, or `null` if parsing failed.
   */
  static parseRfc2616Date(dateString: string): number | null {
    try {
      // JavaScript's built-in Date.parse() can often handle RFC 2616 formatted dates.
      // It returns milliseconds since epoch, so convert to seconds.
      const timestampMs = Date.parse(dateString)
      if (isNaN(timestampMs)) {
        return null // Return null for invalid dates
      }
      return timestampMs / 1000
    } catch (error) {
      // Log any unexpected errors during parsing but return null
      console.error('Error parsing RFC2616 date:', error)
      return null
    }
  }

  /**
   * Handles a client response error, attempting to correct clock skew.
   *
   * This method inspects the `Date` header from the server response to
   * adjust the `clockSkewSeconds`. If the `Date` header is missing or
   * cannot be parsed, a `SkewAdjustmentError` is thrown.
   *
   * @param e The client response error object to handle.
   * @throws SkewAdjustmentError If the server date is missing or invalid in the headers.
   */
  static handleClientResponseError(e: HttpClientResponseError): void {
    if (!e.headers) {
      throw new SkewAdjustmentError('No server date in headers.', { cause: e })
    }

    const serverDate = Object.entries(e.headers).find(
      ([key]) => key.toLowerCase() === 'date',
    )?.[1]
    if (typeof serverDate !== 'string') {
      throw new SkewAdjustmentError('No server date in headers.', { cause: e })
    }

    const serverDateParsed: number | null = DRM.parseRfc2616Date(serverDate)
    if (serverDateParsed === null) {
      throw new SkewAdjustmentError(
        `Failed to parse server date: ${serverDate}`,
        { cause: e },
      )
    }

    const clientDate = DRM.getUnixTimestamp()
    DRM.adjClockSkewSeconds(serverDateParsed - clientDate)
  }

  /**
   * Generates the Sec-MS-GEC token value.
   *
   * This function calculates a token based on the current time, adjusted for
   * clock skew and rounded down to the nearest 5 minutes. This time value
   * is then concatenated with a trusted client token and hashed using SHA256.
   * The result is an uppercased hexadecimal digest.
   *
   * @returns The generated Sec-MS-GEC token value as an uppercase hexadecimal string.
   *
   * @see https://github.com/rany2/edge-tts/issues/290#issuecomment-2464956570
   */
  static generateSecMsGec(): string {
    // Get the current timestamp in Unix format with clock skew correction
    let ticks = DRM.getUnixTimestamp()

    // Switch to Windows file time epoch (1601-01-01 00:00:00 UTC)
    ticks += WIN_EPOCH

    // Round down to the nearest 5 minutes (300 seconds)
    ticks -= ticks % 300

    // Convert the ticks to 100-nanosecond intervals (Windows file time format)
    // Python's `1e9 / 100` simplifies to `1e7`.
    ticks *= S_TO_NS / 100

    // Create the string to hash by concatenating the ticks and the trusted client token
    // Use Math.round to match Python's :.0f formatting for integers
    const strToHash = `${Math.round(ticks)}${TRUSTED_CLIENT_TOKEN}`

    // Compute the SHA256 hash using @noble/hashes and return the uppercased hex digest
    const hash = sha256(new TextEncoder().encode(strToHash))
    return bytesToHex(hash).toUpperCase()
  }

  static generateMuid(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  }

  static headersWithMuid(headers: Record<string, string>): Record<string, string> {
    if (Object.keys(headers).some((key) => key.toLowerCase() === 'cookie')) {
      throw new Error('Cookie header already set.')
    }

    return {
      ...headers,
      Cookie: `muid=${DRM.generateMuid()};`,
    }
  }
}

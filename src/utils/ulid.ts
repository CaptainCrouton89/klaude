/**
 * ULID (Universally Unique Lexicographically Sortable Identifier) generator
 * Format: 48-bit timestamp + 80-bit random
 * Sortable by creation time, URL-safe characters
 */

import { randomBytes } from 'crypto';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LENGTH = 10; // 48-bit timestamp expressed in Crockford base32
const RANDOM_LENGTH = 16; // 80 bits of entropy (16 characters)

/**
 * Generate a ULID string using current timestamp and cryptographically secure randomness.
 */
export function generateULID(now: number = Date.now()): string {
  const timeEncoded = encodeTime(now, TIME_LENGTH);
  const randomEncoded = encodeRandom(RANDOM_LENGTH);
  return timeEncoded + randomEncoded;
}

/**
 * Encode the millisecond timestamp into Crockford base32 with fixed length.
 */
function encodeTime(timestamp: number, length: number): string {
  let value = timestamp;
  let encoded = '';

  for (let i = 0; i < length; i++) {
    const index = value % ULID_ALPHABET.length;
    encoded = ULID_ALPHABET[index] + encoded;
    value = Math.floor(value / ULID_ALPHABET.length);
  }

  return encoded;
}

/**
 * Generate Crockford base32 random component with cryptographically secure randomness.
 */
function encodeRandom(length: number): string {
  const buffer = randomBytes(length);
  let encoded = '';

  for (let i = 0; i < length; i++) {
    const index = buffer[i] % ULID_ALPHABET.length;
    encoded += ULID_ALPHABET[index];
  }

  return encoded;
}

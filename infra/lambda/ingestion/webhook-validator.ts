/**
 * Webhook secret key validation.
 *
 * Validates incoming webhook requests by comparing the provided secret key
 * against the expected shared secret using a constant-time comparison.
 *
 * Requirements: 6.1, 6.2
 */

import { timingSafeEqual } from "crypto";

/**
 * Validates a webhook request by comparing the provided secret key
 * against the expected secret using constant-time comparison to prevent
 * timing attacks.
 *
 * @param providedSecret - The secret from the x-webhook-secret header
 * @param expectedSecret - The shared webhook secret stored in Secrets Manager
 * @returns true if the secrets match, false otherwise
 */
export function validateWebhookSecret(
  providedSecret: string,
  expectedSecret: string,
): boolean {
  if (!providedSecret || !expectedSecret) {
    return false;
  }

  try {
    const providedBuffer = Buffer.from(providedSecret, "utf8");
    const expectedBuffer = Buffer.from(expectedSecret, "utf8");

    // Buffers must be the same length for timingSafeEqual
    if (providedBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return timingSafeEqual(providedBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

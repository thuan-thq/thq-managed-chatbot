# Webhook Secret Key Auth Bugfix Design

## Overview

The ingestion Lambda's webhook authentication currently uses HMAC-SHA256 signature verification, which requires the caller to compute a hash of the request body using a shared secret. Strapi cannot natively produce HMAC signatures in its webhook headers - it can only send static header values. This fix replaces HMAC validation with direct secret key comparison: the Lambda reads the `x-webhook-secret` header and performs a constant-time equality check against the stored secret from Secrets Manager. The fix is minimal and scoped to the authentication step only; all downstream processing (dedup, routing, S3 persistence, Bedrock sync) remains untouched.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - webhook requests authenticated via `x-webhook-signature` HMAC validation instead of direct `x-webhook-secret` header comparison
- **Property (P)**: The desired behavior - requests with a valid `x-webhook-secret` header matching the stored secret are accepted; all others are rejected with 401
- **Preservation**: Existing downstream behavior (dedup checking, JSON parsing, event routing, S3 persistence, Bedrock KB sync, error handling) that must remain unchanged
- **handleWebhook**: The function in `infra/lambda/ingestion/handler.ts` that orchestrates webhook authentication and processing
- **validateHmacSignature**: The function in `infra/lambda/ingestion/webhook-validator.ts` that computes and compares HMAC-SHA256 signatures (to be replaced)
- **webhookSecret**: The shared secret stored in Secrets Manager at `/{clientId}/secrets/datasource` under the `webhookSecret` field

## Bug Details

### Bug Condition

The bug manifests when Strapi sends a webhook request with the shared secret in a static header. The current `handleWebhook` function requires an `x-webhook-signature` header containing a computed HMAC-SHA256 digest, which Strapi cannot produce without custom middleware. Requests from Strapi's native webhook system are always rejected.

**Formal Specification:**

```
FUNCTION isBugCondition(input)
  INPUT: input of type { headers: Record<string, string>, body: string }
  OUTPUT: boolean

  RETURN input.headers["x-webhook-secret"] IS NOT EMPTY
         AND input.headers["x-webhook-secret"] == storedWebhookSecret
         AND (input.headers["x-webhook-signature"] IS EMPTY
              OR validateHmacSignature(input.body, input.headers["x-webhook-signature"], storedWebhookSecret) == false)
END FUNCTION
```

### Examples

- **Valid Strapi request rejected**: Strapi sends `x-webhook-secret: webhook-friedrice-secret` with a JSON body. Current code returns 401 because `x-webhook-signature` header is missing.
- **Correct secret, no HMAC**: Request has `x-webhook-secret: webhook-friedrice-secret` but no `x-webhook-signature`. Current code returns 401 ("missing signature"). Expected: 200.
- **Wrong secret rejected**: Request has `x-webhook-secret: wrong-value`. Expected after fix: 401 ("invalid secret").
- **Missing secret header rejected**: Request has neither `x-webhook-secret` nor `x-webhook-signature`. Expected after fix: 401 ("missing secret").

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- Dedup checking via DynamoDB (isDuplicate/recordProcessed) must continue to work for authenticated requests
- JSON payload parsing and 400 response for invalid payloads must remain
- WebhookEventRouter routing to create/update/delete handlers must remain
- S3 persistence and Bedrock KB sync triggers must remain
- 500 response on processing failure (without dedup recording) must remain
- 500 response when Secrets Manager retrieval fails must remain
- Event ID extraction from headers or body must remain
- Collection routing via path parameter must remain (intranet-pages, intranet-teams, intranet-people)

**Scope:**
All inputs that pass or fail authentication reach the same downstream logic. The fix changes ONLY:

- Which header is checked (from `x-webhook-signature` to `x-webhook-secret`)
- How validation is performed (from HMAC computation to direct comparison)

Everything after the authentication gate is unaffected:

- Dedup logic
- Payload parsing
- Event routing
- S3 writes
- Bedrock sync
- Error responses for non-auth failures

## Hypothesized Root Cause

Based on the bug description, the root cause is a design mismatch:

1. **Over-engineered authentication**: The system uses HMAC-SHA256 signature verification (`validateHmacSignature`) which requires the caller to compute `HMAC(body, secret)`. Strapi's native webhooks cannot compute this - they can only attach static header values.

2. **Wrong header name**: The code checks for `x-webhook-signature` (an HMAC digest) rather than `x-webhook-secret` (the raw shared secret). Strapi sends the secret directly in a custom header.

3. **Unnecessary body dependency**: HMAC ties authentication to the request body content, adding complexity with no security benefit over direct secret comparison for this use case (both rely on knowing the shared secret).

4. **No alternative auth path**: There is no fallback mechanism - if the caller cannot produce an HMAC signature, the request is unconditionally rejected.

## Correctness Properties

Property 1: Bug Condition - Secret Key Authentication Accepts Valid Requests

_For any_ webhook request where the `x-webhook-secret` header value matches the stored webhook secret (constant-time comparison), the fixed `handleWebhook` function SHALL accept the request and proceed to downstream processing (dedup check, payload parsing, event routing).

**Validates: Requirements 2.1, 2.2, 2.5**

Property 2: Bug Condition - Secret Key Authentication Rejects Invalid Requests

_For any_ webhook request where the `x-webhook-secret` header is missing or its value does not match the stored webhook secret, the fixed `handleWebhook` function SHALL reject the request with HTTP 401 Unauthorized.

**Validates: Requirements 2.3, 2.4**

Property 3: Preservation - Downstream Processing Unchanged

_For any_ webhook request that passes authentication (regardless of auth mechanism), the fixed code SHALL produce exactly the same downstream behavior as the original code: identical dedup checking, JSON parsing, event routing, S3 persistence, Bedrock sync triggering, and error responses.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `infra/lambda/ingestion/handler.ts`

**Function**: `handleWebhook`

**Specific Changes**:

1. **Replace header check**: Change from reading `x-webhook-signature` to reading `x-webhook-secret`
   - Replace `headers["x-webhook-signature"]` with `headers["x-webhook-secret"]`
   - Update the missing-header log message from "Missing x-webhook-signature header" to "Missing x-webhook-secret header"
   - Update the 401 response message from "missing signature" to "missing secret"

2. **Replace validation logic**: Remove `validateHmacSignature` call, use direct constant-time comparison
   - Replace `if (!validateHmacSignature(rawBody, signature, webhookSecret))` with a constant-time string comparison of the header value against the stored secret
   - Use `timingSafeEqual` from Node.js `crypto` module for the comparison
   - Update the mismatch log reason from "Signature mismatch" to "Secret mismatch"
   - Update the 401 response message from "invalid signature" to "invalid secret"

3. **Remove rawBody from auth**: The authentication step no longer needs the request body
   - The `rawBody` variable is still needed for JSON parsing later, but is no longer passed to the validator

4. **Update or remove webhook-validator.ts**: Either replace `validateHmacSignature` with a new `validateWebhookSecret` function, or inline the comparison in handler.ts
   - Preferred: Create a new `validateWebhookSecret(providedSecret: string, storedSecret: string): boolean` function in `webhook-validator.ts` that uses `timingSafeEqual`
   - Remove the old `validateHmacSignature` function
   - Update the import in handler.ts

5. **Update handler.ts import**: Change from importing `validateHmacSignature` to importing `validateWebhookSecret`

**File**: `infra/lambda/ingestion/webhook-validator.ts`

**Specific Changes**:

1. **Replace function**: Remove `validateHmacSignature` and export `validateWebhookSecret`
   - Remove `createHmac` import (keep `timingSafeEqual`)
   - New function signature: `validateWebhookSecret(providedSecret: string, storedSecret: string): boolean`
   - Implementation: convert both strings to Buffers, check equal length, use `timingSafeEqual`

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm that the current code rejects valid Strapi-style requests.

**Test Plan**: Write tests that send webhook requests with `x-webhook-secret` header (Strapi's approach) and verify that the current code rejects them. Run these tests on the UNFIXED code to confirm the authentication mismatch.

**Test Cases**:

1. **Valid secret, no HMAC header**: Send request with correct `x-webhook-secret` but no `x-webhook-signature` - current code returns 401 (will fail on unfixed code)
2. **Valid secret, wrong HMAC**: Send request with correct `x-webhook-secret` and garbage `x-webhook-signature` - current code returns 401 (will fail on unfixed code)
3. **Both headers present**: Send request with correct `x-webhook-secret` and valid HMAC `x-webhook-signature` - current code returns 200 (passes on unfixed code, confirms HMAC is the gate)

**Expected Counterexamples**:

- Requests with valid `x-webhook-secret` but missing/invalid `x-webhook-signature` are rejected
- Root cause confirmed: authentication is gated on HMAC signature, not direct secret comparison

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**

```
FOR ALL input WHERE isBugCondition(input) DO
  result := handleWebhook_fixed(input)
  ASSERT result.statusCode == 200
         OR result.statusCode IN [400, 500] (for downstream errors)
  ASSERT result.statusCode != 401
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**

```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT handleWebhook_original(input).statusCode == handleWebhook_fixed(input).statusCode
  ASSERT handleWebhook_original(input).body == handleWebhook_fixed(input).body
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:

- It generates many test cases automatically across the input domain
- It catches edge cases that manual unit tests might miss (empty strings, unicode secrets, very long headers)
- It provides strong guarantees that downstream behavior is unchanged for all authenticated requests

**Test Plan**: Observe behavior on UNFIXED code first for downstream processing (dedup, routing, error handling), then write property-based tests capturing that behavior.

**Test Cases**:

1. **Dedup preservation**: Verify duplicate detection continues to work identically after auth change
2. **JSON parsing preservation**: Verify invalid JSON still returns 400 after auth change
3. **Event routing preservation**: Verify events route to correct collection handlers after auth change
4. **Error handling preservation**: Verify 500 responses on processing failure still occur without dedup recording

### Unit Tests

- Test `validateWebhookSecret` returns true for matching secrets
- Test `validateWebhookSecret` returns false for non-matching secrets
- Test `validateWebhookSecret` returns false for empty inputs
- Test `validateWebhookSecret` uses constant-time comparison (timing analysis)
- Test `handleWebhook` returns 401 when `x-webhook-secret` header is missing
- Test `handleWebhook` returns 401 when `x-webhook-secret` value is wrong
- Test `handleWebhook` proceeds to dedup check when `x-webhook-secret` is correct

### Property-Based Tests

- Generate random string pairs and verify `validateWebhookSecret` returns true only when strings are equal
- Generate random request payloads with valid secret and verify downstream processing occurs
- Generate random invalid secrets and verify 401 is always returned
- Generate various body contents and verify authentication is independent of body content (unlike HMAC)

### Integration Tests

- Test full webhook flow: valid `x-webhook-secret` header through to S3 write and Bedrock sync
- Test Strapi-format payloads with correct secret are processed end-to-end
- Test that Secrets Manager failure still returns 500 regardless of auth mechanism
- Test all three collections (intranet-pages, intranet-teams, intranet-people) work with new auth

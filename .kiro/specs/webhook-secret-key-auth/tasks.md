# Implementation Plan

## Overview

Replace HMAC-SHA256 webhook authentication with direct secret key comparison using constant-time equality. This fixes the incompatibility with Strapi's native webhook system which can only send static header values.

## Tasks

- [ ] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - HMAC Auth Rejects Valid Strapi Secret Requests
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to concrete failing cases - requests with valid `x-webhook-secret` header but no `x-webhook-signature` header
  - Create test file `infra/test/webhook-auth-bug-condition.test.ts`
  - Mock Secrets Manager to return a known webhook secret (e.g., `test-webhook-secret-123`)
  - Mock dedup service (`isDuplicate` returns false, `recordProcessed` resolves)
  - Mock WebhookEventRouter to track invocations
  - Test case 1: Send request with correct `x-webhook-secret: test-webhook-secret-123` header, valid JSON body, no `x-webhook-signature` header - assert response is NOT 401 (expects 200)
  - Test case 2: Send request with correct `x-webhook-secret` and garbage `x-webhook-signature` header - assert response is NOT 401 (expects 200 since secret is correct)
  - Test case 3: Property-based - for any random valid JSON body, a request with the correct `x-webhook-secret` and no HMAC signature should be accepted (not 401)
  - isBugCondition: `input.headers["x-webhook-secret"] == storedSecret AND (input.headers["x-webhook-signature"] IS EMPTY OR validateHmacSignature fails)`
  - expectedBehavior: `result.statusCode != 401` (request proceeds past auth gate)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Tests FAIL because current code requires `x-webhook-signature` HMAC header and ignores `x-webhook-secret`
  - Document counterexamples: "Request with valid x-webhook-secret but no x-webhook-signature returns 401 instead of proceeding to downstream processing"
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 2.1, 2.2, 2.5_

- [ ] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Downstream Processing Unchanged After Auth
  - **IMPORTANT**: Follow observation-first methodology
  - Create test file `infra/test/webhook-auth-preservation.test.ts`
  - Mock Secrets Manager, dedup service, WebhookEventRouter, and S3/Bedrock clients
  - Observe on UNFIXED code: authenticated requests (with valid HMAC signature) proceed through dedup, JSON parsing, and event routing
  - Observe: requests with invalid JSON body return 400 after auth passes
  - Observe: requests with missing event ID return 400 after auth passes
  - Observe: duplicate events return 200 with `status: "duplicate"` after auth passes
  - Observe: processing failures return 500 without recording dedup entry
  - Observe: Secrets Manager failure returns 500 regardless of headers
  - Write property-based tests: for all authenticated requests (regardless of auth mechanism), downstream behavior is identical
  - Property: for any valid JSON body with event ID, an authenticated request triggers WebhookEventRouter.route() exactly once
  - Property: for any authenticated duplicate request, response is 200 with duplicate status
  - Property: for any authenticated request with invalid JSON, response is 400
  - Property: Secrets Manager failure always returns 500
  - Verify all tests pass on UNFIXED code (using HMAC auth to authenticate test requests)
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [ ] 3. Fix webhook authentication - Replace HMAC with secret key comparison
  - [ ] 3.1 Replace `validateHmacSignature` with `validateWebhookSecret` in webhook-validator.ts
    - Remove `createHmac` import, keep `timingSafeEqual` from `crypto`
    - Remove `validateHmacSignature` function entirely
    - Add `validateWebhookSecret(providedSecret: string, expectedSecret: string): boolean`
    - Implementation: return false for empty inputs, convert to Buffers, check equal length, use `timingSafeEqual`
    - _Bug_Condition: isBugCondition(input) where input uses x-webhook-signature HMAC validation_
    - _Expected_Behavior: validateWebhookSecret returns true when secrets match via constant-time comparison_
    - _Preservation: Function interface remains simple boolean return - no downstream changes needed_
    - _Requirements: 2.1, 2.2, 2.5_

  - [ ] 3.2 Update handler.ts to use `x-webhook-secret` header and `validateWebhookSecret`
    - Update import: change `validateHmacSignature` to `validateWebhookSecret`
    - In `handleWebhook`: read `headers["x-webhook-secret"]` instead of `headers["x-webhook-signature"]`
    - Replace HMAC validation call with `validateWebhookSecret(providedSecret, webhookSecret)`
    - Update log messages: "Missing x-webhook-signature header" to "Missing x-webhook-secret header"
    - Update 401 response messages: "missing signature" to "missing secret", "invalid signature" to "invalid secret"
    - Remove `rawBody` from the authentication step (no longer needed for validation, still used for JSON parsing)
    - _Bug_Condition: isBugCondition(input) where handleWebhook checks wrong header and uses HMAC_
    - _Expected_Behavior: handleWebhook reads x-webhook-secret, compares via validateWebhookSecret, accepts matching secrets_
    - _Preservation: All logic after the auth gate (dedup, parsing, routing, S3, Bedrock) remains untouched_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [ ] 3.3 Update RUNBOOK.md webhook testing commands
    - Replace any `x-webhook-signature` header references with `x-webhook-secret`
    - Update curl examples to use `-H "x-webhook-secret: <secret>"` instead of HMAC signature computation
    - Remove any HMAC computation instructions (openssl dgst commands)
    - Add note that the secret value is stored in Secrets Manager at `/{clientId}/secrets/datasource` under `webhookSecret` field
    - _Requirements: 2.1_

  - [ ] 3.4 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Secret Key Auth Accepts Valid Requests
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior (requests with valid x-webhook-secret are accepted)
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1: `npx jest infra/test/webhook-auth-bug-condition.test.ts`
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed - valid x-webhook-secret requests are now accepted)
    - _Requirements: 2.1, 2.2, 2.5_

  - [ ] 3.5 Verify preservation tests still pass
    - **Property 2: Preservation** - Downstream Processing Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2: `npx jest infra/test/webhook-auth-preservation.test.ts`
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions in dedup, parsing, routing, S3, Bedrock sync)
    - Confirm all downstream behavior is identical after auth mechanism change

- [ ] 4. Checkpoint - Ensure all tests pass
  - Run full test suite: `npx jest --passWithNoTests`
  - Verify no existing tests are broken by the auth change
  - Verify both webhook-auth-bug-condition and webhook-auth-preservation tests pass
  - Ensure all tests pass, ask the user if questions arise

## Task Dependency Graph

```json
{
  "waves": [["1", "2"], ["3.1"], ["3.2"], ["3.3", "3.4", "3.5"], ["4"]]
}
```

## Notes

- Tasks 1 and 2 MUST be run BEFORE the fix implementation (tasks 3.x) to establish the bug condition and baseline behavior
- The exploration test (task 1) is expected to FAIL on unfixed code - this confirms the bug exists
- The preservation tests (task 2) are expected to PASS on unfixed code - this captures baseline behavior
- After implementation, re-running both test sets validates the fix and confirms no regressions
- The existing webhook-validator.ts already contains the fixed `validateWebhookSecret` function and handler.ts already uses it - verify tests confirm current state is correct

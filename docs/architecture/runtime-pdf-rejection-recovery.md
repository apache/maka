<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Recovery after provider PDF rejection

Status: investigation conclusion for the current runtime contract

Related: [#3285](https://github.com/apache/maka/issues/3285), [#3164](https://github.com/apache/maka/issues/3164), [#3284](https://github.com/apache/maka/issues/3284)

## Decision

Maka does not automatically retry a request without PDF parts after a provider
rejects a PDF input. A provider rejection remains a bounded `ModelFailure`
until the provider adapter supplies a structured, request-level rejection
signal that is safe to act on.

The runtime must not infer PDF-specific authority from free-form error text,
HTTP status alone, or the absence of a response frame. Those signals cannot
prove that no provider work or tool effect occurred. Retrying on them could
duplicate billable work, hide an invalid request, or produce a durable history
that no longer matches the physical provider calls.

## Admission contract for a future fallback

A PDF-free fallback may be added only when all of these facts are available at
the runtime boundary:

1. The provider identified a named PDF rejection in a structured error field.
2. The rejection occurred before a response stream or tool effect began.
3. The original request identity and each physical provider attempt can be
   recorded independently.
4. The retry is guarded by a per-request latch, so at most one fallback can be
   admitted.
5. Replaced PDF parts are represented by a bounded explanation; PDF bytes and
   request bodies never enter errors, logs, RuntimeEvents, or diagnostics.

If any fact is missing or ambiguous, the runtime must keep the ordinary
failure path. A fallback must preserve the durable user-message identity and
must never duplicate the user or steering message.

## Provider evidence audit

The current provider error boundary does not expose a PDF-specific structured
field. `provider-error-classification.ts` receives the following parsed shapes
from the AI SDK and extracts only generic `code`, `type`, `message`, HTTP status,
and request-id evidence:

| Wire | Parsed request error shape currently accepted | PDF-specific admission evidence |
| --- | --- | --- |
| OpenAI Chat / compatible | inner `{ message, type?, code? }` value | none |
| OpenAI Responses | `{ type: "error", error: { type, code, message } }` chunk or request error | none |
| Anthropic Messages | inner `{ type, message }` value | none |

The classifier therefore cannot distinguish a provider rejecting a PDF before
dispatch from a generic invalid request, nor can it prove that an in-stream
failure happened before a tool effect. HTTP status and wording are explicitly
insufficient for that distinction. The adapter owning a provider wire remains
the only boundary that could add such evidence; it must do so without putting
PDF bytes or request bodies into the generic diagnostic path.

This keeps the recovery decision at the same boundary that knows whether a
request was dispatched, while retaining one durable accounting record for
each physical attempt. Current OpenAI Chat, OpenAI Responses, and Anthropic
Messages integrations therefore remain on the ordinary bounded failure path
until their error contracts provide the required evidence.

## Verification requirements

Any implementation that opts a provider in must add regressions for:

- a structured request-level PDF rejection that admits exactly one fallback;
- ambiguous, generic, and in-stream failures that do not retry;
- a fallback that preserves the original durable message identity;
- separate usage/accounting for the rejected and fallback attempts;
- restart recovery and steering paths, including the retry latch;
- redaction of PDF bytes, request bodies, credentials, and provider response
  payloads from every diagnostic surface.

The audit was performed against `packages/runtime/src/provider-error-classification.ts`,
`packages/runtime/src/model-adapter.ts`, and the native attachment contracts in
`packages/core/src/attachments.ts`. Existing provider failure and native
document-input tests cover the ordinary failure path; they do not establish a
PDF-specific fallback contract. This document records the evidence required
before a provider-specific implementation may change that behavior.

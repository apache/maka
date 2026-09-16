---
doc_id: commandcode-cli-transport
title: "Command Code CLI transport"
language: en
source_language: en
implementation_status: current
document_status: current
translation_status: source-only
last_verified: 2026-09-16
owners:
  - maka-backend
---
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

# Command Code CLI transport

Records what the `commandcode-go` provider ("Command Code GO") sends, where that knowledge came
from, whose identity the requests present, and what authorization basis Maka
has for it. This exists because the wire is not a published Command Code API
and the requests do not identify Maka.

## The wire

- Provider: `commandcode-go`, shown as "Command Code GO" (`packages/core/src/provider-registry.ts`)
- Adapter: `packages/runtime/src/commandcode-cli-language-model.ts`
- Generation: `POST https://api.commandcode.ai/alpha/generate`
- Discovery: `GET https://api.commandcode.ai/provider/v1/models` (the documented Provider API list)
- Request body: `{ config, memory, taste, skills, params: { model, messages, tools, system, max_tokens, temperature, stream, reasoning_effort? }, threadId }`
- Response: SSE `data:` lines carrying AI SDK stream parts (`text-delta`, `reasoning-*`, `tool-call`, `finish`, `error`)

Command Code documents three Provider API endpoints (`/provider/v1/chat/completions`,
`/provider/v1/messages`, `/provider/v1/models`) and states that "every plan
except the Go plan has API access". `/alpha/generate` appears in no public
documentation. It is the private transport of the official `command-code`
CLI.

## Why it exists

The Go plan (USD 1/month) is CLI-only. Its keys are rejected by the Provider
API with `403 upgrade_required` ("Your Go plan doesn't include API access").
The same keys are accepted by `/alpha/generate`, because that is the wire the
CLI they paid for uses. This provider lets a Go-plan user run Maka against
their plan; a user on GOAT or higher should use the ordinary `commandcode`
provider, which speaks the documented API.

## Source

Nothing here was obtained from Command Code. The request shape, headers, and
event vocabulary were learned from two MIT-licensed community projects that
observed the official CLI (`command-code@1.54.0`):

- `pi-commandcode-provider` by Pat Woz, which reverse-engineered the wire.
- `dsh-commandcode-provider` by Mars-Sea, a port of the above whose adapter this one mirrors.

Maka's adapter is a fresh implementation against the AI SDK `LanguageModelV4`
interface; it reuses their wire facts, not their code. Their NOTICE files
state that neither project is affiliated with or endorsed by Command Code,
Inc.

## Consent identity

The requests present the official CLI's identity headers, because the gateway
keys plan gating on them:

```
x-command-code-version: 1.54.0
x-cli-environment: production
x-project-slug: <slug of the working directory>
x-taste-learning: true
x-co-flag: false
```

Command Code's servers therefore see a `command-code` CLI 1.54.0 client, not
Maka. The application the service believes it is talking to and the
application that holds the credential are not the same.

## Authorization basis

**Not established.** Command Code's Terms of Service (effective 2026-07-03)
contain no clause naming third-party clients, unpublished endpoints, or client
identity headers. They do prohibit reverse engineering "the Services" and
automated tools that "perform automated searches or requests", and the plan
documentation defines Go as the plan without API access. Whether a third-party
client presenting the CLI's identity to reach a plan's CLI-only wire is
permitted has not been asked of Command Code, and no published statement
answers it.

Because that basis is missing, the transport ships with these safeguards:

- **Off by default, per install.** `getAIModel` refuses the provider and the
  connection test fails with an explanation unless the Runtime Host process
  has `MAKA_COMMANDCODE_CLI_TRANSPORT_EXPERIMENTAL=1`
  (`isCommandCodeCliTransportEnabled` in the adapter module). The flag records
  an operator's decision to accept the identity mismatch above for their own
  install. It is not the authorization basis, and turning it on does not
  create one.
- **Explicit, not automatic.** The ordinary `commandcode` provider never falls
  back to this wire. A user picks the "Command Code GO" card knowingly; the
  card's description names the flag.
- **Honest failure on the documented wire.** A `403 upgrade_required` from the
  Provider API is classified as a plan (billing) failure rather than a
  credential failure, so a Go-plan user is told the plan lacks API access
  instead of being sent to re-enter a valid key.
- Resolving this entry requires either a written Command Code statement
  permitting third-party clients on the CLI transport, linked from this file,
  or a Command Code-sanctioned way for the Go plan to reach a documented API.
  Only then should the transport default to on.

## Related

- `docs/github-copilot-oauth-identity.md` records the same shape of decision for a borrowed OAuth identity.
- Browser sign-in for both Command Code providers is a loopback flow, not OAuth; see `apps/desktop/src/main/commandcode-browser-login.ts`.

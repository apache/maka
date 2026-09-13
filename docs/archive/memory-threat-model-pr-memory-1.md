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

# Memory Subsystem Threat Model

> Archived on 2026-07-13. This document records the contract-only PR-MEMORY-1 boundary, not the current product implementation. Source and focused tests own the active contract.

PR-MEMORY-1 is a **contract-only** package. It MUST NOT add IPC handlers, storage repositories, embedding providers, Recall tool runtime, renderer UI, or settings flags. Implementation packets (PR-MEMORY-2+) sit downstream of this contract — none may bypass `validateMemoryWriteRequest`.

Anchors:

- `notes/reference implementation-memory-reverse-2026-05-25.md` (kenji msg `66fd3eab`) — reference implementation facts + Maka quasi-memory inventory.
- `notes/pr-memory-0-audit-plan.md` — pre-audit plan skeleton.
- `#my-ai:2f91befb` thread, msgs `22209a1b` (xuan gate review + scope adjust) + `fb95a158` (kenji invariant ask) + `68a1bcb5` (xuan review priorities).

## Source separation (gate #8 + type system)

Memory is not one surface. The contract types separate them so a quasi-memory observation cannot become a durable memory entry by typing alone.

- **`MemorySource`** (durable-capable): `user_authored`, `chat_extracted`. These can produce `'active'` entries IF a `confirmedAt` timestamp is supplied AND the request did not originate from the renderer.
- **`MemoryCandidateSource`** (non-durable): `voice_transcript`, `activity_observation`, `cu_observation`, `search_recall`, `daily_review`. These can only produce `'draft'` or `'review_required'` entries. The normalizer rejects any candidate-source request with `persistenceState: 'active'` (`MemoryBlockReason='candidate_source_no_active'`).

`MemorySource` and `MemoryCandidateSource` are disjoint enums. The `DurableMemoryEntry` shape's `source` field is typed `MemorySource`, and `DraftMemoryEntry`'s `source` field is typed `MemoryCandidateSource`. A Voice transcript cannot type-check into a `DurableMemoryEntry` even before reaching the validator.

## Assets

- Memory entry `content` (NFC-normalized, control/zero-width-stripped).
- Memory entry `source` and the user-visible provenance derived from it.
- Memory entry `scope` (`'workspace'` / `'session'`).
- Memory entry `confirmedAt` (a CLAIM about user action — gate #9 forbids renderer from setting this).
- Pending/review queue contents.
- Future embedding vectors (out of scope for v1 contract; `embeddingProvider: 'disabled'` is hard-coded).
- Citation index / prompt-injection references when memory is consumed (gate #4).
- Export bundles (gate #6 reversibility).

## Boundaries

1. **Renderer → main**: renderer may PROPOSE memory writes but MUST NOT supply `confirmedAt`. Confirmation event recording is a main-side responsibility.
2. **Main → store**: every write passes `validateMemoryWriteRequest`; the store boundary refuses any request that did not.
3. **Store → embedding/provider**: NOT IMPLEMENTED in v1. `embeddingProvider: 'disabled'` literal in `MemoryCapabilitySnapshot` prevents accidental wiring of a provider.
4. **Store → prompt-build**: only `'active'` durable entries are eligible for injection, and only with a visible citation surface (`MemoryUsePolicy='cited_only'`). The contract does NOT include `'silent'`.
5. **Quasi-memory surfaces → memory**: forbidden as a direct write path; the only way into memory from quasi-memory is via a draft entry that the user explicitly promotes.

## Nine privacy gates (locked by @xuan `22209a1b`)

| # | Gate | Enforcement in contract |
|---|---|---|
| 1 | default-off | `MEMORY_MODES` includes `'off'`; fresh-install snapshot MUST be `'off'`. Step #1 of validator rejects with `MemoryBlockReason='mode_off'`. |
| 2 | manual confirm before durable write | Durable `'active'` path requires `confirmedAt`. Validator rejects with `MemoryBlockReason='manual_confirm_required'` when missing/invalid. |
| 3 | reversible delete/export | Contract docs require reversible operations exist BEFORE any auto-write capability is added. v1 contract has no auto-write; downstream packets MUST add `delete` + `export` shapes before adding any write driver. |
| 4 | incognito read+write disable | `MemoryWriteRequestContext.incognitoActive` short-circuits validator at step #2 with `MemoryBlockReason='incognito_active'`. (Read path is a future contract — the same flag MUST gate it.) |
| 5 | no auto sleep consolidation | NOT in `MemorySource` enum; NOT in `MemoryCandidateSource`. No type exists for an automated consolidation source — adding one is a contract change requiring explicit review. |
| 6 | visible citation | `MemoryUsePolicy` only allows `'never'` or `'cited_only'`. No `'silent'` policy. Adding `'silent'` requires expanding the enum (i.e. requires explicit review). |
| 7 | no hidden activity promotion | `activity_observation` / `cu_observation` are `MemoryCandidateSource` only. Validator rejects `persistenceState='active'` for these via gate `candidate_source_no_active`. |
| 8 | provider+embedding leakage boundary | `MemoryCapabilitySnapshot.embeddingProvider` is the literal `'disabled'`. v1 has no provider field on entries. Downstream wiring of any provider requires extending this snapshot type. |
| 9 | renderer cannot forge provenance/readiness | `MemoryWriteRequestContext.originatedFromRenderer=true` blocks any durable `'active'` write — even with valid `confirmedAt` — returning `MemoryBlockReason='renderer_provenance_forged'`. |

## What NOT to copy from reference implementation (negative reference list)

Per `notes/reference implementation-memory-reverse-2026-05-25.md`:

1. **Sleep cycle / 4-layer consolidation** (`22-embeddings.md`) — Maka has no sleep stage. No code path automatically aggregates, summarizes, or merges memory entries.
2. **Auto-extract from chat** — every `chat_extracted` write requires explicit confirmation. Even after assistant suggests, user must click confirm; no silent insertion.
3. **Auto-retrieve / Recall tool runtime** — out of scope for v1 contract. Adding it requires a separate retrieve-side contract with its own threat model.
4. **LLM-mediated forget/delete** — only user-initiated deletes allowed. No "the model decided this is no longer relevant".
5. **Activity-derived memory** — Activity recorder feeds Maka memory only via `activity_observation` candidate source, never as a durable source. Activity audit (separate lane) MUST run before any activity→memory pipeline.
6. **Unauthenticated local route** (reference implementation's `05-express-api.md` exposes memory over local HTTP) — Maka memory MUST NOT have a local HTTP endpoint; if Local Gateway lane lands, it MUST go through capability scope allowlist + audit log, never default-on.
7. **Cloud embedding fallback** — `embeddingProvider: 'disabled'` lock. Adding a provider requires an explicit contract extension; no silent OpenAI/Cohere/local hybrid.
8. **Soul tree / `~/.config/reference implementation` long-term file** — out of v1 scope. If durable persistence lands (PR-MEMORY-2+), it sits inside the existing workspace store, not a separate global tree.

## Quasi-memory exclusion list (gate #7 + #8)

These existing Maka surfaces contain durable user-correlated data BUT MUST NOT be treated as `MemorySource` and MUST NOT auto-promote:

- `settings.json` — personalization fields, onboarding milestones.
- `skills/` — user-installed skill content.
- `usage_log` (`telemetryRepo`) — historical queries / latency / errors.
- `sessions/*/session.jsonl` — session history.
- `workspace/` instruction files — prompt-time injection only.
- Capability snapshot + runtime probe history (Health Center).
- Visual-smoke fixtures.
- Daily Review candidates (post-Daily Review lane).
- Search index hits (`MemorySource='search_recall'` is the candidate-source bridge, not durable).
- Voice transcripts (`voice_transcript` candidate source).
- CU / Activity observations (candidate sources).

**What the contract catches** (gate, per @xuan `0c9c68f9`): a request whose `source` value is the literal name of a quasi-memory surface — `source: 'usage_log'`, `source: 'health_probe'`, `source: 'session_summary'`, etc. — is rejected by `validateMemoryWriteRequest` with `MemoryBlockReason='unknown_source'`, regardless of other fields. The string is not in `MEMORY_SOURCES` or `MEMORY_CANDIDATE_SOURCES`.

**What the contract CANNOT catch** (source-laundering — downstream concern): if a downstream IPC handler or store boundary reads a usage-log entry, copies its body into a fresh `{ source: 'chat_extracted', confirmedAt: ..., content: ... }` payload, and submits THAT to the validator — the validator accepts it. The validator sees a well-formed durable `chat_extracted` write; it has no way to know the body originated from a quasi-memory surface. Source-laundering defense is a per-IPC-handler / per-store-boundary responsibility (provenance lock at the input layer), NOT a contract-layer responsibility. Any future implementation packet that introduces a "promote draft to active" or "summarize quasi-surface as chat_extracted" path MUST add a separate provenance gate at that boundary.

## Minimum test matrix (locks the gates above)

The companion test file `packages/core/src/__tests__/memory.test.ts` MUST contain at least these assertions (each labeled G#N for the gate locked):

- G1: `mode='off'` → `mode_off` block (any source, any state).
- G2: durable `user_authored` + `persistenceState='active'` without `confirmedAt` → `manual_confirm_required`.
- G2b: durable `chat_extracted` + `persistenceState='active'` without `confirmedAt` → `manual_confirm_required`.
- G3: contract has no `delete`/`export`-bypass shape (must be added by downstream packet only).
- G4: `incognitoActive=true` + any valid write → `incognito_active`.
- G5: no automated-consolidation source exists in `MEMORY_SOURCES` or `MEMORY_CANDIDATE_SOURCES`.
- G6: `MEMORY_USE_POLICIES` includes only `'never'` and `'cited_only'`.
- G7: candidate-source + `persistenceState='active'` → `candidate_source_no_active` (one assertion per candidate kind).
- G8: `MemoryCapabilitySnapshot.embeddingProvider` is the literal `'disabled'`.
- G9: durable + active + `originatedFromRenderer=true` → `renderer_provenance_forged`.

Plus normalizer matrix:

- `normalizeMemoryContent`: typeof reject, NFC, control/zero-width strip, trim, empty reject, cap reject.
- `normalizeMemorySource`: known durable, known candidate, unknown rejected.
- `normalizeMemoryMode` / `normalizeMemoryPersistenceState` / `normalizeMemoryScope`: closed-enum reject for non-members.
- `validateMemoryWriteRequest` returns canonical `DurableMemoryEntry` or `DraftMemoryEntry` (not raw input) on success.
- `validateMemoryWriteRequest` rejects `mode_only` + candidate (`mode_disallows_candidate`).

## Forbidden surfaces in PR-MEMORY-1 source diff

Reviewer source-grep MUST NOT find these in the PR:

- `ipcMain.handle` — no IPC handler is wired.
- `BrowserWindow` / renderer imports — no renderer code path touches memory.
- `fetch(` / `XMLHttpRequest` — no provider/network call.
- `embedding` / `vector` — no embedding logic (the contract field is the literal `'disabled'`).
- `Recall` / `recall_tool` — no Recall tool runtime.
- Storage repo names (`telemetryRepo`, `connectionStore`, `sessionStore`, etc.) — no persistence path.
- Settings field additions for memory — contract is independent of settings shape until PR-MEMORY-2 adds them.

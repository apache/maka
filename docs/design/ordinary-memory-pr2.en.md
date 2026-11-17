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

# Ordinary memory PR2: exact matching implementation record

Date: 2026-11-17. Base: upstream `rust-preview` at `9ac917f17` (PR1, #6970). Branch: `codex/ordinary-memory-pr2`.

**Status: partial PR2 implementation.** Semantic retrieval, model relation classification, automatic writes, scope snapshot validation and the full acceptance suite remain unfinished.

## Implemented behavior

PR1 stored hashes and retained deleted/corrected assertions, but Create always allocated a new ID. The existing user-management transaction now checks restricted assertions first, then active assertions. An exact active match reuses its ID and appends user-operation evidence. An exact restricted match returns `suppressed` without exposing its body or ID.

Normalization only converts CRLF to LF and trims outer whitespace. Case, internal whitespace, punctuation, negation, quantities, conditions and dates remain intact. Matching also checks namespace, resolved scope and assertion metadata, including temporal boundaries. The algorithm remains compatible with PR1 hashes and requires no migration.

## Changes and rationale

- `facts/src/memory.rs` adds `evidence_added` and `suppressed` results, separating successful confirmation from suppression.
- `state/src/memory/matching.rs` implements normalization, restricted-first indexed matching and incremental evidence attachment.
- `state/src/memory.rs` calls matching after Create validation and before insertion, recognizes evidence writes in the Statement changed flag, and adds behavior tests.
- The native memory recovery test exercises the real Host API and suppression after restart.
- Generated plugin SDK declarations expose the new result variants to TypeScript consumers.

A baseline compilation omission in `owner/session_tools.rs` is also fixed by providing `incognito: false` to Create. The common creation path still computes `input.incognito || policy.incognito`, preserving caller privacy inheritance.

## Storage and authority

Restricted matching uses EXISTS and the existing namespace/scope/digest/disposition index. It does not materialize an unbounded history array or compete with an active-result Top-K budget. A restored active assertion exempts its own identical historical restricted versions; unrelated old assertions remain suppressed.

An active match adds evidence to the existing assertion, keyed by operation UUID. Repeating that confirmation does not add another evidence row. New evidence increments record and scope revisions while preserving the assertion, body, metadata and modified_at. Explicit user confirmation promotes auto_recall to user_recall and preserves user_always.

The existing Native/Remote management admission supplies user authority. The matching code does not add a model-writable authority field. All matching and mutations execute in the existing RootStore Statement and Host receipt transaction. There is no external model call inside the transaction.

When legacy duplicates exist, matching selects a stable ID; it does not consolidate all legacy records. Metadata is serialized by the same Rust structure and compared through SQLite json(); this is not general JSON object-key canonicalization.

## Verification and limits

Storage tests cover normalized duplicates, scope/time isolation, negation and case, evidence growth, stable priority, protected mode preservation, deleted/corrected assertion suppression, explicit restore, promotion of automatic facts, confirmation replay and indexed query planning. The native acceptance extension checks real API results and restart persistence. Execution results are recorded below.

This change only intercepts Create. Correct and Restore have not been routed through cross-record resolution. It therefore does not establish the complete write boundary required by PR2. It also does not add new created/revised result distinctions or implement semantic equivalence.

## Remaining PR2 work

1. Bounded multilingual keyword/entity/alias retrieval with separate ordinary, protected and restricted budgets.
2. One bounded semantic classification call per batch, evidence and authority validation, and no write fallback on model failure.
3. One commit plan shared by creation, correction, import and extraction; immutable revisions, conflict relations and unresolved candidates.
4. Scope and target revision checks across model execution, source/authority revalidation and bounded retries.
5. Within-batch and cross-session races, semantic fixtures, provider failure tests and measured recall/merge/suppression errors.

This commit is a foundation for continued PR2 work, not evidence that the full planned PR2 is ready to merge.

## Execution record

- `cargo test -p maka-agent-state --lib --locked`: 18 passed.
- `npm run schema:generate -w @maka-agent/plugin-sdk`: declarations generated successfully.
- `cargo test -p maka-agent-native --lib memory_management_cas_sources_deletion_and_restart --locked`: 1 passed, including concurrent creation and suppression after restart. The sandbox initially rejected fixture initialization with EPERM; the unsandboxed rerun passed.
- `npm run typecheck -w @maka-agent/plugin-sdk`: passed.
- `npm run schema:check -w @maka-agent/plugin-sdk`: 5 declaration files verified.
- `node --test scripts/ci.test.mjs`: 18 passed after allowing the local listener outside the sandbox.
- `rustfmt --check` on changed Rust files and `git diff --check`: passed.
- Full-repository `just check` and full PR2 semantic acceptance were not run.

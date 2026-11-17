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

# Ordinary memory PR2: unified write reconciliation

Date: 2026-11-17. Base: upstream `rust-preview` at `9ac917f17`, including PR1 (#6970). Branch: `codex/ordinary-memory-pr2`.

This document replaces the earlier exact-matching-only report. The branch now routes both single and batch writes through bounded candidate retrieval, relation classification and a guarded commit. Natural-language uniqueness is not a database invariant; measured limitations appear below.

## Behavior and scope

Equivalent assertions reuse an ID and append evidence. Explicit, newer changes can revise automatic facts. Conflicts with protected records remain unresolved. Deleted and corrected history participates in matching. Scope changes during model evaluation cause bounded reinspection; the final transaction checks the scope again.

PR3 Recall filtering, PR4 pinned projections/import readers, PR5 frozen conversation extraction and authorization parsing, and PR6/7 triggers remain separate planned PRs. They can consume this batch service. No new scheduler is introduced.

## Code changes and purpose

- Facts/API contracts add MemoryWrite, batch results, extraction provenance, reconcileMemories, pendingMemories and optional model resolution context.
- State memory/resolution.rs owns snapshots, bounded retrieval, complete relation matrices, evidence validation, batch planning, conflicts and atomic writes. Raw UserChange is crate-local to prevent Native consumers bypassing reconciliation.
- Migration 0046 builds an FTS5 trigram derived index for existing assertions, maintains inserts/deletes with triggers, adds an indexed relation table and a canonical generation method field. Existing immutable migration constraints remain unchanged.
- Native memory.rs binds management authority, project/source identity and model context, retries a changed scope once, then prepares a RootStore Statement.
- Native recap.rs shares the existing auxiliary model worker, cancellation, cleanup tickets, pricing and usage accounting between recap and memory purposes. The embedded resolution prompt requests strict JSON pairwise classification.
- Service routing, generated SDK declarations, product client operation admission/recovery and the Host fixture grants include the new methods.
- CI tests verify that the embedded prompt selects Native and downstream product consumers through the Cargo ownership graph.
- The first-stage SessionCreate compilation fix remains: incognito defaults false at construction while the common path inherits caller privacy through input.incognito OR policy.incognito.

## Authority and API

Both mutation APIs require Native/Remote management identity. Agent callers are rejected, including attempts through the batch method. There is no model-supplied user actor field.

MemoryWrite contains an edit and optional evidence. Direct management input creates UserOperation provenance. A conversation reference grants only automatic extraction authority and is only accepted with Create. Its session, fact ID, fingerprint and UTF-8 span must match immutable history; incognito and cross-project sources are rejected. Automatic candidates cannot request direct correction, restore, pinning or deletion.

reconcileMemories takes one resolved scope, up to four writes, and optional resolution containing a non-incognito sessionId and an explicit configured model selection. That session must admit an auxiliary request. If semantic comparison is needed without this context, the response is retryable, not an unchecked creation.

Batch results distinguish created, evidence_added, revised, suppressed, unresolved and retryable. changeMemory preserves saved for single creation/revision and retains NotFound, Conflict and InvalidState semantics. pendingMemories exposes keyset pagination only to management callers. Normal memory reads exclude unresolved and suppressed records; management evidence/history can inspect unresolved provenance.

## Retrieval and classification

Exact hashing preserves case, internal whitespace, punctuation, negation, conditions, quantities and time. Only CRLF and surrounding whitespace are normalized. Namespace, scope and assertion metadata remain separate constraints. Clearly disjoint time intervals can be independent deterministically; arbitrary metadata differences do not authorize bypassing suppression.

Candidate identities come from indexed hashes, scope-qualified FTS5 trigram matches and current pinned records. Matching texts include both version bodies and confirmed equivalent expressions, bound to the original assertion. Deletion and correction therefore restrict known aliases; explicit restoration follows known equivalent assertion versions, inherits their matches and records authorization tied to the restored fact. Old related records stay suppressed; conflict-only descendants are not reactivated. A target-bound restoration remains unresolved when another active identity already represents that fact. Semantic suppression also retains the matched text and restricted assertion identity for later batch relations and retries, without treating restricted content as supporting evidence. Exact hits for every batch item are collected before lexical candidates fill the shared budgets. Deduplicating candidates by assertion preserves each input’s exact matches, so resubmitting several confirmed aliases in one batch remains deterministic without another model call. Ordinary, protected/pending and restricted-history buckets have independent budgets. An additional indexed single-match lookup enforces known exact suppression without relying on Top-K. The application never loads the entire history into a model prompt.

Candidate matches drive the joins: exact queries use the digest index, while lexical queries fetch the retrieved rowids. This prevents SQLite from scanning the whole scope or a memory-state bucket before filtering. Commit-time exact reuse and suppression queries also start from digest hits. A regression test executes the production queries for all three candidate classes with exact hits, lexical hits and misses, comparing results and database VM steps as records grow from 100 to 10,000. Broad lexical matches, pinned entries and related restoration history still have their own read costs; the final candidate limit does not imply constant query cost.

For input i, the model returns a row against every stored candidate followed by every earlier input in the batch. Matrix dimensions, enums, unknown fields and replacement quotes are checked. Targets and revisions come from the trusted snapshot, not model declarations.

Equivalent assertions reuse their current version. Compatible supplements and independent facts remain separate. Automatic replacement requires an automatic target, a source observation newer than all verified evidence for the current assertion, compatible effective time and an explicit replacement quote found in verified evidence. Protected or uncertain conflicts become unresolved and retain target relations. A target-bound edit matching another ID remains unresolved, preserving both existing identities and pinning instead of silently retiring a protected record. User corrections use new user provenance; historical evidence is not relabeled as support for the new assertion.

Pending candidates retain both confirmed equivalent and conflicting targets. Both relation endpoints identify assertion versions. Deletion follows those versions and deactivates a record only when its current assertion is affected, preserving later user corrections while still suppressing pending descendants linked to old versions. Explicit restoration traverses indexed known equivalents; its cost grows with that component’s history and aliases. It does not promise to discover every unrecognized synonym or erase original conversations. Restore must be explicit.

## Transactions and recovery

Inspect captures candidates and scope revision together. Model evaluation runs outside the database transaction. Native rechecks the scope and allows one reinspection/reclassification attempt. Commit validates scope and target revisions, source references, project bindings and caller CAS before applying writes under a savepoint. Later ID-based edits carry forward revisions produced by earlier writes in the same transaction, while retaining the requested assertion and state checks. Failed batch validation rolls back all changes. Later batch items reload the original assertion’s state, protection and latest evidence time. Repeated unresolved assertions retain their ID and append evidence and relations. Replacement targets are deduplicated by ID and assertion. An exact match of the current assertion is not turned into a duplicate pending record by an older version of that same ID. An assertion-scoped ordered index supplies the latest observation without scanning its evidence history.

Two concurrent absent-candidate snapshots cannot both insert unchecked facts. One may commit; the other receives retryable and must resolve again with a new operation identity. Assertions, evidence, relations, scope revisions, derived indexes and Host receipts use the existing RootStore boundary.

Host operation replay returns the existing receipt without rerunning the model. Receipts contain IDs/revisions/status rather than cached memory bodies. Auxiliary timeout cancels the child scope and waits for resource cleanup instead of abandoning a provider worker. Reclassification after a scope change uses a distinct auxiliary attempt under the same Host operation, accounting for both calls separately. The initial attempt omits the new ordinal to preserve existing ledger source identities.

A valid replacement of the current automatic assertion is not blocked by historical conflicts under the same ID, allowing successive explicit preference changes to retain the original identity. Equivalence to restricted old content still takes suppression precedence; conflicts with other IDs and user protection remain effective. Deterministic suppression of confirmed aliases retains each batch input's exact match even when other lexical candidates are retrieved.

## Fixed budgets

| Resource | Limit |
| --- | --- |
| Writes per batch | 4 |
| Body / evidence quote | 8,192 / 16,384 UTF-8 bytes |
| Query trigrams | 48 per input |
| Each of three candidate buckets | 8 records and 8,192 body bytes |
| Serialized semantic input | 40,000 bytes |
| Output | 8,192 tokens, bounded by the model; 65,536 response bytes |
| Model wait | 45 seconds, followed by cancellation and cleanup |
| Reclassification | Once; at most two model calls |

Input bytes are a deterministic bound, not an exact tokenizer estimate. Oversized restricted content is rejected rather than truncated. Actual provider usage remains in the existing auxiliary journal. Retained suppression history and indexes grow; no TTL silently discards them.

## Validation and measured limits

State tests cover normalization, scopes/time, evidence idempotency, protected modes, deletion/correction suppression, in-batch equivalence, stale snapshots after concurrent insertion/deletion, invalid matrices, cross-time equivalence, forged evidence, unquoted replacement, delayed older sources, pending records and separate restricted budgets. Migration tests cover initialization, upgrade and reopening.

The real Host acceptance test uses a local provider-protocol fixture to exercise auxiliary generation, operation receipts, persistence and restart. It covers Postgres/PostgreSQL reuse, malformed model output without writes, paraphrase suppression after deletion and rejected Agent impersonation. A concurrency case deletes the candidate before the first model response, then verifies a second request with the restricted snapshot, final suppression, and two separately settled usage records under one operation. Its controlled relations test integration and authority, not production-model language quality.

A fixed lexical retrieval fixture finds 5 of 6 examples. Spelling variants, Chinese substrings, email conditions, negation and Python keywords are retrieved. `I live in Beijing` to `我的常住城市是北京` misses because there is no shared substring. One development run measured lookup p50 23,350µs and p95 128,278µs over six queries while other work ran; this is a smoke observation, not a scale benchmark.

Production-model false merge and false suppression rates were not measured and must not be reported as zero. Short strings, translations without shared terms, absent aliases and records beyond the candidate budget may be missed. No candidates means no match within this retrieval budget, not global semantic uniqueness.

Full-repository just check, cross-platform runners and production-model sampling were not run locally. Final focused verification follows.

## Final verification

- State library tests (`cargo test -p maka-agent-state --lib --locked`): 44 passed. Facts library tests also passed all 36 cases.
- Native `memory::` tests: 4 passed, including real Host semantic calls, authority rejection, restart and Host isolation; local listeners required unsandboxed execution.
- Product client pending-operation recovery test: 1 passed.
- CI planning tests: 19 passed.
- SDK generation, verification of 5 declaration files and TypeScript checking: passed.
- State-only strict Clippy (`--no-deps -- -D warnings`): passed.
- Changed Rust file formatting and `git diff --check`: passed.
- Additional strict Native Clippy failed in unchanged driver, driver_cleanup, notifications, history projection and scheduler code. Dependency-inclusive Clippy also reported a provider-protocol struct-update warning. Repository lint settings were not weakened; full strict Clippy is not claimed to pass.

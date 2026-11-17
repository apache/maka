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

# Ordinary memory PR1: persistence, evidence and user authority

PR1 uses the existing RootStore, migration ledger and Host operation journal. It provides scoped user management without introducing another database, lease or mutation protocol. Semantic reconciliation, Recall integration, context projection, automatic extraction and the full management UI remain later PRs.

## Records, assertions and metadata

A memory is identified by Host deployment, Agent namespace, resolved personal/project scope and a typed ID. Its operation revision protects all changes with CAS; its assertion pointer identifies the immutable body version. Pinning, deleting and attaching evidence advance the operation revision without inventing another body version.

Migration 43 creates records, immutable versions and scope generations. Migration 44 adds assertion metadata and generation method. Kind identifies a fact, preference or instruction; statement identifies an assertion, preference or intention. Unspecified input remains explicitly unspecified. Temporal validity is unspecified, timeless or a half-open interval in Unix milliseconds, with an optional open end. Empty or reversed intervals are rejected. Metadata stays attached to its original body through correction and suppression. User-operation observation time never substitutes for fact validity.

Bodies in this PR have `generation=user_input`. Correction links separately identify prior assertions. No model-facing API may impersonate a direct user edit.

## Version-bound evidence

Migration 45 creates an indexed evidence association table and backfills existing user-operation sources. Each new body first receives its actual Host user-operation source. Evidence is incrementally appended and paginated instead of being returned as an unbounded array with every record.

Clients obtain a public history position and selected text, then call the management-only `memorySource` API. The Host verifies the span and returns the immutable fact identity and fingerprint; clients do not need database access or internal identifiers.

`changeMemory.add_evidence` supplies the expected operation revision and the exact assertion. A conversation reference contains the owned session, source sequence/item index, immutable fact UUID, full-message SHA-256, UTF-8 byte offsets and quoted text. Native code resolves ownership and project scope. The Root transaction rechecks session bindings, retrieves the actual message, and verifies its identity, fingerprint and exact span. Incognito or unavailable sources are rejected. Observation time comes from the message; operation identity comes from the Host. Conversation deduplication keys use a fixed-size SHA-256 to avoid duplicating quoted text in the unique index.

A duplicate reference for the same assertion is idempotent. Different facts can reference the same message. Adding evidence preserves the body, assertion pointer, mode and priority timestamps, while advancing operation and scope revisions. Correction creates a new assertion and user-operation source; prior conversation evidence remains attached to the old assertion.

The association table fields are:

| Field | Meaning |
| --- | --- |
| `sequence` | Database-assigned association ID and keyset cursor; not observation time or priority. |
| `namespace`, `scope`, `id` | Owning Host/Agent namespace, resolved scope and memory item. |
| `assertion` | Immutable body version, enforced by a composite foreign key to the version table. |
| `source` | Verified source JSON, including the actual user operation or conversation reference, observation time and attachment operation. |
| `source_key` | Per-assertion deduplication key; conversation references use a fixed-length digest independent of the attachment operation. |

The uniqueness constraint allows one source to support multiple facts. The pagination index begins with the item/assertion locator and ends with `sequence`. Scope comparison and the eventual transaction use the same captured target and source bindings, so a second scope resolution cannot silently change the authorization decision.

`memoryEvidence` pages by assertion and sequence cursor, with at most 100 returned associations. Suppressed records and versions are filtered. Restoring a record does not expose previously suppressed evidence. `memory` returns the assertion pointer so callers do not confuse a pin/evidence revision with a body version.

Text verification establishes authentic provenance, not semantic entailment. This PR's association is an explicit user operation. Automated evidence selection, semantic reconciliation and frozen-range extraction belong to later PRs.

## Authority and privacy

Only trusted management identities can mutate memories. Agent reads require a live execution, the permitted session scope, and both memory read policy flags. Disabling model reads does not remove user management access.

`create.incognito` is stored at creation and cannot be changed through metadata. Derived Agent sessions, forks and scheduled sessions inherit the restriction. Memory reads check the actual execution session. Incognito executions cannot use the user-management mutation path, and Incognito conversations cannot supply new memory evidence. The Session DTO exposes this state across restart. This is a memory privacy boundary, not a promise to erase conversation history. Later extraction/context paths must consume the same boundary.

## Commit, deletion and recovery

Root transactions validate CAS and captured workspace authority before changing records, versions, evidence, matching hashes and scope generations. Host receipts record the actual result in the same commit chain. Receipts contain IDs and revisions, not a second readable body copy.

Deletion suppresses the record and its versions, removes always mode, and preserves matching data without a TTL. Ordinary detail, list, history and evidence reads hide suppressed content. Ordinary correction cannot restore a deleted record: explicit restore requires the expected revision and new user input.

## Validation

The final library run passed all 53 tests: facts 32, API 2, state 14 and client 5. It includes migration upgrade/reopen and existing-data backfill, versioned metadata, invalid temporal intervals, forged spans, duplicate evidence, a source shared by different facts, pagination, correction isolation, deletion filtering and pending client-operation recovery.

Expanded Host tests exercise actual conversation evidence, read-policy combinations through Agent identity, Incognito execution and fork inheritance, user-management denial for models, project/worktree scope, independent Hosts and Agents, original receipts through the Host reader, and restart behavior. The final memory/project-scope filter passed all 5 selected tests (one is an existing inventory test also matched by the filter).

The complete native library run executed 105 tests: 104 passed and `preset_execution_uses_durable_role_and_explicit_model_selection` failed with `Application channel ended before a complete frame`. Two subsequent isolated nextest runs of that test passed without changing its code or timeout. The initial interruption was not diagnosed; the complete run is not reported as 105/105 passing.

Rust checks for app-client, CLI and workbench test targets passed. All 5 generated declaration files matched; SDK acceptance and product bundle TypeScript checks, workspace Rust formatting, diff whitespace and staged new-file ASF headers passed. Repository-wide `just check`, every CI shard and scale/semantic quality evaluation were not run.

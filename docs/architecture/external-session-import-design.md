---
doc_id: architecture.external-session-import-design
title: "External Session import design"
language: en
source_language: zh-CN
counterpart: ./external-session-import-design.zh-CN.md
implementation_status: current
document_status: current
translation_status: synced
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

[中文](./external-session-import-design.zh-CN.md)

# External Session import design

## Scope and user contract

TUI and Desktop select one Claude Code, Codex, or OpenCode Session through the same Runtime Host catalog/import path. Every explicit import creates a new native Maka Session snapshot. A successful call returns and opens that exact Session; the import does not call a model. External stores remain read-only. Later source changes are not synchronized into a published Maka Session, and Maka messages are not written back. The old TUI scanner and digest handoff have no production path.

The external catalog lists source conversations; the Maka task list lists published native Sessions. A newly imported old conversation need not be first in the task list because that list follows conversation activity. Reimport neither overwrites nor merges a previous copy. Different Host/Profile spaces do not share sources or Maka Sessions; a remote Host reads its own source files, never the TUI client's local files.

## Non-goals and tradeoffs

The design does not track source updates or incrementally synchronize an imported Session, add a freshness state machine, migrate ordinary Sessions made by the old digest handoff, publish truncated history, or replay source tool records as Maka runtime facts. An unknown outcome does not introduce a cross-client attempt ID or automatic reconciliation: the user can inspect published copies or explicitly create another independent copy.

## Authority and seams

| Obligation | Single authority | Public seam |
| --- | --- | --- |
| Source format, discovery, filtering, paging, decoding, and conversion | Corresponding Storage adapter | `listSessionPage(query)`, `readSession(id)` |
| Shared query, source Session ID/title/cwd matching, sanitize, and limit contracts | Core external-session | Contracts consumed by adapters and Host |
| Workspace resolution, import concurrency, result classification, staging, publication, and recovery | Runtime Host external-session coordinator | `external-session.catalog.query`, `external-session.import` |
| Current published import count and recent Maka Session IDs | Storage Session authority | `lookupExternalSessionImports(adapterId, sourceSessionIds, limit)`, projected by Host as `importState` |
| Provider admission for stored history | Runtime replay planner | `buildRuntimeEventModelReplayPlan`; continuation has separate admission |
| Desktop identity/navigation and TUI navigation | Desktop preload/shell; TUI `MakaSessionDriver` | Host-scoped Session ID; `switchSession(sessionId)` |
| Request warnings, buttons, and menus | Desktop page and TUI runner | Present Host results without attributing a catalog record to an unanswered request |

## Import path

```text
TUI / Desktop selects source and external Session
  → Host resolves workspace and catalog query
  → adapter returns a bounded catalog page
  → user selects one entry; adapter reads and converts its full transcript
  → importer verifies model-visible conversation content
  → native Maka Session is staged, Ledger history is materialized
  → Session is published and its exact ID is returned and opened
```

Catalog reads only a selection summary; import reads the selected complete transcript. A published Session has a materialized Ledger and is available in the Maka task list. The import does not run the model; the next user message may continue from the imported history.

## 1 · Module boundaries

Core defines cross-source contracts without knowing source file formats. Each Storage adapter owns discovery, filtering, cursor position, decoding, and conversion for its source. Host owns workspace resolution, wire validation, concurrency, canonical admission, error classification, staging, and publication. TUI and Desktop display results and navigate; neither parses source formats nor error strings.

## 2 · Claude catalog read bound

For each candidate the Claude catalog reads at most a 256 KiB head and 256 KiB tail. Full import has a separate budget. Incomplete JSONL records at window edges are not parsed as complete records. A Claude projects directory name is not an invertible encoding of `cwd`; scoped catalog matching uses a complete top-level `cwd` JSON string from the bounded head. A missing, broken, or truncated `cwd` excludes that candidate from a workspace-scoped query. This can omit an unprovable entry but cannot assign it to the wrong workspace.

## 3 · OpenCode import bound

OpenCode import limits encoded source payload to 64 MiB, decoded message/part rows to 250,000, and retained canonical Maka messages to 256 MiB. A breach rejects the whole import before commit; it never silently drops old content. These are bounds on defined held data, not a process RSS guarantee. Catalog includes only records provably identified as root Sessions (`parent_id` empty); child, malformed, and uncertain rows fail closed. Catalog and `readSession` share a strict row decoder.

## 4 · Conversation admission

Importer and Ledger share `isConversationTextMessage`. Human user text counts; assistant content counts only when nonempty. Tool, note, token, turn-state, and steering projections alone do not make an importable conversation. A transcript containing only runtime metadata fails before a staged Session is created.

Ledger repair groups each turn through its last stored row, even when turns interleave or a turn has several state rows. It first finds each turn's last sequence with bounded pages, then converts the same transcript through a fixed high-water sequence. The final state row determines the turn outcome.

## 5 · Assistant-first history and provider admission

The Ledger preserves a source transcript that starts with assistant content. `buildRuntimeEventModelReplayPlan` uses durable `storedMessageId` provenance to recognize repaired backfill and defaults to projecting from the first model-visible user boundary for provider consumers. Continuations are admitted separately. The UI therefore retains the complete history while ordinary provider requests receive user-led history. Native legacy and imported Sessions use the same projection rule; ordinary tool or diagnostic prefixes are not blanket-deleted.

## 6 · Workspace scope

The Runtime Host TUI external-session surface decides scope. With a current workspace target, it offers current workspace and all, defaulting to current; without a target, it offers only all. If the target disappears before a scoped query, the surface rejects that request instead of silently broadening it. TUI runner forwards this choice rather than deriving scope from the Session driver. External-source scope is independent of the Maka task list's Current/All filter. The TUI runner briefly coalesces consecutive search edits before querying the Host. Every edit advances the same request revision immediately and retires the displayed rows and cursor, so an older in-flight response cannot repaint or paginate the catalog while the newer query waits for its debounce.

## 7 · Adapter-owned paging

Every adapter implements required `listSessionPage(query)`. Host and clients treat cursors as opaque; adapters decode them, bind them to `cwd/includeArchived/text`, and identify continuation positions. Codex uses source-order keysets; Claude and OpenCode use a shared Storage offset pager with query-bound opaque cursors. Invalid or mismatched cursors raise `ExternalSessionCatalogCursorError` and map to `invalid_request`. Exceeding a source scan limit raises `ExternalSessionLimitError` and maps to `source_limit_exceeded`.

Host requests at most `page size + 1` source entries. Each returned entry carries its source continuation cursor. After wire validation or JSON byte-budget truncation, Host continues after the last entry actually delivered. Invalid or undelivered entries cannot cause a skipped page position.

## 8 · Codex keyset catalog

Codex keeps no server-side catalog snapshot, SQLite transaction, TTL, or LRU across requests. Cursors are bound to the current query. State DB pages order by `(sort_key DESC, id DESC)`, where `sort_key` is computed once by the query, selected alongside the row, and read straight back off that row to build the cursor — so the position a cursor names is by construction the position the query ordered by. One adapter normalizer accepts finite numeric or numeric-string epoch seconds/milliseconds and parseable date-time strings such as ISO 8601; SQLite ordering, cursor position, and displayed summary timestamps all call that same rule. The first page reads the newest `state_N.sqlite`; if that generation cannot be read, the page is served by the filesystem fallback rather than by an older generation, because a lower generation is the snapshot frozen at the last bump and is missing everything created since. Continuation names the generation it started on, uses a SQL keyset condition, and stays strict — a missing original generation invalidates the cursor, and a transient read failure remains a persistence failure. Connections close after each request.

The filesystem fallback orders by `(mtime DESC, fixed-size path identity ASC)` across active and optionally archived roots. Its opaque cursor uses the versioned `f2` filesystem tag; the identity is derived once from the relative rollout path, so deeply nested paths cannot enlarge the cursor past the Host wire bound. One traversal has a `maxCatalogCandidates` file bound; exceeding it returns a typed source limit. Stat-known keys reject candidates that cannot enter the current page before reading their bounded heads. The page retains at most `limit + 1` matching summaries instead of materializing the corpus or rescanning it repeatedly for deep pages.

Keysets resume strictly after the last delivered record. A live source updated between pages may move ahead of the cursor and be absent from that traversal; a fresh catalog query sees the new order. The design does not claim a stable snapshot of mutable external data.

## 9 · Host wire page boundary and import count

Every catalog field has a wire bound, including source ID, title, cwd, and recent imported Session IDs. Invalid identities are dropped rather than truncated into another identity. Host limits both item count and encoded JSON bytes. If the next entry would exceed the page budget, the response stops and resumes after the last delivered source cursor. Per-row bounds ensure a single valid row fits.

Storage counts extant published Sessions whose immutable `externalOrigin` matches the adapter and source ID. Archived Sessions count; deleted and staged Sessions do not. `importedCount` covers all matching copies; `importedSessionIds` is a short wire-safe list sorted by Maka Session creation time. It may include another client's import. “Open latest” means the first ID currently returned by Host, not the result of an unanswered request.

## 10 · Staging, publication, and recovery

Importer validates canonical input and completes deterministic catalog projection before announcing the durable commit attempt. It creates a `transcriptLedgerVersion: 0` staged Session, materializes its Ledger, then publishes it as a usable Session. A pre-materialization failure deletes staging; Host startup `recover()` processes remaining version-0 Sessions. Recovery isolates each staged Session: if both preparation and discard fail, that Session remains unpublished for a later Host recovery attempt while recovery continues with the other staged Sessions. Only published copies count in the catalog. Host coalesces concurrent imports of the same `(adapterId, sourceSessionId)` onto one in-flight Promise. An explicit import after completion creates an independent copy.

## 11 · Unknown outcome and client interaction

A Host `commit_outcome_unknown` or a transport interruption after dispatch leaves this request unconfirmed. The catalog has no operation-specific identity, so neither client interprets a count increase as proof that a particular Session came from this request. Neither automatically opens a possible copy, declares success or failure, or retries. A mounted page can show a request-local warning; remount reads Host catalog and does not restore an unknown lock.

The user may inspect the Maka task list, open an already published import from the catalog, or explicitly import again. That new request may produce another independent copy even if the first one succeeded. Host `isImporting` is the single in-flight admission constraint; published copies remain openable while another import runs. Desktop offers separate **Open latest imported task** and **Import/Import again** row actions. TUI imports a source without a prior copy directly; selecting a source with a recent imported ID offers **Open latest imported task**, **Import again** when not in flight, and Esc to cancel. Opening uses the Host-provided ID and never starts an import. A failed open reports the ID and leaves `/session` available. Batch unknown results count as neither success nor definite failure.

## 12 · Stable failure semantics

Adapters produce typed source failures; Host maps them to public results; clients localize the result without parsing exception strings. Import `source_limit_exceeded` carries a structured limit kind and maximum for transcript, record, or converted-output bounds. Catalog uses the same stable code for a candidate-scan limit. `model_unavailable` means no usable target model configuration; `source_unreadable` means source data or conversion cannot be read; `commit_outcome_unknown` means the durable outcome cannot be confirmed. Invalid catalog cursors map to `invalid_request`, distinct from transient source persistence failures. Unknown outcomes never cause an automatic retry; a later user click is a new operation.

## Verification obligations and limits

- Adapter tests cover source filtering, full-or-reject behavior, resource ceilings, cursor position, and both Codex catalog paths — including an unreadable newest generation being answered by the filesystem fallback, and a text-shaped ordering value being unable to strand the pages after it. Host and Storage tests cover wire truncation, typed errors, import counts, in-flight coalescing, staging, publication, and recovery.
- Runtime tests cover preservation of assistant-first history and user-led admission across provider projections. TUI and Desktop tests cover search, scope, open versus explicit repeat, unknown outcomes, cancellation, batch accounting, and failed navigation.
- The design does not promise a snapshot across pages of a mutable external source, or attribute a recent catalog copy to an unknown request. A packaged Desktop build and a live concurrently-writing external client have not been exercised end to end.

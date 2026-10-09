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

# Memory Network — Maka plugin

Shared memory over retained originals. An index is a fallible navigation aid; originals remain the evidence. Recall remains available. Memory organization is independent of continuous-task execution.

## Lifecycle

1. `MemoryRange` synchronizes available source versions and returns an exact opaque snapshot cursor (`to`). `from=null` describes existing information; with an index, `from` is that index's last completed snapshot. These are source-version boundaries, not dates or descriptions such as “the last 100 sessions.”
2. `MemoryIndexCreate({name, instructions, cursor})` standardizes “organize this information according to this criterion.” A normal independent Maka Agent receives the criterion and exact range as an ordinary background task. It chooses searches, message types, grouping and tools itself. There is no batch queue, assigned chunk, event schema, prescribed directory tree or publication/acceptance workflow. The method returns the complete content directory, progress and any failure for the caller to inspect.
3. Readers get the index and cursor information, then choose index documents, original links, session queries and incremental evidence to inspect. Reads and text edits never advance coverage.
4. A configurable periodic schedule (12 hours by default) runs maintenance independently of foreground conversations. Source observations refresh when an index is read, when maintenance is due, or through MemoryRange/MemoryIndexMaintain. Index reads never launch the organizing Agent. No-change scheduled checks update observation time and schedule the next check without invoking a model. It receives the covered-to-current range, can revisit older originals, and maintains existing index content. `MemoryIndexCheckpoint` saves progress. The Agent sets `complete=true` after organizing the captured range, advancing coverage to that exact cursor. With `complete=false`, progress is saved without advancing coverage; after the turn finishes normally, the plugin sends a continuation to the same Session and fixed range. Completion quality is the Agent's judgment; there is no independent evaluator. Later arrivals remain incremental.

## Tools

| Tool | Purpose |
| --- | --- |
| `MemorySources` | Discover permitted source adapters |
| `MemoryRange` | Capture existing or incremental source boundaries without running a model |
| `MemoryHistory` | Browse source/session records or query full messages within exact boundaries |
| `MemoryIndexCreate` | Criterion + cursor → independent Agent organization → actual results |
| `MemoryIndexList`, `MemoryIndexRead` | Discover all indexes and inspect the full lightweight document directory, progress and coverage |
| `MemoryIndexContent` | Read one key, multiple keys, or the full index; search keys/bodies; optional document pagination and character budget |
| `MemoryIndexWrite`, `MemoryIndexEdit` | Write arbitrary text or replace an exact text occurrence; keys/structure are Agent-chosen |
| `MemoryIndexCheckpoint` | Save progress without committing coverage |
| `MemoryOriginal` | Read a complete retained original message, lightweight backlinks and newer-version pointers; expandBacklinks=true includes linked bodies |
| `MemoryIndexMaintain` | Run/continue one background round now without enabling a paused schedule |
| `MemoryIndexControl` | Pause, resume or configure the per-index maintenance interval |

`MemoryHistory` accepts `from`, `to`, `mode` (`records` or `messages`), `source`, `recordId`, `types`, `messageId`, `query`, `since`, `until`, `offset`, and `limit`. **By default all message types and fields are included**, including process/tool messages and thinking fields. The Agent chooses any filtering. Explicit `view=conversation` is an optional projection that selects user/assistant text, omits marked commentary and thinking-only messages, and leaves unmarked legacy assistant responses visible. It never changes retained originals or coverage. Message timestamps filter results; they are not the coverage cursor.

The runtime exposes the same projection through `ctx.sessionQuery.sourceQuery(sourceId, recordId, options)` and `selectMessages(messages, options)`. Existing Recall search is unchanged.

Index text is free-form. Citations use exact `[label](memory-original:REF)` links returned by history queries. Links/backlinks are derived from text automatically. A write with empty text deletes that document. Optimistic index revisions protect concurrent edits; reads and writes are separate from checkpointing.

## Extractor tool

`MemoryExtract` (提取器) performs **one bare LLM generation** over selected originals. The caller supplies `from`/`to`, natural-language `requirements`, optional `source`/`recordIds`, types/view/query/date/message filters, and message `offset`/`limit`. The Agent decides the scope and how to use the result; there is no child Agent, task queue, fixed event schema or automatic index write/checkpoint.

The tool is visible from the first model step without `tool_search`, through the generic plugin tool registration field `discovery: 'direct'`. This controls schema discovery, not permissions. Calling the extractor is optional. For an event index, a sufficient criterion is: “按事件整理给定范围内的信息，不同条目归到对应事件，保留来龙去脉、相关时间线和原文链接。”

The plugin loads selected messages directly into the LLM prompt, including their stable original references. `limit` defaults to 5,000 messages (maximum 20,000); the receipt reports total matches and `nextOffset` so a selection is never mistaken for the entire cursor. `maxInputChars` defaults to 400,000 and is a **character guard, not a token count or context guarantee**. Oversized selections return `input_too_large` before calling the model, with no silent truncation or automatic batching. The caller can narrow its selection or adjust the guard for its model. All types remain visible by default; `view=conversation` is explicit.

Generation uses the existing `ctx.llm.generate` plugin API, currently inheriting the calling Session's model/connection; this does **not** automatically route Sol to DeepSeek. The requested output budget defaults to 32,768 tokens. Codex OAuth requires streaming and rejects an explicit output-token limit, so that endpoint controls its output limit; other providers receive the requested budget. There is no extractor-specific time limit; cancellation from the owning turn or user still stops the call. Provider errors are returned to the Agent, without pausing or marking an index complete.

Full output is saved to `<dataDirectory>/extractions/<id>/result.md`, and `receipt.json` records exact source references, filters, bounds, requirement, actual model, finish reason and unknown citations. The tool returns paths and a bounded preview. `generated` means a model response was produced, not that extraction quality or semantic completeness was proven. Truncated output and references outside the supplied originals are flagged. The Agent reads and integrates the result with ordinary index tools; extraction never advances coverage. Files are local to the Host running the plugin.

## Sources and consistency

Each adapter supplies stable record IDs, opaque content revisions, permission-checked listings and snapshots via `ctx.sessionQuery.registerHistorySource({id, description, list, read})`. Maka uses Recall visibility plus a durable ledger-head revision. Each method receives the active caller. Adapters must scope records so listing authorization covers all returned content, including historical versions. No production Feishu/mail/calendar connector is included.

Cursors retain a manifest of exact immutable message versions per source record. Revised messages and late arrivals are incremental even when their timestamps are old. Old originals and citations remain available. A removed message in a still-visible record is reported as removed, without deleting its original. Loss of source visibility fails closed for existing ranges; it is not interpreted as proof of deletion. Reads currently use complete changed-session snapshots; streaming ingestion and query acceleration are future optimizations.

SQLite retains originals, free-form documents, links, cursor manifests, worker bindings and a timestamped append-only edit/checkpoint audit. Progress writes and completion checkpoints validate range identity, current visibility, prior boundary and index revision. New arrivals after a captured boundary cannot be acknowledged by that checkpoint.

Existing legacy data is preserved, including old entries and audit tables. Legacy batch tools are no longer registered. Legacy coverage is not treated as a new snapshot cursor, and workers from other protocols remain paused until an explicit `MemoryIndexMaintain` creates a fresh worker under the new protocol. The old storage helpers remain for migration compatibility tests only.

## Scheduling and limits

Background workers use ordinary persistent Maka Sessions and inherit the initiating Session's model connection and permission mode. Their history is excluded from ingestion. A database lease prevents overlapping plugin generations from maintaining the same database. Foreground callers can stop waiting without canceling the independent job. Partial text edits and progress survive unsuccessful runs; an unfinished exact range is retried without silently extending its boundary. A fresh `complete=false` checkpoint from the worker causes another ordinary turn in the same Session after the prior turn settles. It continues saved work on the same captured range until `complete=true`, without a round-count cap. Checkpoints are attributed to the submitting Session and compared against the pre-turn audit position, so old or other-Session reports cannot trigger another turn. `runTimeoutMs` (default 10 minutes) applies separately to each turn. Timeout, Host rejection, abnormal worker termination, or an idle turn without a fresh checkpoint returns incomplete progress rather than triggering this immediate continuation. An explicitly stopped worker stays stopped for scheduled maintenance until MemoryIndexControl resume; a one-shot MemoryIndexMaintain does not unpause its schedule. Pause stops future checks; a currently active round may finish. Other failed attempts retain the existing scheduled retry behavior. There is no batch queue, native Goal or publication gate.

| Configuration | Default | Meaning |
| --- | --- | --- |
| `tickMs` | 30000 | Lightweight due-time checks; does not scan sources on each tick |
| `intervalMs` | 43200000 | Default maintenance interval (12 hours), overridable per index |
| `threshold` | 100 | Legacy configuration accepted but ignored; scheduling is time based |
| `retryMs` | 60000 | Delay before retrying an unsuccessful round |
| `runTimeoutMs` | 600000 | Timeout for each worker turn, reset on continuation |
| `dataDirectory` | generated | Persisted plugin data location |

At most two scheduled index runs start concurrently. Maintenance runs while Host/plugin are active; it does not wake a closed desktop app or automatically import new Codex histories. Model interpretation and sufficiency are not guaranteed by a completed cursor.

## Build and validation

Requires Node 22.19+ and a Maka build containing the generic history-query/source and background-Agent APIs. Upgrade an older running Host before installing this plugin.

```sh
npm install
npm run verify
```

Bundle: `release/memory-network.maka-extension`. No extra key is needed in normal operation. The opt-in `scripts/live.ts` uses the real Maka AiSdkBackend with controlled source histories and Agent lifecycle bindings. See [TEST-REPORT.md](./TEST-REPORT.md) for validation scope.

### Reading existing indexes

The read tools (`MemoryIndexList`, `MemoryIndexRead`, `MemoryIndexContent`, `MemoryOriginal`) are available directly, without tool search. Index overview returns every visible document title, size and citation count; it does not choose the first few documents for the Agent.

`MemoryIndexContent({indexId, keys: [...]})` reads a batch of full documents. `{indexId, view: "full"}` reads the entire index. `query` is a case-insensitive literal filter across keys and bodies; the default directory view avoids loading every body. `limit`, `after` and `maxChars` are optional Agent choices. A character budget stops between documents and returns `next`; an oversized first document is returned intact with `exceedsBudget: true`. There is no silent text truncation.

Backlinks from `MemoryOriginal` default to `indexId`, `key` and `title`. Read the linked document with `MemoryIndexContent`, or explicitly request `expandBacklinks: true`. Original message fields remain intact.

### External source references

Host plugins can register read-only adapters through `ctx.sources.register()`. `PluginSourceService` exposes provider metadata, native queries, paged metadata enumeration, current permission checks and version-aware original reads. The Feishu implementation lives in the separate `scripts/plugins/feishu-source` plugin; the memory plugin has no Feishu SDK or credential logic.

`memory_references` stores source instance, object identity, native locator, revision and optional local archive location. Existing public `memory-original:...` links are retained during a transactional migration. `links` now references this registry instead of requiring a `fragments` row. Original source rows are never modified. `MemoryOriginal` returns object-wide backlinks across known versions; cached evidence is permission-checked, and `latest=true` explicitly requests the current remote version. An unavailable uncached version is reported, never replaced silently.

`MemorySourceQuery` accepts provider-specific query fields advertised by `MemorySources`. Query results carry reusable refs. Querying does not advance coverage. `MemoryRange` enumerates source metadata into an immutable identity/revision boundary; it does not bulk-copy external bodies. `MemoryHistory` and `MemoryExtract` resolve selected remote originals on demand. For external history, `mode=records` is the metadata directory; body/type filters apply in `mode=messages`, using native source kinds. Mixed-source indexes retain independent coverage via existing cursor checkpoints.

Current limits: metadata enumeration is still a scoped rescan rather than an upstream change-token adapter; history bodies not observed before an upstream edit may no longer be recoverable. Session ingestion keeps the existing local archive for compatibility. Provider configuration defines the external enumeration scope. Runtime Host must include `PluginSourceService` before installing this memory plugin version.

## Delayed indexes and periodic maintenance

`MemoryIndexList`, `MemoryIndexRead` and every form of `MemoryIndexContent` return `freshness`: completed coverage cursor, latest observed cursor, last organization time, last successful source-check time, last check and maintenance errors, known pending changes, whether partial edits exist, maintenance enabled state, interval and next check time. A reused immutable cursor does not reuse its old observation time: successful checks are recorded separately. Legacy records without a known check time report unknown freshness.

Known pending changes only describe the last successful scan. Zero is never a promise that sources have not changed since. MemoryIndexList, MemoryIndexRead and every form of MemoryIndexContent automatically refresh observations before returning, preserving visibility checks. External sources enumerate metadata without eagerly reading bodies. Callers can pass coveredCursor as from and observedCursor as to directly to `MemoryHistory`; repeated reads do not consume the delta. No preliminary MemoryRange call is required. A failed scan returns knownPending=null and preserves the last successful cursor/check time; it is not evidence that sources have no new changes. Refreshing observations never moves completed coverage or changes index contents.

The scheduler persists the next check and per-index override in the existing worker record. Each due round either resumes an unfinished immutable range, or captures a new range and only invokes the Agent if there are changes. Successful completion schedules the next check after the configured interval. No-change checks preserve the organization timestamp and index revision. Failures preserve coverage and schedule a retry. A database lease and per-index running map protect reloads and overlapping calls; unfinished work is resumed without absorbing later arrivals.

`MemoryIndexControl({indexId,action:"configure",intervalMs:43200000})` adjusts an interval without unpausing. `action:"pause"` prevents later scheduled checks; `action:"resume"` schedules the next check after the interval. Existing paused workers stay paused on upgrade. Work arriving during a round is left for the next source check. During a round, entries may be partially updated while the completed coverage boundary stays unchanged; this is explicitly exposed as `partialUpdate`.

Real lifecycle tests use a separate synthetic Source and a short test-only per-index interval; they do not create or modify user content in Feishu. Controlled tests cover idle scheduling, automatic observation refresh, no-change checks, errors, in-flight arrivals, pause/resume and plugin reload recovery.

Source permission checks for scoped tools are limited to the requested sources. An unrelated provider outage does not block local or other-source indexes. Listing indexes marks inaccessible ones unavailable without returning their content; original backlink traversal omits inaccessible links. Source failures never count as an empty successful scan or advance coverage.

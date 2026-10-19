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

# Feishu Source

Read-only sources for memory-network, registered through the Host `sources` plugin service. The indexes use generic original references; native Feishu IDs, access checks, pagination and versions stay in this plugin.

## Local CLI mode

Install the official `@larksuite/cli` and authorize it as the user. Configure these scalar plugin fields:

```json
{
  "instanceId": "personal",
  "cliPath": "/absolute/path/to/lark-cli",
  "accountId": "ou_your_user_open_id",
  "appId": "cli_your_app_id",
  "cliProfile": "cli_your_app_id",
  "kinds": "[\"documents\",\"tasks\",\"calendar\"]",
  "calendarId": "primary",
  "startTime": 1790697600,
  "endTime": 1791993600,
  "containers": "[]",
  "messageStartTime": 0
}
```

`startTime`/`endTime` are an explicit calendar window in Unix seconds. Messages use independent `messageStartTime`/`messageEndTime` as allowed download bounds; defaults are 0 and no upper bound. `FeishuSync` selects a concrete interval within them. They do not inherit the calendar window. In CLI mode, omitted/empty `containers` automatically discovers all provider-accessible private and group chats, with pagination and no muted-chat exclusion. A nonempty list optionally restricts the source to selected chats/threads. Do not reuse `instanceId` for another account or application.

- `feishu.<instanceId>.documents`: accessible docx documents, including docx behind Wiki links. `documentQuery` optionally scopes enumeration. Native document ID and revision are retained; bodies are fetched only on demand at the observed revision. A changed version is not substituted for an old citation.
- `feishu.<instanceId>.tasks`: the current user's tasks, preserving native task fields, dates, status and origin links. Detail content determines revision; old incomplete tasks are historical evidence, not an automatic instruction to act.
- `feishu.<instanceId>.calendar`: occurrences within the configured calendar/time window. Native event IDs and details are retained; cancelled events resolve as deleted.
- `feishu.<instanceId>.messages`: all provider-discoverable private/group chats and their replies by default, or the configured subset. Only completed synchronization batches are visible. Enumeration, query and original reads use the local cache. Deleted/expired messages with explicit provider deletion evidence resolve as deleted; other missing originals fail the sync instead of being invented as tombstones.

Document/task/calendar queries accept `{text?, limit?, cursor?}` and retain their on-demand provider behavior. Follow `next`, even on an empty page, without changing the query. Message queries accept `{text?, types?, chatId?, startTime?, endTime?, limit?, cursor?}` (limit 1–500, Unix seconds) against published local originals. Their signed paging cursors bind the complete query, account/application/source scope and publication boundary. The signing key persists in the cache, so restarting or publishing another batch does not change an in-flight page sequence. These paging cursors differ from memory coverage cursors.

The official CLI owns credential storage and refresh. No access token is copied to Maka configuration, indexes, or tool results. Set `cliProfile` to pin the CLI profile as well as the user/app identity. Each invocation verifies the pinned user and app identity. All provider commands are fixed in the adapter, run without a shell, use explicit user identity, and pass a read-only command allowlist. Model input cannot choose a command. Metadata/detail reads use at most four concurrent calls, paced at least 250 ms apart. Rate-limit responses (`99991400`/`429`) retry up to three times with 1/2/4-second backoff; permission errors are not retried. Cancellation, CLI errors, permission errors, and unavailable sources fail closed; an error never becomes an empty successful scan.

## Token mode

Without `cliPath`, configure `instanceId`, `accountId` (user open ID), `appId`, and optional `containers` and time bounds. Supply a protected absolute `tokenFile` (0600), or plugin credential slot `access-token`. This mode requires a user token; its open ID is verified through `authen/v1/user_info`. The configured app namespace must match the token's issuing application; CLI mode additionally verifies app identity automatically. The caller manages token refresh.

## Explicit message synchronization

1. `FeishuSync({startTime, endTime, refresh?})` downloads the half-open interval `[startTime,endTime)` in Unix seconds. Code explicitly requests both private and group chats (`types=p2p,group`), preserves configured chat restrictions, pages **only that time interval**, then calls native message search for the same interval. Search IDs are deduplicated against the current job and fetched by raw `mget`, at most 50 per request. It does not expand years of historical threads or call a model per page.
2. Every completed page commits raw messages and progress to SQLite. A failed/interrupted call returns or retains a job ID; repeat the same range to resume. A completed range is reused unless `refresh=true`. An already incomplete refresh also resumes. `FeishuSyncStatus({jobId?})` reports progress, errors and published ranges without downloading messages.
3. Only after the final page and another identity check does one transaction publish the staged batch. Until then, prior published versions and paging boundaries stay unchanged. Raw IDs and versions are retained, isolated by account/application/scope. No absence in search or a failed/missing mget response is treated as deletion.
4. Read and build memory indexes after syncing. Source observation and index maintenance do **not** start another download. Optional periodic source synchronization is configured separately using FeishuSyncControl; it is off by default.

CLI cache storage uses profile `message-cache-directory` as its base. If absent, `dataDirectory` supplies the base, otherwise a directory is generated and saved. Each account uses `sha256(JSON.stringify([instanceId, accountId, appId]))/messages.sqlite`, with file permissions 0600. The durable `cursor-signing-key` is kept in plugin storage, initialized from 32 random bytes. No second cache layout or data migration is used.

The local schema consists of `sync_jobs`, `sync_chats`, `originals`, `sync_members`, `sync_tokens`, `publications`, and `heads`. Jobs store the exact `{startTime,endTime,containers}` request and `incomplete` / `complete` status. Phases are `discover → history → search → publish → complete`. Completed pages commit originals and per-chat/search/discovery progress together. Repeated cursors are checked separately per phase and chat. Publication appends only changed message versions and marks the job complete in one transaction; sequence numbers identify published message versions, not job batches. Older published originals retain their references.

`FeishuSyncStatus` returns the requested job, or the latest job when no ID is supplied. It includes range, phase, page count, discovered/completed chats, downloaded message count, timestamps, error and coverage caveat, plus the separately persisted schedule state. With no job it returns `configured:true`, `synchronized:false` and the source ID. `FeishuSync` uses `exclusive_step`; status uses `parallel`.

Queries read published originals only, ordered by message creation time and ID. The first page freezes the highest publication sequence; later pages retain that boundary. Queries default to 50 items (maximum 500); enumeration uses 500. With no completed synchronization, enumeration/query explicitly asks for `FeishuSync` rather than presenting an empty source as complete. Time/chat limits apply to queries, authorization and original reads.

Token mode continues to use its on-demand remote message adapter and explicit chat/thread scope. It does not create a local message cache or expose `FeishuSync`. Documents, tasks and calendars retain their existing on-demand behavior in CLI mode.

CLI transient failures (`invalid_response`, `command_timeout`, `EAGAIN`, `EMFILE`, `ENFILE`) allow two retries with 250ms/500ms waits. Failed identity checks are removed from the invocation cache so a subsequent check can recover. Existing rate-limit backoff and cancellation remain; permission denial and mismatched identities do not use transient retries.

Completing a sync means the bounded chat scan and search supplement finished, **not** that every historical reply or inaccessible/retention-expired conversation was recovered. Search availability and visibility are provider-defined.

## Memory loop

For CLI messages, run `FeishuSync` first, then use `MemorySources` → `MemorySourceQuery` / `MemoryRange` → `MemoryOriginal` → `MemoryIndexCreate`. Index workers use the same source tools as ordinary agents. Citations resolve through the shared reference registry. `MemoryOriginal` returns backlinks, which lead back through `MemoryIndexContent`; references from different indexes may share the same original.

Message synchronization explicitly stores bounded originals; message enumeration returns only their published metadata. Other sources enumerate addresses, revisions and metadata, not a bulk original-body snapshot. Some provider list/detail APIs transfer content while checking metadata or access; only originals explicitly read through memory are persisted in the memory evidence cache. Current index maintenance compares scoped enumerations, not push events or a native change feed. Search visibility is provider-defined and should not be presented as a dump of every document the user has ever accessed.

## Current coverage and verification

Mailbox, minutes/transcript, standalone spreadsheet cells, and Base records are not yet registered adapters. Permission grants alone do not make those data types supported. Embedded sheet references in a document remain references, not fetched cell contents. The CLI can be probed separately, but do not describe those probes as a completed memory integration.

`npm run verify` builds, type-checks, tests and packages. Run memory-network `prepare:test` first for the bundle helper. Controlled tests cover account isolation, read-only routing, pagination, native document revisions, task revisions, calendar cancellation, bounded sync, batch mget, atomic publication, resumability, durable cursors and tombstones. Real-model validation is recorded separately from these tests.

Official CLI: https://github.com/larksuite/cli

Chat discovery means what the current user/API can enumerate, not a promise that every historical, departed, expired or inaccessible conversation is available. A failed discovery or message page fails the scan; it is never silently marked covered. Explicit chat restrictions remain a filter and cannot be bypassed by search.

CLI account validation accepts `ready` and `needs_refresh` only for the configured app and user. The official CLI refreshes the latter on its next read; logged-out, expired, unknown, or switched identities still fail without treating the source as empty.

## Optional periodic message sync

`FeishuSyncControl({action:"enable"|"pause"|"check",intervalMinutes?,overlapHours?})` uses the same cached sync engine. Enable only on a user request. Cadence defaults to 30 minutes (5–1440), overlap to 24 hours (1–168); extension configuration supplies the defaults. `check` is one check without enabling a paused cadence. Pausing prevents future checks and lets an active batch finish. This is source I/O, with no organizing model call.

Scheduler metadata and an ownership lease are persisted alongside the existing cache in additive `sync_schedule` / `sync_schedule_lease` tables. Existing jobs, originals, publications and cursors are unchanged. Each failed batch retains its exact range and page state across restart; retry delays grow from 30 seconds to at most one hour. A changed source scope disables the previous schedule until explicitly re-enabled, without removing published originals. Different ranges cannot run concurrently through one sync engine, avoiding out-of-order publication; the caller receives a retryable busy error.

After downtime the next batch includes the unsynchronized gap plus overlap, rather than replaying every missed interval. The overlapping creation-time window can refresh messages inside that window; it does **not** establish that older edits, deletions or inaccessible messages were discovered. Source status and index freshness are independent: observing the local cache never asserts the live server was checked.

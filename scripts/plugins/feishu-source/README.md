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

`startTime`/`endTime` are an explicit calendar window in Unix seconds. Messages use independent `messageStartTime`/`messageEndTime`; defaults are 0 and the start of each scan. They do not inherit the calendar window. In CLI mode, omitted/empty `containers` automatically discovers all provider-accessible private and group chats, with pagination and no muted-chat exclusion. A nonempty list optionally restricts the source to selected chats/threads. Do not reuse `instanceId` for another account or application.

- `feishu.<instanceId>.documents`: accessible docx documents, including docx behind Wiki links. `documentQuery` optionally scopes enumeration. Native document ID and revision are retained; bodies are fetched only on demand at the observed revision. A changed version is not substituted for an old citation.
- `feishu.<instanceId>.tasks`: the current user's tasks, preserving native task fields, dates, status and origin links. Detail content determines revision; old incomplete tasks are historical evidence, not an automatic instruction to act.
- `feishu.<instanceId>.calendar`: occurrences within the configured calendar/time window. Native event IDs and details are retained; cancelled events resolve as deleted.
- `feishu.<instanceId>.messages`: all provider-discoverable private/group chats and their replies by default, or the configured subset. Every fresh enumeration discovers chats again, so newly joined chats enter the next source boundary. Messages past the provider retention period resolve as unavailable.

Document/task/calendar queries accept `{text?, limit?, cursor?}`. Follow `next`, even on an empty page, without changing the query. `limit` is 1–100 (document API pages cap at 20). Message queries accept `{text?, types?, chatId?, startTime?, endTime?, limit?, cursor?}` (limit 1–50, time bounds in integer Unix seconds; floor the start and ceil the end when converting millisecond timestamps). In the default all-chat mode, `text`, `chatId`, or time filters use native search and resolves native originals for stable citations. An unfiltered query or coverage enumeration walks chat pages, message pages and thread replies. Keep all filters unchanged while following a cursor, including empty pages. Native search results are not proof of exhaustive history coverage. These short-lived paging cursors differ from immutable memory coverage cursors.

The official CLI owns credential storage and refresh. No access token is copied to Maka configuration, indexes, or tool results. Set `cliProfile` to pin the CLI profile as well as the user/app identity. Each invocation verifies the pinned user and app identity. All provider commands are fixed in the adapter, run without a shell, use explicit user identity, and pass a read-only command allowlist. Model input cannot choose a command. Metadata/detail reads use at most four concurrent calls, paced at least 250 ms apart. Rate-limit responses (`99991400`/`429`) retry up to three times with 1/2/4-second backoff; permission errors are not retried. Cancellation, CLI errors, permission errors, and unavailable sources fail closed; an error never becomes an empty successful scan.

## Token mode

Without `cliPath`, the original message adapter remains supported. Configure `instanceId`, explicit `containers`, and `startTime`; optionally `endTime`. Supply a protected absolute `tokenFile` (0600), or plugin credential slot `access-token`. The caller manages token refresh in this mode.

## Memory loop

Use `MemorySources` → `MemorySourceQuery` / `MemoryRange` → `MemoryOriginal` → `MemoryIndexCreate`. Index workers use the same source tools as ordinary agents. Citations resolve through the shared reference registry. `MemoryOriginal` returns backlinks, which lead back through `MemoryIndexContent`; references from different indexes may share the same original.

Enumeration stores addresses, revisions and metadata, not a bulk original-body snapshot. Some provider list/detail APIs transfer content while checking metadata or access; only originals explicitly read through memory are persisted as evidence. Current index maintenance compares scoped enumerations, not push events or a native change feed. Search visibility is provider-defined and should not be presented as a dump of every document the user has ever accessed.

## Current coverage and verification

Mailbox, minutes/transcript, standalone spreadsheet cells, and Base records are not yet registered adapters. Permission grants alone do not make those data types supported. Embedded sheet references in a document remain references, not fetched cell contents. The CLI can be probed separately, but do not describe those probes as a completed memory integration.

`npm run verify` builds, type-checks, tests and packages. Run memory-network `prepare:test` first for the bundle helper. Controlled tests cover account isolation, read-only routing, pagination, native document revisions, task revisions, calendar cancellation, message scope and thread expansion. Real-model validation is recorded separately from these tests.

Official CLI: https://github.com/larksuite/cli

Chat discovery means what the current user/API can enumerate, not a promise that every historical, departed, expired or inaccessible conversation is available. A failed discovery or message page fails the scan; it is never silently marked covered. Explicit chat restrictions remain a filter and cannot be bypassed by search.

CLI account validation accepts `ready` and `needs_refresh` only for the configured app and user. The official CLI refreshes the latter on its next read; logged-out, expired, unknown, or switched identities still fail without treating the source as empty.

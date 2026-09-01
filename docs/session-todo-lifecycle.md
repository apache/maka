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

# SessionTodo Lifecycle

Status: **Current**. The former Session Task Ledger is **Removed**: its module,
storage, and `workflow_task_ledger_events` table are gone as of workflow schema
12. SessionTodo is the only Session task surface.

This document answers one question for Runtime, Runtime Host, CLI, and Desktop
contributors: who owns a Session's current Todo list, and what must happen to
that list as the Session is read, copied, archived, or removed?

## Mental model

SessionTodo is one small current-state document attached to one Session. It is
closer to replacing a whiteboard checklist than appending to an audit log.
`todo_read` returns the whole ordered list; `todo_write` atomically replaces the
whole ordered list.

For example, this write:

```json
{
  "todos": [
    { "content": "inspect the owner", "status": "completed" },
    { "content": "run focused tests", "status": "in_progress" }
  ]
}
```

commits exactly those two items in that order. A later write containing only
the second item removes the first. There is no item identity, patch operation,
revision, history, hierarchy, owner, evidence, cursor, or watermark.

`completed` is model-reported progress. It is not proof that a command ran, a
test passed, or a file changed; AgentRun, RuntimeEvent, tool results, filesystem,
and git remain the authorities for those facts.

## Authority and data flow

The Runtime Host is the sole interactive authority. Storage owns the durable
document and migration transaction; Runtime exposes the model tools; CLI and
Desktop only render Host-owned results.

```text
model todo_read / todo_write          Desktop read-only panel
              \                         /
               Runtime Host SessionTodo coordinator
                    | admission + Session presence
                    | commit, then signal-only invalidation
                    v
            SQLite SessionTodo current document
```

`todo_write` is an internal Host tool port rather than a public Client mutation
operation. Desktop reads through `session.todo.query`. A successful replacement
commits before the Host publishes a `todo` domain invalidation. Reads and
first-read initialization are silent because they do not change the effective
current list.

The stored document is canonical product state. Before model or Desktop
display, content passes through the shared Unicode sanitization, secret
redaction, and `<session-todo>` tag-neutralization projection. Display safety
does not rewrite the stored document.

## Document contract

Each item contains only:

- `content`: non-empty normalized text, at most 200 Unicode code points;
- `status`: `pending`, `in_progress`, or `completed`.

The document contains at most 200 items and at most 256 KiB of encoded JSON.
These bounds keep the complete snapshot below the Runtime Host frame budget, so
the operation needs no paging contract.

An initialized empty list is different from no SessionTodo row. That distinction
is what makes explicit clearing deterministic.

## First read

The first Host read of an uninitialized Session, through either `todo_read` or
`session.todo.query`, persists an empty document and returns it. The first
explicit `todo_write` writes the requested complete list directly.

## Copy and branch semantics

Conversation copy initializes the target Todo inside the Host-owned copy
lifecycle, before the target Session is published:

- an ordinary branch whose selected cut includes the latest committed turn
  copies the source's current Todo;
- a historical cut, before-revision, or side conversation initializes an
  explicit empty Todo document.

Initialization is one SQLite write transaction. The source's current document
is read — an uninitialized source reads as empty, without being written — and
the absent target is inserted in the same transaction. Retrying an identical
initialization is idempotent; a different or corrupt existing target fails
closed instead of being overwritten.

The Runtime Host holds the source and target Session admission lanes during the
copy. A failed copy purges the incomplete target's Todo state before discarding
the preparing Session.

## Archive, removal, backup, and rollback

- Archive retains the current Todo document.
- Remove and incomplete-copy discard purge the Todo document, so a deleted
  Session cannot show stale work if its identifier is observed again.
- Backup and restore preserve both non-empty and initialized-empty documents.

Rollback across the cutover means restoring a database backup taken before the
upgrade. That loses Todo edits made after the backup; running an old binary
directly against the upgraded live database is not a supported rollback
guarantee.

Upgrading to workflow schema 12 drops `workflow_task_ledger_events` without
migrating it. A workspace last opened by v0.2.0-incubating-rc1 or earlier loses
its unfinished Tasks; they are not imported into SessionTodo.

## Surface behavior

CLI/TUI renders the settled semantic `todo_read` or `todo_write` tool result.
It does not present `todo_write` arguments as committed state, including when a
durable transcript is reconstructed after restart.

Desktop renders the same current ordered snapshot as a flat read-only list.
Session and request-generation fences reject late responses after navigation;
signal-only invalidations trigger a fresh full read rather than client-side
merging.

No SessionTodo content is appended to a turn-tail prompt or dynamic system
prompt. The model reads it on demand with `todo_read`.

## Code map

- `packages/core/src/session-todo.ts`: document validation, bounds, and shared
  display projection.
- `packages/storage/src/session-todo-store.ts`: SQLite persistence, migration,
  copy initialization, and purge.
- `packages/runtime-host/src/server/session-todo-coordinator.ts`: Session
  admission, presence checks, commit, and invalidation.
- `packages/runtime/src/session-todo-tools.ts`: model-facing read and
  whole-document write tools.
- `packages/runtime-host/src/server/session-revision-coordinator.ts` and
  `session-retirement-coordinator.ts`: copy and lifecycle integration.
- `apps/desktop/src/main/runtime-host-client.ts`: Desktop query adapter and
  display-safe projection.

The legacy Task codecs, replay, and tables are deleted. Nothing may recreate a
second product surface for Session tasks or change this current-document
contract.

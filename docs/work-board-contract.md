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

# Work Board Phase 0 Contract

Status: Phase 0. Scope: `packages/core` (contract) + `packages/storage` (store and migration).

## Boundary

The Work Board is a user-owned, local-first surface for deferred work. It is not an
execution authority:

- no `task_*` tools, no `task.ledger.query`, and no `workflow_task_ledger_*` reads/writes;
- no model-visible tools and no turn-tail injection;
- no Goal, AgentRun, RuntimeEvent, or Agent Graph writes;
- execution state is projected at read time, never copied into board storage.

## Item contract

```ts
interface WorkBoardItem {
  schemaVersion: 1;
  id: string;              // durable UUID, never rewritten
  revision: number;        // monotonic per item, incremented on every effective mutation
  scope: WorkBoardScope;   // inbox | { kind: 'project'; projectId }
  title: string;
  notes?: string;
  state: 'todo' | 'in_progress' | 'done';
  creator: { kind: 'user' } | { kind: 'agent_suggestion'; confirmedAt: number };
  provenance: WorkBoardProvenance;
  createdAt: number;
  updatedAt: number;
  // Active items never carry `archivedAt`; archived items always carry it:
  // { archived: false } | { archived: true; archivedAt: number }
  archived: boolean;
  archivedAt?: number;
}
```

`linkedSessions` is deferred to Phase 3: Phase 0 has no consumer and no mutation
path that writes it, so the Phase 0 contract rejects the field in create input
and in stored records. It will be added together with the canonical continuity
adapter when "start as task" lands.

`Inbox` is a scope, not a status. State transitions are user-confirmed only:

```text
todo <-> in_progress
todo -> done
in_progress -> done
done -> todo | in_progress
```

`done` is user intent. It is never derived from a Session or AgentRun outcome.

## Provenance

Provenance is a discriminated union:

- `manual`;
- `main_conversation` (`sessionId`, `messageId`, optional `runId` / `turnId`, `capturedAt`, bounded `excerpt`; `parentSessionId` is rejected);
- `side_conversation` (same fields plus required `parentSessionId`).

The bounded `excerpt` is snapshotted at capture time so a side-chat item survives
the temporary fork's deletion. Typed refs are best-effort links, not hard
dependencies.

Agent suggestions require `confirmedAt` and are only created by explicit user
action or an unambiguous instruction. The board never writes itself.

## Persistence and mutation

`WorkBoardStore` in `packages/storage` owns the `workflow_work_board_items` table
in `runtime.sqlite` (operational-state database), added by the additive workflow
schema 8 → 9 migration:

```sql
CREATE TABLE IF NOT EXISTS workflow_work_board_items (
  item_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('inbox', 'project')),
  project_id TEXT,
  archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
  record_json TEXT NOT NULL,
  CHECK (
    (scope_kind = 'inbox' AND project_id IS NULL)
    OR
    (scope_kind = 'project' AND project_id IS NOT NULL)
  )
);
```

Writes:

- mutations are semantic patches (`title` / `notes` / `scope` / `state`), never
  full-record replacement. In this patch contract, `undefined` (or an omitted
  field) means "not provided" and keeps the stored value; `notes: null`, an
  empty string, or a whitespace-only string is the explicit clear signal. This
  is a contract decision, not a JavaScript object-equality rule;
- all mutations are serialized on one write queue and committed in a transaction;
- every effective mutation increments `revision`;
- `expectedRevision` provides optimistic concurrency (CAS);
- mutation timestamps are clamped to the stored `updatedAt`, so keyset ordering
  stays monotonic even if the wall clock moves backwards;
- permanent deletion requires an archived item;
- reads reject disagreement between the indexed columns and `record_json.scope`
  as `corrupt_record`.

There is no total item cap. List/query size is bounded by pagination (default 50,
max 100) with an opaque keyset cursor. Cursors are bound to the normalized
`scope` / `includeArchived` filters; reusing a cursor with different filters is
rejected as invalid input.

The default `archived = 0` list queries are covered by partial indexes on active
rows only:

```sql
CREATE INDEX workflow_work_board_items_active_scope_order
  ON workflow_work_board_items(scope_kind, project_id, updated_at DESC, item_id DESC)
  WHERE archived = 0;
CREATE INDEX workflow_work_board_items_active_order
  ON workflow_work_board_items(updated_at DESC, item_id DESC)
  WHERE archived = 0;
```

This keeps an archive-heavy database from walking most of the ordering index to
produce one page of active items.

## Linked-session projection

Deferred. Phase 0 does not ship a projection function: there is no production
consumer yet, and the minimal DTO would have been a parallel contract instead
of the canonical `SessionContinuitySnapshot` / `TurnSnapshot` used by the
Runtime Host. It will be implemented beside the real continuity adapter when
"start as task" lands in Phase 3, using only facts those authorities directly
expose.

## Tests

- contract: decode, provenance invariants, state transitions, archive invariant,
  bounds, patch/CAS semantics;
- storage: migration, reopen persistence, pagination/filtering, archive/delete,
  archive-heavy index coverage, concurrent mutations, corrupt-record rejection,
  backup/restore;
- projection: deferred to Phase 3 (no Phase 0 module or tests).

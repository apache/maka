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
  linkedSessions: Array<{ sessionId: string; linkedAt: number }>;
  createdAt: number;
  updatedAt: number;
  archived: false | true;  // active items never carry archivedAt; archived items must
  archivedAt?: number;
}
```

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
- permanent deletion requires an archived item;
- reads reject disagreement between the indexed columns and `record_json.scope`
  as `corrupt_record`.

There is no total item cap. List/query size is bounded by pagination (default 50,
max 100) with an opaque keyset cursor.

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
  concurrent mutations, corrupt-record rejection, backup/restore;
- projection: pure-function fixtures only.

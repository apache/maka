# Work Board Phase 1 — capture/list MVP

## Surface

A compact Work Board tab in the session workbar, next to Tasks, with:

- global Inbox and current-project filtering;
- manual create, rename, move (Inbox <-> project), complete / reopen,
  archive / restore, and delete (archived items only);
- empty, loading, and error states;
- local-first persistence through the existing operational-state database.

## Boundary

- The Desktop main process owns `WorkBoardStore`; the renderer is a read-only
  IPC projection that reloads on the `workBoard:changed` signal.
- No Runtime Host involvement, no model-visible tools, no turn-tail injection.
- `linkedSessions` and the linked-session projection remain deferred to Phase 3.

## Why a dedicated store instead of a project file

A project `TODO.md` / issue would satisfy the literal capture-and-list atom,
but the #2560 acceptance criteria also require:

- side-conversation capture that keeps typed source references and a bounded
  excerpt after the temporary fork is deleted;
- per-item user lifecycle (complete / reopen / archive) under concurrent
  Desktop writes, which needs a stable item identity and revision CAS;
- Inbox vs project scoping, and later start-as-task linking with typed result
  refs.

A file would need an ad-hoc parse convention, provide no stable per-item
identity or CAS for concurrent writers, and cannot carry typed provenance
without inventing a second format. It would also bypass the operational-state
database that already owns backup/restore and migrations. The Work Board store
is therefore not a Linear/Jira-shaped skeleton: it is the smallest
machine-readable authority that keeps the deferred-intent atom linkable and
safe under concurrent local writers. Session linking (Phase 3) and result refs
(Phase 4) are the load-bearing reasons for this shape; if they were not in
scope, a project file would indeed suffice.

## Sequencing

Per maintainer review, the load-bearing assumption is that users return to the
board and start tasks from it. The plan is to validate a thin
capture -> revisit -> start-as-task loop before expanding Phases 2 and 4.

## Implementation

- Main: `apps/desktop/src/main/work-board-ipc-main.ts`
  (`workBoard:list/create/update/archive/unarchive/remove` + change signal).
- Preload: `window.maka.workBoard` in `apps/desktop/src/preload/preload.ts`.
- Renderer: `useWorkBoard` hook and `WorkBoardPanel`, wired as a workbar tab in
  `session-workbar.tsx`.

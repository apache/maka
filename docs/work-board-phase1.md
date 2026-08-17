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

## Implementation

- Main: `apps/desktop/src/main/work-board-ipc-main.ts`
  (`workBoard:list/create/update/archive/unarchive/remove` + change signal).
- Preload: `window.maka.workBoard` in `apps/desktop/src/preload/preload.ts`.
- Renderer: `useWorkBoard` hook and `WorkBoardPanel`, wired as a workbar tab in
  `session-workbar.tsx`.

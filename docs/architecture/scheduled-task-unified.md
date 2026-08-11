# ScheduledTask — unified 定时任务

## Problem

Maka previously had two clocks:

1. Desktop-owned notification schedules
2. Runtime Host standalone session schedules

The product word was one (“定时任务”), the data paths were two. Agent-created work never appeared in the desktop catalog.

## Design

One noun: **`ScheduledTask`**.

| Concern | Owner |
|---------|--------|
| Catalog + schedule math | Runtime Host `HostScheduledTaskCoordinator` + SQLite `workflow_scheduled_tasks` |
| Fire admission and recovery | Runtime Host (`workflow_scheduled_task_fires`) |
| Due effects | Runtime Host; Desktop is only a native delivery provider |
| Desktop/TUI/CLI access | bounded `scheduled-task.query` / `scheduled-task.mutate` protocol |
| Agent create/list/pause/resume/delete | `ScheduledTask` tool → Host coordinator directly |
| Heartbeat (session polling) | still `Automation` tool, session-scoped only |

### Effects

- `notify.local` / `notify.bot` — Host admits the fire, then invokes one Desktop native-effect
  provider. Desktop never reads or advances the catalog.
- `agent_run` — freeze the execution template at create; on fire, Host creates a stable Session and
  admits the root AgentRun itself.

### UI

The scheduled-task panel consumes `ScheduledTask` directly. The renderer keeps its existing
`scheduled-tasks:*` IPC surface, but Desktop main is a thin Runtime Host protocol proxy. Host
change frames are signals only; Desktop re-queries the canonical record.

### Authority invariant

Runtime Host is the only catalog writer, scheduler, clock, and fire admission authority. No
interactive client opens the ScheduledTask SQLite tables. Agent tools and every UI surface reach
the same coordinator, so ownership does not depend on which client initiated a Session.

Before an effect crosses its irreversible boundary, the Store persists one unique fire claim per
task. For `agent_run`, it also persists the stable Session/Turn/Run/message identity before Session
creation or execution admission. Recovery can therefore reconcile the exact Host execution
without creating a duplicate Session. Native delivery claims are not replayed after an unknown
outcome.

### Runtime boundary

Scheduled tasks keep Runtime Host resident even when the initiating client exits. `agent_run`
requires no Desktop. Local and bot notifications wait durably for a native-effect provider before
crossing the delivery boundary. Once invocation starts, an unknown outcome is recorded as failed
and is never replayed. Other interactive clients can create and manage the global catalog through
the same Host protocol; heartbeat remains a separate session-scoped Automation. The separate
Headless runtime is outside this interactive authority boundary.

## Key files

- `packages/core/src/scheduled-task.ts`
- `packages/storage/src/scheduled-task-store.ts`
- `packages/runtime/src/scheduled-task-tools.ts`
- `packages/runtime-host/src/protocol/scheduled-task.ts`
- `packages/runtime-host/src/server/scheduled-task-coordinator.ts`
- `apps/desktop/src/main/scheduled-tasks-ipc-main.ts` (protocol proxy)
- `apps/desktop/src/main/runtime-host-boot.ts` (native-effect provider)

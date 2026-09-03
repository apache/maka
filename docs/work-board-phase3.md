# Work Board Phase 3 — Start-task validation spike

This is a temporary, default-off experiment validating the
`capture -> revisit -> start` loop.

For local dogfooding, enable it only in a development renderer with
`VITE_MAKA_WORK_BOARD_START_TASK=1`; production builds keep the entry hidden.

## Scope

- only project-scoped items whose project identity resolves through the Task
  Entry catalog to one available, non-archived `(profileId, hostId, projectId)`;
- Inbox items and ambiguous/unavailable Host targets remain disabled;
- the existing New Task surface and Composer first-send path create the Session;
- the draft contains only the bounded item title and optional notes;
- a successful first send adds an idempotent Host-scoped `linkedSessions` entry;
- opening a link navigates through the existing Desktop Session identity path.

The spike does not add side-chat capture, model-visible Work Board tools,
turn-tail injection, execution-state projection, result refs, automatic
completion, prioritization, or a persisted feature setting.

## Evidence checklist

For each dogfooding run record whether the item pre-existed, the resolved Host
and project, normal first-send completion, restart/reopen behavior, duplicate or
orphan Sessions, and any manual repair. Record an explicit `go` or `stop`
decision before starting Phase 2 or Phase 4.

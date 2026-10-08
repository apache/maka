# Heartbeat assistant revision — 2026-10-08

Current implementation uses the initiating ordinary conversation Session. Removed the notebook, InitiativeRead / InitiativeHistory / InitiativeCheckpoint and the finish hook. Host cadence schedules checks; pause does not cancel user work. Legacy state is archived and paused on migration.

Controlled validation: 9 tests passed, including packaged extension execution, natural finish without checkpoint, busy foreground deferral, queued admission, restart/interruption, aborted runtime completion, migration, and lease fencing. Build, pack and typecheck passed.

Matter delegation is tested in proactive-matters: idempotent creation, separate worker lifecycle, wait → user amendment → completion, task ownership, cancellation, and late-write rejection. Real-model smoke artifacts are stored outside the repository. Real Sol smoke confirmed shared chat history, independent task delegation, host heartbeats, quiet completion, and an approved wait followed by timer resumption. Final task completion / result relay was not verified: repeated provider connection timeouts and an independent proxy timeout stopped the test. Original environment restored. Fixed a real integration bug where the Host ignored requested Session IDs; delegation now persists the actual returned ID. Controlled tests are not evidence of broad proactive recommendation quality.

## Historical report (previous implementation)

# Verification scope

2026-09-30: `npm run verify` passed: build, exported-bundle packaging, 8/8 controlled tests and TypeScript checking.

Controlled tests exercise the actual HostPluginPlatform, tool registration, background Agent interfaces, natural-finish hooks, SQLite stores, and the real memory-network extension. Runtime model calls and external actions are replaced with deterministic adapters.

The scenario creates two independent indexes: a project deadline and a supplier commitment. First check stays quiet. A new supplier original changes delivery from Thursday to Monday while the index still says Thursday. The next check reads the uncovered increment, combines it with the Friday deadline, and prepares one simulated local backup checklist. A further unchanged check performs no duplicate action. Neither initiative reading nor its checkpoints advance memory index coverage.

Additional regressions cover timer wakeups in the same Session, queued admission before turn execution, required checkpoints, invalid past times, stale activation/turn/revision rejection, exact retry idempotence, cross-conversation control isolation, restart persistence, interrupted execution handling, lease fencing, history pagination and installation from the exported bundle.

This is framework integration verification, **not real-model decision-quality validation**. The scenario does not establish that a small model will discover the relevant indexes, interpret every original correctly, or choose useful actions in arbitrary histories. No live model service or user's ongoing memory run is used or restarted.

The current memory plugin refreshes its lease every 10 seconds. Installing another extension reloads it, so the integration test waits for that refresh before building fixture indexes. This is inherited memory plugin behavior; initiative does not change it.


## Live follow-up, 2026-09-30

Flash ran two real model turns over ten recent Codex conversation snapshots and three manually curated need-oriented indexes. First turn wrote one local suggestion; unchanged second turn committed an empty update without another draft. Actual Host tools and Maka AI SDK backend were used in an isolated runtime fixture; no desktop deployment or external task execution. The earlier controlled-test-only limitation above describes the original eight tests.

The live run exposed two material limitations: the model overstated absence of evidence as current failure/no implementation, and a records/all history read loaded ~1.16 MB of JSON. The following quiet turn still carried ~362k input tokens per request in session history. This run demonstrates a functional loop, not adequate judgment quality or efficient index use. Private evidence is retained locally under `.artifacts/live-ten/RESULTS.md` and `report.json`, excluded from version control.


## Open-tool proactive task follow-up

The next Flash run used the same snapshots/indexes, the broader proactive task and ordinary Maka built-in tools. Both turns completed; the model performed real local inspections and updated one draft, with an empty user update on the second turn. No web calls were selected. Eight controlled regressions and typecheck/build/package passed. The model read the evaluation artifacts itself, then incorrectly inferred completion from report-file presence; this self-reference contaminates the comparison. Evidence and full limitations are retained in `.artifacts/live-open/RESULTS.md`. Tool restrictions are prompt guidance only, as explicitly requested for this test.


## Notification-priority run

One Flash turn completed using the same ten-session inputs and manual indexes, with notification selection/ranking as the primary task. The model prioritized memory-index progress, initiative quality, an unverified PR, and an unanswered research question. It did not create a draft and did submit a user-facing update. Its claim that only controlled tests existed contradicted the live-test evidence it then cited; self-evaluation artifact contamination also remained. Web access failed/timed out, so no PR status was verified. Local evidence: `.artifacts/live-priority/USER-UPDATE.md` and `RESULTS.md`. Build and typecheck passed.

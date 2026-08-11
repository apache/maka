# Documentation archive

Files here are retained for historical context. They are not current contracts, roadmaps, or implementation instructions.

## Frontend

- `design-system-v0.2-wave-10.md` — the former design-system document; retired because stable rules, implementation snapshots, and future PR plans had become inseparable.
- `full-product-test-plan-2026-05.md` — a completed one-month delivery plan.
- `ui-quality-plan-2026-05.md` — a time-sensitive rollout and coverage snapshot.
- `design-refinement-roadmap-2026-07.md` — completed design decisions and an obsolete documentation backlog.

The root `DESIGN.md` owns shared product design intent. `docs/frontend-css-governance.md`, local frontend READMEs, source, and contract tests own implementation rules and executable behavior.

## Audits

- `maka-capability-audit-v1-2026-05.md` — a point-in-time capability and release-gate audit whose frontend authority references are no longer current.

## Validation snapshots

- `desktop-smoke-plan-legacy.md` — completed PR acceptance paths and deferred UI designs removed from the current executable smoke runbook.

## Former repository notes

Tracked `notes/` files were retired as an undocumented parallel authority. Point-in-time audits, migration plans, reference reverse-engineering, and design research remain here only for provenance. Current repository rules live in `ARCHITECTURE.md`, `DESIGN.md`, active cross-cutting contracts, local READMEs, source, and tests; workspace-specific agent instructions are supplied outside the tracked documentation set.

- `frontend-simplification-map-2026-07-13.md` — baseline knip/size measurement for the frontend simplification rounds landed in #871–#887.
- `composer-mentions-spec-2026-07-14.md` — the shipped v1 `@`/`/` composer mention-popup spec (#979); current behavior lives in `packages/ui` source and the composer-mention contract test.

## Security contract snapshots

- `memory-threat-model-pr-memory-1.md` — the contract-only PR-MEMORY-1 boundary, superseded as a description of the current product.
- `search-service-threat-model-pr-search-0.md` — the PR-SEARCH-0/1.5 boundary, superseded as a description of current search.
- `voice-threat-model-pr-voice-0.md` — the docs/core-only PR-VOICE-0 boundary, superseded as a description of current voice.

## Implementation plans

The dated runtime files are completed execution plans. Each file records the pull request that landed its implementation.

`heavy-task-mainline-system-design.md` preserves the original PR, trace, and rollout chronicle. The Headless heavy-task mechanism it describes was retired by #2598 and has no current implementation authority.

`deepseek-reasonix-cost-runtime-design.md` preserves the original implementation slices and open decisions. Backend architecture chapters and runtime source own current request-shape, replay, compaction, and cost mechanisms.

`runtime-kernel.md`, `runtime-v2-architecture-evolution.md`, and `runtime-mainline-teaching-manual.md` preserve the extraction rationale and overlapping teaching narrative that led to the current runtime. Current authority starts at `ARCHITECTURE.md`.

`runtime-v2-implementation-notes.md` records the initial Phase 1–4 runtime skeleton and is superseded by the backend architecture chapters and current source.

## Computer use follow-up records

The computer-use follow-up files are per-PR follow-up records, incident investigations, and run logs from the #857–#985 delivery chain. Current computer-use authority lives in the contracts listed in `../README.md` and in source and contract tests.

- `computer-use-delivery-state.md` — `outcome_unknown` delivery-state follow-up; postcondition semantics are owned by the foundation contract and runtime tests.
- `computer-use-evidence-hardening.md` — fail-closed report hardening; the current boundary is owned by the provider evidence contract and evidence classes.
- `computer-use-executor-hardening.md` — post-merge review record of PR #893; durable decisions are folded into the foundation contract and the model-loop foundation, remaining work belongs in issues.
- `computer-use-runtime-hardening.md` — lifecycle fix record of PR #892; current fencing is owned by runtime source and tests.
- `computer-use-physical-input-guard.md` — physical-input interference incident and the guard policy it produced.
- `computer-use-process-restart-e2e.md` — process-restart soak goal, investigation, and run logs; the PID-reuse non-claim is restated in the host events contract.
- `computer-use-real-ax-model-e2e.md` — real-model AppKit AX harness record and provider run logs; current evidence classes and operator commands live in `../computer-use-evidence-classes.md`.

## Reverse-engineering records

- `expert-team-plan.md` and `expert-team-implementation.md` — historical WorkBuddy and QoderWork reverse-engineering notes for the retired expert-teams feature (#971).

## Benchmark logs

- `economic-mechanisms-benchmark.md` — the first synthesis-cache benchmark entry for economic-mechanisms tracking issue #481 and slice #578. Current progress belongs in those issues.

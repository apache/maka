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

# Deep Research durable workspace

This contract is an independent, minimal reproduction of the central systems
idea in [FS-Researcher: Test-Time Scaling for Long-Horizon Research Tasks with
File-System-Based Agents](https://arxiv.org/abs/2602.01566) (Zhu et al., ACL
2026). It supports the Deep Research direction tracked in
[issue #566](https://github.com/maka-agent/maka-agent/issues/566).

The reproduction uses the paper's high-level two-stage method:

1. Build a durable knowledge base by archiving raw sources before derived
   evidence notes.
2. Write an outline, source-backed sections, and a final report from that
   durable workspace.

No source code, prompts, or documentation are copied from the paper's reference
repository. The Maka implementation is built independently on Maka's existing
event-ledger and Artifact Store contracts.

## Status and audience

This document is the stable architecture and safety contract for the initial
Deep Research workspace shipped by PR #1227. It is intended for:

- reviewers checking issue #566 against the implementation;
- runtime and storage maintainers evolving the ledger or tools;
- Desktop maintainers consuming the projected run state; and
- contributors adding local exploration, web research, or report-generation
  behavior without weakening the read-only boundary.

Code and contract tests remain authoritative if this document and the
implementation disagree.

## Reviewer summary

The change deliberately separates workflow metadata from large research
content:

| Concern | Authority | Main implementation |
| --- | --- | --- |
| Run lifecycle and invariants | Event projection | `packages/core/src/deep-research-run.ts` |
| Append-only persistence and replay | Deep Research store | `packages/storage/src/deep-research-store.ts` |
| Source, note, and report bodies | Existing Artifact Store | `packages/core/src/artifacts.ts` |
| Model-facing mutations and reads | Eight runtime tools | `packages/runtime/src/deep-research-tools.ts` |
| Session gating and IPC | Desktop main/preload | `apps/desktop/src/main/main.ts`, `apps/desktop/src/preload/preload.ts` |
| Visible progress and handoff | Desktop renderer/UI | `apps/desktop/src/renderer/use-deep-research-run.ts`, `packages/ui/src/chat-view.tsx` |

The highest-risk review areas are:

1. projection invariants and failure behavior for corrupt or conflicting events;
2. artifact ownership, source traceability, and integrity-checked reads;
3. root-session gating for Maka-owned write tools; and
4. the explicit transition from a read-only research session to a new normal
   implementation task.

## Paper-to-Maka mapping

The paper describes a persistent workspace shared by a Context Builder and a
Report Writer. Maka adopts the systems boundary, not the reference
implementation:

| FS-Researcher idea | Maka reproduction | Deliberate difference |
| --- | --- | --- |
| File system as external memory | JSONL event ledger plus Artifact Store | Maka reuses app-owned storage rather than exposing arbitrary project paths |
| Context Builder archives sources and notes | `source` and `evidence_note` artifacts with explicit provenance | Search and worker scheduling remain bounded, separately authorized substeps |
| Report Writer consumes the knowledge base | Outline, five report sections, final report, and handoff artifacts | Completion is enforced by projection invariants rather than prompt convention alone |
| Work survives context boundaries | Status projection and chunked artifact reads | Resume fails closed on corrupt state or integrity mismatch |
| Multiple agents coordinate through durable files | Research steps can record worker run ids and evidence | The initial slice records workers but does not introduce a new autonomous scheduler |

## Scope

This slice adds a bounded, inspectable research workspace. It provides:

- an append-only Deep Research event ledger;
- restart-safe projection of objective, scope, stage, round, artifacts,
  checklist, bounded research steps, report sections, checkpoints, and
  completion;
- app-owned Markdown artifacts for raw sources, evidence notes, outlines,
  report sections, the final report, and implementation handoff;
- chunked, integrity-checked artifact reads so a resumed model can recover
  evidence bodies by id without rereading the original source;
- visible Desktop progress for checklist state, inspected files/symbols/URLs,
  worker runs, blockers, artifact counts, and report draft state;
- direct source-artifact references for every derived artifact;
- root-session tools that are available only when the session has the
  `mode:deep_research` label;
- completion invariants that require settled checklist items, all required
  report sections, an archived source, a final report, and a structured
  handoff.

Search-provider selection, browser automation, ranking, automatic citation
formatting, and long-running scheduling remain separate concerns. The workspace
records local and web substeps but does not silently broaden their permissions.

## Authority and data flow

The research event ledger is the authority for workflow state and
relationships. The Artifact Store is the authority for large bodies. The
existing Task Ledger remains the authority for tasks; checkpoints only link to
task ids.

```text
Deep Research root session
        |
        +-- deep_research_* tools
                |
                +-- sessions/<session>/deep-research/events.jsonl
                |      objective, checklist, steps, sections, refs, completion
                |
                +-- artifacts/
                       raw sources, notes, outline, sections, report, handoff
```

Every mutation includes available run, turn, and tool-call references. The
event is projected and validated before it is appended. Corrupt JSONL fails
closed instead of returning a partial workspace.

## Lifecycle and state model

```text
not started
    |
    | research_started
    v
knowledge_base (active or blocked)
    |
    | archived sources + evidence + bounded steps + checkpoints
    v
report_writing (active or blocked)
    |
    | five completed sections + final report + handoff
    v
completed
```

Stages and checkpoint rounds are monotonic. A completed run is terminal:
subsequent mutations are rejected, except an exact replay of the original
tool call.

### Event types

| Event | Purpose | Important validation |
| --- | --- | --- |
| `research_started` | Establish objective and scope | Must be first and unique |
| `research_artifact_recorded` | Attach source or derived artifact metadata | Derived artifacts must cite archived source artifacts |
| `research_checklist_updated` | Persist required review progress | Evidence and blocker fields must match the status |
| `research_step_recorded` | Record bounded local or web work | Requires roots or keywords, stop condition, and evidence contract |
| `research_checkpoint_recorded` | Mark resumable progress | Round and stage cannot regress |
| `research_completed` | Seal report and implementation handoff | Requires sources, settled checklist, five sections, report, and handoff |

### Artifact roles

| Role | Meaning | Source-reference rule |
| --- | --- | --- |
| `source` | Archived raw source or inspectable primary material | No parent source required |
| `evidence_note` | Derived finding or comparison note | Must cite one or more `source` artifacts |
| `outline` | Planned report structure | Must cite one or more `source` artifacts |
| `report_section` | One required report section | Must cite sources and carry section key/status |
| `report` | Final user-facing research report | Must cite one or more `source` artifacts |
| `handoff` | Structured implementation input | Must cite one or more `source` artifacts |

## Tool protocol

The root Deep Research agent follows this sequence:

1. `deep_research_start`
2. `deep_research_save_artifact` with `role=source` for each important raw
   source and its inspectable locator
3. derived evidence artifacts with direct `source_artifact_ids`
4. `deep_research_record_step` after each bounded local or web substep,
   recording roots/queries, ignored paths, stopping condition, inspected refs,
   worker ids, evidence, and blockers
5. `deep_research_update_checklist` as each required area progresses
6. `deep_research_checkpoint` after meaningful rounds and before compaction
7. `deep_research_status` after interruption or restart, followed by
   `deep_research_read_artifact` for only the evidence bodies needed to resume
8. five source-backed report sections, each explicitly drafted or completed
9. final `role=report` and `role=handoff` artifacts
10. `deep_research_complete` with implementation tasks, recommended issues
    and/or pull requests, and verification commands

Mutation retries are idempotent by tool-call id. Exact replays return the
existing projection; reusing the same tool-call id with different start,
artifact, checklist, step, checkpoint, or completion input fails closed.
The id is unique across all Deep Research mutation tools, and artifact replay
comparison includes the exact name, summary, body hash, provenance, locator,
role, and report-section metadata. Replay lookup happens before terminal-state
rejection, so an exact retry remains safe after completion.
Save-artifact ids also derive from session, turn, and tool-call ids. If ledger
validation fails after an artifact body was created, the artifact is rolled
back.

## Resume and failure semantics

| Situation | Behavior |
| --- | --- |
| Process or model-context restart | Reproject the JSONL ledger, call `deep_research_status`, then read only required artifacts |
| Exact mutation retry | Return the existing projection without appending a duplicate event |
| Same tool-call id with different input | Reject the request as a semantic conflict |
| Invalid event or invariant regression | Validate before append and leave the ledger unchanged |
| Artifact created but event rejected | Roll back the newly created artifact |
| Corrupt JSONL | Fail closed; do not expose a partial run |
| Missing, deleted, or cross-session artifact | Reject the read |
| Artifact content hash mismatch | Reject the read as an integrity failure |
| Completion artifact missing, deleted, corrupt, cross-session, or wrong role/type | Reject completion before sealing the ledger |
| Interrupted or blocked research | Preserve checkpoint, blocker, inspected refs, and collected evidence for review/resume |

## Read-only implementation handoff

Completion does not change the research session's permission mode. The Desktop
surface states that the original session remains read-only and offers an
explicit **continue in a new task** action. That action:

1. creates a normal, unlabeled task;
2. builds a bounded prompt from the structured handoff and provenance ids;
3. fills the composer without sending it; and
4. asks the implementation task to inspect current code and present a plan
   before modifying project files.

The user therefore chooses the mode transition and still reviews the seeded
prompt before any model call or project write.

## Safety boundary

Deep Research still uses the `explore` permission profile. The new tools are a
narrow exception for writes into Maka-owned state only. They do not expose a
general filesystem path and cannot edit the user's project. Ordinary sessions
and child agents do not receive these tools.

Status and artifact text are secret-redacted and strip forged workspace and
artifact envelope tags before they are returned to the model. Artifact reads
verify session ownership, live state, source type, and the SHA-256 hash recorded
in the ledger. Completion repeats these checks for every archived source, the
current artifact for all five report sections, the final report, and the
handoff, including persisted Markdown type and Deep Research role. Generic
Artifact Pane deletion is disabled for ledger-owned artifacts so UI actions
cannot silently invalidate a completed workspace.

## Compatibility and operating limits

The initial run schema is version `1`. The ledger is append-only and has no
in-place migration path in this slice. A future schema change must either remain
backward-projectable or introduce an explicit migration with fixture coverage.

Limits are defensive bounds, not product targets:

| Limit | Value |
| --- | ---: |
| Artifacts per run | 2,000 |
| Research steps per run | 500 |
| Checkpoints per run | 500 |
| Checklist items per run | 50 |
| Inspected refs per step | 200 |
| Artifact body accepted by a tool | 512,000 characters |
| Artifact body returned in one read | 64,000 characters |
| Artifacts included in status output | Most recent 100 |

These bounds prevent an untrusted or looping model from turning projection or
status rendering into an unbounded operation. Large research bodies are read in
chunks and remain outside the event ledger.

## Non-goals and follow-up seams

The initial reproduction does not claim to provide:

- a new search provider, browser driver, citation-ranking algorithm, or
  automatic bibliography formatter;
- an autonomous scheduler for worker runs;
- clickable artifact/ref drill-down throughout the progress panel;
- ledger compaction, indexing, or schema migration;
- a report-quality benchmark equivalent to the paper's evaluation; or
- permission to modify the user's project from a Deep Research session.

Those capabilities should build on this contract in separate changes rather
than widening the initial persistence and permission boundary.

## Reviewer checklist

- [ ] Only root sessions labeled `mode:deep_research` receive the eight tools.
- [ ] Tool writes are limited to Maka-owned ledger and artifact state.
- [ ] Derived artifacts cannot be recorded without archived-source provenance.
- [ ] Exact retries are idempotent and conflicting retries fail closed.
- [ ] Stage/round regression, corrupt ledgers, and integrity mismatches are
      rejected.
- [ ] Completion cannot bypass checklist, section, report, source, or handoff
      requirements.
- [ ] Desktop progress comes from the durable projection rather than model-only
      text.
- [ ] Completing research does not mutate the original session's `explore`
      permission.
- [ ] The implementation handoff creates a normal task, fills but does not send
      its bounded prompt, and leaves the original run inspectable.

## Verification

The focused tests cover:

- happy-path two-stage projection and completion;
- rejection of evidence without archived source references;
- monotonic rounds and stages;
- checklist evidence and completion gates;
- bounded local/web steps with inspected refs, worker ids, and stopping
  conditions;
- required report-section and structured-handoff gates;
- restart recovery from append-only JSONL;
- idempotent checkpoint and completion retries;
- rejection of conflicting input under a replayed tool-call id;
- integrity-checked chunked artifact recovery;
- corrupt-ledger fail-closed behavior;
- runtime schema checks, retry idempotency, and safe status rendering;
- Desktop root-session label gating, live progress IPC/UI wiring, server-rendered
  progress component coverage, and explicit read-only-to-implementation handoff.

Run:

```sh
npm --workspace @maka/core test
npm --workspace @maka/storage test
npm --workspace @maka/runtime test
npm --workspace @maka/desktop test
```

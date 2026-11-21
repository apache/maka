---
name: event-description-generator
description: >
  Orchestrate event description audits by delegating chunk work to the event-descriptions-worker
  subagent. Resolve a project name to projectId via get_context when needed, then spawn worker
  subagents over cursors for a bounded run window and write outputs into run-scoped directories.
  Use when auditing missing event descriptions at scale without doing per-event analysis directly
  in this skill.
---

# Event Description Generator

Run this skill as an **orchestrator only**. Do not perform per-event filtering, repo search, or description-writing logic in this skill body. Delegate chunk processing to the `event-descriptions-worker` subagent.

## Workflow

1. Resolve project input (`projectId` or project name)
2. Create a run ID with short git SHA (`<projectId>-<sha>`)
3. Create run directories under `runs/`
4. Determine cursor plan (`cursorStart`, `maxEvents`, chunk size)
5. Spawn `event-descriptions-worker` subagents for cursor chunks
6. Collect worker summaries + output paths
7. Compress the run into a single CSV
8. Report concise progress and next cursor

## Execution Rules

- Keep this skill as a **dispatcher**; the worker does the heavy lifting.
- Do not call `set_event_metadata` from this skill.
- Do not manually re-implement worker filtering/search logic here.
- Preserve user control over scope (project, cursor range, chunk size, parallelism).

## Prerequisites

The user must provide either:

- `projectId`, or
- project name to resolve.

If neither is provided, stop and ask.

## Phase 1: Resolve Project

### 1.1 If `projectId` is provided

Use it directly.

### 1.2 If project name is provided

Call `get_context` and resolve the name to a single `projectId`.

- If exactly one clear match exists, continue with that ID.
- If multiple matches exist, ask the user to choose.
- Do not choose an ambiguous match on behalf of the user.

### 1.3 If project name is not provided

Prompt the user to input the project name or ID and halt.

## Phase 2: Build Cursor Plan

Default values unless the user specifies otherwise:

- `cursorStart`: `0`
- `maxEvents`: `400`
- `eventsPerWorker`: `50`
- `maxParallelWorkers`: `4`

For `maxEvents`:

- Compute total chunks as `ceil(maxEvents / eventsPerWorker)`.
- Process at most `maxEvents` events starting at `cursorStart`.
- For the final chunk, pass a reduced `eventsPerWorker` if needed to avoid exceeding `maxEvents`.

For each chunk:

- Worker input cursor = current cursor
- Next planned cursor = current cursor + `eventsPerWorker`

## Phase 3: Initialize Run Directory

Before launching workers:

1. Get the short git SHA by running `git rev-parse --short HEAD` in the workspace root.
2. Create `runId = <projectId>-<sha>`.
3. Ensure these directories exist:
   - `.agents/skills/event-description-generator/runs/`
   - `.agents/skills/event-description-generator/runs/<runId>/`

## Phase 4: Spawn Worker Subagents

For each planned cursor, invoke `event-descriptions-worker` with:

- `projectId` (resolved)
- `cursor`
- `runId`
- `eventsPerWorker` (optional per-worker chunk size; pass when not default)

Worker output file convention:

- `.agents/skills/event-description-generator/runs/<runId>/event-descriptions-<cursor>.csv`

### 4.1 Parallelization guidance

- If user asks for one cursor, run one worker.
- If user asks for multiple cursors/range, run workers in parallel up to `maxParallelWorkers`.
- For large ranges, run in waves (bounded concurrency), then continue until limit reached.

## Phase 5: Collect Worker Results

From each worker response, capture:

- events fetched
- events written
- output CSV path
- next cursor
- any errors

## Phase 6: Compress Run

After all workers have completed, run the compress script to merge all chunk CSVs into a single file, keeping only rows with a `suggested_description`:

```bash
python3 .agents/skills/event-description-generator/scripts/compress-run.py <runId>
```

Capture the script's stdout to include compression stats in the report. If the script fails, note the error but do not block the report.

## Phase 7: User-Facing Report

Return a short summary:

```text
Event description generator dispatch complete for project {projectId}
- Run ID: {runId}
- Workers run: {n}
- Total fetched: {sum_fetched}
- Total written: {sum_written}
- Compressed output: .agents/skills/event-description-generator/runs/{runId}/{runId}-{YYYY-MM-DD}.csv
  - Rows with descriptions: {compress_written}
  - Rows filtered (no description): {compress_filtered}
- Next cursor to continue: {max_next_cursor_or_last_next_cursor}
- Errors: {none_or_list}
```

If the user never specified writing the descriptions, ask if they would like to write the suggested descriptions to Amplitude.

## Phase 8: Write Descriptions to Amplitude

IMPORTANT: Only execute this phase when the user has explicitly asked to write descriptions.

Fixed constants (not configurable):

- `eventsPerWriter`: `100`
- `maxParallelWriters`: `4`

### 8.1 Locate the compressed CSV

Use the compressed output path reported in Phase 7:

```
.agents/skills/event-description-generator/runs/<runId>/<runId>-<YYYY-MM-DD>.csv
```

If the file does not exist (e.g. the user is resuming a previous run), ask the user to provide the path and halt.

### 8.2 Build writer plan

Run the writer-plan script to count data rows and compute chunks in one step:

```bash
python3 .agents/skills/event-description-generator/scripts/writer-plan.py <csvPath>
```

The script outputs JSON with all the information needed to spawn writers:

```json
{
  "csvPath": "...",
  "totalDataRows": 137,
  "eventsPerWriter": 50,
  "totalChunks": 3,
  "chunks": [
    { "index": 0, "lineStart": 1, "lineEnd": 50 },
    { "index": 1, "lineStart": 51, "lineEnd": 100 },
    { "index": 2, "lineStart": 101, "lineEnd": 137 }
  ]
}
```

Parse the JSON output and use the `chunks` array to drive step 8.4.

### 8.3 Spawn writer subagents

For each planned chunk, invoke `event-descriptions-writer` with:

- `projectId` (resolved in Phase 1)
- `csvPath`
- `lineStart`
- `lineEnd`

Run workers in parallel up to `maxParallelWriters`. For large files, process in waves (bounded concurrency) until all chunks are complete.

### 8.4 Collect writer results

From each worker response, capture:

- `written`: events successfully written
- `skippedRows`: rows filtered due to missing fields
- `success`: true/false
- `errors`: any tool errors

### 8.5 Write report

Return a concise summary:

```text
Description write complete for project {projectId}
- Source: {csvPath}
- Total data rows: {totalDataRows}
- Writers run: {totalChunks}
- Total written: {sum_written}
- Total skipped: {sum_skipped}
- Errors: {none_or_list}
```

## Common Invocation Patterns

### Single chunk

- Inputs: `projectId=123`, `cursor=500`
- Run ID generated once for this invocation
- Action: spawn one worker
- Output: one CSV + next cursor

### Multi-chunk wave

- Inputs: `projectId=123`, `cursorStart=0`, `maxEvents=100`, `eventsPerWorker=20`
- Planned cursors: `0, 20, 40, 60, 80`
- Action: spawn workers with bounded parallelism
- Output: five CSVs under one run directory, continuation cursor `100`

## References

- Audit worker definition: `.cursor/agents/event-descriptions-worker.md`
- Writer worker definition: `.cursor/agents/event-descriptions-writer.md`
- Compress script: `.agents/skills/event-description-generator/scripts/compress-run.py`
- Legacy search heuristics (if needed for worker evolution): [search-playbook.md](references/search-playbook.md)

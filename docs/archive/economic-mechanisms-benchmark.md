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

# Economic mechanisms benchmark — synthesis cache

Tracking issue: [#481](https://github.com/maka-agent/maka-agent/issues/481) ·
Slice: [#578](https://github.com/maka-agent/maka-agent/issues/578)

This is the first entry in the economic-mechanism benchmark log. It measures the
**synthesis cache** now that it is wired into the headless Harbor cell.

## What the mechanism does

When the context budget prunes and **archives** an old tool result, a later
replay that needs it back would normally **re-hydrate the full archived
payload**. The synthesis cache instead persists a compact *synthesis block*
(summary + coverage + source refs) the first time an archive is retrieved, and
on subsequent replays injects that block **in place of** the raw payload. The
saving is `hydrated_archive_tokens − synthesis_block_tokens`, paid back on every
replay that reuses the block.

The runtime has always implemented the mechanism (`AiSdkBackend` consumes
`loadSynthesisCache` / `writeSynthesisCache` + the `contextBudget.synthesisCache`
policy). Desktop wired it; headless did not. This slice adds the headless wiring
and the measurement below.

## Result — deterministic A/B

Because the effect is a deterministic function of the request projection, it is
measured against a **mock model** (no network, reproducible in CI) rather than a
live LLM. The same replay is projected twice; the prompt the model actually
receives is ground truth.

| Arm | Replay prompt (tokens) | Δ vs baseline |
| --- | ---: | ---: |
| **baseline** — re-hydrate archived tool result | 2818 | — |
| **arm** — inject synthesis block | 764 | **−2054 (−72.9%)** |

Scenario: a ~2.4 KB archived `Read` tool result is pruned, then recovered on the
next turn. Baseline hydrates the full body; the arm swaps in its synthesis block.
`charsPerToken = 1`, so prompt chars are the token estimate directly.

Reproduce:

```bash
npm run build --workspace @maka/runtime
node --test --test-name-pattern="synthesis cache cuts replay tokens" \
  packages/runtime/dist/__tests__/ai-sdk-backend.test.js
# → [synthesis-cache A/B] baseline=2818 arm=764 saved=2054 (72.9%)
```

The exact percentage scales with archived-payload size vs block size; the test
asserts a floor (`>40%`) so it stays a meaningful regression guard, not a brittle
golden number.

## Live activation evidence (Harbor)

A live autonomous run on `terminal-bench-sample` / `sqlite-with-gcov`
(`deepseek-v4-pro`, 2 attempts + prior-attempt context replay) confirms the
wiring is **active end-to-end** on the real path. From `task-run.json →
budget.contextBudget`:

```json
{
  "synthesisCacheEnabled": true,
  "synthesisCacheMode": "fallback_archive_retrieval",
  "archiveRetrievalMode": "eager",
  "synthesisCacheWriteSkipped": 1,
  "synthesisCacheWriteSkippedReasonCounts": { "source_missing": 1 },
  "retrievedArchiveToolResults": 0,
  "keptTurns": 1
}
```

The policy is live and the **write gate is reached and evaluated every step** —
it only records `source_missing` because no archived tool result was retrieved to
synthesize from.

## Why the live cost / pass-rate A/B is deferred

The write path needs archive retrieval to **retrieve a previously archived tool
result** (`retrievedArchiveToolResults > 0`). Archiving happens at the **turn**
level: stale-prune archives *older turns'* tool results. A Terminal-Bench task
run — even autonomous with replay — collapses into effectively **one turn**
(`keptTurns: 1`, thousands of events in a single turn), so there are no older
turns to archive, nothing to retrieve, and no synthesis source. This is a
structural mismatch between the mechanism's trigger (multi-turn history, as in
the interactive desktop app) and the benchmark's single-long-turn shape — not a
wiring defect.

A live cost/pass-rate/steps entry will be added once a multi-turn Harbor workload
that archives-then-retrieves across turns is available. The arm environment for
that run:

```bash
MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE=off \
MAKA_CONTEXT_STALE_TOOL_RESULT_PRUNE=on \
MAKA_CONTEXT_MAX_HISTORY_ESTIMATED_TOKENS=6000 \
MAKA_CONTEXT_ARCHIVE_RETRIEVAL=on MAKA_CONTEXT_ARCHIVE_RETRIEVAL_MODE=eager \
MAKA_CONTEXT_SYNTHESIS_CACHE=on MAKA_CONTEXT_SYNTHESIS_CACHE_MODE=read_write
```

These keys are on the `runtime-policy-ab-run` arm allowlist (derived from
`HARBOR_CELL_CONTEXT_ENV_KEYS`), so the arm is A/B-toggleable once the workload
exists.

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

# Discovery evaluation

Measures assistant discovery in both directions, not only repetition (#6360, #6247 item 6).

| Number | Meaning |
|---|---|
| misses | Findings the scenario marks as useful that were never told to the user |
| repeats | A topic told again with no new note, or told while the user's rule closes or defers it |
| latency | Time the runner took per round and in total |
| cost | Calls, input tokens and output tokens the runner reports |

Read them together. A runner that goes silent has zero repeats and loses every finding; a runner that repeats finds everything and pays for each repeat.

Files, all under `test/`:

- `discovery-eval.ts`: `evaluate(scenario, runner)`. It drives the real `Notebook`, so validation, topic state and delivery receipts behave as in production.
- `discovery-eval-scenarios.ts`: scenarios with the findings that are useful to tell.
- `discovery-eval.test.ts`: scripted runners (silent, repeating, sensible) showing the numbers separate the behaviours.

A `Runner` receives the notebook as the judgement model reads it and returns a judgement draft plus optional usage. The tests use scripted runners. **No live runner is included, so there is no baseline for current `main` yet.** A live runner would drive the persistent Sessions with a real model and read cost from the run-cost ledger (#6309).

Run: `npm run test:assistant` in `packages/runtime-host`.

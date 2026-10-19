---
name: maka-cli
description: Coordinate Maka CLI as a worker to submit tasks, inspect progress, update saved models, and handle Session questions or approvals.
---
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

# Maka CLI

Delegate work to Maka; the parent owns the assignment and final judgment.

## Submit, then wait

Check `maka run --help` for the installed interface. This skill does not upgrade Maka. Preserve the user's Host, model, cwd, and permissions; otherwise use existing defaults. Repeat the same `--host <profile-id>` on subsequent calls. Model, connection, and thinking options can also persistently update an existing Session.

Prefer this flow when coordinating work across calls:

```sh
maka run "Inspect the project and report findings" --no-wait
# Save the returned sessionId with its Host and assignment as $session.
maka run --session "$session" --wait --json
```

`--no-wait` already returns JSON. It is the recommended parent-agent workflow, not the CLI's global default: ordinary `maka run "…" --json` still waits and suits a single call. Detached work requires a persistent installation and cannot own CLI MCP servers or use Graph Mode.

Wait when ready for the next interaction or result; avoid repeated status polling. A Session-only wait selects its current Turn, or the latest result if idle. It does not drain the whole queue.

| `status` | Parent action |
| --- | --- |
| `running` | Keep the Session ID; execution is incomplete. |
| `needs_input` | Answer `questions` using the task context or the user's decision. |
| `needs_approval` | Assess `approvalRequests` and approve or deny. |
| `completed` | Read and assess `finalOutput` from wait/result. |
| `failed` | Read the wait/result error before retrying. |
| `idle` | No result is selected; do not infer success. |

## Inspect progress or add work

```sh
maka run --session "$session" --status
maka run --session "$session" --recap --json
maka run --session "$session" "Inspect the tests next" --no-wait
maka run --session "$session" "Focus on the parser" --steer --no-wait
```

Status returns lifecycle and pending interactions; `--status --recap` returns both state/boundary and progress as JSON. If installed help advertises `--recap`, use it to summarize recorded progress during execution. Each recap calls the model independently and can lag execution; it is neither final output nor a direct worker reply. Portable `session-export` is not a progress query.

An added prompt queues by default; `--queue` is optional. `submission` confirms admission, while `status` describes the observed Session, possibly an earlier Turn. Service current questions/approvals before expecting queued work to execute. Status and admission receipts already return JSON; use `--json` on waits/results/recaps to keep their output structured.

## Handle decisions and interruption

Read [Session control details](references/session-control.md) when answering a question, deciding a sandbox request, changing models or resuming, selecting one queued result, or handling `submission: "inbox"`. It covers request selection and uncertain outcomes.

`--session` controls inherit saved access, including bypass, without repeated `--yolo`. That flag explicitly grants full access; a read-only prompt does not restrict it. Ctrl+C on a Session observer leaves Host execution running; `maka run --session "$session" --stop` explicitly requests stop.

Exit 0 can mean admission or a pending interaction, not task completion. After interruption or an uncertain submission, inspect the Session before replaying work. Preserve provider/auth/quota errors and exit codes.

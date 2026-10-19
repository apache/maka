---
name: maka-cli
description: Delegate work to Maka through its CLI and manage sessions, waits, AskUser answers, queued prompts, steering, and safe continuation. Use when an agent needs to invoke maka run or coordinate Maka as a child agent.
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

Use Maka as a child agent while keeping the parent responsible for the task and final judgment.

## Check the installed interface

Read `maka run --help` before choosing a workflow. The installed CLI is the authority for available flags; if session controls are missing, use its supported blocking run or report the version gap. Do not assume installing this skill installs or upgrades Maka.

Use the user's chosen connection, model, Host, and working directory. Otherwise use existing defaults. Supply configuration such as `--connection`, `--model`, and `--cwd` when creating the Session; subsequent `--session` commands use its saved configuration. Do not change login, defaults, or provider to work around an error without authorization.

## Submit and observe

For a simple task, ordinary run waits by default:

```sh
maka run "Inspect the project and report your findings" --json
```

For work the parent will coordinate across CLI calls:

```sh
maka run "Inspect the project and report your findings" --no-wait --json
# Save the returned sessionId as $session.
maka run --session "$session" --status --json
maka run --session "$session" --wait --json
```

Keep the returned Session ID with its assignment. Admission with `status: running` is not task completion. Use blocking `--wait` rather than repeatedly polling status when the parent only needs an answer or final result.

A standalone wait selects the current Turn when it attaches; if idle, it reads the latest result. It does not wait for every queued Turn. Read the latest Turn result without waiting with:

```sh
maka run --session "$session" --result --json
```

Interpret the structured result:

| Status | Parent action |
| --- | --- |
| `running` | Execution is not complete; wait when ready. |
| `needs_input` | Read the questions and submit answers. This is a normal handoff, not failure. |
| `needs_approval` | Review the sandbox expansion and justification, then approve or deny. |
| `completed` | Read `finalOutput` and assess it against the assignment. |
| `failed` | Read the error and report or address its cause before retrying. |
| `idle` | No execution result is selected; do not infer that the assignment succeeded. |

## Answer AskUser

An ordinary built-in AskUser returns questions and options with `needs_input` and exit code 0. The Host keeps the original Turn waiting. Supply one string or `null` per question, in order:

```sh
maka run --session "$session" --answer '["Blue"]' --wait --json
```

Use the returned options and the parent's task context. If the decision belongs to the user and the parent lacks an answer, ask the user. An answer continues the original tool call and Turn; do not use `--resume` for it. If another question arrives, repeat the handoff. When answer submission fails or its outcome is uncertain, read current status/questions before deciding whether to submit again. If multiple pending batches prevent unique selection, report the ambiguity.

## Decide a sandbox request

For Host-owned Session execution, wait/status return `needs_approval` and `approvalRequests`
containing the requested expansion and justification. Decide from that scope and the parent's task
authorization. Choose one of these alternatives:

```sh
maka run --session "$session" --approve --wait --json
maka run --session "$session" --deny --wait --json
```

These answer only sandbox-boundary requests and continue the original Turn. They require exactly
one pending sandbox request in the Session; ambiguity is rejected. Neither needs `--yolo`, and
combining them with it is rejected. Approval expands the Host's saved managed boundary for subsequent Session execution rather than
switching the Session to bypass. Ordinary blocking run still denies sandbox expansions.

The command targets the single request pending when it attaches, which may differ from a request
seen by an earlier invocation. Never automatically retry an uncertain decision; read the current
request and choose again. Request IDs are tracked internally by the CLI.

## Add work or change direction

Queue is the default for an added prompt; each queued message gets its own later Turn. For
coordination, submit first, then service the Session's current interactions:

```sh
maka run --session "$session" "Inspect the tests next" --queue --no-wait --json
maka run --session "$session" --wait --json
```

Read `submission` as an admission receipt: `started`, `queued`, or `steering`. It is not completion.
The accompanying `status` refers to the currently observed Session; a queued receipt can include
questions from the Turn ahead of it. The queue count can be omitted until its projection catches
up; status reads a fresh view. Handle `needs_input`/`needs_approval`, then keep observing the
Session. `queued` counts follow-up plus steering messages, not an exact queue position. Status
reports the execution boundary and any Host-published `providerRetry`; absence of activity details
is not proof of a stalled task.

Use `--queue --wait` when you need that message's exact result and can separately service earlier
Turn interactions. It follows the submitted message and does not return a predecessor's AskUser;
waiting on it alone can leave a queue blocked on an unanswered question. A Session-only wait
selects the current Turn, and result reads the latest Turn, not every queued assignment.

Use steer to change ongoing work:

```sh
maka run --session "$session" "Focus on the parser" --steer --no-wait --json
```

Steer is delivered through the Host's current execution boundaries. It can miss the current Turn and carry over; admission does not prove consumption. Steer with `--wait` observes the Turn selected on attachment. A later `--result` means the latest Turn, not an arbitrary earlier assignment.

## Permissions, interruption, and recovery

Session controls (`--session`) inherit saved permissions. They do not need repeated `--yolo`
for prompts, queue/steer, answers, or safe resume. Use `--yolo` only to explicitly grant full access.
Inspect `executionBoundary` in status to distinguish managed read-only/writable from bypass.
Inheriting bypass is not an enforced read-only task, even if the prompt asks only for review.
The legacy blocking `--resume <id>` selector still requires `--yolo` for a bypass Session.

To stop Host execution explicitly, use the same Host selection and Session ID:

```sh
maka run --session "$session" --stop --json
```

This targets the current Turn observed on attachment and needs no `--yolo`. A successful stop
request exits 0; it does not mean the assignment succeeded. A successful status query also exits 0
when it reports task failure. Wait/result continue to reflect task failure through their exit code.
For permission requests, MCP forms, or other unsupported interactions, wait reports the actual kind
and leaves the Host waiting; use an interactive client or explicitly stop the Turn. Do not
repeatedly wait expecting the pending interaction to resolve itself.

Ctrl+C on Session observation ends the observer while Host execution continues. Legacy ordinary blocking run cancellation can stop execution. After interruption of the parent or CLI, query status; do not assume the task stopped or automatically restarted with the parent. For stopped execution, request safe continuation:

```sh
maka run --session "$session" --resume --wait --json
```

Add `--yolo` if the Session has full access. The Host can refuse unsafe continuation; report the reason instead of blindly submitting the original task again. Legacy `--resume <session-id>` selects a Session for a blocking run; it differs from `--session <id> --resume`.

Preserve provider/auth/quota errors and exit codes. A failed CLI call does not prove a submitted message was rejected; inspect the Session before retrying a potentially duplicate action. Do not interpret a nonzero observer exit alone as child-task failure.

Use a persistent Maka installation for detached work and Session execution controls. Temporary npx invocations can own the Host lifetime. CLI-owned MCP servers cannot detach with `--no-wait`, and MCP form continuation across CLI processes and Graph interaction handoff are unsupported. Keep those workloads on their supported blocking or interactive path rather than promising a cross-process answer/resume.

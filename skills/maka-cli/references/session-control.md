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

# Session control details

Read the section relevant to the current handoff or control action.

## Output and exit codes

Without `--json`, completed answers and recaps print text; receipts, status (including `--status --recap`), and pending interactions print JSON. `--json` also structures final answers and recaps. Errors are brief text on stderr by default. Explicit `--json` returns structured errors on stdout; operation errors preserve the original message and any Host `code`, without asserting a Turn status.

`finalOutput`/`error` describe a task outcome; status-only queries can omit them. `recap` summarizes recorded evidence and cannot see unreturned tool results or unrecorded work. `submission` (`started`, `queued`, `steering`, `inbox`) is admission only. `queued` counts follow-up plus steering messages, not position, and admission can omit it until the projection catches up. Status also reports `executionBoundary` and any Host-published `providerRetry`; silence alone does not prove a stall.

A denied approval returns the decision to the model; the same Turn can continue within existing permissions or explain its blocker. A failed tool or rejected expansion does not itself make the Turn fail. Wait returns at Turn completion or the next interaction; `--deny --no-wait` only submits the decision.

Successful status, stop, and recap calls exit 0 even when the observed task failed. Wait/result reflect task failure through their exit code. A failed observer alone does not establish worker failure; inspect status/result before retrying.

## Answer AskUser

Built-in AskUser returns `needs_input`, questions/options, and exit 0 while the original Turn waits. Supply one string or `null` per question, in order:

```sh
maka run --session "$session" --answer '["Blue",null]' --json
```

Answering continues the original tool call and Turn; do not use `--resume`. If another question arrives, repeat the handoff. Multiple pending batches can prevent unique selection; report that ambiguity. After a failed or uncertain answer submission, reread current questions before sending again.

## Decide a sandbox request

Inspect the expansion and justification in `approvalRequests`, then choose one alternative within the task's authorization:

```sh
maka run --session "$session" --approve --json
maka run --session "$session" --deny --json
```

Exactly one sandbox request must be pending. The command decides the request present on attachment, which can differ from an earlier observation. Never automatically retry an uncertain decision. Neither flag needs `--yolo`; combining them with it is rejected. Approval saves a managed-boundary expansion for subsequent Session execution; it does not switch to bypass. Ordinary blocking runs deny sandbox expansions, so use detached submission and Session controls when the parent must decide.

Permission requests, MCP forms, and other unsupported kinds remain waiting when reported. Use a supported interactive client or explicitly stop; repeated waits will not resolve them.

## Queue, steering, and Inbox

For coordination, submit a follow-up with `--no-wait`, then use Session-only wait/answer calls. Each queued message gets its own later Turn. Omit `--no-wait` and use `--json` only when following that message's exact result while separately servicing earlier Turns: that wait does not return an earlier Turn's AskUser and can leave the queue blocked.

Steering is delivered at Host execution boundaries and can carry over if it misses the current Turn. Admission does not prove consumption. Steer with `--wait` observes the Turn selected on attachment. `--result` reads the latest Turn, not an arbitrary previous assignment.

`submission: "inbox"` returns immediately even with `--wait`, without a worker result or queue count. Inspect delegated work through its own worker Session.

## Persist model settings, then choose an action

```sh
maka run --session "$session" --model "other-model"
maka run --session "$session" --model "other-model" --resume --json
maka run --session "$session" --model "other-model" "Continue the review" --no-wait
```

These are alternatives: only save settings; save then safely resume; or save then submit new user input. `--connection <slug>` changes the saved account; otherwise the existing account remains. `--thinking` can be updated too; native model/connection changes reset thinking to the model default unless explicitly supplied; selecting the same target preserves the saved level. Changes persist like Desktop model selection without changing global defaults or permissions. A settings-only call returns a JSON `configuration` receipt and leaves execution unchanged, even if `status` describes an earlier failed Turn.

Settings are saved before an explicit action and remain saved if that action fails. Choose a model from the user's instruction or existing authorization; CLI does not classify failures or select replacements. Busy or unsafe-continuation errors come from the Host. The CLI does not implicitly stop execution or replay the old prompt. A new prompt and safe resume are distinct operations.

## Recovery and compatibility

`--stop` targets the current Turn observed on attachment and needs no `--yolo`. Ctrl+C on a Session observer detaches; ordinary legacy blocking-run cancellation can stop execution. Query status after interruption. For stopped work:

```sh
maka run --session "$session" --resume --json
```

Saved permissions, including bypass, are inherited. If the Host refuses safe continuation, report the reason instead of resending the assignment.

Legacy `--resume <session-id>` is a blocking selector, distinct from `--session <id> --resume`. It permits workspace/timeout/Graph overrides and still requires `--yolo` for bypass. Prefer `--session` for ordinary controls and model changes.

Temporary npx invocations may own Host lifetime and cannot provide detached work or Session execution controls. CLI-owned MCP servers cannot detach; MCP form continuation across CLI processes and Graph interaction handoff are unsupported. Use their supported blocking or interactive paths.

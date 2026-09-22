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

# WorkHub fix acceptance — 2026-09-22

Base: `acab16537639cffd3cbd3b2652368f3679b1f245`. Acceptance used an isolated desktop profile, native Electron controls, and DeepSeek V4 Flash with default reasoning. Existing task history was retained across restarts. Runtime events and task-file snapshots were inspected independently of model replies.

## Delivered behavior

- Settled form and question interactions survive transcript replay. Expanding a choice displays the full question, options and selected answer; cancellation does not fabricate a selection.
- Multi-target conversation rails split equally by distinct Session. Each segment filters the corresponding work; task labels open the correct Session. Stop and failed-resume records retain target identity.
- Stopped assignments remain discoverable for control operations. Stop requests are scoped to their action so a later stop after resume does not replay an older stop.
- Delegation receipts distinguish admission from completion. Read-only `tasks status` queries an exact Session/Turn within current discovery and rejects stale Host or target identity. Execution completion does not verify artifacts.
- Stop/resume receipts omit absent execution evidence instead of passing undefined through the strict JSON boundary.

## Verification

- Earlier combined affected regression run: 429 passed across core, storage, Runtime Host, runtime read models, UI and Desktop. This was not the full repository suite.
- Latest Desktop WorkHub regression after the receipt correction: 119 passed, 0 failed. The new protocol-boundary regression reproduced `Invalid structuredContent` before the correction.
- Main/Host/UI/renderer builds, Desktop typecheck and renderer architecture checks passed during implementation. Final changed-file lint, formatting and diff checks passed.
- Native acceptance: two-target rails, filtering, Session navigation, failed-resume identity, expanded model questions, cancelled choices, keyboard collapse and restart replay.

## Latest real conversation samples

| Turn | Natural-language input | Observed result |
| --- | --- | --- |
| 17 | 给接口那份 plan-lite.md 补一句验收范围：只覆盖登录接口的正常请求、异常和限流。原计划别改，也别新建工作。 | One delegation to the existing API Session; admitted evidence, no claimed completion. Residual wording issue below. |
| 18 | 现在改好了吗？只查刚才那次的状态，别再派任务，也别改文件。 | Only status; exact Turn completed, artifacts unverified. |
| 19 | 只让登录接口重新在自己的目录用 bash 前台运行 observe.sh，别改脚本，别动登录页面。这次明确是重跑。 | Only API delegated, correct task directory. |
| 20 | 这次跑完没？看一下就行，别重发。 | Only status; running, no new delegation. |
| 21 | 那把这次接口的运行停了，页面别动，也不要重跑。 | Exposed the receipt serialization regression; actual cancellation confirmed by status. |
| 22 | 登录接口再重跑一次 observe.sh，仍然用原目录 bash 前台运行，其他的别动。 | New sample after the fix and restart, existing API Session. |
| 23 | 把刚才这次登录接口停掉，不要再运行。 | Normal stop_delivered receipt, followed by exact-Turn cancelled status. |
| 24 | 所以文件和测试都确认没问题了，对吧？只回答，不要执行任何动作。 | No tool calls; explicitly declined to claim artifact/test verification. |

Only the API plan-lite file and its observer heartbeat changed. Original plans, requirements, scripts and the UI task files remained unchanged. Both observer runs were stopped; files remained unchanged between the final stop and the final question.

## Remaining scope

- F04 is not closed: replies can still turn an instruction such as “do not change the original plan” into an unverified assertion that the file was not changed, or infer an older Turn's end from Session availability. Replies also remain too verbose and expose internal identifiers.
- Safe-boundary resume remains disabled by default. Successful resume has automated coverage; its native success UI was not exercised in this run.
- The latest eight turns are targeted acceptance, not a rerun of attachments, floating drafts, forced termination or every ambiguous multi-target case.

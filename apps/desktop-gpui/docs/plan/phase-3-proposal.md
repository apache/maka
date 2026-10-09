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

# Phase 3 proposal

Status: proposal for a decision, written 2026-09-26 after Phase 2 closed (HEAD 36c464f, 496
tests, acceptance run in `docs/acceptance/`). Nothing here is started.

## Where we are

The GPUI client covers the daily chat loop end to end on macOS: Host lifecycle, connections,
tasks and projects, streaming transcript with tools, reasoning, queue and attachments, settings,
three locales, command palette, packaging. Compared with the Electron Desktop it lacks the
long tail listed in `2026-09-25-gpui-client-plan.md` §6 tier (b) remainder and tier (c).

Two facts should drive what comes next:

1. **Protocol drift is the standing cost.** Every `apache/maka` release that bumps the
   compatibility epoch breaks this client until someone updates the types. Today that is a
   manual job guided by `just drift` and the fixtures. Whatever Phase 3 picks, the first
   package should make this cheap (below, P0).
2. **The client is only as useful as the Host features it exposes.** The Host already runs
   Agent Graph, WorkHub, scheduled tasks, skills and MCP; the client shows none of them. Each
   is a projection of existing protocol operations, not new backend work.

## P0. Sustainment (do first, small)

- Protocol update playbook: a script that diffs `packages/runtime-host/src/protocol` between
  the pinned epoch commit and `apache/maka@main`, lists changed decoders, and re-records the
  fixtures on a dev Host built from the new commit. Pin the maka commit in `Cargo.toml`
  metadata or a `MAKA_PIN` file so CI can check it out.
- Nightly CI job against `apache/maka@main`: build the Host, run the fixture capture and the
  protocol tests; failure means "epoch moved", not "client broke".
- Decide the home of the repository: stay separate, or propose it to `apache/maka` as
  `apps/desktop-gpui` once the maintainers want it. Staying separate keeps velocity; moving
  gets the drift problem solved by the people who cause it.

## Candidates, ranked by value to a daily user of Maka

| Rank | Package | What it is | Why this rank | Cost |
|---|---|---|---|---|
| 1 | Permission prompts for real | `sandbox_boundary`, `form`, `client_capability` interactions fully typed and rendered; live fixture recorded with a tool-capable cloud model | Without them `ask` mode is half usable; the UI exists but was never exercised against a real prompt | Small, needs a valid API key |
| 2 | Workbar: terminal + git review | PTY subscription frames (`SessionRuntimeResourcePtyDataFrame`) into a terminal view; git review diff from `git-review` operations | The two things a coding-agent user opens most after the chat | Medium; a terminal emulator crate (`alacritty_terminal`) is the big dependency |
| 3 | Skills and MCP pages | Settings sections listing skills (`skill.*`) and MCP servers (`plugin.*` / `mcp` ops), enable/disable, status | Users cannot see why a tool exists or is missing | Small to medium |
| 4 | Agent Graph panel | `AgentGraphChangedFrame` projection into a collapsible panel of child sessions with status | Maka's differentiator; today the client silently drops these frames | Medium |
| 5 | Scheduled tasks and daily review | `scheduled_task.*` list, create, run now; daily review as a read-only view | Automation users need it; others never open it | Medium |
| 6 | Remote Hosts | WebSocket transport with TLS, then SSH tunnel via the system `ssh` | Only matters for users with a remote Host; the transport is well specified | Medium |
| 7 | WorkHub | Coordination conversation and delegation to tasks | Big surface, own domain contract, only worth it after 4 | Large |
| 8 | Collaboration, bots, plugins, computer use, pets, browser | Long tail | Each has few users or needs Desktop-only native pieces | Large |

## Recommendation

Do P0, then 1, 2 and 3 as Phase 3 (about the size of Phase 2). Revisit 4 to 6 after a week
of real use tells us which frames and operations the user actually hits.

## What we need from you

- A working cloud API key on the dev Host for package 1 (the local 7B model never calls
  `request_sandbox_boundary`).
- A yes or no on proposing the repository to `apache/maka`, which changes P0's shape.
- Whether remote Hosts (package 6) matter for your daily use.

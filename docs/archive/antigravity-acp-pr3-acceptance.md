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

# Antigravity ACP PR 3 acceptance

PR 3 is tracked by [issue #5103](https://github.com/apache/maka/issues/5103).
The results below are from a new probe, separate from the successful PR 2
execution and earlier cross-process feasibility checks in
[the PR 2 record](antigravity-acp-pr2-acceptance.md).

## Real Agent prerequisite probe, 2026-09-24

- Official macOS arm64 `agy_acp_server.par` **1.1.1** with its matching
  `localharness_external`, ACP SDK **1.4.0**.
- The probe used a temporary toy project with a randomly generated synthetic
  token. An isolated temporary home copied only the existing OAuth token and
  ACP settings into mode-restricted files, but stalled before `session/new`
  completed. The method results below used the existing authenticated Agent
  home with the toy project. No credentials, Session IDs, token values, or
  project contents were recorded.
- `initialize` returned protocol version 1, `loadSession: true`, and
  `sessionCapabilities.resume`. `session/new` returned an external Session ID
  and confirmed `gemini-3.7-flash-high`.
- A fresh process accepted `session/resume` with the same ID and project
  directory and returned the same model. A second independent process also
  accepted `session/resume` for that ID. `session/load` accepted it and sent
  two `user_message_chunk` notifications and an
  `available_commands_update`. No successful Agent output existed to replay
  in this run.
- The first prompt and post-resume prompt each ended with `end_turn` but
  emitted an Agent execution error: the model request returned HTTP 403,
  reporting that the account was not eligible for Gemini Code Assist for
  individuals in the current location. The temporary profile with and without
  explicit HTTP(S) proxy variables stalled before Session creation. Direct access with
  the machine's SOCKS proxy configuration failed because the bundled Python
  lacked `python-socks`. Explicit local HTTP(S) proxy variables allowed
  Session creation but produced the same model 403.
- All probe-owned Agent process groups and temporary profiles were removed.

This initial probe **did not pass the PR 3 prerequisite gate**. It confirms
cross-process method acceptance, but cannot establish continued model context,
successful replay shape, duplicate or reordered replay behavior, or a crash
window where the Agent advanced beyond Maka's durable history. The 2026-09-12
PR 2 feasibility probe observed one successful output chunk and tool replay;
it did not send a post-resume prompt or establish reconciliation semantics.
The later route-change probe below supplied the missing successful turns.

## Post-login recheck, 2026-09-24

After the user completed login in a locally built Maka, the official 1.1.1
Agent was probed again with the authenticated home and a new temporary toy
project. It negotiated the same resume/load capabilities, created a Session,
and confirmed `gemini-3.7-flash-high`. After a synthetic-token prompt, a fresh
process resumed the same Session ID and accepted a follow-up asking for that
token. Both prompts emitted the same location-eligibility HTTP 403 Agent error,
so the follow-up did not recall the token. A third process loaded the Session;
it replayed two user-message chunks and an available-commands update, with no
successful assistant or tool output to reconcile. The configured local HTTP(S)
proxy's observed egress region was Singapore. All probe processes and the toy
project were removed. Successful login therefore has not cleared the real-model
prerequisite gate.

## Route-change verification, 2026-09-24

After the user changed the proxy exit, a new probe used the same official
macOS arm64 1.1.1 server and matching helper, the user's authenticated Agent
home, and a temporary toy project. Synthetic random values were used only to
test context; no token values, credentials, external Session IDs, or private
project content are recorded here. Intermittent HTTP 403 responses still
occurred between successful requests, so the probe retried affected tool turns.

- `initialize` again negotiated protocol 1, `loadSession: true`, and
  `sessionCapabilities.resume`. `session/new` returned a Session ID and
  `gemini-3.7-flash-high`.
- A successful prompt gave the Agent one synthetic token. A new process used
  `session/resume` with that same ID and project path, returned the same model,
  and a follow-up answer recalled the exact token. The Session was not
  replaced and the prompt was not resent.
- A successful tool turn read a second synthetic token from a toy file. The
  file was removed, then a new process used `session/load` and replayed user,
  Agent, and tool updates. A follow-up recalled the file-only token after the
  file was gone, proving that tool context survived the process change.
- Two independent `session/load` calls produced the same update counts and
  replay tool IDs for the completed history. A failed tool turn showed that
  live tool IDs can differ from replayed IDs. Repeated identical user prompts
  appeared as distinct replayed user chunks. Thus neither prompt text nor
  live tool ID alone is a safe general deduplication key.
- The probe terminated all child process groups and removed its toy project.

These observations support `session/resume` for a fully committed Maka turn.
For an interrupted turn, Maka captures `session/load` replay separately and
reports a history gap. It does not append unaligned replay to the canonical
conversation or submit another prompt. This is a conservative reconciliation
decision because the official replay did not provide stable canonical event
identities across every observed turn. The user can read the saved history and
start a new task; the external Session ID is never silently replaced.

## Built Plugin smoke, 2026-09-24

The built production ACP Runtime and Antigravity adapter bundles were loaded
with the official 1.1.1 executable/helper and the authenticated Agent home.
A temporary toy task completed a synthetic-token prompt. The Runtime
acknowledged that turn, disposed its process, and a fresh `AcpExecutor`
instance reported `restorable` from the saved Plugin-private record. The
explicit restore changed readiness to `ready`; a follow-up prompt completed
and recalled the synthetic token. The test removed the toy project and did
not print the token or external Session ID. This exercises the shipped
Plugin code path in addition to the direct protocol probe. It does not stand
in for a full Desktop UI restart test.

## Implementation checks

On the branch tested at `bd8661f3a` and rebased without conflicts to
`b62ca805e` before opening the draft PR:

- `npm run build`, `npm run typecheck`, `npm run lint`, and
  `npm run format:check` passed.
- Renderer architecture, locale hygiene, and the protocol compatibility epoch
  guard passed; the epoch advanced from 183 to 184 for the new readiness values.
- Every workspace test suite passed in a final serial run using
  `node scripts/run-workspace-tests-parallel.mjs --concurrency=1`. Controlled
  ACP tests include a forcibly killed, durably acknowledged child process
  restored under the same external Session in a fresh process; uncertain load
  replay remains outside the canonical turn.
- An earlier serial run had one intermittent Runtime Host Goal handoff timing
  assertion. The full Host workspace passed independently, that exact test
  passed in isolation, and the final serial run passed. The failing test does
  not touch ACP restoration.

A full Desktop UI restart with a signed-in real Agent was not executed. The
production Plugin bundle smoke, Desktop picker/controller tests, and the real
Agent protocol probes cover the corresponding layers separately.

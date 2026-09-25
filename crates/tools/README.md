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

# maka-tools

[中文](README.zh-CN.md)

Journaled tool dispatch and Code Mode, inspired by [OpenAI Codex](https://github.com/openai/codex).
Catalogs, permissions and execution facts remain authoritative outside JavaScript.

## Code Mode

Configure Code Mode and `apply_patch` in each connection's model parameters.
Auto follows the Host's model defaults; explicit choices apply to new Runs.
Resume and handoff retain the admitted choices. Enabling `apply_patch` replaces
`Edit` and `Write`; disabling it exposes those structured editing tools instead.

OpenAI Responses exposes `exec` as a freeform tool accepting raw JavaScript.
Chat, Anthropic and plaintext OpenResponses wrap the same source in
`{code, yield_time_ms?, max_output_tokens?}`. An optional first line sets options:
`// @exec: {"yield_time_ms": 30000, "max_output_tokens": 10000}`.
Specify each option once, either in the pragma or the JSON wrapper.

Source is an async ES module: top-level `await` works; top-level `return` and
imports do not. Emit output with helpers. Each cell has a fresh V8 isolate without
Node, filesystem, network, console or shared-memory globals. The standalone
`maka code` command and Rust function-body embedding API keep their existing
return-value contract; they are not the model-facing exec tool.

`wait({cell_id, yield_time_ms?, max_tokens?, terminate?})` observes a running cell.
Exec defaults to 30000 ms, wait to 10000 ms; both default to 10000 output tokens.
The old wait spelling `max_output_tokens` is accepted but no longer advertised.
Results distinguish `running`, `completed` and `terminated`; observations contain
only new output. Termination requests cancellation, not instant cleanup.

Helpers: `text`, `image`, `audio`, `generatedImage`, `notify`, `yield_control`,
`store`, `load`, `setTimeout`, `clearTimeout`, `exit`, and `ALL_TOOLS`.
Images accept Host image references, MCP image blocks or base64 data URLs.
The second `image` argument overrides embedded `detail` or `codex/imageDetail`
metadata (auto/low/high/original), preserved through evidence and model projection.
Audio is retained as protected session evidence and sent as native input:
Responses uses `input_audio.audio_url`; Chat carries WAV/MP3 in a user content
block after the complete tool-result batch. Unsupported adapters/formats receive
an explicit notice, with bytes still retained. PCM WAV clips shorter than 25 ms
produce the same omission notice as Codex.

`notify` independently appends output associated with the original exec call;
it does not yield, finish the cell, or require wait. Notifications arriving during
inference enter the next model step; an unobserved notification triggers a follow-up
even if that response contained no tool calls. Native Responses uses additional
custom-tool outputs, including in WebSocket deltas. JSON-only protocols receive
labelled observations. Notification facts never settle tool effects; commit
failure cancels and drains the cell. Closing the Run fences late notifications.
No helper grants filesystem, network or client authority.

A Run owns up to four uncollected cells. Tools execute with the cell's captured
catalog, including normal preflight and journaling. The entire authorized nestable
catalog is callable: deferred tools are omitted only from expanded prompt text.
`ALL_TOOLS` includes their metadata and TypeScript declarations for discovery and
use within the same cell. Names normalize to JavaScript identifiers; collisions
reject the cell before effects. DirectOnly tools stay outside `tools`. Declarations
use input and optional output schemas; descriptions are not validators. Direct
mode keeps search/next-step activation.

Each cell has a 64 KiB source limit, 64 MiB V8 heap guard, 30-second synchronous
execution budget, 32 tool-call budget and eight concurrent tool slots.
Excess concurrent calls queue within the call budget. Async Host waits do not
consume the synchronous budget. Output and JSON scratch values are bounded;
V8 heap limits are not process isolation.
Clearing a timer cancels its sleep and releases its slot. Module completion cancels
unawaited work, then drains admitted effects; cancellation cannot undo past effects.

Scratch data belongs to the live session, not durable or an authorization store. A cell reads
a snapshot and publishes its writes after settlement; later completions win
for the same key. Turns, compaction and same-Host handoff preserve JSON scratch data;
session retirement and Host restart clear it. JS globals and permissions are never stored.

Compatibility baseline: official `openai/codex` commit
`4b1c0c30dabd08fed7d6523844f9156d982eb297`; implementation is independent.

## Ownership

The provider's `exec` is a control operation. Its independently journaled
`CodeCell` owns nested `CodeMode` operations. The control call can settle while
the cell runs; the cell cannot settle before its admitted children.

Call `RunTools::shutdown` before closing the Run or log. It cancels cells,
drains accepted work, and propagates persistence or cleanup uncertainty.
Dropping `RunTools` requests cancellation but cannot await cleanup.
Handoff seals only an idle cell execution boundary. Recovery never replays
an interrupted cell or silently repeats its effects.

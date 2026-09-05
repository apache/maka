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

# Computer Use Model-Loop Foundation

## Product Boundary

The primary model path is the provider-neutral `maka_computer` function tool
through `AiSdkBackend`. The model observes an Accessibility tree, then uses
`click_element`, `set_value`, or another semantic action with IDs from that
observation.

This matches the recovered Codex layering:

```text
model function/tool call
  -> Computer Use facade
  -> observed AX element identity
  -> stale-element refetch and uniqueness checks
  -> element executor
  -> AXPick / AXPress / AXValue when supported
  -> synthetic event fallback only inside the native executor
```

Codex does not currently expose a top-level native `computer` tool in the
captured production request. Its deferred Computer Use wrapper exposes the AX
facade. Accessibility-first dispatch happens inside element execution, not by
implicitly turning every model coordinate into an AX element.

## Current Safety Policy

Maka keeps the same separation:

- `maka_computer` is the primary model-facing path;
- semantic element actions and verified AX/CDP value updates are retained;
- coordinate click, scroll, drag, key input, and pixel fallback are described
  as disabled and fail closed;
- provider adapters use the same `maka_computer` contract rather than a
  separate native Computer Use loop.

No provider adapter may infer a missing observation ID or silently bind an
action to the current frame.

## Real Provider Results

The local Azure Responses bridge at `127.0.0.1:8538` and coproxy Anthropic
endpoint at `127.0.0.1:8537` were used without persisting credentials or raw
provider responses.

### OpenAI Responses

`gpt-5.6-sol` completed the product path:

```text
list_apps -> observe -> set_value -> verified finish
```

The full product path passed:

```text
getAIModel
  -> OpenAI Responses model
  -> AiSdkBackend / streamText
  -> ToolRuntime
  -> maka_computer
  -> synthetic AX semantic backend
```

The product path persisted tool calls and results, emitted permission-safe
telemetry, and reached the verified final value.

### Anthropic

`claude-sonnet-4-6` completed the same semantic task through coproxy.

One run omitted `observation_id` from `set_value`. The harness returned a
typed tool error requiring another observation; the model recovered instead
of the executor guessing a frame. This behavior is a required regression
scenario for future provider adapters.

### Kimi and MiniMax

No live Kimi or MiniMax credential is configured on this machine. Their
product paths are covered as hermetic protocol evidence, not real-provider
evidence.

Both `kimi-coding-plan` and `minimax-coding-plan` complete the same multi-step
semantic loop through their exact Anthropic-compatible URL/auth contracts:

```text
getAIModel -> streaming tool_use -> AiSdkBackend -> ToolRuntime
  -> maka_computer -> list_apps -> observe -> set_value -> final response
```

## Provider Schema Findings

OpenAI strict function schemas require every property to be listed in
`required`. Optional fields must be represented as nullable. Because one
function schema serves several action variants, the model can populate known
fields that are irrelevant to the selected action.

The OpenAI adapter therefore:

1. emits all properties as required and nullable;
2. rejects unknown keys and accessor properties;
3. projects only the known keys allowed for the selected action;
4. records discarded non-null keys;
5. passes the projected value to the existing strict action parser.

The core `maka_computer` parser remains strict and provider neutral.

## Non-Claims

This foundation does not:

- reconnect a compatibility CGEvent path;
- add the real AppKit AX provider runner (that is the next evidence-layer PR);
- resolve PID reuse, stale driver nodes, or executor lifecycle hardening;
- replace the executor-hardening and stacked-PR restack work.

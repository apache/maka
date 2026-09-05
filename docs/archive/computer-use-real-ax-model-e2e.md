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

# Real Model To AppKit AX E2E

## Scope

This harness connects a live provider model to the production Maka model and
tool path, the pinned `cua-driver`, and the owned `Codex CUA Lab.app`.

```text
live provider
  -> getAIModel
  -> AiSdkBackend / streamText
  -> ToolRuntime
  -> maka_computer
  -> cua-driver
  -> AppKit Accessibility element action
```

The fixture launches in the background and never uses explicit activation.
The launcher owns `caffeinate`, lock/frontmost monitoring, temporary files,
fixture shutdown, and child termination.

The action policy allows only scenario-specific subsets of:

```text
list_apps
observe
click_element
set_value
wait
```

Coordinate click, scroll, drag, type, key input, and compatibility pixel
fallback are not available. A read-only HID age probe fences native semantic
dispatch while the user is actively providing physical input.

## Real Results

### OpenAI through Azure bridge

`gpt-5.6-sol` completed:

- observe-only: two tools, zero dispatch;
- AX set value: one verified AX dispatch, zero pixel dispatch;
- physical intervention recovery: first mutation returned
  `reobserve_required`, then the model observed and succeeded;
- process restart recovery: the old semantic action returned
  `target_missing`, then the model rediscovered the new process and succeeded;
- AX click: one `click_element` dispatch and the external AppKit button oracle
  changed exactly once.
- safe multi-step task: `set_value` followed by `click_element`, each using the
  fresh observation from the prior step; one dispatch per semantic action and
  zero pixel dispatch.

### Anthropic through coproxy

`claude-sonnet-4-6` completed:

- AX set value through the full `AiSdkBackend` product path;
- physical intervention recovery with the same re-observe sequence;
- one verified AX dispatch and zero pixel dispatch in both mutation runs.
- the same safe multi-step `set_value` then `click_element` task through the
  full product loop.

### Kimi and MiniMax protocol paths

No live Kimi or MiniMax credential is configured on this machine. Their
product paths were therefore validated as `hermetic-protocol`, not
`real-runtime`.

Both `kimi-coding-plan` and `minimax-coding-plan` completed:

```text
getAIModel
  -> Anthropic-compatible streaming protocol
  -> AiSdkBackend
  -> ToolRuntime
  -> maka_computer
  -> list_apps -> observe -> set_value -> final response
```

The server fixtures verify each provider's exact URL prefix, API-key header,
model ID, streaming `tool_use`, tool-result reinjection, and final semantic
state. They also verify that a failed semantic action is reinjected as
`tool_result.is_error:true`; Runtime records the failed result once, while the
AI SDK adapter exposes it to the provider as a recoverable tool execution
error.

## Dynamic Structure Finding

The model observed one stale target. An independent AX setup action inserted a
second target with the same semantic identity before the model action.

The real executor returned `target_changed`, with zero model dispatch and zero
target mutation. The content fingerprint gate currently runs before strict
element identity refetch. This is safe, but stricter than the recovered Codex
behavior where semantic element actions may continue to a unique/missing/
ambiguous refetch decision after an AX structure change.

The finding is reported on executor hardening PR #910. The model-runner treats
either strict refetch rejection or conservative `target_changed` as a
fail-closed result and records the exact result code.

## Runtime Finding

Real model runs exposed that returned Computer Use results with a top-level
`error` were being recorded as successful tool invocations. A model could also
retry the same ambiguity-rejected semantic target after a new observation
because the generic loop signature included the changing observation ID.

The independent Runtime fix:

- classifies returned top-level errors consistently for persisted results,
  events, telemetry, and loop control;
- gives explicit ambiguity failures a stable semantic signature that ignores
  observation ID;
- blocks the next identical ambiguity retry before native execution;
- does not cache recoverable `user_intervened` or `target_missing` outcomes.

The real evidence sanitizer also previously hard-coded an OpenAI producer.
Reports now preserve an explicit producer and provider while retaining the
same privacy projection.

## Evidence Finding

The Desktop runner previously inferred fixture windows from action output, so
an incorrect action window could add itself to the ownership allowlist. The
launcher now discovers the exact fixture PID/window set independently before
the model runs, binds actions by tool-call dispatch traces or observation
lineage, and waits for trace flush before qualification.

## Evidence Privacy

Reports are launcher-owned temporary files with mode `0600`. The sanitized
projection retains provider/model, action types, result codes, aggregate
state, and allowlisted trace fields. It drops coordinates, typed values, AX/UI
text, credentials, URLs beyond origin, and raw provider payloads.

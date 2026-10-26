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

# Deferred Goal wait integrations

[中文版](./goal-wait-deferred-integrations-2026-10-24.zh-CN.md)

Date: 2026-10-24. This records two prototypes removed from `codex/goal-host-observation` after `5d046a81`. It explains their purpose and conditional necessity, not a commitment to deliver them. The current contract is [Goal event wait consumers](../goal-event-wait-consumers.md).

## Scope decision

The current change keeps ordinary in-turn `WaitForEvent`, direct AI SDK and Code Mode execution, natural Goal waiting, and the existing ShellRun source. Computer observation and the ACP Host tool bridge are separate extensions. Their implementations, dedicated protocol fields, persistence branches and tests are removed together; existing computer tools and ACP execution remain available with their main-branch behavior.

| Integration | Role | Independent of |
| --- | --- | --- |
| Computer text observation | Source adapter for text appearing or disappearing in an observed application window | ShellRun, GitHub CI, PR/review and file-readiness sources |
| ACP Host tool bridge | Execution channel through which an external Agent invokes Maka-owned tools | Which source a `WaitForEvent` call observes |

## Computer text observation

Existing `maka_computer` waits accept `wait_for_text` or `wait_for_text_gone`: for example, wait until “Upload complete” appears or “Loading” disappears. They inspect accessible control labels and values in the previously observed window, with the original timeout and public result format.

The removed prototype registered a `computer_use` source with present/absent conditions. Host scheduling requested native window snapshots through the existing Desktop capability connection. Dedicated request, probe, probe-cancel, snapshot and result frames transported these operations. Trusted dispatch bindings identified the original Session, Turn and window; a result sidecar linked observation consumption to the original durable tool result.

The prototype still polled snapshots. Its adapter requested a 250 ms interval, but the actual frequency was constrained by Host minimum intervals, capacity and backoff. Its benefit was shared Host scheduling, cancellation and resource accounting; it did not implement operating-system push notifications or prove elimination of native polling.

This integration becomes necessary if the accepted scope requires existing computer waits to use Host observation as well. It is not required to keep an explicit ShellRun `WaitForEvent` inside its original Turn. Removing it leaves the existing computer wait loop in place.

Any separate implementation needs to preserve window identity and re-observation rules, appearance/disappearance and missing-window behavior, the original deadline and final accepted native read, cancellation, native permissions, and disconnect cleanup. Host and client clocks must not be treated as interchangeable. A reliable result must remain attributable to its original tool operation without replaying desktop actions. Genuine native event subscriptions would require separate design and evidence.

## ACP Host tool bridge

Maka's built-in AI SDK backend owns its model tool catalog directly. ACP executors delegate work to an external Agent, which does not automatically receive Maka's internal tools. The removed bridge exposed an MCP tool catalog to that Agent and forwarded calls to the existing Runtime tool boundary.

The prototype used a stdio MCP relay backed by a local HTTP service on `127.0.0.1` that lived with the retained ACP Session; each call was bound to the active invocation. It handled tool listing, directory changes, calls, cancellation and results. Its production catalog exposed only `WaitForEvent`; the transport itself was generic. A caller could thereby wait for an existing source such as ShellRun. ACP was not an additional source of external events.

This bridge becomes necessary if external ACP Agents must call Maka-owned `WaitForEvent`. It is not required for the built-in AI SDK backend's direct tools or Code Mode. Removing it preserves existing ACP sessions, tools and execution, but does not expose Host event waits to ACP Agents.

A separate implementation needs to preserve the original Run/invocation and durable dispatch/result boundary, drain abandoned calls, fence late callbacks and retained ACP sessions, clean up transport resources, and deliver current-turn input through existing durable ownership. Tool capability negotiation must preserve executors that do not implement Host tools, including ordinary non-Goal Runs with an empty catalog. The removed prototype incorrectly rejected such executors when a dynamic empty catalog was present; that behavior is not an acceptable prerequisite for this feature.

## Retained and deferred boundaries

No registration stub, inactive feature flag, computer-specific dispatch binding/result sidecar, or ACP-only capability subscription is retained for these prototypes. Ordinary `WaitForEvent` results and their durable consumption remain because they have current consumers.

Natural Goal waiting is a consumer of registered sources. Child Run completion and current-turn steering use internal notifications. Code Mode is an execution entry point. None of these constitutes another external source. The default production registry now contains ShellRun only; GitHub CI, PR/review and file readiness remain outside this change.

Future proposals should specify either a new observable condition or a new supported executor, then carry their own authorization, lifecycle and integration tests. Broad coverage of every Goal wait is a later scope decision, not a claim made by this reduced change.

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

# Runtime v2 Architecture Evolution

> Archived on 2026-07-13. This proposal records the route to the current runtime; it is not current architecture authority. Start with `ARCHITECTURE.md`.

This document proposes a long-term evolution path for Maka's agent runtime. It
is written for developers who need to understand why the runtime needs another
architecture pass, what should stay stable, and how the codebase can move there
without a big-bang rewrite.

The goal is not to replace the Vercel AI SDK. The goal is to make Maka own its
runtime semantics while continuing to use the AI SDK as the main model/tool
stepping engine.

## Executive Summary

Maka already has a working local coding agent runtime:

- Electron desktop entry points
- session JSONL storage
- model streaming through the AI SDK
- tool execution and permission prompts
- abort handling
- bot and OpenGateway entry points
- tool artifacts and usage telemetry
- an internal `AgentRun` ledger

The current architecture is better than the original monolithic path, but the
runtime still lacks one stable center of gravity. The same run is currently
represented through several related but separate structures:

- `StoredMessage` in the session JSONL
- renderer-facing `SessionEvent`
- `AgentRunEvent` in the run ledger
- best-effort `RunTraceEvent`
- telemetry records

That split makes the system hard to evolve. It also makes important questions
harder than they should be:

- Which facts are the real runtime truth?
- Which objects are only UI projections?
- Which events should be replayed into the next model request?
- Which events are diagnostic-only?
- Where should permission, tool, recovery, and telemetry semantics live?

Runtime v2 should introduce a canonical invocation/event spine:

```text
RuntimeRunner
  -> InvocationContext
  -> AgentFlow
      -> AiSdkFlow
          -> AI SDK streamText
          -> ToolRuntime
  -> RuntimeEvent ledger
  -> projections
```

The key shift is:

```text
Today:
  SessionManager + StoredMessage/SessionEvent are close to the runtime center.

Target:
  Invocation + RuntimeEvent + AgentFlow are the runtime center.
  StoredMessage, renderer SessionEvent, AgentRunStore, RunTrace, and telemetry
  become projections or ledgers derived from canonical runtime facts.
```

## Design Inputs

This proposal is based on the current Maka implementation and on the runtime
structure documented in the Google ADK Go reading materials. The useful lesson
from ADK is not to copy type names directly. The useful lesson is the layering:

```text
Runner -> Agent -> Flow -> Model/Tool -> Event -> Session
```

In that model:

- `Runner` owns the invocation shell and persistence boundary.
- `Agent` owns lifecycle and routing.
- `Flow` owns the model/tool loop.
- `Event` is the shared runtime fact language.
- `Session` stores durable history and scoped state.
- tool, callback, plugin, instruction, workflow, entrypoint, and telemetry
  layers attach around that axis without becoming the axis themselves.

Maka has different product constraints, so the evolution should be adapted:

- keep the AI SDK as the long-term main flow implementation;
- preserve Electron and existing user-visible session behavior;
- preserve existing JSONL compatibility;
- reuse `ToolRuntime`, `AgentRunStore`, and `RunTrace`;
- avoid a flag day where all storage and UI projections change at once.

## Current Runtime Path

Today, one user turn approximately flows like this:

```text
renderer / bot / gateway
  -> desktop main / entrypoint code
     -> ensureSessionCanSend(...)
     -> SessionManager.sendMessage(sessionId, input)
        -> new AgentRun(...)
        -> AgentRun.execute()
           -> append user StoredMessage
           -> append turn_state=running
           -> lock connection snapshot
           -> ensureActive() / build AiSdkBackend
           -> register active run
           -> AiSdkBackend.send()
              -> PermissionEngine.beginTurn()
              -> RunTrace
              -> ModelAdapter.resolveModel()
              -> build AI SDK tool map
              -> materialize prior StoredMessage[] into AI SDK messages
              -> AI SDK streamText({ tools, stopWhen: stepCountIs(maxSteps) })
                 -> AI SDK owns model -> tool -> model stepping
                 -> tool.execute(...) calls ToolRuntime
              -> pump fullStream into SessionEvent queue
              -> append assistant StoredMessage
              -> append token_usage StoredMessage
              -> queue complete/error/abort
           -> AgentRun updates SessionHeader / turn_state / AgentRunStore
           -> cleanup active run
```

This split has some good properties:

- `SessionManager.sendMessage()` no longer owns the whole hot path.
- `AgentRun` gives a durable run lifecycle record.
- `ToolRuntime` is a real boundary for tool permission, execution, artifacts,
  and tool telemetry.
- `ModelAdapter` isolates provider/AI SDK stream and error normalization.

But it also has structural limits:

- Maka does not have its own explicit `Flow.Run`; the model/tool loop is
  implicit inside `AiSdkBackend.send()` plus the AI SDK.
- Cross-turn model history is built from selected `StoredMessage` types, not
  from a canonical runtime event history.
- tool calls and tool results are persisted for UI/history, but their role in
  future model context is an implicit policy inside `materializePriorMessages()`.
- permission and tool events are represented across `StoredMessage`,
  `SessionEvent`, `RunTraceEvent`, and telemetry rather than one canonical fact.
- entrypoints still own some runtime readiness semantics, such as connection
  readiness/rebind checks.

## Target Architecture

The target architecture keeps the AI SDK as the primary model/tool stepping
engine, but wraps it in Maka-owned invocation and event semantics.

```text
┌────────────────────────────────────────────────────────────────────┐
│                        Entrypoint Adapters                         │
│                                                                    │
│  Desktop IPC             Bot Gateway             OpenGateway       │
│  - parse input           - parse input           - parse HTTP      │
│  - validate shape        - auth/rate limit       - SSE/JSON        │
│  - broadcast output      - send bot reply        - gateway output  │
│                                                                    │
│  Entrypoints are protocol adapters. They do not own runtime loop,   │
│  readiness, recovery, or model/tool policy.                         │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ RuntimeRequest
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                          RuntimeRunner                            │
│                                                                    │
│  - RuntimeGate preflight                                           │
│  - create invocation/run context                                   │
│  - append user RuntimeEvent                                        │
│  - resolve active agent/flow policy                                │
│  - run AgentFlow                                                   │
│  - persist canonical events                                        │
│  - drive projections                                               │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ InvocationContext
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                         AgentFlow Interface                        │
│                                                                    │
│  interface AgentFlow {                                             │
│    run(ctx, input): AsyncIterable<RuntimeEvent>                    │
│  }                                                                 │
│                                                                    │
│  AiSdkFlow is the default long-term implementation:                 │
│                                                                    │
│    - build AI SDK messages from runtime history projection          │
│    - build AI SDK tool map                                          │
│    - call streamText({ tools, stopWhen: stepCountIs(...) })         │
│    - map text/thinking/tool/usage/finish/error to RuntimeEvent      │
│    - delegate tool execution to ToolRuntime                         │
└──────────────────────────────┬─────────────────────────────────────┘
                               │ tool.execute seam
                               ▼
┌────────────────────────────────────────────────────────────────────┐
│                           ToolRuntime                              │
│                                                                    │
│  - declaration/schema/registry                                      │
│  - permission evaluation and parked decisions                       │
│  - tool implementation execution                                    │
│  - output deltas and artifacts                                      │
│  - tool telemetry                                                   │
│  - RuntimeEvent(tool_call/tool_result/permission/artifact)          │
│  - returns result to AI SDK so streamText can continue stepping      │
└────────────────────────────────────────────────────────────────────┘
```

Shared services sit beside this path:

```text
RuntimeEventLedger
  canonical invocation facts

ProjectionManager
  RuntimeEvent -> StoredMessage JSONL
  RuntimeEvent -> renderer SessionEvent stream
  RuntimeEvent -> TurnRecord / SessionHeader
  RuntimeEvent -> AgentRunStore / RunTrace
  RuntimeEvent -> TelemetryRepo

SessionService
  event history + scoped state
  legacy JSONL compatibility

RuntimeGate
  readiness / rebind / blocked/running/waiting guards

Plugin / Callback / Instruction
  prompt injection / audit / retry-reflect / telemetry hooks
```

## Canonical RuntimeEvent

Runtime v2 needs a single internal fact model. A sketch:

```ts
type RuntimeEvent = {
  id: string;
  invocationId: string;
  runId: string;
  sessionId: string;
  turnId: string;
  ts: number;

  author: 'user' | 'agent' | 'tool' | 'system';
  role: 'user' | 'model' | 'tool' | 'system';
  branch?: string;
  partial: boolean;

  content?: {
    text?: string;
    thinking?: string;
    functionCall?: {
      id: string;
      name: string;
      args: unknown;
    };
    functionResponse?: {
      id: string;
      name: string;
      result: unknown;
      isError?: boolean;
    };
    error?: {
      code?: string;
      reason?: string;
      message: string;
    };
  };

  actions?: {
    stateDelta?: Record<string, unknown>;
    artifactDelta?: Record<string, string | number>;
    permissionRequest?: PermissionRequest;
    permissionDecision?: PermissionDecision;
    transferToAgent?: string;
    endInvocation?: boolean;
    tokenUsage?: TokenUsage;
  };

  refs?: {
    storedMessageId?: string;
    traceEventId?: string;
    toolCallId?: string;
    providerEventId?: string;
  };
};
```

This event is not a UI event and not a trace event. It is the internal runtime
fact. Other records should either be written from it or be explicitly linked to
it.

## Consumption Paths

### Desktop User Message

```text
Renderer
  -> preload IPC
  -> main IPC handler
     -> normalize input
     -> validate attachment shape
  -> RuntimeRunner.run({ source: 'desktop', sessionId, text, attachments })
     -> RuntimeGate.preflight()
     -> create invocation
     -> append RuntimeEvent(user)
     -> ProjectionManager writes user StoredMessage and renderer append event
     -> AiSdkFlow.run(ctx)
        -> build AI SDK messages from runtime history projection
        -> streamText(...)
        -> partial model chunks -> RuntimeEvent(partial model text)
        -> final model output -> RuntimeEvent(final model text)
        -> tool calls go through ToolRuntime
     -> ProjectionManager writes:
        -> assistant StoredMessage
        -> TurnRecord
        -> SessionHeader
        -> AgentRun ledger status
        -> telemetry usage/tool records
  -> main process streams projected SessionEvents back to renderer
```

The renderer consumes a projection stream. It does not consume the runtime core
directly.

### Tool Call and Permission

```text
AiSdkFlow
  -> AI SDK asks tool.execute({ args, toolCallId })
  -> ToolRuntime.executeTool()
     -> RuntimeEvent(tool_call)
        -> StoredMessage tool_call
        -> renderer tool_start
     -> PermissionEngine.evaluate()
        ├─ allow
        │   -> run tool.impl
        │   -> RuntimeEvent(tool_result)
        │   -> return result to AI SDK
        │
        ├─ block
        │   -> RuntimeEvent(tool_result isError synthetic)
        │   -> return synthetic error result to AI SDK
        │
        └─ prompt
            -> RuntimeEvent(permission_request)
            -> renderer permission modal
            -> session waiting_for_user projection
            -> park tool execution
            -> respondPermission(...)
            -> RuntimeEvent(permission_decision)
            -> allow/deny branch
```

Permission is a runtime action, not just a UI event. It should be represented in
`RuntimeEvent.actions`.

### Model History Construction

Today, model history is built from stored messages and skips several runtime
message types. Runtime v2 should make this an explicit projection:

```text
RuntimeEvent history
  -> ModelHistoryProjector
     include:
       user text events
       model final text events
       selected system/instruction events
       function call events when required by the provider protocol
       tool function response events
     exclude:
       partial chunks
       token usage
       trace diagnostics
       UI-only system notes
       permission ack unless deliberately exposed to the model
  -> AI SDK messages
```

This makes the "what does the next model call see?" policy reviewable and
testable.

### Startup Recovery

```text
App startup
  -> RuntimeRecovery.scan()
     -> read invocation/run ledger
     -> classify non-terminal invocations by latest RuntimeEvent:
        - model stream started with no terminal event -> failed app_restarted
        - tool started with no result -> failed interrupted_tool
        - permission_request pending -> waiting_for_user or failed by policy
        - final model event persisted but run header not completed -> complete it
     -> append recovery RuntimeEvent
     -> ProjectionManager repairs:
        - TurnRecord
        - SessionHeader
        - StoredMessage system note if needed
        - AgentRun terminal status
```

Recovery should reason from canonical invocation facts first and then repair
projections. It should not independently guess from multiple stores unless it is
handling legacy data.

### Bot and OpenGateway

```text
Bot / OpenGateway
  -> normalize external protocol
  -> RuntimeRunner.run({ source: 'bot' | 'gateway', ... })
  -> same RuntimeGate
  -> same AiSdkFlow
  -> same ToolRuntime
  -> projected output:
     bot: collect final response and send bot reply
     gateway: format JSON/SSE response
     desktop: optional fan-out when the same session is visible
```

The runtime should not have three subtly different send paths for desktop, bot,
and gateway.

## Source of Truth Boundaries

The intended boundary is:

```text
RuntimeEventLedger
  runtime fact

StoredMessage JSONL
  user-visible conversation projection and legacy read model

renderer SessionEvent
  transport projection for UI streaming

AgentRunStore
  invocation/run lifecycle ledger, eventually closely linked with RuntimeEvent

RunTrace
  diagnostic-only projection; failures must not affect execution

TelemetryRepo
  economic and operational projection
```

This boundary is the main reason to do the work. Without it, adding more
features will keep increasing the number of places that need to agree about the
same run.

## Proposed Module Shape

One possible file layout:

```text
packages/runtime/src/
  runtime-event.ts
  runtime-event-projection.ts
  invocation-context.ts
  runtime-runner.ts
  runtime-gate.ts
  runtime-recovery.ts

  flows/
    agent-flow.ts
    ai-sdk-flow.ts

  model/
    model-adapter.ts
    model-history.ts

  tools/
    tool-runtime.ts
    tool-registry.ts
    permission-events.ts

  projections/
    stored-message-projection.ts
    session-event-projection.ts
    turn-record-projection.ts
    telemetry-projection.ts

  session-manager.ts
```

This is not a required final file layout. The important part is the direction:
`SessionManager` becomes a facade and session CRUD owner, not the runtime brain.

## Migration Plan

### Phase 1: RuntimeEvent RFC and Adapters

Add the canonical event types and adapters without changing the run path.

Deliverables:

- `RuntimeEvent` and `RuntimeEventActions`
- mapping tests for current `StoredMessage`, `SessionEvent`, `AgentRunEvent`,
  and `RunTraceEvent`
- documentation of which events are facts and which are projections

Reason:

This gives the team a shared language before changing control flow.

### Phase 2: RuntimeRunner Shell

Introduce `RuntimeRunner.run()` and make `SessionManager.sendMessage()` delegate
to it while still using current `AgentRun.execute()`.

Deliverables:

- `RuntimeRunner`
- `InvocationContext`
- `RuntimeGate` placeholder for readiness policy
- backward-compatible `SessionManager` facade
- tests proving current UI-visible behavior remains stable

Reason:

This moves invocation ownership out of `SessionManager` without changing the
AI SDK or storage path all at once.

### Phase 3: AgentRunStore to Invocation Ledger

Upgrade the run ledger to carry invocation/event linkage.

Deliverables:

- run headers linked to `invocationId`
- run events linked to canonical runtime event ids where possible
- recovery tests that reason from invocation facts and repair projections

Reason:

The current run ledger is already useful. It should become part of the runtime
spine instead of a parallel diagnostic store.

### Phase 4: AiSdkFlow Formalization

Extract/formalize the current `AiSdkBackend.send()` loop into `AiSdkFlow`.

Deliverables:

- `AgentFlow` interface
- `AiSdkFlow` implementation
- `ModelHistoryProjector`
- `AiSdkFlow` emits canonical `RuntimeEvent`s
- `AiSdkBackend` becomes configuration/factory shell rather than the runtime
  loop owner

Reason:

The AI SDK remains the main engine, but Maka gains explicit flow input/output
semantics.

### Phase 5: ToolRuntime Event Actions

Make tool calls, tool results, permission requests, permission decisions, state
deltas, and artifact deltas first-class runtime event actions.

Deliverables:

- `tool_call` / `tool_result` runtime events
- permission request/decision runtime actions
- artifact delta linkage
- tests for allow/block/prompt/deny/abort paths through canonical events

Reason:

Tools are where model intent becomes local side effects. That boundary must be
auditable and replayable.

### Phase 6: Entrypoint Cleanup

Move readiness and rebind policy out of desktop main and into runtime gates.

Deliverables:

- `RuntimeGate` owns connection readiness/rebind/session blocked/running guards
- desktop/bot/gateway entrypoints call the same runner APIs
- contract tests proving the same session state behaves the same across
  desktop, bot, and gateway paths

Reason:

Entry points should translate protocols; they should not own runtime policy.

### Phase 7: Model History Correctness

Build future model prompts from runtime event history projection.

Deliverables:

- explicit policy for which runtime events enter model history
- tests for tool-result replay into the next model call
- tests excluding partial chunks, telemetry, trace, and UI-only notes
- provider compatibility tests around AI SDK message shapes

Reason:

The next model call must see the right history for the right reason. This
should be a tested runtime policy, not incidental stored-message filtering.

## What Not To Do

Avoid these failure modes:

- Do not rewrite all provider streaming logic from scratch.
- Do not remove the AI SDK as the main flow engine.
- Do not delete session JSONL compatibility.
- Do not move UI concerns into `RuntimeEvent`.
- Do not let `RunTrace` become a success/failure source of truth.
- Do not let desktop main remain the owner of readiness/rebind runtime policy.
- Do not introduce a second tool runtime beside the current `ToolRuntime`;
  evolve it into the event/action model.

## Success Criteria

Runtime v2 is working when these statements are true:

- A developer can answer "what happened in this turn?" by reading one
  invocation/event ledger.
- UI messages, turn records, run records, trace rows, and telemetry can be
  traced back to canonical runtime event ids.
- desktop, bot, and gateway entry points share the same runtime readiness and
  execution semantics.
- model history construction is an explicit tested projection from runtime
  events.
- tool permission and tool result behavior is visible as runtime actions, not
  scattered side effects.
- `SessionManager` is mostly session CRUD plus backward-compatible facade
  methods.
- the AI SDK remains a supported first-class flow implementation through
  `AiSdkFlow`.

## Open Questions

- Should canonical `RuntimeEvent` be stored as a separate JSONL immediately, or
  first mirrored into `AgentRunStore` events?
- Should `StoredMessage` projection be synchronous with event append, or should
  projection failures be recoverable/replayable?
- How much of current `RunTrace` should be folded into `RuntimeEvent` refs
  versus left as diagnostic-only rows?
- Should permission prompts be model-visible events, UI-only events, or
  configurable by flow policy?
- How should branch/agent transfer be represented before Maka has a full
  multi-agent tree?
- What is the compatibility strategy for old sessions that have no runtime
  event ledger?

These should be answered in the RFC before implementation starts.

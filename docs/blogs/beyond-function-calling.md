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

[简体中文](./beyond-function-calling.zh-CN.md)

# Beyond Function Calling: How Agents Reach the Real World

## Deferred Tools: Even an Unused Tool Has a Cost

In standard programs, an uncalled function incurs negligible runtime overhead. It can sit in a source repository or a dynamic library without consuming CPU cycles or occupying stack frames.

Tools in an agent architecture behave fundamentally differently.

Before a large language model can invoke a tool, it requires explicit awareness of the tool name, behavioral description, and structured parameter schema. Consequently, the runtime must transmit these definitions alongside the system prompt and conversation history on every request. Even if a tool is never triggered during an entire session, its schema continually consumes input tokens across every inference step.

Tool overhead begins long before execution starts. Schemas occupy scarce context windows, dilute model attention during planning, and degrade prefix cache reuse across provider endpoints. As registries expand, the broader action space comes at the expense of task-specific context and introduces higher decision variance.

When an agent exposes only elementary tools like `Read`, `Write`, and `Bash`, the overhead remains manageable. Once the registry includes browser drivers, OS automation routines, subagent delegations, enterprise services, and dozens of Model Context Protocol (MCP) connectors, keeping all schemas resident across all requests breaks scalability.

Maka addresses this limitation through Deferred Tools. The mechanism does not alter execution timing; its purpose is to control when complete schemas become visible to the model.

The runtime continuously retains all registered tool bindings for the active run. However, the initial request exposes only high-frequency primitives alongside a compact `tool_search` utility. Extended tools register solely by name and category in a lightweight inventory, omitting full descriptions and parameter schemas.

```text
Bound Tool Registry
        │
        ├──── Direct Tools ───────────────→ Full schemas in this request
        │
        └──── Deferred Tools
                │
                └──── Lightweight Search Inventory
                           │
                      tool_search
                           │
                    Bounded matches
                           │
                           ▼
                    Next provider step
                    injects matched schemas
```

The `tool_search` utility performs local lookups across capabilities already registered with the runtime. Maka matches queries against tool names, descriptions, and functional categories, returning a size-bounded candidate set. The payload returned to the model contains only the activated tool identifiers. Full schemas are never dumped directly into the tool result payload; they are injected into the subsequent model turn through standard tool projection.

In Maka, tool state is organized into three distinct tiers:

- **Bound:** The runtime possesses an executable implementation, defining the absolute capability ceiling of the run.
- **Discoverable:** The tool is cataloged in the lightweight inventory, making the model aware of its availability.
- **Visible:** The complete schema is injected into the active provider request, enabling the model to construct valid calls.

Capability discovery does not introduce unregistered implementations or exceed the binding ceiling. It serves exclusively to reshape the tool projection presented to subsequent inference steps.

Step boundaries enforce strict temporal separation. Once a provider step is dispatched, its schema set is immutable. If a model generates the following sequence within a single completion:

```text
tool_search("browser click")
browser_click(...)
```

Maka rejects the second call. Results from `tool_search` apply only to subsequent provider interactions; they cannot retroactively amend schemas already committed to the provider. The complete definition of `browser_click` enters context in the next step, allowing the model to construct arguments against a validated interface.

Deferred activation is strictly scoped to the active turn. Discovered tools accumulate monotonically across retries within the turn, and release upon completion. Subsequent user turns reset to the baseline tool set, preventing intermittent tool usage from permanently burdening long-term inference context.

Visibility does not equate to authorization. A visible schema still requires parameter validation, concurrency checks, and permission gates upon invocation. The `tool_search` mechanism regulates cognitive surface area; system safety remains the sole responsibility of runtime enforcement.

Deferred Tools constrain the action space presented to the model. The runtime preserves comprehensive capabilities while exposing only task-relevant subsets per step.

## The Action Boundary: Bridging Probability and System Side Effects

Injecting a tool schema into context only informs the model of available actions. Until the model produces a tool call, the interaction remains strictly within the domain of text tokens.

Language models cannot directly manipulate host systems. They consume input sequences and predict subsequent tokens. Emitting the statement "I have updated the configuration" does not alter any byte on disk. A physical boundary separates descriptive language from concrete system state.

Tool calls bridge this boundary. The model ceases freeform generation and emits a structured action intent specifying the target tool, call arguments, and a correlation identifier (Call ID). The runtime intercepts this intent, executes the real operation within a sandboxed environment, and returns observed outcomes to the model.

```text
LLM
 │
 │  function_call(name, arguments, call_id)
 ▼
Runtime
 │
 ├── Resolve tool binding
 ├── Validate arguments and execution bounds
 ├── Request required permissions
 ├── Invoke concrete system operation
 ▼
Filesystem / Process / Browser / Network / Human
 │
 │  function_response(call_id, result)
 ▼
Next LLM inference step
```

This feedback loop allows the model to interact with external environments. File reads inspect workspace state, command executions capture compiler and test diagnostics, file modifications update working trees, network calls interface with external services, and user interaction tools pause for clarification.

Tool results provide the empirical ground truth for subsequent decisions. Without observational feedback, models cannot verify whether operations succeeded or correct invalid assumptions. An end-to-end agent step consists of a closed loop across reasoning, dispatch, and observation:

```text
Reason → Act → Observe → Reason
```

This interaction differs fundamentally from regular software invocation. Conventional programs link callers and callees inside deterministic execution environments. Tool calls generated by language models represent probabilistic action proposals. Arguments may be malformed, environmental preconditions may be stale, and assumptions regarding system state may be incorrect.

Language models do not possess ambient execution authority. External side effects occur strictly through runtime arbitration, validation, and policy checks.

In Maka, invocations face rigorous validation before dispatch: bindings are checked, turn visibility is verified, parameter schemas are enforced, and concurrency policies are applied. Underlying system implementations execute only after all checks pass.

This boundary decouples model intent from system authorization. The model possesses proposal authority; producing syntactically valid JSON cannot grant environmental privileges. Tool schemas define the wire format for proposals, bindings register available capabilities, and runtime permissions arbitrate individual calls.

Upon completion, the runtime normalizes external payloads into provider-neutral tool results, paired via stable Call IDs. Within Maka's `RuntimeEvent Log`, these events are committed as immutable `function_call` and `function_response` entries, establishing an auditable factual foundation for replay and crash recovery.

Call IDs serve as architectural anchors. When an agent dispatches multiple concurrent calls, disparate I/O latencies shuffle completion order. The runtime relies on deterministic identifiers to route results back to their respective causal chains and preserve structural topology during replay.

Tool calls transform model output from human-directed prose into system invocations with irreversible side effects. The runtime must therefore implement rigorous engineering boundaries to manage external consequences safely.

## Reliable Execution: Crash Recovery Over Committed History

Introducing external side effects exposes the agent runtime to real-world infrastructure failures.

Consider a scenario where a model calls `Edit` to update a port from `3000` to `4000`. The disk write completes, but the host process loses power immediately afterward. Upon restart, the runtime observes a dangling call without an associated result. This absence does not mean the filesystem remained untouched.

A missing tool result can signify several conflicting states: the call was never dispatched, execution is still in progress, disk writes succeeded while metadata commits failed, or external processes modified state post-write. Blindly re-executing such calls risks duplicate writes, redundant financial transactions, or persistent data corruption.

Unlike text generation, external system actions cannot be assumed nonexistent simply because the runtime missed the return signal.

Maka encloses every external tool invocation within a lightweight two-phase persistence boundary:

```text
Model generates function_call
          │
          ▼
Validate parameters, visibility, permissions, and bounds
          │
          ▼
T1: Commit Tool Dispatch
          │
          ▼
Execute real-world operation
          │
          ▼
T2: Commit function_response
          │
          ▼
Deliver Tool Result to model
```

T1 signifies that all pre-flight validations passed and execution crossed the dispatch threshold. From this point forward, the runtime cannot safely assume the operation never occurred. T1 must commit before concrete implementations are invoked; if T1 persistence fails, external actions remain blocked.

T2 certifies that execution results have committed as an immutable `function_response` event. Only after T2 commits may the outcome enter subsequent model inference steps. Even if an external operation succeeds, missing T2 persistence prohibits feeding unverified state into the active reasoning loop.

Maka avoids distributed database transactions across external systems. File I/O, shell tasks, browser drivers, and network requests exhibit wide variance in latency, making global ACID transactions impractical. Maka uses two localized storage transactions to bound the external side-effect window:

```text
Committed T1 → External Side Effect → Committed T2
```

When unexpected crashes occur, recovery logic derives exact status from the append-only event prefix:

| Log State | Recovery Disposition |
|---|---|
| No T1 committed | Operation never dispatched; safe to discard or re-evaluate |
| Both T1 and T2 present | Operation completed; reuse committed result without re-execution |
| T1 present, T2 missing | State indeterminate; force reconcile or park |
| Broken ID causality or ordering conflicts | Ledger corrupted; fail closed |

The interval between T1 and T2 represents the critical failure window. The system knows dispatch was authorized, but cannot confirm external completion. Maka prohibits speculative guessing and never defaults missing outcomes to failure. Tool bindings declare specific recovery policies: natural idempotency, queryable status checks, or strict prohibition of automatic retries. When definitive evidence is lacking, the runtime parks the operation, awaiting automated probes or operator intervention.

Recovery operations remain append-only. The runtime never edits prior `function_call` events or fabricates missing history. Dispatches, outcomes, reconciliations, and operator decisions append to the log tail as new facts. Historical facts remain immutable; subsequent events record how dangling operations converged.

Resume routines initiate fresh execution cycles only after all pending operations resolve to Completed or Definitely Not Dispatched.

Replay follows strict architectural boundaries. Maka never re-runs historical tool implementations, nor does it resurrect transient in-memory objects, unresolved promises, or dropped sockets. Replay reconstructs verified causal history: user inputs, reasoning traces, and paired `function_call` and `function_response` events.

```text
Immutable RuntimeEvent Prefix
            │
            ├── Resolve and converge tool states
            ├── Strip transient streaming chunks
            ├── Retain paired Call / Response events
            ├── Prune uncommitted dangling suffixes
            └── Verify High-Water mark and Digest
                         │
                         ▼
              Verified Provider Replay Plan
                         │
                         ▼
              Fresh Run / Invocation Instance
```

Leveraging append-only logs, recovery operates independently of volatile memory dumps. The runtime reads the immutable event slice up to the recorded high-water mark, validates its cryptographic digest, and projects canonical context for the subsequent step.

The resumed instance receives distinct Run and Invocation identifiers, noting its parent run and high-water anchor. Original user prompts are not duplicated, and finished operations do not re-run. The continuation inherits verified historical facts rather than an imperative re-execution script.

Before dispatching model requests, Maka verifies fundamental environmental invariants: matching workspace paths, active tool bindings, converged background tasks, and absence of conflicting recoveries. If any condition cannot be confirmed, resume aborts to a parked state, preventing execution within compromised environments.

Maka crash recovery reconstructs execution from verified append-only history, rather than attempting to resurrect volatile process state.

## Code Mode: Programmatic Orchestration and Folded Call Trees

Standard tool calling adheres to a sequential turn pattern: the model proposes an action, the runtime executes it, and the model re-evaluates the prompt. For workflows requiring continuous semantic reasoning at every step, this pattern provides necessary control.

However, for deterministic data transformations, this round-trip structure creates severe latency and token overhead.

Consider multi-package dependency audits: an agent must traverse dozens of directories, inspect `package.json` files, extract version constraints, and report discrepancies. Under sequential tool calling, the agent repeats dozens of inference cycles: generating read requests, waiting for file contents, parsing results, and emitting subsequent calls. Raw file contents flood the context window, and model round trips compound latency.

```text
Reason → Call → Observe → Reason → Call → Observe → ...
```

In these workflows, reasoning is essential for initial planning and final error analysis, while intermediate steps involve deterministic control flow. Forcing models to emulate loops and string parsers incurs unnecessary inference cost and pollutes context with intermediate noise.

Code Mode replaces discrete invocations with programmatic orchestration.

Instead of emitting fragmented tool calls, the model produces an executable program. Iteration, concurrency, branching, parsing, and aggregation execute inside a sandboxed interpreter. The model receives only the final structured output.

```text
                  ┌─ Tool A ─┐
Reason → Program ─┼─ Tool B ─┼→ Filter / Join / Reduce → Observe → Reason
                  └─ Tool C ─┘
```

Implementations vary across ecosystem providers: OpenAI exposes Programmatic Tool Calling within the Responses API, executing model-generated JavaScript in a secure V8 environment with access to `tools.*`; Anthropic allows Claude to execute Python scripts within a containerized environment, calling whitelisted tools programmatically.

Both approaches share common architectural principles: delegating non-deterministic planning to the model while offloading deterministic control flow to an execution engine.

Sandboxes operate under strict isolation. Code executed within the container accesses only tools explicitly surfaced by the runtime. Writing custom network or filesystem logic cannot bypass runtime permissions. The script acts as an orchestration layer, not an escalation of privilege.

Code Mode does not displace standard tool mechanisms. Instead, it reorganizes linear call sequences into a hierarchical call tree: the root node contains the program payload, while branch nodes represent concrete tool calls issued by the script. Each leaf operation must still pass through runtime validation, permission gates, and transaction boundaries.

```text
Program / exec
├── Tool Call 1
├── Tool Call 2
│   └── Tool Result 2
└── Tool Call 3
    └── Tool Result 3
         │
         ▼
   Program Result
```

Folding invocations into trees yields two primary benefits: it minimizes round-trip inference steps, and it shields the context window from intermediate telemetry. The sandbox absorbs raw operational payloads, returning only consolidated summaries to the outer context. Full operational details are preserved in audit logs without consuming inference memory.

Programmatic orchestration should not be applied universally. Irreversible side effects, actions requiring human authorization, or workflows where subsequent steps depend on unstructured semantic observations benefit from explicit top-level tool calls. Code Mode is designed for deterministic data pipelines, not for concealing agent decisions.

Maka enforces clear operational bounds within Code Mode. The model submits JavaScript cells via an `exec` primitive, restricted to registered tools marked for nested invocation. The execution environment lacks ambient OS capabilities, constrained by quotas on execution time, memory usage, script size, response size, and concurrency.

Crucially, nested invocations within a cell route through the central `ToolRuntime`. Validation, permission evaluation, and T1/T2 transactions apply uniformly. Maka assigns discrete identifiers to nested calls, maintaining parent-child links with the host `exec` event.

Nested calls retain durable persistence semantics without inflating the model prompt. They commit to the `RuntimeEvent Log` with `modelVisibility: hidden`, while the model sees only the outer `exec` boundary and its aggregated result. Maka preserves complete factual history in storage while projecting a clean abstraction for inference.

Crash recovery also accounts for programmatic execution. A script may execute three nested operations before crashing on the fourth. Re-running the entire script upon recovery would duplicate completed side effects. Maka prohibits automatic retries of unfinalized `exec` cells. Settled nested operations remain in the log, while the outer cell marks an interrupted state, leaving resumption strategy to subsequent model evaluation.

Script environments are ephemeral, yet every nested tool invocation crossing the system boundary remains durably logged and auditable.

## Parallel Tool Execution: Decoupling Task Concurrency from Resource Authority

Agents can emit concurrent tool calls within Code Mode programs or output parallel invocations in a single standard completion step.

Parallel tool calling requires clear architectural definition. When a model outputs a batch of calls in one step, it does so without observing any interim results. Therefore, invocations within that batch cannot possess causal data dependencies on each other.

If an operation depends on data produced by another call, it must be scheduled in a subsequent reasoning step.

```text
Single Assistant Step

        ┌── Tool Call A ──→ Result A ──┐
Model ──┼── Tool Call B ──→ Result B ──┼──→ Next Model Step
        └── Tool Call C ──→ Result C ──┘

                    Fan-out / Fan-in
```

From an architectural standpoint, batch calls mirror asynchronous I/O primitives. Each tool call is handled as an independently awaitable task. The runtime avoids thread blocking, advancing concurrent tasks until external filesystems, processes, or networks respond. Once the entire batch settles, the runtime aggregates results for the next inference step.

This structure allows independent wait states to overlap. A slow web query does not delay local file inspection or subagent execution. Overall latency converges toward the critical path rather than the sum of independent operations.

However, an absence of data dependencies does not guarantee an absence of resource conflicts.

A model may emit `Read(a)` and `Edit(a)` within the same batch, or instruct multiple tools to update shared session state simultaneously. While neither call consumes the other's return value, both contend for identical physical resources. Handing such batches directly to uncoordinated primitives like `Promise.allSettled()` introduces race conditions governed by nondeterministic execution timing.

Maka addresses this challenge in [PR #4542](https://github.com/apache/maka/pull/4542): the runtime must maximize independent I/O parallelism while guaranteeing deterministic ordering for conflicting operations.

Centralizing all concurrency constraints inside a single Tool Scheduler introduces architectural bottlenecks. Expecting a scheduler to statically deduce read/write sets from tool arguments creates brittle abstractions that fail across dynamic host environments.

Asynchronous system design provides a clear separation of concerns: executors schedule task lifecycles, while resource authorities govern access constraints.

An executor drives ready tasks forward. Mutual exclusion, reader-writer fairness, capacity limits, and wakeup signals belong to authorities positioned beside the underlying resources: asynchronous mutexes, reader-writer locks, semaphores, or state-owning actors.

Agent runtimes follow this division:

```text
Tool Batch
    │  Create tasks, allocate result slots, broadcast cancellation
    ▼
Resource Authority
    │  Resolve identity, order, enforce exclusivity, check versions, wake
    ▼
Filesystem / Terminal / Browser / Session / Remote Service
```

Resource authorities must resolve true resource identity. Raw path arguments cannot reveal physical aliases: distinct paths may point to the same file via symlinks, multiple tools may manipulate the same browser tab, and separate MCP calls may target the same remote session. Only the authority directly managing the resource can arbitrate true contention and commit order.

Batch schedulers reduce unnecessary contention, but cannot serve as the sole source of safety. Schedulers cannot enforce exclusivity across independent turns, concurrent subagents, or external system processes. Safety must close at the resource authority layer.

Different resource types require tailored synchronization models:

- **Filesystems:** Canonical path leases with writer-priority or read-write fairness.
- **Terminals and Browsers:** Single-state actors enforcing strict sequential operations.
- **External APIs and MCP Servers:** Counting semaphores regulating concurrency and request quotas.
- **Versioned Session State:** Optimistic concurrency control via Compare-And-Swap (CAS) on revisions.

These patterns share an asynchronous lifecycle without forcing heterogeneous resources into a single locking model.

This separation clarifies the distinction between resource contention and capacity limits:

- Resource contention determines whether operations can safely execute concurrently without corrupting state.
- Capacity limits determine how many concurrent operations the infrastructure can support.

Treating upstream API rate limits as a global mutex introduces head-of-line blocking, allowing slow network calls to stall unrelated disk reads. Asynchronous runtimes should restrict blocking strictly to genuine physical conflicts, keeping independent work unhindered.

When batch invocations contend for identical resources, the model's generated array order acts as a deterministic tie-breaker. This sequence establishes prioritization during contention, but does not represent causal data flow.

Parallel execution involves four distinct temporal sequences:

```text
Model Generation Order
    ≠ Task Start Order
    ≠ Task Completion Order
    ≠ Runtime Event Arrival Order
```

Independent tasks start and complete out of order. Raw execution events commit to the log as they occur, linked through Tool Call IDs, while payloads returned to the provider reassemble to match original prompt ordering. Historical logs preserve physical facts, while context projection satisfies model protocol requirements.

Aborts and timeouts adhere strictly to structured concurrency rules. Queued tasks that are canceled must not begin execution; tasks that have crossed T1 dispatch cannot simply be abandoned. The runtime must await their convergence and record final dispositions. The batch manager maintains ownership across child tasks, ensuring every operation completes, aborts, or reaches a verifiable state before the next inference step begins.

## Sandboxes, Serverless, and Disaggregated State

Tool invocations must ultimately execute on concrete computing infrastructure.

Models generate action plans and programs coordinate control flow, but operating system processes, memory spaces, and network interfaces require physical or virtual resources. Execution targets span a broad spectrum: lightweight JavaScript V8 isolates, Python container environments with data science toolchains, and full MicroVMs with dedicated kernels and hardware virtualization.

```text
LLM Generates Intent
      │
      ▼
Agent Runtime
      │  Select execution environment and capabilities
      ▼
┌──────────┬──────────────┬─────────────┐
│ V8       │ Python       │ MicroVM     │
│ Program  │ Data/Scripts │ Full OS Tool│
└──────────┴──────────────┴─────────────┘
      │
      ▼
Filesystem / Process / Network / Browser
```

Heavier execution environments carry distinct trade-offs. Booting a full virtual machine for basic string manipulation introduces unnecessary latency, while running untrusted shell scripts directly within the host process creates severe security risks. Runtimes must dynamically match tool requirements against lightweight, securely isolated substrates.

Sandboxes define more than security perimeters; they establish resource, failure, and lifecycle boundaries for agent execution.

Runtimes enforce strict quotas at the sandbox layer: limiting CPU, memory, storage, concurrency, and execution time; restricting network domains; and terminating environments upon memory exhaustion or process failures to prevent systemic instability.

Sandboxing also enables decoupling agent state from host infrastructure.

Conventional applications assume long-running local processes. In contrast, modern agent environments treat compute substrates as disposable: V8 cells terminate upon completion, containers recycle after idle timeouts, and MicroVMs drain during host migrations. Binding persistent agent state to ephemeral compute nodes undermines system reliability.

Append-only logging provides the foundation for this separation.

Conversation traces, tool calls, results, permission records, and recovery events reside in durable logs. Large artifacts and binary outputs persist in object storage, while workspaces mount via copy-on-write snapshots or persistent volumes. Sandboxes act as stateless execution engines, disposable and recreatable across nodes.

```text
Durable State                         Ephemeral Compute

RuntimeEvent Log ─┐                 ┌─ V8 Isolate
Artifact Storage ─┼─→ Rehydrate ────┼─ Container
Workspace Snapshot┘                 └─ MicroVM

       Preserves "What happened"           Executes "Next action"
```

Agent workloads are bursty: sandboxes sit idle during model reasoning, followed by intense spikes during compilation or batch processing. Certain tools run in milliseconds, while others block for hours on external feedback. Modern infrastructure must support rapid scaling to zero during idle periods, provisioning specialized capacity only when invoked.

This differs from traditional Function-as-a-Service (FaaS) abstractions. Standard serverless functions assume brief, stateless execution; agents maintain stateful workspaces, spawn long-running background tasks, pause for human review, and resume hours later.

Agent Serverless decouples session state entirely from compute lifecycle.

When a sandbox terminates, the runtime does not attempt to reconstruct volatile process heaps or unresolved sockets. Instead, it inspects durable logs, rehydrates workspace snapshots into a newly provisioned sandbox, and resumes execution from a verified factual history.

Security architectures also benefit from this model. Disposable sandboxes do not hold static administrative credentials or broad network access. They receive short-lived, minimum-privilege capabilities per task. Credential storage and policy authorization remain within the trusted runtime outside the container. If a sandbox environment is compromised, its authorization scope expires immediately upon termination.

Affordable compute substrates enable fleet-scale agent deployments. A single session can provision lightweight V8 isolates for script orchestration, Python containers for data analysis, and MicroVMs for software compilation, terminating resources as each task completes.

The natural extension of this architecture is complete state disaggregation: persisting session state in cost-effective object storage (such as S3-compatible systems) while compute executes across on-demand, stateless workers.

Sessions cease to correlate with static processes or host directories. They exist as collections of durable objects: append-only event segments, binary artifacts, workspace snapshots, compaction projections, and manifest metadata pointing to current commit boundaries. Between interactions, sessions persist passively in object storage at minimal cost.

```text
                    Cost-Effective Object Storage (S3)

Session A ── Events / Artifacts / Workspace Snapshots ─┐
Session B ── Events / Artifacts / Workspace Snapshots ─┼── S3
Session C ── Events / Artifacts / Workspace Snapshots ─┘
                                                       │
                         External Event / User / Schedule
                                   │                   │
                                   ▼                   │
                         Rehydrate Session Context ◀───┘
                                   │
                       ┌───────────┼───────────┐
                       ▼           ▼           ▼
                      V8        Python      MicroVM
                       │           │           │
                       └───────────┼───────────┘
                                   │
                              Append Facts
                                   │
                                   └──────────────→ S3
```

Long-running agents no longer require persistent, dedicated servers.

They remain dormant most of the time. When messages arrive, webhooks trigger, or schedules elapse, the control plane reads the session manifest, mounts the required log prefix and workspace snapshot, and provisions an appropriate sandbox. Once execution settles, new facts sync back to storage, and compute resources release immediately.

The architecture organizes into two coordinated tiers:

- **Data Plane:** Object storage managing immutable, high-volume event logs and filesystem snapshots.
- **Control Plane:** Low-latency storage tracking authoritative head pointers, resource leases, quotas, and pending operations.

This mirrors disaggregated database architectures. Object storage provides durable, cost-effective persistence, while compute resources provision strictly on demand. Context assembly operates like a materialized view query: the runtime reads durable state, applies compaction and result pruning, and projects bounded context for model inference.

```text
Session on S3
      │
      ├── Projection ──→ Model Context ──→ LLM
      │                                      │
      ├── Rehydrate ───→ Sandbox ──────────→ Tool Call
      │                                      │
      └──────────────── Append New Facts ◀───┘
```

Both models and sandboxes function as interchangeable compute utilities.

Model selection scales with reasoning complexity, and sandbox sizing matches workload requirements. A session is never coupled to a single model provider or execution substrate.

Cost efficiency stems from ensuring dormant sessions consume zero active compute.

Disaggregated storage also facilitates spot-instance execution and instantaneous branching. Using append-only logs and copy-on-write snapshots, subagents fork from parent histories without copying storage, writing only delta records going forward.

The future of agent runtime engineering is clear: establishing immutable logs as the authoritative source of truth, relying on disposable sandboxes for safe execution, decoupling resource governance from task scheduling, and dynamically managing schema projections to preserve model focus. Extending language models into external systems requires robust runtime engineering to ensure safety and reliability.

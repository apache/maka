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

In an ordinary program, a function that is never called has almost no runtime cost. It can sit in a codebase or a dynamic library without consuming CPU or occupying the call stack.

Tools in an agent do not work that way.

Before a model can call a tool, it must know the tool's name, purpose, and argument format. The runtime therefore sends tool definitions to the model together with the system prompt and conversation history. Even when a tool is never invoked, its description and JSON Schema have already participated in every inference.

A tool starts costing tokens before it starts executing. Its schema occupies context, influences the model's next-action decision, and changes the request prefix available for provider-side caching. More tools give the model a larger action space, but leave less room for the task itself and introduce more competing choices.

This is barely noticeable when an agent has only a few tools such as `Read`, `Write`, and `Bash`. It becomes a scaling problem once browsers, computer use, subagents, external services, and MCP connectors join the tool registry. Keeping every schema resident in every model request is not a sustainable architecture.

Maka's deferred tools begin with this observation. "Deferred" does not mean delayed execution or background execution. It means delaying the moment when the complete tool schema becomes visible to the model.

The runtime still holds every tool binding available to the current run. On the first model request, however, the model sees only a small set of frequently used tools and a lightweight `tool_search`. Other tools appear in a compact search inventory by group and name, without their full descriptions or argument schemas.

```text
Bound Tool Registry
        │
        ├── Direct Tools ───────────────→ Full schemas in this request
        │
        └── Deferred Tools
                │
                └── Lightweight Search Inventory
                           │
                      tool_search
                           │
                    Bounded matches
                           │
                           ▼
                    Next provider step
                    injects matched schemas
```

`tool_search` does not search files, web pages, or application data. It searches capabilities already owned by the runtime. Maka performs the lookup locally against tool names, descriptions, and capability groups, then selects a bounded set of matches with bounded schema size. The result contains only the activated tool names. Full schemas are not duplicated inside the tool result; they appear through the normal tool projection in the next provider request.

This separates several concepts that are easy to conflate:

- **Bound:** the runtime owns an executable tool binding. This defines the capability ceiling of the run.
- **Discoverable:** the tool appears in the lightweight inventory, so the model knows that the capability exists.
- **Visible:** the complete schema is present in the current provider request, so the model can construct a valid call.

Search does not bind a new tool and cannot exceed the run's binding ceiling. It changes only the tool projection visible to the next model call.

"Next" is an important boundary. Once a provider step begins, its tool schemas are fixed. If the model emits both of these calls in one response:

```text
tool_search("browser click")
browser_click(...)
```

Maka still rejects the second call. A search result can affect a later request, but it cannot rewrite the schema set of a request already sent to the provider. Only in the next step does the full `browser_click` definition enter context, allowing the model to generate arguments for an interface it has actually seen.

Deferred activation is scoped to the current turn. Tools discovered during a turn accumulate monotonically, and provider retries inherit that working set. When the turn ends, the activation set is released. The next user turn starts again from the stable base set instead of permanently paying for every capability used in the past.

Visibility is also not authorization. A visible tool still passes through permission checks, argument validation, and runtime execution boundaries when called. `tool_search` manages the model's cognitive action space, not the user's permission space.

Deferred tools therefore do not answer "how should a tool execute?" They answer "which tools deserve to enter the model's next thought?" The runtime retains the complete capability space while the model sees only the working set relevant to the current task.

## Tool Calls: Giving the LLM Hands and Feet

Once a tool schema enters context, the model merely knows which actions are available. Until it emits a tool call, everything remains tokens.

An LLM cannot read a file, start a process, or click a screen. It consumes input and predicts output. Even if it says, "I have modified the file," that sentence changes nothing on disk. Language describes the world; by itself, it does not alter the world.

A tool call creates a channel between the two. Instead of producing only natural language, the model emits a structured action request: a tool name, arguments, and an ID that associates the eventual result with the call. The runtime receives the request, executes the corresponding operation in a real environment, and returns the observation to the model.

```text
LLM
 │
 │  function_call(name, arguments, call_id)
 ▼
Runtime
 │
 ├── Resolve the tool binding
 ├── Validate arguments and execution boundaries
 ├── Request permission when necessary
 ├── Invoke the real implementation
 ▼
Filesystem / Process / Browser / Network / Human
 │
 │  function_response(call_id, result)
 ▼
The LLM's next inference
```

This closed loop is where a model becomes an agent. File reads give it observations of a codebase. Commands expose compiler and test feedback. File edits let it change the workspace. Browser and network tools connect it to systems outside the local process. Questions let it pause for new facts when information is missing.

If tools are the agent's hands and feet, tool results are its senses. Without feedback, the model cannot tell whether an action succeeded or whether reality matches its prediction. A complete agent step is therefore not simply "the model thought once." It combines intention, execution, and observation:

```text
Reason → Act → Observe → Reason
```

This resembles a function call, but differs in a fundamental way. When a program calls an internal function, caller and callee usually share one deterministic execution environment. A model issuing a tool call is proposing an action from a probability distribution. Its arguments may be incomplete, its target may have changed, and its understanding of the environment may be wrong.

It is more accurate to say that the LLM does not grow its own hands and feet. The runtime lends it a controlled set.

In Maka, a model-generated call cannot bypass the runtime and reach the outside world directly. The runtime verifies that the binding exists, that it is visible in the current step, and that the arguments conform to its schema. The call must also pass concurrency limits, permission policies, and execution boundaries before the implementation can run.

This boundary separates model intent from system authority. A model may request an action, but emitting a syntactically valid call does not create a capability or grant permission. The schema teaches the model how to express the request, the binding determines whether the runtime possesses the capability, and permission determines whether this particular invocation may proceed.

After execution, the runtime converts the outcome into a provider-independent tool result and pairs it with the original call ID. In Maka's `RuntimeEvent Log`, the two sides become `function_call` and `function_response`. What the model requested and what the runtime actually returned both become replayable, auditable facts.

The call ID is more than a message-format field. A turn may launch several calls at once, and completion order may differ from call order. Stable identities allow the runtime to route every result to the correct call and reconstruct the same causal relationships during recovery.

Tool calling completes a crucial transition: model output is no longer only language for a human reader. It can become a request to inspect private data, consume resources, start processes, or mutate state. Deferred tools decide which capabilities enter the model's field of thought. A tool call lets one selected capability cross the language boundary and attempt to change reality.

At that moment, the systems problem changes. A failed generation produces disappointing text. A failed tool call may occur after the real-world effect happened but before its result returned. Once the model has hands and feet, the runtime must become responsible for the consequences.

## Reliable Tool Calls: Resume Replays History, Not Actions

Tool calling connects the model to the real world, and imports the real world's uncertainty into the agent runtime.

Suppose the model calls `Edit` to change a configuration port from `3000` to `4000`. The file write finishes, and the Maka process crashes immediately afterward. After restart, the runtime can see that the call has no result, but that does not prove the file was never modified.

A missing result can represent several realities: dispatch never began; the tool is still running; the side effect completed but its result was never persisted; or the external state changed again after execution. If resume simply executes the call again, it can duplicate writes, messages, object creation, or even payments.

This is the most important difference between a tool call and text generation. Missing text can be regenerated. An action that already crossed a process boundary cannot be assumed absent merely because the runtime did not receive its result.

Maka places two durable boundaries around real tool execution:

```text
Model emits function_call
          │
          ▼
Arguments, availability, permission, and boundary checks
          │
          ▼
T1: Commit Tool Dispatch
          │
          ▼
Execute the real-world operation
          │
          ▼
T2: Commit function_response
          │
          ▼
Expose Tool Result to the model
```

T1 means that the runtime has completed every pre-execution check and has formally crossed the dispatch boundary. From this point onward, the system can no longer safely claim that the tool did not run. T1 must commit before the implementation begins; if the commit fails, the side effect is not allowed to start.

T2 means that the outcome has become a durable `function_response`. Only after T2 commits may the result enter the next model inference. Even if a tool returns successfully, the runtime cannot show the model a result that it would be unable to reconstruct after restart.

Maka does not try to wrap the entire tool call in a database transaction. Filesystem operations, shell commands, browser actions, and network requests can take seconds or hours, and SQLite cannot participate in a true distributed transaction with all of those systems. Maka instead uses two short transactions to make the side-effect window explicit:

```text
Committed T1 → External Side Effect → Committed T2
```

Wherever the process crashes, the committed append-only prefix gives the restarted runtime a precise classification:

| Durable facts | Runtime conclusion |
|---|---|
| T1 was never crossed | The tool was definitely not dispatched |
| Both T1 and T2 exist | The tool completed; reuse the existing result and never execute it again |
| T1 exists but T2 is missing | The side-effect state is unknown; reconcile or park |
| Call, dispatch, or response identities conflict | The ledger is corrupt; fail closed |

The interval between T1 and T2 is the dangerous case. The system knows that execution was authorized, but not whether the external effect finished. Maka does not let the model guess, and does not reinterpret "no result" as "not executed." Tool bindings can declare recovery semantics, such as natural idempotency, support for observing an existing outcome, or a prohibition on automatic retry. Without enough evidence, the runtime parks the operation for stronger observation or human intervention.

Recovery remains append-only. The runtime does not edit the old `function_call` or fabricate a past that never happened. Dispatch, outcome, reconciliation, and recovery decisions are appended as new facts. Old facts remain unchanged; later facts explain how the operation eventually converged.

Resume becomes safe only after every tool call has been classified as completed or definitely not dispatched.

"Replay" is easy to misunderstand here. Maka does not execute historical tools again, nor does it resurrect the old process's promises, JavaScript stack, sockets, or child processes. It replays the valid history that the model had already observed: user messages, model output, paired `function_call` and `function_response` events, and other facts admissible to provider context.

```text
Immutable RuntimeEvent Prefix
            │
            ├── Resolve tool operations
            ├── Discard streaming partials
            ├── Preserve paired calls and responses
            ├── Trim an interrupted, non-replayable suffix
            └── Validate high-water and digest
                         │
                         ▼
              Verified Provider Replay
                         │
                         ▼
              New Run / Invocation / Turn
```

The append-only structure makes this natural. Resume does not infer progress from objects left in old process memory or reconstruct execution from UI state. It reads the immutable event prefix through a recorded high-water mark, verifies its digest, and projects the provider history required for the next inference.

The continuation receives new run, invocation, and turn identities, and records the source run and event high-water from which it continues. It does not duplicate the original user message, and completed tools do not execute again. A continuation inherits verified causal history, not a list of commands waiting to be rerun.

Before invoking the model, Maka also rechecks the external conditions on which that history depends: whether the workspace is still the same workspace, whether required tool bindings still exist, whether background processes and child tasks have converged, and whether another continuation already claimed the same recovery boundary. If any condition cannot be proven, resume parks instead of carrying old conclusions into a changed world.

Maka's Resume is therefore not "continue executing code from the crash instruction pointer." It first gives every real-world action a trustworthy conclusion in the log, then creates a new execution from an immutable and verified history. Tool-call recovery answers whether an action happened. The append-only log answers which facts the model may continue from.

Once real-world actions reliably settle into log facts, resume stops being an attempt to rescue an old process. It becomes the problem of constructing a new runtime from history.

## Code Mode: When a Tool Call Becomes a Program

So far, every tool call in this discussion has happened one at a time.

The model chooses a next action, the runtime executes it, and the result returns to context. The model reads the observation, reasons again, and decides whether to call another tool. When every step requires semantic judgment, this is exactly how an agent should work.

But not every step deserves another model invocation.

Imagine an agent that must read twenty files, identify those containing a dependency, inspect each configuration, and report only projects with inconsistent versions. With ordinary tool calling, the model may request one read, inspect the result, request the next, and repeat. Every intermediate result enters context, while loops, filtering, and aggregation advance through repeated inference.

```text
Reason → Call → Observe → Reason → Call → Observe → ...
```

The task may require model judgment only when forming the initial plan and interpreting the final anomalies. Most of the middle is deterministic control flow. Asking an LLM to impersonate a `for` loop is slow, and burdens future context with every raw result.

Code Mode changes this layer.

Rather than emitting a separate top-level call for every action, the model writes a small program that invokes multiple tools. Loops, parallelism, branches, field extraction, and aggregation run inside a constrained code environment. The model sees only what the program elects to return.

```text
                  ┌─ Tool A ─┐
Reason → Program ─┼─ Tool B ─┼→ Filter / Join / Reduce → Observe → Reason
                  └─ Tool C ─┘
```

OpenAI Codex calls this execution shape Code Mode. The public Responses API describes the same class of capability as Programmatic Tool Calling: the model writes JavaScript that orchestrates available tools through `tools.*` in an isolated V8 runtime. Claude also provides Programmatic Tool Calling, using Python in a Code Execution Container and `allowed_callers` to specify which tools code may invoke.

The protocols differ, but express the same judgment: LLMs are good at forming plans and resolving semantic uncertainty; programs are better at executing control flow that has already become explicit.

This does not give the model an unbounded machine. A Code Mode program can reach only the capabilities exposed by the runtime. Writing network code does not create network access, and writing filesystem code does not bypass filesystem permissions. The program is an orchestration layer over tools, not a new source of authority.

Nor does it replace tool calling. Programmatic Tool Calling turns a linear sequence into a call tree: a model-generated program sits at the root, and the tools invoked by that program become its children. Every leaf still requires runtime validation, authorization, and execution.

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

The most visible gain is fewer model round trips. A loop or batch query that once required repeated sampling can run inside one program. Equally important, programmatic execution reduces context pollution. Code can process dozens of raw results and return only the few lines that matter. Tool results have not vanished; the portions that require no model understanding simply never enter the model's state space.

Code Mode and deferred tools therefore address two different kinds of tool-context pressure. Deferred tools reduce tool definitions loaded before inference. Code Mode reduces tool-result accumulation and model round trips during execution. The first controls the working set of capability descriptions; the second controls the working set of observations.

Not every sequence belongs inside a program. A write may need human approval. A search result may change the direction of an investigation. An unexpected UI message may require fresh semantic interpretation. Irreversible effects are also often easier for humans to understand and control as explicit top-level calls. Code Mode should move deterministic work downward, not hide every agent decision inside code.

Maka's Code Mode preserves that boundary. The model submits a JavaScript cell through an `exec` tool. The cell can invoke only currently active tools that explicitly allow nesting. The execution environment has no ambient process, filesystem, or network capability, and it enforces limits on time, memory, source size, result size, call count, and concurrency.

More importantly, every nested invocation returns to the same `ToolRuntime`. Argument validation, permissions, execution boundaries, and the T1/T2 durability semantics from the previous section do not disappear merely because code issued the call. Maka assigns each nested invocation its own identity and records its parent relationship to the outer `exec`.

Those internal calls are durable, but they do not reenter model history as a long sequence of calls and results. Runtime events mark them as originating from Code Mode and hidden from provider replay. The model sees the outer `exec` and its final result. Again, Maka follows the same architecture: the log preserves complete facts, while provider context is a projection of those facts.

Code Mode also sharpens the recovery problem. A program may finish three tools and crash while awaiting the fourth. Rerunning the entire program after restart would repeat real actions that already completed. Maka therefore never automatically retries an interrupted `exec`. Existing nested outcomes remain in the log, while the outer cell receives an explicit interrupted result. A new model inference then decides how to continue.

The program is not a shortcut around reliability. It compresses reasoning round trips between model and runtime, but cannot compress facts that already happened in the world. The program and its call stack may be ephemeral. Every tool call that crosses a real execution boundary must still leave an auditable, recoverable record.

Tool calling moves the model from language into action. Code Mode takes another step: the model produces not just an action, but the structure among actions.

## Parallel Tool Calls: Async I/O for Agent Runtimes

Code Mode can call several tools concurrently from a program. Even without Code Mode, modern models can emit multiple tool calls in one assistant step.

This is commonly called Parallel Tool Calling, but "parallel" needs a precise meaning. The model does not observe the first result while deciding the second call. It commits the entire batch in one generation, so calls in that batch cannot have data dependencies based on tool results.

If the second action must consume the first result, it belongs in the next model step rather than the same batch.

```text
One Assistant Step

        ┌── Tool Call A ──→ Result A ──┐
Model ──┼── Tool Call B ──→ Result B ──┼──→ Next Model Step
        └── Tool Call C ──→ Result C ──┘

                    Fan-out / Fan-in
```

From the runtime's perspective, this resembles classic asynchronous I/O. Each tool call becomes an independently awaitable task. Once a task starts, the runtime does not need to hold a synchronous call stack for it. It can start other ready work, then wake the corresponding continuation when the filesystem, process, network, or remote service produces a result. Only after every task reaches a terminal state does the runtime hand the batch of results to the next model step.

The benefit is not merely that execution is "faster." Waiting overlaps. While one web search is waiting on the network, another search, file read, or child agent need not wait alongside it. End-to-end latency moves from the sum of independent I/O delays toward the longest delay on the critical path.

But an absence of result dependencies does not imply an absence of resource conflicts.

A model can emit `Read(a)` and `Edit(a)` together. It can ask two tools to replace the same session state. Neither call consumes the other's result, but both contend for one real resource. If the runtime simply hands the batch to `Promise.allSettled()`, observation order, write order, and overwrite behavior depend on unpredictable execution timing.

Maka [PR #4542](https://github.com/apache/maka/pull/4542) discusses this exact problem: how to preserve concurrency among independent I/O while giving conflicting operations a deterministic order.

It is tempting to place all responsibility in a central tool scheduler. Such a scheduler can predict which resources each call reads or writes, start non-conflicting work immediately, and queue conflicts in model-generated order. This provides a clear batch orchestration policy, but should not become the only source of resource correctness.

Classic async I/O offers a useful separation of concerns: executors schedule tasks; resource authorities manage resources.

A Tokio executor does not inspect futures to discover whether they touch the same Redis key or file. It runs futures that are ready. Mutual exclusion, reader/writer fairness, capacity, and wakeups live closer to the resource in an async mutex, an RwLock, a semaphore, or an actor that exclusively owns the state.

The same boundary applies to an agent runtime:

```text
Tool Batch
    │  Create tasks, retain result slots, propagate cancellation
    ▼
Resource Authority
    │  Resolve identity, queue, exclude, check versions, wake waiters
    ▼
Filesystem / Terminal / Browser / Session / Remote Service
```

Why must the authority resolve resource identity? Because the real resource is often not the string in a tool argument. `link/a` and `real/a` may refer to the same file through a symbolic link. Different UI tools may target the same browser tab. Different MCP tools may share one remote session. Only the layer that owns or executes against the resource can know whether two names identify the same thing and where the operation actually linearizes.

A lock that exists only inside the current tool-batch scheduler cannot protect against another turn, another agent, another process, or another code path reaching the same resource. Correctness must still hold at the point closest to the side effect. A batch scheduler remains valuable for reducing contention and creating deterministic orchestration, but it should not be the only lock.

Different resources need not pretend to share one conflict model. Files fit canonical-path, writer-fair read/write leases. Terminals and browsers resemble actors with exclusive state ownership. Concurrency limits for remote providers, MCP servers, and child agents are capacity concerns and fit semaphores. Revisioned session state may use compare-and-swap. These systems share an asynchronous lifecycle, not one universal lock.

This is also why resource conflict and capacity must remain separate:

- Resource conflict asks whether two actions can happen concurrently without violating correctness.
- Capacity asks how much work the system is willing to run concurrently.

Representing an API rate limit as a global resource conflict can reduce concurrency, but introduces unrelated head-of-line blocking: a slow request stalls a file read that shares no resource with it. Async I/O instead blocks only work that is genuinely not ready and lets independent work proceed.

For actual conflicts, provider array order can serve as a stable tie-breaker. It must not be misread as a data dependency. The model did not see any intermediate result while generating the batch. Order can say who acquires a contended resource first; it cannot mean that a later call consumed an earlier result.

Parallel tool calling therefore contains at least four distinct orders:

```text
Model generation order
    ≠ Task start order
    ≠ Task completion order
    ≠ Runtime event arrival order
```

An independent later task may start or finish first. Live events should enter the log in the order facts actually occur, carrying tool call IDs for causal association. Results sent to the provider can still be reassembled in original call order. Factual order and provider-protocol order are different projections of the same execution.

Cancellation and failure must also obey the async lifecycle. A queued task that is cancelled must never start later. A task that already crossed T1 cannot be treated as nonexistent; the runtime must let it settle and record its outcome. An ordinary tool failure can return as one result alongside its siblings. A T1 or T2 persistence failure, however, should prevent queued work from acquiring dispatch permission. Active work must wind down safely while not-yet-started work freezes.

This has the flavor of structured concurrency. A parent batch does not launch a collection of promises and walk away. It owns their lifetimes. Before the next model inference begins, every child task must have completed, been cancelled, or reached an explicit recoverable state.

Parallel Tool Calling is therefore not fully described by saying "tools run at the same time." The hard part is drawing boundaries among three goals: overlap independent I/O, preserve correctness for shared resources, and give the batch a coherent lifecycle under cancellation, failure, and recovery.

The model expresses concurrent intent. The batch runtime joins it structurally. Resource authorities decide which concurrency reality permits.

## Sandboxes and Serverless: Giving an Agent a Disposable Computer

A tool call ultimately has to run somewhere.

The model can emit an invocation and write an orchestration program, but it cannot conjure CPU, memory, filesystems, or network connections. JavaScript execution, Python processes, dependency installation, test runs, and browser automation all consume real computing resources.

The lightest environment may be a JavaScript V8 isolate. It starts quickly and provides a narrow boundary suitable for short Code Mode control flow. Data analysis and large library ecosystems may call for a Python runtime. Tools that need a complete filesystem, system commands, compilers, and background processes naturally lead to containers or even microVMs.

```text
LLM emits intent
      │
      ▼
Agent Runtime
      │  Select environment and capabilities
      ▼
┌──────────┬──────────────┬─────────────┐
│ V8       │ Python       │ MicroVM     │
│ Orchestr.│ Data/scripts │ Full OS tools│
└──────────┴──────────────┴─────────────┘
      │
      ▼
Filesystem / Process / Network / Browser
```

Heavier is not always better. Starting a VM for every small tool call is wasteful; running untrusted system commands inside the runtime process is unsafe. The runtime should select an execution substrate that is light enough for the task and strong enough for the isolation it requires.

A sandbox is therefore more than a wall around dangerous model-generated code. It is the resource boundary, fault boundary, and lifecycle boundary of one agent execution.

The runtime can limit CPU, memory, disk, concurrency, and elapsed time. It can decide whether the sandbox has network access, which paths it can see, and which external services it can invoke. If code loops forever, exhausts memory, or crashes a process, the environment can be terminated without spreading the failure across the agent system.

More importantly, the sandbox separates an agent from the machine currently running it.

Traditional desktop software often assumes that a process and its local state persist. Agent execution environments should be assumed to disappear at any moment. A V8 cell ends when its code finishes. An idle container can be reclaimed. A microVM can vanish because of timeout, migration, preemption, or host failure. Recovery becomes nearly impossible if the agent's authoritative state lives inside those temporary environments.

This is where the append-only log returns.

Conversations, tool calls, results, permission decisions, and recovery facts live in a durable log. Files, media, and oversized results live in external artifact storage. Workspaces can be reconstructed from persistent volumes, snapshots, or objects. The sandbox carries only the computation currently in progress. It can be destroyed and recreated on another machine.

```text
Durable State                         Ephemeral Compute

RuntimeEvent Log ─┐                 ┌─ V8 Isolate
Artifact Storage ─┼─→ Rehydrate ────┼─ Container
Workspace Snapshot┘                 └─ MicroVM

        Preserves what happened        Executes what happens next
```

Serverless and agents fit naturally because agent workloads are bursty. While the model reasons, the sandbox may have nothing to do. When a call arrives, it may suddenly need computation. Some tasks last milliseconds; others compile a large project or wait on long-running I/O. An ideal compute layer appears on demand, scales to zero while idle, and assigns different resource shapes according to tool requirements.

Agent serverless cannot, however, be a simple copy of traditional Function as a Service. A conventional function receives input, computes, and returns. An agent also maintains a workspace, starts background processes, waits for approvals, calls external tools, and resumes hours later. It does not need an immortal process. It needs a protocol that reconnects durable state to ephemeral compute.

When a sandbox disappears, the runtime should not try to restore its heap, promises, or stack frames. It should use the log to determine which tools ran and which outcomes committed, mount the necessary workspace and artifacts into a fresh environment, and start the next execution from a trustworthy historical prefix.

Serverless does not mean the agent has no state. It means the state belongs to no individual computer.

This architecture also changes permissions. A sandbox need not hold permanent credentials for every cloud service or receive ambient network access. It gets only the capabilities needed by the current task. Secrets, approvals, and resource authorities remain outside. Code may request an action, but the external runtime still decides whether that action may cross the boundary.

Once execution is cheap enough, agents can scale in a new way. A short orchestration rents V8, data processing rents a Python container, and a complete software build rents a microVM. Child agents can run concurrently in isolated workspaces, then release every resource when they finish.

Take this one step further: put every session in cheap S3-compatible object storage, and make the compute layer entirely out of inexpensive, short-lived, replaceable execution resources.

This is complete disaggregation of storage and compute.

A session no longer corresponds to an object in one process or a directory on one machine. It becomes a set of durable objects: append-only event segments, artifacts, workspace snapshots, compaction projections, and a manifest pointing to the current trustworthy prefix. After a conversation turn, no runtime needs to remain resident in memory. The session can rest in object storage while consuming almost no compute.

```text
                    Cheap Durable Storage

Session A ── Events / Artifacts / Workspace Snapshots ─┐
Session B ── Events / Artifacts / Workspace Snapshots ─┼── S3
Session C ── Events / Artifacts / Workspace Snapshots ─┘
                                                       │
                         Event / User / Schedule        │
                                   │                   │
                                   ▼                   │
                         Rehydrate a Session ◀─────────┘
                                   │
                       ┌───────────┼───────────┐
                       ▼           ▼           ▼
                      V8        Python      MicroVM
                       │           │           │
                       └───────────┴───────────┘
                                   │
                              Append Facts
                                   │
                                   └──────────────→ S3
```

A "long-running agent" no longer requires a long-running machine.

It can remain dormant most of the time. When a user message, timer, webhook, or background completion arrives, the scheduler reads the session manifest, loads the required log prefix and workspace snapshot, and assigns a new sandbox. When the task finishes, new facts and artifacts return to object storage and the compute environment is released.

The agent is not continuously alive. It is continuously awakenable.

S3 is no longer merely backup media in this design. It can hold the factual state of the agent. Memory, SQLite, local SSD, vector indexes, and provider context on hot machines become caches or projections. They can accelerate reads, but they should not determine whether the session still exists. Lose the machine and rebuild the cache. Preserve the trustworthy history in object storage and the agent survives.

Putting a session in S3 does not mean repeatedly appending in place to one giant object. A natural design writes immutable event segments and artifacts, then advances a small manifest or head pointer to the latest committed prefix. Leases, compare-and-swap, idempotency keys, and in-flight operation state still require a strongly consistent control plane. The large bodies of history, tool output, filesystem snapshots, and media can live in cheap object storage.

The system separates naturally into two layers:

- The data plane stores immutable, voluminous, rarely modified session state.
- The control plane stores small, strongly consistent heads, leases, admissions, and operation state.

This resembles storage-compute disaggregation in modern databases. Object storage provides vast, inexpensive, durable capacity. Compute nodes appear only when a query or mutation needs them. Here the object being queried and continued is not a table. It is an agent's history.

From this perspective, model context is itself a query. The runtime reads durable session state from S3 and applies compaction, tool-result pruning, visibility, and provider-compatibility projections to construct what the model should see now. The model's next output does not rewrite the past; it appends new facts.

```text
Session on S3
      │
      ├── Projection ──→ Model Context ──→ LLM
      │                                      │
      ├── Rehydrate ───→ Sandbox ───────→ Tool Call
      │                                      │
      └──────────────── Append New Facts ◀───┘
```

Both the LLM and the sandbox now become compute resources.

Model capacity can be rented according to task difficulty: an inexpensive model for routine work, a stronger model for difficult judgment. Execution capacity can likewise match capabilities: an isolate for orchestration, a container for scripts, a microVM for operating-system tools. A session belongs to no particular model and no particular sandbox.

This creates a different agent economy. Cost no longer depends primarily on how many sessions exist, but on how many are thinking and acting now. Ten million dormant sessions can be ten million object prefixes. Only the small active fraction consumes model tokens, CPU, and memory.

The cheapest agent is not an agent running on a smaller server. It is an agent with no server at all while asleep.

Disaggregation also makes preemptible compute practical. Workers can come from inexpensive instances, shared pools, or capacity that may disappear at any time. Previously, killing a machine running an agent meant losing the conversation. Once state is externalized, losing a worker means losing only a temporary execution. The runtime classifies real-world effects through T1 and T2, then continues the session on another compute resource.

Branching and forking also become cheap. Append-only history and copy-on-write workspace snapshots let several agents share one historical prefix and grow independent suffixes. Spawning a child agent need not copy the entire session. It records the prefix and snapshot from which it starts. Unchanged artifacts remain shared; only new facts consume new storage.

Even model upgrades need not migrate sessions. History retains provider-neutral runtime facts, and a new model receives a projection suited to its protocol. One durable session can run on one model today and resume on another months later. The identity of an agent comes from the history it has lived through, not from the model weights currently loading it.

The security boundary becomes cleaner as well. S3 holds encrypted, auditable long-term state. A sandbox receives minimal capabilities only for its short lifetime. Secrets need not enter workspace snapshots, and permanent cloud credentials need not enter microVMs. When code needs an external resource, it asks an outside authority for one constrained operation. If the compute environment is compromised, its authority expires with the environment.

Cheap compute does not automatically create correctness. An inexpensive microVM cannot make a duplicate payment safe. A restartable container cannot determine whether an email was sent before a crash. The more disposable workers become, the more the system depends on reliable tool calls, idempotent operations, resource authorities, and append-only logs to prove what happened in the real world.

This is more than "run agents on serverless." We are assembling a new kind of computer for agents:

```text
S3                 is its inexpensive durable disk
Append-Only Log     is its recoverable state
LLM                 is its rented reasoning unit
Sandbox / MicroVM   is its rented body
Agent Runtime       is the operating system connecting them
```

Discussion of agents today often centers on models. But models produce judgment and intent. Applying that intent to reality safely, reliably, and economically requires vast amounts of on-demand execution, together with session state that outlives every execution environment.

The core infrastructure of future agents will include extremely cheap storage and extremely cheap compute. Storage lets hundreds of millions of sessions persist. Compute lets any one of them wake immediately when needed. The bridge is not the memory of one machine, but a history that can be replayed, verified, and extended.

Look back across the tool stack. Deferred tools decide which capabilities deserve the model's attention. Tool calls turn language into action. Reliable execution makes action a trustworthy fact. Code Mode expresses structure among actions. The async runtime overlaps waiting. Sandboxes and serverless provide the CPU, memory, and isolation that all of those layers consume.

Ultimately, an agent is not a long-lived process that happens to save some state.

**An agent is durable state that temporarily rents a model and a computer whenever it needs to think and act.**

It sleeps in cheap S3. When an event arrives, the log tells it who it used to be, the sandbox defines what it may do now, and inexpensive compute lets it move forward.

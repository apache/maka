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

[简体中文](./serverless-agent-runtime.zh-CN.md)

# From Stateless Functions to Agent Runtimes: The Serverless Scheduling Unit Is Growing

Serverless is often reduced to a simple idea: run a short-lived, stateless function.

That description captures the most familiar product form, but not the underlying systems principle. Serverless is first and foremost a **resource execution contract**: when demand arrives, the platform finds and materializes a computing environment that satisfies the workload's requirements; when the work is done, the caller no longer owns that machine. Whether the platform destroys the environment, freezes it, or returns it to a pool is an implementation choice, not a promise made by the application.

Agents make this distinction important again. An agent may invoke tools repeatedly, modify files, start interpreters and browsers, wait for external events, and then continue from where it left off. If every interaction recreates a stateless function, restoring the working environment may cost more than performing the task itself.

This raises a new question: **Must the scheduling unit of Serverless be a stateless function?**

OpenSandbox, CubeSandbox, and Agent Substrate offer three different answers. They expand the scheduling unit into a complete Sandbox, a resumable microVM, and an Actor that can be reactivated on different Workers, respectively. This article does not attempt to rank the three projects. Instead, it uses them to examine how Agent Runtimes are reshaping Serverless.

## 1. Serverless Materializes Resources on Demand

Set Lambda and functions aside for a moment. A Serverless execution can be modeled as follows:

```text
Demand arrives
  -> admission and routing
  -> find capacity that satisfies CPU, memory, and isolation requirements
  -> materialize an execution environment
  -> inject code, input, configuration, and permissions
  -> execute and commit the result
  -> freeze, reuse, or destroy the environment
```

The essential property is not that the program runs for only a few milliseconds. It is that **the binding between a logical program and physical resources is temporary**. Callers neither manage the server nor base correctness on the assumption that the next invocation will return to the same Worker. The platform may retain a warm environment, but that environment can only be an optimization; application correctness cannot depend on it.

Every Serverless platform must therefore reconcile the same tension:

```text
Application: resources should already be ready when demand arrives.
Platform: expensive resources should not remain allocated when there is no demand.
```

Cold starts, warm pools, snapshot restoration, resource overcommit, and multi-tenant scheduling are all attempts to balance these goals. The Berkeley view of Serverless likewise treats elastic scaling, pay-per-use pricing, and hidden server management as defining characteristics, rather than reducing Serverless to "short functions."[^serverless-berkeley]

Four dimensions provide a useful framework for evaluating whether an Agent Runtime has Serverless properties:

| Dimension | Question |
|---|---|
| Startup latency | How much materialization work is required between demand arriving and the environment becoming executable? |
| Idle cost | How much CPU, physical memory, and scheduling quota remain allocated when no work is running? |
| State fidelity | Which parts of the rootfs, process state, memory, and network state survive restoration? |
| Scheduling freedom | Can the next execution run on different capacity, and what locality constraints remain? |

Resource discussions must also distinguish several concepts that are routinely collapsed into a single phrase, "memory usage":

```text
Resource limit          Maximum permitted usage
Scheduler request       Capacity reserved in the scheduler's accounting
Guest RAM / VA          Address space visible to the guest or mapped by the VMM
RSS / PSS               Physical pages currently resident in memory
```

Configuring `1 GiB` may set a number in only one of these layers. Whether that reservation immediately becomes 1 GiB of physical memory depends on the implementation.

## 2. Stateless Functions Were the First Engineering Solution

The simplest way to let the next invocation run on any machine is not to make the scheduler remember the previous machine. It is to make application correctness independent of that machine:

```text
output = function(input, external_state)
```

Business entities go into databases, files into object storage, invocation coordination into queues and workflows, and secrets and configuration into external services. The execution environment retains only the code, memory, and temporary cache required by the current invocation.

Once state is externalized this way, any compatible Worker can process the next request, and failed executions can be retried elsewhere. **Statelessness is not the goal of Serverless. It was the mechanism that gave the first generation of Serverless systems scheduling freedom.**

Nor does "stateless" mean that a warm environment can contain no state whatsoever. Connection pools, global objects, and temporary files may all survive. The actual constraint is:

> The correctness of the next invocation cannot depend on the previous execution environment still existing.

For the rest of this article, it is useful to divide state into three categories:

```text
Authoritative state   State that must survive after an instance disappears
Execution state       Current CPU, processes, memory, writable rootfs, and network context
Acceleration state    Warm Pods, cached template pages, golden snapshots, and similar optimizations
```

For an ordinary function, Execution state is usually disposable. For an agent, losing it can be expensive: installed dependencies, an in-progress workspace, interpreter variables, browser pages, and background tool processes may all be part of the next step of work.

Agents expose the limits of stateless functions. The answer may not be to abandon Serverless, but to enlarge its scheduling unit: an environment can remain stateful within its lifetime while still being materialized, paused, and reclaimed on demand.

## 3. OpenSandbox: A Leased, Temporary Computer

From the caller's perspective, OpenSandbox does not expose a function invocation. It exposes a remote, temporary computer:

```python
sandbox = await Sandbox.create(
    image="python:3.12",
    resource={"cpu": "1", "memory": "1Gi"},
    timeout=600,
)

await sandbox.files.write(...)
await sandbox.commands.run(...)
await sandbox.kill()
```

The caller submits an image or snapshot, entry command, environment variables, resources, network policy, and TTL, and receives a stable `sandboxId`. It can then execute multiple commands, read and write files, and maintain sessions inside the same Sandbox. The SDK also constructs file, command, health-check, and other services around that same ID during creation.[^opensandbox-api]

The logical scheduling unit in OpenSandbox is therefore not a single `commands.run()` call, but an entire Sandbox lifetime:

```text
create
  -> multiple command / file / session operations
  -> pause / resume / renew
  -> kill or TTL expiration
```

The Sandbox is explicitly stateful within that lifetime. The caller does not need to know whether a Docker container, Kubernetes Pod, or Kata microVM ultimately hosts it, but it still manages when this temporary computer is created, paused, and destroyed.

This is the first boundary between OpenSandbox and traditional FaaS. FaaS typically releases the binding when an invocation ends; OpenSandbox can release the current compute only when the broader Sandbox lifetime permits it.

For the purposes of this article, we can call this abstraction a **Serverless Computer**. This is not an official project category, but an analytical lens: instead of delivering only a function entry point, the platform delivers a complete, programmable computer with a lease.

## 4. OpenSandbox: Making a Complete Environment Serverless

OpenSandbox supports Docker and Kubernetes backends. On the Kubernetes path, it separates the logical Sandbox from its current execution instance:

```text
Sandbox ID / CR   Logical identity, template, TTL, and desired state
Pod / Pod IP      Current execution instance and endpoint
```

OpenSandbox externalizes the Sandbox identity, template, TTL, OCI base image, network policy, and optional PVC or object storage. Kubernetes materializes those declarations as a Pod. When a Kata RuntimeClass is configured, Kubernetes, containerd, and Kata remain responsible for microVM creation and its resource overhead.

The current process tree, anonymous memory, Shell session, network namespace, and open connections still belong to the current Pod. OpenSandbox's Kubernetes pause operation commits the container's writable rootfs, releases the Pod, and rebuilds it from the new OCI image on resume. It does not checkpoint processes or memory.[^opensandbox-pause]

Restoration therefore preserves **committed filesystem state and declarative configuration**, not the complete execution context. If a Pod disappears, the logical CR can reconcile a new instance, but unexternalized local writes, processes, memory, and connections do not return automatically.

The resource accounting also clarifies a common question: if a Sandbox is configured with 1 GiB, does the service consume 1 GiB? OpenSandbox writes `resourceLimits` to the main sandbox container. If the caller does not separately provide `resourceRequests`, the implementation defaults the main container's `requests` to its `limits`.[^opensandbox-resources]

On the Kubernetes path, configuring `memory=1Gi` therefore asks the scheduler to reserve 1 GiB for the main container and sets the same value as its limit. The complete Pod may also include other containers, init-container rules, and RuntimeClass overhead. **This does not mean the process immediately acquires 1 GiB of RSS, but it does consume the corresponding amount in the scheduler's capacity ledger.**

OpenSandbox uses Pools to reduce cold-start latency by maintaining a set of complete Ready Pods that can be claimed immediately. Pool configuration explicitly defines lower and upper bounds for the warm buffer.[^opensandbox-pool]

```text
Larger warm Pool
  -> lower allocation latency
  -> more resident Pods and VMs, and more scheduler reservations
```

OpenSandbox has thus brought complete working environments under a Serverless control plane, but its central trade-off remains familiar: either wait for a complete Pod to be created, or pay the idle cost of keeping complete Pods warm.

The next question follows naturally: if a complete Pod is an expensive unit to materialize, can the platform reduce the marginal cost of each temporary computer instead of accumulating more warm Pods?

## 5. CubeSandbox: A microVM That Can Restore Its Execution Context

CubeSandbox presents a caller experience similar to OpenSandbox: select a Template, create a Sandbox with a stable `sandboxID`, and then perform multiple code, command, file, PTY, and network operations.

```python
sandbox = Sandbox.create(template="agent-python")
sandbox.run_code("x = 1")
sandbox.run_code("print(x)")
sandbox.pause()
sandbox.resume()
```

`run_code()` sends requests through a proxy to `envd` inside the VM and reuses the interpreter's global namespace by default.[^cubesandbox-api] Once again, the managed object is not an individual code invocation, but a persistent Sandbox.

CubeSandbox's key distinction is that the caller can do more than destroy the environment: it can pause, resume, snapshot, roll back, and clone it. A successful pause terminates the current live microVM while preserving recoverable VM state. Resume can retain the same logical `sandboxID`, select a node again, and create a new microVM.

From the application's perspective, this is still a temporary computer. From the platform's perspective, **the logical Sandbox is no longer identical to the current VMM process**. Once the latest recoverable state has been committed successfully, the current microVM can disappear.

## 6. CubeSandbox: Separating Declared Capacity from Physical Residency

CubeSandbox controls the entire path from its API and scheduler to its Shim, VMM, and guest agent. Its central mechanism is not merely that it uses microVMs, but that many Sandboxes share the Template's base state:

```text
Template rootfs       --reflink / CoW--> Sandbox rootfs
Template memory file  --MAP_PRIVATE----> Sandbox guest memory

Untouched pages: do not become physically resident
Read-only pages: can remain shared file-cache pages
Written pages: become anonymous CoW pages private to the current VM
```

When restoring snapshot-backed guest memory, CubeSandbox's VMM uses `MAP_NORESERVE | MAP_PRIVATE`. Its code comments also distinguish untouched pages, read-only file-backed pages, and anonymous CoW pages produced after writes.[^cubesandbox-memory]

This explains why a Sandbox declaring `2 GiB` of guest memory does not immediately reserve 2 GiB of physical memory exclusively for itself at startup. Actual residency more closely tracks the guest working set, private dirty pages, and fixed VMM overhead.

That does not mean the declared 2 GiB disappears from resource accounting. The memory still enters CubeSandbox's scheduling ledger, whose default scheduling capacity uses a 2x memory and 3x CPU overcommit ratio.[^cubesandbox-overcommit] In other words:

```text
Declared capacity     Determines guest limits and the scheduling allocation unit
Scheduling capacity   Permits controlled overcommit
Physical residency    Grows with actual access and CoW writes
```

This distinction is essential to understanding the phrase "a 4 MB Sandbox." The project's reported figure of roughly `4-5 MiB` refers to **VMM overhead PSS**, not the total memory footprint of a complete Sandbox. A separate create-only test of 1,000 idle instances, each declaring 2 vCPU and 2 GiB, measured changes in machine-wide `free available` memory and reported an amortized increase of approximately `21.5-25.7 MB` per instance.[^cubesandbox-benchmark] The two figures have different measurement boundaries. They are not interchangeable, and neither should be compared directly with another system's Pod RSS.

Pause introduces a second level of resource separation. CubeSandbox saves VM state, memory, and rootfs, then destroys the current microVM, allowing its physical CPU and memory to be reclaimed.[^cubesandbox-pause] By default, however, `paused_resource_release_ratio=0`, so a paused Sandbox retains its full scheduling quota to make resume more predictable. Operators can release some or all of that quota to increase density, but restoration then becomes best effort.[^cubesandbox-paused-quota]

CubeSandbox's Serverless properties therefore do not come from making resource numbers disappear. They come from three separations:

```text
Declared guest RAM != physical memory fully resident at startup
Logical Sandbox    != current microVM process
Startup baseline   != a complete private memory copy for every instance
```

The cost remains real. CoW and overcommit do not create physical capacity. If many lightly loaded VMs begin writing across their entire memory allocations at once, the platform still needs real-time capacity filtering, node reservation thresholds, cgroups, and admission control to protect the host.

Even if each individual microVM becomes cheap enough, a higher-level question remains: must a long-lived Agent identity always be identical to a Sandbox object?

## 7. Agent Substrate: An Actor That Can Sleep

Agent Substrate moves the logical unit up another level. The caller creates a long-lived Actor, not a Sandbox that begins running immediately. Create first writes a logical record with an initial state of `SUSPENDED`; it does not immediately create a dedicated Pod or start a process.[^substrate-create]

The caller receives a stable Actor identity and address. When a business request arrives and the Actor is not running, the Router triggers Resume, assigns the Actor to a ready Worker, and forwards traffic to it.

```text
Long-lived logical Actor
  -> Resume
  -> an active sprint
  -> handle multiple requests and modify memory and files
  -> Pause or Suspend
  -> release the Worker
```

The Actor does not end when one HTTP request completes, and this is not the traditional FaaS model of one instance per request. The true scheduling unit is an **Actor activation**.

We can call this a **Serverless Actor**. The Actor has a long logical lifetime, while a Worker sandbox is merely the execution vehicle assigned during one active interval. The application identity can persist even though expensive compute is bound only while work is occurring.

## 8. Agent Substrate: Time-Multiplexing Actors onto Workers

Substrate leaves Kubernetes on the relatively slow path of managing the Worker fleet, while removing high-frequency Actor activation from the kube-scheduler's critical path:

```text
Kubernetes
  -> maintain M ready Worker Pods in advance

Substrate
  -> store N logical Actors in the database
  -> select a ready Worker at activation time
  -> start or restore a gVisor sandbox inside the Worker
  -> terminate the sandbox after checkpointing and release the assignment
```

"Multiplexing" must be understood precisely here. The current code explicitly limits each Worker to one active Actor, while WorkerPool materializes complete Pods in advance through a Kubernetes Deployment.[^substrate-worker] Substrate therefore performs **time multiplexing of many suspended Actors over a smaller number of warm Workers**. It does not pack many concurrently active Actors into one Worker.

It provides two distinct inactive states:

| Operation | State location | Restoration characteristics |
|---|---|---|
| Pause | Checkpoint remains on the original node | Faster restoration, but constrained by node locality |
| Suspend | Checkpoint is uploaded as an external snapshot | Can restore on a different Worker or node |

Pause requests a node-local checkpoint and then releases the Worker assignment. Suspend writes the checkpoint to an external location and records it as the Actor's latest successfully committed recoverable state.[^substrate-pause-suspend]

Snapshot scope determines how much Execution state survives. `FULL` is designed to preserve processes, memory, rootfs changes, and DurableDir through backend checkpointing; `DATA` preserves only DurableDir and restarts the application during restoration.[^substrate-scope] Here, `FULL` describes the interface contract and the checkpoint/restore capability of a particular backend. It should not be read as an unconditional continuity guarantee for arbitrary external connections.

Substrate's resource accounting therefore has two layers:

```text
WorkerPool request
  -> shared compute capacity reserved by Kubernetes

Actor limit
  -> Substrate placement and sandbox cgroup limits
  -> a suspended Actor does not add another Kubernetes Pod request
```

If a system contains ten thousand logical Actors but only one hundred are active concurrently, it can theoretically maintain a Worker fleet sized near active concurrency plus headroom. Storage cost grows with the number of Actors and snapshots, while compute cost primarily tracks the warm Worker baseline and active Actors.

The current implementation still requires participation from the layer above. Repository examples explicitly invoke Suspend to release a Worker; they do not demonstrate a general automatic idle-suspension loop. Losing a Worker may also move an Actor without a successfully committed checkpoint into `CRASHED`, rather than transparently rolling it back to any previous state.[^substrate-idle-failure]

Substrate is therefore not simply a system with "smaller Pods." It defines a different resource relationship:

```text
Actor lifetime       != Worker lifetime
Stored Actor count   != Reserved Worker count
Request routing      != Kubernetes Pod scheduling
```

## Conclusion: Serverless Does Not Mean Stateless Functions

Placing the three systems on the same axis reveals a continuous evolution:

```text
Stateless FaaS
  invocation -> worker

OpenSandbox
  sandbox lifetime -> container / Pod / VM

CubeSandbox
  logical sandbox -> snapshot-backed microVM

Agent Substrate
  actor activation -> ready worker sandbox
```

OpenSandbox addresses how to deliver and manage a complete computing environment through one control plane. CubeSandbox addresses how to reduce the materialization and residency cost of a complete microVM. Agent Substrate addresses how a long-lived logical Actor can occupy a Worker only while active.

None of the three systems is stateless. What they inherit from Serverless is the continued removal of two bindings:

1. The permanent binding between a logical identity and one physical instance.
2. The binding between long-lived application state and the continuous occupation of expensive compute resources.

For agents, the question is no longer "How do we force this program into a function?" It is:

> Can a long-lived, stateful logical program own a computer only while it is doing useful work?

At the next layer up, an agent's authoritative state can be decomposed further into Session, Filesystem, and Agent Memory. A context service can retrieve that state and inject it into different Runtimes at activation time. That is a state model above the compute layer. The point here is more fundamental: as long as logical identity, recoverable state, and physical execution instances are separated cleanly, stateful agents are not inherently at odds with Serverless.

---

## References and Source Revisions

This article was prepared on September 5, 2026, against the following source revisions. All performance figures are reported by the respective projects and were not reproduced on common hardware or under a common workload. They therefore do not constitute a cross-project benchmark.

[^serverless-berkeley]: Eric Jonas et al., [Cloud Programming Simplified: A Berkeley View on Serverless Computing](https://arxiv.org/abs/1902.03383), 2019.

[^opensandbox-api]: OpenSandbox commit `8720eecc`, [Python SDK `Sandbox.create`](https://github.com/opensandbox-group/OpenSandbox/blob/8720eeccfefc42ccca0a0d565f0942906cefee77/sdks/sandbox/python/src/opensandbox/sandbox.py#L506-L624).

[^opensandbox-pause]: OpenSandbox commit `8720eecc`, [Kubernetes pause/resume lifecycle and preserved state](https://github.com/opensandbox-group/OpenSandbox/blob/8720eeccfefc42ccca0a0d565f0942906cefee77/docs/guides/pause-resume.md#L39-L79).

[^opensandbox-resources]: OpenSandbox commit `8720eecc`, [main container requests default to limits](https://github.com/opensandbox-group/OpenSandbox/blob/8720eeccfefc42ccca0a0d565f0942906cefee77/server/opensandbox_server/services/k8s/provider_common.py#L158-L183).

[^opensandbox-pool]: OpenSandbox commit `8720eecc`, [Pool warm buffer and capacity fields](https://github.com/opensandbox-group/OpenSandbox/blob/8720eeccfefc42ccca0a0d565f0942906cefee77/kubernetes/apis/sandbox/v1alpha1/pool_types.go#L48-L87).

[^cubesandbox-api]: CubeSandbox commit `ddddcc25`, [Python SDK `Sandbox.create`](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/sdk/python/cubesandbox/sandbox.py#L183-L220) and [`run_code`](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/sdk/python/cubesandbox/sandbox.py#L387-L417).

[^cubesandbox-memory]: CubeSandbox commit `ddddcc25`, [snapshot memory mapping](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/hypervisor/vmm/src/memory_manager.rs#L1495-L1545) and [CoW page classification](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/hypervisor/vmm/src/pagemap_anon.rs#L5-L17).

[^cubesandbox-overcommit]: CubeSandbox commit `ddddcc25`, [default CPU and memory overcommit ratios](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/CubeMaster/pkg/base/config/config.go#L298-L369).

[^cubesandbox-benchmark]: CubeSandbox commit `ddddcc25`. The README describes low memory overhead as [`< 5MB`](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/README_zh.md#L232-L243), and its [memory chart](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/docs/assets/cube-sandbox-mem-overhead.png) labels the orange portion `VMM Overhead PSS (MiB)`. The fuller benchmark reports [machine-wide memory changes in a 1,000-instance create-only scenario](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/docs/zh/blog/posts/2026-06-01-cubesandbox-perf-benchmark.md#L226-L264).

[^cubesandbox-pause]: CubeSandbox commit `ddddcc25`, [pause produces a CoW-backed snapshot and destroys the live sandbox](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/Cubelet/services/cubebox/pause_cow.go#L93-L101); [resume recreates the microVM under the desired sandbox ID](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/CubeMaster/pkg/service/sandbox/sandbox_resume_pause.go#L341-L429).

[^cubesandbox-paused-quota]: CubeSandbox commit `ddddcc25`, [paused resource release policy](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/docs/zh/guide/lifecycle.md#L227-L237).

[^substrate-create]: Agent Substrate commit `7a9abab3`, [Actor creation starts in `SUSPENDED`](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/actor.go#L69-L104).

[^substrate-worker]: Agent Substrate commit `7a9abab3`, [one active Actor per Worker](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/internal/ateomcapacity/ateomcapacity.go#L38-L46); [WorkerPool materialized as a Kubernetes Deployment](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/atecontroller/internal/controllers/workerpool_apply.go#L189-L211).

[^substrate-pause-suspend]: Agent Substrate commit `7a9abab3`, [Pause writes a node-local checkpoint](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/workflow_pause.go#L149-L208); Suspend [uploads the checkpoint](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/workflow_suspend.go#L269-L318), then [records the external snapshot and releases the Worker](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/workflow_suspend.go#L344-L410).

[^substrate-scope]: Agent Substrate commit `7a9abab3`, [snapshot content scope definitions](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/pkg/proto/ateapipb/ateapi.proto#L175-L183).

[^substrate-idle-failure]: Agent Substrate commit `7a9abab3`. The project example notes that auto-suspend-on-idle [is not yet implemented and explicitly invokes Suspend after each request cycle](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/demos/parking/load.sh#L17-L24); [an Actor that is still running enters `CRASHED` when its Worker disappears](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/workflow_worker_delete.go#L153-L164).

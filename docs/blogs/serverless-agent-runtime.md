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

Serverless is frequently simplified as running short-lived, stateless functions.

That description captures the most widespread product form, but misses the foundational systems principle beneath it. Serverless is first and foremost a **resource contract**: when workload demand arrives, the platform materializes a compute environment satisfying specified constraints; when demand ceases, the caller releases the underlying machine. Whether the environment is destroyed, frozen, or recycled into a pool is an implementation choice of the platform, not a contractual commitment made by application code.

The emergence of autonomous agents makes this distinction critical again. An agent typically performs iterative tool invocations, modifies files, drives interpreter and browser processes, suspends execution while waiting on external events, and subsequently resumes from its exact execution context. If every step requires instantiating an isolated stateless function from scratch, cold-start latency and environment hydration costs rapidly outstrip the actual execution workload.

This exposes a fundamental architectural question: **Must the scheduling unit of Serverless remain restricted to stateless functions?**

OpenSandbox, CubeSandbox, and Agent Substrate provide distinct engineering answers. They expand the scheduling unit into complete container sandboxes, resumable snapshot-backed microVMs, and addressable Actors dynamically activated across worker fleets. This essay analyzes how these three architectures navigate systems trade-offs and reframe the design boundaries of Serverless for Agent Runtimes.

## 1. Serverless Materializes Resources on Demand

Setting aside specific cloud product abstractions, a generalized Serverless execution lifecycle can be modeled as follows:

```text
Demand arrives
  -> admission and routing
  -> find capacity that satisfies CPU, memory, and isolation requirements
  -> materialize an execution environment
  -> inject code, input, configuration, and permissions
  -> execute and commit the result
  -> freeze, reuse, or destroy the environment
```

The defining characteristic of Serverless is that **the binding between a logical program and physical resources is temporary**. Callers neither manage the host server nor rely on assumptions that subsequent invocations will route to the identical physical worker. The platform may retain warm cached environments, but this serves strictly as a performance acceleration mechanism rather than a correctness invariant.

Serverless infrastructure continuously balances an inherent operational tension:

```text
Application: resources should already be ready when demand arrives.
Platform: expensive resources should not remain allocated when there is no demand.
```

Cold-start optimization, warm buffer pools, memory snapshot restoration, resource overcommit, and multi-tenant bin-packing all seek an equilibrium across this trade-off. The classic Berkeley analysis of Serverless computing similarly identifies elastic scaling, usage-based billing, and abstracted server management as defining tenets, rather than brief execution durations.[^serverless-berkeley]

Evaluating whether an Agent Runtime exhibits Serverless properties centers on four primary dimensions:

| Dimension | Question |
|---|---|
| Startup latency | How much materialization work is required between demand arriving and the environment becoming executable? |
| Idle cost | How much CPU, physical memory, and scheduling quota remain allocated when no work is running? |
| State fidelity | Which parts of the rootfs, process state, memory, and network state survive restoration? |
| Scheduling freedom | Can the next execution run on different capacity, and what locality constraints remain? |

When analyzing resource consumption, systems engineering requires distinguishing four concepts frequently conflated under generic memory metrics:

```text
Resource limit          Maximum permitted usage
Scheduler request       Capacity reserved in the scheduler's accounting
Guest RAM / VA          Address space visible to the guest or mapped by the VMM
RSS / PSS               Physical pages currently resident in memory
```

Configuring `1 GiB` often reflects a numerical quota at only one of these architectural tiers. Whether that declaration translates into immediate physical memory residency depends entirely on hypervisor and runtime implementation mechanics.

## 2. Stateless Functions Were the First Engineering Solution

To allow subsequent invocations to land on arbitrary nodes, system design decouples execution correctness from specific host identity:

```text
output = function(input, external_state)
```

Business entities persist to databases, files stream to object storage, invocation choreographies delegate to queues and workflows, and credentials reside in external configuration stores. The local execution sandbox retains only the code artifacts, ephemeral memory, and local caches necessary for the active request.

Under this model, any compatible worker can process succeeding requests, and failed executions safely retry across disparate nodes. **Statelessness was an engineering mechanism that provided scheduling freedom to first-generation Serverless architectures, isolating correctness from host topology.**

Statelessness does not preclude physical persistence within warm environments. Database connection pools, pre-warmed runtime heaps, and local scratch files may persist safely. The core invariant remains:

> The correctness of the next invocation cannot depend on the previous execution environment still existing.

To evaluate agent runtime architectures, this essay classifies execution state into three distinct tiers:

```text
Authoritative state   State that must survive after an instance disappears
Execution state       Current CPU, processes, memory, writable rootfs, and network context
Acceleration state    Warm Pods, cached template pages, golden snapshots, and similar optimizations
```

In traditional batch or microservice workloads, execution state can be discarded upon request completion. In agent workflows, however, this tier represents substantial computational investment: dynamically resolved packages, in-progress workspace edits, interpreter runtime variables, browser DOM trees, and background diagnostic processes all form immediate inputs to subsequent reasoning cycles.

Agents expose the boundaries of traditional stateless functions. The architectural progression lies in expanding the scheduling unit: allowing stateful environments to be materialized, suspended, and reclaimed on demand.

## 3. OpenSandbox: A Leased, Temporary Computer

From the caller perspective, OpenSandbox exposes a remote, temporary computer:

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

The caller specifies base OCI images or snapshots, entrypoint commands, environment variables, compute specifications, network isolation rules, and a time-to-live (TTL), obtaining a persistent `sandboxId`. The caller can then execute sequential commands, perform file I/O, and sustain interactive terminal sessions within that sandbox. The client SDK coordinates file management, command dispatch, and lifecycle health checks around that unified identifier.[^opensandbox-api]

The logical scheduling unit in OpenSandbox expands beyond a single `commands.run()` call into an entire Sandbox lifetime:

```text
create
  -> multiple command / file / session operations
  -> pause / resume / renew
  -> kill or TTL expiration
```

State persists continuously within the sandbox lifetime. The caller remains agnostic to whether a Docker container, Kubernetes Pod, or Kata microVM backs the workload, yet explicitly manages the allocation, suspension, and destruction of this temporary compute instance.

This marks the primary architectural boundary between OpenSandbox and conventional FaaS: FaaS releases resource bindings upon single invocation completion, whereas OpenSandbox retains capacity bindings across the composite lifecycle of the leased environment.

This article categorizes this abstraction as a **Serverless Computer**. Rather than an official project category, this serves as an analytical perspective: the platform delivers a complete, programmable computer leased on demand.

## 4. OpenSandbox: Making a Complete Environment Serverless

OpenSandbox supports Docker and Kubernetes infrastructure backends. On Kubernetes, the system decouples the logical sandbox declaration from the physical execution pod:

```text
Sandbox ID / CR   Logical identity, template, TTL, and desired state
Pod / Pod IP      Current execution instance and endpoint
```

The platform externalizes sandbox metadata, OCI configurations, network policies, and persistent storage volumes into custom resources, delegating pod materialization to Kubernetes controllers. When configured with a Kata RuntimeClass, hypervisor provisioning and virtualization overhead remain managed through containerd and Kata.

However, ephemeral process trees, anonymous memory allocations, interactive shell sessions, network namespaces, and established sockets remain anchored to the active pod instance. The OpenSandbox Kubernetes pause implementation commits the container writable rootfs into an incremental image and deletes the pod, rebuilding an instance from the committed layer upon resume; this flow omits memory and process tree state preservation.[^opensandbox-pause]

Restoration therefore guarantees **committed filesystem state and declarative configuration**. The logical custom resource reconciles a new pod instance following host termination, but uncommitted volatile memory, running threads, and established network sockets do not survive.

Resource ledger mechanics also explain whether configuring `1 GiB` consumes 1 GiB of physical capacity immediately. OpenSandbox writes `resourceLimits` to the primary sandbox container; unless callers specify discrete `resourceRequests`, the implementation defaults container `requests` to equal `limits`.[^opensandbox-resources]

On Kubernetes, declaring `memory=1Gi` instructs the scheduler to allocate a full 1 GiB reservation while establishing an identical cgroup limit. The complete pod may additionally account for sidecars, init containers, and virtualization overhead. **This does not imply processes instantaneously commit 1 GiB of resident memory (RSS), but it deducts that capacity from scheduler ledgers.**

OpenSandbox utilizes warm pools to mitigate cold-start delays by maintaining ready pod instances for instant assignment. Pool specifications configure capacity bounds for these warm buffers.[^opensandbox-pool]

```text
Larger warm Pool
  -> lower allocation latency
  -> more resident Pods and VMs, and more scheduler reservations
```

OpenSandbox successfully incorporates complete OS runtime environments into a Serverless control plane, but retains classic capacity trade-offs: either absorb cold-start provisioning latency, or maintain persistent reservations for warm idle capacity.

This invites a deeper architectural query: if complete pods represent heavy provisioning units, can platforms lower the marginal cost per virtual machine rather than pooling idle pods?

## 5. CubeSandbox: A microVM That Can Restore Its Execution Context

CubeSandbox presents an application interface parallel to OpenSandbox: select a Template, provision an instance with an invariant `sandboxID`, and execute interactive code blocks, shell commands, file modifications, PTY sessions, and network services:

```python
sandbox = Sandbox.create(template="agent-python")
sandbox.run_code("x = 1")
sandbox.run_code("print(x)")
sandbox.pause()
sandbox.resume()
```

The `run_code()` API routes requests through a proxy to `envd` inside the VM, reusing the interpreter global namespace by default.[^cubesandbox-api] The managed object is a Sandbox retaining persistent context, rather than an isolated code invocation.

CubeSandbox differentiates itself by granting callers fine-grained lifecycle controls: beyond termination, callers can pause, resume, snapshot, roll back, and clone execution environments. A successful pause terminates the active microVM process on the host while preserving a restorable virtual machine state snapshot; resume reuses the logical `sandboxID` to schedule and instantiate a microVM across candidate nodes.

From the application vantage point, callers manipulate a continuous virtual machine; from the systems plane, **the logical Sandbox separates from the physical VMM process**. Once the latest checkpoint commits to storage, the live microVM process can be safely destroyed.

## 6. CubeSandbox: Separating Declared Capacity from Physical Residency

CubeSandbox manages the end-to-end data path across its API, scheduler, Shim, VMM, and guest agent. Its central design allows concurrent Sandboxes to share the base physical state of a Template:

```text
Template rootfs       --reflink / CoW--> Sandbox rootfs
Template memory file  --MAP_PRIVATE----> Sandbox guest memory

Untouched pages: do not become physically resident
Read-only pages: can remain shared file-cache pages
Written pages: become anonymous CoW pages private to the current VM
```

When restoring snapshot-backed guest memory, the Cube hypervisor maps regions using `MAP_NORESERVE | MAP_PRIVATE`; the codebase explicitly differentiates untouched virtual pages, shared read-only file pages, and anonymous copy-on-write pages created upon memory mutations.[^cubesandbox-memory]

This explains why a sandbox declaring `2 GiB` of guest memory avoids reserving 2 GiB of dedicated physical host memory at initialization. Actual resident set size (RSS) tracks active guest working sets, private dirty pages, and lightweight VMM overhead.

This optimization does not eliminate resource quota tracking. Declared specifications enter the Cube scheduler ledger, which applies an overcommit policy defaulting to 2x memory and 3x CPU ratios.[^cubesandbox-overcommit] In practice:

```text
Declared capacity     Determines guest limits and the scheduling allocation unit
Scheduling capacity   Permits controlled overcommit
Physical residency    Grows with actual access and CoW writes
```

This structural separation clarifies the "4 MB Sandbox" metric cited in project materials. The reported `4-5 MiB` figure measures **VMM overhead PSS**, rather than total end-to-end sandbox memory. A separate benchmark evaluating 1,000 idle instances (configured with 2 vCPU / 2 GiB each) reported an amortized increase of approximately `21.5-25.7 MB` per instance based on system-wide available memory deltas.[^cubesandbox-benchmark] These metrics reflect distinct measurement boundaries and should not be equated directly with Kubernetes Pod RSS.

The Pause primitive introduces secondary resource decoupling. Cube serializes microVM CPU registers, memory deltas, and rootfs layers, terminating the active VM process to release physical host CPU and memory allocations.[^cubesandbox-pause] However, the default configuration enforces `paused_resource_release_ratio=0`, retaining full scheduler quota reservations to guarantee deterministic capacity on resume. Administrators can configure quota release ratios to increase density, shifting resume admissions to a best-effort model.[^cubesandbox-paused-quota]

CubeSandbox achieves Serverless elasticity through three foundational separations:

```text
Declared guest RAM != physical memory fully resident at startup
Logical Sandbox    != current microVM process
Startup baseline   != a complete private memory copy for every instance
```

These trade-offs remain bound by physical laws. Copy-on-write mechanisms and overcommit ratios do not synthesize physical memory; if large cohorts of light VMs simultaneously mutate their memory footprints, platforms rely on real-time node capacity checks, watermark thresholds, cgroups, and admission controls to protect host stability.

Even when individual microVMs achieve extreme density, a higher-level question emerges: must a persistent Agent identity remain tightly coupled to an individual Sandbox container?

## 7. Agent Substrate: An Actor That Can Sleep

Agent Substrate elevates the logical scheduling unit to a long-lived Actor. The Create operation writes a durable record initialized to `SUSPENDED`, deferring dedicated Pod allocation and process execution.[^substrate-create]

The caller receives a durable Actor identifier and communication endpoint. When an external request arrives while the Actor is inactive, the Router triggers Resume, allocating the Actor to a ready Worker from the pool and routing execution traffic.

```text
Long-lived logical Actor
  -> Resume
  -> an active sprint
  -> handle multiple requests and modify memory and files
  -> Pause or Suspend
  -> release the Worker
```

Individual request completions do not terminate the Actor lifecycle, departing from the classic single-request FaaS pattern. The fundamental scheduling unit becomes an **Actor activation**.

This pattern functions as a **Serverless Actor**: the Actor sustains an enduring logical lifecycle, while the Worker sandbox serves as an ephemeral execution substrate assigned during active intervals. Application identity endures continuously, while underlying compute resources bind solely during active execution.

## 8. Agent Substrate: Time-Multiplexing Actors onto Workers

Substrate delegates low-frequency worker lifecycle management to Kubernetes, decoupling high-frequency Actor activations from the kube-scheduler critical path:

```text
Kubernetes
  -> maintain M ready Worker Pods in advance

Substrate
  -> store N logical Actors in the database
  -> select a ready Worker at activation time
  -> start or restore a gVisor sandbox inside the Worker
  -> terminate the sandbox after checkpointing and release the assignment
```

Resource multiplexing here follows strict execution constraints. The implementation restricts each Worker to exactly one active Actor; the WorkerPool pre-provisions underlying pods via standard Kubernetes Deployments.[^substrate-worker] Substrate therefore implements **time multiplexing of numerous suspended Actors over a consolidated pool of warm Workers**, avoiding uncoordinated multi-tenant packing inside a single Worker.

The architecture provides two inactive states balancing performance against placement flexibility:

| Operation | State location | Restoration characteristics |
|---|---|---|
| Pause | Checkpoint remains on the original node | Faster restoration, but constrained by node locality |
| Suspend | Checkpoint is uploaded as an external snapshot | Can restore on a different Worker or node |

Pause generates a node-local checkpoint and yields the Worker allocation; Suspend persists the snapshot to external storage, committing it as the authoritative recoverable checkpoint for that Actor.[^substrate-pause-suspend]

Snapshot scoping controls execution state preservation fidelity: the `FULL` scope captures running process trees, memory state, rootfs deltas, and persistent directories (DurableDir) via hypervisor checkpointing; the `DATA` scope retains only the durable data directory, re-initializing the application runtime upon recovery.[^substrate-scope] The `FULL` designation specifies interface contracts and checkpoint capabilities, rather than unconditional continuity across arbitrary external network connections.

Substrate manages capacity through a two-tiered accounting model:

```text
WorkerPool request
  -> shared compute capacity reserved by Kubernetes

Actor limit
  -> Substrate placement and sandbox cgroup limits
  -> a suspended Actor does not add another Kubernetes Pod request
```

If a platform registers ten thousand logical Actors with only one hundred concurrently active, the cluster maintains a Worker pool sized to active concurrency plus head-room. Durable storage costs scale with total Actor counts and snapshot volumes, while compute expenditure correlates with the warm Worker baseline and active tasks.

This architecture requires application-level coordination: reference implementations explicitly trigger Suspend to return Workers, lacking general automated idle-reclamation loops; uncheckpointed active Workers that fail unexpectedly transition the hosted Actor to `CRASHED`, precluding transparent arbitrary rollback.[^substrate-idle-failure]

Substrate establishes a distinct resource mapping topology:

```text
Actor lifetime       != Worker lifetime
Stored Actor count   != Reserved Worker count
Request routing      != Kubernetes Pod scheduling
```

## Conclusion: Serverless Does Not Mean Stateless Functions

Mapping these three architectures along a unified systems trajectory highlights continuous evolutionary steps:

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

OpenSandbox orchestrates and provisions complete operating system environments under a unified control plane; CubeSandbox reduces the physical materialization and memory residency footprint of complete microVMs; Agent Substrate achieves time-multiplexed reuse of warm workers across persistent logical Actors.

All three architectures move beyond strict statelessness while preserving the foundational Serverless principle of resource decoupling:

1. Decoupling logical identity from permanent attachment to specific physical instances.
2. Decoupling enduring application state from continuous occupation of costly compute capacity.

For agent architectures, the core question becomes:

> Can a long-lived, stateful logical program own a computer only while it is doing useful work?

Moving up the abstraction stack, authoritative agent state further disaggregates into conversation histories, workspace files, and long-term memory, which context services rehydrate into disparate execution sandboxes upon activation. That represents a state model above the compute substrate. At the virtualization layer, however, the architectural path is established: once logical identities, restorable state, and physical execution instances separate cleanly, stateful agents operate in complete harmony with Serverless.

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

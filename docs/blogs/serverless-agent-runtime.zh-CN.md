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

[ENGLISH](./serverless-agent-runtime.md)

# 从无状态函数到 Agent Runtime：Serverless 的调度单位正在变大

Serverless 常被简化成一句话：运行一段短暂的无状态函数。

这个描述抓住了最常见的产品形态，却没有抓住它真正的系统内核。Serverless 首先是一种**资源运行契约**：需求到来时，平台为程序找到并物化一份满足要求的计算环境；需求结束后，调用方不再拥有那台机器。至于环境最终被销毁、冻结还是放回池中，是平台的实现选择，而不是业务程序的承诺。

Agent 让这个问题重新变得重要。一个 Agent 往往会连续调用工具、修改文件、启动解释器和浏览器、等待外部事件，然后从原来的现场继续工作。如果每次调用都重新创建一个无状态函数，恢复环境的成本可能比真正执行任务还高。

于是，一个新的问题出现了：**Serverless 的调度单位是否必须是一段无状态函数？**

OpenSandbox、CubeSandbox 和 Agent Substrate 给出了三种不同答案。它们分别把调度单位扩大为完整 Sandbox、可恢复的 microVM，以及可在 Worker 之间重新激活的 Actor。本文不打算给三个项目打分，而是借它们理解 Agent Runtime 正在怎样改写 Serverless。

## 1. Serverless 是按需求物化资源

先暂时忘掉 Lambda 和函数。一次 Serverless 执行可以抽象为：

```text
需求到达
  -> admission 与路由
  -> 找到满足 CPU、内存和隔离要求的容量
  -> 物化执行环境
  -> 注入代码、输入、配置与权限
  -> 执行并提交结果
  -> 冻结、复用或销毁环境
```

这里最重要的不是程序只能运行几十毫秒，而是**逻辑程序与物理资源的绑定是临时的**。调用方不需要维护服务器，也不能把正确性建立在“下一次一定回到同一台 Worker”之上。平台可以保留 warm environment，但它只能是加速手段，不能成为业务正确性的必要条件。

Serverless 平台因此始终在处理一组矛盾：

```text
业务方：请求到达时，资源最好已经准备好。
平台方：没有请求时，最好不保留昂贵资源。
```

冷启动、预热池、快照恢复、资源超卖与多租户调度，都是在这两个目标之间寻找平衡。Berkeley 对 Serverless 的经典讨论也把弹性伸缩、按使用付费和隐藏服务器管理视为核心，而不只是“函数很短”。[^serverless-berkeley]

评价一个 Agent Runtime 是否具有 Serverless 属性，可以固定看四件事：

| 维度 | 要问的问题 |
|---|---|
| 启动延迟 | 从需求到达到环境可执行，需要付出多少物化成本？ |
| 空闲成本 | 没有工作时，仍保留多少 CPU、物理内存和调度配额？ |
| 状态保真度 | 恢复后保留 rootfs、进程、内存和网络中的哪些状态？ |
| 调度自由 | 下一次执行能否放到另一份容量，受什么 locality 约束？ |

讨论资源时，还必须区分几个经常被混成“内存占用”的概念：

```text
Resource limit          最多允许使用多少
Scheduler request       调度器提前计账多少
Guest RAM / VA          guest 可见或 VMM 映射多大的地址空间
RSS / PSS               当前实际驻留了多少物理页
```

配置 `1 GiB`，可能只是在其中一层记了一个数。它是否立刻转化成 1 GiB 物理内存，取决于具体实现。

## 2. 无状态函数是第一种工程解法

要让下一次调用落到任意一台机器上，最简单的办法不是让调度器记住上一台机器，而是让程序的正确性不再依赖它：

```text
output = function(input, external_state)
```

业务实体进入数据库，文件进入对象存储，调用衔接交给消息队列和工作流，Secret 与配置由外部服务管理。执行环境只保存本次调用所需的代码、内存与临时缓存。

这样做以后，任意兼容 Worker 都能处理下一次请求；失败的执行也可以在别处重试。**无状态不是 Serverless 的目的，而是第一代 Serverless 获得调度自由的办法。**

“无状态”也不意味着 warm environment 中绝对不能存在状态。连接池、全局对象和临时文件都可以留下。真正的约束是：

> 下一次调用的正确性，不能依赖上一次 execution environment 仍然存在。

为了分析 Agent Runtime，后文把状态统一分成三类：

```text
Authoritative state   实例消失后仍必须存在的权威状态
Execution state       当前 CPU、进程、内存、writable rootfs 与网络现场
Acceleration state    warm Pod、模板页缓存、golden snapshot 等加速层
```

对于普通函数，Execution state 通常可以丢掉。对于 Agent，它却可能非常昂贵：已经安装的依赖、修改中的 workspace、解释器变量、浏览器页面和后台工具进程，都可能属于下一步工作的一部分。

Agent 暴露了无状态函数的边界。解决办法未必是放弃 Serverless，而可能是扩大它的调度单位：让一个生命周期内有状态的环境，仍然可以被按需物化、暂停和回收。

## 3. OpenSandbox：一台有租期的临时计算机

从调用者看，OpenSandbox 提供的不是一次函数调用，而是一台远程临时计算机：

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

调用方提交 image 或 snapshot、入口命令、环境变量、资源、网络策略和 TTL，得到一个稳定的 `sandboxId`。随后可以在同一个 Sandbox 中多次执行命令、读写文件和维持会话。SDK 的创建流程也会围绕同一个 ID 构造文件、命令、健康检查等服务。[^opensandbox-api]

因此，OpenSandbox 的逻辑调度单位不是一次 `commands.run()`，而是一段 Sandbox 生命周期：

```text
create
  -> 多次 command / file / session 操作
  -> pause / resume / renew
  -> kill 或 TTL 到期
```

Sandbox 生命周期内明确有状态。调用方不需要知道它最终由 Docker container、Kubernetes Pod 还是 Kata microVM 承载，但仍要显式管理这台临时计算机何时创建、暂停和销毁。

这也是 OpenSandbox 与传统 FaaS 的第一处分界：FaaS 通常在 invocation 结束后解除绑定；OpenSandbox 要等整个 Sandbox 生命周期结束，才有机会释放当前计算。

本文可以把这种抽象称为 **“Serverless Computer”**。这不是项目的官方分类，而是一种分析视角：平台不再只交付一个函数入口，而是按需交付一台完整、可编程、有租期的计算机。

## 4. OpenSandbox：完整环境如何变成 Serverless

OpenSandbox 可以使用 Docker 或 Kubernetes 后端。在 Kubernetes 路径里，逻辑 Sandbox 与当前执行实例被拆成两层：

```text
Sandbox ID / CR   逻辑身份、模板、TTL 与 desired state
Pod / Pod IP      当前执行实例与 endpoint
```

它外置了 Sandbox 身份、模板、TTL、OCI 基础镜像、网络策略，以及可选的 PVC 或对象存储。Kubernetes 负责把这些声明物化成 Pod。若配置 Kata RuntimeClass，microVM 的创建与资源开销继续由 Kubernetes、containerd 和 Kata 负责。

但是，当前进程树、匿名内存、Shell session、network namespace 与打开的连接，仍然属于当前 Pod。OpenSandbox 的 Kubernetes pause 会提交容器 writable rootfs、释放 Pod，再在 resume 时用新的 OCI image 重建；它不会 checkpoint 进程和内存。[^opensandbox-pause]

这意味着一次恢复保存的是**已提交的文件系统状态和声明式配置**，而不是完整执行现场。逻辑 CR 可以在 Pod 丢失后重新协调出新实例，但没有外置的本地写入、进程、内存和连接不会自动回来。

资源账本也解释了“配置 1 GiB，服务是否会吃掉 1 GiB”这个常见疑问。OpenSandbox 会把 `resourceLimits` 写入主 sandbox 容器；若调用方没有单独给出 `resourceRequests`，实现默认令主容器的 `requests = limits`。[^opensandbox-resources]

所以，在 Kubernetes 路径中配置 `memory=1Gi`，意味着主容器向 scheduler 申请 1 GiB 调度容量，同时把 1 GiB 作为限制。完整 Pod 还可能包含其他容器、init container 规则和 RuntimeClass overhead。**这不等于进程立刻产生 1 GiB RSS，但它确实占用了相应的调度账本。**

OpenSandbox 用 Pool 降低冷启动：提前维持一批完整 Ready Pod，分配时直接领取。Pool 的配置明确包含 warm buffer 的上下界。[^opensandbox-pool]

```text
更大的 warm Pool
  -> 更低的分配延迟
  -> 更多常驻 Pod、VM 与 scheduler reservation
```

因此，OpenSandbox 已经把完整工作环境纳入 Serverless 控制面，但它的主要交换仍然很传统：要么等待完整 Pod 被创建，要么提前为完整 Pod 支付空闲成本。

下一个问题自然出现了：如果完整 Pod 是昂贵的物化单位，能否不靠堆积更多 warm Pod，而是直接降低每台临时计算机的边际成本？

## 5. CubeSandbox：一台可以恢复执行现场的 microVM

CubeSandbox 给调用方的上层体验与 OpenSandbox 相似：选择 Template，创建一个有稳定 `sandboxID` 的 Sandbox，然后连续执行代码、命令、文件操作、PTY 和网络服务。

```python
sandbox = Sandbox.create(template="agent-python")
sandbox.run_code("x = 1")
sandbox.run_code("print(x)")
sandbox.pause()
sandbox.resume()
```

`run_code()` 通过代理请求 VM 内的 `envd`，并默认复用解释器的全局命名空间。[^cubesandbox-api] 所以这里真正被管理的也不是一次代码调用，而是一台持续存在的 Sandbox。

CubeSandbox 的关键区别，是调用方不仅可以销毁，还可以 pause、resume、snapshot、rollback 和 clone。一次成功 pause 会结束当前活 microVM，但保留可恢复的 VM 状态；resume 可以继续使用同一个逻辑 `sandboxID`，重新选择节点并创建 microVM。

从业务角度看，它仍然是一台临时计算机；从平台角度看，**逻辑 Sandbox 已经不再等同于当前 VMM 进程**。只要最新一次可恢复状态已经被成功提交，当前 microVM 就可以消失。

## 6. CubeSandbox：把声明容量与物理驻留分开

CubeSandbox 自己控制从 API、调度器到 Shim、VMM 与 guest agent 的数据路径。它的核心机制不是简单地“使用了 microVM”，而是让大量 Sandbox 共享 Template 的基础状态：

```text
Template rootfs       --reflink / CoW--> Sandbox rootfs
Template memory file  --MAP_PRIVATE----> Sandbox guest memory

未访问页：不进入物理内存
只读页：可以保留为共享文件页缓存
写入页：产生当前 VM 的匿名 CoW 页
```

恢复 snapshot-backed guest memory 时，Cube 的 VMM 使用 `MAP_NORESERVE | MAP_PRIVATE`；代码注释也明确区分了未访问页、只读文件页与写入后产生的匿名 CoW 页。[^cubesandbox-memory]

这解释了为什么一个声明 `2 GiB` guest memory 的 Sandbox，不会在启动瞬间为自己独占 2 GiB 物理内存。实际驻留更接近 guest working set、私有脏页和 VMM 固定开销。

但这不意味着“2 GiB 不计资源”。声明内存仍然进入 Cube 的调度账本，只是默认调度容量采用内存 2 倍、CPU 3 倍的 overcommit ratio。[^cubesandbox-overcommit] 换句话说：

```text
声明容量       决定 guest 上限与调度分配单位
调度容量       允许在受控比例下 overcommit
物理驻留内存   随实际访问和 CoW 写入增长
```

这也是所谓“4 MB Sandbox”最需要澄清的地方。项目材料中的约 `4-5 MiB` 指 **VMM overhead PSS**，不是完整 Sandbox 的总内存。项目另一组 1000 个、每个声明 2 vCPU/2 GiB 的空载 create-only 测试，按整机 `free available` 的变化计算出约 `21.5-25.7 MB` 的单实例均摊增量。[^cubesandbox-benchmark] 两个数字测量边界不同，不能互相替代，更不能直接拿去和另一个系统的 Pod RSS 比较。

Pause 又引入了第二层资源分离。Cube 会保存 VM state、memory 与 rootfs，并销毁当前 microVM，所以活 VM 的物理 CPU 和内存可以被回收。[^cubesandbox-pause] 但是，默认 `paused_resource_release_ratio=0`，暂停中的 Sandbox 仍保留完整调度配额，以提高 resume 成功的确定性。运维可以释放部分或全部额度换取更高密度，但恢复会变成尽力而为。[^cubesandbox-paused-quota]

因此，CubeSandbox 的 Serverless 性不来自“资源数字消失了”，而来自三组解绑：

```text
声明 guest RAM != 启动时立即占满物理内存
逻辑 Sandbox   != 当前 microVM 进程
启动基线       != 每个实例都复制一份完整内存
```

代价同样明确。CoW 与 overcommit 不会创造物理容量；当大量轻载 VM 同时写满内存，平台仍需要实时容量过滤、节点保留阈值、cgroup 与 admission control 保护宿主机。

即使单台 microVM 已经足够轻，还有一个更上层的问题：长期存在的 Agent 身份，是否必须永远等同于一个 Sandbox 对象？

## 7. Agent Substrate：一个可以休眠的 Actor

Agent Substrate 把逻辑单位再次向上移动。调用方创建的不是一台立即运行的 Sandbox，而是一个长期存在的 Actor。Create 首先写入一个初始状态为 `SUSPENDED` 的逻辑记录，不立即创建专属 Pod 或启动进程。[^substrate-create]

调用方获得稳定的 Actor identity 和地址。业务请求到达时，如果 Actor 尚未运行，Router 会触发 Resume，把它分配给一台 ready Worker，再把流量转发过去。

```text
长期逻辑 Actor
  -> Resume
  -> 一次 active sprint
  -> 处理多次请求、修改内存和文件
  -> Pause 或 Suspend
  -> 释放 Worker
```

一次 HTTP 请求结束不会结束 Actor，也不存在传统 FaaS 意义上的“一次请求一个实例”。真正的调度单位是一次 **Actor activation**。

这可以被称为 **“Serverless Actor”**：Actor 拥有长期逻辑生命周期，Worker sandbox 只是它在某段活跃时间内使用的执行载体。业务身份可以持续存在，而昂贵计算只在工作发生时绑定。

## 8. Agent Substrate：把 Actor 时间复用到 Worker

Substrate 把 Kubernetes 留在相对较慢的 Worker fleet 管理路径上，再把高频 Actor activation 从 kube-scheduler 的关键路径中移开：

```text
Kubernetes
  -> 预先维护 M 个 ready Worker Pod

Substrate
  -> 在数据库中保存 N 个逻辑 Actor
  -> activation 时选择一个 ready Worker
  -> 在 Worker 内启动或恢复 gVisor sandbox
  -> checkpoint 后终止 sandbox，释放 assignment
```

这里必须准确理解“复用”。当前代码明确把每个 Worker 的 active Actor 容量设为 1；WorkerPool 则通过 Kubernetes Deployment 预建完整 Pod。[^substrate-worker] 因此，Substrate 做的是**大量 suspended Actor 对少量 warm Worker 的时间复用**，不是在一个 Worker 里同时塞入许多 active Actor。

它提供两类不同的停止状态：

| 操作 | 状态位置 | 恢复特征 |
|---|---|---|
| Pause | checkpoint 留在原节点 | 恢复较快，但受节点 locality 约束 |
| Suspend | checkpoint 上传为外部 snapshot | 可以换 Worker、换节点恢复 |

Pause 的实现会请求 node-local checkpoint，再释放 Worker assignment；Suspend 会把 snapshot 写入外部位置，并把它记录为 Actor 最新成功提交的可恢复状态。[^substrate-pause-suspend]

Snapshot scope 还决定恢复保留多少 Execution state：`FULL` 设计为通过后端 checkpoint 保存进程、内存、rootfs 改动与 DurableDir；`DATA` 只保存 DurableDir，恢复时重新启动应用。[^substrate-scope] 这里的“FULL”是接口设计和具体 backend 的 checkpoint/restore 能力，不应被理解成对任意外部连接都提供无条件连续性。

Substrate 的资源账本因此分成两层：

```text
WorkerPool request
  -> Kubernetes 预留的共享计算容量

Actor limit
  -> Substrate placement 与 sandbox cgroup 上限
  -> suspended Actor 不追加一份 Kubernetes Pod request
```

如果系统中存在一万个逻辑 Actor，但只有一百个同时活跃，理论上可以只维持接近活跃并发、再加一定余量的 Worker fleet。存储成本随 Actor 与 snapshot 数量增长，计算成本则主要随 warm Worker baseline 和 active Actor 增长。

不过，这条链路目前仍需要上层参与：仓库中的示例会显式调用 Suspend 来释放 Worker，并没有展示一个通用的自动 idle suspension 闭环；Worker 丢失也可能让尚未成功 checkpoint 的 Actor 进入 `CRASHED`，而不是透明地回滚到任意旧状态。[^substrate-idle-failure]

所以，Substrate 展示的不是“更小的 Pod”，而是另一种资源关系：

```text
Actor lifetime       != Worker lifetime
Stored Actor count   != Reserved Worker count
Request routing      != Kubernetes Pod scheduling
```

## 结语：Serverless 不等于无状态函数

把三套系统放回同一个坐标系，可以看到一条连续的演化路径：

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

OpenSandbox 解决的是如何统一交付和管理完整计算环境；CubeSandbox 解决的是如何降低完整 microVM 的物化与驻留成本；Agent Substrate 解决的是如何让长期存在的逻辑 Actor 只在活跃时占用 Worker。

三者都不是“无状态”的。它们真正继承的 Serverless 原则，是不断解除两种绑定：

1. 解除逻辑身份与某一个物理实例的永久绑定；
2. 解除长期存在的业务状态与持续占用昂贵计算资源的绑定。

因此，对于 Agent，问题已经不再是“怎样把它强行写成一个函数”，而是：

> 我们能否让一个长期存在、有状态的逻辑程序，只在真正工作时拥有一台计算机？

再向上一层，Agent 的权威状态还可以被继续拆成 Session、Filesystem 与 Agent Memory，由上下文服务在激活时召回并注入不同 Runtime。但那是计算层之上的状态模型。本文想先说明的是：只要逻辑身份、可恢复状态与物理执行实例能够被清楚地拆开，有状态 Agent 并不天然违背 Serverless。

---

## 参考资料与源码版本

本文于 2026 年 9 月 5 日基于以下代码版本阅读。文中的性能数字均为项目公开材料所报告，未在统一硬件和工作负载下重新测试，因此不构成跨项目 benchmark。

[^serverless-berkeley]: Eric Jonas et al., [Cloud Programming Simplified: A Berkeley View on Serverless Computing](https://arxiv.org/abs/1902.03383), 2019。

[^opensandbox-api]: OpenSandbox commit `8720eecc`，[Python SDK `Sandbox.create`](https://github.com/opensandbox-group/OpenSandbox/blob/8720eeccfefc42ccca0a0d565f0942906cefee77/sdks/sandbox/python/src/opensandbox/sandbox.py#L506-L624)。

[^opensandbox-pause]: OpenSandbox commit `8720eecc`，[Kubernetes pause/resume lifecycle and preserved state](https://github.com/opensandbox-group/OpenSandbox/blob/8720eeccfefc42ccca0a0d565f0942906cefee77/docs/guides/pause-resume.md#L39-L79)。

[^opensandbox-resources]: OpenSandbox commit `8720eecc`，[main container requests default to limits](https://github.com/opensandbox-group/OpenSandbox/blob/8720eeccfefc42ccca0a0d565f0942906cefee77/server/opensandbox_server/services/k8s/provider_common.py#L158-L183)。

[^opensandbox-pool]: OpenSandbox commit `8720eecc`，[Pool warm buffer and capacity fields](https://github.com/opensandbox-group/OpenSandbox/blob/8720eeccfefc42ccca0a0d565f0942906cefee77/kubernetes/apis/sandbox/v1alpha1/pool_types.go#L48-L87)。

[^cubesandbox-api]: CubeSandbox commit `ddddcc25`，[Python SDK `Sandbox.create`](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/sdk/python/cubesandbox/sandbox.py#L183-L220) 与 [`run_code`](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/sdk/python/cubesandbox/sandbox.py#L387-L417)。

[^cubesandbox-memory]: CubeSandbox commit `ddddcc25`，[snapshot memory mapping](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/hypervisor/vmm/src/memory_manager.rs#L1495-L1545) 与 [CoW page classification](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/hypervisor/vmm/src/pagemap_anon.rs#L5-L17)。

[^cubesandbox-overcommit]: CubeSandbox commit `ddddcc25`，[default CPU and memory overcommit ratios](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/CubeMaster/pkg/base/config/config.go#L298-L369)。

[^cubesandbox-benchmark]: CubeSandbox commit `ddddcc25`，README 把低内存开销描述为 [`< 5MB`](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/README_zh.md#L232-L243)，其[内存图](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/docs/assets/cube-sandbox-mem-overhead.png)将橙色部分标为 `VMM Overhead PSS (MiB)`；更完整的测试材料报告了 [1000-instance create-only 场景的整机内存变化](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/docs/zh/blog/posts/2026-06-01-cubesandbox-perf-benchmark.md#L226-L264)。

[^cubesandbox-pause]: CubeSandbox commit `ddddcc25`，[pause produces a CoW-backed snapshot and destroys the live sandbox](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/Cubelet/services/cubebox/pause_cow.go#L93-L101)；[resume recreates the microVM under the desired sandbox ID](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/CubeMaster/pkg/service/sandbox/sandbox_resume_pause.go#L341-L429)。

[^cubesandbox-paused-quota]: CubeSandbox commit `ddddcc25`，[paused resource release policy](https://github.com/TencentCloud/CubeSandbox/blob/ddddcc25280f4e183d7891454bbf55e1f97a7948/docs/zh/guide/lifecycle.md#L227-L237)。

[^substrate-create]: Agent Substrate commit `7a9abab3`，[Actor creation starts in `SUSPENDED`](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/actor.go#L69-L104)。

[^substrate-worker]: Agent Substrate commit `7a9abab3`，[one active Actor per Worker](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/internal/ateomcapacity/ateomcapacity.go#L38-L46)；[WorkerPool materialized as a Kubernetes Deployment](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/atecontroller/internal/controllers/workerpool_apply.go#L189-L211)。

[^substrate-pause-suspend]: Agent Substrate commit `7a9abab3`，[Pause writes a node-local checkpoint](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/workflow_pause.go#L149-L208)；Suspend 会[上传 checkpoint](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/workflow_suspend.go#L269-L318)，再[记录外部 snapshot 并释放 Worker](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/workflow_suspend.go#L344-L410)。

[^substrate-scope]: Agent Substrate commit `7a9abab3`，[snapshot content scope definitions](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/pkg/proto/ateapipb/ateapi.proto#L175-L183)。

[^substrate-idle-failure]: Agent Substrate commit `7a9abab3`，项目示例说明 auto-suspend-on-idle [尚未实现，并在每轮请求后显式 Suspend](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/demos/parking/load.sh#L17-L24)；[Worker 消失时，仍在运行的 Actor 会进入 `CRASHED`](https://github.com/agent-substrate/substrate/blob/7a9abab35044670ce357d9eea89175a153718cbc/cmd/ateapi/internal/controlapi/workflow_worker_delete.go#L153-L164)。

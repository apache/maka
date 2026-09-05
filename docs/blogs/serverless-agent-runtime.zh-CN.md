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

Serverless 常被简化定义为：运行一段短暂的无状态函数。

这种描述抓住了最普及的产品形态，但尚未触及更底层的系统内核。Serverless 首先是一种**资源运行契约**：需求到达时，平台按需物化满足规格的计算环境；需求结束后，调用方释放对物理节点的占用。至于环境最终被销毁、冻结还是归还缓冲池，属于平台的实现策略，而非业务程序的契约承诺。

Agent 的兴起使这一架构分歧重新凸显。一个自治 Agent 往往需要连续调用工具、修改文件系统、操作解释器与浏览器进程、挂起等待外部事件，并在后续重新唤醒时无缝恢复上下文现场。若每次交互均由全新的无状态函数承载，冷启动与环境水合的开销将迅速超过任务本身的计算耗时。

由此引出一个核心架构命题：**Serverless 的调度单位是否必须局限于无状态函数？**

OpenSandbox、CubeSandbox 与 Agent Substrate 从不同维度给出了工程实践。它们分别将调度单位拓宽为完整的沙箱容器、支持快照恢复的 microVM，以及可在不同 Worker 间动态迁移唤醒的 Actor。本文旨在通过对比三者的架构取舍，解析 Agent 运行时正在如何重塑 Serverless 的设计边界。

## 1. Serverless 是按需求物化资源

剥离具体云服务形态后，通用的 Serverless 执行流程可抽象如下：

```text
需求到达
  -> admission 与路由
  -> 找到满足 CPU、内存和隔离要求的容量
  -> 物化执行环境
  -> 注入代码、输入、配置与权限
  -> 执行并提交结果
  -> 冻结、复用或销毁环境
```

Serverless 的核心特质在于**逻辑程序与物理资源的绑定是临时的**。调用方无须管理底层服务器，亦不可假设后续请求必然调度至同一物理节点。平台可保留热缓存环境（Warm Environment），但这仅作为性能加速手段，业务逻辑的正确性不可建立在此假设之上。

Serverless 基础设施始终致力于平衡一组天然张力：

```text
业务方：请求到达时，计算资源应当即刻就绪。
平台方：无负载运行时，昂贵的物理资源应当彻底释放。
```

冷启动优化、预热缓冲池、内存快照恢复、资源超卖（Overcommit）及多租户调度，均是针对该张力的工程折中。Berkeley 关于 Serverless 计算的经典论述亦将弹性伸缩、按用量计费与屏蔽服务器运维视为核心特征，而非狭义上的“函数执行耗时短”。[^serverless-berkeley]

评估一个 Agent Runtime 是否具备 Serverless 属性，通常可聚焦于四个核心维度：

| 维度 | 要问的问题 |
|---|---|
| 启动延迟 | 从需求到达至环境可执行，需要付出多大物化成本？ |
| 空闲成本 | 无工作负载时，仍保留多少 CPU、物理内存与调度配额？ |
| 状态保真度 | 恢复执行后，rootfs、进程树、内存与网络连接能保留哪些？ |
| 调度自由 | 后续执行能否灵活放置于任意计算容量，受何种亲和性约束？ |

在量化资源开销时，必须清晰区分四个常被笼统概括为“内存占用”的概念：

```text
Resource limit          调度层允许使用的资源上限
Scheduler request       调度器预先预留与记账的容量
Guest RAM / VA          Guest 内部可见或 VMM 映射的虚拟地址空间
RSS / PSS               当前宿主机实际驻留的物理内存页
```

声明 `1 GiB` 往往仅代表在其中某一层登记了配额数值，其是否即刻转化为物理内存占用，完全取决于底层虚拟化与运行时的具体实现。

## 2. 无状态函数是第一种工程解法

要让下一次调用落到任意一台机器上，工程设计选择解耦程序正确性与特定宿主节点：

```text
output = function(input, external_state)
```

业务实体存入数据库，文件沉淀于对象存储，调用编排委托给消息队列与工作流引擎，密钥与配置则由外部配置中心管理。本地执行环境仅保留当次计算所需的运行代码、瞬态内存与局部缓存。

在此范式下，任意对等 Worker 均可处理后续请求，异常退出亦可在异地无损重试。**无状态是第一代 Serverless 获得调度自由的工程解法，使业务正确性完全脱敏于宿主位置。**

无状态并不排斥热环境（Warm Environment）中局部状态的物理存留。数据库连接池、预加载的全局对象与本地临时文件均可保留。核心系统约束在于：

> 后续调用的正确性，绝不可依赖前次执行环境的持续存续。

为便于剖析 Agent Runtime 的设计差异，本文将运行状态统一划分为三层：

```text
Authoritative state   实例销毁后依然必须权威存在的持久状态
Execution state       当前 CPU、进程树、内存堆栈、可写 rootfs 与网络连接
Acceleration state    Warm Pod、模板页缓存、Golden Snapshot 等性能加速层
```

在传统批处理或微服务中，Execution state 在调用结束后即可安全丢弃。然而在 Agent 系统中，该层状态极为昂贵：动态安装的依赖包、正在编辑的代码工作区、交互式解释器变量上下文、浏览器 DOM 树以及后台长效诊断工具，均构成后续推理轮次的直接输入。

Agent 拓展了传统无状态函数的应用边界。系统演进的方向在于扩大调度单位：使具有生命周期状态的环境，依然能够按需物化、挂起与弹性回收。

## 3. OpenSandbox：一台有租期的临时计算机

从调用者视角看，OpenSandbox 交付的是一台远程临时计算机：

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

调用方声明基础镜像或快照、启动命令、环境变量、计算资源、网络安全策略及生存时间（TTL），获取全局唯一的 `sandboxId`。随后可在此沙箱内连续执行命令、读写文件并维系交互会话。SDK 在创建流程中围绕该统一标识编排文件管理、指令执行与健康检查服务。[^opensandbox-api]

因此，OpenSandbox 的逻辑调度单位由单次 `commands.run()` 扩展为一段完整的 Sandbox 生命周期：

```text
create
  -> 多次 command / file / session 操作
  -> pause / resume / renew
  -> kill 或 TTL 到期
```

在沙箱生命周期内部，运行状态完整存续。调用方无须感知底层载体是 Docker 容器、Kubernetes Pod 还是 Kata microVM，但需要显式管理该临时主机的创建、暂停与终结。

这构成了 OpenSandbox 与传统 FaaS 的核心分界：FaaS 通常在当次调用结束时即刻解绑资源，而 OpenSandbox 只有在整个沙箱租期结束或被显式回收时，平台方能完全释放计算资源。

本文将这种抽象归纳为 **“Serverless Computer”**。该提法并非项目的官方分类。作为本文的架构分析视角，平台按需交付的是一台完整、可编程、有租期的虚拟计算机。

## 4. OpenSandbox：完整环境如何变成 Serverless

OpenSandbox 支持接入 Docker 或 Kubernetes 后端。在 Kubernetes 路径下，逻辑沙箱与底层执行实例被划分为两层解耦结构：

```text
Sandbox ID / CR   逻辑身份、模板、TTL 与期望状态（Desired State）
Pod / Pod IP      当前物理执行实例与交互端点（Endpoint）
```

系统将沙箱元数据、镜像规范、网络策略及持久存储卷（PVC）外置化，交由 Kubernetes Controller 将其物化为 Pod。若启用 Kata RuntimeClass，microVM 的创建与资源管理则下沉至 containerd 与 Kata 处理。

然而，瞬态的进程树、匿名内存页、交互式 Shell 终端、网络命名空间及已建立的网络套接字，仍牢固绑定于当前 Pod。OpenSandbox 的 Kubernetes Pause 机制通过将容器的可写 rootfs 提交为增量镜像并销毁 Pod，在 Resume 时基于新镜像拉起新 Pod；该过程并不捕获内存与进程上下文。[^opensandbox-pause]

这意味着沙箱恢复保全的是**已提交的文件系统状态与声明式配置**。逻辑 CR 能够在 Pod 异常退出后拉起新副本，但未提交的本地内存、活跃进程与网络连接将随实例销毁而重置。

资源记账机制也解答了“配置 1 GiB，系统是否立即吞吐 1 GiB 物理内存”的疑问。OpenSandbox 会把 `resourceLimits` 写入主沙箱容器；若调用方未单独显式指定 `resourceRequests`，实现层默认令主容器的 `requests = limits`。[^opensandbox-resources]

因此，在 Kubernetes 路径下配置 `memory=1Gi`，意味着主容器向调度器申请 1 GiB 的调度配额预留，同时将 1 GiB 设为资源上限。整机 Pod 还需计入辅助容器与 RuntimeClass 的额外开销。**这并不等同于进程即刻占满 1 GiB RSS，但确实在调度器的容量账本中完成了全额扣减。**

OpenSandbox 引入预热池（Pool）以削减冷启动时延：在系统侧预先保有就绪状态的 Ready Pod，任务到达时瞬时认领。Pool 配置显式界定了温水池的容量水位。[^opensandbox-pool]

```text
更大的 warm Pool
  -> 更低的分配延迟
  -> 更多常驻 Pod、VM 与 scheduler reservation
```

OpenSandbox 成功将完整操作系统工作环境纳入 Serverless 控制面，但其核心工程交换依然延续了传统模式：要么忍受全量 Pod 创建的排队时延，要么预先为温热 Pod 支付常驻物理成本。

由此引申出进一步的系统探索：若全量 Pod 属于较重的物化载体，能否在不堆砌常驻 Pod 的前提下，从底层削减单台临时虚拟机的边际物化成本？

## 5. CubeSandbox：一台可以恢复执行现场的 microVM

CubeSandbox 在接入层提供了与 OpenSandbox 相似的编程接口：指定 Template，分配唯一且固定的 `sandboxID`，随后持续执行代码片段、终端命令、文件 I/O、PTY 交互及网络服务：

```python
sandbox = Sandbox.create(template="agent-python")
sandbox.run_code("x = 1")
sandbox.run_code("print(x)")
sandbox.pause()
sandbox.resume()
```

`run_code()` 通过代理请求 VM 内的 `envd`，并默认复用解释器的全局命名空间。[^cubesandbox-api] 平台直接管控的实体是一台具有持久上下文的 Sandbox，而非单次代码调用。

CubeSandbox 的核心突破在于赋予了调用方更细粒度的控制能力：除销毁外，支持执行 pause、resume、snapshot、rollback 及 clone。一次成功的 Pause 会优雅销毁当前宿主机上的活跃 microVM 进程，但完整保全可恢复的 VM 状态镜像；Resume 操作则复用同一逻辑 `sandboxID`，重新选择最优物理节点拉起新的 microVM。

在业务视角下，用户依然在操纵一台临时计算机；而在平台架构视角下，**逻辑 Sandbox 已与底层具体的 VMM 进程彻底解耦**。只要最新的可恢复镜像已安全落盘，物理虚拟机便可被立即销毁回收。

## 6. CubeSandbox：把声明容量与物理驻留分开

CubeSandbox 完整自研了从 API、调度器到 Shim、VMM 与 Guest Agent 的数据路径。其核心设计在于让大量并发 Sandbox 共享 Template 镜像的基础物理状态：

```text
Template rootfs       --reflink / CoW--> Sandbox rootfs
Template memory file  --MAP_PRIVATE----> Sandbox guest memory

未访问页：不进入物理内存
只读页：可以保留为共享文件页缓存
写入页：产生当前 VM 的匿名 CoW 页
```

在加载基于快照的 Guest 内存时，Cube 的 VMM 显式调用 `MAP_NORESERVE | MAP_PRIVATE`；底层代码严格区分了未触达页、共享只读文件页以及执行写操作后产生的私有匿名 CoW 页。[^cubesandbox-memory]

这阐明了一个声明 `2 GiB` 内存的沙箱，为何不会在初始化瞬间独占 2 GiB 物理内存。实际的驻留内存主要取决于 Guest 的工作集活跃页、脏页增量以及 VMM 自身的轻量开销。

但这并不意味声明内存彻底脱离了配额监管。声明规格依然进入 Cube 的调度记账，只是系统默认引入了内存 2 倍、CPU 3 倍的受控超卖比率（Overcommit Ratio）。[^cubesandbox-overcommit] 具体表现为：

```text
声明容量       决定 guest 上限与调度分配单位
调度容量       允许在受控比例下 overcommit
物理驻留内存   随实际访问和 CoW 写入增长
```

这也是“4 MB Sandbox”指标需要被准确厘清的关键所在。项目测试数据中的 `4-5 MiB` 专指 **VMM Overhead PSS**，并非整个沙箱系统的端到端总内存。在另一项 1000 实例（每实例配置 2 vCPU / 2 GiB）的纯创建压力测试中，依据整机可用内存（Free Available）衰减均摊，测得单实例系统增量约为 `21.5-25.7 MB`。[^cubesandbox-benchmark] 两项指标的统计口径不同，不可混同，亦不可直接与常规 Pod 的完整 RSS 粗暴对比。

Pause 机制在资源层面实现了二级剥离。Cube 保存 VM 寄存器状态、内存镜像与 rootfs 增量后，销毁当前 microVM，使宿主机物理 CPU 与内存得到真实释放。[^cubesandbox-pause] 不过，系统默认设置 `paused_resource_release_ratio=0`，使处于暂停期的沙箱继续保留调度记账名额，以保障后续 Resume 的准入确定性。管理员可按需调大配额释放比率以换取更高的承载密度，此时恢复流程将转为尽力而为（Best-effort）。[^cubesandbox-paused-quota]

CubeSandbox 的 Serverless 特质源自三层核心解耦：

```text
声明 guest RAM != 启动时立即占满物理内存
逻辑 Sandbox   != 当前 microVM 进程
启动基线       != 每个实例都复制一份完整内存
```

该模式的系统权衡十分明确。CoW 与超卖机制无法凭空增加物理承载上限；若大量轻载虚拟机同时爆发全量内存写操作，宿主机依然需要依赖实时容量过滤、预留警戒水位、cgroup 隔离及准入控制实施兜底防护。

当单台 microVM 的开销已优化至极低水平，架构面临更深层的命题：长效存续的 Agent 身份，是否必须与底层的沙箱对象强行绑定？

## 7. Agent Substrate：一个可以休眠的 Actor

Agent Substrate 将逻辑调度单位进一步提升为长期存在的 Actor。Create 操作首先向控制面写入初始状态为 `SUSPENDED` 的持久化记录，不立即分配专属 Pod 或拉起进程。[^substrate-create]

调用方获得稳定的全局 Actor 标识与访问端点。当外部请求到达且 Actor 未处于运行态时，Router 控制面自动触发 Resume，将其调度并绑定至处于就绪态的 Worker，随后完成流量转发。

```text
长期逻辑 Actor
  -> Resume
  -> 一次 active sprint
  -> 处理多次请求、修改内存和文件
  -> Pause 或 Suspend
  -> 释放 Worker
```

单个 HTTP 请求的终结不会终结 Actor 的生命周期，这不同于传统 FaaS “单次调用对应单次实例”的范式。此时核心调度单位演变为 **Actor activation**。

这种模式可归纳为 **“Serverless Actor”**：Actor 拥有持久的业务逻辑生命周期，Worker 沙箱仅充当其在活跃工作周期的瞬态执行载体。业务身份持续存续，高成本物理计算仅在执行任务时动态绑定。

## 8. Agent Substrate：把 Actor 时间复用到 Worker

Substrate 将 Kubernetes 收拢于相对低频的 Worker 集群编排，把高频的 Actor Activation 彻底移出 kube-scheduler 的核心链路：

```text
Kubernetes
  -> 预先维护 M 个 ready Worker Pod

Substrate
  -> 在数据库中保存 N 个逻辑 Actor
  -> activation 时选择一个 ready Worker
  -> 在 Worker 内启动或恢复 gVisor sandbox
  -> checkpoint 后终止 sandbox，释放 assignment
```

此处的“复用”具有严格的系统边界。当前实现显式限制每个 Worker 仅能承载一个活跃 Actor；WorkerPool 则通过标准 Kubernetes Deployment 预备底座 Pod。[^substrate-worker] 因此，Substrate 实施的是**大量休眠态 Actor 在时间维度上分时复用少量温热 Worker**，而非在单个 Worker 内无序混部多个并发活跃 Actor。

系统提供了两级挂起状态以平衡性能与放置自由：

| 操作 | 状态位置 | 恢复特征 |
|---|---|---|
| Pause | checkpoint 留在原节点 | 恢复较快，但受节点 locality 约束 |
| Suspend | checkpoint 上传为外部 snapshot | 可以换 Worker、换节点恢复 |

Pause 触发本地检查点保存并释放当前 Worker 占用；Suspend 则将全量快照推送到外部存储系统，并在控制面将其固化为该 Actor 最新的已提交稳态。[^substrate-pause-suspend]

快照的作用域决定了 Execution state 的恢复保真度：`FULL` 级别通过后端检查点完整保留进程树、内存镜像、rootfs 差分与持久化目录（DurableDir）；`DATA` 级别仅保留持久化数据目录，恢复时重新初始化应用运行时。[^substrate-scope] 这里的 `FULL` 代表接口规范与对应底层的检查点能力，并不意味其能保证任意外部网络长连接的透明保活。

Substrate 的容量账本因此形成分层管理：

```text
WorkerPool request
  -> Kubernetes 预留的共享计算容量

Actor limit
  -> Substrate placement 与 sandbox cgroup 上限
  -> suspended Actor 不追加一份 Kubernetes Pod request
```

若系统中托管一万个逻辑 Actor，但在同一时刻仅有一百个处于活跃计算状态，集群理论上仅需维系与并发数匹配并略带余量的 Worker 规模。静态存储成本随 Actor 总量与快照实体平缓增长，而计算开销严格受控于温热 Worker 基线及活跃任务数。

当前该技术栈仍依赖应用层的显式协同：官方示例中均通过显式调用 Suspend 来交还 Worker，尚未构建通用的空闲自动挂起闭环；若 Worker 发生物理单点故障，未完成检查点保存的活跃 Actor 将转入 `CRASHED`，无法做到透明的前向故障无损恢复。[^substrate-idle-failure]

Substrate 由此确立了一套全新的资源映射拓扑：

```text
Actor lifetime       != Worker lifetime
Stored Actor count   != Reserved Worker count
Request routing      != Kubernetes Pod scheduling
```

## 结语：Serverless 不等于无状态函数

将上述三套系统置于同一演进坐标系中，呈现出一条清晰的技术演进路径：

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

OpenSandbox 探索了如何通过统一控制面交付和管理完整的操作系统计算环境；CubeSandbox 攻克了如何利用写时复制与内存共享降低完整 microVM 的物理开销；Agent Substrate 则展示了长周期逻辑 Actor 与瞬态 Worker 资源在时间维度的弹性复用。

三类架构均突破了纯粹的无状态约束，但完整继承了 Serverless 解耦资源的核心原则：

1. 解耦逻辑身份与特定物理实例的排他性强绑定；
2. 解耦长效存续的业务状态与对昂贵物理计算资源的持续霸占。

对于 Agent 架构，核心议题已演变为：

> 我们能否让一个长期存在、有状态的逻辑程序，仅在真正执行任务时才动态占有一台计算机？

在此基础之上，Agent 的权威状态进一步分化解耦为会话交互历史、工作区文件实体及长期记忆，由外部状态面在激活时刻精准水合入不同的执行沙箱。这属于算力层之上的上层状态模型。但就底层计算基础设施而言，只要逻辑身份、可恢复状态与物理运行实例能够清晰解耦，有状态的智能体就与 Serverless 理念完全契合。

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

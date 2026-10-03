---
doc_id: computer-use-provider-evidence
title: "Computer Use provider 证据"
language: zh-CN
source_language: en
counterpart: ./computer-use-provider-evidence.md
implementation_status: current
document_status: current
translation_status: synced
last_verified: 2026-09-11
owners:
  - maka-backend
---
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

# Computer Use provider 证据

[English](./computer-use-provider-evidence.md)

本层定义真实模型 Computer Use 运行的证据契约。它不声称任何 provider 已经完成过真实运行。

## 场景契约

场景库定义：

- 一个自有（owned）的 Electron fixture；
- 精确的用户提示与预期状态；
- 禁止产生的效果；
- 允许的动作以及每个动作的预算；
- 必需的执行能力；
- 确定性的状态评估。

fixture 辅助程序只导入 Electron。它不导入 Maka Runtime、provider 传输层或执行后端。

## 报告契约

报告把证据分为四类：

- `real-runtime`：真实运行的 provider 模型使用了生产 Maka runtime；
- `fault-injection`：真实运行的 provider 与 Runtime 触发了一个具名的注入故障，但该运行无法
  被认定为真实宿主机证据；
- `hermetic-protocol`：伪传输层证明了协议行为；
- `static-contract`：仅做源码或 schema 检查。

只有 `real-runtime` 能满足标记为 `real` 的 provider 矩阵单元格。
被策略绕过的运行会保留可见的标记，且不能成为不带限定条件的通过。

真实报告还会 fail closed，除非生产者、传输层、策略模式、模型、fixture PID/窗口归属、
最新 observation 的谱系、动作预算以及 dispatch 来源都显式给出。预期失败必须由场景授权；
报告不能自我授权。

脱敏器保留动作类型、时序、结果码、聚合状态以及允许列表内的 trace 字段。
它会移除坐标、已输入的文本、原始 UI 内容、凭据、完整 URL 以及 provider 载荷。

## 汇总核对发现

复核发现，AppKit 生产者输出的是 `traces`，而资格验证读取的是 `driverTraces`；同时 Desktop
启动器从正在被评判的动作反推其 fixture 窗口允许列表。第一处不一致会拒掉有效的 AX 证据；
第二处则让归属证明出现循环。

现在两个生产者都输出同一套规范 schema。Desktop fixture 的身份在模型执行之前，
独立地由启动器持有的 PID 与执行器窗口清单采集得到。资格验证会等待匹配的 dispatch trace，
并要求每个目标都属于该独立身份。

资格验证还保留三条 fail-closed 不变量：

- 重启恢复只授权场景声明的过期 `set_value / target_missing` 结果，
  并为所需的新重试分配预算；
- 不被允许以及超出预算的模型尝试，会在 harness 拒绝它们之前先记录为规范的失败动作证据；
- Desktop 启动器与 provider 矩阵调用同一个真实报告校验器，因此启动器无法对一份矩阵判定无效的
  报告成功退出。

旧的真机直接资格验证 runner 已被移除。五轮的 restart runner 仍以
`npm run computer-use -- restart-soak` 提供，它使用
[Lab fixture 准备](./computer-use-evidence-classes.zh-CN.md#lab-fixture-准备) 中描述的
`MAKA_CU_AX_MODEL_LAB_ROOT` fixture 检出。该 runner 只用于回归，无法满足 provider 矩阵
单元格。这里只有一条资格验证路径，而不是多套并行证据标准。

## 下一层

provider 启动器必须：

1. 固定使用本库中的某个场景；
2. 针对自有 fixture 与生产 Computer Use 后端运行；
3. 在 dispatch 之前强制执行场景的动作预算；
4. 输出一份脱敏的 `real-runtime` 报告；
5. 让 provider 矩阵校验 fixture 状态与禁止产生的效果。

## 首次真实运行

首次通过资格验证的运行结果如下：

- provider：OpenAI；
- model：`gpt-5.4`；
- evidence class：`real-runtime`；
- tool exposure：direct E2E，只暴露生产环境的 `maka_computer` 工具；
- action：一次应用范围内的 `observe`；
- tool latency：1117 ms；
- total run latency：7502 ms；
- terminal status：`complete / end_turn`；
- fixture oracle：验证码匹配，且交互次数保持为 0。

采用 direct E2E 的工具暴露是刻意的。默认的延迟加载 `tool_search` 路径仍是一份独立的产品契约；
启动器收窄了 provider 变量，但仍会走通生产工具实现、权限引擎、Runtime、Desktop 宿主以及
执行器后端。

在这次运行中，OpenAI Responses 的工具续接暴露了一个产品缺陷：服务端存储在第二个请求里生成了
`item_reference`，却没有 `previous_response_id`，导致自定义 Responses 端点拒绝了该工具结果。
OpenAI provider 选项现在使用 `store:false`，与现有的 Codex 订阅边界保持一致，并让函数
调用/结果保持内联。

下一次运行应当在执行器加固合并之后，执行一次 AX 语义变更。

那次 L1 运行现已完成：

- scenario：`l1-single-click`；
- provider/model：OpenAI `gpt-5.4`；
- actions：两次 observation 与一次 `click_element`；
- 不允许任何基于坐标或兼容模式的输入动作；
- semantic click latency：1445 ms；
- total run latency：26023 ms；
- fixture oracle：主点击次数为 1，danger 点击次数为 0，过量点击次数为 0；
- terminal status：`complete / end_turn`；
- result：通过。

该运行起初 fail closed，因为用户的前台 ChatGPT 窗口遮挡了合成目标。现在 fixture 宿主会在
宣告就绪之前先稳定下来，并用 `showInactive()` 与 `moveTop()` 把它的 layer-0 窗口提升，且
不会将其聚焦，也不使用置顶覆盖层。

## 原生 WebContent 资格验证

由 `apps/desktop/bundled-tools.json` 固定的执行器现在携带源码提交
`4a9787d2c7f2fbc6a29b33d691916c6b84543661`，其中包括 `maka-agent/maka-cu#2`、#3 中的
窗口切换后续修复，以及 #4 中的直接 WebContent frame-reflow 修复。

共享的合成 CUA Lab 在集成前连续运行了十次：

- 在移除唯一的镜像之后，observation 暴露了一个 OOP 按钮；
- slider 的请求/回读/业务 oracle：`42 / 42 / 42`；
- 滚动路径：语义 `ax_action`，oracle 偏移量 `76`；
- OOP 点击路径：`skylight_pid`；
- DOM `MouseEvent.isTrusted`：`true`；
- 宿主本地鼠标事件：一次按下与一次抬起；
- 过期错误目标计数：`0`；
- 目标应用从未成为最前台。

一个独立的实时保留元素探针覆盖了三种 refetch 结果：

- 唯一替换：动作完成一次，错误目标 `0`；
- 缺失替换：`element_released`，无副作用；
- 有歧义替换：`element_changed`，无副作用。

在 #4 之后，由 `apps/desktop/bundled-tools.json` 固定的那个精确二进制
（`e457a3143544ba8385c489e5259f206d9450feb1c692eb562413b41b9f38de21`）完成了一轮与源码绑定的
五轮 Web 矩阵：

- 探针重新构建了干净的源码提交 `4a9787d2c7f2fbc6a29b33d691916c6b84543661`，
  并要求固定的二进制字节与该构建一致；
- 每次运行的主 AX 点击 oracle 都是 1；
- 每次 OOP 点击都使用 `skylight_pid`，产生 `MouseEvent.isTrusted=true`，并且恰好投递一组
  宿主本地鼠标按下/抬起；
- 每次运行 slider 都是 42，滚动偏移量都是 76；
- 唯一 refetch 只点击了预期的过期目标一次，而缺失 refetch 没有对目标或诱饵产生效果；
- 全部 30 个前台哨兵区间记录到的目标最前台采样为 0，每个区间至少 92 个采样，采样间隔最大
  为 80 ms。

确定性源码测试套件则另行强制让直接 WebContent 的仅 frame 重排走通唯一、缺失与有歧义三种
refetch 结果，保留独立的 renderer 进程代次，并确认原生 AX frame 变更仍然 fail closed。

这是原生执行器证据，不是 provider-model 的资格验证单元格。未来任何 `real-runtime` web 场景
仍然必须通过上面的报告契约。

同一源码提交还新增了 `doctor --json`。在锁屏状态上做的发布二进制冒烟测试正确报告了：
权限已授予、所有必需的 native SPI 均可用、ad-hoc 未加固签名，以及
`metadataObservation / screenshotObservation / trustedWebContentClick = false`。

模态窗口与次级窗口路由现在既有确定性证据，也有实时的原生功能证据。针对那个精确固定的二进制
连续跑了五次 CUA Lab，结果如下：

- 打开模态窗口，应用 observation 被路由到该 sheet，关闭，然后返回主窗口；
- 打开次级窗口，应用路由到最前台的次级窗口，精确窗口按钮点击、语义滚动，关闭，然后返回
  主窗口；
- 全部 30 条 dispatch 路径都是 `ax_action`；
- 按钮计数为 1，滚动偏移量达到 140；
- 五次单次运行的记录被保留在同一份聚合 fixture 中。

高频前台哨兵未通过：在十个模态/次级采样区间中，它记录到 1,738 个目标最前台采样，每个区间
至少 189 个采样，采样间隔最大为 96 ms。阶段级的前后读值掩盖了这次瞬时焦点抢占。因此
模态/多窗口路由在功能上已通过资格验证，但尚未满足后台焦点契约。

源码对两处实测到的 AppKit 竞态做了有界处理：新列出的 CGWindow 可能稍后才发布其 AXWindow；
在创建或关闭窗口期间，一次按压可能返回 `cannotComplete`。这套五次运行的 fixture 并未覆盖
拓扑恢复验证分支（`topologyRecoveryEvidenceCount: 0`），因此该行为仍属于实现与单元测试
证据，而不是实时结论。

这是原生执行器资格验证，不是 provider-model 矩阵单元格。

该固定版本现在还包含稳定的 AX observation 修订：

- 第一棵树获得深度优先的稳定 id；
- 匹配到的兄弟节点在全新的快照 token 之间保持 id 不变；
- 新 id 从高于此前最大值的编号开始；
- 动作后的 observation 可以渲染为无变化、有序的插入/更新变更、压缩后的已移除 id 区间，或
  整树回退；
- 显式 observe 仍然渲染完整的树。

这是 hermetic 协议/静态契约证据，不是 provider-model 资格验证单元格。原生源码套件通过了 326
个测试，并有 26 个显式的 live 测试跳过；宿主 Computer Use 套件通过了 124 个测试。
上面的模态/次级证据是在解锁之后运行的。

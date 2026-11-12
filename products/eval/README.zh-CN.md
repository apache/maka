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

# maka-eval

[English](README.md)

多臂基准评测实验的测量与控制平面（支持 `maka.eval.v1` 与 `maka.eval.v2`）。`maka-eval` 负责实验契约解析、任务组并发调度、阶段截止时间权威、持久化只追加（append-only）尝试日志、Token 与成本计量对账、Trial 环境编排及确定性对照报告生成。

## 原生 Host 与产品等价性（Product Parity）

在 Trial 镜像内将匹配版本的 `maka` 和 `maka-eval` 放在同一目录，`subject.config.makaExecutable` 指向原生 `maka`。拒绝 `nodePath`、`shimPath`、旧 provider 配置及仅面向评测的专用参数（`toolProfile`、`permissionMode: "bypass"`、`collaborationMode`、`orchestrationMode`）。

Maka 被测对象仅通过公开产品接口配置（`provider`、`connectionSlug`、`connectionName`、`baseUrl`、`model`、可选 `modelOverride`、`requestHeaders`、`requestBodyOverlay`、`sandboxMode`、`requestPermissions`、`thinkingLevel`、`language`、`workspaceInstructions` 与 `apiKeyEnvironment`）。适配器通过 `maka host init --settings-stdin` 初始化隔离的 Root，仅应用显式声明的公开 Settings/Session 配置，并通过生产客户端的 composer 草稿与回执协议提交任务，不注入评测提示词、不裁剪或替换工具、不注入合成模型参数。本地计量网关以只读方式统计提供商用量，原样转发请求体。无人值守执行不会静默绕过审批或交互请求，遇到挂起交互时以 `unattended-interaction-blocked` 显式结算；工作区或环境受限时以 `environment-limitation` 显式上报。

产品等价性是 `M3` 验收与 `M5` 生产交付的前置准入门槛（`RunFingerprint` 仅记录运行条件，不构成产品等价性证明）：
- `maka-eval parity <spec.json> [--subject <id>] [--out <report.json>]` 在相同版本、公开配置、工作区与任务输入下同时驱动常规 Maka 客户端路径与 `maka-eval` 入口，比对落盘的 `RunSpec`/`RequestSpec` 事实与出站报文，验证产品组合、生效指令、工具暴露及执行策略等价。
- `maka-eval report <spec.json> <dir> --milestone m3|m5 --parity-report <report.json>` 强制校验等价性报告（`m5` 同时要求全部单元完成确定性结算）。

当前原生执行器尚未配置代理侧车与挂载，因此 `egressProxy` 会在预检失败。清理未确认的尝试会跨次运行阻断准入，直到 `PostHocRecovery` 记录确认资源已处置。两版报告均读取已提交日志，不再将结果 JSON 文件作为另一权威；缺少定价依据的记录保持成本未知。

定向验证前先构建 `maka-cli`，运行 `cargo test -p maka-eval` 时通过运行时环境变量 `CARGO_BIN_EXE_maka` 指定其路径。CI 负责提供和归档原生辅助程序。真实 Host 与等价性测试使用本地假提供商，不产生付费模型调用。

## 模块结构

- [`contract`](src/contract.rs)：严格的 `maka.eval.v1` 实验与结果投影契约、原生的 `maka.eval.v2` 正交尝试维度（生命周期阶段、执行结果、计量完整性、环境清理状态）、仅记录运行条件的 `RunFingerprint` 及语义差异注册表。
- [`parity`](src/parity.rs)：端到端产品等价性验证，对比常规 Maka 客户端与 `maka-eval` 在产品组合、生效指令、工具暴露（Code Mode、内置 skill、工具 schema）及执行策略四项维度的等价性。
- [`measurement`](src/measurement.rs)：精确的 6 计数器 Token 核算（保留 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`、`reasoningTokens`、`totalTokens`，不重算求和）、无篡改计量网关、准入截止边界、HMAC 鉴权检查点恢复、回执与代理日志去重对账及标准 `DEEPSEEK_V4_FLASH_COST` 计价。
- [`store`](src/store.rs)：单写者只追加实验日志（`LaunchIntent`、`ResourceTagged`、`Checkpoint`、`Settled`、`PostHocRecovery`）、派发前意图落盘、原子结算提交、关键产物校验与确定性状态重建。
- [`runner`](src/runner.rs)：任务组并发准入（`maxConcurrentTaskGroups`）、共享预备缓存边界锁、分阶段截止时间控制、有界重试策略、最早有效尝试（`sequence >= 1`）规范结果选择及崩溃恢复。
- [`environment`](src/environment.rs)：单次尝试级 `TrialEnvironment` 抽象及版本锁定的 Harbor / Pier 桥接（1:1 尝试与 Trial 映射）。
- [`subject`](src/subject.rs)：被测系统适配器，包含 Rust Maka Host 适配器（通过 `maka host init --settings-stdin --root <ROOT_DIR>` 引导隔离的 Host Root、公开 Settings/Session 客户端执行、无人值守交互阻断与环境限制显式上报、持久化回执日志与历史/用量结算）和外部 CLI 适配器（`exit-code` 与 `protocol-v1` 有界结果帧）。
- [`report`](src/report.rs)：从日志确定性重建 `v1` 与 `v2` 结果、生成成对队列汇总报告、`M3`/`M5` 里程碑等价性准入校验及三项裁决差分对比报告（`v1_parses`、`v1_matches_oracle`、`conditions_comparable`）。

[源码](src/lib.rs) · [Cargo 配置](Cargo.toml)

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

@.agents/AGENTS.md

- 遵循 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 按真实需求选择最简单、完整的设计，不为假设需求增加抽象、配置或兼容层。
- 防御放在边界，内部信任契约；不要重复校验或用兜底掩盖错误。
- 用类型表达约束，让非法状态不可表示；用枚举区分状态，用新类型区分身份和单位。
- 明确所有权，优先借用；不要为绕过借用检查而复制数据或堆叠 `Arc`、`Mutex`。
- 正常缺失用 `Option`，可预期失败用 `Result`；保留错误原因，不静默吞错。
- 测试行为，而非实现。只保留能发现实际回归的测试，避免重复断言和随重构失效的实现细节测试。
- 按数据规模、运行时长和并发量判断成本，不只看小数据和单次耗时。
- 热路径只处理所需数据，避免全量扫描、重复计算与复制，以及状态无界积累。
- 同时考虑读取、写入、缓存维护、清理和恢复，避免把瓶颈转移到另一条路径。
- 减少共享状态和锁竞争，锁内不做无关的 I/O 或耗时工作。
- 不在异步执行器线程中执行阻塞 I/O 或长时间 CPU 计算。
- 用实际执行路径验证索引、缓存和批处理是否有效；修复一处，排查所有同类路径。
- 让布局本身说话。用结构、层级和交互表达意图，不堆砌 slogan、装饰和解释文案。
- 少写注释，只补充代码无法表达的关键约束、取舍或安全前提；随代码更新或删除过时注释。
- 将 `unsafe` 限制在最小边界，说明安全依据，并封装为安全接口。

## CI 维护

- 测试套件和执行入口统一维护在 [scripts/ci.mjs](scripts/ci.mjs) 及其模块中，`just` 和 workflow 复用这些定义；新增或移动套件时同步更新路由、归档资源及结果汇总。
- 修改 SDK、插件、fixture、构建脚本或嵌入资源时，检查实际消费者并更新 Cargo 图之外的输入依赖。内置 skill 的 Markdown 等文件也是产品输入，不能仅按扩展名跳过。
- 缩小测试编译范围前验证 workspace 的 feature 合并语义。修改归档时检查运行时读取的 `OUT_DIR` 资源及子进程可执行文件，并用独立 runner 上的现有行为测试验收。
- 修改路由或分片时，验证受影响的传递依赖仍会执行；计划要求的任务被跳过、取消、失败或全量测试意外为空时，统一检查必须失败。

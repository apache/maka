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

# Recall 批量读取验证

2026-09-30，基于 `ed38ccbb6bac474b93e4517f2a12a30209c108d5` 上的本地修改。

完整消息读取原先执行两次会话级查询，加上每个 invocation/run 的 terminal、事件、partial snapshot 和 partial segment 查询。ordinal 读取还会解码一遍全量事件，只用于提取 ID。

新增的 `readSessionRuntimeSnapshot` 在同一个 SQLite 读事务内完成五次批量查询：opening、其余事件及运行顺序、轻量 ordinal、partial snapshot、partial segment。复用 opening 和 terminal 事件对象，避免重复传回或解码 payload。ReadModel 保持原来的投影、校验和排序；没有批量能力的存储继续使用原读取路径。

Recall 先确认语料计数是否可用，再读取候选会话。计数不可用时直接选择全量扫描，避免候选会话被读取两遍。

## 测量

Node v24.14.0，内存 SQLite 合成数据：一个会话，每个 Turn 有 opening、user、terminal 三个事件，前十个 Turn 命中。比较当前批量路径与禁用批量能力的原读取路径，预热一次，七轮交替执行；每轮断言完整 Recall 结果一致。耗时包含 Core Recall、SQLite 和 ReadModel，排除 IPC、UI 和写入构造。SQL/JSON 计数在计时之外，单独测量完整 ReadModel，不含候选筛选和语料计数，也不含事务控制语句。

| 20,000 Turn，返回 10 个片段 | 原读取路径 | 批量路径 |
|---|---:|---:|
| 查询中位数 | 1,603.63 ms | 492.25 ms |
| 完整读取 SQL 次数 | 80,002 | 5 |
| 完整读取 JSON.parse 次数 | 160,000 | 60,000 |

原路径七轮耗时（ms）：1602.75、1594.61、1617.21、1669.82、1581.42、1603.63、1644.06。

批量路径七轮耗时（ms）：501.35、524.70、459.48、485.32、475.29、492.25、533.18。

单 Turn 的 21 轮中位数为 0.23 → 0.18 ms，SQL 为 6 → 5，JSON.parse 为 8 → 3。绝对耗时很短，仅作小输入检查。

```sh
npx tsc -b packages/core packages/storage packages/runtime
node packages/runtime/scripts/benchmark-recall.mjs 20000 7
node packages/runtime/scripts/benchmark-recall.mjs 1 21
```

## 验证和边界

- Storage 全套：1,545 通过，8 跳过；Runtime 全套：3,699 通过，14 跳过。运行时设置 `NODE_OPTIONS=--disable-warning=ExperimentalWarning`。
- Core Recall 与 Host Recall：66 通过。受影响包及 Runtime Host 的 TypeScript 构建、修改文件 lint/format、`git diff --check` 通过。
- 回归覆盖固定 SQL 数、每个事件只解码一次、降级不重读、原路径与批量路径的完整结果一致、partial 流、child 排除、旧版 opening、损坏事件校验和读取期间并发 terminal 写入。
- 保留完整候选会话扫描与排名语义；20,000 Turn 仍投影 40,000 条消息。此修改消除重复 I/O 和 N+1，不引入搜索索引，不把 `limit` 当作提前停止条件。
- Host 请求取消链路是独立问题，此次未修改。

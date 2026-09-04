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

# Filesystem Read/Tree Lease 测试报告

日期：2026-09-04

平台：Windows，Node.js v22.23.2

工作区：`D:\harness learning\maka-agent`

## 1. 结论

Filesystem Read/Tree Lease 的实现和定向回归通过。最终扩展矩阵为 **62 pass、0 fail、0 skip**。

本轮补齐了以下关键证据：

- 独立 `settleToolCallBatch()` 之间的 Read/Edit 与 Grep/Write 冲突；
- 不依赖 Scheduler 的 prepared Read/direct Edit owner 互斥；
- structured single-operation patch 与 Read/Grep 的直接 overlap；
- root/child tool composition 共享同一个 filesystem coordinator；
- multi-key 原子准入、writer fairness、abort/reject release；
- Windows junction 与 POSIX symlink 的 canonical alias、越界和“不跟随删除”语义；
- unknown tool fallback、`all`/`none` 真值表和 provider-order 结果槽稳定性。

原先的 State Root ownership namespace 权限阻塞在 unrestricted 环境下不再出现。Runtime Host 全量测试仍不能宣称全绿，但剩余失败已确认是独立的 Windows SQLite teardown、默认测试并发资源压力和 real-model terminal timeout，不是本次 filesystem lease 行为失败。

## 2. 实现范围

实现包含：

- process-owned `FilesystemLeaseCoordinator`；
- exact/tree read-write 冲突判断；
- writer-fair、abort-aware 等待队列；
- `acquireMany` 风格的 multi-key 原子准入，禁止部分持有；
- canonical、Windows case-folded lease key；
- Read/Write/Edit/Grep/Glob/apply_patch 的 owner-level lease；
- freeform multi-file patch 的整组 lease interval；
- Runtime Host root/child composition 共享 coordinator；
- patch unknown-outcome 与现有 authority contract 对齐。

## 3. 测试矩阵

| 类别 | 主要场景 | 结果 |
| --- | --- | --- |
| Lease key | POSIX canonical、Windows case fold、`src`/`src2` separator boundary | 通过 |
| Coordinator | exact/tree RW、并发 read、独立路径 fan-out、writer fairness | 通过 |
| Abort/release | queued abort、pre-abort、active abort、effect reject 后释放 | 通过 |
| Multi-key admission | reversed keys、dedupe、全量原子准入、禁止 partial admission | 通过 |
| 独立 batch | Read/Edit、Grep tree/child Write | 通过 |
| Owner correctness | prepared/direct 路径绕过 Scheduler 后仍互斥 | 通过 |
| Patch | structured patch overlap、multi-file interval、exact-write claims | 通过 |
| Root/child | 两个 composition 共享 coordinator | 通过 |
| Alias | prepared junction/symlink canonical lease identity | 通过 |
| Boundary | junction/symlink 越界拒绝、bypass 可访问 | 通过 |
| Delete link | 删除 reparse/link entry，不跟随删除目标 | 通过 |
| Kimi semantics | unknown→`all`、`all`/`none`、fairness、provider order | 通过 |

## 4. 执行结果

### 4.1 类型检查与构建

以下命令通过：

```text
npm --workspace @maka/runtime run typecheck
npm --workspace @maka/runtime-host run typecheck
npm --workspace @maka/runtime run build
npm --workspace @maka/runtime-host run build
```

### 4.2 最终扩展矩阵

运行：

```text
node --test \
  packages/runtime/dist/__tests__/filesystem-apply-patch.test.js \
  packages/runtime/dist/__tests__/filesystem-authority-contract.test.js \
  packages/runtime/dist/__tests__/filesystem-authority-leases.test.js \
  packages/runtime/dist/__tests__/filesystem-authority.test.js \
  packages/runtime/dist/__tests__/filesystem-lease-coordinator.test.js \
  packages/runtime/dist/__tests__/filesystem-lease-key.test.js \
  packages/runtime/dist/__tests__/filesystem-tool-call-batch-scenarios.test.js \
  packages/runtime/dist/__tests__/tool-authority-kimi-semantics-batch.test.js \
  packages/runtime-host/dist/__tests__/filesystem-lease-composition.test.js
```

结果：

```text
tests 62
pass 62
fail 0
skipped 0
```

### 4.3 Windows link 定向矩阵

Windows 当前进程令牌没有 `SeCreateSymbolicLinkPrivilege`。测试采用平台等价策略：Windows 使用无需提权的 directory junction，POSIX 保留 symlink。该策略实际验证 reparse entry 的 canonicalization、越界拒绝和不跟随删除，而不是简单跳过。

结果：

```text
tests 23
pass 23
fail 0
skipped 0
```

### 4.4 静态质量检查

以下检查通过：

```text
biome format
biome lint
git diff --check
```

## 5. Runtime Host 全量测试记录

使用 unrestricted filesystem 权限后，Host 测试不再出现 `StorageRootAuthorityError` 或 State Root ownership namespace 解析失败。

全量测试进行了两种运行：

1. 默认 Node 文件并发：多个 Host/child 进程出现 JavaScript heap OOM，随后残留句柄导致测试不退出。
2. `--test-concurrency=1` 串行：消除了 OOM，但在 Windows SQLite 临时库清理阶段稳定出现 `EBUSY`，并在后续大型 composition 文件中出现长时间不退出。

独立复现结果：

- `canonical-session-projection.test.js`：8 个用例均在清理 `runtime.sqlite`、`runtime.sqlite-wal` 或 `runtime.sqlite-shm` 时因 `EBUSY` 失败；
- `execution-model-composition.test.js`：存在既有 real-model Turn terminal timeout、SQLite `EBUSY`，随后测试进程不退出；
- 本次新增的 `filesystem-lease-composition.test.js` 通过；
- Host production composition、State Root startup、root/child filesystem coordinator 路径均可运行。

因此，本报告不将 Runtime Host 全量 suite 标记为全绿。剩余问题应作为独立的 Windows SQLite close/cleanup、测试并发上限及 real-model timeout 工作处理。

## 6. Review disposition

测试已经证明 filesystem correctness 不依赖单一 batch Scheduler。仍需在 PR 文案中明确：

- unknown real tool 默认 `all` 是安全优先的吞吐回退；
- provider order 只用于冲突调度和结果槽稳定性，不表达数据依赖；
- subagent fan-out 继续由既有 capacity limiter 控制，capacity 尚未统一表达为本 authority contract；
- global `all`、dynamic MCP policy 和 Bash workspace-scoped coarse authority 不属于本次 filesystem lease 实现范围。

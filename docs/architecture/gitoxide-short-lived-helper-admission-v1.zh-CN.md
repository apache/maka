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

# Gitoxide short-lived helper：repository admission v1

状态：验证切片；尚无 Desktop、CLI、Runtime Host 或 M2 生产消费者，只能保持 Draft。

## 1. 主要不变量

本切片只证明：

> 在选择 managed-workspace durable mode 或写入 T1 以前，Git backend owner 可以通过一个
> 短生命周期、隔离配置的 Gitoxide helper 观察 repository object format 和 exact HEAD identity；
> 只有 SHA-1 repository 返回 observation，SHA-256 与未知格式稳定 fail closed，且不得调用或
> 回退到系统 Git。

它不证明 source import、clone、fetch、worktree、candidate、projection、ref CAS、Write/Edit 或
resume。现有 dormant `GitWorkspaceService` 也没有切换到该 helper。

## 2. 为什么是 helper，不是常驻 broker

`maka-gitoxide-helper` 每次启动只执行以下协议：

```text
stdin:  一个最大 64 KiB 的 strict JSON request
        ↓
Gitoxide isolated repository observation
        ↓
stdout: 一个 JSON response
        ↓
process exit
```

进程不监听 socket、不复用 repository handle、不保存 caller identity，也不拥有跨请求锁或可恢复
状态。因此它不是新的常驻 authority；durable ownership 仍必须由未来的 Storage/Runtime owner
通过 SQLite、artifact receipt 与 scoped capability 建立。

## 3. Owner、原子边界与失败状态

| 项目 | v1 合同 |
| --- | --- |
| operation owner | 单次 `maka-gitoxide-helper` 子进程 |
| 输入 | `inspect_repository` strict JSON，最大 64 KiB |
| 配置边界 | `gix::open::Options::isolated()` + `strict_config(true)` |
| 成功 | exit 0；SHA-1 + exact HEAD commit/tree OID |
| policy rejection | exit 2；`unsupported_object_format` |
| operational failure | exit 1；稳定 `helper_error.reason` |
| 原子性边界 | 单个 repository handle 的一次只读 observation；无跨介质事务 |
| rollback | 只读操作，不需要回滚 |

当前 response 中的 observation 不是不可伪造的进程外 capability。未来 Node/Runtime adapter 必须先
验证 helper binary/release identity、绑定 invocation input，并把 observation 转换为 owner-issued
opaque capability；不能让 caller 直接提交裸 OID 或 object format。

## 4. SHA-256 策略

Cargo 编译 `sha256` feature 只用于识别并给出稳定拒绝，不代表 Maka 已支持 SHA-256 repository。
v1 的 `supportedObjectFormats` 固定为 `["sha1"]`。未来支持必须显式升级 backend capability 与
协议测试，禁止静默 fallback。

## 5. 测试与工具链

- 普通 `npm test`、TypeScript workspace 测试和最终用户运行不要求 Rust 工具链。
- 修改 helper 时运行 `npm run test:gitoxide-helper`。
- `Cargo.lock` 是 source/build identity 的一部分并进入版本控制。
- 三平台独立 CI 构建同一源码并运行协议测试。
- 测试使用 Git CLI 预先构造真实 fixture；启动 helper 后清空 `PATH` 并注入恶意 Git config 环境。
  如果 helper 尝试使用系统 Git 或 caller config，测试会失败。

## 6. 平台能力矩阵

| 平台 | 当前验证目标 | 尚未承诺 |
| --- | --- | --- |
| Linux | SHA-1 inspect；SHA-256 reject；无 system-Git fallback | packaging、sandbox、crash recovery |
| macOS | 同 Linux | signing、notarization、production packaging |
| Windows | 同 Linux | Authenticode、job owner、production packaging |

只有三个 CI lane 都建立证据后，才能把“当前验证目标”升级为持续平台承诺。

## 7. 下一切片

后续 stacked Draft 先建立 helper artifact claim → opaque invocation capability 的内部边界，并明确
正式 packaged-release trust root 尚未接入；详见
`gitoxide-helper-artifact-authority-v1.zh-CN.md`。再后续才把一次 repository observation 转换成
T1 前可消费的 opaque admission capability。source import、fresh projection 与 candidate ref CAS
继续分别验证，不能在 admission PR 中顺手恢复旧 Git CLI adapter。

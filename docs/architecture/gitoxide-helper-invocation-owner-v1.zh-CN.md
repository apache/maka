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

# Gitoxide short-lived invocation owner v1

状态：可独立合并的 enabling infrastructure；真实 Rust helper 的三平台 contract 进入 CI，但正式
release issuer 与 Desktop/CLI managed-workspace 产品接线仍未完成。

## 1. 主要不变量

本切片只证明：

> Runtime Host 只能通过 owner-bound opaque artifact capability 启动一个刚完成 artifact observation 的
> Gitoxide helper path；
> invocation 使用固定 strict JSON request、最小环境、有界 stdin/stdout/stderr、固定超时与取消边界；
> exit 0/1/2 必须分别匹配 inspected/operational failure/policy rejection 的 exact response shape，任意
> 不一致均 fail closed。

它不签发 repository admission capability，不写 SQLite/T1，不创建 Git artifact，也不接 Desktop/CLI。

## 2. Owner 与调用链

```text
opaque GitoxideHelperInvocationCapability
        ↓ invocation owner token 验证 + artifact bytes 重验
fixed argv [] / minimal env / no shell
        ↓ 64 KiB strict JSON request
one short-lived Rust helper
        ↓ bounded stdout/stderr + exact exit/response decoder
typed observation | typed policy rejection | stable error
```

caller 不能提供 executable path、argv、environment、protocol version、timeout 或 output limit。可变
业务输入只包括 operation 所需的 absolute repository path、显式 policy 与 AbortSignal；repository path
在 spawn 前 canonicalize。

## 3. 原子性、失败状态与回滚

| 项目 | v1 合同 |
| --- | --- |
| owner | 单次 Runtime Host invocation owner |
| 原子性边界 | 从 public operation 入口开始的一次绝对 deadline、artifact/path preflight、一个 helper process 及其 exact response |
| 成功 | exit 0 + exact SHA-1 `repository_inspected` |
| policy rejection | exit 2 + exact `unsupported_object_format` |
| repository/helper failure | exit 1 + allowlisted stable helper reason |
| timeout | inspect 为 5 秒、source import 为 10 分钟；同一个绝对 deadline 从 public 入口覆盖 preflight 与执行。若 helper 已启动，共享 lifecycle force-kill process tree，并以有界 exit acknowledgement/output drain 收口；若仍在 Node 文件系统 preflight，调用方按 deadline fail closed，迟到结果被丢弃且不得签发 capability |
| cancellation | preflight 或运行中 fail closed，`gitoxide_helper_invocation_aborted` |
| resource failure | repository open 前的本地 metadata 总量 1 MiB、16,384 entries、primary `objects/pack` 1,024 entries；source alternates 一律拒绝；Gitoxide object allocation 64 MiB、object-store slots 固定 1,024、stdout 64 KiB、stderr 16 KiB；超限 fail closed 或 force-kill |
| malformed protocol | exit code、JSON shape、OID 或字段不一致均拒绝 |
| rollback | inspect 无 durable side effect；import 只允许 fresh destination，但 partial artifact cleanup 留给未来 storage owner |

Rust helper v1 不启动 descendants；Runtime 仍使用共享 process-tree terminator 处理 timeout、abort 和
output overflow，不允许常驻或 detached helper。

Node 的 `realpath`/artifact 文件读取没有可移植的 syscall cancellation。v1 因此只承诺 public operation
在绝对 deadline 内返回或 fail closed，不声称 timeout 能终止已经交给操作系统的 preflight I/O；该 I/O
的迟到完成不能启动 helper、签发 repository capability 或发布 artifact。

## 4. 配置与数据边界

- argv 固定为空，禁止 caller 注入 helper option；
- `shell: false`，不会经过 shell parsing；
- child `PATH` 为空，只保留 Windows loader 与临时目录所需的最少环境变量；
- Rust 侧在 `gix::open()` 前按 pinned Gitoxide discovery 顺序检查 worktree 与 bare candidate，并有界
  解析 `.git`/`commondir` 路径文件、`HEAD`、config、packed refs、shallow、refs tree 与 primary
  `objects/pack`；`objects/info/alternates` 或 `http-alternates` 只要存在就以
  `repository_alternates_unsupported` 拒绝，不递归打开外部 object database；metadata 总量超过 1 MiB、
  条目超过 16,384、pack 目录超过 1,024 entries 或深度超过 64 时返回
  `repository_metadata_limit_exceeded`；随后使用 `gix::open::Options::isolated()`、
  `lossy_config(true)`、`strict_config(true)` 与固定 1,024 个 object-store slots，禁止 Gitoxide 再按
  未验证磁盘状态决定初始 slot allocation；
- request 最大 64 KiB；stdout 最大 64 KiB；stderr 最大 16 KiB；
- SHA-1 OID 必须是 40 位小写十六进制；SHA-256/未知格式只返回 rejection，禁止 fallback。

## 5. 平台证据

同一个 workflow 使用 release toolchain 的 Node 24.18.1，在 Linux、macOS、Windows 上：

1. 编译并测试 Rust helper；
2. 构建 Runtime Host；
3. 通过真实 helper executable 验证 SHA-1 success、SHA-256/未知格式 rejection、unborn SHA-1
   failure、checksum mismatch 和 portable managed-tree policy。

该证据只覆盖 helper 协议、进程终止与 fresh-only import，不包含平台安装签名或恶意同用户替换。
当前实现会在 spawn 前完成 bytes/identity observation，但 Node 的 path-based spawn 不能把已打开并验证的
handle 直接作为 executable，因此 observation 与 exec 之间仍有 TOCTOU。正式 packaged-release owner
必须依赖平台签名和受保护安装目录；v1 不声称抵抗拥有同用户写权限的攻击者。

## 6. 下一切片

同一 consolidated PR 的后续 authority layer 已把 exact repository observation 转换成 owner-bound
opaque admission capability，并用它驱动 fresh-only source import；合同见
`gitoxide-repository-admission-capability-v1.zh-CN.md`。仍不在本 PR 实现 durable T1、worktree
projection、candidate、recovery owner 或 ref CAS。

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

# PR2 官方二进制前置验证记录

验证日期：2026-09-12。平台：macOS arm64。ACP SDK：1.4.0。官方 Antigravity ACP：1.1.1。状态：**实际任务执行被提供方拒绝，未通过验收**。

## 程序来源与隔离

程序使用 [PR1 固定的官方发行包](../antigravity-acp-settings.md)，未修改官方二进制。SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `agy_acp_server.par` | `9d900b93031fc42397f88206e14eba4193729bbef631a70b18e7a19631a6dfac` |
| `localharness_external` | `e0a8ef9d80a1ffb178f945159dda33f73d4a5be65516642542352584b834fa2a` |

在独立临时项目中执行，测试文件为公开的加法函数和断言。RPC 有期限，所有官方进程及 helper 已完成进程树清理。没有写入真实项目文件、改系统代理或切换模型来绕过提供方拒绝。

## 认证与代理差分

1. 初始 `session/new` 返回 Authentication required。用户在官方 Google 页面完成认证后，`authenticate` 返回 `{}`。
2. 系统同时配置 HTTP、HTTPS、SOCKS 代理，初始子进程没有代理环境变量。`session/new` 稳定返回 `-32603`，诊断为 `python-socks is required to use a SOCKS proxy`。
3. 保持程序、凭据和请求相同，仅向子进程显式传入已有 HTTP 代理的 `HTTP_PROXY` 和 `HTTPS_PROXY`，`initialize → session/new` 成功，无需再次打开登录页。
4. 未发送模型或模式设置请求。官方返回默认模型 `gemini-3.7-flash-high`、模式 `default`。这些只是此次观测值，不是产品硬编码配置。

推论：仅继承进程环境会触发官方 Python 的 macOS SOCKS 自动发现问题。产品应消费 Maka 已准入的 HTTP/HTTPS 代理，且不能将 SOCKS 端点自动转换为 HTTP。

## Prompt 的实际结果

两轮 prompt 的 RPC 均返回：

```json
{ "stopReason": "end_turn" }
```

但 assistant 文本均为执行错误，包含 HTTP 403、`PERMISSION_DENIED`、`UNSUPPORTED_LOCATION`；没有输出约定的 `ACP_DEFAULT_OK` 标记。首次 probe 仅按 RPC 成功判定，随后已纠正为检查实际消息与业务结果，记录 `assessment.accepted: false`。

登录成功、session 创建成功、prompt RPC 正常结束这三个事实，均不足以证明任务执行成功。真实错误文本必须保留可见；后续执行状态设计不能把它们当作验收成功依据。

## 仍未验证的行为

- 文件读写、执行测试、工具通知、diff、权限拒绝、提问。
- 有效同会话多轮、普通取消后续聊、等待权限时取消、完成与取消竞争。
- 运行中异常退出、helper 清理对当前轮的影响。
- 成功任务的跨进程 resume/load 可行性。

这些行为没有证据，并非已证明不支持。`initialize` 声明的能力不能替代实际行为验证。不得降低计划验收标准，也不继续对已被拒绝的账号重复提交工具任务。

## 本地复现材料

此 worktree 的 `output/pr2-probe/` 保存脱敏 JSON 与脚本：`README.md`、`probe.mjs`、`session-new-check.mjs`。原始账号凭据、授权 URL 均不包含在记录中。

- `new-red-2.json`：无显式 HTTP 代理环境的 session 创建失败。
- `new-http-proxy.json`：只改变子进程代理环境后的创建成功。
- `default-prompt-http-proxy.json`：两轮实际错误文本及失败验收结论。

恢复条件：提供方允许当前开发环境实际执行官方默认 prompt。恢复后先重跑完整真实验收 gate，再推进依赖这些行为的 PR2 产品实现。

## 自动化验证的边界

本轮新增基础设施测试使用本地 SDK fixture；它们验证代理传递、认证证据和已观察进程的清理，不能替代以上官方任务验收。

尚未验证官方程序及 helper 对 `NO_PROXY` 通配符的解释是否等价于 Maka。原生 Python urllib 不支持 Maka 的全部通配格式；传递代理环境不代表两套绕过规则已实现等价。

原有进程树终止工具在父进程退出后无法追溯从未观察到、且已脱离原进程组的 daemon。不得将已知 helper 的清理测试宣称为任意 daemon 的生命周期保证；官方任务崩溃时的进程清理仍属于后续真机 gate。

本轮曾以真实本地 helper 和针对该 PID 的 `SIGKILL` / `EPERM` 注入复现“已发现逃逸 helper 存活，dispose 却成功”的缺陷；现已修复为保留进程身份并验证退出后才成功。回归覆盖重试、身份变化、未知身份和不再向已释放的旧进程组发送信号。

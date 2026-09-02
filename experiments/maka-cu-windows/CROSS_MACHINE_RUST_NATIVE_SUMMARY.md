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

# Cross-machine Rust native Computer Use summary

Run date: 2026-09-03. This is an uncommitted local evidence record for the
`codex/maka-cu-rust-comparison` worktree. All application tests used owned
fixtures. Chromium received six independent temporary profiles; no existing
Chrome profile or user document was opened.

## Environment

| Item | Value |
|---|---|
| Windows | Windows 11 Pro, 10.0.26200, AMD64 |
| Node used for build/tests | v24.19.0 bundled runtime |
| .NET SDK | 10.0.400 |
| Rust | rustc 1.89.0, cargo 1.89.0 |
| Protocol | `maka.cu/2` |

## Artifact

The formal native source is `maka-cu/apps/OpenComputerUseWindows/native`.
The prepared Desktop helper is:

`apps/desktop/resources/bin/maka-cu-windows/maka-cu-windows.exe`

- Size: 710656 bytes
- SHA256: `9d62d9043443b82e8586dbf784792b0ff502fe55020850fff001baeb9ea815e9`
- `distributionReady`: `false`

## Architecture gate status

- `maka-agent/maka-cu#6`: the local formal Windows executor is now a native
  Rust/direct-COM implementation speaking the shared `maka.cu/2` contract. Its
  source is mirrored into the experiment tree and the two copies have matching
  SHA256 values.
- `apache/maka#4497`: the local Runtime/Computer Use surface is semantic-only;
  coordinate mutation is not exposed to the model, while keyboard remains
  capability- and observation-bound.
- `apache/maka#4409`: the local product-side integration uses the shared
  supervised lifecycle and a thin Windows native-helper selection/artifact
  seam; it does not retain the former private Windows protocol as a production
  adapter.

These are uncommitted local convergence results, not merged upstream PRs. The
production gate remains closed until provenance, packaging, clean-machine,
packaged conversation E2E, and the complete real-application matrix are
qualified.

## Results

| Surface | Result | Evidence |
|---|---:|---|
| Formal Rust cargo tests | 8 pass, 0 fail | `maka-cu` native crate |
| Shared-protocol lifecycle | 29 pass, 0 fail | `maka-cu2-lifecycle-driver.mjs`; fresh HWND/PID/title/start-time/generation checks |
| Cold-start / memory / first-frame measurements | handshake: 46.916 / 52.471 / 42.470 ms; helper working set: 8,601,600 / 8,597,504 / 8,572,928 bytes; first WPF frame: 1,563.699 ms; post-frame working set: 54,112,256 bytes | `performance-results-cross-machine-rust-formal-native.json`; three fresh helper PIDs and a fresh fixture PID/HWND |
| `apps.launch` | 6 pass, 0 fail | `app-launch-results-cross-machine-rust-formal-native.json` |
| Formal `dispatch.key` rerun | WPF: 17 pass, 0 fail, 1 honest unknown; Chromium: 9 pass, 0 fail, 3 blocked, 1 honest unknown | `app-task-results-cross-machine-rust-formal-native.json`; `browser-results-cross-machine-rust-formal-native.json` |
| WPF direct run on .NET 10 fixture | 17 pass, 0 fail, 0 blocked, 1 honest unknown | `app-task-results-cross-machine-rust-formal-native-key-net10.json`; `net10.0-windows10.0.22621.0` fixture |
| WPF matrix (current key-dispatch release) | 102 pass, 0 fail, 0 blocked, 6 unknown | `app-task-results-cross-machine-rust-formal-native-key-matrix-1..6.json`; six distinct PIDs and HWNDs |
| Chromium matrix (current key-dispatch release) | 54 pass, 0 fail, 18 blocked, 6 unknown | `browser-results-cross-machine-rust-formal-native-key-matrix-1..6.json`; six distinct PIDs, HWNDs, and temporary profiles |
| Computer Use host integration | 117 pass, 0 fail | prepared Rust helper plus WinForms fixture |
| Desktop host targeted tests | 17 pass, 1 environment-blocked (Windows symlink EPERM); native capability contract 13/13 pass | `computer-use-host.test.js` and `runtime-host-native-capabilities.test.js` |
| Windows x64 packaged application | pass; installer, zip, and block map generated | `apps/desktop/release`; packaging exit code 0; Spectre/MSB8040 did not recur |
| Real Electron Maka smoke | 7/7 programmatic pass | latest report `apps/desktop/tests/real-window-smoke/2026-09-02T18-28-30-785Z.md`; isolated user-data; rendered UI and no error boundary |
| Manual real Maka Computer Use browser navigation | user-confirmed pass | isolated local Maka session opened a new Chrome test instance and navigated to `https://www.google.com/`; no existing Chrome profile was used |
| LibreOffice real-app probe | 9 pass, 1 fail (`dispatch_refused`), 0 blocked, 0 unknown | `libreoffice-results-cross-machine-rust-formal-native.json`; temporary Writer profile; no user document |
| WinUI/UWP availability | Calculator, Notepad, and Paint packages detected; Notepad restored an existing session, so the probe stopped before input or mutation and no new full mutation matrix was accepted | `real-app-availability-cross-machine-rust-formal-native.json` |
| Automated real-model Maka runner | not run; provider/bridge environment was not configured for the dedicated runner | `scripts/computer-use/real-model.mjs`; this is separate from the manual Maka smoke above |
| CU-scoped source build | pass; repository-wide build is blocked by pre-existing `@maka/ui` type errors (`settledText`, `autoScroll`, `trailingAction`) outside this change | bundled Node 24.19 |

The Chromium blocked cases are the current UIA provider's honest refusal of a
safe writable `ValuePattern` route and `TextPattern` selection route. Enter is
kept as `unknown`; a page oracle is never promoted to helper verification.

## Blockers and interpretation

1. The Windows x64 package now completes successfully on this host. `node-pty`
   rebuild and electron-builder both exit successfully; the earlier Spectre/
   `MSB8040` error did not recur. Clean-machine validation is intentionally
   skipped by the current scope, so this remains local-machine evidence.
2. The legacy `comparison-harness.mjs` still sends the former private
   `initialize`/`list_windows` protocol to its Rust subject and reports 0/34.
   It is not a valid shared-protocol conformance runner; the new `maka-cu2`
   lifecycle driver is the authoritative Rust result.
3. LibreOffice was present at `D:\soft\program\soffice.exe`. Its temporary
   Writer window was observed and captured successfully, but one semantic
   Properties-button press returned the executor's typed `dispatch_refused`.
   The mutation was not retried; the result remains a real-app action refusal,
   not a fabricated pass or unknown.
4. The dedicated platform-aware real-model runner was not executed: this machine has no
   `MAKA_CU_PROVIDER`, provider API key, or local bridge listening on port 8538.
   This is an environment block, not a Computer Use pass/fail result.
5. WinUI/UWP package discovery succeeds for Calculator, Notepad, and Paint.
   Notepad restored an existing session with user-visible tabs, so the probe
   stopped before input, save, or mutation; package availability is not
   task-matrix coverage.
6. The ASF header suite has one environment-only failure because Windows denied
   creation of its temporary symlink (`EPERM`); the source/header checks and
   `git diff --check` pass.

## Production decision

The native executor, focus-bound keyboard dispatch, shared lifecycle,
semantic-only schema, packaging manifest, and fixture evidence are materially
advanced, but this is not yet clean-machine or production evidence. The legacy
comparison harness still needs a shared-protocol migration; Chromium text input
and selection remain provider-blocked. The repository-wide build is also
blocked by pre-existing `@maka/ui` type errors outside this change; the
Computer Use packages and desktop main build pass.

---

# Rust native Computer Use 跨机器摘要

运行日期：2026-09-03。本文件是
`codex/maka-cu-rust-comparison` 工作区中的未提交本地证据记录。所有应用测试
均使用本测试拥有的 fixture。Chromium 使用六个独立临时 profile；没有打开用户
现有 Chrome profile 或用户文档。

## 环境

| 项目 | 值 |
|---|---|
| Windows | Windows 11 Pro，10.0.26200，AMD64 |
| 构建/测试 Node | bundled runtime v24.19.0 |
| .NET SDK | 10.0.400 |
| Rust | rustc 1.89.0，cargo 1.89.0 |
| 协议 | `maka.cu/2` |

## 产物

正式 native 源码位于 `maka-cu/apps/OpenComputerUseWindows/native`。
Desktop 已准备的 helper 为：

`apps/desktop/resources/bin/maka-cu-windows/maka-cu-windows.exe`

- 大小：710656 bytes
- SHA256：`9d62d9043443b82e8586dbf784792b0ff502fe55020850fff001baeb9ea815e9`
- `distributionReady`：`false`

## 架构门禁状态

- `maka-agent/maka-cu#6`：本地 formal Windows executor 已经是使用 Rust/direct-COM
  并实现 shared `maka.cu/2` 的 native executor；它与实验目录中的源码副本 SHA256
  一致。
- `apache/maka#4497`：本地 Runtime/Computer Use action surface 已是 semantic-only；
  坐标 mutation 不暴露给模型，键盘仍受 capability 和 observation 绑定约束。
- `apache/maka#4409`：本地产品接入使用共享 supervised lifecycle 和薄的 Windows
  native-helper 选择/产物 seam，不再保留旧私有 Windows protocol 作为生产 adapter。

这些是未提交的本地收敛结果，不代表上游 PR 已合并。产物来源、打包、clean-machine、
打包后的对话 E2E 和完整真实应用矩阵完成前，生产门禁仍保持关闭。

## 结果

| 范围 | 结果 | 证据 |
|---|---:|---|
| 正式 Rust cargo 测试 | 8 pass，0 fail | `maka-cu` native crate |
| shared-protocol 生命周期 | 29 pass，0 fail | `maka-cu2-lifecycle-driver.mjs`；包含新 HWND/PID/标题/启动时间/generation 校验 |
| 冷启动 / 内存 / 首帧测量 | 握手：46.916 / 52.471 / 42.470 ms；helper 工作集：8,601,600 / 8,597,504 / 8,572,928 bytes；WPF 首帧：1,563.699 ms；首帧后工作集：54,112,256 bytes | `performance-results-cross-machine-rust-formal-native.json`；三组新 helper PID 和一组新 fixture PID/HWND |
| `apps.launch` | 6 pass，0 fail | `app-launch-results-cross-machine-rust-formal-native.json` |
| formal `dispatch.key` 重跑 | WPF：17 pass，0 fail，1 个诚实 unknown；Chromium：9 pass，0 fail，3 blocked，1 个诚实 unknown | `app-task-results-cross-machine-rust-formal-native.json`；`browser-results-cross-machine-rust-formal-native.json` |
| .NET 10 fixture 的 WPF 直接运行 | 17 pass，0 fail，0 blocked，1 个诚实 unknown | `app-task-results-cross-machine-rust-formal-native-key-net10.json`；`net10.0-windows10.0.22621.0` fixture |
| WPF 矩阵（当前键盘路径 release） | 102 pass，0 fail，0 blocked，6 unknown | `app-task-results-cross-machine-rust-formal-native-key-matrix-1..6.json`；六组不同 PID 和 HWND |
| Chromium 矩阵（当前键盘路径 release） | 54 pass，0 fail，18 blocked，6 unknown | `browser-results-cross-machine-rust-formal-native-key-matrix-1..6.json`；六组不同 PID、HWND 和临时 profile |
| Computer Use 宿主集成 | 117 pass，0 fail | Rust helper 加 WinForms fixture |
| Desktop 宿主聚焦测试 | 17 pass，1 个环境 blocked（Windows symlink EPERM）；native capability contract 13/13 通过 | `computer-use-host.test.js` 和 `runtime-host-native-capabilities.test.js` |
| Windows x64 打包应用 | pass；installer、zip 和 block map 均生成 | `apps/desktop/release`；打包退出码 0；Spectre/MSB8040 未再出现 |
| 真实 Electron Maka smoke | 7/7 程序化检查通过 | 最新报告 `apps/desktop/tests/real-window-smoke/2026-09-02T18-28-30-785Z.md`；隔离 user-data；界面渲染成功且无错误边界 |
| 手工真实 Maka Computer Use 浏览器导航 | 用户确认通过 | 隔离的本机 Maka 会话打开了新的 Chrome 测试实例并访问 `https://www.google.com/`；没有使用现有 Chrome profile |
| LibreOffice 真实应用探测 | 9 pass，1 fail（`dispatch_refused`），0 blocked，0 unknown | `libreoffice-results-cross-machine-rust-formal-native.json`；临时 Writer profile；没有用户文档 |
| WinUI/UWP 可用性 | 已发现 Calculator、Notepad、Paint 包；Notepad 恢复了已有会话，因此探测在输入/修改前停止，没有接受新的完整 mutation 矩阵 | `real-app-availability-cross-machine-rust-formal-native.json` |
| 自动真实模型 Maka runner | 未执行；专用 runner 尚未配置 provider/bridge 环境 | `scripts/computer-use/real-model.mjs`；这与上面的手工 Maka smoke 分开记录 |
| CU 范围源码构建 | pass；仓库全量构建被本改动范围之外既有的 `@maka/ui` 类型错误（`settledText`、`autoScroll`、`trailingAction`）阻塞 | bundled Node 24.19 |

Chromium 的 blocked 是当前 UIA provider 对安全可写 `ValuePattern` 路径和
`TextPattern` 文本选择路径的诚实拒绝。Enter 保持 `unknown`；页面 oracle
不会被改写成 helper verified。

## 阻塞与解释

1. Windows x64 安装包现在可以在本机成功完成。`node-pty` 重建和
   electron-builder 均成功退出，之前的 Spectre/`MSB8040` 没有重现。
   当前范围按决定跳过 clean-machine，因此这些仍属于本机证据。
2. 旧 `comparison-harness.mjs` 仍向 Rust subject 发送旧私有协议
   `initialize/list_windows`，因此报告 0/34。它不是 shared-protocol 的有效
   conformance runner；Rust 的权威结果应使用新的 `maka-cu2` lifecycle driver。
3. LibreOffice 已确认位于 `D:\soft\program\soffice.exe`。临时 Writer
   窗口的观察和截图均通过，但一次语义“属性”按钮点击返回 executor 的类型化
   `dispatch_refused`。没有重试该变更动作；结果保持为真实应用动作拒绝，不能改写成
   pass 或 unknown。
4. 专用平台感知的真实模型 runner 尚未执行：本机没有
   `MAKA_CU_PROVIDER`、provider API key，也没有监听 8538 端口的本地 bridge。
   这是环境阻塞，不是 Computer Use 的 pass/fail 结果。
5. WinUI/UWP 包发现已成功找到 Calculator、Notepad 和 Paint。Notepad 恢复了
   带有用户可见标签的已有会话，因此探测在输入、保存或修改前停止；包可用
   不等于任务矩阵覆盖。
6. ASF header 全量套件有一个环境级失败：Windows 拒绝创建其临时 symlink
   （`EPERM`）；源文件/头部检查和 `git diff --check` 均通过。

## 生产判断

native executor、焦点绑定键盘投递、共享生命周期、semantic-only schema、
打包 manifest、fixture 以及本机手工 Maka 对话证据已经完成实质推进；当前
范围明确跳过 clean-machine。旧 comparison harness 仍需迁移到 shared protocol；
Chromium 文本输入和文本选择仍被 provider 阻塞；自动真实模型 runner 仍需独立
provider/bridge 配置。仓库全量构建还被本改动范围之外的既有 `@maka/ui` 类型错误
阻塞，但 Computer Use 包和 Desktop main 构建通过。该摘要将随本次 scoped commit
推送，distributionReady 仍保持 `false`。

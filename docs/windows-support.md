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

# Windows support baseline

Windows is an active enablement target, not a fully supported Maka platform yet. The CLI and Electron desktop application can run from source, and release workflows produce a verified unsigned Windows x64 preview. The x64 package includes an AppContainer sandbox for the managed filesystem-worker surface, with packaged lifecycle and adversarial evidence, and automatic updates are verified end to end in CI on the unsigned preview channel. Signing, the wider general-command sandbox tier, direct Credential Manager/DPAPI probes, independent security review, and computer-use guarantees remain incomplete. Progress is tracked in [GitHub issue #2142](https://github.com/apache/maka/issues/2142).

## Install the Windows x64 preview

Only use Windows assets attached to a Maka GitHub Release. The NSIS installer is named
`Maka-<version>-win-x64.exe`; the ZIP is a portable artifact for inspection and troubleshooting.

1. Download the `.exe` and its matching `.sha256` file from the same release.
2. In PowerShell, compute the installer digest:

   ```powershell
   Get-FileHash .\Maka-<version>-win-x64.exe -Algorithm SHA256
   Get-Content .\Maka-<version>-win-x64.exe.sha256
   ```

3. Require the two SHA-256 values to match exactly. A checksum only establishes the bytes published
   with that release; it is not a substitute for publisher authentication.
4. Run the installer. Because the preview has no Authenticode signature, SmartScreen reports an
   unknown publisher. Continue through **More info → Run anyway** only after completing step 3.
5. Launch Maka, configure a model under **Settings → Models**, and install `ripgrep` with
   `winget install BurntSushi.ripgrep.MSVC` if Runtime's `Grep` tool is needed. Restart Maka after
   changing `PATH`.

The release gate installs a pinned v0.1.9 build, fully smokes it, upgrades the same installation to
the candidate, fully smokes the candidate, waits for installed processes to exit, and runs the real
uninstaller. A second gate proves the automatic, running-app upgrade path: the installed candidate,
running, discovers a newer build through its packaged electron-updater against a loopback test feed,
downloads it in the background, hands off to the NSIS installer, relaunches as the new version, and
passes the full packaged smoke — with the feed requests (including the differential-download probe),
the `downloaded` state and its exact version pair, and the final installed version asserted
individually; transient states such as `checking` and `downloading` are not individually asserted.

A third gate exercises **Abort-path rollback with backup retention**. Before anything destructive
runs, an upgrade backs up the existing installation to a same-volume sibling
(`<install dir>.pre-upgrade-backup`), verifies the copy, and persists the registry snapshot; a
backup failure, missing uninstall registration, backup marker that does not match the current
snapshot, or backup without an executable witness refuses the upgrade with the old install untouched
(exit 101). On the NSIS **Abort path**
the installer restores the backup with a two-step same-volume swap — at every intermediate point at
least one complete installation exists on disk — and writes and verifies the required registration
values (exit 102). A registry read-back mismatch keeps recovery evidence and returns 103. The gate
arms a deterministic test-only failpoint at
the worst moment — new files extracted, old files gone, the new uninstaller and registry not yet
written — and asserts the previous installation comes back byte-identical (per-file SHA-256 over
the whole tree; file contents, not ACLs or timestamps), registered, and launchable at its old
version, forces and recovers from a registry read-back mismatch, refuses stale-version and incomplete
backups without changing the current install, then asserts a normal upgrade succeeds with no backup
residue.

Be precise about the boundary: the template's own failure branches (the old uninstaller failing,
extraction retry exhaustion or cancellation) exit via `Quit`, which NSIS gives no hook for — **no
automatic rollback runs on those paths**. The gate pins that gap deliberately: after a `Quit` at
the worst moment, the verified backup and a `RECOVERY-README.txt` inside it are retained. Rerunning
the installer adopts the backup only when its version marker matches the persisted snapshot and
then completes the upgrade — that rerun is the supported recovery, and the gate proves it. Manual
recovery, if ever needed: close Maka, delete the
installation directory, rename `<install dir>.pre-upgrade-backup` to the installation directory,
and remove the two marker files inside it. Also not covered: a hard kill of the installer process
or power loss (the backup copy is not forced through volatile device caches, in line with the
durability boundary below). What is still not proven overall: update signature verification (no
Authenticode certificate yet — the feed configuration for the production GitHub channel is pinned
by unit tests and exercised routinely on real releases instead) and persisted business-data
migration.

To uninstall, use **Settings → Apps → Installed apps → Maka → Uninstall**. Back up any important
workspace data first; the preview does not yet claim business-data migration guarantees.

## 安装 Windows x64 预览版

只使用 Maka GitHub Release 附带的 Windows 资产。NSIS 安装包名为
`Maka-<version>-win-x64.exe`；ZIP 主要用于便携检查和问题排查。

1. 从同一个 release 下载 `.exe` 和对应的 `.sha256` 文件。
2. 在 PowerShell 中分别查看实际摘要和发布的摘要：

   ```powershell
   Get-FileHash .\Maka-<version>-win-x64.exe -Algorithm SHA256
   Get-Content .\Maka-<version>-win-x64.exe.sha256
   ```

3. 两个 SHA-256 必须完全一致。校验和只能确认文件与该 release 发布的字节一致，不能替代发布者身份认证。
4. 运行安装包。预览版尚无 Authenticode 签名，SmartScreen 会提示未知发布者；只有完成第 3 步后，
   才应选择 **更多信息 → 仍要运行**。
5. 启动 Maka，在 **设置 → 模型**中配置模型。需要 Runtime `Grep` 工具时，执行
   `winget install BurntSushi.ripgrep.MSVC`，并在 `PATH` 更新后重启 Maka。

发布门禁会安装固定的 v0.1.9、执行完整 smoke、在同一目录升级候选版本、再次完整 smoke、等待安装目录内
进程退出，并运行真实卸载器。另一个门禁证明**运行中的自动更新路径**：已安装且正在运行的候选版本通过打包的
electron-updater 从 loopback 测试 feed 发现新版本、后台下载、交接给 NSIS 安装器、以新版本自动重启并通过
完整打包 smoke——feed 请求（含差量下载探测）、`downloaded` 状态及其精确版本对、最终安装版本均逐项断言；
`checking`/`downloading` 等瞬态不逐项断言。

第三个门禁验证 **Abort 路径 rollback 与备份保留**。升级在任何破坏性步骤之前先把现有安装备份到同卷同级
目录（`<安装目录>.pre-upgrade-backup`），校验副本并持久化注册表快照；备份失败、卸载注册信息缺失、备份
版本标记与当前快照不匹配，或备份缺少可执行文件见证时直接拒绝升级，旧安装分毫未动（退出码 101）。在
NSIS **Abort 路径**上，安装器
用同卷两步换名恢复备份——任意中间时刻磁盘上都至少存在一份完整安装——并回写、回读校验必需的注册信息
（退出码 102）；注册表回读不一致时保留恢复证据并返回 103。门禁在最坏时点——新文件已抽取、
旧文件已删、新卸载器与注册表尚未写入——注入确定性的测试专用失败点，断言先前安装**逐文件 SHA-256 字节
一致**地恢复（文件内容字节，不含 ACL/时间戳）、注册信息恢复、且能以旧版本启动；还会强制制造并恢复
注册表回读不一致，验证旧版本或不完整备份不会被当前安装误接管，并断言正常升级成功且无备份残留。

边界必须说清楚：模板自身的失败分支（旧卸载器失败、抽取重试耗尽或被取消）经 `Quit` 退出，NSIS 对此没有
任何回调——**这些路径上不会发生自动 rollback**。门禁刻意钉住这一缺口：在最坏时点 `Quit` 之后，已校验的
备份和其中的 `RECOVERY-README.txt` 会被保留。仅当备份版本标记与持久化快照一致时，重新运行安装器才会
接管该备份并完成升级——这次重跑就是受支持的恢复方式，门禁对其有断言。如需手工恢复：关闭 Maka、删除
安装目录、把 `<安装目录>.pre-upgrade-backup`
重命名为安装目录、删除其中的两个标记文件。同样不覆盖：安装器进程被硬杀或断电（备份拷贝不经强制介质
刷盘，与下方耐久性边界同一口径）。整体仍未证明的是：更新签名校验（尚无 Authenticode 证书；生产 GitHub
通道的 feed 配置由单测钉死，并在每次真实 release 中例行使用）与业务数据迁移。

卸载入口为 **设置 → 应用 → 已安装的应用 → Maka → 卸载**。预览版尚未承诺业务数据迁移，
请先备份重要 workspace 数据。

## Phase 0 development target

The initial target is a native Windows 11 x64 development environment with:

- Node.js 22.19 or newer; CI currently standardizes on Node.js 24;
- npm 11 and the committed lockfile;
- Git for Windows with long-path support available;
- PowerShell 7 (`pwsh`) preferred, with Windows PowerShell 5.1 and `cmd.exe` supported fallbacks;
- `ripgrep` on `PATH` for the Runtime `Grep` tool;
- WebView/runtime components installed by a current Windows 11 installation;
- Windows Developer Mode or elevation only for tests that create file symlinks. Normal CLI and desktop startup must not require either.

Windows 10, Windows on Arm, signed automatic updates, the final sandbox support declaration, and computer-use are not covered by the current support target. Packaged installation is available only as the unsigned Windows 11 x64 preview described above; its automatic-update path is CI-verified but unsigned.

## Reproducible checks

Install and build from a clean checkout:

```powershell
npm ci
npm run build
```

Audit all test declarations excluded on Windows:

```powershell
npm run windows:inventory
```

Run isolated CLI and real Electron startup smoke checks:

```powershell
npm run smoke:windows
```

Run the complete repository test plan:

```powershell
npm test
```

The generated [Windows test skip inventory](./windows-test-inventory.md) classifies every detected Windows-excluded test declaration. Adding or removing one requires regenerating the inventory with `npm run windows:inventory:write` and reviewing its classification.

## Crash and durability boundary

Windows recovery evidence distinguishes an application process crash from an operating-system or
device power loss. Passing a real-process crash gate proves that committed state converges after the
owning process is forcibly terminated. It does not, by itself, prove that Windows has forced every
parent-directory update through volatile device caches.

| Surface | Current Windows guarantee | Boundary |
|---|---|---|
| SQLite operational state | Databases use WAL journaling with `synchronous=FULL`. Real-process failpoint tests verify that committed runtime, continuation, and memory facts survive owner death while incomplete transactions do not become authoritative. Workspace RuntimeEvents and projections retain their schema 9 reader/rebuild contract. | The guarantee is the SQLite and Windows filesystem contract on supported local storage. Maka does not claim protection from storage hardware or drivers that acknowledge flushes before data is stable. |
| Artifact payload publication | Payload bytes are written to a same-directory staging file and the file is synchronized before publication. Recovery reconciles staged payloads, metadata, deletes, and owner death without accepting uncommitted residue. | Windows evidence covers forced process termination and restart. It does not establish a separately forced parent-directory entry after sudden system power loss. |
| Root and open-database replacement | Live owners retain exclusive authority and cleanup closes stores and leases before deleting their roots. | Windows does not permit the POSIX test technique of renaming or unlinking an open SQLite database or replacing a directory that contains open files. Those tests remain classified as platform contracts rather than portable recovery gates. |

On POSIX, stable-storage paths synchronize changed parent directories after publishing or removing a
name. On Windows, Node does not provide the same usable directory-handle synchronization operation,
so `syncDirectory()` is a no-op. Maka therefore does not currently promise POSIX-equivalent
power-loss durability for a newly created, renamed, linked, or removed directory entry on Windows.
The supported evidence is narrower: file contents are synchronized where the storage protocol calls
for it, SQLite transactions use full synchronous WAL semantics, process-crash recovery converges,
and unsupported live-root replacement fails closed.

## Baseline captured on 2026-08-04

Environment: Windows 11 x64, Node.js 22.23.1, npm 11, Git for Windows.

| Surface | Result | Notes |
|---|---:|---|
| Workspace build | PASS | All root `build:test` workspace builds completed. |
| Repository script tests | 110 pass, 0 fail, 1 skip | The skip is a real macOS `pgrep` probe. |
| Storage suite | 514 pass, 100 fail, 40 skip | Failures are dominated by `EBUSY` cleanup while SQLite files remain open. |
| Complete repository test plan | TIMEOUT | `npm test` did not exit within 10 minutes and left the workspace test runner alive. |

The storage result is a diagnostic baseline, not an accepted support threshold. Windows does not allow POSIX-style unlink of an open SQLite database or shared-memory file. Stores, owners, and leases must close deterministically before their temporary root is removed.

The root test timeout is tracked separately from individual test failures. Phase 1 must make the workspace runner emit progress, terminate its children, and produce a bounded summary on Windows.

## Current capability boundary

- CLI `--help`, `--version`, TUI startup, and non-interactive commands are native Node.js paths.
- Desktop development startup uses the Windows Electron binary.
- Runtime Host endpoints use Windows named pipes rather than Unix domain sockets.
- Automatic shell selection prefers PowerShell 7, then Windows PowerShell, then `cmd.exe`.
- Desktop can explicitly select a GNU Bash `bash.exe` on the Runtime Host machine (Git Bash or the legacy `System32\bash.exe` WSL shim). The Host validates the executable before persisting it and fails closed if the configured path later disappears; remote Desktop clients do not resolve the path on their own machine.
- PTY execution uses ConPTY through `node-pty`; process-tree termination uses `taskkill /T` where required.
- Restricted managed profiles use the packaged AppContainer broker when available and fail closed
  when the native capability or requested policy is unavailable.
- The packaged filesystem-worker gate covers client cancellation, Runtime Host parent death,
  repeated concurrent launches, ACL quarantine isolation, filesystem aliases, restricted TCP outbound network,
  host named pipes, ambient environment, host registry values, parent tokens, and descendant
  denial or AppContainer/Job inheritance. It does not claim UDP/DNS/SMB enforcement, local inbound-listener enforcement, the deferred
  no-Win32k/window-station tier, or direct Credential Manager/DPAPI isolation.
- Computer-use has no Windows backend.
- The Windows x64 NSIS installer is unsigned. The in-app automatic-update path (electron-updater →
  NSIS handoff → relaunch) is verified end to end in CI against a loopback feed; the production
  GitHub feed configuration is pinned by unit tests. Updates are not signature-verified until an
  Authenticode certificate lands.

Do not describe Windows as released or fully supported until the support criteria in issue #2142 are complete for the claimed support tier.

# Windows support baseline

Windows is an active enablement target, not a fully supported Maka platform yet. The CLI and Electron desktop application can run from source, and release workflows produce a verified unsigned Windows x64 preview. Signing, automatic updates, sandbox enforcement, and computer-use guarantees remain incomplete. Progress is tracked in [GitHub issue #2142](https://github.com/maka-agent/maka-agent/issues/2142).

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
uninstaller. This proves a closed-app upgrade and uninstall path. It does not prove automatic update,
running-app upgrade, persisted business-data migration, or rollback after a mid-install failure.

To uninstall, use **Settings → Apps → Installed apps → Maka → Uninstall**. Back up any important
workspace data first; the preview does not yet claim installer rollback or migration guarantees.

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
进程退出，并运行真实卸载器。这证明关闭应用后的升级与卸载路径，不证明自动更新、运行中升级、业务数据迁移，
也不证明安装中途失败后的 rollback。

卸载入口为 **设置 → 应用 → 已安装的应用 → Maka → 卸载**。预览版尚未承诺安装器 rollback 或数据迁移，
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

Windows 10, Windows on Arm, automatic updates, sandbox enforcement, and computer-use are not covered by the current support target. Packaged installation is available only as the unsigned Windows 11 x64 preview described above.

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
| SQLite operational state | Databases use WAL journaling with `synchronous=FULL`. Real-process failpoint tests verify that committed runtime, continuation, memory, and managed-workspace facts survive owner death while incomplete transactions do not become authoritative. | The guarantee is the SQLite and Windows filesystem contract on supported local storage. Maka does not claim protection from storage hardware or drivers that acknowledge flushes before data is stable. |
| Artifact payload publication | Payload bytes are written to a same-directory staging file and the file is synchronized before publication. Recovery reconciles staged payloads, metadata, deletes, and owner death without accepting uncommitted residue. | Windows evidence covers forced process termination and restart. It does not establish a separately forced parent-directory entry after sudden system power loss. |
| Marker and managed-workspace control files | Writers synchronize temporary file contents before same-directory `link` or `rename` publication. Readers validate file and root identity and fail closed on unsupported replacement. | Node can synchronize the file on Windows, but the repository's directory synchronization barrier is intentionally unavailable on Windows. |
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
| Managed workspace baseline tests | 17 pass, 0 fail, 5 skip | Passed after enabling Git for Windows long paths. |
| Storage suite | 514 pass, 100 fail, 40 skip | Failures are dominated by `EBUSY` cleanup while SQLite files remain open. |
| Complete repository test plan | TIMEOUT | `npm test` did not exit within 10 minutes and left the workspace test runner alive. |

The storage result is a diagnostic baseline, not an accepted support threshold. Windows does not allow POSIX-style unlink of an open SQLite database or shared-memory file. Stores, owners, and leases must close deterministically before their temporary root is removed.

The root test timeout is tracked separately from individual test failures. Phase 1 must make the workspace runner emit progress, terminate its children, and produce a bounded summary on Windows.

## Current capability boundary

- CLI `--help`, `--version`, TUI startup, and non-interactive commands are native Node.js paths.
- Desktop development startup uses the Windows Electron binary.
- Runtime Host endpoints use Windows named pipes rather than Unix domain sockets.
- Shell selection prefers PowerShell 7, then Windows PowerShell, then `cmd.exe`.
- PTY execution uses ConPTY through `node-pty`; process-tree termination uses `taskkill /T` where required.
- Restricted sandbox profiles fail closed because there is no Windows sandbox backend.
- Computer-use has no Windows backend.
- The Windows x64 NSIS installer is unsigned and there is no supported automatic-update channel.

Do not describe Windows as released or fully supported until the support criteria in issue #2142 are complete for the claimed support tier.

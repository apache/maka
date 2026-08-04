# Windows support baseline

Windows is an active enablement target, not a released or fully supported Maka platform yet. The CLI and Electron desktop application can run from source, but release, recovery, sandbox, and computer-use guarantees are incomplete. Progress is tracked in [GitHub issue #2142](https://github.com/maka-agent/maka-agent/issues/2142).

## Phase 0 development target

The initial target is a native Windows 11 x64 development environment with:

- Node.js 22.19 or newer; CI currently standardizes on Node.js 24;
- npm 11 and the committed lockfile;
- Git for Windows with long-path support available;
- PowerShell 7 (`pwsh`) preferred, with Windows PowerShell 5.1 and `cmd.exe` supported fallbacks;
- `ripgrep` on `PATH` for the Runtime `Grep` tool;
- WebView/runtime components installed by a current Windows 11 installation;
- Windows Developer Mode or elevation only for tests that create file symlinks. Normal CLI and desktop startup must not require either.

Windows 10, Windows on Arm, packaged installation, automatic updates, sandbox enforcement, and computer-use are not covered by the Phase 0 baseline.

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
- There is no signed Windows installer or supported update channel.

Do not describe Windows as released or fully supported until the support criteria in issue #2142 are complete for the claimed support tier.

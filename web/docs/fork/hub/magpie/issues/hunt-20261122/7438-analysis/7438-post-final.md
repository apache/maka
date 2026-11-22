@qikairo7 — first: sorry about the lost dsh history and the eight sign-ins; thank you for the forensic work (the USN timeline and the honest attribution section especially). I can't hand you a fix yet, and I won't guess one. What I did is a line-by-line audit of what applying 0.1.4651 → 0.1.4652 touches, against `upstream/main` as of today (`700f4127e`); the apply code is unchanged between `v0.1.4651` and `v0.1.4652` (that diff is four Library-page UI commits), so the same reading covers the version that ran during your incident. It answers your question 1 with code pointers, and it ends with what would close in on the actor — including the artifacts you offered.

## What applying 0.1.4651 → 0.1.4652 actually does

1. **Clock check** every `updateEvery` minutes (your 360 = 6 h; `internal/gui/update.go:204`, driven by the loop at `:208`): the releases feed is asked, and a newer build is downloaded into magpie's own staging — the system cache folder (`%LOCALAPPDATA%\magpie\…`) when a rename from there reaches the program's folder, else a hidden `.magpie-update` folder beside `magpie.exe`, else `magpie.exe.new` beside it (`internal/update/update.go:746`, `binaryStage`). Nothing is unpacked over the user profile at any point.
2. **Putting it in** — at a restart, or Settings' AutoRestart once the gateway goes idle (the disk swap you saw at 19:20) — renames the running `magpie.exe` to `magpie.exe.old` and renames the staged file into its place (`InstallBinaryAside`, `internal/update/update.go:858`; `moveAside` `:1037`, `oldName` `:1071`). Two file renames beside the exe. No directory is touched.
3. **The relaunch** starts the new exe with `MAGPIE_REPLACES=<old pid>` (`RelaunchBinary`, `internal/update/update.go:1155`); the new process waits for the old one to be gone first (`AwaitPredecessor`, `:1179`). The old process's shutdown (`internal/gui/app.go:447`) ends the Codex failover, ports Codex rollouts, and — only with "Put agents back when quitting" on, which is off by default — restores agents' config files, file by file. Its last updater act (`install(false)`) is a no-op after the swap.
4. The new process's **first log line is the `magpie 0.1.4652 started` line itself** (`internal/applog/applog.go:80`); nothing logs before it.
5. The elevated install path that runs shell `rm -rf` / `mv` (`internal/update/admin.go:90`) is macOS/Linux only (`CanElevate`, `:29`, false on Windows); on Windows the swap is the two renames above.

## Where the audit looked for a deletion — and didn't find one

Every `os.RemoveAll` call site in the tree names a path inside magpie's own state: the update staging and `.magpie-update` beside the exe; magpie's config and cache folders; the sessions trash (which refuses a session still in use — your running dsh session was a victim, not a target); magpie's own saved-account folders (Claude's `claude-accounts/…`, Kiro's homes); the plugin and Bun caches under `~/.cache/magpie`; temp folders. None names `~/.claude`, `~/.codex`, `~/.zcode`, `~/.dsh`, `~/.bun`, `~/.cache` itself, or `~/.config/magpie`.

The one wholesale remover is the uninstaller — `internal/uninstall/uninstall.go:196` (`Folders`) and `:248` (`Data`), run from Settings › Uninstall or `magpie uninstall`; `Data` also runs from a spawned `magpie uninstall --data-after <pid>` after the app quits (`:320`). It doesn't fit your incident: it never removes the agents' folders, and it removes `%LOCALAPPDATA%\magpie` (`appdir.SystemCache`, `internal/appdir/appdir.go:377`) — where your `app.log` lives (`%LOCALAPPDATA%\magpie\logs\app.log`) and survived with the day's lines intact.

The timing points the same way. The deletion began around 20:01:40 while the 0.1.4651 process was still logging and serving (your 20:01:49 gateway line; the `plugins: Bun runtime not ready: downloading Bun 1.4.2` at 20:01:41 is that same old process re-fetching Bun because `~/.cache/magpie/bun` had just vanished — `internal/plugin/bunready.go:167`), and the 0.1.4652 process cannot have acted before 20:02:05 (its first output is the `started` line). The same apply had run nine times that day without this. So the actor is most likely outside the apply path — and outside what this repository can name: the provider plugins (MiniMax Code, WorkBuddy) are JavaScript magpie downloads and runs under its Bun runtime, so they hold file access magpie's own Go code never exercises, and a machine-local cleaner, antivirus action or OneDrive behavior is the other usual suspect. USN records the deletions but not the deleting process.

## What would pin the actor down

- The USN analysis you offered, ideally for 20:01:35–20:01:50: the **parent directories** of the delete records, and how they interleave with the `logins.json` rewrite (magpie rewrites it when it marks a sign-in lapsed — "*user*'s sign-in has expired — add the account again to use it", `internal/provider/logins_on.go:371`) and with the `~/.config/magpie` subfolders hit (library/routing vs. providers.json/logins.json).
- The full-day app.log.
- Whether Settings → Sync (WebDAV/S3/GitHub) was configured, and whether anything else (a disk cleaner, an antivirus quarantine, OneDrive) ran in that window.
- If it can be reproduced, Sysmon or Process Monitor on a test box, since USN alone doesn't name the process.

## Pausing updates and backing the sign-ins up now (your question 2)

- Settings' automatic-update switch off stops the clock checks by themselves (`noAutoUpdate`, `internal/settings/settings.go:605`; the gate is `internal/gui/update.go:204`); `updateEvery` can also be raised. There is no version pinning today.
- `magpie backup [--sign-ins] [file]` writes providers, settings, profiles, agents' picks and the Library into one passphrase-sealed file, saved sign-ins included with `--sign-ins` (`internal/cli/backup_cmd.go:22`); `magpie backup restore` brings them back. Worth taking one now, and on a schedule.

**On #7428**: same idle auto-update channel, but that issue is the clock check discarding a staged download and fetching again (bandwidth only, nothing installed); nothing in this audit ties it to deletions.

**Not verified**: Windows on a real machine — this is a static audit of the tree at `700f4127e`; nothing was run on Windows and nothing reproduced yet.

**Attribution**: AI-written (GLM-5.3-Flash via ZCode CLI), code audit only; every pointer above is checkable as is. I claimed the issue earlier with "take" while diagnosing; nothing is fixed, so the hunt is open — with your USN data, whoever picks it up (me included) can start from the deleting process instead of from guesses.

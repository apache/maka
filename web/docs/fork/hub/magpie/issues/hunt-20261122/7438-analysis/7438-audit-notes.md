# 7438 审计笔记（车道 F，2026-11-22）

base = upstream/main `700f4127e8044ac6dfbb0e0cc937e91c59a601ac`（worktree /private/tmp/mg-h23f-7438，分支 fix/7438-updater-keeps-cli-state，未提交任何代码改动）。

## 结论

magpie Go 代码中**不存在**删除 ~/.claude / ~/.codex / ~/.zcode / ~/.dsh / ~/.bun / ~/.cache（父目录）/ ~/.config/magpie 的可达路径。apply 链（clock check → StageBinary → InstallBinaryAside → RelaunchBinary → AwaitPredecessor → 新进程 applog.Start）只做下载进 magpie 自有 staging + 两个 exe 旁改名。v0.1.4651..v0.1.4652 diff = 4 个 Library UI 提交，无删除面；v0.1.4651→700f4127e 在 apply 相关文件上只有 Nix/Guix 包装检测新增（appdir/launcher.go 等），无删除逻辑增删。

Phase 2/3（RED/GREEN/消融/矩阵）因此**阻断**：apply 路径上没有可复现的删除行为，RED 无法构建；按"不靠猜、证据先于结论"纪律不虚构修复。交付转分析帖（合法形态，guapr-patch：分析帖 RED/消融不强制）。

## 审计覆盖清单（全部引注，行号=700f4127e）

1. gui/update.go 全文（updater 状态机：run()/install()/restartInto）——无用户目录删除。clock check `updateDue` :204；start 循环 :208。
2. update/update.go：`binaryStage` :746（staging=SystemCache 或 exe 旁 `.magpie-update`/`exe.new`）；`InstallBinaryAside` :858；`moveAside` :1037；`oldName` :1071（exe.old/exe.old-N）；`RemoveOld`/`RemoveStaleNew`（仅 exe 旁文件）；`RelaunchBinary` :1155；`AwaitPredecessor` :1179；`swapScript`（rm -rf）在 admin.go :90，仅 darwin/linux（`CanElevate` :29 Windows=false）。
3. uninstall/uninstall.go：唯一整目录删除者——`Folders` :196（appdir.Config=~/.config/magpie :262、appdir.Cache=~/.cache/magpie :294、SystemCache=%LocalAppData%/magpie :377、WebView、claudecode.Root=~/.cache/magpie/claude-code、webData=%APPDATA% profile）+ `Data` :248 + `Run` :294 + `AfterExit` :320（spawn `magpie uninstall --data-after <pid>`）。不含 agent 目录；与现场矛盾点：app.log 在 %LocalAppData%\magpie\logs 存活。`removable` :352 守卫正确（排除含 home 的目录）。
4. gui/app.go OnShutdown :447（EndProbes/EndCodexFailover/PortCodexRollouts/restoreAgentsOnQuit[默认关]/install(false)）——无删除。
5. restoreonquit.go（RestoreOnQuit 默认关）+ agent dshTidyMade（模板级守卫）——无整目录删除。
6. sessions/：回收站流（manage.go :519/:836/:871/:896、gateway_delete.go :149/:172/:236）带 ErrActive/recent 守卫；cursor/call_cache=tmp/old。
7. provider/：claude_dirs.go :103（claudeAccountDir=claude-accounts/<hash>）、claude_signin.go :165（signin- 临时目录）、kiro_accounts.go :113（kiro homes）——全在 magpie 自有目录。
8. plugin/：bunupdate.go :265/:296（bun 版本目录）、installcache.go :62（install-cache 条目）、systemca_darwin（darwin tmp）。
9. library/：skills/skill_*/mcp_*/plugin.go 等——tmp/stage/pluginDir/skillDir，均在 magpie Library 或 agent 的 skills 子目录。
10. settings/migrate.go：dial→magpie 仅拷贝不删。appdir/move.go：rename+undo 守卫。applog：:80 started 为新进程首行日志。
11. 外部命令删除面（rg rd /s|rmdir|Remove-Item|rm -rf）：仅 admin.go :92（darwin/linux 提权）与 rtk_wsl.go :247（临时 CLAUDE_CONFIG_DIR）。Windows 无破坏性外部命令。
12. 全仓 `os.RemoveAll(` 参数表达式逐点去重清单（见会话记录）——无一命中托管状态目录。
13. ForgetInstallDir（install_windows.go :124 起）只删注册表值。usage OthersDir=magpie 自有 usage-others。

## 时间线推理（与报告者 USN 对齐）

- 19:20 磁盘换 exe（install），20:01:40 agents idle → AutoRestart 触发重启窗口；20:01:40-41 删除风暴，此时 0.1.4651 旧进程仍在写日志（20:01:49 网关 401 仍在服务）。
- 20:01:41 `plugins: Bun runtime not ready: downloading Bun 1.4.2`（bunready.go :167）= 旧进程因 ~/.cache/magpie/bun 刚被清而重下。
- 20:02:05 `magpie 0.1.4652 started` = 新进程首行日志（applog.Start）——新进程在此之前不可能有动作。
- 删除集合恰为"magpie 托管状态全集+缓存"，但删除者在仓内代码中不存在 → 嫌疑收窄到：(a) catalog 下发的 provider 插件 JS（MiniMax/WorkBuddy，Bun 运行时上有 FS 权限，源码在仓外）；(b) 机器本地第三方（清理工具/AV/OneDrive）。
- 当天前 9 次 apply 正常 + 4652 diff 无删除面 → 触发条件是状态/外部 actor，与版本无关。

## 交付

- 分析帖（英文）：7438-post-final.md（本目录），POST 至 issue 7438。
- 无 patch/无 push/无分支推送（无可修面）。take（id 7080387311）保留待主线程收口定夺（分析帖内已声明 claim 开放）。
- 继续条件：报告者提供 USN parent-dir 明细 + 全天 app.log + Sync/第三方确认 → 定位删除进程后再评估 patch 面（如确认为插件层，则 patch 面在插件运行时隔离/审计，不在 updater）。

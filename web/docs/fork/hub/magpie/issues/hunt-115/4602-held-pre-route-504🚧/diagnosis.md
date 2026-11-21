# #4602 held-pre-route 504 — 诊断记录（hunt-115-c4，2026-11-01）

Issue: https://github.com/yetone/magpie/issues/4602（ly6170，2026-10-31 16:05Z，中文正文，0 评论无认领）
Upstream 开工 SHA: `cbfbcb383b3d36ecd0f2b8aa53e186560244d402`
定性：**环境根因（进程级 Windows 文件打开停顿）+ 看门狗按设计工作 → 降级英文诊断帖，无 patch**（#3007 判定帖先例路径）

## 时间线重建（依据附件 heldReport，副本 attachment-log.txt）

- 请求：`POST /v1/chat/completions`，`workbuddy-ai/deepseek-v4.1-flash`，agent dsh，0.1.2404 (windows/amd64, served by app)，报告时刻 2026-10-31T15:56:09Z。
- ~15:55:33Z 到达；272.7 KB body 全部读完（最后字节在报告前 33.1s）。
- known waits：body 0s、JS middleware 200ms、masking 5.5s（均完成）。
- 之后进入路由规划 `serve → planPaused → perKeyBarred`：账户型 provider 逐账户查 `AccountServes` + `capHeld`；`capHeld → HoldCaps → CapsOf → storedPicks → load → read → steady.ReadFile` 读 `providers.json`（0.1.2404 尚无 `storedFile`/filememo 解析缓存，每请求裸读）。
- 卡点：goroutine 停在第一次 `os.Open` 的内核 `CreateFile`（`syscall.Open+0x1b0`）——`steady` 的有界等待（50×10ms≈0.5s）根本没机会启动；用户态代码管不到内核调用。
- 15:56:09Z：held 36s，其中 ≥30s 无已知等待（36−5.7≈30.3s）→ `checkUnknown`（`unroutedUnknown=30s`，unrouted.go:61）→ `giveUp(true)`：504 + 罐头消息 + 存 heldReport + goroutine dump 到日志。附件即该报告。

## 504 而非 failover 的定性

`giveUp`（unrouted.go:622）开头即 `len(f.begun) > 0 → return`：只要有任何 provider 已被尝试，看门狗不打断、failover 继续跑。本请求从未路由出去（规划阶段冻结），**没有 failover 对象**——「30s 无名等待→504+报告」是设计出口（#3682 事故后 v0.1.1540 引入的显形机制）。

## 环境根因证据（dump 分组精确计数）

- 21 个 goroutine 卡死在内核文件 syscall：10 个 `CreateFile`（os.Open/os.OpenFile）+ 11 个 `GetFileAttributesEx`（os.Stat）。
- 分布于互不共享锁的子系统：gateway 请求×4（=报告 "requests in flight: 4"：2 个在 capHeld 栈、1 个在 `AlsoOn → filelock.Lock` 开锁文件、1 个在 `Available → settings.Load` stat）+ KeepListsFresh + quotas×3 + KeepCodexDaemonCurrent + KeepDshWired + GUI handler/tray/lighten。
- 另 5 个 goroutine 排在进程内 filelock mutex 后（持锁者正卡在开锁文件的内核调用）。
- 应用层死锁不可能同时冻住这些独立调用链；唯一共同点是内核文件操作不返回 → 杀软过滤驱动/sync 工具进程级 hold。
- 本仓内证：`filelock.go:35` 注释原文 "#1665: ~190 times in a Windows start's first 25s, each an antivirus filter driver's work"。
- 同日同版本旁证：`b81956189`（v0.1.2440，11-01 02:21 +0800 落）——mycf_711 Win11 0.1.2364→0.1.2404 升级文件被扫描器 hold（"something (often an antivirus) holds the staged magpie.exe.new"）。

## 上游已在收窄暴露面（时序）

- 报告 10-31 16:05Z；`9fa11784d`（11-01 00:43 +0800，首发 v0.1.2429）把 `storedPicks` 的每请求裸读+全量解析 providers.json 换成 filememo 解析缓存——正是报告者卡点栈。报告者 0.1.2404 < 0.1.2429，两者都不含。
- 残余暴露（无法归零，正确性要求）：filememo 每请求至少一次内核 stat（holdCatalog 的 1s Hold 窗只免重复）；filelock 开锁文件本身。

## 碰撞检查

- #3380（我方 message_start usage 补零，passthrough 面）：无面交。
- #3083（plugin 登录 10min 超时报错）：无面交。#3052（x-bili-* 头，维护者已采纳）：无面交。
- #3682（pf-serve 锁内同步 I/O → 全请求排队 504，CLOSED）：同看门狗家族但根因不同（可选功能锁内 I/O vs 内核文件停顿）；handbook/10 §15 三条硬规则不受影响——本单卡点是核心配置读，非「可选功能阻塞核心路径」。
- 发布门禁：cbfbcb383..FETCH_HEAD 仅 `d1a94f579`（Codex pick #4772），无 4602/held/504 命中；issue 无他人新评论。

## 发布记录

- take：comment-6556866967（2026-11-01 10:42:40Z）
- 诊断帖：comment-6556879767（2026-11-01 10:44:02Z，GET 回读 4282 字符完整）：时间线 / 504≠failover 定性 / dump 计数 / 不 patch 三理由 / 三条行动建议（升 ≥v0.1.2440；%USERPROFILE%\.config\magpie 排除扫描+查 sync 工具；复发则附最新 held-*.txt+点名杀软）
- 无分支/无 patch/无 push（诊断定性路径，同 hunt-115 4472 先例）；worktree 未建（无代码改动）。

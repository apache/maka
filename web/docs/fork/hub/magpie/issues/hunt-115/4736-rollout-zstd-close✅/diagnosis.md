# hunt115-a2-4736 · editRollout 缺 zstd.Encoder.Close（#4736）诊断与降级记录

- **结论：分析在案，未发 patch**（核查后无真实行为后果，按任务书「无真实行为后果如实降级不硬凑」执行）
- 交付帖：https://github.com/yetone/magpie/issues/4736#issuecomment-6556039271（author=ggbdpq，GET 回读一致）
- take：https://github.com/yetone/magpie/issues/4736#issuecomment-6555555932
- 核验基线：upstream/main `77e8535887`（开工时 fetch；647323409 与之两函数字节级一致，无漂移）

## 代码面确认（真实存在）

`internal/sessions/codex_portable.go` `editRollout`（L312）：packed rollout 建 `zstd.NewWriter(tmp)`（L338-344）后，除完整成功写外所有退出都不调 `z.Close()`：ctx 取消（L350-351）、bw.Write 错（L360-362）、ReadBytes 错（L367-369）、`!changed`（L371-373）。既有 `done` defer（L330-336）只关/删 tmp 文件不关 encoder。`internal/sessions/codex_provider.go` `rewriteCodexProvider`（L567）结构逐字节同构（defer L581-587、`!changed` L622-624）。

## 后果定性（klauspost/compress v1.18.3 源码级核查，go.mod 钉死版本）

| 担忧 | 结论 | 证据 |
| --- | --- | --- |
| goroutine 泄漏 | **无** | v1.18.3 每块一个瞬时 goroutine（`nextBlock`），`wg.Done` 自排空，无人等 Close |
| fd/tmp 残留 | **无** | encoder 不持 fd；既有 done defer 关+删 tmp |
| 发布文件损坏 | **无** | 唯一发布路径在 Chmod/Sync/Rename 前显式 Flush+Close |
| 内存滞留 | **无** | NewWriter 纯堆分配（GOMAXPROCS×8MiB window 的 per-worker encoder channel），无池、无 finalizer（SetFinalizer 仅 Decoder），GC 一轮回收；该分配是 NewWriter 固有成本，changed 路径同付，非缺 Close 增量 |

缺 Close 实际留下：final block 未编码 + 短暂在途写者写已 unlink 的 tmp（共享 fd 关闭后写失败，错误落无人读字段）。报告者 CPU profile（encoder ~12.4% cum）归属 #4735 的无效重压缩面，非泄漏证据——报告者自己也承认无法证明持久泄漏。

## 为何不发 patch

用户可见断言（连续调用 NumGoroutine 回基线 / tmp 目录干净 / 重复调用正常 / 字节 mtime 不变）在未修代码上全部通过——GC+既有 tmp 清理在 v1.18.3 上吸收了全部缺口；本仓门禁要求修复带「不修就失败」的测试，此缺口在钉死版本上不可构造，发行为不可见 patch 是错形。

## 给维护者的修法形状（帖内已给）

在两个函数的既有 `done` defer 口上扩一行：`var z` 上移至 defer 前，`if !done { if z != nil { z.Close() }; tmp.Close(); os.Remove }`。第二次 Close 是 no-op（首次尾置 `s.err = ErrEncoderClosed`，nextBlock 开头 `s.err != nil` 直接返回，Close `errors.Is` 映射回 nil）——错误故意忽略：tmp 正被丢弃。

## 兄弟面 rg 全查（`rg 'zstd.NewWriter'` 全仓）

- 同病：`editRollout`、`rewriteCodexProvider`（两处，帖内点名为修法落点）
- 非病：`internal/provider/codex_zstd.go`、`internal/maskrec/maskrec.go`——进程级单例 + `EncodeAll`（无需 Close，by design）；其余为测试或 Decoder
- Q2 收口之问：两函数各自的 done defer 即本函数瓶颈口，跨函数收口需重构（超出本单边界）；单例 EncodeAll 不走该口，无改理由

## 现场

- worktree /tmp/mg115-a2-4736 已 remove，本地分支 hunt115-a2-4736 已删（零提交）；临时稿目录已清
- 未推任何 fork 分支、未写 journal（按任务书主线程统一记账）
- 兄弟单边界：#4735（无修改跳过解压重压缩，性能面）/ #4276（request-cache 写放大）均未接，池中留观——本单未触其面

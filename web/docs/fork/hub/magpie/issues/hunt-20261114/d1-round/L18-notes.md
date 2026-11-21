# L18 车道终笔记（2026-11-14，档1 专注轮）

基线 tip：a8fa771a（开工）；收口时 upstream tip=783b69b8c（新增 3 提交均在 gateway/update 域，对两 patch 的文件零触碰，方向鲜度门过，未 rebase）。

## #3356 library sync 重启用排除的本地数据覆盖较新服务端内容

- **处置**：PATCH-POSTED，帖 [6868427368](https://github.com/yetone/magpie/issues/3356#issuecomment-6868427368)，分支 `hunt-20261114-d1-3356`@`17dff3cdcef8c29c`，patch sha256-16=`301fbfd2f9e8108e`。
- **根因**：459d668b3（#6428 sync 大改造，Nov 13 落地）已修报告主场景——`st.Off` 标记被排除的 part、rejoin 按首 join 处理（部分引用 #5642），且 commit 未引用 #3356（无声收编第三形态，排雷⑤抓到报告者自带 fork fix b0ccf760 未被应用）。残留缺口：**改造前版本写的 state 无 `Off` 字段**——升级后启用 part（中间无 sync）时 rejoin 不触发，落 `lc && !rc` 分支 → 旧本地上传覆盖较新服务端内容。Configure 无迁移。
- **修法**：rejoin 检测兜底——`st.Local[p]==hashes(backup.Bundle{})[p]`（nothing-hash）且 `L[p]≠st.Local[p]` 且 `!unset(local,p)` 且 part 现在 sync 且非首 sync → 追加进 rejoin，走同一条"各算各的改动、新者留下"路径。`st.Off` 在册的 state 走原路径不变；首 sync 本身就是 join。
- **验证**：RED（只退 davsync.go：仅 TestSyncPartTurnedBackOnWithoutOffMark 红、主路径测试仍绿——变异点精准）；复绿；davsync 全量 25m 绿（提交 head 重跑）；race 定向绿；gofmt/vet 绿；GOOS×3 nogui 绿；git am 回放树一致（8d144288）；回读全绿。
- **Not verified**：真机从改造前版本升级（真实 server 内容）；GUI sync 表单。
- **边界（帖内已声明）**：legacy state 中被排除 part 本地无内容时，服务端内容要等服务端该 part 下次变化或再开关一次才到来——无数据损失。
- **不自信点**：①兜底检测在 tip 自产 state 上的唯一新增行为是"曾参与且为空、现持有内容"也走 rejoin——与原路径结果等价是静态推演（时间戳比较两者同向），无专门测试锁定；②`hashes(backup.Bundle{})` 与 legacy 各版本 state 的 nothing-hash 表示逐版本一致是按当前实现推定（h(nil) 对 nil 字段），未对每个历史版本实测。

## #5642 s3 仅勾 Library 多机覆盖其它 setups

- **处置**：出列零帖。f411bd304（v0.1.3363，Nov 9）显式收编（commit 主题带 #5642，tip 代码三处引用），维护者帖内致谢本账号 patch，报告者末评已理解。无新投入，不重复交付。

## #5583 SignIns 同步复制旋转 refresh token（丢账号面）

- **处置**：出列零帖。8a7f77cb7（v0.1.3363，Nov 9）以本账号 `rotating` 原语收编（"on @ggbdpq's rotating primitive"）。余下 open 部分是报告者的 `carry: relay` 生成链提案（功能/设计面，维护者明说等两机日志后另行设计），非档1，不硬凑。

## #4258 agent stash 原件在 restore 失败后丢失+坏 stash 被替换

- **处置**：PATCH-POSTED，帖 [6868465352](https://github.com/yetone/magpie/issues/4258#issuecomment-6868465352)，分支 `hunt-20261114-d1-4258`@`9aac492d0e6b4460`，patch sha256-16=`c9663118cd5ad6ac`。
- **根因**：tip 实锤三面中的两面。mode 1（restore-before-write）：claude/codex `unroute` 的 `unstash`（删+写回）先于还原配置的写，写失败即永久丢失；claude `putClouds` 同形；model 原件的消费点（unroute）早于其还原/替换写（Unwire/set 后段）。mode 2（坏 stash）tip 已是 #1505 家族声明形态（lastgood.KeepUnparsed 旁置）——不动，帖内声明。mode 3（跨进程锁）报告者 patch 有、本 patch 未带，帖内列为 left。
- **修法**：stash.go 新增 `peek`（读不删）+`forgetValues`（写成功后取走，仅当值仍等于 peek 值——并发写存活）；claude putClouds/unroute 块改 peek+写+forgetValues；model 键改由调用方在其写成功点消费（Unwire switch 两分支、set(v)、set("") 的 forget 批次后移到 DelJSON 之后）；codex unroute 同改+set(v) 加 forget；codex Unwire 原 forget 批次恰在写后已合规不动。unstash 在 claude.go/codex.go 归零。
- **验证**：RED（只退 stash.go/claude.go/codex.go 三产品文件：双子测试红，输出即报告面——stash 原件尽失）；复绿；agent 全量 25m 唯一红=TestMothX（预存红名单在案，非新红）；race 定向绿；gofmt/vet 绿；GOOS×3 nogui 绿；git am 回放树一致（b64ec6d1）；回读全绿。
- **Not verified**：双 magpie 进程共享配置目录（mode 3）；真实 watcher/失败 rename（用目录占位注入模拟）。
- **兄弟面 Left（帖内已点名可追踪）**：agy.go/ante.go/antigravity.go/astrbot.go/cline.go/claudedesktop.go 的同形 take-out-before-put-back 未改（patch 尺度相称原则+报告者自身 patch 也仅 claude/codex）；applied.go/agents.go 的 unstash 是纯消费无还原写、非缺陷面。
- **不自信点**：①model 键消费点迁移改动 5 个调用点的契约（unroute 不再消费 model），依赖调用方自觉 forget——若未来新增 unroute 调用方忘记消费会泄漏 stash 条目（无编译期防护）；②set("") 的 forget 批次后移改变了 DelJSON 失败时 mainKey/wroteAt/aboutKey 的存活（原先于写被删）——判定为改善但属行为变化；③帖内 race 行命令省略了实际多跑的 TestOffAndOnAgain（实际为超集，结论不受影响， fidelity 瑕疵）。

## 环境陷阱（本轮新录）

- macOS 上 `edit.WriteAtomic` 的 `Target()` 将 `/var/...` 解析为 `/private/var/...`：测试经 `edit.Filtered` 注入时比较路径必须先 `filepath.EvalSymlinks`，否则 `p == path` 永假、注入静默不触发（#4258 测试首跑教训）。
- 后台 `go test | tail -N` 会把失败详情截断丢失，且任务通知的 exit code 是管道尾命令的——全量验证一律 `> file 2>&1` 落盘再读。

## 本车道未跑项清单（汇总）

- 两 patch 的 GUI 测试（playwright 套件）未跑——改动均在 Go 内部分派/时序层，davsync/agent 包全量已盖；#3356 的 sync-scope GUI 表单与 #4258 的 GUI 路由展示未过浏览器。
- #3356：真实升级路径（pre-#6428 版本写的 state + 真实 WebDAV/S3 服务器）。
- #4258：跨进程并发写 stash（mode 3）；Windows watcher 持文件的真实失败注入。
- gateway 包全量未跑（两 patch 不触 gateway 域）。

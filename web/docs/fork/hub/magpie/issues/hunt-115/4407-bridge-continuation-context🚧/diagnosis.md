# #4407 诊断记录（hunt-115 b13，2026-11-02）

## 老单复核
- 报告 v0.1.2119（ffa07395e，10-30）。行号全部重核于现行 HEAD（14e351378→rebase ccd746e03）。
- 同域提交逐读：10-30 以来 claude_subscription.go 约 30 提交，两大波：TUI 交互模式（10-31 起）、branch 机制（2af4d8c62，11-01，"tool results another request answered first branch off the run's session"）。
- 碰撞：无 open PR 引用 4407；#4568（AgentSummary 缓存成本判面，@yetone 求方向中）不碰撞；#2933/#1365/#1429 同族不同症状；#3440/#2955 为 Codex compaction 域。

## 假设与排除（关键推演）
- H1 follows 拒绝后 fallback 静默 unshelve/resume 同对话旧 session：**排除**。follows 与 turnKey 用同一 hashMessages；「key 命中 ⟹ req[:j+1] 逐字等于 heard+reply ⟹ follows 必真」，数学上「follows 假而 key 命中」不可能。v0.1.2119 与 HEAD 同构（已 diff 原文核验）。
- H2 rewritten（looseTurn）静默接住深改写：**排除**——rewrote 只容忍 last turn 的 cut/短尾（cutFrom/HasPrefix），且命中带日志与 toolsCover。
- H3 branch 的 said!=totld 盲区：**排除**——historyKey(msgs[:k]) 恰等于 park 时 l.told（触发 calls 的请求全量），检查完备。
- 残留：报告日志「replacement run 无 told 行」在现行架构下唯一无日志来源是 hasReply 为假的静默全量 start（上下文完整，非事故）；报告者日志为节选，可能存在未贴的 rewritten/branch 行。报告时序本身（interrupted response 与 2,171 的因果）报告者自认未定 reproducer。

## 定稿根因（本 patch 收口的面）
shelve 与 abortFor（SIGTERM）在同一轮 keepIdle 里连续发生；Claude Code（Node）写 session JSONL 是异步的，进程被杀时未 flush 的尾部永久丢失。unshelve 消费前只 stat 存在（saved()），残缺文件被静默 resume，只喂 since → 发给 Anthropic 的请求=残缺历史+增量 → 200 小上下文应答。这就是 #4407 报告的「silently return HTTP 200 from a new context containing only tool output」的确定性通道。

## 修法（c19f59eb8）
- savedSession.line = shelve 时 run.lines 里 seq 最大的 uuid（noteLines 现成跟踪，Claude Code stdout 的 uuid 即 session 行）。
- unshelve：line 非空且文件无该行（sessionHasLine，cutAfter/mark 范本同 cutSession）→ discard + 日志 + told whole 兜底。
- 不变量：JSONL append-only ⟹ 最后 assistant 行在 ⟹ 其前全部在。
- 兄弟面：resume（活 run 持续写盘，无 SIGTERM 竞争）不改；branch（cutSession 已验 cut 行）不改；saved()（存在性）保持互补；sweep/remove 清理路径不涉。失败读取语义：文件读不到→拒绝 resume→told whole（非空/相等）；sid 非法→true 交 Claude Code 自身拒绝兜底。热路径代价：unshelve 低频，一次 ReadFile O(文件)，锁外。

## 验证
- RED：TestClaudeAShelvedSessionMissingItsLastLineIsNotResumed（残缺拒/完整过/无 line 过/无文件拒四案例）；消融（删 unshelve 验证）回红：`a session whose file was cut short of its last line was resumed`。
- 定向套件（Session/Resume/LetGo/Rewritten/Shelv/Branch/Fork）绿。
- gateway 全量 nogui：1 失败 TestCodexPoolSaysTheClientsVersion——UA 断言吸入本机 Apple_Terminal/455，分支与父提交单跑均绿，与改动零交集（环境型预存，见下）。基线全量对照：见 base-full.log。
- gofmt/vet（含 GOOS=linux nogui、GOOS=windows）绿；三平台 build 绿（darwin cgo 预存 warning 在 internal/gui，非本包）。

## 预存红清单（本机）
- TestCodexPoolSaysTheClientsVersion 合跑偶发：UA 环境泄漏；单跑绿（分支/基线都绿）。同型先例：任务书记录的 spawn 重度合跑互踩。

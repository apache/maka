# T1 车道 L6 STATE（2026-11-12，开工 tip f6c882ad7 → 中途 ea3a00ad）

- worktree /tmp/mg-t1L6-wt；GOCACHE=/tmp/mg-t1L6-gocache；数据 /tmp/mg-t1L6-data；patch/帖稿 /tmp/mg-t1L6-out/
- 产物：docs/hub/magpie/issues/hunt-20261112/t1-L6-{5273,5220,3183,5299,6155,6066,5333}/

## 终态

| # | 处置 | 帖 id | 要点 |
| --- | --- | --- | --- |
| 5299 | 判定 | 6825149906 | 上游今日 531b27783（v0.1.3899，#6292）落地 claude-shelf --resume=报告者 ask7；信任面=ClaudeTrustFolder 只写 saved accounts（#4830）；中段打断/取消不在 shelf 面=设计空间 |
| 5273 | 验证背书+预算第二笔 PATCH | 6825308007 | elio 1e1b101bc cherry-pick 至 ea3a00ad（干净）；行为级 RED（探针 [] vs ["qwen-1","qwen-2"]）+20/20 双引擎+同族 34 绿+works-only 双树同红预存；预算红→我方第二笔 1,264,422→1,264,700（实测 278）；分支 hunt-20261112-t1-5273@b0c80a5b45a0fe11（--force-with-lease 强推后）；patch sha e39aff392ca8f808/883d799e9a7b96f5；am 回放树 0a611cf3 一致；take 6823552780；gui 全量#2 仅同 2 预存红；帖 GET 回读 IDENTICAL |
| 5220 | 判定（声明设计） | 6825146459 | expiringResetSpent stopped 例外=da46cd21f(#718) 提交正文+TestResetSpentAsLateAsSafe 守护+tooltip 四处声明；报告者数据吻合例外形状；两建议转产品反馈 |
| 6308 | 让位（零帖） | — | author=yetone 亲单，正文自带修法 spec，自评在跟（e0b67f342） |
| 6155 | 判定 | 6825151964 | gatewayMode(web&&boot.gateway) 下 provPrefsField 隐藏 warmup/resets（app.js:19655/19684，v0.1.3758 已含 19656/19685）；warm-up 经本地 app 发送=Docker 无宿主 |
| 6066 | 判定/指路 | 6825153572 | 重置卡自动使用=Codex 独占（codex_*.go）；Claude 侧已有 Warm up on reset（claudeWarmup） |
| 5333 | 判定（feature 定性） | 6825154963 | Codex 三档已含「只列 magpie 模型」；其它 agent join=route.go 设计；扩大覆盖=maintainer feature |
| 5423 | 出列（零帖） | — | 纯咨询，社区已答 2 条，我方无事实可加 |
| 1714 | 出列（零帖） | — | 我方 #1737（eb22f6355）已修，v0.1.1230 发出，等报告者确认；主题行双单号在案 |
| 3183 | 判定（尾评新 bug 定性） | 6825148060 | zzy9001 首刷 lead=""：stick=完成时写（answered/affinity.go）→spawn 序竞态结构性成立；+12.5s 行不可见两候选（readLogSnapshot settle 滞后 #4368 / id 形状）；修法方向三条留 maintainer；take 6823554831 |

## 过程记事

- 开工排雷净（10 单无 open PR 竞争、无他人占坑）。
- 5273 中途上游推进 f6c882ad7→ea3a00ad：gui 资产+预算测试同域 → rebase（elio 提交干净重放，i18n 旧键 0/新键 4；预算冲突按新上游值重建 1,264,422+278=1,264,700）；探针 RED 重建于 ea3a00ad 树复现；20/20 复绿；am 回放 0a611cf3 一致；--force-with-lease 显式 sha 强推。
- Playwright 本机可跑：缓存 chromium-1200/webkit-2227 ↔ playwright 1.57.0（/tmp/mg-t1L6-pw，未触仓库树）——GUI 测试 NOT-RUNNABLE 旧结论本机已可破。
- gui 全量#1（f6c882ad7+fix）：仅 TestProxyCheckSaysAProxyPassedBy/TestSessionReadsRoutes（均预存红在册）零新增；gui 全量#2（ea3a00ad+系列）后台在跑。
- 判定帖域漂移核查：新 tip 10 提交仅触 gui 资产，判定帖引用域（codex_expiring/gateway/claude_dirs/usage）零漂移。
- 6 判定帖 GET 回读全 IDENTICAL（5333 一次网络 EOF 重试后过）。

## 第二批（同日续，开工 tip 873b4987e→发帖时 182803ea，零域重叠）

| # | 处置 | 帖 id | 要点 |
| --- | --- | --- | --- |
| 4660 | 判定跟进帖（旧分析在案 11-02） | 6826452966 | 上游 04ed05733（v0.1.3308）修掉 switch 覆写缺口（darwish4021 案）；报告者症状=共享 refresh token trade 成本面（族判定 #5702/#6037 口径）；四问仍待报告者 |
| 5465 | 复验重发 PATCH（我方 in-flight 修复） | 6826454744 | rebase 0d99261dc→873b4987e 零冲突；WSL/Pi 五测+全族绿；GOOS 双绿；patch sha c0772f29525c4028；分支 hunt-20261112-t1-5465@7dfaf056f（补 Generated-by 尾注强推；中途误重写 message→对照原提交恢复全文+尾注，d1942933d）；apply 干净至 7dbfc9f2f |
| 4144 | 验证背书+rebase 重发 PATCH（skygunner 系列两笔） | 6826456398 | cherry-pick 至 tip（消融回红 TestCorruptFrameDoesNotExposeLineContinuation）；两处适配：版本位改 per-agent（parseVersions dsh 4/callParseVersions dsh 1，遵 #2278 两级约定）+modTime 类型；sessions 全包绿 98.8s 零失败；am 至现 tip 两笔全落（git apply 多文件怪癖≠am）；分支 @eb23419a；patch sha 4d3ab4716a100ba4/453460ad807178c9；take 6825833185 |
| 3197 | 验证背书 PATCH（skygunner orphan 修复） | 6826458007 | 上游 c736906b1..7dbfc9f2f 零覆盖→fork 修复仍唯一；cherry-pick 干净至 tip；消融回红双测试；severed 全族绿；gateway 全包绿 997.2s 零失败（第一次后台跑活着被我误判死+并发重跑→停冗余）；patch sha 0d4491a1eafb8386；分支 @abe40fd14；take 6826452293 |

- 判例：git apply 多文件按序不串联同文件 create→modify（--check 假阴性），git am 才是顺序通道；全树 am 回放比对必须锁同基（base 漂移=假 MISMATCH）；多系列 am 循环必须每系列重置仓库（累积叠加假 MISMATCH）；zsh 变量 refspec（$H:refs/...）被吞→字面量。
- 本机 GUI 测试通道可用（playwright 1.57.0 ↔ 缓存 chromium-1200/webkit-2227）。

# R-B 车道 档1 审查轮 STATE（2026-11-14）
TIP = f53c4a1a1451a10a589b9ff02fa29ff33fa9b501 (upstream/main, 实 fetch)
GOCACHE = /tmp/mg-RB-gocache
worktree = /tmp/mg-RB-wt（每单重建）
产物 = issues/hunt-20261114/audit1/RB-<单号>/

## 分支 head 实测（ls-remote）
- #4144 hunt-20261112-t1-4144 = 367ce6f8a4 (vincent x2, parent 98bee0b77 on a8fa771a6)
- #4666 hunt-20261112-t1-4666 = cf8d4f0d20 (ggbdpq x1, parent 63c91cae5)
- #4785 hunt-20261112-t1-4785 = 8211d0fccd (Dopetaiga x1, parent 63c91cae5)
- #5197 hunt-20261112-t1-5197 = af2530c021 (NightGlowww x1, parent 63c91cae5)
- #5205 hunt-20261112-t1-5205 = 68b74201aa (SkyJiashu x1, parent 63c91cae5)
- #5260 hunt-20261112-t1-5260 = a78ab6f424 (ggbdpq x1, parent 63c91cae5)
- #5914 hunt-20261111-rf-5914 = a41c0243ea (yjqi x1, parent a8fa771a6)
- #5969 hunt-20261112-t1-5969 = 04667d0934 (ggbdpq x1, parent 63c91cae5)
- #6336 hunt-20261112-t1-6336 = 149e364e5a (Aryz 多提交, parent fd00a4842)

## 进度
- [ ] 4144
- [ ] 4666
- [ ] 4785
- [ ] 5197
- [ ] 5205
- [ ] 5260
- [ ] 5914
- [ ] 5969
- [ ] 6336

## 4144 Phase A (done)
- rebase TIP f53c4a1a1: clean, new head 3e7c64a2ce211c7b4eb6b4fcec32ab219b4377ca (2 commits: 0342310d2 + 3e7c64a2c)
- range-diff a8fa771a6..367ce6f8a vs f53c4a1a1..new: both `=` 零语义漂移; author vincent preserved
- am: 2-patch series applies clean on TIP, am-tree 8b843e7553 == branch-tree 8b843e7553 TREE-IDENTICAL
- series patch sha256-16: 419d74d389c68d4a

## Phase A 完成（9/9 全部 rebase TIP 干净 + range-diff 全 `=` + am TREE-IDENTICAL + 作者保留）
- 4144: new 3e7c64a2ce211c7b4eb6b4fcec32ab219b4377ca tree 8b843e7553 sha 419d74d389c68d4a (2提交)
- 4666: new 7295e1037730720a5b297742d1efec92ed3729b4 tree 6102bca489 sha e04902cbd80e38d3
- 4785: new 067e754ebb16eb312b1dca57764d22edb6cee304 tree ad981b88d2 sha 719447a6508d0554
- 5197: new 68324ff74aca447e5d144d13d6d88fc144b21a8e tree e9bbbec4cc sha a9e413dbd8a37b99
- 5205: new c7ebd54b63d5be6d68aa6cd7a1be399aa6b65f85 tree de316210b6 sha ef76ec315fb6ff55
- 5260: new d7c32d937ca138da4fff7f6adecb02f67949bea0 tree 0c91df31e6 sha 90aa470aa5f62232
- 5914: new fe319191b80a908c386e2fead48be4868a5e4eff tree 434688083e sha a95df363f541c531
- 5969: new a3a72cb8dc9add5fb21b170ce3da19c2bc08bd5b tree 46eb56e142 sha f1c5678f85317575
- 6336: new 0c13f5f577f7a6aca5c321c9fb48878293da5c25 tree cc38e8fdc9 sha 7174b1b1722bf2ee (11提交, series root=63c91cae5, 11/11 `=`)
- 教训：wt2 am 前必须 reset --hard TIP（4666 首次比对不一致系 wt2 残留 4144 am 结果，重置后一致）

## TIP 二动（POST 前鲜度门拦截）: f53c4a1a1 → eb1b8300049212e71617167498d349792625c07c
增量 2 提交（gateway.go/prev_response.go/cindy+prev_share 测试/agent-wiring docs），与本车道 9 单改动面零重叠。
9 单机械链在新 TIP 全部重做（教训：批量循环曾出零提交瞬时故障，mech.sh 已加 pipefail+零提交守卫，逐单重跑核实）：
- 4144: 48d18e31d3528b6a35b60218347c37b738e355b7 tree 814dce351f sha 419d74d389c68d4a (2提交, range-diff 2/2 `=`)
- 4666: f7ecd0bd9fbbdc0b6891374f2d8df2e5d105c352 tree 9488fe805e sha e04902cbd80e38d3 (1/1 `=`)
- 4785: 38a7e7e3f992eec4695ed925e0c13c7c48e3368b tree 1686d81c52 sha 719447a6508d0554 (1/1 `=`)
- 5197: c520ff7cee082321e28036b40cfdc901192666d4 tree 981d9c91bc sha a9e413dbd8a37b99 (1/1 `=`)
- 5205: 00b8fa9e9a147e571a601f36ac0e92f4be008c34 tree 08e2a138d4 sha ef76ec315fb6ff55 (1/1 `=`)
- 5260: 87d765c366b5a5eef5e296a23866cea9fe8fa4fd tree 883d191607 sha 90aa470aa5f62232 (1/1 `=`)
- 5914: 6ef377c5f4fddccaa480478369f9c9979abf951f tree fcebefbb01 sha a95df363f541c531 (1/1 `=`)
- 5969: df12d257fd0c062605f91ddffa27ef4395f701f5 tree ca940423c8 sha f1c5678f85317575 (1/1 `=`)
- 6336: 39687605e00839b4480cfa464389086dec109d79 tree c6484be54a sha 7174b1b1722bf2ee (11提交, 11/11 `=`)
patch sha16 与旧 TIP 轮一致（patch 文本不含 base 信息，零漂移预期内）。

## 4144 完成 REVERIFY-POSTED
- 帖 id 6868883652 (GET 回读 len=2117, head16=48d18e31d3528b6a, sha16=419d74d389c68d4a 全部在帖内)
- 新证据（TIP eb1b83000 基, head 48d18e31d3）: sessions 全量 ok 89.1s; race 定向 ok; gofmt/vet 清; linux/windows/darwin nogui build 清
- 消融: 产品文件回 TIP 保测试 → 6/10 红（TestCorruptFrameDoesNotExposeLineContinuation frames_review_test.go:30: lines=[] next=0 end=0 err=<nil> + TestDshCorruptSeedCacheRepair 计入 fork 继承用量）→ 恢复绿
- 兄弟面: dsh.go/calls_dsh.go 双读皆走 scanFrames; parseVersions dsh:4 + callParseVersions dsh:1 在位
- 教训: gh api -f body=@file 不读文件（发了 31 字符壳帖）→ PATCH -F body=@file 修复; 推 refspec 必须用 ${VAR}:refs/... 防 zsh :r 修饰符

## 4666 完成 REVERIFY-POSTED
- 帖 id 6868968760 (len=2112, head16=f7ecd0bd9fbbdc0b, sha16=e04902cbd80e38d3, GET 回读含分支链接+Attribution)
- 新证据（head f7ecd0bd9f）: plugin 全量唯一红 TestHostToldTheGatewayAddress（净 TIP 同红: 3592/3591 端口迁移）; 双 lock 测试 race 绿
- 消融: store.go 回 TIP → 两测同红 store_lock_test.go:31/79 → 恢复绿; gofmt/vet 清; 3 GOOS build 清
- 兄弟面: 写漏斗=store.go 五 mutator+listFileMu; 其余 plugins.json 引用全是注释/读

## 4785 完成 REVERIFY-POSTED
- 帖 id 6869105729 (len=2188, head16=38a7e7e3f992eec4, sha16=719447a6508d0554)
- agent 全量 325.5s 仅 TestMothX 红（净 TIP worktree /tmp/mg-RB-base 同红确认）; TestCodexSyncMendsGoneCatalog 定向绿
- 消融: macOS 不可见（ToSlash 原生），回退 codex.go 测试亦绿——红证据=帖内两真 Windows 机记录（laweit-lxy 8f804396fd / Dopetaiga 3e319622）
- 兄弟面: ownCatalog 8 调用点全走同一谓词; deskCatalog 仍裸串比较（同前）
- 5197 gateway 全量后台完成: ok 1012.768s 零失败（head c520ff7cee）

## TIP 三动（5205 POST 前鲜度门拦截）: eb1b83000 → 92e760f3d1825f643b57c53b19f1692928ab4183
增量 2 提交: 4e770f733 library subagent 导入（library+gui+docs）+ 92e760f3d providers 模型 keys 标注（GUI-only）。
4144/4666/4785 已于各自 POST 前 gate 过，帖引用当帧 tip 成立，不追改。
剩余 6 单（5205/5260/5914/5969/6336/5197）机械链重做（TIP=92e760f3d1）:
- 5205: ff919f08cb6264cddccf373db4742d5a4c8e6062 tree 02a2fbe049 sha ef76ec315fb6ff55 (1/1 `=`)
- 5260: 37ee8a5ebd0f72d183eda154c898462d09b9aa67 tree (identical) sha 90aa470aa5f62232 (1/1 `=`)
- 5914: 44df60d139b6eb29261b2b9bd3b0569aaadd0a80 sha 24fdc3a5e939bb45 (1/1 `=`; sha 变=上游 i18n 加行使 hunk 偏移移，无语义混入——i18n.js diff 仅含我方行已核)
- 5969: 6f2bb5f9cb677ab2c6480c7e02c52496b551ba9f sha f1c5678f85317575 (1/1 `=`)
- 6336: 1d4839e857acfa3949c3ed3872037f5befee0ee3 sha 9b3adb02a19f9c48 (11/11 `=`; 同上偏移漂移)

## 5205 完成 REVERIFY-POSTED（TIP 92e760f3 基）
- 帖 id 6869277681 (len=1787, head16=ff919f08cb6264cd, sha16=ef76ec315fb6ff55)
- claudetui 全量 ok 149.6s; gofmt/vet 清; windows/linux/darwin build 清
- 消融: _windows.go darwin 不编译，双态同绿——红证据=帖内两 Win10 真机
- 兄弟面: CreatePseudoConsole 仅 child_windows.go 一处

## 事故记录（5197 证据污染）
两个后台 gateway 套件任务（exec_7af34e68@ d5f103e4f5 / exec_4262fec1@2f45759a36）共用 /tmp/mg-RB-wt-5197 与同一日志文件，并发 checkout 互踩；事后 worktree 停在过期 head fa999bb339，full3.log 来源不可信 → 5197 全部证据作废，已重建独占 worktree（mg-RB-wt-5197@2f45759a36）单任务重跑 full4。其余 4 单（5260/5914/5969/6336）全程专属 worktree 未受影响。
教训：同一 worktree 永远只允许一个后台任务；日志文件名必须含任务唯一 id。

## 各单进度（TIP 6c88d61f0d 基）
- 5260@faaf3a3d3f: agent 全量 ok 仅 TestMothX（净 TIP 同红已证）; 消融红 hermes_test.go:575; race ok; builds ok
- 5914@f93f84c097: provider 全量 339s 仅 TestResolveVia（净 TIP 同红）; race 定向 ok; 根因消融（providersMu.Path 旁路）→ TestEditRefusedWhileAnotherMagpieHolds edit_test.go:213 + TestProvidersChangeRefusedWhileAnotherMagpieHolds providers_busy_test.go:79 两拒绝边界红, 恢复绿
- 5969@ea020ffdc9: agent 全量 577s 仅 TestMothX; race ok; 行为消融（摘两 share 分支保 const）→ TestClaudeDesktopCompactPctDeclaration claude_compact_pct_test.go:88 + TestClaudeCompactPctGivesWay :152 双红, 恢复绿
- 6336@a0239b48d7: library 全量 ok 392.7s; race ok; 消融（回 4 产品文件+删 skillwellknown.go）→ 8/10 红, 恢复绿; node --check ok
- 5197@2f45759a36: full4 重跑中

## 发布记录（全部 POST 前过鲜度门）
- 4144: 帖 id 6868883652 @ tip eb1b83000, push head 48d18e31d3
- 4666: 帖 id 6868968760 @ tip eb1b83000, push head f7ecd0bd9f
- 4785: 帖 id 6869105729 @ tip eb1b83000, push head 38a7e7e3f9
- 5205: 帖 id 6869277681 @ tip 92e760f3, push head ff919f08cb
- 5260: 帖 id 6870387012 @ tip 925bc7188b, push head 91e05dd4f7 (run7 证据)
- 5914: 帖 id 6870389076 @ tip 925bc7188b, push head efedb81bb1 (provider run6 全量+run7 race/消融/tui+子树同一性)
- 5969: 帖 id 6870391324 @ tip 925bc7188b, push head ef20ebb347 (run7 证据)
- 6336: 帖 id 6870393492 @ tip 925bc7188b, push head 97dbb0707 (run7 证据)
- 5197: gateway run7 跑中（head 5a716cb5e@925bc7188b; 上游 925bc7188b 改了 codex_backend.go——干净合并、range-diff `=`、合并区人工核看完整）
- 各单 run5/run6/run7 证据日志、消融红逐字输出、ls-remote 对账均在 /tmp/mg-RB-audit1/
- 5197: 帖 id 6870531265 @ 双 tip 表述（证据@925bc7188b + push head 13b5b423e@8ed2ae030c），ls-remote 对账一致
- 全 9 单完成。R-B 车道收工。

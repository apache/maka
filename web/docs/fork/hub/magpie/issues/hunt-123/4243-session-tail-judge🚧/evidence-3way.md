# #4243 三方对照证据（判定车道，worktree /private/tmp/mg123-g，基线 2741b749f）

判定日期：2026-11-04。上游 yetone/magpie；报告者 aresxu8866-hue；竞速者 zhangjian94cn。

## 0. 祖先关系实测

- `git merge-base --is-ancestor 70d50254c 2741b749f` → **是**：上游修复在 tip 内。
- `git merge-base --is-ancestor 70d50254c zj94/fix/4243-codex-lifecycle-boundary` → **否**：竞速 draft 基座 b26fa090 早于上游修复，**不含** 70d50254c。
- `git merge-base --is-ancestor 4534561f6 70d50254c` → **是**：报告者引用的 main 落后于修复（报告时点修复未落地，现已在 main）。
- 上游 main 自 tip 后仅 1 提交（6d1e3f1e2，gui tests），codex 触面零新动作；`git log upstream/main --grep=4243` 仅命中 70d50254c 本身。

## 1. 报告者（issue 正文）要素清单

1. **route 含 magpie 不拥有的 catalog**：`codexAppRoute` 哈希 `model_catalog_json` 指向的文件内容；第三方工具每次 Codex models-cache 刷新都重写（仅 fetched_at 不同）→ route 每几分钟一变 → 反复重启（一天 30+ 代 app-server）。
2. **重启权限中断 turn**：`KeepCodexAppOnItsProvider` 对运行中的 turn 发 SIGTERM；app 重连 `resumedCurrentConversation=false`，turn 停止（eslogger signal 实证 sender=magpie tray）。
3. **512KiB tail 缺 task_started 判 open 为 closed**：`sessionTurnOpen` 只读 rollout 末尾 `sessionTurnTail = 512 << 10` 字节；长 turn 的 task_started 在 512KiB 之外且尾部无 task_complete/turn_aborted → `started == ended == -1` → 判 closed。整文件回放判 open，tail 判 not。
4. 建议：(a) tail 无标记时往前读/整扫/保持生命周期偏移，判不了的算 open；(b) 仅当 magpie 拥有 catalog 或自己是 provider 时才把 catalog 计入 route；(c) 加关闭自动重启的开关。

## 2. 上游 70d50254c（2026-10-31，yetone）实测

- 提交：`codex: a change to the model list alone no longer ends the Codex app's app-server`（#4550 触发，报告者 #4243 的 catalog 面同根因）。
- agents.go：route key 列表去掉 `model_catalog_json`（现 tip :101 仅 model_provider/openai_base_url；:109 magpie.base_url；:120-122 requires_openai_auth 仅当 mp==magpieID；:123-125 out）；删除 catalog 哈希块（原 `catalog=" + codexCatalogTag(c)`）；注释 :77-83 明示 model list 不在 route。
- codex_app_route.go **整个删除**（45 行，codexCatalogTag 在内）。
- codex_app_server.go 17 行：**纯注释**，tail/重启逻辑零改动。
- 新测试：TestCodexEffortPickKeepsTheAppRunning（报告者同款场景）、TestCodexAppRouteIgnoresARename（反转旧保证）。
- 提交信息 "Siblings, all read" 段：RestartCodexApp / RestartSwitchedCodexApp / RestartCodexAppWhenIdle 逐个核过——用户发起或真 route 变更，不读 catalog，未改。

## 3. 竞速 draft 1139c528（zhangjian94cn，2026-10-30）实测

- 体量：28 文件，+707/-1960。基座 b26fa090（早于 70d50254c）。
- codex_app_server.go（-535 行为主）：
  - `codexAppStep` 重写为只标记 pending refresh，恒返回空（"only Codex may restart them"）；
  - `endCodexAppServer = func(int) error { return errCodexRefreshRequired }`（:69）——**全树唯一**的 endCodexAppServer 残留是 stub；
  - `RestartCodexApp` / `RestartSwitchedCodexApp` → `errCodexRefreshRequired`（:327-334）；`RestartCodexAppWhenIdle` 只报 uninstall notice，永不结束进程（:339）；
  - `sessionTurnOpen`/`sessionTurnTail = 512 << 10` **逐字节保留**（:276-308），但 `codexTurnOpen` 改注释 "diagnostic only ... neither this sample nor a process's start time authorizes a restart"——tail 判定失去消费者。
- 兄弟面（与其自述一致，diff 实查）：agents.go 钩子重接线（CodexAppReopen 摘除）、apprestart.go、codex_app.go（-96）、codex_daemon.go、internal/uninstall/uninstall.go、gui providers.go/app.js(-93)/i18n.js(-52，废弃 notice/翻译 20 行)——desktop/daemon/uninstall/generic 全不再终止 Codex。
- **route 仍含 catalog 哈希**：draft 的 agents.go :79-96 保留 `model_catalog_json` + `codexCatalogTag`，codex_app_route.go 仍在。route 照旧每几分钟一变，只是变更后果降级为 pending-refresh 标记（stale/stuck → GUI 提示），不再击杀。
- 自述状态：全量套件 RED（5 gateway 失败复现于基座=#4362；TestPluginSOCKSProxy=#2207 基座也红；CheckinGoesThroughItsProxy 双侧超时；GitPluginUpdateOnlyWhenItsRepositoryMoved 未定性）→ 自标 draft not merge-ready。tradeoff：切账号后 Send 不可用直到用户刷新。

## 4. tip（2741b749f）机械链路（文件:行）

- 重启判定链：`gateway.go:807` → `KeepCodexAppOnItsProvider`（codex_app_server.go:335，3s 一拍 codexAppEvery :138）→ `codexAppStep` :354 → route 变更入 stale 集 :413-438 → busy/idle 门 :499-501（codexAppIdle=10s :139）→ `codexTurnRunning` :510（→ codexTurnOpen :555 → sessionTurnOpen :612）→ `endCodexAppServer(p)` :525 SIGTERM。
- tail：`sessionTurnTail = 512 << 10` :606；seek 到 size-512KiB :618-622；`started := LastIndex("type":"task_started")` :627，`ended := max(task_complete, turn_aborted)` :628；`started <= ended → false(closed)` :629-631——双 -1 落 closed，与"读不了的文件算 open"注释（:608-611）只覆盖读错误/时间戳解析失败（:615/:620/:625/:636），不覆盖"标记都在 tail 之外"。
- route：agents.go codexAppRoute :84-127，已不含 catalog（70d50254c）。

## 5. 判定表

| 要素 | 上游 70d50254c | 竞速 draft 1139c528 | tip 残留 |
| --- | --- | --- | --- |
| route 含 catalog → 反复重启 | **覆盖**：catalog 出 route，codex_app_route.go 删，双测试锁定 | 部分覆盖（后果面）：route 仍含 catalog 哈希但变更只标记 pending refresh 不击杀；且不含该修复，rebase 后仍带标记抖动 | 无（tip 已修） |
| magpie 重启权限中断 turn（SIGTERM） | 未覆盖（有意保留）：真 route 变更/账号切换仍重启，catalog 链已断 | **覆盖（设计级）**：全兄弟面摘除终止权限，旧 API 报 refresh required；自认 tradeoff 切账号后 Send 不可用 | 设计决策留给维护者 |
| 512KiB tail 判 open 为 closed | 未覆盖：codex_app_server.go 仅注释改动，tail 逻辑原样 | 未覆盖（被绕开）：函数逐字节保留，仅失去消费者；draft 移除重启权限后误判不再击杀，但误判本身在 | **open**：真 route/账号变更重启时仍可切断 tail 外的长 turn；报告建议 (a) 两边都没做 |
| 建议 (c) 关闭自动重启的设置 | 未做 | 等效实现（重启权限整体移除） | open（属设计决策） |

## 6. 结论

- 上游走"route=请求去向"小步路线，报告的 catalog 触发面已修；512KiB tail 误判是**两边都没盖的残留 open 面**，但只在真 route/账号变更重启时才造成伤害（报告者自己的触发链已被上游切断）。
- 竞速 draft 是"移除重启权限"大改方向，覆盖重启面但以 Send 可用性为代价、全量套件 RED 自认 not merge-ready、基座落后需 rebase。
- 方向选择属维护者设计拍板；本车道只出判定帖不发 patch。

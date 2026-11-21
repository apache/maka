# R-B 车道 档1 审查轮终笔记（2026-11-14）

任务：9 个档1 在途单六要素全链审查——当前 main 上重跑全部证据、复验帖落 issue、分支推送对账。

## 终局 9/9：REVERIFY-POSTED ×9

| 单号 | 帖 id | POST 时 tip | 推送 head | patch sha256[:16] |
| --- | --- | --- | --- | --- |
| #4144 | 6868883652 | eb1b83000 | 48d18e31d3528b6a | 419d74d389c68d4a |
| #4666 | 6868968760 | eb1b83000 | f7ecd0bd9fbbdc0b | e04902cbd80e38d3 |
| #4785 | 6869105729 | eb1b83000 | 38a7e7e3f992eec4 | 719447a6508d0554 |
| #5205 | 6869277681 | 92e760f3 | ff919f08cb6264cd | ef76ec315fb6ff55 |
| #5260 | 6870387012 | 925bc7188b | 91e05dd4f7f7f503 | 90aa470aa5f62232 |
| #5914 | 6870389076 | 925bc7188b | efedb81bb1b55179 | 86f06740e90836d5 |
| #5969 | 6870391324 | 925bc7188b | ef20ebb347bc755e | f1c5678f85317575 |
| #6336 | 6870393492 | 925bc7188b | 97dbb07071a7a69e | 9b3adb02a19f9c48 |
| #5197 | 6870531265 | 8ed2ae030c（双 tip 表述，全量证据@925bc7188b） | 13b5b423e87edbd8 | 36f572bcc038ba02 |

六要素全部在案（帖内六要素表 + /tmp/mg-t1-STATE-RB.md + 各 RB-<单号>/ 产物）：
- 机械链：每单 rebase 干净 + range-diff 全 `=`（4144 两提交、6336 十一提交逐条 `=`）+ git am 干净 TIP 树重放 TREE-IDENTICAL + 作者全保留（含背书载运：vincent/skygunner、Dopetaiga、NightGlowww、SkyJiashu、yjqi/qiqll、CN-Aryz）。
- 套件：sessions 89s / plugin(唯一红=预存 TestHostToldTheGatewayAddress，净 TIP 同红) / agent×多轮(唯一红=预存 TestMothX，净 TIP 同红) / gateway 968-1321s 零失败 / provider(唯一红=预存 TestResolveVia，净 TIP 同红) / claudetui 149s / library 230-393s 零失败 / tui ok。
- 消融回红：4144（6/10 红，产品文件回退）+4666（双红 store_lock_test.go:31/79）+5260（hermes_test.go:575）+5914（锁 Path 旁路→两拒绝边界红）+5969（摘 share 分支→双红）+6336（8/10 红）+5197（codex_models_auth_test.go:38/69 红）；4785/5205=Windows-only，macOS 不可见如实记录，红证据=帖内真机记录（laweit-lxy/Dopetaiga/laweit Win10×2）。
- 兄弟面：每单 git grep 全站核（4144 scanFrames 双读、4666 写漏斗五 mutator、4785 ownCatalog 8 调用点+deskCatalog 未动、5197 identifyCaller/models 独占+上游 codex_backend 同文件改动共存、5205 CreatePseudoConsole 唯一、5260 hermesKeyEnvRef 独占+goose 异形、5914 editFound 成包形状、5969 env 读取唯一、6336 well-known 族独占+上游 subagent import 分离）。
- 实证：各单承 A-50 末帖实证段重跑本地可复现部分；NOT-RUNNABLE 承接（真 Windows 机、双真 magpie 跨机、真 ChatGPT 后端、真 Docker/Hermes、40 Playwright 浏览器测试、真 uizze.sh）。

## 过程要记

1. **TIP 九动**：本车道全程 upstream/main 移动 9 次（f53c4a1a→eb1b8300→92e760f3→2a75aafc→6c88d61f→14f0046e7→27e43ed26→925bc7188b→8ed2ae030，约每 5-15 分钟一动）。全部机械链按最终引用 tip 重做；已发帖引用各自 POST 前过门的 tip（编年先例）；925bc7188b→8ed2ae030c 增量不触 5197 文件与测试，5197 帖内双 tip 精确表述（全量证据@925bc7188b、race/消融/build@推送 head）。
2. **#5197 与上游同文件交互**：上游 925bc7188b 改 codex_backend.go（up-bytes）与本单 hunks 同文件——auto-merge 干净 + range-diff `=` + 合并区人工核看 + 全量套件在合并后 head 零失败（968.3s），共存实证。
3. **#5914 消融方法**：产品文件回退因 API 互锁编译红不可用（edit.go/strict.go 为新增、setter 文件与 provider.go 互锁）——改用根因消融：providersMu 的 lock Path 旁路（API 全保、保护失效）→ 两拒绝边界测试行为红。run5/6/7 三轮复现同形态。
4. **预存红对照**：TestMothX（agent）/TestHostToldTheGatewayAddress（plugin）/TestResolveVia（provider）均以净 TIP worktree 单跑同红归因，非本车道引入。

## 事故与判例

1. **mech.sh 批量循环瞬时故障**：单跑正常、for 循环批跑出现 HEAD==TIP 零提交静默态（rebase 报成功但零提交重放）——加 pipefail+零提交守卫后捕获两次，改为逐单单跑后零再犯。教训：批处理脚本必须带产物数量守卫，禁裸循环。
2. **后台任务互踩（5197 证据污染）**：两个后台 gateway 套件共用同一 worktree+同一日志路径，并发 checkout 互踩，worktree 停在过期 head、日志来源不可信——5197 证据全部作废重建（独占 worktree+唯一日志名）。教训：同一 worktree 永远只允许一个后台任务；日志名必须含任务唯一 id。
3. **gh api -f body=@file 不读文件**：4144 首帖发出 31 字符壳帖——`-f` 是字面量，`-F` 才支持 @file；PATCH 修复后 GET 复核。教训：发帖统一 `-F body=@file` 并回读长度。
4. **zsh $VAR:r 修饰符吞冒号**：push refspec `"$NEW:refs/..."` 被解析成 `$NEW:r`+`efs/...` 报 src refspec 错——改 `${NEW}:refs/...`。教训：refspec 一律 brace 形式。
5. **rm -rf 误删 tracked docs（已即时恢复）**：清理误建在主 clone 的 docs/issues 时 `rm -rf docs` 连带删了仓库 tracked docs/ 23 文件——`git checkout -- docs/` 全数恢复，工作树净。教训：repo 工作树内清目录前必须 `git status`/`git ls-files` 核对 tracked 状态，禁裸 rm -rf 目录。
6. **5914 patch sha 随 base 移动变化**（a95df363→24fdc3a5→839ffcc3→86f06740）：上游 i18n 等加行使 hunk 偏移移动、patch 文本变而语义零混入（range-diff `=` + i18n.js diff 仅含我方行人工核）——sha16 是 per-base 的，帖内 sha 只对当帖引用的 base 成立。

## 未跑项 / 承接

- 4785/5205：Windows-only 行为，本机消融不可见（如实记录），红证据=帖内真机记录。
- 各单 Not verified 原样承接（帖内注明 unchanged from the post above）。
- provider 全量在 925bc7188b 基以 run6（27e43ed26 基）+子树字节同一性（git diff 空）+run7 race/消融/tui 重跑合成覆盖（上游该区间增量不触 provider 及其依赖）。
- 5197 全量套件引用 925bc7188b 基 run7（968.3s 零失败），8ed2ae030c 增量（claudetui + claude_subscription/ir）不触本单文件/测试，帖内已明示。

产物：本目录 RB-<单号>/（上轮末帖存档+本轮帖稿+patch 文件）+ RB-STATE.md（全程日志）+ /tmp/mg-RB-audit1/（套件日志、消融逐字红输出、rebase/am 日志）。

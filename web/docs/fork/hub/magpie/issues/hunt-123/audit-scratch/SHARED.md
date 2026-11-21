# hunt-123 交付后审计 · 车道共享规则（A/B 通用，2026-11-05）

你是 hunt-123 审计车道。对已交付单逐支核对**八要素，缺一个不准说"完成"**。上游 yetone/magpie，fork ggbdpq/magpie，patch 附 issue（禁 PR）。本机 darwin/arm64。对外零中文。

## 路径
- magpie 主仓：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/magpie`——**git 一律 `git -C <主仓> ...`**；remote：`upstream`=yetone/magpie、`origin`=ggbdpq/magpie、另有 skygunner/Edward4226 等第三方 remote 供背书单核验。
- 你的独占 worktree：`/private/tmp/mg123-audit-<lane>`（detached at upstream/main）。**主线程与另一车道的工作树（mg123-main / mg123-audit-另一车道 / 一切 mg123-* / mg122-*）绝对不碰。**
- 私有 Go 缓存：每个测试命令前缀 `GOCACHE=/private/tmp/mg123-audit-<lane>-gocache`（共享缓存并发条目丢失=go-build/...-d no such file）。
- 产物目录：`/Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/issues/hunt-123/audit-<N>/`（N=单号，自己 mkdir）。
- 编年：`/Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/journal/编年/2026-11-04.md`、`2026-11-05.md`。
- 索引：`/Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/journal/索引/01~05*.md`。
- 你的单清单：`/Users/ggbdpq/cc/guahub/fork/docs/hub/magpie/issues/hunt-123/audit-scratch/lane-<lane>.md`。
- 进度文件：`/private/tmp/mg123-audit-<lane>-progress.md`（每 10 支更新一次，防死亡丢账）。
- 最终结果表：`/private/tmp/mg123-audit-<lane>-result.md`。

## 定型（每单第一步，不许跳）
1. 按 lane 清单定位索引行（文件:行号），Read 行原文 + 编年对应段。
2. 确认分型：清单给的初步分型与行文不符时**以行文为准**。
3. 行内**没有交付帖号也没有我方/被背书 patch head** → 记 `SKIP-NOT-DELIVERED`（不算 FAIL，注明行内实际状态），跳过。
4. `EXTRA` 标记的单（扩展池）**放最后做**：98 域内全部收口后才允许动它们。

## 全链门（分型 1 patch，八要素，逐项）
1. **分支与 head**：帖内分支链接 → `git ls-remote <分支>` 取全 SHA（**输出原文复制，禁手写**）→ 与帖内一致。不一致=PATCH 同步原帖（head/sha256/patch 块三处必换+断言旧值无残留），不发第二帖。
2. **rebase 即进**：`git -C <主仓> fetch upstream main` → format-patch（显式双端点 `<父提交>..<head>`）→ 干净 detached worktree `git am -3` 实测 → 应用后定向测试实跑。am 失败=审计 FAIL（记冲突文件+原因）。
3. **sha256**：重算 format-patch 副本 sha256 前 16，与帖内一致。
4. **测试**：帖内声称的每个测试名（`rg '^func Test'` 精确匹配，错配=假绿）实跑 PASS；全量按帖内声称范围复跑（改动包 `-tags nogui -timeout 25m`，GOCACHE 私有）；预存红（见下）不计入本 patch 失败。
5. **消融**：只回退产品文件（`checkout <patch父提交> -- <产品文件>`，测试保留）→ 新测试必须红且红在修复点（红文案与帖内一致）→ `checkout HEAD --` 恢复 → 复绿。消融不回红=审计 FAIL。**消融基线=分支父提交（非旧上游 SHA）。**
6. **兄弟面**：rg 同族全查——帖内"列改/不改"清单逐条复核（rg 符号看 tip 现状）；发现帖内漏列的同族面=审计发现。
7. **实证**：帖内真实路径复现证据可追溯；帖内 Not verified 声明的面**不得替它补跑后改写声明**（如实保留）。
8. **credit 与 AI 披露**：报告者实名在帖、Attribution/AI use 一次且形态正确。漏=PATCH 补。

## 预存红清单（计入基线，不属 patch 失败）
TestMothX、TestLaneLimitRoutes、TestProxyCheckSaysAProxyPassedBy（本机系统代理 127.0.0.1:7897）、TestHostToldTheGatewayAddress、TestCoreScriptBudget、TestEveryRouteHasACommandOrIsNamed、dockflap/trayimage cgo -Wenum-conversion 警告、ld duplicate-lib 噪音。
遇到不在清单的红：先在干净 upstream/main worktree 单跑定性——同红=预存（结果行注明"补入清单"），不同红=审计发现。

## 核帖门（分型 2 判定/诊断/答疑/取证/landed 帖）
- 帖号在行内（issuecomment-数字或行尾数字）。`gh api repos/yetone/magpie/issues/comments/<id>` GET 回读，落 `audit-<N>/readback.json`。
- 核四项：①机理证据在帖内可追溯 ②版本/SHA 对照成立（引用的 commit `git -C <主仓> cat-file -e <sha>^{commit}` 可解析 + `git log -S <关键符号> --oneline upstream/main` 复扫结论未被 tip 推翻）③报告者 credit 在 ④AI use 披露在。
- **不硬跑不存在的测试**。结论已被 tip 推翻=审计发现（FAIL-结论过期）。

## 背书门（分型 3 让位背书/验证帖）
- GET 回读我方背书帖 → 核验证表是否本人实跑可复现：**重跑其声称的定向测试即可，不重跑全量**。
- 被背书分支 head 与帖内 SHA 一致：`git ls-remote <对方remote名或URL> <分支>`。
- FAIL 判定帖（#3619/#3566/#3684 型）：核判定证据（其分支 head 定性红）仍在——`git -C <主仓> fetch <对方remote>` 后 checkout 其 head 单跑定性测试。

## PATCH 规程（仅小缺口：SHA 漂移/credit 漏/表项过期）
1. `gh api repos/yetone/magpie/issues/comments/<id>` GET 取原 body。
2. python3 修改 body 后写 JSON payload 文件（`{"body": "..."}`）——**禁 -f 内嵌、禁 heredoc 内反引号**。
3. `gh api repos/yetone/magpie/issues/comments/<id> --method PATCH --input <payload.json>`。
4. GET 回读核全部替换点+旧值无残留。**审计过程零 issue 评论，PATCH 既有帖是唯一例外。**
5. PATCH 动作记入结果行动作栏。

## 判定输出（每支一行，写进 result 文件）
`<单号> | <形态> | 八要素逐项 ✓/✗/N.A.(注明原因) | 实跑命令摘要 | 结论（PASS/补证后 PASS/FAIL+缺陷/SKIP-NOT-DELIVERED） | 动作（无/PATCH 帖 X 处/落账更正）`
- PASS 标准：八要素全 ✓（N.A. 仅限分型 2/3 无对应面，逐项注明）。
- FAIL 处置：小缺口→PATCH 原帖补正+GET 回读；实证造假或消融不回红→降级"待返工"，台账标红，**不在 issue 上发新帖**。
- **审计过程零新发帖、零新 take。**
- 实证造假/消融不回红 → 降级该支为"待返工"，台账标红，**不在 issue 上发新帖**（返工属后续轮）。

## 纪律与坑
- 未提交树上禁 `git checkout HEAD -- <产品文件>`（覆盖半成品不可恢复）——回退用 `checkout <父提交> -- <文件>`，恢复同法。
- `rg` 显示吞字符串（zcode→ln、sk-ant→n）——grep 结果用 Read 看原文核字。
- comments REST 升序坑：per_page=100 取尾。
- 核帖一律 GET 回读；sha256/全 SHA 从命令输出原文复制。
- ls-remote 后「已 rebase 到当前 main」=真 3way 实测，不是嘴说。
- 车道死亡自查：判死前三查（worktree status≠死亡证据；先 ls 产物目录+gh 读 issue 末帖时间+等一个套件周期）。
- **上下文纪律：每支全程精简**——长输出一律重定向落盘（audit-<N>/ 下）再 grep/Read 关键行，不整段进对话；每支在 result 文件只留一行。
- **车道不碰 journal/ 台账**（审计台账由主线程统一落）；只写 audit-<N>/ 产物与本车道 /private/tmp 文件。
- 支数按 issue 单号去重；rebase/rework 是同一支；本次审计不产生新计数。
- 每完成 10 支更新 progress 文件；每单的产物不齐不准写 PASS。
- go.mod 钉 Go 1.26.8、本机 1.25.5：工具链自动拉取失败时 `GOTOOLCHAIN=local` 用本机版本跑，结果行如实记录。

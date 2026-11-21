# hunt-123 审计返工 · 车道规则（rework a/b 通用）

返工来源：审计轮 FAIL 2（`journal/audit-2026-11-05.md`）。**只 PATCH 既有帖，禁止发任何新帖/新 take/issue 评论。**

## 路径（与 SHARED.md 一致）
- magpie 主仓：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/magpie`（git 一律 `git -C`；upstream=yetone，origin=ggbdpq）
- 你的 worktree：`/private/tmp/mg123-rework-<lane>`（detached @upstream/main 4164edce6）——**只碰自己这棵树**
- 私有缓存：`GOCACHE=/private/tmp/mg123-rework-<lane>-gocache`
- 审计共享规则：同目录 `SHARED.md` 的 PATCH 规程、预存红清单、操作坑**全部适用**
- 产物落：`docs/hub/magpie/issues/hunt-123/audit-<N>/rework/`
- 结果行追加：`/private/tmp/mg123-rework-<lane>-result.md`

## 通用门（返工=同支 rework，不产生新计数）
1. `git -C <主仓> fetch upstream main && fetch origin <分支>`——开工先看 upstream 是否又前进，重基线。
2. 分支 rebase 到 upstream/main（rework-a 用 rebase；rework-b 在分支上修测试后 rebase）——**机械冲突解保留双方语义**（tip 新落代码与补丁同区域时两块并存，禁删对方新逻辑）。
3. 验证矩阵：am -3 干净 detached 树实测 + 帖内声称的全部测试名实跑 + 改动包全量 `-tags nogui -timeout 25m` + 消融回红（基线=分支父提交）→ 恢复 → 复绿。**预存红不计入**（SHARED.md 清单+TestPluginCheckinAsksAgainAtUntil/TestSignInDoneOnceTheAccountIsBack）。
4. sha256 重算：format-patch 按**帖内声称的生成方式**（范围/单提交、p 序号）——#5021 判例：方式不同字节必不符。
5. PATCH 原帖三处必换（head/sha256/patch 块）+验证表更新+待返工注记移除；python3 组 JSON payload 文件 `gh api --method PATCH --input`；GET 回读断言旧值零残留。
6. 长输出重定向产物目录再 grep 关键行；每支一行结果。

## rework-a：#3967（帖 6618749896）
- 分支 `origin/fix/3967-billing-200` @`05b7fb9d9`（父 `667317159`）。审计实测：am -3 到新 tip CONFLICT×2（`internal/gateway/fallback.go` + `internal/gateway/`主文件；tip 新落 #4855 namedStatus/failedNamed 与 usageReported 修复同区域）。
- 任务：rebase 到 upstream/main 解冲突（保 #4855 新语义 + 我方 settle/translate 尾/流式记账三缝 usageReported 门）→ gateway 全量绿（~600s+，solo 跑勿并行重测试）+ 消融回红（settle 缝摘 saidUsage 门→never-reported 全零块穿）→ am -3 干净树复测 → sha256 重算 → PATCH 帖 6618749896（head/base/sha256/patch 块+验证表更新+注记"rebased to current main after audit"）→ GET 回读。
- 帖内 Not verified 声明如实保留；credit（Gaudi-XIX + aron-intframe harness）不动。
- 注意：审计发现该 patch 曾有"续作车道抓到真回归"（settle 缝打穿豁免）历史——解冲突后必须重跑全量防回归复发。

## rework-b：#5103（帖 6627934214 + 6627961774 双帖）
- 分支 `origin/fix/5103-provider-icon` @`724edc87d`。审计归因：新测 `TestPluginSaidIconName` 单跑绿 / provider 全包红×3（TempDir 清理与泄漏 keeper 续期循环互踩；`-skip` 新测全包绿+零 orcaterm；干净 tip 全包绿）。
- 任务：诊断测试隔离缺口（读 provider 包 keeper 续期循环与新测的 TempDir/全局状态交互；先 `go test ./internal/provider/ -count=3` 复现全包红再动手）→ **最小修**（ponytail：优先测试侧隔离——t.Cleanup 顺序/停 keeper/独立 t.TempDir 子目录，能不动产品代码就不动；若根因确在产品侧泄漏 keeper，则最小修产品并在帖内披露）→ 修复后 **provider 全包连跑 ≥3 次全绿**（隔离修复的验收线）+ 定向绿 + 消融回红复验 → rebase upstream/main → am -3 → sha256 重算 → PATCH 双帖（head/sha256/patch 块+验证表补"full package ×3 green"+移除待返工注记）→ GET 回读旧值零残留。
- 帖内 credit（Jirentian 等）与 Not verified 如实保留。

## 结束条件
完成（PATCH 同步+回读核验+结果行）或不可恢复死亡。返回：结果行+PATCH 帖号+新 head/sha256+验证摘要（不贴完整日志）。

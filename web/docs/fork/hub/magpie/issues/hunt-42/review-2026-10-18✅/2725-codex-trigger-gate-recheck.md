# #2725 复查报告（rev/a-gw 路，2026-10-18）

审计基线：worktree `/private/tmp/magpie-rev-a-gw` @ upstream/main `d783df46cbac`（= 任务给的 d783df46，fetch 后无前进）。我方 review-fix 分支 `hunt39-b2-gw-trigger-gate` @ `37040572`（基 `89521b03`）。

## ① 现状复核：前提仍在

**时间线（UTC，均从 gh api 现场拉取）**：bf931f82（#2642+#2582 合并修）10-17 10:19 合入 → 我方 #2725 issue 11:25（正文已按 bf931f82 后状态写，引 `planned.unlisted` 只救 writer 不救 carrier）→ 维护者 12:38 否决 v1（`0bde98cc`），给出 route (a)/(b) → 我方 13:29 发 review-fix（route a 直译）→ **此后无维护者回合**。

**bf931f82 没有覆盖 trigger-keeper**：它合入的是 #2582（codex 自家模型按 toggle 决定）、writer 从 `planned.unlisted` 找回（还移植了我方旧 writer 侧修复 0ab41eba0/e1646488d）、`codexSealedFor`、`checkpointError` 措辞。当前 main 的 `nativeCompactionFor`（native_compaction.go:96）仍是 provider 级判定，无 `planCarries`/`planCarriesGroup`；`compactionCarriers`（:341）仍是一行 `keepCandidates`；gateway.go:1986 的 `carrierError` 出口原样。

同题查重：`git log -E --grep '#2725' upstream/main` 零命中；`gh pr list --search 2725` 空。

## ② 我方交付与 ③ RED 复核（消融，全新跑在 d783df46 上）

分支对 d783df46 **不能干净落**：`git cherry-pick --no-commit 37040572` 在 docs/subsystems/gateway-routing.md 与 native_compaction_test.go 冲突（45b8c725 #2727 同晚改了同一 bullet 和测试文件尾）。手工重放（不 commit）：

1. `git diff 89521b03 37040572 -- internal/gateway/native_compaction.go | git apply` → 干净。
2. 测试块（纯尾部追加 101 行）追加到当前文件尾。
3. docs 的 planCarries 句子用 python 精确插入当前 bullet 同一锚点（"answers a 400 saying so." 之后）。

**BASELINE（带修复）**：
```
$ GOTOOLCHAIN=auto go test -tags nogui -count=1 -timeout 300s -run 'TestNativeCompactionTriggerSummarisedWhenNoListedKeyCarriesIt|TestNativeCompactionTriggerThroughTheListedKeyThatCarriesIt' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	1.123s   # EXIT=0
$ GOTOOLCHAIN=auto go test -tags nogui -count=3 -race -timeout 300s -run '...同两测试...' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	2.236s   # EXIT=0
```
**ABLATION（只 `git checkout HEAD -- internal/gateway/native_compaction.go`，测试保留）**：
```
--- FAIL: TestNativeCompactionTriggerSummarisedWhenNoListedKeyCarriesIt (0.12s)
    native_compaction_test.go:849: 400, the relay asked 0 times: {"error":{..."none of the keys or accounts that serve fake/m1 now can be asked it on the Responses API..."...}}
```
（保护性测试 ThroughTheListedKeyThatCarriesIt 拆产品文件后仍绿，未列出；gofmt -l 空。）

rebase 后的完整 diff 已存：`2725-rebased-onto-d783df46.patch`（175 行，apply 后 worktree 已 reset 干净）。

## ④ 对抗攻击

- **前提强度**：constructed、无用户报告——但维护者 12:38 明说 "The 400 is a dead end, I agree"，且 route (a) 是他提出的修法；(a) 下 fake-upstream 异议消失（不发往 unlisted key）。测试断言 200+哪个 key 被问+summary 内容，行为级。
- **热路径**：`planCarries` 被 `compactsNatively` 短路，只有用户显式开 native compaction 的 provider 才跑 plan 构建；codex 自家模型路径（codex_backend.go:211）Resolve 失败即 false，零代价。组路径 planCarriesGroup 前置逐成员 `compactsNatively` 短路。代价可控但未 profile。
- **默认不覆盖自设值（10-18 新规）**：gate 只在用户显式 `compaction=native` 时改变行为，且改变的语义正是维护者 route (a) 的原文（"so it goes to magpie's summary through kchat"），gateway-routing.md 有对应句子。
- **兄弟路径**：`nativeCompactionFor` 两调用点（handle/codexBackend）经函数内 gate 全覆盖；`keepsCompaction`/`checkpointReaders`（writer 证据）不动；`carrierError` 保留给 gate 看不见的形状（请求被钉到 sealer、名单中途变化）。
- **维护者验收口径**：他点名要的 "a test on the case where a listed key does carry it as well" 已在（protective 测试，拆产品文件前后均绿）。

## ⑥ Verdict：IMPROVE

review-fix 内容站得住（route a 直译+他要的 protective 测试），但**分支必须 rebase 才能合**（与 45b8c725 撞 2 文件）。**下一步最小动作**：基于 `d783df46` 用 `2725-rebased-onto-d783df46.patch` 重建分支（提交头沿用 37040572 的 message），force-push `hunt39-b2-gw-trigger-gate`，然后发下方英文稿。无需改产品逻辑。

## 不自信清单

1. rebase 是我在 worktree 手工解析，未走真实 `git rebase`；patch 文件是解析结果，用户重建提交时如行序不同以内容为准。
2. rebase 树上只跑了两个目标测试+race×3+gofmt，未跑全 gateway 套件（纪律禁全量；分支历史声称 89521b03 上 `-p 2` 全绿，但严格说那是旧树）。
3. `planCarries` 的 plan 构建代价（组大+native on 的后端请求）未 profile，只论证了短路。
4. 真实多 key 中转依旧没有；unlisted 形状仍是从 `perKeyBarred`/`WithKey` 读出的构造。
5. route (a) vs (b) 最终是维护者口味；(a) 已按他提议实现，仍可能被改选 (b)。

## 英文稿（rebase 后发）

```markdown
Rebased onto current `main` (`d783df46`): #2727's test and routing-doc
changes landed under it the same evening, so the branch as posted no
longer applies. No code change — it is the same route-(a) gate, with
your requested protective test, at the new head <推送后填新 SHA>.

Re-verified on `d783df46` today:

- `TestNativeCompactionTriggerSummarisedWhenNoListedKeyCarriesIt`, with
  `internal/gateway/native_compaction.go` reverted to main and the test
  kept: red — 400 carrierError, the relay asked 0 times. `bf931f82`
  took the writer back from `planned.unlisted` and settled the toggle
  for Codex's own models; the trigger-keeper still judges at the
  provider level, so the dead end stands.
- With the fix: green — 200, magpie's summary through the listed chat
  key, the key whose list lacks the model never asked.
- `TestNativeCompactionTriggerThroughTheListedKeyThatCarriesIt`: green
  before and after, as you asked.
- Both tests, `-race -count=3`: ok. `gofmt -l` clean; `go vet -tags
  nogui` clean.

Branch: [ggbdpq/magpie `hunt39-b2-gw-trigger-gate`](<推送后链接>) (head
<SHA>, on `d783df46`).
```

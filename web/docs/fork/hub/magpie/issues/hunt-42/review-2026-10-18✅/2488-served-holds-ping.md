# #2488 复查报告 — 整窗美元合计不认回复里点名的模型（B 路 usage/计价）

复查日期：2026-10-18。审计基线：upstream/main `d783df46cbac9021e26a6bd71ca0b55544552eb2`（2026-10-18 07:13 +0800，比 10-17 复验所用的 `e085d6e9` 更新一天）。worktree `/private/tmp/magpie-rev-b-usage`。

## verdict：PUSH

材料站得住：缺陷在最新 main 仍在，patch 干净落上，消融在最新 main 上断言级回红，语义方向与维护者已合入的 #1498/#2344 家族规则一致，无维护者动区冲突。下一步最小动作：在 issue 下发一条英文 ping（引用本日 `d783df46` 复验与消融红），不求新改动。

## 现状复核（步骤①）

- 缺陷仍在：`internal/usage/window_holds.go` 的 `apiPricer()`（约 :301）仍是双键缓存 `[2]string{Provider, Model}`，链为 MakerPrice → provider.ListPrice → SamePriceIn(#2344)，**无 `Record.Served` 回退**；一次 `priceOf` 返回 nil 即整窗 `Priced=false`，美元合计丢弃（逐字读过当前源码确认）。
- 维护者 10-14 以来对该区域的提交（`git log --since=2026-10-14 -- internal/usage/window_holds.go internal/usage/ledger.go`）：`2c72563d`(#2521，ledger/request_page)、`7170b5d8`(#2512，plan credits 汇总，不触及 window_holds.go)、`357ffac7`(#2344 Same as 计价，10-15)。**无一触及 `window_holds.go` 里的 apiPricer 主体**；#2344 在 patch 基 `a15e5765` 内（`git merge-base --is-ancestor` 验证），patch 建立在最新计价语义之上。
- 同题未解：`git log -E --grep '#2488' upstream/main` 无命中；`gh pr list --state all --search 2488` 相关 PR 无。

## 我方交付（步骤②）

- fork 分支 `origin/hunt31-d-served-holds` head = `a99f582a6a0bdba344182deae6c293362828042b`（2026-10-16），父 `a15e5765`，与 issue 正文声明完全一致。
- diff（`git diff a15e5765 a99f582a`）：`window_holds.go` apiPricer 三键化 + Served 回退（与 ledger `Pricer()` 同构，见 `internal/usage/ledger.go:515-548`：OwnCost 哨兵 → 三键缓存 → Served 回退）；`window_holds_test.go` 新增 `TestHoldsPriceTheModelTheReplyNamed`；`providers-accounts.md` 补一句语义说明。评论描述与 diff 一致。

## RED 复核（步骤③，消融，在 d783df46 上）

| 检查 | 命令 | 结果 | exit |
| --- | --- | --- | --- |
| BASELINE 干净落 patch | `git diff a15e5765 a99f582a > /tmp/rev-b-2488.patch && git apply` | 3 files changed, 64 insertions(+), 16 deletions(-)，干净应用 | 0 |
| 修后新测试 | `GOTOOLCHAIN=auto go test -tags nogui -count=1 -p 2 -run TestHoldsPriceTheModelTheReplyNamed ./internal/usage/` | `ok github.com/yetone/magpie/internal/usage 1.746s` | 0 |
| ABLATION 手拆产品文件（`git checkout upstream/main -- internal/usage/window_holds.go`，保留测试） | 同上命令 | `--- FAIL: TestHoldsPriceTheModelTheReplyNamed (0.09s)` / `window_holds_test.go:401: the model the reply named wasn't its API price: <nil>` / `FAIL` | 测试 FAIL |
| 恢复修复文件后 usage 全包 | `go test -tags nogui -count=1 -p 2 ./internal/usage/` | `ok ... 10.780s` | 0 |
| gofmt（两文件） | `gofmt -l` | 无输出 | 0 |
| vet | `go vet -tags nogui ./internal/usage/` | 无输出 | 0 |

消融失败句与 10-17 评论（issuecomment-6229538049）逐字一致，且基线更新到 `d783df46`。

## 对抗攻击（步骤④）与防御

1. **是否撞维护者"声明过的设计"**：不撞。整窗计价的既有裁决是"只按 API 目录价，绝不进用户自设价/倍率"（`de3b1c64` 起源、apiPricer 注释明写）；`e10b7f92`(#2010) 的裁决是"可能由 credits 支付的窗不显示 whole"——本 patch 不碰这两条：仍只取目录价，只是把"回复点名了有目录价的模型"从 unpriced 改为按被点名模型计价。ledger 侧同语义 #1498 已由维护者合入（`34a6576c`，社区作者 liuweifeng），#2344 Same as 同家族 10-15 刚合入——这是维护者认可的家族规则，patch 是把它补齐到整窗，不是反转设计。
2. **热路径**（LESSONS 10-18 b14784c03 条）：`WithWindowHolds` 调用点为 `/api/usage/quotas` 读写 handler 与 `magpie quota --json`（`internal/gui/usage.go:192,214`、`provider.ReckonHolds`），是页面读取路径，本就整日志扫描；价格查询按三键 memoize，每键至多两次 `one()`，`settings.Load()` 每次调用一次。不在 15s Sessions 轮询上。无违规。
3. **默认不覆盖用户自设值**（code-standards 10-18 新规）：patch 的回退只查目录价（MakerPrice/ListPrice/SamePriceIn），不读用户为订阅设的价格/倍率——比 ledger 的 `EffectivePriceIn` 更保守，读取点清单：`window_holds.go` 内仅 settings.Load() 供 SamePriceIn 用。无覆盖面。
4. **兄弟路径**：`window_holds_history.go:74`（过去周期）用同一 `apiPricer`，patch 一并生效（issue 已声明）。**登记不修的新发现**：ledger `Pricer()` 有 OwnCost 哨兵（`ledger.go:525`，报告过自身成本的调用算 priced），`apiPricer` 没有——一条 `OwnCost != nil` 且模型无目录价的调用同样会把整窗打成 unpriced。这是与 #2488 同症状的另一条路径，属于维护者的语义决定（整窗 whole 是否认"客户端自报的成本"），不在本单范围内，只登记。
5. **测试是否只测实现**：`TestHoldsPriceTheModelTheReplyNamed` 断言三层公开行为——被点名模型得到其 API 价、本名无价不被凭空计价、自有价模型保持原价——再加端到端窗口 whole 断言（`WithWindowHolds` 后 `Holds.Priced/Cost`）。目录价硬编码（gpt-5.5 input 1.25、claude-opus-4-7 input 5）与紧邻的既有测试 `TestHoldsPriceTheModelItIsTheSameAs`（同样断言 1.25）同款，是房规而非新弱点；models.dev 调价时两个测试会一起红，属既有脆弱性。

## 收益三句话（步骤⑤）

用中转把目录里没有的模型 id（如 `moonshot-kimi-k3`）卖出有目录价的模型（如 `gpt-5.5`）的用户，在 Usage 页的订阅卡窗口上能看到美元整窗估算，而不是因为一次这样的调用整个窗的美元合计消失。token 合计与过去周期同样受益。维护者已合入的 ledger 侧行为由此在整窗侧保持一致。

## 不自信清单

- 未跑 `go test ./...`、GUI、跨平台 build/vet（纪律 2 限时；patch 声明的 windows/linux vet/build 结果来自历史提交，未复跑）。
- 测试断言依赖 models.dev 当前目录价（1.25/5），models.dev 调价会连红两个既有风格相同的测试——房规脆弱性，非本 patch 引入。
- OwnCost 兄弟路径（见对抗 4）未验证是否真实可触发（需要一条 OwnCost 报告且模型完全无目录价的订阅窗记录），只是代码路径推演。
- "维护者无回合"是否等于默认认可未可知；ping 后仍可能被以"整窗 whole 应保持纯目录价"为由打回，但 #1498/#2344 的合入历史使这一步概率低。

## 英文 ping 稿（可直接发）

```markdown
Gentle ping — still standing after another day of main. Re-verified on `d783df46` (10-18): the patch applies cleanly, `TestHoldsPriceTheModelTheReplyNamed` passes with the fix, and hand-reverting `window_holds.go` alone brings it back red with the same assertion (`the model the reply named wasn't its API price: <nil>`). The ledger has priced such calls by the model the reply named since #1498, and Same as joined that family in #2344 — this only carries the same rule to the window's dollar whole, still never a price the user set. Happy to rebase if anything around it moved.
```

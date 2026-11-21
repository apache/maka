# #2199 复查报告 — Bedrock 新四厂商按本名回答被误标 swapped（B 路 usage/计价）

复查日期：2026-10-18。审计基线：upstream/main `d783df46cbac9021e26a6bd71ca0b55544552eb2`（2026-10-18 07:13 +0800）。worktree `/private/tmp/magpie-rev-b-usage`。

## verdict：PUSH

主打的牌是同族先例与家族规则，全部核验成立：#1484（`012be0fc`，10-10）是维护者**已合入并以 `(#1484, ggbdpq)` 署名**的同概念修法；"厂商目录增长、vendorDot 名单漂移"在最新 main 上原样持续；models.dev 目录今日（10-18）四厂商 id 不减反增。下一步最小动作：英文 ping，引用 10-18 复验与目录现况。

## 现状复核（步骤①）

- 缺陷仍在：`internal/usage/served.go:26` 的 `vendorDot` 与 issue 引用**逐字一致**，`xai`/`writer`/`moonshot`/`nvidia` 均不在交替里（`moonshotai` 在而 `moonshot` 不在）。逐字读过当前源码。
- 维护者 10-14 以来对 `internal/usage/served.go` 零提交（`git log --since=2026-10-14 -- internal/usage/served.go` 空）；`git log -E --grep '#2199' upstream/main` 无命中；无相关 PR。
- 目录现况（2026-10-18 `curl https://models.dev/api.json`，`amazon-bedrock` 199 个模型）：
  - xai：`global.xai.grok-4.7`、`us.xai.grok-4.6`、`us.xai.grok-4.7`、`xai.grok-4.3` 等
  - writer：`us.writer.palmyra-x5-v1:0`、`writer.palmyra-x4-v1:0` 等
  - moonshot：`moonshot.kimi-k2-thinking` **与** `moonshotai.kimi-k2.5`、`global.moonshotai.kimi-k3` 并存——证实"两前缀并存、名单只认其一"
  - nvidia：`nvidia.nemotron-nano-12b-v2`、`nvidia.nemotron-super-3-120b` 等（比 10-14 又多了新 id，漂移在扩大）

## 我方交付（步骤②）

- fork 分支 `origin/take-b2-bedrock-vendor-dot` 现 head `9a5ce8c6`（2026-10-17 10:54 rebase 到 `ebf3f48f`），**内容与 issue 正文所附 `146c60c2`（基 `4e9335c9`）的 served.go diff 逐字一致**（`diff` 两版 patch 输出为空）；`ebf3f48f`→`d783df46` 间两触及文件零变化，分支即最新。
- diff：`vendorDot` 交替补 `moonshot`（置于 `moonshotai` 之后，最左优先下 `moonshotai.kimi-k3` 仍整段剥）、`nvidia|writer|xai`；注释说明四厂商来源；测试加 6 行 no-swap 断言 + 2 行 still-a-swap 守卫（`global.xai.grok-4.7`→`grok-4.6`、`us.writer.palmyra-x5-v1:0`→`palmyra-x4` 保持 true）。

## RED 复核（步骤③，消融，在 d783df46 上）

| 检查 | 命令 | 结果 | exit |
| --- | --- | --- | --- |
| BASELINE 落 patch | `git diff ebf3f48f 9a5ce8c6 > /tmp/rev-b-2199.patch && git apply` | 2 files changed, 16 insertions(+), 2 deletions(-) | 0 |
| 修后目标测试 | `go test -tags nogui -count=1 -p 2 -run TestBedrockProfileAnsweredByItsModelIsNoSwap ./internal/gateway/` | `ok ... 1.170s` | 0 |
| ABLATION 手拆 served.go（`git checkout upstream/main -- internal/usage/served.go`，保留测试） | 同上 | 六行逐字复现 issue 输出：`Swapped("global.xai.grok-4.7", "grok-4.7") = true, want false` 等 6 条，FAIL | 测试 FAIL |
| 恢复后 gateway 定向子集 | `-run 'Bedrock|Swapped|Served|RelayRenamed|Rename'` | `ok ... 1.478s` | 0 |
| 恢复后 usage 全包 | `go test -tags nogui -count=1 -p 2 ./internal/usage/` | `ok ... 11.243s` | 0 |
| gofmt（两文件）/ vet（两包 nogui） | `gofmt -l` / `go vet -tags nogui` | 无输出 | 0 |

消融机制说明：旧正则对 `us.xai.grok-4.6`（region `us.` 后跟的 `xai.` 不在名单）与 `xai.grok-4.6`（`xai` 可当 region 但其后 `grok` 不是 maker，整体不剥）两侧都剥不掉，sent 侧残留 `us.` 前缀，bare id 不相等即 swapped；patch 后两侧同剥为 `grok-4.6`。

## 对抗攻击（步骤④）

1. **是否撞已裁决口径**：不撞，反而是家族规则的直接受益者。#1484 的修法形态（vendorDot 补名单 + 复现测试 + still-a-swap 守卫）与 patch 完全同构，且维护者合入时在提交主题里署名 `(#1484, ggbdpq)`——"识别名单漂移需同步"是维护者用合并行为背书的规则。
2. **兄弟路径**（rg 全查，记录改/不改清单）：
   - `vendorDot` 唯一使用点 `served.go:45`（bareModel）——patch 已改。
   - `RelayRenamed`/`ServingName`/`GrokServing`/`GeminiServing`（served.go）：名字形状判定，无厂商名单——不改，正确。
   - `internal/provider/grouptemplate.go:196` 另有一套 `bareModel`：按 `/` 剥路由前缀（`openai/gpt-6-luna`→`gpt-6-luna`），无名单，概念不同——不改，正确。
3. **venderDot 剥离外溢**：patch 后对**所有** provider 生效（bareModel 不分家）。非 Bedrock 供应商若真有以 `nvidia.`/`xai.`/`writer.`/`moonshot.` 为名前缀的模型 id，前缀会被剥——后果与 #1498 的 relay 前缀改名语义一致（同 bare id = SameSpelled 家族 = 不算偷换），风险低，与 #1484 已合入的先例同性质（既有名单本就如此作用于全部 provider）。
4. **为何不从 catalog 动态推导厂商名单**（维护者可能的追问）：vendorDot 是编译期正则，catalog 是运行时下载（models.dev）；推导是更大的改动，超出本单目标；#1484 维护者自己也是延续硬编码名单。patch 顺应既有修法形态。
5. **热路径**：`Swapped`/`bareModel` 在 usage 记录读取与行渲染时调用；正则只加 4 个交替分支，量级不变。无 LESSONS 违规。
6. **测试是否只测实现**：断言的是公开函数 `usage.Swapped` 的行为（6 行假阳性 + 2 行守卫），外层 `TestBedrockProfileAnsweredByItsModelIsNoSwap` 还有经 Bedrock 预设的 httptest 全链路（路由/tries/usage 行不标 swapped）。

## 收益三句话（步骤⑤）

在 Bedrock 预设里手工填入新厂商模型 id（xAI/Writer/Moonshot/NVIDIA 的 `地域.厂商.模型` 推理配置 id）的用户，只要上游按模型本名回答（#1484 定下的 Bedrock 行为），路由、各次尝试和 usage 行不再被误标 swapped——不再看见"厂商偷换了模型"的假警报；历史被误标的行经 SameSpelled 读回也为未偷换（与 #1484 相同）。

## 不自信清单

- 未对真实 Bedrock 账号的四厂商模型实测（无账号）；"按本名回答"前提沿用 #1484 的已合入口径，六对 sent/served id 取自 models.dev 今日实数据。
- 外溢（对抗 3）未找到现实反例，但不能排除某个非 Bedrock 供应商确有以这四前缀为真实 id 一部分的模型——与既有名单同风险，未单独验证。
- 分支 head `9a5ce8c6` 与 issue 正文格式补丁里的旧 head `146c60c2` 不一致（内容相同，10-17 rebase 过）——ping 稿里已说明，维护者点分支链接拿到的是新版。
- 未跑 `./...` 全量与跨平台 vet/build（纪律 2；历史提交声明过 windows/linux 干净）。

## 英文 ping 稿（可直接发）

```markdown
Gentle ping — the drift is still live and growing. Re-verified on `d783df46` (10-18): `vendorDot` is unchanged, and models.dev's bedrock list now carries the four makers across more ids than on 10-14 (`global.xai.grok-4.7`, `us.xai.grok-4.6`, `us.writer.palmyra-x5-v1:0`, `moonshot.kimi-k2-thinking` beside `moonshotai.kimi-k2.5`, `nvidia.nemotron-nano-12b-v2` and newer nemotrons). The branch is current (`9a5ce8c6`, rebased 10-17, same diff as posted): the six new rows fail on main's served.go with `Swapped(...) = true` exactly as listed, pass with the fix, and the two still-a-swap guards hold. Same family as #1484, which landed with this exact fix shape — happy to rebase if anything moved.
```

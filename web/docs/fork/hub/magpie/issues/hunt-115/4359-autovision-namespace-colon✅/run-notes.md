# 4359 AutoVision namespace colon — run notes（lane a12，2026-11-01）

## 单据
- issue: https://github.com/yetone/magpie/issues/4359（yuerfu 报，10-30，0 评论，无占坑 PR）
- take: https://github.com/yetone/magpie/issues/4359#issuecomment-6558238139
- 开工 upstream SHA: `9d08993c8bd40de5d002bc364a16be344c5d78fa`
- 分支: `fix/4359-autovision-namespace-colon`（worktree /tmp/mg115-a12-4359）
- 提交: `aa378a4f6`（fix(gateway): a model the user said sees is picked though its ID carries a namespace colon (#4359)，author ggbdpq）
- patch: `vision-4359.patch`，SHA-256 前 16 `be3ff69268bd1dd8`；git am 校验通过（scratch worktree，am 后 251284b823）

## 根因
`internal/gateway/search.go` `smallCands`：keep（`seesAt`，先读用户 `modelImages` 应答）通过后，`ContainsAny(l, ":~")` + 词表（nano/lite/image/audio/tts/embed/free）的形状过滤无条件 `continue`，把用户显式标记为 seeing 的 `cn:*` 模型丢掉 → 池空 → `seer()` 返回 ""。报告者措辞「dropped before seesAt runs」不精确：seesAt 先跑且返回 true，是随后的形状过滤把它盖掉。

## 修法
`smallCands` 循环外读一次 `settings.Shared()`；`provider.ImageOverrideIn(s, p.ID, m.ID)` 有应答（`said`）时跳过形状过滤（`:~` + 词表），结构性过滤（`group/`、`auto/`、账户合成 `/`）保持无条件。searcher 池（kind="search"）同享：同一判定，用户证明 ID 是真实厂商模型，两用皆可；relay 的 searchRank 未动。

## 缓存安全
`smallKept`（stamped）按 `provider.StampNow()` 重戳，roots 含 `settings.Path()`；settings.Save 移 stamp（TestAutoVisionSeesEachChange 已证），改动即时可读。

## RED/GREEN
- RED（修复前，基线 9d08993c8 + 新测试）：
  `--- FAIL: TestAutoVisionPicksANamespacedIDTheUserSaidSees ... small_kept_test.go:213: AutoVision = "", want relay/cn:deepseek-v4.1-flash, the model the user said sees`
- 消融：commit 后 `git checkout 9d08993c8 -- internal/gateway/search.go`（只回产品文件），测试保留，回红同上；恢复后绿。
- GREEN：定向 ok；全量见下。

## 验证矩阵（本机 5 车道，只跑定向+改动包）
| 检查 | 结果 |
| --- | --- |
| `go test -tags nogui -run TestAutoVisionPicksANamespacedIDTheUserSaidSees ./internal/gateway` | ok |
| `go test -tags nogui -count=1 ./internal/gateway`（全量） | ok 531.577s（EXIT=0；5 车道争用） |
| `gofmt -l internal/gateway/search.go internal/gateway/small_kept_test.go` | 无输出 |
| `go vet -tags nogui ./internal/gateway`（darwin） | 干净 |
| `GOOS=linux go vet -tags nogui ./internal/gateway` | 干净 |
| `GOOS=windows go vet ./internal/gateway` | 干净 |
| `go build -tags nogui ./...` darwin/linux/windows | 均 EXIT=0（pipefail 重跑取真实退出码；darwin 有 internal/gui 上游 cgo warning，非本单引入） |

## 兄弟面（改/不改理由）
1. `smallCands` 形状过滤（`:~`+词表）— 本单改。
2. 同函数结构性前缀过滤（group/auto/账户 `/`）— 不改：那是 magpie 自己的合成 ID（组引用、写进 agent 的复合名），不是厂商真实 ID 的形态；用户对整名模型的应答不能把组引用变成模型。
3. `catalog.textModel`/`draws` 词表 — 不改：models.dev 默认推断层，用户 `modelImages` 在 `entryFor`（provider/models.go:2945）下游覆盖它，无冲突。
4. `searchModel`/`DrawsID`（Code Assist 搜索资格）— 不改：判「生成图像」非「接受图像」，与用户 images 应答无关。
5. `blindTo`/`ServedEntryOf` — 已走 `entryFor` 应用 override，正确。
6. 命名 vision（`provider.Resolve("21/cn:…")`）— 报告者步骤 6 已证可用，路由层无冒号问题。

## 失败读取语义
settings 读失败 → `settings.Shared()` 回默认值 → `ImageOverrideIn` 无应答 → 形状过滤照旧（= 用户未答过的旧行为），与全仓 ImageOverride 读者同一回退。

## 热路径代价
每次池构建（stamped，变更时才重建）多一次 `settings.Shared()`（filememo 命中 + RLock）与每模型一次 map 查找；`seesAt` 本就每模型调一次 `ImageOverride`，代价同级。

## Watched 三查
1. 手拆回红：见 RED/消融。
2. 兄弟路径：见上表 6 条。
3. 失败读取：见上。

## 不确定项
- 报告者真实 relay 不可复现（无该服务）；测试用同形态模型替身（`cn:` 前缀、厂商列表不报 images）。
- searcher 池行为变化（用户标记过的 `:` 模型可入选 searcher 的 small 候选）已在帖内 What changed 明说；relay 自动搜索资格未变。

## 发布
- PATCH 前门禁：fetch upstream（c0477aa72..94f6f6092），`#4359|autovision|seesAt` 零命中；base..upstream/main 对两个改动文件 diff 为空。
- push origin，ls-remote = `aa378a4f6928fbce231744467724e59d0c8ec24c`。
- 帖：https://github.com/yetone/magpie/issues/4359#issuecomment-6558455950
- GET 回读：与提交 body 逐字节一致（仅 GitHub 追加文末换行 1 字节）；回读五项自检各 1。

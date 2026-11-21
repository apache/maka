# hunt47-D · yetone/magpie#2887 · 厂商"模型无提供方"400 未触发组内 failover

- 分支：`hunt47-d-shape-failover`（worktree `/tmp/magpie-h12`，基于 upstream/main `ef655acb40b2b2b5484e8eab41c79ff8b41bb6d3`）
- 提交：`90401beeac7c6de72b82bdca93612ae69e65fc46`（作者 ggbdpq <ggbdpq@gmail.com>，单提交）
- 补丁：`0001-gateway-a-vendor-s-model-not-served-here-refusal-fai.patch`，sha256 前 16 位 `7486473028cc297b`
- 英文评论（post-ready）：`2887-comment.body.md`

## 根因与修法

聊天路由组的 failover 由 `holdWriter.failed()` 驱动，其定义为 `!passing && code>=400 && retryable(code, errBody)`（`internal/gateway/fallback.go`）。400/422 只有命中 `quotaWords / unservedWords / refusedWords / shapeWords / unsaidWords / regionWords / wrongEndpoint` 之一才 retryable；ModelScope 的 `has no provider supported` 不匹配任何一个 → 组循环跳过所有 failover 分支，把 400 直接交回客户端，客户端重试再次命中首位（报告者实测连续 28 次）。

修法：把有厂商局部性语义（"本模型在本家不被服务"，换一个成员即可应答）的措辞补进 `unservedWords`：

| 措辞 | 来源 |
| --- | --- |
| `has no provider supported` | issue 2887 报告内 usage.jsonl 原文（ModelScope 400） |
| `deployment not found` / `DeploymentNotFound` / `The API deployment for this resource does not exist` | Azure OpenAI DeploymentNotFound（Microsoft Q&A、Stack Overflow 多处；Azure 原生回 404 已按状态码 failover，此处覆盖中转改写为 400 的情形） |
| `model_not_found`（OpenAI 风格） | 词表已有，未改动，仅测试锁定 |

落地后的行为全部来自既有机制，无新机制：

1. 400 命中 `unservedWords` → `retryable` → 组内问下一位成员；
2. `restAfterMarked` 的 unserved 分支（#1235 机制）把席位休息记在该 key 的该 model 名下（`restID`），同 key 其它模型不受影响——报告者第 2 点"坏席位软隔离"由此自然满足：下一个组请求跳过坏席位（测试断言第二次请求 `ms` 不再被问、`b.n==2`）；
3. `shapeRefused` 显式排除 `unservedWords`，走休息路径而非 shape 路径；decision group（`decideFailed`/`retryable`）同享此修复。

Poison-pill 底线保持：普通 400（"Invalid parameter"、"field required"）不 failover，直接交回客户端。

## 验证证据

- **RED**（upstream `fallback.go` + 新测试，两种方式各跑一次：初始 RED 与消融 RED）：`--- FAIL: TestGroupFailsOverAModelWithNoProvider … 400 … (ms 1, b 0)` —— 组以首位 400 结束、第二成员从未被问，与 issue 现场一致。
- **GREEN**：`ok github.com/yetone/magpie/internal/gateway 1.040s`（新测试）。
- **家族**：12 个测试全绿（新测试 + `TestGroupFailsOverAnUnservedModel`、`TestLastOneLeftIsTriedAgain`（poison-pill 端到端 guard：普通 400 一次即止）、shape 家族三个、escaped 词表两个、modelRefused 休息粒度、fallback guard 三个）。
- **全包**：`go test ./internal/gateway/ -count=1` → `ok … 339.974s`，EXIT=0。
- **-race**：目标三测试 `ok 2.361s`。
- **gofmt**：`gofmt -l internal/gateway/` 空。
- **vet**：darwin/linux/windows 三平台 clean。
- **build**：darwin 全量 `go build .` OK（仅预存 ld/CGO 警告）；linux/windows 用 Makefile 自带的跨平台方式 `CGO_ENABLED=0 go build -tags nogui .` OK；`./internal/gateway/` 三平台各自 OK。
- **消融**：仅触及一个产品文件 `internal/gateway/fallback.go`；还原为 upstream 版 → RED，恢复修复版 → GREEN。
- **变异**：(a) 删新措辞 = 消融 RED（同一文件单点改动）；(b) 往 `unservedWords` 加通用措辞 `invalid parameter` → guard 行变红 `retryable(400, "Invalid parameter: messages.3.content") = true`，证明词表没有过度扩张；恢复后回绿。

## 厂商措辞来源声明

- ModelScope：来自报告原文（usage.jsonl 引用），未实测真实账号。
- Azure DeploymentNotFound：Microsoft Learn Q&A（"How do I resolve error DeploymentNotFound"、"The API deployment for this resource does not exist"）与 Stack Overflow #77278712；均为公开文档/问答，非实测。

## 关于席位隔离（报告者第 2 点）

未新增隔离机制：一旦措辞入 `unservedWords`，既有 `modelRefused → restID()` 路径自动把休息按 model 记账（冷却阶梯，到期自动恢复）。这是仓库既有的"模型级软休息"，与 #1235（SenseNova 403 模型不在套餐）同路径；超出此的"持久坏席位台账"属行为新增，留给维护者定夺（英文评论 `## Not verified` 已写明）。

## 未验证项 / 诚实声明

- 无真实 ModelScope / Azure 账号：措辞来源如上声明，未实测活体 400。
- macOS 全量 GUI 交叉构建 linux 失败于第三方依赖 wails v3（`menu_linux.go: undefined: pointer`），与本改动无关、改动前后一致；按 Makefile 用 `-tags nogui` 交叉构建通过。
- decision group 路径共享 `retryable()` 理论上同享修复，但端到端测试只覆盖聊天组。

## 交付物

- `/tmp/magpie-h12`：分支 `hunt47-d-shape-failover`，提交 `90401beeac7c6de72b82bdca93612ae69e65fc46`
- 本目录：`RESULT.md`、`2887-comment.body.md`、`0001-gateway-….patch`
- 未推送、未发评论（按要求）

# #5521 验证纪要（车道 M5，2026-11-07）

- 单：yetone/magpie#5521「模型列表拉取对任意 base 都附带 x-api-key，部分中转（lightvela）401 Invalid token」
- 分支：`fix/5521-models-api-key-scope`（fork ggbdpq/magpie），head `d0640422c510aad4dd20c457244fcb549e5b1cdb`，基线 upstream/main `416305451`
- patch：`0001-live-an-OpenAI-compatible-base-s-model-list-is-asked.patch`，`git format-patch -1 --zero-commit`，SHA-256 前 16 `8b9ab0d792422511`（raw）
- take 帖：6693535262；PATCH 帖：6694003118（GET 回读 OK：patch 全文/sha/分支 sha/尾注俱在）
- worktree：/private/tmp/mg-5521（GOCACHE=/tmp/mg-5521-gocache）

## 修法

方案一（报告者建议，源头收窄）+ 一处兄弟面回归修复：

1. `internal/catalog/live.go` fetchPage：`x-api-key` 只在 `anthropic` 时写。论据：magpie 自家 chat 路径 `AuthHeaders`（provider/test.go）对 Chat/Responses proto 从不发 x-api-key，只有 `proto == Anthropic` 才双发；列表请求的无差别双发与自家语义不一致。学习机制（`p.listAuth`）本来就只包在 Anthropic base 的 ctx 上，不受影响。
2. `internal/provider/remote_magpie.go` listHeaders：remote magpie 的列表请求按协议「key 总以 x-api-key 发送」（remoteKey），原先搭 fetchPage 双发的便车；收窄后由 listHeaders 显式带 `h["x-api-key"] = p.Key`，与 signRemote 语义一致。

## TDD

- `TestListBearerOnlyOnOpenAIBase`（internal/catalog/live_test.go）：lightvela 式网关（任何带 x-api-key 的列表请求回 401 `Invalid token (request id: …)`，报告者原文）+ Anthropic base 双头+版本头对照。
- RED：`no model list: http://127.0.0.1:…/v1/models: 401 Unauthorized (Invalid token (request id: 202611060939163895096998268d9d6bo12ykfZ))`——与报告者弹窗一字不差。
- 消融：`git checkout HEAD~1 -- internal/catalog/live.go`（只回退产品文件）→ 同红 → 恢复 → 绿。

## 兄弟面 rg 全查（模型列表拉取认证头全部调用点）

- `catalog.FetchURL/FetchAt/FetchAtListed/FetchGemini` 非测试调用点全集：provider/models.go:786（ModelsURL 分支）、:849（Gemini 自有头）、:895（FetchAtListed，anthropic=proto==Anthropic）、codex_entries.go:40（同 URL 复问，false，回退有 Live 兜底）、azure.go:151（key=""）。gui/cli 无直接调用。
- x-api-key 其它写入域全部无关：remote_magpie/remote_quotas（远端协议，已处理）、gateway（收头）、opencode_go_free、vscode、claude_launch、redact。
- 测试面甄别：authheader_test 全族 Anthropic base（不动）；key_models_prefill/zhipu_envelope 读头是 Bearer 优先 OR 语义；opencode_bare_list OR 语义；azure_test 断言无 key（key=""路径）。**实red 一例**：TestRemoteMagpieRequestsCarryHeaders（列表路径断言 x-api-key=协议 key）——首轮全量抓红，listHeaders 补 key 后绿，已被帖子记录为 rider's guard。

## 矩阵

| 项 | 结果 |
| --- | --- |
| 定向：TestListBearerOnlyOnOpenAIBase + TestRemoteMagpieRequestsCarryHeaders + TestListLearnsOneAuth/TestRetryOneAuth*/TestBothAuthRefused | ok（含 `-race`） |
| `go test -tags nogui ./internal/catalog/ ./internal/provider/` 全量 | ok（135.8s） |
| gofmt -l | clean |
| go vet -tags nogui（darwin/linux amd64，两包） | ok / ok |
| go build ./...（darwin） | ok |
| go build ./...（linux amd64） | **预存红**：wails v3.0.0-beta.24 linux 文件 undefined: pointer；基线 416305451 同败（实测）。改动两包 + agent/redact/probelog linux build ok；cli→gui→wails 间接依赖，同预存 |
| 疑点 | TestClaudeAccountServesModelsListedSinceItsFetch 一次全量红：同代码复跑全量绿 + 单独绿 + 基线绿 + 与改动零接触面（本地 models.dev catalog 文件 + Anthropic 账号路径，不触非 Anthropic 列表头）→ 归因负载 flaky，非本改动 |

## 发布

push 显式 refspec `d0640422c:refs/heads/fix/5521-models-api-key-scope` → ls-remote 回读一致 → PATCH 帖 6694003118（五段+验证表+patch 折叠+Attribution 语境+尾注+报告者 wabxn514 credit）→ GET 回读 OK。

# #2071 追平验证记录（2026-11-06，车道 G）

任务：把 Oct 22 rework（d290df20）追平到 upstream/main 2000ae439，Go 侧 seating+测试，app.js 侧按裁决放弃，PATCH 同步原帖 6342731404。

## 交付物

- 追平提交：`95d3c4a14cae69d4833e2eeef68589c388ea92c6`（分支 `fix/2071-user-kind-filter` 本地；远端 force-with-lease 推至 `ggbdpq/magpie:hunt62-a-2071-rework`）
- 改动：`internal/provider/models.go`（Available 过滤 withoutUserKinds、ExposedOf pick 过滤）、`internal/provider/modelkind.go`（hasKindable picks）、`internal/provider/modelkind_list_test.go`（两列表断言测试，承自 d290df20 原样）
- patch：`0001-provider-a-model-the-user-says-makes-videos-or-image.patch`（10651 字节，sha256 前 16 = `2ff14408321bff05`）
- 原帖 PATCH：comment 6342731404（updated_at 2026-11-06T14:03:53Z）

## TDD（RED → GREEN → 消融回红 → GREEN）

| 步骤 | 结果 |
| --- | --- |
| RED：两测在父提交 2000ae439（实现前） | `TestUserKindLeavesTheChatList` 红："Available (the editor's chat chips) still has it: [omni_flash-10s claude-sonnet-4-5]"；`TestUserKindBeatsAPick` 红："Exposed still serves a pick the user said makes videos: [omni_flash-10s claude-sonnet-4-5]" |
| GREEN：实现后定向 | 两测 ok（1.1s） |
| 消融：`git checkout 2000ae439 -- models.go modelkind.go`（只退产品文件、留测试、基线=父提交、变异点=过滤分支整体） | 两测红，逐字同 RED |
| 恢复：`git checkout HEAD -- ...` | 两测 ok（1.1s） |

## 矩阵

| 项 | 结果 |
| --- | --- |
| `go test ./internal/provider/ -tags nogui -count=1` 全包 | ok（119.9s） |
| `go test ./internal/catalog/ -tags nogui -count=1` 全包 | ok（1.1s） |
| `go test ./internal/gateway/ -tags nogui -timeout 25m -count=1` 全量 | ok（686.6s，零失败） |
| `go test ./internal/gui/ -tags nogui -run 'ProviderInfo|Providers|Model'` | ok（5.3s） |
| gateway 定向 `-run 'CustomProviderVideo|CustomProviderDraw|Kind|Drawer|Videomaker'` | ok（1.5s；含 TestCustomProviderVideoTheUserMarks/TestCustomProviderVideoKeepsTheCallersFields——hasKindable picks 由其锁定） |
| 定向两测 `-race` | ok（2.3s） |
| `gofmt -l internal/provider/` | 净 |
| `go vet -tags nogui ./internal/provider/`（darwin） | 净 |
| `GOOS=linux go vet -tags nogui ./internal/provider/` | 净 |
| `go build -tags nogui ./...`（darwin） | ok |
| `GOOS=linux go build -tags nogui ./internal/provider/` | ok |
| 预存红对照（TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy） | gateway 全量本次零红，前两者未触发；gui 只跑定向未含第三者 |

## 兄弟面

见 `sibling-face.md`（改动点消费方全跟随、不改读者逐个理由、id 空间核验、已知缺口）。

## PATCH 帖与回读

- `gh api -X PATCH repos/yetone/magpie/issues/comments/6342731404`：head 行 base 87d703c5→2000ae439、details summary 换新 subject+sha256 前16、patch 块整体换为 95d3c4a14 产物、`**Branch with the commit**` 行换新 head、**patch**: 行后插入 Re-verified 块（含新验证表与缺口说明）。
- GET 回读终判：`readback-trimmed.md`（去 jq 尾换行）sha256 `74d35015…` 与本地 new-comment-body.md 逐字节一致；从回读抽出的 patch 块 sha256 = `2ff14408321bff05…` 与产物一致；围栏 2 成对、details 1/1、新 head 与 Re-verified 行在位。API `.body|length`=17435 为字符数（UTF-8 多字节），字节 17461。

## 已知缺口（如实，不在本追平范围）

marked 模型离开 chat chips 后，维护者自建的 Image/Video models 两区列出它但仅 tick/untick，无右键改 kind 菜单，SetModelKind 无 CLI/API 入口 →「改回 Auto」暂无 GUI 落点（Re-verified 块已注明，属维护者 review 第 4 点后半的 UI 后续）。

## 未验证

报告者真实 relay 端到端（无账号）：更新后 omni_flash-10s 应同时离开对话 chips、agents 列表与网关模型列表，保留在 Video models 区。

# #2071 hunt62 Lane A 验证日志（重做修复）

日期：2026-10-22。分支 `hunt62-a-2071-rework`（基线 upstream/main `87d703c5`），head `d290df20880f11b90588d5e8af81600a3d5d0ef3`，单提交，作者/提交者均 `ggbdpq <ggbdpq@gmail.com>`（`git -c user.name=… -c user.email=… commit -F` 提交后核验 author/committer 两行）。

## 维护者 review（yetone，2026-10-15T05:19:55Z）要点

1. 旧补丁 65cf6069 只设标志无过滤消费方：`withUserKinds` 把 Films/Draws 设到 `Available()` 返回条目上，但标志唯一读取处 `catalog.Chat()`（internal/catalog/live.go）在 `Available()` 之前对抓取列表过滤；`Available()` 之后的消费者（编辑器 chips internal/gui/providers.go `for _, m := range p.Available()` → `out.Models`，`modelJSON` 不带 Films 字段）、`Exposed()`、网关模型列表都不看标志。
2. 旧测试只断言标志不断言列表成员；维护者给出复现：沙盒 HOME + base URL relay（保存列表 omni_flash-10s + claude-sonnet-4-5），`SetModelKind("relay/omni_flash-10s","video")` 后断言不在 `Available()`/`Exposed()`——main 红，打旧补丁仍红。
3. 小问题：`withUserKinds` 没像 `ModelKind()` 那样先判 `p.MarksKinds()`。
4. 真正修法要求：成员层面从对话列表拿掉，Exposed()/网关/编辑器跟随；编辑器在图像/视频区列出并保留右键"类型"菜单（否则无处改回 Auto）；测试断言成员，人工去掉过滤要变红。

## 复核的装配链（file:line，基线 87d703c5）

- 抓取分类：`catalog.fetchPage`（internal/catalog/live.go，`r.Kind`/`DrawsID` → `Draws`/`Films`）→ `SaveLiveSides` 存原始列表。
- 唯一按标志过滤：`catalog.Chat`（internal/catalog/live.go:131-138，`!m.Draws && !m.Films`），被 `catalog.Live`（live.go:74-84）调用；`readLive` 的 byID 同样由 Chat 构建（live.go:47-58）。
- 装配：`Provider.live()`（internal/provider/models.go:145-156）→ `Provider.available()`（models.go:50+）→ `Provider.Available()`（models.go:31-48）。
- Available 之后消费者（均不读标志）：编辑器 chips internal/gui/providers.go:785→`out.Models`（`j.Kind` 仅标签）；`Exposed()` internal/provider/models.go:1439+（pick() 对 byID-miss 的 pick 复活为 unlisted 裸模型，models.go:1451-1466）；网关 internal/gateway/gateway.go:1941；CLI internal/cli/providers_cli.go:384、model_cli.go:172；TUI internal/tui/pages.go:384。编辑器图像区 internal/gui/providers.go:814 `gateway.Drawers(p)`（draw.go:250-300，已并入 `KindModels(KindImage)`、排除 KindVideo）；视频请求路径 internal/gateway/video.go:99-122 `customVideomakers`。
- 用户标注：settings.ModelKinds["pid/mid"]；`ModelKind`（modelkind.go:39-44，MarksKinds 门禁 modelkind.go:32-37）、`KindModels`（modelkind.go:54-73）、`SetModelKind`（modelkind.go:86+）。

## 方案取舍

- 选定：`Available()` 出口成员过滤（`withoutUserKinds`）——所有对话消费者单咽喉跟随；`Exposed()` pick() 挡掉被标注 pick 的复活。理由：改动面最小（一处出口+一处复活口），语义正确（"Available 的每一条都可对话"），MarksKinds 门禁保留在 provider 层。
- 否决 catalog 层（readLive 时应用标志）：catalog 在 provider 之下，表达不了 MarksKinds 门禁（账号/remote magpie/decide-only 不吃旧标注），且波及 LiveByID 请求路径。
- 否决仅 gui 循环过滤：Exposed/网关仍供给对话，违背维护者点名的三个消费者。
- 前端：renderDrawers 加已标注 chip 的类型菜单 + 新增 renderVideomakers 视频区（app.js 手写源码 1.3MB，无构建链，`node --check` 过语法）。

## TDD

RED（main，提交前）：

```
--- FAIL: TestUserKindLeavesTheChatList (0.12s)
    modelkind_list_test.go:61: Available (the editor's chat chips) still has it: [omni_flash-10s claude-sonnet-4-5]
--- FAIL: TestUserKindBeatsAPick (0.01s)
    modelkind_list_test.go:98: Exposed still serves a pick the user said makes videos: [omni_flash-10s claude-sonnet-4-5]
internal/gui/providers_draw_test.go:76:27: j.VideoIDs undefined … 82:7 / 83:26: j.Kinds undefined
```

GREEN：实现后定向 + 全量见下。中途网关两测被打破（`TestCustomProviderVideoTheUserMarks` videomakers [] / `TestCustomProviderVideoKeepsTheCallersFields` 400 can't make videos）：根因 `serves()`=Available∪Exposed，标注模型从两者消失后 `hasKindable` 对不在 LiveAll 的手打 pick 失真，`KindModels` 误删。在共享根因 `hasKindable`（modelkind.go:78-85）补 picks 语义修复，两测转绿。

## 消融（先提交 d290df20，再回退产品文件、保留测试）

回退 4 个产品文件（models.go / modelkind.go / gui/providers.go / app.js）至父提交后复跑（先 `grep -n '^func Test'` 取精确名）：

```
--- FAIL: TestUserKindLeavesTheChatList — Available (the editor's chat chips) still has it: [omni_flash-10s claude-sonnet-4-5]
--- FAIL: TestUserKindBeatsAPick — Exposed still serves a pick the user said makes videos: [omni_flash-10s claude-sonnet-4-5]
internal/gui/providers_draw_test.go:76:27: j.VideoIDs undefined（build failed）
```

恢复后 `git status` 干净、provider 定向复跑 ok。

## 预存红定性

`TestProxyCheckSaysAProxyPassedBy`：在 worktree 用父提交 gui 全目录（`git checkout HEAD~1 -- internal/gui`）单跑，同样红；另在主 clone（本地 main，3608ed78）单跑也红。确认预存、与本补丁无关。TestMothX 未在本次改动包出现，未跑。

## 矩阵（退出码）

| 项 | 结果 |
| --- | --- |
| `go test -tags nogui -count=1 -run 'TestUserKind…|TestProviderInfo…'`（RED/GREEN/消融） | 如上 |
| `go test -tags nogui -count=1 ./internal/provider` | ok（82.6s，exit 0） |
| `go test -tags nogui -count=1 ./internal/gui` | 仅 TestProxyCheckSaysAProxyPassedBy 红（预存，父提交同红）；其余全绿 |
| `go test -tags nogui -count=1 ./internal/gateway` | ok（361s，含两视频测转绿后复跑） |
| `go test -tags nogui -count=1 ./internal/cli` | ok（41.6s） |
| `gofmt -l internal/provider internal/gui` | 空输出 |
| `go vet ./...` | exit 0 |
| `GOOS=linux go vet -tags nogui ./...` | exit 0 |
| `GOOS=windows go vet -tags nogui ./...` | exit 0 |
| `go build -tags nogui ./...`（darwin） | ok |
| `GOOS=linux go build -tags nogui -o … .` | ok（入口为根 main.go，无 ./cmd） |
| `GOOS=windows go build -tags nogui -o … .` | ok |
| `node --check internal/gui/assets/app.js` | OK |
| `git am` 补丁实测（临时分支 am-check 于 87d703c5） | Applying 干净，树与 head 完全一致（TREE-IDENTICAL），作者保留，临时分支已删 |

## 兄弟面清单（三查②：还有哪些消费者该读标志）

- 网关 /v1/models、agent 模型列表（Exposed）、CLI/TUI 列表：读 Available/Exposed，自动跟随（行为即本单主张）。
- 图像请求 `gateway.Drawers`（draw.go:250-300）：经 `KindModels(KindImage)` 独立读取，已含用户标注图像模型并排除视频标注——不改（请求路径，须保留）。
- 视频请求 `customVideomakers`（video.go:99-122）：同上经 `KindModels(KindVideo)`——不改（请求路径）。
- `ServesModel`/`UpstreamName`（modelprefs.go:890+）经 `serves()`：标注模型现在"served=false"。语义正确（对话不再请求它）；其唯一副作用是给标注模型留的自定名不再生效，属对话列表语义的自然结果，未改，如在 review 中被点名再议。
- 收藏/置顶/下拉：仓库无收藏置顶模型机制；下拉（agent picker/Claude Desktop 菜单等）全走 Exposed，跟随。无需额外改动。

## 交付物

- 提交：`d290df20880f11b90588d5e8af81600a3d5d0ef3`（分支 hunt62-a-2071-rework）
- patch：本目录 `0001-provider-gui-a-model-the-user-says-makes-videos-or-i.patch`，SHA-256 前 16 `cdb51fe24e382c90`
- 待发布稿：本目录 `2071-comment.body.md`（三件套自检：Attribution 精确行 ×1、details/summary 单行 + patch 围栏 + /details ×1、branch 行 ×1；零中文；GLM-5.3-Flash 仅出现在 patch 围栏内 commit 尾注一次；无 AI use 段）

## 不确定项

- app.js 渲染（两区 chip、右键菜单、staged 保存流）无自动化验证（仓库无前端测试设施），仅 `node --check` + Go 侧 JSON 形状测试；已在 patch 的 Run 段与评论 Not verified 明示。
- `Exposed` 的 `manyModels=24` 截断分支：被过滤后 avail 变小会改变截断起点——属预期（列表成员本就变了），无测试覆盖该组合，未见回归。
- internal/tui、internal/agent 未跑测试（未改动包，`go vet ./...` 与全仓 build 覆盖编译面）；其模型列表经 Available/Exposed 自动跟随。

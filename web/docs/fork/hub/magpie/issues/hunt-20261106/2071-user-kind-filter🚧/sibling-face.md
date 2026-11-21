# #2071 追平（95d3c4a14）兄弟面 rg 全查表

基线：upstream/main 2000ae439；改动面 = `Available()` 成员过滤（withoutUserKinds）、`ExposedOf` pick 过滤、`hasKindable` picks 语义。全查词：`ModelKind` `KindModels` `ModelKinds` `withoutUserKinds` `Films` `Draws` `Available()` `Exposed()`。

## 改动点自身的消费方（全部跟随，=修复目的）

| 消费方 | 位置 | 判定 |
| --- | --- | --- |
| 网关模型列表 | internal/gateway/gateway.go:2665 `p.Available()` | 跟随过滤——报告者场景的网关面，改=目的 |
| 编辑器 chips | internal/gui/providers.go out.Models（遍历 avail=p.Available()） | 跟随——编辑器对话列表不再列 marked 模型 |
| Exposed 全部消费方 | cli/model_cli.go:1462、cli/providers_cli.go×7、gateway/search.go:455/602、provider/autolist.go:214、claudedash.go:125、decide.go:664、disabled.go:289、detect.go:313 | 跟随——agents 列表不含 marked 模型，改=目的 |
| Available 其余消费方 | cli/groups_cli.go:1276、cli/model_api_cli.go:221、cli/model_cli.go:224、cli/providers_cli.go:244/430/961/2187、gateway/search.go:239/258/340/496、search_remote.go:41/42/50、gui/providers.go:3140、provider/autolist.go:217、codex_models.go:696、groupeffort.go:129、modelprefs.go:725/977、models.go:1666、gateway/draw.go:458 | 跟随；draw.go:458 是 kindModel 查找循环，marked 模型退回 LiveAll 取名，行为不损 |
| KindModels 消费方 | gateway/draw.go:419（image 标注进 draws 路径）、gateway/video.go:167（video 标注进 videos 路径） | 经 hasKindable picks 修复后继续含 marked 模型（含手打 pick）——gateway TestCustomProviderVideoTheUserMarks/KeepsTheCallersFields 锁定 |

## 不改的读者（逐个对比理由）

| 读者 | 位置 | 不改理由 |
| --- | --- | --- |
| `p.ModelKind(m.ID)` draws 排除 video 标注 | gateway/draw.go:373/425 | 语义不变：marked 模型仍经 KindModels(KindImage) 进 draws 候选，373/425 继续把 video 标注排掉 |
| `p.ModelKind(m.ID)` videos 排除 image 标注 | gateway/video.go:172 | 同上对称面 |
| `j.Kind = p.ModelKind(m.ID)` | gui/providers.go:958 | chip 徽章读当前 kind，不涉列表成员 |
| `setModelKind` 写口 | provider/modelkind.go（编辑器 Save 经 modelprefs.go:599 唯一 GUI 入口） | kind=="" 改回 Auto 不做 hasKindable 校验，marked→Auto 通路不受过滤影响；kind!="" 时 hasKindable 新含 picks，手打 pick 可标注 |
| vendor 侧 `Films`/`Draws`/`Serves` 分类 | catalog/live.go:686（分类）、live.go:181 LiveVideomakers、live.go:218 catalog.Chat、gateway/video.go:160、video_minimax.go:88、media_group.go:17 | vendor 语义与用户标注正交；catalog.Chat 只滤 fetched list 的 vendor 标志，本次不动 |
| `withUserKinds`（旧补丁的设标志函数） | 无——当前 main 不存在 | 旧形态已废弃，不带入 |

## id 空间核验（相对旧补丁的语义修正）

- `settings.ModelKinds` key = 编辑器 chip 呈现的 id（SetModelPrefs ref=pid/「列表 id」，modelprefs.go:552）；改名经 `setModelID`→`s.MoveModel`（settings.go:1466，反射迁移全部 per-model map 除 ModelIDs）随迁 → key 恒在「列表 id」空间。
- 因此过滤放在 `ids().list(...)` **之后**（`withoutUserKinds(p.ids().list(p.available()))`），与编辑器写、网关读同一空间。旧补丁在其基线上无 list 层，此点为追平时的实证修正。
- `serves()`（modelprefs.go:975）调 Available+Exposed：withoutUserKinds 只读 heldSettings 不回调 serves，KindModels/ExposedOf pick 也不在 Available 栈内，无递归环。

## 已知缺口（如实上报，不扩大范围）

marked 模型离开 chat chips 后，编辑器 Image models/Video models 两区（维护者 filmIds/renderDrawers UI）已列出它但 chip 仅 tick/untick（hiddenDrawers/hiddenVideomakers），无右键改 kind 菜单；SetModelKind 无 CLI/API 入口。→「改回 Auto」暂无 GUI 落点，属维护者 review 第 4 点后半（其自建 UI 的后续），本次按裁决不带 app.js 侧，Re-verified 行注明。

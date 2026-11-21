# hunt-123 / #4242 Lane A 执行日志（2026-11-04）

结局：**让位出列（独立核验帖计完成）**。未产出我方 patch，未动产品文件（worktree 仅 review 用 cherry-pick，已留在 /private/tmp/mg122-b 分支 review-4242-nikowu）。

## 时间线
- 到手即发现 c=2：Niko-Wu（contributor）2026-10-29 10:04Z 已 take 并交付完整 fork 分支修复（`fix/oss-batch` head `00adbe64`，单 commit，6 文件 +215/−3，cherry-pick 形态，"OPEN, no claim"）。报告者 Reign9201 同日 09:35Z 更正原报告：wb2api 拒的是**缺 type 键的空根**（`{}` 400 code 11129 → `{"type":"object"}` 200），并降到 latent。
- take 已被占 → 本单转为独立核验（判例 #4945 同构：skygunner 交付 → 我方让位 + 核验帖）。
- 核验帖：comment 6618338662（2026-11-03T23:41:15Z，3560 字符，作者 ggbdpq，GET 回读八要素通过）。
- 产物：`nikowu-00adbe64.patch`（其 commit 副本，sha256 前 16 = c551e39b170b9ca9）。

## 让位闸判定
触发项：**方案先行**——Niko-Wu 已交付带测试/验证/消融说明的完整修复，早于本 lane 启动。其余闸项核实：修复未 landed（`git log --grep=4242` 空、`emptyObjectRoot`/`emptyRootsBody` 在 tip 667317159 搜不到）；维护者未表态；报告者未自带修复。其修复未落地、且无人复核过 → 核验有真实价值，不算无用功。

## 独立核验记录（全部本机实测，darwin/arm64 go1.25.5）
- **漂移核查**：其基线 4534561f → tip 667317159 之间，anthropic.go/object_root.go 面落了 5 个 commit（#4910 #4571 #3835 #2532 #3739），cherry-pick 零冲突自动合并，定向测试全绿 → 无语义漂移。
- **Root cause 代码链确认**：`objectSchema` 的 `len(schema)==0` 早退 + `{}` 不含 `Of"` 走不进并集折叠 → 原样出站；translated 面（chat.go/responses.go/anthropic.go objectSchema）与 raw passthrough 面都盖住了。`emptyObjectRoot`（窄形）与 `objectSchema`（宽形，折叠并集）分离是对的——用宽形会改 relay 首问形状（TestRootUnionFoldedWhereRefused 守住，实测仍绿）。
- **消融**：调用点级回退 4 处（chat.go/responses.go 换回 t.Schema、gateway.go 去 emptyRootsBody 调用、anthropic.go 空根分支 if false）保测试 → `TestEmptyToolSchemaGetsObjectRoot` + `TestEmptyToolSchemaTranslatedToChat` 红（后者即报告者形状：/v1/messages input_schema {} → Chat 上游，重问 parameters {"type":"object"}）；恢复 → 绿。`TestEmptyToolSchemaBodyGetsObjectRoot` 直调函数本体，调用点消融下恒绿，属单元测，路径由 TranslatedToChat 经 passthrough 覆盖。
- **验证矩阵**：定向 3 测试 + 并集族全绿（含 -race）；全量 `go test -tags nogui -timeout 25m ./internal/gateway/` 647s 绿；gofmt -l 净；vet 净（gui 的 cgo 告警预存无关）；`go build ./...` 过。-race 全量唯一红 `TestCompactionOverByteCapEveryTime`，在未打 patch 的 667317159 复跑同红 → 预存（byte-cap 压缩面，与工具 schema 零交集）。
- **兄弟面 rg 全查（12 文件）**：chat_tool_shape.go（转发不改 schema）、undeclared_tools.go（stub 自带 type:object）、claude_subscription.go（bridge 已填空 schema）、gemini_schema.go（无类型节点全补 type，含根）、kimi/deepseek/oneof/copilot_gemini/xai_body（各修别的缺陷，均不放空根过）→ 均无需同修。
- **发现的残留（已写进帖）**：`emptyRootsBody` gate 只认 Chat/Responses，raw Anthropic→Anthropic passthrough 仍原样转发 `"input_schema": {}`（报告者在 /v1/messages 复现过 400）。已知的 Anthropic 格式上游都收空根，translated 面已盖，不阻断本修复；若严格上游类在那里出现再补。

## 经验
- **c>0 的单必须先读完评论再动手**——本单开场即撞 contributor 已交付，读评论省了一整轮重复 patch。
- 让位不是零产出：对 fork 分支交付做"漂移核查 + 消融 + 全矩阵 + 兄弟面全查"的独立核验，是维护者 cherry-pick 前唯一的质量关，#4945/#4242 两次同构成立。
- 消融的精度：直调被测函数的单元测在"调用点级消融"下恒绿，RED 证据要指到真正走调用链的集成测上，并在帖里说明覆盖关系，别谎报"全部消融红"。

# hunt58 Lane A · #3055 验证日志（本地，不发布）

日期：2026-10-21 · 分支：hunt58-a-3055 · head：`76a40b013b9c3474efeb570eed75daaca924fb24` · 基线：`f5b0157420a4491f6e707b49a8af8e87ea8050a1`（=upstream/main） · worktree：/tmp/magpie-r58-a

## 前提核验（逐项）

1. `gh issue view 3055 --repo yetone/magpie` — 正文与派单摘要一致：0 评论，ArakawaHenri 自认「没有证据证明是 Magpie 网关本身改写了 required」，聚焦 magpie 生成的 DSH 接入配置；给出 `compat.supportsStrictMode: true` 单字段绕过及生效证据（同一会话后续调用恢复省略可选参数）。
2. magpie 侧无任何 strict 关闭项：`rg -n 'supportsStrictMode|StrictMode|strict' internal/` 只命中 gateway 的 strict_refused（上游拒绝 strict 字段时的剥除路径）与无关词；`internal/agent/dsh.go` 的 `dshPiCompat` 只有 `ForceAdaptiveThinking`（1341 行附近），`dshKindConfig`（1533 行附近）仅 `anthropic-messages && AdaptiveThinking` 时写 compat；openai-responses 路由零 compat。
3. pi-ai strict 语义（上游开源源码求证，shallow clone badlogic/pi-mono 至 /tmp/pi-mono-verify）：
   - `packages/ai/src/api/openai-responses.ts` getCompat：`supportsStrictMode: model.compat?.supportsStrictMode ?? false`；
   - `packages/ai/src/api/openai-responses-shared.ts` convertResponsesTools：`defaultStrict = false`；`if (supportsStrictMode) { functionTool.strict = strict }` — compat 未设时工具对象省略 strict 字段；设 true 时普通工具显式 `strict: false`；
   - `packages/ai/test/openai-responses-compat.test.ts`（cloudflare-ai-gateway 用例）断言普通工具 `{name:"ordinary", strict:false}`、constrained 工具 `strict:true`；
   - `packages/coding-agent/src/core/provider-composer.ts` mergeCompat：provider 级 compat 为 base、model 级覆盖 — 报告者把绕过写在 provider 级与实现相符；magpie 现有写法为 model 级（forceAdaptiveThinking 先例），两级都被 pi-ai 读取。
   - 派单称 pi-ai「vendor 依赖，go.mod 里」与事实不符：magpie go.mod 无 pi-ai，无 vendor 目录；pi-ai 是消费端（dsh/Pi/omp）内嵌的 TS 库。不构成弃单项，依赖源码仍可求证。
4. OpenAI 协议语义（developers.openai.com/api/docs/guides/function-calling）：Responses 省略 strict「will attempt to normalize your schema into strict mode when possible」；strict 模式「All fields in `properties` must be marked as `required`」；Chat Completions 省略时保持 non-strict。与报告一致。
5. 弃单条件三项均未触发：magpie 未显式关 strict（即缺陷本身）；根子在 magpie 生成面而非用户配置；strict 语义与报告描述相符。接单。

## TDD

- 测试文件：`internal/agent/responses_strict_test.go`（新）。
- RED（先只加 struct 字段使测试可编译，行为未接）：
  - `TestDshTellsAResponsesToolsStrictIsOff` → `responses_strict_test.go:48: a model asked on Responses isn't told strict is off: &{ID:resp/gpt-5.5 ... Compat:<nil>}`
  - `TestPiTellsAResponsesToolsStrictIsOff` → `responses_strict_test.go:149: resp/gpt-5.5 is asked on Responses and isn't told strict is off`（附生成的 models.json 片段：api openai-responses 无 compat）
- GREEN（接上 dshKindConfig 的 openai-responses 分支 + piModelJSON 的 compat 行）：两测试 ok。

## 消融

| 变异 | TestDsh… | TestPi… |
| --- | --- | --- |
| A：两处产品文件整体回 f5b01574、保留测试（两处同禁） | 红（build 级：`SupportsStrictMode undefined`，修复新增的类型面基线不存在） | 同红 |
| B：只摘 dshKindConfig 的 openai-responses 分支 | 红（行为级，`Compat:<nil>`） | 绿 |
| C：只摘 piModelJSON 的 compat 行 | 绿 | 红（行为级） |

变异均为手工核对 diff 原文（非 grep 计数）；B/C 证明每个测试各守自己的修复点，A 为简报要求的组合消融。

## Watched 三查

1. 手动打破（=消融 B/C）回红，已做。
2. 兄弟面清单：改=DSH（dshKindConfig，报告面）、Pi+StepCode（piModelJSON 同函数同语义）；不改=Pencil（native=false 全 Chat）、omp（models.yml 整文件 schema 校验、无版本底线，需单独带版本闸的单，先例 ompSessionSince/ompTakesMax）、lody/cindy（URL scheme 自有客户端）、zcode/droid/OpenCode/Crush/jcode 等（自有客户端，非 pi-ai 语义）。
3. 失败读取：无新增失败路径；用户手设 compat 键仍由 dshKeepCompat 保留（测试含 maxTokensField 存活断言）；magpie 自设键按现状覆盖（forceAdaptiveThinking 同先例）；Pi 侧 syncJSON 无变化不重写（TestPiKeepsTheirKeysInMagpiesProvider 在全包运行中仍绿，证明加了 compat 后块仍字节稳定）。

## 矩阵（命令 → 退出码）

- `go test -run 'TestDshTellsAResponsesToolsStrictIsOff|TestPiTellsAResponsesToolsStrictIsOff' -count=1 ./internal/agent/` → 0（修复后）
- `go test -count=1 ./internal/agent/` → 1，唯一 FAIL=TestMothX；stash 全部改动后在干净基线复跑同样 FAIL（`mothx_test.go:154`，Detected() 期望假实真，本机预存，与本改动无关；两次运行均 1 个 FAIL）
- `gofmt -l internal/agent/dsh.go internal/agent/agents.go internal/agent/responses_strict_test.go` → 无输出，0
- `go vet ./...` → 0（internal/gui 的 cgo -Wenum-conversion warning 为预存）
- `GOOS=linux GOARCH=amd64 go vet -tags nogui ./...` → 0
- `GOOS=windows GOARCH=amd64 go vet ./...` → 0
- 裸 `GOOS=linux GOARCH=amd64 go vet ./...` → 报错全部位于 github.com/wailsapp/wails/v3 模块自身 linux 文件（`undefined: pointer` 等，依赖侧预存）；改动包裸 linux vet `./internal/agent/` → 0
- `go build -o /dev/null .`（darwin/arm64 原生）→ 0（ld duplicate libraries warning 预存）
- `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags nogui -o /dev/null .` → 0
- `GOOS=windows GOARCH=amd64 go build -o /dev/null .` → 0
- `CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -tags nogui -o /dev/null .` → 0
- 裸 `GOOS=darwin GOARCH=amd64 go build -o /dev/null .` → 1，错误全部在 wails 依赖 darwin 文件；stash 后基线复跑同样 1（10 处 undefined），预存
- 文档：docs/subsystems/agent-wiring.md dsh 段补 supportsStrictMode 事实

## 交付物

- 提交：`76a40b01`（单提交，作者/提交者均 `ggbdpq <ggbdpq@gmail.com>`，经 `-c user.name/-c user.email/--author` 单次固定——仓库共享 config 的 user.name 值损坏为字面量 "user.email"，未改共享配置）
- patch：`docs/issues/hunt58/a-3055/0001-agent-a-tool-asked-on-Responses-says-strict-false-it.patch`
- SHA-256 前 16：`1499c2c813496c83`（shasum -a 256）
- 评论稿：`docs/issues/hunt58/a-3055/3055-comment.body.md`（五段+Verification 表行间无空行+Not verified+Attribution+patch details+分支行；稿内中文仅一处=内嵌 patch 的上下文行含上游 agent-wiring.md 原有「原生联网搜索」字样，git am 需要原样上下文，属逐字引用）
- 未做：push、发帖、评论、关单（按派单禁止项）

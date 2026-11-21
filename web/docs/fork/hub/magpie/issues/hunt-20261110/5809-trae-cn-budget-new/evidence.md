# #5809 判定证据（NEW 车道 B，2026-11-10）

结局：**JUDGED**（设计决策面，判定帖，不硬凑 patch）
基点：upstream/main = `e3ab7f3bf`（agent: isDir, isFile and Taken make no os.FileInfo on unix）
帖：https://github.com/yetone/magpie/issues/5809#issuecomment-6753086571

## 排雷三查（take 后末页重扫）

- 末评=自己 take（ggbdpq，6752911439）；无维护者评论。
- `git log upstream/main --grep=#5809`：唯一命中 `1493acb46`（`openai/codex#58091` 子串假阳性，Codex memories 提交，语义无关）。
- issue OPEN，无 open PR 引用（gh pr list 检索 5809/trae 无命中）。

## 采纳链（源码级，逐 file:line）

1. 插件 `@magpie-community/opencode-trae-auth@0.2.33`（npm 最新，`npm view` 实时确认；与报告者所核 0.2.32 modelOf 同源）`index.mjs`：
   - `:3614`：`// context_window_tokens: dev is what a request gets, max only in Max mode`；`const ctx = Number(m.context_window_tokens?.dev ?? m.context_window_size?.max?.[0] ?? ... ) || was.limit?.context || MODEL.limit.context`
   - `:2897` `maxModel`、`:2909` `const MAX = "-max"`：Max 模式窗口单独映射为 `<id>-max` 条目——dev 预算是插件**有意**的设计并在 README 写明。
2. `internal/plugin/host.js:2613-2615`：host 只透传 OpenCode 形状 `limit.{context,input,output}`，`context_window_tokens` 原始字段不出插件；core 无法知道该数是 mode budget。
3. `internal/provider/plugins.go:335` `pluginCatalog`：`Context: catalog.Window(m.Input)` + #1286 clamp（published = min(Window(input), Window(context))）——两种放法下 dev（较小值）都赢，协议现状无法表达"budget X, capability Y"。
4. `internal/provider/models.go:3672` `ListedWindow`（vendor 的话 > models.dev）；`:3693` `WindowOf`（用户 > 两者）；`:3449` `entryFor` → `Entry.Context`。
5. 发射点（兄弟面全查，全部读同一个 `Entry.Context`）：
   - `internal/gateway/gateway.go:1376` `/v1/models` modelObject（context_window=context_length=max_input_tokens）
   - `gateway.go:1473` Catwalk 形状 `context_length`
   - `internal/gateway/ollama.go:160` ollama details
   - agent writers（dsh/Pi/OpenCode/Crush/Command Code 配置；报告者补评 5 正确：写手吃 catalog 非 HTTP）
   - GUI `internal/gui/providers.go`（Context/Listed 字段）、CLI
   - 结论：任何局部修都是漏的；共享根=采纳契约。
6. gateway 不强制该数：`gateway.go:10393` `context_length_exceeded` 只分类 vendor 报错（tooLong），非 magpie 自查——报告者证据 5 成立，纯声明值。

## 判定依据（为何 JUDGED）

- 116000 确为插件 dev 模式专有值（前提成立）→ 但 core 无从"识别"：无 budget/mode 字段（plugin.Model 全 struct 核过），host.js 不带原始字段。
- 各 core 侧改法全不成立：
  - models.dev 覆盖 / 取 max：报大方向危险（#4584 WorkBuddy 形状：声明 1M 实服 100K → agent 越窗硬失败）；vendor-word-wins 是承重设计。
  - core 特判 trae-cn：插件逻辑进 core 且无数据可用。
  - 与 `-max` 兄弟条目取 max：抹掉 dev/max 模式区分（两条目路由行为不同），且 `-max` 的 1,000,000 也是 Trae 自己清单的数。
  - LeastWindow(2048)（`catalog.go:538`）数值过滤：116000 分不出来。
- 维护者先例：插件报错数→插件修+core 钉最低版本（`0f04dca6e` WorkBuddy min 0.2.26；plugins#561 已关=插件侧修）。
- 用户逃生门今日有效：Model settings 窗口（SetContext）覆盖插件的话，`TestPluginModelWindow`（`internal/provider/plugin_context_test.go`）断言。
- 两条正路留给维护者拍：①插件改映射（max → limit.context，dev 另存）——core 零改动即发布能力值；②协议加 budget 字段（#2889 形状）。

## NOT-RUNNABLE 如实

- 报告者的真机探针（1M token 经 gateway 发送、credits 计量对比、code 4026 慢失败）：需真实 Trae CN 账号，本车道未复现；其测量内部自洽且与源码路径一致，按给定采信，判定帖已声明。

## 交付物

- 判定帖：issuecomment-6753086571（7094 字节 body，列表端点回读 len=7060 一致）
- body.md 本目录；无 patch（判定单）；worktree /tmp/mg-1110-B3-5809 已清；分支 fix/5809-trae-cn-dev-budget 已删。

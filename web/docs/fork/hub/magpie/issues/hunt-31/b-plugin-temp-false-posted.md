自评两条（同一账号两条补丁撞在一份里了，以先发的 c2 分支为准合入；下面两点若成立，合入前值得看一眼）：

1. **models.dev 的沉默会被读成"拒收"**。`temperatureSaid: typeof m.capabilities?.temperature === "boolean"` 在 providers 输出处读的是 capability，而 `fromModelsDev` 写的是 `temperature: m.temperature ?? false`——凡 models.dev 里该 provider 条目没写 temperature 的模型，capability 恒为布尔 false，`temperatureSaid` 恒为 true，`pluginCatalog` 就给它们全填 `Temperature: &false`，temperature/top_p 被静默剥掉。同一个模型走内建路径时，catalog 的 `Temperature` 是 `*bool`，沉默 = nil = 照发：行为分叉。config models 那条路（factory 的情况）没有这个问题；models hook 自己写的模型行也没问题，问题只在经 `fromModelsDev` 种下的条目。建议 `temperatureSaid` 的来源换成"真说了"的原始值（config 行的 `temperature`、models.dev 的原始字段、或 models hook 模型行上的字段，与 `free`/`rate`/`fast` 同例），不读被强转的 capability。

2. **中继路径没盖到**。`RejectsTemperature` 只在翻译路径被消费（`buildFor` → `build` → `buildChat`/`buildResponses`）；Chat/Responses 原样中继（`passthrough`，流式插件请求走这条）仍照带 temperature/top_p——plugins#154 的原报（Nowledge Mem，Chat 客户端）恰是这条路由。内建 catalog 模型的中继同样没设防（改动前的既有行为，顺手一起补上即闭合"模型列表说了不算"这一类）。

另外两份的测试同名同路径（`internal/gateway/plugin_temperature_test.go`），两份都要的话要改一个的名字。

这两条都在我验证过的分支里：[ggbdpq/magpie@hunt31-b-gw-plugin-temp](https://github.com/ggbdpq/magpie/tree/hunt31-b-gw-plugin-temp)（基于 ea3dee96，单提交 7aa5682b）。`TestPluginModelRefusingTemperature` 在 ea3dee96 修前红（中继带 temperature 0.7/top_p 0.9、翻译带 temperature 0.7，说不出 temperature 的对照模型保留），修后绿；消融（摘全部 4 个产品文件）回红同形；`go test -tags nogui -p 2 -timeout 45m ./internal/gateway/` 全包绿，`./internal/plugin/` 全包绿，provider 定向绿，gofmt/vet（darwin+linux nogui+windows）/三平台 build 净。以维护者取哪份（或合并两份）为准；若取 c2 版，第 1 点建议照改。

没跑什么：真实 Factory 账号端到端（本机无 Factory 订阅；factory 侧以 0.1.31 `configModels()` 的包内字节为准，已 npm 解包核对）；models hook 用 `capabilities.temperature: false` 显式声明的插件未覆盖（现网插件没有这样说的）；Gemini 中继的 `generationConfig.temperature` 未动（catalog Temperature 的语义是 OpenAI 式采样参数，Gemini 翻译路径本就不消费它）。

Generated-by: GLM-5.3-Flash (ZCode)

补丁已验证，接续前面的认领。方案即帖中 Should do，一处偏差在最后一段说明。

## 现象

插件模型（Factory、Cursor、Zen 等经插件服务的）没有 temperature 的"说不"通道：客户端发来的 `temperature`/`top_p` 原样穿过 magpie 到达插件的 fetch，OpenAI 推理模型一类的上游以 400 拒收（plugins#154 的 `factory-plugin/gpt-6.1-sol`）。factory 0.1.31 只在插件自己的 fetch 里剥，别的插件各得再剥一遍；magpie 侧没有任何插件模型级别的依据。

## 最小复现（红测试）

`TestPluginModelRefusingTemperature`（internal/gateway/plugin_temperature_test.go）：fake 插件加一个 `temperature: false` 的 config 模型（照抄 factory 0.1.31 configModels 的字面形状），带 `temperature: 0.7, top_p: 0.9` 走完整网关栈。

在 ea3dee96（无本改动）上红：

```
--- FAIL: TestPluginModelRefusingTemperature
    plugin_temperature_test.go:62: the plugin's fetch got a model that refuses them asked with temperature 0.7, top_p 0.9
    plugin_temperature_test.go:71: the translated request asked temperature 0.7 of a model that refuses it
```

两处红对应两条路：Chat 流式请求**原样中继**（passthrough）到插件 fetch 时照带；Anthropic 客户端请求**翻译**（buildChat）时也照带。说不出 temperature 的对照模型（fake-1）断言参数保留，改动前后都绿。

## 根因

三处断链，另有一处没人管的路：

1. `host.js` 的 `providers()` 把模型行交给 magpie 时没有 temperature 字段；`info()` 的 config-models 合并只把 `reasoning`/`attachment`/`tool_call`/`modalities` 并进 capabilities，`m.temperature` 被丢掉（factory 就说在这里）。
2. `plugin.Model`（internal/plugin/providers.go）没有该字段，`pluginCatalog`（internal/provider/plugins.go）因此没法填 `catalog.Model.Temperature`。
3. `provider.RejectsTemperature` 走 `Available()` 读 catalog，对插件模型永远读不到。
4. 翻译路径的 `build` 本来就消费 `RejectsTemperature`（temperature 和 top_p 一起剥，chat.go），插件模型一旦进了 catalog 即自动生效；但 Chat/Responses **原样中继**（`passthrough`）从不问它——这条路对内建 catalog 模型同样不设防。

## 修法

- `host.js`：`fromModelsDev` 带上 models.dev 的原始 `temperature`（说了才有）；`info()` 的 config 合并把 `m.temperature` 带到模型行；`providers()` 输出映射加 `temperature`（仅 boolean 时）。**有意不读 `capabilities.temperature`**：`fromModelsDev` 里 `m.temperature ?? false` 把 models.dev 的沉默强转成 false，原样透传会让所有没说 temperature 的插件模型被当成拒收——与内建路径（models.dev 沉默 = nil = 照发）在同一个模型上分叉。models hook 若想声明，用模型行上的 `temperature`（与 `free`/`rate`/`fast` 同例）。
- `plugin.Model` 加 `Temperature *bool`；`pluginCatalog` 填进 `catalog.Model.Temperature`。
- `passthrough` 的 Chat 与 Responses 分支在 `p.RejectsTemperature(model)` 时 `withoutFields(body, "temperature", "top_p")`；Codex 的 as-sent 形状（#1758）在 break 之后，不受影响。

文档随改：gateway-routing.md 的 sampling 行补一句，provider-plugins.md 加「A plugin model's sampling」。

## 验证

| 检查 | 结果 |
| --- | --- |
| 修前红 @ ea3dee96（摘全部 4 个产品文件） | 红，两条断言与上面同形 |
| 修后 TestPluginModelRefusingTemperature | 绿 |
| go test -tags nogui -p 2 ./internal/plugin/（全包） | ok |
| go test -run 'TestPlugin*' ./internal/gateway/（全组） | ok |
| go test -run 'TestRejectsTemperature|TestPluginModel|TestPluginCatalog|PluginParity|TestPlugin' ./internal/provider/ | ok |
| go test -run 'TestSampling|TestUpstreamBytes|TestPassthrough|TestRelay' ./internal/gateway/ | ok |
| go test -tags nogui -p 2 -timeout 45m ./internal/gateway/（全包） | ok |
| gofmt -l internal/ | 净 |
| go vet（darwin）；GOOS=linux vet -tags nogui；GOOS=windows vet | 净（trayimage_darwin.go 的 cgo 警告照旧） |
| go build + linux/windows build | ok |

分支：[ggbdpq/magpie hunt31-b-plugin-temp-false](https://github.com/ggbdpq/magpie/tree/hunt31-b-plugin-temp-false)（基于 upstream/main ea3dee96，单提交）。合入请保留原作者或加 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`。

## 没跑什么

- 真实 Factory 账号端到端：本机无 Factory 订阅；factory 侧行为以 0.1.31 的 `configModels()` 字节（npm 包已解包核对）和 fake 插件的同形 fixture 为准。
- models hook 以 `capabilities.temperature: false` 声明拒收的插件（不走模型行字段）：有意不覆盖，理由见修法第 4 点；现网插件没有这样说的。
- Gemini 中继上的 `generationConfig.temperature`：catalog 的 Temperature 语义是 OpenAI 式采样参数，Gemini 翻译路径本就不消费它，未扩。
- GUI（模型编辑器对插件模型显示/改 temperature 偏好）：未动，插件模型没有该编辑项。

Generated-by: GLM-5.3-Flash (ZCode)

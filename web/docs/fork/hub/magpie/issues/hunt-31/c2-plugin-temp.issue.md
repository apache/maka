补丁在 [ggbdpq/magpie@hunt31-c2-prov-plugin-temp](https://github.com/ggbdpq/magpie/tree/hunt31-c2-prov-plugin-temp)（基于 ea3dee96）。

## 现象

帖子里说的链路属实，且两条口子都在：

1. `host.js` 的 `info()` 处理 config models 时，capabilities spread 只读 `m.reasoning`/`m.attachment`/`m.tool_call`/`m.modalities`，**config 模型行的 `temperature` 键根本没被读**——Factory 0.1.31 在 config models 里写的 `temperature: false` 到这一步就丢了；
2. `host.js` 输出给 magpie 的模型行不带 `capabilities.temperature`，`plugin.Model`（internal/plugin/providers.go）也没有这个字段，`pluginCatalog`（internal/provider/plugins.go）因此不填 `catalog.Model.Temperature`，`Provider.RejectsTemperature` 对插件模型永远返回 false，gateway 的构建把 temperature/top_p 照发。

## 修法

- `host.js` `info()`：config models 的 capabilities spread 加 `...(m.temperature !== undefined ? { temperature: m.temperature } : {})`；
- `host.js` providers 输出：仿 `imageSaid` 先例加 `temperatureSaid`（有没有说）与 `temperature`（说的是不是 true），models hook 与 config 两条路都覆盖；
- `plugin.Model` 加 `temperatureSaid`/`temperature`；`pluginCatalog` 在说了的情况下填 `catalog.Model.Temperature`；
- `RejectsTemperature` 经 `Available()` 即得，gateway `buildFor` 无需改动——插件模型拒绝 temperature/top_p 后走与 catalog 模型同一条剥离路径。

## 红绿证据

新增 `internal/gateway/plugin_temperature_test.go`，fake 插件加 `$FAKE_NOTEMP`：一个 config 模型写 `temperature: false`（Factory 0.1.31 的写法），一个 models hook 模型在 capabilities 上说 false（OpenCode 原生形状），走完整 gateway 栈发 `{"temperature":0.4,"top_p":0.9,...}`，断言到达插件 fetch 的请求体。

当前 main（ea3dee96）无补丁时：

```
--- FAIL: TestPluginModelTemperatureSaidIsRead
    plugin_temperature_test.go:63: a config model saying temperature: false was asked with map[temperature:true top_p:true]
    plugin_temperature_test.go:66: a models hook model saying capabilities.temperature false was asked with map[temperature:true top_p:true]
```

带补丁转绿，且「什么都没说」的 `fake-1` 照旧带 temperature/top_p（同测试第三断言）。消融：把三个产品文件（host.js、providers.go ×2）摘回 HEAD 重放，同形红。

## 验证

| 项目 | 结果 |
| --- | --- |
| 修前红 / 消融回红 | 见上，ea3dee96 上复现 |
| 修后 | 该测试绿；`go test -tags nogui -p 2` internal/plugin、internal/provider 整包 ok，gateway 的 `Plugin\|Fake\|Moved\|Mover\|Parity` 全绿 |
| `gofmt -l` | 无输出 |
| `go vet` | darwin、`GOOS=linux -tags nogui`、`GOOS=windows` 对 plugin/provider/gateway 均通过 |
| `go build` | darwin、`GOOS=linux -tags nogui`、`GOOS=windows` 均通过 |
| **没跑的** | 没用真实 Factory 账号实测（帖子报告的 400 依据 sweanng424 的 Discord 报告与 plugins#154，测试用 fake 插件同一形状）；没测 Responses/Anthropic 协议下插件模型的剥离（`rejectTemp` 在 buildChat/buildResponses 两处生效，测试只走 Chat） |

合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>。

Generated-by: GLM-5.3-Flash (ZCode)

<details><summary>git format-patch</summary>

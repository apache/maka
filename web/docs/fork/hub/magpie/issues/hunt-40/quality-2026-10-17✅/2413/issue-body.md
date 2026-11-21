# 本地待发布修订稿：#2413

> 未发布到 GitHub。复核基线：`6f950653fcdb46c73044a071328cdc508f12ccef`，2026-10-17（澳门时间）。补丁文件为同目录 `updated.patch`，它是相对该基线的 unified diff，不代表新提交或维护者已认可。

## 来源与影响

这是一项代码审计发现，不是本人在真实 CC Switch/Alma 安装中的故障报告。当前 main 仍把 CC Switch 的 `GOOGLE_GEMINI_BASE_URL` 条目，以及 Alma 的 `api_format=gemini` 或 `type=google` 且带 base 的条目，列为不支持 Gemini 协议而跳过。

可证明的收益只限于：这类条目可以从既有导入入口保留 Gemini 地址、API key 和显式模型并落盘，省去在编辑器手工重建供应商。没有统计真实受影响用户数，不声称改善延迟或节省计费。

## 产品意图与修法

导入初版 `0b0f258c0` 有意排除了 Gemini 协议中转；不是把原设计当无意遗漏。但后来的 [#1346](https://github.com/yetone/magpie/issues/1346) / `844b9ca3` 已支持自定义 Gemini 兼容端点，维护者的说明也包含中转地址。当前 Provider 文档与 `GeminiBase`、`AuthHeaders`、模型列表路径都支持这个用途。本补丁建议把已有能力接回应用导入；“是否仍希望保留应用导入限制”留给维护者判断，不把技术上可接通等同于产品已批准。

实现沿用原补丁：`endpoints` 加 Gemini，统一校验与写入 `Provider.Gemini`；CC Switch/Alma 对应分支填入该端点；同 key 合并与首地址识别带上 Gemini；删去四条过时 skip 翻译。OpenCode 与 Alma 的原位置结构体初始化改为具名字段以适配新增字段，不改协议选择。Google 没有自定义 base 时仍走原 preset；无 key、无效 base、指向 magpie 本身和 sign-in 仍跳过。没有新增协议翻译或依赖。

## 相对原交付补齐了什么

1. 原 patch 的测试 import hunk 因 main 已有 `slices` 而冲突；本稿重新生成于固定 main，独立副本 `git apply --check` 与实际套用都通过。
2. 原回归主要检查 CC Switch 预览，Alma 没有 Gemini fixture。本稿从 `ImportSources` / `ImportFromApps` 到 `Find` 观察已保存供应商，不测试私有分支；分别证明 CC Switch、Alma 的 Gemini key/model/地址持久化、同 key 多协议合并及 reimport 状态。
3. 显式覆盖 Alma 的两条识别分支、无 key、无效地址、自指地址、Google 无自定义 base 与 sign-in 不变。

## 本轮实跑

- 原 main 既有 `TestImportCCSwitch|TestImportAlma` 通过。
- 修改 CC Switch 公开导入预期后，旧代码行为 FAIL，包含旧 Gemini skip；最小修复后通过。
- 新增 Alma Gemini 导入断言后，旧 Alma 分支行为 FAIL；改为填写 Gemini 端点后通过。
- 摘掉两个全部 Go 产品修改文件，保留新测试：CC Switch 与 Alma 均行为 FAIL；恢复产品文件后 GREEN。
- 手工移除 Gemini 同 key 合并、Alma 的 `type=google` 识别和 Gemini URL 校验，三项新测试均行为 FAIL；每次恢复相同 SHA-256，最终导入测试 GREEN（1.020s）。
- 完整 `go test -p 2 -tags nogui -count=1 -timeout 45m ./internal/provider` 通过（83.946s）。
- `go vet -p 2 -tags nogui ./internal/provider` 通过；触达 Go 文件 `gofmt -l` 无输出；现有 i18n 静态检查 3/3 通过。
- 另一独立副本套用补丁后执行回滚，五个文件的 SHA-256 恢复基线；原导入测试通过（1.075s）。

所有测试在临时 HOME 下运行，固定 GOPATH/GOMODCACHE/GOCACHE，provider 的既有 `testenv.Offline` 禁止外网。完整命令、字面输出、退出状态、消融及手工破坏记录见本地 `verification.json` / `logs/`；手工破坏最终结论以该记录为准。

## 未完成的验收

- 没有真实 CC Switch/Alma 安装、真实导出数据库、真实中转账号或本人触发的失败样本；SQLite fixture 来自当前读取器支持的字段，尚未证明真实应用全部版本 schema 兼容。
- 没有完成真实 Gemini 上游请求回合；已有 Gemini 测试是本地 httptest，不冒充真实服务验证。
- 本分支单独跑过 `./internal/provider`。四份补丁叠在同一副本上的 `go test -tags nogui ./...` 退出码 1，见 [组合结果](../integration/RESULT.md)：`internal/provider` 通过，`internal/gui` 的 `TestProxyCheckSaysAProxyPassedBy` 失败。没有全仓三平台 vet/build、真实 Linux/Windows 运行、Chromium/WebKit GUI suite。provider 包与无浏览器 i18n 检查不等同于完整合入门禁。
- 原始测试补齐期间曾误把 `ImportFromApps` 的“跳过且返回空列表”契约断言为 error；已修正测试而未改产品语义，失败日志保留。

因此这是本地改进并验证后的候选补丁，不宣称真实应用导入已验收或已达到完整合入门禁。若仍有保留该限制的产品理由，请指出；没有新增证据时不重复催促。

AI 协作披露：本轮由 Codex 协助追踪当前代码、补齐回归、执行消融与整理稿件；可解释边界为上述公开导入行为和记录的验证结果。

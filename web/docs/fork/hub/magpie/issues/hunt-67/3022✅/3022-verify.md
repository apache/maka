# #3022 hunt67 Lane B 验证轮记录（2026-10-23）

报告者独立复现回合：核实 Shane-Meng 证据 + 我方在途分支漂移 + 整合回应稿。
worktree：magpie-hunt67-b（hunt67/b，基线 be002aca，全程未提交，收口已恢复干净）。
go1.26.8 windows/amd64，GOTOOLCHAIN=auto；-race 用 mingw64 gcc + CGO_ENABLED=1。

## 1. 时间线与查重基线

- issue：xiaobaifly7 2026-10-20T05:48，0.1.1294 / Windows / DeepSeek Harness / Ollama Cloud `deepseek-v4.1-flash:1017`，redact+redactPersonal 开。
- 我方评论三轮：10-20T15:56（base 318697dc，head d6a8df9c）→ 10-20T22:53（base 0f044e94，head cd0c3e50）→ 10-21T19:59（base 9b0f4861，head `2bf5b3dc386f5b91366c93d8142c781d8ae73519`）。分支 `hunt53-f-redact-json-escape`。
- Shane-Meng 2026-10-23T02:58：独立复现（详见 §4）。
- 查重基线：开工 GET comments=4；写稿前复核 comments=4、updated=2026-10-23T02:58:59Z，无增量。

## 2. 上游脱敏层演化（9b0f4861→be002aca）

`git log 9b0f4861..origin/main -- internal/redact/` 共 4 笔（全部 2026-10-22）：

| commit | 内容 | 触及「匹配起点」？ |
| --- | --- | --- |
| b00c82ac | 每类处置（mask/warn/hold）+ Never mask list + Try it（#1977） | 否 |
| dd791524 | 用户脱敏词任意大小写开关（ZoeCats） | 否 |
| 0ddcf28a | 后端 id（UUID、32+ hex）原样放行（新文件 ids.go） | 否 |
| ec7e50b8 | 小数的数字不再单独成数被遮 | 否 |

**结论：根因未被自修。** be002aca 上 `takes(s, a, b, ok)` 签名原样（无转义保护），`mask(s, o, put)` 仍 3 参；EMAIL 规则在 `\n\n\n@` 处仍会从转义 `n` 起算（RED 实证）。
**但接口面漂移**（影响我方 patch 落地）：
- `apply` 签名 `seen func(Hit)` → `o Options`（warn/hold 政策），json.go 的 `knownSpans` 调用改传 `o`；
- 新增 `Preview` 函数（Try it，masking.go:97 → redact.go）插在 `Mask` 与 `mask` 之间，内部以新 put=`tag` 调 3 参 `mask`。

## 3. 分支漂移判定

- `ls-remote fork hunt53-f-redact-json-escape` = `2bf5b3dc` = 本地 FETCH_HEAD，与 10-21 评论一致，无新推。
- parent = 9b0f4861。format-patch → `git apply --3way --check` on be002aca：json.go 干净、scrub.go 干净、escape_test.go 新增、**redact.go 一处冲突**（约 483-500 行）。
- 冲突唯一成因：上游 `Preview` 插入落在 `Mask` 与 `mask` 签名行之间。解法（已本地验证）：保留 Preview，其 `mask(...)` 调用补第 4 参 `false`（不补则 4 参 mask 下编译不过——这是必须的适配，非可选），取我方 4 参 `mask` 签名。
- 解决后树 vs be002aca：redact.go +26/-8（我方原 4 参改造 + Preview 一行适配），json.go/scrub.go/escape_test.go 与分支 patch 逐字节相同。
- **分支 fork 上未更新**（本轮无推送授权）：维护者现在 git am 该 patch 会在 redact.go 撞同一冲突；需要第三次 rebase 落到 be002aca。

## 4. Shane-Meng 证据核实

| 论断 | 核实方式 | 结果 |
| --- | --- | --- |
| 脱敏层破坏内层 arguments 转义（EMAIL 从转义 `n` 起算、`\{` 非法） | be002aca 上探针复现（RED，§5） | **本机钉死**，损坏形态逐字符同构其描述：`\n\n\{{EMAIL_lbqbj3xb}}\n…`，反斜杠紧贴占位符 |
| 失败片段 `…possible new issue\n\n\n@pytest.ma` | 探针用同构形状（三个转义换行 + @decorator） | 形状可达，RED 复现 |
| 严格 vs 宽松上游对照（Ollama 400 / WorkBuddy·百炼 200）、803 条二分、548/549 字符截断、`\u0040` 恢复 | 需真实 Ollama Cloud/WorkBuddy 账号 | **本机不可复现，如实转述**；与机理内部自洽 |
| 「GUI 请求不脱敏」对 Ollama Cloud 无效 | 读码：`provider.SkipsRedaction`（internal/provider/unredacted.go:10-14）要求 `LocalAddresses(全部 base URL)`；Ollama Cloud 是远程 | **代码读证实** |
| 「fallback 只在 429/额度触发，400 不绕过」 | 读码：`retryable()`（internal/gateway/fallback.go:1275）：401/402/403/404/408/429/5xx 直接过；400/422 须撞 quota/unserved/refused/shape/unsaid/region 词表或 wrongEndpoint；"invalid tool call arguments" 全不撞 | **证实**（细节：400 并非绝对不可 fallback，是该错误消息不匹配任何词表） |
| 回归建议清单（\n@、\n\n@、多装饰器、Windows 路径、真邮箱混排、json.Unmarshal 断言） | 对照已落地测试 | 已盖：`\n@` 形状（RED/GREEN）、普通字符串里的 Windows 路径、同请求真邮箱仍遮。未盖（如实报）：`\n\n@` 及三连形状（守卫同一条 odd-run 路径，探针已证，但未落为分支测试）、多装饰器、arguments 内 Windows 路径（10-21 已声明证据-only）、邮箱与装饰器同串 |

## 5. RED / GREEN（be002aca，Windows 本轮实测）

RED 条件：产品文件全在 be002aca（零修复），仅放测试（分支的 escape_test.go + 临时探针 shane_probe_test.go，探针不进分支）。

```
--- FAIL: TestMaskJSONKeepsArgumentsJSON (0.00s)
    escape_test.go:31: 2 masked, want 1: {"messages":[{"role":"user","content":"write {{EMAIL_eymlaavc}} about the demo"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"pwsh","arguments":"{\"command\":\"print('before')\\{{EMAIL_daaqu6wd}}()\\ndef demo():\\n    return 1\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"done"}]}
--- FAIL: TestProbeTripleNewlineDecorator (0.00s)
    shane_probe_test.go:40: arguments no longer JSON (1 masked): {"command":"looked into a possible new issue\n\n\{{EMAIL_lbqbj3xb}}\ndef demo():\n    pass"}
FAIL
FAIL	github.com/yetone/magpie/internal/redact	0.789s
FAIL
```
（`go test ./internal/redact -run 'TestMaskJSONKeepsArgumentsJSON|TestProbeTripleNewlineDecorator' -count=1`，exit 1；全文 red-on-be002aca.txt）

GREEN 条件：3way 套 patch + 解冲突（Preview 补 `, false`）。

```
=== RUN   TestMaskJSONKeepsArgumentsJSON
--- PASS: TestMaskJSONKeepsArgumentsJSON (0.00s)
=== RUN   TestProbeTripleNewlineDecorator
--- PASS: TestProbeTripleNewlineDecorator (0.00s)
PASS
ok  	github.com/yetone/magpie/internal/redact	0.862s
```

## 6. 相称矩阵（本轮实测，Windows）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 定向 RED | `go test ./internal/redact -run 'TestMaskJSONKeepsArgumentsJSON\|TestProbeTripleNewlineDecorator' -count=1`（无修复） | FAIL，exit 1 |
| 定向 GREEN | 同上 -v（修复后） | PASS，ok |
| 整包 | `go test -tags nogui ./internal/redact/... -count=1` | ok 1.157s |
| 消费方 | `go test -tags nogui ./internal/gateway/ -run 'Redact\|redact\|Mask\|Seen' -count=1` | ok 12.846s |
| masking 门面 | `go test -tags nogui ./internal/masking/` | no test files |
| 竞态 | `go test -tags nogui ./internal/redact -race -count=1`（CGO_ENABLED=1） | ok 6.402s |
| 格式 | `gofmt -l internal/redact` | 空 |
| 静态 | `go vet -tags nogui ./internal/redact` | clean |
| 构建 | 解决树上 `go build ./internal/redact/` | ok |

**没跑**：跨平台构建（darwin/linux——本轮树与 10-21 验证树的唯一新增差异是 Preview 一行 `, false`，分支 commit 内容本身未变）；整仓 vet；GUI。分支 head 未变，10-21 的验证矩阵对该 head 仍有效。

## 7. 兄弟面（脱敏写回点全查）

be002aca 上 redact 包 `mask(` 调用点全集（修后形态）：
1. `Mask`（redact.go:480）→ `false`（纯文本路径）— patch 盖
2. `Preview`（redact.go:487，上游 b00c82ac 新增）→ `false` — **冲突解决时适配**（分支 patch 尚未含此行）
3. `scrub`（scrub.go:54）→ `false` — patch 盖
4. `MaskJSON`（json.go:399）→ `asJSON(key, "")`（唯一 jsonText=true 入口）— patch 盖

`takes(` 调用点：仅 mask 内两处（组内 spans 与单 span），均传 jsonText。`unmarked`/`Restore` 侧读同一 `asJSON`（json.go:474），未遮值原样往返。包外同名 `mask`（agent/preview.go、gateway audioForm/embeddings）无关联。公开入口唯一消费门面 internal/masking（Masker.JSON/Text/Preview）。

## 8. 缺口与不确定项

- 真实 Ollama Cloud 往返从未由我方验证（历轮同）；Shane-Meng 的 200/400 表是其环境自报。
- 分支需第三次 rebase（9b0f4861→be002aca），冲突点与解法见 §3；本轮未改分支、未推。
- 若 rebase 后把探针形状（\n\n\n@）落为正式测试，可同时覆盖 Shane-Meng 建议的一格；属分支作者后续决定。
- **本轮不自信的点**：①Preview 适配是我在解决树上手改的一行，未进分支 commit——若后续 rebase 用不同解法（如把 Preview 移到 mask 之前），行为等价但 diff 形态会不同；②「invalid tool call arguments 不撞 retryable 词表」基于报告者捕获的消息文本，Ollama Cloud 原始 body 若含 "model …invalid" 等字样（unservedWords 第一分支），fallback 行为可能不同——未拿到原始 body，不下断言；③548/549 字符截断、803 条二分的数值只能转述，机理上无反证。

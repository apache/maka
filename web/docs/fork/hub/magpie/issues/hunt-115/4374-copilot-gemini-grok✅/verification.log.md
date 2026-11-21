# #4374 Copilot Gemini 400 / Grok 422 — 验证记录

- issue: https://github.com/yetone/magpie/issues/4374
- take: https://github.com/yetone/magpie/issues/4374#issuecomment-6558400985
- 交付帖: https://github.com/yetone/magpie/issues/4374#issuecomment-6558793655
- 分支: `fix/4374-copilot-gemini-grok` @ `ced7c173f29f00292a1d817e320cea110c2bb1f5`（fork ggbdpq/magpie，base=upstream/main 85e37162e）
- patch: `0001-fix-gateway-…as-functions.patch`，SHA-256 前 16 = `35158dcf857a45ea`（git am 原样可贴）
- 开工 SHA: upstream/main `c0477aa728bf4bbedf78f404efa72eb4c7c48011`；发布前上游前进两轮（8+1 提交），无一命中 `#4374|copilot|gemini|422`；85e37162e 触及 gateway.go（行 1545/2204/2561，与本次改动 4541/4752 远隔）→ 按门禁 rebase 追平重跑定向

## 判面

- #4525/#4527（我方 landed item id 面）：input item id 超 64 字符、400 `string too long`、只咬后续轮 —— #4374 的 Grok 422 首轮即挂、Gemini 400 是 chat 翻译线，不同根因
- #4657（我方 landed Zed toolConfig 面）：插件线 Code Assist 信封大小写，不同线
- #3931（OPEN，fork 有修未进上游）：Copilot Gemini 拒绝工具 schema 的 object anyOf unions —— Gemini 半的直接根因，修法收敛到该单的对照实验证据

## 修法

1. Gemini（`copilot_gemini_schema.go` 新文件 + forwardOnce 接线）：可证不相交的 object anyOf 原地等长改名 oneOf（判据：双分支同 require 一个 string 字段且 enum/const 不相交；或一分支 require 的字段被另一分支 `additionalProperties:false` 禁出）。键 = Agent=="copilot" + geminiNamed(model) + to==Chat
2. Grok（`customOff` 预判扩展）：Copilot 前置 Grok 模型带 custom tool 时首轮即走翻译线（xAI #3392 拒 custom tools + #378 Copilot 前置 Grok 应答裸化 → 现有 learner 学不到）。键 = Agent=="copilot" + grokModel(model) + hasCustomTool(body)

## RED/GREEN（签名逐字对齐报告）

- RED（父提交 c0477aa72）：`TestCopilotGeminiTakesCodexUnionsAsOneOf` FAIL 400 `Copilot: invalid request body` 原文；`TestCopilotGrokTakesCustomToolsAsFunctions` FAIL 422 `Copilot: 422 Unprocessable Entity: Unprocessable Entity` 原文；`TestCopilotGeminiKeepsUnprovenUnions` PASS（守卫，改前改后都该绿）
- GREEN（ced7c173f）：三测全过；相邻面 `TestCopilot*`/`TestCustomTool*`/`TestCodexCustomTool*` 全过；-race 过

## 消融（先提交后消融，只回退产品文件）

1. 仅删 schema fit（forwardOnce 接线行+新文件）：Gemini 测试回红 400 原文，Grok 不受累
2. 仅 gateway.go 回退父提交（接线+customOff 同消）：双红，400/422 原文各一

## 矩阵

| 检查 | 结果 |
| --- | --- |
| 改动包全量 `go test -tags nogui ./internal/gateway` | ok 527.7s |
| gofmt -l（三文件） | 无输出 |
| vet nogui darwin / GOOS=linux / GOOS=windows | 干净 |
| build nogui darwin / linux / windows | ok（darwin cgo 警告为预存基线） |
| 发布后 GET 回读 | user=ggbdpq，正文去尾随换行后逐字节一致 |

## 兄弟面 rg 全查（改/不改理由）

- `toolOneOfAsAnyOf`（Cline/Kilo/OpenRouter，oneOf→anyOf）：反向换名、键不同家，不改
- `geminiToolTypes`（Vertex 型推断，按模型名不分家）：只插 type、anyOf 节点跳过，与改名无交互，不改；#3931 实证保留它 200 照样通过
- xAI 直连 custom tools：拒绝文可读、learner 正常学（#3392），不改
- Grok 插件线：PLUGIN-SERVED（修在插件仓），且无裸化证据，不改
- Copilot GPT/Claude：GPT 吃 custom tools（isnine 成功轮），Claude 走 Messages 翻译线，不命中新键，不改
- 失败读取语义：非法 JSON 时 gjson/Unmarshal 静默不命中 → body 原样直通，无新增吞错

## 不确定项

- Grok 422 触发字段=custom tools 是从 #3392+#378 联读的推断（帖内 Not verified 已写明）；若实为 hosted tool 等其它字段，翻译线不解决，需 Request Archive 抓上游体定位
- 无真机 Copilot Enterprise 账号可验（本机无登录）

# magpie「规则试算」Windows 真机验证报告

## 环境

| 项 | 值 |
| --- | --- |
| 仓库 / 分支 | ggbdpq/magpie，`ggbdpq-try-rule`（本地 magpie-pr1） |
| HEAD | 验证开始时 `5551b2d3c650e676fafaa470a6435d150490fcb9`（动手前 `git rev-parse` 核对一致）；验证发现的布局问题修复后经两次 amend 并入同一提交，**最终 `3ff2b31f5b251d3a994fa7f228161dae436a2ee0`，已 force-with-lease 推送 origin**（本地与 origin 一致，工作区仅剩未跟踪的 magpie-try.exe） |
| 系统 | Windows 11 build 26100 x64（Git Bash 环境） |
| Go | go1.27.0 windows/amd64 |
| 构建 | `go build -o magpie-try.exe .`（需 `GOPROXY=https://goproxy.cn,direct`，proxy.golang.org 直连超时） |
| 运行方式 | `magpie-try.exe web --addr 127.0.0.1:13430 --no-open`，`MAGPIE_ADDR=127.0.0.1:13425` |
| 沙盒 | HOME/USERPROFILE/XDG_CONFIG_HOME/XDG_CACHE_HOME 全部指向 `%TEMP%\magpie-try-home`；providers.json + settings.json 从真实配置拷入沙盒 `.config\magpie\` |
| 隔离核验 | 启动后沙盒目录新增 logins.json.lock / plugins.yml / stash.json 等状态文件；建组后分组只写入沙盒 providers.json（真实 providers.json 无 groups，真实目录全部文件 mtime 停留在启动前） |
| 真机 magpie | 全程未动：不杀进程、未写真实目录、真机继续监听 127.0.0.1:3425，沙盒实例用 13425/13430 |
| 判断模型（分类器） | deepseek/deepseek-v4-flash（界面名 DeepSeek V4 Flash，真实小模型） |
| 测试组 | 「试算验证」id=`group`：成员 deepseek/deepseek-v4-pro（第 1）+ zhipu/glm-5.3-flash（第 2）；规则 1：意图是 "a hard task" → DeepSeek V4 Pro；分类器 DeepSeek V4 Flash |
| 无规则对照组 | 「无规则组」id=`group-2`（CLI `group add` 创建，成员同上，无规则、无分类器） |

## 用例表

| # | 入口 | 输入文本 | 判断模型回答（原话） | 命中规则 / 去向 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | GUI zh 编辑器 Try 框 | Optimize this O(n^3) algorithm in our payment core and keep the tests green — this is a really hard task | 「deepseek/deepseek-v4-flash 判断第 1 轮属于 "a hard task" 中的"a hard task"（用时 791 毫秒）」 | 规则 1 命中 → DeepSeek V4 Pro 先接，失败才轮到组内其他成员 | 附注「真实请求还取决于会话保持、成员休息和各成员的上下文窗口」；无压缩/文件夹注记 |
| 2 | GUI zh | What's the weather like today in Shanghai? | 「判断第 1 轮不属于 "a hard task" 中的任何一个（用时 763 毫秒）」 | 无规则命中，按组原本的顺序路由 | 同上附注 |
| 3 | GUI zh | 帮我设计一个高并发的分布式消息队列，要考虑一致性和分区容错，这是个非常难的任务 | 「判断第 1 轮属于 "a hard task" 中的"a hard task"（用时 784 毫秒）」 | 规则 1 命中 → DeepSeek V4 Pro | 中文输入判断正常 |
| 4 | GUI en（切语言后） | Refactor the payment core and shave this O(n^3) algorithm — a really hard task | 「was asked which of "a hard task" turn 1 is, and said "a hard task" (in 548 ms)」 | Rule 1 would match — DeepSeek V4 Pro would go first | 英文文案完整；另有一次误点开「试算验证」编辑器跑的 "Help me plan a wedding budget spreadsheet" → 不命中（632 ms），属操作失误非产品问题 |
| 5 | GUI en，无规则组 | Help me plan a wedding budget spreadsheet | 未调分类器（立即返回） | 「This group decides nothing: it has no rules but pauses, or none at all.」 | 中文界面等价文案见 CLI #8 |
| 6 | CLI（server 在跑旁路执行） | `magpie-try.exe group try group "Refactor the payment core and shave this O(n^3) algorithm — a really hard task"` | `✓ the classifier deepseek/deepseek-v4-flash says: a hard task` | `✓ rule 1 intent "a hard task" → deepseek/deepseek-v4-pro` | 墙钟 1.079s（含进程启动）；完整输出见下 |
| 7 | CLI | `magpie-try.exe group try group "What's the weather like today in Shanghai?"` | `✓ the classifier deepseek/deepseek-v4-flash says none of the intents` | `no rule matched: the group's order stands` | 墙钟 0.792s |
| 8 | CLI，无规则组 | `magpie-try.exe group try group-2 "Anything at all"` | 未调分类器 | `magpie: 无规则组 decides nothing: it has no rules but pauses, or none at all`（exit=1，0.294s） | 无规则时客户端快速失败，不浪费分类器调用 |

CLI #6 完整输出：

```
✓ the classifier deepseek/deepseek-v4-flash says: a hard task
✓ rule 1 intent "a hard task" → deepseek/deepseek-v4-pro
```

CLI #7 完整输出：

```
✓ the classifier deepseek/deepseek-v4-flash says none of the intents
no rule matched: the group's order stands
```

## 截图清单

均在 `C:\Users\ggbdpq\AppData\Local\Temp\magpie-try-home\shots\`：

| 文件 | 内容 |
| --- | --- |
| `try-zh-wide.png` | zh 界面 1280×800，规则行 + Try 框 + 命中结果（用例 3 结果在场） |
| `try-zh-narrow420.png` | zh 界面 420×900 窄窗，同区域，结果占满全宽可读 |
| `try-en-wide.png` | en 界面 1280×800，规则行（asks for "a hard task" → DeepSeek V4 Pro）+ Try 框 + 命中结果 |
| `trace-zh.png` | zh 界面 Routing 页请求列表：5 次请求全部带「路由分类器」徽标（deepseek/deepseek-v4-flash，实际 deepseek-flash，539–788ms，$0.000），账号统计仅分类器模型；下方两组卡片（试算验证 group、无规则组 group-2） |
| `try-zh-wide-fixed.png` | A2 修复后 zh 宽窗 1280×800：结果块跨全宽（实测 989px），三行结果完整可读 |
| `try-zh-narrow420-fixed.png` | A2 修复后 zh 420×900 窄窗：结果 353px 占满全宽，与修复前一致不受影响 |

规则行四语言检查：zh 规则行显示「意图是 a hard task → DeepSeek V4 Pro · DeepSeek」，en 显示「asks for "a hard task" → DeepSeek V4 Pro · DeepSeek」；输入框、按钮、结果三行在 zh/en 均有完整翻译。zh-TW / ja / de 未逐一切换实测，但代码层面 i18n.js 无 "Try" 键（见异常 A1），四种非英语语言同样会裸露 "Try"。

## 异常清单

1. **A1 · i18n（轻微）**：Try 区的分区标签在中文界面显示为未翻译的英文 **"Try"**（`internal/gui/assets/plugins/routing/client.js:5372` 的 `t("Try")` 在 i18n.js 里没有对应键）。Try 框占位符、按钮、结果文案均已翻译，唯独这 3 个字母裸奔。zh-TW / ja / de 同样受影响。
2. **A2 · 布局（已修复 ✅）**：宽窗下试算结果块被挤成窄列竖排——1280px 视口实测 `.hint` 宽 **72px**（`.editor` 网格标签列），而同一表单的输入框宽 903px；中英文均复现，420px 窄窗正常。**修复**（已并入提交 `3ff2b31f`）：`routing.css` 增加一行 `.rt-gedit > .hint { grid-column: 1 / -1; }`（照 `.editor .off-note` 的既有全宽模式），并在 `routing-rule-try.test.cjs` 新增布局断言用例（结果块宽度 ≥ 输入行宽度 ×0.9）。验证：TDD 先红（`said:72, row:732`）后绿（该文件 chromium 8/8）；触及组编辑器的 17 个回归文件 116/116 绿；i18n-keys 3/3 绿；重建 exe 后真页面复测 zh 宽窗结果块 989px、420 窄窗 353px 不受影响（截图 `try-zh-wide-fixed.png`、`try-zh-narrow420-fixed.png`）。WebKit 本机未装浏览器未跑，作者环境可补。
3. **A3 · 文案（供确认）**：只有一个意图时，命中结果读作「判断第 1 轮属于 "a hard task" 中的"a hard task"」，"X 中的 X" 重复拗口（en 版 "which of "a hard task" turn 1 is, and said "a hard task"" 同样冗余）；意图多时该句式才通顺。
4. **A4 · 语义（供确认，非缺陷）**：任务预期「判断调用只进用量，agent 标为 magpie-router」。实测：(a) Routing 页实时 trace **会**显示分类器调用行，但每行带独立「路由分类器」徽标，明确标注「magpie 自行发起的调用（路由分类器），不属于对话轮次」，费用 $0.000；(b) 用量记录（沙盒 usage.jsonl）字段为 `agent: "magpie"`、`kind: "routing"`，没有字面 "magpie-router"——`magpie-router/1` 实际是分类器对厂商请求的 User-Agent（`internal/gateway/user_agent.go` 的 magpiesOwn）。成员模型（DeepSeek V4 Pro / GLM-5.3-Flash）在整个验证过程中 **零请求、零用量记录**，红线实质成立。
5. **环境备忘（非产品问题）**：proxy.golang.org 在本机不可直连，构建需 `GOPROXY=https://goproxy.cn,direct`；Go 编译一次通过，无 Windows 特有构建问题。

## 结论

**可用。** 命中 / 不命中 / 中文 / 无规则边界 / GUI+CLI 双入口 / 旁路真机全部符合预期，沙盒隔离与真机共存无一处越界。验证中发现的宽窗布局挤压（A2）已修复、测试锁定并 amend 进提交 `3ff2b31f`（已强推 origin）；仍开放的有："Try" 标签四语言缺翻译（A1，等作者定词）、文案句式 A3 与 trace/用量语义 A4 供作者确认。

## 附：现场遗留

- 沙盒服务仍在运行（修复后重建的 exe）：页面 http://127.0.0.1:13430/?k=e464ee7175411f027ce4ace2ddb6090f（网关 13425），进程 PID **41420**（首次验证的旧进程 PID 2136 已终止换新），确认后可直接结束；沙盒目录 `%TEMP%\magpie-try-home` 可整体删除。注意你本机已安装的 magpie 客户端是旧版，布局修复要等分支合并发版后才会带上。
- 提交状态：修复（routing.css +2、routing-rule-try.test.cjs +11）已 amend 进 `3ff2b31f` "routing: try a group's rules on a message before saving them"，正文末段同步更新为 Windows 实际验证情况，已 force-with-lease 推送 origin。
- 构建产物 `E:\cc\guahub\fork\magpie-hub\magpie-pr1\magpie-try.exe`（未跟踪文件，未提交）。

# 01-AI-IDE与Agent工程工作流

> 由 6 份 AI 对话沉淀合并。整理目标是保留可复用事实、决策与验证结果，压缩聊天过程。

## 核心沉淀

- AI IDE 的长期配置应把 MCP、Skill、上下文治理和用量观测拆成独立能力，先验证工具真实 schema/CLI，再固化配置。
- Chrome DevTools 与 Figma MCP 要区分远程/本地模式和实际参数；复杂问题优先通过新会话或 Git worktree 隔离上下文，避免继续堆叠失效历史。
- 不同 AI IDE 的 Skill 调用语法不完全一致，应维护一份工具级速查，不把某一家的命令格式当成通用标准。
- token 统计工具存在版本、采集源和平台差异，安装成功不代表覆盖所有 AI IDE，先明确采集边界。
- stdio 型 MCP 接入是同一套模板：`mcp.servers` 条目 + 环境变量 token + 同进程 JSON-RPC 四步握手验证；MCP 工具名后缀每进程动态生成，必须每会话现查，禁止硬编码。
- Codex 的 memory 与 AGENTS.md 是两层：memory 落盘文件按需加载，「四工件」等运行时协议是上层工具注入，本地禁用规则不保证覆盖平台注入。

## 来源与整合内容

### 来源：ZCode配置ChromeDevTools与Figma官方MCP服务器.md

### 二、最终结论

- **chrome-devtools MCP：已配置并端到端验证通过**。用户级配置 + 真实 MCP 协议握手探测（initialize → tools/list）返回 41 个工具，内存分析套件 12 个工具齐全。
- **Figma MCP：已配置远程官方服务器**（`https://mcp.figma.com/mcp`，HTTP 传输），端点网络可达（探测返回 401 = 待 OAuth），但**能否走通取决于两个未验证项**：ZCode 是否实现 MCP OAuth 浏览器授权流，以及 Figma 远程服务器的客户端白名单是否放行 ZCode（官方文档称仅目录内客户端可连，ZCode 不在列）。
- 两项均配置在**用户级**：覆盖所有工作区，自然包含当前项目；项目级不重复配置（同名时用户级覆盖项目级，重复即死配置）。

### 一、问题背景与目标

用户读了 Google 官方 `chrome-devtools-mcp`（ChromeDevTools/chrome-devtools-mcp）的推广文章，要求：
1. 在 ZCode 中配置 chrome-devtools MCP（浏览器内核级调试：语义快照、性能 Trace、V8 堆快照、SourceMap 还原）；
2. 在当前项目（AI 美管家）可用；
3. 追加需求：接入 Figma 官方 MCP（参考 figma.com/mcp-catalog）。

本机起点：**零 MCP 配置**——`~/.zcode/cli/config.json` 不存在，项目里没有 `.zcode/` 也没有 `.agents/mcp.json`。

### 关键决策与理由

1. **Windows 下命令包 `cmd /c npx`**：Node ≥18.20 直接 spawn `.cmd`（npx 实为 npx.cmd）会抛 EINVAL；`cmd /c` 在「shell 包裹」和「直接 spawn」两种客户端实现下都能工作，是 Windows MCP 配置的标准安全写法。
2. **省略文章推荐的 `--browser-url=http://127.0.0.1:9222`**：该参数要求先手动以调试端口启动 Chrome，否则每次工具调用都连接失败，不适合做默认值。不配时 MCP 自己拉起独立 Chrome 实例（持久 profile 在 `~/.cache/chrome-devtools-mcp/chrome-profile`，不污染日常浏览器）。日后要接管带登录态的 Chrome 再加 `"--browserUrl=http://127.0.0.1:9222"`。
3. **保留 `--memoryDebugging`**：实测已是正式参数（别名 `--experimentalMemory`），启用后返回 12 个内存工具（take/compare_heapsnapshot、支配树、保留路径等）。
4. **只配用户级不配项目级**：用户级覆盖一切工作区；同名双配 = 项目级永远被压制，是死配置。

### 六、踩坑经验

1. **配置文件会被 ZCode 客户端回写**：GUI 里操作 MCP 开关（Settings → MCP）后，客户端会重写 `config.json`——重排 args 数组格式，并把开关状态固化为 `"enabled": false/true`。导致 Agent 上次写入的文件状态失效，**Edit 前必须重新 Read**，否则报 "File has been modified since read"。用户截图里 chrome-devtools 开关呈关闭态，就是客户端写入了 `enabled: false`（也可能是客户端对新服务器的默认值），需显式改回 `true`。
2. **推广文章的参数名不可作为配置依据**：Figma 文章写的 `--browser-url` 与真实参数 `--browserUrl` 不一致；唯一权威是 `npx <包名> --help` 的实测输出，配置前先跑一遍。
3. **Windows 下 MCP 服务器命令写 `cmd /c npx`**：规避 Node spawn `.cmd` 的 EINVAL；Git Bash 里手工测试时写 `cmd //c`。
4. **用户级 + 项目级同名 MCP 是死配置**：覆盖顺序用户级 > 项目级，项目级条目永远不生效。
5. **ZCode MCP schema 严格**：多余字段整个服务器被静默丢弃且无报错提示，写配置只用文档列出的字段。

### 九、可迁移的通用经验

- **任何 MCP 接入的标准动作序列**：查客户端配置体系（scope 文件与 schema）→ `--help` 核实服务器真实参数 → 写最小合法配置 → 脱离客户端做协议级探测（stdio 用 JSON-RPC 管道、http 用 curl 打 initialize）→ 重启客户端看状态。探测先行能把"配置错了"和"客户端不支持"两类问题解耦。
- **HTTP 型 MCP 的 401 探测法**：`curl -X POST <url>` 带 initialize 报文，返回 401 = 网络通、差认证；连接拒绝/超时 = 网络或端点问题。
- **官方 MCP 服务器的三类隐性门槛**：传输类型（stdio/http）、认证方式（OAuth 不可用 PAT 模拟）、客户端白名单——选型前先核对，别只看功能列表。
- **配置型任务的"权威来源"纪律**：教程/文章的参数名、菜单路径一律实测核实（`--help`、真实抓取官方文档页），本对话两处文章与实际不符。
- **客户端 GUI 与配置文件是双向通道**：GUI 操作会回写文件，Agent 改文件前必须重读；反之文件改动也要重启客户端才生效。

### 验证结果

`POST https://mcp.figma.com/mcp` 带 initialize 报文 → **HTTP 401（2.9s）**：网络可达，401 为预期的未认证响应。认证链路只能等 ZCode 重启后实际发起 OAuth 才能验证。

### 七、已完成事项

1. chrome-devtools MCP 用户级配置完成，MCP 协议握手探测通过（41 工具）。
2. Figma 远程 MCP 用户级配置完成，端点可达性验证通过（401 待 OAuth）。
3. chrome-devtools 的 `enabled` 从客户端误写的 `false` 恢复为 `true`。
4. 排明 Figma 远程/本地两条路线的前提、端点、席位要求；确认本机无 Figma 桌面版。

### 来源：CodexCursor上下文窗口超限问题与新工作树worktree解决方案.md

### 核心结论

1. 报错含义：模型上下文空间耗尽。解决路径二选一：新建对话线程，或者派生新工作树。
2. 「派生到新工作树」是Git Worktree能力在Codex/Cursor里的封装，会复制当前项目代码快照，**生成全新空白AI对话上下文**，不会继承旧对话的超限历史，完美解决上下文溢出，同时保留完整项目代码环境。
3. 新工作树是独立副本，改动不会污染原项目，修改完成后可通过Git合并代码回主项目。

### 背景与问题

在使用Codex（Cursor）AI编辑器开发小程序项目`homing-miniapp-brand`，执行骨架屏bones生成任务时，出现报错：

> Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.

**问题本质**：当前对话上下文总量超出模型上下文窗口上限，AI无法继续接收指令、读取项目文件执行任务。 项目任务背景：调研小程序全局骨架屏组件，基于小程序构建产物，探测微信开发者工具CLI路径，生成临时bones.json，追加文档记录，**不修改原src/bones、不执行git add**。

### 有效方案

### 方案：派生到新工作树（本次选用方案）

1. 在超限对话右键菜单，点击【派生到新工作树】
2. 工具自动执行：创建Git worktree，复制项目文件，生成独立目录，启动**全新对话** 日志示例：`Worktree created at C:\Users\802165\.codex\worktrees\d75f\homing-miniapp-brand`
3. 在新工作树对话，重新下发任务指令，继续原来的开发工作，不再触发上下文超限。
4. 任务完成：按需把代码变更合并回原仓库；临时工作树用完后可清理。

### 备选方案：直接新建对话

- 优点：操作快，不生成额外项目副本，不占用磁盘
- 缺点：需要手动复述需求、粘贴关键代码和项目背景，容易丢失上下文信息

### 踩坑与错误认知

❌ 错误认知：派生新工作树只是单纯新建对话。 ✅ 纠正：它不仅重置AI对话，底层创建独立Git工作目录，代码文件是项目快照副本。

❌ 错误认知：新工作树的修改会直接改动原项目。 ✅ 纠正：两者目录独立，改动互不影响，需要手动git合并。

### 后续建议

1. 在新工作树会话下发任务指令，继续小程序骨架屏bones生成流程；
2. 完成开发后，将需要保留的代码变更合并回原始项目；
3. 不再需要该临时工作树时，执行git命令删除，避免占用存储空间；
4. 后续长任务，提前拆分对话，预防上下文溢出。

------

> 文件说明：本次记录Codex上下文超限的报错解读、两种解决方案对比，Git worktree在Cursor中的用法，适用于前端项目使用Cursor做长流程工程化任务时排查同类上下文溢出问题。

需要我把这份内容直接导出成`.md`文本，你复制保存到本地吗？

### 来源：各AI IDE Skill调用命令语法对比整理.md

### 核心结论

1. 主流新一代AI Code Agent绝大多数采用 **`/` 斜杠命令** 来触发Skill专项工作流；仅旧版OpenAI Codex使用`@`作为技能触发前缀（已淘汰）。
2. Cursor是二分设计：`@` 用于**引用代码上下文/文件**，`/` 用于**执行技能工作流**，二者职责分开；其余工具大多不再区分两套符号，文件路径直接跟在斜杠命令后面作为参数。
3. 所有工具都支持自定义Skill/Agent，且各自有项目级配置目录，方便团队/个人存放自定义指令集。

### 背景与问题

不同AI代码IDE（Cursor、Claude Code、Trae、Zcode、Qoder、Lingma、Antigravity、CodeBuddy、Kimi、旧Codex）的Skill/Agent调用前缀、文件引用语法、自定义技能存放目录不统一，容易混淆，需要统一梳理对比，方便日常写指令、自定义Agent。

### 有效方案

1. 跨AI IDE写通用指令：优先使用自然语言描述任务；如果要写斜杠命令，注意区分Cursor特殊的`@`上下文语法。
2. 自定义技能迁移：不同IDE的Skill文件不能直接互通，需要按对应IDE的目录规范存放。
3. 快速记忆口诀：**现代AI代码IDE用/干活，Cursor用@找文件，老Codex@已经过时**。

### 踩坑与错误认知

1. ❌ 误区：`@`是通用技能触发符号。✅ 纠正：`@`在Cursor只是上下文引用；只有老Codex用`@`执行skill，现已废弃。
2. ❌ 误区：所有AI IDE都支持`@codebase`。✅ 纠正：仅Cursor支持`@codebase`全库检索，其他IDE不识别这个标记。

### 后续建议

1. 建立个人速查表，放在开发项目文档里，快速查阅各IDE斜杠命令。
2. 若要做跨IDE统一Agent封装，可以在自己的脚本层做语法翻译，向上提供统一接口，向下适配各AI IDE的slash命令。
3. 持续关注各IDE更新，部分工具会调整斜杠命令与自定义技能的目录规范。

> 文档说明：剔除闲聊内容，仅保留技术语法、对比表与实操经验，适合作为个人技术笔记长期检索。

这份技术资料可以长期保存，方便你后续在不同AI IDE编写Agent指令，需要我把它导出为纯Markdown文本，你直接复制保存到本地文件吗？

### 来源：tokenusage 安装踩坑与适用范围排查记录（Windows）.md

### 核心结论

1. npm安装的`tokenusage@1.5.2`为阉割版本，**没有`init`/`start`子命令**，之前提供的init/start命令属于Rust完整二进制版本，不适用于npm包。
2. `tokenusage`**仅支持读取Cursor、Claude Code、Antigravity等IDE内置AI插件本地日志**，**不支持CC-Switch中转代理的API请求统计**。
3. 工具面板显示`Tokens=0`不是安装故障，是数据源不匹配，即使安装成功，也无法捕获CC-Switch的Token消耗。
4. npm的`allow-scripts`警告仅为安全提示，不影响程序运行，无需反复配置。

### 背景与问题

在Windows环境，尝试安装`tokenusage`（tu）终端Token统计工具，希望统计通过CC-Switch产生的大模型Token消耗。
遇到一系列问题：npm包拼写404、allow-scripts警告、命令不存在、面板持续显示Tokens=0无数据。

### 有效方案

### 1. 安装命令修正
- 错误：`tokeusage`（拼写缺失字母n，报404 Not Found）
- 正确：`npm install -g tokenusage`
> allow-scripts警告无需强制处理，不影响tu命令执行。

### 2. 查看当前工具可用命令
```bash
tu --help
```

### 3. 实时查看面板（npm阉割版可用）

```
tu live
tu today
```

### 4. CC-Switch用量统计替代方案

1. 优先：使用CC-Switch自带「Usage」用量面板，直接查看所有中转API的Token与费用。
2. 备选工具：`ccusage`，适配CC-Switch代理日志解析。

```
npm uninstall -g tokenusage
npm install -g ccusage
ccusage today
```

### 《tokenusage 安装踩坑与适用范围排查记录（Windows）.md》

```

### tokenusage 安装踩坑与适用范围排查记录（Windows）

## 背景与问题
在Windows环境，尝试安装`tokenusage`（tu）终端Token统计工具，希望统计通过CC-Switch产生的大模型Token消耗。
遇到一系列问题：npm包拼写404、allow-scripts警告、命令不存在、面板持续显示Tokens=0无数据。

## 核心结论
1. npm安装的`tokenusage@1.5.2`为阉割版本，**没有`init`/`start`子命令**，之前提供的init/start命令属于Rust完整二进制版本，不适用于npm包。
2. `tokenusage`**仅支持读取Cursor、Claude Code、Antigravity等IDE内置AI插件本地日志**，**不支持CC-Switch中转代理的API请求统计**。
3. 工具面板显示`Tokens=0`不是安装故障，是数据源不匹配，即使安装成功，也无法捕获CC-Switch的Token消耗。
4. npm的`allow-scripts`警告仅为安全提示，不影响程序运行，无需反复配置。

## 关键知识
### tokenusage 采集原理
该工具为本地日志解析器，**被动读取IDE内置AI写入本机的会话日志**，不是全局网络抓包。
支持源：`claude`(Cursor / VSCode Claude Code)、`codex`、`antigravity`、heartbeat。
**不支持API中转代理工具（CC-Switch）**，CC-Switch的请求不会生成tokenusage可识别的本地日志。

### 两个版本差异
1. npmjs版本：`tokenusage@1.5.2`，阉割版，可用命令：`today/daily/activity/live/claude/codex`，**无init/start后台监控**
2. crates.io Rust原版：完整功能，拥有`init/start/stop`后台采集命令，需要Rust环境，通过`cargo install`安装

## 有效方案
### 1. 安装命令修正
- 错误：`tokeusage`（拼写缺失字母n，报404 Not Found）
- 正确：`npm install -g tokenusage`
> allow-scripts警告无需强制处理，不影响tu命令执行。

### 2. 查看当前工具可用命令
```bash
tu --help
```

### 3. 实时查看面板（npm阉割版可用）

```
tu live
tu today
```

### 4. CC-Switch用量统计替代方案

1. 优先：使用CC-Switch自带「Usage」用量面板，直接查看所有中转API的Token与费用。
2. 备选工具：`ccusage`，适配CC-Switch代理日志解析。

```
npm uninstall -g tokenusage
npm install -g ccusage
ccusage today
```

## 重要细节

1. `tu today`可以正常渲染终端面板 = **安装已经成功**，Tokens=0 ≠ 安装失败。
2. 管理员权限：npm全局安装不需要管理员；cargo编译Rust二进制、读取IDE缓存日志时才需要管理员CMD。
3. 报错 `unrecognized subcommand 'init'`：是npm版本包本身没有这个子命令，不是输错命令或权限问题。

## 踩坑与错误认知

1. ❌ 错误认知：以为`tu init`是通用初始化命令，所有版本都支持。 ✅ 事实：init仅Rust(cargo)完整版拥有，npm包没有。
2. ❌ 错误认知：工具可以捕获任何API请求，包含CC-Switch代理调用。 ✅ 事实：只读取特定IDE本地日志，代理转发的网络请求无法抓取。
3. ❌ 错误认知：npm的allow-scripts警告=安装失败，必须修复。 ✅ 事实：只是npm安全策略警告，工具能正常运行，可忽略。
4. ❌ 错误认知：Tokens=0是后台监控没启动。 ✅ 事实：npm阉割版本身就没有后台监控，同时CC-Switch不在支持范围内。

## 可复用经验

1. 安装npm工具前，优先执

> 此节原文较长，已在整理版中截取关键部分。

### 来源：ZCode接入Apifox MCP接口文档服务.md（2026-09-23）

- 配置落点 `C:\Users\802165\.zcode\cli\config.json` 的 `mcp.servers`（不是 `mcpServers`）；条目「美业鸿溟平台 - API 文档」：`cmd /c npx -y apifox-mcp-server@latest --project-id=8699553 --branch-id=8614461`，token 存 `env.APIFOX_ACCESS_TOKEN`（`afxp_` 前缀，文档不复写值）。
- 验证：同进程 JSON-RPC 四步 initialize → notifications/initialized → tools/list → tools/call，成功拉到项目 8699553 的 OpenAPI 3.1（服务端 v0.0.17，3 个工具）。
- 关键坑：MCP 工具名后缀每进程动态生成（如 `read_project_oas_v24e1u`），跨进程复用报 -32602——每会话现查，禁止硬编码；占位符 token 会产出「能握手拉不到文档」的半成品。
- 用法：配置仅对新会话生效，自然语言触发，无斜杠命令。

### 来源：Codex全局记忆机制与四工件事务流程来源及禁用.md（2026-09-04）

- Memory 结构：`memory_summary.md` 每轮摘要、`MEMORY.md` 按需主索引、`extensions/ad_hoc/notes/` 补充材料；`AGENTS.md` 是本地协作指引，不等于系统提示词。
- 「MODIFIED_FILE/DIFF_FILE/VERIFICATION.txt/ROLLBACK.sh 四工件」协议在本机 .codex 规则与 Skill 中均无定义，判定为会话运行时上层工具注入；已在 `C:\Users\802165\.codex\AGENTS.md` 落禁用约定（普通文件修改改用 Git diff+备份+测试等最小可回滚证据）。
- 同日新增消融记忆：实现后按原验收标准裁决删留复杂度；memory 全量备份 `E:\ggbdpq\codex-memory-backup-20260904-105800\memories`（232 文件，robocopy 返回码 1 是成功复制）。

## 使用建议

- 后续继续开发或研究时，先以实际代码、最新接口契约、官方文档和运行证据复核本文中的时效性事实。
- 新对话只补充新增结论或修正文档已有结论，避免再次创建同主题平行文档。

# Plan

目标是先把 Prism 当作一个云端 LaTeX/AI 工作台来学习和建模，再在只使用本人已登录会话、只操作自己项目的前提下，做一个本地调用工具原型。当前公开可核验信息只证明 Prism 是 OpenAI 的免费 AI-first LaTeX/scientific workspace，集成 ChatGPT/Codex，并提供 LaTeX 编写、协作、AI 辅助、引用、渲染等能力；截图里的接口、额度池和 GPT-6 Astra Extra High 说法只作为待验证线索，不作为事实或实现授权。

## Scope
- In:
  - 学习 Prism 的产品形态、网络调用链、项目/文件/渲染/AI 助手流程。
  - 设计一个本地 Prism 调用工具的学习路线：先浏览器观察，再端点建模，再最小 CLI/MCP 风格封装。
  - 按需使用 `C:\Users\ggbdpq\.ai\categories\06-安全与逆向工程` 下的 skill：首选 `reverse-skill-router` 路由，实际重点是 `js-reverse`、`browser-automation`、`api-security`，必要时补 `llm-security` 与 `docs-generator`。
  - 所有实验限定在本人账号、本人项目、可手动在 Prism UI 完成的动作内，并保留可回滚/可删除的测试项目。
- Out:
  - 不做额度绕过、权限绕过、隐藏模型滥用、账号/Token 导出、他人项目访问、批量消耗资源或规避风控。
  - 不把截图里的社交媒体说法当成官方 API 文档；没有官方稳定 API 前，不承诺长期可用。
  - 不先写生产级客户端；先完成学习、证据、接口契约和最小可替换原型。

## Action items
[ ] 建立事实基线：记录官方来源中已核验的 Prism 能力、入口 `https://prism.openai.com/`、OpenAI Prism 产品页描述，以及截图中的未验证线索；输出 `docs/facts-and-claims.md`，明确“事实 / 推断 / 未验证”。

[ ] 设定授权边界：创建只读/低风险实验策略，使用新建测试 Prism 项目、测试 LaTeX 文件和无敏感内容；约定所有日志自动脱敏 Cookie、Authorization、CSRF、项目 UUID、邮箱、文件内容片段。

[ ] 路由逆向 skill：用 `reverse-skill-router` 做入口判断；本任务是 Web 前端与接口观察，PRIMARY 选 `js-reverse`，辅助选 `browser-automation` 做登录后页面观察，选 `api-security` 做端点契约与鉴权/错误边界梳理；若后续要评估 Prompt/工具调用风险，再引入 `llm-security`。

[ ] 观察 Prism UI 主链路：手动登录 Prism 后，用浏览器 DevTools/Playwright/agent-browser 观察从“创建项目 → 上传文件 → 编辑 LaTeX → 渲染 PDF → 调用 AI 助手 → 查询状态”的 Network 请求、initiator、headers、payload、response shape，并保存脱敏 HAR。

[ ] 验证截图端点线索：逐一核对截图中的候选端点是否真实出现，包括 `POST /api/projects`、`GET /api/project-access?d=UUID`、`POST /api/codex/conversation-history`、`POST /api/llm/response_with_tools_start`、`POST /api/llm/response_with_tools_status`、`POST /s/sandboxes/proxy/render`、`GET /s/sandboxes/proxy/render-status?waitMs=10000`、`POST /api/project-files/upload`、`PATCH /api/projects/{uuid}/thumbnail`；每个端点只记录本人项目样本。

[ ] 建立接口契约表：为每个确认端点写 method、path、用途、必需 header、body schema、response schema、状态轮询规则、错误码、幂等性、重试策略、敏感字段和 UI 对应操作；输出 `docs/prism-endpoint-map.md`。

[ ] 设计本地工具架构：先做 Node/TypeScript CLI `prismctl`，通过 Playwright persistent context 复用本机已登录浏览器会话，不在配置文件里保存明文 Token；核心模块拆成 `session`、`projects`、`files`、`render`、`assistant`、`redaction`、`fixtures`。

[ ] 实现最小原型顺序：先支持 `whoami/session-check`、`list/create project`、`upload file`、`render start/status`；AI 助手相关接口放到第二阶段，因为它最可能涉及模型、额度和产品策略变化。

[ ] 添加验证与回归：用脱敏 fixtures 写契约测试；用一个临时 Prism 项目做端到端 smoke test；每次运行后比较 UI 行为和本地工具结果，记录状态码、响应字段、渲染产物是否一致；失败时先更新契约，不盲目补环境。

[ ] 做风险与变化控制：加入速率限制、指数退避、只读默认模式、确认后才执行上传/创建/删除、日志脱敏、session 过期提示、端点 404/403/429 的降级说明；把“官方未公开 API，可能随时变化”写入 README。

[ ] 输出学习成果包：整理 `README.md`、`docs/prism-endpoint-map.md`、`docs/reverse-notes.md`、`docs/known-risks.md`、`fixtures/redacted/*.json`、`src/prismctl/*`，并写清楚如何从原型切换到未来可能出现的官方 Prism API。

## Suggested timeline
- Day 1: 官方资料核验、截图线索归档、授权边界和脱敏规则。
- Day 2: 浏览器观察完整 UI 主链路，保存脱敏 HAR 与请求清单。
- Day 3: 端点契约表第一版，验证创建项目/访问权/上传/渲染链路。
- Day 4: `prismctl` 架构骨架和 session-check/list/create/upload/render 最小 CLI。
- Day 5: 契约测试、fixture 脱敏、错误码和轮询状态处理。
- Day 6: AI 助手链路只做低频手动验证，确认是否能安全封装 start/status，不验证“无限额度”说法。
- Day 7: 文档、风险清单、可复现实验步骤、下一轮产品化决策。

## Skill routing notes
- `create-plan`: 用其模板约束本文件结构，但本次按你的明确要求把计划写入磁盘。
- `computer-use`: 已加载；当前阶段不需要直接控制 Windows App，后续若要操作浏览器/桌面 GUI，再按 Computer Use 初始化和确认规则执行。
- `grilling`: 适合下一轮把设计树继续拷问清楚；本文件先给可执行学习计划。
- `js-reverse`: 用于观察 Prism 前端脚本、XHR/fetch、initiator、运行时参数和本地最小复现。
- `browser-automation`: 用于打开 Prism、登录后页面操作、截图和请求触发；不猜元素引用，先 snapshot。
- `api-security`: 用于把端点契约、鉴权边界、状态码和错误处理整理成可验证表；不做攻击性测试。

## Open questions
- 你最终想要的本地工具形态是 CLI、MCP server、还是带 Web UI 的本地代理？推荐先 CLI，再抽象成 MCP server。
- 你是否接受“只复用本机浏览器已登录会话，不导出、不持久化明文 Token”的实现约束？推荐接受，这样风险最低。
- 第一版是否只覆盖项目/文件/渲染，不封装 AI 助手调用？推荐第一版暂缓 AI 助手，先把基础链路跑稳。

## Verified sources
- OpenAI Prism 产品页：<https://openai.com/prism/>
- Prism 应用入口：<https://prism.openai.com/>

---
status: reference-only
original_path: "06-个人材料/14-关天豪-clife-AI项目经验-草稿.md"
migration_date: 2026-09-19
---

> 归档材料：历史职责与决策证据，不回写为新事实。旧日期、数字与‘最新’措辞仅代表当时版本；当前使用[替代入口](../../../00-事实与简历/05-项目归属与量化证据.md)。原始字节见迁移前快照。

# clife 时期项目经验（简历草稿·按现有简历格式）

> 归属核查说明：以下条目全部经 `E:\Projects` 各仓库 git log 取证，**2026-09-08 已按源码逐条复核修订**（仓库定位、提交数、归属均以本轮 git 取证为准）。**标 ✅ 的是你本人提交（git 可复核）**；标 ⚠️ 的核心代码署名是同事（面试深挖有风险，写法见文末策略）。

---

### **智慧顾问 - 美业机构智能体工作台（H5）**

鸿溟 App 内嵌的美业门店智能工作台 H5（美容师/顾问/店长三助手 + 预约看板 + 顾客经营），为一线顾问/店长提供顾客经营与排期管理的一站式工作台，并接入智能待办能力，提升顾问的顾客跟进效率与成单转化。

- **技术栈**：Taro 3.6（App 内嵌 H5 宿主）+ React 17 + TypeScript + Zustand + SCSS Modules + webpack5。仓库 `E:\Projects\frontend\beauty-smart-advisor`（全仓 3919 次提交）。

- **核心功能开发**：

  - **预约看板模块**（✅ 本人 273 次提交居全仓第 5，reservationBoard 是最大落点）：负责资源预约看板全模块（src/pages/reservationBoard/），实现 **ScheduleTimeline 排期时间轴**组件（本人独写 24 次提交：多资源并行时间轴渲染、拖拽式预约排期）、预约表单弹窗（ReservationFormModal）、日历侧栏（CalendarSidebar）与树形资源选择器（TreeSelect）；封装资源调度工具（utils/scheduler.ts，本人独写 15 次提交）与 useReservationResources Hook，支撑顾问按资源/时段可视化排期。

  - **顾客管理模块**（✅ pages/myCustomers 本人 78 次提交为第一作者）：开发"我的顾客"全模块，含顾客筛选器（features/customerFilter + components/CustomerFilterPanel）、护理记录评价映射（serviceComplete/components/ServiceReview/normalizeServiceReviews.ts）、待办 relationType 五类映射（utils/customerContact.ts：注释原话"当前只认后端唯一五类"，定位五大回访邀约状态）。

  - **智能待办**（✅）：utils/customerTodoMappers.ts 解析智能待办 offsetDays（兼容数字、数字字符串、"180天"带单位文案三类入参），覆盖护后回访/剩余项目/复购/沉睡激活/差评跟进五类待办的时间偏移规则，实现"AI 建议 → 顾问执行"的闭环。

  - **AI 话术生成接入**（⚠️ 话术抽屉 SpeechDrawer 与 services/assistant.ts 主笔为同事）：参与联调与顾问跟单流程的嵌入，本人强相关的周边是美容师助手满意度模块（beauticianAssistant，本人 33 次提交）。

- **前端架构设计**（✅）：HOC 组合模式收敛横切逻辑（authWrapper 鉴权兜底、withCustomerLoginModal 顾客登录态）；本人提交 2ccbe56b "refactor(myCustomers): 统一模块导出导入与注释契约"；筛选条件字段口径与后端接口字段名对齐，降低联调损耗。

---

### **轻医美工作台 - AI 音频编辑（小程序子包）**

为轻医美机构的咨询/运营人员提供录音的 AI 智能剪辑能力：上传音频后由服务端 AI 任务异步加工，前端提供波形可视化、人工精修与结果保存的全流程交互。

- **技术栈**：Taro（微信小程序）+ React + TypeScript + Zustand（store.ts 页面状态）+ 自研波形组件族 + 异步任务轮询。仓库 `E:\Projects\frontend\homing-miniapp-workbench`（全仓 4752 次提交）。

- **核心功能开发**（✅ 全仓本人 168 次；其中 audioEdit 子包 src/subPackage/audioEdit/ 路径下 152 次、独立负责）：

  - **异步 AI 任务状态机**：封装音频编辑任务全生命周期接口（POST /tasks/add 创建、GET /tasks/detail 轮询、GET /tasks/cancel 取消、POST /tasks/confirm 确认保存，另有 GET /waveform 波形拉取），前端以任务状态驱动 UI（TaskStatusPanel 任务状态面板、失败错误分级提示与错误日志结构化上报）。

  - **波形可视化与人工精修**：实现波形组件族（WaveformPanel / TimelineWaveform / WaveformStrip / WaveformBars / ProgressWaveform），支持播放控制（PlaybackControls）、手动裁剪（ManualTrimPanel）、裁剪预览（SheetPreviewWaveform），连同 AudioEditSheet/AudioHeader/FooterActions 共 12 个组件；AI 生成结果可进入人工精修流程后保存。

  - **安全与健壮性**：对音频源 URL 做服务端校验前置（assertValidAudioSourceUrl，service.ts:196，防非法资源地址注入任务）；接口错误统一格式化（标题/消息分级），并沉淀 getAudioEditErrorLogDetail 结构化排错日志（service.ts:228）；请求超时三档分级（普通 15s / 波形 10min / 轮询 3s，constants/request.ts）。

- **工程质量**（✅）：子包自带 README、constants/types/utils/hooks 分层（12 个 hook），是工作台内工程完整度最高的子包之一；Java 侧状态经三级映射落到页面态（service.ts:66-74 JAVA_STATUS_TO_PAGE_STATUS）。

---

### **AI 私教智能体 - 跨端组件与 A2UI 渲染（小程序矩阵）**

品牌版 AI 私教智能体面向 C 端用户提供 AI 护肤教练对话服务，本人负责智能体对话界面在品牌端的组件化沉淀，以及智能体输出的结构化商品卡片的跨端渲染。

- **技术栈**：Taro 多端（微信/支付宝/抖音/H5）+ React + TypeScript + Zustand + A2UI（Agent-to-UI 结构化渲染）。

- **核心功能开发**：

  - **A2UI 商品推荐组件**（✅ 文件头署名亲笔，brand 端本人 27 次提交）：设计并实现智能体输出的**产品推荐公共组件**（src/components/A2UI/ProductRecommend/，index.tsx 与 utils.ts 文件头 @Author 关天豪），按场景类型（ProductRecommendRecommendType：morning/night/in_store_care）渲染多段式商品卡片（价格格式化 formatPrice、商品类型标签 PRODUCT_TYPE_LABEL_MAP、CSS 变量主题化 PRODUCT_RECOMMEND_CSS_VARS），配套亲笔接口层 `services/aiCoach.ts`（7 个接口，含 GET /v1/beautycamp/skin-coach/product-recommend）——**让智能体的推荐结论以可交互的商品卡片直达下单路径**。同族还有餐食评估（FoodAssessmentCheckln）、肤测记录（SkinTestRecord）等 A2UI 卡片。

  - **智能体对话组件沉淀**（✅）：负责品牌端智能体 BottomSheet 半屏交互组件族（index/store/CategorySheet/RecordSheet）等对话 UI 在小程序端的落地与跨端适配。

  - **智能体流式内核**（⚠️）：对话核心（小程序内自研 SSE Hook：`Taro.request enableChunked + onChunkReceived` 替代 EventSource、跨 chunk UTF-8 流式解码器、流式 JSON 容错解析驱动步骤进度卡、Zustand 分片 chatStore 会话管理）由李杰/lihao 实现；brand 端的 aiAgentPackage 与 skincare-coach-ai 是**复制后独立演进**关系（brand 2026-04-22 在先、54 文件；skincare-coach-ai 2026-06-01 拷贝后增强为 66 文件，独有 chatSessionManager/StreamingAnswerContent/ThoughtRender/AnswerSegments，29 个同名文件全部分叉）。此块以"参与联调"表述，深挖细节前先与同事对齐口径。

---

### **AI 辅助研发体系（跨项目工程化）**

在团队内推动 AI 编码规范的体系化落地，让 AI 从"个人提效工具"升级为"团队可复用的研发基建"。

- **体系内容**（✅ 各仓库可见）：

  - **AI 协作规范分层**：在多个仓库建立 CLAUDE.md（项目级编码约定）+ AGENTS.md（Agent 工作约定）+ CONTEXT.md（领域术语表，如网咨助手仓库根 CONTEXT.md 的预加载/转发事件/权威初始化等 9 条术语）+ docs/adr（架构决策记录，如 H5 容器鉴权时序 ADR-0001），使 AI 会话与新人上手共享同一份"项目上下文"。

  - **脚手架与 Mock 基建**：维护团队共享 Mock 反向代理网关 beauty-mock-gateway（backend/node/mock-gateway：SQLite 命中 mock 规则即回 JSON、未命中转发真实接口）；搭建现代栈模板 vite-react-admin-template（React 19.2 + TS 7 + Vite 8 + Zod 4 + Tailwind 4.3 + shadcn 底座，`E:\guahub\docs\temp\项目代码回忆\11-现代技术栈模板\`）并全链路验证构建。

  - **个人 AI 工作流**：日常使用 Claude Code/Cursor 进行开发（专业技能栏已列）；本时期完成 E:\Projects 全池 65 个 git 仓库的代码考古与简历取证。

---

## 归属风险表（面试前必读）

| 内容 | 归属 | 简历写法 |
| --- | --- | --- |
| 预约看板、我的顾客、智能待办（beauty-smart-advisor） | ✅ 你本人（273 次提交、全仓第 5，git 可复核） | "负责/主导" |
| AI 音频编辑子包（workbench） | ✅ 你本人（全仓 168 次、子包路径 152 次） | "独立负责" |
| A2UI 商品推荐 + BottomSheet + aiCoach 接口层（brand） | ✅ 你本人（27 次提交、文件头亲笔） | "设计并实现" |
| AI 话术生成（SpeechDrawer / services/assistant.ts） | ⚠️ 同事（802150）为主 | 只写"参与接入/联调"；讲自己的智能待办 offsetDays 规则 |
| 智能体 SSE 流式内核、chatStore、AnswerRender（skincare-coach-ai） | ⚠️ 李杰 / lihao | 只写"参与联调"；若被深挖，讲你自己的：A2UI 卡片设计、音频编辑任务状态机、预约看板排期 |
| 美肤私教智能体整体 | ⚠️ 团队项目，你在 brand 端有 27 次提交 | 项目条目可写，但核心亮点换你自己的 A2UI 与 BottomSheet 组件，不写"负责智能体内核" |
| 网咨助手（online-consultation-assistant） | ⚠️ lihao 118/230 次为主 | 不单独成条，其仓库根 CONTEXT.md 体系归入"AI 辅助研发体系"即可 |

## 知识补强路线（对应你抓取的 Token→Agent 课程 + Harness 幻灯片）

按"面试官会追问什么"排序，学完一个就在现项目找一个落点：

1. **Function Calling / Tool Use 规范**——你已做 A2UI（Agent 输出→UI），下一步理解 Agent 是怎么决定调用工具的，就能讲清"为什么商品推荐是结构化输出"。
2. **MCP 协议（Client 视角）**——公司后端已有 mcp-server-bff，前端做一个 MCP 工具调试面板即可把"了解 MCP"变成"实现过 MCP 前端"。
3. **Eval（效果评测）**——AI 话术生成、商品推荐都缺评测口径；哪怕做一个简单的人工评分回流，也是中小公司稀缺的"AI 产品化"证据。
4. **RAG 基础与上下文工程**——课程主线，结合你 CONTEXT.md/术语表的实践，叙事上是"Context Engineering 的工程化落地"。
5. **Guardrails 与降级**——你音频编辑里的 URL 校验、错误分级就是雏形，补齐"AI 输出不可信时的兜底"叙事即可。

## 老项目处理

希音三件套（SSAP/BCP/DOMP）+ 涉案财物：各压缩到 3 行以内（保留"从 0 到 1、第一贡献者、TS 92% 落地"三个量化点），为上面四个 clife 条目腾版面。PromptFlow 保留。

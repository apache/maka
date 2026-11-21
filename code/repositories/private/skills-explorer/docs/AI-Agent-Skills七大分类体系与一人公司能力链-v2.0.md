# AI Agent Skills 七大分类体系与一人公司能力链 v2.0

> 基于 2026-08-22 提供的 `.ggbdpq` 压缩包实战快照  
> 面向：8 年前端开发经验，向 AI Agent 工程、全栈能力和 OPA 一人公司持续扩展  
> 设计目标：分类稳定、目录更少、零空目录、支持几百到上千个 Skill、运行时保持精简
>
> **现状注（2026-09-13）**：本文是 v2 分类的期初设计论证存档；结构现状以 `~/.ai/README.md`（2026-09-29 三文档合并后的唯一说明文档） 为准，两者冲突时以后者为准。

---

## 1. 结论先行

v1.0 的七大能力方向整体成立，真正需要升级的是物理目录模型和资产治理方式。

两个月实战已经证明几个事实：

1. **一级能力域需要稳定，二级目录不能按未来想象提前预建。**
2. **React、Vue、Taro、状态管理、Git、DevOps 等更适合成为标签或具体 Skill 名，达到足够规模后再拆目录。**
3. **全面收集与运行时全量加载是两件事。** 你的仓库可以非常宽，global 运行时入口应持续保持窄。
4. **个人经验、来源作者、工具厂商都属于横切属性。** 它们不应长期占用一级能力分类。
5. **逆向与安全已经形成真实密度。** 当前拥有 28 个一等逆向/安全 Skill，加上 Semgrep、CodeQL、Variant Analysis，已经值得进入七大核心分类。
6. **v2.0 应把“Skill 创作治理”和“Agent 编排工作流”合并为 Agent 元能力层。** 两者共同解决 Agent 如何获得、组织、调度和验证能力的问题。
7. **一人公司能力链应从单线模型升级为“主价值流 + 两条横切能力带 + 反馈飞轮”。**

---

## 2. 我对压缩包做了什么分析

本次直接检查了：

- `categories/` 全部 `SKILL.md`
- `.skill-lock.json`
- `skills.manifest.json`
- `scripts/sk-rebuild.js`
- `scripts/sk-sync.js`
- `scripts/sk-doctor.js`
- `~/.ai/README.md`（原 categories/README.md，2026-09-29 并入）
- `scenarios/README.md`
- `docs/外部技能研究/README.md`
- `docs/外部技能研究/INDEX-主题索引.md`
- `08-个人经验沉淀/practices-me`
- `10-逆向工程`
- global 与 scenario 的运行时清单

### 2.1 当前仓库量化快照

| 指标                            |     实际值 | 说明                                                                           |
| ------------------------------- | ---------: | ------------------------------------------------------------------------------ |
| 压缩包条目                      |     16,528 | 包含源码、references、研究仓库等                                               |
| `categories/` 中 `SKILL.md`     |        195 | 真实扫描结果                                                                   |
| 当前一等 Skill 目录             |        174 | 按现有目录层级计算                                                             |
| 隐藏嵌套 `SKILL.md`             |         21 | 20 个位于 `practices-me/references`，1 个 `src-hunter` 位于 `pentest-tools` 内 |
| v1 七大类二级目录               |         54 | 仅统计 01 至 07                                                                |
| v1 七大类空二级目录             |         19 | 占 35.2%                                                                       |
| 仅有 0 至 2 个 Skill 的二级目录 |         33 | 占 61.1%                                                                       |
| global 运行时 Skill             |         16 | 这一点控制得很好                                                               |
| scenario 数量                   |          9 | 场景化装配已经形成                                                             |
| manifest 覆盖的 unique Skill    |        123 | global + scenarios 去重                                                        |
| `.skill-lock.json` 管理 Skill   |         68 | 第三方安装锁                                                                   |
| Firecrawl 锁定 Skill            |         31 | 占 lock 的 45.6%                                                               |
| `architecture/` 研究 Skill      | 182 unique | README 中已区分 DUP 与 NEW                                                     |

### 2.2 最直接的问题

当前 54 个 v1 二级目录里有 19 个空目录。更关键的是，33 个目录只有 0 至 2 个 Skill。

这说明 v1 的二级目录已经出现明显的“提前建模”。例如：

- `Vue与Nuxt`
- `Taro与移动端`
- `状态管理与数据流`
- `后端服务与API`
- `数据库与存储`
- `Git与CICD`
- `云部署与DevOps`
- `财务法务与合规`
- `个人品牌与产品化`

这些方向长期都值得学习，但当前仓库尚未形成足够的一等 Skill 密度。把它们提前做成物理目录，会增加维护成本和视觉噪音。

---

## 3. v1.0 两个月实战暴露出的架构问题

### 3.1 分类维度仍然有交叉

当前目录同时出现：

- 能力域：产品、前端、工程、自动化
- 技术栈：React、Vue、Taro
- 厂商：Firecrawl
- 作者：Matt Pocock
- 个人归属：个人经验沉淀
- 专项兴趣：逆向工程

这几种维度都合理，但适合放在不同层。

v2.0 统一原则：

> **物理目录只表达“核心能力结果”，技术栈、作者、来源、使用频率、个人归属和场景全部交给元数据与视图。**

### 3.2 `08-个人经验沉淀` 属于横切属性

`practices-me`、`writer-me`、`know-me`、`mentor-me` 都有价值，但“个人”描述的是资产归属。

v2.0 建议：

- `practices-me` 归工程能力
- `writer-me` 归内容交付
- `know-me`、`mentor-me` 归经营与个人系统
- 使用 `scope=personal`、source 或 catalog 元数据表达个人资产

这样七大类可以真正成为稳定的能力地图。

### 3.3 `10-逆向工程` 已经具备升级为核心一级类的条件

当前 `10-逆向工程` 有 28 个一等 Skill，且没有空二级目录。

同时 `05-全栈工程与交付质量/09-安全监控与性能` 已经拥有：

- `semgrep`
- `codeql`
- `variant-analysis`

安全与逆向已经形成完整能力簇：

- 安全审计
- Web/API 安全
- 供应链安全
- 二进制分析
- 移动端逆向
- 固件与恶意软件
- 漏洞利用
- CTF

因此 v2.0 将它升级为第六大类。

### 3.4 `Skill创作治理` 与 `Agent编排工作流` 可以合并

当前两类分别只有 8 个和 10 个一等 Skill。

它们都属于 Agent 的元能力：

- Skill 发现
- Skill 创建
- Skill 评估
- 计划
- 编排
- 多 Agent
- 执行
- 上下文
- 交接
- 完成验证

合并后得到 18 个高相关 Skill，结构更加完整，也为“安全与逆向工程”腾出一个七大类席位。

### 3.5 Firecrawl 和音视频已经证明“厂商数量会扭曲目录”

`.skill-lock.json` 中 68 个第三方 Skill，有 31 个来自 Firecrawl 相关仓库。

这说明一个厂商就可以迅速带来几十个 Skill。如果二级目录跟着厂商、产品或单个工具扩张，目录树会越来越像软件清单。

v2.0 对此采用：

- 分类按能力结果
- `source` 记录作者或厂商
- scenario 负责组合
- architecture 保留原仓库研究材料

### 3.6 当前脚本会递归扫描所有 `SKILL.md`

`sk-rebuild.js` 和 `sk-doctor.js` 的 `collectSkillTargets()` 会递归遍历 `categories/`，发现某目录包含 `SKILL.md` 后，用**目录 basename** 作为 Skill key。

这与你当前 `practices-me` 的写法存在结构冲突。

例如：

```text
practices-me/references/web/stacks/react/SKILL.md
```

frontmatter：

```yaml
name: react-me
```

扫描器得到的 key 却是：

```text
react
```

类似的 folder/name 不一致共有 **22 处**。

另外：

```text
design-generator-v1.0/SKILL.md
design-generator-v2.0/SKILL.md
```

两个 frontmatter 都叫：

```yaml
name: design-generator
```

当前存在 **1 组 frontmatter 重名**。

这在 Skill 数量继续增长后会逐渐变成隐式路由问题。

### 3.7 README 已经出现机器状态漂移

例如：

- `categories/README.md`（2026-09-29 已并入 `~/.ai/README.md`）仍写“全库约 120 个 SKILL.md”，实际已经是 195。
- `scenarios/README.md` 写 global 14 个，manifest 当前是 16 个。
- `scenarios/README.md` 写 Firecrawl 场景 34 个，manifest 当前是 33 个。
- 逆向场景 README 写 29 个，manifest 当前是 28 个。

这说明“人工维护数量型文档”已经开始失真。

v2.0 建议让脚本自动生成 inventory 和 README 统计区。

---

# 4. AI Agent Skills 七大分类体系 v2.0

## 01. Agent 系统与 Skills 工程

负责 Agent 如何获得能力、组织能力、调度能力和验证执行。

三个二级目录：

### 01-Skill工程

覆盖：

- Skill 搜索与安装
- Skill 创建
- Skill 编写规范
- Skill 评估
- Skill 维护
- Skill 版本治理
- Skill 安全检查

当前代表：

- `find-skills`
- `skill-creator`
- `skill-from-masters`
- `writing-skills`
- `writing-great-skills`
- `skill-judge`
- `ask-matt`

### 02-规划编排与多Agent

覆盖：

- 任务拆解
- 计划编写
- 持久化计划
- 并行 Agent
- 计划执行
- 完成验证

当前代表：

- `writing-plans`
- `planning-with-files`
- `dispatching-parallel-agents`
- `executing-plans`
- `verification-before-completion`

### 03-上下文效率与交接

覆盖：

- 上下文压缩
- Token 效率
- 会话交接
- 长任务状态传递

当前代表：

- `handoff`
- `caveman`
- `caveman-commit`
- `caveman-compress`
- `caveman-stats`

核心目标：

> 把“会使用 AI”升级为“会设计 Agent 工作系统”。

---

## 02. 研究、产品与决策

负责寻找值得解决的问题，把模糊需求变成可验证的产品规格。

### 01-研究市场与分析

覆盖：

- 深度研究
- 市场分析
- 竞品情报
- 公司目录
- 论文与技术资料
- 数据判断

当前主要来自 Firecrawl 研究链。

### 02-产品定义与规格

覆盖：

- 需求澄清
- grilling
- brainstorming
- 领域建模
- PRD
- Issue 拆分
- 项目逆向分析
- 个人 `prd-me`

### 03-原型验证与决策

覆盖：

- throwaway prototype
- 原型转 PRD
- 产品专属 prototype skill
- 业务流程验证

核心目标：

> 先提高“选对问题”的概率，再提高实现速度。

---

## 03. 设计体验与前端应用

这是你当前最有积累、也最应该继续形成差异化优势的能力域。

v1.0 最大的问题是按 React、Vue、Taro、状态管理提前拆目录。v2.0 只保留两个实体二级目录。

### 01-设计系统与设计还原

覆盖：

- UI/UX
- 前端审美
- 交互设计
- Design System
- Shadcn
- Figma
- Figma to Code
- 截图还原
- 设计系统提取
- UI Implementer
- `ui-me`

### 02-Web跨端与体验质量

覆盖：

- React
- Next.js
- Vue
- Taro
- NutUI
- TypeScript
- Zustand
- CSS/SCSS
- UnoCSS
- 组件组合模式
- 前端性能
- 可访问性
- 响应式
- Remotion React
- `web-me`
- `react-me`
- `vue-me`
- `taro-me`
- `zustand-me`
- `css-me`

以后出现 Angular、Svelte、React Native、Flutter 时，优先直接添加 Skill 并打标签。只有某一技术簇达到明显规模后再物理拆分。

核心目标：

> 从“前端工程师”继续升级为“能把产品体验独立落地的人”。

---

## 04. 软件工程与全栈交付

负责把设计和需求变成可靠、可维护、可上线的系统。

### 01-架构工程化与服务端

覆盖：

- 项目架构
- TypeScript 工程
- Vite
- pnpm
- Turborepo
- tsdown
- Node BFF
- API 契约
- Java DDD
- Feign
- MyBatis
- Solon MCP
- `practices-me`

当前个人 Node/Java 经验建议从 `practices-me/references` 提升为独立 Skill，同时保留 `practices-me` 作为路由器。

### 02-测试调试与代码审查

覆盖：

- TDD
- Vitest
- Web App Testing
- 系统调试
- 根因分析
- Code Review
- 架构改进
- 代码简化
- 注释治理
- 深度审计
- `test-me`
- `bug-me`
- `quality-me`

Git、CI/CD、部署、数据库暂时不单独创建空目录。

新增相关 Skill 时先进入 `01-架构工程化与服务端`。当某一簇达到 5 至 8 个高价值一等 Skill，并且实际检索产生摩擦，再拆出新的二级目录。

核心目标：

> 独立完成“开发、验证、上线、维护”的工程闭环。

---

## 05. 工具、数据与自动化

负责让 Agent 连接真实世界。

### 01-浏览器与数据获取

覆盖：

- Agent Browser
- Chrome DevTools
- Firecrawl search/scrape/crawl/map/parse
- Puppeteer
- Web Scraper
- Reverse 场景中的 browser automation

### 02-外部集成与任务自动化

覆盖：

- MCP
- API
- SaaS
- Firecrawl build workflows
- 定时监控
- 截图
- 外部工具调用
- 自动执行链

### 03-音视频与媒体工具

覆盖：

- 视频生成
- 视频编辑
- 扩图、扩视频
- Lipsync
- Face Swap
- 音频工程
- `ai-audio-me`

这里放“工程工具和执行能力”。

内容成品、品牌素材和传播结果放第七类。

核心目标：

> 把个人执行扩展成机器执行，把单点工具扩展成自动工作流。

---

## 06. 安全与逆向工程

这是 v2.0 新晋七大核心类。

### 01-安全工程与审计

覆盖：

- Semgrep
- CodeQL
- Variant Analysis
- StackHawk
- Secure Coding

### 02-WebAPI与供应链安全

覆盖：

- API Security
- Pentest
- LLM Security
- Supply Chain Security
- `src-hunter`

### 03-二进制移动端与逆向

覆盖：

- IDA
- Radare2
- PyGhidra
- Binary Triage
- Binary Diff
- APK
- Mobile Reverse
- JS Reverse
- Firmware
- Malware
- 通用 Reverse Engineering

### 04-漏洞研究与CTF

覆盖：

- CTF Rev
- CTF Pwn
- CTF Crypto
- Pwn Chain
- Patch Diff Exploit
- Attack Chain

核心目标：

> 建立系统底层理解、安全边界和高难问题分析能力。

对一人公司而言，这一类既是风险控制能力，也是高技术壁垒方向。具体使用必须遵守授权、合法性和安全边界。

---

## 07. 内容、增长与一人公司

负责把技术和产品转化为影响力、客户和收入。

### 01-内容与知识交付

覆盖：

- 技术文章
- 写作
- Markdown
- PDF
- DOCX
- PPTX
- XLSX
- 蓝图
- 技术文档
- Diagram
- 教学
- 微信读书知识处理
- `writer-me`
- `summary-me`

### 02-多媒体与品牌

覆盖：

- 音乐生成
- TTS
- AI 音频
- 品牌素材
- 未来图片/视频内容生产

这里关注最终内容和传播结果。

### 03-增长销售与客户

覆盖：

- SEO
- CRO
- Copywriting
- Lead Research
- Lead Generation
- 客户转化

### 04-经营与个人系统

覆盖：

- 项目运营
- Dashboard
- 商业运营
- 产品化
- 财务和法务
- 个人品牌
- 知识管理
- `know-me`
- `mentor-me`

当前财务、法务、个人品牌相关 Skill 数量还不够，因此不提前创建更细目录。

核心目标：

> 从“能做产品”继续走到“能让产品被发现、被购买、被持续经营”。

---

# 5. v2.0 最终物理目录

v1.0 七大核心分类共有 54 个二级目录。

v2.0 建议压缩到 **21 个实体二级目录**，减少约 **61.1%**。如果把当前额外的逆向二级目录一起纳入旧体系比较，目录压缩幅度约 **65.6%**。

```text
categories/
├─ 01-Agent系统与Skills工程/
│  ├─ 01-Skill工程/
│  ├─ 02-规划编排与多Agent/
│  └─ 03-上下文效率与交接/
├─ 02-研究产品与决策/
│  ├─ 01-研究市场与分析/
│  ├─ 02-产品定义与规格/
│  └─ 03-原型验证与决策/
├─ 03-设计体验与前端应用/
│  ├─ 01-设计系统与设计还原/
│  └─ 02-Web跨端与体验质量/
├─ 04-软件工程与全栈交付/
│  ├─ 01-架构工程化与服务端/
│  └─ 02-测试调试与代码审查/
├─ 05-工具数据与自动化/
│  ├─ 01-浏览器与数据获取/
│  ├─ 02-外部集成与任务自动化/
│  └─ 03-音视频与媒体工具/
├─ 06-安全与逆向工程/
│  ├─ 01-安全工程与审计/
│  ├─ 02-WebAPI与供应链安全/
│  ├─ 03-二进制移动端与逆向/
│  └─ 04-漏洞研究与CTF/
└─ 07-内容增长与一人公司/
   ├─ 01-内容与知识交付/
   ├─ 02-多媒体与品牌/
   ├─ 03-增长销售与客户/
   └─ 04-经营与个人系统/
```

关键规则：

> **没有 Skill 就没有目录。**

不要使用 `.gitkeep` 预占未来分类。

未来方向先写在 taxonomy 文档或 catalog 中，出现真实 Skill 后再创建目录。

---

# 6. 按当前 195 个 SKILL.md 迁移后的分布

本方案把 20 个 `practices-me/references/**/SKILL.md` 和 `src-hunter` 视为应提升的一等 Skill，并归入七大类。

同时建议把 `design-generator-v1.0` 移入归档，只保留一个活跃 `design-generator`。

迁移后预计 **194 个活跃一等 Skill**：

| 一级分类                 | 活跃 Skill | 二级分布                                                                                   |
| ------------------------ | ---------: | ------------------------------------------------------------------------------------------ |
| 01-Agent系统与Skills工程 |         18 | 01-Skill工程 8、02-规划编排与多Agent 5、03-上下文效率与交接 5                              |
| 02-研究产品与决策        |         20 | 01-研究市场与分析 6、02-产品定义与规格 11、03-原型验证与决策 3                             |
| 03-设计体验与前端应用    |         32 | 01-设计系统与设计还原 15、02-Web跨端与体验质量 17                                          |
| 04-软件工程与全栈交付    |         29 | 01-架构工程化与服务端 13、02-测试调试与代码审查 16                                         |
| 05-工具数据与自动化      |         39 | 01-浏览器与数据获取 16、02-外部集成与任务自动化 9、03-音视频与媒体工具 14                  |
| 06-安全与逆向工程        |         29 | 01-安全工程与审计 5、02-WebAPI与供应链安全 5、03-二进制移动端与逆向 13、04-漏洞研究与CTF 6 |
| 07-内容增长与一人公司    |         27 | 01-内容与知识交付 11、02-多媒体与品牌 5、03-增长销售与客户 6、04-经营与个人系统 5          |

这比按“未来技术栈”预建目录更符合你的真实资产分布。

完整 195 条迁移路径已经生成独立 CSV，包含：

- Skill 名称
- 旧路径
- 新一级分类
- 新二级分类
- 新路径
- MOVE / PROMOTE / ARCHIVE / RENAME_MOVE
- 迁移原因

---

# 7. 一人公司能力链 v2.0

v1.0 使用的是一条顺序链：

```text
Skill → 编排 → 产品 → 前端 → 工程 → 自动化 → 商业
```

它适合入门理解，但经过两个月实战后，可以升级为更准确的系统模型：

## 7.1 一条主价值流

```text
研究与产品决策
        ↓
设计体验与前端应用
        ↓
软件工程与全栈交付
        ↓
工具数据与自动化
        ↓
内容增长与一人公司
        ↓
用户、收入、数据与反馈
```

这条链回答：

> 一个人如何把问题变成产品，再把产品变成持续经营结果？

## 7.2 第一条横切能力带：Agent 系统与 Skills 工程

```text
┌────────────────────────────────────────────┐
│ Agent 系统、Skill、规划、多 Agent、上下文、验证 │
└────────────────────────────────────────────┘
       ↓        ↓        ↓        ↓        ↓
     研究      设计      开发      自动化      经营
```

它是杠杆层。

任何阶段出现稳定、重复、可描述的工作，都应该逐渐沉淀为：

```text
经验
→ Skill
→ Workflow
→ Scenario
→ 自动执行
```

## 7.3 第二条横切能力带：安全与逆向工程

```text
设计 → 开发 → API → 数据 → 部署 → 自动化 → 经营
  ↑      ↑      ↑      ↑      ↑       ↑
        安全、审计、逆向、风险验证
```

它是保障层和深技术能力层。

对于个人开发者，这类能力不需要平均投入，但应保持体系化认知，并在高风险环节调用专业 Skill。

## 7.4 一个反馈飞轮

```text
产品实践
→ 用户反馈
→ 线上故障
→ 销售异议
→ 内容数据
→ 经营数据
→ 提炼规律
→ 更新 memory / Skill
→ 优化 scenario / workflow
→ 下一轮产品
```

这才是 OPA 长期最重要的复利来源。

---

# 8. 五层 Skills 资产架构继续保留

你当前最大的正确决策之一，是已经把“存储”和“运行时”分开。

v2.0 建议继续强化为五层：

## Layer 1：architecture

定位：

- 原始优秀仓库
- 研究材料
- 上游对照
- 尚未验证的候选 Skill

继续保持只读研究区。

## Layer 2：categories

定位：

- 经过筛选的一等 Skill SSOT
- 七大分类
- 194 左右活跃 Skill

只在这里修改 Skill 真身。

## Layer 3：scenarios

定位：

- 面向真实任务的组合视图

场景应该以**任务结果**命名。

建议逐渐调整：

| 当前场景                 | v2 建议                                            |
| ------------------------ | -------------------------------------------------- |
| `05-firecrawl数据抓取`   | `研究与数据采集`                                   |
| `07-Matt Pocock工程技能` | 拆为 `需求与方案设计`、`实现与验证` 或并入工程场景 |
| `08-音视频处理`          | 保留                                               |
| `09-代码审查`            | 保留                                               |
| `01-PRD转页面`           | 可升级为 `产品到界面`                              |

作者和厂商继续保留在 source metadata。

## Layer 4：global / project runtime

当前 global 只有 16 个，这个数量是健康的。

全面学习几百个 Skill，不代表每次会话都需要加载几百个 Skill。

建议：

- global 保持约 10 至 20 个
- 场景按需 apply
- 项目专属 Skill 放项目级
- Codex 原生继续单独管理

## Layer 5：memory

定位：

- 个人经验
- 项目事实
- 复盘
- 决策
- 失败案例
- 证据地图

Memory 记录“知道什么”。

Skill 记录“怎么做”。

Scenario 记录“什么时候组合哪些能力”。

三者边界需要长期保持。

---

# 9. v2.0 的目录治理规则

## 规则一：一级目录固定七个

未来至少一年不轻易增加一级目录。

新增领域先尝试：

1. 找现有能力域
2. 加标签
3. 加 scenario
4. 达到规模后再考虑二级拆分

## 规则二：二级目录按真实密度创建

建议阈值：

- 0 个：禁止创建
- 1 至 4 个：优先放现有二级目录
- 5 至 8 个：开始观察是否形成稳定能力簇
- 8 至 15 个：可以独立二级目录
- 超过 20 个：检查是否需要再次拆分

阈值只是治理参考，语义边界优先。

## 规则三：技术栈优先使用标签

推荐维度：

```yaml
stack:
  - react
  - nextjs
  - vue
  - taro
  - node
  - java
```

还可以维护：

```yaml
lifecycle:
  - research
  - plan
  - build
  - test
  - review
  - ship
  - operate
  - grow

scope:
  - global
  - scenario
  - project
  - personal

priority:
  - core
  - regular
  - niche

status:
  - candidate
  - active
  - deprecated
  - archived

source:
  - self
  - anthropic
  - vercel
  - mattpocock
  - firecrawl
```

如果不希望扩展 `SKILL.md` frontmatter，可以单独维护 `skills.catalog.json`。

## 规则四：目录名必须与 frontmatter name 对齐

建议 doctor 强制：

```text
folder basename == SKILL.md frontmatter.name
```

版本历史放 archive，不在 active categories 同时放两个同名 Skill。

## 规则五：Skill 包内部禁止再放可被扫描的 `SKILL.md`

两种选择：

### 需要独立调用

提升为 categories 中的一等 Skill。

### 只是参考资料

改名为：

```text
references/react.md
references/api-contract.md
references/java-ddd.md
```

不要继续叫 `SKILL.md`。

---

# 10. 对现有脚本的 v2.0 改造建议

## 10.1 `collectSkillTargets()` 不再无限递归

当前逻辑：

```text
categories 下看到任何 SKILL.md 都收进索引
```

建议改成：

```text
categories/<一级>/<二级>/<skill>/SKILL.md
```

只扫描合法层级。

如果需要未来允许直接放一级分类根部，可以明确支持固定两种 schema，不再遍历任意深度。

## 10.2 解析 frontmatter name

索引 key 使用：

```yaml
name:
```

同时校验 folder basename 与 name 一致。

## 10.3 `sk-doctor` 增加分类健康检查

至少增加：

- 空二级目录检查
- folder/name 不一致检查
- frontmatter 重名检查
- Skill 内嵌套 `SKILL.md` 检查
- README 统计漂移检查
- orphan Skill 检查
- scenario/vendor 命名提醒
- archived Skill 被 manifest 引用检查

## 10.4 README 统计改为生成

例如：

```bash
node scripts/sk-doctor.js
```

自动生成：

- Skill 总数
- 分类数量
- global 数量
- scenario 数量
- 来源分布
- 空目录
- orphan
- 重名
- 最近新增

这样 README 只维护方法论，数量由机器生成。

---

# 11. 针对你的学习与职业发展的优先顺序

你已经拥有较强前端积累，未来希望同时向 AI Agent、全栈和 OPA 发展。

因此不建议七类平均分配时间。

## P0：Agent 系统与软件工程

重点：

- Agent workflow
- multi-agent
- planning
- verification
- context engineering
- code review
- debugging
- TDD
- architecture
- Node/Java 服务端

目标：

> 从“AI 帮我写代码”升级到“我设计 AI 软件生产系统”。

## P1：研究产品 + 自动化

重点：

- research
- PRD
- domain modeling
- prototype
- browser automation
- MCP
- API
- data pipeline

目标：

> 一个人完成从发现问题到自动执行的闭环。

## P1：继续扩大前端优势

前端仍然是你的强势杠杆：

- React/Next
- Taro
- Vue
- Design System
- Figma
- UI implementation
- performance
- accessibility

目标：

> 将八年前端经验转化为 AI 时代的产品交付优势，而不局限于页面开发岗位。

## P2：增长与经营

随着个人产品逐渐稳定，持续提高：

- SEO
- copywriting
- sales
- lead generation
- pricing
- customer support
- finance
- legal
- personal brand

目标：

> 从工程闭环进入商业闭环。

## P2/P3：安全与逆向

根据兴趣和项目需求保持长期深挖。

它对底层能力、安全意识和复杂问题分析非常有价值，但投入强度需要结合主营产品方向。

---

# 12. v2.0 最终原则

经过两个月真实积累后，这套体系应该从“分类百科全书”升级为“个人能力操作系统”。

我建议长期坚持六句话：

> **一级分类稳定。**  
> **二级目录按真实密度生长。**  
> **没有 Skill 就不创建目录。**  
> **技术栈、来源和个人归属交给元数据。**  
> **仓库可以很宽，运行时必须很窄。**  
> **每一次实战最终都要回流为 Memory、Skill 或 Workflow。**

最终的一人公司系统可以概括为：

```text
               Agent 系统与 Skills 工程
                        ↓
研究产品 → 设计体验 → 全栈交付 → 数据自动化 → 增长经营
    ↑          ↑          ↑          ↑          ↑
             安全与逆向工程横向保障
                        ↓
               用户、收入、故障、数据
                        ↓
                Memory / Skill / Workflow
                        ↓
                   下一轮能力复利
```

v2.0 的目标已经从“我应该把 Skill 放在哪个文件夹”进一步升级为：

> **怎样让几百个 Skill 逐渐形成一个可搜索、可组合、可验证、可进化，并最终服务于个人产品和一人公司的能力系统。**

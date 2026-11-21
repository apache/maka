# Product Prototype Skill Builder 架构与实现分析

本文面向个人深度学习，分析 `product-prototype-skill-builder` 这套历史 Skill 的架构设计。它的特别之处在于自身并不直接产出页面原型，而是指导 AI 基于当前仓库生成一个新的产品专属 `prototype-designer` Skill。换句话说，它是一个面向 Skill 生产的元 Skill。

## 结论摘要

`product-prototype-skill-builder` 的核心设计以规则编排为主，脚本自动化为辅。它用一个短 `SKILL.md` 作为总控入口，用三份 `references` 文件分别承担产品形态识别、目标 Skill 创建规范、原型交付质量约束，再用可选 `agents/openai.yaml` 适配特定平台展示。

这套架构有四个值得学习的点。

1. 它把“如何生成一个 Skill”拆成可验证的流程，而不是只给一段泛化提示词。
2. 它先判断产品形态，再提炼规范，避免把 Web 后台、移动端、大屏、AIGC、编辑器等模式混写。
3. 它给强规则设置证据门槛，只有全局配置、公共组件或至少 3 个代表页面重复出现的模式，才能写成强约束。
4. 它把原型交付质量作为下游 Skill 的继承约束，要求处理控件可见性、状态样式和静态 sanity check。

## 修改文件清单

本文分析的源码范围如下。

| 文件                                          | 行数 | 角色                                                                   |
| --------------------------------------------- | ---: | ---------------------------------------------------------------------- |
| `SKILL.md`                                    |  105 | 总控入口，定义目标、平台兼容、Required Reads、Workflow 和 Output Rules |
| `references/product-shape-framework.md`       |  198 | 产品形态识别框架                                                       |
| `references/creation-spec.md`                 |  240 | 目标 `prototype-designer` Skill 的创建契约                             |
| `references/prototype-delivery-guardrails.md` |  154 | 下游原型交付质量约束                                                   |
| `agents/openai.yaml`                          |    4 | 可选平台适配元数据                                                     |

当前 Skill 路径如下。

```text
~\.agents\categories\03-研究产品与决策\04-原型与业务流程\product-prototype-skill-builder
```

## 改动目的

本文要回答五个问题。

1. 它为什么能作为“生成 Skill 的 Skill”。
2. 它如何把产品源码分析转化成目标 Skill 规则。
3. 它如何控制证据质量，避免模型脑补产品规范。
4. 它如何把原型交付质量传递给下游 Skill。
5. 如果要复刻这套架构，应该保留哪些核心模块。

## 一句话架构

`product-prototype-skill-builder` 可以理解成一个 Skill 生成编译器。

```text
当前仓库源码
  |
  v
产品形态识别
  |
  v
稳定证据采样
  |
  v
目标 Skill 创建契约
  |
  v
原型交付质量约束注入
  |
  v
<product-name>-prototype-designer/
  ├── SKILL.md
  └── references/
```

它的输入是当前仓库的源码证据，输出是一个产品专属 `prototype-designer` Skill。中间的关键在于通过形态识别、证据优先级、强规则门槛、目标目录规范和交付质量清单来约束生成过程，减少模型自由发挥带来的漂移。

## 总体架构

```text
product-prototype-skill-builder/
├── SKILL.md
├── references/
│   ├── product-shape-framework.md
│   ├── creation-spec.md
│   └── prototype-delivery-guardrails.md
└── agents/
    └── openai.yaml
```

架构分层如下。

| 层级       | 文件                               | 核心职责                                                  |
| ---------- | ---------------------------------- | --------------------------------------------------------- |
| 总控层     | `SKILL.md`                         | 定义调用场景、读取顺序、执行工作流和输出规则              |
| 形态识别层 | `product-shape-framework.md`       | 判断仓库属于哪类产品，给后续规则限定适用范围              |
| 创建契约层 | `creation-spec.md`                 | 规定目标 Skill 的命名、目录、证据门槛、章节结构和汇报要求 |
| 质量继承层 | `prototype-delivery-guardrails.md` | 把 HTML / 前端原型的控件可见性和状态完整性写入下游 Skill  |
| 平台适配层 | `agents/openai.yaml`               | 给支持该格式的平台提供显示名、短描述和默认提示词          |

这套分层的好处是职责边界清楚。`SKILL.md` 不承载所有细节，细节按主题拆入 `references`。下游创建时必须按顺序读取引用文件，减少遗漏。

## 核心工作流

`SKILL.md` 把流程拆成 6 步。

| 步骤 | 名称                    | 目标                                                  |
| ---- | ----------------------- | ----------------------------------------------------- |
| 1    | Confirm Scope           | 识别产品名和目标 Skill 命名                           |
| 2    | Classify the Product    | 按端类型、交互范式、页面结构、运行特征识别产品形态    |
| 3    | Gather Stable Evidence  | 采样 8 到 12 个代表文件，按证据优先级提炼稳定规范     |
| 4    | Create the Target Skill | 创建同名目标技能目录，至少包含 `SKILL.md`             |
| 5    | Write the Target Skill  | 写入工作流、规范、代码约束、原型质量约束和自检清单    |
| 6    | Validate and Report     | 校验目录、frontmatter、references、质量约束和最终汇报 |

这个流程体现了一个重要设计。它先建立边界，再写规则。产品名、端类型、交互范式、证据等级都确认后，才允许生成目标 Skill。

## Required Reads 设计

`SKILL.md` 明确要求按顺序读取三份引用文件。

```text
product-shape-framework.md
  |
  v
creation-spec.md
  |
  v
prototype-delivery-guardrails.md
```

这个顺序不是随意排列。

| 顺序 | 文件                               | 作用                                                |
| ---- | ---------------------------------- | --------------------------------------------------- |
| 1    | `product-shape-framework.md`       | 先判断产品形态，防止后续规则套错端                  |
| 2    | `creation-spec.md`                 | 再确定目标 Skill 的目录、命名、证据、结构和交付标准 |
| 3    | `prototype-delivery-guardrails.md` | 最后把下游原型交付质量要求注入目标 Skill            |

它像一个编译前检查链。先识别语义上下文，再执行创建契约，最后补上质量门禁。

## 产品形态识别层

`product-shape-framework.md` 的作用是防止模型把所有仓库都当成同一种产品。它用四个维度识别产品形态。

| 维度                 | 示例                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------- |
| Terminal             | Web desktop、Mobile app、Mini program、Desktop client、Large screen                     |
| Interaction Paradigm | Admin、Consumer browsing、AIGC conversational、Editor、Data screen                      |
| Page Structure       | List management、Form configuration、Conversation flow、Canvas editing、Chart dashboard |
| Runtime Traits       | Real-time refresh、Streaming output、Touch-first、Keyboard-and-mouse-first              |

这个框架最重要的价值是排斥规则。它明确禁止在证据不足时把某一类产品的惯例强加给另一类产品。

| 错误迁移                     | 风险                                 |
| ---------------------------- | ------------------------------------ |
| 把 Web 后台规则强加给移动端  | 忽略 safe area、触控目标和底部操作区 |
| 把移动端规则强加给桌面端     | 造成桌面信息密度和操作效率下降       |
| 把普通 CRUD 套给 AIGC 工作流 | 漏掉流式输出、停止、重试、会话历史   |
| 把普通页面套给大屏           | 忽略远距可读性、比例缩放和自动刷新   |
| 把传统表单套给编辑器         | 漏掉画布、选中态、快捷键和保存状态   |

因此，产品形态识别层相当于目标 Skill 的类型系统。类型判断错了，后续规范会系统性跑偏。

## 创建契约层

`creation-spec.md` 是这套 Skill 的核心契约。它规定目标 Skill 怎么命名、怎么取证、写什么章节、交付什么文件。

### 命名与目录规则

目标技能必须先创建独立文件夹，文件夹名使用 hyphen-case，且必须与目标 `SKILL.md` frontmatter 的 `name` 完全一致。

命名优先级如下。

| 条件                     | 命名                                   |
| ------------------------ | -------------------------------------- |
| 能稳定识别产品名         | `<product-name>-prototype-designer`    |
| 多子产品但有统一主产品名 | 使用统一主产品名                       |
| 无法稳定识别产品名       | `prototype-designer`                   |
| 已有同名目录             | 使用 `-v2`、`-next` 等后缀，并说明原因 |

这避免了目标 Skill 文件散落在项目根目录，也避免 frontmatter 与目录名不一致导致平台识别失败。

### 证据优先级

它给证据设置了固定优先级。

| 优先级 | 证据类型                                                           |
| -----: | ------------------------------------------------------------------ |
|      1 | 主题变量、设计 token、全局样式、主题文件、布局壳子、端适配规则     |
|      2 | 公共组件、二次封装组件、基础组件库封装、hooks、mixins、utils、指令 |
|      3 | 高频代表页面中稳定重复出现的模式                                   |
|      4 | 单页个例                                                           |
|      5 | 用户后续提供的截图                                                 |
|      6 | 模型推断                                                           |

这个优先级很关键。它把源码中的稳定结构放在最高位，把模型推断放在最低位。对一个会生成下游 Skill 的工具来说，这相当于防止错误规则被固化。

### 强规则门槛

只有满足以下条件之一，规则才能写成“必须 / 强制 / 严禁 / 绝对禁止”。

1. 在全局配置、主题文件、布局壳子、公共组件中有直接证据。
2. 在至少 3 个代表页面中稳定重复出现。
3. 已经被封装成统一组件、统一 hook、统一工具函数或统一样式约定。

证据不足时，目标 Skill 必须写明“未在源码中发现稳定规范”或“仅观察到局部倾向，不能上升为全局规则”。

这套门槛让目标 Skill 的规则有证据等级，减少“看起来合理”的伪规范。

## 质量继承层

`prototype-delivery-guardrails.md` 是这套架构里最容易被低估的一层。很多生成原型的 Skill 会复刻布局和文案，却漏掉 HTML / CSS / 前端原型里的控件可见性和状态样式。这个文件专门堵住这个缺口。

它要求下游目标 Skill 在输出以下内容时应用 guardrails。

| 输出形态                       | 是否应用                         |
| ------------------------------ | -------------------------------- |
| HTML 静态原型                  | 应用                             |
| 单文件前端原型                 | 应用                             |
| Vue / React / 任意前端代码骨架 | 应用                             |
| 可点击 demo 页面               | 应用                             |
| 带交互态的高保真页面原型       | 应用                             |
| 纯文字信息架构草图             | 可不强制展开，但建议保留自检思想 |

### 它继承给下游 Skill 的关键约束

| 约束                            | 目的                                                         |
| ------------------------------- | ------------------------------------------------------------ |
| Native Control Reset            | 避免浏览器默认控件样式污染视觉                               |
| Component Visual Fidelity       | 不只复刻结构，还要复刻真实组件视觉                           |
| Existing Component Priority     | 源码已有组件时，优先复用现有组件语言                         |
| Interactive State Completeness  | 默认、hover、active、checked、disabled、错误、空状态都要考虑 |
| Static Prototype Sanity Check   | HTML 交付前至少做结构和关键元素检查                          |
| Conditional Visual Verification | 环境支持渲染预览时做可视验证，不支持时退回代码级检查         |

这层设计的本质是质量要求传递。builder Skill 生成 target Skill 时，不只生成“会设计”的 Skill，还要生成“交付前会自检”的 Skill。

## 平台适配层

`agents/openai.yaml` 只有 4 行。

```yaml
interface:
  display_name: "Product Prototype Skill Builder"
  short_description: "Build product-specific prototype skills from codebases"
  default_prompt: "使用 $product-prototype-skill-builder 基于当前仓库创建产品原型设计 skill。"
```

它的作用是给支持该格式的平台提供展示名、短描述和默认提示词。`SKILL.md` 明确说明，`agents/openai.yaml` 只是可选适配文件，核心逻辑仍然来自 `SKILL.md` 和 `references/`。

这个边界很重要。平台元数据不能成为 Skill 成立的唯一依赖。跨平台可复用能力必须放在 Markdown 规则中。

## 生成目标 Skill 的输出契约

目标 `prototype-designer` Skill 至少要包含一个 `SKILL.md`，按需补充 `references/`。

推荐交付结构如下。

```text
<product-name>-prototype-designer/
├── SKILL.md
└── references/
    ├── product-shapes.md
    ├── ui-tokens.md
    ├── layout-patterns.md
    ├── component-patterns.md
    ├── code-conventions.md
    ├── rule-sources.md
    └── prototype-delivery-guardrails.md
```

目标 `SKILL.md` 必须覆盖这些章节。

| 章节                     | 目的                                                   |
| ------------------------ | ------------------------------------------------------ |
| YAML frontmatter         | 只允许 `name` 和 `description`，且 `name` 与目录名一致 |
| 产品形态识别与适用范围   | 说明当前仓库属于哪些产品形态                           |
| 核心原型设计工作流       | 区分有截图升级和无截图全新原型                         |
| 产品核心 UI 与布局规范   | 只写源码中有稳定证据的规则                             |
| 页面组件交互规范         | 沉淀真实存在的稳定交互模式                             |
| 技术栈输出建议与代码骨架 | 跟随仓库真实技术栈                                     |
| 组件级与代码级编码规范   | 命名、样式隔离、反馈、确认、权限、状态管理             |
| 原型实现质量约束         | 处理控件可见性、状态完整性、静态校验                   |
| 原型输出前自检 checklist | 至少 10 条，兼容当前产品形态                           |
| 规则溯源表               | 说明关键规则来自哪些源码文件                           |

这是一份非常完整的“目标 Skill 结构协议”。它让生成结果具备可审查性，而不是只生成一个看似完整的提示词文件。

## 证据采样策略

`creation-spec.md` 要求优先分析 8 到 12 个代表文件、组件和页面。这是一个很务实的策略。

| 做法                   | 价值                             |
| ---------------------- | -------------------------------- |
| 采样代表文件           | 控制分析成本，避免全仓库低效扫描 |
| 优先全局样式和布局壳子 | 先找最高稳定性的规则             |
| 再看公共组件           | 找真实复用模式                   |
| 再看高频页面           | 验证规则是否稳定重复             |
| 单页个例降级处理       | 防止局部实现被写成全局规范       |

这套采样策略适合产品规范抽取。它承认仓库里并非所有代码都有同等权威，先找高权威证据，再看局部页面。

## 下游场景设计

目标 Skill 必须覆盖两类原型工作流。

| 场景             | 输入                 | 目标                                                 |
| ---------------- | -------------------- | ---------------------------------------------------- |
| 现有功能升级     | 有截图或现有页面参考 | 保留原页面上下文、信息架构、导航关系和交互逻辑       |
| 全新功能原型生成 | 无截图，只有功能描述 | 复用当前系统已有页面模板、组件组合方式和状态流转模式 |

这个区分很重要。现有功能升级更像局部改造，全新功能更依赖源码中已有模式迁移。目标 Skill 如果不区分两类场景，很容易把已有页面改得失去产品连续性。

## 安全边界

`product-prototype-skill-builder` 的安全边界集中在四类禁止项。

| 禁止项                                 | 原因                                   |
| -------------------------------------- | -------------------------------------- |
| 严禁输出通用模板替代现有产品语言       | 目标是延续产品一致性                   |
| 严禁把一种产品形态规则强加给另一种形态 | 防止跨端误用                           |
| 严禁无证据引入新的视觉体系或组件风格   | 防止目标 Skill 固化模型脑补            |
| 严禁只约束页面结构却不约束原型实现质量 | 防止控件不可见、状态缺失和默认样式污染 |

这四类边界说明它并不是一个“美化工具”。它更像产品一致性提炼器和下游原型 Skill 生成器。

## 架构亮点

### 1. 元 Skill 思路清晰

普通 Skill 直接解决用户任务。这个 Skill 解决的是“如何创建另一个能持续解决产品原型任务的 Skill”。它把一次性分析转化为可复用能力。

### 2. 引用文件分工准确

三个 references 文件分别回答不同问题。

| 文件                               | 回答的问题                        |
| ---------------------------------- | --------------------------------- |
| `product-shape-framework.md`       | 当前仓库是什么类型的产品          |
| `creation-spec.md`                 | 目标 Skill 应该如何创建           |
| `prototype-delivery-guardrails.md` | 目标 Skill 生成原型时如何保证质量 |

这种分工让主 `SKILL.md` 保持短小，也让复杂规则可以独立维护。

### 3. 证据门槛防止规则污染

它明确要求强规则必须有稳定证据。这个设计很成熟，因为生成出来的目标 Skill 会在未来反复使用。如果错误规则被写入目标 Skill，后续所有原型都会被污染。

### 4. 产品形态先行

它先判断 terminal、interaction paradigm、page structure 和 runtime traits，再沉淀规范。这个顺序能减少跨端误用，是产品型 Skill 很重要的工程习惯。

### 5. 交付质量向下传递

`prototype-delivery-guardrails.md` 把控件可见性、状态完整性和 sanity check 写成下游约束。这让目标 Skill 继承交付纪律，而不只继承设计风格。

## 当前局限

这套 Skill 也有明显边界。

| 局限                     | 影响                                                           |
| ------------------------ | -------------------------------------------------------------- |
| 没有脚本自动化           | 文件创建、证据统计、目录校验依赖执行者                         |
| 没有 schema 校验         | 目标 `SKILL.md` frontmatter 和章节完整性需要人工或外部工具检查 |
| 没有模板文件             | 执行者需要根据规则自行组织目标 Skill 正文                      |
| 没有示例输出             | 新执行者可能不清楚优秀目标 Skill 的粒度                        |
| 没有测试快照             | 难以判断一次生成是否相对历史版本退化                           |
| `.DS_Store` 出现在目录中 | 属于无关系统文件，分析时应忽略                                 |

这些局限并不削弱它的设计价值。它的核心是规则架构，而非自动化工具链。若要继续演进，优先补自动校验和模板体系。

## 可升级方向

如果后续继续完善，可以按优先级推进。

1. 增加目标 Skill 模板，例如 `templates/SKILL.md.tpl` 和 `templates/rule-sources.md.tpl`。
2. 增加校验脚本，检查 frontmatter、目录名、必备章节、references 链接和 checklist 条数。
3. 增加证据采样表模板，记录 8 到 12 个代表文件的证据等级。
4. 增加最小可用目标 Skill 示例，供执行者对齐粒度。
5. 增加平台适配说明，区分 OpenAI、Codex、Claude 等平台元数据边界。
6. 增加交付后回归清单，检查目标 Skill 是否继承了 guardrails。

## 复刻路径

如果要复刻这套“生成 Skill 的 Skill”架构，可以按下面顺序设计。

### Step 1 定义元目标

先明确这个 builder 生成什么类型的下游 Skill。例如 prototype designer、API contract auditor、brand guideline designer、dashboard reviewer。

### Step 2 拆出类型识别框架

任何 builder 都需要先判断对象类型。产品原型场景用产品形态识别；API 场景可以用服务类型识别；品牌场景可以用品类和视觉系统识别。

### Step 3 写创建契约

创建契约必须说明目标 Skill 的命名、目录、frontmatter、必备章节、证据优先级、强规则门槛和最终汇报。

### Step 4 写质量继承文件

把下游最容易漏掉的质量要求单独拆成 guardrails。对于原型 Skill，是控件可见性和静态校验；对于 API Skill，可能是契约兼容和错误码覆盖；对于安全 Skill，可能是证据复现和误报标注。

### Step 5 保持平台适配可选

平台元数据只做增强，核心能力必须保留在 Markdown 规则和 references 中。这样生成器才能跨平台复用。

### Step 6 增加校验闭环

成熟版本应该有校验脚本或检查清单，确保目标 Skill 名称、目录、章节、references、证据来源和质量约束都完整。

## 可执行步骤

阅读这套 Skill 时，建议按下面顺序。

1. 先读 `SKILL.md`，理解总目标和 6 步工作流。
2. 再读 `product-shape-framework.md`，掌握产品形态识别维度和排斥规则。
3. 再读 `creation-spec.md`，理解目标 Skill 的命名、证据、结构和交付契约。
4. 再读 `prototype-delivery-guardrails.md`，理解下游原型实现质量如何被强制继承。
5. 最后看 `agents/openai.yaml`，确认它只是平台显示与默认提示词适配。

如果要实践一次，应选择一个真实产品仓库，按证据优先级采样 8 到 12 个代表文件，再生成 `<product-name>-prototype-designer` 目录。完成后重点检查目标 Skill 是否包含产品形态边界、规则溯源表、原型质量约束和输出前 checklist。

## 验收方式

这类 builder Skill 的验收应分三层。

| 层级     | 验收点                                                                                   |
| -------- | ---------------------------------------------------------------------------------------- |
| 结构验收 | 是否有总控入口、类型识别、创建契约、质量 guardrails 和平台适配边界                       |
| 规则验收 | 是否设置证据优先级、强规则门槛、形态排斥规则和证据不足写法                               |
| 下游验收 | 生成的目标 Skill 是否能独立指导后续原型设计，并继承控件可见性、状态完整性和 sanity check |

最关键的验收问题是：它生成的目标 Skill 是否能在未来迭代中稳定复用当前产品的真实设计语言。如果只能生成通用模板，说明 builder 没有完成自己的核心目标。

## 总结

`product-prototype-skill-builder` 的架构价值在于把 Skill 创建过程工程化。它没有依赖复杂脚本，却通过分层 Markdown 规则建立了稳定流程。

它的核心方法可以概括为五句话。

1. 先识别产品形态，再沉淀产品规范。
2. 先采稳定证据，再写强规则。
3. 先创建自洽目录，再写目标 Skill。
4. 先继承现有产品语言，再生成新原型。
5. 先写交付质量约束，再允许下游输出前端原型。

这就是它作为历史 Skill 仍然值得学习的原因。它体现的是一套面向可复用 Skill 生产的架构范式，价值高于单次提示词技巧。

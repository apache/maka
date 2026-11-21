---
name: product-prototype-skill-builder
description: 用于基于当前仓库源码创建产品专属的 prototype-designer skill。适用于需要分析现有产品的 UI 规范、布局骨架、交互模式、产品形态和代码约束，并沉淀为可复用 SKILL.md 与 references 的场景，尤其适合为后续产品迭代生成与现有产品保持一致的原型设计技能。
---

# Product Prototype Skill Builder

## Overview

创建一个新的产品专属 prototype-designer skill，使后续 AI 在做功能迭代、页面改版或新功能原型时，优先复用现有产品的设计语言、交互习惯和代码实现模式，而不是生成通用模板。

## Quick Start

平台无关调用提示词：

`请基于当前仓库创建一个用于后续产品迭代原型设计的 skill，并保持生成结果与现有产品 UI 规范、交互模式和代码实现方式一致。`

如果当前环境支持显式技能调用，可使用：

`使用 $product-prototype-skill-builder 基于当前仓库创建产品原型设计 skill。`

## Platform Compatibility

- 这个 skill 的核心内容是 `SKILL.md` 和 `references/`，它们应当作为跨平台可复用的主入口。
- `agents/openai.yaml` 只是某些支持该格式的平台的适配文件，不是 skill 的核心逻辑。
- 如果使用环境不支持 `openai.yaml`、`$skill-name` 或显式技能机制，可以直接读取本文件和 `references/` 里的规则，将其作为结构化提示词执行。
- 创建目标技能时，应优先保证目标技能的 `SKILL.md` 和 `references/` 自洽可用；平台专属元数据文件只能作为可选增强，不得作为唯一依赖。

## Required Reads

- 先读 [references/product-shape-framework.md](references/product-shape-framework.md)，识别产品形态、端类型和适用边界。
- 再读 [references/creation-spec.md](references/creation-spec.md)，获取目标技能的目录规则、命名规则、证据优先级、输出结构和最终交付要求。
- 再读 [references/prototype-delivery-guardrails.md](references/prototype-delivery-guardrails.md)，补齐下游 prototype-designer skill 对静态原型实现质量、控件可见性和交付自检的硬约束。
- 若运行环境提供专门的技能创建能力，优先用它初始化目标技能目录；否则按引用文件中的规则手工创建等价目录。

## Workflow

### 1. Confirm Scope

- 从当前仓库识别产品主名称、系统简称、品牌名或主应用名。
- 优先把目标技能命名为 `<product-name>-prototype-designer`；若无法稳定识别产品名，再回退为 `prototype-designer`。
- 只允许基于当前仓库源码提炼规范；外部文档、截图和模型推断都不能覆盖源码中的稳定证据。

### 2. Classify the Product

- 按终端载体、交互范式、页面结构形态、运行与数据特征四个维度识别产品形态。
- 若仓库同时包含多种形态，分别沉淀规范并明确边界，避免把 Web、移动端、大屏、AIGC、编辑器和桌面端模式混写。
- 如果只能看到局部证据，先写清“已确认形态”和“待确认形态”，不要强行归并。

### 3. Gather Stable Evidence

- 优先分析 8 到 12 个最具代表性的文件、组件和页面。
- 证据优先级固定为：主题变量/全局样式/布局壳子 > 公共组件/封装 > 高频页面模式 > 单页个例 > 截图 > 模型推断。
- 只有全局规则、公共组件规则或至少 3 个代表页面重复出现的模式，才能写成“必须 / 强制 / 严禁 / 绝对禁止”。
- 证据不足时，明确标注“未在源码中发现稳定规范”或“仅观察到局部倾向，不能上升为全局规则”。
- 若目标技能要生成 HTML 原型或前端原型，必须额外检查源码中的表单控件、开关、单选、多选、抽屉、分页、步骤条和表格状态样式，避免下游技能只复刻布局却漏掉控件可见性与状态样式。

### 4. Create the Target Skill

- 必须先创建与目标技能同名的文件夹。
- 目标技能目录内至少包含 `SKILL.md`；按需补充 `references/`，不要把文件直接散落在项目根目录。
- `SKILL.md` frontmatter 只允许 `name` 和 `description`，其中 `name` 必须与目录名完全一致。
- 若环境支持技能元数据，可补齐 `agents/openai.yaml`；若不支持，保持只含 `SKILL.md` 与 `references/` 的最小可用目录即可。

### 5. Write the Target Skill

- 让目标技能默认采用“保守迭代”策略：优先复用现有设计语言，不做无依据的风格升级。
- 目标技能必须覆盖：
  - 产品形态识别与适用范围
  - 有截图的现有功能升级工作流
  - 无截图的全新功能原型生成工作流
  - 通用规范与形态特定规范
  - 组件交互规范
  - 技术栈输出建议与代码骨架
  - 代码级约束
  - 原型实现质量约束
  - 原型输出前自检 checklist
  - 规则溯源表或独立溯源文件
- 若目标技能预期会输出 HTML 静态原型、Vue 页面原型或前端代码骨架，必须把 `references/prototype-delivery-guardrails.md` 中的要求转化为下游 skill 的明确约束，而不是仅靠模型自行发挥。
- 必须在目标 skill 中明确区分两类校验：
  - 基础静态 sanity check 是交付前硬要求
  - 控件可见性的肉眼验证属于条件式要求，应写成“环境支持渲染预览时必须执行；环境不支持时必须说明限制，并退回到代码级或结构级检查”

### 6. Validate and Report

- 若环境支持，生成 `agents/openai.yaml`；若不支持，跳过该步骤并明确说明。
- 优先校验 `SKILL.md`、目录命名、references 路径、空模板问题，以及下游 skill 是否已经明确覆盖“原生控件重置 / 自定义控件可见性 / 组件状态自检 / 基础静态 sanity check / 条件式可视验证”这类原型实现质量约束；平台专属文件校验属于附加项。
- 最终汇报目标技能路径、生成文件、关键证据来源、证据不足项，以及是否只能给出最小可用版本。

## Output Rules

- 只在有稳定证据时使用“必须 / 强制 / 严禁 / 绝对禁止”。
- 严禁把一种产品形态的模式强加给另一种产品形态。
- 严禁输出通用后台模板、通用 App 模板、通用 AIGC 模板、通用大屏模板或通用营销页模板替代现有产品语言。
- 严禁把平台专属元数据文件当成 skill 的唯一交付物。
- 严禁只约束页面结构而不约束原型实现质量，尤其是会影响视觉还原的 switch、checkbox、radio、分页、抽屉、步骤条、表格状态等基础控件。
- 严禁让下游 prototype skill 只说“生成 HTML 原型”，却不要求在交付前做基础静态 sanity check。
- 严禁把“肉眼可见性验证”写成无条件硬要求却不考虑执行环境；正确写法应是“环境支持时执行，不支持时说明限制并退回到代码级或结构级检查”。
- 若仓库规范不足以支撑完整目标技能，先生成最小可用版本，并明确缺口。

## Resources

- `references/product-shape-framework.md`：产品形态识别维度、适用边界和排斥规则。
- `references/creation-spec.md`：创建目标 prototype-designer skill 的详细约束、目录结构、内容要求和交付标准。
- `references/prototype-delivery-guardrails.md`：当下游 skill 要生成 HTML / 静态原型 / 前端原型时，必须继承的实现质量约束和交付前自检要求。

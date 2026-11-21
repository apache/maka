---
name: awesome-design-md-prototype-designer
description: 用于在 awesome-design-md 仓库内，基于现有站点条目完成“有截图参考的设计包升级”和“仅有文字描述的新站点设计包生成”，并输出与当前仓库结构、文档格式、预览页实现方式一致的 `DESIGN.md`、`preview.html`、`preview-dark.html` 与 `README.md`。
---

# Awesome DESIGN.md Prototype Designer

## 1. 产品形态识别与适用范围

### 已确认形态

- 当前仓库的主形态是 `Web desktop`。
- 当前仓库的主交互范式是 `Marketing / showcase` 与 `Design reference documentation` 的组合。
- 当前仓库的主页面结构是 `Hero + sectioned catalog + cards/forms/examples` 的分段式展示。
- 当前仓库的主运行特征是静态 Markdown 与单文件 HTML/CSS 交付。

### 适用任务

- 为现有 `design-md/<site-slug>/` 目录做增量升级。
- 为新站点创建一套完整设计包。
- 修订现有 `DESIGN.md` 的设计语言描述，并同步更新 light / dark 预览页。
- 修订 README 的站点说明、文件表格和预览描述。

### 不适用任务

- 不要把本 skill 用于生成后台管理台、移动端 App、桌面客户端、画布编辑器或数据驾驶舱原型。
- 不要把本 skill 用于生成真实产品业务流程页面。
- 不要把某个站点自身的业务组件体系误写成仓库级全局规范。

### 边界判断

- 这个仓库收录的是多个站点的设计语言样本，仓库本身没有统一视觉品牌系统。
- 下游任务的“产品”默认指的是 `awesome-design-md` 这套样本库交付形态，不指代样本来源站点本身的业务代码。
- 下游输出的稳定目标是“新增或修订一个站点设计包”。

更多边界见 `references/product-shapes.md`。

## 2. 默认设计策略

- 有截图时，优先保留原条目的目录名、文件边界、章节结构、预览页骨架和 README 模板。
- 无截图时，优先复用仓库里已经稳定重复出现的设计包结构，再把新站点的视觉语言填入该结构。
- 严禁输出通用 SaaS 模板、通用后台模板、通用 App 模板替代当前仓库的样本包语言。
- 严禁擅自把单个站点的视觉风格提升为仓库全局风格。
- 严禁在无源码证据时自行引入构建工具、组件库、SSR 框架或复杂 JS 交互。

## 3. 核心原型设计工作流

### 场景 A：现有功能升级

适用条件：

- 用户给出某个现有目录的截图、链接、修订需求或差异说明。

执行顺序：

1. 先读取对应目录下的 `DESIGN.md`、`preview.html`、`preview-dark.html`、`README.md`。
2. 先确认这次改动影响的是文案描述、token、预览骨架还是 README 说明。
3. 若只是 token 或组件视觉修订，必须同步检查 light / dark 两个预览页。
4. 若修改 `DESIGN.md` 中的颜色、字体、按钮、卡片、表单或阴影描述，必须检查预览页是否仍然能把这些信息直观展示出来。
5. 若截图只覆盖局部模块，只允许修改局部规范；未被截图或源码稳定证据覆盖的部分保持原样。
6. 完成后必须回看 README 是否仍然准确说明当前目录的文件组成和预览用途。

### 场景 B：全新功能原型生成

适用条件：

- 用户要新增一个之前不存在的站点目录。
- 用户只给出站点链接、截图、品牌名或较详细的视觉描述。

执行顺序：

1. 先确定新目录名，优先复用品牌官方常用 slug；若品牌以域名识别更稳定，可保留域名风格，例如 `linear.app`、`x.ai`。
2. 先写 `DESIGN.md`，保持 9 个章节的稳定结构。
3. 再写 `preview.html` 与 `preview-dark.html`，保持当前仓库通用的目录内展示骨架。
4. 最后写 `README.md`，说明该条目来源、文件组成、用途和预览。
5. 若证据不足，必须在 `DESIGN.md` 或 README 中明确说明“不是官方设计系统”与“可能不是 100% 准确”这类边界。

## 4. 产品核心 UI 与布局规范

### 通用强规则

- 每个站点目录必须包含 `DESIGN.md`、`preview.html`、`preview-dark.html`、`README.md` 四个核心文件。
- `DESIGN.md` 必须沿用 9 段式结构，至少覆盖视觉氛围、颜色、排版、组件、布局、层级、Do / Don’t、响应式、Agent Prompt Guide。
- `preview.html` 与 `preview-dark.html` 必须用单文件 HTML 交付，并以内联 CSS 展示该站点的设计 token 和组件样式。
- README 必须说明该条目来自公开网站提炼，且不是官方设计系统；还要说明文件组成与预览用途。
- 预览页必须包含清晰的 Hero 区和分段式 token catalog，不允许只放零散色块或只放截图。

### 形态特定规范

对当前仓库这个“设计样本包”形态，稳定重复的页面骨架如下：

- 顶部导航
- Hero 区
- Colors
- Typography
- Buttons
- Cards
- Forms
- Spacing
- Radius
- Elevation / Depth

允许按站点特征做轻微裁剪或扩展，但默认先保留这套骨架。

### 不能上升为全局规则的内容

- 未在仓库中发现稳定的分页、步骤条、抽屉底栏、开关、单选、复选、表格选中态体系。
- 个别条目出现的 checkbox、table 或特殊交互，不足以提升为仓库级强规则。
- 未在仓库根级发现统一颜色 token、统一字号 token 或统一品牌色。

更多模式见 `references/layout-patterns.md` 与 `references/ui-tokens.md`。

## 5. 页面组件交互规范

### 稳定存在的交互模式

- 导航链接有 hover 态。
- Hero 区至少有一个主 CTA，常见为双按钮组合。
- 色板以 `color-grid` 类网格展示，卡片内同时展示名称、色值和角色。
- Typography 区用若干 `type-sample` 展示层级。
- Cards 区通常有 hover 态或阴影变化。
- Forms 区至少展示文本输入框，常见还会展示 textarea、focus 态和 error 态。
- 响应式收敛策略通常在 `max-width: 768px` 左右收起导航并改为单列。

### 条件式组件要求

- 若站点本身存在额外组件类型，例如 checkbox、pricing card、timeline、console、syntax block，可以加到预览页。
- 若仓库中没有稳定重复证据，这类组件只能作为站点特化展示，不能写成仓库全局硬要求。

### 禁止事项

- 严禁把站点来源的真实复杂业务流程硬塞进预览页。
- 严禁让预览页沦为营销海报；它首先是 token catalog，其次才是风格展示页。
- 严禁只展示视觉图，不展示对应的颜色、排版、按钮、卡片、表单等基础样式样本。

更多组件线索见 `references/component-patterns.md`。

## 6. 技术栈输出建议与代码骨架

### 技术栈建议

- 优先使用 Markdown 编写 `DESIGN.md` 和 `README.md`。
- 优先使用单文件 HTML 与内联 CSS 编写 `preview.html` 与 `preview-dark.html`。
- 优先使用 CSS 自定义属性承载站点 token。
- 只有在站点风格高度依赖 web font，且当前仓库已有同类先例时，才引入外部字体链接。
- 默认不引入构建工具、组件库、打包器和运行时 JS。

### 目录骨架

```text
design-md/<site-slug>/
  DESIGN.md
  README.md
  preview.html
  preview-dark.html
```

### 预览页骨架示例

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Design System Preview: Site Name (Light)</title>
  <style>
    :root {
      --bg-page: #ffffff;
      --text-primary: #111111;
      --accent: #0066ff;
      --border: #e5e5e5;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg-page); color: var(--text-primary); }
  </style>
</head>
<body>
  <nav class="nav"></nav>
  <section class="hero"></section>
  <section class="section" id="colors"></section>
  <section class="section" id="typography"></section>
  <section class="section" id="buttons"></section>
  <section class="section" id="cards"></section>
  <section class="section" id="forms"></section>
  <section class="section" id="spacing"></section>
  <section class="section" id="radius"></section>
  <section class="section" id="elevation"></section>
</body>
</html>
```

## 7. 组件级与代码级编码规范

- 目录名必须与站点 slug 一致，且与已有集合风格兼容。
- 文件名强制固定为 `DESIGN.md`、`README.md`、`preview.html`、`preview-dark.html`。
- `DESIGN.md` 的主标题应写成 `# Design System: <Brand>`。
- `README.md` 默认沿用当前仓库条目中的说明模板，至少说明来源站点、四个文件及预览用途。
- 预览页类名优先沿用当前仓库高频命名，例如 `nav`、`hero`、`section`、`color-grid`、`card-grid`、`form-input`。
- 预览页 token 必须写在 `:root` 中，且优先使用语义命名，不要堆积无意义的随机变量名。
- 改动某个站点的 token 或组件样式时，必须同时判断 light / dark 双预览页是否都要更新。
- 若站点没有足够证据支撑 dark 版完全重构，优先保留结构一致，再做配色映射。
- `README.md`、`DESIGN.md` 与预览页文案必须指向同一个站点品牌，严禁品牌名错位。

更多编码约束见 `references/code-conventions.md`。

## 8. 原型实现质量约束

当前仓库会直接交付 HTML 预览页，因此以下要求是硬约束：

- 对 `button`、`input`、`textarea` 这类已在仓库中稳定出现的基础控件，必须显式处理默认外观、边框、背景、尺寸和状态。
- 若本次条目引入 `checkbox`、`radio`、自定义 pill toggle 或其他自定义控件，必须显式处理可见样式，不能依赖浏览器默认表现。
- 预览页中的关键控件至少要覆盖默认态；若页面里展示了 focus、error、hover 或 active 语义，就必须让这些状态肉眼可区分。
- 颜色、字体、阴影和边框必须优先复刻当前站点目录的 `DESIGN.md` 描述，不能退回浏览器默认蓝、默认灰和默认阴影。
- 交付前必须做一次基础静态 sanity check。
- 环境支持渲染预览时必须执行一次肉眼检查，确认关键按钮、输入框、自定义控件和 hover / focus / error 示意区块真实可见。
- 环境不支持渲染预览时，必须明确说明限制，并退回到代码级和结构级检查。

更多硬约束见 `references/prototype-delivery-guardrails.md`。

## 9. 原型输出前自检 checklist

- 是否创建了完整的四文件设计包。
- `DESIGN.md` 是否保留 9 段式结构。
- `README.md` 是否说明“非官方设计系统”与“可能不是 100% 准确”。
- `preview.html` 与 `preview-dark.html` 是否都能独立表达同一站点的设计语言。
- 预览页是否包含 Hero、Colors、Typography、Buttons、Cards、Forms、Spacing、Radius、Elevation 等核心分段。
- `:root` 中的 token 是否为语义命名，且与页面展示内容一致。
- 文档、标题、按钮文案中的品牌名是否统一。
- 文本输入框、按钮、textarea 的默认态是否有明确可见样式。
- 若使用了自定义控件，是否覆盖默认态、hover / checked / disabled 中实际需要的状态。
- 是否至少做过一次基础静态 sanity check。
- 环境支持时，是否做过一次条件式可视验证。
- 是否避免把单个站点的局部组件误写成仓库级全局规则。
- 是否在证据不足处明确写出“未在源码中发现稳定规范”或等价说明。

## 10. 规则溯源

- 规则来源与证据等级见 `references/rule-sources.md`。
- 在下游任务中，凡是要使用“必须 / 强制 / 严禁 / 绝对禁止”字样的规则，先回查 `references/rule-sources.md`。
- 若新增仓库级模式，请先确认它已进入全局文件、公共模板或至少 3 个代表目录，再升级为强规则。

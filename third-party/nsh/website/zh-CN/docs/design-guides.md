---
title: 设计指南
description: 面向 Native Shell 应用的产品、视觉与交互设计规范：层级、颜色与 token、间距、密度、组件、交互状态、浮层、动效、数据密集界面、界面用词与平台适配。
order: 29
group: ui
---

# 设计指南

请在为 Native Shell 应用选择组件或编写布局代码之前阅读本指南。它记录 GPUI Kit 在多年桌面应用开发中形成的产品判断，并沿用到 NSH：界面应当原生、克制、精确，并让用户无需猜测就能完成任务。

本文是一份规范性指南：**必须**表示正确性或生态约束，**应该**表示默认选择，偏离时需要有明确理由；**可以**表示可选方法。具体的 prop 与方法以[元素](../elements/index.md)和 [API](../modules/index.md) 页面为准。

这些规则建立在 `nsh/base`（Rust 中为 `nsh_base`）的行为能力、主题及其 token，以及各平台用户熟悉的交互习惯之上。NSH 用各平台自己的界面渲染，外观交给应用：`nsh/base` 的组件负责行为、状态、焦点与无障碍，所有颜色、尺寸、圆角和间距都来自应用自己的组件，因此这些规则指导的是应用的设计系统。<a href="https://ui.shadcn.com/docs" target="_blank" rel="noopener noreferrer">shadcn/ui</a> 提供了开放代码、组合能力和可靠默认值等有益方法，但不决定 NSH 应用的外观。发生冲突时，优先服从平台行为和用户熟悉的交互。

## 设计主张

界面应该原生、安静、准确。由内容、层级与交互承担体验，装饰只用于支持它们。

1. **先清晰，后个性：** 在加入品牌表达前，先让主要任务与下一步行动清楚。
2. **先组合，后发明：** 从已有组件出发组成产品工作流；只有行为确实不同，才创建新 primitive。
3. **先 token，后数值：** 颜色、圆角、字体与间距必须构成系统，避免无法响应主题的孤立字面量。见[样式](./styling.md)、[Tailwind](./tailwind.md) 与[主题](./rust.md#主题)。
4. **平台约定优先于网页惯例：** 在桌面上保留键盘操作、窗口框架、菜单、密集数据视图、可调整区域和持久导航；在手机和平板上保留系统标题栏、返回手势、提示框和触摸目标。
5. **状态必须可见：** hover、按下、焦点、选中、禁用、加载、校验与破坏性状态必须清楚且一致。
6. **几何表达包含关系：** 圆角、内缩与边界应构成一致的层级，叠放时也不能破坏。
7. **反馈必须真实：** 加载、提示与动效应解释实际状态或变化，不为即时操作增加仪式感。

## 借鉴 Shadcn

Shadcn 最有价值的不是某一种边框颜色，而是一套建立系统的方法：

- 拥有界面最上层代码，不与封闭抽象反复对抗；
- 用小而可预测的部件组合出产品组件；
- 默认样式本身就属于同一种视觉语言；
- 代码和组合结构同时对人和 AI 可读；
- 把行为 primitive 与带视觉观点的样式层分开。

NSH 通过 `nsh` 的原语、`nsh/base` 的无样式基础组件，以及属于应用的样式层来实现这些原则（[三层结构](./architecture.md#三层结构)）。应用在 `nsh/base` 之上构建自己的组件，可以用 TSX，也可以放在应用的 Rust crate 中；真正可复用的行为放入 `nsh/base`，视觉决策留在上层。

以下网页习惯不应直接复制：

| 网页习惯 | NSH 默认方式 |
| --- | --- |
| 所有按钮都显示手形光标 | 按钮使用默认指针，只有链接使用手形（`cursor-pointer`） |
| 以页面跳转为主要结构 | 桌面上使用持久窗口、pane、sidebar、tab 与 menu；手机上使用带系统返回的 `NavStack` |
| 依赖浏览器兜底焦点和滚动 | 明确焦点所有者与各区域的滚动所有者（`Scroll`、`List`） |
| 移动优先的单列布局 | 手机上单列，桌面上是有最小窗口尺寸定义的可调整 shell |
| 关键操作只在 hover 时出现 | 键盘、触摸和指针都可达，不依赖 hover 才存在 |
| 每行放一排 hover-only 图标按钮 | 一个可见主操作，次要命令使用 `Menu` / `ContextMenu` |
| 用 Link 样式文字执行应用 command | 使用应用的默认、outline 或 ghost 样式的 `Button`；链接样式只用于 URL、网页资源或 Email 地址 |
| 全局采用很大的触摸密度 | 触摸屏上使用适合手指的目标；有指针时默认 medium，专业数据区域才局部紧凑 |
| 每个平台都画一个标题栏和提示卡片 | iOS 与 Android 上使用系统标题栏和 `AlertDialog`；桌面与 Web 上使用页面的 `header` 插槽 |
| 通过 CSS 穿透修改后代 | 使用应用的组件、组件的部件和主题 token |

## 从用户任务开始

画界面之前先写清楚：

- 用户的主要任务；
- 正在查看或修改的对象；
- 必须立即可见的操作；
- 做决定所需的信息；
- 空、加载、错误、离线、只读和无权限状态；
- 完整流程的键盘、触摸与读屏路径；
- 应用显示在哪里：单独运行，还是在宿主应用之中。

界面结构应由这些答案决定，不要从 dashboard 卡片网格或组件目录开始。优秀的应用呈现用户的心智模型——文档、账户、项目、消息、设置——而不是内部服务架构。

先确定主要任务，再选择控件。视觉权重、位置与信息深度必须匹配功能在产品中的重要性。不能把核心结果缩成角落里的数字、图标或弱化操作，却让次要内容占据页面。当结果集本身就是产品价值，应使用摘要区域或卡片展示数量、代表性结果、当前状态和清晰的下一步。

每个操作都要有明确的对象、当前状态、作用范围和结果。界面尚未展示或暗示这些信息时，操作就出现得太早。不能因为后端已有能力就直接暴露入口；先设计用户如何理解这个对象和结果。

## 视觉语言

### 层级

使用少量、清晰的层级：

- **窗口或页面标题**标识当前对象或工作区；
- **章节标题**分隔有意义的区域（`role="header"`，读屏用户可以在它们之间跳转）；
- **正文**承载工作内容；
- **弱化文字**提供次要元数据和帮助；
- **标签**标识控件和值。

先用字号、字重、间距与分隔线建立层级，再考虑颜色和容器。避免卡片嵌套卡片；大多数区域只需要背景、hairline 边界和有意图的留白。

层级必须按整个功能评审，不能只看单个组件。隐藏强调色和装饰后，主要任务、当前选择、结果摘要和下一步仍应能从结构中识别。每个控件单看都合理，如果没有形成清楚的阅读顺序与决策路径，整体设计仍然失败。

注意力是有限的。一个局部区域只需要一个清晰重点。如果所有内容都有颜色、徽章、粗体、容器或警示，就没有内容真正重要。先用结构和距离建立优先级；只有某个区别会改变用户的注意或行动时，才使用更强的颜色或组件。

### 颜色与主题

从主题读取颜色（Rust 中为 `theme()`，TSX 中为 token 类名），并按语义角色使用：

- `background` / `foreground`：主表面和正文；
- `card`、`popover`、`sidebar` 及对应 foreground：具名表面；
- `muted` / `muted-foreground`：辅助信息；
- `primary`：当前决策区域的主要操作或选中强调，`secondary` 和 `accent`：较弱的强调以及悬停或聚焦的行；
- `destructive`：只用于破坏性操作和错误，应用加入主题的状态色（`success`、`warning`）只表达对应语义；
- `chart-1` 到 `chart-5`：数据序列；
- `border`、`input` 和 `ring`：结构与交互。

```rust tabs
use nsh_base::theme;

view()
    .rounded(move || theme().radius)
    .border_1()
    .border_color(move || theme().border)
    .bg(move || theme().background)
    .p_4()
    .gap_1()
    .child(text("余额").text_color(move || theme().foreground))
    .child(text("刚刚更新").text_sm().text_color(move || theme().muted_foreground))
```

```tsx tabs
<View class="gap-1 rounded-(--radius) border border-border bg-background p-4">
  <Text class="text-foreground">余额</Text>
  <Text class="text-sm text-muted-foreground">刚刚更新</Text>
</View>
```

不要把状态色当装饰，也不要只依赖颜色表达含义。自定义表面必须在明暗主题和自定义主题（包括嵌入你的应用的宿主应用主题）中验证；不能假设 foreground 一定是黑色或 background 一定是白色。

Badge 只用于有助快速扫描的短 state、count 或 classification，不能套在每个 label、metadata value、filter 或 section title 上。大多数 Badge 保持 neutral；只有真实表达 success、warning、destructive 或 info 时才使用语义颜色。满屏多色 Badge 通常说明 hierarchy 或 grouping 尚未设计完成。

应用界面不应出现 raw hex、`rgb()`/`rgba()` 或 `hsl()` 颜色，也不应出现 `bg-zinc-100` 这样的调色板类名。颜色必须按语义角色从主题解析。需要的 role 不存在时，在应用的主题文件中定义（[主题 token](./tailwind.md#主题-token)：在它的 `light` 和 `dark` 中写 `"up": "#16a34a"`，会生成 `text-up`、`bg-up/30`、TSX 中的 `token("up")` 和 Rust 中的 `theme().color("up")`），而不是在 call site 嵌入 palette value。Raw color 只属于 theme definition，或颜色本身就是数据的、经过审查的 data/raster content。

### 圆角、间距与密度

圆角应像字号和控件尺寸一样，使用有限的档位（主题的 `radius`，控件和表面都可用，即 `rounded-(--radius)`；应用加入主题的圆角；以及 Tailwind 的 `rounded-sm` … `rounded-2xl`），不要为每个元素发明新数值。大型容器可比内部控件使用更柔和的档位；紧凑控件与浮层则使用更小的档位。普通矩形的圆角应明显小于短边的一半。`rounded-full`（`.rounded_full()`）只用于有意设计的圆形与胶囊，提示框不应意外变成胶囊。

嵌套表面应呈现同心的曲线关系。用 `inner radius ≈ max(0, outer radius − inset)` 选择最接近且合适的圆角，让转角处的边带保持均匀；重复出现的特殊组合若需要中间值，应在主题中定义具名 token（`"radius-inset": "0.375rem"`，`rounded-(--radius-inset)`）。分段控件是一个完整轮廓：两端的分段顺着容器内侧圆角，中间分段保持直角，每处边界只保留一道等宽分隔线。

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/radius-hierarchy-light.svg" alt="浅色主题的聊天输入框：内缩表面、两侧按钮及提示文字的间距一起变化；红色参考圆显示转角共用圆心。">
<img class="diagram diagram-dark" src="/diagrams/radius-hierarchy-dark.svg" alt="深色主题的聊天输入框：内缩表面、两侧按钮及提示文字的间距一起变化；红色参考圆显示转角共用圆心。">
</div>

圆角必须约束整个可见表面，而不只是描边。外角露出的部分应透出后方表面；子元素背景、选中填充与滚动内容也须遵循同一边界。给内层设置相应圆角，或用 `overflow-hidden`（`.overflow_hidden()`）裁剪容器，再用高对比背景检查明暗主题下的叠层。选择裁剪方式时仍须保留向外绘制的焦点环。

采用紧凑、重复的间距 scale。label 与 control 的距离应小于两个 group 的距离，两个 group 的距离应小于两个 section 的距离。优先使用应用组件的尺寸（small、默认 medium、large），不要单独写高度。compact 用于 toolbar 和数据密集界面，不能用来把结构不清楚的布局硬塞进更小空间。

共享语义 scale 有意保持很小：间距大致为 2、4、8、12、16、24、32 点；字体大致为 12、14、16、18、20 点。这些表示关系，不是鼓励把当前数值散落在 feature 代码中。Tailwind 的间距 scale 提供了它们：每一步 4 点（`p-4` 是 16 点），类名和 Rust 类型化方法相同；`nsh.json` 中 `"tailwind"` 的 `"spacing"` 改变类名的步长，类型化方法保持 Tailwind 的默认 scale。需要不同 scale 的应用在自己的组件或主题 token（`p-(--gap-card)`）中持有它，并一致使用。

### 空间语法

间距表达关系。根据相邻对象的语义关系选择间距：

| 关系 | 常用类名 | 当前 scale | 示例 |
| --- | --- | --- | --- |
| 光学校正 | `gap-0.5` | 2 点 | 图标基线、紧凑分隔 |
| 同一控件的部件 | `gap-1` | 4 点 | 菜单图标与标签、标题与说明 |
| 紧密相关的控件 | `gap-2` | 8 点 | 按钮图标与文字、对话框操作 |
| 同一个内容 group | `gap-3` | 12 点 | 通知各列、紧凑表单行 |
| 同一 section 的不同 group | `gap-4` | 16 点 | panel 内边距、表单组 |
| 不同 section | `gap-6` | 24 点 | 页面或 inspector 的主要区块 |
| 主要区域边界 | `gap-8` | 32 点 | 空状态留白、页面大段落 |

这些数值描述默认 scale；代码使用间距类名和类型化方法（`gap-2`、`.gap_2()`、`p-4`、`.p_4()`）或主题 token。产品自有 scale 应保持关系顺序，并通过应用自己的组件传递，而不是在每个调用处书写。

处理上下左右空间时遵守以下规则：

1. **先分清内部与外部。** 组件 padding 由组件拥有，组件之间的 gap 由父容器拥有。
2. **纵向节奏表达分组。** 标题到说明的距离小于说明到下一 section 的距离；相等间距意味着相等关系。
3. **横向空间服务扫描。** 重复行中的图标、label、value、badge、尾部 action 应落在稳定列上。
4. **leading/trailing 是语义。** 按阅读方向思考，并写成 start 和 end（`ps-*`、`me-*`、`.ps_4()`），布局就能从右到左镜像。
5. **不要重复 padding。** 已有 panel inset 内的 card 不应再无条件增加一整层 panel padding。
6. **谨慎使用光学校正。** 图标或字形允许 1–2 点修正，但必须能解释为何偏离 scale。

常见组合揭示了这些关系：

- 小按钮内容间距为 4 点，常规尺寸为 8 点；
- 对话框 header 与 footer 内部间距为 8 点；
- 紧凑 list/menu 行通常采用 4 点纵向、8–12 点横向 padding；
- Sheet header 约为 leading 16 点、trailing 12 点，为关闭控件留出空间；footer 为横向 16 点、纵向 12 点；
- 通知使用 16 点横向 padding 和 12 点列间距，因为图标、消息和操作属于不同 group。

这些不是所有 surface 的复制模板，而是在说明：控件内部最紧，行针对扫描优化，容器边界比内容内部花费更多空间。

### 比例与层次

先确定内容约束，再确定比例。角色不同的 pane 不要机械地各占一半。

- Sidebar 应足够容纳稳定标签，但视觉上从属于工作区；为它定义最小、首选与最大宽度（`min-w-*`、`w-*`、`max-w-*`），而不只是百分比。
- Master–detail 中，collection 必须仍可扫描，detail 消耗剩余空间。约 1/3 与 2/3 可作为起点，但内容约束优先。在手机上，两者变成 `NavStack` 中的两个页面。
- Inspector 与辅助 sheet 默认不能遮住主要对象；内容增长时应可调整或关闭；[`Sheet`](../elements/sheet.md) 可以通过遮罩、Escape 和返回键关闭。
- 对话框宽度由决策复杂度决定：短确认用 `AlertDialog`，中等表单；复杂工作应进入独立页面或窗口。
- 最强 elevation 只给最上层决策面；同一层内使用背景和 hairline，而不是不断加重阴影。

每个主要区域要定义三件事：任务可用的最小尺寸、舒适默认尺寸、如何消费剩余空间。如果 split 表达用户工作习惯，应持久化；恢复后必须按当前窗口重新 clamp。

### 对齐细节

对齐是一套结构系统，不是最后的润色。每个 surface 应先建立少量 alignment spine：共享的 leading/trailing edge、文字 baseline、center line 与固定功能 lane。同一层级的元素即使使用不同 component，也应从上到下或从起始到结束落在同一条 spine 上。

<div class="diagram-scroll">
<img class="diagram diagram-light" src="/diagrams/alignment-spines-light.svg" alt="内容区域的对齐参考线">
<img class="diagram diagram-dark" src="/diagrams/alignment-spines-dark.svg" alt="内容区域的对齐参考线">
</div>

纵向红色虚线贴近共享边缘或控件中心，说明内容、状态、时间与尾端操作的列对齐；横向虚线分别贴近文字基线并穿过行中心，说明文字底边和不同尺寸控件的垂直居中。右侧紧凑对照单独展示必须从结构所有者修复的一个渲染像素漂移。

- Sibling region 使用相同 content inset。同层级的 heading、toolbar、list row、empty state 与 footer 不能各自发明略有差异的起始线。
- 整个区域重复同一套 column geometry。Header、row、summary、loading state 与 inline editor 为 identity、metadata、status、number 和 action 保留相同 lane。
- 跨 row 与 section 对齐相关 control。从上到下扫描时，form label、field、description 与 validation message 应显现稳定的纵向网格。
- 水平 band 保持一致。同一 toolbar、标题栏、status bar 或 row 中的项目共享 baseline 或 center line，不能逐个用 offset 微调。
- 只有真实 hierarchy、containment 或 disclosure 才引入 indentation。装饰性缩进会让 sibling 看起来像 subordinate，并破坏阅读起始线。
- Nested level 结束后必须准确回到 parent spine，不能让多层 container 的 padding 逐层漂移。
- Optional content 出现或消失时仍保持 spine。缺少 icon、badge、description 或 trailing action 不能推动其余 label；需要跨行比较时使用明确 slot 或 lane。
- 层级相同时，major region 之间也应互相对齐。Sidebar header、content title、split pane、toolbar 与 bottom bar 不必共享所有坐标，但相同层级应形成可见的连续线。

不是每一条边都必须对齐。Child 可以缩进，primary value 可以领先 supporting metadata，destructive decision 也可以获得额外间隔。但例外必须表达层级或语义，不能只是各 component padding 未协调的结果。先建立 shared spine，再明确设计例外。

精确对齐与重复 gap 是质量 invariant。两条 edge 或两段 spacing 按设计应相等时，相差一个 rendered pixel 也是 defect，不能以“肉眼大致一致”通过。必须在代表性的 window size、文字大小与 display scale factor 下用测量工具检查 resolved bounds，直接比较 coordinate 与 distance，不能只看一张截图凭感觉验收。

这里的 rendered-pixel 容差是验证规则，不是允许用 raw point offset 修补代码。相等关系应来自同一个间距类名或方法、token、grid definition 或 shared component inset；发生偏差时修复共同 owner。还要考虑 fractional layout 与 device rounding（2× 和 3× 的手机、桌面的小数缩放），确保预期 spine 在不同缩放下落到同一 physical pixel，而不是只在某一档看似对齐。

- 混合字号同排时按文字 baseline，而不是按 bounding box 中心对齐。
- 图标放入固定槽位，避免不同固有宽度导致 label 抖动。
- 可比较数字对齐到结束边并使用等宽数字（`tabular-nums`），文本和标识符通常对齐到起始边（locale 另有要求除外）。
- 行尾 action 和 disclosure indicator 使用固定宽度 lane。
- 表单控件按交互 frame 对齐，而不是按下面的 help text 对齐。
- 只有两侧确实分别拥有相反边缘时才用 `justify-between`（`.justify_between()`），不要用它掩盖中间结构缺失。
- Hairline 由边界所有者绘制，相邻区域不能各画一次同一条分隔线。
- 滚动条属于实际滚动的区域，并贴住面板、编辑器或窗口的尾端边缘。内容内边距可以缩进文字与行，但不能把滚动条推到界面中间；给滚动视图的内容加内边距，而不是给滚动视图本身。

### 密度层级

Medium 是默认值。密度应在局部上下文整体变化，而不是只改一个控件：

- **comfortable / large：** onboarding、稀疏表单、重要决策；
- **standard / medium：** 大多数应用 chrome 与工作流，以及所有触摸屏；
- **compact / small：** 桌面的 toolbar、menu、table 和重复的专业数据；
- **extra compact / xsmall：** 极少数高密度工具，不应成为全应用默认。

使用有限的 scale，而不是任意尺寸。在触摸屏上，每个可按压目标至少 44 × 44 点（[触摸目标](./accessibility.md#触摸目标)）。有指针时，按钮 frame 大致为 24、28、32 点；input 在 large 时可到约 40 点；table row 大致为 28、32、40 点。给应用组件一个尺寸，让字体、图标、padding 和 hit target 一起变化。只改外框高度通常是不完整的。

### 文字大小、基础字号与点

良好的 scale 能在文字变大时保持设计层次。成功的放大不只是每个对象都变大，而是在每一种文字大小下，title/body、control/icon、inner/outer spacing、primary/secondary region 之间仍保持相同关系。

NSH 的长度单位是点，用户的文字大小（iOS 的动态字体、Android 的字体大小、桌面的文字缩放、宿主应用自己的设置）缩放的是文字：每个允许字体缩放的文字和输入框都会变大，间距、圆角、边框和图片保持原有尺寸（[文字大小](./device-and-environment.md#文字大小)）。应用的基础字号（Tailwind 的 `text-base`，16 点）是字号 scale 围绕的正文字号。

设计时关注比例：

- type step 围绕 body base size 保持相同 hierarchy；
- spacing step 围绕 typography 保持相同 grouping；
- control frame 与 hit target 随 label 增长：按内容和最小值（`min-h-11`）确定尺寸，而不是固定高度；
- pane minimum 与 comfortable width 要容纳更大的文字；
- radius 与 focus treatment 相对 control frame 保持光学一致。

因为文字会自行变大，包住它的固定框就会出问题：固定高度按钮中放大的 label、固定 pane minimum 中放大的 document、固定行高中放大的 row，都会破坏原有节奏并裁切内容。文字变大时让行换行或改为纵向排列（`fontScale()`、`font_scale()`），并对本身已经很大的文字（比如 34 点的标题）限制缩放倍数（`maxFontSizeMultiplier`）。

原则上 application layout 不写字面点值（`p-[13px]`、`px(13.0)`）。使用间距 scale（`p-2`、`gap-3`、`w-64`、`text-sm` 及其类型化方法）或应用组件的尺寸。只有值代表 physical/raster boundary 时才使用字面点值：hairline、platform window inset、bitmap dimension、minimum hit-test tolerance，或必须匹配 external surface 的 geometry。这些必须是经过审查和记录的例外。Product spacing、typography、icon size 与普通 control geometry 保持在 scale 上。

不能只在默认值验证。至少使用多档文字大小检查 hierarchy、wrap、truncate、minimum window size、pane resize、focus-ring clearance、popup placement 与列表行的测量。

### 表面与层级

Elevation 用于解释叠放关系，而不是表达重要程度。基础表面保持平面；区域由背景差异和 separator 划分。Popover、menu、sheet、dialog、notification 因处于内容上方，可以逐级增强阴影。不要给每张 card 都加阴影。

同类 surface 必须采用同一种处理。让弹出层家族共用一种主题化表面（`popover` token、边框、`radius` 和一种阴影），这样 `Popover`、`Menu`、`ContextMenu` 和 `Tooltip` 不会逐渐漂移。应用新增 anchored surface 时应复用该处理，而不是用无关的 border/shadow 字面量近似。

### 字体与图标

界面文字使用平台 UI 字体；代码、标识符、快捷键和对齐数字才使用等宽字体。正文必须易读，避免过度大写或字距，尤其不能把拉丁文字的 tracking 直接套给 CJK。

一个产品使用同一套图标。图标辅助 label，不能用猜谜替代陌生操作。仅图标按钮始终需要无障碍名称（`accessibilityLabel`）；是否添加视觉提示遵循下文的 tooltip 规则。填充或彩色图标用于表达状态，不用于让 toolbar 显得热闹。

## 布局模式

### 选择稳定的应用框架

大多数应用适合以下一种：

- **单工作区：** header 或 toolbar 加一个主要视图；
- **导航栈：** 推入和弹出页面（`NavStack`），手机上带系统返回手势；
- **Sidebar 工作区：** 持久导航与变化的 detail；
- **Master–detail：** 可调整 collection 与 detail pane，在手机上是两个页面；
- **文档工作区：** 用 tab 管理多个长期对象；
- **Utility window：** 单一任务与短而固定的操作路径。

全局导航在内容变化时应保持稳定。主要工作区用 `flex-1`（`.flex_1()`）消费剩余空间；可收缩的 overflow child 需要 `min-w-0` / `min-h-0`。滚动和虚拟列表应使用 `Scroll`、`List`，不要用多层视图重做行为。

在桌面上，应用自绘的标题栏（[`nsh/desktop`](../modules/nsh-desktop.md)）首先是窗口框架。保留其拖动区域（`.window_drag(true)`），不要把普通的标题单击绑定到低频编辑操作。重命名应由明确的对象命令触发，并在适当时提供键盘路径。

### 可调整的窗口

窗口可以是任意尺寸：由用户、分屏或宿主应用决定。窗口变窄时按以下优先级处理：

1. 保留主要任务；
2. 可调整区域达到有文档的最小值；
3. 折叠次要 label 或 inspector；
4. 把低频操作移入 menu；
5. 只滚动真正发生 overflow 的区域。

隐藏操作时必须提供另一条路径。不要让整个窗口滚动，而实际只有 list 或 document body 需要滚动。断点（`md:`、`lg:`）和 `windowSize()`（Rust 中为 `window()`）跟随 NSH 渲染所在的界面。

NSH 的 flex child 即使设置 `flex-1`，也可能因为长内容拒绝收缩。设计和代码必须约定哪些 pane 可以收缩、截断、换行或滚动。被裁剪的区域也会裁掉向外绘制的 focus ring，不能为了简化 overflow 牺牲键盘焦点可见性。

### 表单与设置

每个字段使用可见 label，help 与 validation 放在所描述字段附近。相关字段应对齐，但不要强迫长 label 进入过窄固定列。独立选择用 `Checkbox`，少量可见互斥项用由 `Radio` 组成的 [`RadioGroup`](../elements/radio.md)，较长集合用列出选项的 `Menu`，立即生效的设置用 [`Switch`](../elements/switch.md)。它们的部件（开关的轨道和滑块、复选框的指示器）由应用设置样式，`checked:`、`indeterminate:` 和 `disabled:` 类名跟随控件：

```rust tabs
use nsh_base::{switch, theme};

fn setting_switch(label: &'static str, on: Signal<bool>) -> impl IntoElement {
    switch()
        .checked(on)
        .on_change(move |next: &bool| on.set(*next))
        .flex_row()
        .items_center()
        .gap_3()
        .track_style(|s| {
            s.w(px(44.0))
                .p(px(2.0))
                .rounded_full()
                .bg(move || theme().muted)
                .transition_colors()
                .checked(|s| s.bg(move || theme().primary))
        })
        .thumb_style(|s| {
            s.size(px(20.0))
                .rounded_full()
                .bg(move || theme().background)
                .shadow_sm()
                .transition_transform()
                .checked(|s| s.translate_x(px(20.0)))
        })
        .child(text(label).text_color(move || theme().foreground))
}
```

```tsx tabs
import { Text } from "nsh";
import { Switch } from "nsh/base";

function SettingSwitch(props: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Switch
      checked={props.on}
      onChange={props.onChange}
      class="flex-row items-center gap-3"
      trackClass="w-11 rounded-full bg-muted p-0.5 transition-colors checked:bg-primary"
      thumbClass="size-5 rounded-full bg-background shadow-sm transition-transform checked:translate-x-5"
    >
      <Text class="text-foreground">{props.label}</Text>
    </Switch>
  );
}
```

“全选”复选框用不确定状态表示部分选中：

```rust tabs
use nsh_base::{checkbox, theme};

fn select_all(selected: Signal<usize>, total: usize) -> impl IntoElement {
    checkbox()
        .checked(move || selected.get() == total)
        .indeterminate(move || selected.get() > 0 && selected.get() < total)
        .on_change(move |all: &bool| selected.set(if *all { total } else { 0 }))
        .flex_row()
        .items_center()
        .gap_2()
        .indicator_style(|s| {
            s.size(px(20.0))
                .items_center()
                .justify_center()
                .rounded(move || theme().radius)
                .border_2()
                .border_color(move || theme().border)
                .checked(|s| s.bg(move || theme().primary).border_color(move || theme().primary))
                .indeterminate(|s| s.bg(move || theme().primary).border_color(move || theme().primary))
        })
        .indicator(text(move || mark(selected.get(), total)).text_color(move || theme().primary_foreground))
        .child(text("全选").text_color(move || theme().foreground))
}

fn mark(selected: usize, total: usize) -> &'static str {
    if selected == total { "✓" } else if selected > 0 { "–" } else { "" }
}
```

```tsx tabs
import { Text } from "nsh";
import { Checkbox } from "nsh/base";

function SelectAll(props: { selected: number; total: number; onChange: (all: boolean) => void }) {
  return (
    <Checkbox
      checked={props.selected === props.total}
      indeterminate={props.selected > 0 && props.selected < props.total}
      onChange={props.onChange}
      class="flex-row items-center gap-2"
      indicatorClass="size-5 items-center justify-center rounded-(--radius) border-2 border-border checked:border-primary checked:bg-primary indeterminate:border-primary indeterminate:bg-primary"
      indicator={
        <Text class="text-primary-foreground">
          {props.selected === props.total ? "✓" : props.selected > 0 ? "–" : ""}
        </Text>
      }
    >
      <Text class="text-foreground">全选</Text>
    </Checkbox>
  );
}
```

操作进行中禁用重复提交，保留用户输入，并在操作附近显示结果。让输入框保持在软键盘上方（`env(keyboard-inset-height)`）。Dialog 只用于短而聚焦的决策；需要探索或大量字段的流程使用完整页面或 sheet。

加载表现必须对应真实的等待。设置面板内容已经可用时，切换应立即完成；只有内容确实在加载且轮廓已知时，才使用骨架图。

## 组件与组合

采用 Shadcn 的核心思想：组件是构建材料，不是封闭设计系统。`nsh/base` 提供行为，应用在自己的组件中提供一致默认值，并拥有组合和产品语义。

- 变体按语义使用。主按钮只留给决策区域中明确的默认提交，通常也是在桌面上按回车执行的操作。操作唯一、使用频繁或希望用户注意，都不会使它自动成为主按钮。管理工具栏中的“添加”通常使用默认按钮；表单中默认提交的“创建”可以使用主按钮。destructive 表示破坏性提交，ghost 用于低强调的工具栏操作。
- 优先使用明确的部件与插槽，不要穿透任意后代设置样式。
- 跨产品重复且带有领域语言或规则的模式，应封装为应用组件。
- 按语义角色使用标准组件。`Menu`、`ContextMenu`、`Popover`、`Sheet`、`Dialog` 与 `AlertDialog` 不是可以互换的容器；它们分别拥有选择、焦点、键盘操作、关闭方式和布局契约，在每种设备上也有各自的形式。
- 保留同类组件的几何规则。菜单行的上下左右内边距、高度、图标槽、勾选槽、分隔线、圆角和状态样式必须统一；不能用自定义弹出层模仿一个间距仅仅接近标准组件的菜单。
- 不要仅为重命名每个 prop 或冻结所有能力而包装一层组件。
- 无产品样式的复用行为放入 `nsh/base`，或放入应用各产品共享的 crate；有主题观点的表现留在应用的组件中。

```rust tabs
use nsh_base::{button, theme};

/// 表单底部：默认样式的取消，以及主要的提交。
fn form_actions(cancel: impl Fn() + 'static, create: impl Fn() + 'static) -> impl IntoElement {
    view()
        .flex_row()
        .justify_end()
        .gap_2()
        .child(
            button()
                .on_press(cancel)
                .rounded(move || theme().radius)
                .border_1()
                .border_color(move || theme().border)
                .px_4()
                .py_2()
                .active(|s| s.bg(move || theme().muted))
                .child(text("取消").text_color(move || theme().foreground)),
        )
        .child(
            button()
                .on_press(create)
                .rounded(move || theme().radius)
                .bg(move || theme().primary)
                .px_4()
                .py_2()
                .active(|s| s.bg(move || theme().primary.opacity(0.9)))
                .child(text("创建").text_color(move || theme().primary_foreground)),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Button } from "nsh/base";

// 表单底部：默认样式的取消，以及主要的提交。
function FormActions(props: { onCancel: () => void; onCreate: () => void }) {
  return (
    <View class="flex-row justify-end gap-2">
      <Button onPress={props.onCancel} class="rounded-(--radius) border border-border px-4 py-2 active:bg-muted">
        <Text class="text-foreground">取消</Text>
      </Button>
      <Button onPress={props.onCreate} class="rounded-(--radius) bg-primary px-4 py-2 active:bg-primary/90">
        <Text class="text-primary-foreground">创建</Text>
      </Button>
    </View>
  );
}
```

## 交互状态

### 让结果先于点击被理解

控件应当让结果在操作前就可以预见。优先使用熟悉的平台控件与布局，让用户不必先学习界面。文案说明动作与对象，状态说明当前是否可用，反馈则确认同一个结果。

不要把实际会打开设置流程的按钮写成“保存”，也不要用“删除”描述仅从分组移除的操作。上下文不能说明范围时，直接写出范围。按下后立即反馈；耗时操作防止重复提交，并在被改变的对象附近显示结果。只有结果本身不可见时，才补充成功提示。

每个交互控件都要设计以下状态：

| 状态 | NSH | 设计要求 |
| --- | --- | --- |
| 静止 | | 操作提示清楚但不嘈杂 |
| 悬停 | `hover:` | 提供轻微指针反馈，但不能成为唯一线索 |
| 按下 | `active:` | 立即响应按压，样式由应用设置 |
| 打开 | 弹出层的 `open` | 附属弹出层打开期间持续显示按下或打开状态 |
| 焦点可见 | `focus-visible:` | 显示高对比键盘焦点环 |
| 选中 | `selected:`、`checked:` | 状态持久，并与悬停明确区分 |
| 禁用 | `disabled:` | 降低强调，且不产生误导性的悬停或按下反馈 |
| 加载 | | 保持上下文、防止重复操作，并解释较长等待 |
| 错误 | | 说明发生了什么以及如何恢复 |

需要键盘访问的命令在桌面与 Web 上用 [`keymap`](../modules/nsh.md#keymap) 绑定。遵循熟悉的平台快捷键（`"mod+k"` 在 macOS 上是 Command，在其他平台上是 Control），在菜单或工具提示中展示，并在浮层打开或关闭后把焦点放到合理位置。

选中状态是信息模型的一部分，不是可选润色。标签页、分段选择、可选行、筛选项与导航入口必须持续显示选中状态（`selected`，读屏软件会读出）。拥有菜单的按钮在弹出层关闭前必须保持按下或打开外观；悬停无法说明触发按钮与弹出层之间的关系。

```rust tabs
use nsh_base::{tab, theme};

fn section_tab(label: &'static str, id: Section, current: Signal<Section>) -> impl IntoElement {
    let selected = move || current.get() == id;
    tab()
        .selected(selected)
        .on_press(move || current.set(id))
        .rounded(move || theme().radius)
        .px_3()
        .py_2()
        .selected_style(|s| s.bg(move || theme().muted))
        .child(text(label).text_color(move || {
            if selected() { theme().foreground } else { theme().muted_foreground }
        }))
}
```

```tsx tabs
import { Text } from "nsh";
import { Tab } from "nsh/base";

function SectionTab(props: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Tab
      selected={props.selected}
      onPress={props.onPress}
      class="group rounded-(--radius) px-3 py-2 selected:bg-muted"
    >
      <Text class="text-muted-foreground group-selected:text-foreground">{props.label}</Text>
    </Tab>
  );
}
```

分段控件的选中填充与未选中表面必须共享容器轮廓。两端不应露出直角，每处边界的视觉厚度也应一致。

导航项、列表行与标签页的选中状态应由条目自身的表面表达：选中填充、更强的前景色或更重的字重。不要用左侧竖条或单侧边框作为选中标记。这是网页模板的习惯，而非原生惯例：它会打断条目的圆角轮廓，并在本已按文字对齐的列中加入一条相互竞争的边缘。

破坏性操作要区分可逆与不可逆。可逆变更优先 undo 或临时 notification；严重且不可撤销时才使用 [`AlertDialog`](../elements/alert-dialog.md)，确认文案必须写出具体对象和后果。

### 指针约定

Button、Checkbox、MenuItem、Tab 等控件使用默认指针；link 使用手形（`cursor-pointer`）。文本、resize、grab、prohibited cursor 只在确实描述当前操作时使用。Cursor 只是强化 affordance，不能替代可见状态与 accessibility role。

Hover 应克制，因为触摸、键盘和 accessibility 操作没有 hover。破坏性或关键操作不能只有 hover 时才存在。行内 action 可以在 rest 时更安静，但 selection、键盘或 context menu 必须提供同一命令。

### 优先使用命令入口，而不是悬停工具栏

根据命令的频率和作用范围决定入口：

- 主要或高频操作使用带文字的按钮或熟悉的工具栏控件，并保持可见；
- 当前区域的次要操作放入具有可见触发按钮的 [`Menu`](../elements/menu.md)；
- 作用于指针或手指下对象的命令放入 `ContextMenu`：桌面上右键点击，触摸屏上长按；
- 有自然键盘形式的重要命令同时提供快捷键（[`keymap`](../modules/nsh.md#keymap)），并放进应用菜单（[`nsh/desktop`](../modules/nsh-desktop.md) 的 `Menu.setApplicationMenu`）；
- 悬停时出现的图标只能是快捷入口，同一命令必须在其他位置仍可到达。

这不只是视觉偏好。`nsh/base` 的菜单已经拥有在触发者旁的定位、桌面上层叠展开的子菜单与手机上原地替换的表单页子菜单、通过选中项目、点按外部、Escape 或返回键关闭，以及面向读屏软件的 menu 与 menu item 角色。自定义 hover button strip 必须重新实现这些行为，而且触摸、keyboard-only 与许多 assistive technology workflow 根本看不到它。

```rust tabs
use nsh_base::{menu, menu_item, menu_separator, theme};
use nsh_core::{color::black, element::StyleRefinement};

/// 应用的弹出层表面，菜单、弹出框和工具提示共用。
fn popup(s: StyleRefinement) -> StyleRefinement {
    s.min_w(px(192.0))
        .p_1()
        .rounded(move || theme().radius)
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().popover)
        .shadow_lg()
}

fn item(label: &'static str, on_select: impl Fn() + 'static) -> impl IntoElement {
    menu_item()
        .on_select(on_select)
        .px_3()
        .py_2()
        .rounded(move || theme().radius)
        .hover(|s| s.bg(move || theme().muted))
        .active(|s| s.bg(move || theme().muted))
        .child(text(label).text_color(move || theme().foreground))
}

fn more_menu(rename: impl Fn() + 'static, duplicate: impl Fn() + 'static, delete: impl Fn() + 'static) -> impl IntoElement {
    menu()
        .offset(px(4.0))
        .popup_style(popup)
        .backdrop_style(|s| s.bg(black().opacity(0.5)))
        .trigger(
            view()
                .label("更多操作")
                .size(px(44.0))
                .items_center()
                .justify_center()
                .rounded_full()
                .active(|s| s.bg(move || theme().muted))
                .child(text("⋯").text_color(move || theme().foreground)),
        )
        .child(item("重命名…", rename))
        .child(item("复制", duplicate))
        .child(menu_separator().h(px(1.0)).my_1().bg(move || theme().border))
        .child(item("删除…", delete))
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator } from "nsh/base";

/** 应用的弹出层表面，菜单、弹出框和工具提示共用。 */
export const popup = "min-w-48 rounded-(--radius) border border-border bg-popover p-1 shadow-lg";
const item = "rounded-(--radius) px-3 py-2 hover:bg-muted active:bg-muted";

function MoreMenu(props: { onRename: () => void; onDuplicate: () => void; onDelete: () => void }) {
  return (
    <Menu
      offset={4}
      popupClass={popup}
      backdropClass="bg-black/50"
      trigger={
        <View accessibilityLabel="更多操作" class="size-11 items-center justify-center rounded-full active:bg-muted">
          <Text class="text-foreground">⋯</Text>
        </View>
      }
    >
      <MenuItem onSelect={props.onRename} class={item}><Text class="text-foreground">重命名…</Text></MenuItem>
      <MenuItem onSelect={props.onDuplicate} class={item}><Text class="text-foreground">复制</Text></MenuItem>
      <MenuSeparator class="my-1 h-px bg-border" />
      <MenuItem onSelect={props.onDelete} class={item}><Text class="text-foreground">删除…</Text></MenuItem>
    </Menu>
  );
}
```

用户需要明确知道“这里还有更多命令”时使用 `Menu`，例如 toolbar overflow、document action、account menu。命令只作用于当前 selection 或指针下对象时使用 `ContextMenu`，例如 rename、duplicate、reveal、remove。Context menu 不能是 essential command 的唯一入口；按场景同时提供 menu bar、toolbar、keyboard 或 detail view 路径。

不要为了视觉极简把所有 action 都藏入 menu。Discovery 与速度同样重要：主要 action 保持可见；destructive item 有清楚 label 并与普通命令分隔；同一 command 在所有入口使用一致 verb、icon、shortcut、enabled state 与执行结果。

### 按钮表示应用操作，链接只表示外部资源

改变应用状态、确认决策、打开工具、提交数据或执行命令时使用 `Button`，并根据局部层级选择表现：

- 当前决策的默认提交使用主按钮；
- 普通可见操作使用默认按钮；
- 需要清楚边界但强调较低时使用描边按钮（outline）；
- 工具栏或行内的熟悉低强调操作使用幽灵按钮（ghost）；
- 只有符号广为人知时才使用图标按钮，并提供无障碍名称；含义或范围不清楚时再加工具提示。

不能因为按钮是界面中唯一操作、位于右上角，或团队希望获得更多点击就使用主按钮。主按钮表达默认提交及其键盘行为。添加项目、打开工具、刷新视图等普通命令，应根据局部层级使用默认按钮、描边按钮或幽灵按钮。

带下划线的链接（`role="link"`）只用于外部 resource target：URL、网页、在线文档或 Email 地址。它使用手形 cursor，因为语义是离开当前 application context 并访问该 resource。不能为了让功能 command 看起来安静而套链接样式。链接形态的 Delete、Save、Refresh、Add、Open menu 或应用内跳转会隐藏 control affordance，并向 accessibility 暴露错误 role。

“查看”不会让 app 内 destination 变成链接。完整报告、分析、detail panel 或 local record 仍应通过 button、row、card、tab 或 disclosure control 打开。当 card 已说明会打开什么时，可以使用“完整分析”这类依赖上下文的短 label；下划线只留给真正交给 browser 或 mail client 的 resource。

所有应用内导航——sidebar row、tab、breadcrumb、list item、打开本地 view、切换 workspace——必须使用导航栈、`Button` 或对应组件。视觉强调通过按钮变体或 navigation component 的 selected state 决定，不能通过伪装语义实现。

## 反馈与浮层

选择足以承载当前决策的最小 surface：

- tooltip：短解释或快捷键（[`Tooltip`](../elements/tooltip.md)，或任意元素的 `tooltip`）；
- popover：不中断任务的上下文控件（[`Popover`](../elements/popover.md)）；
- menu：紧凑 action 列表（[`Menu`](../elements/menu.md)）；
- notification：无需用户决策的异步状态；
- dialog：聚焦决策或短表单（[`Dialog`](../elements/dialog.md)）；
- alert dialog：有后果操作的明确确认（[`AlertDialog`](../elements/alert-dialog.md)）；
- sheet：需要更多持续空间的辅助工作（[`Sheet`](../elements/sheet.md)）。

每种都采用所在设备期望的形式，应用只为一套结构设置样式（`popupClass`、`backdropClass`）：

| | 桌面 | 手机和平板 |
| --- | --- | --- |
| `Tooltip` | 指针停留在元素上之后出现 | 只在应用打开它时出现 |
| `Popover` | 锚定；点按外部关闭它并继续生效 | 锚定；点按外部只会关闭它 |
| `Menu` | 触发者旁的弹出层，子菜单层叠展开 | 底部的表单页；子菜单替换当前的项目 |
| `ContextMenu` | 次键（右键），出现在指针处 | 长按打开表单页 |
| `Sheet` | 遮罩之上的边缘面板 | 相同 |
| `AlertDialog` | 平台对话框样式的提示框 | 系统的提示框或操作表 |

Tooltip 用于补足信息，不用于重复显而易见的操作。陌生符号、模糊的作用范围或未在别处展示的有用快捷键才需要它。消息底部反复出现的复制、下载等命令应保留无障碍名称和键盘路径；悬停标签只会打断浏览。手机只在应用打开时才显示 tooltip，所以 tooltip 绝不能承载触摸用户需要的信息。

Alert 即使不是 modal，也会打断视觉 hierarchy。它只用于当前任务中需要立即注意的重要异常信息，不能作为普通 description、tip 或空白内容的装饰 container。不需要立即注意或 action 时，使用 inline help、muted text 或普通 section。

避免 overlay 叠 overlay。Escape 和 Android 返回键关闭最上层可关闭 surface；在 `onOpenChange` 中同步应用的状态，焦点回到 trigger 或下一个逻辑目标。

Overlay action 必须指向 overlay 实际展示的 object 或 state。例如只有独立 recent-history section 可见且存在 entry 时，才显示“清除历史”。Search result、recent item 与 favorite 是不同 collection，应明确 label 和分区，不能混成一个没有解释的 list。不适用的 action 应隐藏，或 disabled 并说明原因；不能在 footer 塞一个作用不明的 trash icon。

Footer 不是无处安放 capability 的收纳区。它可以显示适用于整个 surface 的 shortcut、status 或 action，但每项都必须回答：object 是什么、为什么现在可用、影响什么 scope、执行后哪个 visible state 会改变。

## 动效

动效用于解释变化，不是环境装饰。出现、关闭、展开和空间连续性使用短 transition。如果 opacity 或 transform 已能表达关系，就不要动画大面积 layout。遵守 reduced motion（`motion-reduce:`、`reduceMotion()`），状态理解不能依赖动画，也不要给所有组件安装默认动画。

```rust tabs
view()
    .on_press(open)
    .transition_transform()
    .duration(150.0)
    .when(!reduce_motion(), |v| v.active(|s| s.scale(0.97)))
```

```tsx tabs
<View onPress={open} class="transition-transform duration-150 active:scale-[0.97] motion-reduce:active:scale-100" />
```

Motion policy 属于应用层。`nsh/base` 拥有 transition 所需的生命周期机制和 geometry，但不决定所有产品都 fade 或 slide。独立动画值使用稳定 ID；被打断时从当前采样值平滑反向，而不是回到旧端点重新开始。

动效应遵循交互的连续性。指针或滚动位置在相关目标间移动时，预览表面保持稳定，只更新内容或位置；交互结束后再关闭。每次更新都淡出、重现，会被感知为闪烁。

## 数据密集界面

Dense 不等于拥挤。在 table、tree、长列表与 editor 中：

- header 和行主要标识保持稳定；
- 可比较值对齐，必要时使用 tabular number；
- 区分 focus、hover、active row 与 multi-selection；
- sorting/filtering 可见且可逆；
- filter/reorder 后按 domain ID 保持 selection；
- virtualize 大集合（`List`），但不改变键盘语义；
- 次要 column 和 inspector 渐进披露；
- empty state 解释下一步。

一致字段的比较使用 table；异质内容扫描使用 list；真实层级使用 tree。不要把复杂数据布局当作一种视觉样式。

## 界面用词

文字是界面架构的一部分。一个功能中的入口、对象、命令、状态和结果应作为整体设计，不能按照实现逐项翻译。默认使用在当前上下文中仍然准确的最短表达。

### 让上下文承担上下文

不要重复界面已经表达的信息。侧栏入口通常只需写对象或领域：使用 `Users`，而不是 `User Management`；使用“快捷键”，而不是“快捷键配置管理”。如果表格内容本身都是操作，可以省略泛化的“操作”列名。对话框标题已经是“删除‘路线图’？”时，正文不必再次提问。

这是上下文经济，不是为了短而删。文字能够改变决策时必须保留：受影响范围、不可逆后果、异常前提或恢复方式。每一个额外词都应回答当前布局尚未回答的问题。

入口与对象使用名词（“用户”“外观”“订单”），命令使用动词（“保存”“复制”“导出”），状态使用形容词或短语（“离线”“已是最新版本”“待审核”）。除非能够区分真实领域概念，否则避免“管理”“模块”“页面”“功能”“操作”“系统”等包装词。

### 分别写作，而不是翻译句形

先统一意图、层级与术语，再按每种语言的自然表达分别写作。不要保留源语言的语序、词数、客套填充或词性。中文概念直译可能是 `User Management`，自然英文却是 `Users`；忠实是保留用途，不是保留字面形式。

信息架构已经表达的词应删除。在 `Settings` 中，入口通常只写 `Account`，不用重复 `Account Settings`，更不能写不自然的单数 `Account Setting`。正确英文来自控件的角色和相邻文字，而不是脱离上下文的中文短语。

为重复出现的对象、命令与状态维护一份小型产品词表。工具栏、菜单、右键菜单、对话框、快捷键搜索与文档对同一概念使用同一个词，除非上下文确实改变了含义。文案必须放回真实界面评审；只看翻译文件，往往发现不了相邻文字的重复和作用范围不一致。

技术写作不追求纯中文。已经稳定的 UI framework 术语，如果翻译后不够准确，可以保留英文；API 标识符保持原名并使用代码格式。普通叙述不能仅为显得专业而夹杂英文。术语首次出现时按需说明含义，此后在界面、文档和 API 示例中保持同一种写法。

文档中的链接若指向有固定名称的 API、组件、源码文件或指南，链接文字沿用准确的英文名称，中文页面也一样。例如写 `View`、`Button`、`Menu`、`Text`，不要翻译名称，也不要额外加上多余的 `NSH` 前缀。周围的说明仍用中文。链接只覆盖被引用的名称；“源码”等说明性文字放在链接之外。

跨语言共用的技术对比表保留能力项、框架名、API 名和模型名的既有英文写法；翻译表格周围的解释，不翻译这些技术标签。普通界面用词如有通行的中文名称，仍可在对比表之外使用中文。

### 按钮与确认对话框

按钮默认简短，通常一至两个词，并说明结果，而不是手势或控件。使用“保存”“移动”“删除”，不用“点击进行保存”“执行移动操作”“确认删除操作”。不提交并离开的操作统一使用“取消”。`OK` 只用于确认已经读到纯信息。

简短是默认值，不是机械字数限制。当额外文字能够揭示后果，或区分容易混淆的选择时，应有意使用更长但仍可扫描的文字，例如“仅从此分组删除”与“从所有位置删除”，或“不保存并重新启动”。长度必须换来决策所需的信息，不能重复标题或正文。

能够准确概括结果时，确认按钮使用最具体的短词：

| 上下文 | 较弱 | 推荐 |
| --- | --- | --- |
| 删除对话框 | “是”“Sure”“确认删除” | “删除” |
| 未保存修改 | “确认”“是” | “放弃修改” |
| 纯信息确认 | “确认操作” | “知道了”或 `OK` |
| 无法用一个准确动词概括的复杂承诺 | “是” | “确认” |

当对话框已完整说明复杂承诺，而不存在准确的结果动词时，“确认”是合理的后备用词；它不应替代本来清楚的命令。`Sure` 是口语回应，不是稳定的英文命令，含义也不足以进入标准词表。

确认对话框应组成一个紧凑决策：

- 标题写决策或条件，例如“删除‘路线图’？”；
- 正文只补充新的作用范围、后果或恢复方式；
- 操作使用“取消”和结果词，例如“删除”；
- 破坏性样式标记破坏性结果（`AlertDialog` 中 `destructive` 角色的操作），但不能代替准确用词。

能够说明实际情况时，不使用“提示”“警告”“错误”“确认”等泛化标题。避免“您确定要……吗”“是否需要……”“请注意……”以及状态已经表达清楚时的“成功”等套话。礼貌来自冷静、尊重的语气，不来自重复的“请”。

### 大小写、标点与符号

英文 UI 默认使用 sentence case：`Reset layout`，不用 `Reset Layout` 或 `RESET LAYOUT`。专有名词与约定俗成的缩写保持原样。只有原生命令菜单等确实受益于平台惯例时才使用 title case，并在同一类控件中保持一致。

全大写可以作为克制的排版强调，适合极短的分组标签、眉题、状态，以及既有缩写或代码。它通过紧凑的字形和适当字距形成接近加粗的层级，但不应用于按钮、长标题、完整句子或密集列表。同一区域不要同时用全大写、强色和粗体争夺注意。不要自动转换所有字符串；产品名、缩写与本地化内容需要保留正确大小写。

标签、按钮、菜单项、标签页、标题、占位文字与短状态末尾不加句号；完整的说明、警告和错误句子使用完整标点。日常成功或失败消息避免感叹号。中文句子使用全角标点，短控件文字同样按语义省略句末标点。

使用单个省略号字符（`…`），不用三个句点。凡按钮或菜单项会打开对话框、sheet、独立窗口，或命令完成前还需要用户输入或选择，文字末尾都加省略号，例如 `Settings…`、“导出…”。立即执行的命令不加。正在进行的任务使用不确定进度指示器，不用装饰性的点号表达。

错误说明发生了什么，并在有帮助时给出下一步恢复方式。成功反馈只在结果状态尚不可见时出现。使用“无法保存。请检查网络连接后重试。”，不要只显示技术代码或长篇道歉；文档已经明显进入保存状态时，不再弹出“保存成功”。

## 国际化与平台适配

无障碍（A11y）名称和标签可以保持英文，无需本地化。为操作某个条目的控件命名时，保留条目自身的标签，即使该标签已经本地化。这项例外不适用于可见界面文案。

文案必须承受扩展、CJK 排版、从右到左的文字和不同快捷键写法。不要按一条英文 label 固定控件宽度；不要把文字放进 raster asset；不要拼接翻译片段；只有存在 tooltip 等恢复路径时才截断 label。

尊重有意义的平台差异：Command/Control、原生窗口装饰、系统 appearance、scrollbar、menu 和 notification 能力，以及手机上的系统标题栏、返回手势和提示框。各平台的信息架构应稳定，但不能为了表面像素一致而消除用户熟悉的平台行为。

NSH 应用运行在手机、平板、桌面和 Web 上，也经常运行在宿主应用之中。为每一种设计：

- **系统界面保留平台的外观。** 在 iOS 和 Android 上，页面的标题栏是系统的（`NavPage` 的 `title` 和标题栏选项）；桌面与 Web 显示页面的 `header` 插槽，由应用绘制。每个页面都同时提供两者（[导航](./navigation.md#navpage-与标题栏)）。确认使用 `AlertDialog`；状态栏跟随最上层的页面或对话框（`statusBar`）。
- **宿主的主题。** 嵌入的应用可以拿到宿主的主题；读取 token 的类名和 Rust 绑定会以原生方式跟随它（[主题 token](./tailwind.md#主题-token)）。
- **安全区域与键盘。** 内容留在安全区域内（`env(safe-area-inset-*)`、`safeAreaInsets()`），输入框留在软键盘上方（`env(keyboard-inset-height)`）（[设备与环境](./device-and-environment.md)）。
- **外观、文字大小与动效。** 每个界面都在浅色和深色（`dark:`、`colorScheme()`）、用户的文字大小和减少动态效果（`motion-reduce:`、`reduceMotion()`）下可用。
- **从右到左。** 布局方向跟随语言区域，`direction` 样式可以为一个视图及其子树单独设置；start 与 end 属性随之镜像（[从右到左](./layout.md#从右到左)）。
- **触摸与指针。** 触摸目标至少 44 × 44 点；悬停和工具提示只在有指针时出现。

```rust tabs
use nsh_base::nav_page;

nav_page()
    .title("收件箱")
    .header(page_header("收件箱"))
    .child(inbox())
```

```tsx tabs
import { NavPage } from "nsh/base";

<NavPage title="收件箱" header={<PageHeader title="收件箱" />}>
  <Inbox />
</NavPage>
```

## AI 生成界面的规则

AI 修改 NSH 界面前必须阅读相邻 feature、应用的组件和主题 token、组件文档和声明（`.nsh/types`），并先说清主要任务、state owner、component composition 以及键盘和触摸路径。不能从 React、React Native 或 Shadcn 示例推断 API，也不能因为名字“听起来合理”就发明 NSH 的 prop 或方法；`nsh check` 和构建时的类名检查会报告不存在的内容。

AI 输出只有在人能够解释 hierarchy、density、component choice 与所有例外字面量时才算完成。看起来合理的截图不是证据；键盘与触摸、焦点、动态内容、主题、resize、文字大小和失败状态都属于设计。

## 无障碍检查表

界面完成前验证：

- 所有 action 都能通过键盘、触摸和读屏软件到达和执行；
- focus 顺序符合视觉与任务顺序；
- focus 始终可见，overlay 关闭后正确恢复；
- control 有无障碍名称；仅图标 control 仅在含义、范围或快捷键需要解释时使用 tooltip；
- 文字与有意义边界对比度充足；
- 状态不只依赖颜色；
- disabled 与 read-only 可区分；
- label、error、description 靠近对应 control；
- 长翻译、从右到左和更大字体下仍可用；
- 触摸目标至少 44 × 44 点，即使紧凑布局，pointer target 仍舒适。

## 设计评审清单

评审不是清点部件，而是判断界面是否做出了正确取舍。依次回答：

1. **任务清楚吗？** 新用户能否直接看懂界面用途、主要操作和下一步，而不必学习、猜测或试错？
2. **操作兑现承诺吗？** 文案、控件、状态、范围、反馈与结果是否始终描述同一件事？
3. **层级明确而克制吗？** 核心功能是否获得应有的空间，同时主按钮、强色、粗体、徽标和警示保持稀缺？
4. **还能做得更少吗？** 能否删除、合并或推迟某个入口、选项或状态，同时完整保留主要任务？
5. **结构准确吗？** 同层内容是否共享对齐轴，相等间距是否精确到渲染像素，滚动条是否贴住实际滚动区域的边缘？
6. **遵守组件体系吗？** 标准控件是否保留统一的几何、状态、键盘与关闭行为，外观是否来自主题与尺度令牌？
7. **所有状态与约束下都可用吗？** 检查键盘、触摸与焦点、空白、加载、失败、无权限、长翻译、更大文字、从右到左、两种外观、最小窗口和减少动态效果。
8. **在真实平台上验证了吗？** 在它要发布的每个平台上（`nsh run --target …`、`nsh test --target …`），使用真实组件、文案和代表性内容亲手完成任务，而不只评审一张理想截图。

# UI UX Pro Max 中文学习导读

本文面向个人深度学习，基于当前本地 `ui-ux-pro-max` Skill 做中文化整理。它保留原始 `SKILL.md` 的使用规则，同时补入脚本入口、数据域和运行口径，方便理解这套 Skill 为什么能把 UI/UX 知识组织成可检索、可组合、可落地的工作流。

## 结论摘要

`ui-ux-pro-max` 是一个面向 Web 与移动端 UI/UX 设计的本地知识型 Skill。它用 `SKILL.md` 规定何时使用、如何使用和如何验收，用 CSV 承载设计知识，用 Python 脚本完成 BM25 检索、跨域组合、设计系统生成和可选持久化。

当前本地版本的关键事实如下。

| 项目                 | 当前口径                                                                              |
| -------------------- | ------------------------------------------------------------------------------------- |
| Skill 入口           | `~\.agents\categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\SKILL.md` |
| `SKILL.md` 行数      | 659 行                                                                                |
| 配置内 domain        | 11 个                                                                                 |
| 配置内 stack         | 16 个                                                                                 |
| 配置内 domain 数据量 | 2739 行                                                                               |
| 配置内 stack 数据量  | 841 行                                                                                |
| 核心脚本             | `search.py`、`core.py`、`design_system.py`                                            |
| 当前工作流偏向       | React Native 与 App UI 质量控制，同时保留 Web 与多栈检索能力                          |

## 来源范围

本文只依据当前本地文件，不沿用旧路径口径。

| 类型         | 路径                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------- |
| 使用协议     | `categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\SKILL.md`                 |
| CLI 入口     | `categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\scripts\search.py`        |
| 检索内核     | `categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\scripts\core.py`          |
| 设计系统生成 | `categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\scripts\design_system.py` |
| 结构化知识   | `categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\data\*.csv`               |

## 元信息中文化

`ui-ux-pro-max` 的定位可以概括为 UI/UX 设计智能知识库。它覆盖页面设计、组件设计、视觉风格、交互状态、无障碍、动画、排版、配色、图表、移动端触控、App 导航和多技术栈实现规则。

原始描述强调这些能力。

| 能力块   | 中文说明                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 设计场景 | website、landing page、dashboard、admin panel、e-commerce、SaaS、portfolio、blog、mobile app                                   |
| UI 元素  | button、modal、navbar、sidebar、card、table、form、chart                                                                       |
| 视觉风格 | glassmorphism、claymorphism、minimalism、brutalism、neumorphism、bento grid、dark mode、responsive、skeuomorphism、flat design |
| 设计主题 | color systems、accessibility、animation、layout、typography、spacing、interaction states、shadow、gradient                     |
| 动作类型 | plan、build、create、design、implement、review、fix、improve、optimize、enhance、refactor、check                               |
| 集成方向 | 可结合 shadcn/ui MCP 查组件与示例                                                                                              |

## 适用边界

### 必须使用

当任务会影响界面的结构、视觉、交互或体验质量时，应使用这个 Skill。

| 场景           | 说明                                             |
| -------------- | ------------------------------------------------ |
| 新页面设计     | Landing Page、Dashboard、Admin、SaaS、Mobile App |
| 组件创建或重构 | buttons、modals、forms、tables、charts           |
| 设计系统决策   | 配色、字体、间距、布局、动效、风格               |
| UI 评审        | 检查无障碍、可用性、视觉一致性、响应式           |
| 导航与交互     | 路由结构、手势、动画、加载反馈                   |
| 产品级设计判断 | 信息层级、品牌气质、视觉密度、主行动按钮         |

### 推荐使用

当界面看起来不够专业、移动端交互不稳、上线前需要体验质量门禁、跨平台风格需要统一，或要搭建组件库时，也适合使用。

### 可以跳过

纯后端逻辑、数据库设计、DevOps、非视觉脚本、与界面无关的性能优化，不需要调用这套 Skill。

## 规则优先级

`SKILL.md` 把 UI/UX 规则分成 10 类。这个表是人工与模型执行时的优先级参考，脚本本身不会读取这张表。

| 优先级 | 类别                | 影响等级 | 检索域                | 必查点                                      |
| ------ | ------------------- | -------- | --------------------- | ------------------------------------------- |
| 1      | Accessibility       | CRITICAL | `ux`                  | 对比度、alt 文本、键盘导航、aria label      |
| 2      | Touch & Interaction | CRITICAL | `ux`                  | 触控尺寸、目标间距、加载反馈、点击反馈      |
| 3      | Performance         | HIGH     | `ux`                  | 图片优化、懒加载、预留空间、降低 CLS        |
| 4      | Style Selection     | HIGH     | `style`、`product`    | 产品类型匹配、风格一致、SVG 图标            |
| 5      | Layout & Responsive | HIGH     | `ux`                  | 移动优先、断点、无横向滚动、允许缩放        |
| 6      | Typography & Color  | MEDIUM   | `typography`、`color` | 16px 基准、语义色、行高、字体层级           |
| 7      | Animation           | MEDIUM   | `ux`                  | 150 到 300ms、表达因果、尊重 reduced motion |
| 8      | Forms & Feedback    | MEDIUM   | `ux`                  | 可见 label、字段旁错误、辅助文本            |
| 9      | Navigation Patterns | HIGH     | `ux`                  | 可预测返回、深链、导航层级、状态保留        |
| 10     | Charts & Data       | LOW      | `chart`               | 图例、tooltip、可访问配色、表格替代         |

学习时可以把它理解为一套质量门禁序列。先守住无障碍、触控和性能，再进入风格、布局、排版、动画、表单、导航和图表细节。

## 快速规则导读

### 1. Accessibility

无障碍是最高优先级。重点包括普通文本 4.5:1 对比度、交互元素可见 focus ring、图片 alt 文本、图标按钮 aria label、Tab 顺序与视觉顺序一致、表单 label 与输入框绑定、支持 reduced motion 和动态字体。

### 2. Touch & Interaction

移动端交互强调触控目标、目标间距和反馈速度。iOS 触控区至少 44pt，Material 推荐 48dp。主要行为不能只依赖 hover，异步按钮要禁用并展示进度，手势要有可见替代入口。

### 3. Performance

性能规则服务于体验稳定性。图片用 WebP 或 AVIF，非首屏内容懒加载，异步内容预留空间，字体使用 `font-display`，长列表虚拟化，高频事件使用 debounce 或 throttle。

### 4. Style Selection

风格选择要贴合产品类型。比如金融产品更重信任和清晰，娱乐产品可以更鲜活，工具类产品要强调效率。图标使用 SVG，风格、阴影、圆角、动效要在同一视觉语言内。

### 5. Layout & Responsive

布局规则强调移动优先、断点一致、正文不横向滚动、固定导航预留内容空间。移动端正文至少 16px，长文本行宽要可读，桌面容器宽度要稳定。

### 6. Typography & Color

字体与颜色强调语义化。颜色要用 `primary`、`secondary`、`error`、`surface` 这类 token 管理。正文行高建议 1.5 到 1.75，数据列使用等宽或 tabular figures 更稳。

### 7. Animation

动效需要表达状态变化和空间关系。优先使用 `transform` 与 `opacity`，避免动画触发布局重排。动画要可中断，避免阻塞用户输入，并支持 `prefers-reduced-motion`。

### 8. Forms & Feedback

表单要有可见 label、字段级错误、恢复路径、提交反馈和可访问提示。复杂表单应逐步披露，长表单可考虑草稿保存，多个错误时应有错误摘要。

### 9. Navigation Patterns

导航要稳定、可预测、可回退。底部导航最多 5 个顶级入口，大屏可用侧边栏，小屏用底部或顶部导航。返回时应恢复滚动位置、筛选状态和输入内容。

### 10. Charts & Data

图表要匹配数据类型。趋势用折线，对比用柱状，占比谨慎使用饼图。图表不能只靠颜色表达含义，重要图表要提供文本摘要或表格替代。

## CLI 工作流

### 前置条件

先确认 Python 可用。

```powershell
python --version
```

在当前 Windows 环境中，建议直接使用技能目录下的脚本绝对路径，减少相对路径误判。

### Step 1 分析需求

执行前先提取四类信息。

| 信息            | 示例                                                  |
| --------------- | ----------------------------------------------------- |
| Product type    | Entertainment、Tool、Productivity、SaaS、Dashboard    |
| Target audience | C 端用户、运营人员、开发者、管理者                    |
| Style keywords  | playful、minimal、dark mode、content-first、immersive |
| Stack           | 当前 `SKILL.md` 工作流偏向 React Native               |

### Step 2 生成设计系统

设计系统生成是主流程。它会跨 `product`、`style`、`color`、`landing`、`typography` 多个 domain 查找结果，再结合 `ui-reasoning.csv` 生成组合建议。

```powershell
python "~\.agents\categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\scripts\search.py" "beauty spa wellness service" --design-system -p "Serenity Spa" -f markdown
```

预期结果包含 Pattern、Style、Colors、Typography、Key Effects、Anti-patterns 和 Pre-Delivery Checklist。

### Step 3 补充 domain 检索

拿到设计系统后，可以按具体问题补充查询。

```powershell
python "~\.agents\categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\scripts\search.py" "animation accessibility" --domain ux --max-results 2
```

常见补充方式如下。

| 需求         | Domain         | 关键词示例                            |
| ------------ | -------------- | ------------------------------------- |
| 产品类型模式 | `product`      | `entertainment social`                |
| 视觉风格     | `style`        | `minimalism dark mode`                |
| 配色方案     | `color`        | `fintech trust`                       |
| 字体搭配     | `typography`   | `elegant luxury`                      |
| 图表建议     | `chart`        | `real-time dashboard`                 |
| UX 规则      | `ux`           | `animation accessibility`             |
| Google Fonts | `google-fonts` | `sans serif variable`                 |
| React 性能   | `react`        | `rerender memo list`                  |
| App 接口规范 | `web`          | `accessibilityLabel touch safe-areas` |
| 图标         | `icons`        | `settings navigation lucide`          |

### Step 4 查询栈级规则

栈级规则通过 `--stack` 查询。当前配置内有 16 个 stack。

```powershell
python "~\.agents\categories\04-设计系统与前端应用\01-UIUX与前端审美\ui-ux-pro-max\scripts\search.py" "navigation list performance" --stack react-native --max-results 2
```

这个查询会读取 `data\stacks\react-native.csv`，返回与导航、列表性能等主题相关的实现建议。

## 可用 Domain

下表来自 `core.py` 的 `CSV_CONFIG`，表示 CLI 直接支持的普通检索域。

| Domain         | 数据文件                | 行数 | 用途                            |
| -------------- | ----------------------- | ---: | ------------------------------- |
| `style`        | `styles.csv`            |   84 | UI 风格、效果、兼容性、实现检查 |
| `color`        | `colors.csv`            |  161 | 产品类型到语义色板              |
| `chart`        | `charts.csv`            |   25 | 图表类型、适用场景、无障碍替代  |
| `landing`      | `landing.csv`           |   34 | Landing 页面结构与 CTA 策略     |
| `product`      | `products.csv`          |  161 | 产品类型、推荐风格、关键考虑    |
| `ux`           | `ux-guidelines.csv`     |   99 | UX 问题、做法、反模式、严重级别 |
| `typography`   | `typography.csv`        |   73 | 字体搭配、情绪、导入方式        |
| `icons`        | `icons.csv`             |  105 | 图标库、导入代码、使用场景      |
| `react`        | `react-performance.csv` |   44 | React 与 Next.js 性能规则       |
| `web`          | `app-interface.csv`     |   30 | App 接口与无障碍规范            |
| `google-fonts` | `google-fonts.csv`      | 1923 | Google Fonts 字体检索           |

## 可用 Stack

下表来自 `core.py` 的 `STACK_CONFIG`。栈级 CSV 使用统一列结构，便于同一套检索内核复用。

| Stack             | 数据文件                     | 行数 |
| ----------------- | ---------------------------- | ---: |
| `react`           | `stacks\react.csv`           |   53 |
| `nextjs`          | `stacks\nextjs.csv`          |   52 |
| `vue`             | `stacks\vue.csv`             |   49 |
| `svelte`          | `stacks\svelte.csv`          |   53 |
| `astro`           | `stacks\astro.csv`           |   53 |
| `swiftui`         | `stacks\swiftui.csv`         |   50 |
| `react-native`    | `stacks\react-native.csv`    |   51 |
| `flutter`         | `stacks\flutter.csv`         |   52 |
| `nuxtjs`          | `stacks\nuxtjs.csv`          |   58 |
| `nuxt-ui`         | `stacks\nuxt-ui.csv`         |   50 |
| `html-tailwind`   | `stacks\html-tailwind.csv`   |   55 |
| `shadcn`          | `stacks\shadcn.csv`          |   60 |
| `jetpack-compose` | `stacks\jetpack-compose.csv` |   52 |
| `threejs`         | `stacks\threejs.csv`         |   53 |
| `angular`         | `stacks\angular.csv`         |   50 |
| `laravel`         | `stacks\laravel.csv`         |   50 |

## 持久化能力

`design_system.py` 支持 Master 加页面覆盖的分层设计系统文件。开启持久化时会创建 `design-system\<project>\MASTER.md`，如果指定页面，还会创建 `design-system\<project>\pages\<page>.md`。

这套机制的读取逻辑如下。

1. 构建具体页面前，先查页面级覆盖文件。
2. 页面覆盖文件存在时，页面规则优先。
3. 页面覆盖文件不存在时，使用 `MASTER.md`。
4. `format_page_override_md()` 和 `_generate_intelligent_overrides()` 会结合页面名、查询词和设计系统结果生成页面建议。

本文的示例命令不启用持久化，避免学习验证时产生新文件。

## 脚本层导读

### `search.py`

`search.py` 是 CLI 控制层，行数为 114 行。它负责参数解析、分支路由和输出格式化。

| 参数或函数        | 作用                                    |
| ----------------- | --------------------------------------- |
| `--domain`        | 查询普通 domain                         |
| `--stack`         | 查询技术栈规则                          |
| `--max-results`   | 控制返回数量                            |
| `--json`          | 输出 JSON                               |
| `--design-system` | 生成完整设计系统                        |
| `--project-name`  | 给设计系统输出命名                      |
| `--format`        | 选择 `ascii` 或 `markdown`              |
| `format_output()` | 把检索结果整理成模型容易消费的 Markdown |

分支优先级很清晰。先判断设计系统模式，其次判断 stack 查询，最后走普通 domain 查询。

### `core.py`

`core.py` 是检索内核，行数为 262 行。它的核心职责是把不同 CSV 包装成统一检索接口。

| 对象或函数        | 作用                                   |
| ----------------- | -------------------------------------- |
| `DATA_DIR`        | 指向 `data` 目录                       |
| `CSV_CONFIG`      | 声明普通 domain 的文件、搜索列、输出列 |
| `STACK_CONFIG`    | 声明 stack 到 CSV 文件的映射           |
| `BM25`            | 本地关键词排序算法                     |
| `_load_csv()`     | 读取 CSV 为字典列表                    |
| `_search_csv()`   | 通用 CSV 检索内核                      |
| `detect_domain()` | 根据关键词自动推断 domain              |
| `search()`        | 普通 domain 查询入口                   |
| `search_stack()`  | 栈级查询入口                           |

一个关键设计是 `search_cols` 与 `output_cols` 分离。搜索只看最有匹配价值的列，输出再返回对阅读和执行有价值的字段。

### `design_system.py`

`design_system.py` 是组合推理层，行数为 1148 行。它把多个检索结果组合成一套设计系统建议。

| 模块                                | 作用                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| `SEARCH_CONFIG`                     | 固定设计系统要聚合的 domain                                  |
| `DesignSystemGenerator`             | 生成设计系统字典                                             |
| `_find_reasoning_rule()`            | 从 `ui-reasoning.csv` 匹配产品类别规则                       |
| `_apply_reasoning()`                | 提取 pattern、style_priority、anti_patterns、decision_rules  |
| `_multi_domain_search()`            | 跨 `product`、`style`、`color`、`landing`、`typography` 检索 |
| `_select_best_match()`              | 根据风格优先级挑选候选                                       |
| `format_ascii_box()`                | 终端友好的 ASCII 输出                                        |
| `format_markdown()`                 | 文档友好的 Markdown 输出                                     |
| `persist_design_system()`           | 写入 Master 与页面覆盖文件                                   |
| `_generate_intelligent_overrides()` | 生成页面级覆盖建议                                           |

学习这份脚本时，可以把它拆成三段看：先看 `generate()` 如何得到设计系统字典，再看格式化函数如何输出，最后看持久化函数如何把结果变成可跨会话读取的文件。

## 专业 UI 检查清单

### Visual Quality

- [ ] 图标使用 SVG 或平台向量图标。
- [ ] 同一层级图标保持同一套图标语言。
- [ ] 品牌资产使用官方比例和留白。
- [ ] pressed 状态不引发布局跳动。
- [ ] 主题色通过语义 token 管理。

### Interaction

- [ ] 所有可触控元素有明确 pressed feedback。
- [ ] iOS 触控目标至少 44pt，Android 至少 48dp。
- [ ] 微交互动效控制在 150 到 300ms。
- [ ] disabled 状态有语义属性和视觉弱化。
- [ ] 读屏焦点顺序与视觉顺序一致。
- [ ] 手势区域避免 tap、drag、back swipe 冲突。

### Light 和 Dark Mode

- [ ] 主文本在明暗模式下均达到 4.5:1。
- [ ] 次级文本在明暗模式下至少达到 3:1。
- [ ] 分割线、边框、交互态在两种主题中都可见。
- [ ] modal 或 drawer 的 scrim 能隔离背景干扰。
- [ ] 明暗模式均经过实际检查。

### Layout

- [ ] header、tab bar、bottom CTA 避开 safe area。
- [ ] 滚动内容不会被固定元素遮挡。
- [ ] 已检查小屏手机、大屏手机、平板、横屏。
- [ ] 横向 inset 随设备尺寸和方向变化。
- [ ] 组件、区块、页面保持 4/8dp 节奏。
- [ ] 长文本在大屏上有可读行宽。

### Accessibility

- [ ] 有意义的图片和图标有可访问标签。
- [ ] 表单字段有 label、hint 和清晰错误消息。
- [ ] 信息表达不只依赖颜色。
- [ ] 支持 reduced motion 和动态文本大小。
- [ ] selected、disabled、expanded 等状态能被辅助技术识别。

## 学习路径

建议按下面顺序学习这套 Skill。

1. 先读 `SKILL.md` 的适用边界和 10 类规则优先级，理解它什么时候该介入。
2. 再读 `core.py` 的 `CSV_CONFIG`，理解配置驱动如何把不同数据表统一成检索接口。
3. 运行一次设计系统命令，看输出如何组合 Pattern、Style、Colors 和 Typography。
4. 再读 `design_system.py` 的 `generate()`，把运行结果和源码流程对上。
5. 最后读持久化部分，理解 Master 加 Overrides 如何让设计规则跨会话复用。

## 术语对照

| 英文                          | 中文建议         |
| ----------------------------- | ---------------- |
| design system                 | 设计系统         |
| domain                        | 知识域           |
| stack                         | 技术栈           |
| reasoning rule                | 推理规则         |
| anti-pattern                  | 反模式           |
| persist                       | 持久化           |
| Master + Overrides            | 主规则加覆盖规则 |
| searchable database           | 可搜索知识库     |
| priority-based recommendation | 基于优先级的推荐 |
| touch target                  | 触控目标         |
| safe area                     | 安全区域         |
| reduced motion                | 减少动态效果     |

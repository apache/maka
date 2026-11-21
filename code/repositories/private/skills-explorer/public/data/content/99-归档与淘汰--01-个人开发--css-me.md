---
name: css-me
description: CSS、SCSS、CSS Modules 样式治理与 UI 还原。Use when writing or reviewing styles, restoring UI from screenshots or Figma, enforcing six-step property order, fixing cross-device height layout, tablet layout, old Android gap or inset compatibility, z-index layering, ImageWebp icon sizing, unit px/rpx conventions, modal layout, token or mixin usage, or style regression tests.
---

# CSS 治理与 UI 还原

> 适用：样式开发与 UI 还原（多端 H5/小程序/平板）。路由、接口、状态归 helper-me 对应专题与工程决策门。独立姊妹 skill，2026-09 验证。

## P0 跨端高度布局（血泪核心：固定内容 + 可压缩空白盒子）

处理 H5、安卓手机、安卓平板竖屏、平板横屏侧边栏这类高度不稳定页面时，先把设计稿拆成"固定内容尺寸 + 可压缩空白盒子 + 居中对齐"的工程布局，再写样式。

1. 按页面状态拆盒子：主内容、上方空白、播放控制、进度条、底部操作各自独立，不共用会互相污染的选择器。
2. 固定内容保留真实可用尺寸：按钮、控件、时间文字、进度条热区、波形可视区给 `min-height` 或明确内容尺寸，保证可点可读。
3. 空白盒子承担压缩：用 `flex` shrink 表达优先压缩顺序——先压纯空白，再压波形上下空白，最后才压波形可视区。
4. 不写死整页 `height`：容器占满可用高度，子区块用 `flex: grow shrink basis` 表达设计高度；`basis` 优先用设计稿整数 px。
5. 百分比只用于"随容器变化"的量：高度比例只用取整、语义清楚的比例，不写 `7.391%` 这类魔法数。
6. 主体内容始终居中：外层 `width: 100%` 显式居中，内部 `max-width` 保手机主内容宽度，横屏只放开波形横向宽度。
7. 窄屏优先保证底部可触达：压缩策略失败先减空白和上下边距，不降按钮高度。
8. 结果页和处理中页分开校准：复用组件但视觉重心不同，分别确认主波形盒、状态说明、控制区和底部按钮的空白均衡。

`min-height: 0`、`overflow: hidden`、`flex` 是压缩三件套，只用在确认可压缩的盒子上。修完一个状态，搜索同类状态选择器（首页/手动编辑/去静音/智能剪辑/处理中/完成态），确认没有互相覆盖。

## P1 兼容红线（低版本 WebView）

| 问题              | 处理口径                                          |
| ----------------- | ------------------------------------------------- |
| `gap`             | 核心布局改 `margin`、兄弟选择器或显式间距         |
| `inset`           | 展开为 `top`、`right`、`bottom`、`left`           |
| `ScrollView` 不滚 | 查父级高度、内部 `overflow`、Taro props、触摸链路 |
| 弹窗滚动穿透      | 明确 mask、内容区高度、内部滚动容器               |
| CSS 变量          | 关键颜色和尺寸提供 Sass token 或静态值兜底        |
| 动态文案撑高      | 固定按钮、状态文案、底部操作区尺寸                |
| Grid 布局         | 老内核支持差，布局优先 `flex` / `-webkit-box`     |

## P1.5 图片与图标

- 图标、插画统一走图片组件（如 `@/components/imageWebp` 的 `ImageWebp`），禁止原生 `Image`/`img`，也不用 CSS `background-image` 当图标（小程序不支持，还多一次请求）。URL 由切图 skill 生成到 `assetUrls.ts` 一类常量文件，不写死 Figma 临时链接。
- 图片组件默认宽度常是 `width: 100%`，作为图标或固定尺寸图放进 `flex` / `-webkit-box` 子项时，**调用方必须写死盒尺寸**，否则默认宽度会撑坏相邻间距：

```scss
.icon {
  flex-shrink: 0; // 或 -webkit-box-flex: 0
  width: 80px;

  min-width: 80px;
  max-width: 80px;
  height: 80px;
}
```

- 分隔线、细线一类装饰用纯色（`background-color` / `border`），不塞图；颜色对齐设计稿，不自行调淡。

## P2 六段式属性顺序

复杂选择器按：定位与层级 → 显示与布局 → 盒模型与尺寸 → 文本与内容 → 背景与视觉 → 交互与动画。

```scss
.card {
  /* 1. 定位与层级 */
  position: relative;
  z-index: 1;
  /* 2. 显示与布局 */
  display: flex;
  overflow: hidden;
  /* 3. 盒模型与尺寸 */
  box-sizing: border-box;
  width: 100%;
  padding: 24px;
  /* 4. 文本与内容 */
  font-size: 28px;
  line-height: 40px;
  color: $text-main;
  /* 5. 背景与视觉 */
  background: $white;
  border-radius: 20px;
  /* 6. 交互与动画 */
  transition: opacity 0.16s ease;
}
```

单属性覆盖可简化；弹窗、表单、时间轴、气泡必须分组。

块内结构顺序（`order/order`）：`dollar-variables → custom-properties → at-rules → declarations → @supports → @media → rules`。属性顺序规则可能只对部分目录强制（经 stylelint overrides 限定生效范围），**未强制的目录手写时同样按此顺序**，保持全项目一致、减少 `git diff` 噪声；自动重排交给格式化 skill，不在手工改动里大批重排。

## P2.5 模块样式三件套与治理（token / mixin / 入口）

模块公共样式拆成三个文件，职责互不越界（receptionPrep `styles/` 实测标杆）：

| 文件          | 职责                                                       | 红线                                         |
| ------------- | ---------------------------------------------------------- | -------------------------------------------- |
| `ui.scss`     | 视觉变量：颜色、状态、渐变、阴影。只声明变量，不输出 CSS   | 不当颜色杂物箱，不收只出现一次的值           |
| `mixins.scss` | 结构配方：按钮、空态块、图标盒、两行截断等重复 ≥3 处的组合 | 不承担业务状态判断，不参数化只出现一次的结构 |
| `index.scss`  | 唯一入口：只 `@import` 上面两个文件                        | 编译产物必须为零全局 CSS                     |

组件统一 `@import '<模块>/styles';` 取公共变量与配方，禁止直接导入 ui.scss / mixins.scss，禁止循环导入。

两代写法：`_tokens.scss + _mixins.scss`（两分册、无统一入口、组件直接 import mixins）是**历史写法**，见旧模块 reservationBoard / audioEdit；新模块与重构模块统一升级为三件套，老模块不强制迁移。

**抽离判据**：颜色值出现 ≥2 次进 token；同一结构组合出现 ≥3 处进 mixin；只出现一次的样式留在组件。抽离后必须替换全部调用点——只定义 mixin 不替换手写残留，等于没抽（实测：定义 `rp-flex-center` 后仍留 8 处手写三件套）。

**编译守卫测试**（`tests/styles.test.cjs`，四条断言）：

1. 入口压缩编译后为空串（注释合法会随 expanded 输出，compressed 下消失；出现任何选择器即全局样式泄漏）；
2. 全部 `*.module.scss` 可独立编译；
3. 每个模块必须引用统一入口，且源码禁止内联色值（hex / rgb 字面量）；
4. 传入重构前目录作基线，逐文件对比编译 CSS 的选择器与声明——纯组织重构要求编译结果一致，不用更新测试来掩盖差异。

**@include 约定**：统一放规则块最顶部（先复用配方，再写本块特有声明），与后续声明之间空一行。用 `order/order`（at-rules 置顶，模块范围升 error）+ `declaration-empty-line-before` 强制；六段式属性顺序写在独立的 `stylelint.config.property-order.js`，经 stylelint overrides 限定生效范围。注意 `order/properties-order` 只管声明属性，`@include` 是 at-rule，归 `order/order` 管。

**注释规范**：scss 源码统一 `/* xxx */` 块注释，不用 `//`——后者在未配 `customSyntax: postcss-scss` 的解析器（编辑器插件、CI）下报 `Unknown word (CssSyntaxError)`。不要依赖本地配置兜底，源码本身要合法。副作用：块注释会留在编译产物（expanded），入口"零输出"断言相应用压缩编译判空。

## P3 平板时间轴密度

调密度至少同时看五个参数：`slotHeight`（半小时刻度高度）、`timelineEdgePadding`（首尾可视边界）、`timeLabelWidth`（时间列与门店树对齐）、`minAppointmentCardHeight`（半小时卡片可读性）、卡片 padding 与行高（姓名、手机号、服务文本可读性）。

## Token 与第三方覆盖

- Token 只抽三类：高频复用值（品牌色/文本色/边框色/表单背景）、语义稳定结构（表单行/字段/浮层/禁用态）、需整体联动的布局（弹层壳/label/picker 箭头）。不把只出现一次的样式抽成 mixin，token 文件不当颜色杂物箱。
- 第三方覆盖：`:global` 指向具体第三方类名并在覆盖前注释对象和原因；只有组件库限制或内联优先级导致普通覆盖无效时才用 `!important`。

## z-index 层级约定

| 区间        | 用途                               |
| ----------- | ---------------------------------- |
| `1~9`       | 页面内部装饰（分隔线、时间线）     |
| `40~99`     | 轻量浮层                           |
| `100~1999`  | 选择器、下拉                       |
| `2000`      | 页面顶部固定区                     |
| `3000~3099` | 模态弹窗；新增全局弹窗优先 `3000+` |

层级靠约定分配，不用更高 z-index 抢层级（见反模式）。

## 单位约定

- Taro 会把 `px → rpx` 转换（`nut-` 前缀除外），按设计稿 px 写即可；已明确要求 rpx 时例外。
- `rpx` 通常在 stylelint `unit-no-unknown` 白名单里，可用，但同一处不混用 px 与 rpx。

## 截图还原流程

标注业务区域 → 找到对应组件与 selector → 记录尺寸、间距、颜色、层级、滚动归属和交互态 → 只改目标 selector 和必要父容器 → 用截图/设备/URL/测试命令闭环验收。

尺寸、行高、圆角、间距以 **Figma 节点 metadata 为准**，不凭截图目测。常见还原坑（真实踩过）：标题 `line-height` 错用大值把标题块撑高、图标与副标题错位；内层卡片圆角沿用旧值不对齐设计。

改前先读现有 `index.module.scss`，改后 `git diff` 逐条核对，避免顺手改坏相邻 selector。

## 回归测试

优先跑目标模块已有样式契约（各项目入口不同，常见形如 `test/layout.test.cjs`、`gapCompatibility.test.cjs`、`figmaVisual.contract.test.cjs`）。无法自动化的视觉项记录 URL、截图、设备、浏览器版本。

## 反模式

- 不只凭肉眼改尺寸；不只调一个设备截图，手机、平板竖屏、平板横屏侧边栏的最短高度一起看。
- 不用更高 z-index 掩盖层级设计混乱。
- 不把一个状态的样式污染到另一个状态的选择器。
- 不用 `gap` 和 `inset` 写必须兼容老安卓的核心布局。
- 不让底部操作条随动态文案撑高。
- 不把可点击控件和纯空白放进同一个不可控高度盒子一起压缩。
- 不用大量小数百分比表达高度压缩。
- 不把样式修复扩成全模块重构。
- 播放器、图表、监听、定时器成对清理（详见 ui-me 资源型组件生命周期）。
- 样式注释不用 `//` 行注释（CSS 解析器下报 Unknown word），统一 `/* xxx */`。
- 不把公共样式散在组件里手写重复；抽了 mixin 就替换全部调用点，不留手写残留。
- 不把样式细节写进页面开发类 skill（figma-to-page 等），统一归本 skill 治理。

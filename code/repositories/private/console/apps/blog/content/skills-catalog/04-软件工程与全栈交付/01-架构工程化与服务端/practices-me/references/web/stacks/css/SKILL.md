---
name: css-me
description: CSS、SCSS、CSS Modules 样式治理与 UI 还原。Use when writing or reviewing styles, restoring UI from screenshots or Figma, mapping screenshot regions to selectors, enforcing six-step property order, fixing cross-device height layout, tablet layout, old Android gap or inset compatibility, z-index issues, modal layout, timeline density, token or mixin usage, or style regression tests.
---

# CSS Writing Guidelines

## 使用定位

用于样式开发、UI 还原、样式规范、跨端高度布局、平板布局、低版本 WebView 兼容和样式回归。它处理视觉与 CSS 事实；路由、接口、状态和多端构建交给对应专题。

## 截图到样式流程

1. 标注截图中的业务区域。
2. 找到每个区域对应的组件和 selector。
3. 记录尺寸、间距、颜色、层级、滚动归属和交互态。
4. 只修改目标 selector 和必要父容器。
5. 改后用截图、设备、URL、测试命令或人工验收记录闭环。

看板类布局可按这些区域验收：

| 区域 | 样式关注点 |
| --- | --- |
| `CalendarSidebar` | 左侧宽度、月历高度、灰点、状态筛选、滚动归属 |
| `MetaSkinHeader` | 门店文字、顶部操作区、添加预约按钮尺寸和对齐 |
| `WeekView` | 周日期高度、选中态、分割线 |
| `ConsultantTabs` | 页签高度、激活态、横向滚动或均分策略 |
| `ScheduleTimeline` | 时间列、刻度线、卡片密度、空态、底部安全区 |
| 弹窗和气泡 | 遮罩、层级、内部滚动、footer 可触达 |

## 六段式属性顺序

复杂选择器按下面顺序组织：

1. 定位与层级
2. 显示与布局
3. 盒模型与尺寸
4. 文本与内容
5. 背景与视觉
6. 交互与动画

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

少量状态类和单属性覆盖可以简化。弹窗、表单、时间轴、气泡必须分组。

## 平板时间轴密度

时间轴密度至少同时看：

| 参数 | 影响 |
| --- | --- |
| `slotHeight` | 半小时刻度高度 |
| `timelineEdgePadding` | 首尾可视边界 |
| `timeLabelWidth` | 时间列和门店树对齐 |
| `minAppointmentCardHeight` | 半小时卡片可读性 |
| 卡片 padding 和行高 | 姓名、手机号、服务文本可读性 |

## 跨端高度布局

处理 H5、安卓手机、安卓平板竖屏、安卓平板横屏侧边栏这类高度不稳定页面时，先把设计稿拆成“固定内容尺寸 + 可压缩空白盒子 + 居中对齐”的工程布局，再写样式。

1. 先按页面状态拆盒子。每个页面状态单独列出主内容、上方空白、播放控制、进度条、底部操作等区块，不共用会互相污染的选择器。
2. 固定内容保留真实可用尺寸。按钮、播放控件、时间文字、进度条热区和波形可视区要有 `min-height` 或明确内容尺寸，保证可点击和可读。
3. 空白盒子承担压缩。把设计稿中的留白放进独立区块，用 `flex` 的 shrink 控制优先压缩顺序。优先压缩纯空白，其次压缩波形上下空白，最后才压缩波形可视区。
4. 避免直接写死整页 `height`。页面容器可以占满可用高度，子区块用 `flex: grow shrink basis` 表达设计高度和压缩弹性；`basis` 优先用设计稿整数 px，少用难读的小数百分比。
5. 百分比用于“随容器变化”的宽度或少量总量映射。高度适配如果需要百分比，只用取整、语义清楚的比例；不要出现 `7.391%` 这类无法维护的魔法数。
6. 主体内容始终居中。波形、播放控件、底部按钮的外层容器要 `width: 100%` 并显式居中，内部再用 `max-width` 保留手机主内容宽度，横屏需要铺满时只放开波形横向宽度。
7. 窄屏侧边栏优先保证底部可触达。底部操作区不要被上方固定盒子挤出屏幕；压缩策略失败时先减少空白和波形上下边距，不降低按钮高度。
8. 结果页和处理中页面分开校准。处理中、完成态常常复用组件但视觉重心不同，需要分别确认主波形盒、状态说明、播放控制和底部按钮的上下空白是否均衡。

参考口径：

- 音频编辑类页面可以把时间刻度、波形可视区、播放按钮、进度条、底部按钮视为固定内容。
- `min-height: 0`、`overflow: hidden`、`flex` 是压缩布局的基础，但只能用在确认可以被压缩的盒子上。
- 修复一个状态后，要搜索同类状态选择器，确认首页、手动编辑、去除静音、智能剪辑、处理中和完成态没有互相覆盖。

## Token 与 Mixin

只抽三类：

1. 高频复用值，如品牌色、文本色、边框色、表单背景。
2. 语义稳定结构，如表单行、字段、浮层、禁用态。
3. 需要整体联动的布局，如弹层壳、label、picker 箭头。

避免把只出现一次的样式抽成 mixin。

## 第三方覆盖

1. 用 `:global` 指向具体第三方类名。
2. 覆盖前写一句注释说明对象和原因。
3. 只有组件库限制或内联优先级导致普通覆盖无效时，才使用 `!important`。

## 低版本 WebView

| 问题 | 处理口径 |
| --- | --- |
| `gap` | 核心布局改 `margin`、兄弟选择器或显式间距 |
| `inset` | 展开为 `top`、`right`、`bottom`、`left` |
| `ScrollView` 不滚 | 查父级高度、内部 `overflow`、Taro props、触摸链路 |
| 弹窗滚动穿透 | 明确 mask、内容区高度、内部滚动容器 |
| CSS 变量 | 关键颜色和尺寸提供 Sass token 或静态值 |
| 动态文案撑高 | 固定按钮、状态文案、底部操作区尺寸 |

## 回归测试

优先运行目标模块已有样式契约。常见入口：

```powershell
node src/pages/<page-name>/dev/02.test-case/test/layout.test.cjs
node src/pages/<page-name>/dev/02.test-case/test/componentStyle.test.cjs
node src/pages/<page-name>/dev/02.test-case/test/modalStyle.test.cjs
node src/pages/<page-name>/dev/02.test-case/test/gapCompatibility.test.cjs
node src/<module-path>/test/figmaVisual.contract.test.cjs
node src/<module-path>/test/mainWaveform.contract.test.cjs
```

无法自动化的视觉项要记录 URL、截图、设备、浏览器或开发者工具版本。

## 资源型组件生命周期

播放器、图表、全局监听、定时器必须在卸载时成对清理。验收：切走页面后不应继续回调、不应泄漏实例。图表 `dispose` 与 resize 监听成对移除。

## 反模式

- 不只凭肉眼改尺寸。
- 不用更高 z-index 掩盖层级设计混乱。
- 不把首页选择器样式污染到表单选择器。
- 不用 `gap` 和 `inset` 写必须兼容老安卓的核心布局。
- 不让底部操作条随动态文案撑高。
- 不把 token 文件变成颜色杂物箱。
- 不在 `:global` 写宽泛选择器影响整页组件。
- 不把样式修复扩成全模块重构。
- 不用大量小数百分比表达高度压缩策略。
- 不把可点击控件和纯空白放在同一个不可控高度盒子里一起压缩。
- 不只调一个设备截图，要同时考虑手机、平板竖屏和平板横屏侧边栏的最短高度。

## 输出格式

1. 结论摘要
2. 修改文件清单
3. UI 区域和 selector 对照
4. 样式修改顺序
5. 兼容风险
6. 回归命令和人工验收

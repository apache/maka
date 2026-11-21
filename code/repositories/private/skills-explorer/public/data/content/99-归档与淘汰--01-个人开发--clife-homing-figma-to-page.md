---
name: clife-homing-figma-to-page
description: Use when implementing or reviewing Figma-to-React/Taro pages in beauty-smart-advisor, component maps, ViewModel/mapper layering, SCSS Modules, ImageWebp sizing, tablet WebView compatibility, screenshot/Figma UI restoration, or focused Figma UI fixes.
---

# Clife Homing Figma 转页面

核心：先锁定业务边界和真实来源，再写 ViewModel 驱动的 React/Taro 页面。截图和静态 demo 只用于视觉验收；接口字段以源代码/后端契约为准。

## 快速分流

| 当前任务                                                      | 处理方式                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| 只要 Figma 图标、切图、COS URL、`assetUrls.ts`                | 使用 `clife-homing-figma-to-urls`，本 skill 只消费生成后的 URL |
| 样式写法、样式抽离、属性排序、样式排查与治理                  | [可选] 参考 `css-me`——本 skill 不承载样式细节                  |
| 只要格式化、import 排序、提交前 diff 收敛                     | 使用 `clife-homing-format-code`                                |
| 新页面、页面级重构、截图/Figma 还原、组件地图、ViewModel 分层 | 使用本 skill                                                   |
| 仅一个已定位 UI bug                                           | 跳过大组件地图，先锚定真实 selector/组件，做最小边界修复       |

涉及 Figma MCP 取节点、尺寸、文本、层级时，先加载 `figma-design-to-code` / `figma-use`。纯接口盘点或纯文档输出不加载附属文件。

## 起手盘点

动手前把三类输入分开，避免把背景材料误当需求：

1. 本轮用户要交付的页面、模块、节点、bug 或文档。
2. Figma、截图、PRD、静态 demo 分别提供哪些事实。
3. 当前工作区已有脏改动，哪些属于本轮，哪些保留不碰。

只读检查优先覆盖：

- 路由入口：`src/app.config.ts`、目标 `src/pages/<module>/index.tsx`。
- 模块现状：目标目录的 `components/`、`constants/`、`types.ts`、`normalize*.ts`、`index.hook.ts`。
- 可复用标杆：`src/pages/reservationBoard/` 的分层，`src/pages/serviceComplete/` 的护理报告实现。
- Git 范围：`git status --short`，必要时分别看 `git diff` 和 `git diff --cached`。

完成标准：能说清目标文件白名单、页面入口、复用件、数据来源、无关脏改动。

## 组件地图

完整页面或模块开发时，先命名业务区块，再编码。一个 Figma 红框或业务语义块优先对应一个候选业务组件；视觉碎片只在多处复用或隔离复杂性时再抽。

护理报告示例：

```text
ReportPreview
├─ Tab1-3 Placeholder
├─ ComfortMemory
│  ├─ ReportSectionHeader
│  ├─ MemoryLeadCard / RelaxCard / MemoryTile
│  └─ NextCareGuide
└─ CareContinuation
   ├─ ReportSectionHeader
   ├─ StageList
   ├─ HomeCareProducts
   └─ NextVisitCard
```

组件地图至少标明：组件名、父子关系、数据从哪里来、哪些是临时静态数据。边界不清时，先交付地图和疑点，再进入实现。

## 分层写法

- JSX 只消费已经归一化的 ViewModel；接口 DTO、summary 解析、默认值、展示顺序放到 `mapper` / `normalize*.ts` / `constants.ts`。
- 数据流保持 `services → hooks/useXxxResources → index.hook.ts → components`。
- 静态配置放模块作用域常量，避免在 render 内重建。
- 函数组件使用 TypeScript 和 `memo`；事件用 `useCallback`，派生数据用 `useMemo`，依赖数组按真实变量填写。
- 图片使用 `@/components/imageWebp` 的 `ImageWebp`，URL 从 `assetUrls.ts` 读取；图标的盒尺寸写法属于样式细节，[可选] 参考 `css-me`。

## 实现注意

- Figma 尺寸、行高、圆角、间距以节点 metadata 为准，截图只做肉眼回归。
- 临时预览页可服务验收，但输出时标明静态数据不是接口契约。
- 接口分析要区分“已存在接口 / 预计新增接口 / 待后端确认字段”。
- 若用户只要求某个小问题，补丁只落在直接组件或 selector，别顺手重构相邻交互。
- 需要格式收敛时，把变更交给 `clife-homing-format-code`，别在页面 skill 里全仓格式化。

## 高价值反模式

| 反模式                           | 代价                                     | 正确做法                          |
| -------------------------------- | ---------------------------------------- | --------------------------------- |
| 按截图目测写尺寸                 | 平板 WebView 上行高、间距、圆角容易偏    | 取 Figma metadata，再用截图验收   |
| 组件里直接解析 DTO               | JSX 变成数据清洗脚本，后续接口变更难收敛 | mapper/normalize 先产出 ViewModel |
| 用 CSS `background-image` 放图标 | 小程序兼容和资源治理都容易出问题         | `ImageWebp + assetUrls.ts`        |
| 把静态 demo 字段写成接口合同     | 后端对齐时会产生假契约                   | 标注为 UI 验收数据，接口另列      |
| 为一个局部 bug 重排整页结构      | 引入无关 diff 和回归风险                 | 锚定当前组件/selector 最小修复    |

## 验收与输出

每轮交付至少说明：

- 改了哪些绝对路径或项目相对路径。
- 本轮实现对应哪个 Figma 节点、截图区域或用户问题。
- 做过哪些验证：可读性、冲突标记、diff 范围、必要的格式/类型/样式检查。
- 哪些验证受环境限制，剩余风险是什么。

技术分析文档按“页面入口 → 功能 → 组件 → 接口 → 文件 → 复用关系”组织。

## 项目事实

- 护理报告模块目录：`src/pages/serviceComplete/`。
- 组件目录：`src/pages/serviceComplete/components/<Name>/{index.tsx,index.module.scss}`。
- 图片常量：`src/pages/serviceComplete/constants/assetUrls.ts`。
- 图片组件：`@/components/imageWebp`。
- 分层参考：`src/pages/reservationBoard/`。
- 模块目录结构、文件规模与拆分规则归 helper-me `03-dev` 的 `web-me` 节；样式治理归 `css-me`。
- v1.7.1 画板：38=`6323:2788`，39=`6323:2944`，40 需在 Figma Layers 点选确认；父节点 `6122:3167` 是整页画布。

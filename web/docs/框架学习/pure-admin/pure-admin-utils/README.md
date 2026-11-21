# @pureadmin/utils 从入门到精通

一套基于源码（v2.6.4）写的系列教程，共 10 篇，分三个阶段。所有代码示例的输入输出均来自仓库测试文件 `src/tests/utils.test.ts` 的真实断言，所有机制描述均对应源码原文，文中出现的每个文件路径都可以在仓库里直接找到。

## 适用读者

- 正在或准备在 Vue 3 项目里使用 `@pureadmin/utils` 的开发者（入门篇）
- 想理解"零依赖工具库"工程设计的开发者（进阶篇）
- 想参与贡献或借鉴其架构写自己工具库的开发者（精通篇）

## 目录

### 入门：会用

| 篇 | 文章 | 核心内容 |
| --- | --- | --- |
| 01 | [初识 @pureadmin/utils](./01-getting-started.md) | 库的定位、三部分组成（utils/hooks/types）、安装与第一行代码 |
| 02 | [工具函数实战](./02-utils-in-action.md) | 判空校验、数组、对象、字符串、金额精度、树形数据、存储，25 个高频函数 |
| 03 | [hooks 实战](./03-hooks-in-action.md) | 水印、暗色模式、拖拽、剪贴板、尺寸监听、平滑滚动、动态加载 |

### 进阶：懂原理

| 篇 | 文章 | 核心内容 |
| --- | --- | --- |
| 04 | [零依赖设计](./04-zero-dependency-design.md) | convert.ts 依赖反转层、四入口构建矩阵、tree-shaking、SSR 三道防线 |
| 05 | [useECharts 深度剖析](./05-use-echarts.md) | globalProperties 注入与特征嗅探、响应式主题、resize 双路径、轴标签 tooltip |
| 06 | [useWatermark 深度剖析](./06-use-watermark.md) | canvas 双列瓦片绘制、MutationObserver 防删除、verticalOffset、调用时序 |
| 07 | [类型系统](./07-type-system.md) | types.ts 组织方式、泛型工具类型、DeepClean 条件类型拆解、四态参数类型 |

### 精通：能改造

| 篇 | 文章 | 核心内容 |
| --- | --- | --- |
| 08 | [工程化体系](./08-engineering.md) | tsup 四配置块、vitest 现状与盲区、CI 双流水线、husky 三件套、发版流程 |
| 09 | [实战：添加新函数](./09-add-your-own-function.md) | 实现 → 类型 → 导出 → 测试 → 四道检查的完整流程与代码风格约定 |
| 10 | [源码笔记与已知边界](./10-source-notes.md) | 七处值得标注的源码位置（含可复现依据）、判断函数可信度的三问框架 |

## 推荐学习路径

**路径 A：项目要用了，快速上手**（约 1 小时）
01 → 02 → 03，遇到具体问题再回查。三篇的动手练习都做，约需半天。

**路径 B：想搞懂设计**（约 3 小时）
01 → 02 → 03 → 04 → 05 → 06。第 4 篇是分水岭，读完它再看任何 hooks 源码都不再迷路。

**路径 C：准备贡献代码或写自己的库**（约 1 天）
A 或 B 打底 → 07 → 08 → 09 → 10。第 10 篇的三问框架（有测试吗/有模块级状态吗/边界有人管吗）适合作为读任何源码的习惯。

## 阅读约定

- 每篇开头列"读完你会知道什么"，结尾有"动手练习"，练习都指向仓库里的真实文件
- 提及源码时给出相对路径（如 `src/utils/object.ts`），文件行号基于 v2.6.4，后续版本可能有偏移
- "新手常见误解"是每篇的固定栏目，内容来自该库使用者最常见的错误认知

## 相关链接

- 官方文档站：<https://pure-admin-utils.netlify.app/>
- 仓库地址：<https://github.com/pure-admin/pure-admin-utils>
- npm：<https://www.npmjs.com/package/@pureadmin/utils>
- 各框架集成示例：<https://github.com/pure-admin/pure-admin-utils-docs/tree/master/playgrounds>

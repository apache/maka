# 03 全局 Skill 速查

> 内容版本：v2.0
> 校准日期：2026-09-13
> 范围：`skills.manifest.json` global 键的 24 项——每次会话自动可触发，直呼名字或说触发词即可。
> 待命技能（不在此表）见 [04](04-场景-需求与开发.md)/[05](05-场景-质量与交付.md) 的路由表，按真身路径调用。

## 一、个人开发 *-me 家族（8）

| skill              | 一句话用途                                                                                                                                   | 典型触发                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **helper-me**      | 个人开发总入口：架构/技术栈/工作流决策 + React 审查，内嵌 prd-me / api-me / dev-me（web/react/zustand/vue/node-bff/bug/quality/review 八节） | "做个人项目""审 React 代码""code review 面试" |
| **ui-me**          | 业务 UI 架构契约：布局、搜索表单、表格分页、弹窗、无数据态、H5 适配、P0-P8 优先级总表                                                        | "表格页""弹窗""加载更多""横屏适配"            |
| **css-me**         | CSS/SCSS/CSS Modules 样式治理与 UI 还原，六步属性序、跨端布局                                                                                | "样式""UI 还原""z-index""gap 兼容"            |
| **taro-me**        | Taro 3.6 + React 17 多端工作流：分包、APP_TYPE、真机差异                                                                                     | "Taro""小程序""dev:h5"                        |
| **writer-me**      | 技术写作：README、交接、复盘、翻译、去 AI 味                                                                                                 | "写文档""复盘""帮我重写这段文字"              |
| **mentor-me**      | 导师式概念讲解，用当下项目做贯穿案例                                                                                                         | "teach me X""什么是 X"                        |
| **cognition-me**   | 学习规划、心智模型、时间杠杆、长期成长                                                                                                       | "学习计划""心智模型"                          |
| **performance-me** | 月度绩效自评与目标制定，git 提交取材                                                                                                         | "本月绩效""月度总结"                          |

## 二、在职项目（3，beauty-smart-advisor）

| skill                          | 一句话用途                                                    |
| ------------------------------ | ------------------------------------------------------------- |
| **clife-homing-figma-to-page** | Figma→React/Taro 页面：组件地图、ViewModel 分层、SCSS Modules |
| **clife-homing-figma-to-urls** | Figma 节点/SVG 切图 → COS CDN URL 与 assetUrls.ts             |
| **clife-homing-format-code**   | 项目内 scoped Prettier/ESLint 排序、diff 收敛、提交前检查     |

## 三、工程与质量（7）

| skill                           | 一句话用途                                        | 典型触发               |
| ------------------------------- | ------------------------------------------------- | ---------------------- |
| **tdd**                         | 测试先行：红绿重构、修 bug 先写失败测试           | "先写测试""TDD"        |
| **code-simplifier**             | 保功能简化代码：清晰、一致、可维护                | "简化这段代码"         |
| **writing-comments**            | 代码注释写法（JSDoc 与行内注释的价值判断）        | "加注释"               |
| **typescript-magician**         | 复杂泛型设计、any 收紧、类型守卫                  | "类型体操""消灭 any"   |
| **jsdoc-typescript-docs**       | JSDoc 文档化 TS 代码与 API 文档生成               | "JSDoc""补文档注释"    |
| **vercel-react-best-practices** | Vercel 出品的 React/Next 性能与写法规范           | 写/审 React 代码时     |
| **vercel-composition-patterns** | React 组合模式：布尔 props 泛滥重构、组件库灵活层 | "组件设计""props 太多" |

## 四、方法论与表达（3）

| skill        | 一句话用途                                | 典型触发                         |
| ------------ | ----------------------------------------- | -------------------------------- |
| **grilling** | 对方案/决策 relentless 拷问直到共识       | "grill me""stress-test 这个方案" |
| **ponytail** | 懒汉阶梯：YAGNI、复用优先、最短可用 diff  | "$ponytail"                      |
| **show-me**  | 图示化解释：简图、代码形草图、HTML 小产物 | "画个图""show me"                |

## 五、Skill 体系自身（3）

| skill                              | 一句话用途                                 | 典型触发                |
| ---------------------------------- | ------------------------------------------ | ----------------------- |
| **find-skills**                    | 发现并安装现成 skill                       | "有没有能做 X 的 skill" |
| **skill-doctor**                   | 按 rubric 给 skill 打分并起草修改          | "评估这个 skill"        |
| **project-workflow-skill-builder** | 从项目源码/需求/历史生成产品专属开发 skill | "给这个项目生成 skill"  |

## 相关文档

- 待命技能按场景的路由：[04-场景-需求与开发](04-场景-需求与开发.md)、[05-场景-质量与交付](05-场景-质量与交付.md)
- 机器源：[../../skills.manifest.json](../../skills.manifest.json)

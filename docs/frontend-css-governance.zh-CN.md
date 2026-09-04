---
doc_id: frontend.css-governance
title: "前端 CSS 治理规范"
language: zh-CN
source_language: en
counterpart: ./frontend-css-governance.md
implementation_status: current
document_status: stable
translation_status: synced
last_verified: 2026-09-05
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# 前端 CSS 治理规范

[English](./frontend-css-governance.md)

本仓库的前端样式体系由 Astryx、`@maka/ui` 产品组合样式和 renderer surface CSS 组成。级联顺序是明确的实现契约，不能随意改动。本文描述贡献者修改 `apps/desktop/src/renderer/**` 与 `packages/ui/src/**` 时应遵守的当前契约。

## 1. 入口文件规则

- `apps/desktop/src/renderer/styles.css` 只能作为样式入口文件使用。
- 它只允许包含 `@import` 和顶层入口编排语句。
- 新增的 per-surface selector 规则块必须放在 `apps/desktop/src/renderer/styles/**/*.css`。
- `cascade-layers.css`、`maka-tokens.css` 和 `reference-shell.css` 是有意保留在根目录的例外：它们分别负责级联顺序、renderer 共享 token 与历史 recipe，以及待收敛的 shell 兼容规则。普通 surface 规则不要写进这些文件。

### Selector 命名

- 新增的跨 renderer surface 共享 selector，以及 `@maka/ui` 对外 selector，使用 kebab-case `.maka-*` 方言。
- 已有的 `styles/settings/**` surface 使用 camelCase `.settings*` selector；settings 内的新 selector 应延续该方言，避免同一 surface 混用两套命名。
- 现有 feature 可以保留自己的局部命名空间，例如 `.workhub-*`，但不得把它扩散成第二套跨 surface 方言。遗留的 `.agents-*` 与 `.detailPane` 属于兼容债务，不能作为新增 selector 的范例。
- 在 settings 的 concern 文件之间移动现有 selector 时不要求全仓重命名；未来若统一命名，应作为显式兼容性改动单独推进。

## 2. Layer 规则

- `apps/desktop/src/renderer/cascade-layers.css` 是级联顺序的唯一权威：`reset`、`theme`、`base`、`astryx-components`、`astryx-tokens`、`components`。
- `styles.css` 把 Astryx 中性组件样式放入 `astryx-components`，把生成的 Maka 主题放入 `astryx-tokens`，并把 `@maka/ui` 与 renderer surface 放入 `components`。`maka-tokens.css` 自己声明 `base` 与 `components` 块。
- 普通产品展示规则应放在 `components`；只有现有 layer 确实拥有该规则的语义时，才使用其他 layer。
- 只有在构建链明确支持时，才使用 `@import "./file.css" layer(components)`。
- 不要使用 `@layer { @import ... }` 这种写法。

应在最近的现有职责缝隙解决覆盖，不再增加更高优先级的兼容层。surface 样式文件不得重新排序全局 layer；需要改变级联顺序时，应修改 `cascade-layers.css`，并提供真实渲染回归证据。

## 3. `!important` 使用规则

- 默认例外包括无障碍辅助规则（例如 `.maka-visually-hidden`）、reduced-motion / e2e-fixture 覆盖，以及集中管理的原生 cursor 策略。
- `reference-shell.css`、`styles/settings/usage.css` 与 `packages/ui/src/styles.css` 中仍有少量兼容或产品覆盖。它们是显式债务或有边界的组件修复，不能作为继续增加覆盖的先例。
- 新增的非默认用法必须紧邻说明注释：指出与哪条规则冲突、为什么常规组件或 layer 职责无法表达，以及何时可以删除。约定使用 `Justified:` 作为标记。
- 如果 primitive API 或语义类可以直接表达，优先在该职责层解决，不要继续叠更多 `!important`。

## 4. Token 规则

- renderer 共享自定义属性统一放在 `apps/desktop/src/renderer/maka-tokens.css`。
- `apps/desktop/src/renderer/astryx-theme/maka.css` 由 `npm run astryx:theme` 生成，不得手工修改。
- 组件局部属性只能放在其 owner 附近，并带 `/* local: ... */` 注释。
- 不要为语义角色新增原始颜色，不要用一次性 radius 重复现有圆角阶梯，也不要新增无治理的 z-index。只有在描述组件内部的实测约束、而非可复用设计角色时，才可使用字面几何值。

## 5. 这些规则靠什么保证

这些规则靠评审保证。静态正确性交给 Biome、Knip 和 typecheck；accessibility
保留聚焦的检查。CSS 使用关系和 Story 文案不再由全仓 regex baseline 决定。

- `npm run astryx:surface-inventory` 会验证生成的 surface inventory 与磁盘一致，并阻止新增 raw interactive-control blocker；它不等于完整的 CSS 治理证明。
- renderer CSS 的行为在它真正渲染的地方验证：Storybook、app，或对真实界面的 e2e 断言。
- selector 应随其 source 或 surface 一起删除，不维护运行时字符串 allowlist。

## 6. 推荐改动顺序

调整 renderer CSS 时，建议按下面顺序推进：

1. 把 `styles.css` 中的真实规则块迁到子文件。
2. 通用组件外观留给 Astryx，产品组合样式放在 `@maka/ui` 或对应 renderer surface。
3. 清理 dead selector。
4. 只有在 primitive / layer 架构已经稳定后，再移除剩余 `!important`。

## 7. 当前治理原则

- 先保证 CI 护栏可信，再做结构收敛。
- 先删 dead CSS，再谈样式“美化性重构”。
- 对共享 `Button` / `Textarea` / `EmptyState` 这类 primitive 的覆盖，优先从组件接口层解决，不要长期依赖 renderer CSS 强压。
- 任何会影响级联顺序的改动，都必须配合对真实渲染结果的最小回归验证一起提交。

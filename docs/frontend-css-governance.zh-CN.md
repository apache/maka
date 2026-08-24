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

本仓库的前端样式体系由 Astryx、`@maka/ui` 产品组合样式和 renderer surface CSS 组成。级联顺序必须被明确约束，不能随意改动。

## 1. 入口文件规则

- `apps/desktop/src/renderer/styles.css` 只能作为样式入口文件使用。
- 它只允许包含 `@import` 和顶层入口编排语句。
- 新增的 per-surface selector 规则块必须放在 `apps/desktop/src/renderer/styles/**/*.css`。
- `maka-tokens.css` 尾部的历史 recipe 和 `reference-shell.css` 是待收敛的 transitional exceptions；不要继续向这两个例外增加 surface 规则。

### Selector 命名

- renderer 与 `@maka/ui` 的共享 selector 使用 kebab-case `.maka-*` 方言。
- 已有的 `styles/settings/**` surface 使用 camelCase `.settings*` selector；settings 内的新 selector 应延续该方言，避免同一 surface 混用两套命名。
- 在 settings 的 concern 文件之间移动现有 selector 时不要求全仓重命名；未来若统一命名，应作为显式兼容性改动单独推进。

## 2. Layer 规则

- 纯展示规则应尽量放进：
  - `@layer base`
  - `@layer components`
- 只有在构建链明确支持时，才使用 `@import "./file.css" layer(components)`。
- 不要使用 `@layer { @import ... }` 这种写法。

Astryx reset 和组件层在前，Maka base token 与产品 `components` 在后。应在最近的现有职责缝隙解决覆盖，不再增加更高优先级的兼容层。

## 4. `!important` 使用规则

- 默认只允许两类场景使用 `!important`：
  - 无障碍辅助规则，例如 `.maka-visually-hidden`
  - reduced-motion / e2e-fixture 这类测试或可访问性覆盖
- 其他任何 `!important` 都必须同时满足：
  - 就地写明 `Justified:` 注释
- 如果 primitive API 或语义类可以直接表达，优先在该职责层解决，不要继续叠更多 `!important`。

## 5. Token 规则

- 自定义 CSS 变量统一放在：
  - `apps/desktop/src/renderer/maka-tokens.css`
- 只有组件局部变量允许例外，但必须带：
  - `/* local: ... */`
- 禁止新增以下硬编码值：
  - 颜色
  - radius
  - 未纳入约束体系的 z-index

## 6. 这些规则靠什么保证

这些规则靠评审保证。静态正确性交给 Biome、Knip 和 typecheck；accessibility
保留聚焦的检查。CSS 使用关系和 Story 文案不再由全仓 regex baseline 决定。

- renderer CSS 的行为在它真正渲染的地方验证：Storybook、app，或对真实界面的 e2e 断言。
- selector 应随其 source 或 surface 一起删除，不维护运行时字符串 allowlist。

## 7. 推荐改动顺序

调整 renderer CSS 时，建议按下面顺序推进：

1. 把 `styles.css` 中的真实规则块迁到子文件。
2. 通用组件外观留给 Astryx，产品组合样式放在 `@maka/ui` 或对应 renderer surface。
3. 清理 dead selector。
4. 只有在 primitive / layer 架构已经稳定后，再移除剩余 `!important`。

## 8. 当前治理原则

- 先保证 CI 护栏可信，再做结构收敛。
- 先删 dead CSS，再谈样式“美化性重构”。
- 对共享 `Button` / `Textarea` / `EmptyState` 这类 primitive 的覆盖，优先从组件接口层解决，不要长期依赖 renderer CSS 强压。
- 任何会影响级联顺序的改动，都必须配合对真实渲染结果的最小回归验证一起提交。

# 前端 CSS 治理规范

[English](./frontend-css-governance.md)

本仓库的前端样式体系基于 Tailwind v4，加上 renderer 侧手写 CSS。
当前仍存在一部分 renderer surface 对共享 `@maka/ui` primitive 的覆盖，因此级联顺序必须被明确约束，不能随意改动。

## 1. 入口文件规则

- `apps/desktop/src/renderer/styles.css` 只能作为样式入口文件使用。
- 它只允许包含：
  - `@import`
  - `@source`
  - `@theme`
  - 顶层入口编排语句
- 新增的 per-surface selector 规则块必须放在 `apps/desktop/src/renderer/styles/**/*.css`。
- `maka-tokens.css` 尾部的历史 recipe 和 `reference-shell.css` 是待收敛的 transitional exceptions；不要继续向这两个例外增加 surface 规则。

### Selector 命名

- renderer 与 `@maka/ui` 的共享 selector 使用 kebab-case `.maka-*` 方言。
- 已有的 `styles/settings/**` surface 使用 camelCase `.settings*` selector；settings 内的新 selector 应延续该方言，避免同一 surface 混用两套命名。
- 在 settings 的 concern 文件之间移动现有 selector 时不要求全仓重命名；未来若统一命名，应作为显式兼容性改动单独推进。

## 2. Layer 规则

- 纯展示、不会去覆盖共享 primitive / Tailwind utility 的规则，应尽量放进：
  - `@layer base`
  - `@layer components`
- 只有在构建链明确支持时，才使用 `@import "./file.css" layer(components)`。
- 不要使用 `@layer { @import ... }` 这种写法。
- 如果一个 selector 需要覆盖共享 primitive 自带的 Tailwind utility，就不要把它放进 `@layer components`。

## 3. 必须压过 Tailwind Utility 的规则

下面这些选择器依赖在同一元素上压过 Tailwind utility。自 #1565 PR 1 起，它们靠位于 `maka.legacy` 层实现（`cascade-layers.css` 把该层声明在 `utilities` 之后；在此之前靠保持 unlayered）。`cascade-layers.css` 里的层序声明只允许追加：后续迁移 PR 可以增加新层，但绝不能重排既有五层。除非共享 primitive 的实现先改掉，否则不能把这些选择器塞进 `@layer components`：

- `.maka-nav-row`
- `html[data-os="darwin"] .maka-nav-row`
- `.settingsHealthRefresh`
- `.settingsPermissionRefresh`
- `.settingsBotList button`

这是约定，不是测试护栏：静态级联契约已随源码扫描测试套件一起删除。改动这里靠看真实渲染结果（Storybook 或 app）验证，而不是靠正则扫 CSS。

## 4. `!important` 使用规则

- 默认只允许两类场景使用 `!important`：
  - 无障碍辅助规则，例如 `.maka-visually-hidden`
  - reduced-motion / e2e-fixture 这类测试或可访问性覆盖
- 其他任何 `!important` 都必须同时满足：
  - 就地写明 `Justified:` 注释
- 如果一个元素的 primitive reset 可以直接通过 JSX utility class 完成，优先把 reset 下沉到 JSX，不要继续在 CSS 里叠更多 `!important`。

## 5. Token 规则

- 自定义 CSS 变量统一放在：
  - `apps/desktop/src/renderer/maka-tokens.css`
- 只有组件局部变量允许例外，但必须带：
  - `/* local: ... */`
- 禁止新增以下硬编码值：
  - 颜色
  - radius
  - 未纳入约束体系的 z-index

## 6. Dead CSS 规则

- dead CSS 检查脚本是：
  - `scripts/check-dead-css.mjs`
- 当前扫描范围包括：
  - `apps/desktop/src/renderer/styles/**/*.css`
  - `apps/desktop/src/renderer/reference-shell.css`
- 如果某个 class 是运行时动态生成、源码静态搜索不到，必须在脚本 allowlist 中明确登记。
- 如果 dead class 数量变化，只有在评审明确确认的前提下，才允许修改 `scripts/check-dead-css-baseline.json`。

## 7. 这些规则靠什么保证

靠评审时的约定，加上仍然独立存在的快速脚本：`check-dead-css`、`check-a11y`、
`check-copy`、`check-console`。原来用测试把这些规则再断言一遍的源码扫描套件已经
删除——它让每次重构都要顺手改写自己的护栏，抓到的却只是 linter 该抓的东西。

- renderer CSS 的行为在它真正渲染的地方验证：Storybook、app，或对真实界面的 e2e 断言。
- 真的值得机器强制的规则，写成 `scripts/check-*.mjs`（快、单一职责、不依赖构建），
  而不是写成一个正则扫源码树的测试。

## 8. 推荐改动顺序

调整 renderer CSS 时，建议按下面顺序推进：

1. 把 `styles.css` 中的真实规则块迁到子文件。
2. 只把“不会覆盖共享 utility”的规则放进 layer。
3. 清理 dead selector。
4. 只有在 primitive / layer 架构已经稳定后，再移除剩余 `!important`。

## 9. 当前治理原则

- 先保证 CI 护栏可信，再做结构收敛。
- 先删 dead CSS，再谈样式“美化性重构”。
- 对共享 `Button` / `Textarea` / `EmptyState` 这类 primitive 的覆盖，优先从组件接口层解决，不要长期依赖 renderer CSS 强压。
- 任何会影响 Tailwind utility 级联顺序的改动，都必须配合对真实渲染结果的最小回归验证一起提交。

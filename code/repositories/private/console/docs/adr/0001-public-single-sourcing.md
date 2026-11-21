# ADR-0001: 公共件单源化

- 状态：已接受（Accepted）
- 日期：2026-08-30
- 关联：AGENTS.md「架构边界」3/4/5 与「模块豁免规则」；提交 `a887f456`（样式基座）、`0a37cf00`（主题统一）、`9784b71d`（UI 基座收敛）、`64ace6c3`（markdown 上移）、`a72ad5b6`（chat-viewer 元文件）、`dfafcafe`（影子类型派生）

## 背景

2026-08-30 全仓架构评审发现六类复制漂移，公共件"有家未归"——`@ggbdpq/console-ui` 等包已存在且被各 app import，但复制品散落各处：

1. 样式基座（:root + .dark token + @theme + 防闪脚本）在 4 个 app 的 globals.css 各存一份，另加 `scripts/apply-dark-tokens.mjs` 里的第 5 份模板，靠正则 codemod 手工同步；
2. 主题状态 3 套 module、3 个 localStorage key（`theme` / `claude-profile-theme` / `agentops-theme`），互不相认且防闪脚本只覆盖其一，另有 2 处 zustand 旁路直接改 `<html>` class 覆盖首帧写入；
3. console 内 3 套 UI 基座并存（`src/ui/*`、`components/agentops/ui/*`、`@ggbdpq/console-ui`），违反 AGENTS.md 边界 5；
4. `markdown.tsx` 在 blog 与 toolbox 逐字节双份；
5. chat-viewer 按原版 verbatim 移植时把上一仓库的元文件（README/LICENSE/CI/CONTRIBUTING/样本数据/开发档案）一并带进 `src/`；
6. inventory 视图层手写影子类型（`CatalogProduct` 与核心 `productSchema` 16 字段逐一相同，`Wallet`/`AutoRule`/`MarketQuote` 同形），schema 漂移时编译期不报错。

## 决策

1. **样式基座唯一住址**：token 块、`@theme` 映射、`@layer base`、防闪脚本归 `packages/ui`（`styles/base.css` + `ThemeScript`）；各 app 的 `globals.css` 只允许 `@import "@ggbdpq/console-ui/base.css"` 与 app 自有样式，禁止定义基座变量。
2. **主题唯一真源**：`packages/ui` 的 theme module（`useTheme`/`ThemeToggle`/`ThemeScript`），key 固定 `"theme"`，语义为 light→dark→system 三态循环；禁止任何 app 自建主题存储或直接 `classList` 旁路改主题。
3. **UI 基座唯一**：所有 UI 原语只用 `@ggbdpq/console-ui`（AGENTS.md 边界 5 的落地）；域变体（badge 的 p0/p1/p2/pass/pending/blocked 等）以 variant 并入包内组件，禁止 app 内重建基座目录（`src/ui` 一类）。
4. **跨 app 复用组件上移**：两个以上 app 需要的组件（如 `Markdown`）进 `packages/ui`，其第三方依赖（react-markdown 等）随组件归位包内。
5. **Verbatim 移植豁免仅覆盖源码**：lib/components 源码保真；上一仓库的元文件一律不随迁（详见 AGENTS.md「模块豁免规则」）。
6. **类型派生优先**：与 `@ggbdpq/inventory-core` 同形的类型一律从核心派生（`CatalogProduct`/`Wallet`/`AutoRule`/`MarketQuote`）；有意的 API 投影宽化（`InventoryItem`/`PurchaseOrder` 可选字段）保留手写防腐层。
7. **验证口径**：此类变更用 typecheck + vitest + build 作为匹配风险等级的验证证据；涉及渲染路径的视觉结论须经人工核验。

## 后果

- 正：Figma 改色、主题语义、组件排版、markdown 排版改一处全站生效；核心 schema 漂移编译期暴露；全仓净删约 1200 行复制代码；console 首次实现完整 build（88/88 静态页）。
- 负：`packages/ui` 成为四个 app 的关键依赖，包内接口变更需全仓验证；治理台/配置台视觉从锁深色变为跟随全局明暗（已确认接受）。
- 中性：`scripts/apply-dark-tokens.mjs`、`src/ui/`、`agentops/ui/`、chat-viewer 元文件等旧载体已删除，回潮即引入新文件。

## 防回潮检查点（评审与新代码时逐条核对）

- [ ] 新 app 的 globals.css 是否只 import 基座、不定义 token 变量
- [ ] 是否出现第二个 `cn` 实现或 re-export 之外的本地铁副本
- [ ] 是否出现 app 内新 UI 基座目录（`src/ui`、`components/xxx/ui` 原语集）
- [ ] 主题相关代码是否新建 localStorage key 或绕过 theme module 直接改 class
- [ ] `lib/` 下是否手写与 inventory-core 同形的类型（应 import 派生）
- [ ] verbatim 移植是否夹带仓库元文件

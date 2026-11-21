# console 设计规范（DESIGN.md）

> 制定于 2026-09-06。条文来源：`C:\Users\ggbdpq\.ai\categories\03-设计体验与前端应用\01-设计系统与设计还原` 下的 shadcn（customization + rules）、impeccable（product register）、design-taste-frontend（一致性锁）、interaction-design（动效时长表）；验收借用 web-design-guidelines（Vercel Interface Guidelines）。
>
> **唯一 token 住址：`packages/ui/src/styles/base.css`。** 四个 app 的 globals.css 只 `@import` 基座；改主题色/字体/圆角只动基座，不在 app 里复制。

## 1. 适用范围与豁免

- **约束**：`apps/console`、`apps/blog`、`apps/toolbox`、`apps/portal` 的所有页面与业务组件，以及 `packages/shared` 相关展示层。
- **豁免区**（源码风格不动）：
  - `/lab`（`apps/console/src/app/lab/**`、`components/lab/**`）：终端实验室作用域主题（`.lab-root` 内自洽：绿 accent、两档圆角、term-* 语义类），pi-web-dev verbatim 豁免。
  - `apps/toolbox/src/features/chat-viewer`、`skill-manager`：verbatim 移植模块源码。
  - `packages/ui/src/**`：shadcn 定制层（原语实现），实现细节自由，但对页面暴露的 API 必须语义化。
- 豁免区的类名**不得外溢**到非豁免文件；豁免不覆盖行为与 a11y。

## 2. 设计原则（GitHub Primer × product register）

本产品是控制台：**设计服务于任务，工具隐入任务**。视觉语言参考 GitHub Primer（2026-09-10 起，米金品牌退役）——中性灰阶、绿主按钮、蓝链接、细边框卡片、小圆角、紧凑密度；及格线是"earned familiarity"：

- **一致性优先于惊喜**：同一个动作在所有台里长得一样；"保存"按钮在两处长得不同，必有一处是错的。
- **色彩策略 Restrained**：中性灰面板 + 单一 accent（蓝 `#0969da`/`#2f81f7`），主操作绿（`--primary`），accent 蓝只用于链接与信息指示，不用于装饰。
- **语义状态词表标准化**：hover / focus / active / disabled / loading / error / success / warning / info 全部走 token，任何交互组件七态齐备才可交付。
- **亮暗双板同权**：每个页面交付前两种模式都打开看过；层级关系在两板下都对等。
- **破坏性操作两步行内确认**：删除类动作先落"确认删除？✓/✗"行内确认（TodoPanel 与 ConversationHistory 同款），不做一键直达、也不弹模态（product register：模态是最后手段）。

## 3. 主题色（GitHub Primer，双板）

2026-09-10 换皮：米金品牌退役，亮暗双板均取自 GitHub Primer。实底色 -foreground 对比度已逐对预演算 ≥4.5:1（暗板亮色实底配深字）。

| Token | 亮板 | 暗板 | 用途 |
|---|---|---|---|
| `--primary` | `#1f883d` 主按钮绿 | `#238636` | **只给页面主操作**（跟随 GitHub：主按钮绿） |
| `--primary-foreground` | 白 | 白 | 实底 primary 上的文字 |
| `--info` / 链接蓝 | `#0969da` | `#2f81f7` | 链接、信息指示（GitHub accent） |
| `--background` | `#ffffff` | `#0d1117` | 页面底 |
| `--card` / `--popover` | `#ffffff` | `#161b22` | 卡面/浮层（暗板 GitHub surface） |
| `--secondary` / `--muted` | `#f6f8fa` | `#21262d` | 次按钮灰底、次级面 |
| `--foreground` | `#1f2328` | `#e6edf3` | 正文 |
| `--muted-foreground` | `#59636e` | `#9198a1` | 次要文字 |
| `--accent`（hover 面） | `#eaeef2` | `#30363d` | hover 抬升底 |
| `--border` / `--input` | `#d0d7de` | `#30363d` | 边框 |
| `--ring`（focus） | `#0969da` | `#2f81f7` | focus 环 |
| `--nav-accent` | `#fd8c73` | `#f78166` | UnderlineNav 激活底线橙 |
| `--success` / `--warning` / `--destructive` | `#1a7f37` / `#9a6700` / `#cf222e` | `#3fb950` / `#d29922` / `#f85149` | 语义状态 |
| `--success/warning/info-foreground` | 白 | `#0d1117` 深字 | 实底状态色上的文字（暗板亮底深字 ≥5:1） |

硬规则：

- **禁裸色名**（`bg-emerald-700`、`text-stone-400`…）与禁手写 `dark:` 颜色覆盖——它们绕过双板。状态指示用 `text-destructive` / `bg-success` / Badge variant。两条例外已固化在 check-style：`bg-black/NN` 遮罩 scrim、行内 `// style:ok` 豁免（物理媒介/动态数据色）。
- **Button variant 语义**：`default` 只给页面主操作（绿）；普通按钮用 `secondary`（灰底描边，GitHub 次按钮）或 `outline`。见 §6。
- 正文对比度 ≥ 4.5:1；大字（≥18px bold）≥ 3:1。
- 新增语义色的流程：先在 `base.css` 定义 `--xxx` + `--xxx-foreground` 并注册 `@theme inline`，再使用。
- **lab @theme 色名带命名空间碰撞风险**：`--color-base` 曾使 `text-base` 被整体解析为颜色 utility（字号丢失），已改名 `--color-lab-base`。新增 `--color-*` 时避开 Tailwind 内置 utility 名。

## 4. 字体

- 界面：**Geist Variable**；等宽（数字/ID/hash/代码/终端）：**JetBrains Mono Variable**。两族封顶（impeccable：字体 ≤ 3）。
- `--font-sans` / `--font-mono` 在 `base.css` 声明，`body` 全局 `font-sans`；字体文件由各 app 经 `@fontsource-variable/*` import（console 已接；其他 app 需用时自行加依赖）。
- **输入控件防缩放线**：触屏设备（`pointer: coarse`）上 input/select/textarea 字号一律 ≥16px（iOS Safari 聚焦 <16px 输入会自动放大页面）。基座已用非 layered 元素规则全局兜底（压过 text-sm/text-xs 工具类，桌面端不受影响），新写输入框无需关心此条。
- 数字型数据（计数、金额、时间戳）加 `tnum`。

## 5. 圆角体系（Shape Lock）

全项目一套刻度，由 `--radius: 0.375rem`（6px，GitHub 基准）派生，**只许这五档**：

| 档 | 值 | 用途 |
|---|---|---|
| `rounded-sm` | 2px | 小 chip |
| `rounded-md` | 4px | 按钮、输入框 |
| `rounded-lg` | 6px | 卡片、面板、表格容器 |
| `rounded-xl` | 10px | 大面板、弹窗（历史遗留，新代码用 lg） |
| `rounded-full` | 胶囊 | 仅限 badge、状态点、头像、气泡 |

禁 `rounded-2xl/3xl`；卡片圆角上限 6px（Primer 无大圆角）。

## 6. 写法规则（shadcn rules 条文）

1. **内置 variant 优先**：`<Button variant="outline">`，不要手写 `border border-input bg-transparent hover:bg-accent`。
2. **Button variant 语义（GitHub 式）**：`default`（绿）**只给页面主操作**；普通/次要按钮一律 `secondary`（灰底描边）或 `outline`；`ghost` 给工具条图标钮。若一个页面出现多个绿按钮，必有多余的。
2. **className 只管布局**（`max-w-md`、`mt-4`），不管颜色和字重；改颜色走 token 或加 variant。
3. `gap-*` 替代 `space-x/y-*`；`size-4` 替代 `w-4 h-4`；`truncate` 替代三件套。
4. 条件类用 `cn()`，不在 className 字符串里写三元拼接。
5. **禁手写 z-index**：Dialog/DropdownMenu/Popover 等自管堆叠；自定义堆叠用语义刻度（dropdown → sticky → modal-backdrop → modal → toast → tooltip）并在常量文件登记。
6. 组件更新的智能合并走 `npx shadcn@latest add <x> --diff/--dry-run`，不从 GitHub 手拉。

## 7. 图标

- 唯一家族：**`@phosphor-icons/react`**（项目既定）。禁手写 SVG path；禁混入第二家族。
- shadcn 组件内图标用 `data-icon="inline-start|inline-end"`，不加 `size-*`（组件管尺寸）；业务区图标统一 `weight` 与视觉尺寸一致。
- 按钮 label 动宾结构（"保存修改"不是"确定"）；同一动作全程同名。

## 8. 动效（interaction-design + product register）

| 时长 | 用途 |
|---|---|
| 100-150ms | 微反馈（hover、按压） |
| 200-300ms | 小过渡（toggle、下拉） |
| 300-500ms | 模态、页面级 |
| >500ms | 仅编排型特效 |

- 进入用 ease-out（`cubic-bezier(0.16, 1, 0.3, 1)`）；禁 bounce/elastic。产品区多数过渡 150-250ms。
- **只动 transform/opacity**；每个动画必须有 `prefers-reduced-motion: reduce` 降级（lab 的 `.lab-root` 块是范本）。
- 产品 UI 禁页面加载编排动画；动效只表达状态（反馈/定向/聚焦/连续），不做装饰。
- 空态教学（告诉用户怎么填充）、加载用骨架屏（与最终布局同形，禁内容区大 spinner）、错误内联清晰。

## 9. 布局骨架

现状三套并存：ModuleNav（agentops/inventory）、AppShell（governance）、assets 顶栏页签。本轮规范先锁"视觉层"，骨架收敛是独立决策：

- **新页面一律用 ModuleNav 模式**（GitHub UnderlineNav 式页签：激活项 2px 橙底线贴分隔线，header + `max-w-[1720px]` 容器）。
- 骨架二选一（ModuleNav vs AppShell）列为路线图 P3，决策后本节更新。
- 响应式是结构性的（塌侧栏、响应式表格），不做流式字号。

## 10. 验收

1. `pnpm style:check`——扫描裸色名（`scripts/check-style.mjs`）。新代码零容忍；历史欠债在脚本 ALLOWLIST 白名单，**只减不增**，还清一个删一个。
2. 双板检查：改动页面在亮/暗两板各开一遍。
3. Pre-Flight 精选（design-taste 第 14 节的 dashboard 适用项）：单一主题无中途反转 / 单一 accent / 圆角刻度一致 / CTA 对比度 / 表单 focus ring 可见 / 双板已测 / reduced-motion 降级 / 骨架屏 / 空/错态齐备 / 无 em-dash / 无 AI 紫。
4. 大改动追加 web-design-guidelines（Vercel Interface Guidelines）审查，输出 `file:line` 清单。

## 11. 迁移路线图（2026-09-10 质量战役收账）

| 优先级 | 欠债 | 状态 |
|---|---|---|
| ~~P0~~ | todo 模块 raw palette | ✅ 2026-09-06 收编（186 处） |
| ~~P1~~ | ccpage 与 cc 域 `--color-*` 别名体系 | ✅ 2026-09-10 直连语义 token，别名表已删（312 处/13 文件） |
| ~~P2~~ | 历史裸色名 31 文件 | ✅ 2026-09-10 白名单清零（133 处） |
| ~~P2~~ | ui 原语内裸色（badge/alert/message 等变体） | ✅ 2026-09-10 语义 variant |
| P3 | 骨架二选一决策（ModuleNav vs AppShell vs 自容器；含 lab 是否入壳） | ⏳ 待单独决策 |
| ~~P4~~ | 字体接入 blog / toolbox / portal | ✅ 2026-09-10 fontsource 接入 |
| — | **全站换皮 GitHub Primer**（米金退役，console+portal；blog/toolbox 自动跟随基座） | ✅ 2026-09-10（G1-G4） |

无导航四模块（register/toolkit/workflow/worktree）页头已统一 text-xl 规格（2026-09-10）。

## 12. 维护规则

- 改主题色/字体/圆角：只动 `base.css`，三 app 自动生效。
- 本规范的修订随 PR 走；新增豁免区必须在第 1 节和 check-style.mjs 的 EXEMPT_PREFIXES 同步登记并说明理由。
- 白名单文件清零后从 ALLOWLIST 删除；禁止往 ALLOWLIST 加新文件（那是开倒车）。

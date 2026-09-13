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

# Maka 质感提升路线图（2026-07）

> Archived on 2026-07-13. Completed decisions remain visible for provenance; unfinished queues must be tracked in GitHub issues rather than treated as a current documentation backlog.

> 来源：四个设计 skill 资源的系统学习（taste-skill / superdesign /
> ui-skills.com 生态 / vercel-labs agent-skills），对照 maka 现状
> （2026-06-24 skills 轮已 shipped 项 + 2026-07-03 三层 code review）
> 提炼的真增量，加上产品 owner 拍板的四个路线决策。
>
> 阅读前提：`notes/ui-skills-deep-read-2026-06-24.md`（已 shipped 项，
> 避免重做）；`docs/frontend-css-governance.md`（token 治理规则）。

## 0. 已拍板的路线决策（2026-07-03，jackwener）

| # | 决策 | 含义 |
|---|------|------|
| D1 | **转向 4pt spacing 系统** | 所有 padding/gap 收敛到 4/8/12/16/24/32；允许偏离 QoderWork 逐像素值 1-2px。「高级感来自一致性而非对标精度」 |
| D2 | **Dark mode 一等公民** | dark 需要独立 elevation 体系（阴影塌缩为 border ring）、语义色 desaturate；UI PR 双主题截图验收 |
| D3 | **动效人格：快而准** | 高频操作（切会话/发送/palette）零动画；其余全部 <300ms 且取区间下限；AI 流式输出的 typing 节奏除外（那是语义不是装饰） |
| D4 | **暂不做签名元素** | 先把 QoderWork 镜像的基本功（layering/圆角/阴影/状态）做精，视觉身份创新延后 |

## 1. 四源精华 × maka 适用清单

只列「真增量」——已 shipped 项见 ui-skills-deep-read 笔记。

### 1.1 表面层级体系（interface-design "subtle layering"，最高杠杆）

- Surface 亮度逐级只差几个百分点：shell(base) → 白卡(+1) → popover/dropdown(+2)。
  dropdown 必须比它的父表面高一级。
- **Input 比周围略暗**（inset 隐喻「往里输入」）：composer、搜索框、
  palette 输入行。当前 maka 输入面与卡面同色 → 缺一级。
- Border 四档递进：standard / softer / emphasis / focus-ring，全部
  低透明度 rgba/oklch alpha 而非实色 hex。
- Depth 策略四选一并从一而终：maka 的选择 = **白卡 layered shadow +
  卡内 hairline border**，写死，不混用。

### 1.2 阴影（taste-skill + interface-design 共识配方）

- Light mode 三层：`0 0 0 1px α.06 / 0 1px 2px -1px α.06 / 0 2px 4px α.04`，
  全部 oklch(from var(--foreground))，opacity 永不超 0.05-0.06。
- Hover 提升：`0 2px 8px α.04`，200ms。
- **Dark mode 阴影塌缩为单 ring**：`0 0 0 1px oklch(1 0 0 / 0.08)`（D2）。

### 1.3 圆角（同心圆角公式）

- **嵌套时内 radius = 外 radius − padding**。审计对象：灰壳→白卡、
  气泡→内嵌代码块、卡→内部输入框、modal→内部卡。
- 现有 4 档 token（control 6 / surface 8 / modal 12 / pill 999）保留，
  公式约束的是嵌套关系而非档位本身。

### 1.4 间距（D1：4pt 网格）

- 新代码强制 4 的倍数；存量逐步迁移（每次触碰某文件时顺手收敛该文件）。
- 疏密节奏：相关项 8–12px 紧组，组间 24–32px（桌面工具档，非 landing
  的 48-96px）。
- 治理方式：契约测试对新增 CSS 声明检查（存量 allowlist 冻结）。

### 1.5 动效（D3：快而准，Emil duration 表）

| 交互 | 时长 | 备注 |
|------|------|------|
| 高频操作（切会话/发送/palette 开合） | **0ms** | 每天百次的操作不配动画 |
| 按压反馈 | 100–160ms | `:active scale(0.97)` 已 shipped |
| tooltip / 小 popover | 125–200ms | origin-aware |
| dropdown / select | 150–250ms | |
| modal / drawer | 200–300ms | 取下限 |
| AI 流式 / typing 指示 | 语义节奏 | 不受 300ms 上限约束 |

- 永不 ease-in；永不从 scale(0) 入场（0.95 起）；出场比入场快。
- 可中断 UI 用 transition 不用 keyframes。
- hover 动画包 `@media (hover: hover) and (pointer: fine)`。

### 1.6 文字层级（收敛，而非增加）

- 三档制：primary（`--foreground`，100% ink）/ secondary
  （`--foreground-secondary`，80% ink）/ muted
  （`--muted-foreground`，50% ink）。`--foreground-N` 十几档是
  层级糊的来源，UI 新代码只从三档语义别名取值。40% 和 50% 肉眼
  barely 可分，桌面工具场景不需要在"不重要"内部再分一档，所以
  从原四档制进一步收敛到三档。
- CJK 注意：Windows 中文字体缺中间字重 → color/opacity 杠杆权重高于
  weight；**禁收紧 CJK letter-spacing**（拉丁负 tracking 规则不适用）。
- 数字全面 tabular-nums（token 数、时间戳、计数）——部分已 shipped，
  按面补齐。

### 1.7 对比度硬线

- 正文与 **placeholder 均 ≥4.5:1**（「浅灰显优雅」是中文小字的头号
  可读性杀手）；大字 ≥3:1。进 visual audit 流程。

### 1.8 工程质量清单（vercel web-interface-guidelines 摘录）

- flex/grid 文本容器 `min-w-0` 才能截断（已有多起此类 bug）。
- modal/drawer 内 `overscroll-behavior: contain` 防滚动穿透。
- 破坏性操作永不立即执行（confirm 或 undo 窗口）。
- 提交中按钮转 spinner 但不提前 disable；错误 inline + focus 第一个错误。
- 拖拽时禁文本选择；`h-dvh` 不用 `h-screen`。

### 1.9 明确不采纳（避免后人重提）

- Display 字体池 / serif 纪律 / hero 字号 —— 中文 + system stack 无意义
- GSAP scrolltelling / marquee / 磁性按钮 / bento —— marketing 专属
- em-dash 全域禁令 —— 中文破折号「——」是合法标点
- 「禁版本号」—— 桌面工具 About 页显示版本正当
- superdesign 的 AI 消息入场 600ms —— 与 D3 冲突，取 Emil 值

## 2. 落地队列（按杠杆排序）

1. **P-SHADOW** ✅ (#457)：三层阴影配方升级 + dark 塌缩 ring
2. **P-INSET** ✅：palette/搜索输入行 3% 前景 wash step-down；通用
   Input/Textarea 2% wash。composer 例外保持 elevated —— 它是主命令台
   不是表单字段（PR-UI-LAYOUT-8 的有意设计）。
3. **P-RADIUS** ✅（首轮）：palette/搜索 modal 输入行按同心公式修正
   （12−8=4px，写法 `calc(var(--radius-modal)-8px)` —— 契约的 calc
   allowlist 要求无空格）。其余嵌套对（settings modal 内卡、tool card
   内 pre）审计通过或留待触碰时修正。
4. **P-MOTION** ✅（已达标，无需动作）：duration token
   120/150/180/280ms 完全符合 Emil 表且取下限；装饰性入场动画已被
   #406 gap 3 清除；剩余 keyframes 全部是功能性流式动画（D3 豁免）
5. **P-TEXT** ✅（首轮）：孤儿档 -20/-30 清除（8 处调用点：文字并入
   -40 兼修对比度、装饰内联 color-mix）；文字主力收敛为
   40/50/60/70/80。全量四档语义别名迁移留待逐面触碰。
6. **P-4PT** ✅✅（#448 完全体）：#459 的渐进 ratchet 服役半天后被
   #448（#430 PR3）取代 —— 它修复了 --spacing 0.25rem=3.75px 的真 bug
   （Tailwind 与手写 px 两把尺），全量 687 CSS + 125 TSX 收敛到 14 档
   --space-* scale，并用 spacing-converge-contract 硬 ban bare px。
   ratchet 契约已删除（一个机制，留强的）
7. **P-DARK** ✅：elevation 独立化由 P-SHADOW dark-collapse 完成；
   语义色审计通过（dark 的 chroma 微调是感知补偿而非过饱和，
   accent 0.135→0.15 配 L+0.04 在暗底维持等感知强度）
8. **P-STATE** ✅（审计轮）：技能/回顾/聊天 empty 构图完备；发送失败
   = toast + turn 级失败徽章双通道；会话列表本地快路径合理缺席
   skeleton（300ms 延迟原则，本地 SQLite <50ms）；无通用 Skeleton
   组件正符合「形状对齐」原则。缺口留逐面触碰时补。

每项独立 PR，双主题截图验收（D2），契约测试锁行为。

## 3. 队列完成记录（2026-07-03 首轮全清）

- #457 P-SHADOW（roadmap + 阴影配方 + dark collapse）
- #458 P-INSET + P-RADIUS 首轮 + P-MOTION 审计
- #459 P-4PT ratchet 契约 + P-TEXT 孤儿档清理
- 前置质感修复：#454（玻璃色板复活/token 卫生）、#452（blocked
  语义/时间戳/i18n）、#451（copy-feedback 契约同步）
- P-FOREGROUND-TIER-CONVERGE（issue #430 PR4）：5 档文字梯
  （40/50/60/70/80）收敛到 3 档语义别名 — `--foreground`
  （100% ink）、`--foreground-secondary`（80% ink）、
  `--muted-foreground`（50% ink）。-90/-95 零调用直接删。
  444 处调用点全量替换，契约测试锁住文字用法不回退到裸
  mix stops。

下一轮候选（按杠杆）：P-STATE 边缘面补齐、storybook Design
System 页同步新阴影/层级规则。
（原「文字档 60/80 的逐面归并」已由 P-FOREGROUND-TIER-CONVERGE
解决，落地为 3 档制而非 4 档 — 50% 和 40% 肉眼 barely 可分，
桌面工具场景不需要在"不重要"内部再分一档。）
（原「module-pages 76 个 off-grid 值」已由 #448 全量收敛解决。）

## 4. 第二轮全量精读增补（2026-07-03，四源全覆盖）

> 覆盖：taste-skill 全部 26 文件（含 v2 遗漏章节、v1 §9、research/laziness）、
> ui-skills registry 全部 126 条目（~110 份独立文档）、vercel-labs 88 文件
> （react-best-practices 70 rules 全读）、superdesign 全段亲读。
> 原文缓存：session scratchpad `skills2/` 与 `agent-skills/`。

### 4.1 新增可落地规则（相对 §1 的真增量）

**Motion 增补**
- **300ms loading 阈值**：加载 <300ms 什么都不显示，杜绝闪烁 skeleton（ui-ux-pro-max）
- **exit = enter × 60–75%**；动画必须可中断（快速触发用 transition/spring 可重定向，禁 keyframes 重播）；context menu 只做退场动画（Emil review-animations / transitions.dev）
- **80ms 瞬时感知阈值**（micro-interaction 目标）；「慢即真」：AI 生成类复杂操作的可见工作过程传达真实感（pbakaus animate — 属 D3 的流式语义豁免区）
- **transitions.dev 参数表**：dropdown open 250/close 150ms、pre-scale 0.97；modal 250/150、scale 0.96；text swap 200ms+8px+blur 2px；error shake 6px+4px overshoot、3s 自动回退；replay 前 `void el.offsetWidth`
- **换字元素宽度锁定**：状态标签/token 计数/「已复制」按最宽态锁 min-width —— chat 工具最高频 layout-shift 根治（compact-landing）
- spring 决策表：手势/可中断→spring(500/30)；系统状态→easing；时间表征→linear；高频→零动画

**Color/表面增补**
- **灰字禁上彩底**：彩底文字用同色相深一档或前景加 alpha（pbakaus 三处反复强调）
- **OKLCH 三定律**：修对比只调 L 锁 C/H；palette 各阶 hue 漂移 >10° = bug；跨 hue 等鲜艳度用 max-chroma 相同百分比（oklch-skill）
- dark 深度 = 三档 surface 亮度（15/20/25% L 同色相），不靠阴影 —— 与 P-SHADOW dark collapse 互证
- alpha 滥用是 palette 不完整的信号：除 focus ring 外定义显式 overlay 色（对 @layer 陷阱也更友好）
- Anti-Nested-Box：卡中卡中卡硬 ban；密集区用 border-t/divide-y/负空间替代套卡

**排版/细节增补**
- `…` 不用 `...`（loading 文案以 … 结尾）；快捷键 `⌘ K` 用 nbsp；ALL-CAPS 短标签 +5–12% tracking
- 暗底亮字三轴补偿：line-height +0.05–0.1、letter-spacing +0.01–0.02em、字重调档
- italic 含降部字符（y g j p q）最低 leading-[1.1]
- kbd 键帽 recipe：1px 边 + 4px radius + 浅底 + mono（桌面快捷键提示刚需）
- 负 inset 伪元素扩热区（44px 达标不改布局）；`dialog::backdrop` + blur 4px 替代手写遮罩

**治理增补**
- **icon 四条**：单 family、stroke 统一 1.5/2px、filled-outline 不同层级混用禁、尺寸 token（16/20/24）
- z-index 显式 scale 立法（maka 已有语义 z token ✓ 复核覆盖率即可）；modal scrim 40–60% black
- toast 纪律：3–5s 自动消失、aria-live polite、永不作关键信息唯一渠道、低风险删除用 Undo toast
- 文案：按钮写确切动作、同意图全应用一个措辞（发送/确认/提交不混用）、error = 原因+修复路径、禁「轻松/简单/只需」、AI 腔清单（段首总结过渡/datasheet 腔/碎句连发）

**React 性能（vercel 70 rules 全读 → maka grounding）**
现状：全仓 0 处 useTransition/useDeferredValue；chat-view 仅 MessageBody 有 memo。
- ✅ content-visibility 已落地（#468）
- 待做（按序）：TurnView memo 化 + props 收窄（流式不重渲染旧 turn）→ 流式更新包 startTransition / 搜索过滤用 useDeferredValue → markdown parse 结果按 text 缓存 → 面板 hover 预热 `void import()` → 频繁 toggle 面板用 <Activity> → 滚动三件套（passive listener / 贴底判定走 ref / 读写分离）→ barrel import 审计（rollup-plugin-visualizer）
- composition-patterns：composer.tsx 792 行按 compound components 重构候选；react19-no-forwardRef 全仓清理候选
- 原生 `document.startViewTransition` 做 settings/panel 切换（Electron 固定 Chromium，零依赖）

### 4.2 明确不采纳增补
- Lucide→Phosphor 全量换 icon（80+ 调用点，见 §4.3 问题 1，待拍板）
- Motion/GSAP 库编排、bento/hero/marquee 全家（landing 专属）
- 声音反馈两篇（超 UI-only scope，规则已存档：默认音量 0.3、打字禁声）
- react@canary 的 <ViewTransition> 组件（生产依赖不划算，用原生 API 替代）
- brutalist/gpt-tasteskill/brandkit/imagegen 系（风格化/资产生成，与 QoderWork 镜像路线冲突）

### 4.3 已拍板决策（2026-07-03 第二轮，jackwener）
| # | 决策 | 含义 |
|---|------|------|
| D5 | **保留 Lucide + 治理** | 不迁 Phosphor；用治理抵消「默认感」：stroke 统一 1.5px、尺寸 16/20/24 token 化、禁 filled/outline 同层级混用 |
| D6 | **AI 等待感全谱引入** | taste v1 §9 五套微动效全部评估落地：shimmer processing、typewriter 轮播、呼吸指示+overshoot 通知、layoutId 列表重排、横向流。流式语义豁免区，不违反 D3 |
| ~~D7~~ **D7'** | **中性冷 zinc（hue 286）** | 2026-07-03 晚 owner 看到实际暖米观感后推翻 D7：暖褐与玻璃通透语言相抵触（「追求的是玻璃质感」）。全局 ink/壳/dark/darwin 玻璃板换 zinc 族；sage accent 与 sand 可选主题不动。参考基准：冷净白侧栏截图（zinc Canvas White + Charcoal Ink） |
| D8 | **copy lint 做可机械化的那半** | check-copy.mjs 上线（pressure-word / ascii-ellipsis）；同意图同措辞、AI 腔清单留人工 review |

**产品级附赠**（超 UI，存档）：research/laziness 的反截断体系 —— skill description 具体度决定 68%→90% 触发率、`[PAUSED - X of Y]` 续写协议、EmotionPrompt 量化数据，可用于 maka 自身的 agent prompt 设计。

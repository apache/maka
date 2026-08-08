---
name: 主题工厂
description: 需要为演示、网站、文档或品牌定一套统一视觉风格时使用。用户会说"给我配一套配色和字体""定一个专业/科技/温暖的主题""生成设计 token""这个页面颜色太乱帮我统一"。
category: 设计与UI
allowed-tools:
  - Read
  - Write
  - Bash
---

# 主题工厂

## 目标

把一个模糊的调性需求（"专业""有活力""科技感""温暖治愈"）翻译成一套**完整、自洽、可直接落地**的设计 token：配色 palette、字体栈、间距/圆角/阴影/动效尺度。产物是一份 CSS variables 文件加一页套用示例，用户复制即用，不需要再做二次调色。

一套合格的主题必须满足三条：**语义完整**（每种前景/背景/边框/状态都有明确色值）、**对比达标**（正文与背景 WCAG AA ≥ 4.5:1）、**尺度成系统**（间距与字号按比例递进，不是随手拍的数字）。

## 工作流步骤

### 第 1 步：澄清定位（不清楚就先问）

在动手前明确四件事，任何一项缺失都会导致主题跑偏：

- **用途**：演示 slide / 落地页 / 文档 / dashboard / 移动端 —— 决定字号基准与信息密度
- **行业与受众**：金融法务偏克制，消费科技偏鲜明，儿童教育偏高饱和
- **调性关键词**：让用户给 2–3 个形容词（如"沉稳、可信、现代"）
- **明暗模式**：只做亮色，还是亮/暗双供

如果用户已给品牌主色（hex 或图片），以它为锚点推导整套；没有则由调性生成。

### 第 2 步：定主色与色相策略

先定 1 个 **primary**（品牌/行动色），再决定色相关系：

- **单色 monochromatic**：primary 一个色相走明度梯度 —— 最安全，适合工具类
- **邻近 analogous**：primary 与相邻 ±30° 色相搭配 —— 自然和谐
- **互补 complementary**：primary 与对向色相点缀 —— 活力、强调
- **中性打底 + 强调色**：大面积灰阶，primary 只用于关键动作 —— 最耐看，推荐给专业场景

调性到色相的经验映射（仅作起点，非硬规则）：

| 调性 | 建议色相区间 | 饱和度取向 |
|------|------------|-----------|
| 专业 / 可信 | 蓝 210–230 | 中低 |
| 科技 / 未来 | 靛蓝紫 250–275 | 中高 |
| 自然 / 健康 | 绿 140–160 | 中 |
| 温暖 / 亲和 | 橙红 20–40 | 中高 |
| 奢华 / 高级 | 深墨 + 金 40–50 | 低背景高点缀 |

### 第 3 步：生成色板梯度

每个关键色相生成 50→900 的明度梯度（50 最浅、900 最深），共 10 档。中性灰单独一条梯度用于文字、边框、背景。语义色（success/warning/danger/info）各给一个主值加浅背景值。

生成后**必须验证对比**：正文文字色 vs 页面背景色、按钮文字 vs 按钮背景，都要 ≥ 4.5:1（大字号标题可放宽到 3:1）。见第 4 步的校验脚本。

### 第 4 步：定字体与尺度系统

**字体栈**（务必带完整 fallback，中文场景包含中文字体）：

```
--font-sans: "Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
--font-serif: "Source Serif 4", "Songti SC", Georgia, serif;
--font-mono: "JetBrains Mono", "SF Mono", Menlo, monospace;
```

**字号尺度**用 modular scale（比例递增，别用等差）。推荐 1.25（Major Third）：13 → 16 → 20 → 25 → 31 → 39 → 49px。

**间距尺度**用 4px 基准的 8 档：4 / 8 / 12 / 16 / 24 / 32 / 48 / 64。

**圆角**：sm 4 / md 8 / lg 12 / full 9999。**阴影**：给 sm/md/lg 三档，暗色模式下阴影应更弱并叠加边框。

### 第 5 步：写出 CSS variables 文件

用 Write 输出单个 `theme.css`，`:root` 放亮色，`[data-theme="dark"]` 放暗色覆盖。所有 token 语义化命名（用 `--color-text-primary` 而非 `--gray-800`），组件层只引用语义变量。

### 第 6 步：产出套用示例并预览

再 Write 一个 `theme-preview.html`，`<link>` 或内联引入 theme.css，展示按钮/卡片/表单/标题层级/状态标签，让用户一眼看全套效果。用 Bash 打开或截图预览（见输出格式）。

## 规范 / 质量清单

- [ ] primary/中性/语义色齐全，无"临时借用"的裸 hex
- [ ] 正文对比 ≥ 4.5:1，大标题 ≥ 3:1，已用脚本验证
- [ ] 亮/暗两套都定义（若用户要双模式）
- [ ] 字体栈含 fallback 与中文字体
- [ ] 字号走 modular scale，间距走 4px 基准，无孤立魔数
- [ ] token 语义命名，组件不直接引原始色阶
- [ ] 阴影在暗色下减弱并配边框
- [ ] 预览页覆盖按钮/卡片/表单/状态四类组件

对比度校验脚本（无依赖，Bash 直接跑）：

```bash
python3 - <<'PY'
def lum(hex):
    r,g,b=(int(hex[i:i+2],16)/255 for i in (1,3,5))
    f=lambda c:c/12.92 if c<=.03928 else ((c+.055)/1.055)**2.4
    return .2126*f(r)+.7152*f(g)+.0722*f(b)
def ratio(a,b):
    l1,l2=sorted([lum(a),lum(b)],reverse=True)
    return round((l1+.05)/(l2+.05),2)
# 依次填入 (前景, 背景) 逐对校验
for fg,bg in [("#1a1a2e","#ffffff"),("#ffffff","#4f46e5")]:
    r=ratio(fg,bg)
    print(f"{fg} on {bg}: {r}  {'PASS' if r>=4.5 else 'FAIL(<4.5)'}")
PY
```

## 输出格式

产物固定两个文件，写在用户指定目录或当前目录：

1. `theme.css` —— 完整 token，结构示意：

```css
:root {
  /* Brand */
  --color-primary:      #4f46e5;
  --color-primary-hover:#4338ca;
  --color-primary-soft: #eef2ff;
  /* Text */
  --color-text-primary:   #1a1a2e;
  --color-text-secondary: #4b5563;
  --color-text-muted:     #9ca3af;
  /* Surface */
  --color-bg:      #ffffff;
  --color-surface: #f9fafb;
  --color-border:  #e5e7eb;
  /* Status */
  --color-success:#16a34a; --color-success-soft:#dcfce7;
  --color-warning:#d97706; --color-warning-soft:#fef3c7;
  --color-danger: #dc2626; --color-danger-soft:#fee2e2;
  /* Type */
  --font-sans:"Inter","PingFang SC",system-ui,sans-serif;
  --text-xs:13px; --text-sm:16px; --text-base:20px;
  --text-lg:25px; --text-xl:31px; --text-2xl:39px;
  /* Space */
  --space-1:4px; --space-2:8px; --space-3:12px; --space-4:16px;
  --space-6:24px; --space-8:32px; --space-12:48px;
  /* Radius & Shadow */
  --radius-sm:4px; --radius-md:8px; --radius-lg:12px;
  --shadow-sm:0 1px 2px rgba(0,0,0,.06);
  --shadow-md:0 4px 12px rgba(0,0,0,.10);
}
[data-theme="dark"]{
  --color-bg:#0f0f1a; --color-surface:#1a1a2e;
  --color-text-primary:#f1f5f9; --color-border:#2a2a3e;
  --shadow-md:0 4px 12px rgba(0,0,0,.5);
}
```

2. `theme-preview.html` —— 引入上面变量的示例页。

预览命令：

```bash
# macOS 直接打开
open theme-preview.html
# 或 headless 截图（若装了 Chrome）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --screenshot=theme-preview.png --window-size=1200,900 \
  --hide-scrollbars theme-preview.html
```

最后向用户交付时，用文字概述：主题名、色相策略、primary 色值、对比校验结论，并附两个文件路径。

## 边界

- 只产出 token 与静态预览，不改动用户现有代码库的组件实现；如需套用到具体项目，说明"把 theme.css 引入后将裸色值替换为语义变量"，由用户或后续任务执行。
- 不生成字体文件本身，只给字体栈；商用字体的授权由用户负责。
- 不臆造品牌色 —— 用户给了就用，没给就基于调性生成并说明这是"推导值，可调"。
- 单个主题一次交付；多主题需求逐个产出，不在一个文件里堆叠多套。

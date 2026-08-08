---
name: 信息图生成
description: 需要把长文、报告或一组数据转成好看的单页信息图时使用。用户会说"把这篇文章做成信息图""这份数据可视化一下""生成一张 Notion 风格的图文卡片""做个可以发朋友圈/导出 PDF 的总结图"。
category: 设计与UI
allowed-tools:
  - Read
  - Write
  - Bash
---

# 信息图生成

## 目标

把一篇长文或一组数据，重构成一张 **Notion 风格的单文件 HTML 信息图**：卡片分区、图标点缀、层次分明、留白充足，可在浏览器直接看、可打印导出 PDF、可截图分享。核心是**信息重构而非排版搬运** —— 先提炼要点、建立层级，再用卡片承载，让读者三秒抓到主旨、逐卡深入。

Notion 风格的要义：柔和中性底色、克制的强调色、圆角卡片、清晰的标题层级、图标作视觉锚点、大量留白。不堆装饰、不用重阴影、不做花哨渐变。

## 工作流步骤

### 第 1 步：读懂并提炼内容

先通读原文/数据，产出结构化提纲：

- **一句话主旨**：整张图的核心，放最顶部当大标题
- **3–7 个分区**：每区一个核心概念，配一句概括
- **每区要点**：3–5 条，动词开头、短句、去水分
- **关键数据**：能提炼成数字的单独拎出来做"数据卡"（大数字 + 标签）

信息过载是信息图头号杀手 —— 宁可砍掉次要内容，也要保证每张卡呼吸感充足。

### 第 2 步：规划版面与分区类型

按内容性质给每个分区选卡片型：

| 内容 | 卡片型 |
|------|--------|
| 并列要点 | 图标列表卡（每条一个图标 + 文字） |
| 关键指标 | 数据卡（超大数字 + 单位 + 说明） |
| 步骤流程 | 步骤卡（序号圆标 + 箭头递进） |
| 对比 | 双列对比卡（左右分栏） |
| 引述/结论 | 强调卡（左侧色条 + 大字） |

顶部放标题区（主旨 + 副标题 + 可选日期/来源），中部按逻辑排分区卡，底部放小结或署名。

### 第 3 步：定视觉规格

- **底色**：页面 `#f7f6f3`（Notion 米白），卡片 `#ffffff`
- **文字**：主 `#37352f`、次 `#787774`
- **强调色**：选一个主色（如靛蓝 `#4f46e5` 或暖橙 `#d9730d`），仅用于图标、色条、数字，面积小
- **圆角** 12–16px，**阴影**极浅 `0 1px 3px rgba(0,0,0,.06)`
- **字体**：`-apple-system,"PingFang SC","Microsoft YaHei",sans-serif`
- **图标**：用 emoji 或内联 SVG（单文件自包含，不外链图标库）
- **栅格**：容器 max-width 720–840px 居中，卡片间距 16–24px

### 第 4 步：写单文件 HTML

用 Write 输出一个自包含 `.html`：所有 CSS 内联在 `<style>`，图标用 emoji 或内联 SVG，**不引用任何外部资源**（无 CDN、无外链字体/图片），确保离线可看、导 PDF 不缺样式。加 `@media print` 规则保证打印/导 PDF 时分页合理、去掉多余阴影。

### 第 5 步：预览与导出 PDF

用 Bash 打开预览，或用 headless Chrome 直接导出 PDF（见输出格式）。检查：无横向滚动、卡片不被截断、打印分页干净。

## 规范 / 质量清单

- [ ] 顶部一句话主旨，读者三秒抓住重点
- [ ] 每张卡只讲一个概念，要点 ≤ 5 条
- [ ] 留白充足，无信息过载、无拥挤
- [ ] 强调色面积克制（图标/数字/色条，不铺满）
- [ ] 标题层级清晰（主旨 > 分区标题 > 要点）
- [ ] 图标语义相关，不是随意贴装饰
- [ ] 单文件自包含，无任何外部资源引用
- [ ] 有 `@media print`，A4 打印/导 PDF 分页正常
- [ ] 容器居中限宽，移动端无横向滚动
- [ ] 数据卡数字醒目，标签说明到位

## 输出格式

产物是一个 HTML 文件，写在用户指定或当前目录。结构骨架：

```html
<div class="page">
  <header class="hero">
    <div class="eyebrow">📊 年度总结</div>
    <h1>一句话主旨放这里</h1>
    <p class="sub">副标题 / 来源 / 日期</p>
  </header>

  <section class="card list-card">
    <h2>🎯 分区标题</h2>
    <ul>
      <li><span class="ico">✅</span> 要点一，动词开头</li>
      <li><span class="ico">✅</span> 要点二</li>
    </ul>
  </section>

  <section class="stats">
    <div class="stat"><b>87%</b><span>用户留存</span></div>
    <div class="stat"><b>3.2x</b><span>效率提升</span></div>
  </section>

  <section class="card quote-card">
    <blockquote>关键结论用强调卡承载</blockquote>
  </section>

  <footer class="foot">由 maka 生成 · 2026</footer>
</div>
```

配套 CSS 要点（内联）：

```css
body{margin:0;background:#f7f6f3;font-family:-apple-system,"PingFang SC",sans-serif;color:#37352f}
.page{max-width:800px;margin:0 auto;padding:48px 24px}
.hero h1{font-size:32px;line-height:1.3;margin:8px 0}
.card{background:#fff;border-radius:14px;padding:24px 28px;margin:16px 0;
      box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card h2{font-size:20px;margin:0 0 12px}
.card li{list-style:none;display:flex;gap:10px;padding:6px 0;line-height:1.6}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin:16px 0}
.stat b{display:block;font-size:36px;color:#4f46e5}
.stat span{color:#787774;font-size:14px}
.quote-card{border-left:4px solid #4f46e5}
@media print{body{background:#fff}.card{box-shadow:none;border:1px solid #eee}
  .page{padding:0}section{break-inside:avoid}}
```

导出与预览命令：

```bash
# 打开预览
open infographic.html
# headless Chrome 导出 PDF（自动分页）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --print-to-pdf=infographic.pdf --no-pdf-header-footer \
  infographic.html
# 导出整图 PNG（长图，适合分享）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --screenshot=infographic.png --window-size=840,2000 \
  --hide-scrollbars infographic.html
```

交付说明：主旨、分区数量与卡片类型、强调色、HTML 路径，以及导 PDF/PNG 的命令。

## 边界

- 忠于原文事实，只做提炼与重组，不新增原文没有的数据或观点；数字必须来自原始材料。
- 一个主题一张信息图；内容确实过多时拆成系列（每张聚焦一个分区），不硬塞进一页。
- 版权：不搬运原文整段长文，做的是要点摘要式重构。
- 不外链任何资源（CDN/字体/图片/图标库），保证离线与导出可靠；需要图标用 emoji 或内联 SVG。
- 只产出信息图本身，不负责发布到社交平台；发布由用户操作。

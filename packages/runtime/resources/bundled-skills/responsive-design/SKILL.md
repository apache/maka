---
name: 响应式设计
description: 需要让页面在手机/平板/桌面都好用时使用。用户会说"这个页面适配一下手机""做成响应式的""移动端布局乱了""加断点""触控按钮太小""字体在小屏太大/太小"。
category: 设计与UI
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
---

# 响应式设计

## 目标

用 **mobile-first** 策略产出在手机、平板、桌面上都自洽的自适应布局：基础样式面向最小屏，用 `min-width` 断点逐级增强；排版用 `clamp()` 流体缩放；栅格用 Grid/Flex 自动重排；触控目标 ≥ 44px。核心原则：**内容优先、渐进增强、流式为主断点为辅** —— 尽量让布局自己流动，断点只在真正需要重排时才加。

## 工作流步骤

### 第 1 步：确立 mobile-first 基调

从最窄屏（约 360px）开始写基础样式，默认单列、纵向堆叠。**别写 `max-width` 往下裁**，而是用 `min-width` 往上加。这样小屏拿到的是最精简样式，大屏才加载额外规则。

必备 viewport（HTML 头部，缺了一切响应式失效）：

```html
<meta name="viewport" content="width=device-width, initial-scale=1">
```

### 第 2 步：定断点体系

按内容断点、不按具体设备型号。够用的四档：

| 名称 | min-width | 目标 |
|------|-----------|------|
| 基础 | 0（默认） | 手机竖屏，单列 |
| sm | 640px | 大手机 / 小平板竖屏 |
| md | 768px | 平板，双列 |
| lg | 1024px | 桌面，多列 + 侧栏 |
| xl | 1280px | 宽屏，限制最大宽度 |

```css
/* 基础：手机，默认样式写在这，无媒体查询 */
.grid{display:grid;grid-template-columns:1fr;gap:16px}
@media (min-width:768px){ .grid{grid-template-columns:repeat(2,1fr)} }
@media (min-width:1024px){ .grid{grid-template-columns:repeat(3,1fr);gap:24px} }
```

### 第 3 步：优先流式，少用断点

能自动流动的场景别写断点：

**自适应栅格**（卡片自己换行，多数情况不需要任何媒体查询）：

```css
.cards{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(260px,1fr));
  gap:24px;
}
```

**流体排版**用 `clamp(最小, 视口相对值, 最大)`，字号随屏平滑缩放，免去逐档调字号：

```css
h1{font-size:clamp(1.75rem, 4vw + 1rem, 3rem)}
p {font-size:clamp(1rem, 1vw + .9rem, 1.125rem)}
.section{padding:clamp(24px, 5vw, 80px)}
```

**弹性间距/宽度**：容器用 `width:min(100% - 32px, 1200px);margin-inline:auto` 一行搞定"限宽 + 两侧留白 + 居中"。

### 第 4 步：保证触控友好

- 所有可点元素（按钮、链接、图标按钮、表单控件）**最小 44×44px** 命中区，不够就加 padding 撑开
- 触控目标间距 ≥ 8px，避免误触
- 表单输入框 `font-size:16px` 起（iOS Safari 小于 16px 会自动放大页面）
- hover 效果要有非 hover 的等价触发（触屏无 hover）；用 `@media (hover:hover)` 包裹纯装饰性 hover
- 关键操作放拇指易达区（屏幕下半部）

```css
.btn{min-height:44px;min-width:44px;padding:12px 20px}
@media (hover:hover){ .btn:hover{background:var(--hover)} }
```

### 第 5 步：媒体与内容自适应

- 图片一律 `max-width:100%;height:auto`，绝不溢出
- 用 `<picture>` 或 `srcset` 按屏给不同分辨率图（省流量）
- 表格在窄屏用横向滚动容器包裹：`<div style="overflow-x:auto">`，别让它撑破视口
- 长内容/代码块同理包 `overflow-x:auto`，**页面 body 永远不横向滚动**

### 第 6 步：多断点实测

用 Bash 起本地服务，headless Chrome 按多个宽度截图核对（见输出格式）。逐一检查：无横向滚动、断点切换不错位、触控目标够大、字号在极端屏宽仍可读。

## 规范 / 质量清单（常见适配陷阱）

- [ ] 有 viewport meta，`initial-scale=1`
- [ ] mobile-first：基础样式无媒体查询，用 `min-width` 增强
- [ ] 能流式的用 `auto-fit`/`clamp()`，没滥用断点
- [ ] 触控目标 ≥ 44px，间距 ≥ 8px
- [ ] 表单输入 `font-size ≥ 16px`（防 iOS 缩放）
- [ ] 图片 `max-width:100%`，不溢出
- [ ] 宽表格/代码块包 `overflow-x:auto`，body 无横向滚动
- [ ] hover 效果有触屏等价，或 `@media (hover:hover)` 隔离
- [ ] 断点按内容定，非按设备型号硬编码
- [ ] 固定定位元素（顶栏/悬浮按钮）在小屏不遮挡内容
- [ ] 用 `min()`/`max()`/`clamp()` 减少魔数断点
- [ ] 极窄屏（360px）与超宽屏（1440px+）都实测过

## 输出格式

改造已有页面用 Edit 定点修改；新建用 Write 出单文件。推荐一段可复用的响应式基座：

```css
:root{ --gap:clamp(16px,3vw,24px); --pad:clamp(16px,5vw,64px) }
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"PingFang SC",sans-serif}
.container{width:min(100% - 32px, 1200px);margin-inline:auto}
.grid{display:grid;gap:var(--gap);
      grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
h1{font-size:clamp(1.75rem,4vw + 1rem,3rem);line-height:1.2}
img{max-width:100%;height:auto;display:block}
.btn{min-height:44px;padding:12px 20px;font-size:16px}
.scroll-x{overflow-x:auto}          /* 包裹宽表格/代码 */
@media (hover:hover){ .btn:hover{opacity:.9} }
```

多宽度截图实测：

```bash
# 起本地服务（若是纯静态文件）
python3 -m http.server 8080 &
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
for w in 375 768 1024 1440; do
  "$CH" --headless --hide-scrollbars \
    --window-size=${w},900 \
    --screenshot=shot-${w}.png \
    "http://localhost:8080/index.html"
done
# 逐张核对：横向滚动 / 断点错位 / 触控尺寸 / 字号
```

交付说明：断点策略、哪些区块走流式哪些用断点、触控与防溢出处理、各宽度截图路径。

## 边界

- 聚焦布局与适配的 CSS/HTML，不重写业务逻辑或后端；改造现有页面时最小化改动，优先 Edit 局部而非整页重写。
- 不追求"像素级还原每台设备"——目标是各尺寸下可用、可读、不破版，而非逐机型定制。
- 不引入重型 CSS 框架来解决响应式；优先原生 Grid/Flex/clamp，除非用户已在用某框架。
- 截图实测依赖本地 Chrome，缺失时说明并给出手动在浏览器缩放核对的替代方案。
- 单文件自包含，不外链 CDN 资源。

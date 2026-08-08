---
name: 小红书封面卡片
description: 用单文件 HTML/CSS 制作 3:4 小红书封面与信息图卡片系列，强钩子标题、高对比配色、emoji 点缀、统一模板，再用 headless Chrome 截成 PNG
category: 内容创作
allowed-tools:
  - Read
  - Write
  - Bash
---

# 小红书封面卡片

## 目标

为小红书（或其他图文社媒）制作一个**系列化的封面 + 信息图卡片**：3:4 竖版、强钩子标题、高对比配色、emoji 点缀、统一视觉模板，最终导出为可直接上传的 PNG。

**关键约束：maka 本地环境没有图像生成模型。** 因此本 skill 不"生成图片"，而是用**单文件 HTML/CSS 精确排版**做出卡片，再用 **headless Chrome 截图**导出像素级可控的 PNG。这种方式的好处是：文字绝不糊、排版可复现、系列风格易统一、改文案只需改 HTML。

## 工作流

### 第 1 步：明确选题、系列结构与调性

先和用户收敛：

- **选题与受众**：讲什么、给谁看（决定语气与配色，如干货知识 vs 生活治愈 vs 测评）。
- **系列结构**：通常 1 张**封面**（强钩子）+ 3–6 张**内容卡**（每张一个要点）。先列出每张卡的标题与核心信息。
- **视觉调性**：从模板里选一种基调——治愈暖色、清爽极简、专业深色、活力撞色。确定主色 + 辅色 + 强调色。
- **封面钩子**：小红书的命门是封面标题。要用**数字、悬念、痛点、结果承诺**制造点击欲，如"90% 的人都做错了"、"3 步搞定 XX"、"我后悔没早知道"。

### 第 2 步：用单文件 HTML/CSS 排版

每张卡是一个独立 HTML 文件（或一个文件内多个 `.card`），**尺寸固定 3:4**。小红书推荐 1242×1656（即 3:4），也可用 1080×1440。下面是一个**可直接用的模板**，内联所有样式、自包含、无外部依赖：

```html
<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { display: flex; }
  .card {
    width: 1242px; height: 1656px;   /* 3:4，截图时按此裁 */
    padding: 110px 96px;
    display: flex; flex-direction: column;
    /* 高对比背景：柔和渐变，别用纯白 */
    background: linear-gradient(160deg, #FFF4E6 0%, #FFE3C4 100%);
    font-family: "PingFang SC", "Noto Sans SC", sans-serif;
    color: #2B2118;
  }
  .tag {
    align-self: flex-start;
    background: #FF6B35; color: #fff;
    font-size: 34px; font-weight: 700;
    padding: 14px 30px; border-radius: 999px;
    margin-bottom: 48px;
  }
  .title {
    font-size: 116px; font-weight: 900; line-height: 1.18;
    letter-spacing: -1px;
  }
  .title .hl { color: #FF6B35; }        /* 关键词高亮 */
  .sub { font-size: 46px; margin-top: 40px; color: #6B5B4D; line-height: 1.5; }
  .points { margin-top: auto; display: flex; flex-direction: column; gap: 40px; }
  .point { display: flex; gap: 26px; align-items: flex-start; font-size: 48px; line-height: 1.4; }
  .point .emoji { font-size: 56px; }
  .footer { margin-top: 56px; font-size: 36px; color: #A08B78; }
</style>
</head>
<body>
  <div class="card">
    <div class="tag">🔥 干货收藏</div>
    <div class="title">90% 的人<br>都用错了<span class="hl">这 3 招</span></div>
    <div class="sub">看完这篇，少走两年弯路 ✨</div>
    <div class="points">
      <div class="point"><span class="emoji">✅</span><span>第一招：把大目标拆成每天能做完的小步</span></div>
      <div class="point"><span class="emoji">✅</span><span>第二招：给每件事设一个明确的完成标准</span></div>
      <div class="point"><span class="emoji">✅</span><span>第三招：每晚 5 分钟复盘，只问"明天先做啥"</span></div>
    </div>
    <div class="footer">@你的账号名 · 记得点赞收藏 💛</div>
  </div>
</body>
</html>
```

排版要点：

- **强对比**：背景别用纯白；标题字重拉满（800–900），关键词用强调色高亮。手机小图上要一眼看清。
- **字号够大**：封面标题 90–130px 级别，内容 44–56px。缩略图里也读得清才算合格。
- **统一模板**：系列内所有卡共用同一套 tag / 标题 / footer 结构与配色，只换文案，保证一眼看出"是一个系列"。
- **emoji 点缀而非堆砌**：用来分点、标情绪、加节奏，别铺满。
- **留白与呼吸**：`padding` 给足，元素之间用 `gap`；内容卡用 `margin-top: auto` 把要点推到下半区，重心稳。
- **多卡批量**：可为每张卡写一个文件（`cover.html`、`card-1.html`…），或一个文件多个 `.card` 分别截。

### 第 3 步：用 headless Chrome 截图导出 PNG

用 Bash 调用无头 Chrome，按卡片尺寸截图。先探测可用的 Chrome：

```bash
# macOS 常见路径；也可能是 chromium / google-chrome
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || CHROME="$(command -v chromium || command -v google-chrome-stable || command -v google-chrome)"
[ -x "$CHROME" ] || echo "CHROME_MISSING：请安装 Google Chrome 或 Chromium"

# 按 3:4 窗口精确截图（1242×1656）
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1242,1656 \
  --screenshot="cover.png" \
  "file://$(pwd)/cover.html"
```

对系列里每张卡重复上述命令（改输入 html 与输出 png）。截完用 Bash 确认所有 PNG 已生成并报告路径。若 `--window-size` 与卡片尺寸一致，`.card` 会正好铺满一屏，无多余白边。

### 第 4 步：回看与迭代

看生成的 PNG，检查：**缩略图可读性**（缩到手机列表大小标题还清楚吗）、**系列一致性**（配色/结构/字体统一吗）、**钩子强度**（封面标题够不够抓人）、**排版细节**（有无溢出、截断、贴边、emoji 挤压）。改 HTML 重新截，直到成系列、够抓眼。

## 输出格式

交付物：

1. **系列大纲**：封面钩子 + 每张内容卡的标题与要点。
2. **HTML 文件**：每张卡一个自包含单文件（或一个多卡文件），用 Write 保存。
3. **导出的 PNG**：给出每张的确切路径与截图命令，尺寸 3:4。
4. **发布建议**（可选）：正文文案与话题标签建议。

## 边界

- **不生成图像**：无图像模型；所有视觉均来自 HTML/CSS 排版 + 截图，因此擅长文字型封面与信息图，不适合需要真实照片/插画的卡（那类需用户自备素材，可用 `background-image` 引入本地图）。
- **需要 Chrome/Chromium**：截图依赖本地无头浏览器；缺失时提示用户安装，不擅自安装大型软件前先说明。
- **字体依赖系统**：用系统自带中文字体（PingFang SC / Noto Sans SC）保证可渲染；特殊字体需用户提供并用 `@font-face` 内联本地文件。
- **单文件自包含**：所有 CSS 内联、不引外链 CDN，确保离线可复现、截图稳定。
- **尊重平台规范**：不生成夸大不实、诱导性违规文案；钩子要吸引但不欺骗。
- 文案与要点应源自用户提供的真实内容，本 skill 负责排版与视觉，不杜撰事实性信息。

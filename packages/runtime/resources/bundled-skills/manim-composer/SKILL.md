---
name: Manim 概念动画
description: 把抽象概念（数学、算法、物理）拆成分镜脚本并用 manim 写出场景代码，检测环境后渲染成 3Blue1Brown 风格解说 mp4
category: 内容创作
allowed-tools:
  - Read
  - Write
  - Bash
---

# Manim 概念动画

## 目标

把一个抽象概念（数学定理、算法过程、物理/生物机制）转化成一段 **3Blue1Brown 风格**的解说动画：用连续变形、逐步揭示、几何直觉，让观众获得"a-ha moment"，而不是被公式砸晕。产出是一段可播放的 `mp4`（外加可复用的 manim `.py` 场景文件）。

本 skill 用 [Manim](https://www.manim.community/)（Manim Community 版，`manim` on PyPI）作为渲染引擎——一个用 Python 描述数学动画的库。核心工作是：**先把概念讲清楚的分镜（storyboard），再翻译成 manim 代码，然后渲染、回看、迭代**。动画质量取决于分镜，代码只是执行。

## 工作流

### 第 1 步：拆解概念为分镜脚本

写代码前，先把要讲的东西拆成一个**镜头序列（storyboard）**。每个镜头回答：这一屏观众看到什么、听到（字幕/旁白）什么、上一屏到这一屏靠什么动画过渡。原则：

- **一屏一个想法**：不要在一个画面塞多个新概念。
- **递进揭示**：从具体例子 → 一般规律 → 形式化，而不是一上来就抛定义。
- **锁定 a-ha moment**：明确哪一个镜头是"顿悟点"，把最强的视觉变换留给它（如把求和写成面积、把旋转写成复数乘法）。
- **用变换代替切换**：3B1B 风格的精髓是 `Transform`——同一个对象连续变形，让观众看到"A 是怎么变成 B 的"，而不是硬切。

把分镜整理成一张表（镜头号、画面内容、字幕、过渡动画、时长估计），作为写代码的蓝图。

### 第 2 步：写 manim 场景代码

把每个镜头翻译成一个 `Scene.construct()` 里的动画序列。用 Write 保存为 `.py`。下面是一个**可直接跑的最小示例**，演示 (a+b)² 的几何展开——一个典型的"把代数变成面积"的 a-ha：

```python
# expand.py
from manim import *

class ExpandSquare(Scene):
    def construct(self):
        title = Text("(a + b)² 的几何直觉", font="PingFang SC").scale(0.7).to_edge(UP)
        self.play(Write(title))

        # 用一个大正方形表示 (a+b)²
        a, b = 2.2, 1.3
        big = Square(side_length=a + b, color=BLUE).move_to(ORIGIN)
        self.play(Create(big))
        self.wait(0.5)

        # 切成四块：a², ab, ab, b²
        v = DashedLine(big.get_corner(UL) + RIGHT * a,
                       big.get_corner(DL) + RIGHT * a, color=GREY)
        h = DashedLine(big.get_corner(UL) + DOWN * a,
                       big.get_corner(UR) + DOWN * a, color=GREY)
        self.play(Create(v), Create(h))

        labels = VGroup(
            MathTex("a^2").move_to(big.get_corner(UL) + (RIGHT * a + DOWN * a) / 2),
            MathTex("ab").move_to(big.get_corner(UR) + (LEFT * b + DOWN * a) / 2),
            MathTex("ab").move_to(big.get_corner(DL) + (RIGHT * a + UP * b) / 2),
            MathTex("b^2").move_to(big.get_corner(DR) + (LEFT * b + UP * b) / 2),
        )
        self.play(LaggedStart(*[FadeIn(l) for l in labels], lag_ratio=0.3))
        self.wait(0.5)

        # a-ha：四块面积之和 = 展开式
        formula = MathTex("(a+b)^2", "=", "a^2", "+", "2ab", "+", "b^2")
        formula.scale(0.9).to_edge(DOWN)
        self.play(Write(formula))
        self.wait(2)
```

代码书写建议：

- **中文字幕**用 `Text(..., font="PingFang SC")`（macOS 自带）或 `SimHei`；公式一律用 `MathTex`/`Tex`（LaTeX）。
- **动画节奏**：关键概念后 `self.wait(1~2)` 留给观众消化；连续步骤用 `LaggedStart` 制造依次浮现感。
- **排版**：`to_edge` / `next_to` / `arrange` 管理相对位置，别用魔法坐标堆砌；元素别贴边、别重叠。
- **强调**：用 `Indicate`、`Circumscribe`、颜色高亮引导视线到当前重点。
- **变形优先**：能用 `Transform`/`TransformMatchingTex` 就不要 `FadeOut`+`FadeIn` 硬切。

### 第 3 步：检测环境并渲染

用 Bash 先确认 manim 是否可用。LaTeX 公式还需 TeX 发行版：

```bash
# 检测
manim --version || python3 -c "import manim" 2>/dev/null || echo "MANIM_MISSING"

# 安装（按需，向用户说明后再执行）
pip install manim            # 或 python3 -m pip install manim
# LaTeX（用到 MathTex 时）： brew install --cask mactex-no-gui  或  basictex
```

渲染（先用低质量快速预览，满意后再出高清）：

```bash
# 预览：480p，快
manim -pql expand.py ExpandSquare
# 成片：1080p60
manim -qh expand.py ExpandSquare
```

`-p` 渲染后自动播放，`-q` 后接 `l/m/h/k`（低/中/高/4K）。产物默认在 `media/videos/<file>/<quality>/<Scene>.mp4`。用 Bash 确认文件生成并把路径告诉用户。

### 第 4 步：回看与迭代

渲染后按这些点自检并修正：**时长节奏**（是否太快看不清 / 太慢拖沓）、**排版**（有无重叠、出画、字太小）、**过渡**（是否用变形讲清了"怎么变的"）、**a-ha 是否成立**（顿悟点的视觉冲击够不够）。改代码 → 重渲 → 再看，直到讲清楚为止。

## 输出格式

交付物：

1. **分镜表**（Markdown 或直接写在回复里）：镜头序列 + 每镜的画面/字幕/过渡/时长。
2. **manim 场景 `.py`**：用 Write 保存，注释标出每个镜头对应的代码段，可独立运行。
3. **渲染好的 `mp4`**：给出确切文件路径与渲染命令。
4. **环境说明**：本次是否安装了依赖、用了什么质量档、如何重渲更高清。

## 边界

- **安装前先说明**：`pip install` / `brew install` 会改动环境，执行前向用户讲清将安装什么。
- **LaTeX 依赖较重**：若用户不需要公式，尽量用 `Text` 避免拉起整套 TeX；确需公式且无 TeX 时，明确告知需安装 `mactex`/`basictex`。
- **渲染耗时**：高清/4K 渲染可能很慢，默认先出低质量预览，确认后再出成片。
- **不承诺"和 3B1B 一模一样"**：追求同类直觉表达与风格，不复刻其具体作品或素材。
- **无音频合成**：本 skill 产出画面与字幕；配音/BGM 需用户另行处理，可在分镜里预留旁白文案。
- 分镜没想清楚就不要急着写代码——动画的成败在分镜，不在语法。

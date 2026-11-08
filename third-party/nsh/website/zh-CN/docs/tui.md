---
title: TUI
description: "在终端里运行 Rust 和 TSX 编写的 NSH 应用：Cell 布局、键盘与鼠标输入、终端的颜色、组件和弹出层在字符网格上的样子、在应用代码中识别终端、测试，以及在 ratatui 应用中嵌入 AppView。"
order: 16.5
group: platforms
---

# TUI

NSH 应用也能在终端里运行。终端后端用 [ratatui](https://ratatui.rs) 把应用绘制在终端的字符 Cell 网格上，使用终端自己的
字体和颜色，并从键盘和鼠标接收输入。核心、响应式图、渲染器、组件和原生模块与其他平台完全相同，因此在窗口里运行的应用
同样能在终端里运行：gallery 的演示在这里和在手机上是同一份代码。

终端是一种独立的设备形态，和手机、桌面并列：`idiom()` 为 `Idiom::Terminal`（`nsh_core::platform::Idiom`；TSX 中
`platform.idiom` 为 `"terminal"`），而 `os()`（`platform.os`）是本机自己的系统：macOS、Windows 或 Linux，因此
`fs/promises` 和 `process` 的行为与在该桌面上一致。桌面行为在终端里同样适用：`desktop={{…}}` 属性、`platform.select`
的 `desktop` 键、`platform.desktop`、键盘快捷键、悬停、工具提示和右键菜单。应用菜单（`Menu.setApplicationMenu`）是屏幕顶上一行的
菜单栏，和 mc、htop 的一样：按 F10 或点击标题打开它的菜单，菜单栏收起时菜单项的快捷键照样可用。

## 运行应用

```sh
nsh run App.tsx --target tui        # TSX 应用
nsh run --target tui                # Rust 应用，在它的目录里
```

应用占满启动它的终端，保存时热更新；Rust 应用的根组件运行在用它的 crate 构建的终端开发宿主中，Rust 代码改动后会重新构建
并重启。在源码仓库中，`nsh run` 会先构建开发宿主（`nsh-tui-host`）。

启动时，CLI 显示构建进度，构建开发宿主时还显示正在编译的 crate；`-v` 实时显示工具的输出。应用打开后，终端只显示应用本身。诊断信息（CLI 的输出、宿主的日志、`console.log`）写入应用的 `.nsh/tui.log`，按 `C-h e`（先按
Ctrl+H，再按 E）会在应用上方的面板里打开它们：方向键和 Page Up / Page Down 滚动，`r` 重新加载最新的构建，Escape、`C-g`
或 `q` 关闭面板。应用出错时面板会自动打开，下一次更新时关闭。Ctrl+C 复制选中的文本，没有选中内容时退出；终端会恢复原样。

`--fps` 在右上角显示一行性能信息（帧率、帧耗时、每帧写出的字节数和 Cell 数）；`C-h p` 切换显示。

```sh
nsh run App.tsx --target tui --fps
nsh run App.tsx --target tui --points-per-cell 10x20
```

## Cell

核心照常以 point 为单位布局应用，终端再把 point 换算成 Cell：默认一个 Cell 是 **8 × 16 points**。在 `nsh.json` 中设置
其他尺寸，或在一次运行中用 `--points-per-cell` 指定，后者优先：

```json
{ "tui": { "pointsPerCell": "10x20" } }
```

在终端里，核心使用一套为字符网格设计的布局算法，与终端应用自己的布局方式一致：每个 frame 都是整数个 Cell，为屏幕按 point
设计的间距变成终端能给出的 Cell。

- **间距。** 行内的 gap 是一列，24 points 起是两列。列中 16 points 及以上的 gap 和 margin 是一个空行。水平 padding 从
  8 points 起是一个 Cell，从 24 points 起是两个；垂直 padding 从 24 points 起是一行。
- **边框。** 卡片（padding 达到 12 points 或以上，或包含两行及以上内容的容器）保留边框，有边框的每一边占一个 Cell，用制表符
  绘制：`─` 和 `│`，设置了圆角的角为 `╭╮╰╯`，否则为直角 `┌┐└┘`，虚线 `╌╎`，点线 `┈┊`。控件（按钮、标签页、文本框）就是它的
  标签行。
- **Flex 与 grid。** `flexDirection`、`flexGrow`、`justifyContent`、`alignItems`、`flexWrap`、grid 模板和跨度都按整数 Cell
  分配。一行空间不足时，先收缩 gap，再让文本换行。
- **文本** 无论字号多大，每行都占一行，使用终端的字体；字重 600 及以上为粗体，斜体、下划线和删除线保留。宽字符（中日韩文字、
  emoji）占两个 Cell，字素簇保持完整。`numberOfLines` 和省略号与其他平台一致，省略号占一个 Cell。
- **布局结果** 以 point 报告：frame、`onLayout`、命中测试、浮层和滚动偏移与其他平台一致。

## 键盘

每个控件都能用键盘到达。Tab 和 Shift+Tab 按文档顺序访问可按下和可编辑的视图，与桌面一致；方向键移到该方向上最近的控件，
需要时滚动过去。键盘滚动到视野内的控件会在滚动视图中居中。对话框或 Sheet 带着遮罩打开时，Tab 只在它里面移动，关闭后焦点
回到打开前的控件。Tab 总是移到下一个控件：在 `DataTable` 里它离开表格，列之间用方向键移动。点击会把焦点交给所点的控件
或包着它的控件，Tab 从那里继续。

| 按键 | 作用 |
|---|---|
| Tab、Ctrl+N / Shift+Tab、Ctrl+P | 下一个 / 上一个控件，到头后回绕 |
| Down / Up | 下方 / 上方最近的控件，需要时滚动过去 |
| Right、Ctrl+F / Left、Ctrl+B | 同一行右侧 / 左侧最近的控件 |
| Enter、Space | 按下获得焦点的控件 |
| Escape、Ctrl+G | 离开获得焦点的输入框；否则返回：先是应用的 `onBackPress`，然后是最新的对话框或导航栈 |
| Page Down、Ctrl+V / Page Up、Alt+V | 把焦点所在的滚动视图滚动一页 |
| Home、Alt+< / End、Alt+> | 该滚动视图的第一个 / 最后一个控件 |
| Ctrl+S / Ctrl+R | 向前 / 向后搜索屏幕上的文本 |
| Ctrl+C | 复制选中内容（Ctrl+Shift+C、Cmd+C、Ctrl+Insert 和 Alt+W 也复制）；没有选中内容时退出 |
| Ctrl+A、Cmd+A | 已有选中文本时，选中所在可选择视图的全部文本 |
| F10 | 应用菜单的菜单栏：Left / Right 在标题间移动，Down、Enter 或标题的首字母打开它的菜单，Escape 先关闭菜单，再离开菜单栏 |

应用自己的快捷键（[`keymap`](../modules/nsh.md#keymap)）最先匹配，获得焦点的组件绑定的按键（滑块的方向键、列表的按键）也是
如此，所以组件会先于焦点移动拿到它的按键。支持 kitty 键盘协议的终端会把 Ctrl+I、Ctrl+M 和 Ctrl+[ 与 Tab、Enter 和 Escape
区分开，报告按键重复和松开，并把 Super 作为 Cmd 报告，因此 `cmd+` 快捷键在这些终端里可用；在不支持该协议的 macOS 终端里，
没有绑定接收的 Ctrl 快捷键会再作为 Cmd 匹配一次，菜单和提示（`keymap.label`、`Command`）也把这些快捷键显示为 Ctrl，
即在这里要按的键（`mod+o` 显示为 `⌃O`）。

**搜索。** Ctrl+S 和 Ctrl+R 像 readline 和 Emacs 那样随输入搜索屏幕上的文本。查询显示在最底一行，前面是 `/`（向前）或
`?`（向后），匹配处高亮，焦点移到匹配所属的控件。Ctrl+S / Ctrl+R 跳到下一个 / 上一个匹配，Backspace 或 Ctrl+H 撤回上一个
按键，Enter 在当前匹配处结束搜索，Escape 或 Ctrl+G 把焦点和滚动位置恢复到搜索之前。

**文本框** 支持 readline 的按键，也支持桌面的按键：

| 文本框中的按键 | 作用 |
|---|---|
| Ctrl+A / Ctrl+E、Home / End | 行首 / 行尾 |
| Ctrl+Home / Ctrl+End、Alt+< / Alt+> | 文本开头 / 结尾 |
| Ctrl+F / Ctrl+B、Alt+F / Alt+B | 向前 / 向后一个字符、一个单词 |
| Ctrl+Right / Ctrl+Left、Alt+Right / Alt+Left | 向前 / 向后一个单词，与桌面一致 |
| Ctrl+N / Ctrl+P、Down / Up | 多行输入框中的下一行 / 上一行 |
| Ctrl+K / Ctrl+U、Ctrl+W、Alt+Backspace、Alt+D | 删除到行尾 / 行首、向后删除一个单词、向前删除一个单词 |
| Ctrl+Y | 插入最近删除的文本 |
| Ctrl+T | 交换插入点两侧的字符 |
| Ctrl+D、Delete / Ctrl+H、Backspace | 向前 / 向后删除 |
| Ctrl+Delete / Ctrl+Backspace | 向前 / 向后删除一个单词 |
| Shift 加移动键 | 扩展选区 |
| Ctrl+Shift+A、Cmd+A | 全选 |
| Ctrl+Z / Ctrl+Shift+Z、Cmd+Z / Cmd+Shift+Z | 撤销 / 重做 |
| Ctrl+Shift+C、Cmd+C、Ctrl+Insert、Alt+W | 复制 |
| Ctrl+Shift+X、Cmd+X、Shift+Delete | 剪切 |
| Ctrl+V、Ctrl+Shift+V、Cmd+V、Shift+Insert | 粘贴 |
| Enter | 按 `submitBehavior`：提交、提交并离开，或换行 |
| Shift+Enter、Alt+Enter | 在按 Enter 提交的多行输入框中换行 |
| Escape、Ctrl+G | 离开输入框 |

编辑输入框时，终端光标是插入点处的竖线。输入法在终端模拟器中组字，提交的文本进入输入框；一次粘贴是一次插入。复制的文本
通过终端写入系统剪贴板（OSC 52，终端允许时在 SSH 中同样可用）。

## 鼠标

终端以 Cell 为精度报告鼠标位置，NSH 把每个 Cell 换算成它中心的 point。

- **点击** 按下指针下方的视图；双击和三击在输入框和可选择文本中选中一个单词和一行，之后拖动按单词或行扩展选区。右键打开
  最近的监听了 `onContextMenu` 的视图的右键菜单。
- **滚轮** 滚动指针下方的滚动视图，每格三行（横向六列；按住 Shift 时纵向滚轮变为横向），键盘焦点保持不变。
- **悬停** 逐个 Cell 跟随指针：指针下方的视图及其祖先获得 `hover:` 样式和 `onMouseEnter` / `onMouseMove` /
  `onMouseLeave`，悬停的控件显示在更浅的色带上，指针下方视图的工具提示和悬停卡片随之打开。指针离开终端或终端失去焦点时，
  悬停状态清除。
- **拖动** 逐个 Cell 跟随指针：
  - `Slider`（以及 `ColorSlider`、`ColorArea`）：按下轨道时最近的滑块移到该处，拖动时滑块随指针移动；范围滑块的两个滑块
    不会越过彼此；
  - 滚动条：按下轨道时滑块跳到该处，按住滑块时它跟随指针；
  - `ResizablePanelGroup` 或 `DockArea` 的分隔线调整窗格大小，拖到分组上方的 `DockArea` 标签页会勾勒出它将停靠的位置；
  - 在可选择的视图和输入框中选择文本；Shift+点击扩展选区，Ctrl+C、Ctrl+Shift+C 或 Cmd+C 复制；拖选时指针停在所在滚动视图的
    边缘之外（或终端自身的边缘行上），滚动视图会逐行滚动，越出越远滚得越快；
  - 没有其他视图接管的内容随拖动滚动，应用的手势（`panActivation`、响应者系统）收到每一次移动；指针移出应用时，拖动仍保持
    它的目标。

  拖动不会按下它起始处的视图。

## 颜色与主题

应用用终端自己的主题绘制。启动时，宿主向终端询问它的默认前景色和背景色，应用的浅色或深色模式跟随背景色（终端没有回答时为
深色）。色深来自环境变量：`COLORTERM=truecolor`（或已知支持 24 位色的终端）为真彩色，`TERM` 含 `256color` 为 256 色，其余为
16 种标准色。设置 `NO_COLOR` 时不用颜色绘制：状态以反显、下划线、加粗和删除线表示。`NSH_TUI_COLORS=truecolor`、`256`、`16`
或 `mono` 可直接指定。

应用的颜色按含义读取，所以为屏幕设计的应用在任何终端主题下都清晰可读：

- 饱和的颜色（主按钮、错误、链接）是终端中该色相的强调色：红、黄、绿、青、蓝或品红；
- 中性色是终端的前景色，对比度低的颜色（次要文字、占位符、分隔线）是它的淡化版本；
- 画布、色块和语法高亮保留自己的颜色，按终端的色深显示。

在 256 色及以上且背景色已知的终端里，填充是 **surface**：终端自己的背景色向前景色混合出的若干层次，所以卡片、侧边栏或选中的
行会站在比周围稍亮或稍暗一层的色带上，而页面本身就是终端的背景色，透明度也一并保留。在 16 色终端里，同一个应用布局不变，用线条、粗体、
暗色和反色绘制，小块填充使用标准色：chip 和标签用深灰，主按钮用它自己的颜色；面板和卡片靠留白分隔。

终端用自己的方式显示状态：选中的行和获得焦点的控件是高亮色带加粗体，悬停的控件是更浅的色带，禁用的控件变淡；持有焦点的窗格中
选中的行使用强调色。应用的焦点样式照常叠加生效。

## 组件与弹出层

`nsh/base` 的控件在终端里使用终端自己的形式，每个占一行，保留应用的标签、值和事件：

| 组件 | 在终端中 |
|---|---|
| `Checkbox` | `[✓]`、`[ ]` 或 `[–]`，后接标签 |
| `Radio` | `(●)` 或 `( )`，后接标签 |
| `Switch` | 开为 `[✓]`，关为 `[ ]`，与复选框相同 |
| `Slider` | 一行 `─`，到当前值为止用 `━` 填充，每个滑块一个 `●` |
| `Progress` | 指示色的粗线 `━`，其后为线条色的细线 `─` |
| `Select`、`Combobox`、`DatePicker` | 当前值（`Select` 未选中时是 `placeholder`，或应用的 `trigger`），色带右端是 `▾`，它后面留一个空白 Cell，与文字前的一格对称，有值可清除时它前面是 `×`；标识为 muted 色，聚焦或打开时为强调色；列表在它下方展开。应用自己的 `trigger` 在色带末尾留出三个 Cell 给标识（带 `×` 时六个） |
| `Tabs` | 标签页排成一行，选中的为粗体 |
| `Calendar`、`DatePicker` | 像 `cal` 的月历：日期数字按列右对齐，今天为粗体，选中的日期显示为色带；选择月份和年份的视图在月历宽度内居中 |
| `OtpInput` | 各格排成一行，终端光标位于下一个数字所在格的中间；空格显示暗淡的 `·`，遮盖的数字显示 `●`；有边框、无填充的格是一个线框（`┌───┐`），数字居中，下一个格的边线为强调色 |
| `Pagination` | 上一页、页码、`…` 和下一页作为一行中的词，当前页显示为色带 |
| `MenuItem`、`Submenu` | 标题从行首开始；勾选的菜单项行尾为 `✓`（单选项为 `●`），子菜单的触发项后为 ` ›` |
| `Select`、`Combobox` 的列表 | 标题从行首开始，选中的行行尾为 `✓` |
| `Accordion`、`Collapsible`、`Tree` | 收起为 `▸`，展开为 `▾` |
| `Scrollbar` | 终端自己的滚动条 |
| `TextView` | 终端阅读器式的文档：块之间空一行，标题去掉 `#` 并加粗（h1 下方有横线），引用以 `▎` 开头，代码块是一条带底色的区域、上方标注语言，提示框是一条带图标的着色区域，表格用框线绘制并收窄到视图宽度，任务项为 `☐` / `☑` |

**弹出层**（popover、菜单、选择框的列表、命令面板）在锚点旁打开，四周是圆角线框，第一个 surface 的无障碍标签作为
标题显示在上边框中（`╭─ 标题 ─`）。有 surface 时，它们浮在一层色带上并投下一个 Cell 的阴影；键盘或指针所在的项是一整行
强调色色带。**对话框** 在屏幕中央显示带框的盒子，并淡化其后的内容；焦点留在最新的对话框内，Escape 请求关闭它，关闭后焦点
回到打开它的控件。`AlertDialog` 以同样的方式绘制，按钮排成一行 `Cancel  OK`（16 色时为 `< Cancel >  < OK >`）。

**Toast** 显示在状态行，即屏幕的最后一行，一次一条：最新的 toast 的内容排成一行，新的 toast 会取代上一条。不会层叠，也没有动画；
Escape 关闭状态行上的 toast，它自己的按钮和超时也会关闭它。工具提示共用这一行，没有 toast 时显示在那里。

内容溢出的 **滚动视图** 在内侧边缘显示一个 Cell 宽的滚动条，`│` 加 `┃` 滑块；它填满一个窗格时，滚动条画在窗格的边线上。
**画布** 用盲文点绘制，每个 Cell 横向两点、纵向四点，文字占整格；图表演示和绘图保持各自的形状。**图标按钮**（内容是图标的
按钮）把它的无障碍标签显示为文字，弹出层的触发按钮显示 `▾`。

**可按的标识**（触发按钮的 `▾`、清除的 `×`、步进器的 `−` / `+`）各占一个三 Cell 宽的槽，标识在中间，即 ` ▾ `，按在槽内任意一格
都算按下。槽与槽紧挨着排列（` ×  ▾ `），所以色带末尾的标识后面留一个空白 Cell。标识为 muted 色，在它的控件聚焦或打开时、按下时
以及指针在槽上时变为强调色。自己做这样的标识时，用一个可按的 `View`，宽三个 Cell、高一个 Cell（默认尺寸下为 24 × 16 points），字形居中。`NumberInput` 设了 `controlsRight` 时，
在终端里把步进器并排放，减号在前（` −  + `）。

**媒体元素在布局中保留自己的空间。** 大于图标尺寸的 `Image`、`Video`、`WebView` 或着色器视图保留它的盒子，周围的文本和控件
停在设计安排的位置；终端显示文字和线条，所以这个盒子是空白的 Cell。图标尺寸（48 × 48 points 及以下）的图片、视频、Web
视图、着色器和画布把空间让给周围的内容。有 surface 时，图片角色、背景为某种颜色的视图（色块）显示这种颜色。

## 为终端布局

大多数应用无需改动：桌面行为适用，上面的布局规则会把桌面设计适配到字符网格上。需要为终端单独布局时，用 idiom 判断：

```rust tabs
use nsh_core::{platform::Idiom, prelude::*};

#[component]
pub fn Shell() -> impl IntoElement {
    // 终端使用一列紧凑布局；窗口使用侧边栏。
    view()
        .flex_1()
        .child(if idiom() == Idiom::Terminal { compact_layout() } else { sidebar_layout() })
}

fn compact_layout() -> AnyElement {
    view().flex_1().flex_col().into_element()
}

fn sidebar_layout() -> AnyElement {
    view().flex_1().flex_row().into_element()
}
```

```tsx tabs
import { View, platform } from "nsh";

export function Shell() {
  // 终端使用一列紧凑布局；窗口使用侧边栏。
  return (
    <View class="flex-1">
      {platform.idiom === "terminal" ? <CompactLayout /> : <SidebarLayout />}
    </View>
  );
}

function CompactLayout() {
  return <View class="flex-1 flex-col" />;
}

function SidebarLayout() {
  return <View class="flex-1 flex-row" />;
}
```

在终端中 `platform.desktop` 为 `true`，而 `platform.idiom === "desktop"` 匹配窗口和桌面浏览器，所以用 idiom 判断指针和宽窗口的
代码会让终端走自己的分支。应用为 `nsh/desktop` 自己绘制的窗口装饰（自定义标题栏）在终端里是应用的内容；对
`platform.idiom === "terminal"` 省略它即可。环境报告减少动态效果：导航和布局过渡直接进入最终状态，应用自己的动画照写法运行。
安全区和键盘高度为 0。

## 测试

```sh
nsh test --target tui
```

通过终端开发宿主在内存终端中运行应用的测试，不需要真实终端，可以在 CI 中运行。步骤用终端的输入按下、输入和滚动；
`open(entry, { width, height })` 以 point 设置视口（默认 390 × 844），向上取整为完整 Cell。`app.screenshot("cells.json")`
以 UTF-8 JSON 返回屏幕内容，每个 Cell 一项，包含字符、颜色和修饰符，测试可以逐字节比较渲染结果
（[测试](./testing-and-trace.md#在真实平台上运行)）。

## 运行 bundle

开发宿主也能独立运行构建好的 bundle，或连接你自己启动的开发服务器：

```sh
nsh build my-app --out build
nsh-tui-host --bundle build/bundle.js                       # 在源码仓库中：target/debug/nsh-tui-host
nsh-tui-host --dev-server ws://127.0.0.1:8790/ws
```

| 选项 | 作用 |
|---|---|
| `--points-per-cell <WIDTHxHEIGHT>` | 一个 Cell 的尺寸，单位为 point（默认 `8x16`） |
| `--no-mouse` | 把鼠标留给终端模拟器和它自己的文本选择；键盘照上文工作 |
| `--fps` | 显示性能信息行（`C-h p` 切换） |
| `--log-file <PATH>` | 诊断信息的写入位置（默认是系统临时目录中的一个文件，`C-h e` 可查看） |
| `--data-dir <PATH>` | 应用保存数据的位置 |
| `--trace` | 在日志中加入引擎的耗时 |

bundle 的资源从它旁边的 `assets/` 目录读取。

## 嵌入终端应用

`nsh-platform-tui` crate 为 Rust 编写的 [ratatui](https://ratatui.rs) 应用提供 `AppView`：一个 NSH 引擎，绘制在应用自己
frame 的任意区域中。应用保有自己的终端、事件循环和布局；每个 `AppView` 相互独立，多个可以共用一个屏幕。

```rust
use nsh_platform_tui::{AppOptions, AppView, Input, Root};

let mut options = AppOptions::default();
options.ui_sets = vec![nsh_base::registry(), my_app::registry()];
let mut view = AppView::new(options);
view.load(Root::of::<my_app::App>())?;

// 在应用的绘制中：视图使用传给它的区域。
terminal.draw(|frame| view.render(frame, frame.area()))?;

// 在应用的事件循环中：按键、粘贴和鼠标事件，坐标是终端中的绝对 Cell。
view.handle(input);

// 视图需要时再绘制：`next_frame_deadline()` 是它下一帧的时间。
let due = view.next_frame_deadline();
```

`load` 也接受 `Bundle`（`Bundle::read(path)`，即 `nsh build` 写出的 TSX 应用）。`AppView::set_wake_callback` 让引擎线程通知
应用的循环有一帧要绘制；`set_focused` 给予或收回键盘焦点；`set_appearance` 设置浅色或深色模式；`register_component` 添加应用
自己的原生组件，绘制在它们的 Cell 中。`AppOptions` 设置 Cell 尺寸（`cells`）、终端的颜色与色深（`capabilities`）、限制、
存储、资源和剪贴板。启用 feature `run-app` 后，`run_app(&mut terminal, &mut view, poll)` 是一个现成的循环，适合像开发宿主那样
把整个终端交给一个视图的应用。

## 另见

- [CLI](./cli.md)：`nsh run --target tui`、`nsh test --target tui`
- [平台特定代码](./platform-specific.md)
- [设备与环境](./device-and-environment.md)

---
title: 终端
description: 在终端运行 Native Shell 应用，打包控制台程序，并在 Ratatui 应用中嵌入独立的 NSH 界面。
order: 15.75
group: platforms
---

# 终端

Native Shell 使用 Ratatui 和 Crossterm 在 macOS、Windows、Linux 的终端中绘制应用。终端界面背后仍是同一套
TSX 和 Rust 组件、响应式图、Taffy 弹性与网格布局、虚拟列表、网络功能和沙箱。终端应用可以在自己管理的任意
矩形区域中嵌入独立的 `AppView`。

## 运行应用

```sh
nsh run my-app --target tui
```

宿主使用终端的备用屏幕、键盘、鼠标和括号粘贴模式，并在应用关闭时恢复终端。TSX 修改通过图形平台也使用的
开发服务器送达。Ctrl+Q 关闭应用。发行包将宿主放在 `runtime/tui/`；源码检出中的命令会按需构建 `nsh-tui-host`。

运维控制台示例包含侧栏导航、搜索和状态筛选、服务指标、详情检查器、画布图表、活动时间线和部署对话框。
紧凑的 120×34 布局可同时显示七条完整服务记录、指标和图表；160×50 还会显示检查器和活动时间线。更矮的终端
会收起次要内容，为服务列表保留空间。宽度达到 140 列时，检查器提供 Details、Effects 和 Guide 三个标签页。
Effects 展示本地图片、模糊、混合模式、动画图层、随包提供的 Pacifico 画布字体和弹出菜单；Guide 以可读模式
打开本地 HTML 运行手册：

```sh
nsh run examples/terminal-workbench --target tui
```

宿主也可以直接加载构建好的包：

```sh
nsh build my-app --release -o build
dist/nsh/runtime/tui/nsh-tui-host --bundle build/bundle.nshc --size 120x34
```

`--size` 使用列数和行数。交互会话的视口由终端当前大小决定；脚本则使用指定大小作为初始视口。

## 布局与绘制

NSH 保持以 point 布局。默认情况下，一个终端单元格代表 **8×16 point**，因此 120×40 的终端向 Taffy 提供
960×640 point 的视口。内边距、弹性与网格布局、滚动偏移、图片大小和指针命中测试共用这一坐标系。终端大小
变化会将新视口传给引擎，让应用重新布局。

文本按终端列宽换行：中文和许多 emoji 占两列，组合字符序列保持完整。文本片段保留颜色、粗体、斜体、下划线
和删除线；双向段落按显示顺序排列文本。字体形状与字形大小由终端字体决定。显式行高和字间距会取整为终端的
行与列。

背景、边框和裁剪遵循保留的视图树。变换投影完整的视图子树，指针命中测试跟随变换后的几何形状。后代圆角裁剪、
组透明度、混合模式、有序滤镜和背景滤镜由图形工作线程合成。

交互宿主在启动时探测图像协议和终端单元格的实际像素尺寸。终端提供图像能力时，图片和记录好的画布绘图优先通过
[`ratatui-image`](https://docs.rs/ratatui-image/11.1.0/ratatui_image/) 使用 Kitty、Sixel 或 iTerm2 图像协议。
编码在图形工作线程中完成。彩色半块和四分块字符提供通用绘制路径，也用于保持文字、浮层与图形重叠时的合成效果。
每格选择颜色误差较小的分块方式，但仍然只能显示两种颜色。字形形状和 RGB 颜色到调色板的映射由终端决定。

`NSH_IMAGE_PROTOCOL` 可选 `auto`（默认）、`halfblocks`、`kitty`、`sixel` 或 `iterm2`。`halfblocks` 直接使用
常规文本绘制。选择图像协议时会使用终端报告的像素尺寸。无界面脚本绘制可复现的文本快照。嵌入宿主通过
`AppView::set_image_protocol` 显式选择协议；创建嵌入视图时，终端 IO 由宿主掌控。

现有 [`nsh/base`](../modules/nsh-base.md) 组件通过这些基础元素绘制。为交互行提供至少一个终端行的
高度，使用清晰的颜色对比，并让重要标签在终端列宽内保持可读。

画布路径、渐变、裁剪、变换、合成和图片绘制由工作线程栅格化。画布文本使用当前界面注册字体和系统回退字体
经过塑形的轮廓；`measureText` 与绘制采用相同的塑形和字体选择。注册的 TrueType、OpenType 与字体集合保留在
当前界面内。普通 `Text` 使用终端字体和单元格几何；应用变换或效果的文本组将字体轮廓栅格化，并对齐测量后的
单元格几何。

图片支持 PNG、JPEG、GIF 和 WebP，也支持解码器资源上限内的 GIF、WebP 动画。
`resizeMode` 确定图片大小后，`objectPosition` 设置图片在框内的位置，同时用于字符和像素图像。
`defaultSource` 在加载期间和
加载出错后保持可见。`blurRadius` 由工作线程处理；`fadeDuration` 设置已加载图片在占位图上的淡入时长，终端的
默认值为 0 ms。下载进度最多每 100 ms 送达一次，并在完成时送达最终进度。

页面栈和对话框使用滑动、淡入淡出或即时切换。应用提供页面标题、对话框背景、卡片和关闭控件；对话框占据
完整视口，返回与关闭操作遵循挂载的属性。宿主可通过 `AppOptions::reduce_motion` 或
`AppView::set_reduce_motion` 选择减少动态效果。

## 键盘与鼠标

| 按键 | 操作 |
|---|---|
| Tab、Shift+Tab | 在最新模态界面内聚焦下一个或上一个输入框、可按控件或滚动视图 |
| Enter、Space | 激活聚焦的可按控件 |
| Escape | 离开输入框；其他情况下返回或请求关闭模态界面 |
| 方向键、Page Up / Down、Home / End | 滚动聚焦的滚动视图或其可滚动祖先 |
| Ctrl+滚轮、Ctrl++ / Ctrl+- | 在配置的范围内缩放滚动视图 |
| Ctrl+0 | 重置滚动视图的缩放 |
| F10 | 打开应用菜单 |
| Ctrl+Q | 关闭终端宿主 |
| Ctrl+C | 复制输入框或可选择文本的选区；其他情况下关闭宿主 |

点击可以聚焦或激活控件，并保持内容当前的滚动位置。键盘导航或程序设置焦点时，会将目标控件滚动到可见区域。
新挂载的列表控件会按布局完成后的位置滚入视野；随后显式发出的滚动或缩放命令优先决定对应滚动视图的位置。
鼠标滚轮垂直滚动，Shift+滚轮水平滚动。指针位置从单元格坐标转换为布局使用的同一
虚拟 point 坐标。鼠标中键拖动可平移滚动内容，并按属性提供惯性、回弹和下拉刷新。使用左键拖动滚动条滑块，
或点击轨道翻页。缩放遵循滚动视图的缩放与手势属性；分页、吸附偏移、从右到左布局及滚动动画命令使用同一套
原生滚动状态。

终端会报告指针进入和离开，但目前不会发出连续的 `onHoverMove` 或 `onMouseMove` 回调。
脚本中的 `hover` 步骤只移动指针，不会额外提供这些回调。

输入框支持按字素移动光标和删除、Shift 选择、Ctrl/Alt+方向键按词移动、Home / End、Ctrl+Home / End、全选、
撤销与重做。Ctrl+A/C/X/V 分别全选、复制、剪切和粘贴；Ctrl+Z 与 Ctrl+Shift+Z 或
Ctrl+Y 撤销和重做。安全输入框隐藏内容并保护复制与剪切。终端按键与括号粘贴保留文本原样。输入法通过终端输入
已提交的文本；括号粘贴将文本作为一次编辑输入。Enter 遵循 `submitBehavior`，Shift/Alt+Enter 为多行输入框插入
换行。

交互式独立宿主通过操作系统的剪贴板辅助程序连接复制与粘贴，并以 OSC 52 作为复制的后备路径。嵌入视图和脚本
初始使用界面实例自己的剪贴板；嵌入宿主可通过 `HostServices` 连接自己的剪贴板。NSH 传送完整文本，
由操作系统的辅助程序或终端处理剪贴板的接收。

应用的 [`nsh/keymap`](../modules/nsh-keymap.md) 绑定先于默认处理执行。终端模拟器决定哪些按键和修饰键会传给
应用；请选择目标终端能够转发的快捷键。

可选择文本支持鼠标选择，行内文本链接通过指针命中测试激活。
[`SelectionArea`](../elements/selection-area.md) 让同一个选区跨越文本节点、多行文本和 `TextView` 文档块。
拖动或 Shift+点击可扩展选区；按住指针拖出 Scroll 边缘时会自动滚动。Ctrl+A 选中区域内的全部文字，
Ctrl+C 或 Ctrl+Insert 复制，Escape 清除非空选区。`selectable={false}` 的文字不参与选择，可用于排除标签和
控件文字。复制使用底层文本及其中的换行和 Unicode 内容，经由上述同一套宿主剪贴板与 OSC 52 路径输出。
模态界面或获得焦点的弹出层会暂停已保留的背景选区对键盘的处理；关闭弹出层后，该选区可再次接收复制等操作。
原生提示框和操作表使用 Tab 或方向键选择按钮，Enter 激活按钮。

终端界面可使用 [`nsh/desktop`](../modules/nsh-desktop.md) 提供的标题与菜单。
`platform.isTerminal` 标识这种呈现方式，`platform.idiom === "desktop" && !platform.isTerminal` 则标识图形桌面界面。
F10 打开应用菜单；方向键导航，Enter 或 Space 选择，Escape 关闭。应用菜单和弹出菜单支持子菜单、勾选标记、
禁用项及快捷键。独立宿主通过清理后的 OSC 2 输出更新窗口标题。

## 可读页面与视频

`WebView` 将 HTML 呈现为可读的终端页面，包含标题、段落、列表、预格式文本块和基本表格。内联 HTML 和远程
URI 来源都使用这一模式。URI 导航遵循应用的 `webview` 能力声明，并按授权范围检查重定向。链接带有数字引用：
Tab 选择链接并滚动到可见区域，Enter 跟随链接。Alt+Left 和 Alt+Right 浏览历史；重新加载、停止和滚动命令作用于
阅读器。

`Video` 通过 FFmpeg 播放画面，支持暂停、跳转、播放速率、循环以及加载和进度事件。将 `ffmpeg` 和 `ffprobe` 安装
到可执行文件搜索路径，或通过 `NSH_FFMPEG` 和 `NSH_FFPROBE` 指定路径。嵌入宿主可以为音频输出、浏览器执行或
平台专用的媒体呈现提供原生组件。

## 应用数据

[`nsh/storage`](../modules/nsh-storage.md) 跨启动和开发重载保留字符串值。每个应用的 `nsh.json` `id` 在系统数据
目录下标识自己的 `storage.json` 目录：macOS 使用 Application Support，Windows 使用 `%APPDATA%`，Linux 使用
`$XDG_DATA_HOME`（或 `~/.local/share`）。包和 Rust 根组件携带同一应用标识，两种入口使用同一份数据。发行应用在
`nsh.json` 中声明自己的 `id`。

## 打包

```sh
nsh package my-app --target tui
nsh package my-app --target tui --run
```

控制台运行程序及资源一起分发：

```text
out/<Name>/
  <Name>                 可执行文件；Windows 上为 <Name>.exe
  nsh/bundle.nshc        编译后的 TSX 应用
  nsh/assets/…           导入的资源
  nsh/app.json           应用元数据
  nsh/capabilities.json  配置了能力时的应用能力声明
```

同一目录在 macOS 和 Linux 上归档为 `<Name>.tar.gz`，在 Windows 上归档为 `<Name>.zip`。请在可执行文件将运行的
操作系统上打包，并将 `nsh/` 目录保留在可执行文件旁边。终端运行时使用 Rust 库和操作系统的控制台设施。
`--run` 在当前终端中启动应用，并等待应用关闭。Rust 根应用使用同样的包结构，根组件编译进运行程序。

## 嵌入 Ratatui 应用

`nsh-platform-tui` 提供具有独立引擎、保留界面和输入状态的 `AppView`。宿主管理终端、事件循环及其他 Ratatui
控件。加载包后，轮询提交、推进动画、转发事件，并绘制到分配给界面的区域：

```rust
use nsh_platform_tui::{AppOptions, AppView, Bundle};

let mut view = AppView::new(AppOptions::default());
let code = std::fs::read_to_string("app/bundle.js")?;
view.load(Bundle::source(code).into())?;

// In the host's event loop:
view.poll()?;
view.tick(start.elapsed().as_secs_f64())?;
view.resize(area.width, area.height);
view.render(area, frame.buffer_mut());
```

使用 `view.handle_event(event)` 转发键盘和粘贴事件。转发鼠标事件前，将坐标转换为相对界面区域的位置；仅向
应接收事件的界面转发事件。释放界面或调用 `stop()` 会结束其引擎。

直接驱动 `Surface` 和 `LocalEngine` 的宿主通过 `Surface::handle_event` 将事件交给当前挂载的界面。
界面管理原生指针捕获、选择、焦点和手势。按顺序将它产生的 `SurfaceEvent` 转发给引擎的 `EngineControl`，
应用回调使用 `dispatch_event`，然后调用 `LocalEngine::pump()` 并应用每个挂载批次，再处理下一条物理事件。
在事件或环境更新入队前，通过 `EngineControl::set_focus_path` 发布 `Surface::focus_path()`。
终端输出期间，引擎工作和原生输入继续推进。

`Surface::handle_wheel(mouse, steps)` 将坐标、方向和修饰键相同的连续刻度交给一次实时命中测试选中的目标，
并返回已消费的刻度数。原生组件每次调用最多接收一个刻度，方便宿主在更多输入到来前转发其事件。
宿主输入区域变化时，调用 `Surface::cancel_pointer()` 取消原生捕获并保留键盘焦点，再通过同一引擎控制端
转发由此产生的事件。

`AppOptions::asset_base` 从资源目录或 HTTP 基地址解析 `asset:/` URI。`AppOptions::limits` 配置虚拟机限制；
嵌入默认使用 `Limits::default()`，独立宿主使用 `Limits::standalone()`。`nsh run --target tui --limits` 让 TSX 入口
使用嵌入默认限制，也可以传入各项限制的名称和值。`AppOptions::metrics` 接受验证过的
`CellMetrics`，供宿主选择其他虚拟 point 比例。参见[沙箱与能力](./sandbox-and-capabilities.md)。

`AppOptions::data_dir` 为嵌入应用选择数据目录，例如宿主自身数据目录下的 `nsh/`。加载的各应用按自己的 `id`
使用其中的独立目录。`AppOptions::storage` 连接宿主自己的 `nsh_engine::StorageBackend`，优先于文件存储位置。

通过 `AppView::set_host_services(Some(services))` 连接可选的剪贴板、标题和无障碍播报回调。
`AppView::accessibility_snapshot()` 提供每个无障碍节点的角色、标签、提示、状态、值、区域、焦点和操作；
`Surface::perform_accessibility_action` 将宿主操作传回挂载的应用。安全输入框的值保持受保护。创建嵌入视图时，
终端 IO 和服务集成由宿主管理。

使用[原生组件](./native-components.md)时，实现 `NativeComponent`，并在加载应用前通过
`AppView::register_component(name, factory)` 注册工厂。每个挂载叶子节点都有自己的实例，接收属性和命令，
在裁剪区域内绘制，并可以向 TSX 返回原生事件。宿主可以为地图、浏览器页面、媒体控制等内容提供终端呈现。

### 宿主管理的服务

使用 `AppOptions::ui_sets` 为单个界面提供原生模块。注册表的 `value` 工厂可捕获宿主授予该界面的客户端，
并将 Rust 类实例提供给 TSX：

```rust
use nsh_core::ui::{Instance, Registry};

let mut native = Registry::ui_set("my-app/native");
native.value("service", move || Instance::new(Service::from(client.clone())));
let options = AppOptions {
    ui_sets: Some(vec![native]),
    ..Default::default()
};
```

其中 `Service` 是宿主的 `#[class]` 包装类型。其方法（包括异步方法）自动生成 TypeScript 声明；TSX 通过
`import { service } from "my-app/native"` 使用它。省略类构造函数可将客户端创建保留在宿主侧。
首次导入或通过 [`nativeModule`](../modules/nsh-native.md#nativemodule) 查找模块时，工厂在该虚拟机中运行一次；
两种路径共享同一个值，重载会创建新值。取消、订阅清理及服务操作回执由宿主管理。
`None` 使用进程的默认模块，`Some(vec![])` 则选择空集合。

## 可复现的交互

宿主的 `--script` 在内存中的 Ratatui 缓冲区上运行，并保存 UTF-8 文本快照。步骤用分号或换行分隔：

```sh
nsh-tui-host --bundle build/bundle.nshc --size 120x40 \
  --script "wait 300; shot home.txt; key Tab; type 你好 👋; resize 100 35; wait 300; shot resized.txt; quit"
```

| 步骤 | 操作 |
|---|---|
| `wait <ms>` | 在指定时间内处理提交与动画 |
| `shot <file.txt>` | 保存当前文本缓冲区 |
| `tap <column> <row>` | 点击单元格 |
| `hover <column> <row>` | 将指针移到单元格 |
| `wheel <column> <row> <dx> <dy>` | 在单元格位置按滚轮刻度滚动 |
| `type <text>` | 将 UTF-8 文本粘贴进聚焦输入框 |
| `key <name>` | 发送按键，例如 `Tab`、`Enter`、`Esc`、`Ctrl+a` 或 `Shift+Left` |
| `selectall` | 全选聚焦输入框的文本 |
| `resize <columns> <rows>` | 改变视口并重新布局 |
| `dark`、`light` | 设置界面的外观 |
| `expect <text>` | 断言快照包含文本 |
| `expect-focus` | 断言某个节点具有键盘焦点 |
| `quit` | 停止应用 |

快照保留普通终端文本和布局。栅格化文本与图形以半块字符近似呈现；文本断言应使用效果组之外的标签。颜色和
图形细节可在交互终端中查看。

## 另见

- [CLI](./cli.md)
- [打包](./packaging.md)
- [图片与资源](./images-and-assets.md)
- [Canvas](./canvas.md)
- [平台概览](./platforms.md)

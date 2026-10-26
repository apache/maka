---
title: 性能报告
description: NSH 应用的实测数据：NSH 基线中的提交与帧开销，以及 gallery 在 Linux、macOS、Windows 和 iOS 上逐页的帧率、CPU 和内存，并附复现方法。
order: 62.5
group: tools
---

# 性能报告

NSH 应用的实测开销。NSH 如何保持高速、如何测量你自己的应用，见[性能](./performance.md)。

## 基线

来自 NSH 自己的基线（除特别注明外均为 Apple silicon）：

| 场景 | 数据 |
|---|---|
| 计数器应用，无界面（debug） | 首帧 ~0.5–0.65 ms（58 ops / 49 mount items）；一次点击 ~0.15 ms |
| 计数器应用，Mac Catalyst（release） | 首帧 ~1.05–1.15 ms（其中约 0.7 ms 用于首次用 CoreText 布局 10 段文本）；一次点击 ~0.12 ms |
| Gallery 照片列表，无界面（debug） | 首帧 653 ops / 224 nodes，~2.7 ms |
| 滚动照片列表，Catalyst（release） | 慢速滚动时重新绑定一行 ~0.4 ms；快速甩动时一整屏约 32 行 0.9–1.6 ms |
| 滚动照片列表，Android 模拟器（arm64，release） | 重新绑定一行 ~0.3–0.4 ms（JS ~60 µs） |
| 引擎启动（release） | ~75–155 µs；全局 API（`fetch`、`URL` 等）在首次使用前没有任何开销，首次使用后 ~90 µs |
| 热重载 | 从保存文件到新版本运行 ~120 ms；应用更新 0.2–0.5 ms |

## Linux（GTK 4）

测量环境：Linux 桌面（x86_64，24 线程，NVIDIA GPU），release 构建，gallery 运行在 120 Hz 显示器上一个 1896 × 1030 的窗口里，
所有读数都由 `examples/gallery/tools/perf.py` 自动采集（`nsh test --target linux --fps`，每秒一行；CPU 指整个进程，以单核的百分比计）。
*帧 p95* 是主线程绘制一帧所用时间的第 95 百分位：低于 8.3 ms，一帧就能放进 120 Hz 的一次刷新。

### 动画演示

<div class="data-table">

| 演示 | FPS | 帧 p95 | CPU |
|---|---|---|---|
| Stocks：22 条实时走势线、分时图、盘口、逐笔成交 | 117–120 | 5–6 ms | 25–29%（1200 × 800）、28–32%（1896 × 1030） |
| Stocks，窗口铺满 4K 144 Hz 显示器（1.6 倍缩放） | 143–145 | 4.1–4.4 ms | 26–29% |
| Canvas：仪表盘、时钟、点阵 | 120 | 2.6–4.4 ms | 5–10% |
| Animations：三个原生循环、弹簧、序列 | 120 | 2.0 ms | 12–13% |

</div>

### 每个页面

gallery 的每个页面，分别在刚打开时和测试滚动它时测量，窗口 1200 × 800，显示器 144 Hz（同一台机器）。NSH 只在屏幕上有内容变化时才绘制一帧，
所以这里的 *FPS* 是画面在动时的帧率：按相邻两帧间隔的中位数计算（`perf.py` 的 `moving`）；等于显示器的 144 时，动画或滚动的每一帧都紧接着上一次刷新。
*超过一次刷新* 是耗时超过一次刷新（6.9 ms）的帧所占的比例。Images 页的 GIF 和 WebP 按它们自己的帧率播放（这里约 50 FPS），视频也一样。Physics、Overlays 和 Menus 页面很短：在 1200 × 800 下滚动几帧就到底了，所以它们在 900 × 500 的窗口里测量，那里有足够的内容可以滚动。

<div class="data-table">

| 页面 | 帧的来源 | FPS | 帧 p95 | 超过一次刷新 | CPU |
|---|---|---|---|---|---|
| Stocks | 实时数据、原生循环 | 144 | 4.1 ms | 0% | 26% |
| Stocks，滚动 | 实时数据、滚动 | 144 | 4.1 ms | 0% | 25% |
| Photos，滚动 | 滚动 | 144 | 2.8 ms | 2% | 9% |
| Lists，滚动 | 滚动 | 143 | 1.7 ms | 0% | 7% |
| Scrolling，滚动 | 滚动 | 144 | 1.6 ms | 1% | 4% |
| Navigation，滚动 | 滚动 | 143 | 1.7 ms | 0% | 2% |
| Form，滚动 | 滚动 | 144 | 1.3 ms | 0% | 4% |
| Resizable，滚动 | 滚动 | 143 | 0.6 ms | 0% | 1% |
| Dock，滚动 | 滚动 | 142 | 0.5 ms | 1% | 1% |
| Gestures | 弹簧、脉动的圆环 | 144 | 1.6 ms | 0% | 1–5% |
| Physics，滚动 | 滚动（900 × 500 窗口） | 144 | 1.6 ms | 1% | 1% |
| Animations | 原生循环 | 144 | 2.6 ms | 0–1% | 5% |
| Canvas，滚动 | 滚动、原生循环 | 144 | 4.2 ms | 0% | 1–4% |
| Styles，滚动 | 滚动 | 144 | 2.3 ms | 2% | 3% |
| Tailwind | `animate-*` 工具类 | 144 | 1.7 ms | 0% | 3–8% |
| Text，滚动 | 滚动 | 144 | 1.9 ms | 0% | 4% |
| Text View，滚动 | 滚动 | 141 | 1.8 ms | 2% | 7% |
| Images，滚动 | 滚动、GIF 和 WebP 的帧 | 143 | 2.9 ms | 2% | 8% |
| Components，滚动 | 滚动 | 144 | 1.4 ms | 0% | 3% |
| Overlays，滚动 | 滚动（900 × 500 窗口） | 144 | 1.7 ms | 0% | 2% |
| Menus，滚动 | 滚动（900 × 500 窗口） | 144 | 1.9 ms | 0% | 2% |
| Controls | 过渡动画 | 144 | 0.9 ms | 0% | 1–4% |
| Web and video | 视频帧、网页 | 135–142 | 1.0 ms | 0% | 7–8% |

</div>

### 内存

启动 3 秒后的静止内存（release 运行器，480 × 640 窗口）。*私有内存*是只属于这个进程的内存（USS）；*常驻内存*还包含共享库的页面
（GTK、GPU 驱动），这些页面由机器上所有 GTK 应用共享：

<div class="data-table">

| 应用 | 渲染器 | 私有内存（USS） | 常驻内存（RSS） |
|---|---|---|---|
| Rust 应用（`nsh init --template rust`） | GL（`ngl`） | ~49 MB | ~142 MB |
| Rust 应用 | Cairo（`GSK_RENDERER=cairo`） | ~28 MB | ~95 MB |
| TSX 计数器（`examples/counter`） | GL | ~79 MB | ~166 MB |
| 只有一个 label 的 GTK 4 窗口，作为参照 | Vulkan / Cairo | ~62 / ~40 MB | ~132 / ~109 MB |

</div>

再次访问同一页面不会增加内存；第一次访问某个页面时，进程增长的是它有意保留的缓存（解码后的图片，上限 128 MB）以及首次使用时加载的库（网页视图用的 WebKitGTK）。

### 应用体积

用 `nsh init` 的每种模板生成的 hello world 应用，以及两个实际在用的应用，由 `nsh package --target linux` 为 x86_64 构建。运行器是应用唯一的可执行文件；
压缩包是它发布用的 `.tar.gz`。hello world 都以链接时优化构建并去除符号（`CARGO_PROFILE_RELEASE_LTO=fat`、
`CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1`、`CARGO_PROFILE_RELEASE_STRIP=true`）：

<div class="data-table">

| 应用 | 编写语言 | 运行器 | 压缩包 |
|---|---|---|---|
| Hello world（`--template rust`） | Rust | 16.5 MB | 7.5 MB |
| Hello world（`--template ts`） | TSX，运行在 QuickJS 上 | 25.7 MB | 11.6 MB |
| Hello world（`--template mixed`） | TSX 加一个 Rust crate | 25.8 MB | 11.7 MB |
| [sysmon](https://github.com/huacnlee/sysmon) 0.1.3 | Rust | 20.9 MB（去除符号后） | 9.7 MB |
| [Omasend](https://github.com/huacnlee/omasend) 0.2.0 | Rust | 22.3 MB | 9.8 MB |

</div>

TSX 运行器包含 QuickJS 运行时、原生模块和渲染器；应用自己的代码是运行器旁边的 bundle，hello world 的不到 1 KB。

这些数字来自：

- **渲染器**：在 NVIDIA 驱动下，NSH 使用 GSK 的 GL 渲染器绘制，在那里它每帧的开销只是 Vulkan 渲染器的一小部分（Animations 演示：每帧绘制 ~1 ms，Vulkan 下约 9.5 ms）。仍可用 `GSK_RENDERER` 指定渲染器。
- **Canvas 栅格**：每个 canvas 只栅格化一次，分成保存在 GPU 上的 256 px 图块。动画值变化时，只重绘读取它的操作覆盖的区域，并叠加在绘制中静态部分保留下来的像素上；看不见的 canvas 会等到滚入视野再绘制。
- **路径只暂存一次**：长路径之后的 `fillRect` 和 `fillText` 会把路径留在原处，直到再次用到它（一条 400 点的折线加 240 根柱子：0.63 ms）。

## macOS（AppKit）

测量环境：MacBook Pro（Apple M3，24 GB）的内置 120 Hz ProMotion 显示屏，release 构建，gallery 运行在 1200 × 800 的窗口里，
所有读数都由 `examples/gallery/tools/perf.py` 自动采集（`nsh test --target macos --fps`，每秒一行；CPU 指整个进程，以单核的百分比计，
GPU 是它占用 GPU 的比例）。阶段是主线程每帧的开销：*tick*（display link 上的原生动画）和 *canvas*（重放绘制）。

### 动画演示

<div class="data-table">

| 演示 | FPS | 帧 p95 | CPU | GPU |
|---|---|---|---|---|
| Stocks：22 条实时走势线、分时图、盘口、逐笔成交 | 120 | 2.7–3.7 ms | 33–36% | 18–22% |
| Canvas：仪表盘、时钟、点阵 | 119–120 | 0.6–0.7 ms | 4–7% | 0% |
| Animations：三个原生循环、弹簧、序列 | 119–120 | 0.3–1.6 ms | 5–8% | 0% |

</div>

Stocks 上一帧的主线程时间约 1.6 ms 用于 tick，其中约 0.45 ms 重放 canvas 中的动画部分；每个 canvas 的其余部分由 Core Animation
在自己的线程上绘制。

### 每个页面

gallery 的每个页面，打开时以及测试滚动它时，同样在 1200 × 800 的窗口里。与 Linux 一样，*FPS* 是有东西在动时的速率（每个相邻绘制帧间隔的中位数一帧）；
达到显示器的 120 时，动画或滚动的每一帧都在上一帧之后的下一次刷新到来。*超过一次刷新*是耗时超过一次刷新（8.3 ms）的帧所占的比例。
静止的页面不绘制帧，CPU 为 2–5%。图片的 GIF 和 WebP 由 Core Animation 播放，视频由 AVFoundation 播放，按各自的帧率。

<div class="data-table">

| 页面 | 帧的来源 | FPS | 帧 p95 | 超过一次刷新 | CPU |
|---|---|---|---|---|---|
| Stocks | 实时数据、原生循环 | 120 | 3.2 ms | 0% | 35% |
| Stocks，滚动中 | 实时数据、滚动 | 120 | 3.5 ms | 0% | 36% |
| AI Chat，滚动中 | 滚动 | 120 | 2.4 ms | 1% | 5% |
| Photos，滚动中 | 滚动 | 120 | 1.4 ms | 0% | 10% |
| Lists，滚动中 | 滚动 | 120 | 1.6 ms | 0% | 8% |
| Scrolling，滚动中 | 滚动 | 120 | 2.7 ms | 0% | 6% |
| Navigation，滚动中 | 滚动 | 120 | 0.2 ms | 0% | 4% |
| Form，滚动中 | 滚动 | 120 | 0.6 ms | 0% | 5% |
| Resizable，滚动中 | 滚动 | 120 | 0.3 ms | 0% | 4% |
| Dock，滚动中 | 滚动 | 120 | 0.3 ms | 1% | 5% |
| Gestures | 弹簧、脉动的圆环 | 120 | 0.4 ms | 0% | 4% |
| Physics，滚动中 | 滚动 | 120 | 0.3 ms | 0% | 4% |
| Animations | 原生循环 | 120 | 0.3 ms | 0% | 5% |
| Canvas，滚动中 | 滚动、原生循环 | 120 | 1.2 ms | 0% | 7% |
| Styles，滚动中 | 滚动、摆动的变换 | 120 | 1.0 ms | 0% | 6% |
| Tailwind | `animate-*` 工具类 | 120 | 0.5 ms | 0% | 4% |
| Text，滚动中 | 滚动 | 120 | 0.3 ms | 0% | 5% |
| Text View，滚动中 | 滚动 | 120 | 0.7 ms | 0% | 5% |
| Images，滚动中 | 滚动 | 120 | 0.4 ms | 0% | 5% |
| Components，滚动中 | 滚动 | 120 | 0.3 ms | 0% | 5% |
| Overlays，滚动中 | 滚动 | 120 | 0.3 ms | 0% | 4% |
| Menus，滚动中 | 滚动 | 120 | 0.3 ms | 0% | 5% |
| Controls | 过渡 | 120 | 0.3 ms | 0% | 4% |
| Web and video，滚动中 | 滚动 | 120 | 0.2 ms | 0% | 6% |
| System | `requestAnimationFrame`、定时器 | 120 | 0.2 ms | 0% | 3% |
| Standard APIs，滚动中 | 滚动 | 120 | 0.3 ms | 0% | 5% |
| Storage，滚动中 | 滚动 | 120 | 0.3 ms | 0% | 5% |

</div>

### 内存

启动 3 秒后的静止内存（release 运行器）。*占用（footprint）*是 macOS 计入这个进程的内存（活动监视器显示的值）；*常驻内存*还包含系统共享库的页面：

<div class="data-table">

| 应用 | 窗口 | 占用 | 常驻内存（RSS） |
|---|---|---|---|
| Rust 应用（`nsh init --template rust`） | 1200 × 800 | ~19 MB | ~86 MB |
| TSX 计数器（`examples/counter`） | 1200 × 800 | ~20 MB | ~89 MB |
| 只有一个 label 的 AppKit 窗口，作为参照 | 480 × 640 | ~17 MB | ~80 MB |

</div>

浏览 gallery 的过程中，进程在 Canvas 页之前占用 84–230 MB，从 Text View 页起约 350–360 MB，增长的是它有意保留的缓存（解码后的图片，
上限 128 MB；Text View 页的文档）以及首次使用时加载的框架（网页视图用的 WebKit）；Canvas 页的栅格在三个 canvas 都可见时最多约
310 MB，离开页面即释放。

### 应用体积

用 `nsh init` 的每种模板生成的 hello world 应用，由 `nsh package --target macos` 为 Apple 芯片（arm64）构建，与 Linux 一样以链接时优化构建并去除符号；以及上面两个应用为 Apple 芯片发布的版本。
可执行文件是 `.app` 里的运行器；zip 是压缩后的 `.app`（`ditto -c -k`）：

<div class="data-table">

| 应用 | 编写语言 | 可执行文件 | 压缩后的 `.app` |
|---|---|---|---|
| Hello world（`--template rust`） | Rust | 12.4 MB | 6.0 MB |
| Hello world（`--template ts`） | TSX，运行在 QuickJS 上 | 19.8 MB | 9.5 MB |
| Hello world（`--template mixed`） | TSX 加一个 Rust crate | 19.8 MB | 9.5 MB |
| [sysmon](https://github.com/huacnlee/sysmon) 0.1.3 | Rust | 21.6 MB | 8.4 MB（它发布的 `.tar.gz`） |
| [Omasend](https://github.com/huacnlee/omasend) 0.2.0 | Rust | 18.4 MB | 9.7 MB（它发布的 `.tar.gz`） |

</div>

这些数字来自：

- **只为变化绘制帧**：display link 在原生动画运行时跳动，并随动画一起停止；动画随页面一起停止（视图删除时它的关键帧动画结束，循环在组件的 `cleanup` 中停止）。
- **Canvas 在开销最小的地方绘制**：频繁重绘的 canvas（动画、实时数据）在 Core Animation 的线程上异步绘制（`drawsAsynchronously`），不占用主线程；偶尔才重绘的 canvas 直接在主线程上绘制，省下异步绘制占用的显存。动画值变化时只重绘读取它的操作覆盖的区域。
- **保留 canvas 的静态部分**：绘制内容稳定后，第一个动画操作之前较长的部分保留为一个图层；每帧绘制这个图层，只重放动画的其余部分，并直接在主线程上完成（Canvas 页的仪表盘、时钟和点阵：不占 GPU，内存减半）。
- **内容变化时才绘制**：文本和 canvas 绘制在各自的 layer 里，内容或尺寸变化时才重绘，移动或滚动时不重绘。

## Windows（Win32、Direct2D）

测量环境：一台 Windows 11 台式机（Intel Core i7-13700KF，32 GB，NVIDIA GeForce RTX 3060 Ti），4K 144 Hz 显示器、150% 缩放，
release 构建，gallery 运行在 1200 × 800 的窗口里（1800 × 1200 像素），所有读数都由 `examples/gallery/tools/perf.py` 自动采集
（`nsh test --target windows --fps`，每秒一行；CPU 指整个进程，以单核的百分比计）。阶段是主线程每帧的开销：*paint*（Direct2D
绘制窗口）以及其中的 *canvas*（录制和重放绘制）。

### 动画演示

<div class="data-table">

| 演示 | FPS | 帧 p95 | 每帧 paint / canvas | CPU |
|---|---|---|---|---|
| Stocks：22 条实时走势线、分时图、盘口、逐笔成交 | 144 | 3.7–4.3 ms | 1.4 / 0.13 ms | 36–43% |
| Canvas：仪表盘、时钟、点阵 | 144 | 1.0–2.0 ms | 0.8–1.4 / 0.05 ms | 21–35% |
| Animations：三个原生循环、弹簧、序列 | 144 | 1.0–3.6 ms | 0.9–1.9 ms | 20–41% |

</div>

Stocks 每秒 commit 16–17 次，每次在引擎线程上用时最多 2.1 ms 的 JS 和 1.7 ms 的 core（p95）。

> [!NOTE]
> 动画让视图在大片区域里移动的页面，在这里的 CPU 占用比 Linux 和 macOS 高（Animations 为 20–41%，而那两者为 5–13%；Gestures 为 36%，
> 而那两者为 1–5%）。Windows 的一帧会在主线程上用 Direct2D 重画变化区域里的每一个视图：一个变大的圆环每帧都要重画它下面的卡片。
> 在 macOS 上，Core Animation 在 GPU 上直接移动、缩放和淡化它保留的 layer，不需要重画；在 Linux 上，GSK 保留没有变化的渲染节点。
> 此外，这里的数字是每秒 144 帧、1800 × 1200 像素下的读数。

### 每个页面

gallery 的每个页面，打开时以及测试滚动它时，同样在 1200 × 800 的窗口里。与 Linux 和 macOS 一样，*FPS* 是有东西在动时的速率（每个相邻绘制帧间隔的中位数一帧）；
达到显示器的 144 时，动画或滚动的每一帧都在上一帧之后的下一次刷新到来。*超过一次刷新*是耗时超过一次刷新（6.9 ms）的帧所占的比例。
静止的页面不绘制帧，CPU 为 0–2%。图片的 GIF 和 WebP 按各自的帧率播放（这里约 40 FPS）。Physics、Overlays、Menus 和 Storage
在 900 × 500 的窗口里测量，在那里它们有足够的内容可以滚动。

<div class="data-table">

| 页面 | 帧的来源 | FPS | 帧 p95 | 超过一次刷新 | CPU |
|---|---|---|---|---|---|
| Stocks | 实时数据、原生循环 | 144 | 3.9 ms | 0% | 36% |
| Stocks，滚动中 | 实时数据、滚动 | 144 | 4.3 ms | 0% | 43% |
| Photos，滚动中 | 滚动 | 143 | 2.1 ms | 0% | 9% |
| Lists，滚动中 | 滚动 | 144 | 2.0 ms | 1% | 19% |
| Scrolling，滚动中 | 滚动 | 143 | 2.1 ms | 0% | 7% |
| Navigation，滚动中 | 滚动 | 144 | 0.8 ms | 0% | 9% |
| Form，滚动中 | 滚动 | 144 | 0.8 ms | 0% | 12% |
| Resizable，滚动中 | 滚动 | 143 | 0.4 ms | 0% | 4% |
| Dock，滚动中 | 滚动 | 144 | 0.5 ms | 1% | 5% |
| Gestures | 弹簧、脉动的圆环 | 144 | 1.8 ms | 0% | 36% |
| Physics，滚动中 | 滚动（900 × 500 窗口） | 144 | 0.8 ms | 0% | 4% |
| Animations | 原生循环 | 144 | 1.0 ms | 0% | 28% |
| Canvas，滚动中 | 滚动、原生循环 | 144 | 2.0 ms | 0% | 35% |
| Styles，滚动中 | 滚动、摇摆的变换 | 144 | 2.1 ms | 0% | 39% |
| Tailwind | `animate-*` 工具类 | 144 | 0.6 ms | 0% | 19% |
| Text，滚动中 | 滚动 | 144 | 1.6 ms | 0% | 8% |
| Text View，滚动中 | 滚动 | 144 | 1.1 ms | 0% | 10% |
| Images，滚动中 | 滚动、GIF 和 WebP 的帧 | 143 | 4.8 ms | 2% | 23% |
| Components，滚动中 | 滚动 | 144 | 1.0 ms | 1% | 11% |
| Overlays，滚动中 | 滚动（900 × 500 窗口） | 144 | 0.6 ms | 0% | 1% |
| Menus，滚动中 | 滚动（900 × 500 窗口） | 144 | 0.6 ms | 0% | 2% |
| Controls | 过渡 | 117–144 | 1.5 ms | 0% | 22% |
| Web and video，滚动中 | 滚动 | 144 | 1.6 ms | 0% | 15% |
| System | `requestAnimationFrame`、定时器 | 144 | < 0.1 ms | 0% | 1% |
| Storage，滚动中 | 滚动（900 × 500 窗口） | 144 | 0.5 ms | 0% | 1% |

</div>

### 内存

启动 3 秒后的静止内存（release 运行器，1200 × 800 的窗口）。*专用工作集*是只有这个进程使用的内存（任务管理器“内存”一列的值）；
*专用字节*是它提交的内存；*工作集*还包含它与其他进程共享的系统库的页面（Direct3D、Direct2D、DirectWrite、GPU 驱动）：

<div class="data-table">

| 应用 | 专用工作集 | 专用字节 | 工作集 |
|---|---|---|---|
| Rust 应用（`nsh init --template rust`） | ~14 MB | ~60 MB | ~53–71 MB |
| TSX 计数器（`examples/counter`） | ~15 MB | ~61 MB | ~56–71 MB |

</div>

浏览 gallery 的过程中，工作集在 Stocks 页约 108–115 MB，从 Canvas 页起约 230 MB，从 Text View 页起约 320–340 MB，
Web and video 页打开 WebView2 之后约 390–405 MB（网页运行在 WebView2 自己的进程里），增长的是它有意保留的缓存（解码后的图片，
上限 128 MB；Text View 页的文档）。

### 应用体积

用 `nsh init` 的每种模板生成的 hello world 应用，由 `nsh package --target windows` 为 x86_64 构建（Rust 运行器与 Linux 一样以链接时优化构建并去除符号）。
可执行文件是应用的 `<Name>.exe`；zip 是写在它的目录旁边的 `.zip`：

<div class="data-table">

| 应用 | 编写语言 | 可执行文件 | Zip |
|---|---|---|---|
| Hello world（`--template rust`） | Rust | 15.0 MB | 6.7 MB |
| Hello world（`--template ts`） | TSX，运行在 QuickJS 上 | 28.6 MB | 12.4 MB |
| Hello world（`--template mixed`） | TSX 加一个 Rust crate | 26.3 MB | 11.5 MB |

</div>

这些数字来自：

- **只为变化绘制帧，只画变化的地方**：按合成器节奏运行的 ticker 只在原生动画、过渡或帧回调运行时跳动。一帧只在窗口保留的像素上
  重画变化视图的区域（它原来的位置和现在的位置），并且只把这些区域交给合成器（Stocks：每帧约 34 个视图）。
- **Canvas 只录制动画部分**：绘制被录制为 Direct2D 的 command list，是矢量的，任意缩放都清晰。动画值变化时，只重新录制从第一个读取动画值的操作开始的部分，
  之前的部分保留（Stocks：22 条脉动的走势线和分时图，每秒约 26 ms 的录制）。
- **只绘制看得见的部分**：滚动视图或裁剪视图中不在视野内的子视图不进入这一帧，没有自身内容的视图只绘制背景和边框。

## iOS（UIKit）

测量环境：iOS 模拟器（iPhone 18 Pro Max，运行在上面那台 MacBook Pro 上），release 构建，与上面相同的浏览流程（`perf.py --target ios`：
`nsh test --target ios --fps`，以 UIKit 收到的手指触摸操作）。模拟器以 60 Hz 呈现；在配有 ProMotion 屏幕的 iPhone 上，NSH 的 display link
以屏幕的 120 Hz 运行（`nsh package` 构建的应用和开发宿主通过 `CADisableMinimumFrameDurationOnPhone` 请求它）。阶段是 *tick*（原生动画）、
*drain*（应用引擎的批次）和 *scroll*（跟随滚动视图的工作：列表、吸顶单元格、绑定的值）。

<div class="data-table">

| 页面 | 帧的来源 | FPS | 帧 p95 | CPU |
|---|---|---|---|---|
| Home，滚动中 | 滚动 | 60 | 0.1 ms | 6% |
| Stocks | 实时数据、原生循环 | 60 | 0.3 ms | 22% |
| Stocks，滚动中 | 实时数据、滚动 | 60 | 0.3 ms | 25% |
| Photos，滚动中 | 滚动 | 60 | 1.2 ms | 6% |
| Lists，滚动中 | 滚动 | 60 | 1.1 ms | 8% |
| Scrolling，滚动中 | 滚动 | 60 | 0.1 ms | 7% |
| Navigation，滚动中 | 滚动 | 60 | 0.2 ms | 7% |
| Form，滚动中 | 滚动 | 60 | 0.3 ms | 7% |
| Gestures | 弹簧、脉动的圆环 | 60 | 0.3 ms | 3% |
| Animations | 原生循环 | 60 | 0.7 ms | 6% |
| Canvas | 原生循环 | 60 | 0.4 ms | 16% |
| Styles | 摆动的变换 | 60 | 0.4 ms | 4% |
| Tailwind，滚动中 | 滚动 | 60 | 0.2 ms | 7% |
| Text，滚动中 | 滚动 | 60 | 0.1 ms | 7% |
| Text View，滚动中 | 滚动 | 60 | 0.1 ms | 6% |
| Images，滚动中 | 滚动 | 60 | 0.1 ms | 5% |
| Components，滚动中 | 滚动 | 60 | 0.2 ms | 6% |
| Overlays，滚动中 | 滚动 | 60 | 0.1 ms | 6% |
| Menus，滚动中 | 滚动 | 60 | 0.2 ms | 7% |
| Controls，滚动中 | 滚动、过渡 | 60 | 0.2 ms | 5% |
| Web and video，滚动中 | 滚动 | 60 | 0.1 ms | 8% |
| System | `requestAnimationFrame`、定时器 | 60 | 0.3 ms | 4% |
| Standard APIs，滚动中 | 滚动 | 60 | 0.1 ms | 7% |
| Storage，滚动中 | 滚动 | 60 | 0.1 ms | 8% |

</div>

*FPS* 与上面一样是有东西在动时的速率：达到模拟器的 60 时，每一帧都在上一帧之后的下一次刷新到来。没有任何东西在动的页面不绘制帧，
静止时 CPU 为 1–2%。进程在 gallery 首页占用 40 MB，浏览完全部页面后约 180 MB（有意缓存的图片、Text View 页的文档）。

在 iPhone 17 Pro（ProMotion，120 Hz）上，以开发宿主单独运行一个 demo，动画页面每次刷新都绘制一帧：

<div class="data-table">

| 页面 | 帧的来源 | FPS | 帧 p95 | 超过一次刷新 | CPU | 内存 |
|---|---|---|---|---|---|---|
| Stocks | 实时数据、原生循环 | 120 | 0.2–0.3 ms | 0% | 46–70% | 41–43 MB |
| Canvas | 原生循环 | 120 | 0.1 ms | 0% | 25–36% | 37–38 MB |
| Animations | 原生循环 | 120 | 0.2 ms | 0% | 3–11% | 37 MB |

</div>

Stocks 每秒提交 20 次（每 50 ms 一次行情），每次在引擎线程上耗时 JS 1.5 ms、core 1.4 ms（p95 为 2.2 和 2.0 ms），
引擎线程的忙碌占比为 4–6%。

## 测量应用

用同样的方式测量一个应用，在 `--target linux`、`macos`、`windows` 或 `ios` 上带上 `--fps` 和 `-v` 运行它的测试或步骤：

```sh
cargo build --release -p nsh-cli
python3 examples/gallery/tools/perf.py --target macos --only Stocks,Canvas   # gallery，逐页测量
echo 'await app.wait(5000)' | nsh -v test App.tsx --target linux --fps        # 任意应用
```


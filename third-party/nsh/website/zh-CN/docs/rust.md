---
title: 用 Rust 开发
description: 完全用 Rust 编写 Native Shell 应用，在所有平台上都不带 QuickJS；或者在 Rust 之上用 TSX 编写页面：如何选择，以及两者如何共享组件和模块。
order: 5.5
group: start
---

# 用 Rust 开发

Native Shell 应用可以用 Rust 编写，也可以用 TSX，或者两者结合。三种方式运行在同一个引擎上：响应式图、渲染器、Taffy
布局以及原生模块（导航、对话框、键盘、状态栏）始终是 Rust，各平台都用自己的原生 UI 渲染。不同的是你自己的代码用什么语言，以及应用是否带着
JavaScript 虚拟机。

| | Rust | TSX | Rust + TSX |
|---|---|---|---|
| 你的 UI、状态和事件处理 | Rust | TSX，运行在 QuickJS 上 | Rust 组件和模块，TSX 页面使用它们 |
| 应用运行的内容 | 只有引擎和你的 crate，所有平台和浏览器都一样 | QuickJS 和引擎 | QuickJS 和引擎，加上你的 crate |
| 适合 | 业务复杂度高的中大型应用 | 运行时下发的应用和模块、快速迭代 | Rust 核心加上经常变化的部分 |
| 修改代码 | 重新构建并重启 | 热更新 | TSX 热更新，Rust 重新构建并重启 |
| 创建 | `nsh init my-app --template rust` | `nsh init my-app --template ts` | `nsh init my-app --template mixed` |

## 如何选择

**Rust** 适合业务逻辑庞大、要求高的应用：交易、编辑器、数据密集的工具。整个应用都有 Rust 的类型系统和编译期检查，可以使用
crates.io 生态，你自己的代码（不只是 NSH 的代码）也是原生性能，还能用 `cargo test` 对真实 UI 做无界面测试。应用从头到尾都是
Rust 和原生代码：在 iOS、Android、macOS、Windows、Linux、GPUI 和 Web 上，应用里既不带也不运行 JavaScript 虚拟机。
组件是只运行一次的函数，把信号绑定到显示的内容上，和 TSX 一样（[响应式](./reactivity.md)），样式用类型化的方法而不是 class 字符串。

**TSX** 适合应用发布之后才到达的界面：原生应用在运行时加载的模块，由模型生成或由其他团队编写，以[签名包](./signed-packages.md)下发，运行在宿主配置的沙箱里，开发时支持热更新。

**Rust + TSX** 保留 Rust 核心，在值得的地方加上 TSX：页面、设置、引导、实验性功能，任何需要热更新快速迭代、或作为[签名包](./signed-packages.md)
在运行时下发的部分。TSX 像导入其他 NSH 模块一样导入你的 Rust 组件和模块，两部分通过类型化的接口衔接。TSX 运行在 QuickJS
上，这时应用会带上 QuickJS。

## 完全用 Rust 编写的应用

```sh
nsh init my-app --template rust
cd my-app
nsh run                        # 本机的后端；--target ios、android、web、macos、linux 或 windows
nsh package --target web       # 或 ios、ios-simulator、android、macos、linux、windows
```

`src/lib.rs` 包含整个应用：组件、状态、事件处理和任务。

```rust
use nsh_base::{button, theme};
use nsh_core::prelude::*;

/// TSX 通过 `app/native` 可以使用的组件。
#[native_module("app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

#[component]
pub fn App() -> impl IntoElement {
    let count = signal(0_u32);
    let quote = signal(SharedString::from("…"));
    // 异步工作在任务里运行；请求走 NSH 的网络栈。
    spawn(async move {
        if let Ok(response) = fetch("https://api.example.com/quote").await {
            quote.set(response.text().into());
        }
    });
    view()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_4()
        .child(text(move || format!("Count: {}", count.get())))
        .child(text(quote))
        .child(
            // nsh_base 的无样式按钮，用主题的颜色绘制。
            button()
                .px(px(20.0))
                .py(px(12.0))
                .rounded(move || theme().radius)
                .bg(move || theme().primary)
                .active(|s| s.bg(move || theme().primary.opacity(0.9)))
                .on_press(move || count.update(|c| *c += 1))
                .child(text("Tap").text_color(move || theme().primary_foreground)),
        )
}
```

元素和组件用同样的方式创建：一个函数创建它（`view()`、`text(..)`、`nsh_base` 的 `button()`、你的 `#[component] fn Chart`
生成的 `chart()`），它的方法设置 props（每个 prop 一个设置方法，接受值、signal 或闭包）和监听器（每个事件一个方法）。
监听器是接收事件的闭包（`move |text: &str| ..`），没有数据的事件写成 `move || ..`；`.child(..)`
接受一个元素，或元素的 `Option`、`Vec`、数组、迭代器（`.child(rows.iter().map(|r| row(r)))`）。

`nsh.json` 指定根组件，`nsh` 负责挂载它：

```json
{
  "name": "My App",
  "rust": ".",
  "root": "App",
  "theme": "theme.json",
  "appearance": "system"
}
```

`"root"` 是组件在 crate 中的路径（`App`、`shell::Gallery`；有[多个 crate](#多个-crate) 时在第一个中）；`"theme"` 是它的组件绘制时使用的[主题](#主题)，`"appearance"` 和 TSX 应用一样作用于它。
有了它，对应用目录执行 `nsh run` 和 `nsh package` 时，会为目标平台构建应用自己的运行器，直接挂载根组件，不链接 QuickJS：

| 目标 | 运行的内容 |
|---|---|
| macOS、Windows、Linux | 带有你的 crate 的发布运行器，在窗口中运行；`nsh run` 使用 debug 构建，并在终端显示应用日志 |
| iOS、iOS 模拟器、Mac Catalyst | 带有你的 crate 的 iOS 运行器 |
| Android | 带有你的 crate 的应用 `libnsh.so`，由运行时的 Activity 启动 |
| Web | 包含引擎和你的 crate 的 `nsh.wasm`（整个 Rust gallery 为 3.3 MB，brotli 压缩后 0.75 MB）；页面直接挂载根组件 |

`nsh` 只构建你的 crate 需要的东西：一个由你的 crate 和 NSH 核心组成的小程序，它向 CLI 描述 crate 的组件和模块，其余工作由
CLI 自己完成；再加上你运行或打包的每个目标的运行器。新 Rust 应用的第一次构建只编译你的 crate 和 NSH 的核心，大约 60 个
crate。`nsh test` 在同样构建的、包含你的 crate 的运行器中以无界面方式运行应用的测试。

在 Linux 上，由应用 crate 选择可选的平台功能。使用网页视图时，在 `nsh-platform-linux` 依赖上启用
`webview` feature；这会链接 WebKitGTK 6.0，构建和运行时都需要安装该系统库。生成的运行器通过 Cargo
的 feature 合并继承应用的选择。

`nsh run` 期间，修改 crate 的 Rust 代码会重新构建运行器并重启应用；在浏览器中，已打开的页面会自动加载新的运行时。
`cargo run` 在桌面后端上直接启动同一个根组件（`src/main.rs`）；嵌入 NSH 的原生应用在 macOS、Windows、Linux、GPUI 和
iOS 的 `AppView` 上用 `AppSource::Rust` 挂载 Rust 根组件。

要在包括 Web 在内的所有平台上运行的代码，使用 NSH 提供的服务：HTTP 用 `fetch`（[网络](./networking.md#在-rust-组件中)），
等待用 `timer`、`set_timeout` 和 `set_interval`，时钟用 `nsh_core::time::Instant` 和 `nsh_core::time::unix_ms()`。
`background` 和 `blocking` 在原生目标的线程上运行任务。

## 桌面标题栏

Rust 应用通过 `nsh_core::element::desktop` 绘制自定义标题栏。调用
`set_title_bar(TitleBarStyle::Hidden, Some(height))`，将背景设为
`.window_drag(true)`，并通过 `title_bar()` 为系统窗口按钮留出空间。
返回值的 `top` 是标题栏高度，`left` 和 `right` 是两侧系统按钮占用的宽度。
读取会订阅变化，包括进入和退出全屏。平台负责窗口拖动和用户设置的标题栏双击行为；
子元素上的 `.window_drag(false)` 可以排除父元素的拖动区域。

```rust
use nsh_core::{
    desktop::TitleBarStyle,
    element::{desktop::{close_window, set_title_bar, title_bar}}, prelude::*,
};

fn window_bar() -> impl IntoElement {
    set_title_bar(TitleBarStyle::Hidden, Some(px(42.0)));
    view()
        .h(px(42.0))
        .flex_row()
        .items_center()
        .window_drag(true)
        .pl(move || title_bar().left + px(12.0))
        .pr(move || title_bar().right + px(12.0))
        .child(text("My app").flex_1())
        .child(text("Close").window_drag(false).on_press(close_window))
}
```

`set_title_bar(TitleBarStyle::Default, None)` 恢复系统标题栏。
`close_window()` 遵循宿主的正常窗口关闭行为。

## 用 TSX 扩展 Rust 应用

crate 的 `#[native_module("app/native")]` 函数声明 TSX 可以导入的内容：组件（`registry.register::<Chart>()`）、函数模块
（`registry.module::<Portfolio>()`，在单元结构体及其 `impl` 上标注 `#[module]`）、类（`registry.class::<Ledger>()`，在结构体及其 `impl` 上标注
`#[class]`）和资源；这个属性还会在 crate 根部生成 `pub fn registry()`，给测试和其他 Rust 代码使用同一个集合
（`my_app_native::registry()`，与 `nsh_base::registry()` 并列）。在 `#[module]` 或 `#[class]` 的 `impl` 中，`pub fn`（包括 `pub(crate)`）会被导出；没有可见性修饰的函数是
辅助函数，只留在 Rust 中。它们的 TypeScript 声明（包括文档注释）由 Rust 类型生成到 `.nsh/types`，所以 `nsh check` 和编辑器会据此检查
TSX：

```rust
/// 价格图表。
#[derive(Clone, PartialEq, Props)]
pub struct ChartProps {
    /// 要绘制的代码。
    pub symbol: Prop<SharedString>,
    /// 显示的时间范围。
    #[prop(default = SharedString::from("1D"))]
    pub range: Prop<SharedString>,
}

#[derive(Event)]
pub enum ChartEvent {
    /// 选中了一个价格。
    #[args(price)]
    Select(f64),
}

/// 价格图表；按下时选中最新价格。
#[component]
pub fn Chart(props: ChartProps, cx: Scope<ChartEvent>) -> impl IntoElement {
    view()
        .h(px(160.0))
        .bg(move || theme().muted)
        .on_press(move || cx.emit(ChartEvent::Select(101.5)))
        .child(text(move || format!("{} · {}", props.symbol.get(), props.range.get())))
}

/// A ledger kept in Rust.
#[class]
pub struct Ledger {
    entries: Vec<f64>,
}

#[class]
impl Ledger {
    /// An empty ledger.
    pub fn new() -> Self {
        Ledger { entries: Vec::new() }
    }

    /// Adds `amount`; the new balance.
    pub fn add(&mut self, amount: f64) -> f64 {
        self.entries.push(amount);
        self.balance()
    }

    /// The balance.
    #[getter]
    pub fn balance(&self) -> f64 {
        self.entries.iter().sum()
    }

    /// Uploads the entries; resolves when the server has them.
    pub async fn upload(this: Instance<Ledger>, url: String) -> Result<(), String> {
        let body = this.with(|l| format!("{:?}", l.entries));
        fetch(HttpRequest::post(url, body)).await.map(|_| ())
    }
}

/// 应用的持仓。
#[module]
pub struct Portfolio;

#[module]
impl Portfolio {
    /// The value of the holdings.
    pub fn total() -> f64 {
        1250.0
    }
}
```

```tsx
import { mount, signal, View, Text } from "nsh";
import { Chart, Ledger, Portfolio } from "app/native";   // Rust

const ledger = new Ledger();   // 状态保存在 Rust 中

function Overview() {
  const balance = signal(ledger.add(Portfolio.total()));   // Rust，立即调用
  return (
    <View class="gap-2 p-4">
      <Text>Balance: {balance()}</Text>
      <Chart symbol="NSH" range="1M" onSelect={(e) => balance.set(ledger.add(e.price))} />
      <View onPress={() => ledger.upload("https://example.com/ledger")} role="button" class="rounded-lg bg-blue-600 px-4 py-2 active:bg-blue-700">
        <Text class="text-white">Upload</Text>
      </View>
    </View>
  );
}

mount(() => <Overview />);
```

每个导出在 TypeScript 中的文档来自给它命名的那个 Rust 项的文档注释：组件来自 `#[component] fn`（`Chart`），模块和类来自它们的
结构体（`Portfolio`、`Ledger`），props、事件、函数和成员来自它们自己的文档注释（有 getter 的 setter 不需要）。`Props` 结构体和
事件枚举本身的文档注释，以及 `impl` 块上的文档注释，只留在 Rust 中；在 `#[module]` 或 `#[class]` 的 `impl` 块上写文档注释是编译
错误，因为 TypeScript 不会显示它。每个写入 `.nsh/types` 的命令都会对 TSX 看到的、没有文档注释的导出给出警告，并写出它的名字
（`Ledger.add`、`Chart.range`）。

TypeScript 只显示文档注释中第一个标题之前的部分。写给 Rust 调用者的说明，例如 `&self` 借用了什么、函数为什么接收 `cx`，放在标题
`# Rust`（或 rustdoc 的 `# Panics`、`# Examples`）下面，只留在 Rust 文档中：

```rust
/// 把 `text` 放到剪贴板；resolve 为复制的字符数。
///
/// # Rust
///
/// 接收 `cx` 让它成为一个 op，与 TS 在它之前做的 UI 改动按顺序执行。
pub fn copy(text: String, cx: &mut ModuleCx) -> u32 {
    let count = text.chars().count() as u32;
    cx.set_clipboard(text);
    count
}
```

props 是组件 `Props` 结构体的字段，事件是 `Event` 枚举的变体（`onSelect`），都用驼峰命名。Rust 代码用组件的构造函数放置同一个组件，每个 prop 一个设置方法，每个事件一个监听方法：`chart().symbol("NSH").range("1M").on_select(move |price: &f64| last.set(*price))`。Rust 组件自己的内容、事件和状态留在
Rust 中；TSX 传入 props、接收事件。类型不对的 prop（`u32` 类型的 prop 传 `level={1.5}`）和内置元素上一样给出警告：这个 prop 保持原值，组件的其余部分照常渲染。

函数和成员按 Rust 签名运行。不是 `async` 的在 TSX 调用中直接运行并返回值（`Portfolio.total()` 是数字，`ledger.balance` 是属性）：
它们计算并保存状态。`async fn` 返回 Promise，作为任务运行，可以使用 NSH 的服务（`fetch`、`timer`、对话框）；带
`cx: &mut ModuleCx` 参数的模块函数与 UI 按顺序作用于平台（toast、状态栏），组件 ref 的方法也是这样；它们的返回类型决定 TSX
得到什么：返回 `()` 的得到 `void`，没有回复（TSX 调用后继续往下执行）；返回 `Result<(), E>` 的得到 `Promise<void>`，遇到 `Err`
时以其消息 reject（调用与 UI 的修改一起运行，那时 TSX 的调用已经返回，所以由 Promise 带回错误；没人 await 或 catch 的会记录为
[未处理的 rejection](./dev-server-and-debugging.md#日志)）；返回值的得到 `Promise<T>`。参数和返回值的类型来自签名：数字、
字符串、`Option`、`Vec`、你的 `#[derive(JsObject)]` 结构体和 `#[derive(PropEnum)]` 枚举、你的类的实例，以及 TSX 函数
（`Callback<A, R>`：Rust 在调用中立即调用它，或之后用 `post` 和 `call_async` 调用；`Callback<f64>` 在 TS 中是
`(value: number) => void`，`#[args(balance)] listener: Callback<f64>` 给参数命名，得到 `(balance: number) => void`）。事件处理函数的参数
也叫 `value`，在事件的变体上写 `#[args(index)]` 可以给它命名。类型不对的参数在调用中抛出 `TypeError`，
返回 Promise 的调用则以它 reject；`Err` 以其消息抛出（或 reject）。类的对象拥有它的
Rust 值：对象被回收时释放，或调用 `ledger.dispose()`（也可以 `using ledger = new Ledger()`）立即释放。指定 TSX 入口来运行它：`nsh run App.tsx` 或 `nsh package App.tsx --target …`。TSX 的修改是热更新，
Rust 的修改会重新构建并重启应用。CLI 根据 crate 的描述知道它导出了什么，自己打包和编译 TSX；开发宿主和 `nsh test` 的
无界面运行器则与你的 crate 和 QuickJS 一起构建。

仓库中的 `examples/rust-exports` 是导出的参考示例：一个小型 TSX 应用，它的 crate 导出一个组件（必填、有默认值和可选的
props，一个事件，子元素）、一个模块（每种函数各一个）和一个类（构造函数、方法、getter 和 setter、静态成员、`async` 成员、以另一个实例为参数、
Rust 用 `post` 调用的回调、`dispose()` 和 `using`），每个都有简短的文档注释；它的测试（Rust 的，以及 TypeScript 的 `App.test.tsx`）在应用中逐一点按，并检查每个导出显示的内容。

仓库中的 `examples/gallery-rs` 是一个完整的 Rust 应用：每个 demo 都是 Rust，`nsh run examples/gallery-rs --target web`
（或 `ios`、`android` 等）运行它的根组件，`nsh test examples/gallery-rs` 以无界面方式运行它的测试，`cargo run -p gallery-native`
在桌面后端上启动它。

### 渲染函数与应用的类

组件用渲染函数为它拥有的值（它的一行数据、文档中的一个代码块）绘制应用的内容：一个 `Option<Renderer<T>>` 属性，在 TypeScript 中是 `(value: T) => JSX.Element`。组件在内容所在的位置调用 `render(key, value)`，得到一个视图，像其他视图一样设定样式并放置（在 `text(..)` 中是一个行内视图）。只要值不变，内容按 key 保留；值改变时重新渲染。Rust 父组件把闭包传给该属性的设置方法（`quote().render_badge(|symbol| ..)`），由它生成 `Renderer`。

组件中的样式是类型化的；应用的 Tailwind 类通过一个类名属性和该部件元素上的 `.app_class(..)` 作用于组件的某个部件。它们在元素自身的样式之后应用，并使用应用的主题、`dark:` 和各种状态，就像元素上的 `class` 一样。

```rust
/// A quote: its symbol, then content of the app's.
#[derive(Clone, Copy, PartialEq, Props)]
pub struct QuoteProps {
    /// The symbol.
    pub symbol: Prop<SharedString>,
    /// Tailwind classes of the symbol's text.
    pub symbol_class: Prop<Option<SharedString>>,
    /// Content of the app's after the symbol (a change, a badge).
    pub render_badge: Prop<Option<Renderer<SharedString>>>,
}

/// A quote of a symbol.
#[component]
pub fn Quote(props: QuoteProps) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap_2()
        .child(text(props.symbol).app_class(props.symbol_class))
        .child(dynamic(move || {
            props.render_badge.get().map(|r| r.render("badge", props.symbol.get()).flex_1())
        }))
}
```

```tsx
<Quote
  symbol="NSH"
  symbolClass="text-lg font-semibold"
  renderBadge={(symbol) => <Text class="text-green-600">{`${symbol} ▲ 2.4%`}</Text>}
/>
```

`nsh/base` 中的 `TextView` 就是这样构建的：它的 `renderCodeBlock`、`renderMath` 等是渲染函数，它的 `classes` 是应用按部件给出的类（[TextView](../elements/text-view.md)）。

## 测试

Rust 应用的测试以无界面方式运行它，可以在 `cargo test` 中，也可以在 `nsh test` 中，使用同一个驱动：运行在真实的引擎上，没有窗口，以
60 Hz 提供显示帧，所以定时器、任务和动画都像在屏幕上一样运行。驱动启动应用，维护一份它所显示视图的模型，并在用选择器指定的视图上执行步骤（`press`、`type_text`、`submit`、`scroll`、`wait_for`），选择器可以是文本、无障碍标签或
test id（`text:`、`label:`、`id:`）；步骤无法执行时，会带着屏幕上的文字失败。

在 `cargo test` 中，`nsh_testing::Headless`（nsh-testing 的默认特性，不含 QuickJS）运行根组件（`app.screen()`：屏幕上的文字、应用发送的命令）；`EngineConfig::new`
是一个手机尺寸、其余都未设置的引擎。`nsh test` 在用你的 crate 构建的无界面运行器中运行 TypeScript 测试（[测试](./testing-and-trace.md)），其中
`open(".")` 启动 Rust 应用的根组件：

```toml
[dev-dependencies]
nsh-engine = "0.1"
nsh-testing = "0.1"
```

```rust tabs
// tests/app.rs：cargo test
use nsh_engine::{EngineConfig, Root};
use nsh_testing::Headless;

#[test]
fn a_tap_counts() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<my_app::App>())).unwrap();
    app.wait_for("Count: 0").unwrap();
    app.press("Tap").unwrap();
    app.wait_for("Count: 1").unwrap();
}
```

```tsx tabs
// App.test.tsx，与 nsh.json 放在一起：nsh test
import { expect, open, test } from "nsh/test";

test("a tap counts", async () => {
  const app = await open(".");
  await app.press("Tap");
  expect(app.texts()).toContain("Count: 1");
});
```

TSX 入口用 `nsh-testing` 的特性 `bundle` 按 `nsh run` 的方式构建，使用它的宿主提供的 UI 集合：NSH 的，以及每个 crate 由
`#[native_module]` 生成的 `registry()`：

```toml
[dev-dependencies]
nsh-testing = { version = "0.1", features = ["bundle"] }
nsh-base = "0.1"
```

```rust
#[test]
fn the_module_formats_money() {
    let sets = vec![nsh_base::registry(), my_app_native::registry()];
    let mut app = nsh_testing::tsx("../App.tsx", sets).unwrap();
    app.wait_for("Formatted at once: $1,234.50").unwrap();
}
```

`nsh_testing::compile_tsx` 只构建一次入口供多个测试使用，`nsh_testing::start` 把批次交给自己维护屏幕模型的测试。
`examples/rust-exports` 用这种方式测试它的 TSX 入口；`examples/gallery-rs` 用 TypeScript 测试它的 Rust 根组件，
大致每个 demo 一个测试文件。

## 主题

应用的外观由应用自己决定：NSH 提供基础元素和 `nsh_base` 中无样式的基础组件，你的 crate 是其上带样式的一层，即应用自己的组件库（[三层结构](./architecture.md#three-layers)）。Rust 组件的颜色、圆角和字体取自主题，即
`nsh_base` 的 `theme()`，所以一个文件就能改变应用中所有组件的样式。每种颜色都有浅色和深色两个值；系统切换外观时，
`.bg(move || theme().primary)` 这样的绑定会原生地改变颜色，不需要重新渲染。

主题采用 [shadcn/ui](https://ui.shadcn.com/docs/theming) 的设计令牌，默认主题是 shadcn 的 `neutral` 主题：黑白配色，圆角 10 点。
要使用自己的主题，在 `nsh.json` 中把 `"theme"` 设为主题文件的路径（相对于 `nsh.json`），或者直接写入主题内容：

```json
{
  "name": "My App",
  "rust": ".",
  "theme": "brand-theme.json"
}
```

主题文件就是 shadcn 的 `cssVars`，即 shadcn 主题和 registry 条目的格式，所以从 [shadcn 的主题](https://ui.shadcn.com/themes)或
[tweakcn](https://tweakcn.com) 导出的主题可以原样使用。`light` 设置浅色外观的值，`dark` 设置深色外观的值，`theme` 设置两者共用的值：

```json
{
  "cssVars": {
    "theme": {
      "radius": "0.5rem",
      "font-sans": "Inter, sans-serif"
    },
    "light": {
      "primary": "oklch(0.541 0.281 293.009)",
      "primary-foreground": "oklch(0.969 0.016 293.756)",
      "ring": "var(--primary)",
      "up": "#16a34a"
    },
    "dark": {
      "primary": "oklch(0.702 0.183 293.541)",
      "primary-foreground": "oklch(0.283 0.141 291.089)",
      "up": "#4ade80"
    }
  }
}
```

- 你的主题叠加在默认主题之上，只需列出要修改的部分。`light` 设置而 `dark` 省略的值在两种外观中都使用。
- 值按 CSS 的写法书写。颜色可以是任意 CSS 颜色（`#7c3aed`、`rgb(…)`、`hsl(…)`、`oklch(…)`、`white`）、
  `color-mix(in oklab, var(--primary) 80%, white)`，或同一外观的另一个令牌 `var(--primary)`（可带后备值：`var(--brand, #7c3aed)`）。
  长度使用 `rem`（16 点）或 `px`（点）。字体是字体族列表：使用其中第一个非通用的字体族，第一个是通用字体族（`system-ui`、`sans-serif`）时使用系统字体。
- **应用自己的令牌。** 其他任何名称都是应用的令牌，就像 Tailwind `@theme` 中的变量：上例的 `"up"` 在 Rust 中是 `theme().color("up")`，
  在类名中是 `bg-up` / `text-up/70`，在 TSX 中是 `token("up")`（[主题 token](./tailwind.md#主题-token)）。数值如 `"radius-card": "14px"`
  是 `theme().number("radius-card")` 和 `rounded-(--radius-card)`。
- 打包器在构建时检查主题：文件缺失、JSON 无效或不是 `cssVars` 格式的主题都会让构建失败，并报告 `nsh.json: theme: …` 错误。

令牌及其默认的浅色和深色值（shadcn 的 `neutral`）：

| 令牌 | `theme()` | 浅色 | 深色 | 用途 |
|---|---|---|---|---|
| `background` / `foreground` | `background` / `foreground` | `oklch(1 0 0)` / `oklch(0.145 0 0)` | `oklch(0.145 0 0)` / `oklch(0.985 0 0)` | 应用的背景，以及其上的文字 |
| `card` / `card-foreground` | `card` / `card_foreground` | `oklch(1 0 0)` / `oklch(0.145 0 0)` | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | 卡片等分组表面，以及其上的文字 |
| `popover` / `popover-foreground` | `popover` / `popover_foreground` | `oklch(1 0 0)` / `oklch(0.145 0 0)` | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | 弹出框、菜单和提示，以及其上的文字 |
| `primary` / `primary-foreground` | `primary` / `primary_foreground` | `oklch(0.205 0 0)` / `oklch(0.985 0 0)` | `oklch(0.922 0 0)` / `oklch(0.205 0 0)` | 主要操作（主按钮），以及其上的文字 |
| `secondary` / `secondary-foreground` | `secondary` / `secondary_foreground` | `oklch(0.97 0 0)` / `oklch(0.205 0 0)` | `oklch(0.269 0 0)` / `oklch(0.985 0 0)` | 次要操作，以及其上的文字 |
| `muted` / `muted-foreground` | `muted` / `muted_foreground` | `oklch(0.97 0 0)` / `oklch(0.556 0 0)` | `oklch(0.269 0 0)` / `oklch(0.708 0 0)` | 低调的表面；次要文字：说明、标签、占位符 |
| `accent` / `accent-foreground` | `accent` / `accent_foreground` | `oklch(0.97 0 0)` / `oklch(0.205 0 0)` | `oklch(0.269 0 0)` / `oklch(0.985 0 0)` | 悬停或高亮的项，例如菜单项、列表行，以及其文字 |
| `destructive` | `destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` | 破坏性操作和错误 |
| `border` | `border` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 10%)` | 分隔线和边框 |
| `input` | `input` | `oklch(0.922 0 0)` | `oklch(1 0 0 / 15%)` | 输入框的边框 |
| `ring` | `ring` | `oklch(0.708 0 0)` | `oklch(0.556 0 0)` | 焦点环 |
| `chart-1` … `chart-5` | `chart_1` … `chart_5` | `oklch(0.87 0 0)` … `oklch(0.269 0 0)` | 同浅色 | 图表的各个系列 |
| `sidebar`、`sidebar-foreground`、`sidebar-primary`、`sidebar-primary-foreground`、`sidebar-accent`、`sidebar-accent-foreground`、`sidebar-border`、`sidebar-ring` | `sidebar`、`sidebar_foreground` 等 | `sidebar` `oklch(0.985 0 0)`，`sidebar-primary` `oklch(0.205 0 0)` | `sidebar` `oklch(0.205 0 0)`，`sidebar-primary` `oklch(0.488 0.243 264.376)` | 侧边栏的表面、主要操作、高亮项、边框和焦点环 |
| `radius` | `radius` | `0.625rem`（10 点） | | 圆角 |
| `font-sans` | `font_sans` | 系统字体 | | 应用的字体：没有设置自己字体族的文字都使用它 |
| `font-mono` | `font_mono` | 系统等宽字体 | | 等宽字体：`font-mono`、`TextView` 中的代码 |

## 多个 crate

应用的 Rust 代码可以拆分成多个 crate，每个 crate 用自己的名称导入：`"rust"` 可以是 crate 路径的列表，列表中的每个 crate
都有自己的 `#[native_module]` 函数。

```json
{
  "rust": ["native/charts", "native/storage"],
  "root": "App"
}
```

```tsx
import { Chart } from "app/charts";        // native/charts：#[native_module("app/charts")]
import { Store } from "app/storage";       // native/storage：#[native_module("app/storage")]
```

每个运行器和宿主都链接全部这些 crate，`.nsh/types` 为每个名称生成声明。crate 之间通过 Cargo 路径依赖共享代码
（`shared = { path = "../shared" }`）：一个公司组件 crate 可以被多个 crate 使用、被多个应用列出，只有 `"rust"` 中列出的
crate 会导出给 TSX。列出的每个 crate 都有自己的包名和导入名称；重复时 `nsh` 会报告共用它的两个路径。Rust 应用的
`"root"` 是列出的第一个 crate 中的组件。`nsh run` 和 `nsh dev` 期间，修改其中任何一个 crate，或它们通过路径依赖的
crate，都会重新构建并重启应用。

## 在 Web 上使用浏览器 API

在 Web 上，crate 可以通过 wasm-bindgen 和 `web-sys` 调用浏览器的 API（WebSocket、`IndexedDB` 等）；`nsh`
会随运行时一起构建它们所需的胶水代码。见 [Web](./web.md#在-rust-中使用浏览器-api)。

## 另请参阅

- [项目结构](./project-structure.md)：`nsh.json` 的每个键。
- [Web](./web.md#带-rust-组件的应用)：浏览器中的 Rust 应用。
- [网络](./networking.md#在-rust-组件中)：在 Rust 中使用 `fetch`。
- [CLI](./cli.md#nsh-init)：`nsh init --template rust` 和 `--template mixed`。

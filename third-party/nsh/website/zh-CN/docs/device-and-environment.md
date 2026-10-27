---
title: 设备与环境
description: 读取窗口尺寸、配色方案、字体缩放、安全区域、平台、像素密度和布局方向，并在它们变化时作出响应。
order: 47
group: ui
demo: guide-device
---

# 设备与环境

应用运行时，所处的环境会不断变化：窗口改变尺寸（旋转、分屏、Mac 窗口），用户切换到深色模式或更大的字号，键盘出现又消失。NSH 把这些都以**响应式访问器**的形式提供：像 signal 一样调用它，读取了它的东西（样式、文本、计算值）就会在它变化时更新。不需要添加或移除监听器。

在 Rust 中，访问器是 `nsh_core::prelude` 中的函数；在 TSX 中，它们来自表中列出的模块。

| Rust | TSX | 值 |
|---|---|---|
| `window()` | `windowSize()`（`nsh`） | surface 的宽和高，单位为点。 |
| `dark()` | `colorScheme()`（`nsh`） | 深色或浅色：系统的外观，或应用自己设置的外观（`set_color_scheme`、`setColorScheme`）。 |
| `font_scale()` | `fontScale()`（`nsh`） | 用户偏好的文字大小相对于默认值的比例（1 为默认）。 |
| `safe_area()` | `safeArea()`（`nsh`） | surface 中未被系统 UI 遮挡的 inset：上、右、下、左。 |
| `cx.insets()` | `safeAreaInsets()`（`nsh`） | 调用组件渲染位置（页面、对话框）的 inset。 |
| `keyboard_height()`、`keyboard_duration()` | `keyboardFrame()`（`nsh`） | 软键盘的高度和动画时长。 |
| `locale()` | `locale()`（`nsh`） | 用户的区域设置，BCP 47 标签（`"en-US"`、`"zh-Hans-CN"`）：`Intl` 默认按它格式化。 |
| `reduce_motion()`、`screen_reader()` | `reduceMotion()`、`screenReaderEnabled()`（`nsh`） | 见[无障碍](./accessibility.md)。 |

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    view()
        .flex_1()
        .pt(move || safe_area().top + px(16.0))
        .px(px(16.0))
        // 一个浅色值和一个深色值：颜色在原生层跟随外观。
        .bg(AdaptiveColor::rgb(0xffffff, 0x0d1117))
        .child(
            text(move || {
                let size = window();
                format!(
                    "{} × {} pt, text at {:.2}×",
                    size.width.0.round(),
                    size.height.0.round(),
                    font_scale()
                )
            })
            .text_color(AdaptiveColor::rgb(0x1f2328, 0xe6edf3)),
        )
}
```

```tsx tabs
import { mount, Text, View, safeArea } from "nsh";
import { colorScheme, fontScale, windowSize } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, paddingTop: safeArea().top + 16, paddingHorizontal: 16, backgroundColor: colorScheme() === "dark" ? "#0d1117" : "#ffffff" }}>
      <Text style={{ color: colorScheme() === "dark" ? "#e6edf3" : "#1f2328" }}>
        {Math.round(windowSize().width)} × {Math.round(windowSize().height)} pt, text at {fontScale().toFixed(2)}×
      </Text>
    </View>
  );
}

mount(App);
```

## 窗口尺寸与响应式布局

`window()`（TSX：`windowSize()`）是 NSH 渲染目标 surface 的尺寸：手机上是屏幕，iPad 分屏或 Mac 上是窗口，嵌入时是宿主视图。用它来改变布局，而不只是改变尺寸：

```rust tabs
use nsh_core::prelude::*;

fn gallery() -> impl IntoElement {
    let columns = || {
        let width = window().width.0;
        if width >= 700.0 { 4.0 } else if width >= 500.0 { 3.0 } else { 2.0 }
    };
    let side = move || px((window().width.0 - 32.0 - (columns() - 1.0) * 8.0) / columns());
    view().flex_row().flex_wrap().gap_2().child(each(
        photos,
        |p| p.id,
        move |p, _| image(move || p.with(|p| p.url.clone())).w(side).aspect_ratio(1.0),
    ))
}
```

```tsx tabs
import { Image, View } from "nsh";
import { windowSize } from "nsh";

function Gallery() {
  const columns = () => (windowSize().width >= 700 ? 4 : windowSize().width >= 500 ? 3 : 2);
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <Each of={photos}>
        {(p) => <Image src={p().url} style={{ width: (windowSize().width - 32 - (columns() - 1) * 8) / columns(), aspectRatio: 1 }} />}
      </Each>
    </View>
  );
}
```

很多时候 flexbox、百分比和 `aspect_ratio`（`aspectRatio`）就能完成任务，根本不需要读取尺寸；见[布局](./layout.md)。Rust 中 `style_when(|| window().width.0 >= 640.0, |s| s.flex_row())` 随宽度切换样式；TSX 中使用 Tailwind 时，断点变体（`sm:`、`md:`、`lg:`、`xl:`、`2xl:`、`max-*:`、`min-[…]:`）和 `portrait:` / `landscape:` 同样跟随窗口：`class="grid grid-cols-2 md:grid-cols-4"`。

## 深色模式

外观跟随系统，除非应用设置了自己的外观。在 Rust 中，支持深色模式最简单的方法是带有浅色值和深色值的颜色 `AdaptiveColor::rgb(light, dark)`：外观变化时它在原生层切换，无需运行任何代码。在 TSX 中则是 Tailwind 的 `dark:` 变体，它在 `colorScheme()` 为 `"dark"` 时生效：

```rust tabs
view()
    .flex_1()
    .p_4()
    .bg(AdaptiveColor::rgb(0xffffff, 0x18181b))
    .child(
        text("Follows the system appearance")
            .text_color(AdaptiveColor::rgb(0x18181b, 0xf4f4f5)),
    )
```

```tsx tabs
<View class="flex-1 bg-white dark:bg-zinc-900 p-4">
  <Text class="text-zinc-900 dark:text-zinc-100">Follows the system appearance</Text>
</View>
```

其他情况下，在闭包或计算值中读取 `dark()`（TSX：`colorScheme()`）；在 TSX 中颜色较多时，先统一派生出一套调色板：

```rust tabs
use nsh_core::prelude::*;

// `dark()` 是响应式的：外观变化时闭包重新运行。
view()
    .flex_1()
    .bg(move || if dark() { rgb(0x0d1117) } else { rgb(0xf6f8fa) })
    .child(text("Hello"))
```

```tsx tabs
import { computed, Text, View } from "nsh";
import { colorScheme } from "nsh";

const palette = computed(() =>
  colorScheme() === "dark"
    ? { background: "#0d1117", surface: "#161b22", text: "#e6edf3", muted: "#8b949e" }
    : { background: "#f6f8fa", surface: "#ffffff", text: "#1f2328", muted: "#57606a" },
);

<View style={{ flex: 1, backgroundColor: palette().background }}>
  <Text style={{ color: palette().text }}>Hello</Text>
</View>
```

Rust 组件也从主题中取色，主题为每种颜色提供浅色和深色两个值（`nsh.json` 的 `"theme"`，见[用 Rust 开发](./rust.md)），所以它们也会随系统切换。要让状态栏与背景相配，为页面和对话框设置 [`statusBar`](../modules/nsh-base.md#status-bar)，或在 `nsh.json` 中为应用设置。

### 应用自己的外观

始终使用深色（或始终使用浅色）的应用在 `nsh.json` 中声明，`dark()` 和 `colorScheme()`、自适应颜色、`dark:` 类、主题、状态栏的默认样式和提示框从第一帧起就跟随它（打包后的应用启动时也是这个外观）：

```json
{ "appearance": "dark" }
```

`set_color_scheme(Appearance::Dark)`（TSX：`nsh` 中的 `setColorScheme`）在运行时修改它，用于应用内的外观设置；`Appearance::System`（`"system"`）恢复跟随系统：

```rust tabs
use nsh_core::prelude::*;

view()
    .on_press(move || {
        set_color_scheme(if dark() { Appearance::Light } else { Appearance::Dark })
    })
    .role(AccessibilityRole::Button)
    .rounded_lg()
    .px_4()
    .py_2()
    .bg(AdaptiveColor::rgb(0xe5e5e5, 0x262626))
    .child(
        text(|| if dark() { "Light" } else { "Dark" })
            .text_color(AdaptiveColor::rgb(0x171717, 0xfafafa)),
    )
```

```tsx tabs
import { Text, View } from "nsh";
import { colorScheme, setColorScheme } from "nsh";

<View onPress={() => setColorScheme(colorScheme() === "dark" ? "light" : "dark")} role="button" class="rounded-lg px-4 py-2 bg-neutral-200 dark:bg-neutral-800">
  <Text class="text-neutral-900 dark:text-neutral-50">{colorScheme() === "dark" ? "Light" : "Dark"}</Text>
</View>
```

> [!TIP]
> 开发时两种外观都要测试：`xcrun simctl ui booted appearance dark` 可以切换 iOS 模拟器，Android 的快捷设置里有深色主题开关。变化会立即传到应用中，无需重新加载。

## 文字大小

`font_scale()`（TSX：`fontScale()`）是用户的文字大小设置（iOS 的动态字体，Android 的字体大小）相对于默认值的比例。文本和输入框会自动跟随：当用户要求更大的文字时，`fontSize: 16` 会渲染得更大。可以针对单个元素关闭或设置上限：

| Rust（`text` 和 `input`） | TSX（`<Text>` 和 `<Input>`） | 默认值 | 说明 |
|---|---|---|---|
| `.allow_font_scaling(..)` | `allowFontScaling` | `true` | 跟随系统文字大小。 |
| `.max_font_size_multiplier(..)` | `maxFontSizeMultiplier` | `0`（无上限） | 应用于该文本的最大缩放。 |

```rust tabs
text("Today")
    .text_size(px(34.0))
    .font_weight(FontWeight::BOLD)
    .max_font_size_multiplier(1.4)
```

```tsx tabs
<Text style={{ fontSize: 34, fontWeight: "700" }} maxFontSizeMultiplier={1.4}>Today</Text>
```

对于不会自动跟随文字的布局，读取 `font_scale()` 来调整，例如文字变大时把横排改为竖排：Rust 中 `.style_when(|| font_scale() > 1.3, |s| s.flex_col())`，TSX 中 `flexDirection: fontScale() > 1.3 ? "column" : "row"`。

文字大小缩放的是文字：所有允许字体缩放的 `<Text>` 和 `<Input>`，以及平台的提示框和 toast。长度保持原样：间距、宽高、圆角、边框和图片，无论写成点数还是类名（`p-4`、`rounded-lg`、`w-[2rem]`）。按内容决定大小的盒子会随文字一起变大。

## 语言和地区

`locale()` 是用户的区域设置，形式为 BCP 47 标签（Rust 中为 `locale().as_str()`）。在 TSX 中，`Intl` 默认按它格式化数字和日期，所以 `new Intl.NumberFormat().format(1234.5)` 在 `en-US` 下得到 `1,234.5`，在 `de-DE` 下得到 `1.234,5`。读取 `locale()` 来选择你自己的翻译文案：读取它的文字会在它变化时更新。

```rust tabs
use nsh_core::prelude::*;

fn greeting() -> &'static str {
    match locale().as_str().split('-').next() {
        Some("de") => "Willkommen",
        Some("zh") => "欢迎",
        _ => "Welcome",
    }
}

text(greeting)
```

```tsx tabs
import { Text } from "nsh";
import { locale } from "nsh";

const greetings: Record<string, string> = { en: "Welcome", de: "Willkommen", zh: "欢迎" };

<Text>{greetings[locale().split("-")[0]] ?? greetings.en}</Text>
```

## 在嵌入它的应用中

嵌入在原生应用中的 NSH 应用，会跟随宿主应用自己设置的语言和文字大小：嵌入 API 设置的语言和文字大小（Rust 中 [GPUI](./gpui.md)、[macOS](./macos.md)、[Linux](./linux.md) 和 [Windows](./windows.md) 的 `AppView::set_locale` 和 `set_font_scale`，[iOS](./ios.md) 上 Swift 的 `locale` 和 `fontScale`，[Android](./android.md) 上 Java 的 `setLocale` 和 `setFontScale`）代替系统的语言和文字大小。`locale()`、`Intl`、`fontScale()` 和文字会立即跟随，就像跟随系统设置的变化一样；宿主清除设置后恢复为系统的值。原生应用允许用户选择自己的语言或文字大小时使用它们。

## 安全区域

刘海、Home 指示条、状态栏、Android 导航栏以及 Mac Catalyst 的标题栏会遮挡 surface 的一部分。NSH 应用在所有平台上都是全屏绘制，被遮挡的部分以 inset 的形式提供。

- `safe_area()`（TSX：`safeArea()`）给出整个 surface 的 inset。
- 组件的 `cx.insets()`（TSX：`safeAreaInsets()`）给出**组件渲染位置**的 inset：在导航[页面](./navigation.md#标题栏下的安全区域)中从标题栏下方算起，在[对话框](../elements/dialog.md)中是对话框自己的。可能出现在多个地方的组件应该优先用它。
- CSS 的 `env(safe-area-inset-top)`、`-right`、`-bottom`、`-left` 在 `padding*` 和 `margin*` 中按组件渲染处的 inset 为任意视图加内边距或外边距（`calc(env(safe-area-inset-bottom) + 8px)` 再加一段长度；Tailwind `pt-[env(safe-area-inset-top)]`；Rust `.p_safe_area()`、`.pt_safe_area()`、`.pb_safe_area_plus(px(8.0))` 等）。inset 变化时内边距原生更新（[安全区域](../elements/safe-area.md)）。

```rust tabs
use nsh_core::prelude::*;

fn screen() -> impl IntoElement {
    view()
        .pt_safe_area()
        .px_safe_area()
        .flex_1()
        .bg(white())
        .child(content())
        .child(bottom_bar())
}

// 一个组件，为了它的 `Scope`：组件渲染位置的 inset。
#[component]
fn BottomBar(cx: Scope<NoEvent>) -> impl IntoElement {
    // `cx.insets()`：组件渲染位置的 inset。
    view()
        .flex_row()
        .pt(px(8.0))
        .pb(move || cx.insets().bottom + px(8.0))
}
```

```tsx tabs
import { View, safeAreaInsets } from "nsh";

function Screen() {
  return (
    <View class="flex-1 bg-white pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
      <Content />
      <BottomBar />
    </View>
  );
}

function BottomBar() {
  const insets = safeAreaInsets();
  return <View style={{ paddingBottom: insets().bottom + 8, paddingTop: 8, flexDirection: "row" }}>…</View>;
}
```

在 Android 上，嵌入在工具栏下方的视图只会得到与它重叠的那部分系统栏，与 UIKit 的安全区域一致：如果它没有延伸到状态栏，顶部 inset 就为 0。

## 平台

Rust 中的 `os()`、`os_version()`、`idiom()` 和 `is_desktop()`，以及 TSX 中 `nsh` 的常量 `platform`，描述应用运行的平台。它们在应用运行期间保持不变。

| Rust | TSX | 说明 |
|---|---|---|
| `os()` | `platform.os` | `Os::Ios`、`Os::Android`、`Os::MacOs`、`Os::Windows`、`Os::Linux` 或 `Os::Web`（`os().name()` 即 TSX 的字符串）。Mac Catalyst 为 iOS。 |
| `os_version()` | `platform.version` | 主版本号和次版本号；Android 上为 API 级别和 0。 |
| `idiom()` | `platform.idiom`、`platform.catalyst` | `Idiom::Phone`、`Pad`、`Mac`、`Tv` 或 `Desktop`。 |
| `is_desktop()` | `platform.idiom === "desktop" && !platform.isTerminal` | macOS、Windows 或 Linux，或桌面浏览器。 |

TSX 的 `platform` 完整成员：

| 成员 | 说明 |
|---|---|
| `platform.os` | `"ios"`、`"android"`、`"macos"`、`"windows"`、`"linux"` 或 `"web"`。Mac Catalyst 报告 `"ios"`。 |
| `platform.version` | 字符串：iOS 和桌面平台为系统版本（`"17.5"`）；Android 为 API 级别（`"35"`）；Web 为 `"0.0"`。 |
| `platform.idiom` | `"phone"`、`"pad"`、`"mac"`、`"tv"` 或 `"desktop"`。`"desktop"` 表示桌面设备类型：macOS、Windows、Linux 和桌面浏览器。用 `renderer` 区分终端呈现。 |
| `platform.catalyst` | Mac 界面风格的 Mac Catalyst。 |
| `platform.select(spec)` | 当前平台对应的值；见[平台特定代码](./platform-specific.md#platformselect)。 |
| `platform.renderer` | `"native"`（平台视图或桌面图形）、`"web"`（浏览器 HTML）或 `"terminal"`（终端字符单元格）。 |
| `platform.isTerminal` | 界面渲染为终端字符单元格；`platform.os` 仍为宿主操作系统。 |

```rust tabs
use nsh_core::{element::Os, prelude::*};

let haptics_supported = os() == Os::Ios || (os() == Os::Android && os_version().0 >= 30);
```

```tsx tabs
import { platform } from "nsh";

const hapticsSupported = platform.os === "ios" || (platform.os === "android" && Number(platform.version) >= 30);
```

`nsh test` 以 iOS 身份无界面运行。

在 [Linux](./linux.md) 上，`platform.os` 为 `"linux"`，界面风格为 `"desktop"`，`platform.version` 为内核的主、次版本号（`"6.12"`）：
各发行版给版本编号的方式无法相互比较。在那里，安全区域和键盘高度为 0，`colorScheme()` 实时跟随桌面的设置（XDG 设置门户），
`fontScale()` 跟随桌面的文字缩放，`pixelRatio()` 跟随显示器的缩放比例（包括小数缩放）。

在 [macOS](./macos.md)（AppKit 后端）上，`platform.os` 为 `"macos"`，界面风格为 `"desktop"`，
`platform.version` 为 macOS 的版本号。安全区域和键盘高度为 0，`colorScheme()` 实时跟随系统外观，`fontScale()` 为 1，
`pixelRatio()` 为显示器的缩放比例（backing scale）。

在 [Windows](./windows.md) 上，`platform.os` 为 `"windows"`，界面风格为 `"desktop"`，`platform.version` 为 `"10.0"`，Windows 11
上也是如此（Windows 沿用了这个版本号）。安全区域和键盘高度为 0，`colorScheme()` 实时跟随“设置 > 个性化 > 颜色”，`fontScale()`
跟随“文本大小”设置（1 到 2.25），`reduceMotion()` 跟随“动画效果”设置，`pixelRatio()` 为显示器的缩放比例，`Intl`
按用户的区域格式进行格式化。

在浏览器中（[Web 运行时](./web.md)），`platform.os` 为 `"web"`，`platform.version` 为 `"0.0"`。有鼠标且窗口宽度至少 600 点时界面风格为
`"desktop"`，平板上为 `"pad"`，手机上为 `"phone"`，在应用启动时确定。区域设置、`reduceMotion()`、
`fontScale()`（浏览器的文字大小）、`pixelRatio()`、安全区域和键盘高度都来自浏览器，并实时跟随。

## 像素密度

Rust 中的 `pixel_ratio()` 和 `round_to_nearest_pixel(points)`，以及 TSX 中 `nsh` 的 `pixelRatio()`，在点与设备像素之间换算。

| Rust | TSX | 说明 |
|---|---|---|
| `pixel_ratio()` | `pixelRatio()` | 每个点对应的设备像素数（大多数手机为 2 或 3），响应式。 |
| `round_to_nearest_pixel(points)` | `Math.round(x * pixelRatio()) / pixelRatio()` | 把点数取整到最近的设备像素。 |

一条一个设备像素高的细线：

```rust tabs
view()
    .h(move || px(1.0 / pixel_ratio()))
    .bg(rgb(0xd0d7de))
```

```tsx tabs
import { View } from "nsh";
import { pixelRatio } from "nsh";

<View style={{ height: 1 / pixelRatio(), backgroundColor: "#d0d7de" }} />
```

`pixel_ratio()` 和 `pixelRatio()` 都是响应式的，窗口被移到另一块密度不同的屏幕上时，细线会随之调整。

## 从右到左

当设备语言是从右到左书写的（阿拉伯语、希伯来语、波斯语等），NSH 会从右到左布局应用：横排从右侧开始，`left` 和 `right` 样式属性互换，文字右对齐，原生控件镜像显示。布局方向自动跟随用户的语言。视图的 `direction` 样式（`"ltr"`、`"rtl"` 或 `"inherit"`；Rust 中为 `.direction(LayoutDirection::..)`）设置其子树的方向；设在根视图上即设置整个应用的方向。

修改会立即生效，无需重启应用；本页的演示就在切换 `direction` 样式。

用逻辑属性编写两个方向都适用的布局：Rust 中的 `ms` / `me` 和 `ps` / `pe`（与 Tailwind 同名），TSX 中的 `marginStart` / `marginEnd`、`paddingStart` / `paddingEnd`、`start` / `end`、`borderTopStartRadius` 等，它们在从左到右布局中表示左和右，从右到左时则相反。`left` 和 `right` 本身也会互换。`direction` 样式（`"inherit"`、`"ltr"`、`"rtl"`）可以为子树覆盖方向，例如让电话号码或播放器控件保持从左到右。Tailwind 的 `rtl:` 和 `ltr:` 变体按方向生效。

在从右到左布局中，横向滚动视图和列表从最右端开始。在 Android 上，宿主应用必须在清单中声明 `android:supportsRtl="true"`，原生控件才会镜像。

## 相关内容

- [`nsh` 的设备 API](../modules/nsh.md#device)：参考。
- [平台特定代码](./platform-specific.md)：`platform.select`、平台属性与模块。
- [无障碍](./accessibility.md)：屏幕阅读器与减少动态效果。
- [安全区域](../elements/safe-area.md)、[键盘](../elements/keyboard.md)与[状态栏](../modules/nsh-base.md#status-bar)。
- [Tailwind](./tailwind.md)：`dark:`、断点与方向变体。

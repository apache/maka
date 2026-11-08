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
| `locale_settings()` | `localeSettings()`（`nsh`） | 用户的语言与地区设置：偏好语言、时区、12 小时制或 24 小时制、每周的第一天、度量单位和温度单位（[语言与地区设置](#语言与地区设置)）。 |
| `lifecycle()` | `lifecycle()`（`nsh`） | 应用是否正在使用：`active`、`inactive`（可见但没有焦点）或 `background`（[在后台](#在后台)）。 |
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

`locale()` 是用户的区域设置，形式为 BCP 47 标签（Rust 中为 `locale().as_str()`）。在 TSX 中，`Intl` 默认按它格式化数字和日期，所以 `new Intl.NumberFormat().format(1234.5)` 在 `en-US` 下得到 `1,234.5`，在 `de-DE` 下得到 `1.234,5`。读取它的地方会在它变化时更新。

应用自己在各语言下的文字来自它的翻译：`t("hello")`（`nsh/i18n`；Rust 中为 `t!("hello")`）以用户的语言显示一个 key，`setLocale` 让应用显示另一种语言。见 [I18n](./i18n.md)。

```rust tabs
use nsh_core::prelude::*;

text(move || t!("welcome"))
```

```tsx tabs
import { Text } from "nsh";
import { t } from "nsh/i18n";

<Text>{t("welcome")}</Text>
```

## 语言与地区设置

`locale_settings()`（TSX：`localeSettings()`）给出用户为语言和地区所做的其他设置：偏好语言、设备的时区，以及用户如何读时间、星期和度量。系统把这些放在一起保存（iPhone 和 Mac 上的“语言与地区”、Android 的语言和地区偏好、Windows 的“时间和语言”），并常常一次改动好几项，所以它们作为一个值给出，其中任何一项变化时，读取它的地方都会更新。它的名称和取值都是 `Intl` 的，可以直接传入 `Intl` 的选项。

只想跟随其中一项时，通过 `computed` 读取它：读取它的地方只在这一项变化时更新，用户去了另一个时区或添加了一种语言时不会更新。

```rust tabs
use nsh_core::prelude::*;

// 只在用户切换 12 小时制和 24 小时制时更新。
let twelve_hour = computed(|| locale_settings().hour_cycle.twelve_hour());
text(move || if twelve_hour.get() { "3:00 PM" } else { "15:00" })
```

```tsx tabs
import { Text } from "nsh";
import { computed, localeSettings } from "nsh";

// 只在用户切换 12 小时制和 24 小时制时更新。
const twelveHour = computed(() => ["h11", "h12"].includes(localeSettings().hourCycle));

<Text>{twelveHour() ? "3:00 PM" : "15:00"}</Text>
```

测试中，`open` 的 `localeSettings` 设置其中列出的项，其余的是区域设置的（区域设置本身作为偏好语言、所在地区的偏好、UTC）；`app.setLocaleSettings({ hourCycle: "h23" })` 修改其中列出的项，其余的保持不变（[测试](./testing-and-trace.md#操作步骤)）。

### 偏好语言

`languages` 是用户的偏好语言列表，按偏好从高到低排列，BCP 47 标签：系统的列表（手机设置中的语言列表、桌面的界面语言、Web 上浏览器的语言）。应用的文字以其中第一个有翻译的语言显示，并沿列表回退：偏好瑞士德语、然后德语、然后英语的用户，在一个有德语和英语的应用中看到德语文字。`t`（`nsh/i18n`）就是这样选择的（[I18n](./i18n.md)）。`locale()` 是另一回事，它是数字和日期遵循的区域格式，可以是另一种（英文文字、德国日期）。列表从不为空，用户修改它时，读取它的地方会随之更新。

显示在原生应用中、且该应用设置了自己语言的应用，会把那个语言排在最前。

### 地区偏好

除了语言，系统还保存几项用户如何读时间、星期和度量的设置（iPhone 和 Mac 上的“语言与地区”、Android 的地区偏好、Windows 的“区域”）：

- `hour_cycle`（TSX：`hourCycle`）：12 小时制或 24 小时制，用 `Intl` 对小时周期的命名：`h12`（`12:30 PM`）、`h23`（`00:30`），以及较少见的 `h11`（`0:30 PM`）和 `h24`（`24:30`）。
- `first_day_of_week`（TSX：`firstDayOfWeek`）：每周从哪一天开始，即日历的第一列；TSX 按 ISO 8601 编号，1 是星期一，7 是星期日。
- `measurement_system`（TSX：`measurementSystem`）：`metric`（公制）、`us`（英尺、英里、磅、加仑）或 `uk`（公制，但距离用英里、容量用品脱）。
- `temperature_unit`（TSX：`temperatureUnit`）：`celsius` 或 `fahrenheit`。

用户做了设置时，各项是系统的设置，否则是所在地区自己的（按 Unicode CLDR 的数据：美国是 12 小时制、每周从星期日开始，德国是 24 小时制、每周从星期一开始）。

```rust tabs
use nsh_core::{platform::TemperatureUnit, prelude::*};

/// 一个摄氏温度，用用户的单位书写。
fn temperature(celsius: f32) -> String {
    match locale_settings().temperature_unit {
        TemperatureUnit::Celsius => format!("{celsius:.0} °C"),
        TemperatureUnit::Fahrenheit => format!("{:.0} °F", celsius * 9.0 / 5.0 + 32.0),
    }
}

/// 从用户的第一天开始的日历列：1 是星期一，7 是星期日。
fn week_columns() -> [u8; 7] {
    let first = locale_settings().first_day_of_week.number();
    std::array::from_fn(|i| (first - 1 + i as u8) % 7 + 1)
}
```

```tsx tabs
import { localeSettings } from "nsh";

const time = (date: Date) =>
  date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hourCycle: localeSettings().hourCycle });

const temperature = (celsius: number) =>
  localeSettings().temperatureUnit === "fahrenheit"
    ? `${Math.round((celsius * 9) / 5 + 32)} °F`
    : `${Math.round(celsius)} °C`;

// 从用户的第一天开始的日历列：1 是星期一，7 是星期日。
const weekColumns = () =>
  Array.from({ length: 7 }, (_, i) => ((localeSettings().firstDayOfWeek - 1 + i) % 7) + 1);
```

`Intl` 按区域设置自己的小时周期书写时间：像上面那样把 `hourCycle` 作为它的 `hourCycle` 选项传入，就能按用户的习惯书写。在 Web 上，浏览器不提供这些用户设置：小时周期和每周的第一天是浏览器按其语言给出的，单位是其地区的。

基础组件显示应用传给它们的值，用它们自己的形式。`Calendar` 和 `DatePicker` 的 `firstDayOfWeek` 从 `0`（星期日）到 `6`（星期六）给星期编号：用户的第一天是 `localeSettings().firstDayOfWeek % 7`（Rust：`locale_settings().first_day_of_week.number() % 7`）。`TimeField` 和 `DatePicker` 的 `hourCycle` 是 `"h12"` 或 `"h23"`：`localeSettings().hourCycle` 为 `"h11"` 或 `"h12"` 时用户的是 `"h12"`，否则是 `"h23"`（Rust：`locale_settings().hour_cycle.twelve_hour()` 时为 `HourCycle::H12`）。

### 时区

`time_zone`（TSX：`timeZone`）是设备的时区，即系统给它的名称：`Europe/Berlin`、`America/New_York` 这样的 IANA 名称、`UTC`，或系统使用偏移量时区时的名称（Android 上的 `GMT+01:00`）。用户修改设置或设备到了另一个时区时它会变化，读取它的地方随之更新：标出时区的时钟、按用户时区显示的时间列表、和创建时所在时区一起保存的日期。

```rust tabs
use nsh_core::prelude::*;

text(move || format!("Times in {}", locale_settings().time_zone))
```

```tsx tabs
import { Text } from "nsh";
import { localeSettings } from "nsh";

<Text>{`Times in ${localeSettings().timeZone}`}</Text>
```

`Date` 的本地时间一如既往地跟随系统时区：`time_zone` 给出它的名称。`Intl` 也按这个时区格式化本地时间，给出的名称与它相同：`Intl.DateTimeFormat().resolvedOptions().timeZone` 就是 `localeSettings().timeZone`，`{ timeZone: localeSettings().timeZone }` 按本地时间格式化。测试中，`localeSettings()` 给出的是 `open` 或 `app.setLocaleSettings` 设置的时区（否则是 `UTC`）；`Date` 和 `Intl` 的本地时间仍是这台机器的，`Intl` 给出的也是这台机器的时区。

## 在嵌入它的应用中

嵌入在原生应用中的 NSH 应用，会跟随宿主应用自己设置的语言和文字大小：嵌入 API 设置的语言和文字大小（Rust 中 [GPUI](./gpui.md)、[macOS](./macos.md)、[Linux](./linux.md) 和 [Windows](./windows.md) 的 `AppView::set_locale` 和 `set_font_scale`，[iOS](./ios.md) 上 Swift 的 `locale` 和 `fontScale`，[Android](./android.md) 上 Java 的 `setLocale` 和 `setFontScale`）代替系统的语言和文字大小。`locale()`、`localeSettings()` 的偏好语言（宿主应用的语言排在最前）、`Intl`、`fontScale()` 和文字会立即跟随，就像跟随系统设置的变化一样；宿主清除设置后恢复为系统的值。原生应用允许用户选择自己的语言或文字大小时使用它们。

## 在后台

`lifecycle()`（TSX 中同名）表示用户是否正在使用应用。应用在前台时为 `active`；仍可见但焦点在另一个应用或窗口上（或系统在它上面显示了内容：应用切换器、来电）时为 `inactive`；不可见时为 `background`：手机上在后台、桌面上已最小化、Web 上是隐藏的标签页。与所有访问器一样，它会更新读取它的地方，因此 effect 可以在后台暂停实时数据、轮询或视频，并在用户回来时恢复：

```rust tabs
effect(move || {
    if lifecycle() == Lifecycle::Background {
        feed.pause();
    } else {
        feed.resume();
    }
});
```

```tsx tabs
effect(() => {
  if (lifecycle() === "background") feed.pause();
  else feed.resume();
});
```

用 `background` 暂停工作，并在用户做出更改时就保存它：系统可能在应用进入后台几秒后就将其挂起，早于读取这一变化的副作用运行。显示在原生应用中的应用跟随该应用的状态；应用有多个窗口时（iPad、桌面），视图跟随它所在的窗口。在测试中，`nsh/test` 的 `app.setLifecycle("background")` 会把应用移到后台（[测试](./testing-and-trace.md#操作步骤)）。

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

Rust 中的 `os()`、`os_version()`、`idiom()`、`is_desktop()` 和 `is_catalyst()`，以及 TSX 中 `nsh` 的常量 `platform`，描述应用运行的平台。它们在应用运行期间保持不变。

| Rust | TSX | 说明 |
|---|---|---|
| `os()` | `platform.os` | `Os::Ios`、`Os::Android`、`Os::MacOs`、`Os::Windows`、`Os::Linux` 或 `Os::Web`（`os().name()` 即 TSX 的字符串）。Mac Catalyst 为 iOS。 |
| `os_version()` | `platform.version` | 主版本号和次版本号；Android 上为 API 级别和 0。 |
| `idiom()` | `platform.idiom` | `Idiom::Phone`、`Pad`、`Mac`、`Tv`、`Desktop` 或 `Terminal`；在终端中为 `Terminal`，否则 `is_desktop()` 成立时恰好是 `Desktop`。 |
| `is_desktop()` | `platform.desktop` | macOS、Windows 或 Linux、桌面浏览器或终端（[桌面与移动端](./platform-specific.md#桌面与移动端)）。 |
| `is_catalyst()` | `platform.catalyst` | Mac Catalyst，无论哪种界面风格。 |

TSX 的 `platform` 完整成员：

| 成员 | 说明 |
|---|---|
| `platform.os` | `"ios"`、`"android"`、`"macos"`、`"windows"`、`"linux"` 或 `"web"`。Mac Catalyst 报告 `"ios"`。 |
| `platform.version` | 字符串：iOS 和桌面平台为系统版本（`"17.5"`）；Android 为 API 级别（`"35"`）；Web 为 `"0.0"`。 |
| `platform.idiom` | `"phone"`、`"pad"`、`"mac"`、`"tv"`、`"desktop"` 或 `"terminal"`。在终端中为 `"terminal"`，否则 `platform.desktop` 为 `true` 时恰好是 `"desktop"`。`"mac"` 是 Mac Catalyst 下 UIKit 的 Mac 界面风格，属于移动端界面风格。 |
| `platform.desktop` | 适用桌面行为：macOS、Windows、Linux、桌面浏览器和终端。`desktop={{…}}` 属性和 `platform.select({ desktop })` 以它为准。 |
| `platform.catalyst` | 应用运行在 Mac Catalyst 下（`os` 为 `"ios"`），无论是 Mac 还是 iPad 界面风格。 |
| `platform.select(spec)` | 当前平台对应的值；见[平台特定代码](./platform-specific.md#platformselect)。 |

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
`"desktop"`，平板上为 `"pad"`，手机上为 `"phone"`，在应用启动时确定。区域设置、`localeSettings()`（浏览器的首选语言、浏览器按其语言给出的地区偏好和它的时区）、`lifecycle()`（标签页隐藏时为
`"background"`，失去焦点时为 `"inactive"`）、`reduceMotion()`、`fontScale()`（浏览器的文字大小）、`pixelRatio()`、
安全区域和键盘高度都来自浏览器，并实时跟随。

在终端中（[终端后端](./tui.md)），`platform.idiom` 为 `"terminal"`，`platform.desktop` 为 `true`，`platform.os` 是本机自己的系统。
`colorScheme()` 跟随终端的背景色，`reduceMotion()` 为 `true`，安全区域和键盘高度为 0。

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

当设备语言是从右到左书写的（阿拉伯语、希伯来语、波斯语等），NSH 会从右到左布局应用：横排从右侧开始，逻辑样式属性取从右到左时的那一侧，文字右对齐，原生控件镜像显示。布局方向自动跟随用户的语言。视图的 `direction` 样式（`"ltr"`、`"rtl"` 或 `"inherit"`；Rust 中为 `.direction(LayoutDirection::..)`）设置其子树的方向；设在根视图上即设置整个应用的方向。

修改会立即生效，无需重启应用；本页的演示就在切换 `direction` 样式。

用逻辑属性编写两个方向都适用的布局：Rust 中的 `ms` / `me` 和 `ps` / `pe`（与 Tailwind 同名），TSX 中的 `marginStart` / `marginEnd`、`paddingStart` / `paddingEnd`、`start` / `end`、`borderTopStartRadius`、`textAlign: "start"` 等，它们在从左到右布局中表示左和右，从右到左时则相反。`left` 和 `right`（`marginLeft`、`paddingRight`、`left`、`textAlign: "left"` 等）在两个方向上都保持各自的一侧，与 CSS 相同。`direction` 样式（`"inherit"`、`"ltr"`、`"rtl"`）可以为子树覆盖方向，例如让电话号码或播放器控件保持从左到右。Tailwind 的 `rtl:` 和 `ltr:` 变体按方向生效。

在从右到左布局中，横向滚动视图和列表从最右端开始。在 Android 上，宿主应用必须在清单中声明 `android:supportsRtl="true"`，原生控件才会镜像。

## 相关内容

- [`nsh` 的设备 API](../modules/nsh.md#device)：参考。
- [平台特定代码](./platform-specific.md)：`platform.select`、平台属性与模块。
- [无障碍](./accessibility.md)：屏幕阅读器与减少动态效果。
- [安全区域](../elements/safe-area.md)、[键盘](../elements/keyboard.md)与[状态栏](../modules/nsh-base.md#status-bar)。
- [Tailwind](./tailwind.md)：`dark:`、断点与方向变体。

---
title: nsh/device
description: 窗口尺寸、配色方案、字体缩放、区域设置、平台信息、像素密度、布局方向，以及在应用之外打开 URL。
order: 6
---

# nsh/device

设备 API 向应用提供设备及其环境的信息。Rust 代码调用 `nsh_core::ui::prelude` 中的函数（`window()`、`dark()`、`font_scale()`、`locale()`、`os()`、`idiom()`、`pixel_ratio()`、`set_color_scheme()` 等）；TSX 导入 `nsh/device`。窗口尺寸、配色方案、字体缩放、像素密度和区域设置是响应式的：在绑定（Rust 中传给元素的闭包，TSX 中的 JSX）、`computed` 或 `effect` 中读取它们，平台报告变化（旋转、窗口缩放、切换深色模式、修改文字大小或语言、移到另一种像素密度的屏幕）时，读取它们的地方会随之更新。

```rust tabs
use nsh_core::{
    platform::{Appearance, Idiom, Os},
    ui::prelude::*, // window、dark、font_scale、locale、os、idiom、pixel_ratio、set_color_scheme……
};
```

```tsx tabs
import { colorScheme, fontScale, locale, openUrl, pixelRatio, platform, setColorScheme, windowSize } from "nsh/device";
```

教程见[设备与环境](../docs/device-and-environment.md)。

## windowSize

```ts
const windowSize: Accessor<Size>;
```

界面的尺寸（点）：窗口，或嵌入时的 `NshAppView` / `NshView`。响应式。Rust：`window() -> Size<Points>`。

```rust tabs
let wide = move || window().width >= px(600.0);

view().style_when(wide, |s| s.flex_row())
```

```tsx tabs
const wide = () => windowSize().width >= 600;

<View style={{ flexDirection: wide() ? "row" : "column" }}>{/* ... */}</View>
```

## colorScheme

```ts
const colorScheme: Accessor<"light" | "dark">;
```

显示的外观：系统的外观，除非应用设置了自己的（`nsh.json` 的 `"appearance"`、[`setColorScheme`](#setcolorscheme)）。响应式。Rust：`dark() -> bool`；主题颜色（`AdaptiveColor`）和 `.dark(…)` 样式变体无需读取它就会跟随。Tailwind 的 `dark:` 变体也跟随它（见 [Tailwind](../docs/tailwind.md)）。

```rust tabs
view().flex_1().bg(move || if dark() { black() } else { white() })
```

```tsx tabs
const dark = () => colorScheme() === "dark";

<View style={{ flex: 1, backgroundColor: dark() ? "#000" : "#fff" }} />
```

## fontScale

```ts
const fontScale: Accessor<number>;
```

用户偏好的文字大小相对于默认大小的比例（`1` 为默认；iOS 上是动态字体，Android 上是字体大小设置），或嵌入它的应用设置的文字大小。响应式。Rust：`font_scale() -> f32`。除非设置了 `allowFontScaling={false}`，文本本身已经会随之缩放；当其他尺寸（例如文字旁边的图标）也需要跟随时再读取它。

## locale

```ts
const locale: Accessor<string>;
```

用户的区域设置，BCP 47 标签（`"en-US"`、`"zh-Hans-CN"`），或嵌入它的应用设置的区域设置。响应式。Rust：`locale() -> Locale`（`locale().as_str()` 即标签）。`Intl` 默认按它格式化；读取它来选择你自己的翻译文案（[设备与环境](../docs/device-and-environment.md#语言和地区)）。

## setColorScheme

```ts
function setColorScheme(scheme: "light" | "dark" | "system"): void;
```

无论系统外观如何，立即以 `scheme` 显示应用：`colorScheme()`、`dark:` 类、组件的主题和平台控件（警告框、状态栏的默认样式）都随之变化；`"system"` 重新跟随系统。`nsh.json` 的 `"appearance"` 从启动时就设置它。Rust：`set_color_scheme(Appearance::Dark)`（`Appearance::Light`、`Appearance::System`）。

## platform

```ts
const platform: Platform;

interface Platform {
  readonly os: "ios" | "android" | "macos" | "windows" | "linux" | "web";
  readonly renderer: "native" | "web" | "terminal";
  readonly isTerminal: boolean;
  readonly version: string;
  readonly idiom: "phone" | "pad" | "mac" | "tv" | "desktop";
  readonly catalyst: boolean;
  select<T>(spec: PlatformSelectSpec<T>): T | undefined;
}
```

应用所运行的平台，运行期间不变。

| 成员 | Rust | 说明 |
|---|---|---|
| `os` | `os() -> Os`（`os().name()` 即 TS 的字符串） | 操作系统。iOS、iOS 模拟器和 Mac Catalyst 都报告 `"ios"`，浏览器报告 `"web"`。 |
| `version` | `os_version() -> (u16, u16)` | iOS 和桌面系统：系统版本（`"17.5"`）；Android：API 级别（`"35"`）；Web：`"0.0"`。Rust 给出主版本和次版本号，在 Android 上是 API 级别和 0。 |
| `idiom` | `idiom() -> Idiom` | 设备类型：`"phone"`、`"pad"`（iPad、Android 平板）、`"mac"`（以 Mac 形态运行的 Mac Catalyst）、`"tv"`（Apple TV、Android TV）或 `"desktop"`，即桌面设备类型：macOS、Windows、Linux，以及有鼠标且窗口较宽的浏览器。 |
| `catalyst` | `idiom() == Idiom::Mac` | 以 Mac 形态运行的 Mac Catalyst。 |
| `renderer` | `renderer()` | 界面的呈现方式：平台视图或桌面图形（`"native"`）、浏览器 HTML（`"web"`）或终端字符单元格（`"terminal"`）。 |
| `isTerminal` | `is_terminal()` | 界面渲染为终端字符单元格。`os` 报告终端宿主的操作系统。 |
| `select(spec)` | `match os() { … }` | 当前平台对应的值（见下文）。 |

```rust tabs
let columns = if is_desktop() { 3 } else { 1 };
```

```tsx tabs
const columns = platform.idiom === "desktop" && !platform.isTerminal ? 3 : 1;
```

### platform.select

```ts
interface PlatformSelectSpec<T> {
  ios?: T;
  android?: T;
  macos?: T;
  windows?: T;
  linux?: T;
  web?: T;
  terminal?: T; // 终端渲染，优先于操作系统
  mobile?: T;   // iOS、Android，以及手机和平板上的浏览器
  desktop?: T;  // macOS、Windows、Linux，以及桌面浏览器
  native?: T;   // 除 Web 外的所有平台
  default?: T;
}
```

依次返回当前操作系统（`ios`、`android`、`web` 等）对应的值，否则 `mobile` / `desktop`，否则 `native`（除 Web 外的所有平台），否则 `default`，都没有则返回 `undefined`。在浏览器中，`mobile` 还是 `desktop` 由设备类型决定。Rust 代码对 `os()` 做 `match`（`mobile` / `desktop` 用 `is_desktop()`）。

终端依次查找 `terminal`、宿主操作系统、`native` 和 `default`。可用 `platform.select({ terminal: "Press Enter", default: "Tap" })` 为终端选择交互提示。

```rust tabs
use nsh_core::platform::Os;

let card = view().p_4();
let card = match os() {
    Os::Ios => card.shadow_color(black()).shadow_opacity(0.15).shadow_radius(px(8.0)),
    Os::Android => card.elevation(px(4.0)),
    _ => card,
};
```

```tsx tabs
const shadow = platform.select({
  ios: { shadowColor: "#000", shadowOpacity: 0.15, shadowRadius: 8 },
  android: { elevation: 4 },
});
```

> [!TIP]
> 对于只有某个平台才有的属性，优先使用 TSX 元素和组件的 `ios={{…}}` / `android={{…}}` 属性，而不是按 `platform` 分支（见[平台专有代码](../docs/platform-specific.md)）。

## pixelRatio

```ts
const pixelRatio: Accessor<number>;
```

每个点对应的设备像素数（大多数 iPhone 上为 `3`）。响应式：窗口移动到另一种像素密度的屏幕上时（Mac Catalyst、桌面系统或外接显示器）它会变化。Rust：`pixel_ratio() -> f32`，取整到设备像素的长度用 `round_to_nearest_pixel(points)`；在 TSX 中这个长度是 `Math.round(x * pixelRatio()) / pixelRatio()`。

```rust tabs
let hairline = move || px(1.0 / pixel_ratio());
```

```tsx tabs
const hairline = () => 1 / pixelRatio();
```

## openUrl

```ts
function openUrl(url: string): Promise<boolean>;
```

在应用之外打开 `url`：网页在浏览器中打开，`mailto:` 链接在邮件应用中打开，`tel:` 链接在电话应用中打开，其他应用注册的 scheme（`maps:`、宿主应用自己的 `lb://` 链接）交给对应的应用。结果表示是否有应用打开了它：没有应用处理该 scheme 时为 `false`。Rust：`nsh_core::ui::prelude` 的 `open_url(url)`，返回可在任务中等待（或直接丢弃）的回答。

```rust tabs
button()
    .child(text("联系我们"))
    .on_press(|| {
        spawn(async {
            if !open_url("mailto:help@example.com").await {
                log::warn!("no mail app");
            }
        });
    })
```

```tsx tabs
<Button
  onPress={async () => {
    if (!(await openUrl("mailto:help@example.com"))) {
      console.warn("no mail app");
    }
  }}
>
  <Text>联系我们</Text>
</Button>
```

- URL 必须是绝对地址（带 scheme）。会执行代码或访问应用自身数据的 URL，即 `javascript:`、`data:`、`blob:`、`file:`、`about:` 和 `asset:`，以及相对地址，会抛出 `TypeError`。
- 声明了能力的应用需要 `openUrl`：`"openUrl": true` 允许所有 scheme，`"openUrl": { "schemes": ["https", "mailto"] }` 只允许列出的 scheme；其他 URL 抛出 `TypeError`（见[沙箱与能力](../docs/sandbox-and-capabilities.md)）。
- 嵌入它的应用先看到这个 URL，可以改由自己的路由处理（Swift `NshAppView.onOpenURL`、Java `NshView.setOpenUrlHandler`、Rust `AppView::host().handle_open_url`；见 [iOS](../docs/ios.md#应用打开的链接) 和 [Android](../docs/android.md#应用打开的链接)），此时结果为 `true`。
- 各平台用自己的方式打开：iOS 用 `UIApplication.open`（嵌入时是宿主应用的 application），Android 用 `ACTION_VIEW` Intent，macOS 用 `NSWorkspace`，Windows 用 `ShellExecuteW`，Linux 用 `GtkUriLauncher`，GPUI 用它的 `open_url`，Web 在新标签页中打开。`nsh test` 记录这些 URL，而不真正打开。
- [`TextView`](../elements/text-view.md) 设置 `links="open"` 后，以同样的方式打开其中的链接。

## 布局方向

布局方向跟随用户的语言：在从右到左书写的语言（阿拉伯语、希伯来语等）中，应用从右到左布局，行从右侧开始排列，`left` / `right` 样式属性（`marginLeft`、`paddingRight` 等）表示起始端和结束端。修改即时生效，无需重启。

视图的 `direction` 样式（`"ltr"`、`"rtl"` 或默认的 `"inherit"`）设置其自身子树的方向；Rust 中为 `.direction(LayoutDirection::..)`。

```rust tabs
view().direction(LayoutDirection::Rtl).flex_row().gap_2().child(text("First")).child(text("Second"))
```

```tsx tabs
<View style={{ direction: "rtl", flexDirection: "row", gap: 8 }}>
  <Text>First</Text>
  <Text>Second</Text>
</View>
```

## 相关内容

- 安全区域（Rust 的 `safe_area()`；TSX 的 `safeArea()`、`safeAreaInsets()`）和软键盘（Rust 的 `keyboard_height()`；TSX 的 `keyboardFrame()`）属于 [`nsh/base`](./nsh-base.md#safearea-and-safeareainsets)。
- 屏幕阅读器和减弱动态效果的设置在 [`nsh/accessibility`](./nsh-accessibility.md) 中。

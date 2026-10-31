---
title: 平台特定代码
description: 为手机、桌面和浏览器编写同一个应用：ios={{}} / android={{}} / desktop={{}} / web={{}} 中的平台专属属性，nsh/mobile 与 nsh/desktop 模块，platform.os 与 platform.select，以及平台相关的 Tailwind 变体。
order: 17
group: platforms
---

# 平台特定代码

同一个 NSH 包可以在 iOS、Android、macOS、Windows 和 Linux 上运行（也可以在 Mac Catalyst 中运行），还可以通过 [Web 运行时](./web.md)在浏览器中运行。应用的大部分代码根本不需要判断平台：元素、样式、布局和模块在各处的行为都相同，你用它们绘制的组件在各处看起来也都一样。当某样东西确实只属于一个平台时，NSH 给它安排了明确的位置，让平台代码一目了然、范围可控：

| Rust | TSX | 用途 |
|---|---|---|
| [构建方法（`.ripple(..)`、`.input_accessory(..)`）](#平台专属属性) | [`ios={{…}}`、`android={{…}}`、`desktop={{…}}`、`web={{…}}`](#平台专属属性) | 只有一个平台才有的属性。 |
| [`on_back_press`、`nsh_core::element::desktop`](#平台模块) | [`nsh/mobile`、`nsh/desktop`](#平台模块) | 只有移动平台或只有桌面才有的 API。 |
| [`os()`、`idiom()`、`is_desktop()`](#platformos-与-platformselect) | [`platform.os`、`platform.desktop`、`platform.select`](#platformos-与-platformselect) | 按平台选择值或代码。 |
| [`.when(os() == Os::Ios, ..)`](#tailwind-中的平台变体) | [`ios:` / `android:` / `web:` 类](#tailwind-中的平台变体) | 按平台设置样式。 |

## 桌面与移动端

图形平台分为桌面和移动端，判断规则只有一条。桌面是 macOS、Windows、Linux，以及桌面形态的浏览器（有鼠标且窗口较宽，见 [Web](./web.md)）。移动端是 iOS、Android，以及手机或平板形态的浏览器；Mac Catalyst 运行 iOS 后端，因此也属于移动端，适用 `ios={{…}}` 属性。`desktop={{…}}` 属性、`platform.select({ desktop, mobile })` 和 `platform.desktop` 都遵循这条规则，`nsh/base` 的图形组件（菜单在桌面上是弹出层，在移动端是底部面板）和 Rust 中的 `is_desktop()` 也一样。

终端的 `platform.desktop === false`，依次选择 `terminal`、宿主操作系统、`native` 和 `default`。`platform.idiom` 表示设备类型，因此桌面操作系统上的终端仍报告 `"desktop"`。用 `platform.isTerminal` 判断终端呈现。

`nsh/desktop` 的 `isAvailable` 表示原生桌面和终端的标题及菜单 API 可用。图形桌面布局、密度和输入方式用 `platform.desktop` 判断，调用标题和菜单 API 用 `isAvailable` 判断。

## 平台专属属性

在 Rust 中，只有一个平台才有的属性和其他属性一样是构建方法（Android 的 `.ripple(..)`、`.elevation(..)`，iOS 的 `.input_accessory(..)`，桌面的 `.window_drag(..)`）；其他平台会忽略它。在 TSX 中，只存在于某一个平台的属性，归入以该平台命名的对象中。每个元素都接受 `ios`、`android`、`desktop`（macOS、Windows、Linux，以及界面风格为桌面的浏览器）和 `web`（浏览器）；在其他平台上这个对象会被忽略，在它自己的平台上只应用其中的键。桌面浏览器同时应用 `desktop` 和 `web`。

```rust tabs
use nsh_base::dialog;
use nsh_core::{
    Ripple,
    element::{AutoFill, Orientation}, prelude::*,
};

view()
    .on_press(open)
    .active(|s| s.opacity(0.6))
    .ripple(Ripple {
        color: Some(rgba(0x0000001f).into()),
        ..Ripple::default()
    })
    .elevation(px(4.0))
    .p_4()
    .rounded(px(12.0))
    .bg(white())
    .child(text("Open"))

input().placeholder("Code").auto_fill(AutoFill::OneTimeCode)

when(shown, || {
    dialog()
        .supported_orientations([Orientation::Portrait])
        .status_bar_translucent(true)
        .child(…)
})
```

```tsx tabs
<View
  onPress={open}
  activeStyle={{ opacity: 0.6 }}
  android={{ ripple: { color: "rgba(0,0,0,0.12)" }, elevation: 4 }}
  style={{ padding: 16, borderRadius: 12, backgroundColor: "#ffffff" }}
>
  <Text>Open</Text>
</View>

<Input
  placeholder="Code"
  ios={{ textContentType: "oneTimeCode" }}
/>

<Dialog open={open()} ios={{ supportedOrientations: ["portrait"] }} android={{ statusBarTranslucent: true }}>
  …
</Dialog>
```

TSX 的这些对象和其他属性一样是响应式的；从对象中移除的键会被清除。

目前已有的：

| Rust | TSX | 适用于 | 说明 |
|---|---|---|---|
| `.ripple(Ripple { .. })` | `android={{ ripple }}` | 所有元素 | 按下时的 Material 水波纹：颜色、无边界、半径、前景。 |
| `.elevation(..)` | `android={{ elevation }}` | 所有元素 | 根据视图形状生成的 Material 阴影，单位为点。 |
| | `android={{ accessibilityLiveRegion }}` | 所有元素 | `"none"`、`"polite"` 或 `"assertive"`：TalkBack 播报视图的变化。 |
| `.status_bar_translucent(..)` | `android={{ statusBarTranslucent }}` | `Dialog` | 对话框的内容延伸到状态栏下方。 |
| `.input_accessory(..)` | `ios={{ inputAccessoryViewID }}` | `Input` | 显示在键盘上方的 `InputAccessoryView`。 |
| `.auto_fill(..)` | `ios={{ textContentType }}` | `Input` | iOS 对自动填充类型的叫法（Rust 的 `AutoFill` 覆盖两个平台）。 |
| `.supported_orientations(..)` | `ios={{ supportedOrientations }}` | `Dialog` | 允许的方向。 |
| `.back_forward_gestures(..)` | `ios={{ allowsBackForwardNavigationGestures }}` | `WebView` | 滑动在页面历史中前进后退。 |
| `.header_right_system_item(..)` | `ios={{ headerRightSystemItem }}` | `NavPage` | 标题栏末尾显示 UIKit 自带的按钮，按下即按下 `headerRight`。 |
| `.back_forward_gestures(..)` | `desktop={{ allowsBackForwardNavigationGestures }}` | `WebView` | macOS：双指在触控板上轻扫，在页面历史中前进后退；Windows：在触摸屏上轻扫；Linux：在触控板上轻扫。 |
| `.window_drag(..)` | `desktop={{ windowDrag }}` | 所有元素 | 按住它拖动窗口，像系统标题栏一样（见 [nsh/desktop](../modules/nsh-desktop.md#自定义标题栏)）。 |

在 TSX 中，`desktop={{…}}` 和 `web={{…}}` 在所有地方都可以使用。类型（`IOSProps`、`AndroidProps`、`DesktopProps` 及其各元素的形式）会告诉编辑器每个元素接受什么。

元素在各平台上都要表达的意思是顶层属性（Rust 中是同名方法），在有意义的平台上生效：`NavPage` 的 `title`、`headerStyle`、`headerLargeTitle` 和 `headerBackTitle` 设置 iOS 和 Android 的系统标题栏，它的 `header` 插槽是桌面和 Web 上的标题栏，`Dialog` 的 `presentation` 选择 iOS 的表单样式。`AlertDialog.show` 的 `closeOnBackdropPress`、`pagingEnabled`、`refreshing`、`hitSlop` 等在所有平台上都可用。平台系统自带的功能放进该平台的对象；几个平台都有时，用同一个名字分别放进各自的对象：`WebView` 的 `allowsBackForwardNavigationGestures`（系统的滑动前进后退手势）同时在 `ios={{…}}` 和 `desktop={{…}}` 里。

## 平台模块

在 Rust 中，只有一个平台才有的 API 是 `nsh_core::prelude` 的函数（`on_back_press`、`input_accessory_view`）和 `nsh_core::element::desktop` 的函数（窗口：`set_title`、`set_title_bar`、`title_bar`、`minimize`、`toggle_maximize`、`toggle_full_screen`、`set_frame`、`set_level`、`order_front`、`close_window`；菜单：`set_application_menu`、`popup_menu`）；在其他平台上它们什么都不做。在 TSX 中，`nsh/mobile` 存放 iOS 和 Android 的 API（其中一些只属于其中一个平台），`nsh/desktop` 存放桌面的 API。两者在所有平台上都可以导入，因此同一个包可以到处运行：在其他平台上，它们的函数会立即返回，组件不占空间。每个模块都导出 `isAvailable`，在自己的平台上为 `true`；`platform.os` 区分具体平台。

### nsh/mobile

`isAvailable` 在 iOS（包括 Mac Catalyst）和 Android 上为 `true`。两个平台都有系统标签栏 [`TabBar`](../modules/nsh-mobile.md#tabbar)。

#### BackHandler（Android）

| Rust | TSX | 说明 |
|---|---|---|
| `on_back_press(listener)` | `BackHandler.on("press", listener)` | 在对话框之后、导航栈之前监听返回键；处理了就返回 `true`。监听器随添加它的组件（或 effect）一起结束；在 TSX 中，调用还会返回一个函数，用来提前停止监听。 |
| | `BackHandler.exitApp()` | 退出应用。 |

```rust tabs
use nsh_core::prelude::*;

fn player() -> impl IntoElement {
    let full_screen = signal(false);
    // 返回键先退出全屏，再离开页面。监听器随视图一起结束。
    on_back_press(move || {
        if !full_screen.get_untracked() {
            return false;
        }
        full_screen.set(false);
        true
    });
    // …
}
```

```tsx tabs
import { BackHandler } from "nsh/mobile";

function Player() {
  // 返回键先退出全屏，再离开页面。监听器随组件一起结束。
  BackHandler.on("press", () => {
    if (!fullScreen()) return false;
    fullScreen.set(false);
    return true;
  });
  // …
}
```

返回键先由最上层的对话框处理，然后是返回键监听器（最近添加的最先），再然后是最上层的导航栈，都没有处理时应用退出。见[导航](./navigation.md#android-返回键)。

#### InputAccessoryView（iOS）

| Rust | TSX | 说明 |
|---|---|---|
| `input_accessory_view(native_id)` | `InputAccessoryView` | 在引用其原生 id（`.input_accessory(..)`、`ios={{ inputAccessoryViewID }}`）的输入框的键盘上方显示的工具栏。 |

见[表单与键盘](./forms-and-keyboard.md#键盘上方的工具栏inputaccessoryview)。

### nsh/desktop

Rust 应用用 `nsh_core::element::desktop` 绘制自己的标题栏（[用 Rust 开发](./rust.md#桌面标题栏)）。TSX 的模块：

| 导出 | 说明 |
|---|---|
| `Window` | 窗口：`setTitle`、`setTitleBar({ style: "hidden" })`（自定义标题栏）、`minimize`、`toggleMaximize`、`toggleFullScreen`、`close`。 |
| `titleBar` | 隐藏的标题栏的高度，以及系统窗口按钮占用的空间（响应式）。 |
| `Menu` | `setApplicationMenu(items)`（菜单栏，带快捷键）和 `popup(items, at?)`（右键菜单）。 |
| `isAvailable` | 在窗口和菜单 API 可用的地方为 `true`：macOS、Windows 和 Linux。桌面浏览器的 `platform.desktop` 为 `true`，窗口和菜单仍是浏览器自己的。 |

见 [nsh/desktop](../modules/nsh-desktop.md)。

### 状态栏

在两个平台上，状态栏都属于最上层的页面或对话框，和 UIKit 中由最上层视图控制器决定一样：[`NavPage` 和 `Dialog` 接受 `statusBar`](../modules/nsh-base.md#status-bar)（Rust 中为 `.status_bar(StatusBarStyle::Light)`，其他字段用 `StatusBarSetting`），其中有 `foreground`（`"auto"`、深色背景用 `"light"`、浅色背景用 `"dark"`）、`hidden` 和 `animated`。最近显示的页面或对话框按字段逐项生效，它离开后下面那个重新生效。`nsh.json` 的 `"statusBar"` 是它们之下的应用默认值。

```rust tabs
use nsh_base::nav_page;
use nsh_core::prelude::*;

fn photo_viewer() -> impl IntoElement {
    nav_page()
        .header_visible(false)
        .status_bar(StatusBarStyle::Light)
        .child(view().flex_1().bg(black()))
}
```

```tsx tabs
import { View } from "nsh";
import { NavPage } from "nsh/base";

function PhotoViewer() {
  return (
    <NavPage headerVisible={false} statusBar={{ foreground: "light", animated: true }}>
      <View style={{ flex: 1, backgroundColor: "#000000" }}>…</View>
    </NavPage>
  );
}
```

在嵌入原生应用的场景下，iOS 上由宿主应用的视图控制器决定状态栏。在 `nsh.json` 中声明了 `"capabilities"` 的应用，需要 `"statusBar": true` 才能修改它。

## platform.os 与 platform.select

Rust 中的 `os()` 和 TSX 中 `nsh` 的常量 `platform` 告诉你应用运行在哪里：`Os::Ios`、`Os::Android`、`Os::MacOs`、`Os::Windows`、`Os::Linux` 或 `Os::Web`，`platform.os` 为 `"ios"`、`"android"`、`"macos"`、`"windows"`、`"linux"` 或 `"web"`（Mac Catalyst 为 `"ios"`，无论哪种形态 `platform.catalyst` 都为真；[macOS 后端](./macos.md)为 `"macos"`，[Linux 后端](./linux.md)为 `"linux"`，[Windows 后端](./windows.md)为 `"windows"`，它们的元素会应用 `desktop` 属性；[浏览器](./web.md)为 `"web"`，`platform.desktop` 为 `true` 时也会应用 `desktop` 属性）。版本、界面风格等见[设备与环境](./device-and-environment.md#平台)。

```rust tabs
use nsh_core::{element::Os, prelude::*};

if os() == Os::Android {
    // …
}
```

```tsx tabs
import { platform } from "nsh";

if (platform.os === "android") {
  // …
}
```

### platform.select

在 Rust 中用 `match os()` 选择值，桌面用 `is_desktop()`。在 TSX 中，`platform.select(spec)` 返回当前平台对应的值。它依次查找该操作系统自己的键，然后按[上面的规则](#桌面与移动端)（`platform.desktop`）查找 `desktop` 或 `mobile`，再是 `native`（除 Web 外的所有平台），最后是 `default`：

终端界面报告 `platform.renderer === "terminal"`、`platform.isTerminal === true`，`platform.os` 为宿主操作系统。终端依次选择 `terminal`、宿主操作系统、`native` 和 `default`。图形桌面界面应用 `desktop={{…}}` 属性。

```rust tabs
use nsh_core::{element::Os, prelude::*};

fn card() -> View {
    let card = view().rounded(px(12.0)).bg(white());
    match os() {
        Os::Ios => card.shadow_md(),
        Os::Android => card.border_1().border_color(rgb(0xe5e7eb)),
        _ => card,
    }
}

let hint = match os() {
    Os::Ios => "Swipe down to close",
    Os::Android => "Press back to close",
    _ => "Close",
};
```

```tsx tabs
const styles = {
  card: {
    borderRadius: 12,
    backgroundColor: "#ffffff",
    ...platform.select({
      ios: { boxShadow: "0px 2px 8px rgb(0 0 0 / 0.12)" },
      android: { borderWidth: 1, borderColor: "#e5e7eb" },
    }),
  },
};

const hint = platform.select({ ios: "Swipe down to close", android: "Press back to close", default: "Close" });
```

没有匹配项且没有 `default` 时返回 `undefined`。

### 渲染不同的组件

组件也可以这样选择；选择永远不变时（TSX）放在模块顶层：

```rust tabs
fn spinner() -> AnyElement {
    if os() == Os::Ios {
        ios_spinner().into_element()
    } else {
        material_spinner().into_element()
    }
}
```

```tsx tabs
const Spinner = platform.select({ ios: IosSpinner, default: MaterialSpinner })!;
```

或者用 [`when` / `<If>`](../elements/control-flow.md) 内联：

```rust tabs
when(os() == Os::Ios, || input_accessory_view("bar").child(…))
    .otherwise(|| text("Android has no input accessories."))
```

```tsx tabs
<If when={platform.os === "ios"} else={<Text>Android has no input accessories.</Text>}>
  <InputAccessoryView nativeID="bar">…</InputAccessoryView>
</If>
```

## Tailwind 中的平台变体

Rust 用 `.when(os() == Os::Ios, |v| ..)` 按平台设置样式；在 TSX 中，`ios:`、`android:` 和 `web:` 变体只在一个平台上应用对应的类：

```rust tabs
view()
    .rounded_xl()
    .bg(white())
    .p_4()
    .when(os() == Os::Ios, |v| v.shadow_md())
    .when(os() == Os::Android, |v| v.border_1().border_color(rgb(0xe4e4e7)))
```

```tsx tabs
<View class="rounded-xl bg-white p-4 ios:shadow-md android:border android:border-zinc-200">…</View>
<Text class="text-base android:font-medium">Title</Text>
```

## 优先使用共享的行为

在添加平台判断之前，先想想这个差异对用户是否重要。元素和样式已经在应当不同的地方映射到各平台的原生行为（滚动物理效果、文字渲染、键盘、无障碍），在用户期望一致的地方（你的应用自己的外观）保持一致。平台判断最好留给用户依赖的平台惯例：Android 的返回键和 toast、iOS 的表单弹窗和大标题、自动填充的名称、Android 的水波纹。

## 相关内容

- [`InputAccessoryView`](../modules/nsh-mobile.md#inputaccessoryview) 与 [`BackHandler`](../modules/nsh-mobile.md#backhandler)：参考。
- [`nsh` 的设备 API](../modules/nsh.md#device)：`platform`。
- [原生组件](./native-components.md)：使用宿主应用在各平台上提供的视图。
- [Tailwind](./tailwind.md)：所有变体。

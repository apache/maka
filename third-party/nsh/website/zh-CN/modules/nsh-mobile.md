---
title: nsh/mobile
description: iOS 和 Android 的 API：系统标签栏 TabBar、iOS 的 InputAccessoryView、Android 的 BackHandler，以及 isAvailable。
order: 12.2
---

# nsh/mobile

`nsh/mobile` 收录 iOS 和 Android 的专属能力：两者都有的系统标签栏 `TabBar`；iOS 的 [`InputAccessoryView`](#inputaccessoryview)，键盘上方的工具栏；Android 的 [`BackHandler`](#backhandler)，返回键。Rust 代码使用 `nsh_core::mobile` 和 `nsh_core::prelude`；TSX 导入 `nsh/mobile`。这个模块在所有平台上都可以导入，所以同一个 bundle 能在各处运行：在其他平台上，它的组件不占空间、调用立即返回，`isAvailable` 告诉你当前是否在 iOS 或 Android 上（`nsh` 的 `platform.os` 区分具体平台）。桌面的能力在 [nsh/desktop](./nsh-desktop.md) 中。

```rust tabs
use nsh_core::mobile::{TabBarItem, tab_bar};
```

```tsx tabs
import { BackHandler, InputAccessoryView, isAvailable, TabBar } from "nsh/mobile";
import type { TabBarItem, TabBarProps } from "nsh/mobile";
```

## 模块范围

这个模块提供移动平台专属的能力，例如用于应用顶层导航的系统标签栏。通用控件属于 [`nsh/base`](./nsh-base.md)：例如 [Switch](../elements/switch.md) 在手机、桌面和 Web 上共享行为与 API，轨道、滑块和各状态的样式由应用提供。`TabBar` 服务于移动应用导航，`Tabs` 服务于跨平台的标签内容切换。这个模块仅接受具有移动平台专属交互语义的能力。系统外观、尺寸或动画本身仍属于通用控件的共享职责。这个职责区别决定哪些能力适合放在这里（[目标与设计原则](../docs/goals.md)）。

## isAvailable

```ts
const isAvailable: boolean;
```

在 iOS、iOS 模拟器、Mac Catalyst 和 Android 上为 `true`，其他平台为 `false`。Rust：`matches!(os(), Os::Ios | Os::Android)`。

## TabBar

标签栏在应用的几个顶层部分之间切换：记录和统计、收件箱和设置。`TabBar` 就是系统自己的标签栏，所以它的外观和行为与系统应用一致：iOS 和 iPadOS 上是 `UITabBar`（iOS 26 上是 Liquid Glass 及其选中效果），Android 上是 Material 3 的导航栏，使用系统的颜色，浅色和深色都一样。应用提供标签（`items`），指明选中哪一个（`selectedIndex`），接收用户的选择（`onChange`），用 `class` 和 `style` 摆放标签栏，并自己显示选中部分的内容。页面内的标签，以及在所有平台上，请使用 `nsh/base` 的 [Tabs](../elements/tabs.md)。

```rust tabs
use nsh_core::{
    mobile::{TabBarItem, tab_bar},
    prelude::*,
};

fn sections() -> impl IntoElement {
    let section = signal(0u32);
    view()
        .flex_1()
        .child(text(move || match section.get() {
            0 => "Records",
            _ => "Stats",
        }))
        .child(
            tab_bar()
                .items(vec![
                    TabBarItem::new("Records").icon("list.bullet"),
                    TabBarItem::new("Stats").icon("chart.bar"),
                ])
                .selected_index(section)
                .on_change(move |index: &u32| section.set(*index))
                .absolute()
                .left_0()
                .right_0()
                .bottom_0(),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { TabBar } from "nsh/mobile";
import { platform } from "nsh";

function App() {
  const section = signal(0);
  return (
    <View class="flex-1">
      <Text>{section() === 0 ? "Records" : "Stats"}</Text>
      <TabBar
        items={[
          { title: "Records", icon: platform.select({ ios: "list.bullet", android: "ic_records" }) },
          { title: "Stats", icon: platform.select({ ios: "chart.bar", android: "ic_stats" }) },
        ]}
        selectedIndex={section()}
        onChange={(index) => section.set(index)}
        class="absolute inset-x-0 bottom-0"
      />
    </View>
  );
}

mount(App);
```

`TabBar` 来自 `nsh/mobile`，在 Rust 中是 `nsh_core::mobile`。选中状态属于应用：一次点按通过 `onChange` 报告该标签的索引，标签栏像系统的一样立即显示这次选择，应用显示那一部分并把索引作为 `selectedIndex` 传回。样式没有给定高度时，高度是系统的。在 Rust 中，`tab_bar()` 创建它，每个 prop 一个 setter（`.items(..)`、`.selected_index(..)`），每个事件一个监听方法（`.on_change(..)`），以及带类型的样式方法；`TabBarItem::new(title).icon(name)` 创建一个标签。

### Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `TabBarItem[]` | `[]` | 各个标签，按顺序。 |
| `selectedIndex` | `.selected_index(..)` | `number` | `0` | 选中的标签的索引；超出标签数量的索引不选中任何标签。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 标签栏的位置和尺寸。外观是系统的。 |
| `testID` | `.test_id(..)` | `string` | 无 | 在测试和 `nsh test --trace` 中找到标签栏。 |

#### TabBarItem

| 字段 | Rust | 类型 | 说明 |
|---|---|---|---|
| `title` | `TabBarItem::new(title)` | `string` | 标签的标题，屏幕阅读器会读出它。 |
| `icon` | `.icon(name)` | `string` | 标签的图标，用平台对它的称呼：iOS 上是 [SF Symbol](https://developer.apple.com/sf-symbols/)（`"house"`），Android 上是应用的 drawable（`res/drawable/home.xml` 写作 `"home"`，`"android:ic_menu_search"` 是系统的）。用 `platform.select` 按平台选择。 |

### 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|index: &u32\| ..)` | 用户选择了一个标签：它的索引。标签栏立即显示这次选择；应用显示该标签的内容并设置 `selectedIndex`。 |

### 平台说明

- **iOS 和 Mac Catalyst**：`UITabBar`，采用当前 iOS 版本的系统外观：iOS 26 上是悬浮的 Liquid Glass 标签栏及其选中效果。图标是 SF Symbols。
- **Android**：Material 3 的导航栏，由平台的 View 组成：每个标签的文字上方是放在激活指示器中的图标，按压时有水波纹；Android 12 及以上使用系统的动态颜色，更早的版本使用 Material 的基准颜色；浅色或深色跟随应用的外观。位于窗口底部时，它延伸到导航栏下方，高度增加导航栏的 inset，与 Material 的一致。图标是应用的 drawable（由标签栏着色）。
- **桌面（macOS、Windows、Linux、GPUI）和 Web**：各个部分用 [Tabs](../elements/tabs.md) 显示，外观由应用决定。`TabBar` 在这些平台上不占空间，所以一个布局可以同时包含两者，用 `platform.os`（[`nsh` 的设备 API](./nsh.md#device)）来选择。

## InputAccessoryView

在 iOS 和 Mac Catalyst 上可用；在 Android 上是一个空的隐藏视图。

```ts
function InputAccessoryView(props: InputAccessoryViewProps): YNode | null;

interface InputAccessoryViewProps {
  nativeID: string;
  style?: StyleProp<ViewStyle>;
  class?: string;
  children?: JSX.Element;
}
```

键盘上方的工具栏（UIKit 的 `inputAccessoryView`），当 `ios={{ inputAccessoryViewID }}` 与它的 `nativeID` 相同的输入框获得焦点时显示。Rust：`input_accessory_view(native_id)`，在 `.input_accessory(native_id)` 与之相同的输入框获得焦点时显示。它与窗口等宽、高度由内容决定，并在原生侧随键盘一起移动。

| 属性 | 类型 | Rust | 说明 |
|---|---|---|---|
| `nativeID` | `string` | `input_accessory_view(native_id)` | `inputAccessoryViewID` 为该值的输入框会显示这个工具栏。 |
| `style` | `StyleProp<ViewStyle>` | `Styled` 方法（`.bg(…)`） | 工具栏的样式（例如背景色）。 |
| `class` | `string` | | Tailwind class。 |
| `children` | `JSX.Element` | `.child(…)` | 工具栏的内容。 |

它在树中所处的位置不渲染任何内容，在 Android 上则完全不渲染，因此可以把它放在所属输入框的旁边。

```rust tabs
use nsh_core::prelude::*;

#[component]
fn Note() -> impl IntoElement {
    let note = signal(String::new());
    let field = element_ref();
    view()
        .child(
            input()
                .element_ref(&field)
                .value(note)
                .on_change(move |value: &str| note.set(value.to_string()))
                .placeholder("Write a note")
                .input_accessory("note-bar"),
        )
        .child(
            input_accessory_view("note-bar").bg(rgb(0xf1f5f9)).child(
                view()
                    .flex_row()
                    .items_center()
                    .p(px(10.0))
                    .child(
                        text(move || format!("{} characters", note.with(|n| n.chars().count())))
                            .flex_1()
                            .text_color(rgb(0x64748b)),
                    )
                    .child(text("Done").font_weight(FontWeight::SEMIBOLD).on_press(move || field.blur())),
            ),
        )
}
```

```tsx tabs
import { signal, Text, View, type YNode } from "nsh";
import { Input } from "nsh/base";
import { InputAccessoryView } from "nsh/mobile";

function Note() {
  const text = signal("");
  let input: YNode | undefined;
  return (
    <View>
      <Input
        ref={(n) => (input = n)}
        value={text()}
        onChange={(v) => text.set(v)}
        placeholder="Write a note"
        ios={{ inputAccessoryViewID: "note-bar" }}
      />
      <InputAccessoryView nativeID="note-bar" style={{ backgroundColor: "#f1f5f9" }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 10 }}>
          <Text style={{ flex: 1, color: "#64748b" }}>{text().length} characters</Text>
          <Text onPress={() => input?.blur()} style={{ fontWeight: "600" }}>Done</Text>
        </View>
      </InputAccessoryView>
    </View>
  );
}
```

另见[表单与键盘](../docs/forms-and-keyboard.md)。

## BackHandler

在 Android 上可用；在 iOS 上，它的监听器会被保留但不会被调用，`exitApp()` 立即返回。

```ts
const BackHandler: {
  onBackPress(listener: () => boolean | void): () => void;
  exitApp(): void;
};
```

系统返回键和返回手势。对话框先处理返回操作（关闭对话框）；然后运行 `BackHandler` 的监听器，最后添加的最先运行；都不处理时，最上层的导航栈出栈，没有可返回的页面时应用退出。

| 成员 | Rust | 说明 |
|---|---|---|
| `onBackPress(listener)` | `on_back_press(listener)` | `listener` 处理了这次返回时返回 `true`。返回一个停止监听的函数；在组件渲染（或 effect 运行）期间添加的监听器随之停止，Rust 与 TSX 都是如此。 |
| `exitApp()` | 监听器返回 `false` | 退出应用。Rust 监听器返回 `false` 时，返回操作继续传递，由导航栈返回或应用退出。 |

```rust tabs
use nsh_base::alert_dialog;
use nsh_core::prelude::*;

#[component]
fn Editor() -> impl IntoElement {
    let dirty = signal(false);
    on_back_press(move || {
        if !dirty.get_untracked() {
            return false; // 交给应用返回或退出
        }
        spawn(async move {
            let answer = alert_dialog().title("Discard changes?").cancel("Keep").destructive("Discard").show().await;
            if answer == Ok(Some("Discard".into())) {
                dirty.set(false); // 下一次返回即离开
            }
        });
        true
    });
    // ...
}
```

```tsx tabs
import { signal } from "nsh";
import { BackHandler } from "nsh/mobile";
import { AlertDialog } from "nsh/base";

function Editor() {
  const dirty = signal(false);
  // Editor 移除时停止监听。
  BackHandler.onBackPress(() => {
    if (!dirty()) return false; // 交给应用返回或退出
    AlertDialog.show({
      title: "Discard changes?",
      actions: [{ label: "Keep", role: "cancel" }, { label: "Discard", role: "destructive", id: "discard" }],
    }).then((id) => id === "discard" && BackHandler.exitApp());
    return true;
  });
  // ...
}
```

> [!NOTE]
> 监听器在系统已经派发了返回操作之后才运行：主线程从不等待应用的代码。只要注册了至少一个监听器，对话框不处理的返回操作就由 NSH 接管；没有监听器返回 `true` 时，由 NSH 自己让最上层的导航栈返回或退出应用。

状态栏在 iOS 和 Android 上都由 `nsh/base` 中[页面和对话框](./nsh-base.md#status-bar)的 `statusBar` 设置。

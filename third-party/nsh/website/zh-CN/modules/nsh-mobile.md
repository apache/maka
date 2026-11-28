---
title: nsh/mobile
description: iOS 和 Android 的 API：系统标签栏 TabBar、触感反馈 Haptics、系统设置中本应用的页面 AppSettings、iOS 的 InputAccessoryView、Android 的 BackHandler，以及 isAvailable。
order: 12.2
---

# nsh/mobile

`nsh/mobile` 提供只有 iOS 和 Android 才有的组件和 API。TSX 导入 `nsh/mobile`，Rust 代码使用 `nsh_core::mobile` 和 `nsh_core::prelude`。

| API | 用途 | 平台 |
|---|---|---|
| `TabBar` | 系统标签栏 | iOS、Android |
| [`Haptics`](#haptics) | 设备触感反馈 | iOS、Android |
| [`AppSettings`](#appsettings) | 系统设置里本应用的页面 | iOS、Android |
| [`InputAccessoryView`](#inputaccessoryview) | 键盘上方的工具栏 | iOS |
| [`BackHandler`](#backhandler) | 返回键 | Android |

这个模块在所有平台都能导入，所以一个 bundle 可以到处运行。在其他平台上，它的组件不占空间，调用立即返回。`isAvailable` 告诉你是否在 iOS 或 Android 上，`nsh` 的 `platform.os` 告诉你具体是哪个。桌面能力见 [nsh/desktop](./nsh-desktop.md)。

```tsx tabs
import {
  AppSettings,
  BackHandler,
  Haptics,
  InputAccessoryView,
  isAvailable,
  TabBar,
} from "nsh/mobile";
import type { TabBarItem, TabBarProps } from "nsh/mobile";
```

```rust tabs
use nsh_core::mobile::{TabBarItem, tab_bar};
```

## 模块范围

这个模块提供移动平台专属的能力，例如用于应用顶层导航的系统标签栏。通用控件属于 [`nsh/base`](./nsh-base.md)：例如 [Switch](../elements/switch.md) 在手机、桌面和 Web 上共享行为与 API，轨道、滑块和各状态的样式由应用提供。`TabBar` 服务于移动应用导航，`Tabs` 服务于跨平台的标签内容切换。这个模块仅接受具有移动平台专属交互语义的能力。系统外观、尺寸或动画本身仍属于通用控件的共享职责。这个职责区别决定哪些能力适合放在这里（[目标与设计原则](../docs/goals.md)）。

系统自己的分段控件、开关和日期时间选择器在 [nshm](../docs/nshm.md) [nsh-system-controls](https://github.com/longbridge/nsh-system-controls) 中：用 `nsh add nsh-system-controls` 添加，把 `SegmentedControl`、`Switch` 和 `DateTimePicker` 的导入从 `"nsh/mobile"` 改为 `"nsh-system-controls"`。要在所有平台上使用应用自己外观的控件，用 `nsh/base` 的 [ToggleGroup](../elements/toggle.md) 或 [RadioGroup](../elements/radio.md)、[Switch](../elements/switch.md)，以及 [DatePicker](../elements/date-picker.md) 或 [TimeField](../elements/time-field.md)。

## isAvailable

```ts
const isAvailable: boolean;
```

在 iOS、iOS 模拟器、Mac Catalyst 和 Android 上为 `true`，其他平台为 `false`。Rust：`matches!(os(), Os::Ios | Os::Android)`。Mac 上没有应用自己的设置页，所以在 Mac Catalyst 上 `isAvailable` 为 `true`，而 [`AppSettings.available()`](#appsettings) 为 `false`。

## TabBar

标签栏在应用的几个顶层部分之间切换：记录和统计、收件箱和设置。`TabBar` 就是系统自己的标签栏，所以它的外观和行为与系统应用一致：iOS 和 iPadOS 上是 `UITabBar`（iOS 26 上是 Liquid Glass 及其选中效果），Android 上是 Material 3 的导航栏，使用系统的颜色，浅色和深色都一样。应用提供标签（`items`），指明选中哪一个（`selectedIndex`），接收用户的选择（`onChange`），用 `class` 和 `style` 摆放标签栏，并自己显示选中部分的内容。页面内的标签，以及在所有平台上，请使用 `nsh/base` 的 [Tabs](../elements/tabs.md)。

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { TabBar } from "nsh/mobile";
import { platform } from "nsh";
import { Window } from "nsh/desktop";

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
        onChange={({ index }) => section.set(index)}
        class="absolute inset-x-0 bottom-0"
      />
    </View>
  );
}

mount(() => (
  <Window id="main">
    <App />
  </Window>
));
```

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

`TabBar` 来自 `nsh/mobile`，在 Rust 中是 `nsh_core::mobile`。选中状态属于应用：一次点按通过 `onChange` 报告该标签的索引（`{ index }`），标签栏像系统的一样立即显示这次选择，应用显示那一部分并把索引作为 `selectedIndex` 传回。样式没有给定高度时，高度是系统的。标签栏不在视野中时（`hidden`，或被推入页面的 `hidesBottomBarWhenPushed` 移出底部）不接收触摸：落在它留下的区域上的点按会到达下面的视图，因此应用画在那里的控件（例如浮动的操作栏）可以点按。在 Rust 中，`tab_bar()` 创建它，每个 prop 一个 setter（`.items(..)`、`.selected_index(..)`），每个事件一个监听方法（`.on_change(..)`），以及带类型的样式方法；`TabBarItem::new(title).icon(name).badge(text)` 创建一个标签。

### Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `TabBarItem[]` | `[]` | 各个标签，按顺序。 |
| `selectedIndex` | `.selected_index(..)` | `number` | `0` | 选中的标签的索引；超出标签数量的索引不选中任何标签。 |
| `hidden` | `.hidden(..)` | `boolean` | `false` | iOS 和 Android：立即隐藏标签栏。应用在页面推入和弹出期间持有这个值；在 iOS 上当它和当前可见导航栈的 `hidesBottomBarWhenPushed` 请求都为 false 时，标签栏显示。不在视野中时它不接收触摸。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 标签栏的位置和尺寸。外观是系统的，选中的标签使用主题的 `primary`。 |
| `testID` | `.test_id(..)` | `string` | 无 | 在测试和 `nsh test --trace` 中找到标签栏。 |

#### TabBarItem

| 字段 | Rust | 类型 | 说明 |
|---|---|---|---|
| `title` | `TabBarItem::new(title)` | `string` | 标签的标题，屏幕阅读器会读出它。 |
| `icon` | `.icon(name)` | `string` | 标签的图标，用平台对它的称呼：iOS 上是 [SF Symbol](https://developer.apple.com/sf-symbols/)（`"house"`），Android 上是应用的 drawable（`nsh.json` 旁的 `android/res/drawable/home.xml` 写作 `"home"`，`"android:ic_menu_search"` 是系统的）。`nsh package --target android` 会把 `android/res/` 编译进 APK，目录结构与 Gradle 模块的 `src/main/res/` 相同（矢量 drawable、按密度放置的 PNG）；`nsh run` 的开发宿主只有系统的。用 `platform.select` 按平台选择。 |
| `badge` | `.badge(text)` | `string` | 标签的角标：一段文字，例如 `"3"` 或 `"New"`，或者 `""` 表示没有文字的角标；不设置（默认）则不显示。采用系统的角标外观，屏幕阅读器会随标签的标题读出它：它的文字；`""` 则读出系统对没有文字的角标的说法（VoiceOver 的；在 Android 上是系统的“新通知”，使用设备的语言）。 |

### 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|index: &u32\| ..)` | 用户选择了一个标签：`{ index }`，它的索引。标签栏立即显示这次选择；应用显示该标签的内容并设置 `selectedIndex`。 |

### 平台说明

- **iOS 和 Mac Catalyst**：`UITabBar`，采用当前 iOS 版本的系统外观：iOS 26 上是悬浮的 Liquid Glass 标签栏及其选中效果。图标是 SF Symbols。主题的 `primary` 是标签栏的 `tintColor`，即选中标签的颜色；其他标签保持系统的颜色。角标是标签项的 `badgeValue`：文字完整显示，`""` 是系统没有文字的角标，大小与一位数字的角标相同。
- **Android**：Material 3 的导航栏，由平台的 View 组成：每个标签的文字上方是放在激活指示器中的图标，按压时有水波纹；Android 12 及以上使用系统的动态颜色，更早的版本使用 Material 的基准颜色；浅色或深色跟随应用的外观。位于窗口底部时，它延伸到导航栏下方，高度增加导航栏的 inset，与 Material 的一致。图标是应用的 drawable（由标签栏着色）。选中标签的图标和文字使用主题的 `primary`，激活指示器是这个颜色的 12% 不透明度；其他标签保持系统的颜色。角标采用 Material 3 的样式：`""` 是位于图标角上的小角标（圆点），文字是从图标中部开始的大角标，使用它的 error 颜色，超出激活指示器的部分以省略号结尾。大角标与 Material 的一样只容纳简短的文字，即一个数字或不超过四个字符的词：更长的文字会被截断（`"Updated"` 显示为“Up…”），而 iOS 会完整显示。TalkBack 把 `""` 读作系统的“新通知”。
- **桌面（macOS、Windows、Linux、GPUI）和 Web**：各个部分用 [Tabs](../elements/tabs.md) 显示，外观由应用决定。`TabBar` 在这些平台上不占空间，所以一个布局可以同时包含两者，用 `platform.os`（[`nsh` 的设备 API](./nsh.md#device)）来选择。

## InputAccessoryView

在 iOS 和 Mac Catalyst 上可用；在 Android 上是一个空的隐藏视图。

```ts
function InputAccessoryView(props: InputAccessoryViewProps): JSX.Element;

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

```tsx tabs
import { type InputRef, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import { InputAccessoryView } from "nsh/mobile";

function Note() {
  const text = signal("");
  let input: InputRef | undefined;
  return (
    <View>
      <Input
        ref={(n) => (input = n)}
        value={text()}
        onChange={({ value }) => text.set(value)}
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

另见[表单与键盘](../docs/forms-and-keyboard.md)。

## BackHandler

在 Android 上可用；在 iOS 上，它的监听器会被保留但不会被调用，`exitApp()` 立即返回。

```ts
const BackHandler: {
  on(event: "press", listener: () => boolean | void): () => void;
  on(event: "progress", listener: (event: BackProgressEvent) => void): () => void;
  exitApp(): void;
};

interface BackProgressEvent {
  phase: "start" | "move" | "end" | "cancel";
  progress: number;
  edge?: "left" | "right";
}
```

系统返回键和返回手势。对话框先处理返回操作（关闭对话框）；然后运行 `BackHandler` 的监听器，最后添加的最先运行；都不处理时，最上层的导航栈出栈，没有可返回的页面时应用退出。

| 成员 | Rust | 说明 |
|---|---|---|
| `on("press", listener)` | `on_back_press(listener)` | `listener` 处理了这次返回时返回 `true`。返回一个停止监听的函数；在组件渲染（或 effect 运行）期间添加的监听器随之停止，TSX 与 Rust 都是如此。 |
| `on("progress", listener)` | `on_back_progress(listener)` | 在 Android 14 及更高版本上跟随返回手势：对话框没有接管的手势，`listener` 收到它的每一步，`start`、`move`，然后是 `end`（紧接着是返回操作）或 `cancel`，带有从 0 到 1 的 `progress` 和滑动开始的边缘 `edge`。有监听器时，导航栈把手势交给应用，不再预览弹出。见[跟随返回手势](../docs/navigation.md#跟随返回手势)。 |
| `exitApp()` | 监听器返回 `false` | 退出应用。Rust 监听器返回 `false` 时，返回操作继续传递，由导航栈返回或应用退出。 |

```tsx tabs
import { signal } from "nsh";
import { BackHandler } from "nsh/mobile";
import { AlertDialog } from "nsh/base";

function Editor() {
  const dirty = signal(false);
  // Editor 移除时停止监听。
  BackHandler.on("press", () => {
    if (!dirty()) return false; // 交给应用返回或退出
    AlertDialog.show({
      title: "Discard changes?",
      actions: [{ label: "Keep", role: "cancel", id: "keep" }, { label: "Discard", role: "destructive", id: "discard" }],
    }).then(({ action }) => action === "discard" && BackHandler.exitApp());
    return true;
  });
  // ...
}
```

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
            let answer = alert_dialog().title("Discard changes?").cancel("keep", "Keep").destructive("discard", "Discard").show().await;
            if answer.is_ok_and(|r| r.action.as_deref() == Some("discard")) {
                dirty.set(false); // 下一次返回即离开
            }
        });
        true
    });
    // ...
}
```

> [!NOTE]
> 监听器在系统已经派发了返回操作之后才运行：主线程从不等待应用的代码。只要注册了至少一个监听器，对话框不处理的返回操作就由 NSH 接管；没有监听器返回 `true` 时，由 NSH 自己让最上层的导航栈返回或退出应用。

## AppSettings

在 iOS 和 Android 上可用；其他平台上 `open` 立即 reject。

```ts
const AppSettings: {
  open(): Promise<AppSettingsResult>;
  available(): Promise<boolean>;
};

interface AppSettingsResult {
  opened: boolean;
}
```

打开系统设置中本应用自己的页面，用户在那里重新打开曾经拒绝的权限（相机、照片、通知）：权限一旦被拒绝，只有系统设置能改回来，所以应用解释为什么需要权限时，通常会附一个“打开设置”按钮。iOS 打开“设置”应用中本应用的页面，Android 打开应用信息页；嵌入的视图打开宿主应用的页面。

| 成员 | Rust | 说明 |
|---|---|---|
| `open()` | `open_app_settings()` | 打开这个页面；结果是 `{ opened }`，表示系统是否打开了它。 |
| `available()` | `app_settings_available()` | 当前能否用 `open()` 打开这个页面；显示按钮之前先问它。 |

- 没有应用自己的设置页的地方（macOS、Windows、Linux、Web、终端、`nsh test`，以及在 Mac 上运行的 iPhone 或 iPad 应用，包括 Mac Catalyst），`available()` 为 `false`，`open()` 以一个 `Error` reject，其 `code` 为 `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"`（Rust：`AppSettingsError::Unavailable`）。在 macOS 上，想打开某个隐私面板的应用可以用 [`openUrl`](./nsh.md#openurl) 打开它。
- 它作用于整个应用：声明了能力的应用需要 `"application": true`（见[沙箱与能力](../docs/sandbox-and-capabilities.md#application)）。没有它时 `available()` 为 `false`，`open()` 以 `"ERR_ACCESS_DENIED"` reject，`permission` 为 `"application"`（Rust：`AppSettingsError::Denied`）。
- `open()` 从不抛出：所有失败都以 reject 报告。在 Rust 中，两者都是可在任务中等待（或直接丢弃）的回答。

```tsx tabs
import { Text, View, signal } from "nsh";
import { AppSettings } from "nsh/mobile";

function OpenSettingsButton() {
  const canOpen = signal(false);
  AppSettings.available().then(canOpen.set);
  return (
    <If when={canOpen()}>
      <View onPress={() => AppSettings.open()}>
        <Text>打开设置</Text>
      </View>
    </If>
  );
}
```

```rust tabs
use nsh_core::prelude::*;

fn open_settings_button() -> impl IntoElement {
    let can_open = signal(false);
    spawn(async move { can_open.set(app_settings_available().await) });
    when(move || can_open.get(), || {
        view()
            .child(text("打开设置"))
            .on_press(|_| drop(open_app_settings()))
    })
}
```

## Haptics

在 iOS 和 Android 上可用；在其他平台上，调用会立即返回。

```ts
const Haptics: {
  selection(): void;
  impact(style?: "light" | "medium" | "heavy" | "soft" | "rigid"): void;
  notification(kind?: "success" | "warning" | "error"): void;
};
```

设备在用户的手指下播放触感反馈：选择发生了变化、一个元素发生了碰撞、一个任务结束了。iOS 上由反馈生成器播放（`UISelectionFeedbackGenerator`、`UIImpactFeedbackGenerator`、`UINotificationFeedbackGenerator`）；Android 上由视图的触感反馈播放。设备没有触感硬件，或者用户关闭了触感（Android 的触摸反馈设置、iOS 的系统触感）时，什么都不会播放。

| 成员 | Rust | 说明 |
|---|---|---|
| `selection()` | `haptic(Haptic::Selection)` | 选择发生了变化：选择器的值、分段、滑块的一个刻度。 |
| `impact(style)` | `haptic(Haptic::Impact(HapticImpact::Medium))` 等 | 一个元素发生了碰撞；`style` 是它的分量，默认 `"medium"`。 |
| `notification(kind)` | `haptic(Haptic::Notification(HapticNotification::Success))` 等 | 一个任务成功、产生警告或失败；默认 `"success"`。 |

传入不认识的名称会抛出 `TypeError`。Android 并不是每种触感都有对应的常量，它会播放最接近的一种：成功和失败从 Android 11 起用 `CONFIRM` 和 `REJECT`；警告，以及 Android 11 之前的失败，用长按的触感。

```tsx tabs
import { Text, View } from "nsh";
import { Haptics } from "nsh/mobile";

function SaveButton() {
  return (
    <View
      onPress={async () => {
        const saved = await save();
        Haptics.notification(saved ? "success" : "error");
      }}
    >
      <Text>Save</Text>
    </View>
  );
}
```

```rust tabs
use nsh_core::prelude::*;

fn save_button() -> impl IntoElement {
    view().child(text("Save")).on_press(|_| {
        spawn(async {
            let saved = save().await;
            haptic(if saved.is_ok() {
                Haptic::Notification(HapticNotification::Success)
            } else {
                Haptic::Notification(HapticNotification::Error)
            });
        });
    })
}
```

状态栏在 iOS 和 Android 上都由 `nsh/base` 中[页面和对话框](./nsh-base.md#status-bar)的 `statusBar` 设置。

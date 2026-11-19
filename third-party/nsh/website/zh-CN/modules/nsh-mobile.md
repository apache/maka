---
title: nsh/mobile
description: iOS 和 Android 的 API：系统标签栏 TabBar、系统日期时间选择器 DateTimePicker、iOS 的系统分段控件 SegmentedControl、系统开关 Switch、触感反馈 Haptics、iOS 的 InputAccessoryView、Android 的 BackHandler，以及 isAvailable。
order: 12.2
---

# nsh/mobile

`nsh/mobile` 收录 iOS 和 Android 的专属能力：两者都有的系统标签栏 `TabBar`、系统日期时间选择器 [`DateTimePicker`](#datetimepicker)、系统开关 [`Switch`](#switch) 和设备的触感反馈 [`Haptics`](#haptics)；iOS 的系统分段控件 [`SegmentedControl`](#segmentedcontrol) 和 [`InputAccessoryView`](#inputaccessoryview)，键盘上方的工具栏；Android 的 [`BackHandler`](#backhandler)，返回键。Rust 代码使用 `nsh_core::mobile` 和 `nsh_core::prelude`；TSX 导入 `nsh/mobile`。这个模块在所有平台上都可以导入，所以同一个 bundle 能在各处运行：在其他平台上，它的组件不占空间、调用立即返回，`isAvailable` 告诉你当前是否在 iOS 或 Android 上（`nsh` 的 `platform.os` 区分具体平台）。桌面的能力在 [nsh/desktop](./nsh-desktop.md) 中。

```rust tabs
use nsh_core::mobile::{
    DateTimePickerMode, DateTimePickerValue, SegmentedControlItem, TabBarItem, date_time_picker, segmented_control,
    switch, tab_bar,
};
```

```tsx tabs
import {
  BackHandler,
  DateTimePicker,
  Haptics,
  InputAccessoryView,
  isAvailable,
  SegmentedControl,
  Switch,
  TabBar,
} from "nsh/mobile";
import type {
  DateTimePickerMode,
  DateTimePickerProps,
  SegmentedControlItem,
  SegmentedControlProps,
  SwitchProps,
  TabBarItem,
  TabBarProps,
} from "nsh/mobile";
```

## 模块范围

这个模块提供移动平台专属的能力，例如用于应用顶层导航的系统标签栏。通用控件属于 [`nsh/base`](./nsh-base.md)：例如 [Switch](../elements/switch.md) 在手机、桌面和 Web 上共享行为与 API，轨道、滑块和各状态的样式由应用提供。`TabBar` 服务于移动应用导航，`Tabs` 服务于跨平台的标签内容切换。这个模块仅接受具有移动平台专属交互语义的能力。系统外观、尺寸或动画本身仍属于通用控件的共享职责。这个职责区别决定哪些能力适合放在这里（[目标与设计原则](../docs/goals.md)）。`SegmentedControl` 是系统自己的控件，供确实需要 iOS 原生分段控件的应用使用；在所有平台上以应用自己的外观做选择，用 `nsh/base` 的 [ToggleGroup](../elements/toggle.md) 或 [RadioGroup](../elements/radio.md)。同样，`DateTimePicker` 是手机上系统自己的日期时间选择器；在所有平台上以应用自己的外观选择日期和时间，用 `nsh/base` 的 [DatePicker](../elements/date-picker.md) 或 [TimeField](../elements/time-field.md)。`Switch` 同理：它是系统自己的开关，供确实需要 iOS 和 Android 原生开关的应用使用；在所有平台上以应用自己的外观显示开关，用 `nsh/base` 的 [Switch](../elements/switch.md)。

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
        onChange={({ index }) => section.set(index)}
        class="absolute inset-x-0 bottom-0"
      />
    </View>
  );
}

mount(App);
```

`TabBar` 来自 `nsh/mobile`，在 Rust 中是 `nsh_core::mobile`。选中状态属于应用：一次点按通过 `onChange` 报告该标签的索引（`{ index }`），标签栏像系统的一样立即显示这次选择，应用显示那一部分并把索引作为 `selectedIndex` 传回。样式没有给定高度时，高度是系统的。在 Rust 中，`tab_bar()` 创建它，每个 prop 一个 setter（`.items(..)`、`.selected_index(..)`），每个事件一个监听方法（`.on_change(..)`），以及带类型的样式方法；`TabBarItem::new(title).icon(name).badge(text)` 创建一个标签。

### Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `TabBarItem[]` | `[]` | 各个标签，按顺序。 |
| `selectedIndex` | `.selected_index(..)` | `number` | `0` | 选中的标签的索引；超出标签数量的索引不选中任何标签。 |
| `hidden` | `.hidden(..)` | `boolean` | `false` | iOS：立即隐藏标签栏。应用在页面推入和弹出期间持有这个值；当它和当前可见导航栈的 `hidesBottomBarWhenPushed` 请求都为 false 时，标签栏显示。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 标签栏的位置和尺寸。外观是系统的，选中的标签使用主题的 `primary`。 |
| `testID` | `.test_id(..)` | `string` | 无 | 在测试和 `nsh test --trace` 中找到标签栏。 |

#### TabBarItem

| 字段 | Rust | 类型 | 说明 |
|---|---|---|---|
| `title` | `TabBarItem::new(title)` | `string` | 标签的标题，屏幕阅读器会读出它。 |
| `icon` | `.icon(name)` | `string` | 标签的图标，用平台对它的称呼：iOS 上是 [SF Symbol](https://developer.apple.com/sf-symbols/)（`"house"`），Android 上是应用的 drawable（`res/drawable/home.xml` 写作 `"home"`，`"android:ic_menu_search"` 是系统的）。用 `platform.select` 按平台选择。 |
| `badge` | `.badge(text)` | `string` | 标签的角标：一段文字，例如 `"3"` 或 `"New"`，或者 `""` 表示没有文字的角标；不设置（默认）则不显示。采用系统的角标外观，屏幕阅读器会随标签的标题读出它：它的文字；`""` 则读出系统对没有文字的角标的说法（VoiceOver 的；在 Android 上是系统的“新通知”，使用设备的语言）。 |

### 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|index: &u32\| ..)` | 用户选择了一个标签：`{ index }`，它的索引。标签栏立即显示这次选择；应用显示该标签的内容并设置 `selectedIndex`。 |

### 平台说明

- **iOS 和 Mac Catalyst**：`UITabBar`，采用当前 iOS 版本的系统外观：iOS 26 上是悬浮的 Liquid Glass 标签栏及其选中效果。图标是 SF Symbols。主题的 `primary` 是标签栏的 `tintColor`，即选中标签的颜色；其他标签保持系统的颜色。角标是标签项的 `badgeValue`：文字完整显示，`""` 是系统没有文字的角标，大小与一位数字的角标相同。
- **Android**：Material 3 的导航栏，由平台的 View 组成：每个标签的文字上方是放在激活指示器中的图标，按压时有水波纹；Android 12 及以上使用系统的动态颜色，更早的版本使用 Material 的基准颜色；浅色或深色跟随应用的外观。位于窗口底部时，它延伸到导航栏下方，高度增加导航栏的 inset，与 Material 的一致。图标是应用的 drawable（由标签栏着色）。选中标签的图标和文字使用主题的 `primary`，激活指示器是这个颜色的 12% 不透明度；其他标签保持系统的颜色。角标采用 Material 3 的样式：`""` 是位于图标角上的小角标（圆点），文字是从图标中部开始的大角标，使用它的 error 颜色，超出激活指示器的部分以省略号结尾。大角标与 Material 的一样只容纳简短的文字，即一个数字或不超过四个字符的词：更长的文字会被截断（`"Updated"` 显示为“Up…”），而 iOS 会完整显示。TalkBack 把 `""` 读作系统的“新通知”。
- **桌面（macOS、Windows、Linux、GPUI）和 Web**：各个部分用 [Tabs](../elements/tabs.md) 显示，外观由应用决定。`TabBar` 在这些平台上不占空间，所以一个布局可以同时包含两者，用 `platform.os`（[`nsh` 的设备 API](./nsh.md#device)）来选择。

## SegmentedControl

分段控件在原地从少数几个选项中选一个：浅色或深色，日、周或月。`SegmentedControl` 在 iOS 和 iPadOS 上就是系统自己的 `UISegmentedControl`，因此有系统的外观（iOS 26 及以后为 Liquid Glass）、动效、VoiceOver 朗读（“浅色，按钮，已选中，第 1 项，共 2 项”）和键盘焦点。

```tsx
import { signal } from "nsh";
import { SegmentedControl } from "nsh/mobile";

const appearance = signal(0);

<SegmentedControl
  items={[{ title: "浅色", icon: "sun.max" }, { title: "深色", icon: "moon" }]}
  selectedIndex={appearance()}
  onChange={({ index }) => appearance.set(index)}
  style={{ alignSelf: "stretch" }}
/>;
```

选择由应用掌握：点按时 `onChange` 报告分段的序号（`{ index }`），控件像系统的一样立即显示这个选择，应用再把序号作为 `selectedIndex` 传回。新的 `items` 原地更新分段（分段数量不变时控件保持原样，改名或禁用的分段不会闪烁）。样式未指定的尺寸取系统的尺寸；样式给出的宽度由各分段平分。在 Rust 中，`segmented_control()` 创建一个，每个属性有对应的 setter，事件用 `.on_change(..)`；`SegmentedControlItem::new(title).icon(name).disabled(true)` 创建一个分段。

### 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `SegmentedControlItem[]` | `[]` | 各分段，按顺序。 |
| `selectedIndex` | `.selected_index(..)` | `number` | `0` | 选中的分段序号；超出分段数量的序号表示不选中任何分段。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不能选择任何分段：系统将控件调暗。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 控件的位置和尺寸。外观由系统决定。 |
| `testID` | `.test_id(..)` | `string` | 无 | 在测试和 `nsh test --trace` 中找到这个控件。 |

#### SegmentedControlItem

| 字段 | Rust | 类型 | 说明 |
|---|---|---|---|
| `title` | `SegmentedControlItem::new(title)` | `string` | 分段的标题：显示的内容，也是 VoiceOver 朗读的内容。 |
| `icon` | `.icon(name)` | `string` | 代替标题显示的 [SF Symbol](https://developer.apple.com/sf-symbols/)，VoiceOver 仍朗读标题。 |
| `disabled` | `.disabled(..)` | `boolean` | 这个分段不能选择。 |

### 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|index: &u32\| ..)` | 用户选择了另一个分段：`{ index }`。控件立即显示这个选择；应用设置 `selectedIndex`。 |

### 平台说明

- **iOS 和 Mac Catalyst**：`UISegmentedControl`，外观取决于 iOS 版本和应用链接的 SDK：iOS 26 及以后为 Liquid Glass。
- **Android、桌面和 Web**：`SegmentedControl` 不占空间、不显示，因此同一布局可兼顾两者：在这些平台上用 [ToggleGroup](../elements/toggle.md) 或 [RadioGroup](../elements/radio.md) 显示选择，按 `platform.os` 选用。

## Switch

开关打开或关闭一项设置。`Switch` 是系统自己的开关：iOS 和 iPadOS 上是 `UISwitch`，Android 上是 Material 3 的开关。它有系统的外观（iOS 26 及以后为 Liquid Glass）、拨动和拖动时的动效、触感反馈和读屏朗读（“无线局域网，开关按钮，开”）。

```tsx
import { signal } from "nsh";
import { Switch } from "nsh/mobile";

const wifi = signal(true);

<Switch accessibilityLabel="无线局域网" checked={wifi()} onChange={({ checked }) => wifi.set(checked)} />;
```

值由应用掌握：拨动时 `onChange` 报告用户要的值（`{ checked }`），开关像系统的一样立即移过去，应用再把值作为 `checked` 传回。应用不采纳（拒绝这次拨动）时，开关移回原值。样式未指定的尺寸取系统的尺寸，所以一行里可以和其他内容一起摆放。打开时用主题的 `primary` 色；没有时用系统的颜色。在 Rust 中，`switch()` 创建一个，每个属性有对应的 setter，事件用 `.on_change(..)`。

### 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `checked` | `.checked(..)` | `boolean` | `false` | 开或关。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不能拨动：系统将它调暗。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 读屏随状态朗读的名字：它打开的那项设置。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 开关的位置。外观和尺寸由系统决定。 |
| `testID` | `.test_id(..)` | `string` | 无 | 在测试和 `nsh test --trace` 中找到这个开关。 |

### 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|checked: &bool\| ..)` | 用户拨动了开关：`{ checked }`，它要的值。开关立即移过去；应用设置 `checked`。 |

### 平台说明

- **iOS 和 Mac Catalyst**：`UISwitch`，外观取决于 iOS 版本和应用链接的 SDK：iOS 26 及以后为 Liquid Glass。
- **Android**：框架的开关，画成 Material 3 的轨道和滑块，Android 12 及以后用系统的动态颜色（之前用 Material 的基准颜色），跟随应用的浅色或深色外观。
- **桌面和 Web**：`Switch` 不占空间、不显示，因此同一布局可兼顾两者：在这些平台上用 `nsh/base` 的 [Switch](../elements/switch.md) 显示这项设置，按 `isAvailable` 选用。

## DateTimePicker

日期时间选择器设置一个日期、一个时刻或两者：提醒的时间、日程的结束日期。`DateTimePicker` 是系统自己的选择器，因此有系统的外观、格式、日历和无障碍：在 iOS 和 iPadOS 上是紧凑样式的 `UIDatePicker`，值显示在胶囊里，点开是系统的日历或时间滚轮；在 Android 上值显示在字段里，点开是系统的日期或时间对话框。

```tsx
import { signal } from "nsh";
import { DateTimePicker } from "nsh/mobile";

const at = signal("2026-11-17T09:30");

<DateTimePicker
  mode="dateTime"
  value={at()}
  min="2026-11-17T00:00"
  minuteInterval={5}
  accessibilityLabel="提醒时间"
  onChange={({ value }) => at.set(value)}
/>;
```

值是对应模式的 ISO 字符串，与 HTML 的日期和时间输入框相同：`date` 是 `"2026-11-17"`，`time` 是 `"09:30"`，`dateTime` 是 `"2026-11-17T09:30"`。它们是挂钟时间：选择器原样显示，由应用对应到它所指的时区。值由应用掌握：选择后 `onChange` 报告新值（`{ value }`），选择器像系统的一样立即显示它，应用再把它作为 `value` 传回。没有值时选择器显示当前时刻。形式不属于当前模式的 `value`、`min` 或 `max` 不会被当作别的值显示：NSH 记录一条警告并忽略它。样式未指定的尺寸取系统的尺寸。在 Rust 中，`date_time_picker()` 创建一个，每个属性有对应的 setter，事件用 `.on_change(..)`；值是 `DateTimePickerValue`，可由 `chrono` 的 `NaiveDate`、`NaiveTime` 和 `NaiveDateTime` 得到。

### 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `mode` | `.mode(..)` | `"date" \| "time" \| "dateTime"` | `"date"` | 选什么：日期、时刻，或两者。 |
| `value` | `.value(..)` | `string \| null` | `null` | 显示的值，取当前模式的形式；`null` 显示当前时刻。 |
| `min` | `.min(..)` | `string \| null` | `null` | 用户能选的最早的值。 |
| `max` | `.max(..)` | `string \| null` | `null` | 用户能选的最晚的值。 |
| `minuteInterval` | `.minute_interval(..)` | `number` | `1` | 可选的分钟之间相隔的分钟数：1 到 30 之间 60 的约数。其他数字记录警告，按 1 分钟。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不能修改：系统将它调暗。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 读屏随值朗读的名字：它设置的是什么。选择器只显示值，所以传入它所在那一行的名称。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 选择器的位置和尺寸。外观由系统决定。 |
| `testID` | `.test_id(..)` | `string` | 无 | 在测试和 `nsh test --trace` 中找到这个选择器。 |

### 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|value: &DateTimePickerValue\| ..)` | 用户选了一个值：`{ value }`，取当前模式的形式。选择器立即显示它；应用设置 `value`。 |

### 平台说明

- **iOS 和 Mac Catalyst**：紧凑样式的 `UIDatePicker`；`dateTime` 时日期和时刻是两个胶囊。日历和时间滚轮是系统的，使用用户的语言区域、日历和时钟制式。
- **Android**：值以系统的格式和用户的 12 或 24 小时制显示，每部分一个字段；按下时打开系统的日期或时间对话框。时间对话框提供每一分钟：落在 `minuteInterval` 两档之间的选择取前一档，超出 `min` 或 `max` 的选择取边界。
- **桌面和 Web**：`DateTimePicker` 不占空间、不显示，因此同一布局可兼顾两者：在这些平台上用 [DatePicker](../elements/date-picker.md) 或 [TimeField](../elements/time-field.md) 选择，按 `platform.os` 选用。

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

另见[表单与键盘](../docs/forms-and-keyboard.md)。

## BackHandler

在 Android 上可用；在 iOS 上，它的监听器会被保留但不会被调用，`exitApp()` 立即返回。

```ts
const BackHandler: {
  on(event: "press", listener: () => boolean | void): () => void;
  exitApp(): void;
};
```

系统返回键和返回手势。对话框先处理返回操作（关闭对话框）；然后运行 `BackHandler` 的监听器，最后添加的最先运行；都不处理时，最上层的导航栈出栈，没有可返回的页面时应用退出。

| 成员 | Rust | 说明 |
|---|---|---|
| `on("press", listener)` | `on_back_press(listener)` | `listener` 处理了这次返回时返回 `true`。返回一个停止监听的函数；在组件渲染（或 effect 运行）期间添加的监听器随之停止，Rust 与 TSX 都是如此。 |
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

> [!NOTE]
> 监听器在系统已经派发了返回操作之后才运行：主线程从不等待应用的代码。只要注册了至少一个监听器，对话框不处理的返回操作就由 NSH 接管；没有监听器返回 `true` 时，由 NSH 自己让最上层的导航栈返回或退出应用。

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

状态栏在 iOS 和 Android 上都由 `nsh/base` 中[页面和对话框](./nsh-base.md#status-bar)的 `statusBar` 设置。

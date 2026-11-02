---
title: DatePicker
description: DatePicker 组件：从弹出的日历中选出一个日期、一段日期或一个日期和时间，桌面上是触发元素处的弹出层，手机上是 sheet，样式由应用决定。
group: base
demo: el-date-picker
---

# DatePicker

日期选择器从应用的触发元素打开一个 [Calendar](./calendar.md) 来设置日期：截止日期、生日，在 `range` 时是一次旅行的日期，在 `timePrecision` 时是一个日期加一天中的时间。与 [Select](./select.md) 一样，它按每种设备的习惯打开：

- 在桌面平台和桌面浏览器上，是触发元素处的弹出层；打开时键盘落在日期上。
- 在手机和平板上，是屏幕底部、覆盖在背景层之上的 sheet。

选择器负责行为：值（应用的，或它自己的）、展开状态、日历、时间、预设、键盘，以及屏幕阅读器听到的内容。外观由应用决定：应用绘制触发元素（显示值、占位文字、图标），并为弹出层、日历的部件、预设和时间输入框设置样式。

```rust tabs
use chrono::NaiveDate;
use nsh_base::{DateRangePreset, DateTime, PickedDate, date_picker, theme};
use nsh_core::prelude::*;

fn trip_dates() -> impl IntoElement {
    let trip = signal(DateTime::Range(None, None));
    let title = move || {
        trip.get()
            .format("%b %-d")
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Pick dates".to_string())
    };
    let day = |m, d| NaiveDate::from_ymd_opt(2026, m, d).unwrap();
    date_picker()
        .range(true)
        .number_of_months(2)
        .value(move || trip.get())
        .on_change(move |next: &PickedDate| trip.set(next.value))
        .presets(vec![
            DateRangePreset::range("This week", day(10, 25), day(10, 31)),
            DateRangePreset::range("Next week", day(11, 1), day(11, 7)),
        ])
        .accessibility_label("Trip")
        .offset(px(4.0))
        .popup_style(|s| {
            s.p_3()
                .rounded_lg()
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().popover)
                .shadow_md()
        })
        .trigger(
            view()
                .h_9()
                .w_56()
                .px_3()
                .justify_center()
                .rounded_md()
                .border_1()
                .border_color(move || theme().input)
                .child(text(title)),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { DatePicker, type DatePickerValue } from "nsh/base";

function App() {
  const due = signal<DatePickerValue>(null);
  return (
    <DatePicker
      value={due()}
      onChange={({ value }) => due.set(value)}
      timePrecision="minute"
      cleanable
      clearButton={<Text>×</Text>}
      clearButtonAccessibilityLabel="Clear the due date"
      presets={[{ label: "Tomorrow 9:00", value: "2026-10-29T09:00" }]}
      accessibilityLabel="Due"
      offset={4}
      popupClass="rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md"
      backdropClass="bg-black/40"
      contentClass="flex-row gap-3"
      presetClass="rounded-md px-2 py-1.5 text-sm hover:bg-accent"
      headerClass="flex-row items-center justify-between"
      rowClass="flex-row justify-between"
      itemClass="h-8 min-w-8 items-center justify-center rounded-md text-sm focus:ring-2 focus:ring-ring selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
      timeClass="mt-2 gap-3"
      timeLabel={<Text class="text-sm">Time</Text>}
      timeAccessibilityLabel="Due time"
      timeFieldClass="flex-row rounded-md border border-input px-2 py-1"
      segmentClass="text-sm tabular-nums focus:bg-accent"
      trigger={
        <View class="h-9 w-56 justify-center rounded-md border border-input px-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <Text>{typeof due() === "string" ? (due() as string).replace("T", " ") : "Pick a date"}</Text>
        </View>
      }
    />
  );
}

mount(App);
```

`DatePicker` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`date_picker()` 创建一个日期选择器，每个属性有一个设置方法（`.value(..)`、`.range(..)`、`.time_precision(..)`），每个事件有一个监听方法（`.on_change(..)`）。它的值是 `DateTime`（`DateTime::Single`、`DateTime::Range`，由 `chrono` 的日期或日期时间构成）；`onChange` 给出一个 `PickedDate`，即值及选择器的时间精度。

<a id="value"></a>

## 值

值采用 HTML 输入框的格式：ISO 日期 `"2026-10-28"`，与 `<input type="date">` 的相同；在 `range` 时为 `[start, end]`；在 `timePrecision` 时为日期和时间 `"2026-10-28T09:30"`（精确到秒时为 `"2026-10-28T09:30:15"`），与 `<input type="datetime-local">` 的相同；`null` 表示没有。有 `value` 时，值由应用持有：选择器显示它，并用 `onChange({ value })` 报告每次变化；应用把 `value` 设为报告的值以跟随它。省略 `value` 时，选择器自己保存值，初始为 `defaultValue`。

- 单个日期：按下某一天会设置值并关闭弹出层。
- 在 `range` 时，第一次按压开始范围，第二次结束范围，与[日历的](./calendar.md#value)相同；完整的范围设置值并关闭弹出层。
- 在 `timePrecision` 时（仅限单个日期），日历下方显示一个时间输入框，时间的每次编辑都会报告。在桌面上，选中某一天时弹出层保持打开以便设置时间，并报告带时间的日期；再次按下已选中的日期会关闭弹出层。在手机和平板上，点一下某天就以它的时间选中这一天并关闭底部面板，与单个日期相同；再次打开面板即可设置时间。在设置任何时间之前选中的日期使用 `defaultTime`（默认 `00:00`）。`hourCycle` 是时间输入框的小时计法。

`cleanable` 会在有值时加一个清除按钮：按下它会清除值（`onChange({ value: null })`）。这个按钮在触发元素之后，不在它里面，所以按它不会打开弹出层；由应用摆放并填充内容（`clearButton`），和[选择框的清除按钮](./select.md#value)一样。

<a id="presets"></a>

## 预设

`presets` 是日历旁边设置值的按钮："今天"、"最近 7 天"、"明天 9 点"。每个是 `{ label, value }`，`value` 为一个日期、一个范围或日期时间，按原样保存；按下它会设置值并关闭弹出层。`contentClass` 排列预设列与日历和时间（一行，`flex-row`）；`presetsClass` 为这一列设置样式，`presetClass` 为每个按钮设置样式。

<a id="the-calendar"></a>

## 日历

[Calendar](./calendar.md) 除值以外的每个属性都会传给选择器的日历：`numberOfMonths`、`firstDayOfWeek`、`disabledMatcher`、`yearRange`、`previousAccessibilityLabel`、`nextAccessibilityLabel`、各部件（从 `headerClass` 到 `itemStyle`）和 `renderItem`。`calendarClass` 和 `calendarStyle` 为日历本身设置样式。它的视图和按键与日历的相同。

时间行（`timeClass`、`timeStyle`）是一行，其中各项垂直居中、两端分布（`flex-row items-center justify-between`，与 `gpui-component` 的相同）：开头是 `timeLabel`，即应用为它写的文字（"时间"），末尾是时间输入框（`timeFieldClass`、`timeFieldStyle`、`timeAccessibilityLabel`），其各段与 [TimeField](./time-field.md) 的相同（`segmentClass`、`separatorClass`、`renderSegment`）。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `DatePickerValue` | 无 | 值，由应用持有。 |
| `defaultValue` | `.default_value(..)` | `DatePickerValue` | `null` | 没有 `value` 时的初始值。 |
| `range` | `.range(..)` | `boolean` | `false` | 选择一段日期。 |
| `open`、`defaultOpen` | `.open(..)`、`.default_open(..)` | `boolean` | `false` | 展开状态，由应用或选择器自己持有。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 保持关闭，不接受按压和键盘焦点。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对它的称呼。 |
| `dateFormat` | `.date_format(..)` | `string` | `"%Y/%m/%d"` 加时间 | 屏幕阅读器听到的值的格式，采用 `chrono` 的格式。 |
| `timePrecision` | `.time_precision(..)` | `"minute" \| "second"` | 无 | 同时编辑一天中的时间，精确到此单位。 |
| `hourCycle` | `.hour_cycle(..)` | `"h23" \| "h12"` | `"h23"` | 时间输入框的小时计法。 |
| `defaultTime` | `.default_time(..)` | `string` | `"00:00"` | 用户设置时间之前日期使用的时间。 |
| `cleanable` | `.cleanable(..)` | `boolean` | `false` | 有值时显示清除按钮。 |
| `presets` | `.presets(..)` | `DateRangePreset[]` | `[]` | 弹出层中设置值的按钮。 |
| `numberOfMonths`、`firstDayOfWeek`、`disabledMatcher`、`yearRange` | 同 `Calendar` | 同 `Calendar` | 同 `Calendar` | 日历的月数、每周起始日、禁用的日期和年份。 |
| `previousAccessibilityLabel`、`nextAccessibilityLabel` | 同 `Calendar` | `string` | 无 | 屏幕阅读器对日历的"上一个"和"下一个"的称呼。 |
| `placement`、`align`、`offset`、`margin` | `.placement(..)` 等 | 同 `Select` | `"bottom"`、`"start"`、0、0 | 桌面平台：弹出层相对触发元素的位置。 |
| `popupClass`、`popupStyle` | `.popup_class(..)`、`.popup_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 弹出层（桌面平台）或 sheet（触屏设备）。 |
| `backdropClass`、`backdropStyle` | `.backdrop_class(..)`、`.backdrop_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | sheet 后面的背景层。 |
| `contentClass`、`contentStyle` | `.content_class(..)`、`.content_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 弹出层的内容：预设在日历和时间旁边。 |
| `presetsClass`、`presetsStyle` | `.presets_class(..)`、`.presets_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 预设列。 |
| `presetClass`、`presetStyle` | `.preset_class(..)`、`.preset_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每个预设按钮。 |
| `calendarClass`、`calendarStyle` | `.calendar_class(..)`、`.calendar_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 日历。 |
| `headerClass` … `itemStyle` | 同 `Calendar` | 同 `Calendar` | 无 | 日历的头部、主体、各月、各行和各条目。 |
| `renderItem` | `.render_item(..)` | `(item: CalendarItemState) => JSX.Element` | 无 | 由应用绘制的日历条目。 |
| `timeClass`、`timeStyle` | `.time_class(..)`、`.time_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 时间行：开头是它的标签，末尾是输入框。 |
| `timeLabel` | `.time_label(..)` | `JSX.Element` | 无 | 时间行在输入框前显示的内容。 |
| `timeFieldClass`、`timeFieldStyle` | `.time_field_class(..)`、`.time_field_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 时间输入框。 |
| `timeAccessibilityLabel` | `.time_accessibility_label(..)` | `string` | 无 | 屏幕阅读器对时间输入框的称呼。 |
| `segmentClass`、`segmentStyle`、`separatorClass`、`separatorStyle`、`renderSegment` | 同 `TimeField` | 同 `TimeField` | 无 | 时间输入框的各段和 `:`。 |
| `clearButtonClass`、`clearButtonStyle` | `.clear_button_class(..)`、`.clear_button_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 清除按钮（`cleanable`）。 |
| `clearButton` | `.clear_button(..)` | `JSX.Element` | 无 | 清除按钮的内容。 |
| `clearButtonAccessibilityLabel` | `.clear_button_accessibility_label(..)` | `string` | 无 | 屏幕阅读器对清除按钮的称呼。 |
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 按下时打开弹出层的元素；弹出层相对它放置。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 包住触发元素的视图。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | 值变化了（一天、范围的结束日、一个预设、时间、清除按钮）：`{ value }`。设置 `value` 以跟随它。 |
| `onOpenChange` | `.on_open_change(\|e\| ..)` | 弹出层打开或关闭了，以及原因（`{ open, reason }`）。设置 `open` 以跟随它。 |
| `onOpen`、`onClose` | `.on_open(..)`、`.on_close(..)` | 弹出层已显示，或已消失。 |
| `onCancel` | `.on_cancel(..)` | 用户没有做出选择就关闭了弹出层（Escape 或返回、在外面或背景层上按压）。 |

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 |
|---|---|---|
| 触发元素 | 选择器的视图 | 应用自己的元素（`trigger`） |
| 清除按钮 | 选择器的视图，触发元素之后（`cleanable`，有值时） | `clearButtonClass`、`clearButtonStyle`；内容 `clearButton` |
| 弹出层或 sheet | 在一切之上，位于触发元素处（桌面平台）或底部（触屏设备） | `popupClass`、`popupStyle` |
| 背景层 | sheet 后面（触屏设备） | `backdropClass`、`backdropStyle` |
| 内容 | 弹出层中 | `contentClass`、`contentStyle` |
| 预设 | 内容中的第一个（`presets`） | `presetsClass`、`presetsStyle`；每个 `presetClass`、`presetStyle` |
| 日历 | 内容中 | `calendarClass`、`calendarStyle`，以及 [Calendar](./calendar.md#parts) 的部件 |
| 时间行 | 日历下方（`timePrecision`） | `timeClass`、`timeStyle`；标签 `timeLabel` |
| 时间输入框 | 时间行中 | `timeFieldClass`、`timeFieldStyle`，以及 [TimeField](./time-field.md#parts) 的部件 |

<a id="keyboard"></a>

## 键盘

| 按键 | 操作 |
|---|---|
| Return（在触发元素上） | 打开或关闭弹出层。 |
| Delete、Backspace（在触发元素上） | 弹出层关闭时清除值。 |
| Escape | 不做选择就关闭弹出层。 |

在弹出层中，日历的按键在日期间移动并选中一天（见[键盘](./calendar.md#keyboard)），时间输入框的按键编辑时间（见[键盘](./time-field.md#keyboard)）。

<a id="accessibility"></a>

## 无障碍

- 触发元素对屏幕阅读器来说是一个组合框（combobox）：它的标签是 `accessibilityLabel`，值是按 `dateFormat` 写出的日期（默认 `2026/10/28`，在 `timePrecision` 时带时间），并说明弹出层是否展开。`disabled` 时它显示为不可用。
- 日历的日期是按钮，以其 ISO 日期命名（见[无障碍](./calendar.md#accessibility)）；预设是按钮，以其标签命名；时间输入框的名称来自 `timeAccessibilityLabel`。
- 清除按钮是一个按钮，名称来自 `clearButtonAccessibilityLabel`。

关于标签、角色和播报的一般说明，见[无障碍](../docs/accessibility.md)。

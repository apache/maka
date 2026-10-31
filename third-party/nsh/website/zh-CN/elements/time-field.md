---
title: TimeField
description: TimeField 组件：逐段编辑一天中的时间，时、分、秒，使用键盘或手机的数字键盘，样式由应用决定。
group: base
demo: el-date-picker
---

# TimeField

时间输入框逐段编辑一天中的时间：小时、分钟，在 `precision="second"` 时还有秒，在 `hourCycle="h12"` 时还有上午或下午。一个提醒的时间、一场会议的开始、一家店的营业时间。它就是 [DatePicker](./date-picker.md) 在 `timePrecision` 时日历下方的时间，单独放在页面中。

时间输入框负责行为：时间（应用的，或它自己的）、按键编辑哪一段、输入和步进数字，以及屏幕阅读器听到的内容。外观由应用决定：应用为各段和它们之间的 `:` 设置样式，或者自己绘制各段。

```rust tabs
use chrono::NaiveTime;
use nsh_base::{HourCycle, TimeFieldSegmentState, TimeOfDay, time_field, theme};
use nsh_core::prelude::*;

fn reminder_time() -> impl IntoElement {
    let at = signal(TimeOfDay(NaiveTime::from_hms_opt(9, 30, 0).unwrap()));
    time_field()
        .value(move || Some(at.get()))
        .on_change(move |next: &TimeOfDay| at.set(*next))
        .hour_cycle(HourCycle::H12)
        .accessibility_label("Reminder time")
        .render_segment(|segment: &TimeFieldSegmentState| {
            view()
                .px_1()
                .rounded_sm()
                .when(segment.selected, |v| v.bg(move || theme().accent))
                .child(text(segment.label.clone()))
        })
}
```

```tsx tabs
import { mount, signal } from "nsh";
import { TimeField } from "nsh/base";

function App() {
  const at = signal("09:30");
  return (
    <TimeField
      value={at()}
      onChange={({ value }) => at.set(value)}
      hourCycle="h12"
      accessibilityLabel="Reminder time"
      class="h-9 w-32 flex-row items-center rounded-md border border-input px-2"
      segmentClass="rounded-sm px-0.5 text-sm tabular-nums focus:bg-accent focus:text-accent-foreground"
      separatorClass="text-sm text-muted-foreground"
    />
  );
}

mount(App);
```

`TimeField` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`time_field()` 创建一个时间输入框，每个属性有一个设置方法（`.value(..)`、`.precision(..)`、`.hour_cycle(..)`），每个事件有一个监听方法（`.on_change(..)`）。它的时间是 `TimeOfDay`，即一个 `chrono::NaiveTime`。

<a id="value"></a>

## 值

值是 24 小时制的一天中的时间，与 HTML `<input type="time">` 的相同：`"HH:MM"`，在 `precision="second"` 时为 `"HH:MM:SS"`，不论输入框显示哪种 `hourCycle`。有 `value` 时，值由应用持有：输入框显示它，并用 `onChange({ value })` 报告每次编辑；应用把 `value` 设为报告的值以跟随它。省略 `value` 时，输入框自己保存时间，初始为 `defaultValue`（默认 `00:00`）。

`precision` 是输入框编辑的最小单位，`"minute"`（默认）或 `"second"`。`hourCycle` 是小时的计法：`"h23"`（默认）从 00 到 23，`"h12"` 从 12 到 11，并在数字后加一个上午/下午段。

<a id="editing"></a>

## 编辑

总有一段被选中；按键编辑它，与 `gpui-base` 的时间输入框相同：

- Up 和 Down 把这一段加减一，到头后回绕（59 到 00），不会进位到相邻的段。
- 数字输入到这一段，每段两位：一个不能作为更长数值开头的数字（小时里的 `7`）会直接填完这一段并移到下一段。
- `a` 和 `p` 设为上午和下午。
- Backspace 和 Delete 重置这一段。

按下某一段会选中它。按下已选中的上午/下午段会切换它，因为手机上没有 `a` 和 `p` 键。按键交给各段后面一个透明的原生文本输入框，与 [OtpInput](./otp-input.md) 的一样：在手机和平板上它会弹出数字键盘。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | 无 | 时间，由应用持有。 |
| `defaultValue` | `.default_value(..)` | `string` | `"00:00"` | 没有 `value` 时的初始时间。 |
| `precision` | `.precision(..)` | `"minute" \| "second"` | `"minute"` | 编辑的最小单位。 |
| `hourCycle` | `.hour_cycle(..)` | `"h23" \| "h12"` | `"h23"` | 小时的计法；`"h12"` 会加一个上午/下午段。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不接受焦点和编辑；输入框和各段应用 `disabled:` 样式。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对输入框的称呼。 |
| `segmentClass`、`segmentStyle` | `.segment_class(..)`、`.segment_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每一段：输入框有焦点时选中的段应用 `focus:`，随输入框应用 `disabled:`。 |
| `separatorClass`、`separatorStyle` | `.separator_class(..)`、`.separator_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 数字之间的每个 `:`。 |
| `renderSegment` | `.render_segment(..)` | `(segment: TimeFieldSegmentState) => JSX.Element` | 无 | 由应用绘制的段内容；否则显示其标签。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 输入框，包住各段（一行）。 |

`renderSegment` 得到一个 `TimeFieldSegmentState`：`segment`（`"hour"`、`"minute"`、`"second"` 或 `"period"`）、`value`（输入框钟面上的小时、分钟或秒；上午为 `0`，下午为 `1`）、`label`（两位数字，或 `AM` / `PM`）、`selected`（按键编辑它）和 `disabled`。

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | 用户改变了时间：`{ value }`。设置 `value` 以跟随它。应用传入的 `value` 从不被报告。 |

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 |
|---|---|---|
| 输入框 | 根，一行 | `class`、`style` |
| 段 | 输入框中：小时、分钟、秒、上午/下午 | `segmentClass`、`segmentStyle`、`renderSegment` |
| 分隔符 | 输入框中，两个数字之间 | `separatorClass`、`separatorStyle` |

<a id="keyboard"></a>

## 键盘

Tab 到达输入框时停在选中的段上。然后：

| 按键 | 操作 |
|---|---|
| Left / Right | 前一段或后一段。 |
| Tab / Shift+Tab | 后一段或前一段；在最后一段按 Tab、在第一段按 Shift+Tab 会离开输入框。 |
| Up / Down | 把这一段加减一，到头回绕。 |
| 0 到 9 | 输入到这一段。 |
| A / P | 上午或下午。 |
| Backspace、Delete | 重置这一段。 |

<a id="accessibility"></a>

## 无障碍

- 输入框是一个文本输入框，名称来自 `accessibilityLabel`；屏幕阅读器读出它显示的时间。`disabled` 时它显示为不可用。
- 手机和平板显示数字键盘。

关于标签、角色和播报的一般说明，见[无障碍](../docs/accessibility.md)。

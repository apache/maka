---
title: Calendar
description: Calendar 组件：从按周排列的月份中选出一个日期或一段日期，带月份和年份视图与键盘操作，样式由应用决定。
group: base
demo: el-date-picker
---

# Calendar

日历从按周排列的月份中选出一个日期，或者在 `range` 时选出一段日期：表单里的截止日期、一次住宿的几晚、一份报告的天数。它显示一个月，或并排显示几个月，用"上一个"和"下一个"翻月，并可切换到一年中各月的视图或一页年份，以便跳得更远。它就是 [DatePicker](./date-picker.md) 弹出层里的日历，单独放在页面中。

日历负责行为：值（应用的，或它自己的）、显示的月份、视图、不能选的日期、键盘，以及屏幕阅读器听到的内容。外观由应用决定：应用为头部、主体、每个月、每一行和每个条目设置样式，并绘制条目的内容（月份和星期的名称、今天的标记、范围的色带）。日历的网格像表格的列一样填满给它的宽度：几个月平分它，一行里的条目平分这一行，所以手机底部面板里的日历横跨整个屏幕，而按内容定宽的弹出层里的日历保持条目自身的宽度（在 `itemClass` 或 `monthClass` 里写 `flex-none` 可让条目或月份保持自身宽度）。

```rust tabs
use nsh_base::{CalendarItemKind, CalendarItemState, Date, Matcher, calendar, theme};
use nsh_core::prelude::*;

const MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS: [&str; 7] = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

fn due_date() -> impl IntoElement {
    let due = signal(Date::default());
    calendar()
        .value(move || due.get())
        .on_change(move |next: &Date| due.set(*next))
        .disabled_matcher(Matcher::DayOfWeek(vec![0, 6]))
        .previous_accessibility_label("Previous month")
        .next_accessibility_label("Next month")
        .render_item(|item: &CalendarItemState| {
            let label = match item.kind {
                CalendarItemKind::Previous => "‹".to_string(),
                CalendarItemKind::Next => "›".to_string(),
                CalendarItemKind::Weekday => WEEKDAYS[item.value as usize].to_string(),
                CalendarItemKind::MonthToggle | CalendarItemKind::Month => {
                    MONTHS[item.value as usize - 1].to_string()
                }
                _ => item.value.to_string(),
            };
            view()
                .w_8()
                .h_8()
                .items_center()
                .justify_center()
                .rounded_md()
                .when(item.active, |v| v.bg(move || theme().primary))
                .child(text(label).text_sm())
        })
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Calendar, type CalendarValue } from "nsh/base";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function App() {
  const due = signal<CalendarValue>(null);
  return (
    <Calendar
      value={due()}
      onChange={({ value }) => due.set(value)}
      disabledMatcher={[0, 6]}
      previousAccessibilityLabel="Previous month"
      nextAccessibilityLabel="Next month"
      class="w-72 gap-2 rounded-lg border border-border p-3"
      headerClass="flex-row items-center justify-between"
      rowClass="flex-row justify-between"
      itemClass="h-8 min-w-8 items-center justify-center rounded-md text-sm focus:ring-2 focus:ring-ring selected:bg-primary selected:text-primary-foreground disabled:opacity-50"
      renderItem={(item) => (
        <Text class={item.today ? "font-semibold" : ""}>
          {item.kind === "weekday"
            ? WEEKDAYS[item.value]
            : item.kind === "month" || item.kind === "monthToggle"
              ? MONTHS[item.value - 1]
              : item.kind === "previous"
                ? "‹"
                : item.kind === "next"
                  ? "›"
                  : String(item.value)}
        </Text>
      )}
    />
  );
}

mount(App);
```

`Calendar` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`calendar()` 创建一个日历，每个属性有一个设置方法（`.value(..)`、`.range(..)`、`.number_of_months(..)`），每个事件有一个监听方法（`.on_change(..)`）。它的值是 `Date`（`Date::Single`、`Date::Range`，由一个 `chrono::NaiveDate` 或一对日期构成），禁用的日期是 `Matcher`。

<a id="value"></a>

## 值

值是一个 ISO 日期 `"2026-10-28"`，与 HTML `<input type="date">` 的相同；在 `range` 时是 `[start, end]`，`null` 表示没有日期。有 `value` 时，值由应用持有：日历把它显示为已选，并用 `onChange({ value })` 报告一次选择；应用把 `value` 设为报告的值以跟随它。省略 `value` 时，日历自己保存值，初始为 `defaultValue`。

`onChange` 只报告完整的值，与 `gpui-base` 的 `Selected` 相同：按下的一天，或范围的结束日。

- 不设 `range` 时，按下某一天就选中它。
- 在 `range` 时，第一次按压开始范围，第二次结束范围，两者之间的日期都在范围内（每一天的 `inRange`，包括两端）。第二次按在更早的一天上会从那一天重新开始范围，范围完整之后再按也一样。半个范围会一直显示，直到完整时才被报告。

日历打开时显示值所在的月份（范围的开始日），没有值则显示今天所在的月份。

<a id="months-and-views"></a>

## 月份与视图

`numberOfMonths` 从显示的月份起并排显示这么多个月；"上一个"和"下一个"每次翻一个月。`firstDayOfWeek` 是每周的第一天，`0` 为星期日（默认）到 `6` 为星期六。

头部包含"上一个"、两个切换按钮和"下一个"：

- 日视图显示各月的日期，每个月是一列，包含星期行和各周；前后月份的日期补满各周，并为 `muted`。
- 月份切换按钮（`monthToggle`）打开月份视图：十二个月，每行三个。选中一个会在日视图中显示它。
- 年份切换按钮（`yearToggle`）打开年份视图：一页 20 年，每行五个，"上一个"和"下一个"翻页。选中一个会在日视图中显示那一年。`yearRange` 是翻页经过的年份，`[start, end)`（默认：今年之前 50 年到之后 50 年）。

显示多个月时，头部用每个月的标题代替切换按钮（一个不接受按压的 `monthToggle` 条目），与 `gpui-base` 的相同。

<a id="disabled-dates"></a>

## 禁用的日期

`disabledMatcher` 是用户不能选的日期，即 `gpui-base` 的 `Matcher`，有四种形式：

| 形式 | 禁用 |
|---|---|
| `[0, 6]` | 这些星期几，`0` 为星期日到 `6` 为星期六。 |
| `{ before, after }` | `before` 之前和 `after` 之后的日期（任一可省略）。 |
| `{ from, to }` | 从 `from` 到 `to` 的日期，包括两端（省略的一端不限）。 |
| `(date) => boolean` | 函数返回 `true` 的日期，传入每个显示日期的 ISO 日期。 |

函数对每个显示的日期调用一次，在下一个 JS 轮次中调用，已回答过的日期不再询问：翻月只询问新出现的日期，所以它的结果应只取决于日期。传入另一个函数会重新询问。被禁用的日期为 `disabled` 和 `muted`，不接受按压，Return 和 Space 也不会选中它。

<a id="items"></a>

## 条目

日历中每个可按压的目标和标签都是一个条目："上一个"、切换按钮、"下一个"、星期、日期、月份和年份。每个条目绘制在一个由 `itemClass` 和 `itemStyle` 设置样式的部件中，其变体跟随状态：选中时应用 `selected:`（日期或范围的一端、显示的月份或年份、已打开视图的切换按钮），不接受按压时应用 `disabled:`，键盘在它上面时应用 `focus:`。

`renderItem` 根据条目的 `CalendarItemState` 绘制其内容：

| 字段 | 含义 |
|---|---|
| `kind` | `"previous"`、`"monthToggle"`、`"yearToggle"`、`"next"`、`"weekday"`、`"day"`、`"month"` 或 `"year"`。 |
| `value` | 它的数字：一个月中的第几天、月份（1 到 12）、年份、星期几（`0` 为星期日到 `6`）；"上一个"和"下一个"为 `0`。 |
| `date` | 某一天的 ISO 日期。 |
| `year`、`month` | 它所属的年份和月份，否则为显示的年月。 |
| `active` | 它被选中。 |
| `inRange` | 完整范围内的一天，包括两端。 |
| `muted` | 星期、前后月份的日期、被禁用的日期。 |
| `disabled` | 它不接受按压。 |
| `today` | 这一天是今天。 |
| `focused` | 键盘在这一天上。 |

不设 `renderItem` 时，条目显示它的数字，"上一个"和"下一个"显示 `‹` 和 `›`，与 `gpui-base` 的相同；星期也显示它的数字 `0` 到 `6`，因为月份和星期的名称是应用用自己的语言说的话。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `CalendarValue` | 无 | 值，由应用持有。 |
| `defaultValue` | `.default_value(..)` | `CalendarValue` | `null` | 没有 `value` 时的初始值。 |
| `range` | `.range(..)` | `boolean` | `false` | 选择范围：第一次按压开始，第二次结束。 |
| `numberOfMonths` | `.number_of_months(..)` | `number` | `1` | 并排显示几个月。 |
| `firstDayOfWeek` | `.first_day_of_week(..)` | `number` | `0` | 每周的第一天，`0` 为星期日到 `6` 为星期六。 |
| `disabledMatcher` | `.disabled_matcher(..)` | `DateMatcher` | 无 | 不能选的日期。 |
| `yearRange` | `.year_range(..)` | `[number, number]` | 前后各 50 年 | 年份视图翻页经过的年份，`[start, end)`。 |
| `previousAccessibilityLabel` | `.previous_accessibility_label(..)` | `string` | 无 | 屏幕阅读器对"上一个"的称呼。 |
| `nextAccessibilityLabel` | `.next_accessibility_label(..)` | `string` | 无 | 屏幕阅读器对"下一个"的称呼。 |
| `headerClass`、`headerStyle` | `.header_class(..)`、`.header_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 头部："上一个"、切换按钮（或各月标题）、"下一个"。 |
| `bodyClass`、`bodyStyle` | `.body_class(..)`、`.body_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 主体：并排的各月，或月份、年份视图的行。 |
| `monthClass`、`monthStyle` | `.month_class(..)`、`.month_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 日视图中的每个月。 |
| `rowClass`、`rowStyle` | `.row_class(..)`、`.row_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每一行：星期、一周、一行月份或年份。 |
| `itemClass`、`itemStyle` | `.item_class(..)`、`.item_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每个条目：`selected:`、`disabled:`、`focus:`。 |
| `renderItem` | `.render_item(..)` | `(item: CalendarItemState) => JSX.Element` | 无 | 由应用绘制的条目内容；否则显示其数字。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 日历：头部在主体之上。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | 用户选出了一个完整的值：`{ value }`，一天或一个范围。设置 `value` 以跟随它。应用传入的 `value` 从不被报告。 |

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 |
|---|---|---|
| 日历 | 根 | `class`、`style` |
| 头部 | 日历中的第一个 | `headerClass`、`headerStyle` |
| 主体 | 日历中，头部之后 | `bodyClass`、`bodyStyle` |
| 月 | 主体中（日视图） | `monthClass`、`monthStyle` |
| 行 | 月中，或主体中（月份和年份视图） | `rowClass`、`rowStyle` |
| 条目 | 头部和各行中 | `itemClass`、`itemStyle`、`renderItem` |

<a id="keyboard"></a>

## 键盘

所有日期是 Tab 的一站：落在选中的日期上，没有则落在今天，再没有则落在第一个显示的日期。然后：

| 按键 | 操作 |
|---|---|
| Left / Right | 前一天或后一天。 |
| Up / Down | 一周前或一周后的同一天。 |
| Home / End | 本周的第一天或最后一天。 |
| Page Up / Page Down | 一个月前或一个月后的同一天。 |
| Shift+Page Up / Shift+Page Down | 一年前或一年后的同一天。 |
| Return、Space | 选中这一天。 |

移出显示的月份时会翻月。"上一个"、切换按钮、"下一个"、月份和年份接受按压。`gpui-base` 的日期只接受按压；这些按键是 NSH 的，参照 WAI-ARIA 的日期选择对话框。

<a id="accessibility"></a>

## 无障碍

- 每一天是一个按钮，以其 ISO 日期命名；它是选中的日期或范围的一端时为已选状态，被禁用时显示为不可用。
- "上一个"和"下一个"是按钮，名称来自 `previousAccessibilityLabel` 和 `nextAccessibilityLabel`；切换按钮、月份和年份是按钮，以其显示的内容命名。

关于标签、角色和播报的一般说明，见[无障碍](../docs/accessibility.md)。

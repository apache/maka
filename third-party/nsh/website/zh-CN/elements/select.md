---
title: Select
description: Select 组件：从一组条目中选出一个值，桌面上是触发元素处的弹出层，手机上是 sheet，支持键盘、输入跳转、搜索和分组，样式由应用决定。
group: base
demo: el-select
---

# Select

选择框从一组条目中选出一个值：一项设置、一个筛选条件、一个国家、一个时区。应用提供的触发元素打开列表，并按每种设备的习惯呈现：

- 在桌面平台和桌面浏览器中，它是触发元素处的弹出层，至少与触发元素一样宽，高度随行数增长，最多占满触发元素旁边的空间；键盘可以在条目间移动并选中一个。
- 在手机和平板上，它是屏幕底部、覆盖在背景层之上的 sheet。

选择框负责行为：值（应用持有的，或它自己保存的）、打开状态、键盘、输入跳转、搜索、分组、高亮的行以及屏幕阅读器听到的内容。外观由应用决定：应用为触发元素、弹出层、列表、行、分组标题和搜索框设置样式，或者自己绘制行。

```rust tabs
use nsh_base::{SelectItem, SelectItemState, select, theme};
use nsh_core::prelude::*;

const FRUITS: [(&str, &str); 5] = [
    ("apple", "苹果"),
    ("banana", "香蕉"),
    ("blueberry", "蓝莓"),
    ("grapes", "葡萄"),
    ("pineapple", "菠萝"),
];

fn fruit_select() -> impl IntoElement {
    let fruit = signal(None::<SharedString>);
    let title = move || {
        let chosen = fruit.get();
        FRUITS
            .iter()
            .find(|(value, _)| Some(*value) == chosen.as_deref())
            .map_or("选择水果", |(_, title)| *title)
            .to_string()
    };
    select()
        .items(
            FRUITS
                .iter()
                .map(|&(value, title)| SelectItem::new(value, title).disabled(value == "grapes"))
                .collect::<Vec<_>>(),
        )
        .value(move || fruit.get())
        .on_change(move |next: &Option<SharedString>| fruit.set(next.clone()))
        .accessibility_label("水果")
        .offset(px(4.0))
        .popup_style(|s| {
            s.p_1()
                .rounded_lg()
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().popover)
                .text_color(move || theme().popover_foreground)
                .shadow_md()
        })
        .item_style(|s| s.rounded_md().overflow_hidden())
        .trigger(
            view()
                .h_9()
                .w_48()
                .flex_row()
                .items_center()
                .justify_between()
                .px_3()
                .rounded_md()
                .border_1()
                .border_color(move || theme().input)
                .hover(|s| s.bg(move || theme().accent))
                .child(text(title))
                .child(text("▾").text_color(move || theme().muted_foreground)),
        )
        .render_item(|item: &SelectItemState| {
            view()
                .flex_row()
                .items_center()
                .justify_between()
                .px_2()
                .py_1p5()
                .when(item.highlighted, |v| v.bg(move || theme().accent))
                .when(item.disabled, |v| v.opacity(0.5))
                .child(text(item.title.clone()).text_sm())
                .when(item.selected, |v| v.child(text("✓").text_sm()))
        })
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Select } from "nsh/base";

const FRUITS = [
  { value: "apple", title: "苹果" },
  { value: "banana", title: "香蕉" },
  { value: "blueberry", title: "蓝莓" },
  { value: "grapes", title: "葡萄", disabled: true },
  { value: "pineapple", title: "菠萝" },
];

function App() {
  const fruit = signal<string | null>(null);
  const title = () => FRUITS.find((f) => f.value === fruit())?.title;
  return (
    <Select
      items={FRUITS}
      value={fruit()}
      onChange={({ value }) => fruit.set(value)}
      accessibilityLabel="水果"
      offset={4}
      popupClass="rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      backdropClass="bg-black/40"
      itemClass="rounded-md px-2 py-1.5 text-sm focus:bg-accent focus:text-accent-foreground disabled:opacity-50"
      trigger={
        <View class="h-9 w-48 flex-row items-center justify-between rounded-md border border-input px-3 hover:bg-accent active:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <Text class={fruit() ? "text-foreground" : "text-muted-foreground"}>{title() ?? "选择水果"}</Text>
          <Text class="text-muted-foreground">▾</Text>
        </View>
      }
    />
  );
}

mount(App);
```

`Select` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`select()` 创建一个选择框，每个属性有一个设置方法（`.items(..)`、`.value(..)`、`.item_style(..)`），每个事件有一个监听方法（`.on_change(..)`）；`SelectItem::new(value, title)` 创建一个条目，可再用 `.disabled(..)` 和 `.group(..)`。

<a id="items"></a>

## 条目

`items` 是以数据形式给出的列表：每个条目有一个 `value`（在条目中唯一，选中它时值变为它）、一个 `title`（它的行显示的内容，也是搜索和输入跳转匹配的内容、屏幕阅读器读出的内容），以及可选的 `disabled` 和 `group`。相邻且 `group` 相同的条目组成一个分组，显示在以该名称为标题的分组标题下：

```tsx
<Select
  items={[
    { value: "lisbon", title: "里斯本", group: "欧洲" },
    { value: "london", title: "伦敦", group: "欧洲" },
    { value: "tokyo", title: "东京", group: "亚洲" },
    { value: "seoul", title: "首尔", group: "亚洲", disabled: true },
  ]}
  groupClass="px-2 pb-1 pt-2 text-xs text-muted-foreground"
  trigger={trigger}
/>
```

这些行是弹出层滚动视图中的虚拟化列表：上千个条目的列表只创建可见的行；行的总高度超过可用空间时，弹出层可以滚动。

<a id="value"></a>

## 值

有 `value` 时，选中的条目由应用持有：选择框显示该值对应的条目，并用 `onChange({ value })` 报告一次选择；应用把 `value` 设为它以跟随这次选择，或者保留自己的值。`value={null}` 表示没有选中任何条目。省略 `value` 时，选择框自己保存值，初始为 `defaultValue`。`onChange` 只报告变化：再次选择已选中的条目会关闭列表。

`cleanable` 会在有选中条目时加一个清除按钮：按下它会清空值，以 `onChange({ value: null })` 报告，列表保持关闭。这个按钮在选择框的视图里、触发元素之后，不在触发元素里面，所以按它不会打开列表；由应用摆放它（用 `absolute` 盖在触发元素末端、原本放箭头的位置）并填充内容：

```tsx
<Select
  items={fonts}
  value={font()}
  onChange={({ value }) => font.set(value)}
  cleanable
  clearButtonAccessibilityLabel="清除字体"
  clearButtonClass="absolute right-2 top-2 size-5 items-center justify-center rounded-full hover:bg-accent"
  clearButton={<Text class="text-xs text-muted-foreground">✕</Text>}
  trigger={trigger}
/>
```

触发元素是应用自己的元素，所以它可以按应用的需要显示选中的条目：标题、图标，或者在没有选中时显示占位文字。在 TSX 中，触发元素就是你传入的元素：它本身就是组合框，按压、键盘焦点、展开状态和 `disabled` 都在它自己身上，所以它自己的 `active:`、`focus:` 和 `disabled:` 类会跟随选择框，它自己的 `onPress` 也照常运行；列表相对它放置，并且至少与它一样宽。

<a id="open-state"></a>

## 打开状态

没有 `open` 时，选择框自己保存打开状态（初始为 `defaultOpen`）。有 `open` 时，状态由应用持有，并在 `onOpenChange({ open, reason })` 中修改它，原因为 `"triggerPress"`（按下触发元素，或它的某个按键）、`"select"`（一次选择）、`"pressOutside"`、`"backdropPress"` 或 `"cancel"`（Escape 或返回）。`onOpen` 和 `onClose` 表示列表已显示和已消失（sheet 在完全进入和完全离开之后），`onCancel` 表示用户没有选择就关闭了它。

<a id="search"></a>

## 搜索

`searchable` 在条目上方放一个搜索框：输入的内容按标题筛选条目（不区分大小写），没有匹配项的分组连同标题一起隐藏。高亮移到第一个匹配项，搜索框有键盘焦点时按键继续移动高亮，Return 选中它。`empty` 是没有任何匹配项时列表显示的内容：

```tsx
<Select
  items={zones}
  searchable
  searchPlaceholder="搜索时区"
  searchClass="mx-1 mb-1 rounded-md border border-input px-2 py-1.5 text-sm"
  empty={<Text class="px-2 py-6 text-center text-sm text-muted-foreground">没有找到时区</Text>}
  trigger={trigger}
/>
```

在桌面平台上，列表打开时搜索框就获得键盘焦点；在触摸屏上，按下搜索框时键盘才弹出。每次打开时搜索都从空白开始。

<a id="rows-the-app-draws"></a>

## 应用绘制的行

`itemClass` 为每个条目的行设置样式，行中显示条目的标题，提供 `renderItem` 时改由它绘制：`focus:` 作用于高亮的行（按键或指针所在的行），`selected:` 作用于选中的行，`disabled:` 作用于禁用的行。要自己绘制行，传入 `renderItem`：它收到条目及其状态（[`SelectItemState`](#types)），返回行的内容，只为可见的行调用。`renderGroup` 以同样的方式绘制分组标题：

```tsx
<Select
  items={fonts}
  itemClass="rounded-md focus:bg-accent"
  renderItem={(item) => (
    <View class="flex-row items-center gap-2 px-2 py-1.5">
      <Text class="flex-1 text-sm" style={{ fontFamily: item.value }}>{item.title}</Text>
      <Text class="w-4 text-right text-sm">{item.selected ? "✓" : ""}</Text>
    </View>
  )}
  renderGroup={(group) => <Text class="px-2 pt-2 text-xs font-medium text-muted-foreground">{group.title}</Text>}
  trigger={trigger}
/>
```

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `SelectItem[]` | `[]` | 条目，按顺序排列。 |
| `value` | `.value(..)` | `string \| null` | 无 | 选中条目的 `value`，由应用持有；`null` 表示没有选中。省略时选择框自己保存值。 |
| `defaultValue` | `.default_value(..)` | `string` | 无 | 没有 `value` 时的初始值。 |
| `open` | `.open(..)` | `boolean` | 无 | 是否打开，由应用持有。 |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | 没有 `open` 时，初始是否打开。 |
| `searchable` | `.searchable(..)` | `boolean` | `false` | 条目上方的搜索框按标题筛选条目。 |
| `searchPlaceholder` | `.search_placeholder(..)` | `string` | 无 | 搜索框的占位文字。 |
| `cleanable` | `.cleanable(..)` | `boolean` | `false` | 有选中条目时显示清除按钮；按下会清空值（`onChange({ value: null })`）。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 保持关闭：触发元素不接受按压和键盘焦点，并应用 `disabled:` 样式。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对它的称呼：这次选择是关于什么的。 |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | 桌面：列表位于触发元素的哪一侧；只有另一侧放得下时放在另一侧。 |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"start"` | 桌面：它如何与触发元素对齐。 |
| `offset` | `.offset(..)` | `number` | `0` | 桌面：触发元素与列表之间的间距。 |
| `margin` | `.margin(..)` | `number` | `0` | 桌面：它与安全区边缘保持的距离。 |
| `popupClass`、`popupStyle` | `.popup_class(..)`、`.popup_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 列表所在的弹出层（桌面）或 sheet（触摸屏）。 |
| `backdropClass`、`backdropStyle` | `.backdrop_class(..)`、`.backdrop_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 触摸屏：sheet 后面的背景层。 |
| `listClass`、`listStyle` | `.list_class(..)`、`.list_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 列表，即这些行所在的滚动视图。 |
| `itemClass`、`itemStyle` | `.item_class(..)`、`.item_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每个条目的行（文字样式由条目标题继承）：高亮时应用 `focus:`，选中时应用 `selected:`，禁用时应用 `disabled:`。 |
| `groupClass`、`groupStyle` | `.group_class(..)`、`.group_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个分组的标题。 |
| `searchClass`、`searchStyle` | `.search_class(..)`、`.search_style(..)` | `string`、`StyleProp<InputStyle>` | 无 | 搜索框：它的盒子和文字（`color`、`fontSize`、`placeholderColor`）。 |
| `clearButtonClass`、`clearButtonStyle` | `.clear_button_class(..)`、`.clear_button_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 清除按钮（`cleanable`）；`disabled:` 跟随选择框。 |
| `clearButton` | `.clear_button(..)` | `JSX.Element` | 无 | 清除按钮的内容：一个叉号、一个图标。 |
| `clearButtonAccessibilityLabel` | `.clear_button_accessibility_label(..)` | `string` | 无 | 屏幕阅读器对清除按钮的称呼。 |
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 按下时打开列表的元素；列表依它定位。 |
| `empty` | `.empty(..)` | `JSX.Element` | 无 | 没有任何条目显示时（搜索没有匹配项）列表显示的内容。 |
| `renderItem` | `.render_item(..)` | `(item: SelectItemState) => JSX.Element` | 无 | 由应用绘制的条目行；不提供时显示条目的标题。 |
| `renderGroup` | `.render_group(..)` | `(group: SelectGroup) => JSX.Element` | 无 | 由应用绘制的分组标题；不提供时显示分组名称。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 触发元素外面的视图。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | 用户选中了另一个条目（按压、Return 或 Space、在触发元素上输入跳转）：它的 `value`；清除按钮清空时为 `null`。设置 `value` 以跟随它。 |
| `onOpenChange` | `.on_open_change(\|e\| ..)` | 列表打开或关闭了，附带原因。设置 `open` 以跟随它。 |
| `onOpen` | `.on_open(\|\| ..)` | 列表已显示；作为 sheet 时，在它完全进入之后。 |
| `onClose` | `.on_close(\|\| ..)` | 列表已消失；作为 sheet 时，在它完全离开之后。应用关闭它时也会触发。 |
| `onCancel` | `.on_cancel(\|\| ..)` | 用户没有选择就关闭了列表（Escape 或返回、外部按压或按下背景层）。 |

它们按这个顺序到来：选择时先是 `onChange`，没有选择就关闭时先是 `onCancel`，然后是 `onOpenChange`，列表显示或消失之后是 `onOpen` 或 `onClose`。

<a id="types"></a>

## 类型

| 类型 | 成员 | 说明 |
|---|---|---|
| `SelectItem` | `value: string`、`title: string`、`disabled?: boolean`、`group?: string` | `items` 中的一个条目。 |
| `SelectItemState` | `value`、`title`、`disabled`、`group?`（条目的）、`selected: boolean`、`highlighted: boolean`、`index: number` | `renderItem` 收到的内容：条目本身、它是否是选中的条目、按键或指针是否在它上面（Return 或按压会选中它），以及它在 `items` 中的序号。 |
| `SelectGroup` | `title: string` | `renderGroup` 收到的内容：分组的 `group`。 |

在 Rust 中它们是 `nsh_base::SelectItem`、`SelectItemState` 和 `SelectGroup`；`value` 是 `SelectValue`（一个值为 `Controlled(Some(..))`，`null` 为 `Controlled(None)`），`.value(..)` 可以从 `Option<SharedString>` 或字符串创建它。

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式来源 |
|---|---|---|
| 触发元素 | 选择框的视图 | 应用自己的元素（`trigger`） |
| 清除按钮 | 选择框的视图，触发元素之后（`cleanable`，有选中条目时） | `clearButtonClass`、`clearButtonStyle`；内容 `clearButton` |
| 弹出层或 sheet | 位于所有内容之上，在触发元素处（桌面）或屏幕底部（触摸屏） | `popupClass`、`popupStyle` |
| 背景层 | sheet 后面（触摸屏） | `backdropClass`、`backdropStyle` |
| 搜索框 | 弹出层中的第一个（`searchable`） | `searchClass`、`searchStyle`、`searchPlaceholder` |
| 列表 | 弹出层中，搜索框之后 | `listClass`、`listStyle` |
| 分组标题 | 列表中，分组的条目之前 | `groupClass`、`groupStyle`、`renderGroup` |
| 条目的行 | 列表中 | `itemClass`、`itemStyle`、`renderItem` |
| 空状态 | 弹出层中，没有条目显示时 | 它自己的元素（`empty`） |

弹出层是一列：它的高度随搜索框和各行变化，所以在 `popupClass` 上加 `max-h-*` 可以限制它的高度，列表在其中滚动。

<a id="keyboard"></a>

## 键盘

在桌面平台上，Tab 可以到达未 `disabled` 的选择框的触发元素。列表关闭时，Down、Up、Return 和 Space 会打开它并高亮选中的条目（没有选中时，Up 高亮最后一个可用条目，其他键高亮第一个），字母和数字会选中标题以已输入内容开头的条目，与原生选择框一样。列表打开时：

| 按键 | 作用 |
|---|---|
| Down、Up | 下一个或上一个可用条目，到两端后循环。 |
| Home、End | 第一个或最后一个可用条目（搜索框有键盘焦点时归搜索框使用）。 |
| Page Down、Page Up | 向后或向前一页。 |
| Return | 选中高亮的条目并关闭列表。 |
| Space | 选中高亮的条目（没有搜索框时）。 |
| 字母、数字 | 下一个标题以最近一秒内输入内容开头的条目（没有搜索框时）。 |
| Escape | 不选择，关闭列表。 |

列表关闭后，键盘焦点回到触发元素，除非一次外部按压把它带到了别处。指针移过的行会被高亮；按键移动到的高亮行会滚动到可见位置。

<a id="on-each-device"></a>

## 在各设备上

| | 桌面平台和桌面浏览器 | 手机和平板 |
| --- | --- | --- |
| 列表 | 触发元素处的弹出层（`placement`、`align`、`offset`、`margin`），至少与触发元素一样宽，高度随行数增长，最多占满触发元素旁边的空间 | 屏幕底部、覆盖在背景层之上的 sheet，高度随行数增长，最高到状态栏 |
| 关闭 | 一次选择、Escape、外部按压（按压继续作用于指针下的元素） | 一次选择、背景层、Android 返回键 |
| 搜索 | 列表打开时搜索框获得键盘焦点 | 按下搜索框时键盘弹出 |
| 选择 | 鼠标键按下时就选中，搜索框保持键盘焦点 | 轻点 |

`popupClass` 在桌面上为弹出层、在手机上为 sheet 设置样式；两者需要不同样式时，可以把 `platform.idiom`（`nsh/device`）与 `"desktop"` 比较。

<a id="accessibility"></a>

## 无障碍

- 触发元素对屏幕阅读器来说是一个组合框（combobox）：它的标签是 `accessibilityLabel`，值是选中条目的标题，并说明列表是否展开。`disabled` 时它显示为不可用。
- 清除按钮是一个按钮，名称来自 `clearButtonAccessibilityLabel`；它不是 Tab 的一站。
- 列表是一个列表框（listbox），每一行是一个选项（option），以标题命名；选中的选项处于选中状态，禁用的选项显示为不可用。分组标题是标题（header）。
- 按键移动高亮时，屏幕阅读器的焦点移到高亮的行；搜索框有键盘焦点时，改为播报高亮条目的标题，以便继续输入。

关于标签、角色和播报的一般说明，见[无障碍](../docs/accessibility.md)。

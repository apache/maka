---
title: Combobox
description: Combobox 组件：从可搜索的一组条目中选出一个或多个值，桌面上是触发元素处的弹出层，手机上是 sheet，样式由应用决定。
group: base
demo: el-combobox
---

# Combobox

组合框从一组条目中选出值，一个，或者在 `multiple` 时选多个：一篇文章的标签、一个频道的成员、一份文档的语言。它是 [Select](./select.md) 的同类组件，和它共用同一个列表，并按每种设备的习惯呈现：

- 在桌面平台和桌面浏览器上，是触发元素处的弹出层，至少和触发元素一样宽，高度随条目增加，最多到触发元素旁边剩余的空间。
- 在手机和平板上，是屏幕底部、覆盖在背景层之上的 sheet。

组合框负责行为：值（应用的，或它自己的）、展开状态、键盘、搜索、分组、高亮的行，以及屏幕阅读器听到的内容。在 `multiple` 时，一次选择会把该条目加入或移出值，列表保持打开，所以可以一次选好多个。外观由应用决定：应用为触发元素、弹出层、列表、行、分组标题、搜索框和底部区域设置样式，或者自己绘制行。

```rust tabs
use nsh_base::{SelectItem, SelectItemState, combobox, theme};
use nsh_core::prelude::*;

const TAGS: [(&str, &str); 5] = [
    ("bug", "Bug"),
    ("design", "Design"),
    ("docs", "Docs"),
    ("perf", "Performance"),
    ("security", "Security"),
];

fn tag_picker() -> impl IntoElement {
    let tags = signal(Vec::<SharedString>::new());
    let title = move || match tags.get().len() {
        0 => "Add tags".to_string(),
        n => format!("{n} tags"),
    };
    combobox()
        .items(
            TAGS.iter()
                .map(|&(value, title)| SelectItem::new(value, title))
                .collect::<Vec<_>>(),
        )
        .multiple(true)
        .searchable(true)
        .search_placeholder("Find a tag")
        .value(move || Some(tags.get()))
        .on_change(move |next: &Vec<SharedString>| tags.set(next.clone()))
        .accessibility_label("Tags")
        .offset(px(4.0))
        .popup_style(|s| {
            s.p_1()
                .rounded_lg()
                .border_1()
                .border_color(move || theme().border)
                .bg(move || theme().popover)
                .shadow_md()
        })
        .trigger(
            view()
                .h_9()
                .w_48()
                .px_3()
                .justify_center()
                .rounded_md()
                .border_1()
                .border_color(move || theme().input)
                .child(text(title)),
        )
        .render_item(|item: &SelectItemState| {
            view()
                .flex_row()
                .justify_between()
                .px_2()
                .py_1p5()
                .when(item.highlighted, |v| v.bg(move || theme().accent))
                .child(text(item.title.clone()).text_sm())
                .when(item.selected, |v| v.child(text("✓").text_sm()))
        })
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Combobox } from "nsh/base";

const TAGS = [
  { value: "bug", title: "Bug" },
  { value: "design", title: "Design" },
  { value: "docs", title: "Docs" },
  { value: "perf", title: "Performance" },
  { value: "security", title: "Security" },
];

function App() {
  const tags = signal<string[]>([]);
  return (
    <Combobox
      items={TAGS}
      multiple
      searchable
      searchPlaceholder="Find a tag"
      value={tags()}
      onChange={({ value }) => tags.set(value)}
      accessibilityLabel="Tags"
      offset={4}
      popupClass="rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
      backdropClass="bg-black/40"
      searchClass="mb-1 h-8 rounded-md border border-input px-2 text-sm placeholder:text-muted-foreground"
      itemClass="rounded-md px-2 py-1.5 text-sm focus:bg-accent focus:text-accent-foreground"
      trigger={
        <View class="h-9 w-48 justify-center rounded-md border border-input px-3 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
          <Text>{tags().length ? `${tags().length} tags` : "Add tags"}</Text>
        </View>
      }
      renderItem={(item) => (
        <View class="flex-row justify-between">
          <Text>{item.title}</Text>
          <Text>{item.selected ? "✓" : ""}</Text>
        </View>
      )}
    />
  );
}

mount(App);
```

`Combobox` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`combobox()` 创建一个组合框，每个属性有一个设置方法（`.items(..)`、`.value(..)`、`.multiple(..)`），每个事件有一个监听方法（`.on_change(..)`）。它的条目与 `Select` 的相同：`SelectItem::new(value, title)`，可以用 `.disabled(..)` 和 `.group(..)`，分组方式也和选择框一样（见[条目](./select.md#items)）。

<a id="value"></a>

## 值

值是已选条目的值组成的数组。有 `value` 时，值由应用持有：组合框把这些条目显示为已选，并用 `onChange({ value })` 报告每次变化；应用把 `value` 设为报告的值以跟随它，或者保留自己的值。省略 `value` 时，组合框自己保存值，初始为 `defaultValue`。

- 在 `multiple` 时，按压、Return 或 Space 切换高亮的条目：不在值里就加入，在就移出。列表保持打开。
- 不设 `multiple` 时，一次选择把值替换为该条目的值并关闭列表；再次选择已选的条目只会关闭列表。

`onConfirm({ value })` 在列表关闭时告知当时的值：每次打开报告一次，不论怎样关闭（一次选择、Escape、在外面按压、按触发元素），值是用户离开时的样子。Mac 上的 Cmd+Return（其他平台为 Ctrl+Return）关闭列表并确认。

`cleanable` 会在有已选条目时加一个清除按钮：按下它会清空值（`onChange({ value: [] })`）。这个按钮在触发元素之后，不在它里面，所以按它不会打开列表；由应用摆放并填充内容，和[选择框的清除按钮](./select.md#value)一样。

<a id="search"></a>

## 搜索

`searchable` 在条目上方放一个搜索框，和选择框的一样：输入时按标题筛选条目，忽略大小写，没有匹配时显示 `empty`。搜索词默认属于搜索框自己，每次打开从 `defaultQuery`（没有则为空）开始；有 `query` 时由应用持有：`onQueryChange({ query })` 报告输入的内容，应用把 `query` 设为它以跟随，用来按自己的方式筛选，或给出一个起始搜索词。

<a id="footer"></a>

## 底部区域

`footer` 是显示在行下方的内容，位于它自己的部件中（`footerClass`、`footerStyle`）：一个操作（"管理标签"）、一个计数、一句提示。行滚动时它保持不动。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `SelectItem[]` | `[]` | 条目，按顺序。 |
| `multiple` | `.multiple(..)` | `boolean` | `false` | 一次选择把条目加入或移出值，列表保持打开。 |
| `value` | `.value(..)` | `string[]` | 无 | 已选条目的值，由应用持有。 |
| `defaultValue` | `.default_value(..)` | `string[]` | `[]` | 没有 `value` 时的初始值。 |
| `open`、`defaultOpen` | `.open(..)`、`.default_open(..)` | `boolean` | `false` | 展开状态，由应用或组合框自己持有。 |
| `searchable` | `.searchable(..)` | `boolean` | `false` | 条目上方的搜索框按标题筛选条目。 |
| `searchPlaceholder` | `.search_placeholder(..)` | `string` | 无 | 搜索框的占位文字。 |
| `query` | `.query(..)` | `string` | 无 | 搜索词，由应用持有。 |
| `defaultQuery` | `.default_query(..)` | `string` | 无 | 没有 `query` 时每次打开的初始搜索词。 |
| `cleanable` | `.cleanable(..)` | `boolean` | `false` | 有已选条目时显示清除按钮；按下会清空值。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 保持关闭，不接受按压和键盘焦点。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 这次选择是关于什么的，供屏幕阅读器使用。 |
| `placement`、`align`、`offset`、`margin` | `.placement(..)` 等 | 同 `Select` | `"bottom"`、`"start"`、0、0 | 桌面平台：弹出层相对触发元素的位置。 |
| `popupClass`、`popupStyle` | `.popup_class(..)`、`.popup_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 弹出层（桌面平台）或 sheet（触屏设备）。 |
| `backdropClass`、`backdropStyle` | `.backdrop_class(..)`、`.backdrop_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | sheet 后面的背景层。 |
| `listClass`、`listStyle` | `.list_class(..)`、`.list_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 列表，即行所在的滚动视图。 |
| `itemClass`、`itemStyle` | `.item_class(..)`、`.item_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每个条目的行：高亮时应用 `focus:`，已选时应用 `selected:`，不可选时应用 `disabled:`。 |
| `groupClass`、`groupStyle` | `.group_class(..)`、`.group_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个分组的标题。 |
| `searchClass`、`searchStyle` | `.search_class(..)`、`.search_style(..)` | `string`、`StyleProp<InputStyle>` | 无 | 搜索框。 |
| `footerClass`、`footerStyle` | `.footer_class(..)`、`.footer_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 行下方的底部区域。 |
| `clearButtonClass`、`clearButtonStyle` | `.clear_button_class(..)`、`.clear_button_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 清除按钮（`cleanable`）。 |
| `clearButton` | `.clear_button(..)` | `JSX.Element` | 无 | 清除按钮的内容。 |
| `clearButtonAccessibilityLabel` | `.clear_button_accessibility_label(..)` | `string` | 无 | 屏幕阅读器对清除按钮的称呼。 |
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 按下时打开列表的元素；列表相对它放置。 |
| `empty` | `.empty(..)` | `JSX.Element` | 无 | 没有条目显示时列表显示的内容。 |
| `footer` | `.footer(..)` | `JSX.Element` | 无 | 显示在行下方的内容。 |
| `renderItem` | `.render_item(..)` | `(item: SelectItemState) => JSX.Element` | 无 | 由应用绘制的条目行；否则显示条目标题。 |
| `renderGroup` | `.render_group(..)` | `(group: SelectGroup) => JSX.Element` | 无 | 由应用绘制的分组标题；否则显示其标题。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 包住触发元素的视图。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|value\| ..)` | 值变化了（一次选择、一次切换、清除按钮）：`{ value }`，已选条目的值。设置 `value` 以跟随它。 |
| `onConfirm` | `.on_confirm(\|value\| ..)` | 列表关闭了：`{ value }` 为当时的值，每次打开报告一次。 |
| `onQueryChange` | `.on_query_change(\|query\| ..)` | 用户在搜索框中输入了内容：`{ query }`。设置 `query` 以跟随它。 |
| `onOpenChange` | `.on_open_change(\|e\| ..)` | 列表打开或关闭了，以及原因（`{ open, reason }`）。设置 `open` 以跟随它。 |
| `onOpen`、`onClose` | `.on_open(..)`、`.on_close(..)` | 列表已显示，或已消失。 |
| `onCancel` | `.on_cancel(..)` | 用户没有通过会关闭列表的选择而关闭了它（Escape 或返回、在外面或背景层上按压）。 |

它们按这个顺序到来：选择时先是 `onChange`，没有选择就关闭时先是 `onCancel`，然后是 `onOpenChange`，列表关闭时是 `onConfirm`，列表显示或消失之后是 `onOpen` 或 `onClose`。

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 |
|---|---|---|
| 触发元素 | 组合框的视图 | 应用自己的元素（`trigger`） |
| 清除按钮 | 组合框的视图，触发元素之后（`cleanable`，有已选条目时） | `clearButtonClass`、`clearButtonStyle`；内容 `clearButton` |
| 弹出层或 sheet | 在一切之上，位于触发元素处（桌面平台）或底部（触屏设备） | `popupClass`、`popupStyle` |
| 背景层 | sheet 后面（触屏设备） | `backdropClass`、`backdropStyle` |
| 搜索框 | 弹出层中的第一个（`searchable`） | `searchClass`、`searchStyle`、`searchPlaceholder` |
| 列表 | 弹出层中，搜索框之后 | `listClass`、`listStyle` |
| 分组标题 | 列表中，它的条目之前 | `groupClass`、`groupStyle`、`renderGroup` |
| 条目的行 | 列表中 | `itemClass`、`itemStyle`、`renderItem` |
| 空状态 | 弹出层中，没有条目显示时 | 它自己的元素（`empty`） |
| 底部区域 | 弹出层中的最后一个 | `footerClass`、`footerStyle`；内容 `footer` |

<a id="keyboard"></a>

## 键盘

按键与选择框的相同（见[键盘](./select.md#keyboard)），区别在于：在 `multiple` 时，Return 和 Space 切换高亮的条目并保持列表打开；Mac 上的 Cmd+Return（其他平台为 Ctrl+Return）关闭列表并确认；关闭时的触发元素不支持输入跳转（它的按键只用来打开列表）。

<a id="accessibility"></a>

## 无障碍

- 触发元素对屏幕阅读器来说是一个组合框（combobox）：它的标签是 `accessibilityLabel`，值是已选条目的标题，以逗号连接，并说明列表是否展开。`disabled` 时它显示为不可用。
- 列表是一个列表框（listbox），每一行是一个选项，以其标题命名；已选的选项为已选状态，不可选的显示为不可用。分组标题是标题。
- 清除按钮是一个按钮，名称来自 `clearButtonAccessibilityLabel`；它不是 Tab 的一站。

关于标签、角色和播报的一般说明，见[无障碍](../docs/accessibility.md)。

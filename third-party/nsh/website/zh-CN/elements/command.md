---
title: Command
description: Command：命令面板，在应用的命令之上放一个搜索框，用户输入时即时过滤：对话框里的 Cmd+K 面板、页面里的命令菜单、由应用给出结果的搜索。虚拟化渲染，以键盘为先，对屏幕阅读器是一个列表框。每个部件的外观都属于应用。
group: base
demo: el-command
---

# Command

命令面板是一个搜索框加一列命令：用户输入几个字母，列表缩小到匹配的命令，方向键移动高亮，回车执行高亮的命令。`Command` 负责它的行为：过滤、分区、高亮、键盘，以及屏幕阅读器听到的内容。过滤在原生端进行，行是虚拟化的：只创建可见的行，所以成千上万条命令、文件或 emoji 的面板在每次按键时都能即时过滤。外观由应用决定：命令面板本身什么也不画，应用为每个部件设置样式（`itemClass`、`groupClass`、`searchClass` 等），并绘制行的内容（`renderItem`：图标、标签、快捷键）。

```rust tabs
use nsh_base::{CommandEntry, CommandItem, command, theme};
use nsh_core::prelude::*;

fn palette() -> impl IntoElement {
    let items = vec![
        CommandItem::new("new", "New File").group("File").shortcut("mod+n"),
        CommandItem::new("open", "Open…").group("File").shortcut("mod+o"),
        CommandItem::new("theme", "Toggle Theme").group("View").keywords(["dark", "light"]),
        CommandItem::new("settings", "Settings").group("View").shortcut("mod+,"),
    ];
    let chosen = signal(SharedString::from("none"));
    command()
        .items(items)
        .placeholder("Type a command or search…")
        .accessibility_label("Commands")
        .auto_focus(true)
        .on_select(move |id: &SharedString| chosen.set(id.clone()))
        .empty(text("No results.").text_color(move || theme().muted_foreground))
        .h(px(360.0))
        .render_item(|entry: &CommandEntry| {
            view()
                .flex_row()
                .items_center()
                .h_8()
                .px_2()
                .child(text(entry.label.clone()).flex_1())
                .child(
                    text(entry.shortcut_label.clone().unwrap_or_default())
                        .text_color(move || theme().muted_foreground),
                )
        })
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Command, type CommandItem } from "nsh/base";

const commands: CommandItem[] = [
  { id: "new", label: "New File", group: "File", shortcut: "mod+n" },
  { id: "open", label: "Open…", group: "File", shortcut: "mod+o" },
  { id: "theme", label: "Toggle Theme", group: "View", keywords: ["dark", "light"] },
  { id: "settings", label: "Settings", group: "View", shortcut: "mod+," },
];

function App() {
  const chosen = signal("none");
  return (
    <Command
      items={commands}
      placeholder="Type a command or search…"
      accessibilityLabel="Commands"
      searchAccessibilityLabel="Search commands"
      autoFocus
      onSelect={({ id }) => chosen.set(id)}
      class="w-96 overflow-hidden rounded-lg border border-border bg-popover"
      searchBarClass="flex-row items-center gap-2 border-b border-border px-3"
      searchClass="h-11 flex-1 text-sm text-foreground placeholder:text-muted-foreground"
      listClass="max-h-80 p-1"
      groupClass="px-2 py-1.5 text-xs font-medium text-muted-foreground"
      separatorClass="-mx-1 my-1 h-px bg-border"
      itemClass="group h-8 flex-row items-center rounded-md px-2 focus:bg-accent disabled:opacity-50"
      empty={<Text class="py-6 text-center text-sm text-muted-foreground">No results.</Text>}
      renderItem={(entry) => (
        <View class="flex-1 flex-row items-center gap-2">
          <Text class="flex-1 text-sm text-foreground group-focus:text-accent-foreground">{entry.label}</Text>
          <Text class="text-xs text-muted-foreground">{entry.shortcutLabel ?? ""}</Text>
        </View>
      )}
    />
  );
}

mount(App);
```

`Command` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。应用设置 `query` 时，查询词由应用持有，应用在 `onQueryChange` 里更新它；不设置时由搜索框自己保存，从 `defaultQuery` 开始。项目用应用自己的 `id` 标识，而不是标签：`onSelect({ id })` 告诉应用用户选了哪一个。在 Rust 中由 `command()` 创建，每个 prop 有对应的 setter（`.items(..)`、`.query(..)`、`.render_item(..)`），每个事件有对应的监听方法，以及类型化的样式方法。

## 项目

`items` 是按顺序排列的命令，每一项是一个 `CommandItem`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 在 `onSelect` 和 `onHighlightChange` 中标识它：在各项中唯一。 |
| `label` | `string` | 不用 `renderItem` 时它的行显示的内容，也是屏幕阅读器读出的内容和查询词匹配的内容。 |
| `keywords` | `string[]` | 查询词还会匹配的词：同义词、翻译后标签旁的英文名。 |
| `group` | `string` | 它所在的分区：相邻且同组的项目显示在以此为标题的标题行下。 |
| `shortcut` | `string` | 执行同一条命令的按键，写法与 [`keymap`](../modules/nsh.md#keymap) 相同（`"mod+shift+p"`），供它的行显示。由应用用 `keymap.bind` 绑定。 |
| `disabled` | `boolean` | 不能被选中：按键跳过它，按压无效，应用 `disabled:` 样式。 |
| `checked` | `boolean` | 它是当前生效的一项（主题、语言）：应用 `checked:` 样式，屏幕阅读器读作已勾选。 |

当项目的标签或某个关键词包含查询词时（不区分大小写，忽略前后空格），查询词就匹配这一项。各项保持原有顺序，没有匹配项的分区连同标题一起隐去。`renderItem` 会为每个可见的行拿到一个 `CommandEntry`：项目的各个字段，以及 `shortcutLabel`，即按当前平台提示方式显示的 `shortcut`（Apple 平台上是 `⇧⌘P`，其他平台是 `Ctrl+Shift+P`）。它描述的是项目本身，高亮是行的 `focus:`：每一项只绘制一次，高亮移动时视图保持不变。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `CommandItem[]` | `[]` | 按顺序排列的命令。 |
| `query` | `.query(..)` | `string` | 无 | 查询词（受控），由应用在 `onQueryChange` 里设置。 |
| `defaultQuery` | `.default_query(..)` | `string` | 无 | 没有设置 `query` 时的初始查询词。 |
| `searchable` | `.searchable(..)` | `boolean` | `true` | 行上方的搜索框。没有它时显示全部项目，命令面板在键盘焦点里只占一站，支持按首字母跳转。 |
| `filterable` | `.filterable(..)` | `boolean` | `true` | 用查询词过滤项目。关闭后显示全部项目：用于由应用自己给出结果的搜索（服务器返回的结果设为 `items`）。新的查询词仍会高亮第一项。 |
| `loading` | `.loading(..)` | `boolean` | `false` | 正在搜索：`empty` 暂不显示，列表对屏幕阅读器处于忙碌状态。在 `searchSuffix` 里显示你的加载指示。 |
| `placeholder` | `.placeholder(..)` | `string` | 无 | 搜索框的占位文字。 |
| `autoFocus` | `.auto_focus(..)` | `boolean` | `false` | 搜索框显示后获得键盘焦点：打开即可输入的面板。 |
| `separator` | `.separator(..)` | `boolean` | `true` | 在两个显示出来的分区之间放一个分隔行，样式由 `separatorClass` 设置；不会出现在开头、结尾，也不会连续出现。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对列表的称呼（"Commands"）；未设置 `searchAccessibilityLabel` 时也是搜索框的称呼。 |
| `searchAccessibilityLabel` | `.search_accessibility_label(..)` | `string` | `accessibilityLabel` | 屏幕阅读器对搜索框的称呼：它搜索的是什么（"Search commands"）。 |
| `header`、`footer` | `.header(..)`、`.footer(..)` | `JSX.Element` | 无 | 显示在搜索框上方（标题）和行下方（按键提示、计数）的内容。 |
| `empty` | `.empty(..)` | `JSX.Element` | 无 | 没有任何项目显示时的内容：查询词没有匹配，或没有项目。 |
| `searchPrefix`、`searchSuffix` | `.search_prefix(..)`、`.search_suffix(..)` | `JSX.Element` | 无 | 搜索栏里搜索框前后的内容：搜索图标、`loading` 时的加载指示。 |
| `renderItem` | `.render_item(..)` | `(entry: CommandEntry) => JSX.Element` | 无 | 行的内容，只为可见的行调用；没有它时行显示项目的标签。 |
| `renderGroup` | `.render_group(..)` | `(group: CommandGroup) => JSX.Element` | 无 | 分区的标题行（`{ heading }`）；没有它时标题行显示标题文字。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 命令面板本身：尺寸、边框和底色。 |
| `searchBarClass`、`searchBarStyle` | `.search_bar_class(..)`、`.search_bar_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | `searchPrefix`、搜索框和 `searchSuffix` 所在的那一行。 |
| `searchClass`、`searchStyle` | `.search_class(..)`、`.search_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 搜索框。 |
| `listClass`、`listStyle` | `.list_class(..)`、`.list_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 行所在的滚动视图。给它一个高度（`max-h-80`，或给命令面板定高）：行在其中滚动，只创建可见的行。 |
| `itemClass`、`itemStyle` | `.item_class(..)`、`.item_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每个项目的行及其状态（见下）；文字样式会传给标签。 |
| `groupClass`、`groupStyle` | `.group_class(..)`、`.group_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每个分区的标题行。 |
| `separatorClass`、`separatorStyle` | `.separator_class(..)`、`.separator_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个分隔行：线条的高度和颜色。 |

## 事件

| 事件 | Rust | 载荷 | 时机 |
|---|---|---|---|
| `onSelect` | `.on_select(..)` | `{ id: string }` | 用户选中了一项：回车，或按压它的行。 |
| `onHighlightChange` | `.on_highlight_change(..)` | `{ highlighted: string \| null }` | 高亮移动了（按键、指针、新的查询词或新的项目、`highlight`）：用来预览回车会执行什么。 |
| `onQueryChange` | `.on_query_change(..)` | `{ query: string }` | 用户在搜索框里输入，或 Escape 清空了它。 |
| `onCancel` | `.on_cancel(..)` | 无 | 查询词为空时按 Escape：关闭包住命令面板的元素（对话框的 `open`）。 |

## 部件

| 部件 | 所在位置 | 样式 | 状态 |
|---|---|---|---|
| 命令面板 | | `class`、`style` | |
| `header` | 命令面板 | 应用的元素 | |
| 搜索栏 | 命令面板 | `searchBarClass`、`searchBarStyle` | |
| `searchPrefix`、搜索框、`searchSuffix` | 搜索栏 | 应用的元素；`searchClass`、`searchStyle` | 搜索框的 `focus:` |
| 列表 | 命令面板 | `listClass`、`listStyle` | |
| 分区标题行 | 列表 | `groupClass`、`groupStyle`、`renderGroup` | |
| 分隔行 | 列表 | `separatorClass`、`separatorStyle` | |
| 行 | 列表 | `itemClass`、`itemStyle` | `focus:`（高亮）、`checked:`、`disabled:`、`hover:`、`active:` |
| 行的内容 | 行 | `renderItem` | 在 `itemClass` 里加 `group` 后可用 `group-focus:`、`group-checked:`、`group-disabled:` |
| `empty` | 命令面板 | 应用的元素 | |
| `footer` | 命令面板 | 应用的元素 | |

用 `focus:` 表示高亮的行（见[设计指南](../docs/design-guides.md#交互状态)）。

## Ref

| 方法 | 说明 |
|---|---|
| `focus()` | 让搜索框获得键盘焦点（没有搜索框时是命令面板本身）。 |
| `highlight(id)` | 高亮 `id` 对应的项目，并把它的行滚动到可见；没有显示或被禁用的项目保持不变。 |
| `matchedCount()` | `Promise<number>`：当前查询词显示的项目数，包括被禁用的项目。 |

```tsx
let palette: CommandRef | undefined;

<Command ref={(r) => (palette = r)} items={items} />;
palette?.focus();
```

## 放在对话框里的面板

把命令面板放进 [`Dialog`](./dialog.md)，用应用自己的快捷键打开。Escape 先清空查询词；查询词为空时触发 `onCancel`，由应用在其中关闭对话框。

```tsx
import { keymap } from "nsh";

const open = signal(false);
keymap.bind("mod+k", () => open.set(!open()));

<Dialog open={open()} onOpenChange={({ open: next }) => open.set(next)}>
  <Command
    items={commands}
    autoFocus
    onCancel={() => open.set(false)}
    onSelect={({ id }) => {
      open.set(false);
      run(id);
    }}
  />
</Dialog>;
```

## 由应用给出结果的搜索

设置 `filterable={false}` 后，应用给出的每一项都会显示：应用在 `onQueryChange` 里搜索（服务器、数据库），把结果设为 `items`，等待期间设置 `loading`。

```tsx
<Command
  items={results()}
  filterable={false}
  loading={searching()}
  onQueryChange={({ query }) => search(query)}
  searchSuffix={searching() ? <Spinner /> : undefined}
  empty={<Text>No matches</Text>}
/>
```

## 无障碍

- 列表的角色是 `"listbox"`，名称来自 `accessibilityLabel`；每一行是一个 `"option"`，名称是项目的标签，勾选和禁用状态与项目一致；分区标题是 `"header"`，分隔行对屏幕阅读器隐藏。
- 搜索框是一个文本框，名称来自 `searchAccessibilityLabel`（未设置时为 `accessibilityLabel`）；占位文字是它为空时显示的提示。
- 方向键移动高亮时键盘焦点留在搜索框里，屏幕阅读器读出高亮项的标签。没有搜索框时，高亮的行获得屏幕阅读器的焦点。
- `loading` 期间列表处于忙碌状态。

标签、角色和播报的通用说明见[无障碍](../docs/accessibility.md)。

## 键盘

| 按键 | 作用 |
|---|---|
| 输入 | 过滤项目；高亮第一个可用的匹配项。 |
| 下、上 | 高亮下一项或上一项，跳过被禁用的项目，从最后一项回到第一项，反之亦然。 |
| Page Down、Page Up | 按可见的行数移动高亮。 |
| 回车 | 选中高亮的项目（`onSelect`）。 |
| Escape | 清空查询词；查询词为空时触发 `onCancel`。 |
| Home、End | 没有搜索框时：第一项或最后一项（在搜索框里它们移动光标）。 |
| 空格、字母、数字 | 没有搜索框时：空格选中，字母和数字按首字母跳转高亮。 |

## 平台说明

- 桌面（macOS、Windows、Linux、GPUI）和 Web：指针移到哪一行就高亮哪一行，点击在按下时就选中，所以搜索框保持键盘焦点。
- iOS、Android 和 Mac Catalyst：轻点选中一行，键盘上的回车键选中高亮的项目，并保留搜索框以便输入下一个查询词。
- 每个平台都绘制应用设置的样式：命令面板、搜索栏、行及其内容。

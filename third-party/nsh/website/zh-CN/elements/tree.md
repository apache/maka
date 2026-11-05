---
title: Tree
description: Tree：包含子项目的项目，可以展开和收起，其中一个被选中：项目的文件、设置侧边栏、文档大纲。虚拟化渲染，在键盘焦点里只占一站，对屏幕阅读器是一棵树。每一行的外观都属于应用。
group: base
demo: el-tree
---

# Tree

树展示包含子项目的项目：项目的文件和文件夹、设置侧边栏的各个分区、文档的大纲。`Tree` 负责它的行为：哪些项目展开、哪一个被选中、键盘，以及屏幕阅读器听到的内容。它的行是虚拟化的：只创建可见的行，收起的项目的子项目根本不会创建，所以成千上万个项目的树也能立即打开和滚动。外观由应用决定：树本身什么也不画，应用为每一行设置样式（`itemClass`），并绘制行的内容（`renderItem`：图标、按项目深度缩进的标签、箭头、徽标）。

```rust tabs
use nsh_base::{TreeEntry, TreeItem, theme, tree};
use nsh_core::prelude::*;

fn files() -> impl IntoElement {
    let items = vec![
        TreeItem::new("src", "src")
            .child(TreeItem::new("src/main.rs", "main.rs"))
            .child(TreeItem::new("src/ui", "ui").child(TreeItem::new("src/ui/tree.rs", "tree.rs"))),
        TreeItem::new("Cargo.toml", "Cargo.toml"),
    ];
    let selected = signal(None::<SharedString>);
    tree()
        .items(items)
        .default_expanded(vec!["src".into()])
        .selected(move || selected.get())
        .on_selected_change(move |id: &SharedString| selected.set(Some(id.clone())))
        .accessibility_label("Files")
        .h(px(320.0))
        .list_class("p-1")
        .item_class(
            "group rounded-md hover:bg-accent selected:bg-primary/10 \
             focus:outline-2 focus:-outline-offset-2 focus:outline-ring disabled:opacity-50",
        )
        .render_item(|entry: &TreeEntry| {
            view()
                .flex_row()
                .gap_2()
                .h_8()
                .items_center()
                .rounded_md()
                .pl(px(8.0 + 16.0 * entry.depth as f32))
                .child(text(if entry.folder { "▸" } else { " " }).text_color(move || theme().muted_foreground))
                .child(text(entry.label.clone()))
        })
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Tree, type TreeItem } from "nsh/base";

const files: TreeItem[] = [
  {
    id: "src",
    label: "src",
    children: [
      { id: "src/main.rs", label: "main.rs" },
      { id: "src/ui", label: "ui", children: [{ id: "src/ui/tree.rs", label: "tree.rs" }] },
    ],
  },
  { id: "Cargo.toml", label: "Cargo.toml" },
];

function App() {
  const expanded = signal(["src"]);
  const selected = signal<string | null>(null);
  return (
    <Tree
      items={files}
      expanded={expanded()}
      selected={selected()}
      onExpandedChange={({ expanded: next }) => expanded.set(next)}
      onSelectedChange={({ selected: next }) => selected.set(next)}
      accessibilityLabel="Files"
      class="h-80 w-64 rounded-lg border border-border"
      listClass="p-1"
      itemClass="group h-8 rounded-md hover:bg-accent selected:bg-primary/10 focus:outline-2 focus:-outline-offset-2 focus:outline-ring disabled:opacity-50"
      renderItem={(entry) => (
        <View class="h-8 flex-row items-center gap-2" style={{ paddingLeft: 8 + entry.depth * 16 }}>
          <Text class="w-3 text-muted-foreground transition-transform group-aria-expanded:rotate-90">
            {entry.folder ? "›" : ""}
          </Text>
          <Text class="text-sm text-foreground">{entry.label}</Text>
        </View>
      )}
    />
  );
}

mount(App);
```

`Tree` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。应用设置 `expanded` 和 `selected` 时，展开的项目和选中的项目由应用持有，并在 `onExpandedChange` 和 `onSelectedChange` 中更新；不设置时树自己保存状态，从 `defaultExpanded` 和 `defaultSelected` 开始。项目由 `id` 标识，这是应用自己的标识（路径、记录的键），永远不是标签。在 Rust 中由 `tree()` 创建，每个属性有一个 setter（`.items(..)`、`.expanded(..)`、`.render_item(..)`），每个事件有一个监听方法，以及有类型的样式方法。

## 项目

`items` 是顶层的项目，每个都是一个 `TreeItem`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `string` | 在 `expanded`、`selected` 和事件中标识它：在树中唯一（重复的 id 会记录到日志，只有它的第一个项目会展开或被选中）。 |
| `label` | `string` | 没有 `renderItem` 时行显示的内容，屏幕阅读器读出的内容，以及按首字母跳转匹配的内容。 |
| `children` | `TreeItem[]` | 它下面的项目，按顺序。有子项目时它是文件夹：可以展开和收起。 |
| `disabled` | `boolean` | 用户不能选中、展开或收起它：点按和按键都会跳过它，应用 `disabled:` 样式。它的子项目仍按 `expanded` 显示。 |

`renderItem` 为每个可见行收到一个 `TreeEntry`：项目的 `id`、`label` 和 `disabled`，它的 `depth`（顶层为 0，顶层项目之下为 1，……）以及它是否是 `folder`。它描述项目本身，行的状态则通过行的 class 表达：每个项目的绘制只创建一次，在行被选中、展开或收起时保留其视图，所以箭头能以过渡动画旋转。

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `TreeItem[]` | `[]` | 顶层项目，每个带有它下面的项目。 |
| `expanded` | `.expanded(..)` | `string[]` | 无 | 展开项目的 id（受控）。一个项目在它上面的每个项目都展开时显示。 |
| `defaultExpanded` | `.default_expanded(..)` | `string[]` | `[]` | 未设置 `expanded` 时，一开始展开的项目。 |
| `selected` | `.selected(..)` | `string \| null` | 无 | 选中项目的 id（受控），`null` 表示没有。 |
| `defaultSelected` | `.default_selected(..)` | `string` | 无 | 未设置 `selected` 时，一开始选中的项目。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 只读的树：不响应点按和按键，不是键盘焦点的一站，每一行都应用 `disabled:`；显示 `expanded` 和 `selected` 所说的状态。 |
| `reveal` | `.reveal(..)` | `boolean` | `false` | 展开和收起时，项目之后的行以弹簧动画移到新位置，由原生执行。开启“减弱动态效果”时关闭。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对树的称呼（“文件”）。 |
| `renderItem` | `.render_item(..)` | `(entry: TreeEntry) => JSX.Element` | 无 | 可见行的内容；没有它时行显示项目的标签。 |
| `itemClass`、`itemStyle` | `.item_class(..)`、`.item_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每一行：高度、内边距、背景和状态（见下）；其中的文本样式会传给标签。 |
| `listClass`、`listStyle` | `.list_class(..)`、`.list_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 树内承载各行的滚动视图：它的内边距和间距。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 树本身。给它一个高度（或在有高度的父元素中用 `flex-1`）：行在其中滚动，只创建可见的行。 |

## 事件

| 事件 | Rust | 参数 | 时机 |
|---|---|---|---|
| `onExpandedChange` | `.on_expanded_change(..)` | `{ expanded: string[] }` | 用户展开或收起了一个项目（点按、Return、Space、Right 或 Left、`revealItem`）：变化后的展开 id。 |
| `onSelectedChange` | `.on_selected_change(..)` | `{ selected: string }` | 用户选中了另一个项目（点按、方向键、Home、End、按首字母跳转）。 |
| `onExpand` | `.on_expand(..)` | `{ id: string }` | 用户展开了 `id` 对应的项目，在 `onExpandedChange` 之后。 |
| `onCollapse` | `.on_collapse(..)` | `{ id: string }` | 用户收起了 `id` 对应的项目，在 `onExpandedChange` 之后。 |
| `onAction` | `.on_action(..)` | `{ id: string }` | 用户对 `id` 对应的项目执行了操作：在没有子项目的选中项上按 Return，或在任意项目上双击、连续轻点两次，在这次点按自己的事件之后。禁用的项目和禁用的树永远不会报告它。 |

选中项跟随方向键移动，所以文件浏览器在 `onAction` 中打开文件，而不是在 `onSelectedChange` 中：用方向键浏览时逐个预览，按 Return 或双击才打开用户想要的那个文件。

```tsx
<Tree
  items={files}
  onSelectedChange={({ selected }) => preview.set(selected)}
  onAction={({ id }) => openFile(id)}
/>
```

## 部件

| 部件 | 位于 | 样式 | 状态 |
|---|---|---|---|
| 树 | | `class`、`style` | |
| 列表 | 树 | `listClass`、`listStyle` | |
| 行 | 列表 | `itemClass`、`itemStyle` | `selected:`、`aria-expanded:`（展开的文件夹）、`focus:`（树拥有键盘焦点时按键作用的行：选中的行；选中项被收起的项目隐藏时，是那个项目的行；没有选中项时是第一行）、`disabled:`、`hover:`、`active:` |
| 行的内容 | 行 | `renderItem` | 在 `itemClass` 中加上 `group` 后的 `group-selected:`、`group-aria-expanded:`、`group-focus:`、`group-disabled:` |

用 `selected:` 表示选中的行，用 `focus:` 表示键盘所在的位置（见[设计指南](../docs/design-guides.md#交互状态)）。把焦点画在行内（`focus:outline-2 focus:-outline-offset-2`）：列表会裁掉超出两侧的部分。

## Ref

| 方法 | 说明 |
|---|---|
| `focus()` | 获得键盘焦点，与 Tab 到达树时相同。 |
| `revealItem(id)` | 展开 `id` 对应项目之上的项目（通过 `onExpandedChange` 和 `onExpand` 报告，由外到内），并在它显示后把它的行滚动到视野中：应用跟随这次变化时立即滚动；应用不跟随时，这次请求就此结束。 |

```tsx
let files: TreeRef | undefined;

<Tree ref={(r) => (files = r)} items={items} />;
files?.revealItem("src/ui/tree.rs");
```

## 禁用

禁用的项目不响应点按，方向键会跳过它，屏幕阅读器把它播报为不可用。树上的 `disabled` 让整棵树只读：显示应用的状态，不接受输入。

```tsx
<Tree items={items} disabled={locked()} itemClass="h-8 px-2 disabled:opacity-50" />
```

## 无障碍

- 树的角色是 `"tree"`，名字来自 `accessibilityLabel`；每一行是一个 `"treeitem"`，名字是项目的标签，带有层级（深度 + 1）、是否展开（文件夹）、是否选中和是否禁用。
- 树获得键盘焦点时，以及按键移动选中项时，按键作用的行获得屏幕阅读器的焦点。

标签、角色和播报的一般说明见[无障碍](../docs/accessibility.md)。

## 键盘

在桌面和 Web 上（Tab 会到达响应点按的视图），`Tree` 遵循 [WAI-ARIA 树视图模式](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)：

| 按键 | 作用 |
|---|---|
| Tab、Shift+Tab | 一步进入树，一步离开；回来时按键从选中的行继续。没有选中项时，焦点显示在第一行，按 Down 选中它。 |
| Down、Up | 选中下一行或上一行，跳过禁用的项目，从最后一行回到第一行，反之亦然。 |
| Right | 展开收起的文件夹；在展开的文件夹上，选中它的第一个可用的子项目。 |
| Left | 收起展开的文件夹；在其他项目上，选中它的父项目。 |
| Home、End | 选中第一行或最后一行。 |
| Return | 展开或收起选中的文件夹；在没有子项目的项目上，对它执行操作（`onAction`）。 |
| Space | 展开或收起选中的文件夹。 |
| 字母、数字 | 选中下一个标签以所输入内容开头的行。 |

选中项被收起的项目隐藏时（应用收起了它），按键作用于那个项目的行：Right 或 Return 展开它，Down 选中它之后的一行。

在从右到左的布局里，行从右边开始，Left 和 Right 按该模式互换：Left 展开文件夹并进入，Right 收起文件夹并选中父项目。Up、Down、Home 和 End 不变。

## 平台说明

- iOS、Android 和 Mac Catalyst：轻点选中一行，并展开或收起文件夹；连续轻点两次对项目执行操作（`onAction`）。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：点击效果相同，并让树获得键盘焦点，可用上面的按键在其中移动；双击对项目执行操作。
- 每个平台都绘制应用设置的样式：树、行以及行的内容。

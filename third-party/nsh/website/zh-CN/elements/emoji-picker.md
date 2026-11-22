---
title: EmojiPicker
description: EmojiPicker：表情选择面板，在全部表情之上放一个搜索框，按分组排列，就像消息输入框的表情按钮或消息的表情回应那样。内置 Unicode 表情和来自 CLDR 的英文名称，可加入应用语言的名称，支持肤色、最近使用的表情排在最前，虚拟化网格，以键盘为先，对屏幕阅读器是一个列表框。每个部件的外观都属于应用。
group: base
demo: el-emoji-picker
---

# EmojiPicker

表情选择面板是全部表情之上的一个搜索框：各个分组（笑脸、人物、动物、食物……）排成网格，用户最近用过的表情排在最前，能换肤色的表情可以选一种肤色。`EmojiPicker` 负责它的行为：表情本身（Unicode 的表情，带有来自 CLDR 的英文名称和关键词）、搜索、分组、高亮、键盘，以及屏幕阅读器听到的内容。搜索在原生端进行，网格是虚拟化的：只创建可见的行。外观和文字都由应用决定：面板本身什么也不画，也不内置任何文字，应用为每个部件设置样式（`itemClass`、`groupClass`、`searchClass` 等），为分组命名（`groupLabels`），并填入插槽（分组标签、指针下表情的预览）。

```rust tabs
use nsh_base::{EmojiGroupLabels, EmojiPickerEvent, emoji_picker};
use nsh_core::prelude::*;

fn picker() -> impl IntoElement {
    let chosen = signal(SharedString::from("none"));
    let mut labels = EmojiGroupLabels::default();
    labels.smileys_emotion = Some("笑脸与情感".into());
    labels.people_body = Some("人物与身体".into());
    emoji_picker()
        .recent(vec!["👍".into(), "🎉".into()])
        .group_labels(labels)
        .placeholder("搜索表情")
        .accessibility_label("表情")
        .auto_focus(true)
        .on_select(move |e: &EmojiPickerEvent| {
            if let EmojiPickerEvent::Select(emoji, ..) = e {
                chosen.set(emoji.clone());
            }
        })
        .item_class("size-9 items-center justify-center rounded-md text-[22px] hover:bg-accent focus:bg-accent")
        .w(px(342.0))
        .h(px(380.0))
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { EmojiPicker } from "nsh/base";

function App() {
  const message = signal("");
  return (
    <EmojiPicker
      recent={["👍", "🎉"]}
      groupLabels={{ recent: "常用", smileysEmotion: "笑脸与情感", peopleBody: "人物与身体" }}
      placeholder="搜索表情"
      accessibilityLabel="表情"
      autoFocus
      onSelect={({ emoji }) => message.set(message() + emoji)}
      class="h-96 w-[342px] overflow-hidden rounded-xl border border-border bg-popover"
      searchBarClass="mx-2 mt-2 h-8 flex-row items-center rounded-lg bg-muted px-2.5"
      searchClass="flex-1 text-sm text-foreground placeholder:text-muted-foreground"
      rowClass="px-2"
      groupClass="px-3 pt-2.5 pb-1 text-xs font-semibold text-muted-foreground"
      itemClass="size-9 items-center justify-center rounded-md text-[22px] hover:bg-accent focus:bg-accent"
      empty={<Text class="py-6 text-center text-sm text-muted-foreground">没有找到表情</Text>}
    />
  );
}

mount(App);
```

`EmojiPicker` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 里是 `nsh-base` crate。在 Rust 中用 `emoji_picker()` 创建，每个 prop 对应一个设置方法，每个事件对应一个监听方法，另有类型化的样式方法。它本身不弹出：桌面上放进 [`Popover`](./popover.md)，手机上放进 [`Sheet`](./sheet.md)，也可以直接放在页面里。

## 表情数据

面板内置 Unicode 的表情（emojibase-data，Emoji 18.0），保持它们的分组和顺序，每个表情带有引入它的 Emoji 版本，以及来自 Unicode CLDR 的英文名称和关键词。原生平台把数据打包在应用里；Web 上页面在第一次显示面板时下载（`nsh-emoji.bin`，压缩后约 30 KB），下载完成前显示 `loading`。

- **应用语言的名称**：`annotations` 为每个表情提供应用语言的名称和关键词，可以直接取自 emojibase 对应语言的数据（`compact.json`：`{ emoji: unicode, label, keywords: tags }`）。格子和 `onSelect` 使用应用给的名称；查询词同时匹配应用的词和英文词。
- **搜索**：名称或某个关键词包含查询词（不区分大小写）的表情会被匹配；名称里有以查询词开头的词的表情排在最前，其次是关键词里有这样的词的，然后是其余匹配项。匹配结果显示为一个没有标题的分组。
- **分组**：`groups` 选择显示哪些分组以及顺序。`"recent"` 是应用的 `recent` 表情：由应用保存（取自 `onSelect` 的 `base`），面板负责显示。
- **肤色**：`skinTone` 为所有能换肤色的表情设置同一种肤色（多人表情的每个人都会换上）。
- **较新的表情**：`emojiVersion` 去掉某个 Emoji 版本之后新增的表情，供字体还画不出它们的系统使用（Emoji 16 需要 iOS 18.4、Android 16 或较新的 Windows 11）。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `query` | `.query(..)` | `string` | 无 | 查询词（受控），由应用在 `onQueryChange` 里设置。 |
| `defaultQuery` | `.default_query(..)` | `string` | 无 | 没有设置 `query` 时的初始查询词。 |
| `skinTone` | `.skin_tone(..)` | `EmojiSkinTone` | `"none"` | 所有能换肤色的表情的肤色：`"none"`、`"light"`、`"mediumLight"`、`"medium"`、`"mediumDark"`、`"dark"`。 |
| `columns` | `.columns(..)` | `number` | `8` | 每行的格子数。 |
| `groups` | `.groups(..)` | `EmojiGroupId[]` | 全部分组，`"recent"` 在最前 | 显示的分组及顺序：`"recent"`、`"smileysEmotion"`、`"peopleBody"`、`"animalsNature"`、`"foodDrink"`、`"travelPlaces"`、`"activities"`、`"objects"`、`"symbols"`、`"flags"`。 |
| `recent` | `.recent(..)` | `string[]` | `[]` | 应用最近使用的表情，最近的在前：即 `"recent"` 分组。 |
| `groupLabels` | `.group_labels(..)` | `EmojiGroupLabels` | `{}` | 各分组的标题（`{ recent, smileysEmotion, ... }`）：没有标题的分组不显示标题行（除非 `renderGroup` 绘制）。 |
| `annotations` | `.annotations(..)` | `EmojiAnnotation[]` | `[]` | 应用语言的表情名称和关键词（`{ emoji, label, keywords }`）。 |
| `emojiVersion` | `.emoji_version(..)` | `string` | 无 | 显示的最新 Emoji 版本（`"15.1"`）。 |
| `searchable` | `.searchable(..)` | `boolean` | `true` | 网格上方的搜索框。没有它时面板在键盘焦点里只占一站，方向键移动高亮。 |
| `placeholder` | `.placeholder(..)` | `string` | 无 | 搜索框的占位文字。 |
| `autoFocus` | `.auto_focus(..)` | `boolean` | `false` | 搜索框显示后获得键盘焦点：适合桌面。手机上弹出的键盘会挡住表情。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对网格的称呼（"表情"）；未设置 `searchAccessibilityLabel` 时也是搜索框的称呼。 |
| `searchAccessibilityLabel` | `.search_accessibility_label(..)` | `string` | `accessibilityLabel` | 屏幕阅读器对搜索框的称呼（"搜索表情"）。 |
| `header`、`footer` | `.header(..)`、`.footer(..)` | `JSX.Element` | 无 | 显示在搜索框上方（分组标签）和网格下方（高亮表情的名称；手机上放分组标签）的内容。 |
| `empty` | `.empty(..)` | `JSX.Element` | 无 | 没有任何表情显示时的内容：查询词没有匹配。 |
| `loading` | `.loading(..)` | `JSX.Element` | 无 | 表情数据就绪前的内容（Web 上第一次打开时）。 |
| `searchPrefix`、`searchSuffix` | `.search_prefix(..)`、`.search_suffix(..)` | `JSX.Element` | 无 | 搜索栏里搜索框前后的内容：搜索图标、肤色选择。 |
| `renderItem` | `.render_item(..)` | `(entry: EmojiEntry) => JSX.Element` | 无 | 格子的内容，只为可见的格子调用；没有它时格子以文字显示表情。 |
| `renderGroup` | `.render_group(..)` | `(group: EmojiGroup) => JSX.Element` | 无 | 分组的标题行（`{ id, label, first }`）；没有它时标题行显示标题文字。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 面板本身：尺寸、边框和底色。 |
| `searchBarClass`、`searchBarStyle` | `.search_bar_class(..)`、`.search_bar_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | `searchPrefix`、搜索框和 `searchSuffix` 所在的那一行。 |
| `searchClass`、`searchStyle` | `.search_class(..)`、`.search_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 搜索框。 |
| `listClass`、`listStyle` | `.list_class(..)`、`.list_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 行所在的滚动视图：占据面板其他部件留下的高度。 |
| `rowClass`、`rowStyle` | `.row_class(..)`、`.row_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每一行格子，横向排列。 |
| `itemClass`、`itemStyle` | `.item_class(..)`、`.item_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每个格子：尺寸（`size-9`，或 `flex-1` 平分整行宽度）和状态；文字样式会传给表情。最后一行不满时保留空位。 |
| `groupClass`、`groupStyle` | `.group_class(..)`、`.group_style(..)` | `string`、`StyleProp<TextStyle>` | 无 | 每个分组的标题行。 |

## 事件

| 事件 | Rust | 载荷 | 时机 |
|---|---|---|---|
| `onSelect` | `.on_select(..)` | `{ emoji: string, base: string, skinTone: EmojiSkinTone, label: string }` | 用户选中了一个表情（回车、按压）：`emoji` 带肤色，用于插入；`base` 不带肤色，用于记作最近使用；以及它的名称。 |
| `onHighlightChange` | `.on_highlight_change(..)` | `{ highlighted: EmojiEntry \| null }` | 高亮移动了（按键、指针、新的查询词）：用来在预览里显示表情名称。 |
| `onQueryChange` | `.on_query_change(..)` | `{ query: string }` | 用户在搜索框里输入，或 Escape 清空了它。 |
| `onGroupChange` | `.on_group_change(..)` | `{ group: EmojiGroupId }` | 网格顶部换成了另一个分组（滚动到那里，或 `scrollToGroup`）：分组标签跟着它走。查询词显示匹配结果时不触发。 |
| `onCancel` | `.on_cancel(..)` | 无 | 查询词为空时按 Escape：关闭承载面板的容器。 |

`EmojiEntry` 描述一个表情：`emoji`（带肤色）、`base`、`label`、`keywords`、`group`、`version`（引入它的 Emoji 版本）和 `hasSkinTones`（能否换肤色）。`renderItem` 会为每个可见的格子拿到它，高亮是格子的 `focus:`：每个表情只绘制一次，高亮移动时视图保持不变。

## 部件

| 部件 | 位于 | 样式 | 状态 |
|---|---|---|---|
| 面板 | | `class`、`style` | |
| `header` | 面板 | 应用的元素 | |
| 搜索栏 | 面板 | `searchBarClass`、`searchBarStyle` | |
| `searchPrefix`、搜索框、`searchSuffix` | 搜索栏 | 应用的元素；`searchClass`、`searchStyle` | 搜索框的 `focus:` |
| 列表 | 面板 | `listClass`、`listStyle` | |
| 分组标题行 | 列表 | `groupClass`、`groupStyle`、`renderGroup` | |
| 一行格子 | 列表 | `rowClass`、`rowStyle` | |
| 格子 | 一行 | `itemClass`、`itemStyle` | `focus:`（高亮）、`hover:`、`active:` |
| 格子的内容 | 格子 | `renderItem` | `itemClass` 带 `group` 时的 `group-focus:` |
| `loading`、`empty` | 面板 | 应用的元素 | |
| `footer` | 面板 | 应用的元素 | |

## Ref

| 方法 | 说明 |
|---|---|
| `focus()` | 让搜索框获得键盘焦点（没有搜索框时是面板本身）。 |
| `highlight(emoji)` | 高亮这个表情并把它的格子滚动到可见处；没有显示的表情保持不变。 |
| `scrollToGroup(group, animated?)` | 把分组的第一行滚动到顶部（默认带动画），和点分组标签一样。 |
| `entry(emoji)` | `Promise<EmojiEntry \| null>`：一个表情的信息，无论是否显示（例如表情回应的名称）。 |
| `matchedCount()` | `Promise<number>`：查询词匹配到的表情数量。 |

## 分组标签

分组标签是应用放在 `header`（手机上放在 `footer`）里的 [`Tabs`](./tabs.md)：顶部所在的分组被选中（`onGroupChange`），按下标签滚动到对应分组（`scrollToGroup`）。

```tsx
const group = signal<EmojiGroupId>("smileysEmotion");
let picker: EmojiPickerRef | undefined;

<EmojiPicker
  ref={(r) => (picker = r)}
  onGroupChange={({ group: next }) => group.set(next)}
  header={
    <Tabs class="flex-row justify-between" indicatorClass="bottom-0 h-0.5 bg-foreground">
      {groups.map((g) => (
        <Tab selected={group() === g.id} onPress={() => picker?.scrollToGroup(g.id)} accessibilityLabel={g.label}>
          <Icon name={g.icon} />
        </Tab>
      ))}
    </Tabs>
  }
/>;
```

## 应用语言的名称

```tsx
// 应用语言的 emojibase 数据：下载一次，由应用保存。
const annotations = signal<EmojiAnnotation[]>([]);
void fetch("https://cdn.jsdelivr.net/npm/emojibase-data@18/zh/compact.json")
  .then((r) => r.json())
  .then((data) => annotations.set(data.map((e) => ({ emoji: e.unicode, label: e.label, keywords: e.tags ?? [] }))));

<EmojiPicker annotations={annotations()} />;
```

## 无障碍

- 网格的角色是 `"listbox"`，名称来自 `accessibilityLabel`；每个格子是一个 `"option"`，名称是表情的名称；分组标题是 `"header"`。最后一行不满时保留的空位对屏幕阅读器隐藏。
- 方向键移动高亮时键盘焦点留在搜索框里，屏幕阅读器读出高亮表情的名称。

标签、角色和播报的通用说明见[无障碍](../docs/accessibility.md)。

## 键盘

| 按键 | 作用 |
|---|---|
| 输入 | 搜索；高亮第一个匹配项。 |
| 下、上 | 高亮下一行或上一行同一列的格子（那一行较短时落在最后一个）。 |
| 右、左 | 查询词为空时：下一个或上一个格子，可以跨行、跨分组（从右到左的布局里方向互换）。有查询词时它们移动搜索框里的光标。 |
| Page Down、Page Up | 按可见的行数移动高亮。 |
| 回车 | 选中高亮的表情（`onSelect`）。 |
| Escape | 清空查询词；查询词为空时触发 `onCancel`。 |
| Home、End | 没有搜索框时：第一个或最后一个表情（在搜索框里它们移动光标）。 |

输入法组字时按键归输入法：回车和 Escape 用来确认或取消正在输入的文字，不会选中表情或关闭面板。

## 平台说明

- 每个平台用自己的彩色表情字体绘制：iOS 和 macOS 是 Apple Color Emoji，Android（Linux 上通常也是）是 Noto Color Emoji（缺少时请安装），Windows 是 Segoe UI Emoji，浏览器里是系统的字体。Windows 上国旗显示为两个字母：在那里可以把 `"flags"` 从 `groups` 里去掉。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：指针移到哪个格子就高亮哪个格子，点击在按下时就选中，所以搜索框保持键盘焦点。
- iOS、Android 和 Mac Catalyst：轻点选中；键盘上的回车键选中高亮的表情。

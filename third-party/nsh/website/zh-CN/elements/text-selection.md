---
title: 文字选择
description: 可选择的视图：在视图内的文字之间、跨越视图、Text 元素和 TextView 的同一个选区，就像网页中的文字一样选择。
order: 130
group: primitives
demo: el-text-selection
---

# 文字选择

设置了 `selectable` 的 [`View`](./view.md) 让其中的文字一起选择，就像网页一样：一个选区可以从一段文字中的某处延伸到另一段文字中的某处，按阅读顺序跨越视图、[`Text`](./text.md) 元素和 [`TextView`](./text-view.md)。让聊天记录可选择后，选区可以从一条消息开始、在下一条结束；复制会把选中的文字放到剪贴板，并排的文字用制表符连接，其他用换行连接。Rust 用 `view().selectable(true)` 设置，TSX 用 `<View selectable>`；单段文字能否被选择由它的 `userSelect` 样式决定。

```rust tabs
use nsh_base::text_view;
use nsh_core::prelude::*;

fn release_notes(notes: &'static str) -> impl IntoElement {
    view()
        .selectable(true)
        .gap_3()
        .p_4()
        .child(text("Release notes").font_weight(FontWeight::SEMIBOLD))
        .child(text_view().markdown(notes))
        .child(
            view()
                .flex_row()
                .gap_2()
                .child(text("Updated").select_none().text_color(rgb(0x737373)))
                .child(text("October 21")),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { TextView } from "nsh/base";

function ReleaseNotes(props: { notes: string }) {
  return (
    <View selectable class="gap-3 p-4">
      <Text class="font-semibold">Release notes</Text>
      <TextView markdown={props.notes} />
      <View class="flex-row gap-2">
        <Text style={{ userSelect: "none" }} class="text-neutral-500">Updated</Text>
        <Text>October 21</Text>
      </View>
    </View>
  );
}
```

视图的布局和外观是应用的样式，内容是它的子元素。选区本身是平台的：视图不为它绘制任何东西。

## 聊天记录

放在一个可选择视图中的聊天记录像一个页面一样选择：拖动从一条回复开始、在另一条结束，复制会取得其间每条消息的文字。

```rust tabs
use nsh_base::text_view;
use nsh_core::prelude::*;

fn transcript(replies: Signal<Vec<SharedString>>) -> impl IntoElement {
    scroll().flex_1().child(
        view().selectable(true).p_4().gap_4().child(each(
            replies,
            |reply: &SharedString| reply.clone(),
            |reply, _index| text_view().markdown(move || reply.get()),
        )),
    )
}
```

```tsx tabs
import { Scroll, View } from "nsh";
import { TextView } from "nsh/base";

<Scroll class="flex-1">
  <View selectable class="gap-4 p-4">
    <Each of={replies}>{(reply) => <TextView markdown={reply()} />}</Each>
  </View>
</Scroll>
```

## 读取选中的文字

在可选择视图上设置 `onSelectionChange`（Rust 中为 `.on_text_selection_change(..)`），每次选区变化时都会收到选中的文字：`{ text, start }`，即复制会得到的内容及其在整个视图文字中的起始位置；不再有选中内容时（点击别处、按 Escape、另一个视图开始选择）收到 `""`。只在内容变化时报告。可选择视图嵌套时由外层视图报告，因为选区只有一个。设置了 `selectable` 的 [`TextView`](./text-view.md) 也以同样方式报告自己的选区（`onSelectionChange`，Rust 中为 `.on_selection_change(..)`）。聊天应用可以用它引用读者在回答中选中的部分：

```rust tabs
use nsh_core::prelude::*;

fn reply(markdown: SharedString, quote: Signal<String>) -> impl IntoElement {
    view()
        .selectable(true)
        .on_text_selection_change(move |e: &TextSelectionEvent| quote.set(e.text.clone()))
        .child(nsh_base::text_view().markdown(markdown))
}
```

```tsx tabs
import { signal, View } from "nsh";
import { TextView } from "nsh/base";

const quote = signal("");

<View selectable onSelectionChange={({ text }) => quote.set(text)}>
  <TextView markdown={reply} />
</View>
```

### 读取为 Markdown 或 HTML

设置了 `selectable` 的 `TextView` 可以通过 ref 在需要时读取选区：`selectedText({ format })` 返回选中的文字（`"plain"`，默认值，与复制得到的相同），或把选中的那部分文档按 `"markdown"`、`"html"` 返回。内容由选区覆盖的节点重新生成，所以周围的强调、链接、列表项和代码块都会保留（有序列表保留编号，表格的行保留表头）。选中全部时，若文档本来就是这种格式，则原样返回源文。没有选中内容时返回 `""`。Rust 中为 `TextViewApi::selected_text`，传入 `TextSelectionOptions::format(TextSelectionFormat::Markdown)`。

```rust tabs
use nsh_base::{TextSelectionFormat, TextSelectionOptions, TextView, TextViewApi, text_view};
use nsh_core::prelude::*;

fn reply(markdown: SharedString, quote: Signal<String>) -> impl IntoElement {
    let doc = component_ref::<TextView>();
    text_view()
        .markdown(markdown)
        .selectable(true)
        .component_ref(&doc)
        .on_selection_change(move |_| {
            if let Some(api) = doc.api::<TextViewApi>() {
                let options = TextSelectionOptions::format(TextSelectionFormat::Markdown);
                quote.set(api.selected_text(Some(options)));
            }
        })
}
```

```tsx tabs
import { signal } from "nsh";
import { TextView, type TextViewRef } from "nsh/base";

let doc: TextViewRef | undefined;
const quote = signal("");

<TextView
  ref={(r) => (doc = r)}
  selectable
  markdown={reply}
  onSelectionChange={async () => quote.set((await doc?.selectedText({ format: "markdown" })) ?? "")}
/>
```

它读取的是该视图持有的选区：可选择视图嵌套时选区由外层视图持有，内层 `TextView` 的 ref 返回 `""`。

[`Input`](./input.md) 的 `onSelectionChange` 是它自己的：输入框文字中的光标和选区（`{ start, end }`）。

## 如何选择

| 平台 | 如何选择 |
|---|---|
| macOS、Windows、Linux、GPUI | 在文字上拖动；双击选择一个词，三击选择一个段落，之后的拖动按词或段落继续。Shift+点击扩展选区。Ctrl / Cmd+A 选择视图中的全部内容，Ctrl / Cmd+C 复制，Escape 或在外部按下会清除选区。 |
| iOS、Android | 长按选择一个词；平台的选择手柄可以扩展它，编辑菜单中有拷贝和全选。 |
| Web | 浏览器自己的选择，以及它的手势、菜单和快捷键。 |

## 选择的范围

- **不参与的文字**：设置了 `userSelect: "none"`（Rust 中为 `.select_none()`，类 `select-none`；标签、按钮的文字）的文字会被选区及其手势跳过。
- **嵌套的视图**：一个可选择视图放在另一个之中时，属于外层视图，一个选区覆盖两者。
- **TextView**：设置了 `selectable` 的 [`TextView`](./text-view.md) 自己作为一体选择：它的段落、列表项、单元格和代码块一起选择。放在可选择视图中时，它加入外层的选区。
- **单独的文字**：不在任何可选择视图中、设置了 `userSelect: "text"` 的文字单独选择，见 [Text](./text.md#属性)。
- **外观**是平台的高亮，颜色为每段文字的 `selectionColor`（`selection:text-*`）。
- **分成多段文字的一行**：把一行排成多段文字的 Rust 组件（软换行的代码行）给后面的各段设置 `.continues_text(true)`；复制时这一行完整给出，断开处没有换行，三击会选中它的所有部分。[`DiffView`](./diff-view.md) 的换行就是这样处理的。
- **列表**：在虚拟化的 [List](./list.md) 中，选区覆盖已挂载的行；回收到视野之外的行会离开选区。

## 相关内容

- [View](./view.md)：`selectable` 属性。
- [Text](./text.md)：`userSelect`、`selectionColor` 以及单段文字的选择。
- [TextView](./text-view.md)：各个块作为一体选择的文档。

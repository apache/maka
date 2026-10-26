---
title: 文字选择
description: 可选择的视图：在视图内的文字之间、跨越视图、Text 元素和 TextView 的同一个选区，就像网页中的文字一样选择。
order: 10.8
group: primitives
demo: el-text-selection
---

# 文字选择

设置了 `selectable` 的 [`View`](./view.md) 让其中的文字一起选择，就像网页一样：一个选区可以从一段文字中的某处延伸到另一段文字中的某处，按阅读顺序跨越视图、[`Text`](./text.md) 元素和 [`TextView`](./text-view.md)。让聊天记录可选择后，选区可以从一条消息开始、在下一条结束；复制会把选中的文字放到剪贴板，并排的文字用制表符连接，其他用换行连接。它和 `Text` 的 `selectable` 是同一个属性：Rust 用 `view().selectable(true)` 设置，TSX 用 `<View selectable>`。

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
                .child(text("Updated").selectable(false).text_color(rgb(0x737373)))
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
        <Text selectable={false} class="text-neutral-500">Updated</Text>
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

## 如何选择

| 平台 | 如何选择 |
|---|---|
| macOS、Windows、Linux、GPUI | 在文字上拖动；双击选择一个词，三击选择一个段落，之后的拖动按词或段落继续。Shift+点击扩展选区。Ctrl / Cmd+A 选择视图中的全部内容，Ctrl / Cmd+C 复制，Escape 或在外部按下会清除选区。 |
| 终端 | 拖动可跨越文本节点和多行文本；Shift+点击扩展选区。按住指针拖出 Scroll 边缘时会自动滚动。Ctrl+A 全选区域，Ctrl+C 或 Ctrl+Insert 复制，Esc 清除非空选区，在区域外按下也会清除选区。 |
| iOS、Android | 长按选择一个词；平台的选择手柄可以扩展它，编辑菜单中有拷贝和全选。 |
| Web | 浏览器自己的选择，以及它的手势、菜单和快捷键。 |

在终端界面中，已保留的背景选区只接收当前活动输入作用域内的按键。模态界面或获得焦点的弹出层会暂停其键盘
操作；关闭弹出层后，原选区可以再次接收操作。复制沿用其他剪贴板写入所用的
[宿主剪贴板服务与 OSC 52 输出](../docs/tui.md#键盘与鼠标)。

## 选择的范围

- **不参与的文字**：设置了 `selectable={false}`（Rust 中为 `.selectable(false)`；标签、按钮的文字）的文字会被选区及其手势跳过。
- **嵌套的视图**：一个可选择视图放在另一个之中时，属于外层视图，一个选区覆盖两者。
- **TextView**：设置了 `selectable` 的 [`TextView`](./text-view.md) 自己作为一体选择：它的段落、列表项、单元格和代码块一起选择。放在可选择视图中时，它加入外层的选区。
- **单独的文字**：不在任何可选择视图中的 `selectable` 文字单独选择，见 [Text](./text.md#属性)。
- **外观**是平台的高亮，颜色为每段文字的 `selectionColor`（`selection:text-*`）。
- **列表**：在虚拟化的 [List](./list.md) 中，选区覆盖已挂载的行；回收到视野之外的行会离开选区。

## 相关内容

- [View](./view.md)：`selectable` 属性。
- [Text](./text.md)：`selectable`、`selectionColor` 以及单段文字的选择。
- [TextView](./text-view.md)：各个块作为一体选择的文档。

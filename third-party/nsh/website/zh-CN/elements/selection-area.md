---
title: SelectionArea
description: SelectionArea 组件：让其中的文字共用一个选区，跨越视图、Text 元素和 TextView，就像网页上的文字一样选择。
order: 27
group: base
demo: el-selection-area
---

# SelectionArea

`SelectionArea` 让其中的文字一起选择，就像网页上的文字一样：一个选区可以从一段文字中的某处延伸到另一段文字中的某处，跨越视图、[`Text`](./text.md) 元素和 [`TextView`](./text-view.md)，按阅读顺序排列。把聊天记录包在它里面，选区就能从一条消息开始、在下一条消息结束；复制会把选中的文字放进剪贴板，并排的文字之间用制表符连接，其他文字之间用换行连接。Rust 用 `nsh_base::selection_area()` 创建它，TSX 用从 `nsh/base` 导入的 `<SelectionArea>`。

```rust tabs
use nsh_base::{selection_area, text_view};
use nsh_core::ui::prelude::*;

fn release_notes(notes: &'static str) -> impl IntoElement {
    selection_area()
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
import { SelectionArea, TextView } from "nsh/base";

function ReleaseNotes(props: { notes: string }) {
  return (
    <SelectionArea class="gap-3 p-4">
      <Text class="font-semibold">Release notes</Text>
      <TextView markdown={props.notes} />
      <View class="flex-row gap-2">
        <Text selectable={false} class="text-neutral-500">Updated</Text>
        <Text>October 21</Text>
      </View>
    </SelectionArea>
  );
}
```

`SelectionArea` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中来自 `nsh-base` crate。它是一个视图：布局和外观是应用的样式，内容是它的子元素。选区本身是平台的：区域不绘制任何自己的东西。

## 聊天记录

放在同一个区域里的聊天记录像一个页面一样选择：拖动可以从一条回复开始、在另一条回复结束，复制会取得其间每条消息的文字。

```rust tabs
use nsh_base::{selection_area, text_view};
use nsh_core::ui::prelude::*;

fn transcript(replies: Signal<Vec<SharedString>>) -> impl IntoElement {
    scroll().flex_1().child(
        selection_area().p_4().gap_4().child(each(
            replies,
            |reply: &SharedString| reply.clone(),
            |reply, _index| text_view().markdown(move || reply.get()),
        )),
    )
}
```

```tsx tabs
import { Scroll } from "nsh";
import { SelectionArea, TextView } from "nsh/base";

<Scroll class="flex-1">
  <SelectionArea class="gap-4 p-4">
    <Each of={replies}>{(reply) => <TextView markdown={reply()} />}</Each>
  </SelectionArea>
</Scroll>
```

## 如何选择

| 平台 | 如何选择 |
|---|---|
| macOS、Windows、Linux、GPUI | 在文字上拖动；双击选中一个词，三击选中一个段落，之后的拖动按词或段落继续。Shift+点击扩展选区。Ctrl / Cmd+A 选中区域内的全部文字，Ctrl / Cmd+C 复制，Esc 或在区域外按下会清除选区。 |
| 终端 | 拖动可跨越文本节点和多行文本；Shift+点击扩展选区。按住指针拖出 Scroll 边缘时会自动滚动。Ctrl+A 全选区域，Ctrl+C 或 Ctrl+Insert 复制，Esc 清除非空选区，在区域外按下也会清除选区。 |
| iOS、Android | 长按选中一个词；用平台的选择手柄扩展选区，平台的编辑菜单提供“拷贝”和“全选”。 |
| Web | 浏览器自己的选择，使用浏览器的手势、菜单和快捷键。 |

在终端界面中，已保留的背景选区只接收当前活动输入作用域内的按键。模态界面或获得焦点的弹出层会暂停其键盘
操作；关闭弹出层后，原选区可以再次接收操作。复制沿用其他剪贴板写入所用的
[宿主剪贴板服务与 OSC 52 输出](../docs/tui.md#键盘与鼠标)。

## 选择的范围

- **不参与选择的文字**：设置了 `selectable={false}`（Rust 中是 `.selectable(false)`）的文字（标签、按钮上的文字）会被选区及其手势跳过。
- **嵌套的区域**：一个区域在另一个区域里面时属于外层区域，一个选区覆盖两者。
- **TextView**：设置了 `selectable` 的 [`TextView`](./text-view.md) 本身就是一个选择区域：它的段落、列表项、单元格和代码块一起选择。放在 `SelectionArea` 里时，它加入外层的选区。
- **区域之外**：不在任何区域里的 `selectable` 文字单独选择，见 [Text](./text.md#属性)。
- **外观**是平台的高亮，使用每段文字的 `selectionColor`（`selection:text-*`）。
- **列表**：在虚拟化的 [List](./list.md) 中，选区覆盖已挂载的行；滚出视野被回收的行会离开选区。

## 属性

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | 内容：任意视图，文字可以在任意层级。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 它的布局和外观，与 [View](./view.md) 相同。 |

## 相关内容

- [Text](./text.md)：`selectable`、`selectionColor` 和单段文字的选择。
- [TextView](./text-view.md)：其文档块作为一体选择的文档。
- [`nsh/base`](../modules/nsh-base.md)：其他基础组件。

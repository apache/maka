---
title: TitleBar
description: TitleBar：应用自己绘制的窗口标题栏这一行。背景铺满整行，可以拖动窗口，内容只在与系统窗口按钮实际重叠的地方让开。
group: base
demo: el-title-bar
---

# TitleBar

窗口设置 `titleBar: { style: "hidden" }` 后，系统的窗口按钮（macOS 的红绿灯、Windows 的标题栏按钮、Linux 桌面的窗口按钮）保留，顶部这一行的其余部分交给应用。`TitleBar` 就是这一行：按住拖动会移动窗口，双击的效果与系统标题栏相同，其中的按钮、输入框和链接仍然接收点按。它至少与窗口的标题栏区域一样高，把子元素排成一行，只在与窗口按钮重叠的左右两端加内边距，所以背景仍然延伸到按钮下方的窗口边缘。

重叠按标题栏所在的位置计算。分栏布局里每一栏放一个标题栏：侧栏的标题栏在左侧为红绿灯让开，内容栏的标题栏从红绿灯右边开始，不加内边距；侧栏隐藏后，内容栏的标题栏碰到红绿灯，就会让开。进入全屏（没有窗口按钮）后内边距消失。窗口按钮指标题栏所在窗口的按钮：第二个 `<Window>` 里的 `TitleBar` 跟随那个窗口。

```tsx tabs
import { mount, Text, View } from "nsh";
import { TitleBar } from "nsh/base";
import { Window } from "nsh/desktop";

function App() {
  return (
    <View class="flex-1 flex-row">
      {/* 侧栏这一段标题栏：让开红绿灯。 */}
      <TitleBar class="h-11 w-60 bg-muted">
        <Text class="px-3">Library</Text>
      </TitleBar>
      {/* 内容栏这一段：侧栏显示时不加内边距。 */}
      <TitleBar class="h-11 flex-1 border-b border-border">
        <Text class="px-3">Inbox</Text>
      </TitleBar>
    </View>
  );
}

mount(() => (
  <Window id="main" titleBar={{ style: "hidden" }}>
    <App />
  </Window>
));
```

```rust tabs
use nsh_base::{theme, title_bar};
use nsh_core::prelude::*;

fn chrome() -> impl IntoElement {
    view()
        .flex_row()
        .flex_1()
        // 侧栏这一段标题栏：让开红绿灯。
        .child(
            title_bar()
                .w(px(240.0))
                .h(px(44.0))
                .bg(move || theme().muted)
                .child(view().px_3().child(text("Library"))),
        )
        // 内容栏这一段：侧栏显示时不加内边距。
        .child(
            title_bar()
                .flex_1()
                .h(px(44.0))
                .border_b_1()
                .border_color(move || theme().border)
                .child(view().px_3().child(text("Inbox"))),
        )
}
```

`TitleBar` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate 的 `title_bar()`。它加的内边距是与窗口按钮重叠的那部分宽度：应用自己的内边距写在其中的 view 上，写在标题栏本身会把它替换掉。使用系统标题栏（默认）的窗口没有标题栏区域：标题栏什么都不加，只是一行。没有窗口的平台上它同样只是一行。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | 无 | 标题栏里的内容：标题、侧栏开关、应用的按钮。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 标题栏的外观和布局：背景、边框、高于标题栏区域的高度、间距。 |

需要自己读取标题栏区域（自定义布局）时，用 [`nsh/desktop`](../modules/nsh-desktop.md) 的 `titleBar()`（Rust 中是 `current_window().title_bar()`）：其中的 `height`，以及窗口按钮占用的 `left`、`right` 宽度。

---
title: Overlay
description: Overlay 元素：显示在屏幕最上层的内容，不受父元素裁剪，可以作为固定定位的盒子布局，也可以相对锚点放置并跟随锚点，同时报告外部按压和 Escape。
order: 10.5
group: primitives
demo: el-overlay
---

# Overlay

浮层把它的子元素显示在所在根视图中一切内容之上：窗口，或包住它的对话框。父元素的尺寸、`overflow: hidden` 和滚动视图都不会裁剪它。除此之外，它就待在你写它的地方：它读取周围的 context，它的处理函数属于它所在的组件，并随父元素一起移除。弹出框、菜单、工具提示和 sheet 都建立在它之上；[`nsh/base`](../modules/nsh-base.md) 已经提供了它们（[Popover](./popover.md)、[Menu](./menu.md)、[Tooltip](./tooltip.md)、[Sheet](./sheet.md)），要构建你自己的弹出层，就用浮层。

```rust tabs
use nsh_core::ui::prelude::*;

fn more_button() -> impl IntoElement {
    let open = signal(false);
    let anchor = element_ref();
    view()
        .child(
            view()
                .element_ref(&anchor)
                .on_press(move || open.update(|o| *o = !*o))
                .px_3()
                .py_2()
                .child(text("More")),
        )
        .child(when(move || open.get(), move || {
            overlay()
                .anchor(&anchor)
                .placement(Placement::Bottom)
                .align(Align::Start)
                .offset(px(6.0))
                .margin(px(8.0))
                .on_press_outside(move |_: &Point<Points>| open.set(false))
                .on_cancel(move || open.set(false))
                .rounded_lg()
                .bg(white())
                .p_3()
                .shadow_lg()
                .child(text("Shown above everything"))
        }))
}
```

```tsx tabs
import { Overlay, signal, Text, View, type YNode } from "nsh";

function MoreButton() {
  const open = signal(false);
  let anchor: YNode | undefined;
  return (
    <View>
      <View ref={anchor} onPress={() => open.set(!open())} class="px-3 py-2">
        <Text>More</Text>
      </View>
      <If when={open()}>
        <Overlay
          anchor={anchor}
          placement="bottom"
          align="start"
          offset={6}
          margin={8}
          onPressOutside={() => open.set(false)}
          onCancel={() => open.set(false)}
          class="rounded-lg bg-white p-3 shadow-lg"
        >
          <Text>Shown above everything</Text>
        </Overlay>
      </If>
    </View>
  );
}
```

`Overlay` 在 TSX 中来自 `nsh`，在 Rust 中 `overlay()` 来自 `nsh_core::ui::prelude`。它在视图中时就会显示：把它放进 `If`（Rust 中为 `when(..)`）来打开和关闭它。后显示的浮层位于先显示的浮层之上，嵌套在另一个浮层里的浮层位于外层之上。

<a id="placement"></a>

## 放置

没有 `anchor` 时，浮层作为其根视图中 `position: fixed` 的盒子布局：它的 `top`、`left`、`inset`、尺寸和外边距都相对整个窗口（或对话框）。`class="inset-0"` 铺满整个窗口，可用作背景层或全窗口的图层；`class="bottom-0 left-0 right-0"` 是一条沿底部的栏。

有 `anchor` 时，NSH 把它放在锚点旁边：

- `anchor` 是一个视图（一个 `ref`）、根视图坐标系中的一个 `Point`（`{ x, y }`），即触摸的 `pageX` / `pageY`（显示在指针位置的菜单），或那里的一个 `Bounds`（`{ origin, size }`）：输入框的光标（`onCaretMove` 的 `pageBounds`），输入内容的候选在那里打开。
- `placement` 是它所在的一侧：`"top"`、`"bottom"`（默认）、`"left"` 或 `"right"`。这一侧放不下而另一侧放得下时，它会去另一侧；两侧都放不下时，它会去空间更大的一侧。
- `align` 决定它沿这一侧如何对齐：`"start"`、`"center"`（默认）或 `"end"`。在锚点上方和下方时，start 和 end 跟随布局方向：start 是左边缘，在从右到左的布局中是右边缘。
- `offset` 是锚点与浮层之间的间距；`margin` 是它与安全区边缘保持的距离，它始终位于安全区之内：放不下时会沿所在一侧滑动。

锚定的浮层会跟随锚点：锚点滚动、移动或改变尺寸时，浮层会在 NSH 布局它的同一帧里随之移动。`onPosition` 告诉你它放在了哪里，这样箭头可以指向锚点，较长的菜单可以限制自己的高度：

```tsx
<Overlay
  anchor={anchor}
  onPosition={(e) => {
    side.set(e.placement); // "top" when it flipped
    maxHeight.set(e.available.height);
  }}
/>
```

<a id="dismissing"></a>

## 关闭

浮层报告通常会关闭弹出层的操作，由你来决定是否关闭：

- 手指或鼠标按键在浮层、它的锚点以及它内部的浮层之外按下时，触发 `onPressOutside`。这次按压会继续传给下面的内容。
- 按下 Escape、Android 返回键或在 iOS 上使用 VoiceOver 的退出手势时触发 `onCancel`，只发给监听它的最上层浮层。它先于页面和 `BackHandler` 收到这些按键。

要挡住弹出层后面的屏幕，在它下面再放一个 `class="inset-0"`、带有关闭两者的 `onPress` 的浮层：[Sheet](./sheet.md) 和 [Popover](./popover.md) 在手机上的呈现方式就是这样实现的。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `anchor` | `.anchor(&element_ref)`、`.anchor_point(point)`、`.anchor_bounds(bounds)` | `YNode \| Point \| Bounds \| null` | 无 | 它相对放置的视图、点或矩形。没有时，它是根视图中的固定定位盒子。 |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | 它位于锚点的哪一侧。 |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"center"` | 它沿这一侧如何与锚点对齐。 |
| `offset` | `.offset(px(..))` | `number` | `0` | 锚点与浮层之间的间距。 |
| `margin` | `.margin(px(..))` | `number` | `0` | 它与安全区边缘保持的距离。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 它显示的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 它的外观，以及没有锚点时它的位置。 |

它也接受视图的[通用属性](./index.md#通用属性)。

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onPressOutside` | `.on_press_outside(\|point\| ..)` | 一次按压在它、它的锚点以及它内部的浮层之外按下（`pagePosition`，一个 `Point`）。 |
| `onCancel` | `.on_cancel(\|\| ..)` | Escape、Android 返回键或 VoiceOver 的退出手势，在它是监听这些操作的最上层浮层时。 |
| `onPosition` | `.on_position(\|position\| ..)` | NSH 放置了它：`placement`（它所在的一侧）、在根视图中的 `bounds`，以及 `available`（一个 `Size`：这一侧的可用空间）。 |

<a id="platform-notes"></a>

## 平台说明

- 每个平台都把浮层显示为窗口（或对话框）根视图中的原生视图，与周围的视图一样绘制和进行命中测试：UIKit、Android 视图、AppKit、GTK、Win32、GPUI 和 DOM。
- [Dialog](./dialog.md) 中的浮层显示在该对话框里，位于其内容之上。
- 浮层始终在自己的窗口内：超出窗口边缘的菜单会滑回窗口之内。

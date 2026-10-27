---
title: Sheet
description: Sheet 组件：位于屏幕一侧边缘、覆盖在背景层之上的面板，点击背景层、Escape 和返回键会关闭它，样式由应用决定。
order: 29
group: base
demo: el-sheet
---

# Sheet

Sheet 是位于屏幕一侧边缘的面板，背后的背景层覆盖其余部分：筛选条件、分享面板、侧边抽屉。按下背景层、Escape、Android 返回键和 VoiceOver 的退出手势会关闭它。它显示在所在窗口中一切内容之上，在每种设备上都一样，自己不绘制任何东西：面板和背景层都属于应用。

```rust tabs
use nsh_base::{SheetEvent, sheet};
use nsh_core::prelude::*;

fn filters(open: Signal<bool>) -> impl IntoElement {
    sheet()
        .open(move || Some(open.get()))
        .on_open_change(move |e: &SheetEvent| {
            if let SheetEvent::OpenChange(next, _) = e {
                open.set(*next);
            }
        })
        .child(
            view()
                .gap_3()
                .p_6()
                .rounded_t(px(16.0))
                .bg(white())
                .child(text("Filters").font_weight(FontWeight::SEMIBOLD))
                .child(view().on_press(move || open.set(false)).child(text("Done"))),
        )
}
```

```tsx tabs
import { signal, Text, View } from "nsh";
import { Sheet } from "nsh/base";

function Filters() {
  const open = signal(false);
  return (
    <>
      <View onPress={() => open.set(true)}><Text>Filters</Text></View>
      <Sheet
        open={open()}
        onOpenChange={(next) => open.set(next)}
        popupClass="gap-3 rounded-t-2xl bg-white p-6"
        backdropClass="bg-black/40"
      >
        <Text class="font-semibold">Filters</Text>
        <View onPress={() => open.set(false)}><Text>Done</Text></View>
      </Sheet>
    </>
  );
}
```

`Sheet` 来自 [`nsh/base`](../modules/nsh-base.md)。它的内容在每次打开时创建。`side` 把它放在屏幕的 `"bottom"`（默认）或 `"top"`，宽度与屏幕相同；或放在 `"left"` 或 `"right"`，高度与屏幕相同；它另一个方向的尺寸由面板决定，来自其内容或 `popupClass`。

入场滑动距离会跟随面板的实际测量尺寸。内容在入场期间延迟创建或异步增高时，面板沿用当前动画进度，并按更新后的尺寸滑入到位。

<a id="open-state"></a>

## 打开状态

没有 `open` 时，sheet 自己保存状态，初始值为 `defaultOpen`。有 `open` 时，状态由应用持有：在 `onOpenChange(open, reason)` 中修改它，每次关闭的请求都会带着原因（`"backdropPress"`、`"cancel"`、`"swipe"`）报告给它。无论是谁打开或关闭了它，`onOpen` 和 `onClose` 都会在它进入和离开后触发。

`closeOnEscape={false}` 让它在 Escape 和返回键时保持打开，`closeOnBackdropPress={false}` 让它在按下背景层时保持打开；`onCancel` 仍会收到这些操作，可以先询问用户。

<a id="dragging-a-bottom-sheet"></a>

## 拖动底部面板

设置 `closeOnSwipe` 后，底部面板会跟随下拉，遮罩随距离变淡。松手时，下拉距离达到面板高度的 30%，
或向下速度达到每秒 800 点，会以 `"swipe"` 原因请求关闭；较短的拖动会平滑回弹。
受控模式下，业务保持 `open` 为 true 即可让面板回弹。减少动态效果开启时，松手和程序开关会立即到位，
直接拖动仍然跟手。

面板按内容高度布局，适合矮菜单；业务通过 `popupStyle` 或子元素高度约束较长内容，并自行绘制拖动条。
iOS 中，内部竖向 `Scroll` 或 `List` 先消费滚动，到顶部后把同一次手势剩余的下拉位移交给面板。
Android、桌面和 Web 使用已有的原生 pan 支持拖动条及滚动区域外的内容拖动，内部滚动沿用各平台的手势仲裁。
将 `closeOnSwipe` 改为 false 后面板保持原位，内容和滚动位置保留。其他 `side` 保持现有行为。

<a id="native-sheets"></a>

## 原生 sheet

Sheet 由 NSH 在应用的窗口中绘制，样式由应用决定。要使用平台自己呈现的 sheet（iOS 上的 page sheet），请使用 `presentation="pageSheet"` 的 [Dialog](./dialog.md)。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | 无 | 是否打开，由应用控制。 |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | 没有 `open` 时，初始是否打开。 |
| `side` | `.side(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | 它所在的边缘。 |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean` | `true` | Escape 和 Android 返回键会关闭它。 |
| `closeOnBackdropPress` | `.close_on_backdrop_press(..)` | `boolean` | `true` | 按下背景层会关闭它。 |
| `closeOnSwipe` | `.close_on_swipe(..)` | `boolean` | `false` | 底部面板跟随下拉，并在松手达到阈值时请求关闭。 |
| `popupClass`、`popupStyle` | `popup_class`、`popup_style` | `string`、`StyleProp<ViewStyle>` | 无 | 面板的外观。 |
| `backdropClass`、`backdropStyle` | `backdrop_class`、`backdrop_style` | `string`、`StyleProp<ViewStyle>` | 无 | 背景层的外观，比如半透明的颜色。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 内容。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | 它关闭了，附带原因：`"backdropPress"`、`"cancel"` 或 `"swipe"`。 |
| `onOpen` | `.on_open(\|\| ..)` | 它已进入：完全显示出来。 |
| `onClose` | `.on_close(\|\| ..)` | 它已离开：完全消失。应用关闭它时也会触发。 |
| `onCancel` | `.on_cancel(\|\| ..)` | 用户尝试关闭它（Escape 或返回键、按下背景层、已启用的下拉关闭），无论它是否关闭。 |

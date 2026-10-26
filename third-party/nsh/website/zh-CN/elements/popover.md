---
title: Popover
description: Popover 组件：锚定在触发元素上、显示在一切之上的内容，触发元素、外部按压、Escape 和返回键都会关闭它，样式由应用决定。
order: 26
group: base
demo: el-popover
---

# Popover

弹出框把内容显示在触发元素旁边、其他一切之上：详情、一个小表单、一个取色器。按下触发元素会打开和关闭它；外部按压、Escape、Android 返回键和 VoiceOver 的退出手势会关闭它。它放在触发元素的某一侧，空间不够时换到另一侧，始终位于安全区之内，并在触发元素滚动时跟随它。它自己不绘制任何东西：弹出层和其中的内容都属于应用。

```rust tabs
use nsh_base::{OpenChangeReason, PopoverEvent, popover};
use nsh_core::prelude::*;

fn details() -> impl IntoElement {
    popover()
        .offset(px(6.0))
        .margin(px(8.0))
        .trigger(view().px_3().py_2().rounded_md().bg(rgb(0xe5e7eb)).child(text("Details")))
        .on_open_change(|e: &PopoverEvent| {
            if let PopoverEvent::OpenChange(open, OpenChangeReason::PressOutside) = e {
                log::info!("closed by a press outside: {open}");
            }
        })
        .child(
            view()
                .w(px(240.0))
                .gap_1()
                .p_3()
                .rounded_lg()
                .bg(white())
                .shadow_lg()
                .child(text("Order #1024").font_weight(FontWeight::SEMIBOLD))
                .child(text("Shipped yesterday, arriving Friday.")),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Popover } from "nsh/base";

function Details() {
  return (
    <Popover
      offset={6}
      margin={8}
      popupClass="w-60 gap-1 rounded-lg bg-white p-3 shadow-lg"
      trigger={
        <View class="rounded-md bg-gray-200 px-3 py-2">
          <Text>Details</Text>
        </View>
      }
    >
      <Text class="font-semibold">Order #1024</Text>
      <Text>Shipped yesterday, arriving Friday.</Text>
    </Popover>
  );
}
```

`Popover` 来自 [`nsh/base`](../modules/nsh-base.md)。它的内容在每次打开时创建，所以其中的状态每次都从头开始。

<a id="open-state"></a>

## 打开状态

没有 `open` 时，弹出框自己保存状态，初始值为 `defaultOpen`。有 `open` 时，状态由应用持有：在 `onOpenChange(open, reason)` 中修改它，每次打开或关闭的请求都会带着原因（`"triggerPress"`、`"pressOutside"`、`"cancel"`）报告给它。

```tsx
const open = signal(false);

<Popover open={open()} onOpenChange={(next) => open.set(next)} trigger={<Text>Filters</Text>}>
  <FilterForm onApply={() => open.set(false)} />
</Popover>
```

`closeOnEscape={false}` 让它在 Escape 和返回键时保持打开（`onCancel` 仍会收到它们，可以先询问用户）；`closeOnPressOutside={false}` 让它在外部按压时保持打开。

## 独立的锚点

受控弹出框可以使用 `anchor={rowRef}` 跟随在别处渲染的元素，无需把它移入 `trigger`。这个 ref 是同一根视图中的 `YNode`，其边界优先于触发元素。弹出框打开期间保持锚点挂载；虚拟列表中的原行退役时关闭弹出层。锚点只决定位置：键盘焦点会回到实际打开它的控件，例如列表的搜索框。

<a id="phones-and-desktops"></a>

## 手机与桌面

在每种设备上，弹出框都锚定在触发元素上：它显示的内容属于打开它的那个元素旁边。

- 在桌面平台和桌面浏览器中，外部按压会关闭它，并继续传给指针下方的内容，所以一次单击既关闭弹出框，又按下了落点处的按钮。
- 在手机和平板上，外部按压只会关闭它：一个透明的背景层接住这次按压，与系统的弹出框一致。

一组操作请使用 [Menu](./menu.md)，它在手机上会变成 sheet；面板请使用 [Sheet](./sheet.md)。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | 无 | 是否打开，由应用控制。 |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | 没有 `open` 时，初始是否打开。 |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | 它位于触发元素的哪一侧。 |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"center"` | 它沿这一侧如何与触发元素对齐。 |
| `offset` | `.offset(..)` | `number` | `0` | 触发元素与弹出层之间的间距。 |
| `margin` | `.margin(..)` | `number` | `0` | 它与安全区边缘保持的距离。 |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean` | `true` | Escape 和 Android 返回键会关闭它。 |
| `closeOnPressOutside` | `.close_on_press_outside(..)` | `boolean` | `true` | 外部按压会关闭它。 |
| `popupClass`、`popupStyle` | `popup_class`、`popup_style` | `string`、`StyleProp<ViewStyle>` | 无 | 弹出层（装着内容的盒子）的外观。 |
| `anchor` | `.anchor(..)` | `YNode \| null` | 无 | 在别处渲染的锚点，其边界优先于触发元素。 |
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 打开它的元素；它相对这个元素放置。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 内容。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | 它打开或关闭了，附带原因：`"triggerPress"`、`"pressOutside"` 或 `"cancel"`。 |
| `onOpen` | `.on_open(\|\| ..)` | 它已显示。 |
| `onClose` | `.on_close(\|\| ..)` | 它已消失，应用关闭它时也会触发。 |
| `onCancel` | `.on_cancel(\|\| ..)` | 用户尝试关闭它（Escape 或返回键、外部按压），无论它是否关闭。 |

<a id="accessibility"></a>

## 无障碍

触发元素会告诉屏幕阅读器弹出框是否已展开。Escape 和返回键会关闭它，与用户对弹出层的预期一致。

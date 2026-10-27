---
title: Dialog
description: Dialog 组件：在所有内容之上的模态界面，用于全屏流程、sheet 和由应用设定样式的对话框。
order: 21
group: base
demo: el-dialog
---

# Dialog

Dialog 在应用其余内容之上、在它自己的原生窗口层中呈现内容：iOS 和 Mac Catalyst 上是一个被 present 的 view controller，Android 上是一个 Dialog，桌面平台和 Web 上是覆盖整个窗口的一层。它用于全屏流程、sheet 和对话框。系统自带的手势（下滑关闭 sheet、Android 返回键、Escape）都能正常工作，并在原生侧决定。Rust 用 `nsh_base::dialog()` 创建，TSX 用从 `nsh/base` 导入的 `<Dialog>`。

Dialog 负责行为，外观交给应用：它的样式设定弹出层（包含子元素的视图）的样式，在 TSX 中 `backdropClass` / `backdropStyle` 在它后面加一层背景。

```rust tabs
use nsh_base::{button, dialog};
use nsh_core::prelude::*;

/// A blue button with a white label.
fn primary(label: &'static str, on_press: impl Fn() + 'static) -> impl IntoElement {
    button()
        .on_press(on_press)
        .items_center()
        .rounded_lg()
        .bg(rgb(0x2563eb))
        .px_4()
        .py_3()
        .active(|s| s.opacity(0.7))
        .child(text(label).font_weight(FontWeight::SEMIBOLD).text_color(white()))
}

fn example() -> impl IntoElement {
    let open = signal(false);
    view()
        .flex_1()
        .justify_center()
        .p_6()
        .child(primary("Open", move || open.set(true)))
        .child(when(open, move || {
            dialog()
                .presentation(ModalPresentation::PageSheet)
                .on_cancel(move || open.set(false))
                .flex_1()
                .bg(white())
                .child(
                    view()
                        .flex_1()
                        .px_5()
                        .pt_safe_area_plus(px(20.0))
                        .pb_safe_area_plus(px(20.0))
                        .gap_3()
                        .child(text("A sheet").text_2xl().font_weight(FontWeight::BOLD))
                        .child(primary("Close", move || open.set(false))),
                )
        }))
}
```

```tsx tabs
import { signal, Text, View } from "nsh";
import { Button, Dialog } from "nsh/base";

function Example() {
  const open = signal(false);
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24 }}>
      <Button onPress={() => open.set(true)} class="items-center rounded-lg bg-blue-600 px-4 py-3 active:opacity-70">
        <Text class="font-semibold text-white">Open</Text>
      </Button>
      <Dialog open={open()} presentation="pageSheet" onOpenChange={(next) => open.set(next)} class="flex-1 bg-white">
        <View
          style={{
            flex: 1,
            gap: 12,
            paddingHorizontal: 20,
            paddingTop: "calc(env(safe-area-inset-top) + 20px)",
            paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)",
          }}
        >
          <Text style={{ fontSize: 24, fontWeight: "700" }}>A sheet</Text>
          <Button onPress={() => open.set(false)} class="items-center rounded-lg bg-blue-600 px-4 py-3 active:opacity-70">
            <Text class="font-semibold text-white">Close</Text>
          </Button>
        </View>
      </Dialog>
    </View>
  );
}
```

在 TSX 中，`open` 不为 `false` 时显示，变为 `false` 时关闭。在 Rust 中，它在视图中时呈现，离开视图时消失，所以由 `when` 持有它。无论哪种方式，它都会给内容提供 dialog 的安全区域 inset，供其内部的 [`env(safe-area-inset-*)`](./safe-area.md) 变量和 `safeAreaInsets()`（Rust 组件中为 `cx.insets()`）读取。[`Button`](./button.md) 同样来自 `nsh/base`，是由应用设定样式的按压目标。

`nsh_core::prelude` 中也有一个较旧的、已弃用的 `dialog` 函数：像上面那样按名称导入 `nsh_base::dialog`，显式导入会取代它。如果需要系统提示框或操作表，请使用 [`AlertDialog`](./alert-dialog.md)。

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `open` | 打开期间位于视图中（`when(open, ..)`） | `boolean` | `true` | 为 true 时显示。 |
| `animation` | `.animation(ModalAnimation::Fade)` | `"slide" \| "fade" \| "none"` | `"slide"` | 出现和离开的方式。 |
| `presentation` | `.presentation(ModalPresentation::PageSheet)` | `"fullScreen" \| "pageSheet" \| "formSheet"` | `"fullScreen"` | 在 iOS 上的形式：`fullScreen` 以透明背景覆盖整个屏幕；`pageSheet` 和 `formSheet` 是系统 sheet，下面的内容保持可见（在大屏上 `formSheet` 是一个更小的居中 sheet）。 |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean` | `true` | Escape 和 Android 返回键在原生侧关闭它。 |
| `closeOnBackdropPress` | `.close_on_backdrop_press(..)` | `boolean` | `true` | 按下背景层时关闭它。 |
| `closeOnSwipe` | `.close_on_swipe(..)` | `boolean` | `true` | 下滑 sheet（iOS、手机浏览器）时在原生侧关闭它。 |
| `statusBar` | `.status_bar(..)` | `{ foreground?, hidden?, animated? }` | 无 | iOS 和 Android：对话框打开期间的状态栏，位于页面的设置之上（[状态栏](../modules/nsh-base.md#status-bar)）。 |
| `onOpen` | `.on_open(..)` | `() => void` | | 已完全出现。 |
| `onClose` | `.on_close(..)` | `() => void` | | 已离开：用户关闭了它，或应用移除了它。 |
| `onCancel` | `.on_cancel(..)` | `() => void` | | 用户尝试关闭它（Escape、返回、按下背景层、下滑），无论 `closeOn*` 是否允许关闭。 |
| `onOpenChange` | `.on_cancel(..)` | `(open: boolean, reason: "cancel" \| "backdropPress" \| "swipe") => void` | | 用户关闭了它：在这里同步 `open`。在 Rust 中，由 `on_cancel` 把对话框移出视图。 |
| `class`、`style` | `Styled` 方法 | `string`、`StyleProp<ViewStyle>` | | 弹出层：包含子元素的视图。 |
| `backdropClass`、`backdropStyle` | 铺满对话框的子视图 | `string`、`StyleProp<ViewStyle>` | | 铺满 dialog、位于弹出层后面的背景层，设置其中之一时出现。 |
| `children` | `.child(..)` | `JSX.Element` | | 内容。 |

| `ios` 键 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `supportedOrientations` | `.supported_orientations(..)` | `("portrait" \| "portrait-upside-down" \| "landscape" \| "landscape-left" \| "landscape-right")[]` | 与呈现者相同 | dialog 允许的方向。 |

| `android` 键 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `statusBarTranslucent` | `.status_bar_translucent(..)` | `boolean` | `false` | 内容延伸到状态栏下方；否则从状态栏下方开始。 |

## 打开与关闭

对话框的状态属于应用。用户关闭 dialog（Escape、Android 返回键、按下背景层、下滑 sheet）时，它在原生侧关闭并通知应用，由应用把状态改成一致：TSX 中是 `onOpenChange(false, reason)`，Rust 中是 `on_cancel`。在 TSX 中，`open` 一直为 `true` 时 dialog 保持关闭，`open` 从 `false` 变为 `true` 时再次打开。

由于主线程从不等待应用代码，每个 `closeOn*` 标志都在用户操作时由原生侧读取。要在关闭前先确认，把这些标志设为 `false`：此时用户的尝试会调用 `onCancel`，由应用自己关闭对话框（TSX 中把 `open` 设为 `false`，Rust 中把它移出视图）：

```rust tabs
dialog()
    .presentation(ModalPresentation::PageSheet)
    .close_on_escape(false)
    .close_on_backdrop_press(false)
    .close_on_swipe(false)
    .on_cancel(move || ask_to_discard.set(true))
    .flex_1()
    .bg(white())
    .child(form())
```

```tsx tabs
<Dialog
  open={open()}
  presentation="pageSheet"
  closeOnEscape={false}
  closeOnBackdropPress={false}
  closeOnSwipe={false}
  onCancel={() => askToDiscard.set(true)}
  class="flex-1 bg-white"
>
  …
</Dialog>
```

每次尝试都会调用 `onCancel`，无论这些标志是否允许关闭。

## 带背景层的对话框

默认 `fullScreen` 形式的 dialog 显示应用绘制的内容：这里是一层变暗的背景和居中的卡片。按下背景层即关闭：

```rust tabs
when(confirm, move || {
    dialog()
        .animation(ModalAnimation::Fade)
        .on_cancel(move || confirm.set(false))
        .flex_1()
        .child(
            // 背景层：按下即关闭对话框。
            view()
                .absolute()
                .inset_0()
                .bg(rgba(0x00000066))
                .on_press(move || confirm.set(false)),
        )
        .child(
            view()
                .m(auto())
                .w_80()
                .gap_3()
                .rounded_2xl()
                .bg(white())
                .p_5()
                .child(text("删除这一项？").text_xl().font_weight(FontWeight::BOLD))
                .child(
                    button()
                        .on_press(remove)
                        .items_center()
                        .rounded_lg()
                        .bg(rgb(0xdc2626))
                        .px_4()
                        .py_3()
                        .active(|s| s.opacity(0.7))
                        .child(text("删除").font_weight(FontWeight::SEMIBOLD).text_color(white())),
                ),
        )
})
```

```tsx tabs
<Dialog
  open={confirm()}
  animation="fade"
  onOpenChange={(next) => confirm.set(next)}
  backdropClass="bg-black/40"
  class="m-auto w-80 gap-3 rounded-2xl bg-white p-5"
>
  <Text style={{ fontSize: 20, fontWeight: "700" }}>删除这一项？</Text>
  <Button onPress={remove} class="items-center rounded-lg bg-red-600 px-4 py-3 active:opacity-70">
    <Text class="font-semibold text-white">删除</Text>
  </Button>
</Dialog>
```

如果需要系统提示框或操作表，请使用 `nsh/base` 的 [`AlertDialog`](./alert-dialog.md)。

## ref 方法

无。

## 平台说明

- iOS 和 Mac Catalyst：`presentation` 决定形式。`fullScreen` 以透明背景覆盖整个屏幕；`pageSheet` 和 `formSheet` 是带系统背景的系统 sheet，下滑时跟随手指（`closeOnSwipe`）。
- Android：dialog 铺满窗口，显示应用的弹出层和背景层。返回键首先交给最上层的 dialog，然后才是导航栈和 `BackHandler` 监听器。
- 桌面平台（macOS、Windows、Linux、GPUI）和 Web：dialog 是覆盖整个窗口的透明层，显示应用的弹出层和背景层。Escape 是一次关闭尝试。
- `supportedOrientations` 属于 iOS，`statusBarTranslucent` 属于 Android。设置 `statusBarTranslucent` 之前，Android dialog 的内容从状态栏下方开始。

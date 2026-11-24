---
title: Sheet
description: Sheet 组件：位于屏幕一侧边缘、覆盖在背景层之上的面板，点击背景层、Escape 和返回键会关闭它，可停靠在多个高度，样式由应用决定。
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
        onOpenChange={(e) => open.set(e.open)}
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

没有 `open` 时，sheet 自己保存状态，初始值为 `defaultOpen`。有 `open` 时，状态由应用持有：在 `onOpenChange({ open, reason })` 中修改它，每次关闭的请求都会带着原因（`"backdropPress"`、`"cancel"`、`"swipe"`）报告给它。无论是谁打开或关闭了它，`onOpen` 和 `onClose` 都会在它进入和离开后触发。

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
面板开始跟手时结束编辑：其中获得焦点的输入框失焦，软键盘收起；只滚动内部列表不会收起键盘。
将 `closeOnSwipe` 改为 false 后面板保持原位，内容和滚动位置保留。其他 `side` 保持现有行为。

<a id="detents"></a>

## 停靠高度（detents）

底部面板可以停在多个高度，就像地图或播放器的面板：设置 `detents`，可以是 `"medium"`（约半个屏幕）、
`"large"`（状态栏以下的整个屏幕）、以点为单位的 `{ height }`，或 large 高度的一个比例 `{ fraction }`。
面板的高度等于最大的停靠高度，停在较小的高度时位置更低，只露出上面一部分。拖动时面板跟随手指在各高度之间移动；
松手后弹簧动画把它送到最近的停靠高度，快速甩动时则继续到甩动方向上的下一个。拖到最小高度以下时，
`closeOnSwipe` 与没有停靠高度时一样关闭面板；没有 `closeOnSwipe` 则回弹。iOS 中，内部滚动到顶部后把下拉交给面板，
因此最大高度下的列表先滚动，再把面板拉下来。在桌面平台和 Web 上，鼠标拖动同样有效。

没有 `detent` 时，面板自己记住停靠高度，从 `defaultDetent`（默认是最小的）开始。设置 `detent` 后由应用控制：
在 `onDetentChange({ detent })` 中更新它，每次用户把面板移到另一个高度都会报告；应用保持原值时面板会回到原来的高度。
`detents` 可以在面板打开时改变：原来没有停靠高度的面板设置了它，或者全部去掉，都会立即生效，面板会重新创建其中的内容；
`side` 在底部与其他方向之间切换时也是如此。

`grabber` 在面板顶部、内容之前显示一个拖动条。和 sheet 的其他部分一样，它没有自己的外观：用 `grabberClass` /
`grabberStyle` 设置样式，用 `grabberAccessibilityLabel` 命名。读屏软件可以调节它来切换停靠高度，按下它会移到下一个更大的高度
（最大之后回到最小）。减少动态效果开启时，面板在停靠高度之间直接到位。

`footer` 显示在面板底部、内容之后，例如输入条或面板的操作按钮。有停靠高度时，它始终贴在面板可见部分的底部：
停在任何一个高度、拖动或弹簧动画在高度之间移动面板时都一样，随面板在原生侧移动；拖到最小高度以下时随面板一起移动。
最小的停靠高度要放得下底栏。用 `footerClass` / `footerStyle` 设置样式。

```tsx
const detent = signal<SheetDetent>("medium");

<Sheet
  open={open()}
  onOpenChange={(e) => open.set(e.open)}
  detents={["medium", "large"]}
  detent={detent()}
  onDetentChange={(e) => detent.set(e.detent)}
  closeOnSwipe
  grabber
  grabberClass="h-1.5 w-9 self-center rounded-full bg-zinc-300"
  grabberAccessibilityLabel="调整高度"
  popupClass="rounded-t-2xl bg-white pt-2"
  backdropClass="bg-black/40"
  footer={<Input placeholder="添加评论" />}
  footerClass="border-t border-zinc-200 px-4 py-2"
>
  <Scroll class="flex-1">{/* … */}</Scroll>
</Sheet>
```

软键盘会像抬起其他底部面板一样抬起带停靠高度的面板，最多到状态栏下方。键盘弹出期间，面板停在最大的停靠高度，
这样底栏或内容里正在输入的文字看得见；键盘收起后回到原来的停靠高度。升高本身不改变应用读到的 `detent`，
这期间拖动条的读屏值和按下仍按这个 `detent` 计算。

<a id="the-software-keyboard"></a>

## 软键盘

原生 Android 中，Sheet 自己的模态窗口已扣除整个输入法区域。Sheet 与抽屉只补回键盘与底部安全区重叠的部分，让原有安全区留白落在键盘后方，不再重复抬升面板。标题与关闭按钮保留在屏幕内，面板内容与其他平台一样停在键盘上方；其他平台则在完整高度的呈现区域内移动面板。这项偏移仅属于 Sheet 的模态根视图，其他弹层保留各自的呈现方式和键盘处理。

软键盘弹起时，贴着屏幕底边的面板（底部 sheet、左右两侧的抽屉）改为贴在键盘上沿，并随键盘的弹起和收起按键盘自己的曲线移动。
面板底部照常按安全区留白（`pb-[env(safe-area-inset-bottom)]`，Rust 用 `.pb_safe_area()`），与没有键盘时一样：
这段留白此时落在键盘后面，面板内容正好停在键盘上方，即安全区与键盘取较大者。被键盘抬起时，底部 sheet 内容再高也不会越过状态栏。
`popupStyle` 中的 `maxHeight` 会取代这一上限，因此更矮的上限要自行扣除键盘超出安全区的高度（`keyboardFrame().height - safeArea().bottom`），
例如 `windowSize().height - safeArea().top - Math.max(0, keyboardFrame().height - safeArea().bottom) - 24`。
手机上以 sheet 呈现的菜单、选择器和日期选择器也是如此，它们的 `popupStyle` 或 `popupClass` 中的 `maxHeight` 同样取代其上限。

<a id="screen-readers-and-keyboard-focus"></a>

## 读屏与键盘焦点

与 [Dialog](./dialog.md) 一样，Sheet 在每个平台上都是模态对话框。读屏软件把它当作对话框，用 `accessibilityLabel`（填 sheet 的标题）为它命名，它显示期间读屏只在它里面移动。在桌面平台和 Web 上，它打开时键盘焦点离开下面的内容，Tab 在面板里的各个焦点停靠点之间循环，关闭时焦点回到原来的位置。要一打开就让面板里的某个控件获得焦点，在 `onOpen` 中聚焦它。

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
| `detents` | `.detents(..)` | `SheetDetent[]` | `[]` | 底部面板的停靠高度：`"medium"`、`"large"`、`{ height }`、`{ fraction }`。 |
| `detent` | `.detent(..)` | `SheetDetent` | 无 | 当前停靠高度，由应用控制。 |
| `defaultDetent` | `.default_detent(..)` | `SheetDetent` | 最小的 | 没有 `detent` 时，初始的停靠高度。 |
| `grabber` | `.grabber(..)` | `boolean` | `false` | 在面板顶部显示拖动条。 |
| `grabberClass`、`grabberStyle` | `grabber_class`、`grabber_style` | `string`、`StyleProp<ViewStyle>` | 无 | 拖动条的外观。 |
| `grabberAccessibilityLabel` | `.grabber_accessibility_label(..)` | `string` | 无 | 读屏软件对拖动条的称呼。 |
| `footer` | `.footer(..)` | `JSX.Element` | 无 | 显示在面板底部的内容；有停靠高度时显示在可见部分的底部。 |
| `footerClass`、`footerStyle` | `footer_class`、`footer_style` | `string`、`StyleProp<ViewStyle>` | 无 | 底栏的外观。 |
| `popupClass`、`popupStyle` | `popup_class`、`popup_style` | `string`、`StyleProp<ViewStyle>` | 无 | 面板的外观。 |
| `backdropClass`、`backdropStyle` | `backdrop_class`、`backdrop_style` | `string`、`StyleProp<ViewStyle>` | 无 | 背景层的外观，比如半透明的颜色。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 读屏软件对这个对话框的称呼：sheet 的标题。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 内容。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | 它关闭了，附带原因：`"backdropPress"`、`"cancel"` 或 `"swipe"`。 |
| `onOpen` | `.on_open(\|\| ..)` | 它已进入：完全显示出来。 |
| `onClose` | `.on_close(\|\| ..)` | 它已离开：完全消失。应用关闭它时也会触发。 |
| `onCancel` | `.on_cancel(\|\| ..)` | 用户尝试关闭它（Escape 或返回键、按下背景层、已启用的下拉关闭），无论它是否关闭。 |
| `onDetentChange` | `.on_detent_change(\|detent\| ..)` | 用户把它移到了另一个停靠高度（拖动或拖动条）。 |

在 Web 上，嵌入时设置 `dialogs: "viewport"` 可让面板和遮罩覆盖宿主页面，同源 iframe 也会采用这个范围。
跨域 iframe 由宿主页接入 [`hostPlayerFrame`](../docs/web.md)。

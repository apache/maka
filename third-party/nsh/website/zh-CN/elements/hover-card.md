---
title: HoverCard
description: HoverCard 组件：预览触发元素所指向的内容，在指针停留在触发元素上时显示，样式由应用决定。
group: base
demo: el-hover-card
---

# HoverCard

悬停卡片在不离开当前页面的情况下预览触发元素所指向的内容：一次提及背后的个人资料、一个链接背后的页面、一个股票代码背后的报价。在桌面平台和桌面浏览器中，指针在触发元素上停留 `openDelay`（600 毫秒）后，或键盘焦点来到触发元素上时，它会打开。指针从触发元素移到卡片上再移回来时，以及键盘焦点在触发元素上或在卡片里的链接、按钮上时，它都保持打开，所以卡片里的内容用指针和键盘都能使用；指针离开两者、焦点也不在两者之中 `closeDelay`（300 毫秒）后，它会关闭。Escape 和外部按压会立即关闭它。在手机和平板上，按下触发元素会打开和关闭它，外部按压会关闭它。

来自 [`nsh/base`](../modules/nsh-base.md) 的 `HoverCard` 自己不绘制任何东西：触发元素是你的元素，弹出层和其中的内容也都属于你。

```rust tabs
use nsh_base::hover_card;
use nsh_core::prelude::*;

fn mention() -> impl IntoElement {
    hover_card()
        .offset(px(8.0))
        .popup_class("w-72 gap-2 rounded-xl border border-border bg-popover p-4 shadow-lg")
        .trigger(text("@ada").text_color(rgb(0x2563eb)))
        .child(text("Ada Lovelace").font_weight(FontWeight::SEMIBOLD))
        .child(text("Writes the first programs for the Analytical Engine."))
}
```

```tsx tabs
import { Text } from "nsh";
import { HoverCard } from "nsh/base";

function Mention() {
  return (
    <HoverCard
      offset={8}
      popupClass="w-72 gap-2 rounded-xl border border-border bg-popover p-4 shadow-lg"
      trigger={<Text class="text-blue-600">@ada</Text>}
    >
      <Text class="font-semibold">Ada Lovelace</Text>
      <Text>Writes the first programs for the Analytical Engine.</Text>
    </HoverCard>
  );
}
```

触发元素保留自己的角色、按压和外观：带 `role="link"` 和自己 `onPress` 的视图按下后仍会去往它指向的地方，卡片只是为它加上预览。内容在每次打开时创建，所以可以在那时加载它要显示的东西。在手机和平板上，按压会打开卡片，触发元素会告诉屏幕阅读器它的卡片是否已打开。在 [Toolbar](./toolbar.md) 中，触发元素可以是工具栏的一项，卡片里的内容则不是：其中的按钮和链接保留自己的 Tab 停靠点，工具栏的 `disabled` 也不会改变它们。

<a id="delays"></a>

## 延迟

`openDelay` 让指针经过触发元素去往别处时，卡片不会一闪而开；`closeDelay` 给指针留出穿过触发元素与卡片之间空隙的时间。两者都以毫秒为单位。指针和延迟都在原生层跟踪，所以在触发元素上停留、在它与卡片之间移动时，直到卡片打开或关闭之前，都不会运行你的代码。`openDelay` 为 `Infinity` 时，打开交给应用（以及触摸屏上对触发元素的按压）；`closeDelay` 为 `Infinity` 时，关闭交给 Escape、外部按压和应用。

```tsx
<HoverCard openDelay={300} closeDelay={150} trigger={<Text>AAPL</Text>}>
  <Quote symbol="AAPL" />
</HoverCard>
```

<a id="open-state"></a>

## 打开状态

没有 `open` 时，卡片自己保存状态，初始值为 `defaultOpen`。有 `open` 时，状态由应用持有：在 `onOpenChange({ open, reason })` 中修改它，每次打开或关闭的请求都会带着原因报告给它：`"hover"`（指针）、`"focus"`（键盘焦点）、`"triggerPress"`（触摸屏上的按压）、`"pressOutside"` 或 `"cancel"`（Escape 或返回键）。

```tsx
const open = signal(false);

<HoverCard open={open()} onOpenChange={(e) => open.set(e.open)} trigger={<Text>@ada</Text>}>
  <Profile id="ada" />
</HoverCard>
```

<a id="entrance-and-exit"></a>

## 出现与离开

悬停卡片随你的过渡出现和离开，与 [Popover](./popover.md) 相同。`popupStartingClass` 是弹出层第一帧的外观，`popupClass` 里的 `transition-*` 类把它过渡到自己的外观。`popupEndingClass` 是关闭后的外观：卡片会保留下来、不再接收指针，直到这些过渡播放完毕才离开，随后触发 `onClose`。在离开途中指针再次停留在触发元素上时，它会回来。用户要求减少动态效果时，它立即出现、立即离开。

```tsx
<HoverCard
  popupClass="rounded-xl bg-popover p-4 shadow-lg transition-all duration-150 ease-out"
  popupStartingClass="opacity-0 scale-95"
  popupEndingClass="opacity-0 scale-95"
  trigger={<Text>@ada</Text>}
>
  <Profile id="ada" />
</HoverCard>
```

它默认位于触发元素下方（`placement`、`align`），空间不够时换到另一侧，并始终位于安全区之内。`onPosition({ placement, bounds, available })` 说明它放在了哪里。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | 无 | 是否打开，由应用控制。 |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | 没有 `open` 时，初始是否打开。 |
| `openDelay` | `.open_delay(..)` | `number` | `600` | 指针在触发元素上停留、或焦点停在它上面多少毫秒后打开；`Infinity`：不会自行打开。 |
| `closeDelay` | `.close_delay(..)` | `number` | `300` | 指针离开触发元素和卡片、焦点也不在两者之中多少毫秒后关闭；`Infinity`：不会自行关闭。 |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | 它位于触发元素的哪一侧。 |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"center"` | 它沿这一侧如何与触发元素对齐。 |
| `offset` | `.offset(..)` | `number` | `0` | 触发元素与卡片之间的间距。 |
| `margin` | `.margin(..)` | `number` | `0` | 它与安全区边缘保持的距离。 |
| `popupClass`、`popupStyle` | `popup_class`、`popup_style` | `string`、`StyleProp<ViewStyle>` | 无 | 弹出层（装着内容的卡片）的外观。 |
| `popupStartingClass`、`popupStartingStyle` | `popup_starting_class`、`popup_starting_style` | `string`、`StyleProp<ViewStyle>` | 无 | 弹出层第一帧的外观，叠加在它自己的外观之上：它的过渡从这里开始。 |
| `popupEndingClass`、`popupEndingStyle` | `popup_ending_class`、`popup_ending_style` | `string`、`StyleProp<ViewStyle>` | 无 | 弹出层关闭后的外观，叠加在它自己的外观之上：过渡播放期间它会保留。 |
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 它预览的元素；它相对这个元素放置。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 内容，每次打开时创建。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | 它请求打开或关闭，附带原因：`"hover"`、`"focus"`、`"triggerPress"`、`"pressOutside"` 或 `"cancel"`。 |
| `onOpen` | `.on_open(\|\| ..)` | 它已显示。 |
| `onClose` | `.on_close(\|\| ..)` | 它已消失（在离开过渡之后），应用关闭它时也会触发。 |
| `onPosition` | `.on_position(\|e\| ..)` | 弹出层已放置：`placement`（它所在的一侧）、`bounds`（它的框）、`available`（那一侧的空间）。 |

<a id="accessibility"></a>

## 无障碍

悬停卡片是对触发元素的补充：触发元素保留自己的角色和标签，按下它时打开或执行的东西也不变。键盘用户在焦点停在触发元素上时得到卡片，Escape 关闭它。卡片自己不获取焦点，所以 Tab 照常从触发元素往后移动。卡片里的链接和按钮像别处一样获取焦点，其中一个持有焦点时卡片保持打开；卡片里重要的内容，也应能从触发元素通往的页面中找到。

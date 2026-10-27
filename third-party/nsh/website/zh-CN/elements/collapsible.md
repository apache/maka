---
title: Collapsible
description: Collapsible 组件：内容可展开和收起的区域，应用让它展开时内容显示在子元素之后，触发控件和全部外观都由应用决定。
order: 20.7
group: base
demo: el-collapsible
---

# Collapsible

Collapsible 是内容可展开和收起的区域：摘要下面的详情、“显示更多”、一组高级设置。它始终渲染子元素，`open` 时在子元素之后渲染
`content`。`open` 和切换它的触发控件（子元素之一）由应用持有，外观也由应用决定：`Collapsible` 没有自己的触发控件、箭头、动效或文字。

```rust tabs
use nsh_base::{collapsible, theme};
use nsh_core::{AccessibilityState, prelude::*};

fn storage() -> impl IntoElement {
    let open = signal(false);
    collapsible()
        .open(open)
        .gap_2()
        .child(
            view()
                .role(AccessibilityRole::Button)
                .accessibility_state(move || AccessibilityState {
                    expanded: Some(open.get()),
                    ..AccessibilityState::default()
                })
                .on_press(move || open.update(|o| *o = !*o))
                .flex_row()
                .items_center()
                .justify_between()
                .child(text("Storage"))
                .child(text("›").transition_transform().rotate(move || {
                    if open.get() { deg(90.0) } else { deg(0.0) }
                })),
        )
        .content(text("Photos 120 GB · Apps 54 GB · System 38 GB").text_color(move || theme().muted_foreground))
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Collapsible } from "nsh/base";

function App() {
  const open = signal(false);
  return (
    <Collapsible
      open={open()}
      class="gap-2"
      content={<Text class="text-muted-foreground">Photos 120 GB · Apps 54 GB · System 38 GB</Text>}
    >
      <View
        role="button"
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class="flex-row items-center justify-between active:opacity-70"
      >
        <Text class="font-medium">Storage</Text>
        <Text class={`transition-transform ${open() ? "rotate-90" : ""}`}>›</Text>
      </View>
    </Collapsible>
  );
}

mount(App);
```

`Collapsible` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 里是 `nsh-base` crate。值由应用持有：触发控件切换 `open`，
collapsible 显示应用传入的值。在 Rust 里，`collapsible()` 创建一个 collapsible，每个属性一个 setter（`.open(..)`、
`.content(..)`），区域本身用类型化的样式方法，始终显示的部分用 `.child(..)`。

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | `false` | 展开：`content` 在树中，位于子元素之后。值由应用持有。 |
| `content` | `.content(..)` | `JSX.Element` | 无 | 展开的内容。它只创建一次，收起时保留，所以里面的状态（输入框的文字、滚动位置、开关）在下次展开时还在。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 始终显示的部分：摘要、切换 `open` 的触发控件。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 包住子元素和内容的区域（`gap-2` 设置它们的间距）。 |

## 事件

collapsible 本身不报告事件：触发控件是应用的，应用在它的按压（带 `role="button"` 的 `View` 的 `onPress`）里切换 `open`。

## 部件

| 部件 | 位置 | 样式 |
|---|---|---|
| 区域 | | `class`、`style` |
| 子元素 | 区域里，最先 | 它们自己的元素 |
| 内容 | 区域里，子元素之后，`open` 时 | 它自己的元素（`content`） |

内容立即出现和离开。应用自己的过渡表现这个变化：触发控件的箭头转动（`transition-transform`），内容也可以用它自己的类淡入。内容出现或离开时，
每个平台都会重新布局这个区域。

## 无障碍

- 区域本身不是屏幕阅读器的独立元素：子元素和内容按原样朗读。
- 触发控件报告区域是否展开：给它 `accessibilityState={{ expanded: open }}` 和按钮角色（`View` 上的 `role="button"`），屏幕阅读器会连同它的标签播报“已展开”或“已收起”。
- 在 macOS 和 Web 上，可按压的触发控件是键盘焦点的停靠点：Tab 可以到达它，空格和 Return 切换区域。

通用的标签、角色和播报见[无障碍](../docs/accessibility.md)。

## 平台说明

- 每个平台都在 `open` 时把内容显示在子元素之后，否则把它留在布局之外。
- iOS、Android 和 Mac Catalyst：触发控件的按压是轻点。桌面（macOS、Windows、Linux、GPUI）和 Web：点击；在 macOS 和 Web 上，获得焦点的触发控件也响应空格或 Return。

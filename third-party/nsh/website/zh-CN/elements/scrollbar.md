---
title: Scrollbar
description: "Scrollbar 组件：为所有滚动视图和列表（设置一次主题）或单个滚动视图提供应用自己外观的滚动条，也可放在应用想放的位置；滑块跟随内容，拖动和按压会滚动内容，可在滚动时、悬停时或始终显示，按应用给的时长淡入淡出。"
group: base
demo: el-scrollbar
---

# Scrollbar

滚动条为滚动视图或列表提供应用自己外观的滚动条：鼠标靠近时变宽的细胶囊、品牌色的轨道、固定表头旁边或横跨两个面板的滚动条。设置一次
应用的主题后，每个滚动视图和列表都会用它代替平台的滚动指示器（见[内置滚动条](#内置滚动条)）；由应用放置时，它指明自己滚动的滚动视图，
放在应用放置的任何位置。它负责行为：滑块的长度和位置跟随内容、视口和偏移（列表变长、窗口缩放时也一样）；拖动滑块
会滚动内容，按压轨道会让滑块中点移到那里；它在内容滚动时、指针悬停时或始终显示，并以原生动画淡入淡出。外观和时长属于应用：
`Scrollbar` 没有自己的颜色、尺寸或圆角，应用不给时长时，它的淡入淡出不占时间。

```rust tabs
use nsh_base::{ScrollbarEntrance, ScrollbarMode, ScrollbarMotion, scrollbar, theme};
use nsh_core::prelude::*;

fn inbox(rows: impl IntoElement) -> impl IntoElement {
    let list = element_ref();
    // 300 毫秒淡入、500 毫秒淡出，最后一次滚动 2 秒后隐藏；指向隐藏的滑块时它从边缘滑入。
    let mut motion = ScrollbarMotion::default();
    motion.enter = 300.0;
    motion.exit = 500.0;
    motion.thumb_hover_entrance = ScrollbarEntrance::SlideAndFade;
    view()
        .relative()
        .flex_1()
        // 滚动视图自带的指示条让位给应用的滚动条。
        .child(scroll().element_ref(&list).flex_1().scrollbar(false).child(rows))
        .child(
            scrollbar()
                .scroll(list)
                .mode(ScrollbarMode::Hover)
                .motion(motion)
                .accessibility_label("消息")
                // 轨道覆盖在右边缘，滑块在其中靠右。
                .absolute()
                .top_0()
                .bottom_0()
                .right_0()
                .w(px(16.0))
                .items_end()
                .p(px(4.0))
                .thumb_style(|s| {
                    s.w(px(6.0))
                        .rounded_full()
                        .bg(move || theme().muted_foreground)
                        .opacity(0.6)
                        .group_hover(|s| s.w(px(8.0)).opacity(0.9))
                }),
        )
}
```

```tsx tabs
import { mount, Scroll, Text, View, type YNode } from "nsh";
import { Scrollbar } from "nsh/base";

function App() {
  let list: YNode | undefined;
  return (
    <View class="relative flex-1">
      <Scroll ref={list} scrollbar={false} class="flex-1">
        {Array.from({ length: 60 }, (_, i) => (
          <Text class="px-4 py-3">{`消息 ${i + 1}`}</Text>
        ))}
      </Scroll>
      <Scrollbar
        scroll={list}
        mode="hover"
        motion={{ enter: 300, exit: 500, thumbHoverEntrance: "slideAndFade" }}
        accessibilityLabel="消息"
        class="absolute inset-y-0 right-0 w-4 items-end p-1"
        thumbClass="w-1.5 rounded-full bg-muted-foreground opacity-60 transition-all duration-300 hover:w-2 hover:opacity-90 active:w-2 active:opacity-100"
      />
    </View>
  );
}

mount(App);
```

`Scrollbar` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`scrollbar()` 创建一个滚动条，每个
prop 一个 setter（`.scroll(..)`、`.thumb_style(..)`），滚动条本身用类型化的样式方法；它的 `scroll` 接受 `ElementRef`（或
`ScrollbarTarget`）。

<a id="built-in-bars"></a>

## 内置滚动条

每个滚动视图和列表都可以用 `Scrollbar` 代替平台的滚动指示器，无需自己放置滚动条：在应用启动的地方调用一次 `Scrollbar.setTheme`，
所有 `scrollbar` 为 `true` 的视图的滚动条就都采用应用的外观。每个视图在自己的视口上得到一个滚动条，内容滚动时它停在原处（与 sticky
视图一样在主线程上完成），绘制在内容之上；它跟随、滚动和淡入淡出的方式与应用自己放置的 `Scrollbar` 相同。

```rust tabs
use nsh_base::{ScrollbarLook, ScrollbarMode, ScrollbarTheme, set_scrollbar_theme};

fn use_app_scrollbars() {
    let mut vertical = ScrollbarLook::default();
    vertical.class = Some("absolute inset-y-0 right-0 w-4 items-end p-1".into());
    vertical.thumb_class = Some("w-1.5 rounded-full bg-muted-foreground opacity-60 hover:w-2".into());
    let mut horizontal = ScrollbarLook::default();
    horizontal.class = Some("absolute inset-x-0 bottom-0 h-4 items-end p-1".into());
    horizontal.thumb_class = Some("h-1.5 rounded-full bg-muted-foreground opacity-60 hover:h-2".into());
    let mut theme = ScrollbarTheme::default();
    theme.mode = ScrollbarMode::Hover;
    theme.motion.enter = 300.0;
    theme.motion.exit = 500.0;
    theme.vertical = Some(vertical);
    theme.horizontal = Some(horizontal);
    set_scrollbar_theme(Some(theme));
}
```

```tsx tabs
import { Scrollbar } from "nsh/base";

Scrollbar.setTheme({
  mode: "hover",
  motion: { enter: 300, exit: 500 },
  vertical: {
    class: "absolute inset-y-0 right-0 w-4 items-end p-1",
    thumbClass: "w-1.5 rounded-full bg-muted-foreground opacity-60 transition-all duration-300 hover:w-2",
  },
  horizontal: {
    class: "absolute inset-x-0 bottom-0 h-4 items-end p-1",
    thumbClass: "h-1.5 rounded-full bg-muted-foreground opacity-60 transition-all duration-300 hover:h-2",
  },
});
```

`ScrollbarTheme` 包含所有视图共用的滚动条属性，以及每个方向的外观：

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mode` | `"scrolling" \| "hover" \| "always"` | `"scrolling"` | 滚动条何时显示：见[何时显示](#何时显示)。 |
| `motion` | `ScrollbarMotion` | 立即出现，`idle` 为 `2000` | 如何显示和隐藏：见[动效](#动效)。 |
| `minThumbLength` | `number` | `48` | 滑块的最短长度。 |
| `vertical`、`horizontal` | `ScrollbarLook` | 无 | 纵向视图和横向视图的滚动条外观：轨道的 `class` 和 `style`（放在视图的视口中）、`thumbClass` 和 `thumbStyle`、`accessibilityLabel`。没有对应方向外观的视图保留平台的滚动指示器。 |

之后再调用 `setTheme` 会重新设置这些滚动条的样式，`Scrollbar.setTheme(null)` 让视图恢复平台的滚动指示器。单个视图可以用
`scrollbar` 属性设置自己的主题（`<Scroll scrollbar={{ mode: "always", vertical: { … } }}>`），无论应用是否设置了主题；
`scrollbar={false}` 让视图没有滚动条。在父视图视口中布局的列表（`viewport="parent"`）随那个视图及其滚动条一起滚动。多行 `Input` 也会在文本上显示纵向外观的滚动条，像文本视图自己的指示器一样滚动文本。

## 它滚动的滚动视图

`scroll` 指明滚动条跟随的滚动视图或列表：它的 `ref`。滚动视图出现在屏幕上后滚动条就会找到它，所以 `ref` 可以由同一次渲染中后面的元素
设置；把滚动条写在它的滚动视图之后（或把 `ref` 放在 signal 里）。用 `scrollbar={false}` 关闭滚动视图自带的指示条，用 `class` 放置
滚动条：放在包住两者的 `relative` 容器里，覆盖在滚动视图的边缘，或放在屏幕上任何其他位置。

- 滑块的长度是视口显示的内容所占的比例，沿轨道的内容区（在内边距之内）计算，不短于 `minThumbLength`。它的位置是内容滚动的程度；内容
  越过一端回弹时，滑块停在那一端。
- 拖动滑块时，内容滚动的量与滑块移动的量相对应。按压轨道会让滑块中点移到指针下方，之后的拖动从那里继续。
- 纵向滚动条跟随纵向滚动视图；`axis="horizontal"` 为横向滚动视图提供滚动条（沿底边放置）。每个方向一个滚动条。
- 列表同样适用：随着行被测量和加入，滑块跟随列表的总长度。

## 何时显示

| `mode` | 显示 |
|---|---|
| `"scrolling"`（默认） | 内容滚动时，以及停止后的 `motion.idle` 内；显示期间指针在滚动条上会让它保持显示。 |
| `"hover"` | 指针在滚动条上时（它显示的位置，隐藏时也算），以及 `"scrolling"` 显示的时候。 |
| `"always"` | 始终。 |

在任何模式下，拖动滑块时它都显示，并在最后一次滚动、拖动或悬停之后保持 `motion.idle`。内容能完整放进视口时，它保持隐藏。隐藏时
滚动条的 `opacity` 为 0，按压穿过它交给下面的视图。

## 动效

`motion` 设置滚动条淡入淡出的时长，动画以原生方式运行，与 `gpui-base` 的 `ScrollbarMotion` 一致：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `idle` | `2000` | 最后一次滚动、拖动或悬停之后滚动条保持显示的时长，单位毫秒。 |
| `enter` | `0` | 出现所用的时长：不透明度线性上升，滑入缓出。 |
| `exit` | `0` | `idle` 结束后淡出所用的时长，缓入；淡出时它滑出自己的轨道。 |
| `entrance` | `"fade"` | 如何进入：`"fade"` 原地淡入，`"slideAndFade"` 从所在的边缘（右侧、底部）滑入。 |
| `thumbHoverEntrance` | `"fade"` | 指针指向隐藏的滑块让它显示时如何进入（`"hover"`）。 |

不设时长时，滚动条直接出现和消失。中途反向的淡入淡出保持原来的速度：只用剩余距离对应的那部分时长。`"always"` 滚动条从不播放动画，
用户希望减少动效时也一样。滑动的部分被轨道裁剪。滑块自身的动效（例如 `hover:` 时变宽）属于它的样式（`thumbClass` 上的
`transition-all`）。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `scroll` | `.scroll(..)` | `YNode` | 无 | 滚动条跟随并滚动的滚动视图或列表（它的 `ref`）。 |
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"vertical"` | 滚动视图的方向：轨道沿它延伸。创建滚动条时读取。 |
| `mode` | `.mode(..)` | `"scrolling" \| "hover" \| "always"` | `"scrolling"` | 滚动条何时显示。 |
| `motion` | `.motion(..)` | `ScrollbarMotion` | 无动画，`idle` 为 `2000` | 如何显示和隐藏：见[动效](#动效)。 |
| `minThumbLength` | `.min_thumb_length(..)` | `number` | `48` | 内容很长时滑块的最短长度，让它保持容易抓取。 |
| `thumbClass`、`thumbStyle` | `.thumb_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 滑块。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对滚动条读出的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 滚动条本身：它的轨道，放在应用指定的位置。 |

## 部件

| 部件 | 位于 | 样式 |
|---|---|---|
| 轨道 | 应用放置的位置 | `class`、`style` |
| 滑块 | 轨道的内容区 | `thumbClass`、`thumbStyle` |

滚动条沿方向设置滑块的长度并移动它；滑块的粗细和它在轨道横向上的位置由应用决定（轨道上的 `w-1.5` 和 `items-end` 让 6 点宽的滑块靠
右）。轨道的内边距让滑块与两端和两侧保持距离。

部件呈现的状态：

- 轨道：指针下方时 `hover:`；它是一个 `group`，所以滑块可以从它获得 `group-hover:`（指针靠近时变宽的滑块）。
- 滑块：指针下方时 `hover:`，拖动时 `active:`。

滚动条的可见性就是它的不透明度：颜色的透明度请放在轨道背景或滑块上。变宽的滑块用 `transition-all`（它不会拖慢滑块的位置，位置由滚动条
在滑块样式之外设置），`motion-reduce:` 为希望减少动效的人保持静止。

## 无障碍

- 屏幕阅读器滚动的仍是滚动视图：它们用自己的手势移动它并读出其中的内容。
- 滚动条由 `accessibilityLabel` 命名，供能到达它的屏幕阅读器读出。

标签、角色和操作的一般说明见[无障碍](../docs/accessibility.md)。

## 平台说明

- 每个平台都绘制应用设置的样式，滑块跟随各平台为滚动视图报告的偏移。拖动滑块和按压轨道支持鼠标、触控笔和手指。
- `"hover"` 跟随鼠标或触控板的指针（桌面平台和 Web）；在触摸屏上，滚动条在内容滚动时显示，隐藏的轨道让触摸穿过。

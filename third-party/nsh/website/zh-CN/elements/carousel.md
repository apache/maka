---
title: Carousel
description: Carousel 及其部件：一次显示一个位置的幻灯片，可通过平台原生滚动的滑动、滚轮和触控板，以及上一张 / 下一张控件、分页和键盘来切换，在两端无缝循环。轮播负责显示哪张幻灯片、吸附、循环、按键和无障碍；外观和所有文字都属于应用。
group: base
demo: el-carousel
---

# Carousel

轮播一次在一个位置显示一张幻灯片：商品的照片、引导流程的步骤、自动切换的横幅、一排卡片。`Carousel` 负责行为：显示哪张幻灯片、在幻灯片之间滑动、上一张和下一张控件、分页、方向键、在两端循环，以及屏幕阅读器听到的内容。它的部件通过上下文找到它，因此应用可以在自己的布局里自由安排它们。外观由应用决定：它没有自己的颜色、尺寸、箭头、圆点或文字。

内容是一个原生滚动视图。手指、滚轮和触控板在平台的主线程上移动幻灯片，与指针在同一帧；松手时内容吸附到最近的幻灯片，每次快速滑动只移动一张。内容停下时，轮播用 `onChange` 报告这张幻灯片。控件、分页、按键和应用的 `index` 以原生动画把内容滚动到对应幻灯片。

```rust tabs
use nsh_base::{
    carousel, carousel_content, carousel_item, carousel_next, carousel_pagination,
    carousel_pagination_item, carousel_previous, theme,
};
use nsh_core::prelude::*;

fn photos() -> impl IntoElement {
    let index = signal(0u32);
    let names = ["Harbor", "Dunes", "Glacier"];
    carousel()
        .index(move || Some(index.get()))
        .on_change(move |i: &u32| index.set(*i))
        .accessibility_label("Photos")
        .gap_3()
        .child(
            carousel_content().w_full().h(px(180.0)).gap_3().child(
                names
                    .iter()
                    .enumerate()
                    .map(|(i, name)| {
                        carousel_item()
                            .accessibility_label(format!("{} of 3: {name}", i + 1))
                            .w_full()
                            .rounded(move || theme().radius)
                            .bg(move || theme().muted)
                            .items_center()
                            .justify_center()
                            .child(text(*name))
                    })
                    .collect::<Vec<_>>(),
            ),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(carousel_previous().accessibility_label("Previous photo").child(text("‹")))
                .child(
                    carousel_pagination()
                        .flex_row()
                        .gap_1()
                        .child(
                            (0..3)
                                .map(|i| {
                                    carousel_pagination_item()
                                        .index(i)
                                        .accessibility_label(format!("Photo {}", i + 1))
                                        .size_2()
                                        .rounded_full()
                                        .bg(move || theme().border)
                                        .selected_style(|s| s.bg(move || theme().primary))
                                })
                                .collect::<Vec<_>>(),
                        ),
                )
                .child(carousel_next().accessibility_label("Next photo").child(text("›"))),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPagination,
  CarouselPaginationItem,
  CarouselPrevious,
} from "nsh/base";

const NAMES = ["Harbor", "Dunes", "Glacier"];

function App() {
  const index = signal(0);
  return (
    <Carousel index={index()} onChange={({ index: next }) => index.set(next)} accessibilityLabel="Photos" class="gap-3">
      <CarouselContent class="h-[180px] w-full gap-3">
        {NAMES.map((name, i) => (
          <CarouselItem
            accessibilityLabel={`${i + 1} of ${NAMES.length}: ${name}`}
            class="w-full items-center justify-center rounded-(--radius) bg-muted"
          >
            <Text>{name}</Text>
          </CarouselItem>
        ))}
      </CarouselContent>
      <View class="flex-row items-center gap-2">
        <CarouselPrevious accessibilityLabel="Previous photo" class="disabled:opacity-40">
          <Text>‹</Text>
        </CarouselPrevious>
        <CarouselPagination class="flex-row gap-1">
          {NAMES.map((_, i) => (
            <CarouselPaginationItem
              index={i}
              accessibilityLabel={`Photo ${i + 1}`}
              class="size-2 rounded-full bg-border selected:bg-primary"
            />
          ))}
        </CarouselPagination>
        <CarouselNext accessibilityLabel="Next photo" class="disabled:opacity-40">
          <Text>›</Text>
        </CarouselNext>
      </View>
    </Carousel>
  );
}

mount(App);
```


`Carousel` 及其部件来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。显示的幻灯片是应用的 `index`：滑动、控件或按键用 `onChange` 报告下一张，轮播滚动到应用传回的 `index`。滑动停下的那张一直显示到应用回应它的 `onChange` 为止：应用把它作为 `index` 传回时它保持显示；应用保留原来的 `index` 时，内容以动画弹回应用的那张。没有 `index` 时，轮播从 `defaultIndex` 开始自己保存。在 Rust 中，`carousel()`、`carousel_content()`、`carousel_item()`、`carousel_previous()`、`carousel_next()`、`carousel_pagination()` 和 `carousel_pagination_item()` 创建这些部件，每个 prop 有一个 setter（`.index(..)`），每个事件有一个监听方法（`.on_change(..)`），另有类型化的样式方法，内容用 `.child(..)`。

## Props

### Carousel

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `index` | `.index(..)` | `number` | 无 | 显示的幻灯片，从 0 开始，限制在已有幻灯片范围内。由应用持有：变化通过 `onChange` 报告，新的 `index` 以动画滚动过去。 |
| `defaultIndex` | `.default_index(..)` | `number` | `0` | 未设置 `index` 时最初显示的幻灯片。 |
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | 幻灯片排列的方向；在轮播创建时读取。纵向轮播的方向键是上和下。 |
| `looping` | `.looping(..)` | `boolean` | `false` | 幻灯片首尾相接：最后一张之后是第一张，第一张之前是最后一张，无论滑动、上一张、下一张、按键还是应用的 `index` 都无缝衔接（见[循环](#循环)）。在轮播创建时读取。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对轮播（一个区域）的称呼：它的幻灯片是什么（`"精选商品"`）。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | `CarouselContent`、控件，以及应用在它们周围布置的其他内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 轮播的布局：内容和控件的位置。 |

### CarouselContent

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | 无 | 各个 `CarouselItem`，每个都是内容的子元素。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 视口的尺寸，以及幻灯片在其中排成的轨道：它们之间的 `gap`，露出相邻幻灯片的内边距。 |

### CarouselItem

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对幻灯片（一个分组）的称呼：它在其中的位置和显示的内容（`"第 2 张，共 5 张：海景"`）。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 幻灯片的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 它沿轴的尺寸（每屏一张用 `w-full`，三张用 `basis-1/3`）和外观。。循环的轮播里，它的位移由轮播决定：`transform` 请放在它里面的视图上。 |

### CarouselPrevious、CarouselNext

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 控件的名称，当子元素没有说明它的文字时（一个箭头图标）。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 应用的图标或文字。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 它的外观和位置：在内容旁边，或用 `absolute` 盖在内容边缘。 |
| `activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle` | `.active(\|s\| ..)`、`.hover(..)`、`.focus(..)`、`.disabled_style(..)` | `StyleProp<ViewStyle>` | 无 | 按下、悬停、聚焦或在两端禁用时的样式，同 `<state>:` 类。 |

### CarouselPagination

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对这组分页项的称呼（`"选择幻灯片"`）。 |
| `indicatorClass` | `.indicator_class(..)` | `string` | 无 | 指示器的 Tailwind 类：一个位于当前幻灯片分页项上的视图（圆点后的胶囊、下划线），它的外观以及在行中横向的位置（`inset-y-0`、`bottom-0 h-0.5`）。沿着行它覆盖该分页项，并以原生弹簧动画移到下一个。 |
| `indicatorStyle` | `.indicator_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | 指示器的样式，覆盖在 `indicatorClass` 之上。两者都没有时，分页没有指示器。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 各个 `CarouselPaginationItem`，以及应用在它们之间布置的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 这一行的布局（`flex-row gap-2`）。 |

### CarouselPaginationItem

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `index` | `.index(..)` | `number` | 必填 | 它对应的幻灯片，从 0 开始。超过最后一张的索引被禁用。 |
| `selectedStyle` | `.selected_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | 它的幻灯片显示时的样式，同 `selected:` 类。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 它对应哪张幻灯片（`"第 3 张"`），当子元素没有说明它的文字时（一个圆点）。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 应用的圆点、缩略图或数字。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 它的外观；在 `group` 下，其中的 `group-selected:` 类跟随它。 |

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange`（`Carousel`） | `.on_change(\|index: &u32\| ..)` | 用户切换到了另一张幻灯片：滑动、滚轮或触控板停在它上面，或者控件、分页项或按键请求了它。`{ index }` 就是这张幻灯片。应用设置新的 `index` 不会报告。 |
| `onDragStart`（`Carousel`） | `.on_drag_start(\|\| ..)` | 用户开始拖动内容（手指、触控板）。 |
| `onDragEnd`（`Carousel`） | `.on_drag_end(\|\| ..)` | 用户拖动的内容停下了。 |
| `onFocus`（`Carousel`） | `.on_focus(\|\| ..)` | 键盘焦点进入了轮播：来到轮播自身的视图、上一张或下一张控件、某个分页项，或幻灯片里可聚焦的视图。在它们之间移动不会报告。 |
| `onBlur`（`Carousel`） | `.on_blur(\|\| ..)` | 键盘焦点离开了轮播：轮播自身的视图、它的控件、分页项和幻灯片的内容。 |

## 部件

| 部件 | 位于 | 样式来自 | 状态 |
|---|---|---|---|
| 轮播 | | `Carousel` 的 `class`、`style` | `focus:` |
| 内容 | 轮播 | `CarouselContent` 的 `class`、`style` | |
| 幻灯片 | 内容 | `CarouselItem` 的 `class`、`style` | |
| 上一张、下一张 | 轮播 | 它们的 `class`、`style` | `disabled:`、`active:`、`hover:`、`focus:` |
| 分页 | 轮播 | `CarouselPagination` 的 `class`、`style` | |
| 指示器 | 分页 | `indicatorClass`、`indicatorStyle` | |
| 分页项 | 分页 | 它的 `class`、`style` | `selected:`、`disabled:`、`active:`、`hover:`、`focus:` |

## 每屏多张幻灯片

幻灯片的宽度由它自己的类决定，因此一排卡片就是视口里的多张幻灯片。每张幻灯片的起点是一个吸附点：内容停下时，这张幻灯片位于第一张所在的位置，所以第一张前的内边距会保留在每一张前面。在滚动范围的末尾，无法到达该位置的幻灯片与最后一张停在一起，下一张也停在那里。`index` 指位于第一个位置的幻灯片；与最后一张停在一起的几张显示同一个位置，滑动到那里时报告其中的第一张：

```tsx
<Carousel accessibilityLabel="合集">
  <CarouselContent class="w-full gap-4 px-4">
    <Each of={collections()}>
      {(c) => (
        <CarouselItem class="basis-1/3">
          <Card collection={c()} />
        </CarouselItem>
      )}
    </Each>
  </CarouselContent>
</Carousel>
```

在手机宽度下用 `basis-1/2` 或 `basis-[85%]` 可以露出下一张卡片的一部分。纵向轮播（`axis="vertical"`）按高度确定幻灯片的尺寸。

## 循环

开启 `looping` 后，幻灯片无缝地首尾相接：最后一张之后是第一张，无论是滑动、按下一张或按键，还是应用设置的 `index`，中间都不会倒回经过其余幻灯片。内容在幻灯片前后各留出一整圈幻灯片的空间，并把每张幻灯片画在离视图中央最近的位置；动画在平台自己的帧上随滚动计算。每张幻灯片只有一份：屏幕阅读器和分页都只看到一次。

当幻灯片的总长度不小于视口再加一张幻灯片时（三张满宽，或五张三分之一宽），循环是无缝的。少于这个长度时，上一张、下一张和按键仍会在两端循环，但会滚动经过其余幻灯片。

## 自动切换的幻灯片

自动切换的横幅由应用实现：用一个计时器设置 `index`。轮播会报告用户何时在操作它，计时器在这些时候暂停，符合 [WAI-ARIA 轮播模式](https://www.w3.org/WAI/ARIA/apg/patterns/carousel/) 的要求：拖动前后的 `onDragStart` / `onDragEnd`，键盘焦点在轮播里（轮播本身、它的控件、分页或幻灯片的内容）时的 `onFocus` / `onBlur`，以及包在外面的视图上的指针进出。减少动态效果时请关闭它，并提供一个停止它的按钮（轮换控件）：

```tsx
import { cleanup, effect, reduceMotion, signal, Text, View } from "nsh";
import { Button, Carousel, CarouselContent } from "nsh/base";

const index = signal(0);
const playing = signal(true);
const held = signal(0);
const hold = (on: boolean) => held.set(held() + (on ? 1 : -1));

effect(() => {
  index();
  if (!playing() || held() > 0 || reduceMotion()) return;
  const timer = setInterval(() => index.set((index() + 1) % SLIDES.length), 4000);
  cleanup(() => clearInterval(timer));
});

<View onMouseEnter={() => hold(true)} onMouseLeave={() => hold(false)}>
  <Carousel
    looping
    index={index()}
    onChange={({ index: next }) => index.set(next)}
    onDragStart={() => hold(true)}
    onDragEnd={() => hold(false)}
    onFocus={() => hold(true)}
    onBlur={() => hold(false)}
    accessibilityLabel="精彩内容"
  >
    <CarouselContent class="w-full">{/* 幻灯片 */}</CarouselContent>
    <Button onPress={() => playing.set(!playing())} class="self-start px-3 py-1">
      <Text>{playing() ? "暂停播放" : "开始播放"}</Text>
    </Button>
  </Carousel>
</View>
```

在 effect 里读取 `index()`，每次变化（包括用户的切换）后都会重新开始一整个间隔。开启 `looping` 时，从最后一张到第一张会向前跨过接缝。

## 无障碍

- 轮播是由 `accessibilityLabel` 命名的区域；每张幻灯片是由它自己的标签命名的分组（它在其中的位置和显示的内容）。
- 上一张和下一张是按钮，除非循环，否则在两端禁用；每个分页项是一个按钮，它的幻灯片显示时为选中状态。
- 所有文字都来自应用，使用应用的语言。
- 循环轮播中的每张幻灯片只有一份，无论画在哪里。

无障碍标签、角色和播报的一般说明见[无障碍](../docs/accessibility.md)。

## 键盘

在 macOS 和 Web 上，Tab 会到达接受按压的视图，轮播是键盘焦点的一站，它的控件和分页项也是。当其中之一持有焦点时：

| 按键 | 作用 |
|---|---|
| 左、右（纵向时为上、下） | 移到上一张或下一张，循环时越过两端。 |
| Home、End | 移到第一张或最后一张。 |
| 空格、回车 | 按下有焦点的控件或分页项。 |

在从右到左的布局里，横向轮播的幻灯片从右边开始，左键移到下一张，右键移到上一张；纵向轮播仍用上、下键。持有焦点的控件变为禁用时（最后一张上的下一张），焦点交给轮播，按键在那里继续生效。幻灯片里应用自己的可聚焦视图保留它们自己的按键：输入框的方向键移动光标。

## 动效

- 滑动、滚轮和触控板让幻灯片在同一帧跟随指针移动：由平台滚动它们。
- 松手时内容滑行到最近的幻灯片，每次快速滑动一张，与平台的吸附一致。
- 上一张、下一张、分页项、按键和应用的 `index` 以动画把内容滚动到对应幻灯片；减少动态效果时立即到位。
- 分页的指示器以弹簧动画移到当前幻灯片的分页项；减少动态效果时立即移动。
- `looping` 从最后一张到第一张时向前走一步，跨过接缝；内容停下后，无动画地移回一整圈，画面没有任何变化。

## 平台说明

- iOS、Android 和 Mac Catalyst：手指滑动幻灯片；轻点按下控件。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：滚轮和触控板滚动幻灯片，点击按下控件。在内容上用鼠标拖动由应用处理，与那里的所有滚动视图一样。
- 每个平台绘制应用设定的样式：幻灯片、控件、分页及其指示器。

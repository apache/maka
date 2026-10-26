---
title: 滚动
description: Rust 和 TSX 中的滚动视图：分页与吸附、缩放、下拉刷新、滚动事件、用 scrollValue 实现滚动联动效果、滚动视图中的键盘，以及从代码滚动。
order: 39
group: ui
demo: guide-scrolling
---

# 滚动

滚动视图（Rust 中的 `scroll()`，TSX 中的 `<Scroll>`）就是平台自己的滚动视图（iOS 上的 UIScrollView，Android 上的 ScrollView）：惯性滑动、回弹、滚动条、下拉刷新以及吸附都是原生实现。你的代码通过事件得知滚动情况，也可以把滚动偏移绑定到[动画值](./animation.md#动画值)上，做出逐帧跟随手指的效果。

滚动视图适合尺寸已知、规模适中的内容：设置页、表单、文章、一排标签。长列表或无限数据请用[列表](./lists.md)，它会复用行，并接受同样的滚动属性。

## 滚动视图

滚动视图本身是视口，它的子元素是内容。视口需要父元素给出尺寸（通常是 `flex: 1`、`.flex_1()`）；内容按视口的宽度（纵向）或高度（横向）排版，长度按需延伸。

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    scroll().flex_1().bg(rgb(0xf6f8fa)).child(
        view().p_4().gap_3().children((1..=50).map(|n| {
            view().p_4().rounded(px(10.0)).bg(white()).child(text(format!("Row {n}")))
        })),
    )
}
```

```tsx tabs
import { mount, Scroll, Text, View } from "nsh";

function App() {
  return (
    <Scroll style={{ flex: 1, backgroundColor: "#f6f8fa" }}>
      <View style={{ padding: 16, gap: 12 }}>
        <Each of={Array.from({ length: 50 }, (_, i) => i + 1)}>
          {(n) => (
            <View style={{ padding: 16, borderRadius: 10, backgroundColor: "#ffffff" }}>
              <Text>Row {n()}</Text>
            </View>
          )}
        </Each>
      </View>
    </Scroll>
  );
}

mount(App);
```

上面的子视图就是滚动视图的内容容器；在 TSX 中，`contentStyle`（或 `contentClass`）会替你创建一个，把子元素包进一个带该样式、随内容一起滚动的视图。`flexGrow: 1`（`.flex_grow(1.0)`）让内容至少和视口一样高，内容较短时可以居中，较长时照常滚动：

```rust tabs
scroll().flex_1().child(
    view().flex_grow(1.0).justify_center().p_4().child(
        when(move || messages.with(|m| !m.is_empty()), move || {
            each(messages, |m| m.id, |m, _| text(move || m.with(|m| m.text.clone())))
        })
        .otherwise(|| text("No messages yet")),
    ),
)
```

```tsx tabs
<Scroll style={{ flex: 1 }} contentStyle={{ flexGrow: 1, justifyContent: "center", padding: 16 }}>
  <If when={messages().length > 0} else={<Text>No messages yet</Text>}>
    <Each of={messages()}>{(m) => <Text>{m().text}</Text>}</Each>
  </If>
</Scroll>
```

横向滚动视图使用 `horizontal`（`.horizontal()`），并以一个横排视图作为子元素：

```rust tabs
scroll().horizontal().scrollbar(false).child(
    view().flex_row().gap_2().px_4().children(["Today", "This week", "This month", "This year"].map(|label| {
        text(label).px(px(14.0)).py_2().rounded(px(16.0)).overflow_hidden().bg(white())
    })),
)
```

```tsx tabs
<Scroll horizontal scrollbar={false}>
  <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16 }}>
    <Each of={["Today", "This week", "This month", "This year"]}>
      {(label) => <Text style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, overflow: "hidden", backgroundColor: "#ffffff" }}>{label()}</Text>}
    </Each>
  </View>
</Scroll>
```

在从右到左布局中（见[设备与环境](./device-and-environment.md#从右到左)），横向滚动视图从最右端开始，并保持与右端的距离。

手指拖动滚动视图。在桌面（macOS、Windows、Linux）和浏览器中，鼠标像在桌面应用中一样滚动：用滚轮（Shift + 滚轮横向滚动）、触控板、键盘和滚动指示条（鼠标在视图上移动时显示，可以像滚动条一样拖动）；鼠标拖动交给应用的拖拽手势、响应者和文字选择。桌面上的触摸屏像手指一样拖动滚动视图。即使设置了 `scrollbar={false}`，横向视图在这些平台上也保留指示条，因为没有横向滚轮的鼠标要靠它来移动视图。

### 行为属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `horizontal` | `.horizontal()` | `boolean` | `false` | 横向滚动。 |
| `scrollable` | `.scrollable(..)` | `boolean` | `true` | 用户可以滚动。从代码滚动不受影响。 |
| `bounces` | `.bounces(..)` | `boolean` | `true` | 允许越过边缘回弹。 |
| `scrollbar` | `.scrollbar(..)` | `boolean` | `true` | 显示滚动条。在桌面和桌面浏览器中，横向视图始终保留滚动条：它是鼠标的滚动条。 |
| `contentInset` | `.content_inset(EdgeInsets { .. })` | `Partial<Edges>` | | 内容四周可以滚动进入的留白。 |
| `contentOffset` | `.content_offset(point(..))` | `{ x?, y? }` | | 初始位置。 |
| `decelerationRate` | `.deceleration(rate)` | `"normal" \| "fast" \| number` | 平台默认 | 惯性滑动减速的快慢：`"normal"`、`"fast"`，或每毫秒保留的速度比例（`0.998` 为 normal，`0.99` 为 fast；`0` 表示平台默认）。 |

## 分页与吸附

吸附在手指抬起时由原生决定，依据松手位置、预计滑行距离和速度；随后滚动视图滑到选中的停靠点，整个过程不涉及你的代码。

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `pagingEnabled` | `.paging(true)` | `boolean` | 停在视口尺寸的整数倍处。 |
| `snapToInterval` | `.snap_interval(px(..))` | `number` | 停在该长度的整数倍处（0 为关闭）。 |
| `snapToOffsets` | `.snap_offsets(vec![..])` | `number[]` | 停在这些偏移处。 |
| `snapToAlignment` | `.snap_alignment(SnapAlignment::Center)` | `"start" \| "center" \| "end"` | 配合 `snapToInterval`：条目的哪个位置与视口对齐。 |
| `disableIntervalMomentum` | `.disable_interval_momentum(true)` | `boolean` | 一次快速滑动最多移动一个停靠点。 |

一个分页器：每页与滚动视图等宽，滑行结束时更新页码指示器。

```rust tabs
const COLORS: [u32; 4] = [0x0969da, 0x8250df, 0xbf3989, 0x1a7f37];

pub fn pager() -> impl IntoElement {
    let width = signal(0.0_f32);
    let page = signal(0_usize);
    let settle = move |e: &Point<Points>| {
        let width = width.get_untracked();
        if width > 0.0 {
            page.set((e.x.0 / width).round() as usize);
        }
    };
    let pages = COLORS.iter().enumerate().map(|(i, &color)| {
        view()
            .w(move || px(width.get()))
            .h(px(160.0))
            .bg(rgb(color))
            .items_center()
            .justify_center()
            .child(text(format!("Page {}", i + 1)).text_color(white()).text_2xl().font_weight(FontWeight::BOLD))
    });
    let dots = (0..COLORS.len()).map(|i| {
        view()
            .size_2()
            .rounded(px(4.0))
            .bg(move || if page.get() == i { rgb(0x0969da) } else { rgb(0xd0d7de) })
    });
    view()
        .gap_2()
        .p_4()
        .child(
            scroll()
                .horizontal()
                .paging(true)
                .scrollbar(false)
                .h(px(160.0))
                .rounded(px(12.0))
                .on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
                .on_scroll_end(settle)
                .child(view().flex_row().children(pages)),
        )
        .child(view().flex_row().justify_center().gap(px(6.0)).children(dots))
}
```

```tsx tabs
import { mount, Scroll, signal, Text, View } from "nsh";

const colors = ["#0969da", "#8250df", "#bf3989", "#1a7f37"];

function Pager() {
  const width = signal(0);
  const page = signal(0);
  const settle = (e: { x: number }) => page.set(Math.round(e.x / width()));
  return (
    <View style={{ gap: 8, padding: 16 }}>
      <Scroll
        horizontal
        pagingEnabled
        scrollbar={false}
        style={{ height: 160, borderRadius: 12 }}
        onLayout={(e) => width.set(e.size.width)}
        onScrollEnd={settle}
      >
        <View style={{ flexDirection: "row" }}>
          <Each of={colors}>
            {(color, i) => (
              <View style={{ width: width(), height: 160, backgroundColor: color(), alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: "#ffffff", fontSize: 24, fontWeight: "700" }}>Page {i() + 1}</Text>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 6 }}>
        <Each of={colors}>
          {(_, i) => <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: page() === i() ? "#0969da" : "#d0d7de" }} />}
        </Each>
      </View>
    </View>
  );
}

mount(Pager);
```

吸附到中间、每次滑动只移动一张的卡片轮播：

```rust tabs
scroll()
    .horizontal()
    .snap_interval(px(232.0))          // 卡片宽度 (220) + 间距 (12)
    .snap_alignment(SnapAlignment::Center)
    .deceleration(0.99)
    .disable_interval_momentum(true)
    .scrollbar(false)
    .child(view().flex_row().gap_3().px_4().children(cards))
```

```tsx tabs
<Scroll
  horizontal
  snapToInterval={232}          // 卡片宽度 (220) + 间距 (12)
  snapToAlignment="center"
  decelerationRate="fast"
  disableIntervalMomentum
  scrollbar={false}
>
  <View style={{ flexDirection: "row", gap: 12, paddingHorizontal: 16 }}>…</View>
</Scroll>
```

列表接受同样的吸附属性，长轮播用它更合适。

## 滚动事件

| 属性 | Rust | 参数 | 触发时机 |
|---|---|---|---|
| `onScroll` | `.on_scroll(..)` | `ScrollEvent` | 偏移改变。每帧最多一次；`scrollEventThrottle` 可以进一步拉开间隔。 |
| `scrollEventThrottle` | `.event_throttle(ms)` | `number` | 两次 `onScroll` 之间的最少毫秒数。 |
| `onScrollDragStart` | `.on_scroll_drag_start(..)` | `{ x, y }` | 用户开始拖动。 |
| `onScrollDragEnd` | `.on_scroll_drag_end(..)` | `{ x, y }` | 用户抬起手指。 |
| `onMomentumStart` | `.on_momentum_start(..)` | `{ x, y }` | 快速滑动后的惯性滑行开始。 |
| `onMomentumEnd` | `.on_momentum_end(..)` | `{ x, y }` | 惯性滑行结束（被新的拖动打断时也会触发）。 |
| `onScrollEnd` | `.on_scroll_end(..)` | `{ x, y }` | 用户的滚动停了下来：惯性滑行结束后，或没有惯性的拖动结束时。 |

`ScrollEvent` 包含偏移（`offset`，一个 `Point`；Rust 中同名）、内容尺寸，含缩放（`contentSize`，一个 `Size`；`content_size`）、视口（`size`）以及 `zoomScale`（`zoom_scale`）。其他事件携带偏移（Rust 中为 `Point<Points>`）。

```rust tabs
let at_bottom = signal(false);

scroll()
    .flex_1()
    .event_throttle(100.0)
    .on_scroll(move |e: &ScrollEvent| {
        at_bottom.set(e.offset.y + e.size.height >= e.content_size.height - px(20.0))
    })
    .child(content)
```

```tsx tabs
const atBottom = signal(false);

<Scroll
  style={{ flex: 1 }}
  scrollEventThrottle={100}
  onScroll={(e) => atBottom.set(e.offset.y + e.size.height >= e.contentSize.height - 20)}
>
  …
</Scroll>
```

> [!TIP]
> `onScroll` 会在滚动的每一帧运行你的代码（受节流限制）。如果只是*看起来*要跟随滚动，比如渐隐的标题栏或视差图片，请改用 [`scrollValue`](#滚动联动效果scrollvalue)：它完全在原生侧运行。

## 滚动联动效果：scrollValue

`scrollValue`（`.scroll_value(&value)`）接收一个[动画值](./animation.md#动画值)，并在内容移动的同一帧，由原生把（主轴方向的）滚动偏移写进去。把这个值，或由它经 `interpolate`、`diffClamp`（`diff_clamp`）、算术运算得到的节点，绑定到样式上。

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    let offset = animated_value(0.0);
    view()
        .flex_1()
        .child(
            view()
                .h(px(56.0))
                .justify_center()
                .px_4()
                // 顶部透明，滚过 80 点后变为白色。
                .bind_background(&offset.interpolate_colors(&[0.0, 80.0], &[rgba(0xffffff00), rgba(0xffffffff)]))
                .child(
                    text("Inbox")
                        .text_size(px(22.0))
                        .font_weight(FontWeight::BOLD)
                        .origin_left()
                        .bind_scale(&offset.interpolate(&[0.0, 80.0], &[1.0, 0.8])),
                ),
        )
        .child(scroll().flex_1().scroll_value(&offset).child(view().p_4().gap_2()))
}
```

```tsx tabs
import { mount, Scroll, Text, View } from "nsh";
import { createAnimatedValue } from "nsh";

function App() {
  const offset = createAnimatedValue(0);
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          height: 56,
          justifyContent: "center",
          paddingHorizontal: 16,
          // 顶部透明，滚过 80 点后变为白色。
          backgroundColor: offset.interpolate({ inputRange: [0, 80], outputRange: ["rgba(255,255,255,0)", "#ffffff"] }),
        }}
      >
        <Text
          style={{
            fontSize: 22,
            fontWeight: "700",
            transformOrigin: "left center",
            transform: [{ scale: offset.interpolate({ inputRange: [0, 80], outputRange: [1, 0.8] }) }],
          }}
        >
          Inbox
        </Text>
      </View>
      <Scroll style={{ flex: 1 }} scrollValue={offset}>
        <View style={{ padding: 16, gap: 8 }}>…</View>
      </Scroll>
    </View>
  );
}

mount(App);
```

内容上滑时隐藏、一往下滑就重新出现的标题栏，就是对偏移做 `diffClamp`：

```rust tabs
let offset = animated_value(0.0);
let header = offset.diff_clamp(0.0, 56.0);

view()
    .flex_1()
    .child(scroll().flex_1().scroll_value(&offset).child(view().pt(px(56.0))))
    .child(view().absolute().top_0().left_0().right_0().h(px(56.0)).bind_translate_y(&header.mul(-1.0)))
```

```tsx tabs
const offset = createAnimatedValue(0);
const header = offset.diffClamp(0, 56);

<View style={{ flex: 1 }}>
  <Scroll style={{ flex: 1 }} scrollValue={offset}>
    <View style={{ paddingTop: 56 }}>…</View>
  </Scroll>
  <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 56, transform: [{ translateY: header.mul(-1) }] }}>…</View>
</View>
```

插值在输入范围之外默认会截断（clamp），所以下拉越过顶部（偏移为负）时效果停在终点；想做随下拉放大的弹性头图，传入 `extrapolate: "extend"`（Rust 中为 `interpolate_with(.., Interpolation::extrapolate(Extrapolate::Extend))`）。

## 下拉刷新

`refreshing` 和 `onRefresh`（`.refreshing(..)` 和 `.on_refresh(..)`）会加上平台的下拉刷新控件。`refreshing` 为 true 时控件显示；在 `onRefresh` 中把它设为 true，工作完成后再清除。

```rust tabs
let refreshing = signal(false);
let reload = move || {
    refreshing.set(true);
    spawn(async move {
        if let Ok(response) = fetch("https://api.example.com/items").await {
            items.set(parse_items(&response.text()));
        }
        refreshing.set(false);
    });
};

scroll().flex_1().refreshing(refreshing).on_refresh(reload).child(content)
```

```tsx tabs
const refreshing = signal(false);
const reload = async () => {
  refreshing.set(true);
  try {
    items.set(await (await fetch("https://api.example.com/items")).json());
  } finally {
    refreshing.set(false);
  }
};

<Scroll style={{ flex: 1 }} refreshing={refreshing()} onRefresh={reload}>…</Scroll>
```

iOS 上的控件是 UIRefreshControl；在 Mac Catalyst 的 Mac 界面风格中，NSH 显示自己的加载指示器，行为相同。列表也接受这些属性。由于鼠标滚动时不拖动，在桌面和浏览器中下拉是触摸屏（或 macOS 的触控板，它能拉过顶部）的手势；请在这些地方另外提供刷新方式，比如按钮或键盘快捷键。

### 自己的指示器

下拉的样子由应用决定。`refreshIndicator={{ height }}` 表示应用自己绘制指示器，高 `height` 点：平台的转圈隐藏，下拉到 `height` 即刷新，刷新中在内容上方为指示器留出 `height`。`pullValue` 把内容被拉过顶部的距离写进一个动画值：静止时为 0，随下拉增大，刷新中为 `height`。把指示器画在滚动视图顶部之上，用这个值插值出它的样式：样式在 UI 线程上跟随手指，每帧不经过 JS。

```rust tabs
let pull = animated_value(0.0);

view()
    .flex_1()
    .child(
        scroll()
            .flex_1()
            .refreshing(refreshing)
            .on_refresh(reload)
            .pull_value(&pull)
            .refresh_indicator(Some(px(72.0)))
            .child(content),
    )
    .child(
        view()
            .pointer_events(PointerEvents::None)
            .absolute()
            .top_0()
            .left_0()
            .right_0()
            .h(px(72.0))
            .items_center()
            .justify_center()
            .bind_opacity(&pull.interpolate(&[0.0, 36.0], &[0.0, 1.0]))
            .bind_rotate(&pull.interpolate(&[36.0, 72.0], &[0.0, 180.0]))
            .child(arrow()),
    )
```

```tsx tabs
const pull = createAnimatedValue(0);

<View style={{ flex: 1 }}>
  <Scroll
    style={{ flex: 1 }}
    refreshing={refreshing()}
    onRefresh={reload}
    pullValue={pull}
    refreshIndicator={{ height: 72 }}
  >
    …
  </Scroll>
  <View
    pointerEvents="none"
    style={{
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      height: 72,
      alignItems: "center",
      justifyContent: "center",
      opacity: pull.interpolate({ inputRange: [0, 36], outputRange: [0, 1] }),
      transform: [{ rotate: pull.interpolate({ inputRange: [36, 72], outputRange: ["0deg", "180deg"] }) }],
    }}
  >
    <Arrow />
  </View>
</View>;
```

`height` 应不超过视口的一半：拉过顶部后，越往下拉阻力越大，太高就永远拉不到。在 iOS 上，应用自己的指示器会取代 UIRefreshControl，改由 NSH 自己检测下拉，和 Mac 界面风格一样。

## 缩放

当最大缩放比例大于最小缩放比例时，滚动视图（列表保持 1 倍缩放）就可以缩放：捏合会缩放内容，放大后可以双向滚动。

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `minimumZoomScale` | `.zoom_range(min, max)` | `number` | `1` | 最小缩放。 |
| `maximumZoomScale` | `.zoom_range(min, max)` | `number` | `1` | 最大缩放；大于最小值时捏合即可缩放。 |
| `zoomScale` | `.zoom(scale)` | `number` | | 该属性改变时缩放到这个比例；否则保留用户的缩放。 |
| `bouncesZoom` | `.bounces_zoom(..)` | `boolean` | `true` | 捏合可以越过限制并弹回。 |
| `zoomable` | `.zoomable(..)` | `boolean` | `true` | 用户可以捏合缩放。 |
| `centerContent` | `.center_content(..)` | `boolean` | `false` | 比视口小的内容（缩小时）居中显示。 |

滚动事件会报告缩放比例和缩放后的内容尺寸。在代码中，`zoom_to(scale, center, animated)` / `zoomTo({ scale, x, y, animated })` 会缩放，使内容中的点（未缩放的点坐标）落在视口中央；双击放大就是在按压处理函数里调用它：

```rust tabs
pub fn photo() -> impl IntoElement {
    let photo = element_ref();
    let scale = signal(1.0_f32);
    scroll()
        .flex_1()
        .bg(black())
        .zoom_range(1.0, 4.0)
        .center_content(true)
        .on_scroll(move |e: &ScrollEvent| scale.set(e.zoom_scale))
        .element_ref(&photo)
        .child(
            image("https://picsum.photos/id/1015/1200/800")
                .w(px(390.0))
                .h(px(260.0))
                .on_press(move || photo.zoom_to(if scale.get_untracked() > 1.5 { 1.0 } else { 3.0 }, None, true)),
        )
}
```

```tsx tabs
import { Image, mount, Scroll, signal, type YNode } from "nsh";

function Photo() {
  let scroll!: YNode;
  const scale = signal(1);
  return (
    <Scroll
      ref={scroll}
      style={{ flex: 1, backgroundColor: "#000000" }}
      minimumZoomScale={1}
      maximumZoomScale={4}
      centerContent
      onScroll={(e) => scale.set(e.zoomScale)}
    >
      <Image
        src="https://picsum.photos/id/1015/1200/800"
        style={{ width: 390, height: 260 }}
        onPress={() => scroll.zoomTo({ scale: scale() > 1.5 ? 1 : 3 })}
      />
    </Scroll>
  );
}

mount(Photo);
```

在 iOS 上，缩放结束后，缩放视图里的文字和画布会按新的分辨率重新绘制，保持清晰。在 Android 上，NSH 使用自己的滚动视图实现缩放：围绕捏合焦点缩放，支持任意手指数平移、惯性滑动，并在边缘和缩放极限处产生橡皮筋效果。与系统的手势检测一致，Android 在两指间距达到约 27 mm 时开始捏合。

## 从代码滚动

给滚动视图设置 ref（Rust 中用 `element_ref()` 和 `.element_ref(&scroller)`，TSX 中用 [`ref`](./jsx-and-components.md)）并调用它的方法。命令会在同一次更新的其他改动之后执行，所以滚动到刚刚添加的内容也没问题。

| Rust | TSX | 说明 |
|---|---|---|
| `scroll_to(point, animated)` | `scrollTo({ x?, y?, animated? })` | 滚动到某个偏移。在 TSX 中默认带动画。 |
| `zoom_to(scale, center, animated)` | `zoomTo({ scale, x?, y?, animated? })` | 可缩放的滚动视图：缩放到 `scale`（限制在范围内），以内容点或中心为基准。 |

```rust tabs
let scroller = element_ref();

scroll().flex_1().element_ref(&scroller).child(content)
view().on_press(move || scroller.scroll_to(point(px(0.0), px(0.0)), true))
```

```tsx tabs
let scroll!: YNode;

<Scroll ref={scroll} style={{ flex: 1 }}>…</Scroll>
<View onPress={() => scroll.scrollTo({ y: 0 })}>…</View>
```

列表另外还有 `scrollToIndex`、`scrollToOffset` 和 `scrollToEnd`；见[列表](./lists.md#从代码滚动)。

## 滚动视图与键盘

NSH 会自动让获得焦点的输入框保持可见：键盘出现时，输入框所在的滚动视图会得到与键盘等高的底部 inset，并把输入框滚动到可见位置。这是原生完成的，应用中不需要任何代码。滚动视图之外的内容（例如固定在底部的消息栏）以 `env(keyboard-inset-height)` 作为底部内边距（见[滚动视图之外的内容](./forms-and-keyboard.md#滚动视图之外的内容)）。

有两个属性决定滚动和点击如何与键盘交互：

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `keyboardDismissMode` | `.keyboard_dismiss_mode(KeyboardDismissMode::OnDrag)` | `"none" \| "on-drag" \| "interactive"` | `"none"` | 拖动内容时是否收起键盘。iOS 上 `"interactive"` 让键盘随手指下移；Android 上它与 `"on-drag"` 相同。 |
| `keyboardShouldPersistTaps` | `.keyboard_taps(KeyboardTaps::Handled)` | `"never" \| "always" \| "handled"` | `"never"` | 键盘弹出时点击的行为。 |

`keyboardShouldPersistTaps`：

- `"never"`：点击输入框之外只会收起键盘，按钮接收下一次点击。用户要先点一次收起键盘，再点一次才能按下。
- `"handled"`：点在会处理它的东西（按钮）上时，点击照常传递，键盘保持；点在空白处则收起键盘。表单通常应选它。
- `"always"`：键盘在每次点击后都保持显示。

两者都在点击或拖动发生时由原生决定，无需等待你的代码。要从代码收起键盘，在 Rust 中调用 `dismiss_keyboard()`，在 TSX 中调用 [`nsh`](../modules/nsh.md#keyboard-and-keyboardframe) 的 `Keyboard.dismiss()`。

## 嵌套滚动视图

纵向滚动视图里放横向滚动视图会如预期工作：各自接管自己方向上的拖动。同方向的两个滚动视图也可以嵌套（内层先滚动）。需要独占手指的响应者，比如滚动视图里的绘图画布，会阻止外层滚动视图接管触摸：Rust 中用 `.keep_touches(true)`，TSX 中在 `onResponderGrant` 中返回 `true`；见[触摸与手势](./touch-and-gestures.md#手势响应者系统)。

## 相关内容

- [`Scroll`](../elements/scroll.md)：元素参考，包含所有属性和事件。
- [列表](./lists.md)：使用相同滚动属性的虚拟化列表。
- [动画](./animation.md)：用于滚动联动效果的动画值、`interpolate` 和 `diffClamp`。
- [表单与键盘](./forms-and-keyboard.md)：输入框、焦点和键盘。

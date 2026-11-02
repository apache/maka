---
title: Scroll
description: 原生滚动视图：纵向和横向滚动、分页与吸附、下拉刷新、缩放以及滚动事件。
order: 40
group: primitives
demo: el-scroll
---

# Scroll

`Scroll` 是原生滚动视图（iOS 和 Mac Catalyst 上是 UIScrollView，Android 上是 ScrollView）。它把所有子元素作为内容进行布局，并在原生侧滚动：滚动、惯性滑动、回弹和吸附都由平台以屏幕刷新率完成。Rust 用 `scroll()` 创建，TSX 用从 `nsh` 导入的 `<Scroll>`。

```rust tabs
use nsh_core::prelude::*;

scroll().flex_1().child(
    view().p_4().gap_2().child(each(
        rows,
        |row: &Row| row.id,
        |row, _index| text(move || row.get().title),
    )),
)
```

```tsx tabs
<Scroll style={{ flex: 1 }}>
  <View style={{ padding: 16, gap: 8 }}>
    <Each of={rows}>{(row) => <Text>{row().title}</Text>}</Each>
  </View>
</Scroll>
```

滚动视图会创建所有子元素，适合中等规模的页面。对于很长或数量不定的数据，请使用[列表](./list.md)：它创建视口附近的行，并复用它们。

滚动视图在滚动方向上需要确定的尺寸：在有尺寸的容器中给它 `flex: 1`（`.flex_1()`）或高度。其内容按滚动视图的宽度（横向时为高度）布局，高度（宽度）按需增长。

## 属性

除[通用属性](./index.md#通用属性)外（`style` 的类型为 `ViewStyle`）。在 Rust 中，滚动相关的属性是 `Scrollable` trait 的方法，列表也共用它们。

### 滚动

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `horizontal` | `.horizontal()` | `boolean` | `false` | 横向滚动。 |
| `scrollable` | `.scrollable(..)` | `boolean` | `true` | 用户可以滚动。 |
| `scrollbar` | `.scrollbar(..)` | `boolean \| ScrollbarTheme` | `true` | 显示滚动条：平台的滚动指示器，或应用设置主题后的[内置滚动条](./scrollbar.md#内置滚动条)；对象是该视图自己的主题。在桌面和桌面浏览器中，横向视图始终保留滚动条：它是鼠标的滚动条。 |
| `bounces` | `.bounces(..)` | `boolean` | `true` | 允许越过边缘回弹。 |
| `pagingEnabled` | `.paging(..)` | `boolean` | `false` | 停在视口尺寸的整数倍处。 |
| `snapToInterval` | `.snap_interval(px(..))` | `number` | `0` | 停在该长度的整数倍处（0 表示关闭）。 |
| `snapToOffsets` | `.snap_offsets(..)` | `number[]` | | 停在这些偏移量处。 |
| `snapToAlignment` | `.snap_alignment(SnapAlignment::Center)` | `"start" \| "center" \| "end"` | `"start"` | 使用 `snapToInterval` 时，条目的哪个位置与视口对齐。 |
| `disableIntervalMomentum` | `.disable_interval_momentum(..)` | `boolean` | `false` | 一次惯性滑动最多移动一个吸附点。 |
| `decelerationRate` | `.deceleration(rate)` | `"normal" \| "fast" \| number` | 平台默认 | 惯性滑动减速的快慢：每毫秒保留的速度比例（`normal` 为 0.998，`fast` 为 0.99）。 |
| `contentInset` | `.content_inset(EdgeInsets { .. })` | `Partial<Edges>` | | 内容四周的留白。 |
| `contentOffset` | `.content_offset(point(..))` | `{ x?, y? }` | | 初始位置。 |
| `contentStyle` | 内容视图自身的样式 | `ViewStyle` | | 包住子元素、随它们一起滚动的视图的样式；`flexGrow: 1` 让它至少和视口一样高（居中的空状态）。 |
| `contentClass` | 内容视图自身的样式 | `string` | | 同上，写成类名，例如 `"grow justify-center p-4"`。 |
| `keyboardDismissMode` | `.keyboard_dismiss_mode(KeyboardDismissMode::OnDrag)` | `"none" \| "on-drag" \| "interactive"` | `"none"` | 拖动时是否收起键盘。 |
| `keyboardShouldPersistTaps` | `.keyboard_taps(KeyboardTaps::Handled)` | `"never" \| "always" \| "handled" \| boolean` | `"never"` | 点击是否收起键盘：`never`（点击只收起键盘）、`always`（键盘保持）、`handled`（点击被某个元素处理时键盘保持）。 |
| `scrollValue` | `.scroll_value(&value)` | `AnimatedValue` | | 接收滚动偏移量（主轴方向）的动画值，用于随滚动变化的动画。 |
| `scrollEventThrottle` | `.event_throttle(ms)` | `number` | | 两次 `onScroll` 事件之间的最小毫秒数（无论如何每帧最多一次）。 |

### 下拉刷新

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `refreshing` | `.refreshing(..)` | `boolean` | 显示刷新指示器。 |
| `onRefresh` | `.on_refresh(..)` | `() => void` | 用户下拉刷新：开始加载，并在结束前保持 `refreshing` 为真。 |
| `refreshIndicator` | `.refresh_indicator(Some(height))` | `{ height: number }` | 应用自己绘制指示器，高 `height` 点：平台的转圈隐藏，下拉到 `height` 即刷新，刷新中在内容上方留出 `height`。`height` 不大于 0 时视为未设。 |
| `pullValue` | `.pull_value(&value)` | `AnimatedValue` | 一个动画值，写入视图被拉过顶部的距离（静止为 0，随下拉增大；刷新中为内容上方留出的空间，设了 `refreshIndicator` 时等于 `height`），用来绘制应用的指示器。 |

```rust tabs
let refreshing = signal(false);

scroll()
    .flex_1()
    .refreshing(refreshing)
    .on_refresh(move || {
        refreshing.set(true);
        spawn(async move {
            load().await;
            refreshing.set(false);
        });
    })
    .child(content())
```

```tsx tabs
const refreshing = signal(false);
async function reload() {
  refreshing.set(true);
  await load();
  refreshing.set(false);
}

<Scroll style={{ flex: 1 }} refreshing={refreshing()} onRefresh={reload}>
  …
</Scroll>;
```

### 缩放

把 `maximumZoomScale` 设得大于 `minimumZoomScale`（Rust 中为 `.zoom_range(min, max)`），内容就可以双指捏合缩放；放大后可以双向滚动。列表保持原有比例。

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `minimumZoomScale` | `.zoom_range(min, max)` | `number` | `1` | 最小缩放比例。 |
| `maximumZoomScale` | `.zoom_range(min, max)` | `number` | `1` | 最大缩放比例。 |
| `zoomScale` | `.zoom(..)` | `number` | | 值变化时缩放到该比例；否则保留用户的缩放。 |
| `bouncesZoom` | `.bounces_zoom(..)` | `boolean` | `true` | 捏合可以超出限制并弹回。 |
| `zoomable` | `.zoomable(..)` | `boolean` | `true` | 用户可以捏合缩放。 |
| `centerContent` | `.center_content(..)` | `boolean` | `false` | 内容（缩小后）小于视口时居中显示。 |

```rust tabs
let photo = element_ref();

scroll()
    .element_ref(&photo)
    .zoom_range(1.0, 4.0)
    .center_content(true)
    .flex_1()
    .bg(black())
    .child(
        image(PICTURE)
            .w(px(390.0))
            .h(px(520.0))
            .on_press(move || photo.zoom_to(1.0, None, true)),
    )
```

```tsx tabs
let photo!: ScrollRef;
<Scroll ref={photo} maximumZoomScale={4} centerContent style={{ flex: 1, backgroundColor: "#000" }}>
  <Image src={picture} style={{ width: 390, height: 520 }} onPress={() => photo.zoomTo({ scale: 1, animated: true })} />
</Scroll>;
```

## 事件

| 事件 | Rust | 载荷 | 触发时机 |
|---|---|---|---|
| `onScroll` | `.on_scroll` | `ScrollEvent` | 偏移量变化（每帧最多一次，且不比 `scrollEventThrottle` 更频繁）。 |
| `onScrollDragStart` / `onScrollDragEnd` | `.on_scroll_drag_start` / `.on_scroll_drag_end` | `{ offset }`（`Point<Points>`） | 用户开始 / 停止拖动。 |
| `onMomentumStart` / `onMomentumEnd` | `.on_momentum_start` / `.on_momentum_end` | `{ offset }` | 拖动后的惯性滑动开始 / 停止。被新一次拖动打断的滑动同样以 `onMomentumEnd` 结束。 |
| `onScrollEnd` | `.on_scroll_end` | `{ offset }` | 滚动停了下来。 |
| `onRefresh` | `.on_refresh` | 无 | 触发了下拉刷新。 |

`ScrollEvent` 为 `{ offset: Point; contentSize: Size; size: Size; zoomScale }`（Rust 中为 `offset`、`content_size`、`size`、`zoom_scale`）：偏移量、（缩放后的）内容尺寸、视口尺寸和缩放比例（不缩放时为 1）。

> [!TIP]
> 要让某个元素随滚动位置移动（收缩的标题栏、视差图片），请把 `scrollValue` 绑定到一个动画值，并在样式中对它插值。它在 UI 线程上以屏幕刷新率运行，而 `onScroll` 是应用代码中每帧一次的事件。参见[动画](../docs/animation.md)。

## ref 方法

| 方法 | Rust | 说明 |
|---|---|---|
| `scrollTo({ x?, y?, animated? })` | `scroll_to(point(x, y), animated)` | 滚动到某个偏移量。 |
| `zoomTo({ scale, x?, y?, animated? })` | `zoom_to(scale, Some(point(x, y)), animated)` | 缩放到 `scale`（限制在上下限内），使内容中的点（`x`、`y`，未缩放时的点坐标）位于视口中央，未给出时围绕中央缩放。例如双击放大被点击的位置。 |

```rust tabs
let scroller = element_ref();
scroll().element_ref(&scroller).child(content());

scroller.scroll_to(point(px(0.0), px(0.0)), true);
```

```tsx tabs
let scroller!: ScrollRef;
<Scroll ref={scroller}>…</Scroll>;
scroller.scrollTo({ y: 0, animated: true });
```

## 键盘

滚动视图中的输入框会在原生侧自动避开键盘：滚动视图获得底部内边距，并自行滚动到获得焦点的输入框。对于滚动视图之外的内容，请在底部内边距或外边距中使用 [`env(keyboard-inset-height)`](./keyboard.md)。参见[表单与键盘](../docs/forms-and-keyboard.md)。

## 从右到左

在从右到左的布局中，横向滚动视图从右端开始，并在内容变化时保持与右端的距离；其子元素会被镜像。

## 平台说明

- Android：下拉刷新由 NSH 自行绘制（越界回弹效果仍是原生的），`contentInset` 以内边距的方式实现，`decelerationRate` 影响吸附时的滑动。
- Android 用 NSH 自己的滚动视图实现缩放，围绕内容左上角缩放并支持双向滚动。双指间距超过 Android 的最小距离（约 27 mm）后才开始捏合。
- 在 Mac Catalyst（Mac 界面风格）上，NSH 自行检测下拉并显示加载指示器。
- iOS 在缩放结束后会按缩放后的分辨率重绘文本和画布。

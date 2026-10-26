---
title: 触摸与手势
description: 按压与按压反馈、点击区域、pointerEvents、原始触摸事件、手势响应者系统、PanResponder，以及原生的拖动、捏合与旋转手势。
order: 38
group: ui
demo: guide-gestures
---

# 触摸与手势

NSH 的触摸处理分三个层次。**按压**（Rust 中的 `.on_press`、TSX 中的 `onPress` 等）用于按钮、列表行和链接，按压反馈由原生绘制。**原生手势**（拖动、捏合和旋转）在 UI 线程上驱动[动画值](./animation.md#动画值)，即使你的代码正忙，被拖动的卡片也能紧跟手指。**原始触摸与手势响应者系统**（Rust 中的 `.on_touch`、`.claim_touches` 与 `.on_responder_*`；TSX 中的 `onTouchStart`、`onResponderMove`、`PanResponder`）把每根手指的位置都交给你的代码，用来实现前两者表达不了的交互，例如手写绘图。

选择能完成任务的最高层次：层次越高，从 UI 线程传到你的代码的工作就越少。

## 按压

所有元素都接受按压事件，不需要单独的 "touchable" 组件。把 `.on_press` / `onPress` 加在视图、文本、图片或任何其他元素上即可。

```rust tabs
use nsh_core::prelude::*;

#[component]
fn App() -> impl IntoElement {
    let count = signal(0_u32);
    view().flex_1().items_center().justify_center().child(
        view()
            .on_press(move || count.update(|n| *n += 1))
            .on_long_press(move || count.set(0))
            .active(|s| s.opacity(0.6))
            .role(AccessibilityRole::Button)
            .px(px(20.0))
            .py(px(12.0))
            .rounded(px(10.0))
            .bg(rgb(0x0969da))
            .child(
                text(move || format!("Pressed {} times", count.get()))
                    .text_color(white())
                    .font_weight(FontWeight::SEMIBOLD),
            ),
    )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";

function App() {
  const count = signal(0);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <View
        onPress={() => count.update((n) => n + 1)}
        onLongPress={() => count.set(0)}
        activeStyle={{ opacity: 0.6 }}
        role="button"
        style={{ paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, backgroundColor: "#0969da" }}
      >
        <Text style={{ color: "#ffffff", fontWeight: "600" }}>Pressed {count()} times</Text>
      </View>
    </View>
  );
}

mount(App);
```

| Rust | TSX | 默认值 | 说明 |
|---|---|---|---|
| `.on_press(..)` | `onPress` | | 手指在视图内抬起（普通按压，不是长按）。 |
| `.on_long_press(..)` | `onLongPress` | | 手指按住达到长按延迟。之后不会再触发按压。 |
| `.on_press_down(..)` | `onPressDown` | | 按压开始。 |
| `.on_press_up(..)` | `onPressUp` | | 按压结束：抬起、滑出，或被滚动视图接管。 |
| `.long_press_delay(ms)` | `delayLongPress` | `500` | 按压变为长按前的毫秒数。 |
| `.disabled(..)` | `disabled` | `false` | 不接受按压，也不显示反馈；应用禁用样式；屏幕阅读器会读出它已停用。 |

按压的行为：

- **只有最内层的可按压视图响应。** 可按压的行里包含一个可按压的按钮时，按下按钮不会触发行的按压。
- **在滚动视图内，按压会等待约 130 ms** 才开始（并显示反馈），这样从按钮上开始的拖动会滚动页面，而不是按下按钮。
- **滑出即取消。** 手指移出视图时，按压以 press-up 处理函数结束，不触发按压。
- **禁用会把按压监听从挂载的视图上移除**，因此完全没有反馈，同时应用禁用样式（`.disabled_style(..)`、`class="disabled:opacity-40"`）。
- **带按压处理函数的嵌套文本片段就是链接。** 整段文字是一个原生视图，按压会交给手指下的那个片段。见[文本](./text.md)。

## 按压反馈

按压反馈由应用决定：视图在被按下、悬停、获得焦点或禁用时采用的样式。状态一变，样式就在原生侧立即生效，不需要往返你的代码。每种状态都有一个 Rust 方法、一个 TSX 样式属性和一个 [Tailwind 变体](./tailwind.md)：

| Rust | TSX 属性 | 类 | 说明 |
|---|---|---|---|
| `.active(\|s\| ..)` | `activeStyle` | `active:` | 按下时。 |
| `.hover(\|s\| ..)` | `hoverStyle` | `hover:` | 指针悬停在上面时（桌面、iPad 指针、浏览器）。 |
| `.focus(\|s\| ..)` | `focusStyle` | `focus:` | 获得焦点时。 |
| `.disabled_style(\|s\| ..)` | `disabledStyle` | `disabled:` | 禁用时。 |
| `.ripple(Ripple { .. })` | `android={{ ripple }}` | | Android 的 Material 水波纹（`color`、`borderless`、`radius`、`foreground`），叠加在这些样式之上。 |

状态样式叠加在视图自身的样式之上。后面的状态优先（hover、focus、active），禁用样式优先于所有状态，视图禁用时其他状态样式不生效。

```rust tabs
use nsh_core::{Ripple, prelude::*};

view().on_press(open).active(|s| s.opacity(0.5))

view().on_press(open).active(|s| s.bg(rgb(0xddf4ff))).p(px(16.0))

view()
    .on_press(open)
    .active(|s| s.opacity(0.6))
    .ripple(Ripple {
        color: Some(rgba(0x0969da4d).into()),
        ..Ripple::default()
    })
```

```tsx tabs
<View onPress={open} activeStyle={{ opacity: 0.5 }}>…</View>

<View onPress={open} activeStyle={{ backgroundColor: "#ddf4ff" }} style={{ padding: 16 }}>…</View>

<View
  onPress={open}
  activeStyle={{ opacity: 0.6 }}
  android={{ ripple: { color: "rgba(9,105,218,0.3)" } }}
>
  …
</View>
```

无边界水波纹会扩散到视图之外，适合图标按钮：`Ripple { borderless: true, radius: Some(px(24.0)), .. }`、`android={{ ripple: { borderless: true, radius: 24 } }}`。见[平台特定代码](./platform-specific.md)。

加上过渡（`.transition()`、`transition` 类）后，状态变化会有动画。`.group()`（`group` 类）让视图成为一个组，`.group_active(..)`（`group-active:`）在它被按下时给子元素设置样式：

```rust tabs
view()
    .on_press(save)
    .group()
    .rounded_xl()
    .bg(rgb(0x059669))
    .p_4()
    .transition()
    .active(|s| s.scale(0.95).bg(rgb(0x065f46)))
    .child(
        text("Save")
            .font_weight(FontWeight::SEMIBOLD)
            .text_color(white())
            .group_active(|s| s.opacity(0.85)),
    )
```

```tsx tabs
<View
  onPress={save}
  class="group rounded-xl bg-emerald-600 p-4 transition active:scale-95 active:bg-emerald-800"
>
  <Text class="font-semibold text-white group-active:opacity-85">Save</Text>
</View>
```

## 点击区域：hitSlop

点击区域扩展（`.hit_slop(..)`、`hitSlop`）把接收触摸的区域扩展到视图边界之外，而不改变布局。适合关闭按钮、开关之类的小目标。

```rust tabs
view().hit_slop(EdgeInsets::all(px(12.0))).on_press(close).size(px(20.0))

view()
    .hit_slop(EdgeInsets { top: px(10.0), bottom: px(10.0), left: px(4.0), right: px(4.0) })
    .on_press(next)
```

```tsx tabs
<View hitSlop={12} onPress={close} style={{ width: 20, height: 20 }}>…</View>
<View hitSlop={{ top: 10, bottom: 10, left: 4, right: 4 }} onPress={next}>…</View>
```

| Rust | TSX | 说明 |
|---|---|---|
| `.hit_slop(EdgeInsets)` | `hitSlop: number \| { top?, right?, bottom?, left? }` | 在边界四周增加的点数。`EdgeInsets::all(..)` 和 TSX 的数字都作用于四边。 |

扩展出的区域要留在父视图的范围内（给小视图留出一些 margin 或 padding）：命中测试要经过父视图才能到达子视图，落在父视图之外的触摸到不了子视图的扩展区域。

## 超出父视图的子视图

放在父视图边界之外的子视图（绝对定位且 `overflow` 保持可见，例如输入框下方的下拉菜单）在它绘制的位置接收触摸，和其他视图一样：NSH 在原生侧对超出视图范围的后代做命中测试。父视图裁剪溢出时，它们在那里既不显示也不接收触摸。这个区域按布局计算，所以被 transform 移出父视图的子视图只在父视图边界内接收触摸。

注意绘制顺序：只有当输入框排在兄弟视图之后，或 `z-index` 更高时，下拉菜单才会绘制在这些兄弟视图之上，而触摸交给绘制在最上面的视图。

## pointerEvents

指针事件设置（`.pointer_events(..)`、`pointerEvents`）决定子树中哪些视图可以成为触摸的目标。它在原生命中测试时求值，每次触摸都不产生额外开销。

| Rust | TSX | 视图本身 | 子视图 |
|---|---|---|---|
| `PointerEvents::Auto`（默认） | `"auto"` | 接收触摸 | 接收触摸 |
| `PointerEvents::None` | `"none"` | 永远不是目标 | 永远不是目标：触摸穿透到后面的内容 |
| `PointerEvents::BoxNone` | `"box-none"` | 永远不是目标 | 接收触摸 |
| `PointerEvents::BoxOnly` | `"box-only"` | 接收触摸 | 永远不是目标 |

典型用法：不能挡住下层内容的覆盖层（none）；全屏容器的空白处要把触摸让给后面的内容、而其中的按钮仍然可用（box-none）；手指落在子视图上时也要由整行接收按压（box-only）。

```rust tabs
view().flex_1().child(map()).child(
    // 浮动工具栏：空白区域把触摸交给地图。
    view()
        .pointer_events(PointerEvents::BoxNone)
        .absolute()
        .inset_0()
        .justify_end()
        .p(px(16.0))
        .child(
            view()
                .on_press(locate)
                .self_end()
                .p(px(12.0))
                .rounded(px(24.0))
                .bg(white())
                .child(text("Locate")),
        ),
)
```

```tsx tabs
<View style={{ flex: 1 }}>
  <Map />
  {/* 浮动工具栏：空白区域把触摸交给地图。 */}
  <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end", padding: 16 }}>
    <View onPress={locate} style={{ alignSelf: "flex-end", padding: 12, borderRadius: 24, backgroundColor: "#ffffff" }}>
      <Text>Locate</Text>
    </View>
  </View>
</View>
```

Tailwind 类 `pointer-events-none` 和 `pointer-events-auto` 设置的是同一件事；显式属性优先于类。

## 原生手势：拖动、捏合与旋转

要让拖动、捏合和旋转移动屏幕上的东西，就把[动画值](./animation.md#动画值)绑定到手势上。平台的手势识别器在 UI 线程上写入这些值，绑定了它们的视图在同一帧移动；你的代码只在手势开始和结束时得到通知。

```rust tabs
use nsh_core::prelude::*;

#[component]
fn App() -> impl IntoElement {
    let x = animated_value(0.0);
    let y = animated_value(0.0);
    view().flex_1().items_center().justify_center().child(
        view()
            .pan_values(Some(&x), Some(&y))
            .on_pan_end(move |e: &PanEvent| {
                // 以松手时的速度弹回原位。
                let spring = |velocity| Spring { velocity: Some(velocity), ..Spring::default() };
                x.spring(0.0, spring(e.velocity_x));
                y.spring(0.0, spring(e.velocity_y));
            })
            .size(px(120.0))
            .rounded(px(24.0))
            .bg(rgb(0x8250df))
            .bind_translate_x(&x)
            .bind_translate_y(&y),
    )
}
```

```tsx tabs
import { mount, View } from "nsh";
import { createAnimatedValue } from "nsh";

function App() {
  const x = createAnimatedValue(0);
  const y = createAnimatedValue(0);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <View
        pan={{ x, y }}
        onPanEnd={(e) => {
          // 以松手时的速度弹回原位。
          x.spring(0, { velocity: e.velocityX });
          y.spring(0, { velocity: e.velocityY });
        }}
        style={{ width: 120, height: 120, borderRadius: 24, backgroundColor: "#8250df", transform: [{ translateX: x }, { translateY: y }] }}
      />
    </View>
  );
}

mount(App);
```

| Rust | TSX | 说明 |
|---|---|---|
| `.pan_values(Some(&x), Some(&y))` | `pan={{ x?, y? }}` | 单指拖动驱动这些值，单位为点。 |
| `.pinch_value(&scale)` | `pinch={{ scale? }}` | 双指捏合驱动 `scale`（倍数）。 |
| `.rotation_value(&angle)` | `rotation={{ angle? }}` | 双指旋转驱动 `angle`，单位为度。 |
| `.on_pan_start` / `.on_pan_end` | `onPanStart` / `onPanEnd` | 拖动开始 / 结束，带一个 `PanEvent`。 |
| `.on_pinch_start` / `.on_pinch_end` | `onPinchStart` / `onPinchEnd` | 捏合开始 / 结束：缩放倍数和速度（`GestureEvent`）。 |
| `.on_rotation_start` / `.on_rotation_end` | `onRotationStart` / `onRotationEnd` | 旋转开始 / 结束：角度（Rust 中为 `GestureEvent<Radians>`）和速度。 |

拖动事件包含位移（`translation`；TSX：`translationX` / `translationY`，自开始以来移动的点数）、速度（`velocity_x` / `velocity_y`；TSX：`velocityX` / `velocityY`，每**秒**的点数）以及此刻所绑定的值（`value_x` / `value_y`；TSX：`valueX` / `valueY`）。

原生端替你做了这些事：

- **拖动从值当前的位置继续。** 开始时读取这些值，再把位移加上去；抓住一个仍在动画中的值（例如正在弹回的弹簧）会让动画停在原处。
- **只绑定一个轴时，另一个轴照常滚动。** 只绑定水平值时，只有手指的水平移动大于垂直移动，拖动才会开始，所以竖向滚动视图里的横向滑动行仍然可以上下滚动。这个判断在系统询问手势能否开始时由原生做出。
- **拖动、捏合和旋转可以同时进行**：同一张卡片可以同时被拖动、缩放和旋转。
- **用松手速度做物理效果。** 拖动结束时的速度可以直接作为弹簧或衰减的速度；绑定的值用来挑选吸附点。

```rust tabs
// 吸附到左边或右边的卡片。
view()
    .pan_values(Some(&x), None)
    .on_pan_end(move |e: &PanEvent| {
        let projected = e.value_x.unwrap_or(0.0) + e.velocity_x * 0.2;
        let to = if projected > 0.0 { 140.0 } else { -140.0 };
        x.spring(to, Spring { velocity: Some(e.velocity_x), ..Spring::default() });
    })
    .bind_translate_x(&x)
```

```tsx tabs
// 吸附到左边或右边的卡片。
<View
  pan={{ x }}
  onPanEnd={(e) => {
    const projected = (e.valueX ?? 0) + e.velocityX * 0.2;
    x.spring(projected > 0 ? 140 : -140, { velocity: e.velocityX });
  }}
  style={{ transform: [{ translateX: x }] }}
/>
```

> [!TIP]
> 只要拖动只是移动东西，就把动画值绑定到手势上，而不是通过响应者跟随手指。绑定值时，繁忙的应用代码不会让拖动卡顿；用响应者时，每一次移动都是一次发往你的代码的事件和一次视图更新。

## 原始触摸事件

触摸事件报告每根手指的按下、移动和抬起。它们适合记录日志、自定义命中测试和响应多点触摸；它们不会占有触摸（按压和滚动视图照常工作）。

在 Rust 中，`.on_touch(..)` 以 `TouchEvent` 接收每个阶段：`phase`（`TouchPhase::Start`、`Move`、`End`、`Cancel`）、`timestamp` 和 `points`，即所有按下的手指，每根手指有 `id`、在它按下的视图中的位置 `location`、在 surface 中的位置 `page`，以及表示本次事件涉及该手指的 `changed`。在 TSX 中，每个阶段有自己的处理函数：

| TSX | 说明 |
|---|---|
| `onTouchStart` | 有手指在视图上或其内部按下。 |
| `onTouchMove` | 手指移动。同一引擎轮次内的移动会被合并。 |
| `onTouchEnd` | 手指抬起。 |
| `onTouchCancel` | 系统接管了触摸（滚动视图开始滚动、来电等）。 |
| `onTouchStartCapture`、`onTouchMoveCapture`、`onTouchEndCapture`、`onTouchCancelCapture` | 同上，但从外向内调用，先于冒泡阶段的处理函数。 |

每个 TSX 处理函数收到一个 `GestureResponderEvent`：

| 字段 | 说明 |
|---|---|
| `identifier` | 手指按下期间的标识。 |
| `locationX`、`locationY` | 在手指按下的那个视图（`target`）中的位置。 |
| `pageX`、`pageY` | 在整个 surface 中的位置。 |
| `target` | 手指按下的那个视图的 id。 |
| `timestamp` | 毫秒。 |
| `touches` | 所有按下的手指。 |
| `changedTouches` | 本次事件涉及的手指。 |
| `nativeEvent` | 事件本身，因此 `e.nativeEvent.locationX` 也可用。 |
| `stopPropagation()` | 外层视图不再收到这次触摸事件。 |

```rust tabs
use nsh_core::{TouchPhase, element::{TouchEvent}, prelude::*};

view().on_touch(|e: &TouchEvent| {
    let Some(p) = e.points.iter().find(|p| p.changed) else { return };
    match e.phase {
        TouchPhase::Start => log::info!("down {:?} {}", p.location, e.points.len()),
        TouchPhase::Move => log::info!("move {:?}", p.page),
        TouchPhase::End | TouchPhase::Cancel => log::info!("up"),
    }
})
```

```tsx tabs
<View
  onTouchStart={(e) => console.log("down", e.locationX, e.locationY, e.touches.length)}
  onTouchMove={(e) => console.log("move", e.pageX, e.pageY)}
  onTouchEnd={() => console.log("up")}
/>
```

### 视图的位置：measure

触摸的位置相对于手指按下的那个视图，而它可能是你关心的视图的子视图（例如滑块的滑钮）。测量一个视图可以得知它的位置，这样就能改用 page 坐标。在 Rust 中，给视图放一个 `element_ref()`，然后 await 它的 `measure()`；在 TSX 中，调用它的 ref 的 `measure()`：

```rust tabs
let track = element_ref();
let origin = stored(px(0.0));
view()
    .element_ref(&track)
    .claim_touches(TouchClaim::on_start())
    .on_responder_grant(move |e: &ResponderEvent| {
        let x = e.page.x;
        spawn(async move {
            let page = track.measure().await.map_or(px(0.0), |m| m.page.x);
            origin.replace(page);
            seek(x - page);
        });
    })
    .on_responder_move(move |e: &ResponderEvent| seek(e.page.x - origin.get()))
```

```tsx tabs
let track!: YNode;
let origin = 0;
<View
  ref={track}
  onStartShouldSetResponder={() => true}
  onResponderGrant={async (e) => {
    const x = e.pageX;
    origin = (await track.measure())?.pagePosition.x ?? 0;
    seek(x - origin);
  }}
  onResponderMove={(e) => seek(e.pageX - origin)}
/>;
```

它在此前的改动完成布局后返回：Rust 中是一个 `Measurement`（`frame`，即布局处理函数报告的、相对于父视图的框架；以及 `page`，即左上角），TSX 中是 `{ bounds, pagePosition }`。左上角位于 surface 中，或位于视图所在的对话框中，与触摸的 page 坐标相同。周围滚动视图和列表的偏移会计入；transform（包括动画）不计入。视图不在屏幕上时返回 `None` / `null`。

## 手势响应者系统

当你的代码必须独占一段触摸序列时（手写绘图、自定义滑块、原生识别器没有提供的手势），使用手势响应者系统。同一时间只有一个视图是**响应者**并接收移动事件，由各视图协商出谁来担任。

成为响应者：

| Rust | TSX | 说明 |
|---|---|---|
| `.claim_touches(TouchClaim::on_start())` | `onStartShouldSetResponder` 返回 `true` | 手指按下时从目标向外逐层询问。 |
| `.claim_touches(TouchClaim::on_move())` | `onMoveShouldSetResponder` 返回 `true` | 在没有响应者时（或为了接管）每次移动都会询问。 |
| `TouchClaim::on_start().capture()` | `onStartShouldSetResponderCapture` | 同上，但从外向内询问，先于冒泡阶段。父视图用它从子视图手里拿走触摸。 |
| `TouchClaim::on_move().capture()` | `onMoveShouldSetResponderCapture` | 移动时的版本。 |

声明的接管只根据视图本身做决定，不运行你的代码，除非它询问：`TouchClaim::on_move().ask(|r: &ClaimRequest| ..)` 在监听函数调用 `r.claim()` 时接管，可以根据至今的手势（`r.event.gesture`）来判断。TSX 处理函数的第二个参数 `gestureState` 就是这个手势，字段与 [PanResponder](#panresponder) 的相同（`dx`、`dy`、`vx`、`vy`、`moveX`、`moveY`、`x0`、`y0`、`numberActiveTouches`）。只接管水平滑动：`onMoveShouldSetResponder={(e, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy)}`。这个决定仍然晚了一次移动，外层的滚动视图可能已经开始滚动；滚动视图里的拖动请用 [panActivation](#滚动视图里的拖动panactivation)。

成为响应者之后：

| Rust | TSX | 说明 |
|---|---|---|
| `.on_responder_grant(..)` | `onResponderGrant` | 该视图现在是响应者。Rust 默认阻止原生滚动视图接管触摸（`TouchClaim::block_native(false)` 则允许）；TSX 中返回 `true` 达到同样效果。 |
| `.on_responder_reject(..)` | `onResponderReject` | 另一个视图是响应者且不肯放手。 |
| `.on_responder_start(..)` | `onResponderStart` | 又有一根手指按下。 |
| `.on_responder_move(..)` | `onResponderMove` | 手指移动。 |
| `.on_responder_end(..)` | `onResponderEnd` | 有手指抬起。 |
| `.on_responder_release(..)` | `onResponderRelease` | 最后一根手指抬起：手势结束。 |
| `.keep_touches(true)` | `onResponderTerminationRequest` 返回 `false` | 另一个视图想要接管时保留触摸（默认会交出）。 |
| `.on_responder_terminate(..)` | `onResponderTerminate` | 另一个视图或某个原生手势接管了触摸。 |

Rust 组件的响应者从成为响应者起一直保持按下状态，直到它的触摸结束，无论手指或指针移到哪里，就像 CSS 的 `:active` 会保持到按钮松开：它的 `.active(..)` 样式和其中的 `group-active:` 类在整个拖动过程中保持不变（例如拖出条带的调整大小手柄）。

Rust 处理函数收到一个 `ResponderEvent`：手指在它按下的视图中的位置 `location`、page 坐标 `page`、`timestamp`，以及自成为响应者以来的手势 `gesture`。

```rust tabs
use nsh_core::prelude::*;

fn sketch() -> impl IntoElement {
    let strokes = signal(Vec::<Vec<Point<Points>>>::new());
    canvas(move || {
        strokes.with(|all| {
            all.iter().fold(Painter::new().line_width(3.0), |p, s| {
                let mut p = p.begin_path();
                for (i, pt) in s.iter().enumerate() {
                    p = if i == 0 { p.move_to(pt.x, pt.y) } else { p.line_to(pt.x, pt.y) };
                }
                p.stroke()
            })
        })
    })
    .flex_1()
    // 成为响应者：外层的滚动视图不会接管触摸。
    .claim_touches(TouchClaim::on_start())
    .keep_touches(true)
    .on_responder_grant(move |e: &ResponderEvent| strokes.update(|all| all.push(vec![e.location])))
    .on_responder_move(move |e: &ResponderEvent| {
        strokes.update(|all| {
            if let Some(last) = all.last_mut() {
                last.push(e.location);
            }
        })
    })
}
```

```tsx tabs
import { Canvas, type GestureResponderEvent, mount, signal } from "nsh";

function Sketch() {
  const strokes = signal<[number, number][][]>([]);
  const point = (e: GestureResponderEvent): [number, number] => [e.locationX, e.locationY];
  return (
    <Canvas
      style={{ flex: 1 }}
      onStartShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        strokes.set([...strokes(), [point(e)]]);
        return true; // 外层的滚动视图不能接管触摸
      }}
      onResponderTerminationRequest={() => false}
      onResponderMove={(e) => {
        const all = strokes();
        strokes.set([...all.slice(0, -1), [...all[all.length - 1], point(e)]]);
      }}
      draw={(cx) => {
        cx.lineWidth = 3;
        for (const s of strokes()) {
          cx.beginPath();
          s.forEach(([x, y], i) => (i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y)));
          cx.stroke();
        }
      }}
    />
  );
}

mount(Sketch);
```

运行方式：带有任何触摸或响应者处理函数的视图会在原生端监听触摸；平台把发生在它上面（及其内部）的触摸连同沿途正在监听的视图路径一起上报，协商过程在 NSH 的 Rust 核心中进行，按顺序询问接管声明并调用你的处理函数：先从最外层视图向内处理捕获阶段，再从目标向外处理其他的。由此有两个结果：

- **原生滚动视图与响应者相互竞争。** 响应者阻止滚动视图时，外层的滚动视图会停止接管触摸，直到手势结束。如果原生滚动视图先开始拖动，则滚动视图获胜：响应者收到 terminate 处理函数，触摸处理函数收到 cancel。
- **每次移动都是一次发往你的代码的事件。** 由响应者驱动的拖动，流畅程度取决于你的代码的速度；只是移动视图的拖动，优先使用[绑定的值](#原生手势拖动捏合与旋转)。

## PanResponder

在 Rust 中，响应者事件已经带有手势：`ResponderEvent::gesture` 是一个 `PanGesture`，包含自开始以来的距离、速度和手指数量。在 TSX 中，`nsh` 中的 `PanResponder` 封装了手势响应者系统，并附加同样的手势状态；把它的 `panHandlers` 展开到视图上。

```rust tabs
use nsh_core::prelude::*;

fn ball() -> impl IntoElement {
    let pos = signal((0.0_f32, 0.0_f32));
    let start = stored((0.0_f32, 0.0_f32));
    view()
        .size(px(60.0))
        .rounded(px(30.0))
        .bg(rgb(0x0969da))
        .style_with(move |s| {
            let (x, y) = pos.get();
            s.translate_x(px(x)).translate_y(px(y))
        })
        .claim_touches(TouchClaim::on_start())
        .on_responder_grant(move |_: &ResponderEvent| {
            start.replace(pos.get_untracked());
        })
        .on_responder_move(move |e: &ResponderEvent| {
            let (x, y) = start.get();
            let d = e.gesture.delta;
            pos.set((x + d.x.0, y + d.y.0));
        })
        .on_responder_release(move |e: &ResponderEvent| {
            log::info!("released at {} {} pt/ms", e.gesture.vx, e.gesture.vy)
        })
}
```

```tsx tabs
import { mount, signal, View } from "nsh";
import { PanResponder } from "nsh";

function Ball() {
  const pos = signal({ x: 0, y: 0 });
  let start = { x: 0, y: 0 };
  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      start = pos();
    },
    onPanResponderMove: (_, g) => pos.set({ x: start.x + g.dx, y: start.y + g.dy }),
    onPanResponderRelease: (_, g) => console.log("released at", g.vx, g.vy, "pt/ms"),
  });
  return (
    <View
      {...responder.panHandlers}
      style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: "#0969da", transform: [{ translateX: pos().x }, { translateY: pos().y }] }}
    />
  );
}

mount(Ball);
```

手势状态：

| Rust（`PanGesture`） | TSX（`gestureState`） | 说明 |
|---|---|---|
| | `stateID` | 手势的标识。 |
| `position` | `moveX`、`moveY` | 各触点中心的最新位置，surface 坐标（点）。 |
| `origin` | `x0`、`y0` | 成为响应者时触点中心的位置。 |
| `delta` | `dx`、`dy` | 自成为响应者以来移动的距离。 |
| `vx`、`vy` | `vx`、`vy` | 速度，单位为每**毫秒**的点数。 |
| `active_touches` | `numberActiveTouches` | 按下的手指数。 |

在 Rust 中，`PanGesture::begin` 和 `PanGesture::update` 根据原始触摸（`.on_touch`）跟踪手势。TSX 回调参数为 `(event, gestureState)`：`onStartShouldSetPanResponder(Capture)`、`onMoveShouldSetPanResponder(Capture)`、`onPanResponderGrant`、`onPanResponderReject`、`onPanResponderStart`、`onPanResponderMove`、`onPanResponderEnd`、`onPanResponderRelease`、`onPanResponderTerminate`、`onPanResponderTerminationRequest` 和 `onShouldBlockNativeResponder`。最后一个默认为 `true`：成为响应者的 PanResponder 会阻止原生滚动视图接管它的触摸。

## 滚动视图里的拖动：panActivation

纵向滚动视图里一个可以横向拖动查看数值的图表，需要接管横向拖动、把纵向拖动留给滚动视图。按下时就接管触摸会让滚动从第一个像素起就被挡住；在你的代码里根据移动来判断又太晚：等它回答时，滚动视图可能已经拿走了触摸。拖动激活（`TouchClaim::on_pan(..)`、`panActivation`）让平台在主线程上随着手指移动来决定：

```rust tabs
view()
    .claim_touches(TouchClaim::on_pan(PanActivation::horizontal(px(10.0), px(10.0))))
    .on_responder_grant(|e: &ResponderEvent| scrub(Some(e.location.x)))
    .on_responder_move(|e: &ResponderEvent| scrub(Some(e.location.x)))
    .on_responder_release(|_: &ResponderEvent| scrub(None))
    .child(chart())
```

```tsx tabs
<View
  panActivation={{ activeOffsetX: 10, failOffsetY: 10 }}
  onResponderGrant={(e) => scrub(e.locationX)}
  onResponderMove={(e) => scrub(e.locationX)}
  onResponderRelease={() => scrub(null)}
>
  <Chart />
</View>
```

| Rust（`PanActivation`） | TSX | 说明 |
|---|---|---|
| `active_offset_x`、`active_offset_y` | `activeOffsetX`、`activeOffsetY` | 手指沿该轴离按下的位置超过这个距离（任一方向，单位点）时，拖动激活。 |
| `fail_offset_x`、`fail_offset_y` | `failOffsetX`、`failOffsetY` | 手指先超过这个距离时拖动失败：触摸留给滚动视图。 |

`PanActivation::horizontal(active, fail)` 和 `PanActivation::vertical(active, fail)` 设置常用的组合。没有激活偏移时，任一方向移动 10 点后激活。激活之前，外层的滚动视图会等待它（iOS），视图的其他接管声明也不会被询问。激活后，滚动视图不能再拿走这些触摸，视图成为响应者（先 grant，再收到移动）；失败时滚动视图照常滚动。在 TSX 中，`PanResponder` 的 `panHandlers` 也可以一起用：和这个属性放在同一个视图上，`onPanResponderGrant` 在激活时运行。

> [!NOTE]
> 不同 API 的速度单位不同：响应者手势的 `vx` / `vy` 是每毫秒的点数，而拖动结束时的速度以及弹簧或衰减的速度是每秒的点数。把 `vx` 传给弹簧前要乘以 1000。

## 为什么有些答案是属性

主线程从不等待你的代码。当系统需要立即得到答案时（这个拖动手势能否开始、这个点是否命中视图、这次点击是否应该收起键盘），NSH 根据事先挂载好的设置在原生端直接回答：绑定的拖动值（它们的轴）、捏合值、点击区域扩展、指针事件设置、滚动视图的键盘点击设置、拖动激活。你的处理函数事后才得知发生了什么。所以这些是声明式的设置而不是回调；也正因如此，会运行你的代码的响应者协商只在响应者之间做决定，从不阻塞原生手势。

## 相关内容

- [`View`](../elements/view.md)：基础元素上的所有触摸属性。
- [动画](./animation.md)：用于手势驱动运动的动画值、弹簧和衰减。
- [滚动](./scrolling.md)：键盘点击设置、滚动视图与嵌套手势。
- [`PanResponder`](../modules/nsh.md#panresponder)：`PanResponder` 参考。
- [无障碍](./accessibility.md)：可按压视图是无障碍元素；给它们设置角色和标签。

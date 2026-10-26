---
title: nsh/animated
description: 动画值、动画驱动、关键帧、动效及其预设、组合动画、缓动曲线和布局动画。
order: 3
demo: mod-animated
---

# nsh/animated

动画 API 在 UI 线程上执行动画。你创建一个**动画值**（animated value），把它（或由它派生的值）绑定到样式属性上，然后启动动画；此后每一帧都在原生侧计算，不需要运行应用的代码。引擎线程或 JS 线程再忙也不会让动画卡顿，动画的每一帧也不消耗应用任何开销。Rust 代码使用 `nsh_core::ui::prelude` 中的 `animated_value()`、`motion()`、`Animation`、`Spring`、`Timing`、`KeyframeTiming`、`MotionPreset` 和 `Easing`，用元素的 `.bind_*` 方法绑定动画值；TSX 导入 `nsh/animated`。

```rust tabs
use nsh_core::ui::{LayoutAnimation, prelude::*}; // animated_value、motion、Animation、Spring、Timing、Keyframe、KeyframeTiming、MotionPreset、MotionSpec、Easing、animate_layout
```

```tsx tabs
import { Animated, createAnimatedValue, createMotion, motions, Easing, LayoutAnimation, AnimatedNode, AnimatedValue } from "nsh/animated";
```

教程见[动画](../docs/animation.md)。

## 动画值可以驱动什么

| 位置 | Rust | TSX |
|---|---|---|
| `opacity` | `.bind_opacity(&value)` | `style={{ opacity: value }}` |
| `backgroundColor` | `.bind_background(&value.interpolate_colors(&[0.0, 1.0], &[white(), black()]))` | `style={{ backgroundColor: value.interpolate({ inputRange: [0, 1], outputRange: ["#fff", "#000"] }) }}` |
| `borderColor`、`color` | `.bind_border_color(&node)`、`.bind_color(&node)` | 同上：一个颜色节点。`borderColor` 为所有边着色；`Text` 的 `color` 为整段文本着色 |
| `shadowColor`、`shadowOpacity`、`shadowRadius` | `.bind_shadow_color(&node)`、`.bind_shadow_opacity(&value)`、`.bind_shadow_radius(&value)` | `style={{ shadowOpacity: value }}`（`shadowColor` 用颜色节点） |
| `transform` | `.bind_translate_x(&value)`、`.bind_translate_y`、`.bind_scale`、`.bind_rotate`（角度） | `translateX`、`translateY`、`scale`、`scaleX`、`scaleY`、`rotate`、`rotateX`、`rotateY`、`rotateZ`：`transform: [{ translateX: value }]` |
| 滚动位置 | 滚动视图或列表上的 `.scroll_value(&value)` | `<Scroll scrollValue={value}>` 和 `<List scrollValue={value}>` 每帧把滚动偏移写入该值 |
| 手势 | `.pan_values(Some(&x), Some(&y))`、`.pinch_value(&scale)`、`.rotation_value(&angle)` | 任意元素上的 `pan={{ x, y }}`、`pinch={{ scale }}`、`rotation={{ angle }}`：手势直接写入这些值（见[触摸与手势](../docs/touch-and-gestures.md)） |
| 吸附位置 | `.sticky().bind_sticky_top(&value)`（横向滚动视图中为 `.bind_sticky_left`）、列表上的 `.bind_sticky_header_offset(&value)` | `style={{ position: "sticky", top: value }}`、`<List stickyHeaderOffset={value}>`：吸附视图和标题吸附在距视口起点这么远的位置，逐帧跟随该值 |
| 画布 | 绘制调用中的动画参数 | [画布](./nsh-canvas.md)绘制调用中的任意数字或颜色参数 |

其他样式属性只接受普通值；如果要为布局本身（尺寸、在布局流中的位置）添加动画，请使用 [`LayoutAnimation`](#layoutanimation)。

## createAnimatedValue

```ts
function createAnimatedValue(value?: number): AnimatedValue;
```

创建一个初始值为 `value`（默认 `0`）的动画值。Rust：`animated_value(value)`，一个由创建它的组件持有的 `Copy` 句柄。

```rust tabs
use nsh_core::ui::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let x = animated_value(0.0);
    let right = stored(false);
    let toggle = move || {
        let to_right = !right.get();
        right.replace(to_right);
        let _ = x.spring(if to_right { 200.0 } else { 0.0 }, Spring::default());
    };
    view()
        .flex_1()
        .p_6()
        .pt_12()
        .gap_4()
        .child(view().size(px(60.0)).rounded(px(12.0)).bg(rgb(0x6366f1)).bind_translate_x(&x))
        .child(text("Move").on_press(toggle))
}
```

```tsx tabs
import { mount, Text, View } from "nsh";
import { createAnimatedValue } from "nsh/animated";

function App() {
  const x = createAnimatedValue(0);
  let right = false;
  const toggle = () => {
    right = !right;
    x.spring(right ? 200 : 0);
  };
  return (
    <View style={{ flex: 1, padding: 24, paddingTop: 48, gap: 16 }}>
      <View style={{ width: 60, height: 60, borderRadius: 12, backgroundColor: "#6366f1", transform: [{ translateX: x }] }} />
      <Text onPress={toggle}>Move</Text>
    </View>
  );
}

mount(App);
```

> [!NOTE]
> 动画值存在于 UI 线程，每帧都在那里变化，所以应用异步读取它：`await value.getValue()`（或 `stop()` 返回的 Promise）给出那一刻的值，Rust 中在任务里 `value.value().await`。如果代码需要立刻知道目标值，请像上例一样用变量或 signal 自己记录。手势事件会在结束时报告这些值（`PanEvent.valueX` / `valueY`）。

## AnimatedValue

```ts
class AnimatedValue extends AnimatedNode {
  constructor(value: number);
  set(value: number): void;
  stop(): Promise<number>;
  getValue(): Promise<number>;
  setOffset(offset: number): void;
  flattenOffset(): void;
  extractOffset(): void;
  timing(to: number, options?: { duration?: number; easing?: Easing; delay?: number }): Promise<boolean>;
  spring(to: number, options?: { stiffness?: number; damping?: number; mass?: number; velocity?: number }): Promise<boolean>;
  decay(options?: { velocity?: number; deceleration?: number; clamp?: [number, number]; bounce?: number }): Promise<boolean>;
  keyframes(keyframes: KeyframeValue[], options?: KeyframeTiming): Promise<boolean>;
}
```

| 方法 | Rust | 说明 |
|---|---|---|
| `set(value)` | `set(value)` | 直接跳到 `value`，并停止正在运行的动画。 |
| `stop()` | `stop()`，然后 `value().await` | 让正在运行的动画停在当前位置；resolve 为停下处的值。 |
| `getValue()` | `value().await` | resolve 为当前值（含偏移），在 UI 线程上读取。 |
| `setOffset(offset)` | `set_offset(offset)` | 加到值上的偏移：绑定看到的是值 + 偏移；`set`、动画和拖动改变的是值本身。 |
| `flattenOffset()` | `flatten_offset()` | 把偏移加到值上，并把偏移归 0。 |
| `extractOffset()` | `extract_offset()` | 把值移入偏移，并把值归 0（这样下一次拖动从上一次结束的位置开始）。 |
| `timing(to, options)` | `timing(to, ms, easing)`、`timing_with(to, Timing { … })` | 沿缓动曲线动画到 `to`。`duration` 单位为毫秒（默认 300），`easing`（默认 `"easeInOut"`），`delay` 单位为毫秒（默认 0）。 |
| `spring(to, options)` | `spring(to, Spring { … })` | 以弹簧效果运动到 `to`。`stiffness`（默认 170）、`damping`（默认 26）、`mass`（默认 1）、`velocity`（初速度，单位/秒）。 |
| `decay(options)` | `decay(velocity, deceleration)`、`decay_within(velocity, deceleration, (min, max), bounce)` | 以 `velocity`（单位/秒）为初速度滑行并逐渐减速，每毫秒保留 `deceleration`（默认 0.998）的速度。适合在快速滑动后使用 `onPanEnd` 给出的速度。设置 `clamp: [min, max]` 时，它在边界处停下，或以 `bounce`（0..1，默认 0）比例的速度反弹。 |
| `keyframes(frames, options)` | `keyframes(frames, KeyframeTiming)` | 像 CSS 关键帧那样播放[关键帧](#关键帧)：每段有自己的缓动，按 `direction` 播放 `iterations` 次。 |

每个动画方法都返回一个 Promise：动画完成时 resolve 为 `true`，被停止（`stop`、`set` 或同一个值上的另一个动画）时为 `false`。在 Rust 中返回 `AnimationEnd`，在任务中 await 它得到同样的 `bool`。

```rust tabs
let opacity = animated_value(1.0);
spawn(async move {
    if opacity.timing(0.0, 200.0, Easing::EaseInOut).await {
        visible.set(false);
    }
});
```

```tsx tabs
const opacity = createAnimatedValue(1);
const finished = await opacity.timing(0, { duration: 200 });
if (finished) visible.set(false);
```

## AnimatedNode

```ts
class AnimatedNode {
  interpolate(config: {
    inputRange: number[];
    outputRange: number[] | string[];
    extrapolate?: Extrapolation;
    extrapolateLeft?: Extrapolation;
    extrapolateRight?: Extrapolation;
    easing?: Easing;
  }): AnimatedNode;
  diffClamp(min: number, max: number, options?: { snap?: boolean }): AnimatedNode;
  add(b: AnimatedNode | number): AnimatedNode;
  sub(b: AnimatedNode | number): AnimatedNode;
  mul(b: AnimatedNode | number): AnimatedNode;
  div(b: AnimatedNode | number): AnimatedNode;
  mod(b: AnimatedNode | number): AnimatedNode;
}

type Extrapolation = "extend" | "clamp" | "identity";
```

原生动画图中的一个节点：一个 `AnimatedValue`，或由其他节点派生的值。派生节点在其输入变化时在 UI 线程上求值。

| 方法 | Rust | 说明 |
|---|---|---|
| `interpolate(config)` | `interpolate(&input, &output)`、`interpolate_colors(&input, &colors)`、`interpolate_with(&input, output, Interpolation { … })` | 按分段区间映射输入。`outputRange` 可以是数字、颜色（`"#ff0000"`、`"rgba(…)"`）或角度（`"45deg"`、`"1rad"`）。超出 `inputRange` 时默认钳制（clamp）；`extrapolate`（或 `extrapolateLeft` / `extrapolateRight`）可以是 `"extend"`（沿直线延伸）、`"clamp"` 或 `"identity"`（直接输出输入值）。`easing` 决定每一段的曲线。Rust 接受数字、主题颜色（跟随外观）以及供 `bind_rotate` 使用的角度（度）。 |
| `diffClamp(min, max, options?)` | `diff_clamp(min, max)`、`diff_clamp_with(min, max, DiffClamp::snapping())` | 跟随输入的变化量，但把结果限制在 `min..max` 内：内容向上滚动时隐藏、一旦向下滚动就重新出现的标题栏。`snap: true` 让它在滚动视图停下时用 200 ms 停到较近的一端；只有输入达到 `max` 后才会停在 `max`。 |
| `add`、`sub`、`mul`、`div` | `add`、`sub`、`mul`、`div` | 与另一个节点或常量做算术运算。 |
| `mod(b)` | `modulo(b)` | 取模，`b` 为正时结果不会为负（比如把角度保持在 0..360）。 |

```rust tabs
let scroll_y = animated_value(0.0);
let header = scroll_y.diff_clamp(0.0, 44.0);

view()
    .flex_1()
    .child(scroll().scroll_value(&scroll_y).flex_1() /* rows */)
    .child(view().h(px(44.0)).bind_translate_y(&header.mul(-1.0)))
```

```tsx tabs
const scroll = createAnimatedValue(0);
const header = scroll.diffClamp(0, 44);

<Scroll scrollValue={scroll} style={{ flex: 1 }}>{/* rows */}</Scroll>
<View style={{ height: 44, transform: [{ translateY: header.mul(-1) }] }} />
```

```rust tabs
let progress = animated_value(0.0);
let rotate = progress.interpolate(&[0.0, 1.0], &[0.0, 360.0]); // 角度，供 bind_rotate 使用
let color = progress.interpolate_colors(&[0.0, 0.5, 1.0], &[rgb(0x22c55e), rgb(0xeab308), rgb(0xef4444)]);
```

```tsx tabs
const progress = createAnimatedValue(0);
const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
const color = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: ["#22c55e", "#eab308", "#ef4444"] });
```

## 关键帧

```ts
interface Keyframe {
  offset?: number;          // 一次迭代中的位置 0..1；缺省的 offset 均匀分布
  value: number | string;   // 数字，或以度为单位的角度（"45deg"、"0.5turn"）
  easing?: Easing;          // 从这里开始的那一段
}
type KeyframeValue = number | string | Keyframe;

interface KeyframeTiming {
  duration?: number;        // 一次迭代，毫秒（300）
  delay?: number;           // 第一次迭代前，毫秒（0）
  easing?: Easing;          // 没有自带缓动的各段（CSS "ease"）
  iterations?: number | "infinite";   // 1
  direction?: "normal" | "reverse" | "alternate" | "alternate-reverse";
}
```

`value.keyframes(frames, options)` 让一个值走过一组关键帧，并以是否播放完成兑现；`Animated.keyframes(value, { keyframes, ...options })` 是同样的东西，作为组合动画的一步。Rust：`value.keyframes(frames, KeyframeTiming)` 和 `Animation::keyframes(&value, frames, KeyframeTiming)`，关键帧用 `Keyframe::new(value)`（均匀分布）、`Keyframe::at(offset, value)` 和 `.ease(easing)`，时间参数用 `KeyframeTiming::new(ms)` 配合 `.delay(ms)`、`.easing(e)`、`.iterations(Some(n))`、`.infinite()` 和 `.direction(PlaybackDirection::…)`。

它们的播放方式与 CSS 关键帧一致：缓动作用于一段（关键帧的缓动决定从它开始的那一段，时间参数的缓动决定其余各段）；关键帧缺省的 offset 均匀分布，第一个为 0、最后一个为 1；每次迭代先跳到它的第一个关键帧，没有 offset 为 0 的关键帧时，值从当前位置出发；在 `delay` 期间，值停在第一个关键帧上（CSS `animation-fill-mode: backwards`）；反向的迭代倒着播放各段，曲线也随之反转；值停在最后一次迭代结束的位置。

```rust tabs
let y = animated_value(0.0);
y.keyframes(
    [Keyframe::new(0.0), Keyframe::at(0.3, -20.0).ease(Easing::EaseIn), Keyframe::new(0.0)],
    KeyframeTiming::new(600.0).iterations(Some(3)),
);
```

```tsx tabs
const y = createAnimatedValue(0);
y.keyframes([0, { offset: 0.3, value: -20, easing: "easeIn" }, 0], { duration: 600, iterations: 3 });
```

## createMotion

```ts
function createMotion(options?: MotionOptions): Motion;

interface MotionOptions extends MotionPlayOptions {
  initial?: { [C in MotionChannel]?: number };   // 各通道的起始值（其余处于静止状态）
  enter?: MotionName | MotionSpec;   // 从它的起点开始并立即播放
}

interface MotionPlayOptions extends KeyframeTiming {
  ignoreReduceMotion?: boolean;      // 即使用户要求减少动态效果也照常播放
}

interface Motion {
  readonly opacity: AnimatedValue;
  readonly translateX: AnimatedValue;
  readonly translateY: AnimatedValue;
  readonly rotate: AnimatedValue;    // 度
  readonly rotateX: AnimatedValue;
  readonly rotateY: AnimatedValue;
  readonly scale: AnimatedValue;
  readonly scaleX: AnimatedValue;
  readonly scaleY: AnimatedValue;
  readonly style: { opacity: AnimatedValue; transform: MotionTransform };
  readonly transform: MotionTransform;
  play(motion: MotionName | MotionSpec, options?: MotionPlayOptions): Promise<boolean>;
  animation(motion: MotionName | MotionSpec, options?: MotionPlayOptions): CompositeAnimation;
  stop(): void;
  reset(): void;
}
```

创建一个动效：为视图的不透明度和变换的每个通道各建一个动画值，处于静止状态（不透明度和缩放为 1，其余为 0），并在它们上面以原生方式播放动效。用 `style={motion.style}` 绑定，或把 `motion.style`、`motion.transform` 展开到样式中；变换先应用平移，再应用旋转，最后应用缩放，其中 `scale` 合并进 `scaleX` 和 `scaleY`：占用视图 8 个变换步骤中的 7 个，留下一个给你（3D 翻转用 `[{ perspective: 600 }, ...motion.transform]`）。`initial` 设置各通道的起始值（`{ opacity: 0 }`；其余通道从静止状态开始）。带 `enter` 时，它所移动的通道从该动效的起点开始（优先于 `initial`）并立即播放它，其余选项作为它的时间参数（`delay`、`duration`……）。动效只移动不透明度和变换：展开 `motion.style` 会设置视图的 `opacity`，想保留你自己的不透明度就只绑定 `motion.transform`；颜色用动画值和 `interpolate` 来驱动。Rust：`motion()`，一个由创建它的组件持有的 `Copy` 句柄，用 `.bind_motion(&m)` 绑定；`motion().entering(spec)` 用于入场。

| 成员 | Rust（`Motion`） | 说明 |
|---|---|---|
| `opacity`、`translateX`、... `scaleY` | `value(MotionChannel::Opacity)`、... | 各通道的动画值。 |
| `style`、`transform` | 元素上的 `.bind_motion(&m)` | 绑定。 |
| `play(motion, options?)` | `play(spec)`、`play_ignoring_reduce_motion(spec)` | 在各通道上播放按名称指定的预设或一个 [`MotionSpec`](#motions)；新的动效会打断正在播放的那个。`options` 修改它的时间参数。播放完成时以 `true` 兑现，被打断时为 `false`（Rust 中为 `AnimationEnd`）。 |
| `animation(motion, options?)` | `animation(spec)` | 同一个动效，作为尚未启动的 [`CompositeAnimation`](#animated)，用于组合：`Animated.stagger(60, cards.map((m) => m.animation("fadeInUp")), { from: "center" })`（Rust：`Animation::stagger_from(60.0, StaggerFrom::Center, cards.iter().map(\|m\| m.animation(MotionPreset::FadeInUp)))`）。是否减少动态效果在创建时决定。 |
| `stop()` | `stop()` | 停在当前位置。 |
| `reset()` | `reset()` | 停止，并把所有通道放回静止状态。 |

当用户要求减少动态效果（`reduceMotion()`）时，`play`、`animation` 和 `enter` 会立即落在动效的终点，不产生移动，除非设置了 `ignoreReduceMotion`（在选项或动效上）。

```rust tabs
let card = motion().entering(MotionPreset::FadeInUp.spec().timing(|t| t.delay(80.0)));
view().size(px(120.0)).rounded(px(16.0)).bg(rgb(0x0969da)).bind_motion(&card).on_press(move || {
    card.play(MotionPreset::Pulse);
})
```

```tsx tabs
const card = createMotion({ enter: "fadeInUp", delay: 80 });
<View onPress={() => card.play("pulse")} style={{ width: 120, height: 120, borderRadius: 16, backgroundColor: "#0969da", ...card.style }} />
```

## motions

```ts
const motions: Readonly<Record<MotionName, MotionPreset>>;

type MotionChannel = "opacity" | "translateX" | "translateY" | "rotate" | "rotateX" | "rotateY" | "scale" | "scaleX" | "scaleY";

interface MotionSpec extends KeyframeTiming {
  keyframes: { [C in MotionChannel]?: KeyframeValue[] } | MotionFrame[];
  ignoreReduceMotion?: boolean;
}
type MotionFrame = { [C in MotionChannel]?: number | string } & { offset?: number; easing?: Easing };

interface MotionPreset extends MotionSpec {
  kind: "enter" | "exit" | "attention" | "loop";
}
```

现成的动效，以数据形式提供：`motion.play("shake")` 播放的就是 `motions.shake`。`MotionName` 是以下之一：`fadeIn`、`fadeInUp`、`fadeInDown`、`fadeInLeft`、`fadeInRight`、`zoomIn`、`popIn`、`bounceIn`、`slideInUp`、`slideInDown`、`flipInX`、`flipInY`（入场）；`fadeOut`、`fadeOutUp`、`fadeOutDown`、`fadeOutLeft`、`fadeOutRight`、`zoomOut`、`popOut`、`slideOutDown`、`slideOutUp`（退场）；`shake`、`headShake`、`wiggle`、`swing`、`pulse`、`heartbeat`、`rubberBand`、`jello`、`tada`、`jump`、`flash`（吸引注意）；`spin`、`float`、`breathe`、`sway`、`bob`、`glow`（循环）。[动画](../docs/animation.md#预设)逐一介绍了它们。展开一个预设即可修改它：`motion.play({ ...motions.fadeInUp, duration: 600 })`。

`MotionSpec` 是你自己的动效：按通道写的关键帧（`{ opacity: [0, 1], translateY: [24, 0] }`），或像 Web Animations API 那样写的一组帧（`[{ opacity: 0, translateY: 24 }, { opacity: 1, translateY: 0 }]`，没有 offset 的帧按它在列表中的位置排布），再加上[关键帧的时间参数](#关键帧)。Rust：`MotionSpec::new(KeyframeTiming)` 配合 `.values(channel, values)`（均匀分布）、`.track(channel, keyframes)` 和 `.timing(|t| …)`；`MotionPreset::FadeInUp`（或 `.spec()`）是一个预设，`MotionChannel` 命名各通道。

```rust tabs
let rise = MotionSpec::new(KeyframeTiming::new(400.0))
    .values(MotionChannel::Opacity, [0.0, 1.0])
    .track(MotionChannel::TranslateY, [Keyframe::at(0.0, 24.0).ease(Easing::EaseOut), Keyframe::at(1.0, 0.0)]);
card.play(rise);
```

```tsx tabs
card.play({ duration: 400, keyframes: [{ opacity: 0, translateY: 24, easing: "easeOut" }, { opacity: 1, translateY: 0 }] });
```

## Animated

```ts
const Animated: {
  timing(value: AnimatedValue, config: { toValue: number; duration?: number; easing?: Easing; delay?: number }): CompositeAnimation;
  spring(value: AnimatedValue, config: { toValue: number; stiffness?: number; damping?: number; mass?: number; velocity?: number }): CompositeAnimation;
  decay(value: AnimatedValue, config?: { velocity?: number; deceleration?: number; clamp?: [number, number]; bounce?: number }): CompositeAnimation;
  sequence(list: CompositeAnimation[]): CompositeAnimation;
  parallel(list: CompositeAnimation[], config?: { stopTogether?: boolean }): CompositeAnimation;
  stagger(ms: number, list: CompositeAnimation[], config?: { from?: "first" | "last" | "center" | number }): CompositeAnimation;
  delay(ms: number): CompositeAnimation;
  loop(animation: CompositeAnimation, config?: { iterations?: number; resetBeforeIteration?: boolean }): CompositeAnimation;
  keyframes(value: AnimatedValue, config: KeyframeTiming & { keyframes: KeyframeValue[] }): CompositeAnimation;
  add(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  subtract(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  multiply(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  divide(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  modulo(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  diffClamp(a: AnimatedNode, min: number, max: number, options?: { snap?: boolean }): AnimatedNode;
  sampleSpring(config: SpringConfig & { from?: number }, fps?: number): number[];
  sampleDecay(config: DecayConfig & { from?: number }, fps?: number): number[];
};

interface CompositeAnimation {
  start(callback?: (result: { finished: boolean }) => void): Promise<boolean>;
  stop(): void;
  reset(): void;
}
```

`Animated` 用一个个步骤（`timing`、`spring`、`decay`、`sequence`、`parallel` 等）组合出动画。调用 `start()` 之前什么都不会运行；启动后整棵动画树都在原生侧运行，每一步在上一步结束的那一刻于 UI 线程上开始（步骤之间没有帧间隙，也不需要回到应用的代码）。Rust 用 `Animation` 组合同样的动画树。

| 函数 | Rust | 说明 |
|---|---|---|
| `timing`、`spring`、`decay` | `Animation::timing(&value, to, Timing)`、`Animation::spring(&value, to, Spring)`、`Animation::decay(&value, velocity, deceleration)` | 单个值的单个动画；选项和默认值与 [`AnimatedValue`](#animatedvalue) 的同名方法相同，目标值写作 `toValue`。 |
| `sequence(list)` | `Animation::sequence(list)` | 依次运行这些动画。 |
| `parallel(list, { stopTogether })` | `Animation::parallel(list).stop_together(…)` | 同时运行。`stopTogether`（默认 `true`）时，停止其中一个会停止全部。 |
| `stagger(ms, list, { from })` | `Animation::stagger(ms, list)`、`Animation::stagger_from(ms, StaggerFrom::Center, list)` | 并行运行，每个比前一个晚 `ms` 毫秒开始，从 `from` 开始计数：`"first"`（默认）、`"last"`、`"center"`（中间一项立即开始，其余向两侧依次展开；数量为偶数时中间两项同时开始）或一个下标（`StaggerFrom::First`、`Last`、`Center`、`Index(i)`）。 |
| `keyframes(value, { keyframes, ...timing })` | `Animation::keyframes(&value, frames, KeyframeTiming)` | 让一个值走过一组[关键帧](#关键帧)。 |
| `delay(ms)` | `Animation::delay(ms)` | 等待；常用于 `sequence` 中。 |
| `loop(animation, { iterations, resetBeforeIteration })` | `animation.looped(iterations).reset_before_iteration(…)` | 重复 `animation` `iterations` 次（默认无限次），每次运行前把值恢复到起点，除非 `resetBeforeIteration` 为 `false`。 |
| `add`、`subtract`、`multiply`、`divide`、`modulo`、`diffClamp` | 节点的方法 | 与 [`AnimatedNode`](#animatednode) 的对应方法相同，只是写成函数形式。 |
| `sampleSpring`、`sampleDecay` | `nsh_core::ui::sample_spring`、`sample_decay` | 弹簧或衰减动画逐帧的值（见 [Easing](#easing)）。 |

`CompositeAnimation`：

| 方法 | Rust（`Animation`） | 说明 |
|---|---|---|
| `start(callback?)` | `start()`，返回可 await 的 `AnimationEnd` | 运行（或再次运行）。整棵动画树只会 resolve 一次（并调用 `callback`），结果表示它是正常完成还是被停止。 |
| `stop()` | `stop()` | 停在当前位置。 |
| `reset()` | `reset()` | 停止，并把各个值恢复到启动时的值。 |

```rust tabs
let ys: Vec<AnimatedValue> = (0..4).map(|_| animated_value(0.0)).collect();
let hop = Animation::stagger(
    80.0,
    ys.iter().map(|y| {
        Animation::sequence([
            Animation::timing(y, -36.0, Timing::new(220.0, Easing::Curve(Curve::Quad, EaseMode::Out))),
            Animation::spring(y, 0.0, Spring { stiffness: 300.0, damping: 12.0, ..Spring::default() }),
        ])
    }),
);
let run = hop.start();
spawn(async move { log::info!("{}", if run.await { "done" } else { "stopped" }) });
```

```tsx tabs
const ys = [0, 1, 2, 3].map(() => createAnimatedValue(0));
const hop = Animated.stagger(
  80,
  ys.map((y) =>
    Animated.sequence([
      Animated.timing(y, { toValue: -36, duration: 220, easing: Easing.out(Easing.quad) }),
      Animated.spring(y, { toValue: 0, stiffness: 300, damping: 12 }),
    ]),
  ),
);
hop.start(({ finished }) => console.log(finished ? "done" : "stopped"));
```

## Easing

```ts
type Easing =
  | "linear" | "ease" | "easeIn" | "easeOut" | "easeInOut"
  | [number, number, number, number]   // 三次贝塞尔曲线 x1, y1, x2, y2
  | EasingCurve
  | EasingSteps;                     // Easing.steps(…)

const Easing: {
  linear: Easing;
  ease: Easing;
  bezier(x1: number, y1: number, x2: number, y2: number): Easing;
  steps(count: number, position?: "jump-start" | "jump-end" | "jump-none" | "jump-both" | "start" | "end"): EasingSteps;
  in(e: Easing): Easing;
  out(e: Easing): Easing;
  inOut(e: Easing): Easing;
  sample(easing: Easing, count: number): number[];
  quad: EasingCurve;
  cubic: EasingCurve;
  poly(n?: number): EasingCurve;
  sin: EasingCurve;
  circle: EasingCurve;
  exp: EasingCurve;
  elastic(bounciness?: number): EasingCurve;
  back(s?: number): EasingCurve;
  bounce: EasingCurve;
};
```

缓动是数据而不是应用的函数：运行时在原生侧对它求值。在 Rust 中它是枚举 `Easing`：`Linear`、`EaseIn`、`EaseOut`、`EaseInOut`、`Bezier(x1, y1, x2, y2)`、`Steps(count, StepPosition)` 和 `Curve(curve, mode)`，其中 `Curve` 为 `Quad`、`Cubic`、`Poly(n)`、`Sin`、`Circle`、`Exp`、`Elastic(bounciness)`、`Back(s)`、`Bounce`，`EaseMode` 为 `In`、`Out`、`InOut`。要绘制一条缓动曲线，`Easing.sample(easing, count)`（Rust：`nsh_core::ui::sample_easing`）给出它在 0 到 1 之间 `count` 个等距点上的值；`Animated.sampleSpring` 和 `Animated.sampleDecay`（`sample_spring`、`sample_decay`）从 `from`（0）开始逐帧给出弹簧或衰减动画的值（按 `fps`，默认 60），直到结束。三者都来自动画实际运行的原生代码。在 TSX 中凡是接受 `Easing` 的地方，都可以传入名称（`"easeOut"`）、由四个数字表示的三次贝塞尔曲线，或 `Easing` 对象中的曲线。

| 曲线 | Rust | 形状 |
|---|---|---|
| `quad` | `Curve::Quad` | `t²` |
| `cubic` | `Curve::Cubic` | `t³` |
| `poly(n)` | `Curve::Poly(n)` | `tⁿ`（`n` 默认为 2） |
| `sin` | `Curve::Sin` | 正弦 |
| `circle` | `Curve::Circle` | 圆形 |
| `exp` | `Curve::Exp` | 指数 |
| `elastic(bounciness)` | `Curve::Elastic(bounciness)` | 弹性过冲（`bounciness` 默认为 1） |
| `back(s)` | `Curve::Back(s)` | 先回拉再前进；`s` 为过冲量（默认 1.70158） |
| `bounce` | `Curve::Bounce` | 在结尾弹跳 |

`Easing.steps(count, position)` 即 CSS 的 `steps()`：值在 `count` 个级别之间跳变而不连续移动（逐帧的精灵图、跳动的指针）。`position` 决定跳变落在哪里：`"jump-end"`（默认，也可写 `"end"`）、`"jump-start"`（`"start"`）、`"jump-none"` 或 `"jump-both"`；Rust：`Easing::Steps(count, StepPosition::JumpEnd)`、`JumpStart`、`JumpNone`、`JumpBoth`。

这些曲线都是“in”形式（开始时慢）。`Easing.out(curve)` 把它反转，`Easing.inOut(curve)` 让它对称，`Easing.in(curve)` 保持原样；在 Rust 中这就是 `Easing::Curve` 的 `EaseMode`。

```rust tabs
let _ = value.timing(1.0, 600.0, Easing::Curve(Curve::Back(1.70158), EaseMode::Out));
let _ = value.timing_with(1.0, Timing { easing: Easing::Bezier(0.2, 0.0, 0.0, 1.0), ..Timing::default() });
let _ = value.timing_with(1.0, Timing { easing: Easing::EaseOut, ..Timing::default() });
```

```tsx tabs
value.timing(1, { duration: 600, easing: Easing.out(Easing.back()) });
value.timing(1, { easing: Easing.bezier(0.2, 0, 0, 1) });
value.timing(1, { easing: "easeOut" });
```

## LayoutAnimation

```ts
const LayoutAnimation: {
  configureNext(config: LayoutAnimationConfig, onEnd?: () => void): void;
  create(duration: number, type?: LayoutAnimationType, property?: LayoutAnimationProperty): LayoutAnimationConfig;
  Types: { easeInEaseOut; spring; linear; easeIn; easeOut; keyboard };
  Properties: { opacity; scaleXY };
  Presets: { easeInEaseOut: LayoutAnimationConfig; linear: LayoutAnimationConfig; spring: LayoutAnimationConfig };
  easeInEaseOut(onEnd?: () => void): void;
  linear(onEnd?: () => void): void;
  spring(onEnd?: () => void): void;
};

interface LayoutAnimationConfig {
  duration: number;                // 毫秒
  create?: LayoutAnimationAnimation;    // 插入的视图
  update?: LayoutAnimationAnimation;    // 移动或改变尺寸的视图
  delete?: LayoutAnimationAnimation;    // 移除的视图
}

interface LayoutAnimationAnimation {
  type?: "easeInEaseOut" | "spring" | "linear" | "easeIn" | "easeOut" | "keyboard";
  property?: "opacity" | "scaleXY" | "scale";
  duration?: number;
  delay?: number;
  springDamping?: number;          // 0..1，默认 0.7
}
```

`LayoutAnimation.configureNext(config)` 在原生侧为下一次提交中的布局变化添加动画：移动或改变尺寸的视图平滑过渡到新位置，新视图出现（按 `property` 淡入或缩放进入），被移除的视图消失。在会改变布局的状态变化之前调用它。Rust：`animate_layout(LayoutAnimation)`，使用 `nsh_core::ui::LayoutAnimation` 的预设或它的 `create`、`update`、`delete` 过渡。

| 成员 | Rust | 说明 |
|---|---|---|
| `configureNext(config, onEnd?)` | `animate_layout(config)` | 为下一次提交的变化添加动画；结束时调用 `onEnd`。 |
| `create(duration, type?, property?)` | `LayoutAnimation::all(LayoutTransition::new(curve, duration))` | 三个阶段使用同一条曲线的配置。 |
| `Presets.easeInEaseOut` | `LayoutAnimation::EASE_IN_EASE_OUT` | 300 毫秒，视图淡入淡出。 |
| `Presets.linear` | `LayoutAnimation::LINEAR` | 500 毫秒，匀速。 |
| `Presets.spring` | `LayoutAnimation::SPRING` | 700 毫秒；位置以弹簧效果变化（阻尼 0.4），视图线性淡入淡出。 |
| `easeInEaseOut(onEnd?)`、`linear(onEnd?)`、`spring(onEnd?)` | `animate_layout(LayoutAnimation::…)` | `configureNext(Presets.…)` 的简写。 |
| `Types`、`Properties` | `LayoutCurve`、`LayoutProperty` | 这些名称的常量形式。 |

```rust tabs
let open = signal(false);
let toggle = move || {
    animate_layout(LayoutAnimation::SPRING);
    open.update(|o| *o = !*o);
};

view()
    .child(text("Details").on_press(toggle))
    .child(when(move || open.get(), || text("Shown with a spring.")))
```

```tsx tabs
const open = signal(false);
const toggle = () => {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
  open.update((o) => !o);
};

<View>
  <Text onPress={toggle}>Details</Text>
  <If when={open()}>
    <Text>Shown with a spring.</Text>
  </If>
</View>
```

---
title: nsh/animated
description: Animated values, animation drivers, keyframes, motions and their presets, composed animations, easings and layout animation.
order: 3
demo: mod-animated
---

# nsh/animated

The animation API animates on the UI thread. You create an **animated value**, bind it (or values derived from it) to a style property, and start an animation; from then on every frame is computed natively, without running the app's code. A busy engine or JS thread cannot make the animation stutter, and an animation costs the app no work per frame. Rust code uses `animated_value()`, `motion()`, `Animation`, `Spring`, `Timing`, `KeyframeTiming`, `MotionPreset` and `Easing` from `nsh_core::ui::prelude` and binds values with the `.bind_*` methods of elements; TSX imports `nsh/animated`.

```rust tabs
use nsh_core::ui::{LayoutAnimation, prelude::*}; // animated_value, motion, Animation, Spring, Timing, Keyframe, KeyframeTiming, MotionPreset, MotionSpec, Easing, animate_layout
```

```tsx tabs
import { Animated, createAnimatedValue, createMotion, motions, Easing, LayoutAnimation, AnimatedNode, AnimatedValue } from "nsh/animated";
```

See [Animation](../docs/animation.md) for the guide.

## What an animated value can drive

| Where | Rust | TSX |
|---|---|---|
| `opacity` | `.bind_opacity(&value)` | `style={{ opacity: value }}` |
| `backgroundColor` | `.bind_background(&value.interpolate_colors(&[0.0, 1.0], &[white(), black()]))` | `style={{ backgroundColor: value.interpolate({ inputRange: [0, 1], outputRange: ["#fff", "#000"] }) }}` |
| `borderColor`, `color` | `.bind_border_color(&node)`, `.bind_color(&node)` | The same: a node of colors. `borderColor` colors every side; a `Text`'s `color` colors the whole text |
| `shadowColor`, `shadowOpacity`, `shadowRadius` | `.bind_shadow_color(&node)`, `.bind_shadow_opacity(&value)`, `.bind_shadow_radius(&value)` | `style={{ shadowOpacity: value }}` (a node of colors for `shadowColor`) |
| `transform` | `.bind_translate_x(&value)`, `.bind_translate_y`, `.bind_scale`, `.bind_rotate` (degrees) | `translateX`, `translateY`, `scale`, `scaleX`, `scaleY`, `rotate`, `rotateX`, `rotateY`, `rotateZ` steps: `transform: [{ translateX: value }]` |
| Scroll position | `.scroll_value(&value)` on a scroll view or a list | `<Scroll scrollValue={value}>` and `<List scrollValue={value}>` write the scroll offset into it each frame |
| Gestures | `.pan_values(Some(&x), Some(&y))`, `.pinch_value(&scale)`, `.rotation_value(&angle)` | `pan={{ x, y }}`, `pinch={{ scale }}`, `rotation={{ angle }}` on any element: the gesture writes the values directly (see [Touch and gestures](../docs/touch-and-gestures.md)) |
| Where views stick | `.sticky().bind_sticky_top(&value)` (`.bind_sticky_left` in a horizontal scroll view), `.bind_sticky_header_offset(&value)` on a list | `style={{ position: "sticky", top: value }}`, `<List stickyHeaderOffset={value}>`: sticky views and headers stick that far from the start of the viewport, following the value every frame |
| Canvas | an animated argument of a painter's call | Any number or color argument of a [canvas](./nsh-canvas.md) drawing call |

Other style properties take plain values; to animate the layout itself (sizes, positions in the flow), use [`LayoutAnimation`](#layoutanimation).

## createAnimatedValue

```ts
function createAnimatedValue(value?: number): AnimatedValue;
```

Creates an animated value starting at `value` (default `0`). Rust: `animated_value(value)`, a `Copy` handle kept by the component that made it.

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
> An animated value lives on the UI thread and changes there every frame, so the app reads it asynchronously: `await value.getValue()` (or the promise `stop()` returns) gives the value at that moment, and in Rust `value.value().await` in a task. Keep the target in a variable or a signal when your code needs it right away, as above. Gesture events report the values at their end (`PanEvent.valueX` / `valueY`).

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

| Method | Rust | Description |
|---|---|---|
| `set(value)` | `set(value)` | Jumps to `value`, stopping any running animation. |
| `stop()` | `stop()`, then `value().await` | Stops the running animation where it is; resolves with the value there. |
| `getValue()` | `value().await` | Resolves with the current value (with its offset), read on the UI thread. |
| `setOffset(offset)` | `set_offset(offset)` | An offset added to the value: bindings see value + offset; `set`, animations and drags move the value. |
| `flattenOffset()` | `flatten_offset()` | Adds the offset to the value and makes it 0. |
| `extractOffset()` | `extract_offset()` | Moves the value into the offset and makes the value 0 (a drag then starts from where the last one ended). |
| `timing(to, options)` | `timing(to, ms, easing)`, `timing_with(to, Timing { … })` | Animates to `to` along an easing curve. `duration` in ms (default 300), `easing` (default `"easeInOut"`), `delay` in ms (default 0). |
| `spring(to, options)` | `spring(to, Spring { … })` | Springs to `to`. `stiffness` (default 170), `damping` (default 26), `mass` (default 1), `velocity` (initial velocity, units per second). |
| `decay(options)` | `decay(velocity, deceleration)`, `decay_within(velocity, deceleration, (min, max), bounce)` | Coasts from `velocity` (units per second) and slows down by `deceleration` per millisecond (default 0.998). Use it after a fling, with the velocity from `onPanEnd`. With `clamp: [min, max]` it stops at a bound, or bounces back from it keeping `bounce` (0..1, default 0) of its speed. |
| `keyframes(frames, options)` | `keyframes(frames, KeyframeTiming)` | Plays [keyframes](#keyframes) as CSS keyframes play: an easing per segment, `iterations` times in `direction`. |

Each animation method returns a promise that resolves with `true` when the animation finished and `false` when it was stopped (by `stop`, `set` or another animation of the same value). In Rust it returns an `AnimationEnd`, which a task awaits for the same `bool`.

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

A node of the native animation graph: a `AnimatedValue`, or a value derived from others. Derived nodes are evaluated on the UI thread whenever their inputs change.

| Method | Rust | Description |
|---|---|---|
| `interpolate(config)` | `interpolate(&input, &output)`, `interpolate_colors(&input, &colors)`, `interpolate_with(&input, output, Interpolation { … })` | Maps the input through piecewise ranges. `outputRange` holds numbers, colors (`"#ff0000"`, `"rgba(…)"`) or angles (`"45deg"`, `"1rad"`). Outside `inputRange` it clamps by default; `extrapolate` (or `extrapolateLeft` / `extrapolateRight`) can be `"extend"` (continue the line), `"clamp"` or `"identity"` (pass the input through). `easing` shapes each segment. Rust takes numbers, theme colors (which follow the appearance) and angles as degrees for `bind_rotate`. |
| `diffClamp(min, max, options?)` | `diff_clamp(min, max)`, `diff_clamp_with(min, max, DiffClamp::snapping())` | Follows the input's changes but keeps the result within `min..max`: a header that hides while content scrolls up and comes back as soon as it scrolls down. `snap: true` settles it at the nearer bound in 200 ms when its scroll view comes to rest, at `max` only once the input reached `max`. |
| `add`, `sub`, `mul`, `div` | `add`, `sub`, `mul`, `div` | Arithmetic with another node or a constant. |
| `mod(b)` | `modulo(b)` | Modulo, never negative for a positive `b` (keeping angles in 0..360). |

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
let rotate = progress.interpolate(&[0.0, 1.0], &[0.0, 360.0]); // degrees, for bind_rotate
let color = progress.interpolate_colors(&[0.0, 0.5, 1.0], &[rgb(0x22c55e), rgb(0xeab308), rgb(0xef4444)]);
```

```tsx tabs
const progress = createAnimatedValue(0);
const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
const color = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: ["#22c55e", "#eab308", "#ef4444"] });
```

## Keyframes

```ts
interface Keyframe {
  offset?: number;          // 0..1 of an iteration; missing offsets spread evenly
  value: number | string;   // a number, or an angle ("45deg", "0.5turn") in degrees
  easing?: Easing;          // the segment that starts here
}
type KeyframeValue = number | string | Keyframe;

interface KeyframeTiming {
  duration?: number;        // one iteration, ms (300)
  delay?: number;           // before the first iteration, ms (0)
  easing?: Easing;          // segments without their own (CSS "ease")
  iterations?: number | "infinite";   // 1
  direction?: "normal" | "reverse" | "alternate" | "alternate-reverse";
}
```

`value.keyframes(frames, options)` plays a value through keyframes and resolves with whether they finished; `Animated.keyframes(value, { keyframes, ...options })` is the same as a step of a composite. Rust: `value.keyframes(frames, KeyframeTiming)` and `Animation::keyframes(&value, frames, KeyframeTiming)`, with `Keyframe::new(value)` (spread evenly), `Keyframe::at(offset, value)` and `.ease(easing)`, and `KeyframeTiming::new(ms)` with `.delay(ms)`, `.easing(e)`, `.iterations(Some(n))`, `.infinite()` and `.direction(PlaybackDirection::…)`.

They play as CSS keyframes play: an easing shapes one segment (a keyframe's the segment that starts at it, the timing's every other one); offsets missing from keyframes spread evenly, the first at 0 and the last at 1; each iteration starts with a jump to its first keyframe, and without a keyframe at 0 the value goes from where it is; during a `delay` the value holds the first keyframe (CSS `animation-fill-mode: backwards`); backward iterations run the segments backwards with their curves reversed; the value stays where the last iteration leaves it.

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
  initial?: { [C in MotionChannel]?: number };   // where channels start (the others at rest)
  enter?: MotionName | MotionSpec;   // start where it starts and play it at once
}

interface MotionPlayOptions extends KeyframeTiming {
  ignoreReduceMotion?: boolean;      // play even when the user asks for less motion
}

interface Motion {
  readonly opacity: AnimatedValue;
  readonly translateX: AnimatedValue;
  readonly translateY: AnimatedValue;
  readonly rotate: AnimatedValue;    // degrees
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

Creates a motion: an animated value for each channel of a view's opacity and transform, at rest (opacity and scales 1, the others 0), and motions to play on them natively. Bind it with `style={motion.style}`, or spread `motion.style` or `motion.transform` into a style; the transform applies its translations, then its rotations, then its scales, with `scale` folded into `scaleX` and `scaleY`: 7 of a view's 8 transform steps, which leaves one for yours (`[{ perspective: 600 }, ...motion.transform]` for 3D flips). `initial` sets where channels start (`{ opacity: 0 }`; the others start at rest). With `enter`, the channels it moves start where that motion starts (over `initial`) and it plays at once, with the other options as its timing (`delay`, `duration`, ...). A motion moves opacity and transform only: spreading `motion.style` sets the view's `opacity`, so bind only `motion.transform` to keep an opacity of your own, and move colors with an animated value and `interpolate`. Rust: `motion()`, a `Copy` handle kept by the component that made it, bound with `.bind_motion(&m)`; `motion().entering(spec)` enters.

| Member | Rust (`Motion`) | Description |
|---|---|---|
| `opacity`, `translateX`, ... `scaleY` | `value(MotionChannel::Opacity)`, ... | The channels' animated values. |
| `style`, `transform` | `.bind_motion(&m)` on the element | The bindings. |
| `play(motion, options?)` | `play(spec)`, `play_ignoring_reduce_motion(spec)` | Plays a preset by name or a [`MotionSpec`](#motions) on the channels; a new one interrupts the one playing. `options` change its timing. Resolves with `true` when it finished, `false` when something stopped it (`AnimationEnd` in Rust). |
| `animation(motion, options?)` | `animation(spec)` | The same motion as a [`CompositeAnimation`](#animated), not started, to compose: `Animated.stagger(60, cards.map((m) => m.animation("fadeInUp")), { from: "center" })` (Rust: `Animation::stagger_from(60.0, StaggerFrom::Center, cards.iter().map(\|m\| m.animation(MotionPreset::FadeInUp)))`). Reduced motion is decided when it is made. |
| `stop()` | `stop()` | Stops it where it is. |
| `reset()` | `reset()` | Stops it and puts every channel back at rest. |

When the user asks for less motion (`reduceMotion()`), `play`, `animation` and `enter` land where the motion ends at once, without moving, unless `ignoreReduceMotion` is set (on the options or the motion).

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

The ready-made motions as data: `motion.play("shake")` plays `motions.shake`. `MotionName` is one of `fadeIn`, `fadeInUp`, `fadeInDown`, `fadeInLeft`, `fadeInRight`, `zoomIn`, `popIn`, `bounceIn`, `slideInUp`, `slideInDown`, `flipInX`, `flipInY` (enter); `fadeOut`, `fadeOutUp`, `fadeOutDown`, `fadeOutLeft`, `fadeOutRight`, `zoomOut`, `popOut`, `slideOutDown`, `slideOutUp` (exit); `shake`, `headShake`, `wiggle`, `swing`, `pulse`, `heartbeat`, `rubberBand`, `jello`, `tada`, `jump`, `flash` (attention); `spin`, `float`, `breathe`, `sway`, `bob`, `glow` (loop). [Animation](../docs/animation.md#presets) describes each one. Spread a preset to change it: `motion.play({ ...motions.fadeInUp, duration: 600 })`.

A `MotionSpec` is a motion of your own: each channel's keyframes (`{ opacity: [0, 1], translateY: [24, 0] }`), or a list of frames as the Web Animations API writes them (`[{ opacity: 0, translateY: 24 }, { opacity: 1, translateY: 0 }]`, a frame without an offset placed by its position in the list), with the [keyframe timing](#keyframes). Rust: `MotionSpec::new(KeyframeTiming)` with `.values(channel, values)` (spread evenly), `.track(channel, keyframes)` and `.timing(|t| …)`; `MotionPreset::FadeInUp` (or `.spec()`) is a preset, and `MotionChannel` names the channels.

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

`Animated` builds animations out of steps (`timing`, `spring`, `decay`, `sequence`, `parallel`, ...). Nothing runs until `start()`; then the whole tree runs natively, and each step starts on the UI thread at the exact moment the previous one ends (no frame gap, no round trip to the app's code between steps). Rust builds the same tree with `Animation`.

| Function | Rust | Description |
|---|---|---|
| `timing`, `spring`, `decay` | `Animation::timing(&value, to, Timing)`, `Animation::spring(&value, to, Spring)`, `Animation::decay(&value, velocity, deceleration)` | One animation of one value; same options and defaults as the [`AnimatedValue`](#animatedvalue) methods, with the target as `toValue`. |
| `sequence(list)` | `Animation::sequence(list)` | Runs the animations one after another. |
| `parallel(list, { stopTogether })` | `Animation::parallel(list).stop_together(…)` | Runs them at the same time. With `stopTogether` (default `true`), stopping one stops all. |
| `stagger(ms, list, { from })` | `Animation::stagger(ms, list)`, `Animation::stagger_from(ms, StaggerFrom::Center, list)` | Runs them in parallel, each starting `ms` after the previous one, counted from `from`: `"first"` (default), `"last"`, `"center"` (the middle starts at once, the others spread out from it; with an even count both middle items start at once) or an index (`StaggerFrom::First`, `Last`, `Center`, `Index(i)`). |
| `keyframes(value, { keyframes, ...timing })` | `Animation::keyframes(&value, frames, KeyframeTiming)` | A value through [keyframes](#keyframes). |
| `delay(ms)` | `Animation::delay(ms)` | Waits; useful inside `sequence`. |
| `loop(animation, { iterations, resetBeforeIteration })` | `animation.looped(iterations).reset_before_iteration(…)` | Repeats `animation` `iterations` times (forever by default), putting its values back before each run unless `resetBeforeIteration` is `false`. |
| `add`, `subtract`, `multiply`, `divide`, `modulo`, `diffClamp` | the node methods | The same as the [`AnimatedNode`](#animatednode) methods, as functions. |
| `sampleSpring`, `sampleDecay` | `nsh_core::ui::sample_spring`, `sample_decay` | A spring's or decay's values one per frame (see [Easing](#easing)). |

`CompositeAnimation`:

| Method | Rust (`Animation`) | Description |
|---|---|---|
| `start(callback?)` | `start()`, an `AnimationEnd` to await | Runs it (again). Resolves, and calls `callback`, once for the whole tree with whether it finished rather than being stopped. |
| `stop()` | `stop()` | Stops it where it is. |
| `reset()` | `reset()` | Stops it and puts its values back where they were when it started. |

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
  | [number, number, number, number]   // cubic Bézier x1, y1, x2, y2
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

An easing is data, not a function of the app's: the runtime evaluates it natively. In Rust it is the enum `Easing`: `Linear`, `EaseIn`, `EaseOut`, `EaseInOut`, `Bezier(x1, y1, x2, y2)`, `Steps(count, StepPosition)` and `Curve(curve, mode)`, with a `Curve` (`Quad`, `Cubic`, `Poly(n)`, `Sin`, `Circle`, `Exp`, `Elastic(bounciness)`, `Back(s)`, `Bounce`) and an `EaseMode` (`In`, `Out`, `InOut`). To draw one, `Easing.sample(easing, count)` (Rust: `nsh_core::ui::sample_easing`) gives its values at `count` evenly spaced points from 0 to 1; `Animated.sampleSpring` and `Animated.sampleDecay` (`sample_spring`, `sample_decay`) give a spring's or decay's values one per frame (at `fps`, 60 by default) from `from` (0) until it ends. All three come from the native code the animations run. Wherever an `Easing` is accepted in TSX you can pass a name (`"easeOut"`), a cubic Bézier as four numbers, or a curve from the `Easing` object.

| Curve | Rust | Shape |
|---|---|---|
| `quad` | `Curve::Quad` | `t²` |
| `cubic` | `Curve::Cubic` | `t³` |
| `poly(n)` | `Curve::Poly(n)` | `tⁿ` (`n` defaults to 2) |
| `sin` | `Curve::Sin` | Sinusoidal |
| `circle` | `Curve::Circle` | Circular |
| `exp` | `Curve::Exp` | Exponential |
| `elastic(bounciness)` | `Curve::Elastic(bounciness)` | Springy overshoot (`bounciness` defaults to 1) |
| `back(s)` | `Curve::Back(s)` | Pulls back before going; `s` is the overshoot (default 1.70158) |
| `bounce` | `Curve::Bounce` | Bounces at the end |

`Easing.steps(count, position)` is CSS `steps()`: the value jumps between `count` levels instead of moving (a frame-by-frame sprite, a ticking hand). `position` says where the jumps fall: `"jump-end"` (the default, also `"end"`), `"jump-start"` (`"start"`), `"jump-none"` or `"jump-both"`; Rust: `Easing::Steps(count, StepPosition::JumpEnd)`, `JumpStart`, `JumpNone`, `JumpBoth`.

The curves are in their "in" form (slow at the start). `Easing.out(curve)` reverses one, `Easing.inOut(curve)` makes it symmetric, `Easing.in(curve)` keeps it as is; in Rust that is the `EaseMode` of `Easing::Curve`.

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
  duration: number;                // ms
  create?: LayoutAnimationAnimation;    // views inserted
  update?: LayoutAnimationAnimation;    // views moved or resized
  delete?: LayoutAnimationAnimation;    // views removed
}

interface LayoutAnimationAnimation {
  type?: "easeInEaseOut" | "spring" | "linear" | "easeIn" | "easeOut" | "keyboard";
  property?: "opacity" | "scaleXY" | "scale";
  duration?: number;
  delay?: number;
  springDamping?: number;          // 0..1, default 0.7
}
```

`LayoutAnimation.configureNext(config)` animates the layout changes of the next commit natively: views that move or resize glide to their new frames, new views appear (fading or scaling in, by `property`) and removed views disappear. Call it right before the state change that changes the layout. Rust: `animate_layout(LayoutAnimation)`, with `nsh_core::ui::LayoutAnimation`'s presets or its `create`, `update` and `delete` transitions.

| Member | Rust | Description |
|---|---|---|
| `configureNext(config, onEnd?)` | `animate_layout(config)` | Animates the next commit's changes; `onEnd` runs when done. |
| `create(duration, type?, property?)` | `LayoutAnimation::all(LayoutTransition::new(curve, duration))` | A config using the same curve for all three phases. |
| `Presets.easeInEaseOut` | `LayoutAnimation::EASE_IN_EASE_OUT` | 300 ms, views fading in and out. |
| `Presets.linear` | `LayoutAnimation::LINEAR` | 500 ms at constant speed. |
| `Presets.spring` | `LayoutAnimation::SPRING` | 700 ms; frames spring (damping 0.4), views fade linearly. |
| `easeInEaseOut(onEnd?)`, `linear(onEnd?)`, `spring(onEnd?)` | `animate_layout(LayoutAnimation::…)` | Shorthands for `configureNext(Presets.…)`. |
| `Types`, `Properties` | `LayoutCurve`, `LayoutProperty` | The names, as constants. |

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

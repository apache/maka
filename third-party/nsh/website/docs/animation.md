---
title: Animation
description: Motions (ready-made entrances, exits, attention seekers and loops, or your own keyframes), style transitions and keyframe animations, animated values with timing, spring, decay and keyframes, interpolation, composite animations, easing, layout animations, and what runs on the UI thread, in Rust and TSX.
order: 43
group: ui
demo: guide-animation
---

# Animation

Every animation in NSH runs on the UI thread. You describe it once, from Rust or TSX, and the platform plays it frame by frame (Core Animation and a display link on iOS, the UI-thread animator on Android) without calling back into your code. A busy engine thread cannot make an animation stutter, and an animation costs none of your code while it runs.

There are six tools, from the readiest to the most flexible:

| Tool | Use it for |
|---|---|
| [Motion](#motion) | A view that enters, leaves, draws the eye or loops: ready-made motions (`fadeInUp`, `shake`, `pulse`, ...) or keyframes of your own, on its opacity and transform. |
| [Transitions](#transitions) | A style change that should animate instead of jump: a color, an opacity, a transform. |
| [Keyframe animations](#keyframe-animations) | A spinner, a pulsing placeholder, a bouncing hint. |
| [Keyframes](#keyframes) | Any animated value through keyframes, as CSS plays them: offsets, an easing per segment, iterations and a direction. |
| [Animated values](#animated-values) | Anything driven by a value over time: springs, gestures, scroll position, sequences. |
| [Layout animations](#layoutanimation) | Size and position changes after an update: items inserted, removed, reordered, a panel expanding. |

## Motion

A motion moves a view's opacity and transform through keyframes, natively. Create one in the component that owns the view (`motion()` in Rust, `createMotion()` from `nsh` in TSX), bind it to the view, and play a ready-made motion or one of your own on it. `enter` starts the view where a motion begins and plays it at once, so the view comes in from its first frame.

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    let card = motion().entering(MotionPreset::FadeInUp);
    view().flex_1().items_center().justify_center().child(
        view()
            .size(px(120.0))
            .rounded(px(16.0))
            .bg(rgb(0x0969da))
            .bind_motion(&card)
            .on_press(move || {
                card.play(MotionPreset::Shake);
            }),
    )
}
```

```tsx tabs
import { mount, View } from "nsh";
import { createMotion } from "nsh";

function App() {
  const card = createMotion({ enter: "fadeInUp" });
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <View
        onPress={() => card.play("shake")}
        style={{ width: 120, height: 120, borderRadius: 16, backgroundColor: "#0969da", ...card.style }}
      />
    </View>
  );
}

mount(App);
```

A motion has an animated value per channel: `opacity` (0..1), `translateX` and `translateY` (points), `rotate`, `rotateX` and `rotateY` (degrees), `scale`, `scaleX` and `scaleY`. They start at rest (opacity and scales 1, the rest 0) and apply in that order: translations, then rotations, then scales, about the view's transform origin. A motion has no look of its own: it moves what you styled.

A motion moves opacity and transform only. Spreading `m.style` sets the view's `opacity`; to keep an opacity of your own, bind only the transform (`transform: m.transform`). Colors move with an animated value and [`interpolate`](#interpolation).

| TSX | Rust | Description |
|---|---|---|
| `createMotion(options?)` | `motion()` | A motion with every channel at rest. |
| `createMotion({ initial: { opacity: 0 } })` | `m.value(MotionChannel::Opacity).set(0.0)` | Where channels start; the others start at rest. |
| `createMotion({ enter, delay, duration, ... })` | `motion().entering(spec)` | Starts where `enter` starts and plays it at once; the other options change its timing. `enter` sets the channels it moves, over `initial`. |
| `style={m.style}`, `m.transform` | `.bind_motion(&m)` | Binds the channels: `m.style` is `{ opacity, transform }`; spread `m.transform` into a transform with a step of your own. A motion takes 7 of a view's 8 transform steps (`scale` is folded into `scaleX` and `scaleY`), which leaves one for yours, such as `[{ perspective: 600 }, ...m.transform]` for 3D flips. In Rust the motion's transform applies after the view's own. |
| `m.opacity`, `m.translateX`, ... | `m.value(MotionChannel::Opacity)`, ... | One channel's animated value, to interpolate or drive by hand. |
| `m.play(motion, options?)` | `m.play(spec)` | Plays a preset or a motion of your own; a new one interrupts the one playing. Resolves with `true` when it finished (`AnimationEnd` in Rust). |
| `m.animation(motion, options?)` | `m.animation(spec)` | The same motion as a [composite animation](#composite-animations), not started, to sequence, stagger or loop with others. |
| `play(motion, { ignoreReduceMotion: true })` | `m.play_ignoring_reduce_motion(spec)` | Plays it even when the user asks for less motion. |
| `m.stop()` | `m.stop()` | Stops it where it is. |
| `m.reset()` | `m.reset()` | Stops it and puts every channel back at rest. |

### Presets

The ready-made motions are data: `motions` from `nsh` (`motions.fadeInUp` is what `play("fadeInUp")` plays) and `MotionPreset` in Rust (`MotionPreset::FadeInUp.spec()`). Distances are in points, sized for controls and cards; for larger views, scale a motion's values or write your own keyframes. `swing` and the other rotations turn about the view's transform origin: give a swinging sign `transformOrigin: "top"` (`.origin_top()`).

**Enter**: they start hidden or away and end at rest.

| TSX | Rust | Duration | Description |
|---|---|---|---|
| `fadeIn` | `MotionPreset::FadeIn` | 300 ms | Fades in. |
| `fadeInUp` | `MotionPreset::FadeInUp` | 450 ms | Fades in, rising into place. |
| `fadeInDown` | `MotionPreset::FadeInDown` | 450 ms | Fades in, dropping into place. |
| `fadeInLeft` | `MotionPreset::FadeInLeft` | 450 ms | Fades in, coming from the left. |
| `fadeInRight` | `MotionPreset::FadeInRight` | 450 ms | Fades in, coming from the right. |
| `zoomIn` | `MotionPreset::ZoomIn` | 350 ms | Fades in, growing from 90 %. |
| `popIn` | `MotionPreset::PopIn` | 450 ms | Pops in: grows from half its size past its own and settles. |
| `bounceIn` | `MotionPreset::BounceIn` | 650 ms | Bounces in, overshooting twice. |
| `slideInUp` | `MotionPreset::SlideInUp` | 400 ms | Slides up from below, unfaded (sheets, toasts). |
| `slideInDown` | `MotionPreset::SlideInDown` | 400 ms | Slides down from above, unfaded. |
| `flipInX` | `MotionPreset::FlipInX` | 600 ms | Flips in about its horizontal axis. |
| `flipInY` | `MotionPreset::FlipInY` | 600 ms | Flips in about its vertical axis. |

**Exit**: they start at rest and end hidden or away.

| TSX | Rust | Duration | Description |
|---|---|---|---|
| `fadeOut` | `MotionPreset::FadeOut` | 250 ms | Fades out. |
| `fadeOutUp` | `MotionPreset::FadeOutUp` | 300 ms | Fades out, rising away. |
| `fadeOutDown` | `MotionPreset::FadeOutDown` | 300 ms | Fades out, dropping away. |
| `fadeOutLeft` | `MotionPreset::FadeOutLeft` | 300 ms | Fades out to the left. |
| `fadeOutRight` | `MotionPreset::FadeOutRight` | 300 ms | Fades out to the right. |
| `zoomOut` | `MotionPreset::ZoomOut` | 250 ms | Fades out, shrinking to 90 %. |
| `popOut` | `MotionPreset::PopOut` | 300 ms | Pops out: swells a little, then shrinks away. |
| `slideOutDown` | `MotionPreset::SlideOutDown` | 300 ms | Slides down out of view, unfaded. |
| `slideOutUp` | `MotionPreset::SlideOutUp` | 300 ms | Slides up out of view, unfaded. |

**Attention**: they start and end at rest.

| TSX | Rust | Duration | Description |
|---|---|---|---|
| `shake` | `MotionPreset::Shake` | 500 ms | Shakes sideways: a wrong password, an invalid field. |
| `headShake` | `MotionPreset::HeadShake` | 800 ms | Shakes its head: a gentler no. |
| `wiggle` | `MotionPreset::Wiggle` | 600 ms | Wiggles about its center: something to notice. |
| `swing` | `MotionPreset::Swing` | 900 ms | Swings from its top edge, like a sign. |
| `pulse` | `MotionPreset::Pulse` | 500 ms | Grows a little and back: a soft emphasis. |
| `heartbeat` | `MotionPreset::Heartbeat` | 900 ms | Beats twice, like a heart: a like, a favorite. |
| `rubberBand` | `MotionPreset::RubberBand` | 800 ms | Squashes and stretches like rubber. |
| `jello` | `MotionPreset::Jello` | 800 ms | Wobbles like jelly. |
| `tada` | `MotionPreset::Tada` | 900 ms | Shrinks, then grows with a wiggle: a reward. |
| `jump` | `MotionPreset::Jump` | 700 ms | Jumps and lands with a squash. |
| `flash` | `MotionPreset::Flash` | 800 ms | Blinks out and in twice. |

**Loop**: they repeat until stopped.

| TSX | Rust | Duration | Description |
|---|---|---|---|
| `spin` | `MotionPreset::Spin` | 1000 ms | Turns once, forever. |
| `float` | `MotionPreset::Float` | 1500 ms | Floats up and down, forever. |
| `breathe` | `MotionPreset::Breathe` | 1800 ms | Breathes: grows and fades a little, forever. |
| `sway` | `MotionPreset::Sway` | 1600 ms | Sways about its center, forever. |
| `bob` | `MotionPreset::Bob` | 1000 ms | Bobs like a bouncing ball, forever. |
| `glow` | `MotionPreset::Glow` | 2000 ms | Glows in and out, forever. |

`play` takes a preset's timing options over it (`m.play("shake", { duration: 300 })`), and a preset spreads into a motion of your own (`m.play({ ...motions.fadeInUp, duration: 600 })`). In Rust, change a preset's spec: `MotionPreset::FadeInUp.spec().timing(|t| t.delay(100.0))`.

### Motions of your own

A motion of your own is keyframes per channel and one timing (the options of [keyframes](#keyframes)). In TSX, write each channel's keyframes (`{ opacity: [0, 1] }`), or a list of frames as the Web Animations API writes them (`[{ opacity: 0, translateY: 24 }, { opacity: 1, translateY: 0 }]`), each frame with its `offset` and `easing`. In a list of frames, a frame without an offset sits where its position in the list puts it, and a channel follows the frames that name it. Angles can be strings (`"45deg"`, `"0.5turn"`). In Rust, build a `MotionSpec`.

```rust tabs
let rise = MotionSpec::new(KeyframeTiming::new(400.0))
    .values(MotionChannel::Opacity, [0.0, 1.0])
    .track(
        MotionChannel::TranslateY,
        [Keyframe::at(0.0, 24.0).ease(Easing::EaseOut), Keyframe::at(1.0, 0.0)],
    );
card.play(rise);

let flip = MotionSpec::new(KeyframeTiming::new(600.0).infinite())
    .values(MotionChannel::RotateY, [0.0, 180.0, 360.0]);
card.play(flip);
```

```tsx tabs
// Channels' keyframes.
card.play({
  duration: 400,
  keyframes: { opacity: [0, 1], translateY: [{ value: 24, easing: "easeOut" }, 0] },
});

// A list of frames.
card.play({
  duration: 400,
  keyframes: [
    { opacity: 0, translateY: 24, easing: "easeOut" },
    { opacity: 1, translateY: 0 },
  ],
});

card.play({ duration: 600, iterations: "infinite", keyframes: { rotateY: ["0deg", "180deg", "360deg"] } });
```

### Entrances and staggered lists

Give each row a motion that enters, with a delay that grows with its index: rows that appear together come in one after another. Cap the delay so that a row added far down the list does not wait.

```rust tabs
each(items, |item: &Item| item.id, |item, index| {
    let delay = index.get_untracked().min(10) as f32 * 60.0;
    let row = motion().entering(MotionPreset::FadeInUp.spec().timing(|t| t.delay(delay)));
    view()
        .rounded_xl()
        .bg(ZINC.shade(100))
        .p_4()
        .bind_motion(&row)
        .child(text(move || item.get().title))
})
```

```tsx tabs
function Row(props: { title: string; index: number }) {
  const row = createMotion({ enter: "fadeInUp", delay: Math.min(props.index, 10) * 60 });
  return (
    <View class="rounded-xl bg-zinc-100 p-4" style={row.style}>
      <Text>{props.title}</Text>
    </View>
  );
}

<Each of={items()} key={(item) => item.id}>
  {(item, index) => <Row title={item().title} index={index()} />}
</Each>
```

Motions also compose: `m.animation(..)` is a motion as a [composite animation](#composite-animations), not started, so `Animated.stagger` runs a group of them natively, counted from the first item, the last, the center or any index. Give them a hidden `initial` (or start them where the motion starts) so nothing shows before its turn.

```rust tabs
let cards: Vec<Motion> = (0..5)
    .map(|_| {
        let m = motion();
        m.value(MotionChannel::Opacity).set(0.0);
        m
    })
    .collect();
Animation::stagger_from(60.0, StaggerFrom::Center, cards.iter().map(|m| m.animation(MotionPreset::FadeInUp))).start();
```

```tsx tabs
const cards = [0, 1, 2, 3, 4].map(() => createMotion({ initial: { opacity: 0 } }));
Animated.stagger(60, cards.map((m) => m.animation("fadeInUp")), { from: "center" }).start();
```

### Exits

Play the exit, wait for it, then remove the view. A [layout animation](#layoutanimation) lets the views around it close the gap.

```rust tabs
let remove = move || {
    spawn(async move {
        row.play(MotionPreset::FadeOutLeft).await;
        animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
        items.update(|items| items.retain(|i| i.id != id));
    });
};
```

```tsx tabs
const remove = async () => {
  await row.play("fadeOutLeft");
  LayoutAnimation.easeInEaseOut();
  items.set(items().filter((i) => i.id !== id));
};
```

Motions follow the user's [reduced motion](#reduced-motion) setting on their own: when the user asks for less motion, a motion lands where it ends at once, without moving.

## Transitions

Name what to animate and for how long (`.transition_all().duration(400.0)` in Rust, `transitionProperty` and `transitionDuration` in TSX), and later changes to those properties animate natively from what is on screen to the new value.

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    let on = signal(false);
    view().flex_1().items_center().justify_center().child(
        view()
            .on_press(move || on.update(|on| *on = !*on))
            .size(px(100.0))
            .rounded(move || px(if on.get() { 50.0 } else { 16.0 }))
            .bg(move || if on.get() { rgb(0x8250df) } else { rgb(0x0969da) })
            .rotate(move || deg(if on.get() { 45.0 } else { 0.0 }))
            .scale(move || if on.get() { 1.2_f32 } else { 1.0 })
            .transition_all()
            .duration(400.0)
            .ease_in_out(),
    )
}
```

```tsx tabs
import { mount, signal, View } from "nsh";

function App() {
  const on = signal(false);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <View
        onPress={() => on.set(!on())}
        style={{
          width: 100,
          height: 100,
          borderRadius: on() ? 50 : 16,
          backgroundColor: on() ? "#8250df" : "#0969da",
          transform: [{ rotate: on() ? "45deg" : "0deg" }, { scale: on() ? 1.2 : 1 }],
          transitionProperty: "all",
          transitionDuration: 400,
          transitionTimingFunction: "ease-in-out",
        }}
      />
    </View>
  );
}

mount(App);
```

| Style | Rust | Type | Description |
|---|---|---|---|
| `transitionProperty` | `.transition()`, `.transition_all()`, `.transition_colors()`, `.transition_opacity()`, `.transition_transform()`, `.transition_shadow()` | `string` | What animates, comma-separated: `"all"`, `"colors"`, `"opacity"`, `"transform"`, `"box-shadow"`, `"border-radius"`, ... |
| `transitionDuration` | `.duration(ms)` | `number \| "150ms" \| "0.2s"` | Milliseconds as a number, or a CSS time. |
| `transitionDelay` | `.delay(ms)` | `number \| "150ms" \| "0.2s"` | Before it starts. |
| `transitionTimingFunction` | `.ease_linear()`, `.ease_in()`, `.ease_out()`, `.ease_in_out()`, `.ease_bezier(..)` | `"linear" \| "ease" \| "ease-in" \| "ease-out" \| "ease-in-out" \| "cubic-bezier(…)"` | The curve. |

Properties that transition, by group: **colors** (background, border, outline, shadow and text colors, gradient stops), **opacity**, **transform**, **shadows** (`box-shadow`) and **shape** (border radius and width). CSS names and their camel-case forms both work (`background-color`, `backgroundColor`, `transform`, `scale`, ...). Layout changes animate with [layout animations](#layoutanimation).

With Tailwind, the same thing is `transition` (colors, opacity, shadows and transforms), `transition-all`, `transition-colors`, `transition-opacity`, `transition-transform`, `transition-shadow`, with `duration-*`, `delay-*` and `ease-*`. Combined with the pressed state (`.active(..)`, `active:`) it gives pressed states that animate:

```rust tabs
view()
    .on_press(save)
    .rounded_xl()
    .bg(BLUE.shade(600))
    .px_5()
    .py_3()
    .transition()
    .duration(150.0)
    .active(|s| s.scale(0.95).bg(BLUE.shade(800)))
    .child(text("Save").font_weight(FontWeight::SEMIBOLD).text_color(white()))
```

```tsx tabs
<View onPress={save} class="rounded-xl bg-blue-600 px-5 py-3 transition duration-150 active:scale-95 active:bg-blue-800">
  <Text class="font-semibold text-white">Save</Text>
</View>
```

A transition starts from the value currently on screen, so changing the target again mid-way turns smoothly.

## Keyframe animations

Four built-in keyframe animations run natively, forever by default: `spin` (one turn clockwise), `ping` (scales up to 2× and fades out), `pulse` (fades to half opacity and back) and `bounce` (jumps up by a quarter of its height and lands).

```rust tabs
view()
    .size_8()
    .rounded_full()
    .border(px(4.0))
    .border_color(ZINC.shade(300))
    .border_t_color(BLUE.shade(600))
    .animate_spin()
view().h_4().w_40().rounded(px(4.0)).bg(ZINC.shade(200)).animate_pulse()
```

```tsx tabs
<View class="size-8 rounded-full border-4 border-zinc-300 border-t-blue-600 animate-spin" />
<View class="h-4 w-40 rounded bg-zinc-200 animate-pulse" />
```

| Style | Rust | Type | Description |
|---|---|---|---|
| `animationName` | `.animate_spin()`, `.animate_ping()`, `.animate_pulse()`, `.animate_bounce()`, `.animate_none()`, or `.animation(KeyframeAnimation::new(Keyframes::Spin))` | `"none" \| "spin" \| "ping" \| "pulse" \| "bounce"` | The animation. |
| `animationDuration` | `KeyframeAnimation::duration(ms)` | `number \| "1s" \| …` | One iteration. |
| `animationDelay` | `KeyframeAnimation::delay(ms)` | `number \| "200ms" \| …` | Before it starts. |
| `animationTimingFunction` | `KeyframeAnimation::easing([x1, y1, x2, y2])` | as `transitionTimingFunction` | The curve. |
| `animationIterationCount` | `KeyframeAnimation::iterations(n)` | `number \| "infinite"` | Default `"infinite"`. |

Tailwind: `animate-spin`, `animate-ping`, `animate-pulse`, `animate-bounce`, `animate-none`.

## Animated values

An animated value is a number that lives on the UI thread. Create one (`animated_value(..)` in Rust, `createAnimatedValue` from `nsh` in TSX), bind it to styles, and animate it; the bound views follow it every frame without an update.

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    let x = animated_value(0.0);
    let opacity = animated_value(1.0);
    let play = move || {
        spawn(async move {
            x.timing(240.0, 600.0, Easing::Curve(Curve::Cubic, EaseMode::Out)).await;
            opacity.timing(0.3, 200.0, Easing::EaseInOut).await;
            x.spring(0.0, Spring::default());
            opacity.timing_with(1.0, Timing::default());
        });
    };
    view()
        .flex_1()
        .justify_center()
        .p_6()
        .gap_6()
        .child(
            view()
                .size(px(60.0))
                .rounded(px(12.0))
                .bg(rgb(0x0969da))
                .bind_opacity(&opacity)
                .bind_translate_x(&x),
        )
        .child(view().on_press(play).child(text("Play").text_color(rgb(0x0969da))))
}
```

```tsx tabs
import { mount, Text, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh";

function App() {
  const x = createAnimatedValue(0);
  const opacity = createAnimatedValue(1);
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 24 }}>
      <View style={{ width: 60, height: 60, borderRadius: 12, backgroundColor: "#0969da", opacity, transform: [{ translateX: x }] }} />
      <View
        onPress={async () => {
          await x.timing(240, { duration: 600, easing: Easing.out(Easing.cubic) });
          await opacity.timing(0.3, { duration: 200 });
          x.spring(0);
          opacity.timing(1);
        }}
      >
        <Text style={{ color: "#0969da" }}>Play</Text>
      </View>
    </View>
  );
}

mount(App);
```

**What can be bound:** opacity (`.bind_opacity(..)`); the background color, border color (every side) and a text's color (the whole text), through an interpolation to colors (`.bind_background(..)`, `.bind_border_color(..)`, `.bind_color(..)`); the shadow's color, opacity and radius (`.bind_shadow_color(..)`, ...); and the transform steps `translateX`, `translateY`, `scale`, `scaleX`, `scaleY`, `rotate`, `rotateX`, `rotateY` and `rotateZ` (`.bind_translate_x(..)`, `.bind_translate_y(..)`, `.bind_scale(..)`, `.bind_rotate(..)` in degrees, `.bind_transform(kind, ..)`). A focus ring or a price that flashes green is a color interpolation bound to the border or text color:

```rust tabs
let flash = animated_value(0.0);
let color = flash.interpolate_colors(&[0.0, 1.0], &[rgb(0x1f2328), rgb(0x1a7f37)]);

text(move || price.get().to_string()).bind_color(&color)
// On a new price: flash.set(1.0); flash.timing(0.0, 600.0, Easing::EaseInOut);
```

```tsx tabs
const flash = createAnimatedValue(0);
const color = flash.interpolate({ inputRange: [0, 1], outputRange: ["#1f2328", "#1a7f37"] });

<Text style={{ color }}>{price()}</Text>
// On a new price: flash.set(1); flash.timing(0, { duration: 600 });
```

Animated values also drive [canvas drawings](./canvas.md#driving-drawings-with-animated-values), receive scroll offsets ([`scrollValue`](./scrolling.md#scroll-linked-effects-scrollvalue)) and gestures ([`pan`, `pinch`, `rotation`](./touch-and-gestures.md#native-gestures-pan-pinch-and-rotation)).

The value is kept alive by the views bound to it and by the component that made it, so a binding stays connected however your variables come and go. Create animated values in the component that owns them (not at module level when every instance needs its own).

### AnimatedValue methods

| TSX | Rust | Description |
|---|---|---|
| `set(value)` | `set(value)` | Jumps to `value`, stopping any animation. |
| `stop()` | `stop()` | Stops the running animation where it is; in TSX, resolves with the value there. |
| `getValue()` | `value()` | The current value, read on the UI thread where it moves (it settles within a frame): a promise in TSX, an awaitable answer in Rust. |
| `setOffset(offset)` | `set_offset(offset)` | Adds `offset` to what the value shows: bindings see value + offset, while `set`, animations and drags move the value. |
| `flattenOffset()` | `flatten_offset()` | Adds the offset to the value and makes the offset 0. |
| `extractOffset()` | `extract_offset()` | Moves the value into the offset and makes the value 0: a drag then starts from 0, on top of where the last one left it. |
| `timing(to, { duration?, easing?, delay? })` | `timing(to, ms, easing)`, `timing_with(to, Timing { .. })` | Animates to `to` over `duration` ms (default 300, easing `"easeInOut"`). |
| `spring(to, { stiffness?, damping?, mass?, velocity? })` | `spring(to, Spring { .. })` | Springs to `to` (defaults: stiffness 170, damping 26, mass 1). |
| `decay({ velocity?, deceleration?, clamp?, bounce? })` | `decay(velocity, deceleration)`, `decay_within(velocity, deceleration, (min, max), bounce)` | Coasts from `velocity` (units per second) and slows down (deceleration 0.998 per ms by default). With a clamp of `[min, max]` it stops at a bound, or bounces back from it keeping `bounce` (0..1) of its speed. |

Each animation gives an answer you can await: `true` when it finished, `false` when something stopped it (`stop()`, `set()`, or a new animation on the same value). It is a `Promise<boolean>` in TSX and an `AnimationEnd` in Rust. Starting a new animation on a moving value interrupts the old one smoothly: a spring or decay without a velocity continues with the value's current velocity.

```rust tabs
// Spring settings: lower damping overshoots more, higher stiffness is faster.
x.spring(200.0, Spring { stiffness: 180.0, damping: 8.0, ..Spring::default() });   // wobbly
x.spring(200.0, Spring { stiffness: 400.0, damping: 30.0, ..Spring::default() });  // stiff, no overshoot

// A fling that coasts to a stop, from a pan's release velocity.
view().pan_values(Some(&x), None).on_pan_end(move |e: &PanEvent| {
    x.decay(Some(e.velocity_x), 0.998);
})

// A fling that stays on its track and bounces softly off its ends.
x.decay_within(Some(e.velocity_x), 0.998, (0.0, 300.0), 0.3);

// Where a value is now (it moves on the UI thread, so the answer is async).
let at = x.value().await;
```

```tsx tabs
// Spring settings: lower damping overshoots more, higher stiffness is faster.
x.spring(200, { stiffness: 180, damping: 8 });   // wobbly
x.spring(200, { stiffness: 400, damping: 30 });  // stiff, no overshoot

// A fling that coasts to a stop, from a pan's release velocity.
<View pan={{ x }} onPanEnd={(e) => x.decay({ velocity: e.velocityX })} />

// A fling that stays on its track and bounces softly off its ends.
x.decay({ velocity: e.velocityX, clamp: [0, 300], bounce: 0.3 });

// Where a value is now (it moves on the UI thread, so the answer is async).
const where = await x.getValue();
```

### Keyframes

`keyframes` plays a value through keyframes as CSS keyframes play: `value.keyframes(frames, options)` in TSX, `value.keyframes(frames, KeyframeTiming)` in Rust (`Animated.keyframes(value, { keyframes, ... })` and `Animation::keyframes(..)` as a step of a [composite](#composite-animations)). A keyframe is a number (or an angle string such as `"90deg"`), spread evenly with the others, or `{ offset, value, easing }` (`Keyframe::new(value)`, `Keyframe::at(offset, value)`, `.ease(easing)` in Rust).

```rust tabs
let y = animated_value(0.0);
y.keyframes(
    [Keyframe::new(0.0), Keyframe::at(0.3, -20.0).ease(Easing::EaseIn), Keyframe::new(0.0)],
    KeyframeTiming::new(600.0).easing(Easing::EaseOut).iterations(Some(3)),
);

// A clock hand that ticks once a second.
let hand = animated_value(0.0);
hand.keyframes(
    [Keyframe::new(0.0), Keyframe::new(360.0)],
    KeyframeTiming::new(60_000.0).easing(Easing::Steps(60, StepPosition::JumpEnd)).infinite(),
);
```

```tsx tabs
const y = createAnimatedValue(0);
y.keyframes([0, { offset: 0.3, value: -20, easing: "easeIn" }, 0], { duration: 600, easing: "easeOut", iterations: 3 });

// A clock hand that ticks once a second.
const hand = createAnimatedValue(0);
hand.keyframes([0, 360], { duration: 60_000, easing: Easing.steps(60), iterations: "infinite" });
```

| Option | Rust (`KeyframeTiming`) | Default | Description |
|---|---|---|---|
| `duration` | `KeyframeTiming::new(ms)` | 300 | One iteration, in milliseconds. |
| `delay` | `.delay(ms)` | 0 | Before the first iteration. |
| `easing` | `.easing(easing)` | CSS `ease` | The curve of each segment without an easing of its own. |
| `iterations` | `.iterations(Some(n))`, `.infinite()` | 1 | How many iterations, or `"infinite"`. |
| `direction` | `.direction(PlaybackDirection::Alternate)` | `"normal"` | `"normal"`, `"reverse"`, `"alternate"` or `"alternate-reverse"`. |

They play as in CSS and the Web Animations API:

- An easing shapes each segment, not the whole: a keyframe's `easing` shapes the segment that starts at it, and the timing's `easing` every other segment.
- Keyframes without an offset spread evenly between their neighbors; the first defaults to 0 and the last to 1.
- Each iteration starts with a jump to its first keyframe. Without a keyframe at offset 0, the value goes from where it is.
- During a `delay`, the value already holds the first keyframe (CSS `animation-fill-mode: backwards`), so a delayed entrance shows its first frame rather than the view at rest. This holds for motions too.
- `reverse` and the backward iterations of `alternate` run the segments backwards, each with its curve reversed.
- The value stays where the last iteration leaves it. The answer is `true` when they finished, `false` when something stopped them.

### Interpolation

`interpolate` maps a value through piecewise linear segments to numbers, colors or angles, and returns a new node you can bind. One value can drive many properties. In Rust, `interpolate(&input, &output)` maps to numbers, `interpolate_colors(&input, &colors)` to colors, and `interpolate_with(&input, output, Interpolation { .. })` takes the extrapolation and easing; in TSX, `value.interpolate({ inputRange, outputRange })` takes them all.

```rust tabs
let t = animated_value(0.0);

view()
    .bind_background(&t.interpolate_colors(&[0.0, 1.0, 2.0], &[rgb(0x54aeff), rgb(0x8250df), rgb(0xcf222e)]))
    .bind_opacity(&t.interpolate(&[0.0, 1.0], &[0.4, 1.0]))
    .bind_rotate(&t.interpolate(&[0.0, 1.0], &[0.0, 180.0]))
    .bind_scale(&t.interpolate_with(
        &[0.0, 1.0],
        AnimationOutput::Numbers(vec![0.6, 1.2]),
        Interpolation {
            easing: Easing::Curve(Curve::Back(1.70158), EaseMode::Out),
            ..Interpolation::default()
        },
    ))
```

```tsx tabs
const t = createAnimatedValue(0);

<View
  style={{
    backgroundColor: t.interpolate({ inputRange: [0, 1, 2], outputRange: ["#54aeff", "#8250df", "#cf222e"] }),
    opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
    transform: [
      { rotate: t.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] }) },
      { scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.2], easing: Easing.out(Easing.back()) }) },
    ],
  }}
/>
```

| Option | Rust | Description |
|---|---|---|
| `inputRange` | the input slice | Increasing input stops. |
| `outputRange` | the output slice, or `AnimationOutput` | One output per stop: numbers, colors (`"#rrggbb"`, `"rgba(…)"`, named) or angles (`"45deg"`, `"1rad"`). |
| `extrapolate` | `Interpolation::extrapolate(Extrapolate::Extend)` | Outside the input range: `"clamp"` (default), `"extend"` (continue the end segments) or `"identity"` (pass the input through). |
| `extrapolateLeft`, `extrapolateRight` | `extrapolate_left`, `extrapolate_right` | The same, for one side. |
| `easing` | `easing` | Shapes each segment. |

> [!IMPORTANT]
> Interpolations **clamp** by default: outside the input range, the output stays at the nearest end. Pulling a scroll view past its top therefore keeps a scroll-linked header at its end state. Pass `extrapolate: "extend"` (`Extrapolate::Extend`) when you want the line to continue.

### Arithmetic and diffClamp

Nodes combine with arithmetic, also natively: `a.add(b)`, `a.sub(b)`, `a.mul(b)`, `a.div(b)`, `a.mod(b)` (`a.modulo(b)` in Rust; never negative for a positive `b`, e.g. angles in 0..360), where `b` is a node or a number. In TSX, `Animated.add`, `subtract`, `multiply`, `divide` and `modulo` are the same as functions.

`diffClamp(min, max)` (`diff_clamp`) follows the node's *changes* while staying within `min..max`. Applied to a scroll offset, it makes a header that hides as the content scrolls up and comes back as soon as it scrolls down:

```rust tabs
let offset = animated_value(0.0);
let header = offset.diff_clamp(0.0, 56.0);

scroll().flex_1().scroll_value(&offset)
view().absolute().top_0().left_0().right_0().h(px(56.0)).bind_translate_y(&header.mul(-1.0))
```

```tsx tabs
const scroll = createAnimatedValue(0);
const header = scroll.diffClamp(0, 56);

<Scroll style={{ flex: 1 }} scrollValue={scroll}>…</Scroll>
<View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 56, transform: [{ translateY: header.mul(-1) }] }}>…</View>
```

With `{ snap: true }` (`diff_clamp_with(min, max, DiffClamp::snapping())`), a header left partly shown when the scrolling stops finishes the move: it settles fully shown or fully hidden, whichever is nearer, in 200 ms on the UI thread. It hides only once the page has scrolled at least its height, so a page scrolled less than that shows the whole header. Scrolling again during the move takes over from where the header is.

```rust tabs
let header = offset.diff_clamp_with(0.0, 56.0, DiffClamp::snapping());
```

```tsx tabs
const header = scroll.diffClamp(0, 56, { snap: true });
```

## Composite animations

Animations are built out of steps (`Animation` in Rust, `Animated` from `nsh` in TSX) and the whole tree runs natively: each step starts on the UI thread the moment the previous one ends, with no gap and none of your code in between.

```rust tabs
let ys: Vec<AnimatedValue> = (0..5).map(|_| animated_value(0.0)).collect();
let fade = animated_value(1.0);

let hop = Animation::stagger(
    80.0,
    ys.iter().map(|y| {
        Animation::sequence([
            Animation::timing(y, -30.0, Timing::new(200.0, Easing::Curve(Curve::Quad, EaseMode::Out))),
            Animation::spring(y, 0.0, Spring { stiffness: 300.0, damping: 12.0, ..Spring::default() }),
        ])
    }),
);

let breathe = Animation::sequence([
    Animation::timing(&fade, 0.3, Timing::new(400.0, Easing::EaseInOut)),
    Animation::timing(&fade, 1.0, Timing::new(400.0, Easing::EaseInOut)),
])
.looped(None);

let landed = hop.start();
spawn(async move {
    status.set(if landed.await { "landed" } else { "stopped" });
});
```

```tsx tabs
import { Animated, createAnimatedValue, Easing } from "nsh";

const ys = [0, 1, 2, 3, 4].map(() => createAnimatedValue(0));
const fade = createAnimatedValue(1);

const hop = Animated.stagger(
  80,
  ys.map((y) =>
    Animated.sequence([
      Animated.timing(y, { toValue: -30, duration: 200, easing: Easing.out(Easing.quad) }),
      Animated.spring(y, { toValue: 0, stiffness: 300, damping: 12 }),
    ]),
  ),
);

const breathe = Animated.loop(
  Animated.sequence([
    Animated.timing(fade, { toValue: 0.3, duration: 400 }),
    Animated.timing(fade, { toValue: 1, duration: 400 }),
  ]),
);

hop.start(({ finished }) => console.log(finished ? "landed" : "stopped"));
```

| TSX | Rust | Description |
|---|---|---|
| `Animated.timing(value, { toValue, duration?, easing?, delay? })` | `Animation::timing(&value, to, Timing { .. })` | A timing step. |
| `Animated.spring(value, { toValue, stiffness?, damping?, mass?, velocity? })` | `Animation::spring(&value, to, Spring { .. })` | A spring step. |
| `Animated.decay(value, { velocity?, deceleration?, clamp?, bounce? })` | `Animation::decay(&value, velocity, deceleration)`, `Animation::decay_within(..)` | A decay step. |
| `Animated.sequence(list)` | `Animation::sequence(list)` | One after another. |
| `Animated.parallel(list, { stopTogether? })` | `Animation::parallel(list)`, `.stop_together(..)` | All at once. |
| `Animated.stagger(ms, list, { from? })` | `Animation::stagger(ms, list)`, `Animation::stagger_from(ms, StaggerFrom::Center, list)` | All at once, each starting `ms` after the previous one, counted from `from`: `"first"` (the default), `"last"`, `"center"` (a ripple out from the middle) or an index (`StaggerFrom::First`, `Last`, `Center`, `Index(i)`). |
| `Animated.keyframes(value, { keyframes, ...timing })` | `Animation::keyframes(&value, frames, KeyframeTiming)` | A step of [keyframes](#keyframes). |
| `Animated.delay(ms)` | `Animation::delay(ms)` | Waits. |
| `Animated.loop(animation, { iterations?, resetBeforeIteration? })` | `.looped(iterations)`, `.reset_before_iteration(..)` | Repeats (forever by default; `None` in Rust). |

A composite animation has `start()` (in TSX also with a callback and a promise of `finished`; in Rust an awaitable `bool`; calling it again runs it again), `stop()` (stops where it is) and `reset()` (stops and puts its values back where they were when it started). The callback runs once for the whole tree.

A running animation does not keep its values alive: when the component that owns them goes (its views and variables), an endless loop stops with them, and its answer is `false`.

## Easing

Easing curves are data, evaluated natively: `Easing` from `nsh` in TSX, the `Easing` enum in Rust.

| TSX | Rust | Description |
|---|---|---|
| `Easing.linear`, `Easing.ease` | `Easing::Linear`, `Easing::Bezier(0.25, 0.1, 0.25, 1.0)` | Constant speed; CSS's `ease`. |
| `Easing.quad`, `Easing.cubic`, `Easing.poly(n)` | `Curve::Quad`, `Curve::Cubic`, `Curve::Poly(n)` | `t²`, `t³`, `tⁿ`. |
| `Easing.sin`, `Easing.circle`, `Easing.exp` | `Curve::Sin`, `Curve::Circle`, `Curve::Exp` | Sinusoidal, circular, exponential. |
| `Easing.back(s?)` | `Curve::Back(s)` | Pulls back before going (overshoot `s`, 1.70158 by default). |
| `Easing.elastic(bounciness?)` | `Curve::Elastic(bounciness)` | Springy overshoot. |
| `Easing.bounce` | `Curve::Bounce` | Bounces at the end. |
| `Easing.bezier(x1, y1, x2, y2)` | `Easing::Bezier(x1, y1, x2, y2)` | A cubic Bézier, as in CSS. |
| `Easing.steps(count, position?)` | `Easing::Steps(count, StepPosition::JumpEnd)` | Jumps between `count` levels instead of moving, as CSS `steps()`: a frame-by-frame sprite, a ticking hand. `position` is `"jump-end"` (the default, also `"end"`), `"jump-start"` (`"start"`), `"jump-none"` or `"jump-both"`. |
| `Easing.in(e)`, `Easing.out(e)`, `Easing.inOut(e)` | `Easing::Curve(curve, EaseMode::In)`, `EaseMode::Out`, `EaseMode::InOut` | The curves are "in" curves; `out` and `inOut` turn them around. |

In TSX, anywhere an easing is accepted you can also pass a name (`"linear"`, `"ease"`, `"easeIn"`, `"easeOut"`, `"easeInOut"`) or a Bézier array `[x1, y1, x2, y2]`; in Rust, `Easing::EaseIn`, `Easing::EaseOut` and `Easing::EaseInOut` are the CSS curves.

```rust tabs
x.timing(1.0, 300.0, Easing::Curve(Curve::Back(1.70158), EaseMode::Out));
x.timing(1.0, 300.0, Easing::EaseOut);
x.timing(1.0, 300.0, Easing::Bezier(0.2, 0.8, 0.2, 1.0));
```

```tsx tabs
x.timing(1, { easing: Easing.out(Easing.back()) });
x.timing(1, { easing: "easeOut" });
x.timing(1, { easing: [0.2, 0.8, 0.2, 1] });
```

`Easing.sample(easing, count)` (`sample_easing` in Rust) returns the curve at `count` evenly spaced points from 0 to 1, and `Animated.sampleSpring(config, fps?)` / `Animated.sampleDecay(config, fps?)` (`sample_spring`, `sample_decay`) the values a spring or decay moves through, one per frame (60 per second by default) from `config.from` (0) until it ends. They are computed by the same native code the animations run, so a chart of a curve shows exactly what the animation does:

```rust tabs
use nsh_core::element::{sample_easing, sample_spring};

let curve = sample_easing(Easing::Curve(Curve::Back(1.70158), EaseMode::Out), 50); // 50 progress values
let spring = sample_spring(0.0, 1.0, Spring { stiffness: 180.0, damping: 8.0, ..Spring::default() }, 60.0);
```

```ts tabs
const curve = Easing.sample(Easing.out(Easing.back()), 50); // 50 progress values
const spring = Animated.sampleSpring({ toValue: 1, stiffness: 180, damping: 8 });
```

## LayoutAnimation

A layout animation animates the frame changes of the **next** update natively: views that move or resize glide to their new frames, new views fade (or scale) in, removed views fade out. Call it right before the state change: `animate_layout(..)` in Rust, `LayoutAnimation.configureNext(config)` in TSX.

```rust tabs
use nsh_core::element::LayoutAnimation;

let items = signal(vec![1, 2, 3]);
let next = stored(4);

let add = move || {
    animate_layout(LayoutAnimation::SPRING);
    let n = next.with(|n| {
        *n += 1;
        *n - 1
    });
    items.update(|i| i.insert(0, n));
};
let remove = move || {
    animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
    items.update(|i| {
        i.remove(0);
    });
};
```

```tsx tabs
import { signal } from "nsh";
import { LayoutAnimation } from "nsh";

const items = signal([1, 2, 3]);
let next = 4;

const add = () => {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
  items.set([next++, ...items()]);
};
const remove = () => {
  LayoutAnimation.easeInEaseOut();
  items.set(items().slice(1));
};
```

| TSX | Rust | Description |
|---|---|---|
| `configureNext(config, onEnd?)` | `animate_layout(config)` | Animates the next commit's changes; in TSX, `onEnd` runs when done. |
| `create(duration, type?, property?)` | `LayoutAnimation::all(LayoutTransition::new(curve, ms))` | A config with one curve for all three phases. |
| `Presets.easeInEaseOut`, `Presets.linear`, `Presets.spring` | `LayoutAnimation::EASE_IN_EASE_OUT`, `LINEAR`, `SPRING` | Ready-made configs. |
| `easeInEaseOut(onEnd?)`, `linear(onEnd?)`, `spring(onEnd?)` | `animate_layout` with a preset | `configureNext` with a preset. |
| `Types`, `Properties` | `LayoutCurve`, `LayoutProperty` | The names, for building configs. |

A config is `{ duration, create?, update?, delete? }` (`LayoutAnimation { create, update, delete }` in Rust): `create` for inserted views, `update` for moved or resized ones, `delete` for removed ones. Each phase is `{ type?, property?, duration?, delay?, springDamping? }` (`LayoutTransition { curve, property, duration_ms, delay_ms }`), where `type` is `"easeInEaseOut"`, `"spring"`, `"linear"`, `"easeIn"`, `"easeOut"` or `"keyboard"` (the software keyboard's own curve, timed from when the keyboard started to move, so that what makes room for it moves with it; `LayoutCurve::Keyboard`), `property` is what appearing and disappearing views animate (`"opacity"`, `"scaleXY"`, `"scale"`), and `springDamping` (0..1, 0.7 by default; `LayoutCurve::Spring { damping }`) sets the spring's overshoot.

```rust tabs
use nsh_core::element::{LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition};

animate_layout(LayoutAnimation {
    create: Some(LayoutTransition::new(LayoutCurve::EaseOut, 300.0)),
    update: Some(LayoutTransition::new(LayoutCurve::Spring { damping: 0.8 }, 300.0)),
    delete: Some(LayoutTransition {
        property: LayoutProperty::Scale,
        ..LayoutTransition::new(LayoutCurve::EaseIn, 300.0)
    }),
});
```

```tsx tabs
LayoutAnimation.configureNext({
  duration: 300,
  create: { type: "easeOut", property: "opacity" },
  update: { type: "spring", springDamping: 0.8 },
  delete: { type: "easeIn", property: "scaleXY" },
});
```

## What runs where

| | Runs on | Your code per frame |
|---|---|---|
| Transitions, keyframe animations | UI thread | none |
| Motions, keyframes, `timing` / `spring` / `decay`, composites | UI thread | none; your code hears when they end |
| `interpolate`, arithmetic, `diffClamp` | UI thread | none |
| `scrollValue`, `pan` / `pinch` / `rotation` | UI thread | none; your code hears start and end |
| Layout animations | UI thread | none |
| `requestAnimationFrame` loops (`request_animation_frame` in Rust), `onScroll` handlers, `PanResponder` | your code, then an update | every frame |

Reach for `requestAnimationFrame` (a global in TSX, following the display) only for what cannot be described ahead of time, such as a physics simulation in your code. Anything that can be an animated value should be one.

## Reduced motion

When the user asks for less motion (iOS "Reduce Motion", Android "Remove animations"), `reduce_motion()` in Rust and `reduceMotion()` from `nsh` in TSX are `true`, and the `motion-reduce:` / `motion-safe:` Tailwind variants apply.

[Motions](#motion) follow the setting on their own: `play` and `enter` land where the motion ends at once, without moving, and the answer is `true` as for a motion that played. An exit still ends hidden, an entrance still ends at rest. Pass `ignoreReduceMotion: true` (`play_ignoring_reduce_motion` in Rust) for a motion that carries meaning the user needs, such as a progress spinner.

Transitions, keyframe animations, animated values, keyframes and composites play as written; use these to choose a calmer alternative:

```rust tabs
let open = move || {
    if reduce_motion() {
        panel.set(0.0);
    } else {
        panel.spring(0.0, Spring::default());
    }
};

view().style_when(|| !reduce_motion(), |s| s.animate_bounce())
```

```tsx tabs
import { View } from "nsh";
import { reduceMotion } from "nsh";

const open = () => (reduceMotion() ? panel.set(0) : panel.spring(0));

<View class="motion-safe:animate-bounce" />
```

See [Accessibility](./accessibility.md#reduced-motion).

## Related

- [`nsh`'s animation API](../modules/nsh.md#animation): the TSX reference.
- [Touch and gestures](./touch-and-gestures.md): driving animated values with the finger.
- [Scrolling](./scrolling.md#scroll-linked-effects-scrollvalue): `scrollValue`.
- [Canvas](./canvas.md#driving-drawings-with-animated-values): animated values in drawings.
- [Style reference](../modules/style-reference.md): the `transition*` and `animation*` keys.

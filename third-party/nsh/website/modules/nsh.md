---
title: nsh
description: "The core module: signals, effects, context, mount, design tokens, animation, the environment, gestures, the clipboard, storage, the host channel, keyboard shortcuts, accessibility and the element and style types."
order: 2
---

# nsh

`nsh` is the core module: the reactive API (signals, computed values, effects, context), `mount`, `token`, the host elements `View`, `Text`, `Scroll` and `Overlay`, [selectable views](#selectable-views), [the safe area and the keyboard](#safe-area-and-keyboard), [animation](#animation), [the device and its environment](#device), [`PanResponder`](#panresponder), the [clipboard](#clipboard), the [photo picker](#picker), [storage](#storage), the [host channel](#host), [keyboard shortcuts](#keymap), [native components and modules](#nativecomponent-and-nativemodule), [accessibility](#accessibility), and the TypeScript types of elements, styles and events. The reactive graph itself runs natively in Rust; reading a signal is a call into the runtime that costs a few nanoseconds, and only your own closures run in the JavaScript interpreter.

```ts
import { batch, cleanup, computed, context, effect, ErrorBoundary, mount, Overlay, Scroll, signal, split, Text, token, untracked, View } from "nsh";
import { Input } from "nsh/base";
```

NSH's reactivity follows the same model as SolidJS: a component function runs **once**, and the parts of the UI that read signals are updated in place when those signals change. There is no re-render of the component and no virtual DOM. See [Reactivity](../docs/reactivity.md) for the guide.

## signal

```ts
function signal<T>(value: T, options?: SignalOptions<T>): Signal<T>;
function signal<T = undefined>(): Signal<T | undefined>;

interface Signal<T> {
  (): T;                              // read (tracked)
  set(value: T): void;                // write
  update(fn: (value: T) => T): void;  // write from the current value
}

interface SignalOptions<T> {
  /** When a new value counts as a change (default `===`); `false`: always. */
  equals?: false | ((previous: T, next: T) => boolean);
}
```

A signal holds a value. Calling it reads the value and, inside a tracking scope (JSX expressions, `computed`, `effect`), subscribes that scope to it. `set` and `update` write it; everything that read it updates.

```tsx
import { mount, signal, Text, View } from "nsh";

function Counter() {
  const count = signal(0);
  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text>Count: {count()}</Text>
      <Text onPress={() => count.update((n) => n + 1)}>Add one</Text>
    </View>
  );
}

mount(Counter);
```

By default a write that is `===` to the current value does nothing. Pass `equals: false` to notify on every write (useful when you mutate an object in place and set the same object again), or your own comparison:

```ts
const items = signal<string[]>([], { equals: false });
const point = signal({ x: 0, y: 0 }, { equals: (a, b) => a.x === b.x && a.y === b.y });
```

## computed

```ts
function computed<T>(fn: (previous: T | undefined) => T, options?: SignalOptions<T>): Accessor<T>;

interface Accessor<T> {
  (): T;
}
```

A value derived from signals. `fn` runs again when a signal it read changes; readers of the computed value only update when its result changes (by `equals`, `===` by default). `fn` receives the previous result.

```ts
const first = signal("Ada");
const last = signal("Lovelace");
const full = computed(() => `${first()} ${last()}`);
full(); // "Ada Lovelace"
```

Use `computed` when a derivation is expensive or read in several places. For a cheap expression, a plain function (`const full = () => first() + " " + last()`) is just as reactive.

## effect

```ts
function effect(fn: () => void): void;
```

Runs `fn` after rendering, and again whenever a signal it read changes. Use effects for side effects: logging, timers, talking to native modules. An effect belongs to the component (or effect) it was created in and is disposed with it.

```ts
const query = signal("");
effect(() => {
  console.log("query is now", query());
});
```

To undo something before the effect runs again (or when its component goes away), call [`cleanup`](#cleanup) inside it.

## batch

```ts
function batch<T>(fn: () => T): T;
```

Runs `fn` and applies all its writes together at the end, so readers update once instead of once per write. Returns what `fn` returns.

```ts
batch(() => {
  first.set("Grace");
  last.set("Hopper");
}); // `full` recomputes once
```

## untracked

```ts
function untracked<T>(fn: () => T): T;
```

Runs `fn` without subscribing the current scope to what it reads. Use it to read a signal inside an effect or JSX expression without depending on it.

```ts
effect(() => {
  // Runs again when `query` changes, not when `page` changes.
  search(query(), untracked(() => page()));
});
```

## cleanup

```ts
function cleanup(fn: () => void): void;
```

Registers `fn` to run before the current effect runs again, or when the current component or effect goes away.

```tsx
function Clock() {
  const now = signal(new Date());
  const timer = setInterval(() => now.set(new Date()), 1000);
  cleanup(() => clearInterval(timer));
  return <Text>{now().toLocaleTimeString()}</Text>;
}
```

## inputAction

```ts
function inputAction<A>(handler: (args: A) => unknown, args: A): () => void;
```

Captures JSON-compatible `args` and returns a callback that calls `handler` with that snapshot as its only
argument. Pass the second argument explicitly; use `null` or `[]` for an action with no arguments. Capture
evaluates getters and Proxy traps, copies the JSON value and deeply freezes its objects and arrays. It accepts
up to 64 levels, 1,048,576 entries and 8 MiB of canonical UTF-8 JSON. Incoming event arguments and the handler's
return value are ignored.

```tsx
import { inputAction, signal, Text } from "nsh";

const selected = signal("");

function Row(props: { id: string }) {
  const choose = ({ id }: { id: string }) => selected.set(id);
  return <Text onPress={inputAction(choose, { id: props.id })}>{props.id}</Text>;
}
```

Choose the action and its target from captured arguments. Applications and host services may check current
business state to reject stale work while keeping the captured target and arguments unchanged. Event handlers
follow ordinary native input dispatch against the current UI. Argument capture does not prove which rendered
frame the user saw or grant service authority.

## context

```ts
function context<T>(defaultValue: T): Context<T>;

interface Context<T> extends Accessor<T> {
  Provider: (props: { value: T; children?: JSX.Element }) => JSX.Element;
}
```

A value a component provides to everything it renders, however deep. Calling the context (`Theme()`) reads the nearest provider's value, or `defaultValue` without one.

```tsx
import { context, mount, signal, Text, View } from "nsh";

const Theme = context<"light" | "dark">("light");

function Label(props: { text: string }) {
  return <Text style={{ color: Theme() === "dark" ? "#fff" : "#000" }}>{props.text}</Text>;
}

function App() {
  const dark = signal(false);
  return (
    <Theme.Provider value={dark() ? "dark" : "light"}>
      <View style={{ flex: 1, padding: 24, backgroundColor: dark() ? "#000" : "#fff" }}>
        <Label text="Hello" />
        <Text onPress={() => dark.update((d) => !d)}>Toggle</Text>
      </View>
    </Theme.Provider>
  );
}

mount(App);
```

## mount

```ts
function mount<P extends object>(app: Component<P>, props?: P): () => void;
```

Renders `app` into the surface (the window, or the `NshAppView` / `NshView` the app is embedded in) and returns a function that removes it. Every app's entry file ends with `mount(App)`.

```tsx
mount(App);
```

## split

```ts
function split<T extends object, K extends readonly (keyof T)[]>(
  props: T,
  keys: K,
): [Pick<T, K[number]>, Omit<T, K[number]>];
```

Splits a props object into the props named in `keys` and the rest. Both halves stay reactive: props whose values change are getters, and `split` keeps them as getters. Use it in a component that handles some props itself and passes the others on. Destructuring props (`const { label } = props`) would read them once and lose updates.

```tsx
import { split, Text, View } from "nsh";
import { Input, type InputProps } from "nsh/base";

function LabeledInput(props: InputProps & { label: string }) {
  const [own, rest] = split(props, ["label"]);
  return (
    <View style={{ gap: 4 }}>
      <Text>{own.label}</Text>
      <Input {...rest} />
    </View>
  );
}
```

## ErrorBoundary

```ts
function ErrorBoundary(props: {
  fallback: JSX.Element | ((error: unknown, reset: () => void) => JSX.Element);
  children?: JSX.Element;
}): JSX.Element;
```

Renders its children, or `fallback` once something under them throws: a component's body, a binding, an effect or an event handler. The part that failed is removed and the fallback shows in its place. `fallback(error, reset)` gets the thrown value and `reset`, which renders the children again; a `fallback` that takes no arguments is shown as it is. A failure goes to the nearest boundary above it, and one in a fallback to the boundary above that. Rust components use `catch_error` ([Error boundaries](../docs/reactivity.md#error-boundaries)).

```tsx
import { ErrorBoundary, Text, View } from "nsh";

function Feed() {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <View>
          <Text>{error instanceof Error ? error.message : String(error)}</Text>
          <Text onPress={reset}>Try again</Text>
        </View>
      )}
    >
      <Posts />
    </ErrorBoundary>
  );
}
```

## token

```ts
function token<K extends keyof Tokens>(name: K): Tokens[K];
```

The design token `name` of the app's theme (`"theme"` in `nsh.json`, over shadcn/ui's tokens) in the appearance shown:
a color as `#rrggbbaa`, a length as a number of points, a font as its family name. Names are the theme's CSS variables
without `--` (`primary`, `muted-foreground`, `radius`, `font-mono`, and the app's own, such as `up`). Reading it is
reactive: a component, memo or effect that reads a token runs again when the theme or the appearance changes.
`Tokens` lists the app's tokens with their types; NSH writes it into `.nsh/types/nsh/tokens.d.ts` from the theme. For
classes, name the tokens directly (`bg-primary`, `rounded-(--radius)`): [Theme tokens](../docs/tailwind.md#theme-tokens).

```tsx
import { effect, token } from "nsh";

effect(() => console.log("primary is", token("primary"), "radius", token("radius")));
```

## View, Text, Scroll, Overlay

```ts
function View(props: ViewProps): YNode;
function Text(props: TextProps): YNode;
function Scroll(props: ScrollProps): YNode;
function Overlay(props: OverlayProps): YNode;
```

The host elements `nsh` exports, written as tags: `<View>`, `<Text>`, `<Scroll>`, `<Overlay>` (its
children on top of the window, placed against an anchor: [Overlay](../elements/overlay.md)). The compiler makes the
native view in place for a tag that names one of them through its import (an alias too), so importing them costs
nothing at run time. They are components like any other, so they can also be passed around (`const Tag = inline ? Text : View`).
`nsh` exports the other primitives the same way: [`List`](./nsh-list.md), [`Image`](./nsh-image.md),
[`Canvas`](./nsh-canvas.md), [`WebView`](./nsh-webview.md) and [`Video`](./nsh-video.md), each with its own reference
page. Their props are documented under [Elements](../elements/index.md). The text input, `Input`, comes from
[`nsh/base`](./nsh-base.md#input).

## Safe area and keyboard

CSS's environment variables keep content clear of system UI, in any view's padding and margin
(`padding`, `paddingTop`, ..., the same `margin` keys; Tailwind's `p*` / `m*` arbitrary values; the `Styled` methods
`.p_safe_area()`, `.pt_safe_area_plus(..)`, `.pb_keyboard()`, ... in Rust). Their values are `EnvValue`s:
`env(name)`, `env(name, <length>)`, `calc(env(name) + <length>)` and `calc(<length> + env(name))`.

| Variable | Value |
|---|---|
| `safe-area-inset-top`, `-right`, `-bottom`, `-left` | The insets of the root view the node renders in: the nearest page's (below its header), the nearest dialog's, or else the surface's safe area. See [Safe area](../elements/safe-area.md). |
| `keyboard-inset-height` | The software keyboard's height over the surface, 0 while it is hidden; changes animate natively with the keyboard. See [Keyboard](../elements/keyboard.md). |

```tsx
<View style={{ flex: 1, paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(keyboard-inset-height)" }}>…</View>
```

### safeArea and safeAreaInsets

`safeArea()` is the surface's safe area (`safe_area()` in Rust); `safeAreaInsets()` the insets where a component
renders (`cx.insets()` in Rust), the values of the `safe-area-inset-*` variables. Both are reactive `Edges`
(`{ top, right, bottom, left }` in points). See
[safeArea and safeAreaInsets](../elements/safe-area.md#safearea-and-safeareainsets).

### Keyboard and keyboardFrame

`Keyboard.dismiss()` hides the software keyboard (`dismiss_keyboard()` in Rust) and `keyboardFrame()` tells you how
much of the screen it covers (`keyboard_height()` and `keyboard_duration()` in Rust). See
[Hiding the keyboard](../elements/keyboard.md#hiding-the-keyboard) and
[The keyboard's height](../elements/keyboard.md#the-keyboards-height).

## Selectable views

`<View selectable>` (`view().selectable(true)` in Rust) makes the texts inside it select together, as a web page's
do: one selection runs across views, `Text` elements and `TextView`s, in reading order. See
[Text selection](../elements/text-selection.md).

## Animation

The animation API animates on the UI thread. You create an **animated value**, bind it (or values derived from it) to a style property, and start an animation; from then on every frame is computed natively, without running the app's code. A busy engine or JS thread cannot make the animation stutter, and an animation costs the app no work per frame. Rust code uses `animated_value()`, `motion()`, `Animation`, `Spring`, `Timing`, `KeyframeTiming`, `MotionPreset` and `Easing` from `nsh_core::prelude` and binds values with the `.bind_*` methods of elements; TSX imports them from `nsh`.

```rust tabs
use nsh_core::{element::LayoutAnimation, prelude::*}; // animated_value, motion, Animation, Spring, Timing, Keyframe, KeyframeTiming, MotionPreset, MotionSpec, Easing, animate_layout
```

```tsx tabs
import { Animated, createAnimatedValue, createMotion, motions, Easing, LayoutAnimation, AnimatedNode, AnimatedValue } from "nsh";
```

See [Animation](../docs/animation.md) for the guide.

### What an animated value can drive

| Where | Rust | TSX |
|---|---|---|
| `opacity` | `.bind_opacity(&value)` | `style={{ opacity: value }}` |
| `backgroundColor` | `.bind_background(&value.interpolate_colors(&[0.0, 1.0], &[white(), black()]))` | `style={{ backgroundColor: value.interpolate({ inputRange: [0, 1], outputRange: ["#fff", "#000"] }) }}` |
| `borderColor`, `color` | `.bind_border_color(&node)`, `.bind_color(&node)` | The same: a node of colors. `borderColor` colors every side; a `Text`'s `color` colors the whole text |
| `transform` | `.bind_translate_x(&value)`, `.bind_translate_y`, `.bind_scale`, `.bind_rotate` (degrees) | `translateX`, `translateY`, `scale`, `scaleX`, `scaleY`, `rotate`, `rotateX`, `rotateY`, `rotateZ` steps: `transform: [{ translateX: value }]` |
| Scroll position | `.scroll_value(&value)` on a scroll view or a list | `<Scroll scrollValue={value}>` and `<List scrollValue={value}>` write the scroll offset into it each frame |
| Gestures | `.pan_values(Some(&x), Some(&y))`, `.pinch_value(&scale)`, `.rotation_value(&angle)` | `pan={{ x, y }}`, `pinch={{ scale }}`, `rotation={{ angle }}` on any element: the gesture writes the values directly (see [Touch and gestures](../docs/touch-and-gestures.md)) |
| Where views stick | `.sticky().bind_sticky_top(&value)` (`.bind_sticky_left` in a horizontal scroll view), `.bind_sticky_header_offset(&value)` on a list | `style={{ position: "sticky", top: value }}`, `<List stickyHeaderOffset={value}>`: sticky views and headers stick that far from the start of the viewport, following the value every frame |
| Canvas | an animated argument of a painter's call | Any number or color argument of a [canvas](./nsh-canvas.md) drawing call |
| Shader | `.uniform(name, &value)` | A member of a [shader](../elements/shader.md)'s `struct Uniforms`: `uniforms={{ name: value }}` (numbers, or a node of colors for a `vec3f` / `vec4f`) |

Other style properties take plain values; to animate the layout itself (sizes, positions in the flow), use [`LayoutAnimation`](#layoutanimation).

### createAnimatedValue

```ts
function createAnimatedValue(value?: number): AnimatedValue;
```

Creates an animated value starting at `value` (default `0`). Rust: `animated_value(value)`, a `Copy` handle kept by the component that made it.

```rust tabs
use nsh_core::prelude::*;

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
import { createAnimatedValue } from "nsh";

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

### AnimatedValue

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

### AnimatedNode

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

### Keyframes

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

### createMotion

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

### motions

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

### Animated

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
| `sampleSpring`, `sampleDecay` | `nsh_core::element::sample_spring`, `sample_decay` | A spring's or decay's values one per frame (see [Easing](#easing)). |

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

### Easing

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

An easing is data, not a function of the app's: the runtime evaluates it natively. In Rust it is the enum `Easing`: `Linear`, `EaseIn`, `EaseOut`, `EaseInOut`, `Bezier(x1, y1, x2, y2)`, `Steps(count, StepPosition)` and `Curve(curve, mode)`, with a `Curve` (`Quad`, `Cubic`, `Poly(n)`, `Sin`, `Circle`, `Exp`, `Elastic(bounciness)`, `Back(s)`, `Bounce`) and an `EaseMode` (`In`, `Out`, `InOut`). To draw one, `Easing.sample(easing, count)` (Rust: `nsh_core::element::sample_easing`) gives its values at `count` evenly spaced points from 0 to 1; `Animated.sampleSpring` and `Animated.sampleDecay` (`sample_spring`, `sample_decay`) give a spring's or decay's values one per frame (at `fps`, 60 by default) from `from` (0) until it ends. All three come from the native code the animations run. Wherever an `Easing` is accepted in TSX you can pass a name (`"easeOut"`), a cubic Bézier as four numbers, or a curve from the `Easing` object.

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

### LayoutAnimation

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

`LayoutAnimation.configureNext(config)` animates the layout changes of the next commit natively: views that move or resize glide to their new frames, new views appear (fading or scaling in, by `property`) and removed views disappear. Call it right before the state change that changes the layout. Rust: `animate_layout(LayoutAnimation)`, with `nsh_core::element::LayoutAnimation`'s presets or its `create`, `update` and `delete` transitions.

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

## Device

The device API tells the app about the device and its environment. Rust code calls the functions of `nsh_core::prelude` (`window()`, `dark()`, `font_scale()`, `locale()`, `os()`, `idiom()`, `pixel_ratio()`, `set_color_scheme()`, ...); TSX imports `nsh`. The window size, the color scheme, the font scale, the pixel ratio and the locale are reactive: read them in a binding (a closure passed to an element in Rust, JSX in TSX), `computed` or `effect`, and what reads them updates when the platform reports a change (rotation, a window resize, switching to dark mode, changing the text size or the language, moving to a screen of another density).

```rust tabs
use nsh_core::{
    platform::{Appearance, Idiom, Os},
    prelude::*, // window, dark, font_scale, locale, os, idiom, pixel_ratio, set_color_scheme, ...
};
```

```tsx tabs
import { colorScheme, fontScale, locale, openUrl, pixelRatio, platform, setColorScheme, windowSize } from "nsh";
```

See [Device and environment](../docs/device-and-environment.md) for the guide.

### windowSize

```ts
const windowSize: Accessor<Size>;
```

The size of the surface in points: the window, or the embedded `NshAppView` / `NshView`. Reactive. Rust: `window() -> Size<Points>`.

```rust tabs
let wide = move || window().width >= px(600.0);

view().style_when(wide, |s| s.flex_row())
```

```tsx tabs
const wide = () => windowSize().width >= 600;

<View style={{ flexDirection: wide() ? "row" : "column" }}>{/* ... */}</View>
```

### colorScheme

```ts
const colorScheme: Accessor<"light" | "dark">;
```

The appearance shown: the system's, unless the app set its own (`nsh.json` `"appearance"`, [`setColorScheme`](#setcolorscheme)). Reactive. Rust: `dark() -> bool`; theme colors (`AdaptiveColor`) and the `.dark(…)` style variant follow it without reading it. Tailwind's `dark:` variant follows it too (see [Tailwind](../docs/tailwind.md)).

```rust tabs
view().flex_1().bg(move || if dark() { black() } else { white() })
```

```tsx tabs
const dark = () => colorScheme() === "dark";

<View style={{ flex: 1, backgroundColor: dark() ? "#000" : "#fff" }} />
```

### fontScale

```ts
const fontScale: Accessor<number>;
```

The user's preferred text size relative to the default (`1` is the default size; Dynamic Type on iOS, font size on Android), or the text size the embedding app sets in its place. Reactive. Rust: `font_scale() -> f32`. Text already scales with it unless `allowFontScaling={false}`; read it when other sizes should follow, such as icons next to text.

### locale

```ts
const locale: Accessor<string>;
```

The user's locale as a BCP 47 tag (`"en-US"`, `"zh-Hans-CN"`), or the locale the embedding app sets in its place. Reactive. Rust: `locale() -> Locale` (`locale().as_str()` is the tag). `Intl` formats for it by default; read it to choose the strings of your own translations ([Device and environment](../docs/device-and-environment.md#language-and-region)).

### setColorScheme

```ts
function setColorScheme(scheme: "light" | "dark" | "system"): void;
```

Shows the app in `scheme` whatever the system's appearance, at once: `colorScheme()`, `dark:` classes, the components' theme and the platform's controls (alerts, the status bar's default style) follow it; `"system"` follows the system again. `nsh.json` `"appearance"` sets it from the start. Rust: `set_color_scheme(Appearance::Dark)` (`Appearance::Light`, `Appearance::System`).

### platform

```ts
const platform: Platform;

interface Platform {
  readonly os: "ios" | "android" | "macos" | "windows" | "linux" | "web";
  readonly renderer: "native" | "web" | "terminal";
  readonly isTerminal: boolean;
  readonly version: string;
  readonly idiom: "phone" | "pad" | "mac" | "tv" | "desktop";
  readonly catalyst: boolean;
  select<T>(spec: PlatformSelectSpec<T>): T | undefined;
}
```

The platform the app runs on, constant while it runs.

| Member | Rust | Description |
|---|---|---|
| `os` | `os() -> Os` (`os().name()` is the TS string) | The operating system. iOS, the iOS simulator and Mac Catalyst report `"ios"`, browsers `"web"`. |
| `version` | `os_version() -> (u16, u16)` | iOS and desktops: the OS version (`"17.5"`); Android: the API level (`"35"`); the web: `"0.0"`. Rust gives the major and minor version, or the API level and 0 on Android. |
| `idiom` | `idiom() -> Idiom` | The kind of device: `"phone"`, `"pad"` (an iPad, an Android tablet), `"mac"` (Mac Catalyst in the Mac idiom), `"tv"` (Apple TV, Android TV) or `"desktop"`, the desktop device class: macOS, Windows, Linux, and browsers with a mouse and a wide window. |
| `catalyst` | `idiom() == Idiom::Mac` | Mac Catalyst in the Mac idiom. |
| `renderer` | `renderer()` | The surface's presentation: platform views / desktop graphics (`"native"`), browser HTML (`"web"`) or terminal cells (`"terminal"`). |
| `isTerminal` | `is_terminal()` | The surface renders in terminal cells. `os` reports the terminal host's operating system. |
| `select(spec)` | `match os() { … }` | The value for this platform (see below). |

```rust tabs
let columns = if is_desktop() { 3 } else { 1 };
```

```tsx tabs
const columns = platform.idiom === "desktop" && !platform.isTerminal ? 3 : 1;
```

#### platform.select

```ts
interface PlatformSelectSpec<T> {
  ios?: T;
  android?: T;
  macos?: T;
  windows?: T;
  linux?: T;
  web?: T;
  terminal?: T; // terminal rendering, before the OS
  mobile?: T;   // iOS, Android, and phone and tablet browsers
  desktop?: T;  // macOS, Windows, Linux, and desktop browsers
  native?: T;   // every platform but the web
  default?: T;
}
```

Returns the value for the current OS (`ios`, `android`, `web`, ...), else `mobile` / `desktop`, else `native` (every platform but the web), else `default`, else `undefined`. In a browser, `mobile` or `desktop` follows the idiom. Rust code matches on `os()` (and `is_desktop()` for `mobile` / `desktop`).

Terminals try `terminal`, then the host OS, then `native` and `default`. Use `platform.select({ terminal: "Press Enter", default: "Tap" })` for terminal interaction hints.

```rust tabs
use nsh_core::platform::Os;

let card = view().p_4();
let card = match os() {
    Os::Ios => card.shadow([BoxShadow {
        offset_y: px(2.0),
        blur: px(8.0),
        color: rgba(0x00000026).into(),
        ..BoxShadow::default()
    }]),
    Os::Android => card.elevation(px(4.0)),
    _ => card,
};
```

```tsx tabs
const shadow = platform.select({
  ios: { boxShadow: "0px 2px 8px rgb(0 0 0 / 0.15)" },
  android: { elevation: 4 },
});
```

> [!TIP]
> For props that only one platform has, prefer the `ios={{…}}` / `android={{…}}` props of TSX elements and components to branching on `platform` (see [Platform-specific code](../docs/platform-specific.md)).

### pixelRatio

```ts
const pixelRatio: Accessor<number>;
```

Device pixels per point (e.g. `3` on most iPhones). Reactive: it changes when the window moves to a screen of another density (on Mac Catalyst, the desktops, or an external display) and when Android's display size setting changes the density. Rust: `pixel_ratio() -> f32`, and `round_to_nearest_pixel(points)` for a length on whole device pixels; in TSX that length is `Math.round(x * pixelRatio()) / pixelRatio()`.

```rust tabs
let hairline = move || px(1.0 / pixel_ratio());
```

```tsx tabs
const hairline = () => 1 / pixelRatio();
```

### openUrl

```ts
function openUrl(url: string): Promise<boolean>;
```

Opens `url` outside the app: a web page in the browser, a `mailto:` link in the mail app, a `tel:` link in the phone app, and any scheme another app registered (`maps:`, a host app's own `lb://` links). It resolves to whether something opened it: `false` when no app handles the scheme. Rust: `open_url(url)` of `nsh_core::prelude`, an answer to await in a task (or to drop).

```rust tabs
button()
    .child(text("Contact us"))
    .on_press(|| {
        spawn(async {
            if !open_url("mailto:help@example.com").await {
                log::warn!("no mail app");
            }
        });
    })
```

```tsx tabs
<Button
  onPress={async () => {
    if (!(await openUrl("mailto:help@example.com"))) {
      console.warn("no mail app");
    }
  }}
>
  <Text>Contact us</Text>
</Button>
```

- The URL is absolute (it has a scheme). URLs that would run code or reach the app's own data, `javascript:`, `data:`, `blob:`, `file:`, `about:` and `asset:`, throw a `TypeError`, as do relative addresses.
- An app that declares capabilities needs `openUrl`: `"openUrl": true` for every scheme, or `"openUrl": { "schemes": ["https", "mailto"] }` for those listed; other URLs throw a `TypeError` (see [Sandbox and capabilities](../docs/sandbox-and-capabilities.md)).
- The embedding app sees the URL first and can route it through its own router instead (Swift `NshAppView.onOpenURL`, Java `NshView.setOpenUrlHandler`, Rust `AppView::host().handle_open_url`; see [iOS](../docs/ios.md#links-the-app-opens) and [Android](../docs/android.md#links-the-app-opens)). The promise then resolves to `true`.
- Each platform opens it with its own opener: `UIApplication.open` on iOS (the host app's application when embedded), an `ACTION_VIEW` intent on Android, `NSWorkspace` on macOS, `ShellExecuteW` on Windows, `GtkUriLauncher` on Linux, GPUI's `open_url`, a new tab on the web. `nsh test` records the URLs instead of opening them.
- A [`TextView`](../elements/text-view.md) opens its links this way with `links="open"`.

### Layout direction

The layout direction follows the user's language: in a right-to-left language (Arabic, Hebrew, ...) the app lays out right to left, rows run from the right, and `left` / `right` style properties (`marginLeft`, `paddingRight`, ...) mean start and end. Changes apply at once, with no restart.

A view's `direction` style (`"ltr"`, `"rtl"` or `"inherit"`, the default) sets the direction of its own subtree; in Rust, `.direction(LayoutDirection::..)`.

```rust tabs
view().direction(LayoutDirection::Rtl).flex_row().gap_2().child(text("First")).child(text("Second"))
```

```tsx tabs
<View style={{ direction: "rtl", flexDirection: "row", gap: 8 }}>
  <Text>First</Text>
  <Text>Second</Text>
</View>
```

### Related

- Safe area insets (Rust `safe_area()`; TSX `safeArea()`, `safeAreaInsets()`) and the software keyboard (Rust `keyboard_height()`; TSX `keyboardFrame()`) are part of [`nsh/base`](./nsh-base.md#safearea-and-safeareainsets).
- Screen reader and reduced motion settings are in [`nsh`](./nsh-accessibility.md).

## PanResponder

Pan responders are drag gestures on top of the gesture responder system: the element claims the touches of a gesture, then hears them alone with the gesture state, which tracks the touches' centroid, the distance moved and the velocity for you. Rust code claims them with `.claim_touches(TouchClaim::…)` and hears them with `.on_responder_*` listeners whose `ResponderEvent` carries a `PanGesture`, all in `nsh_core::prelude`; TSX imports `PanResponder` from `nsh`, whose `onPanResponder…` callbacks receive the touch event and the gesture state.

```rust tabs
use nsh_core::prelude::*; // TouchClaim, ClaimRequest, ResponderEvent, PanGesture
```

```tsx tabs
import { PanResponder, type PanResponderGestureState } from "nsh";
```

> [!TIP]
> A pan responder delivers every move to the app's code, so it suits gestures that change app state (reordering, swipe-to-delete decisions). To move a view with the finger, the native gesture values are faster: `.pan_values(x, y)`, `.pinch_value(scale)` and `.rotation_value(angle)` in Rust, the `pan={{ x, y }}`, `pinch` and `rotation` props in TSX. The drag writes [animated values](#animation) on the UI thread and the app only hears when it starts and ends (`on_pan_start` / `on_pan_end`, `onPanStart` / `onPanEnd`). See [Touch and gestures](../docs/touch-and-gestures.md).

### PanResponder.create

```ts
const PanResponder: { create(config: PanResponderCallbacks): PanResponderInstance };

interface PanResponderInstance {
  panHandlers: TouchProps;
}
```

Creates a pan responder. Spread its `panHandlers` on the view that should receive the gesture. In Rust, the view claims the touches and listens itself:

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let pos = signal((0.0_f32, 0.0_f32));
    let start = stored((0.0_f32, 0.0_f32));
    view().flex_1().child(
        view()
            .size(px(64.0))
            .rounded(px(32.0))
            .bg(rgb(0x6366f1))
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
                pos.set((x + e.gesture.delta.x.0, y + e.gesture.delta.y.0));
            })
            .on_responder_release(move |e: &ResponderEvent| {
                log::info!("released at {:.0} pt/s", e.gesture.vx);
            }),
    )
}
```

```tsx tabs
import { mount, signal, View } from "nsh";
import { PanResponder } from "nsh";

function App() {
  const pos = signal({ x: 0, y: 0 });
  let start = { x: 0, y: 0 };
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => (start = pos()),
    onPanResponderMove: (_, g) => pos.set({ x: start.x + g.dx, y: start.y + g.dy }),
    onPanResponderRelease: (_, g) => console.log(`released at ${g.vx.toFixed(0)} pt/s`),
  });
  return (
    <View style={{ flex: 1 }}>
      <View
        {...pan.panHandlers}
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: "#6366f1",
          transform: [{ translateX: pos().x }, { translateY: pos().y }],
        }}
      />
    </View>
  );
}

mount(App);
```

### Callbacks

Every callback receives the touch event (`GestureResponderEvent`, from [`nsh`](#types)) and the gesture state. In Rust, a claim decides with `.ask(|request: &ClaimRequest| …)`, calling `request.claim()` to take the touches (without `ask` it takes them always), and each listener gets a `ResponderEvent` whose `gesture` is the state.

```ts
type PanHandler<R = void> = (e: GestureResponderEvent, gestureState: PanResponderGestureState) => R;
```

| Callback | Rust | Returns | Called when |
|---|---|---|---|
| `onStartShouldSetPanResponder` | `.claim_touches(TouchClaim::on_start())` | `boolean` | A finger goes down: return `true` to become the responder. Asked from the touched view outwards. |
| `onStartShouldSetPanResponderCapture` | `TouchClaim::on_start().capture()` | `boolean` | The same, asked from the outside in before the bubbling one (a parent taking the gesture from its children). |
| `onMoveShouldSetPanResponder` | `TouchClaim::on_move().ask(…)` | `boolean` | A finger moves: return `true` to become the responder (e.g. only once `Math.abs(g.dx) > 10`). |
| `onMoveShouldSetPanResponderCapture` | `TouchClaim::on_move().capture()` | `boolean` | The same, capture phase. |
| `onPanResponderGrant` | `.on_responder_grant(…)` | | This view is the responder now: the gesture starts. |
| `onPanResponderReject` | `.on_responder_reject(…)` | | Another view is the responder and would not let go. |
| `onPanResponderStart` | `.on_responder_start(…)` | | A finger went down while responding. |
| `onPanResponderMove` | `.on_responder_move(…)` | | The fingers moved. |
| `onPanResponderEnd` | `.on_responder_end(…)` | | A finger lifted while responding. |
| `onPanResponderRelease` | `.on_responder_release(…)` | | The last finger lifted: the gesture ended. |
| `onPanResponderTerminate` | `.on_responder_terminate(…)` | | Another view (or a native gesture, like a scroll view) took the touches. |
| `onPanResponderTerminationRequest` | `.keep_touches(true)` keeps them | `boolean` | Another view wants the touches: return `false` to keep them (default `true`). |
| `onShouldBlockNativeResponder` | `TouchClaim::block_native(…)` | `boolean` | Whether to keep native scroll views from taking the touches while responding (default `true`). |

### PanResponderGestureState

```ts
interface PanResponderGestureState {
  stateID: number;
  moveX: number;               // latest centroid of the touches (surface points)
  moveY: number;
  x0: number;                  // the centroid when the responder was granted
  y0: number;
  dx: number;                  // distance moved since the grant
  dy: number;
  vx: number;                  // velocity, points per second
  vy: number;
  numberActiveTouches: number;
}
```

Rust: `PanGesture`, with points as `Point<Points>`.

| Field | Rust | Description |
|---|---|---|
| `stateID` |  | Identifies the gesture. |
| `moveX`, `moveY` | `position` | Latest position of the touches' centroid, in surface points. |
| `x0`, `y0` | `origin` | Where the centroid was when the responder was granted. |
| `dx`, `dy` | `delta` | Distance moved since the grant. |
| `vx`, `vy` | `vx`, `vy` | Velocity in points per second. |
| `numberActiveTouches` | `active_touches` | Fingers down. |

### Inside scroll views

While a pan responder is the responder, native scroll views around it do not scroll (`onShouldBlockNativeResponder` defaults to `true`). To let a horizontal swipe coexist with vertical scrolling, become the responder only on horizontal moves:

```rust tabs
view()
    .claim_touches(TouchClaim::on_move().ask(|request: &ClaimRequest| {
        let d = request.event.gesture.delta;
        if d.x.0.abs() > 10.0 && d.x.0.abs() > d.y.0.abs() {
            request.claim();
        }
    }))
    .on_responder_move(move |e: &ResponderEvent| offset.set(e.gesture.delta.x.0))
    .on_responder_release(move |e: &ResponderEvent| {
        if e.gesture.delta.x.0.abs() > 120.0 { remove() } else { offset.set(0.0) }
    })
    .on_responder_terminate(move |_: &ResponderEvent| offset.set(0.0))
```

```tsx tabs
const swipe = PanResponder.create({
  onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy),
  onPanResponderMove: (_, g) => offset.set(g.dx),
  onPanResponderRelease: (_, g) => (Math.abs(g.dx) > 120 ? remove() : offset.set(0)),
  onPanResponderTerminate: () => offset.set(0),
});
```

For a pan the platform recognizes, `TouchClaim::on_pan(PanActivation::horizontal(10.0, 10.0))` decides on the main thread as the fingers move. The underlying responder props (`onStartShouldSetResponder`, `onResponderGrant`, `onTouchStart`, ...) can also be used directly on any element; see [Elements](../elements/index.md).

## Clipboard

The clipboard API reads and writes the system clipboard: text everywhere (`UIPasteboard` on iOS, `ClipboardManager` on Android, `NSPasteboard`, GDK and the Win32 clipboard on desktops, `navigator.clipboard` on the web), images on iOS, the desktops and the web, and the files copied in a file manager on the desktops and Mac Catalyst. Rust code calls the functions of `nsh_core::prelude` (`set_clipboard`, `clipboard_string`, ...); TSX imports `Clipboard` from `nsh`.

```rust tabs
use nsh_core::prelude::*; // set_clipboard, clipboard_string, clipboard_image, ...
use nsh_core::element::ClipboardImage;
```

```tsx tabs
import { Clipboard } from "nsh";
```

```ts
const Clipboard: {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  hasText(): Promise<boolean>;
  writeImage(src: string): Promise<void>;
  readImage(): Promise<ClipboardImage | null>;
  hasImage(): Promise<boolean>;
  readFiles(): Promise<string[]>;
};

interface ClipboardImage {
  url: string; // data:image/png;base64,…
  size: PixelSize;
}
```

| TS | Rust (`nsh_core::prelude`) |
|---|---|
| `await Clipboard.writeText(text)` | `set_clipboard(text)` |
| `await Clipboard.readText()` | `clipboard_string().await -> String` |
| `await Clipboard.hasText()` | `clipboard_has_string().await -> bool` |
| `await Clipboard.writeImage(src)` | `set_clipboard_image(src)` |
| `await Clipboard.readImage()` | `clipboard_image().await -> Option<ClipboardImage>` |
| `await Clipboard.hasImage()` | `clipboard_has_image().await -> bool` |
| `await Clipboard.readFiles()` | `clipboard_files().await -> Vec<String>` |

The Rust reads return answers to await in a task (`spawn`, or an `async` module function); `ClipboardImage` is `nsh_core::element::ClipboardImage`, with `url` and `size` (a `Size<DevicePixels>`).

The user can also copy from a [selectable text](../elements/text.md) themselves; the clipboard API is for copying from code, such as a Copy button.

### Clipboard.writeText

```ts
writeText(text: string): Promise<void>;
```

Puts `text` on the clipboard, replacing what was there. Rust: `set_clipboard(text)`.

```rust tabs
use nsh_core::prelude::*;

fn copy_button(code: Signal<String>) -> impl IntoElement {
    let copied = signal(false);
    view()
        .role(AccessibilityRole::Button)
        .on_press(move || {
            set_clipboard(code.get());
            copied.set(true);
        })
        .child(text(move || if copied.get() { "Copied" } else { "Copy" }))
}
```

```tsx tabs
import { signal, Text, View } from "nsh";
import { Clipboard } from "nsh";

const copied = signal(false);

<View
  onPress={async () => {
    await Clipboard.writeText(code());
    copied.set(true);
  }}
>
  <Text>{copied() ? "Copied" : "Copy"}</Text>
</View>;
```

### Clipboard.readText

```ts
readText(): Promise<string>;
```

Resolves with the clipboard's text, or `""` when it holds none. Rust: `clipboard_string()`. On iOS, reading the clipboard can show the system's paste notice ("App pasted from …"), and on Android 10 and later only the app in the foreground can read it. Read it when the user asks to paste, not on every screen.

```rust tabs
spawn(async move {
    let pasted = clipboard_string().await;
    if !pasted.is_empty() {
        code.set(pasted.trim().to_string());
    }
});
```

```tsx tabs
const pasted = await Clipboard.readText();
if (pasted) code.set(pasted.trim());
```

### Clipboard.hasText

```ts
hasText(): Promise<boolean>;
```

Resolves with whether the clipboard holds text, without reading it: no paste notice on iOS. Rust: `clipboard_has_string()`. Use it to decide whether to show a Paste button. On the web, browsers only tell by reading, so it may ask the user for permission.

```rust tabs
let can_paste = signal(false);
spawn(async move { can_paste.set(clipboard_has_string().await) });
```

```tsx tabs
const canPaste = signal(false);
Clipboard.hasText().then((has) => canPaste.set(has));
```

### Clipboard.readImage

```ts
readImage(): Promise<ClipboardImage | null>;
```

Resolves with the clipboard's image, or `null` when it holds none: a pasted screenshot, or an image copied in a browser
or an image editor. Rust: `clipboard_image()`, `None` when it holds none. `url` is a `data:` URL of the image (PNG, or
the clipboard's own JPEG, GIF, WebP or BMP), which an [`Image`](../elements/image.md) shows as its `src`; in TSX,
`fetch(url)` gives its bytes, for an upload, and in Rust the base64 after the comma decodes to them. `size` (`width` and
`height`) is its size in pixels. As with `readText`, read it when the user asks to paste. Images of up to 48 MB (encoded) are
read, so the `data:` URL fits in the app's memory; for a larger one `readImage` resolves `null` and `hasImage` `true`.

```rust tabs
use base64::Engine as _;
use nsh_core::{element::ClipboardImage, prelude::*};

fn attachments() -> impl IntoElement {
    let attachments = signal(Vec::<ClipboardImage>::new());
    let paste = move || {
        spawn(async move {
            if let Some(image) = clipboard_image().await {
                attachments.update(|list| list.push(image));
            }
        });
    };
    view()
        .flex_row()
        .gap_2()
        .child(text("Paste").on_press(paste))
        .child(each(
            attachments,
            |shot: &ClipboardImage| shot.url.clone(),
            |shot, _| image(move || shot.with(|s| s.url.clone())).size(px(64.0)).rounded(px(8.0)),
        ))
}

async fn upload(image: &ClipboardImage) -> Result<HttpResponse, String> {
    let (_, data) = image.url.split_once(',').ok_or("not a data: URL")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    let request = HttpRequest::post("https://example.com/upload", bytes).header("Content-Type", "image/png");
    fetch(request).await
}
```

```tsx tabs
import { Image, signal, View } from "nsh";
import { Clipboard, type ClipboardImage } from "nsh";

const attachments = signal<ClipboardImage[]>([]);

async function paste() {
  const image = await Clipboard.readImage();
  if (image) attachments.set([...attachments(), image]);
}

async function upload(image: ClipboardImage) {
  const body = new FormData();
  body.append("file", await (await fetch(image.url)).blob(), "screenshot.png");
  await fetch("https://example.com/upload", { method: "POST", body });
}

<View class="flex-row gap-2">
  <Each of={attachments()}>
    {(image) => <Image src={image().url} style={{ width: 64, height: 64, borderRadius: 8 }} />}
  </Each>
</View>;
```

A chat-style app where users paste screenshots into a composer binds the paste shortcut while its input has the focus
and takes the image when there is one:

```rust tabs
use nsh_core::keymap::When;

on_key_with("mod+v", KeyOptions { when: When::Always, ..KeyOptions::default() }, move |_| {
    spawn(async move {
        if clipboard_has_image().await {
            paste().await;
        } else {
            insert_text(&clipboard_string().await);
        }
    });
});
```

```tsx tabs
import { keymap } from "nsh";

keymap.bind("mod+v", async () => {
  if (await Clipboard.hasImage()) return paste();
  insertText(await Clipboard.readText());
}, { when: "always" });
```

### Clipboard.hasImage

```ts
hasImage(): Promise<boolean>;
```

Resolves with whether the clipboard holds an image, without reading it: no paste notice on iOS. Rust:
`clipboard_has_image()`.

### Clipboard.writeImage

```ts
writeImage(src: string): Promise<void>;
```

Puts the image of `src`, a base64 `data:` URL such as `readImage` gives, on the clipboard, replacing what it holds. Rust:
`set_clipboard_image(src)`. On Windows it takes a PNG, the format browsers, Office and the Snipping Tool read.

```rust tabs
set_clipboard_image(image.url.clone());
```

```tsx tabs
await Clipboard.writeImage(image.url);
```

### Clipboard.readFiles

```ts
readFiles(): Promise<string[]>;
```

Resolves with the `file:` URLs of the files and folders copied in a file manager (Finder, Explorer, Files), in their
order, or `[]`: the same URLs a [file drop](../elements/view.md#desktop-file-drops) gives. Rust: `clipboard_files()`.
Parse a URL to get its path.

```rust tabs
let paths: Vec<std::path::PathBuf> = clipboard_files()
    .await
    .iter()
    .filter_map(|file| url::Url::parse(file).ok()?.to_file_path().ok())
    .collect();
```

```tsx tabs
const files = await Clipboard.readFiles();
const names = files.map((url) => decodeURIComponent(new URL(url).pathname.split("/").pop()!));
```

> [!NOTE]
> When your app declares `capabilities` in `nsh.json`, the clipboard must be granted with `"clipboard": true`. Without it `writeText` and `writeImage` do nothing, `readText` resolves `""`, `readImage` `null`, `readFiles` `[]` and `hasText` and `hasImage` `false`, from Rust and TSX alike. See [Sandbox and capabilities](../docs/sandbox-and-capabilities.md).

## Picker

The picker API shows the system's picker for photos and gives the app the images the user picks: the Photos picker on
iOS (`PHPickerViewController`), the Photo Picker on Android, an open panel or file dialog on the desktops and a file
input in a browser. On iOS and Android the picker runs outside the app and hands over only what the user picks, so it
needs no photo library permission. Each picked image arrives as a `File` (TSX) or a `PickedFile` (Rust) whose bytes stay
native: show it with `URL.createObjectURL(file)` in an [`Image`](../elements/image.md), upload it with `fetch` and
`FormData`. Rust code calls `pick_images` of `nsh_core::prelude`; TSX imports `Picker` from `nsh`.

```rust tabs
use nsh_core::picker::{PickRequest, PickedFile};
use nsh_core::prelude::*; // pick_images
```

```tsx tabs
import { Picker, type PickedImage } from "nsh";
```

```ts
const Picker: {
  pickImages(options?: PickImagesOptions): Promise<PickedImage[]>;
};

interface PickImagesOptions {
  multiple?: boolean; // let the user pick several (false: one)
  limit?: number; // at most this many when multiple (up to 100)
  maxDimension?: number; // scale images whose longer side is longer, in pixels
  quality?: number; // JPEG quality from 0 to 1 (0.9)
  format?: "compatible" | "current"; // "compatible": HEIC and the like as JPEG
}

interface PickedImage {
  file: File; // name, type, size in bytes and the bytes
  size: PixelSize; // upright
}
```

| TS | Rust |
|---|---|
| `await Picker.pickImages(options)` | `pick_images(request).await -> Vec<PickedFile>` |
| `multiple`, `limit` | `PickRequest::new(multiple, limit)` (`limit`: 0 for up to 100) |
| `maxDimension` | `request.max_dimension = Some(DevicePixels(2048))` |
| `quality` | `request.quality = Some(Percentage(0.8))` |
| `format` | `request.format = PickFormat::Current` |
| `image.file.name`, `.type`, `.size` | `file.name`, `file.mime`, `file.data.len()` |
| `image.size` | `file.size` (`Size<DevicePixels>`) |

### Picker.pickImages

```ts
pickImages(options?: PickImagesOptions): Promise<PickedImage[]>;
```

Shows the picker and resolves with the images the user picked, in the order picked, or `[]` when the user cancels.
Rust: `pick_images(request)`, an answer to await in a task (`spawn`, or an `async` module function). Options out of
range (`limit: 0`, a `quality` outside 0 to 1) throw a `RangeError` in the call.

The images come ready to send:

- **Formats every browser and server take.** JPEG, PNG, GIF and WebP come as they are; a photo stored in another
  format (HEIC on iPhones, HEIF, TIFF) comes as a JPEG. `format: "current"` keeps the stored format.
- **Scaled down natively.** With `maxDimension`, an image whose longer side is longer is scaled to fit it, upright, and
  encoded again: a PNG as a PNG, anything else as a JPEG of `quality`. Phone photos are 12 to 48 megapixels; scaling
  them to 2048 pixels before an upload makes them a few hundred kilobytes. A `quality` encodes JPEGs again too.
- **What it shows.** `size` is the image's size in pixels as it shows, its camera orientation applied. An image NSH
  encodes again carries no metadata (no location); one that comes as it is keeps its own.

On Windows, Linux and in GPUI windows, the dialog offers the formats the request takes (with `"compatible"`: JPEG, PNG,
GIF and WebP) and the files come as they are stored, at their own size.

A chat composer attaches a photo, shows it while the message is written, and uploads it when it is sent:

```rust tabs
use nsh_core::geometry::{DevicePixels, Percentage};
use nsh_core::picker::{PickRequest, PickedFile};
use nsh_core::prelude::*;

fn attach_button(attached: Signal<Option<PickedFile>>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::Button)
        .accessibility_label("Choose a photo")
        .on_press(move || {
            let mut request = PickRequest::new(false, 1);
            request.max_dimension = Some(DevicePixels(2048));
            request.quality = Some(Percentage(0.85));
            let picked = pick_images(request);
            spawn(async move {
                if let Some(file) = picked.await.into_iter().next() {
                    attached.set(Some(file));
                }
            });
        })
        .child(text("Photo"))
}

async fn upload(file: &PickedFile) -> Result<HttpResponse, String> {
    let request = HttpRequest::post("https://example.com/upload", file.data.to_vec())
        .header("Content-Type", file.mime.as_str());
    fetch(request).await
}
```

```tsx tabs
import { Image, signal, Text, View } from "nsh";
import { Picker } from "nsh";

const attached = signal<{ file: File; src: string } | null>(null);

async function choosePhoto() {
  const [picked] = await Picker.pickImages({ maxDimension: 2048, quality: 0.85 });
  if (picked) attached.set({ file: picked.file, src: URL.createObjectURL(picked.file) });
}

async function send(text: string) {
  const body = new FormData();
  body.append("text", text);
  if (attached()) body.append("photo", attached()!.file);
  await fetch("https://example.com/messages", { method: "POST", body });
  if (attached()) URL.revokeObjectURL(attached()!.src);
  attached.set(null);
}

<View class="flex-row items-center gap-2">
  <View role="button" accessibilityLabel="Choose a photo" onPress={choosePhoto}>
    <Text>Photo</Text>
  </View>
  <If when={attached()}>
    <Image src={attached()!.src} style={{ width: 48, height: 48, borderRadius: 8 }} />
  </If>
</View>;
```

Several photos at once:

```rust tabs
let picked = pick_images(PickRequest::new(true, 9));
spawn(async move {
    let files = picked.await;
    photos.update(|list| list.extend(files));
});
```

```tsx tabs
const images = await Picker.pickImages({ multiple: true, limit: 9, maxDimension: 2048 });
photos.set([...photos(), ...images.map((image) => URL.createObjectURL(image.file))]);
```

### Embedding apps

An app that embeds NSH and has a picker of its own (one with the app's own albums, say) answers the picks itself: in
Rust, a `PickerBackend` (`nsh_core::picker`) given to the engine (`EngineConfig::picker`, or `AppView::set_picker` in
GPUI and GPUI Kit apps) receives every pick's `PickRequest` and returns the files, and the system's picker is not
shown. The files it returns are completed as the platform's are: cut to the request's limit, their sizes, types and
extensions read from their bytes.

### Tests

`nsh test` answers picks in headless runs: `app.onPick(handler)` returns the files the user picks (`{ name, type, data }`),
and without a handler a pick is cancelled. See [Testing](../docs/testing-and-trace.md).

> [!NOTE]
> When your app declares `capabilities` in `nsh.json`, the picker must be granted with `"picker": true`. Without it
> `pickImages` resolves `[]` and shows nothing, from Rust and TSX alike. See
> [Sandbox and capabilities](../docs/sandbox-and-capabilities.md).

## Storage

The storage API keeps the app's data on the device: strings by string key, still there the next time the app starts. Use it for settings, drafts, the last tab the user had open, a cache of what the server sent — any state that should outlive the app's process. Rust code uses `nsh_core::storage::Storage`, TSX imports `Storage` from `nsh`; both read and write the same entries, so an app with a Rust entry and a TSX entry sees one set of data.

```rust tabs
use nsh_core::storage::Storage;
```

```tsx tabs
import { Storage } from "nsh";
```

```ts
const Storage: {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
};
```

| TS | Rust (`nsh_core::storage::Storage`) |
|---|---|
| `await Storage.getItem(key)` | `Storage::get_item(key) -> Option<String>` |
| `await Storage.setItem(key, value)` | `Storage::set_item(key, value) -> Result<(), StorageFull>` |
| `await Storage.removeItem(key)` | `Storage::remove_item(key)` |
| `await Storage.keys()` | `Storage::get_all_keys() -> Vec<String>` |
| `await Storage.clear()` | `Storage::clear()` |

The Rust functions are synchronous, as the entries are in memory: call them where components run (their bodies, handlers and tasks).

Each app has a storage of its own, up to 5 MB of keys and values. Calls run in the order the app makes them, so a `getItem` after a `setItem` sees the new value without waiting for the write. Reads come from memory; writes reach the disk in the background, a few at a time.

| Platform | Where the data is kept |
|---|---|
| iOS | `Library/Application Support/nsh/<app id>/storage.json` in the app's container |
| Android | `files/nsh/<app id>/storage.json` in the app's private directory |
| macOS | `~/Library/Application Support/<app id>/storage.json` |
| Windows | `%APPDATA%\<app id>\storage.json` |
| Linux | `$XDG_DATA_HOME/<app id>/storage.json` (`~/.local/share/…`) |
| Web | The browser's `localStorage`, under keys named after the app id (`nsh:com.example.todo:…`) |

A `storage.json` that is damaged is kept as `storage.json.corrupt` next to it, and the app starts with an empty storage; one that cannot be read leaves the app's changes in memory, so the file is never replaced.

The app id is the `id` in `nsh.json`, and it travels with the app: `nsh build` and `nsh package` write it next to the bundle, the dev server sends it, and a signed package carries the one its release key's certificate vouches for. So every app keeps its own data with no setting, wherever it runs; an app without an id keeps it under `default`. An embedding app can choose another place (see [Embedding on iOS](../docs/ios.md) and [Embedding on Android](../docs/android.md)).

### Storage.getItem

```ts
getItem(key: string): Promise<string | null>;
```

Resolves with the value of `key`, or `null` when it has none. Rust: `Storage::get_item(key)`, `None` when it has none.

```rust tabs
let theme = Storage::get_item("theme").unwrap_or_else(|| "system".into());
```

```tsx tabs
const theme = (await Storage.getItem("theme")) ?? "system";
```

### Storage.setItem

```ts
setItem(key: string, value: string): Promise<void>;
```

Sets `key` to `value`, replacing what it held. Rejects when the storage would grow past 5 MB; the value is not kept then. Rust: `Storage::set_item(key, value)`, which returns `Err(StorageFull)` then. Values are strings: keep structured data as JSON (`serde_json::to_string` in Rust, `JSON.stringify` in TSX) and read it back (`serde_json::from_str`, `JSON.parse`).

```rust tabs
let draft = serde_json::json!({ "title": title.get(), "body": body.get() });
if let Err(full) = Storage::set_item("draft", draft.to_string()) {
    log::warn!("{full}");
}
```

```tsx tabs
Storage.setItem("draft", JSON.stringify({ title: title(), body: body() }));
```

### Storage.removeItem

```ts
removeItem(key: string): Promise<void>;
```

Removes `key` and its value. Removing a key that has no value does nothing. Rust: `Storage::remove_item(key)`.

### Storage.keys

```ts
keys(): Promise<string[]>;
```

Resolves with every key, in order. Rust: `Storage::get_all_keys()`.

### Storage.clear

```ts
clear(): Promise<void>;
```

Removes every key of the app, such as when the user signs out. Rust: `Storage::clear()`.

### Keeping a signal on the device

Read the stored value when the app starts, then write it back whenever the signal changes:

```rust tabs
use nsh_core::{storage::Storage, prelude::*};

#[component]
pub fn App() -> impl IntoElement {
    let saved = Storage::get_item("count").and_then(|n| n.parse().ok());
    let count = signal(saved.unwrap_or(0_u32));
    effect(move || {
        if let Err(full) = Storage::set_item("count", count.get().to_string()) {
            log::warn!("{full}");
        }
    });
    view()
        .on_press(move || count.update(|n| *n += 1))
        .child(text(move || format!("Pressed {} times", count.get())))
}
```

```tsx tabs
import { effect, mount, signal, Text, View } from "nsh";
import { Storage } from "nsh";

const count = signal(0);
const loaded = signal(false);
Storage.getItem("count").then((saved) => {
  count.set(Number(saved ?? 0));
  loaded.set(true);
});
effect(() => {
  if (loaded()) Storage.setItem("count", String(count()));
});

mount(() => (
  <View onPress={() => count.update((n) => n + 1)}>
    <Text>Pressed {count()} times</Text>
  </View>
));
```

## host

`host` reaches the app that embeds NSH: the native app around an `NshAppView` / `NshView`, or on the web the page that runs the player. The app calls the host's functions by name with JSON arguments and listens to the events the host sends.

```ts
import { host } from "nsh";
```

```ts
const host: {
  readonly params: { readonly [key: string]: unknown };
  post(name: string, data?: unknown): void;
  available(): boolean;
  call(name: string, args?: unknown, options?: { timeout?: number }): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): (() => void) & { remove(): void };
};
```

### host.available

```ts
available(): boolean;
```

Whether the platform has a host that answers calls. On the web it is `true` when the page gives the player a host ([The host on the web](#the-host-on-the-web)).

```tsx
import { Text } from "nsh";
import { host } from "nsh";

<Text>{host.available() ? "Embedded" : "Standalone"}</Text>;
```

### host.call

```ts
call(name: string, args?: unknown, options?: { timeout?: number }): Promise<unknown>;
```

Calls the host's function `name` with `args` (any JSON value; `null` without one) and resolves with what it returns. The call rejects with the host's error message when the function fails, with `nsh/host: this platform has no host` when `host.available()` is `false`, and when `name` is not in the app's [`host` capability](#capability) or is no valid name (1 to 128 of `A`–`Z`, `a`–`z`, `0`–`9`, `_`, `.`, `:`, `-`, without `..`).

A call waits 30 seconds for the host's answer, then rejects with `nsh/host: <name> timed out after 30000 ms`; an answer that comes later is dropped. `options.timeout` sets the wait in milliseconds, `0` for no limit; a timeout so large the clock never gets there (about 1e22 ms) waits without limit too, and a negative, `NaN` or infinite one rejects the call with `nsh/host: invalid timeout <value>`. The time is the app's, as its timers': in `nsh test` with a manual clock it moves with the clock.

```ts
const user = (await host.call("getUserInfo")) as { name: string };
const quote = await host.call("quote.refresh", { symbol: "AAPL" }, { timeout: 5000 });
```

### host.on

```ts
on(event: string, listener: (payload: unknown) => void): (() => void) & { remove(): void };
```

Platform events call `listener` with the payload of every `event` the host sends, until `remove()`. Events the host sends before the app starts arrive once it does, so listeners registered at the top level of the app receive them; an event sent before a listener registers is not replayed to it. Read the state the app starts with through `host.call`, and follow its changes with `host.on`.

```ts
const sub = host.on("loginChanged", (payload) => console.log(payload));
// later
sub.remove();
```

### Capability

Every function the app calls must be listed in `nsh.json`'s `capabilities.host`: exact names or prefixes ending in `*`, or `true` for all of them. This holds for every app, also one without other `capabilities`: the host's functions are never granted by default. A call that is not granted rejects and is logged, and building an app that imports `host` from `nsh` without `capabilities.host` warns. Events need no grant. See [Sandbox and capabilities](../docs/sandbox-and-capabilities.md#host).

```json
{ "capabilities": { "host": ["getUserInfo", "bridge.*"] } }
```

### The host on the web

On the web the page is the host. `createPlayer`'s `host` option answers the calls, and `player.hostEvent(event, payload)` sends events:

```js
const player = await createPlayer(container, {
  wasm: "./nsh.wasm",
  host: { call: (name, args) => (name === "getUserInfo" ? { name: "Ada" } : Promise.reject(new Error(name))) },
});
player.hostEvent("loginChanged", { signedIn: true });
```

A published app names its host in `nsh.json`: `web.host` is a JS module in the app's directory, relative to `nsh.json`, exporting `createHost(player)`, which returns the object with `call`. `nsh package --target web` ships it with the site, `nsh run --target web` runs it on the development page, and `nsh test` runs it for the apps its tests open. `web.connect` lists the hosts the host's own requests reach, which the page's Content-Security-Policy allows alongside the app's `capabilities.network`. See [Web](../docs/web.md#the-hosts-functions).

```json
{ "web": { "host": "./host.js", "connect": ["api.example.com"] } }
```

### host.params

The parameters the embedding app set before it started your app, read synchronously from the first line of your code; `{}` when it set none. They stay the same while your app runs: later requests come as events.

```tsx
const conversation = host.params.conversation as string | undefined;
mount(() => (conversation ? <Conversation id={conversation} /> : <Inbox />));
```


### Native SDK channel

The native SDK's `send` keeps events until the app listens, up to 256. When the last listener unsubscribes during delivery, remaining events keep waiting in order; events sent during shutdown wait for the next loaded app. The subscription returned by `host.on` is both a cleanup function and an object with `remove()`. `host.post(name, data)` delivers data to the native SDK handler, whose `isPost` distinguishes posts from calls.

### The embedding app's side

Each view keeps one channel for every app it loads. Set parameters before loading, send events at any time from any thread, and register handlers by name. Calls and posts require the app's `capabilities.host` grant. Handlers answer once, now or later; an answer that never comes fails the call.

```rust tabs
// Any platform's AppView (GPUI, macOS, Windows, Linux, iOS): its HostChannel.
use serde_json::json;

let host = view.host();
let mut params = serde_json::Map::new();
params.insert("conversation".into(), json!("42"));
host.set_params(params);
// Runs on the engine thread: answer at once, or move the call and answer later from any thread.
host.handle("user.profile", |call| {
    let id = call.data()["id"].clone();
    call.resolve(json!({ "id": id, "name": "Ada" }));
});
host.send("conversation.open", json!({ "id": "43" })).unwrap();
```

```swift tabs
appView.params = ["conversation": "42"]
try appView.loadBundle(at: bundleURL)

// On the main thread; return the answer, or throw to reject the call.
appView.handle("user.profile") { data in
    let id = (data as? [String: Any])?["id"]
    return ["id": id ?? NSNull(), "name": try await profiles.name(of: id)]
}
appView.handle("analytics") { data, _ in analytics.log(data) }
appView.send("conversation.open", ["id": "43"])
```

```java tabs
nsh.setParams(Map.of("conversation", "42"));
nsh.loadAssetBundle("nsh");

// On the UI thread; answer now or later, from any thread.
nsh.handle("user.profile", (data, reply) -> {
    Object id = ((Map<?, ?>) data).get("id");
    profiles.load(id, profile -> reply.resolve(Map.of("id", id, "name", profile.name)),
            error -> reply.reject(error.getMessage()));
});
nsh.send("conversation.open", Map.of("id", "43"));
```

See [Embedding on iOS](../docs/ios.md#talking-to-the-app), [Embedding on Android](../docs/android.md#talking-to-the-app) and [GPUI](../docs/gpui.md).

> [!NOTE]
> Native SDK calls and posts use the same [`host` capability](../docs/sandbox-and-capabilities.md#host) as platform calls. A Rust app reaches the embedding app's Rust directly, through the functions it registers ([`nativeModule`](#nativemodule) and Rust imports).

## keymap

The keymap binds the app's keyboard shortcuts: a keystroke such as `"mod+k"` and the function it runs. Rust code calls `on_key`, `on_key_with` and `key_label` from `nsh_core::prelude`; TSX imports `keymap` from `nsh`. Both take the same keystrokes and follow the same rules.

```rust tabs
use nsh_core::prelude::*; // on_key, on_key_with, KeyOptions, key_label
```

```tsx tabs
import type { YNode } from "nsh";
import { keymap } from "nsh";
```

```ts
const keymap: {
  bind(keystroke: string, handler: (keystroke: string) => void, options?: KeyBindingOptions): () => void;
  bind(bindings: Record<string, (keystroke: string) => void>, options?: KeyBindingOptions): () => void;
  focusedWithin(node: YNode): boolean;
  label(keystroke: string): string;
};

interface KeyBindingOptions {
  when?: "always" | "notEditing";
  repeat?: boolean;
  fallback?: boolean;
  within?: YNode;
}
```

| TS | Rust |
|---|---|
| `keymap.bind(keystroke, handler)` | `on_key(keystroke, handler)` |
| `keymap.bind(keystroke, handler, { when, repeat })` | `on_key_with(keystroke, KeyOptions { when, repeat }, handler)`; `when` is `nsh_core::keymap::When` (`Auto`, `Always`, `NotEditing`) |
| `keymap.bind({ … })` | one `on_key` per keystroke |
| `keymap.label(keystroke)` | `key_label(keystroke)` |

A Rust binding lives as long as the component (the owner) that made it; the handler gets the keystroke as written.

Shortcuts work on macOS, Windows, Linux and in browsers (the browser's own keys, such as Ctrl+T or Cmd+W, never reach the page), and on iOS and Android with a hardware keyboard: an iPad's, a Mac's running an iPad app, a tablet's or a Chromebook's, the simulator's and the emulator's. The same code runs everywhere; without a keyboard, no key fires the bindings.

### keymap.bind

```ts
bind(keystroke: string, handler: (keystroke: string) => void, options?: KeyBindingOptions): () => void;
```

Runs `handler` when `keystroke` is pressed and returns a function that removes the binding. The handler gets the keystroke as you wrote it, in its case. Rust: `on_key(keystroke, handler)`.

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let open = signal(false);
    on_key("mod+k", move |_| open.set(true));
    on_key("escape", move |_| open.set(false));
    text(move || if open.get() { "Search…" } else { "Press ⌘K" })
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { keymap } from "nsh";

const open = signal(false);
keymap.bind("mod+k", () => open.set(true));
keymap.bind("escape", () => open.set(false));

mount(() => <Text>{open() ? "Search…" : "Press ⌘K"}</Text>);
```

Pass an object to bind several keystrokes at once; the function returned removes them all. In Rust, each keystroke is one `on_key`:

```rust tabs
on_key("mod+s", move |_| save());
on_key("mod+shift+p", move |_| open_palette());
on_key("f5", move |_| refresh());
```

```tsx tabs
const unbind = keymap.bind({
  "mod+s": save,
  "mod+shift+p": openPalette,
  f5: refresh,
});
```

A binding made while a component renders is removed with the component, so a screen's shortcuts live as long as the screen:

```rust tabs
#[component]
fn Editor() -> impl IntoElement {
    on_key("mod+enter", move |_| send());
    input().multiline(true)
}
```

```tsx tabs
function Editor() {
  keymap.bind("mod+enter", send);
  return <Input multiline />;
}
```

With the dev server, editing a module removes the bindings its top-level code made before it runs again, so hot reload never leaves stale shortcuts behind.

#### Native focus scopes

On a host with native focus scopes, `within` limits a binding to keyboard focus on that node or one of its descendants. Pass a `YNode`
from the running app. NSH checks the native focus path when each key arrives, together with `when` and `repeat`.
If the scope does not match, NSH tries older bindings of the same keystroke, then its ordinary input handling.
A scope with no focused descendant, including a removed scope, leaves those routes available.

```tsx
import { Scroll, Text } from "nsh";
import { keymap } from "nsh";

function ActivityPanel() {
  const panel = Scroll({
    style: { height: 160 },
    children: <Text>Activity</Text>,
  });
  keymap.bind("mod+end", () => panel.scrollToEnd({ animated: false }), {
    within: panel,
    when: "always",
  });
  return panel;
}
```

`within` is supported by terminal and GPUI hosts; supplying it without native focus-scope support throws `TypeError`. A binding with no `within`
keeps its existing app-wide behavior.

### keymap.focusedWithin

```ts
focusedWithin(node: YNode): boolean;
```

Reads whether `node` or one of its descendants has keyboard focus in the host's latest focus
snapshot. It returns `false` when no node has focus or the node is outside that path, including after removal.
The argument is a `YNode` from the running app; calling it without native focus-scope support throws `TypeError`.

This is a nonreactive snapshot read. Calling it inside an effect adds no focus dependency; other reactive reads,
such as `windowSize()`, determine when that effect runs. Each call reads the latest snapshot supplied by the host.

### keymap.label

```ts
label(keystroke: string): string;
```

Returns `keystroke` as menus and hints show it where the app runs: `"⇧⌘L"` on macOS and iOS (and in a browser on a Mac, iPhone or iPad), `"Ctrl+Shift+L"` on Windows, Linux and other browsers, for `"mod+shift+l"`. Rust: `key_label(keystroke)`. Use it to show an app's shortcuts with the keys that work:

```rust tabs
text(format!("Search {}", key_label("mod+k")))
```

```tsx tabs
<Text>Search {keymap.label("mod+k")}</Text>
```

It throws a `TypeError` for an invalid keystroke, as `bind` does; `key_label` and `on_key` panic with the same message.

### Keystrokes

A keystroke is modifiers and a key joined by `+`: `"mod+k"`, `"ctrl+shift+p"`, `"alt+enter"`, `"escape"`, `"f5"`, `"cmd+-"` (Command and minus).

| Modifier | macOS | Windows | Linux |
|---|---|---|---|
| `mod` (also `cmdorctrl`) | Command (⌘) | Ctrl | Ctrl |
| `cmd` (also `command`, `meta`, `super`, `win`) | Command (⌘) | Windows key | Super |
| `ctrl` (also `control`) | Control (⌃) | Ctrl | Ctrl |
| `alt` (also `option`, `opt`) | Option (⌥) | Alt | Alt |
| `shift` | Shift (⇧) | Shift | Shift |

iOS follows macOS (`mod` is Command) and Android follows Windows and Linux (`mod` is Ctrl, `cmd` the Meta key). In a browser, keys follow the platform the browser runs on: `mod` is Command on a Mac, iPhone or iPad and Ctrl elsewhere.

In a terminal, `mod` is Ctrl on every host OS. Control+Q quits the terminal app. `keymap.label("mod+k")` returns `"Ctrl+K"`.

Use `mod` for an app's own shortcuts: it is the key each platform's apps use for them (⌘K on macOS, Ctrl+K on Windows and Linux), so one spelling fits everywhere. The Windows key and Super mostly belong to the system, so `cmd` is rarely right outside macOS.

The key is a letter, digit or punctuation key, written as the character it types on a US keyboard without Shift (`k`, `1`, `,`, `/`, `[`; `"shift+/"` for `?`, `"shift+k"` for Shift+K), or a name: `plus` (the `=` / `+` key, also written `=`), `minus` (also `-`), `space`, `enter` (`return`), `escape` (`esc`), `tab`, `backspace`, `delete` (`del`), `insert`, the arrows `up`, `down`, `left`, `right` (`arrowup`, …), `home`, `end`, `pageup`, `pagedown`, `f1` to `f24`. Case does not matter: `"Mod+Shift+K"` is `"mod+shift+k"`, and a capital letter is the same key, not Shift (`"mod+K"` is `"mod+k"`). Lowercase is the recommended style, which these pages use. `"mod-k"` and `"mod++"` are errors whose messages give the right spelling. Menu shortcuts in `nsh/desktop` take the same keystrokes.

Shortcuts work with any keyboard layout: on a Cyrillic or Greek layout, `mod+k` is the key that types K on a US layout, as menu shortcuts are.

`bind` throws a `TypeError` that says what is wrong with an invalid keystroke (`keymap.bind: invalid keystroke "cmd+kk": unknown key "kk"`), and refuses the keystrokes the system keeps for itself, so an app can never break them:

| Platform | Reserved |
|---|---|
| macOS, iOS | Cmd+Q (quit), Cmd+H (hide), Option+Cmd+H (hide others), Cmd+M (minimize), Ctrl+Cmd+F (full screen) |
| Linux, Windows, Android | Ctrl+Q (quit), Alt+F4 (close), F11 (full screen) |
| Web | None (the browser keeps its own keys) |

### While typing

A text input with the keyboard focus needs its keys: typing, moving the caret, deleting, and select all, cut, copy, paste, undo and redo. So by default a binding does not fire while a text input (or a web view) has the focus if its keystroke is one of these: plain keys and keys with only Shift or Option, the arrows, Home, End, Page Up / Down, Return, Tab, Escape, Backspace, Delete, and `mod+a`, `mod+c`, `mod+v`, `mod+x`, `mod+z`. Other keystrokes with Command or Control, and the function keys, fire wherever the focus is.

`when` changes that (Rust: `KeyOptions { when: When::Always, .. }`):

| `when` | Fires |
|---|---|
| (default) | As above |
| `"always"` | Also in text inputs, before the input sees the key |
| `"notEditing"` | Never while a text input has the focus |

```rust tabs
use nsh_core::keymap::When;

// Sends from the message field too.
on_key_with("mod+enter", KeyOptions { when: When::Always, ..KeyOptions::default() }, move |_| send());
// Only when the user is not typing.
on_key_with("mod+e", KeyOptions { when: When::NotEditing, ..KeyOptions::default() }, move |_| archive());
```

```tsx tabs
// Sends from the message field too.
keymap.bind("mod+enter", send, { when: "always" });
// Only when the user is not typing.
keymap.bind("mod+e", archive, { when: "notEditing" });
```

On iOS and Android, a key an input method is composing with (choosing a candidate, committing) stays the input method's. On the GPUI backend, a native component with the keyboard focus counts as a text input, since it may be a text editor. It sees each key first: a key it handles itself never reaches the bindings, and the bindings that fire while text is edited get the keys it lets through.

### Which binding runs

A key that fires a binding is consumed: it is not typed, the system does not beep, and NSH's own keys do not see it (Escape going back, Tab moving the focus, the arrows scrolling). When several bindings have the same keystroke, the newest one that may fire runs, so a dialog can bind Escape over the screen's binding and the screen's comes back when the dialog's goes. Bindings are checked natively the moment the key is pressed; the handler runs right after, on the engine thread (Rust) or the JS thread (TSX).

Holding a key down fires its binding once, until the key is released; with `repeat: true` it fires again on every auto-repeat (to step through a list, say):

```rust tabs
on_key_with("alt+down", KeyOptions { repeat: true, ..KeyOptions::default() }, move |_| next_item());
```

```tsx tabs
keymap.bind("alt+down", nextItem, { repeat: true });
```

Menu shortcuts give way to a binding of the same keystroke: the application menu's ([`nsh/desktop`](./nsh-desktop)) on every desktop, and on macOS the built-in menus' too (Cmd+W, Cmd+C, ...). While you develop with `nsh run`, Cmd+R / Ctrl+R always reloads the app, even if it binds `mod+r`; a packaged app can bind it.

`fallback: true` runs only after native controls, text editing, selection and navigation leave the key unhandled. Terminal and GPUI hosts support this phase; other hosts reject it. Regular bindings retain their earlier priority.

## nativeComponent and nativeModule

`nsh` connects your app to what the host app provides, by name, at run time. An iOS or Android app that embeds NSH can register its own views (a map, a chart, a camera preview) by name; `nativeComponent` gives you a typed component for one of them. Because NSH renders with real native views, such a component sits in the view hierarchy like any other view: it is laid out by NSH, clips and scrolls with its parents, and overlaps correctly. An app that embeds NSH from Rust can also register functions, classes and Rust components; `nativeModule` gives you them as one typed object. Your app builds with the stock `nsh build` either way: the host connects what it provides when it runs the app. Rust code places a registered view with `native(name)` from `nsh_core::prelude`, sets its props with `.prop(name, value)` (a JSON value, or a signal or closure of one) or binds one to an animated value with `.bind_prop(name, &value)`, hears its events with `.on_native_event(…)` and calls its commands through an `ElementRef`; TSX imports `nsh`.

```rust tabs
use nsh_core::prelude::*; // native, NativeEvent, element_ref
```

```tsx tabs
import { nativeComponent, nativeModule } from "nsh";
```

See [Native components](../docs/native-components.md) for registering the native side, and [Embedding on iOS](../docs/ios.md) / [Embedding on Android](../docs/android.md).

### nativeComponent

```ts
function nativeComponent<P extends object = {}, E extends object = {}>(
  name: string,
  spec: NativeComponentSpec<P, E>,
): (props: NativeComponentProps<P, E>) => YNode;

interface NativeComponentSpec<P, E> {
  /** Its own props: sent to the component (any JSON value), each when it changes. */
  props: readonly (keyof P & string)[];
  /** The events it emits. */
  events?: readonly (keyof E & string)[];
}
```

Returns a component for the native component the embedding app registered as `name` (Swift `NshAppView.register(component:)`, Java `NshView.registerComponent`). Rust: `native(name)`, a view whose props are JSON values (`.prop("text", json!(…))`) and whose events arrive as `NativeEvent { name, data }`.

- `P` is the type of its own props. Each prop listed in `spec.props` is sent to the native side as JSON when it changes; setting it to `undefined` removes it.
- `E` maps event names to their payloads. An event `regionChange` becomes the handler prop `onRegionChange`.
- The component also takes every [view prop](../elements/view.md) except `children`: `style`, `class`, layout, accessibility, touch handlers and `ref`.

```ts
type NativeComponentProps<P, E> = Omit<ViewProps, "children"> & P & NativeEventHandlers<E>;
type NativeEventHandlers<E> = { [K in keyof E & string as `on${Capitalize<K>}`]?: (data: E[K]) => void };
```

#### Size

The component is laid out like a view, at the size its style gives it. Where the style leaves a dimension open, it uses the size the native component reports (as an image uses its natural size).

#### Commands

Its `ref` receives a `YNode`; `ref.command(name, args)` calls command `name` of the native component with `args` (any JSON value). Rust: `ElementRef::command(name, args)`.

```rust tabs
map.command("zoomTo", json!({ "level": 3 }));
```

```tsx tabs
map.command("zoomTo", { level: 3 });
```

#### When nothing is registered

Where nothing is registered under `name` (a different host app, the dev host, the browser), the component renders an empty view and a warning is logged once. Keep the app usable without it, or check for your host before using it.

### Example

The badge here is a native view of the host app, registered as `embed.badge`. NSH lays it out, sends it `text` and `color`, receives its `tap` events, and calls its `pulse` command:

```rust tabs
use nsh_core::prelude::*;
use serde_json::json;

#[component]
pub fn App() -> impl IntoElement {
    let taps = signal(0_u64);
    let badge = element_ref();
    view()
        .flex_1()
        .p_5()
        .gap_4()
        .child(
            native("embed.badge")
                .prop("text", json!("Tap the native badge"))
                .prop("color", json!("#8250df"))
                .element_ref(&badge)
                .on_native_event(move |e: &NativeEvent| {
                    if &*e.name == "tap" {
                        taps.set(e.data["count"].as_u64().unwrap_or(0));
                        badge.command("pulse", json!(null));
                    }
                })
                .self_start()
                .rounded(px(8.0))
                .overflow_hidden(),
        )
        .child(text(move || format!("Tapped {}×", taps.get())))
}
```

```tsx tabs
import { mount, signal, type YNode } from "nsh";
import { nativeComponent } from "nsh";
import { View } from "nsh";

const Badge = nativeComponent<{ text: string; color?: string }, { tap: { count: number } }>("embed.badge", {
  props: ["text", "color"],
  events: ["tap"],
});

function App() {
  const taps = signal(0);
  let badge: YNode | undefined;
  return (
    <View style={{
      flex: 1,
      gap: 16,
      paddingTop: "calc(env(safe-area-inset-top) + 20px)",
      paddingRight: "calc(env(safe-area-inset-right) + 20px)",
      paddingBottom: "calc(env(safe-area-inset-bottom) + 20px)",
      paddingLeft: "calc(env(safe-area-inset-left) + 20px)",
    }}>
      <Badge
        ref={(node) => (badge = node)}
        text={taps() === 0 ? "Tap the native badge" : `Tapped ${taps()}×`}
        color="#8250df"
        onTap={(e) => {
          taps.set(e.count);
          badge?.command("pulse");
        }}
        style={{ alignSelf: "flex-start", borderRadius: 8, overflow: "hidden" }}
      />
    </View>
  );
}

mount(App);
```

### nativeModule

```ts
function nativeModule<T extends object>(specifier: string): T;
```

Returns the exports of the set the embedding app registered as `specifier`: its modules, classes, functions and Rust components, as one object. The app writes the type `T` itself, so nothing about the host is needed when it is built. Rust code built together with the host's crate calls those functions as Rust; `nativeModule` is how TSX reaches them.

```ts
import { nativeModule } from "nsh";

interface TradingApi {
  quote(symbol: string): number;
  placeOrder(symbol: string, quantity: number, side: "Buy" | "Sell"): Promise<Order>;
  subscribe(onChange: (state: Desk) => void): Promise<void>;
}

const { Trading } = nativeModule<{ Trading: TradingApi }>("host/trading");

const price = Trading.quote("AAPL");
```

- Calls work as they do through an import of a set: a plain Rust function returns its value at once, an `async` one returns a promise, and a function you pass is a callback Rust can call later. Rust checks every argument and throws a `TypeError` for a wrong one.
- Each call with the same `specifier` returns the same object in that VM. Its exports are the same values an
  import of the set receives. Host-owned value factories run on the first access through either path; both paths
  share each native instance, and a reload creates new ones.
- Where nothing is registered under `specifier`, `nativeModule` throws a `ReferenceError` naming it. Call it where the app can handle that, or only in the host it is made for.

The host registers the set from Rust, with the platform crate's `set_ui_sets` (next to NSH's own sets) before it starts its views, or `EngineConfig::ui_sets`:

```rust
use nsh_core::prelude::*;

pub struct Trading;

#[module]
impl Trading {
    /// A sample price.
    pub fn quote(symbol: String) -> Result<f64, String> { /* ... */ }

    /// Calls `on_change` with the desk now and on every change.
    pub async fn subscribe(on_change: Callback<Desk>) {
        let mut desk = DESK.subscribe(); // a tokio watch channel the host keeps
        loop {
            on_change.post(desk.borrow_and_update().clone());
            if desk.changed().await.is_err() {
                return;
            }
        }
    }
}

let mut trading = Registry::ui_set("host/trading");
trading.module::<Trading>();
nsh_platform_gpui::set_ui_sets(vec![nsh_base::registry(), trading]);
```

`subscribe` is how the host keeps every app in step with its own data: its task waits for the host's changes and posts each one to the app, so a change made by the host, or by any app through another function, reaches every app that subscribed.

An embedding host can also register an existing client through `Registry::value(name, factory)`. The factory
captures the client the host grants to that view and returns a typed value such as `Instance::new(service)`;
its Rust class methods form the API available to the app. The host manages cancellation and external resources.
See [Host-owned services](../docs/tui.md#host-owned-services) for per-view registration.

> [!NOTE]
> Props, events and command arguments cross to the native side as JSON. Registered components and functions are the host app's own code: NSH's [sandbox limits and capabilities](../docs/sandbox-and-capabilities.md) do not apply to what they do.

## Accessibility

The accessibility API reads the user's accessibility settings (is a screen reader running, did they ask for less motion) and talks to the screen reader. Rust code calls `screen_reader()`, `reduce_motion()` and `announce_for_accessibility()` from `nsh_core::prelude` and moves the focus with an `ElementRef`; TSX imports `screenReaderEnabled()`, `reduceMotion()`, `announce()` and `setAccessibilityFocus()` from `nsh`. The settings are reactive: read them in a binding, `computed` or `effect`, and what reads them updates when the user changes them. The accessibility props of elements (`accessibilityLabel`, `role`, ...) are documented under [Elements](../elements/index.md); the guide is [Accessibility](../docs/accessibility.md).

```rust tabs
use nsh_core::prelude::*; // screen_reader, reduce_motion, announce_for_accessibility, element_ref
```

```tsx tabs
import { announce, reduceMotion, screenReaderEnabled, setAccessibilityFocus } from "nsh";
```

### screenReaderEnabled

```ts
const screenReaderEnabled: Accessor<boolean>;
```

Whether a screen reader (VoiceOver, TalkBack) is running. Reactive: what reads it updates when the user turns the screen reader on or off. Rust: `screen_reader() -> bool`, reactive in the same way.

```rust tabs
when(move || !screen_reader(), || text("Swipe for the next photo"))
    .otherwise(move || text("Next photo").on_press(next))
```

```tsx tabs
<If when={!screenReaderEnabled()} else={<Text onPress={next}>Next photo</Text>}>
  <Text>Swipe for the next photo</Text>
</If>
```

### reduceMotion

```ts
const reduceMotion: Accessor<boolean>;
```

Whether the user asked for less motion (Reduce Motion on iOS, Remove animations on Android). Reactive. Rust: `reduce_motion() -> bool`. Tailwind classes follow it too with the `motion-reduce:` variant.

```rust tabs
let open = move || {
    if reduce_motion() {
        panel.set(0.0);
    } else {
        let _ = panel.spring(0.0, Spring::default());
    }
};
```

```tsx tabs
const open = () => {
  if (reduceMotion()) panel.set(0);
  else panel.spring(0);
};
```

### announce

```ts
function announce(message: string): void;
```

The screen reader reads `message` (a VoiceOver announcement, TalkBack). Use it for results that appear without focus moving, such as "Saved". Rust: `announce_for_accessibility(message)`.

### setAccessibilityFocus

```ts
function setAccessibilityFocus(node: YNode): void;
```

Moves the screen reader's focus to `node` (an element's `ref`). Rust: `ElementRef::set_accessibility_focus()`.

```rust tabs
use nsh_core::prelude::*;

#[component]
fn Saved() -> impl IntoElement {
    let note = element_ref();
    let save = move || {
        announce_for_accessibility("Saved");
        note.set_accessibility_focus();
    };
    // Runs again when the setting changes, until the component goes.
    effect(|| log::info!("screen reader {}", screen_reader()));
    view()
        .gap_2()
        .child(text("Save").role(AccessibilityRole::Button).on_press(save))
        .child(text("Your changes are kept on this device.").element_ref(&note))
}
```

```tsx tabs
import { effect, Text, View, type YNode } from "nsh";
import { announce, screenReaderEnabled, setAccessibilityFocus } from "nsh";

function Saved() {
  let note!: YNode;
  const save = () => {
    announce("Saved");
    setAccessibilityFocus(note);
  };
  // Runs again when the setting changes, until the component goes.
  effect(() => console.log("screen reader", screenReaderEnabled()));
  return (
    <View style={{ gap: 8 }}>
      <Text onPress={save} role="button">Save</Text>
      <Text ref={note}>Your changes are kept on this device.</Text>
    </View>
  );
}
```

## Types

`nsh` also exports the types of the reactive API and of the host elements. The most used ones:

| Type | What it is |
|---|---|
| `Accessor<T>` | A readable value: `() => T` |
| `Signal<T>` | An `Accessor<T>` with `set` and `update` |
| `SignalOptions<T>` | Options of `signal` and `computed` (`equals`) |
| `Context<T>` | What `context` returns |
| `Component<P>` | `(props: P) => JSX.Element` |
| `JSX` | The JSX namespace (`JSX.Element`) |
| `YNode` | What a `ref` receives: focus, scroll and other commands. See [Elements](../elements/index.md) |
| `ViewProps`, `TextProps`, `ImageProps`, `ScrollProps`, `CommonProps`, `TouchProps` | Props of host elements |
| `ViewStyle`, `TextStyle`, `InputStyle`, `ImageStyle`, `LayoutStyle`, `StyleProp<T>` | Style objects; see the [style reference](./style-reference.md) |
| `ColorValue`, `DimensionValue`, `LengthValue`, `TransformStep` | Values inside styles |
| `GestureResponderEvent`, `HoverEvent`, `ContextMenuEvent`, `ScrollEvent`, `PanEvent`, `TouchPoint` | Event payloads |
| `Point`, `Size`, `Bounds`, `Edges`, `Modifiers` | The shapes payloads and props are made of, with GPUI's fields (`nsh_core::geometry`) |
| `PixelSize` | An image's or a video's own size in pixels (`onLoad`, `Image.getSize`, the clipboard's and the picker's images), where `Size` is points |
| `ImageAsset` | What importing an image file gives (`{ url, size: Size, scales? }`; `scales` lists its [pixel-density variants](../docs/images-and-assets.md#pixel-densities)) |
| `OS` | `"ios" \| "android" \| "macos" \| "windows" \| "linux" \| "web"` |
| `AccessibilityRole`, `AccessibilityState` | Accessibility props |

```tsx
import { type GestureResponderEvent, type YNode, signal } from "nsh";

let field: YNode | undefined;
const onPress = (e: GestureResponderEvent) => field?.focus();
```

`StyleProp<T>` accepts one style or a list merged left to right, skipping falsy entries:

```tsx
<View style={[styles.card, selected() && styles.selected]} />
```

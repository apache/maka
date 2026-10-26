---
title: Performance
description: How NSH keeps apps fast (Rust apps, a native runtime, batched crossings, native animations, virtualized lists), what that means for your code, and how to measure headless and on screen.
order: 62
group: tools
---

# Performance

Performance is NSH's first priority, and most of it is decided by the framework rather than by your app: the runtime
is native, each update crosses threads once, animations and list virtualization run without JS, and an app written in
Rust runs no JS at all. This page explains the rules NSH follows, what they mean for the code you write, in Rust and in
TSX, and how to measure.

## The rules

### 1. JS does as little as possible

**An app written in Rust is native code from start to end**: its components, state and handlers are compiled with
NSH's engine, and no interpreter runs ([Building with Rust](./rust.md)). That is the fastest way to write an app, and
the one to choose for demanding business logic.

In a TSX app, QuickJS is an interpreter: small, quick to start, and much slower than native code for heavy work. So in
NSH, **only your app's code is JS**. The reactive graph (signals, computed values, effects), the renderer your compiled JSX calls,
the layout engine, list virtualization, animation and every module you import are
Rust. Parsing, diffing, layout and string processing happen natively.

The effect is measurable. The same counter app on NSH's earlier JS runtime and on the native runtime (release builds):

| | Former JS runtime | Native runtime |
|---|---|---|
| Bundle size | 14 KB JS / 19.6 KB bytecode | 886 B JS / 1.7 KB bytecode |
| Evaluating the bundle | ~390 µs | ~95 µs |
| JS time of one tap (median) | ~14 µs | ~5 µs |
| Commit of one tap | ~22 µs | ~15 µs |
| Scrolling a 1000-row list, JS per rebinding frame | ~150 µs | ~77 µs |

The same holds for components: a button written as a Rust component against an equivalent TSX button, 200 of them:

| | Rust button: JS / core | TSX button: JS / core |
|---|---|---|
| First frame (ops) | 1.32 ms / 0.77 ms (1015) | 2.32 ms / 0.70 ms (2415) |
| Updating all 200 titles (ops) | 0.42 ms / 0.42 ms (200) | 0.77 ms / 0.36 ms (600) |

(Measured on Apple silicon; the second table on the former runtime. Both from NSH's performance baselines.)

**For your code:** keep event handlers and computed values light. Heavy computation (parsing large payloads, sorting
thousands of items on every keystroke) costs more in QuickJS than you may be used to in V8 or JavaScriptCore with a JIT.
Do it once, cache it in a `computed`, or move it off the interaction path.

### 2. Cross threads in batches

Your app's code, Rust or JS, runs on an engine thread, never on the main thread. One turn, for example one event
handler with everything it changes, becomes **one commit**: the runtime renders components, lays out, diffs and produces one batch
of native view operations, which reaches the main thread in **one hop**. There is no bridge message per view and no
serialization per prop.

**For your code:** you do not need to coalesce writes for performance; ten `set` calls in one handler still produce one
commit, in Rust and in TSX. Use `batch` when you want effects and computed values to see all the writes at once instead of running after
each one.

### 3. Fine-grained updates

Components run **once**, in Rust and in TSX alike. Afterwards, only the bindings that read a signal run again when it
changes: a text, a style property, a branch of `when` (`<If>`), the rows of `each` (`<Each>`). Nothing re-renders a whole
subtree to find out what changed.

```rust tabs
use nsh_core::ui::prelude::*;

#[derive(Clone, PartialEq)]
struct Quote {
    price: f64,
    change: f64,
}

fn price(quote: Signal<Quote>) -> impl IntoElement {
    // Runs once. When the quote changes, only the text and the color update.
    text(move || format!("{:.2}", quote.with(|q| q.price))).text_color(move || {
        if quote.with(|q| q.change < 0.0) { rgb(0xcf222e) } else { rgb(0x1a7f37) }
    })
}
```

```tsx tabs
import type { Accessor } from "nsh";
import { Text } from "nsh";

type Quote = { price: number; change: number };

function Price(props: { quote: Accessor<Quote> }) {
  // Runs once. When quote() changes, only the text and the color update.
  return (
    <Text style={{ color: props.quote().change < 0 ? "#cf222e" : "#1a7f37" }}>
      {props.quote().price.toFixed(2)}
    </Text>
  );
}
```

**For your code:**

- Read signals where they are used (inside bindings, `move ||` closures in Rust and JSX expressions in TSX, and in
  `computed` and `effect`), not at the top of a component, so the narrowest binding updates.
- Use `each` / `<Each>` (rows kept by key) or a [virtual list](./lists.md) for collections; rows made again from the whole
  collection (`dynamic` in Rust, a plain `.map()` in JSX) are all created again on each change.
- Derive values with `computed` when several bindings use them, so they are computed once per change.

Appending a fourth item to a three-item list, as `nsh test --trace` shows it:

```rust tabs
// 22 mount items: 3 views removed, 4 created
dynamic(move || items.get().into_iter().map(|n| text(format!("row {n}"))).collect::<Vec<_>>())
// 4 mount items: 1 view created
each(move || items.get(), |n: &u32| *n, |n, _| text(move || format!("row {}", n.get())))
```

```tsx tabs
{items().map((n) => <Text>{`row ${n}`}</Text>)}                   // 22 mount items: 3 views removed, 4 created
<Each of={items()}>{(n) => <Text>{`row ${n()}`}</Text>}</Each>      // 4 mount items: 1 view created
```

See [Reactivity](./reactivity.md).

### 4. Do not send what is not needed

The core sends only what changed: new views get no default style and no empty event mask, unchanged styles and frames
are not sent, a change of text color does not lay the text out again. A tap that changes one number sends one text
item. You can see this in `nsh test --trace` output (below).

### 5. Animate natively

An animation driven from the engine thread (a signal written on every frame) costs a commit per frame, and a JS call
in TSX, and stutters when the engine thread is busy. Animated values ([Animation](./animation.md): `animated_value` in
Rust, [`nsh/animated`](../modules/nsh-animated.md) in TSX) run animations natively instead:

```rust tabs
use nsh_core::ui::prelude::*;

let scroll_y = animated_value(0.0);

view()
    .bind_opacity(&scroll_y.interpolate(&[0.0, 120.0], &[1.0, 0.35]))
    .bind_translate_y(&scroll_y.interpolate(&[0.0, 120.0], &[0.0, -6.0]));
virtual_list(move || photos.with(Vec::len), move |at| photo_row(photos, at))
    .scroll_value(&scroll_y)
    .estimated_item_size(px(64.0))
    .flex_1();
```

```tsx tabs
import { List, View } from "nsh";
import { createAnimatedValue } from "nsh/animated";

const scrollY = createAnimatedValue(0);

<View
  style={{
    opacity: scrollY.interpolate({ inputRange: [0, 120], outputRange: [1, 0.35] }),
    transform: [{ translateY: scrollY.interpolate({ inputRange: [0, 120], outputRange: [0, -6] }) }],
  }}
/>;
<List each={photos()} scrollValue={scrollY} estimatedItemSize={64} style={{ flex: 1 }}>
  {(photo) => <Row photo={photo()} />}
</List>;
```

- `timing`, `spring` and `decay` run on the platform's UI thread, frame by frame, with no work on the engine thread
  per frame.
- `scroll_value` (`scrollValue`) writes a scroll offset into an animated value in the same frame; a pan
  (`pan={{ x, y }}`) lets drags move a view directly. Your code hears about the end (the animation completes, the pan's
  end gets the velocity).
- `Animated.sequence` / `parallel` / `stagger` / `loop` run as one native tree: each step starts the moment the
  previous one ends, with no gap waiting for JS.
- `LayoutAnimation.configureNext` animates the next commit's frames, insertions and removals natively.

### 6. Virtualize long lists

[`List`](./lists.md) keeps only the rows near the viewport, recycles their cells, and computes positions, columns,
sticky headers and viewability natively. Scrolling frames that reveal no new row run none of your code and produce no batch; a
frame that binds one new row of the gallery's photo list is 4 operations and 4 mount items.

**For your code:**

- Give `estimated_item_size` (`estimatedItemSize`) close to the real row height.
- Keep per-item state in your data (keyed by id), not in signals created inside the row: cells are reused for other
  items, and the row's position (`at.index()`; `item()` / `index()` in TSX) changes when they are.
- Keep rows cheap: a row binds once per recycle, so its code runs while the user scrolls.
- Use `scroll_value` (`scrollValue`) instead of `on_scroll` (`onScroll`) for effects that follow the scroll position.
  A scroll listener gets at most one event per engine turn, but each is still a call into your code (into JS, in TSX).

## Measuring

### Headless: `--trace`

In a Rust test, `EngineConfig::trace` logs the same `perf` lines and `Headless::observe` sees every batch
([Testing](./testing-and-trace.md#tracing-with-trace)). `nsh test --trace` prints them for TSX:

```sh
echo 'await app.press("Add")' | nsh test App.tsx --trace                 # first frame + a press
echo 'await app.scroll("id:feed", 3000)' | nsh test App.tsx --trace       # scrolling, 10 pt per frame
```

```text
perf commit: 56 ops, 395µs (list js 6µs), 49 mount items, 21 nodes
perf first frame: eval 271µs, total 1235µs
perf event js: 88µs
perf commit: 10 ops, 151µs (list js 2µs), 8 mount items, 27 nodes
```

What to look at:

- **ops** (operations your JS queued) and **mount items** (native view operations): these are deterministic. If a tap
  that should change one label produces 40 items, something re-creates views it should update.
- **event js**: the JS cost of a handler and what it triggered.
- **commit**: the core's cost of rendering components, layout and diffing.
- **list js**: JS spent binding list rows during that commit.

Full guide: [Testing](./testing-and-trace.md).

### On a device: `--trace`

```sh
nsh run App.tsx --trace
nsh run App.tsx --target android --trace --release
```

logs the same commit lines from a TSX app's real host, with the platform's own text engine. `NshAppView(trace: true)` and
`new NshView(context, true)` do the same in an embedding app.

### On screen: `--fps`

```sh
nsh run App.tsx --target macos --fps --release
```

(`AppOptions { fps: true, .. }` in a Rust app's `run_app`) shows the frame rate and what frames and commits cost over the running app, with CPU, GPU and memory
([macOS: performance monitor](./macos.md#performance-monitor)). On Linux and Windows, `--target linux --fps` and
`--target windows --fps` log the same readings once a second, with the time of each phase of a frame;
`nsh test --target linux --fps -v` (or `windows`) takes them while a test drives the app.

> [!TIP]
> Single measurements are dominated by the CPU's clock state: a thread that just slept runs slower for a while.
> Compare the minimum of several runs, on the same machine, and prefer release builds for timing.

## Reference numbers

Measured numbers, NSH's baselines and the gallery page by page on Linux, are in the [performance report](./performance-report.md).

## Checklist

- Language: write the app, or the parts it uses most, in Rust ([Building with Rust](./rust.md)); keep TSX for what
  changes often or is delivered at run time.
- Interactions: a tap changes a handful of mount items, not dozens.
- Lists: a virtual list (`virtual_list`, `List`) for anything long, with an estimated item size; per-item state in data.
- Animations: animated values, not signals written every frame.
- Scroll effects: `scroll_value` (`scrollValue`), not a scroll listener.
- Handlers: no heavy work per keystroke or per scroll event; cache in `computed`.

## See also

- [Performance report](./performance-report.md)
- [Architecture](./architecture.md)
- [Testing](./testing-and-trace.md)
- [Lists](./lists.md), [Animation](./animation.md), [Reactivity](./reactivity.md)

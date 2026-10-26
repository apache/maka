# Animation

- **Animation**: `createAnimatedValue()` → `timing` / `spring` / `decay` (return a Promise), `interpolate` (numbers, colors or
  `"deg"` / `"rad"` angles; `extrapolate` / `extrapolateLeft` / `extrapolateRight`: `clamp` (default) / `extend` / `identity`;
  `easing`), `add/sub/mul/div/mod`, `diffClamp(min, max, { snap })`. A snapping `diffClamp` settles at its nearer bound
  in 200 ms, easing out, when the scroll view whose scroll value it follows (through any nodes) comes to rest
  (`Graph::settle`), at `max` only once its input reached `max`; scrolling that view again ends the settling where it
  is, and a snapping `diffClamp` it reads, settling too, moves its input without ending it. A snapping dependent
  already at a bound holds there while its upstream nodes settle, then follows new scrolling from that baseline.
  Every platform calls it
  where it sends `onScrollEnd`, listened to or not: the desktops through `ScrollHost::settled`
  (`nsh-core`'s `scroll.rs`; macOS from its own `emit`), iOS in `scroll_event`, Android through `Native.scrollEnded`
  (`ScrollBox.settled`), the web through `nsh_scroll_ended` (`nsh.js` `scrollEvent`), the headless driver at its
  scroll steps' and drags' ends. `Easing` (React Native's: `linear`, `ease`, `quad`, `cubic`, `poly`,
  `sin`, `circle`, `exp`, `elastic`, `back`, `bounce`, `bezier`, `in` / `out` / `inOut`) is data decoded in Rust
  (`nsh_core::animation::Easing::Curve`), never a JS function: the curves, their parameters and defaults are one table
  (`nsh_core::js::animation`), which decodes them, declares their types (`animation::declarations`) and gives `nsh/animated` its curves (`animation::tables`). `Animated.timing` / `spring` / `decay` / `sequence` / `parallel` / `stagger` /
  `delay` / `loop` build a `Composite` tree that runs entirely natively (`AnimationOp::StartComposite`): each step starts at the exact end
  time of the previous one (no frame gaps), `stop()` / `reset()` (back to the values at start) / `start(cb)` report `finished` once
  for the whole tree; leaf animations get internal ids (`LEAF_IDS`) that never reach JS. Composites are released when JS
  lets go of them (their finalizers queue `ReleaseComposite`); a run goes on after that. A run does not keep its
  composite (or the values it animates) alive: `nsh-js` remembers live composites by key (`Animations::composites`),
  not in the run's promise, so an endless `Animated.loop` whose values its component released stops with them (a step on
  a released value ends the run unfinished, rather than counting as done, which made loops spin). Rust components build
  the same trees with `nsh_core::ui::Animation` (composite keys odd, JS's even).
  `decay` takes `clamp: [min, max]` and `bounce`: at a bound it stops, or a new segment of the closed form starts from the
  bound at the exact time it got there with `-bounce` of its speed (frame-rate independent, several per frame if need be).
  Values have an offset (`setOffset` / `flattenOffset` / `extractOffset`, React Native's): they evaluate to value +
  offset; drivers, `set` and gestures move the value. JS reads a node back with `getValue()` (and `stop()`'s promise):
  `AnimationOp::Read` answers with a `Finished` carrying `value`, through the same path as animation ends (Rust
  components: `AnimatedValue::value()`, its request id odd, answered in `Core::animations_finished`).
  `Easing.sample`, `Animated.sampleSpring` / `sampleDecay` return the curves from `nsh_core::animation::sample_easing` /
  `sample_driver` (the drivers' own code, stepped like frames, at most `MAX_SAMPLES`), so drawn curves are what runs;
  Rust components call `ui::sample_easing` / `sample_spring` / `sample_decay` / `sample_decay_within`.
  Bindable: `opacity`, `backgroundColor`, `borderColor` (all sides), a text's `color` (the whole text: iOS and Android draw
  it into a layer and paint over it in the color, `SourceIn` / `SRC_IN`), `shadowColor` / `shadowOpacity` /
  `shadowRadius`, the translate / scale / rotate parts of `transform`, and where views stick: a sticky view's `top` /
  `left` and a list's `stickyHeaderOffset` (`StickyCell::offset`, `docs/dev/scrolling-and-lists.md`). iOS shapes the decoration with the bound
  values (and the layers for them even while they are transparent: `bound_style`), then sets the colors and shadow
  on those layers each frame; Android and web get them as properties (`Mounter.java` codes 11–14; the web composes
  `box-shadow`, dropping layered `boxShadow`s while bound). Driven on the main thread by `CADisplayLink`,
  paused while nothing animates. `scrollValue` writes the scroll offset into an animated value in the same frame; `pan` lets drags drive animated values
  directly, and JS receives the velocity when the drag ends. Animated values referenced by a view's style (or `pan`, `scrollValue`, ...) are kept by its node
  (`nsh-js` `dom.rs`) and derived nodes hold their inputs, so bindings do not break when JS objects are collected. In
  Rust components `AnimatedValue` / `AnimatedNode` are `Copy` handles their owner keeps; the element's bindings, a
  drawing or a composite hold the node while bound (`docs/dev/components.md`, "Animated values").
- **Keyframes and motions** (`nsh_core::animation::motion`): data turned into `Composite` trees, so the graph runs
  them like any composite and no platform has code of its own for them. `keyframes(node, frames, KeyframeTiming)`
  resolves offsets as the Web Animations API does (first 0, last 1, the ones between spread evenly, out-of-order ones
  held), then makes one iteration a `Sequence` of `Timing` runs: a zero-duration jump to the first keyframe (from where
  the value is when there is no keyframe at 0), one run per segment with the easing of the keyframe it starts at (else
  the timing's, CSS `ease` by default: `Easing::EASE`), a `Delay` for a last offset below 1. A delay is a leading
  zero-duration jump to the first keyframe (when it sits at offset 0) and a `Delay`: CSS `animation-fill-mode:
  backwards`, so a delayed entrance (a staggered row) shows its first frame, not the view at rest. Backward iterations mirror
  the offsets and play each curve `Easing::reversed()`; iterations and `alternate` are `Loop`s of one or two passes. A zero-duration `Timing` ends on the frame it starts (`driver.rs`: only a positive
  duration waits for its first tick), so a keyframe's jump and the next segment start together. `Easing::Steps(count,
  StepPosition)` is CSS `steps()` (Easing Functions Level 2, without the before flag). `stagger_delay(index, count,
  StaggerFrom)` counts each item's intervals from the first, the last, the center (both middles of an even count at
  once) or an index; `Animated.stagger`'s `{ from }` and `Animation::stagger_from` use it. A `MotionSpec` is several
  `MotionChannel`s (opacity, then translations, rotations and scales, the order they bind in) through keyframes with
  one timing, its `composite` a `Parallel` (stop together) over the channels' nodes; `start_values` is where an
  entrance sets the values before its first frame (`createMotion`'s `initial` sets the others; `enter` wins on the
  channels it moves). `Motion::animation` / `motion.animation(..)` return the same tree as a composite, not started,
  so motions compose (`Animated.stagger(.., cards.map((m) => m.animation(..)))`); reduced motion is decided when it
  is made. `PRESETS` (the `presets!` table: name, `MotionKind`, one-line doc,
  timing, tracks) is `MotionPreset`, `motions` in JS (`js::animation::tables`), the `MotionName` declarations, and the
  docs' list; `presets_are_well_formed` checks each kind (enter ends at rest, exit starts at rest, attention does both,
  loops are endless) and the offsets. JS sends `{ type: "keyframes", node, ... }` and `{ type: "motion", nodes,
  motion, reduced }` composite specs that `nsh-js` `protocol.rs` decodes through `js::animation`
  (`keyframes_composite`, `motion_spec`: a preset's name, channels' keyframes, or WAAPI-style frames placed by index).
  Reduced motion is decided in the faces (`createMotion`'s `play` reads the environment, Rust's `Motion::play` reads
  `reduce_motion()`; `ignoreReduceMotion` / `play_ignoring_reduce_motion` opt out): a reduced motion is a zero-duration
  `Timing` per channel to where it ends (`keyframe_ends`). `Animated`, `timing` and `keyframes` play as written.
- **Layout animation**: `LayoutAnimation.configureNext(config)` (or the `easeInEaseOut` / `linear` / `spring` presets) animates
  the next commit's frames, insertions and removals natively. The presets are `LayoutAnimation::EASE_IN_EASE_OUT` /
  `LINEAR` / `SPRING` in Rust (what Rust components pass to `animate_layout`), handed to `nsh/animated` as data; the config's
  decoding and types come from the same module.
- **Desktop backends** (Windows, GPUI, Linux, macOS): one platform-free copy of what they animate. `nsh_core::transition`
  holds a view's layout animation, style transition and keyframes (`Live`: curves, springs, interpolation of frames,
  colors, transforms, shadows and corner radii, timing), which each backend steps on its frame clock and applies to its
  own views; `nsh_core::animation::Animator` holds the graph with its bindings to views, gestures and scroll views
  and hands each bound view its `AnimValues`.
- **Web**: animated values run in Rust as elsewhere; layout animations, transitions, keyframes and screen transitions
  are Web Animations and CSS made to match the Linux backend (`web.md` "Animation").

## Compared with gpui-base's motion

gpui-base (`gpui-kit/crates/base/src/motion.rs`, `motion/*.rs`, `docs/STYLING-AND-MOTION.md`) samples motion on the
frame in Rust for one retained element; NSH describes it once and the native graph plays it on the UI thread. What
maps to what:

| gpui-base | NSH |
|---|---|
| `transition()` / `Transition` (keyed target value, duration, delay, easing, reversal from the sampled value) | Style transitions (`transition*`, Tailwind `transition-*`), which start from what is on screen; `AnimatedValue::timing` for values |
| `spring()` / `Spring` (velocity kept across a target change) | `spring` (a new spring or decay without a velocity continues with the value's current velocity) |
| `Keyframes<T>` / `Keyframe` / `animate_keyframes` | `keyframes` (`AnimatedValue::keyframes`, `Animation::keyframes`, `Animated.keyframes`, motions' tracks) |
| `Discrete<T>` | A keyframe segment with `Easing::Steps(1, …)` (`JumpEnd` switches at the end of the segment, `JumpStart` at its start) |
| `Timing` (iterations, `PlaybackDirection`, `SignedDuration` delay) | `KeyframeTiming` (iterations or endless, the four directions, a delay). Negative delays (starting part-way) are not supported |
| `Easing`: CSS keywords, `cubic_bezier`, `steps` with every `StepPosition` | `Easing`: `Linear`, `EASE`, `EaseIn` / `EaseOut` / `EaseInOut`, `Bezier`, `Steps(count, StepPosition)`, plus React Native's curves |
| `Easing::linear_stops` (CSS `linear()` stops), `Easing::Custom` | Gap: no `linear()` stops yet. App functions as curves are out by design (easings are data evaluated natively) |
| `Sequence` | `Animated.sequence` / `Animation::sequence` (each step starts at the exact end of the one before) |
| `Stagger` / `StaggerOrigin` (first, last, center, index) | `Animated.stagger(ms, list, { from })` / `Animation::stagger_from`, `StaggerFrom` |
| `Presence` / `PresencePhase` (keeps content mounted while it exits) | `createMotion({ enter })` / `motion().entering(..)` for entrances, `await play(exit)` then removing the view for exits. Gap: no presence component that keeps a removed view mounted through its exit |
| `MotionReveal` (measured vertical reveal, clipped) | Gap: not provided; buildable with an animated `maskImage`-style fade or `scaleY` on a clipped view, or a layout animation of the height (heights are not bindable to animated values) |
| Reduced motion (transitions and springs snap) | Motions land at their end; the low-level `Animated` / `timing` / `keyframes` play as written and apps choose with `reduce_motion()` |
| `MotionTransform` (translation, scale, rotation, opacity bundle) | A `Motion`'s channels (opacity, translate X / Y, rotate, rotate X / Y, scale, scale X / Y), bound with `style={m.style}` / `bind_motion` |

Beyond gpui-base's: the graph runs on the UI thread with no app code per frame (a busy engine never drops a frame);
interpolation to numbers, colors and angles, arithmetic and `diffClamp`; `decay` with clamps and bounce; gestures
(`pan`, `pinch`, `rotation`) and scroll offsets (`scrollValue`) writing values directly; layout animations of a
commit's frames, insertions and removals; and a library of ready-made motions as data.

## Shaders and generative fills (decision)

NSH does not take app-written shaders. There is no shading language common to its backends: Metal on iOS and macOS,
AGSL `RuntimeShader` only on Android 13 and later, HLSL Direct2D effects on Windows, GTK 4's `GskGLShader` deprecated
since 4.16, no user shaders in GPUI, WebGL / WebGPU on the web. Apps are sandboxed plugins whose limits are enforced
natively, and an arbitrary GPU program escapes those limits (its cost, hangs of the GPU). And a shader is a look,
which NSH leaves to apps.

What apps use today for gradient-art surfaces (getgradients.com's style): layered `linear-gradient` /
`radial-gradient` / `conic-gradient` backgrounds, `filter: blur()`, `maskImage`, `mixBlendMode`, moved by motions and
animated values (the gallery's animated aurora background is built that way), and Canvas drawings bound to animated
values.

A possible direction (a design decision to take, not planned work): parameterized generative fills in the core
(mesh gradients, noise / grain) that each backend draws, or a constrained shader subset compiled per platform (for
example WGSL through naga to MSL, HLSL, GLSL and SPIR-V) with a fallback fill where a platform cannot run it.

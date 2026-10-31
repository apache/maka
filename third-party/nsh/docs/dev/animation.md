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
  (`nsh_core::js::animation`), which decodes them, declares their types (`animation::declarations`) and gives `nsh`'s `Easing` its curves (`animation::tables`). `Animated.timing` / `spring` / `decay` / `sequence` / `parallel` / `stagger` /
  `delay` / `loop` build a `Composite` tree that runs entirely natively (`AnimationOp::StartComposite`): each step starts at the exact end
  time of the previous one (no frame gaps), `stop()` / `reset()` (back to the values at start) / `start(cb)` report `{ finished }` once
  for the whole tree; leaf animations get internal ids (`LEAF_IDS`) that never reach JS. Composites are released when JS
  lets go of them (their finalizers queue `ReleaseComposite`); a run goes on after that. A run does not keep its
  composite (or the values it animates) alive: `nsh-js` remembers live composites by key (`Animations::composites`),
  not in the run's promise, so an endless `Animated.loop` whose values its component released stops with them (a step on
  a released value ends the run unfinished, rather than counting as done, which made loops spin). Rust components build
  the same trees with `nsh_core::element::Animation` (composite keys odd, JS's even).
  `decay` takes `clamp: [min, max]` and `bounce`: at a bound it stops, or a new segment of the closed form starts from the
  bound at the exact time it got there with `-bounce` of its speed (frame-rate independent, several per frame if need be).
  Values have an offset (`setOffset` / `flattenOffset` / `extractOffset`, React Native's): they evaluate to value +
  offset; drivers, `set` and gestures move the value. A node is evaluated once for each state of the graph
  (`Graph::eval` keeps its value until an op, a `set`, a settling or a frame changes the graph), so a node many read
  (the time, a shared track) costs one evaluation a frame. JS reads a node back with `getValue()` (and `stop()`'s promise):
  `AnimationOp::Read` answers with a `Finished` carrying `value`, through the same path as animation ends (Rust
  components: `AnimatedValue::value()`, its request id odd, answered in `Core::animations_finished`).
  `Easing.sample`, `Animated.sampleSpring` / `sampleDecay` return the curves from `nsh_core::animation::sample_easing` /
  `sample_driver` (the drivers' own code, stepped like frames, at most `MAX_SAMPLES`), so drawn curves are what runs;
  Rust components call `element::sample_easing` / `sample_spring` / `sample_decay` / `sample_decay_within`.
  Bindable: `opacity`, `backgroundColor`, `borderColor` (all sides), a text's `color` (the whole text: iOS and Android draw
  it into a layer and paint over it in the color, `SourceIn` / `SRC_IN`), `translate` / `rotate` / `scale` (`[x, y]` per axis) and the steps of a `transform` list (a motion's,
  `createMotion`: `{ opacity, transform }`), and where views stick: a sticky view's `top` /
  `left` and a list's `stickyHeaderOffset` (`StickyCell::offset`, `docs/dev/scrolling-and-lists.md`), and a registered native
  component's own props (`AnimationProp::ComponentSlot(slot)`, `docs/dev/embedding.md`: the component is handed the value,
  a number or an ARGB color, on the frames it changes). iOS shapes the decoration with a bound
  border color (and the layers for it even while it is transparent: `bound_style`), then sets the colors on those
  layers each frame; Android and web get them as properties (`Mounter.java` codes 11 and 12). Driven on the main thread by `CADisplayLink`,
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
  `LINEAR` / `SPRING` in Rust (what Rust components pass to `animate_layout`), handed to `nsh`'s `LayoutAnimation` as data; the config's
  decoding and types come from the same module. That animates every frame of the commit, app-wide; a component that
  sizes one region (a reveal) scopes it with `ElementRef::animate_layout(transition)`, `Command::LayoutAnimation`
  sent to the region's node: only the frames its change moves animate (its subtree's, its ancestors' children, and
  the content of those that changed size). The platforms know nothing of the scope: before handing out the batch,
  the core leads each run of frames with the layout animation it takes, an empty one for the rest
  (`core/layout_scope.rs`), as the platforms animate a frame with the last `MountItem::LayoutAnimation` before it.
  Insertions and removals are not scoped (their animations are decided per batch on iOS, Android and the web).
- **A view that follows another** (`View::follow(target)`, `core/follow.rs`; `nsh/base`'s `Tabs` indicator): its frame
  along its parent's main axis is the target's, placed by the core after layout, with no layout of its own and no
  JS. Following another element runs its `follow_transition` as a layout animation of its own frame alone (a scope of
  the follower's node in `core/layout_scope.rs`, without its ancestors' children: what changes around it in that
  commit changes at once); the first placement and a layout that moves the target place it at once, in the same
  batch. The component decides the transition, `None` under reduced motion (`Tabs`: `spring_move`'s spring,
  `LayoutCurve::Spring { damping: 0.85 }` over 362 ms). A follower hidden (`display: none`) forgets where it was, so
  shown again it is placed at once. A target that changes size in the commit that makes it the target is followed
  to its new frame, animated once; a resize sends no layout animation item. With no follower the pass returns at
  once and `set_frame` notes nothing (`nothing_follows_while_no_view_follows_an_element`).
- **Desktop backends** (Windows, GPUI, Linux, macOS): one platform-free copy of what they animate. `nsh_core::transition`
  holds a view's layout animation, style transition and keyframes (`Live`: curves, springs, interpolation of frames,
  colors, transforms, shadows and corner radii, timing), which each backend steps on its frame clock and applies to its
  own views; a text's color, which lives in its typeset runs rather than its style, transitions as a color the backend
  draws the whole text in over its runs (`Live::text_color`, `transition::recolor`: when the text is one color before
  and after), the way it draws an animated `color`, so no frame typesets the text again; `nsh_core::animation::Animator` holds the graph with its bindings to views, gestures and scroll views
  and hands each bound view its `AnimValues`.
- **Mobile backends**: style transitions are the platform's (Core Animation on iOS, `ValueAnimator`s in
  `Mounter.java` on Android). A text's color follows the same rules as on the desktops and is drawn the same way,
  over the laid-out lines in an in-between color, as an animated `color` is: iOS steps a `transition::TextColor` per
  text (`transition::recolor` decides) on a display link that runs only while one moves (`interaction.rs`
  `TextColors`); on Android the `TEXT` item carries the text's one color (`uniform_color`) and `TextBox.recolor`
  runs a `ValueAnimator` on the view's transition (reduced motion: animators off, at once).
- **Web**: animated values run in Rust as elsewhere; layout animations, transitions, keyframes and screen transitions
  are Web Animations and CSS made to match the Linux backend (`web.md` "Animation"); a text's color is a CSS
  transition of its element's `color`, which its runs inherit.

## Pointer-driven motion follows the pointer

What the pointer drives follows it in the same frame: a hover's cross line, dots and tooltip, a dragged thumb, a
scroll bar's thumb, a resize handle, a color area's knob, a dragged column, a dock's drag preview, a swiped toast or
sheet. The component sets it (`AnimatedValue::set`, a style, `pan_values`) from the event, never eases or springs it
toward the pointer: a position that trails the hand reads as dropped frames. Transitions and springs are for discrete
changes: a step of the keys (a plot's hover glides to the next row on `motion.pointer`), snapping to a row or a slot
as the pointer enters or leaves it, the app setting a value, a release (a swipe settles or flies off), entering and
exiting (the hover's fade), and data changes. "Follows the hand and still animates" is that split: a plot's cross
line snaps to the row under the pointer at once while its fade in and out animate. The app's transitions on a part
the component moves (`transition-all` on a scroll bar's thumb) must not reach the moving property: the component
moves a wrapper of its own (`scrollbar.rs`'s holder). Tests assert it: a pointer move starts no animation
(`nsh-base/tests/base/plot.rs`).

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
| `MotionReveal` (measured vertical reveal, clipped) | `nsh/base`'s `Collapsible` `reveal`: a clip view between zero and the content's height whose change is a layout animation of the frames it moves (`ElementRef::animate_layout`; a critically damped spring of `spring_control`'s time), the content kept until it has closed (`docs/dev/components.md` "Children, slots and rows"). Heights are not bindable to animated values, so a reveal is a layout animation, not a progress the app drives; no reveal element of its own yet |
| Reduced motion (transitions and springs snap) | Motions land at their end; the low-level `Animated` / `timing` / `keyframes` play as written and apps choose with `reduce_motion()` |
| `MotionTransform` (translation, scale, rotation, opacity bundle) | A `Motion`'s channels (opacity, translate X / Y, rotate, rotate X / Y, scale, scale X / Y), bound with `style={m.style}` / `bind_motion` |

Beyond gpui-base's: the graph runs on the UI thread with no app code per frame (a busy engine never drops a frame);
interpolation to numbers, colors and angles, arithmetic and `diffClamp`; `decay` with clamps and bounce; gestures
(`pan`, `pinch`, `rotation`) and scroll offsets (`scrollValue`) writing values directly; layout animations of a
commit's frames, insertions and removals; and a library of ready-made motions as data.

## Shaders

Apps draw generative fills (mesh gradients, noise, grain, plasma) with shader views: `<Shader source={wgsl}>`, a
WGSL `fn shade(uv: vec2f) -> vec4f` that the core checks with naga and the platforms render on the GPU (wgpu on the
native backends, WebGL 2 on the web) under the view's children. Animated values among its `uniforms` are value slots
bound as `AnimationProp::CanvasArg`, as a canvas drawing's are, so they move it with no JS per frame; a shader reading
`nsh.time` draws every frame while it is in sight. See [shaders.md](shaders.md).

Layered CSS gradients, `filter: blur()`, `maskImage` and `mixBlendMode` moved by motions and animated values, and
Canvas drawings bound to animated values, remain the tools for fills built from shapes.

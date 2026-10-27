---
title: Touch and gestures
description: Presses and press feedback, hit areas, pointer events, raw touches, the responder system, PanResponder, and native pan, pinch and rotation gestures.
order: 38
group: ui
demo: guide-gestures
---

# Touch and gestures

NSH has three levels of touch handling. **Presses** (`.on_press` in Rust, `onPress` in TSX, and their siblings) cover buttons, rows and links, with press feedback drawn natively. **Native gestures** (pan, pinch and rotation) move [animated values](./animation.md#animated-values) on the UI thread, so a dragged card follows the finger even while your code is busy. **Raw touches and the responder system** (`.on_touch` and `.claim_touches` with the `.on_responder_*` handlers in Rust; `onTouchStart`, `onResponderMove` and `PanResponder` in TSX) give your code every finger position for anything the other two cannot express, such as drawing.

Pick the highest level that does the job: the higher the level, the less work crosses from the UI thread to your code.

## Presses

Every element accepts the press handlers; there is no separate "touchable" component. Put `.on_press` / `onPress` on a view, a text, an image or anything else.

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

| Rust | TSX | Default | Description |
|---|---|---|---|
| `.on_press(..)` | `onPress` | | The finger lifted inside the view (after a press, not a long press). |
| `.on_long_press(..)` | `onLongPress` | | The finger stayed down for the long press delay. The press handler does not follow. |
| `.on_press_down(..)` | `onPressDown` | | The press started. |
| `.on_press_up(..)` | `onPressUp` | | The press ended: lifted, slid off, or taken over by a scroll view. |
| `.long_press_delay(ms)` | `delayLongPress` | `500` | Milliseconds before a press becomes a long press. |
| `.disabled(..)` | `disabled` | `false` | Takes no presses and shows no feedback; applies the disabled style; screen readers say it is disabled. |

How presses behave:

- **Only the innermost pressable view responds.** A pressable row containing a pressable button gets no press when the button is pressed.
- **Inside a scroll view, the press waits about 130 ms** before it starts (and shows feedback), so a drag that begins on a button scrolls instead of pressing it.
- **Sliding off cancels.** Moving the finger out of the view ends the press with the press-up handler and no press.
- **Disabling removes the press listeners** from what is mounted, so the view shows no feedback at all, and the disabled style applies (`.disabled_style(..)`, `class="disabled:opacity-40"`).
- **Nested text spans with a press handler are links.** The paragraph is one native view; the press goes to the span under the finger. See [Text](./text.md).

## Press feedback

Press feedback is the app's: styles the view takes while it is pressed, hovered, focused or disabled. They are applied natively the moment the state changes, with no round trip to your code. Each state has a Rust method, a TSX style prop and a [Tailwind variant](./tailwind.md):

| Rust | TSX prop | Class | Description |
|---|---|---|---|
| `.active(\|s\| ..)` | `activeStyle` | `active:` | While pressed. |
| `.hover(\|s\| ..)` | `hoverStyle` | `hover:` | While a pointer is over it (desktops, iPad pointers, browsers). |
| `.focus(\|s\| ..)` | `focusStyle` | `focus:` | While it has focus. |
| `.disabled_style(\|s\| ..)` | `disabledStyle` | `disabled:` | While disabled. |
| `.ripple(Ripple { .. })` | `android={{ ripple }}` | | Android's material ripple (`color`, `borderless`, `radius`, `foreground`), in addition to the styles. |

The state styles go over the view's own styles. Later states win (hover, focus, active), the disabled style wins over all, and the others do not apply while the view is disabled.

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

A borderless ripple spreads outside the view, which suits icon buttons: `Ripple { borderless: true, radius: Some(px(24.0)), .. }`, `android={{ ripple: { borderless: true, radius: 24 } }}`. See [Platform-specific code](./platform-specific.md).

With a transition (`.transition()`, the `transition` class) the change of state animates. `.group()` (the `group` class) makes a view a group, and `.group_active(..)` (`group-active:`) styles its children while it is pressed:

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

## Hit areas: hitSlop

The hit slop (`.hit_slop(..)`, `hitSlop`) extends the area that takes touches beyond the view's bounds, without changing its layout. Use it for small targets such as close buttons and toggles.

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

| Rust | TSX | Description |
|---|---|---|
| `.hit_slop(EdgeInsets)` | `hitSlop: number \| { top?, right?, bottom?, left? }` | Points added around the bounds. `EdgeInsets::all(..)` and a TSX number apply to all four sides. |

Keep the extended area inside the parent's bounds (give the small view some margin or padding around it): hit testing reaches a child through its parent, so a touch outside the parent never gets to the child's slop.

## Children outside their parent

A child placed outside its parent's bounds (absolutely positioned with `overflow` left visible, such as a dropdown under its field) takes touches where it is drawn, like any other view: NSH hit-tests the descendants that reach outside a view natively. A parent that clips its overflow clips them, and then they neither show nor take touches there. The area is computed from the layout, so a child moved out of its parent by a transform only takes touches inside the parent's bounds.

Mind the drawing order: a dropdown is drawn over the siblings of its field only if the field comes after them or has a higher `z-index`, and touches go to what is drawn on top.

## pointerEvents

Pointer events (`.pointer_events(..)`, `pointerEvents`) decide which views of a subtree can be the target of a touch. They are evaluated natively during hit testing, so they cost nothing per touch.

| Rust | TSX | The view | Its children |
|---|---|---|---|
| `PointerEvents::Auto` (default) | `"auto"` | Takes touches | Take touches |
| `PointerEvents::None` | `"none"` | Never the target | Never the target: touches pass through to what is behind |
| `PointerEvents::BoxNone` | `"box-none"` | Never the target | Take touches |
| `PointerEvents::BoxOnly` | `"box-only"` | Takes touches | Never the target |

The typical uses: an overlay that must not block what is under it (none), a full-screen container whose empty space should let touches through to the content behind while its buttons still work (box-none), and a row that should take a press even when the finger lands on a child (box-only).

```rust tabs
view().flex_1().child(map()).child(
    // A floating toolbar: the empty area passes touches to the map.
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
  {/* A floating toolbar: the empty area passes touches to the map. */}
  <View pointerEvents="box-none" style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, justifyContent: "flex-end", padding: 16 }}>
    <View onPress={locate} style={{ alignSelf: "flex-end", padding: 12, borderRadius: 24, backgroundColor: "#ffffff" }}>
      <Text>Locate</Text>
    </View>
  </View>
</View>
```

The Tailwind classes `pointer-events-none` and `pointer-events-auto` set the same thing; an explicit prop wins over the class.

## Native gestures: pan, pinch and rotation

For drags, pinches and rotations that move something on screen, bind [animated values](./animation.md#animated-values) to the gesture. The platform's gesture recognizer writes the values on the UI thread and the views bound to them move in the same frame; your code is told when the gesture starts and ends.

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
                // Spring back, starting at the speed the finger let go with.
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
          // Spring back, starting at the speed the finger let go with.
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

| Rust | TSX | Description |
|---|---|---|
| `.pan_values(Some(&x), Some(&y))` | `pan={{ x?, y? }}` | One-finger drags move these values, in points. |
| `.pinch_value(&scale)` | `pinch={{ scale? }}` | Two-finger pinches drive `scale` (a factor). |
| `.rotation_value(&angle)` | `rotation={{ angle? }}` | Two-finger rotations drive `angle`, in degrees. |
| `.on_pan_start` / `.on_pan_end` | `onPanStart` / `onPanEnd` | The drag started / ended, with a `PanEvent`. |
| `.on_pinch_start` / `.on_pinch_end` | `onPinchStart` / `onPinchEnd` | The pinch started / ended: its scale and velocity (`GestureEvent`). |
| `.on_rotation_start` / `.on_rotation_end` | `onRotationStart` / `onRotationEnd` | The rotation started / ended: its angle (Rust: `GestureEvent<Radians>`) and velocity. |

A pan event has the translation (`translation`; TSX: `translationX` / `translationY`, points since the start), the velocity (`velocity_x` / `velocity_y`; TSX: `velocityX` / `velocityY`, points per **second**) and the bound values at that moment (`value_x` / `value_y`; TSX: `valueX` / `valueY`).

What the native side does for you:

- **A drag continues from where the value is.** At the start the values are read, and the translation is added to them; grabbing a value that is still animating (a spring on its way home) stops the animation where it is.
- **One axis only lets the other scroll.** With only a horizontal value bound the drag begins only when the finger moves more horizontally than vertically, so a horizontal swipe row inside a vertical scroll view still scrolls vertically. This decision is made natively when the system asks whether the gesture may begin.
- **Pan, pinch and rotation run together** on the same view: one card can be dragged, pinched and rotated at once.
- **Release velocity for physics.** The pan end's velocity feeds a spring's or a decay's velocity directly; the values let you pick a snap point.

```rust tabs
// A card that snaps to the left or right edge.
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
// A card that snaps to the left or right edge.
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
> Bind animated values to the gesture rather than following it through the responder whenever the drag only moves things. With bound values, busy app code cannot make the drag stutter; with the responder, every move is an event to your code and an update of what the view shows.

## Raw touches

The touch handlers report every finger as it goes down, moves and lifts. They are useful for logging, custom hit testing and reacting to multi-touch; they do not claim the touch (presses and scroll views keep working).

In Rust, `.on_touch(..)` hears every phase as a `TouchEvent`: its `phase` (`TouchPhase::Start`, `Move`, `End`, `Cancel`), its `timestamp` and its `points`, every finger that is down, each with its `id`, its `location` in the view it went down on, its `page` position in the surface, and `changed` for the fingers the event is about. In TSX, each phase has its own handler:

| TSX | Description |
|---|---|
| `onTouchStart` | A finger went down on the view or inside it. |
| `onTouchMove` | A finger moved. Moves are merged per engine turn. |
| `onTouchEnd` | A finger lifted. |
| `onTouchCancel` | The system took the touch (a scroll view started scrolling, a call came in). |
| `onTouchStartCapture`, `onTouchMoveCapture`, `onTouchEndCapture`, `onTouchCancelCapture` | The same, called from the outside in, before the bubbling handlers. |

Each TSX handler gets a `GestureResponderEvent`:

| Field | Description |
|---|---|
| `identifier` | Identifies the finger while it is down. |
| `locationX`, `locationY` | Position in the view the finger went down on (`target`). |
| `pageX`, `pageY` | Position in the surface. |
| `target` | The id of the view the finger went down on. |
| `timestamp` | Milliseconds. |
| `touches` | Every finger that is down. |
| `changedTouches` | The fingers this event is about. |
| `nativeEvent` | The event itself, so `e.nativeEvent.locationX` works too. |
| `stopPropagation()` | Views further out do not see this touch event. |

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

### Where a view is: measure

A touch's location is relative to the view the finger went down on, which may be a child of the view you care about (a slider's knob). Measuring a view tells you where it is, so you can use the page position instead. In Rust, put an `element_ref()` on the view and await its `measure()`; in TSX, call `measure()` on its ref:

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

It resolves once the changes made so far are laid out: in Rust to a `Measurement` (`frame`, the frame in the parent as the layout handler reports it, and `page`, the top left corner), in TSX to `{ bounds, pagePosition }`. The corner is in the surface, or in the dialog the view is in, the same coordinates as touches' page positions. The offsets of the scroll views and lists around it are taken into account; transforms (animations included) are not. It resolves to `None` / `null` for a view that is not on screen.

## The responder system

When your code has to own a touch sequence (finger drawing, a custom slider, a gesture the native recognizers do not offer), use the gesture responder system. One view at a time is the **responder** and receives the moves; views negotiate who that is.

Becoming the responder:

| Rust | TSX | Description |
|---|---|---|
| `.claim_touches(TouchClaim::on_start())` | `onStartShouldSetResponder` returning `true` | Asked when a finger goes down, from the target outwards. |
| `.claim_touches(TouchClaim::on_move())` | `onMoveShouldSetResponder` returning `true` | Asked on every move while there is no responder (or to take it over). |
| `TouchClaim::on_start().capture()` | `onStartShouldSetResponderCapture` | As above, asked from the outside in, before the bubbling ones. A parent uses it to take a touch from its children. |
| `TouchClaim::on_move().capture()` | `onMoveShouldSetResponderCapture` | The move version. |

A claim decides from the view alone, with no code of yours running, unless it asks: `TouchClaim::on_move().ask(|r: &ClaimRequest| ..)` claims when the listener calls `r.claim()`, deciding with the gesture so far (`r.event.gesture`). The TSX handlers get the gesture as their second argument, `gestureState`, with the same fields as [PanResponder's](#panresponder) (`dx`, `dy`, `vx`, `vy`, `moveX`, `moveY`, `x0`, `y0`, `numberActiveTouches`). A swipe that claims only horizontal moves: `onMoveShouldSetResponder={(e, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy)}`. That decision still comes a move late, so a scroll view around may start scrolling first; for drags inside scroll views use [pan activation](#pans-inside-scroll-views-panactivation).

While responding:

| Rust | TSX | Description |
|---|---|---|
| `.on_responder_grant(..)` | `onResponderGrant` | This view is now the responder. Rust keeps native scroll views from taking the touches by default (`TouchClaim::block_native(false)` lets them); in TSX, return `true` for that. |
| `.on_responder_reject(..)` | `onResponderReject` | Another view is the responder and would not let go. |
| `.on_responder_start(..)` | `onResponderStart` | Another finger went down. |
| `.on_responder_move(..)` | `onResponderMove` | A finger moved. |
| `.on_responder_end(..)` | `onResponderEnd` | A finger lifted. |
| `.on_responder_release(..)` | `onResponderRelease` | The last finger lifted: the gesture is over. |
| `.keep_touches(true)` | `onResponderTerminationRequest` returning `false` | Another view wants the touches: keep them (by default they are handed over). |
| `.on_responder_terminate(..)` | `onResponderTerminate` | Another view, or a native gesture, took the touches. |

A Rust component's responder stays pressed from its grant until its touches end, wherever the finger or pointer goes, as CSS's `:active` holds until the button is released: its `.active(..)` styles and the `group-active:` classes inside it keep their look for the whole drag (a resize handle dragged off its band).

The Rust handlers get a `ResponderEvent`: the finger's `location` in the view it went down on, its `page` position, the `timestamp` and the `gesture` since the grant.

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
    // The responder: the scroll view around does not take the touches.
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
        return true; // the scroll view around must not take the touches
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

How it runs: a view with any touch or responder handler listens to touches natively; the platform reports the touches on it (and inside it) with the path of listening views, and the negotiation runs in NSH's Rust core, asking the claims and calling your handlers in order: the captures from the outermost view inwards, then the others from the target outwards. Two consequences:

- **Native scroll views and responders compete.** While a responder blocks them, the scroll views around it stop taking the touches until it ends. If a native scroll view starts dragging first, it wins: the responder gets the terminate handler and the touch handlers a cancel.
- **Each move is an event to your code.** Responder-driven drags are as smooth as your code is fast; for drags that only move views, prefer [bound values](#native-gestures-pan-pinch-and-rotation).

## PanResponder

In Rust, the responder events already carry the gesture: `ResponderEvent::gesture` is a `PanGesture` with the distance from the start, the velocity and the number of fingers. In TSX, `PanResponder` from `nsh` wraps the responder system and adds the same gesture state; spread its `panHandlers` on a view.

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

The gesture state:

| Rust (`PanGesture`) | TSX (`gestureState`) | Description |
|---|---|---|
| | `stateID` | Identifies the gesture. |
| `position` | `moveX`, `moveY` | The latest position of the touches' centroid, in surface points. |
| `origin` | `x0`, `y0` | Where the centroid was when the responder was granted. |
| `delta` | `dx`, `dy` | Distance moved since the grant. |
| `vx`, `vy` | `vx`, `vy` | Velocity, in points per **millisecond**. |
| `active_touches` | `numberActiveTouches` | Fingers down. |

`PanGesture::begin` and `PanGesture::update` follow a gesture from raw touches (`.on_touch`) in Rust. The TSX callbacks get `(event, gestureState)`: `onStartShouldSetPanResponder(Capture)`, `onMoveShouldSetPanResponder(Capture)`, `onPanResponderGrant`, `onPanResponderReject`, `onPanResponderStart`, `onPanResponderMove`, `onPanResponderEnd`, `onPanResponderRelease`, `onPanResponderTerminate`, `onPanResponderTerminationRequest` and `onShouldBlockNativeResponder`. The last one defaults to `true`: a granted PanResponder keeps native scroll views from taking its touches.

## Pans inside scroll views: panActivation

A chart scrubbed sideways inside a vertical scroll view has to take horizontal drags and leave vertical ones to the scroll view. Claiming the touch on start blocks scrolling from the first pixel, and deciding on the moves in your code is too late: by the time it answers, the scroll view may have taken the touch. Pan activation (`TouchClaim::on_pan(..)`, `panActivation`) lets the platform decide on the main thread, as the finger moves:

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

| Rust (`PanActivation`) | TSX | Description |
|---|---|---|
| `active_offset_x`, `active_offset_y` | `activeOffsetX`, `activeOffsetY` | The pan activates once the finger has moved further than this from where it went down, along that axis (either direction, points). |
| `fail_offset_x`, `fail_offset_y` | `failOffsetX`, `failOffsetY` | The pan fails once the finger has moved further than this first: the scroll views keep the touches. |

`PanActivation::horizontal(active, fail)` and `PanActivation::vertical(active, fail)` set the usual pairs. Without active offsets the pan activates after 10 points in any direction. Until it activates, the scroll views around wait for it (iOS) and the view's other claims are not asked. When it activates, the scroll views can no longer take these touches and the view becomes the responder (the grant, then the moves); when it fails, the scroll view scrolls as usual. In TSX, `PanResponder`'s `panHandlers` work with it too: spread them next to the prop, and `onPanResponderGrant` runs at the activation.

> [!NOTE]
> Velocities differ by API: the responder gesture's `vx` / `vy` are points per millisecond, while the pan end's velocity and a spring's or a decay's velocity are points per second. Multiply `vx` by 1000 before passing it to a spring.

## Why some answers are props

The main thread never waits for your code. When the system needs an answer on the spot (may this pan gesture begin, does this point hit the view, should this tap dismiss the keyboard), NSH answers natively from what was mounted beforehand: the bound pan values (their axes), the pinch value, the hit slop, the pointer events, the keyboard taps setting of scroll views, the pan activation. Your handlers hear about what happened afterwards. That is why these are declarative settings rather than callbacks, and why the responder negotiation, which does run your code, only decides between responders and never blocks a native gesture.

## Related

- [`View`](../elements/view.md): every touch prop on the basic element.
- [Animation](./animation.md): animated values, springs and decay for gesture-driven motion.
- [Scrolling](./scrolling.md): the keyboard taps setting, scroll views and nested gestures.
- [`PanResponder`](../modules/nsh.md#panresponder): the `PanResponder` reference.
- [Accessibility](./accessibility.md): pressable views are accessibility elements; give them a role and a label.

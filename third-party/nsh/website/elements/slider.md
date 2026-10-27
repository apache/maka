---
title: Slider
description: "The Slider component: a value, or a range of two, picked along a track, with presses and drags on touch screens and with a mouse, WAI-ARIA's slider keys and a value for screen readers on each thumb, and a track, an indicator, a range and thumbs the app styles."
order: 20.85
group: base
demo: el-slider
---

# Slider

A slider picks a value along a track (a volume, a brightness), or a range of two values with a thumb each (a price
range). It owns its behavior: a press on the track moves the nearer thumb there, a thumb follows a drag, with a mouse
or a finger; values snap to the `step`; each thumb is a stop of the keyboard focus and moves with the arrow keys, and is
an adjustable element for screen readers with its own value. The look is the app's: a `Slider` has no colors, sizes,
radii or motion of its own. It is made of a track with an indicator inside it, the range and the thumbs on the
indicator, then its children (a label, the value as text), and the app styles each part.

```rust tabs
use nsh_base::{SliderValue, slider, theme};
use nsh_core::prelude::*;

fn strength(level: Signal<SliderValue>) -> impl IntoElement {
    let percent = move || format!("{}%", level.get().end());
    slider()
        .value(move || level.get())
        .accessibility_label("Option strength")
        .on_change(move |next: &SliderValue| level.set(*next))
        // The value in a column after the rail.
        .flex_row()
        .items_center()
        .gap_2()
        // An 8-point rail; the thumbs travel inside it.
        .track_style(|s| s.h(px(8.0)).flex_1().px(px(8.0)).rounded_full().bg(move || theme().muted))
        .indicator_style(|s| s.h_full())
        // The fill, from the rail's edge, fading into the thumb's tone.
        .range_style(|s| {
            s.ml(-px(8.0))
                .rounded_full()
                .bg_linear_to_r()
                .gradient_from(move || theme().primary)
                .gradient_to(move || theme().muted_foreground)
        })
        // A 16 x 8 pill sitting in the rail.
        .thumb_style(|s| {
            s.w(px(16.0))
                .h(px(8.0))
                .rounded_full()
                .bg(move || theme().muted_foreground)
                .hover(|s| s.brightness(1.1))
                .active(|s| s.brightness(1.25))
        })
        .child(
            text(percent)
                .w(px(42.0))
                .text_right()
                .text_xs()
                .tabular_nums()
                .text_color(move || theme().muted_foreground),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Slider } from "nsh/base";

function App() {
  const strength = signal(64);
  return (
    <Slider
      value={strength()}
      onChange={(next) => strength.set(next as number)}
      accessibilityLabel="Option strength"
      class="flex-row items-center gap-2"
      trackClass="h-2 flex-1 px-2 rounded-full bg-muted focus-within:ring-2 focus-within:ring-primary/36 focus-within:ring-offset-2 focus-within:ring-offset-background disabled:opacity-35"
      indicatorClass="h-full"
      rangeClass="-ml-2 rounded-full bg-linear-to-r from-primary via-primary to-muted-foreground"
      thumbClass="h-2 w-4 rounded-full bg-muted-foreground transition hover:brightness-110 active:brightness-125 focus:outline-none disabled:brightness-100 motion-reduce:transition-none"
      thumbStyle={{ boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.42)" }}
    >
      <Text class="w-[42px] text-right font-mono text-[11px] text-muted-foreground">{`${strength()}%`}</Text>
    </Slider>
  );
}

mount(App);
```

`Slider` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `slider()` makes one
with a setter per prop (`.value(..)`, `.thumb_style(..)`), a listener method per event (`.on_change(..)`), the typed
style methods for the slider itself and `.child(..)` for its label. Its value is a `SliderValue`: `Single(f64)` or
`Range(f64, f64)`.

## Value

The value is a number, or `[start, end]` for a range with two thumbs; the shape of the value decides how many thumbs
there are. The app owns it with `value` and sets the one `onChange` reports, as for every control of `nsh/base`; or it
leaves the value to the slider with `defaultValue`, and hears the changes all the same.

```tsx
const price = signal<[number, number]>([200, 800]);

<Slider
  value={price()}
  onChange={(next) => price.set(next as [number, number])}
  onChangeEnd={(next) => save(next)}
  min={0}
  max={1000}
  step={10}
  accessibilityLabel="Maximum price"
  startAccessibilityLabel="Minimum price"
/>;
```

- `onChange` reports each new value the user asks for: on a press on the track, at each step of a drag, for each key.
  Each report is a new value.
- `onChangeEnd` reports the value the change ended at, once: when the pointer lifts after a press or a drag that set a
  value, and after each key or screen reader step (each is a whole change). Save or send the value there.
- Values snap to `step`, counted from `min` (`min={1} step={2}` gives 1, 3, 5, ...), and stay between `min` and `max`;
  `max` is always reachable, so the last step is shorter when the range is not a whole number of steps. `step={0}`
  takes any value.
- A range's thumbs never cross: a dragged thumb stops at the other one. A drag that starts on two thumbs at one value
  moves the one that can go the pointer's way.
- The value shown is the app's, held to `min` and `max` (a range's ends in order), and a value off the step's grid
  shows where it is; the user's next change snaps.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `number \| [number, number]` | none | The value (controlled): a number, or a range with two thumbs. The app sets the one `onChange` reports. |
| `defaultValue` | `.default_value(..)` | `number \| [number, number]` | `0` | The value at first while `value` is not set; the slider then keeps its own. |
| `min` | `.min(..)` | `number` | `0` | The smallest value. |
| `max` | `.max(..)` | `number` | `100` | The largest value; one below `min` is `min`. |
| `step` | `.step(..)` | `number` | `1` | The step values snap to, counted from `min`; `0` takes any value. |
| `scale` | `.scale(..)` | `"linear" \| "logarithmic"` | `"linear"` | How values spread along the track: evenly, or by orders of magnitude (from 1 to 1000, a third of the way is 10). Logarithmic needs `min` above 0; with a lower `min` it is linear. |
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | The track's direction: `min` at the left, or at the bottom. Read when the slider is made. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No pointer, keyboard or screen reader changes; `disabled:` classes apply to the slider and its parts. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say for the thumb (on a range, the end's). |
| `startAccessibilityLabel` | `.start_accessibility_label(..)` | `string` | `accessibilityLabel` | What screen readers say for a range's start thumb. |
| `trackClass`, `trackStyle` | `.track_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The track: the area that takes presses and drags. |
| `indicatorClass`, `indicatorStyle` | `.indicator_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The indicator, the rail the values map onto. |
| `rangeClass`, `rangeStyle` | `.range_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The range, from `min` to the thumb (between a range's thumbs), placed by the slider. |
| `thumbClass`, `thumbStyle` | `.thumb_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | Each thumb, centered on its value. |
| `children` | `.child(..)` | `JSX.Element` | none | The content after the track: a label, the value as text. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The slider itself: the column (or row) around the track and the label. |

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onChange` | `.on_change(\|value: &SliderValue\| ..)` | `number \| [number, number]` | The user asked for a new value: a press on the track, a step of a drag, a key, a screen reader's increment or decrement. |
| `onChangeEnd` | `.on_change_end(\|value: &SliderValue\| ..)` | `number \| [number, number]` | The change ended: the pointer lifted, a key or a screen reader's step was done. Once per change. |

## Parts

| Part | Inside | Styled with |
|---|---|---|
| The slider | | `class`, `style` |
| The track | the slider, first | `trackClass`, `trackStyle` |
| The indicator | the track | `indicatorClass`, `indicatorStyle` |
| The range | the indicator, placed by the values | `rangeClass`, `rangeStyle` |
| A thumb (two on a range) | the indicator, centered on its value | `thumbClass`, `thumbStyle` |
| The label | the slider, after the track | its own elements (`children`) |

The track takes presses and drags. The indicator's length is the range of values, from `min` at its leading edge (at
its bottom when vertical); the slider places the range and the thumbs on it, a thumb centered on its value whatever its
size. Two ways to lay them out:

- The track is the rail (the example above): `h-2 px-2 rounded-full bg-muted` with an `h-full` indicator. The padding
  keeps the thumbs inside the rail at both ends, and the range's `-ml-2` starts the fill at the rail's own edge.
- The track is a band around the rail, taller so a finger finds it on a touch screen: `h-8 justify-center` with an
  `h-2 rounded-full` indicator (`w-8 items-center` and `w-2 h-full` on a vertical slider).

States the parts show:

- A thumb: `hover:` under the pointer, `active:` while it is dragged, `focus:` with the keyboard focus, `disabled:`.
- The track: `active:` while a press on it drags; it is a `group`, so the indicator, the range and the thumbs take
  `group-hover:` and `group-active:` from it.
- Every part: `disabled:` while the slider is.

The thumbs move as the value changes, and follow a drag at once. Motion of the thumbs' states is the app's choice
(`transition` for a thumb that brightens on `hover:` and `active:`), and `motion-reduce:` keeps it still for
people who ask for less motion. The keyboard focus is a thumb's, which it reports while it has a `focus:` class:
`focus-within:` on the track then rings the whole rail, and the thumb's `focus:outline-none` takes the place of the
platform's own focus outline.

## Keyboard

On macOS and the web each thumb is a stop of the keyboard focus (Tab), and the focused thumb takes WAI-ARIA's slider
keys:

| Key | Does |
|---|---|
| Right, Up | One step up (also on a vertical slider). |
| Left, Down | One step down. |
| Page Up, Page Down | A tenth of the range up or down (along the scale), by at least one step. |
| Home, End | As far down or up as the thumb goes (a range's start up to its end). |

Each key that changes the value reports `onChange` and then `onChangeEnd`. Arrows and pages repeat while held. The keys
reach the slider only while no text input edits.

## Accessibility

- Each thumb is an adjustable element (`"adjustable"`, a slider in the browser) with its label, its value and the
  values it can take: a range's start from `min` up to the end, its end from the start up to `max`, so screen readers
  read and set both. The value is spoken as the number with the step's decimals (`2.5`).
- A screen reader's increment and decrement actions (VoiceOver's swipe up and down) step the thumb, as the arrow keys
  do.
- The thumbs are the slider's elements for screen readers, named by `accessibilityLabel` (and a range's start by
  `startAccessibilityLabel`); a visible label among its children is read where it is.
- While `disabled`, screen readers say the thumbs are dimmed, and they take no actions.

See [Accessibility](../docs/accessibility.md) for labels, roles and actions in general.

## Platform notes

- Every platform draws what the app styles. Presses and drags are followed in the core, for a mouse, a pen or a
  finger, and a scroll view around the slider does not take a drag that started on it.
- Tab moves the keyboard focus between thumbs on macOS and the web, where the focused thumb takes the slider keys.
- Screen readers: VoiceOver (iOS, macOS) and TalkBack adjust each thumb; UI Automation (Windows), GTK's accessibility
  (Linux) and the browser (`role="slider"`, `aria-valuenow`, `aria-valuetext`) get its range and value.

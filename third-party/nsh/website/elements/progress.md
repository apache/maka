---
title: Progress
description: "The Progress component: a linear progress bar that owns its role, range and value for screen readers and the indicator's width by the value, with a track and an indicator the app styles."
order: 20.8
group: base
demo: el-progress
---

# Progress

A progress bar shows how far a task with a known extent is (a download, an upload, a step of a setup), or, while
`indeterminate`, that a task of unknown extent is under way. It owns what screen readers get, the progress bar role
with the range 0 to 100 and the value, and the indicator's width: `value` percent of the track's. The look is the
app's: a `Progress` has no colors, sizes, radii, motion or label of its own. It is made of a track with an indicator
inside it, then its children (a label, the value as text), and the app styles each part.

```rust tabs
use nsh_base::{progress, theme};
use nsh_core::prelude::*;

fn upload(sent: Signal<f32>) -> impl IntoElement {
    progress()
        .value(sent)
        .accessibility_label("Uploading photos")
        .gap_2()
        .track_style(|s| s.h(px(8.0)).rounded_full().overflow_hidden().bg(move || theme().muted))
        .indicator_style(|s| s.h_full().rounded_full().bg(move || theme().primary))
        .child(
            text(move || format!("{:.0}%", sent.get()))
                .text_sm()
                .text_color(move || theme().muted_foreground),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { Progress } from "nsh/base";

function App() {
  const sent = signal(40);
  return (
    <Progress
      value={sent()}
      accessibilityLabel="Uploading photos"
      class="gap-2"
      trackClass="h-2 overflow-hidden rounded-full bg-muted"
      indicatorClass="h-full rounded-full bg-primary"
    >
      <Text class="text-sm text-muted-foreground">{`${sent()}%`}</Text>
    </Progress>
  );
}

mount(App);
```

`Progress` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The value is the app's: the
progress bar shows the `value` the app passes, held to 0 to 100. In Rust, `progress()` makes one with a setter per prop
(`.value(..)`, `.indicator_style(..)`), the typed style methods for the progress bar itself and `.child(..)` for its
label.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `number` | `0` | How far the task is, as a percentage from 0 to 100 (outside the range, the nearest end). The indicator is that share of the track's width, and screen readers say it. |
| `indeterminate` | `.indeterminate(..)` | `boolean` | `false` | The task's extent is unknown: screen readers hear a progress bar with no value, and the indicator's width is the app's (`indicatorClass`). |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say: what is in progress, when its children have no text that says it. |
| `trackClass`, `trackStyle` | `.track_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The track, the part the indicator fills. |
| `indicatorClass`, `indicatorStyle` | `.indicator_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The indicator, inside the track: its height, color and motion. |
| `children` | `.child(..)` | `JSX.Element` | none | The content after the track: a label or the value as text, which screen readers say. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The progress bar itself: the column (or row) around the track and the label. |

## Parts

| Part | Inside | Styled with |
|---|---|---|
| The progress bar | | `class`, `style` |
| The track | the progress bar, first | `trackClass`, `trackStyle` |
| The indicator | the track | `indicatorClass`, `indicatorStyle`; its width is `value` percent of the track's |
| The label | the progress bar, after the track | its own elements (`children`) |

The indicator starts at the track's leading edge; `overflow-hidden` and a radius on the track round its end with the
track's. A `w-*` class or a `width` in `indicatorStyle` takes the place of the value's width, which is how an
indeterminate bar gets its own.

## Indeterminate

While the extent is unknown, set `indeterminate` and give the indicator a width and motion of the app's. Motion is
the app's choice, and `motion-reduce:` keeps it still for people who ask for less motion:

```tsx
<Progress
  value={0}
  indeterminate={connecting()}
  trackClass="h-2 overflow-hidden rounded-full bg-muted"
  indicatorClass={
    connecting()
      ? "h-full w-1/3 rounded-full bg-primary animate-pulse motion-reduce:animate-none"
      : "h-full rounded-full bg-primary"
  }
/>
```

## Accessibility

- A progress bar is one element for screen readers, with the role `"progressbar"`, the range 0 to 100 and its value
  (VoiceOver and TalkBack say it as a percentage); the track and the indicator are parts of it. Its label is the text
  of its children; give `accessibilityLabel` when it has none.
- While `indeterminate`, it keeps the role and the range and has no value (in the browser: `aria-valuenow` is left out,
  as ARIA says an indeterminate progress bar is).
- It takes no presses and no keyboard focus: it reports, and the controls that start or stop the task are the app's.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- Every platform draws what the app styles; the indicator's width follows `value` at once, and a change animates
  when the app animates it.
- Screen readers: VoiceOver (iOS, macOS) hears the value as a percentage and the bar as updating frequently;
  TalkBack, UI Automation (Windows), GTK's accessibility (Linux) and the browser (`aria-valuenow`) get the range and the
  value.

---
title: Toast
description: "Toast, ToastStack and ToastManager: unstyled toasts as gpui-base's, a semantic root with a transition status, a stack that lays toasts out as layers, and their headless lifecycle."
group: base
demo: el-toast
---

# Toast

Toasts are short messages shown for a while over the app: "Copied", "Draft deleted · Undo", "Could not send".
`nsh/base` provides their behavior in three unstyled pieces, the same as GPUI Kit's `gpui-base`:

- **`ToastManager`** keeps the toasts in order with their lifecycle: each one is `"starting"`, then `"present"` once
  the motion's duration has passed, counts its timeout down while present and not paused, and stays `"ending"` for
  the exit's duration before it is removed.
- **`ToastStack`** measures its toasts and lays them out from an edge, the newest nearest it: overlapping layers while
  collapsed, a list while expanded (the pointer on it, or a finger down on it), moved with springs.
- **`Toast`** is each toast's root: the `alert` role, its `transitionStatus` for the app's styles, a swipe that asks to
  dismiss it, and the screen reader reading its label as it shows.

The look and the content are the app's, and so is the convenience of showing a toast from anywhere: an app builds its
own `toast(...)` on these, as the gallery does (`examples/gallery/toast.tsx`) and as GPUI Kit's notifications are
built on `gpui-base`'s toasts.

```rust tabs
use std::time::Duration;

use nsh_core::{time::now, prelude::*};

use nsh_base::{
    Anchor, ToastManager, ToastMotion, ToastOptions, ToastStackState, theme, toast, toast_stack,
};

fn toasts() -> impl IntoElement {
    let manager = stored(ToastManager::<u64, SharedString>::new(ToastMotion::sonner()));
    let shown = signal(Vec::new());
    let state = ToastStackState::new();
    let sync = move || {
        shown.set(manager.with(|m| {
            m.visible(3)
                .map(|(id, t, s)| (*id, t.clone(), s))
                .collect::<Vec<_>>()
        }))
    };
    // Advance the lifecycle while toasts are mounted, paused while expanded.
    set_interval(Duration::from_millis(50), move || {
        if manager.with(|m| m.advance(now(), state.is_expanded()).changed) {
            sync();
        }
    });
    manager.with(|m| {
        m.push(
            1,
            "Copied".into(),
            ToastOptions::timeout(Some(Duration::from_secs(5))),
            now(),
        )
    });
    sync();
    toast_stack()
        .placement(Anchor::BottomCenter)
        .state(state)
        .w(px(340.0))
        .child(each(
            shown,
            |(id, _, _)| *id,
            move |item, _| {
                toast()
                    .transition_status(move || item.get().2)
                    .accessibility_label(move || Some(item.get().1))
                    .on_dismiss_request(move || {
                        manager.with(|m| m.dismiss(&item.get().0, now()));
                    })
                    .rounded_xl()
                    .px_4()
                    .py_3()
                    .bg(move || theme().card)
                    .shadow_lg()
                    .transition_all()
                    .duration(200.0)
                    .starting_class("opacity-0 translate-y-4")
                    .ending_class("opacity-0 scale-95")
                    .child(text(move || item.get().1))
            },
        ))
}
```

```tsx tabs
import { Overlay, signal, Text, safeArea } from "nsh";
import { Toast, type ToastEntry, ToastManager, ToastStack } from "nsh/base";

const manager = new ToastManager();
const shown = signal<ToastEntry[]>([]);
const expanded = signal(false);
const sync = () => shown.set(manager.visible(3));
// Advance the lifecycle on a timer, paused while the stack is expanded.
setInterval(() => {
  if (manager.advance(expanded()).changed) sync();
}, 50);

export function toast(title: string) {
  manager.push(crypto.randomUUID(), { title }, { timeout: 5000 });
  sync();
}

export function Toaster() {
  return (
    <Overlay class="inset-x-0 bottom-0 items-center p-4" style={{ paddingBottom: safeArea().bottom + 16 }}>
      <ToastStack placement="bottomCenter" class="w-80" onExpandedChange={(e) => expanded.set(e.expanded)} onCancel={() => {
        const newest = shown().filter((t) => t.status !== "ending").at(-1);
        if (newest) { manager.dismiss(newest.id); sync(); }
      }}>
        <Each of={shown()} key={(t: ToastEntry) => t.id}>
          {(t) => (
            <Toast
              transitionStatus={t().status}
              accessibilityLabel={(t().value as { title: string }).title}
              onDismissRequest={() => { manager.dismiss(t().id); sync(); }}
              class="rounded-xl bg-card px-4 py-3 shadow-lg transition-all duration-200"
              startingClass="opacity-0 translate-y-4"
              endingClass="opacity-0 scale-95"
            >
              <Text class="font-semibold text-card-foreground">{(t().value as { title: string }).title}</Text>
            </Toast>
          )}
        </Each>
      </ToastStack>
    </Overlay>
  );
}
```

`Toast`, `ToastStack` and `ToastManager` come from [`nsh/base`](../modules/nsh-base.md). In Rust they are
`nsh_base`'s `toast`, `toast_stack` and `ToastManager`.

## ToastManager

The manager is headless: it renders nothing and runs no timer. The app pushes toasts, renders the ones
`visible(limit)` returns with their status, and calls `advance` on a timer while any is mounted, passing `paused`
while the stack is expanded. In Rust it is `ToastManager<I, T>` over the app's ids and values, with an `Instant` for
each call; in TS it is a class over string ids and any JSON value, on the engine's clock (a test's manual clock
included).

- `push(id, value, options)` adds the newest toast, replacing one with the same id (whose value it returns);
  `options.timeout` is its present time in milliseconds (none: it stays until dismissed).
- `dismiss(id)` begins a toast's exit; `dismissAll()` every toast's, returning their ids.
- `advance(paused)` moves the lifecycle on and reports what changed: `presented`, `ending` (their timeout ran out),
  `removed` (with their values), and `changed`.
- `visible(limit)` is the newest `limit` toasts that are not ending plus the ending ones, oldest first; `entries()`
  (Rust `iter()`) all of them; `get(id)`, `len()`, `isEmpty()`.

`ToastMotion` holds the tokens of both: `duration` (400 ms: the enter's deadline and the stack's spring response),
`exitDuration` (200 ms), `collapsedPeek` (14), `expandedGap` (14), `collapsedScaleStep` (0.05) and
`collapsedVisible` (3), Sonner's (`ToastMotion::sonner()` in Rust; fields left out in TS keep them).

## ToastStack

The stack's children are its toasts, oldest first. From its `placement` edge (`"topRight"` by default; the bottom
anchors lay out upward), collapsed toasts overlap `collapsedPeek` apart, each further one narrower by
`collapsedScaleStep`, and only `collapsedVisible` show; expanded, they are a list `expandedGap` apart. Toasts that
arrive or leave, and expansion, move them with critically damped springs. It is expanded while the pointer is on it
or a finger is down on it (`onExpandedChange({ expanded })`; Rust `ToastStackState`, whose `is_expanded()` reads it), so
the app pauses the timeouts while the user reads or touches the toasts.

The app places the stack: in an [Overlay](./overlay.md) at the edge, inside the safe area. Its `class` and `style`
give its width. While it holds toasts it hears Escape and the Android back button (`onCancel`; `closeOnEscape={false}`
leaves them to the rest of the app): dismiss the newest.

## Toast

A toast is the `alert` role around the app's content. Its `transitionStatus` is the manager's, and its state classes
follow it over its `class`: `startingClass` in its first frame while `"starting"`, so its `transition` classes animate
from it (Tailwind's `starting:`, CSS's `@starting-style`); `endingClass` while `"ending"`, for the exit's duration;
`swipingClass` while a pointer swipes it (`transition-none` keeps it under the finger).

A finger or the mouse dragged toward `swipeDirection` (`"right"` by default; `null` turns swiping off) moves it, once
the pointer has moved, so its buttons stay buttons; let go past `swipeThreshold` points (50) or flicked, it moves on
out and asks to be dismissed (`onDismissRequest`), short of it, it goes back. The screen reader reads its
`accessibilityLabel` as it shows.

## Toast props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `transitionStatus` | `.transition_status(..)` | `"starting" \| "present" \| "ending"` | `"starting"` | Its lifecycle phase. |
| `startingClass`, `endingClass`, `swipingClass` | `.starting_class(..)`, ... | `string` | none | Its classes in its first frame, while ending, while swiped. |
| `swipeDirection` | `.swipe_direction(..)` | `"right" \| "left" \| "up" \| "down" \| null` | `"right"` | The direction it is swiped away in. |
| `swipeThreshold` | `.swipe_threshold(..)` | `number` | `50` | How far a swipe goes before a release asks to dismiss it. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What the screen reader reads as it shows. |
| `onDismissRequest` | `.on_dismiss_request(..)` | `() => void` | none | The user swiped it away. |

## ToastStack props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `motion` | `.motion(..)` | `ToastMotion` | Sonner's | Its motion tokens. |
| `placement` | `.placement(..)` | `"topLeft" \| "topCenter" \| "topRight" \| "bottomLeft" \| "bottomCenter" \| "bottomRight" \| "leftCenter" \| "rightCenter"` | `"topRight"` | The edge it lays out from. |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean` | `true` | It hears Escape and back while it holds toasts. |
| `onExpandedChange` | `.on_expanded_change(..)`, `.state(..)` | `(e: { expanded: boolean }) => void` | none | Interaction expanded or collapsed it. |
| `onCancel` | `.on_cancel(..)` | `() => void` | none | Escape or back: dismiss the newest. |

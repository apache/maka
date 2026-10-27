---
title: Canvas
description: "The Canvas element: custom drawing with a 2D context, replayed natively."
order: 8
group: primitives
demo: el-canvas
---

# Canvas

A canvas is a view you draw yourself with a 2D drawing API, the HTML Canvas 2D API's: charts, gauges, rings,
signatures, custom shapes. The drawing code records operations; the platform replays them natively (Core Graphics on
iOS and Mac Catalyst, `android.graphics.Canvas` on Android) at the screen's resolution. Rust makes one with
`canvas(painter)`, a `Painter` recording the drawing; TSX with `<Canvas>` from `nsh` and its `draw` function.

```rust tabs
use std::f32::consts::{FRAC_PI_2, TAU};

use nsh_core::{canvas::LineCap, prelude::*};

/// A progress ring, 120 points square.
fn ring(progress: f32) -> impl IntoElement {
    let (center, radius) = (60.0, 50.0);
    canvas(
        Painter::new()
            .line_width(12.0)
            .line_cap(LineCap::Round)
            .stroke_color(rgb(0xe5e7eb))
            .begin_path()
            .arc(center, center, radius, 0.0, TAU)
            .stroke()
            .stroke_color(rgb(0x6366f1))
            .begin_path()
            .arc(center, center, radius, -FRAC_PI_2, -FRAC_PI_2 + progress * TAU)
            .stroke(),
    )
    .size(px(120.0))
}
```

```tsx tabs
import { Canvas, mount } from "nsh";

function Ring(props: { progress: number }) {
  return (
    <Canvas
      style={{ width: 120, height: 120 }}
      draw={(cx, { width, height }) => {
        const centerX = width / 2, cy = height / 2, r = width / 2 - 10;
        cx.lineWidth = 12;
        cx.lineCap = "round";
        cx.strokeStyle = "#e5e7eb";
        cx.beginPath();
        cx.arc(centerX, cy, r, 0, Math.PI * 2);
        cx.stroke();
        cx.strokeStyle = "#6366f1";
        cx.beginPath();
        cx.arc(centerX, cy, r, -Math.PI / 2, -Math.PI / 2 + props.progress * Math.PI * 2);
        cx.stroke();
      }}
    />
  );
}

mount(() => <Ring progress={0.7} />);
```

In TSX, `Canvas` creates the native canvas view, measures it, and runs your `draw` function with a context and the
canvas's size (see the [Canvas API](../modules/nsh-canvas.md)). In Rust, `canvas(..)` takes a `Painter`, or a closure
returning one: the closure draws again when what it reads changes, and the size comes from `on_layout` when the
drawing depends on it.

## Props

A canvas takes the props of a [view](./view.md) (styles, press and gesture props, `onLayout`, accessibility, `ref`, …)
plus:

| Prop | Rust | Type | Description |
|---|---|---|---|
| `draw` | `canvas(painter)` | `(cx: CanvasRenderingContext2D, size: { width: number; height: number }) => void` | Draws the canvas. Runs once the size is known, again when the canvas resizes, and again when signals it reads change. |

Give the canvas a size through its styles (width / height, `flex`, an aspect ratio): its size is the one its styles
give it.

## When it redraws

The drawing is tracked like an effect: reading a signal inside it subscribes the drawing to that signal.

```rust tabs
let values = signal(vec![12.0_f32, 40.0, 28.0, 64.0]);
let width = signal(0.0_f32);
let height = 160.0;

canvas(move || {
    let data = values.get(); // a change of values redraws
    let step = width.get() / data.len() as f32;
    data.iter().enumerate().fold(Painter::new().fill_color(rgb(0x0969da)), |p, (i, v)| {
        p.fill_rect(i as f32 * step + 4.0, height - v, step - 8.0, *v)
    })
})
.h(px(height))
.on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
```

```tsx tabs
const values = signal([12, 40, 28, 64]);

<Canvas
  style={{ height: 160 }}
  draw={(cx, { width, height }) => {
    const data = values(); // a change of values() redraws
    const step = width / data.length;
    cx.fillStyle = "#0969da";
    data.forEach((v, i) => cx.fillRect(i * step + 4, height - v, step - 8, v));
  }}
/>;
```

Numbers and colors may also be [native animated values](../modules/nsh.md#animation) (`CanvasNumber`, `CanvasPaint`;
in Rust a `&AnimatedValue` wherever a number goes): the platform then redraws on its own while they animate, with no
work in the app's code per frame.

```rust tabs
use std::f32::consts::TAU;

let angle = animated_value(0.0);
angle.timing(TAU, 1000.0, Easing::Linear);

canvas(
    Painter::new()
        .translate(40.0, 40.0)
        .rotate(&angle) // animates natively
        .fill_color(rgb(0xcf222e))
        .fill_rect(-20.0, -4.0, 40.0, 8.0),
)
.size(px(80.0))
```

```tsx tabs
import { Canvas } from "nsh";
import { Animated, createAnimatedValue } from "nsh";

const angle = createAnimatedValue(0);
Animated.timing(angle, { toValue: Math.PI * 2, duration: 1000 }).start();

<Canvas
  style={{ width: 80, height: 80 }}
  draw={(cx) => {
    cx.translate(40, 40);
    cx.rotate(angle); // animates natively
    cx.fillStyle = "#cf222e";
    cx.fillRect(-20, -4, 40, 8);
  }}
/>;
```

## The context

`CanvasRenderingContext2D` is a subset of the browser's, and `Painter` has the same operations as methods in snake case
(`move_to`, `line_to`, `fill_rect`, `fill_text`, `stroke_color`, …): the state stack (`save`, `restore`), transforms,
paths (`moveTo`, `lineTo`, `arc`, `arcTo`, `ellipse`, `rect`, `roundRect`, Bézier curves), `fill` / `stroke` / `clip`
(also of a `Path2D`, which accepts SVG path data; `fill_svg` / `stroke_svg` in Rust), rectangles, text (`fillText`,
`strokeText`, `measureText`), linear / radial / conic gradients, line dashes, shadows, `globalAlpha`,
`globalCompositeOperation` and `drawImage` (images by URL or asset). Every member is listed in the
[Canvas API reference](../modules/nsh-canvas.md); the [canvas guide](../docs/canvas.md) walks through drawing
charts and animated graphics.

Coordinates are in points with the origin at the top left. `measureText` is synchronous and returns `width`. Rust's
`Painter` answers hit tests too (`is_point_in_path`, `is_point_in_stroke`).

The context draws vector operations and images: pixel access (`getImageData` / `putImageData`), `filter` and SVG
images are outside it.

## Events

The [view events](./view.md#events): `onPress`, `onLayout`, gestures and touches. To handle drawing-relative taps, read
`locationX` / `locationY` in `onTouchEnd`, or track a drag with `onResponderMove` (`.on_responder_move(..)` in Rust,
with `e.location`).

## Ref methods

None of its own.

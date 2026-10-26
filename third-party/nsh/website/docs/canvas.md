---
title: Canvas
description: Drawing on a canvas in Rust and TSX - the 2D operations, paths and SVG path data, gradients, text, images, redrawing from signals, and animating drawings with animated values.
order: 44
group: ui
demo: guide-canvas
---

# Canvas

A canvas is a view you draw into with the operations of the HTML Canvas 2D API: charts, progress rings, gauges, signatures, custom icons, anything that is easier to draw than to build out of views. In Rust, `canvas(..)` shows what a `Painter` recorded; in TSX, `Canvas` from `nsh` takes a `draw` function that records the drawing in one go. The platform replays it natively (Core Graphics on iOS, `android.graphics.Canvas` on Android) at the screen's resolution, so drawings stay sharp at any pixel density.

```rust tabs
use std::f32::consts::TAU;

use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let area = signal((0.0_f32, 0.0_f32));
    view().flex_1().p_6().pt(px(60.0)).child(
        canvas(move || {
            let (w, h) = area.get();
            Painter::new()
                .fill_color(rgb(0x0969da))
                .begin_path()
                .arc(w / 2.0, h / 2.0, 60.0, 0.0, TAU)
                .fill()
                .stroke_color(rgb(0x1f2328))
                .line_width(4.0)
                .stroke_rect(bounds(point(px(20.0), px(20.0)), size(px(w - 40.0), px(h - 40.0))))
        })
        .h(px(200.0))
        .rounded(px(12.0))
        .bg(white())
        .on_layout(move |frame: &Bounds<Points>| area.set((frame.size.width.0, frame.size.height.0))),
    )
}
```

```tsx tabs
import { Canvas, mount, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, padding: 24, paddingTop: 60 }}>
      <Canvas
        style={{ height: 200, borderRadius: 12, backgroundColor: "#ffffff" }}
        draw={(cx, { width, height }) => {
          cx.fillStyle = "#0969da";
          cx.beginPath();
          cx.arc(width / 2, height / 2, 60, 0, Math.PI * 2);
          cx.fill();
          cx.strokeStyle = "#1f2328";
          cx.lineWidth = 4;
          cx.strokeRect(20, 20, width - 40, height - 40);
        }}
      />
    </View>
  );
}

mount(App);
```

A canvas takes everything a [view](../elements/view.md) takes (styles, classes, touch handlers, accessibility, refs) plus its drawing. It needs a size from its style or layout; its content is the drawing. Coordinates are in points, with the origin at the top left.

## When the drawing is made

In Rust, `canvas(move || ..)` records in a binding: the closure runs once, and again when a [signal](./reactivity.md) it read changes. A drawing that depends on the canvas's size keeps the size from `.on_layout(..)` in a signal and reads it, as above. In TSX, `draw(cx, { width, height })` runs:

- once the canvas's size is known (after its first layout);
- again when the canvas is resized;
- again when a signal it read changes.

Each run replaces the whole drawing. Reading signals while drawing is how a canvas follows your data:

```rust tabs
let values = signal(vec![12.0_f32, 30.0, 22.0, 48.0, 36.0, 60.0]);
let width = signal(0.0_f32);
let height = 160.0;

canvas(move || {
    let w = width.get();
    values.with(|v| {
        let x = |i: usize| i as f32 / (v.len() - 1) as f32 * w;
        let y = |n: f32| height - n / 100.0 * height;
        let mut p = Painter::new().begin_path().move_to(x(0), y(v[0]));
        for (i, &n) in v.iter().enumerate().skip(1) {
            p = p.line_to(x(i), y(n));
        }
        p.stroke_color(rgb(0x3b82f6)).line_width(2.5).line_join(LineJoin::Round).stroke()
    })
})
.h(px(height))
.on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
```

```tsx tabs
const values = signal([12, 30, 22, 48, 36, 60]);

<Canvas
  style={{ height: 160 }}
  draw={(cx, { width, height }) => {
    const v = values();
    const x = (i: number) => (i / (v.length - 1)) * width;
    const y = (n: number) => height - (n / 100) * height;
    cx.beginPath();
    v.forEach((n, i) => (i === 0 ? cx.moveTo(x(i), y(n)) : cx.lineTo(x(i), y(n))));
    cx.strokeStyle = "#3b82f6";
    cx.lineWidth = 2.5;
    cx.lineJoin = "round";
    cx.stroke();
  }}
/>
```

Drawing calls only record: the drawing is made by the platform after the recording is done, so pixels are not read back. The recording is sent to the platform as one operation.

## The 2D operations

The operations are a subset of the HTML Canvas 2D API: `CanvasRenderingContext2D` in TSX, and the methods of `Painter` in Rust, under Rust names (`begin_path`, `fill_rect`, `line_width`, `set_transform`, `draw_image`, ...; colors through `fill_color` / `stroke_color`, gradients through `fill_style` / `stroke_style`). What is supported:

**State**

| Member | Rust | Description |
|---|---|---|
| `save()`, `restore()` | `.save()`, `.restore()` | Push and pop the drawing state (styles, transform, clip). |
| `fillStyle`, `strokeStyle` | `.fill_color(..)`, `.fill_style(..)`, `.stroke_color(..)`, `.stroke_style(..)` | A CSS color, a gradient, or an animated value interpolating colors. |
| `lineWidth`, `lineCap`, `lineJoin`, `miterLimit` | `.line_width(..)`, `.line_cap(..)`, `.line_join(..)`, `.miter_limit(..)` | Stroke shape. |
| `setLineDash(segments)`, `getLineDash()`, `lineDashOffset` | `.line_dash(..)`, `.line_dash_offset(..)` | Dashes. |
| `globalAlpha` | `.global_alpha(..)` | Opacity of what is drawn next, 0..1. |
| `globalCompositeOperation` | `.composite(Composite::DestinationOut)` | How it combines: `"source-over"`, `"destination-out"`, `"multiply"`, `"screen"`, ... |
| `shadowColor`, `shadowBlur`, `shadowOffsetX`, `shadowOffsetY` | `.shadow(color, blur, offset)` | Shadows. |
| `font` | `.font(..)` | CSS `font` shorthand: `"600 14px Inter"` (sizes in px, pt or rem); `small-caps` and the number forms `tabular-nums`, `oldstyle-nums`, ... may come before the size. |
| `fontVariantNumeric` | `.font_variant_numeric(..)` | `"tabular-nums"` makes every figure the same width, so changing numbers (counters, prices, axis labels) do not jitter; also `"proportional-nums"`, `"oldstyle-nums"`, `"lining-nums"`, `"normal"`. An NSH addition (CSS's `font-variant-numeric`); setting `font` keeps it. Browsers ignore it. |
| `textAlign`, `textBaseline` | `.text_align(..)`, `.text_baseline(..)` | Text placement. |

**Transforms**: `translate(x, y)`, `scale(x, y)`, `rotate(angle)` (radians, clockwise), `transform(a, b, c, d, e, f)`, `setTransform(a, b, c, d, e, f)`, `resetTransform()`.

**Paths**: `beginPath()`, `moveTo`, `lineTo`, `quadraticCurveTo`, `bezierCurveTo`, `arc`, `arcTo`, `ellipse`, `rect`, `roundRect(x, y, w, h, radii)`, `closePath()`; then `fill(rule?)`, `stroke()` and `clip(rule?)`, each also taking a path (`fill_path`, `stroke_path`, `clip_path` in Rust). Fill rules are `"nonzero"` and `"evenodd"`.

**Rectangles**: `fillRect`, `strokeRect`, `clearRect`.

**Text**: `fillText(text, x, y, maxWidth?)`, `strokeText(...)`, `measureText(text)` (measured synchronously by the platform's text engine with the current `font`; only `width`). In Rust, `measure_text(font, text)` gives the width.

**Hit testing**: `isPointInPath(path?, x, y, rule?)` and `isPointInStroke(path?, x, y)` (`path_contains`, `stroke_contains`, `is_point_in_path` and `is_point_in_stroke` on a `Painter`) answer synchronously, computed from the recorded geometry (the current transform, path, `lineWidth` and `lineCap`). Keep the drawing and the paths you drew to find the shape under a tap:

```rust tabs
let slices: Rc<Vec<Path>> = Rc::new(vec![svg_path("M50 50 L100 50 A50 50 0 0 1 50 100 Z") /* , ... */]);
let draw = {
    let slices = slices.clone();
    move || slices.iter().fold(Painter::new(), |p, s| p.fill_path(s, FillRule::NonZero))
};

canvas(draw.clone())
    .size(px(100.0))
    .claim_touches(TouchClaim::on_start())
    .on_responder_release(move |e: &ResponderEvent| {
        let drawing = draw();
        if let Some(hit) = slices.iter().position(|s| drawing.path_contains(s, e.location, FillRule::NonZero)) {
            selected.set(Some(hit));
        }
    })
```

```tsx tabs
let cx: CanvasRenderingContext2D | undefined;
const slices = [new Path2D("M50 50 L100 50 A50 50 0 0 1 50 100 Z"), /* ... */];

<Canvas
  style={{ width: 100, height: 100 }}
  onStartShouldSetResponder={() => true}
  onResponderRelease={(e) => {
    const hit = slices.findIndex((p) => cx?.isPointInPath(p, e.locationX, e.locationY));
    if (hit >= 0) select(hit);
  }}
  draw={(c) => {
    cx = c;
    slices.forEach((p) => c.fill(p));
  }}
/>
```

Strokes are tested with round joins and without dashes; coordinates given as animated values count as 0.

**Gradients**: `createLinearGradient`, `createRadialGradient`, `createConicGradient`, each with `addColorStop(offset, color)` (`CanvasGradient::linear`, `radial`, `conic` and `add_color_stop` in Rust).

**Images**: `drawImage(image, dx, dy)`, `drawImage(image, dx, dy, dw, dh)`, `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)` (`draw_image(url, dest)` and `draw_image_part(..)` in Rust).

`cx.canvas.width` and `cx.canvas.height` give the canvas's size in points in TSX.

**The supported set**: drawing operations. Pixels are written by the platform, so `getImageData` / `putImageData` and other pixel access are outside it, as are `filter` and SVG images in `drawImage`. An invalid color or font drops that one operation, as in HTML Canvas.

## Paths and SVG path data

A path built once can be filled, stroked or clipped many times: `svg_path(d)` in Rust, `Path2D` in TSX. Both take SVG path data, parsed natively, which makes icons easy:

```rust tabs
use nsh_core::canvas::{FillRule, svg_path};

const HEART: &str = "M12 21s-7-4.35-9.5-8.5C.5 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6.5 4.5 4.5 8.5C19 16.65 12 21 12 21z";

fn heart(size: f32, color: Rgba) -> impl IntoElement {
    let path = svg_path(HEART);
    canvas(
        Painter::new()
            .scale(size / 24.0, size / 24.0) // the path is drawn on a 24-point grid
            .fill_color(color)
            .fill_path(&path, FillRule::NonZero),
    )
    .size(px(size))
}
```

```tsx tabs
import { Canvas, Path2D } from "nsh";

const heart = new Path2D("M12 21s-7-4.35-9.5-8.5C.5 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6.5 4.5 4.5 8.5C19 16.65 12 21 12 21z");

function Heart(props: { size: number; color: string }) {
  return (
    <Canvas
      style={{ width: props.size, height: props.size }}
      draw={(cx) => {
        cx.scale(props.size / 24, props.size / 24); // the path is drawn on a 24-point grid
        cx.fillStyle = props.color;
        cx.fill(heart);
      }}
    />
  );
}
```

A `Path2D` has the same path methods as the context (`moveTo`, `arc`, `roundRect`, ...) and `addPath(other)`. `new Path2D(other)` copies a path.

## Gradients

```rust tabs
canvas(move || {
    let (w, h) = (width.get(), 120.0);
    let linear = CanvasGradient::linear(point(px(0.0), px(0.0)), point(px(w), px(0.0)))
        .add_color_stop(percentage(0.0), rgb(0x22d3ee))
        .add_color_stop(percentage(1.0), rgb(0x6366f1));
    let center = point(px(w / 2.0), px(h * 0.75));
    let radial = CanvasGradient::radial(center, px(4.0), center, px(40.0))
        .add_color_stop(percentage(0.0), rgb(0xfde68a))
        .add_color_stop(percentage(1.0), rgb(0xf97316));
    Painter::new()
        .fill_style(linear)
        .fill_rect(0.0, 0.0, w, h / 2.0)
        .fill_style(radial)
        .begin_path()
        .arc(w / 2.0, h * 0.75, 28.0, 0.0, TAU)
        .fill()
})
.h(px(120.0))
.on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
```

```tsx tabs
<Canvas
  style={{ height: 120 }}
  draw={(cx, { width, height }) => {
    const linear = cx.createLinearGradient(0, 0, width, 0);
    linear.addColorStop(0, "#22d3ee");
    linear.addColorStop(1, "#6366f1");
    cx.fillStyle = linear;
    cx.fillRect(0, 0, width, height / 2);

    const radial = cx.createRadialGradient(width / 2, height * 0.75, 4, width / 2, height * 0.75, 40);
    radial.addColorStop(0, "#fde68a");
    radial.addColorStop(1, "#f97316");
    cx.fillStyle = radial;
    cx.beginPath();
    cx.arc(width / 2, height * 0.75, 28, 0, Math.PI * 2);
    cx.fill();
  }}
/>
```

A conic gradient (`createConicGradient(startAngle, x, y)`, `CanvasGradient::conic(start_angle, center)`) sweeps colors around a point; its start angle is in radians, clockwise from the x axis. A conic gradient on a stroked arc makes a gradient progress ring.

## Text

```rust tabs
Painter::new()
    .font("600 20px system-ui")
    .fill_color(rgb(0x1f2328))
    .text_align(CanvasTextAlign::Center)
    .text_baseline(CanvasTextBaseline::Middle)
    .fill_text("72%", width / 2.0, height / 2.0)
    .font("11px system-ui")
    .fill_text("100", 32.0 - 6.0 - measure_text("11px system-ui", "100").0, 16.0)
```

```tsx tabs
cx.font = "600 20px system-ui";
cx.fillStyle = "#1f2328";
cx.textAlign = "center";
cx.textBaseline = "middle";
cx.fillText("72%", width / 2, height / 2);

cx.font = "11px system-ui";
const label = "100";
cx.fillText(label, 32 - 6 - cx.measureText(label).width, 16);
```

Font families are the same as in styles: system families and the names of fonts your app ships (see [Fonts](./fonts.md)).

## Images

Drawing an image takes a URL in Rust (an asset's is `LOGO.url`), and a URL or an imported asset (`import logo from "./logo.png"`) in TSX. The image is loaded natively, and the canvas draws again once it has loaded, so you do not need to track loading yourself. Remote URLs are subject to the app's [network capabilities](./sandbox-and-capabilities.md).

Canvases on iOS, macOS, Android, Windows, Linux and GPUI draw bitmap images (PNG, JPEG, GIF, WebP, ...); on them, an SVG source is an image that fails to load, and the log names it. Show SVG images with [`<Image>`](./images-and-assets.md#svg-images), or draw their shapes as `Path2D` paths. On the web, a canvas draws what the browser draws, SVG included.

```rust tabs
const LOGO: ImageAsset = asset!("logo.png");

canvas(
    Painter::new()
        .save()
        .begin_path()
        .arc(60.0, 60.0, 56.0, 0.0, TAU)
        .clip() // a round avatar
        .draw_image(LOGO.url, bounds(point(px(4.0), px(4.0)), size(px(112.0), px(112.0))))
        .restore(),
)
.size(px(120.0))
```

```tsx tabs
import { Canvas } from "nsh";
import logo from "./logo.png";

<Canvas
  style={{ width: 120, height: 120 }}
  draw={(cx) => {
    cx.save();
    cx.beginPath();
    cx.arc(60, 60, 56, 0, Math.PI * 2);
    cx.clip(); // a round avatar
    cx.drawImage(logo, 4, 4, 112, 112);
    cx.restore();
  }}
/>
```

The nine-argument form (`draw_image_part`) takes the source rectangle in the image's pixels.

## Driving drawings with animated values

Any number argument of a drawing call, and the fill and stroke paints, can be an [animated value](./animation.md#animated-values) or a node derived from it. Such arguments are read while the platform draws, and when the value animates, the platform redraws on its own, every frame, without recording the drawing again or running any of your code.

```rust tabs
use std::f32::consts::{FRAC_PI_2, TAU};

use nsh_core::{
    canvas::{CanvasTextAlign, CanvasTextBaseline, LineCap},
    prelude::*,
};

pub fn ring() -> impl IntoElement {
    let progress = animated_value(0.3);
    let label = signal(30_u32);
    let go = move |to: f32| {
        label.set((to * 100.0).round() as u32);
        progress.timing(to, 900.0, Easing::Curve(Curve::Cubic, EaseMode::InOut));
    };
    let (center_x, cy, r) = (70.0, 70.0, 60.0);
    view()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_4()
        .child(
            canvas(move || {
                // The end angle reads the animated value on every frame.
                let end = progress.mul(TAU).sub(FRAC_PI_2);
                Painter::new()
                    .line_width(12.0)
                    .line_cap(LineCap::Round)
                    .stroke_color(rgb(0xe5e7eb))
                    .begin_path()
                    .arc(center_x, cy, r, 0.0, TAU)
                    .stroke()
                    .stroke_color(rgb(0x6366f1))
                    .begin_path()
                    .arc(center_x, cy, r, -FRAC_PI_2, &end)
                    .stroke()
                    .fill_color(rgb(0x1f2328))
                    .font("600 22px system-ui")
                    .text_align(CanvasTextAlign::Center)
                    .text_baseline(CanvasTextBaseline::Middle)
                    .fill_text(&format!("{}%", label.get()), center_x, cy)
            })
            .size(px(140.0)),
        )
        .child(
            text("Animate")
                .text_color(rgb(0x0969da))
                .on_press(move || go(if label.get_untracked() < 50 { 0.85 } else { 0.2 })),
        )
}
```

```tsx tabs
import { Canvas, mount, signal, Text, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh";

function Ring() {
  const progress = createAnimatedValue(0.3);
  const label = signal(30);
  const go = (to: number) => {
    label.set(Math.round(to * 100));
    progress.timing(to, { duration: 900, easing: Easing.inOut(Easing.cubic) });
  };
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16 }}>
      <Canvas
        style={{ width: 140, height: 140 }}
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
          // The end angle reads the animated value on every frame.
          cx.arc(centerX, cy, r, -Math.PI / 2, progress.mul(Math.PI * 2).sub(Math.PI / 2));
          cx.stroke();
          cx.fillStyle = "#1f2328";
          cx.font = "600 22px system-ui";
          cx.textAlign = "center";
          cx.textBaseline = "middle";
          cx.fillText(`${label()}%`, centerX, cy);
        }}
      />
      <View onPress={() => go(Math.random())}>
        <Text style={{ color: "#0969da" }}>Animate</Text>
      </View>
    </View>
  );
}

mount(Ring);
```

The arc's end angle is `progress.mul(2π).sub(π/2)`: a node, so the ring sweeps natively for 900 ms while the drawing was recorded once (and once more for the label, which reads a signal). A clock's second hand works the same way: `rotate(seconds.mul(π / 30))` with `seconds` animated linearly.

Colors animate the same way: `.fill_style(&t.interpolate_colors(&[0.0, 1.0], &[rgb(0x54aeff), rgb(0xcf222e)]))` in Rust, `cx.fillStyle = t.interpolate({ inputRange: [0, 1], outputRange: ["#54aeff", "#cf222e"] })` in TSX.

## Touch on a canvas

A canvas is a view, so it takes presses and the [responder system](./touch-and-gestures.md#the-responder-system). Finger drawing records points in a signal and draws them:

```rust tabs
let strokes = signal(Vec::<Vec<(f32, f32)>>::new());

canvas(move || {
    strokes.with(|strokes| {
        let mut p = Painter::new().line_width(3.0).line_cap(LineCap::Round).line_join(LineJoin::Round);
        for stroke in strokes {
            p = p.begin_path();
            for (i, &(x, y)) in stroke.iter().enumerate() {
                p = if i == 0 { p.move_to(x, y) } else { p.line_to(x, y) };
            }
            p = p.stroke();
        }
        p
    })
})
.h(px(240.0))
.claim_touches(TouchClaim::on_start())
.keep_touches(true) // a scroll view around must not take the touches
.on_responder_grant(move |e: &ResponderEvent| {
    strokes.update(|s| s.push(vec![(e.location.x.0, e.location.y.0)]))
})
.on_responder_move(move |e: &ResponderEvent| {
    strokes.update(|s| {
        if let Some(stroke) = s.last_mut() {
            stroke.push((e.location.x.0, e.location.y.0));
        }
    })
})
```

```tsx tabs
const strokes = signal<[number, number][][]>([]);

<Canvas
  style={{ height: 240 }}
  onStartShouldSetResponder={() => true}
  onResponderGrant={(e) => {
    strokes.set([...strokes(), [[e.locationX, e.locationY]]]);
    return true; // a scroll view around must not take the touches
  }}
  onResponderMove={(e) => {
    const all = strokes();
    strokes.set([...all.slice(0, -1), [...all[all.length - 1], [e.locationX, e.locationY]]]);
  }}
  draw={(cx) => {
    cx.lineWidth = 3;
    cx.lineCap = "round";
    cx.lineJoin = "round";
    for (const s of strokes()) {
      cx.beginPath();
      s.forEach(([x, y], i) => (i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y)));
      cx.stroke();
    }
  }}
/>
```

## Performance

- A drawing is recorded in Rust (in TSX, as JS calls the context) and travels to the platform as one operation; there is no per-call bridge crossing.
- Each drawing re-records everything. Keep the work proportional to what is shown, and keep data that changes every frame in animated values rather than signals.
- Split a drawing that has a static part and a frequently changing part into two canvases stacked on top of each other, so only one redraws.
- Inside a zooming scroll view, canvases are drawn again at the zoomed resolution when the zoom ends.

## Related

- [`Canvas` element](../elements/canvas.md): the reference.
- [Animation](./animation.md): animated values, `interpolate` and `Easing`.
- [Images and assets](./images-and-assets.md): the app's images.

# Canvas

- **Canvas** (`Canvas` from `nsh`, the `canvas` host element): an HTML Canvas 2D subset, recorded and replayed natively
  (`nsh_core::canvas`: `Drawing { ops, slots }`). `draw={(cx, { width, height }) => ...}` runs again when the signals it reads
  change (sizes come from `onLayout`). `CanvasRenderingContext2D`: state (`save` / `restore`, `globalAlpha`,
  `globalCompositeOperation`, line styles and dashes, shadows, `font` (CSS shorthand; besides `small-caps` it takes the
  number forms `tabular-nums` / `proportional-nums` / `oldstyle-nums` / `lining-nums`), `fontVariantNumeric` (CSS's
  `font-variant-numeric`, which HTML Canvas lacks: figures of equal width for changing values; kept apart from `font`,
  which does not reset it; CoreText feature settings on iOS, `Paint.setFontFeatureSettings` on Android, ignored by
  browsers), `textAlign` / `textBaseline`),
  transforms, paths (`arc`, `arcTo`, `ellipse`, curves, `rect`, `roundRect`), `fill` / `stroke` / `clip` (also of a `Path2D`,
  which takes SVG path data; arcs become cubics), `fillRect` / `strokeRect` / `clearRect`, `fillText` / `strokeText` /
  `measureText` (synchronous, through the engine's text engine; only `width`), `isPointInPath` / `isPointInStroke`
  (synchronous too, answered in Rust without the platform: `nsh_core::canvas::point_in_path` replays what was recorded
  for its transform, current path and line style and tests the flattened path; after `draw` returned a kept context
  answers from everything it drew, so press handlers can hit-test the shapes; strokes take joins as round and ignore
  dashes; animated values count as 0, since JS does not see their current values), linear / radial / conic
  gradients, `drawImage` (all three forms, images by URI or asset: native canvases draw bitmaps, loaded through their
  platform's image module, whose canvas loads fail an SVG with a warning naming it, as bytes no decoder reads fail;
  the web's draws what the browser draws). Any number argument and colors may be animated values
  (`createAnimatedValue`, `interpolate`, ...): those become slots bound like style values (`AnimationProp::CanvasArg`) and the
  platform redraws on its own while they animate, without JS (only what they change on iOS and macOS: "Partial
  redraws" below). Deriving a node again (`interpolate`, `mul`, ... in a `draw`
  that runs again) gets the live node made by the same operation (`nsh-js` `animated.rs` `derived`, keyed by the
  decoded `AnimationOp`, as `nsh_core::ui` does for Rust components): a redraw sends no new graph nodes and keeps its slots. A drawing travels in its own op (`Op::Draw`), recorded into
  a Rust list of its own (`nsh-js` `canvas.rs`): creating animated values while drawing pushes ops of its own. Each
  operation is one variant of `CanvasOp` / `PathOp` with `#[derive(JsOps)]` (`nsh_core::js::ops`): `#[op(code = CV_…)]` reads its fields in order
  (`OpArg`: numbers or animated values, paints, `Path2D` lists, string unions; an invalid color or font drops the
  operation, as in HTML Canvas), and `method = …, params = …` / `property = …, initial = …` describe the methods and
  properties that only record (`moveTo`, `fillRect`, `lineWidth`, ...): `nsh-js` makes them natively from these specs
  (`CanvasOp::methods` / `properties`) and their declarations are generated (`canvas::declarations`); what has logic
  (overloads, `roundRect`'s radii, `save` / `restore`, gradients, images) is written in `canvas.rs`. The core's decoder
  (`nsh_core::js::canvas::decode`) reads the recorded list. Recording costs: `docs/dev/performance.md`. iOS replays
  into the `drawRect:` context, keeping its own transform and path in view space; Android `CanvasBox.java` interprets an `int[]` (`encode.rs`). Not
  supported: `getImageData` / `putImageData`, filters.

**Partial redraws.** While animated values animate, iOS (`setNeedsDisplayInRect:`) and macOS (`NshView::redraw_rect`:
`setNeedsDisplayInRect:` on the content layer) redraw only what changes: `nsh_core::canvas::DamageScan` replays the
operations for their geometry (transform with `save` / `restore`, bounds of the current path and of `Path2D`s, line
width / joins / caps, shadows) and adds up the bounds of the painting operations that read a slot whose value changed,
through their own numbers or the state they paint with (transform, current path, `globalAlpha`, paint, line width,
dash offset). The platform scans with the old values and the new ones and invalidates the union, inflated for
anti-aliasing (2 pt) and rounded out to whole points; the platform then replays the whole drawing clipped to it
(`drawRect:` on iOS, the content layer's `drawLayer:inContext:` on macOS; Core Graphics skips what falls outside), so
the pixels are those of a full redraw (on macOS also with `drawsAsynchronously`: checked against a full redraw by
screen capture). Bounds are conservative: curves by their control points, arcs by their circle, strokes by half the
width under the transform's largest scale times the miter limit (miter joins) or √2 (square caps), shadows by twice
their blur past their offset, text by 1.5 em per character and 1.5 em above and below the baseline (no text engine at
hand). The scan falls back to a full redraw (`Damage::All`) for a clip that reads a changed value, a painting
operation that reads one under a composite operation other than `source-over` (`copy`, `source-in`, ... change pixels
outside the shape), an image at its natural size and bounds that are not finite. A scan allocates nothing (its save
stack is kept); two per changed frame cost microseconds next to the replay. Linux rasterizes each canvas into an
image surface at the surface's scale, shown as textures of 256 pixel tiles (`canvas.rs` `Raster`): an animation
clears the damaged area and replays the drawing clipped to it, and only the tiles it touches become new textures
(GSK keeps the others on the GPU). There, what the operations before the first one reading a slot painted
(`canvas::first_animated`) is kept from the last full replay and copied back into the area, so only the painting from
that operation on runs again (the operations before it still set the state; their path ops are skipped too when the
animated part begins a path of its own). macOS keeps that part too, as a `CGLayer` (`canvas.rs` `Prefix`), when it
is long (128 operations or more: drawing a layer costs about what replaying a sparkline does) and the drawing has been
painted unchanged 30 times (a drawing that keeps changing would rasterize it on the main thread more often than it
draws from it); such a canvas draws at once, where its layer is made. Other canvases draw at once too unless they
paint 10 times a second or more (`canvas.rs` `Cadence`), when Core Animation replays them on its threads
(`docs/dev/macos.md`). On Linux, a canvas out of sight (outside a clipping ancestor or the window) is not
drawn until it comes into sight: its animations ask for no frames. Android, the web runtime and the GPUI backend (which rasterizes the drawing, text outlines
included, with tiny-skia into a pixmap in device pixels: `nsh-platform-gpui` `canvas.rs`) still redraw the
whole canvas. Numbers:
`docs/dev/performance.md`.

Rust components record drawings with `ui::Painter` (the same operations; `docs/dev/components.md`), paint with the
canvas view's paint properties (`Painter::fill_style_from_view` and the like: `Drawing::view_paints` names the
operations whose value is the view's `fill` / `stroke` / `strokeWidth` / `strokeDasharray`, which the core resolves,
inherited from the views around as CSS inherits them and `currentColor` the view's text color, and sets into the
drawing it mounts, `Drawing::painted`; a change of those properties, the canvas's or a view's around it, sends the
drawing again, so no platform knows of it), measure text
with `measure_text(font, text)` and `text_metrics(font, text)` (its width and the font's ascent, descent and line
height, from the first line the core's text engine lays it out in: `canvas::line_metrics`), and hit-test what a painter recorded with the same
`point_in_path` / `point_in_stroke` (`Painter::is_point_in_path` / `is_point_in_stroke` for the current path,
`path_contains` / `stroke_contains` for a `Path`; animated values count as 0 there too).

The drawing format is documented in `crates/nsh-core/src/canvas.rs`.

**Nodes** (Rust components). A drawing can name parts of what it draws as elements of their own
(`Painter::node(CanvasNode::new(bounds, role, label))`, with `test_id` and `selected`): a grid's cells, a chart's bars.
They are the canvas's children to assistive technologies and UI tests, at their bounds in the canvas, with their role,
name, test id and selected state (`Drawing::nodes`, sent with the drawing). A press on one is a press at its center, as
a pointer there makes it: it goes to the view under that point that takes presses, so a canvas drawn over the view that
handles presses (`pointerEvents: "none"`) keeps working. The GPUI backend makes them AccessKit nodes (`access.rs`
`canvas_nodes`, no actions of their own) and the headless driver views of its model (`label:`, `text:`, `id:` and
`role:` find them, `press` presses under them, `Screen::selected` reads their selected state as it reads a view's);
the other backends do not show them yet.

The test model skips hidden subtrees when finding the view under a node and follows visible overflow until a
clipping view stops it. Headless touches carry the node's center in root and target-local coordinates. A real
host's agent keeps the center relative to the canvas (`Scene::canvas_node`, `SceneQuery::CanvasNode`), brings
that point into view, and presses it at the canvas's native position.

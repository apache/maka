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
  `measureText` (synchronous, through the engine's text engine; only `width`, trailing white space included as in a
  browser: text engines lay a line out without it, so a text ending in white space is measured with a mark after it,
  less the mark), `isPointInPath` / `isPointInStroke`
  (synchronous too, answered in Rust without the platform: `nsh_core::canvas::point_in_path` replays what was recorded
  for its transform, current path and line style and tests the flattened path; after `draw` returned a kept context
  answers from everything it drew, so press handlers can hit-test the shapes; strokes take joins as round and ignore
  dashes; animated values count as 0, since JS does not see their current values), linear / radial / conic
  gradients, `drawImage` (all three forms, images by URI or asset: native canvases load them through their
  platform's image module, which rasterizes an SVG with `nsh_core::svg` and hands its bitmap to the canvas, as bytes no
  decoder reads fail; draw an SVG into an explicit destination rectangle, its raster is sized in the loader's own
  pixels; the web's draws what the browser draws). Any number argument and colors may be animated values
  (`createAnimatedValue`, `interpolate`, ...): those become slots bound like style values (`AnimationProp::CanvasArg`) and the
  platform redraws on its own while they animate, without JS (only what they change on iOS and macOS: "Partial
  redraws" below). Deriving a node again (`interpolate`, `mul`, ... in a `draw`
  that runs again) gets the live node made by the same operation (`nsh-js` `animated.rs` `derived`, keyed by the
  decoded `AnimationOp`, as `nsh_core::element` does for Rust components): a redraw sends no new graph nodes and keeps its slots. A drawing travels in its own op (`Op::Draw`), recorded into
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

**Partial redraws.** While animated values animate, iOS, macOS and Windows redraw only the area the changed values
affect: `nsh_core::canvas::DamageScan` finds it from the recorded operations, falling back to a full redraw
(`Damage::All`) when it cannot bound the change, and the platform replays the whole drawing clipped to it, so the
pixels are those of a full redraw. iOS and macOS call `NshView::redraw_rect`; Windows adds the area to the view's
damage and redraws it over the kept back buffer (`docs/dev/windows.md` "Partial frames"). Linux rasterizes each
canvas into tiled textures (`canvas.rs` `Raster`) and
replays only the damaged area; Linux and macOS (`canvas.rs` `Prefix`) also keep what is painted before the first
animated operation, for long drawings; canvases macOS repaints often are replayed by Core Animation on its threads (`canvas.rs` `Cadence`)
(`docs/dev/macos.md`). macOS can split a small source-over animated suffix of a shorter drawing into its own
content layer, retaining the preceding picture between drawing changes. `DamageScan::painted_after` bounds all
suffix paints in the preceding state; unsupported or large suffixes keep the whole-canvas path.
On Linux, a canvas out of sight (outside a clipping ancestor or the window) is not
drawn until it comes into sight: its animations ask for no frames. Android, the web runtime and the GPUI backend (which rasterizes the drawing, text outlines
included, with tiny-skia into a pixmap in device pixels: `nsh-platform-gpui` `canvas.rs`) still redraw the
whole canvas. Numbers:
`docs/dev/performance.md`.

Windows also omits a `source-over` paint whose current values cannot change a pixel before it builds the geometry,
lays the text out or looks the bitmap up: zero `globalAlpha` (the shadow's alpha is multiplied by it, so it hides
even a configured shadow), a transparent solid or animated color, an empty or degenerate gradient, and an image at
zero alpha. A configured shadow keeps a transparent foreground on the regular path; `clearRect`, clipping,
save/restore and other composite operations are untouched. The decision is read while recording, so a recorded list
paints again once its values become visible.

Windows also classifies a drawing's animated-slot dependencies once (`canvas.rs` `DamageIndex`): each painting
operation records the slots that can change its pixels (its own operands, the current path and transform sticky from
where they were built, and the alpha, paint, line width and dash state it paints with). A changed slot that no
operation reads returns `Damage::None` without a scan, and a slot that cannot move, resize or re-ink geometry (an
animated alpha, color or dash offset) reuses the per-slot area `DamageScan` computed, which cannot differ before and
after the write. Everything the core cannot bound keeps the original full scans: slot-driven transforms, paths, line
widths, dimensions, text positions or image destinations, a slot-dependent clip, `clearRect`, and any composite
operation other than `source-over`. The index is made only once a drawing outlives a frame, so a scene recorded
every frame (a dragged card) keeps the full scans rather than paying for an index it cannot reuse.

Rust components record drawings with `element::Painter` (the same operations; `docs/dev/components.md`), paint with the
canvas view's paint properties (`Painter::fill_style_from_view` and the like: `Drawing::view_paints` names the
operations whose value is the view's `fill` / `stroke` / `strokeWidth` / `strokeDasharray`, which the core resolves,
inherited from the views around as CSS inherits them and `currentColor` the view's text color, and sets into the
drawing it mounts, `Drawing::painted`; a change of those properties, the canvas's or a view's around it, sends the
drawing again, so no platform knows of it), fill a shape with the canvas view's background
(`Painter::fill_background_from_view(area)`: its `backgroundColor` and `backgroundImage` gradients, the app's `bg-*` /
`bg-linear-*` classes, positioned over `area` as over a box of that size and shown only where the path fills, as
CSS's `clip-path` shows a box's background; the core expands it into fills with `CanvasGradient::from_css` and mounts
the view without its background, so the background is drawn once, inside the shape), measure text
with `measure_text(font, text)` and `text_metrics(font, text)` (its width and the font's ascent, descent and line
height, from the first line the core's text engine lays it out in: `canvas::line_metrics`), and hit-test what a painter recorded with the same
`point_in_path` / `point_in_stroke` (`Painter::is_point_in_path` / `is_point_in_stroke` for the current path,
`path_contains` / `stroke_contains` for a `Path`; animated values count as 0 there too).

The drawing format is documented in `crates/nsh-core/src/canvas.rs`.

**SVGs** (Rust components: `element::svg(src)`, `Svg`, in the prelude; `src` an `ImageSrc`, as `image`'s:
`asset!("icon.svg")`, a URL, a file, or `ImageSrc::svg_markup(text)`). An SVG document drawn as authored, in
its own colors, as an `<svg>` written inline in a web page: a canvas whose drawing `nsh_core::svg::drawing`
(feature `svg`) records from usvg's tree (paths, solid colors, linear and radial gradients, opacity, groups and their
transforms, stroke properties, clip paths, blend modes as composite operations), so every platform replays vectors
at its device pixels and an icon is sharp at any size and scale (an image of an SVG is a raster: Linux draws one at
its view's size bucket, Windows and GPUI one at `svg::OVERSAMPLE` per point and scale it). Its bytes come through the
shared image loader (`images.md` "Loading and memory": dedup, L3, the disk cache for remote ones; the engine gives the
core its assets, access policy and disk cache with `Core::set_image_context`), and the document is parsed once per
source key on a decode thread (`svg/drawings.rs`) and kept in the image budget, costed by its operations, leased while
an element shows it and shared by every size. Inline markup, and a drawing in memory, show in the first frame; another
source draws nothing until it loads (an `svg()` of a static source re-renders nothing: its drawing is a signal the
canvas reads). `currentColor` is the canvas view's text color (`color`, inherited), so
`stroke="currentColor"` icons follow the theme and `text-*` classes: usvg resolves `currentColor` while it parses, so
the root gets a `color` of a color the document does not write (where it sets none itself) and the paints of that
color become `ViewPaint::FillCurrentColor` / `StrokeCurrentColor`, which the core resolves as it resolves the other
view paints (and sends again when the text color changes). The drawing is in the `viewBox`'s coordinates (usvg's
mapping onto the SVG's size undone) after one `ViewPaint::Fit` (`canvas::ViewBoxFit`): the core maps the view box
onto the canvas's box by `preserveAspectRatio` (`xMidYMid meet` by default; an SVG without a `viewBox` scales as an
image of its size) and sends such a drawing after the round's layout, and again when the layout gives the canvas
another size (`Core::send_fitted`). The canvas lays out as an image: at the SVG's `width` × `height` (else its
`viewBox`'s size) where its style sets no size, keeping that ratio where it sets one side (`LeafContext::Image`).
What a canvas has no operation for is drawn as near as it can be: a group's opacity multiplies its shapes' (exact
where they do not overlap), a clip path of several shapes clips to them as one path, gradients pad
(`spreadMethod` aside) and a gradient stop of `currentColor` is black; masks and filters are left out (what they
apply to is drawn as it is) and a pattern paints nothing (each logged); `<text>` and `<image>` are not drawn. The
web runtime, without the feature, shows it as an `image()` of a `data:` URI, contained in its box, where the browser
draws it and `currentColor` is black.

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

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
  `measureText` (synchronous, through the engine's text engine: `width`, trailing white space included as in a
  browser: text engines lay a line out without it, so a text ending in white space is measured with a mark after it,
  less the mark; the line's `fontBoundingBoxAscent` / `fontBoundingBoxDescent` come from `canvas::line_extent` the
  first time a script reads one: `canvas/metrics.rs`), `isPointInPath` / `isPointInStroke`
  (synchronous too, answered in Rust without the platform: `nsh_core::canvas::point_in_path` replays what was recorded
  for its transform, current path and line style and tests the flattened path; after `draw` returned a kept context
  answers from everything it drew, so press handlers can hit-test the shapes; strokes take joins as round and ignore
  dashes; animated values count as 0, since JS does not see their current values), linear / radial / conic
  gradients, `drawImage` (all three forms, images by URI or asset: native canvases load them through their
  platform's image module, which rasterizes an SVG with `nsh_core::svg` and hands its bitmap to the canvas, as bytes no
  decoder reads fail; draw an SVG into an explicit destination rectangle, its raster is sized in the loader's own
  pixels; the web's draws what the browser draws; a missing destination size is the source's pixels over
  `CanvasImage::density`, the file name's `@Nx` as an `Image`'s, never the screen's scale, on every platform). Any number argument and colors may be animated values
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
  into the `drawRect:` context, keeping its own transform and path in view space; Android `CanvasPainter.java` interprets an `int[]` (`encode.rs`) for `CanvasBox.java` and offscreen renders. Not
  supported: `getImageData` / `putImageData`, filters.

**Offscreen canvases** (`OffscreenCanvas` of `nsh`, `nsh-js` `canvas/offscreen.rs`; Rust:
`Painter::render` with `canvas::render::RenderOptions`). An object of a size of its own whose `getContext("2d")` is
a context recording as `<Canvas draw>`'s does (`new_recording`, never closed); `convertToBlob` decodes what it
recorded into a `Drawing` (the same `max_canvas_ops` limit) and pushes `Op::RenderCanvas` with a JS call number.
A `clearRect` covering the whole canvas under the identity transform, with no clip and no `save` open, starts the
recording anew (`offscreen.rs` `Reuse`; the browser runtime's `canvas.js` `track`, op 605 asking which property
values took effect): it keeps only the state HTML keeps across the clear, each property's last value that took effect
and the current path, so a canvas reused for many images neither replays earlier ones nor reaches the limit. The
transform counts as the identity until a call changes it (`translate(0, 0)` and the like do not) and again after
`setTransform` / `resetTransform` to it; nothing is dropped when the kept state reads an animated value or the path
was added under another transform. `width` and `height` are read-only, so there is no size reset.
The core (`core/canvas_render.rs`, `canvas::render`) checks the size against `MAX_SIDE` / `MAX_PIXELS`, takes the
screen's pixel ratio when no `scale` is given, and sends `Command::RenderCanvas` on the root to platforms whose
`Environment::canvas_render` is set (elsewhere it answers `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` at once); the
platform's `EventKind::CanvasImage` (`EventPayload::CanvasImage`) settles the promise with a `Blob`
(`JsHost::new_blob`). Request ids are unique in the process (an `AtomicU32`), not per core: after a hot reload the
platform may still answer the replaced core's render, which must not settle the new core's request of that number.
Each request has a deadline (`render::TIMEOUT`, 30 s) that rejects it with `ETIMEDOUT` and frees its slot of
`MAX_PENDING`; an answer after it is dropped. macOS (`nsh-platform-macos` `canvas/offscreen.rs`) loads the images the drawing names
through the shared loader, then replays it with `CanvasState::paint` into an sRGB `CGBitmapContext` of its own
(`nsh-platform-apple` `canvas_image.rs`, shared with iOS, as the ImageIO encoding is) on a
global queue, y down at `scale`, animated slots at 0, and encodes it with ImageIO. Every platform loads the
images first through its shared loader (one that fails is skipped with a warning) and replays the drawing with its
on-screen painter, so the image matches the canvas:
- iOS (`canvas/offscreen.rs`): `canvas::paint`, the code of `CanvasView`'s `drawRect:`, into a `CGBitmapContext` on a
  global queue, ImageIO; images wait in the `ImageLoader` under the root's id (`Mounter::image_loaded`).
- Android (`CanvasRender.java`): `CanvasPainter` on a `Bitmap` on one background thread, `Bitmap.compress`; the
  command is `encode.rs` opcode 55, the reply `Native.canvasImage` (bytes as a `byte[]`).
- Windows (`canvas/offscreen.rs`): the on-screen `record`ed command list drawn into a D2D bitmap of the UI thread's
  device (the painter's resources are that thread's), read back once a Direct3D event query polled from a thread
  timer says the GPU is done, so the UI thread never waits for it, encoded with WIC's PNG encoder on a thread.
- Linux (`canvas/offscreen.rs`): the Cairo `Replay` into an `ImageSurface` on the main thread (Pango text needs it),
  encoded by GDK (`save_to_png_bytes`) on a thread.
- GPUI (`canvas/offscreen.rs`): the tiny-skia `Replay` on a thread into one pixmap the size of the image (scratch
  pixmaps only for shadows and composites, sized to what they touch); text without outlines (emoji, color glyphs) is
  not in the image (`docs/dev/gpui.md`).
- Web (`web/nsh.js` `renderCanvas`): the on-screen `replayCanvas` onto an `OffscreenCanvas` (or a `<canvas>`),
  images loaded CORS-clean, `convertToBlob`, back through `nsh_canvas_image` with a status (`CANVAS_IMAGE`,
  `src/lib.rs` `CanvasImageStatus`: image, failed, too large); the browser runtime's `nsh` exports its own
  `OffscreenCanvas` (`web/browser/canvas.js`, op 604), apart from the browser's global one. Browsers cap canvases
  below the core's limits (WebKit on iOS at 16777216 pixels in all) and past them draw nothing instead of failing, so
  `offscreenCanvas` reads back one pixel drawn in the far corner before the drawing; a canvas that lost it, no context
  or the encoder's `RangeError` answers `TooLarge` (`docs/dev/web.md` "Platform services").

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
suffix paints in the preceding state; unsupported or large suffixes keep the whole-canvas path. Unsplit canvases on
macOS also size their content layer to the 32-point-tile-aligned bounds from `DamageScan::painted_after` (and omit the
layer when `Damage::None`), skipping unshadowed `source-over` paints with constant transparent colors or zero
`globalAlpha` so stacked per-mark canvases do not allocate full-view backing stores.
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

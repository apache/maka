//! How many pixels resvg holds at once to draw a tree: a conservative
//! estimate made before drawing, so that an SVG of a few hundred bytes
//! cannot make the renderer allocate gigabytes.
//!
//! It follows resvg 0.46 (`render.rs`, `mask.rs`, `clip.rs`, `filter/mod.rs`
//! and `path.rs`). Every isolated group (opacity, a clip path, a mask,
//! filters, a blend mode) is drawn into a layer of its own: the group's layer
//! box at the drawing's scale, 2 pixels wider each side, at most 5 × the
//! canvas each way, and alive while its children draw into it, so nested
//! groups add up (usvg nests elements up to 1024 deep). Once the children
//! are drawn, a filter allocates a pixmap of its region per primitive (the
//! results stay until the filter ends; the region is not clamped), a clip
//! path a layer-sized pixmap and an alpha mask per level of clipping, a mask
//! a layer-sized pixmap and its alpha masks beside what its content draws.
//! A pattern draws its tile (the pattern's box at the path's scale, not
//! clamped) whenever a path fills or strokes with it. An inline raster image
//! takes a pixmap of its own decoded size while it is drawn; a GIF adds the
//! decoder's RGBA frame and indexed buffer to that pixmap. The estimate adds
//! up what is alive at once along every nesting path, takes the largest sum,
//! and rounds sizes up. A nested SVG image is refused by the parser's
//! resolver (it would hide its tree from this estimate), so it counts as
//! over budget if one ever reaches the walker.

use resvg::{tiny_skia::Transform, usvg};

/// The most nodes the estimate visits, usvg's limit on a document's
/// elements: a drawing that visits more (shared patterns, masks and clip
/// paths count each time they are drawn) is refused, which also bounds the
/// time the estimate takes.
pub(super) const MAX_VISITS: u32 = 1_000_000;

/// The pixels resvg holds at most at once, beside the canvas, to draw
/// `tree` with `transform` into a canvas of `size` pixels; `None` when the
/// drawing visits more than [`MAX_VISITS`] nodes.
pub(super) fn peak(tree: &usvg::Tree, transform: Transform, size: (u32, u32)) -> Option<f64> {
    // resvg's `max_bbox`: no layer is larger each way.
    let clamp = (5.0 * f64::from(size.0), 5.0 * f64::from(size.1));
    // resvg draws the root's children, not the root as a group.
    Walk { visits: 0 }.nodes(tree.root(), transform, clamp)
}

/// The largest a layer gets each way, in pixels.
type Clamp = (f64, f64);

/// The walk over a tree, counting the nodes it visits.
struct Walk {
    visits: u32,
}

impl Walk {
    fn visit(&mut self) -> Option<()> {
        self.visits += 1;
        (self.visits <= MAX_VISITS).then_some(())
    }

    /// The children of `parent`, drawn one after another.
    fn nodes(&mut self, parent: &usvg::Group, ts: Transform, clamp: Clamp) -> Option<f64> {
        let mut peak = 0.0f64;
        for node in parent.children() {
            self.visit()?;
            let cost = match node {
                usvg::Node::Group(group) => self.group(group, ts, clamp)?,
                usvg::Node::Path(path) => self.paints(path, ts, clamp)?,
                usvg::Node::Text(text) => self.group(text.flattened(), ts, clamp)?,
                usvg::Node::Image(image) => self.image(image)?,
            };
            peak = peak.max(cost);
        }
        Some(peak)
    }

    /// An image: its decoded pixmap while it is drawn. A nested SVG
    /// document is refused by the resolver; should one reach here, it is
    /// over budget (its own tree and layers were never walked).
    fn image(&mut self, image: &usvg::Image) -> Option<f64> {
        let area = match image.kind() {
            usvg::ImageKind::SVG(_) => f64::MAX,
            // resvg decodes a GIF's first frame at the frame's own size, which
            // may exceed the logical screen `imagesize` reports.
            usvg::ImageKind::GIF(data) => gif_area(data.as_slice()).unwrap_or(0.0),
            usvg::ImageKind::JPEG(data)
            | usvg::ImageKind::PNG(data)
            | usvg::ImageKind::WEBP(data) => imagesize::blob_size(data.as_slice())
                .map_or(0.0, |size| size.width as f64 * size.height as f64),
        };
        Some(area)
    }

    /// A group: its layer when it is isolated, beside its children and then
    /// its filters, clip path and mask, one after another.
    fn group(&mut self, group: &usvg::Group, ts: Transform, clamp: Clamp) -> Option<f64> {
        let ts = ts.pre_concat(group.transform());
        if !group.should_isolate() {
            return self.nodes(group, ts, clamp);
        }
        // resvg draws nothing of a group whose box does not transform.
        let Some(bbox) = group.layer_bounding_box().transform(ts) else {
            return Some(0.0);
        };
        let layer = (f64::from(bbox.width()).ceil() + 4.0).min(clamp.0)
            * (f64::from(bbox.height()).ceil() + 4.0).min(clamp.1);
        let mut after = self.nodes(group, ts, clamp)?;
        for filter in group.filters() {
            after = after.max(self.filter(filter, ts, layer)?);
        }
        if let Some(clip) = group.clip_path() {
            after = after.max(self.clip(clip, ts, layer, clamp)?);
        }
        if let Some(mask) = group.mask() {
            after = after.max(self.mask(mask, ts, layer, clamp)?);
        }
        Some(layer + after)
    }

    /// A filter on a layer: every primitive's result, as large as the
    /// region (or the layer), stays until the filter ends, beside the input
    /// copied for the primitive being made and its own result.
    fn filter(&mut self, filter: &usvg::filter::Filter, ts: Transform, layer: f64) -> Option<f64> {
        let Some(region) = filter.rect().transform(ts) else {
            return Some(0.0);
        };
        let (w, h) = (
            f64::from(region.width()).ceil() + 1.0,
            f64::from(region.height()).ceil() + 1.0,
        );
        let results = (filter.primitives().len() as f64 + 2.0) * (w * h).max(layer);
        // `feImage` draws its content into a region-sized pixmap, its
        // layers clamped to the region.
        let (sx, sy) = ts.get_scale();
        let mut content = 0.0f64;
        for primitive in filter.primitives() {
            if let usvg::filter::Kind::Image(image) = primitive.kind() {
                content =
                    content.max(self.nodes(image.root(), Transform::from_scale(sx, sy), (w, h))?);
            }
        }
        Some(results + content)
    }

    /// A clip path on a layer: a layer-sized pixmap and the alpha mask made
    /// of it, beside what its children take and then its own clip path.
    fn clip(
        &mut self,
        clip: &usvg::ClipPath,
        ts: Transform,
        layer: f64,
        clamp: Clamp,
    ) -> Option<f64> {
        let children = self.clipped(clip.root(), ts.pre_concat(clip.transform()), layer, clamp)?;
        let nested = match clip.clip_path() {
            Some(clip) => self.clip(clip, ts, layer, clamp)?,
            None => 0.0,
        };
        Some(1.25 * layer + children.max(nested))
    }

    /// The children of a clip path: a group with a clip path of its own is
    /// drawn into a layer-sized pixmap and clipped there.
    fn clipped(
        &mut self,
        parent: &usvg::Group,
        ts: Transform,
        layer: f64,
        clamp: Clamp,
    ) -> Option<f64> {
        let mut peak = 0.0f64;
        for node in parent.children() {
            self.visit()?;
            let cost = match node {
                usvg::Node::Group(group) => {
                    let ts = ts.pre_concat(group.transform());
                    let children = self.clipped(group, ts, layer, clamp)?;
                    match group.clip_path() {
                        Some(clip) => layer + children.max(self.clip(clip, ts, layer, clamp)?),
                        None => children,
                    }
                }
                usvg::Node::Path(path) => self.paints(path, ts, clamp)?,
                usvg::Node::Text(text) => self.clipped(text.flattened(), ts, layer, clamp)?,
                usvg::Node::Image(image) => self.image(image)?,
            };
            peak = peak.max(cost);
        }
        Some(peak)
    }

    /// A mask on a layer: a layer-sized pixmap, beside an alpha mask while
    /// its content draws into it, then its own mask, then the mask made of
    /// it.
    fn mask(&mut self, mask: &usvg::Mask, ts: Transform, layer: f64, clamp: Clamp) -> Option<f64> {
        if !mask.root().has_children() {
            return Some(0.0);
        }
        let content = self.nodes(mask.root(), ts, clamp)?;
        let nested = match mask.mask() {
            Some(mask) => self.mask(mask, ts, layer, clamp)?,
            None => 0.0,
        };
        Some(1.25 * layer + content.max(nested))
    }

    /// A path's fill and stroke: a pattern draws its content into a tile of
    /// its own, the pattern's box at the path's scale.
    fn paints(&mut self, path: &usvg::Path, ts: Transform, clamp: Clamp) -> Option<f64> {
        let fill = path.fill().map(|fill| fill.paint());
        let stroke = path.stroke().map(|stroke| stroke.paint());
        let mut peak = 0.0f64;
        for paint in [fill, stroke].into_iter().flatten() {
            let usvg::Paint::Pattern(pattern) = paint else {
                continue;
            };
            let (sx, sy) = ts.pre_concat(pattern.transform()).get_scale();
            let rect = pattern.rect();
            let tile = (f64::from(rect.width()) * f64::from(sx)).round()
                * (f64::from(rect.height()) * f64::from(sy)).round();
            let content = self.nodes(pattern.root(), Transform::from_scale(sx, sy), clamp)?;
            peak = peak.max(tile + content);
        }
        Some(peak)
    }
}

/// A GIF's first frame as resvg decodes it: the frame's Image Descriptor size
/// (not the logical screen `imagesize` reads), whose RGBA frame, indexed
/// buffer and resvg's pixmap are alive together (9 bytes a pixel, 2.25 layer
/// pixels).
fn gif_area(data: &[u8]) -> Option<f64> {
    let mut options = gif::DecodeOptions::new();
    options.set_color_output(gif::ColorOutput::RGBA);
    let mut decoder = options.read_info(std::io::Cursor::new(data)).ok()?;
    let frame = decoder.next_frame_info().ok()??;
    Some(f64::from(frame.width) * f64::from(frame.height) * 9.0 / 4.0)
}

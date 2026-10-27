//! Isolated raster groups for visual effects that cannot be expressed by
//! terminal cells. Scene snapshots contain no surface or VM references;
//! the graphics worker resolves their pixels and the normal renderer keeps
//! painting ordinary text while an effect snapshot is pending.

mod blend;
mod effects;

use std::{collections::HashMap, sync::Arc};

use nsh_core::{
    BlendMode, Bounds, Color, CornerRadii, Matrix, NodeId, Point, Points, ResizeMode, Size,
    TextLayout, ViewStyle,
};
use ratatui::buffer::Buffer;

use crate::{CellMetrics, fonts::FontCatalog, image::Raster, worker::Graphics};

const MAX_PIXELS: u64 = 2 << 20;
const MAX_SIDE: u32 = 8192;
const MAX_WORK_PIXELS: u64 = 24 << 20;
const MAX_ENTRIES: usize = 32;
const MAX_CACHE_BYTES: usize = 64 << 20;
const MAX_PENDING: usize = 8;

/// One immutable subtree and the already painted backdrop beneath it.
#[derive(Clone)]
pub(crate) struct Scene {
    pub(crate) bounds: Bounds<Points>,
    pub(crate) root: Layer,
    pub(crate) backdrop: Buffer,
    pub(crate) metrics: CellMetrics,
    pub(crate) font_revision: u64,
    pub(crate) inherited_opacity: f32,
}

#[derive(Clone)]
pub(crate) struct Layer {
    pub(crate) id: NodeId,
    pub(crate) size: Size<Points>,
    /// Local point (0,0) to surface points, before any bounding rectangle.
    pub(crate) transform: Matrix,
    pub(crate) clip: Bounds<Points>,
    pub(crate) style: ViewStyle,
    pub(crate) images: Vec<Image>,
    pub(crate) text: Option<Text>,
    pub(crate) cells: Option<Buffer>,
    pub(crate) overlay: Option<Buffer>,
    pub(crate) children: Vec<Layer>,
}

#[derive(Clone)]
pub(crate) struct Image {
    pub(crate) raster: Arc<Raster>,
    pub(crate) frame: Bounds<Points>,
    pub(crate) mode: ResizeMode,
    pub(crate) tint: Option<Color>,
    pub(crate) opacity: f32,
}

#[derive(Clone)]
pub(crate) struct Text {
    pub(crate) layout: TextLayout,
    pub(crate) content: Bounds<Points>,
    pub(crate) foreground: Option<Color>,
    pub(crate) selection: Vec<(Bounds<Points>, Color)>,
    pub(crate) focus: bool,
    pub(crate) focus_range: Option<(u32, u32)>,
}

impl PartialEq for Scene {
    fn eq(&self, other: &Self) -> bool {
        self.bounds == other.bounds
            && self.root == other.root
            && self.backdrop == other.backdrop
            && self.metrics == other.metrics
            && self.font_revision == other.font_revision
            && self.inherited_opacity == other.inherited_opacity
    }
}

impl PartialEq for Layer {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.size == other.size
            && self.transform == other.transform
            && self.clip == other.clip
            && self.style == other.style
            && self.images == other.images
            && self.text == other.text
            && self.cells == other.cells
            && self.overlay == other.overlay
            && self.children == other.children
    }
}

impl PartialEq for Image {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.raster, &other.raster)
            && self.frame == other.frame
            && self.mode == other.mode
            && self.tint == other.tint
            && self.opacity == other.opacity
    }
}

impl PartialEq for Text {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.layout.0, &other.layout.0)
            && self.content == other.content
            && self.foreground == other.foreground
            && self.selection == other.selection
            && self.focus == other.focus
            && self.focus_range == other.focus_range
    }
}

struct Entry {
    scene: Arc<Scene>,
    sequence: u64,
    pending: bool,
    retired: bool,
    frame: Option<Frame>,
    used: u64,
}

#[derive(Clone)]
pub(crate) struct Frame {
    pub(crate) bounds: Bounds<Points>,
    pub(crate) raster: Arc<Raster>,
}

/// Bounded per-surface cache, with one in-flight snapshot per node.
#[derive(Default)]
pub(crate) struct Cache {
    entries: HashMap<NodeId, Entry>,
    clock: u64,
    sequence: u64,
}

impl Cache {
    pub(crate) fn request(
        &mut self,
        id: NodeId,
        scene: Scene,
        graphics: &Graphics,
    ) -> Option<Frame> {
        self.clock = self.clock.wrapping_add(1);
        if let Some(entry) = self.entries.get_mut(&id) {
            entry.used = self.clock;
            if entry.retired && entry.pending {
                return None;
            }
            if *entry.scene == scene {
                return entry.frame.clone();
            }
            if entry.pending {
                return entry.frame.clone();
            }
        }
        if self.entries.values().filter(|e| e.pending).count() >= MAX_PENDING {
            return self.entries.get(&id).and_then(|entry| entry.frame.clone());
        }
        self.trim(Some(id));
        self.sequence = self.sequence.wrapping_add(1);
        let scene = Arc::new(scene);
        let sequence = self.sequence;
        let pending = graphics.composite(id, sequence, scene.clone());
        if !pending {
            log::warn!("Terminal compositor worker stopped");
        }
        let frame = self.entries.remove(&id).and_then(|entry| entry.frame);
        self.entries.insert(
            id,
            Entry {
                scene,
                sequence,
                pending,
                retired: false,
                frame: frame.clone(),
                used: self.clock,
            },
        );
        frame
    }

    pub(crate) fn complete(
        &mut self,
        id: NodeId,
        sequence: u64,
        result: Result<Raster, String>,
    ) -> bool {
        let Some(entry) = self.entries.get_mut(&id) else {
            return false;
        };
        if entry.sequence != sequence || !entry.pending {
            return false;
        }
        if entry.retired {
            self.entries.remove(&id);
            return true;
        }
        entry.pending = false;
        match result {
            Ok(raster) => {
                entry.frame = Some(Frame {
                    bounds: entry.scene.bounds,
                    raster: Arc::new(raster),
                })
            }
            Err(error) => {
                entry.frame = None;
                log::warn!("Terminal compositor node {id}: {error}");
            }
        }
        self.trim(None);
        true
    }

    pub(crate) fn pending(&self) -> bool {
        self.entries.values().any(|entry| entry.pending)
    }

    pub(crate) fn retain(&mut self, ids: &[NodeId]) {
        for (&id, entry) in &mut self.entries {
            if !ids.contains(&id) {
                entry.retired = true;
                entry.frame = None;
            }
        }
        self.entries
            .retain(|id, entry| entry.pending || ids.contains(id));
    }

    pub(crate) fn invalidate(&mut self, id: NodeId) {
        if let Some(entry) = self.entries.get_mut(&id) {
            entry.retired = true;
            entry.frame = None;
            if !entry.pending {
                self.entries.remove(&id);
            }
        }
    }

    fn trim(&mut self, keep: Option<NodeId>) {
        loop {
            let bytes = self
                .entries
                .values()
                .filter_map(|e| e.frame.as_ref())
                .map(|r| r.raster.rgba.len())
                .sum::<usize>();
            if self.entries.len() < MAX_ENTRIES && bytes <= MAX_CACHE_BYTES {
                break;
            }
            let victim = self
                .entries
                .iter()
                .filter(|(id, entry)| Some(**id) != keep && !entry.pending)
                .min_by_key(|(_, e)| e.used)
                .map(|(&id, _)| id);
            let Some(victim) = victim else { break };
            self.entries.remove(&victim);
        }
    }
}

struct Context<'a> {
    scene: &'a Scene,
    fonts: &'a FontCatalog,
    width: u32,
    height: u32,
    scale: f32,
    pixels_in_use: u64,
}

/// Resolves a snapshot on the graphics worker, including group alpha and
/// the pixels behind backdrop filters. Output covers `Scene::bounds`.
pub(crate) fn rasterize(scene: &Scene, fonts: &FontCatalog) -> Result<Raster, String> {
    if !valid_rect(scene.bounds) {
        return Err("effect group has no finite positive bounds".into());
    }
    let (width, height, scale) = raster_dimensions(scene.bounds, 1.0);
    let backdrop = crate::text::rasterize_cells(&scene.backdrop, scene.metrics, fonts)?;
    let mut context = Context {
        scene,
        fonts,
        width,
        height,
        scale,
        pixels_in_use: 0,
    };
    let mut background = context.blank()?;
    resample(&backdrop, &mut background);
    let layer = context.layer(&scene.root, &background, 0)?;
    composite_into(
        &layer,
        &mut background,
        scene.root.style.opacity * scene.inherited_opacity,
        scene.root.style.blend_mode,
    );
    Ok(background)
}

// Inverse perspective transforms can produce an extremely thin local
// plane. Bound each dimension as well as area before allocating it.
fn raster_dimensions(rect: Bounds<Points>, maximum_scale: f32) -> (u32, u32, f32) {
    let width = f64::from(rect.size.width.0);
    let height = f64::from(rect.size.height.0);
    let scale = (MAX_PIXELS as f64 / (width * height))
        .sqrt()
        .min(f64::from(MAX_SIDE) / width)
        .min(f64::from(MAX_SIDE) / height)
        .min(f64::from(maximum_scale)) as f32;
    let width = (rect.size.width.0 * scale)
        .floor()
        .clamp(1.0, MAX_SIDE as f32) as u32;
    let height = (rect.size.height.0 * scale)
        .floor()
        .clamp(1.0, MAX_SIDE as f32) as u32;
    // Rounding scale to f32 can add one pixel at the area limit.
    let height = height.min((MAX_PIXELS / u64::from(width)) as u32);
    (width, height, scale)
}

impl Context<'_> {
    fn blank(&mut self) -> Result<Raster, String> {
        let pixels = u64::from(self.width) * u64::from(self.height);
        if self.pixels_in_use.saturating_add(pixels) > MAX_WORK_PIXELS {
            return Err("effect group exceeds its working pixel budget".into());
        }
        self.pixels_in_use += pixels;
        Ok(Raster {
            width: self.width,
            height: self.height,
            rgba: vec![0; pixels as usize * 4],
        })
    }

    fn release(&mut self) {
        self.pixels_in_use = self
            .pixels_in_use
            .saturating_sub(u64::from(self.width) * u64::from(self.height));
    }

    fn point(&self, x: u32, y: u32) -> (f32, f32) {
        (
            self.scene.bounds.origin.x.0 + (x as f32 + 0.5) / self.scale,
            self.scene.bounds.origin.y.0 + (y as f32 + 0.5) / self.scale,
        )
    }

    fn region(&self, rect: Bounds<Points>) -> (u32, u32, u32, u32) {
        let x = ((rect.origin.x.0 - self.scene.bounds.origin.x.0) * self.scale)
            .floor()
            .clamp(0.0, self.width as f32) as u32;
        let y = ((rect.origin.y.0 - self.scene.bounds.origin.y.0) * self.scale)
            .floor()
            .clamp(0.0, self.height as f32) as u32;
        let right = ((rect.origin.x.0 + rect.size.width.0 - self.scene.bounds.origin.x.0)
            * self.scale)
            .ceil()
            .clamp(0.0, self.width as f32) as u32;
        let bottom = ((rect.origin.y.0 + rect.size.height.0 - self.scene.bounds.origin.y.0)
            * self.scale)
            .ceil()
            .clamp(0.0, self.height as f32) as u32;
        (x, y, right, bottom)
    }

    fn layer(&mut self, layer: &Layer, backdrop: &Raster, depth: usize) -> Result<Raster, String> {
        if depth >= 32 {
            return Err("effect group nesting exceeds 32 layers".into());
        }
        let mut output = self.blank()?;
        if layer.style.hidden || layer.style.opacity <= 0.0 {
            return Ok(output);
        }
        let mask = self.mask(
            layer,
            Bounds::new(Point::default(), layer.size),
            layer.style.radii(),
        )?;
        if let Some(effects) = &layer.style.effects
            && !effects.backdrop_filters.is_empty()
        {
            output = backdrop.clone();
            self.filter(layer, &mut output, &effects.backdrop_filters)?;
            apply_mask(&mut output, &mask);
        }
        let shadows = self.outer_shadows(layer, &mask)?;
        self.decoration(layer, &mut output, &mask)?;
        for image in &layer.images {
            self.image(layer, image, &mut output);
        }
        if let Some(text) = &layer.text {
            for &(rect, color) in &text.selection {
                self.solid(layer, rect, color, &mut output);
            }
            let mut raster = crate::text::rasterize(
                &text.layout,
                text.content.size.width,
                text.content.size.height,
                self.fonts,
            )?;
            if let Some(color) = text.foreground {
                tint(&mut raster, color);
            }
            self.image(
                layer,
                &Image {
                    raster: Arc::new(raster),
                    frame: text.content,
                    mode: ResizeMode::Stretch,
                    tint: None,
                    opacity: 1.0,
                },
                &mut output,
            );
            if (text.focus || text.focus_range.is_some())
                && let Some(terminal) = text.layout.0.downcast_ref::<crate::text::TerminalLayout>()
            {
                for run in terminal.runs.iter().filter(|run| {
                    text.focus
                        || text
                            .focus_range
                            .is_some_and(|range| run.start < range.1 && run.end > range.0)
                }) {
                    self.solid(
                        layer,
                        Bounds::new(
                            Point::new(
                                Points(text.content.origin.x.0 + run.x.0),
                                Points(
                                    text.content.origin.y.0
                                        + run.y.0
                                        + self.scene.metrics.height().0
                                        - 1.0,
                                ),
                            ),
                            Size::new(
                                Points(f32::from(run.width) * self.scene.metrics.width().0),
                                Points(1.0),
                            ),
                        ),
                        text.foreground.unwrap_or(run.style.color),
                        &mut output,
                    );
                }
            }
        }
        if let Some(cells) = &layer.cells {
            let raster = crate::text::rasterize_cells(cells, self.scene.metrics, self.fonts)?;
            self.image(
                layer,
                &Image {
                    raster: Arc::new(raster),
                    frame: Bounds::new(Point::default(), layer.size),
                    mode: ResizeMode::Stretch,
                    tint: None,
                    opacity: 1.0,
                },
                &mut output,
            );
        }
        for child in &layer.children {
            let mut behind = backdrop.clone();
            composite_into(&output, &mut behind, 1.0, BlendMode::Normal);
            let child_raster = self.layer(child, &behind, depth + 1)?;
            composite_into(
                &child_raster,
                &mut output,
                child.style.opacity,
                child.style.blend_mode,
            );
            self.release();
        }
        if let Some(cells) = &layer.overlay {
            let raster = crate::text::rasterize_cells(cells, self.scene.metrics, self.fonts)?;
            self.image(
                layer,
                &Image {
                    raster: Arc::new(raster),
                    frame: Bounds::new(Point::default(), layer.size),
                    mode: ResizeMode::Stretch,
                    tint: None,
                    opacity: 1.0,
                },
                &mut output,
            );
        }
        if layer.style.overflow_hidden {
            apply_mask(&mut output, &mask);
        }
        self.borders(layer, &mut output, &mask)?;
        if let Some(mut shadows) = shadows {
            composite_into(&output, &mut shadows, 1.0, BlendMode::Normal);
            output = shadows;
            self.release();
        }
        if let Some(effects) = &layer.style.effects {
            self.filter(layer, &mut output, &effects.filters)?;
        }
        self.clip(layer, &mut output);
        Ok(output)
    }

    fn mask(
        &self,
        layer: &Layer,
        rect: Bounds<Points>,
        radii: CornerRadii,
    ) -> Result<tiny_skia::Mask, String> {
        let mut mask =
            tiny_skia::Mask::new(self.width, self.height).ok_or("effect clip allocation failed")?;
        let mut path = tiny_skia::PathBuilder::new();
        let mut first = true;
        for (x, y) in outline(rect, radii) {
            let Some((x, y)) = project(&layer.transform, x, y) else {
                return Ok(mask);
            };
            let (x, y) = (
                (x - self.scene.bounds.origin.x.0) * self.scale,
                (y - self.scene.bounds.origin.y.0) * self.scale,
            );
            if first {
                path.move_to(x, y);
                first = false;
            } else {
                path.line_to(x, y);
            }
        }
        path.close();
        if let Some(path) = path.finish() {
            mask.fill_path(
                &path,
                tiny_skia::FillRule::Winding,
                true,
                tiny_skia::Transform::identity(),
            );
        }
        Ok(mask)
    }

    fn outer_shadows(
        &mut self,
        layer: &Layer,
        mask: &tiny_skia::Mask,
    ) -> Result<Option<Raster>, String> {
        let style = &layer.style;
        let rect = Bounds::new(Point::default(), layer.size);
        let mut shadows = Vec::new();
        if let Some(effects) = &style.effects {
            shadows.extend(
                effects
                    .box_shadows
                    .iter()
                    .rev()
                    .copied()
                    .filter(|s| s.is_visible() && !s.inset),
            );
        }
        if shadows.is_empty() {
            return Ok(None);
        }
        let mut output = self.blank()?;
        for shadow in shadows {
            let shape = Bounds::new(
                Point::new(
                    Points(shadow.offset_x.0 - shadow.spread.0),
                    Points(shadow.offset_y.0 - shadow.spread.0),
                ),
                Size::new(
                    Points(rect.size.width.0 + shadow.spread.0 * 2.0),
                    Points(rect.size.height.0 + shadow.spread.0 * 2.0),
                ),
            );
            if !valid_rect(shape) {
                continue;
            }
            let radii = expanded_radii(style.radii(), shadow.spread);
            let shadow_mask = self.mask(layer, shape, radii)?;
            let mut pixels = self.blank()?;
            for (pixel, &coverage) in pixels
                .rgba
                .as_chunks_mut::<4>()
                .0
                .iter_mut()
                .zip(shadow_mask.data())
            {
                pixel.copy_from_slice(&color_bytes(with_alpha(
                    shadow.color,
                    f32::from(coverage) / 255.0,
                )));
            }
            effects::blur(
                &mut pixels,
                shadow.blur.0.max(0.0) * 0.5 * self.scale * transform_scale(&layer.transform),
            );
            // An outer shadow belongs outside the border box, including
            // when the view itself has a transparent fill.
            for (pixel, &coverage) in pixels
                .rgba
                .as_chunks_mut::<4>()
                .0
                .iter_mut()
                .zip(mask.data())
            {
                pixel[3] = ((u16::from(pixel[3]) * u16::from(255 - coverage) + 127) / 255) as u8;
            }
            composite_into(&pixels, &mut output, 1.0, BlendMode::Normal);
            self.release();
        }
        Ok(Some(output))
    }

    fn decoration(
        &mut self,
        layer: &Layer,
        output: &mut Raster,
        mask: &tiny_skia::Mask,
    ) -> Result<(), String> {
        let style = &layer.style;
        let rect = Bounds::new(Point::default(), layer.size);
        let gradients: Vec<_> = style
            .effects
            .iter()
            .flat_map(|e| e.background_images.iter())
            .filter(|g| g.stops.len() >= 2)
            .map(|g| (g, g.resolved_stops(layer.size)))
            .collect();
        let (left, top, right, bottom) =
            self.region(transformed_bounds(&layer.transform, rect).unwrap_or(self.scene.bounds));
        if !style.background_color.is_transparent() || !gradients.is_empty() {
            for y in top..bottom {
                for x in left..right {
                    let coverage = mask.data()[y as usize * self.width as usize + x as usize];
                    if coverage == 0 {
                        continue;
                    }
                    let (sx, sy) = self.point(x, y);
                    let Some((px, py)) = unproject(&layer.transform, sx, sy) else {
                        continue;
                    };
                    let mut color = premul(style.background_color);
                    for (gradient, stops) in gradients.iter().rev() {
                        color = blend::over(
                            premul(crate::render::gradient_color(
                                gradient,
                                stops,
                                px,
                                py,
                                rect.size.width.0,
                                rect.size.height.0,
                            )),
                            color,
                            1.0,
                            BlendMode::Normal,
                        );
                    }
                    for channel in &mut color {
                        *channel *= f32::from(coverage) / 255.0;
                    }
                    put(
                        output,
                        x,
                        y,
                        blend::over(color, get(output, x, y), 1.0, BlendMode::Normal),
                    );
                }
            }
        }
        if let Some(effects) = &style.effects {
            for shadow in effects
                .box_shadows
                .iter()
                .rev()
                .filter(|s| s.inset && s.is_visible())
            {
                let inner = Bounds::new(
                    Point::new(
                        Points(shadow.offset_x.0 + shadow.spread.0),
                        Points(shadow.offset_y.0 + shadow.spread.0),
                    ),
                    Size::new(
                        Points(rect.size.width.0 - shadow.spread.0 * 2.0),
                        Points(rect.size.height.0 - shadow.spread.0 * 2.0),
                    ),
                );
                let hole =
                    self.mask(layer, inner, expanded_radii(style.radii(), -shadow.spread))?;
                let mut pixels = self.blank()?;
                for (pixel, &coverage) in pixels
                    .rgba
                    .as_chunks_mut::<4>()
                    .0
                    .iter_mut()
                    .zip(hole.data())
                {
                    pixel.copy_from_slice(&color_bytes(with_alpha(
                        shadow.color,
                        f32::from(255 - coverage) / 255.0,
                    )));
                }
                effects::blur(
                    &mut pixels,
                    shadow.blur.0.max(0.0) * 0.5 * self.scale * transform_scale(&layer.transform),
                );
                apply_mask(&mut pixels, mask);
                composite_into(&pixels, output, 1.0, BlendMode::Normal);
                self.release();
            }
        }
        Ok(())
    }

    fn solid(&self, layer: &Layer, rect: Bounds<Points>, color: Color, output: &mut Raster) {
        if color.is_transparent() {
            return;
        }
        let color = premul(color);
        let (left, top, right, bottom) =
            self.region(transformed_bounds(&layer.transform, rect).unwrap_or(self.scene.bounds));
        for y in top..bottom {
            for x in left..right {
                let (sx, sy) = self.point(x, y);
                if unproject(&layer.transform, sx, sy).is_some_and(|(x, y)| contains(rect, x, y)) {
                    put(
                        output,
                        x,
                        y,
                        blend::over(color, get(output, x, y), 1.0, BlendMode::Normal),
                    );
                }
            }
        }
    }

    fn image(&self, layer: &Layer, image: &Image, output: &mut Raster) {
        if image.raster.width == 0
            || image.raster.height == 0
            || image.opacity <= 0.0
            || !valid_rect(image.frame)
        {
            return;
        }
        let dest = crate::image::fitted_frame(&image.raster, image.frame, image.mode);
        let (left, top, right, bottom) = self
            .region(transformed_bounds(&layer.transform, image.frame).unwrap_or(self.scene.bounds));
        for y in top..bottom {
            for x in left..right {
                let (sx, sy) = self.point(x, y);
                let Some((px, py)) = unproject(&layer.transform, sx, sy) else {
                    continue;
                };
                if !contains(image.frame, px, py) || !contains(dest, px, py) {
                    continue;
                }
                let mut color = image.raster.sample(
                    (px - dest.origin.x.0) / dest.size.width.0 * image.raster.width as f32,
                    (py - dest.origin.y.0) / dest.size.height.0 * image.raster.height as f32,
                );
                if let Some(tint) = image.tint {
                    let tint = premul(tint);
                    for c in 0..3 {
                        color[c] = tint[c] * color[3];
                    }
                    color[3] *= tint[3];
                }
                put(
                    output,
                    x,
                    y,
                    blend::over(color, get(output, x, y), image.opacity, BlendMode::Normal),
                );
            }
        }
    }

    fn borders(
        &self,
        layer: &Layer,
        output: &mut Raster,
        mask: &tiny_skia::Mask,
    ) -> Result<(), String> {
        let borders = layer.style.borders;
        if borders.is_visible() {
            let widths = borders.widths.to_array().map(|w| w.0.max(0.0));
            let [top, right, bottom, left] = widths;
            let inner = Bounds::new(
                Point::new(Points(left), Points(top)),
                Size::new(
                    Points((layer.size.width.0 - left - right).max(0.0)),
                    Points((layer.size.height.0 - top - bottom).max(0.0)),
                ),
            );
            let outer_radii = layer.style.radii();
            let inner_radii = CornerRadii {
                top_left: Points((outer_radii.top_left.0 - top.max(left)).max(0.0)),
                top_right: Points((outer_radii.top_right.0 - top.max(right)).max(0.0)),
                bottom_right: Points((outer_radii.bottom_right.0 - bottom.max(right)).max(0.0)),
                bottom_left: Points((outer_radii.bottom_left.0 - bottom.max(left)).max(0.0)),
                continuous: outer_radii.continuous,
            };
            let hole = self.mask(layer, inner, inner_radii)?;
            for y in 0..self.height {
                for x in 0..self.width {
                    let i = y as usize * self.width as usize + x as usize;
                    let coverage = mask.data()[i].saturating_sub(hole.data()[i]);
                    if coverage == 0 {
                        continue;
                    }
                    let (sx, sy) = self.point(x, y);
                    let Some((px, py)) = unproject(&layer.transform, sx, sy) else {
                        continue;
                    };
                    let distances = [
                        py / top.max(f32::EPSILON),
                        (layer.size.width.0 - px) / right.max(f32::EPSILON),
                        (layer.size.height.0 - py) / bottom.max(f32::EPSILON),
                        px / left.max(f32::EPSILON),
                    ];
                    let side = (0..4)
                        .filter(|&i| widths[i] > 0.0)
                        .min_by(|&a, &b| distances[a].total_cmp(&distances[b]))
                        .unwrap_or(0);
                    let along = if side % 2 == 0 { px } else { py };
                    let on = match borders.style {
                        nsh_core::BorderStyle::Solid => true,
                        nsh_core::BorderStyle::Dashed => {
                            along.rem_euclid((widths[side] * 6.0).max(6.0))
                                < (widths[side] * 4.0).max(4.0)
                        }
                        nsh_core::BorderStyle::Dotted => {
                            along.rem_euclid((widths[side] * 2.0).max(2.0)) < widths[side].max(1.0)
                        }
                    };
                    if on {
                        put(
                            output,
                            x,
                            y,
                            blend::over(
                                premul(with_alpha(
                                    borders.colors[side],
                                    f32::from(coverage) / 255.0,
                                )),
                                get(output, x, y),
                                1.0,
                                BlendMode::Normal,
                            ),
                        );
                    }
                }
            }
        }
        let outline = layer.style.outline;
        if outline.is_visible() {
            let outer = outline.offset.0 + outline.width.0;
            let outer_rect = Bounds::new(
                Point::new(Points(-outer), Points(-outer)),
                Size::new(
                    Points(layer.size.width.0 + 2.0 * outer),
                    Points(layer.size.height.0 + 2.0 * outer),
                ),
            );
            let inner = outline.offset.0;
            let inner_rect = Bounds::new(
                Point::new(Points(-inner), Points(-inner)),
                Size::new(
                    Points(layer.size.width.0 + 2.0 * inner),
                    Points(layer.size.height.0 + 2.0 * inner),
                ),
            );
            let outer = self.mask(
                layer,
                outer_rect,
                expanded_radii(layer.style.radii(), Points(outer)),
            )?;
            let inner = self.mask(
                layer,
                inner_rect,
                expanded_radii(layer.style.radii(), Points(inner)),
            )?;
            for y in 0..self.height {
                for x in 0..self.width {
                    let i = y as usize * self.width as usize + x as usize;
                    let coverage = outer.data()[i].saturating_sub(inner.data()[i]);
                    if coverage > 0 {
                        put(
                            output,
                            x,
                            y,
                            blend::over(
                                premul(with_alpha(outline.color, f32::from(coverage) / 255.0)),
                                get(output, x, y),
                                1.0,
                                BlendMode::Normal,
                            ),
                        );
                    }
                }
            }
        }
        Ok(())
    }

    fn filter(
        &self,
        layer: &Layer,
        output: &mut Raster,
        filters: &[nsh_core::Filter],
    ) -> Result<(), String> {
        if filters.is_empty() {
            return Ok(());
        }
        // Filters operate in the element's local plane. Reprojecting the
        // complete isolated layer preserves rotated, skewed and scaled
        // content rather than filtering its axis-aligned bounds.
        let corners = [
            (self.scene.bounds.origin.x.0, self.scene.bounds.origin.y.0),
            (
                self.scene.bounds.origin.x.0 + self.scene.bounds.size.width.0,
                self.scene.bounds.origin.y.0,
            ),
            (
                self.scene.bounds.origin.x.0,
                self.scene.bounds.origin.y.0 + self.scene.bounds.size.height.0,
            ),
            (
                self.scene.bounds.origin.x.0 + self.scene.bounds.size.width.0,
                self.scene.bounds.origin.y.0 + self.scene.bounds.size.height.0,
            ),
        ];
        let mut bounds = (
            f32::INFINITY,
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::NEG_INFINITY,
        );
        for (x, y) in corners {
            let Some((x, y)) = unproject(&layer.transform, x, y) else {
                return Err("effect transform crosses the perspective horizon".into());
            };
            bounds = (
                bounds.0.min(x),
                bounds.1.min(y),
                bounds.2.max(x),
                bounds.3.max(y),
            );
        }
        let rect = Bounds::new(
            Point::new(Points(bounds.0), Points(bounds.1)),
            Size::new(Points(bounds.2 - bounds.0), Points(bounds.3 - bounds.1)),
        );
        if !valid_rect(rect) {
            return Ok(());
        }
        let (width, height, scale) = raster_dimensions(rect, self.scale);
        let mut local = Raster {
            width,
            height,
            rgba: vec![0; width as usize * height as usize * 4],
        };
        for y in 0..height {
            for x in 0..width {
                let px = rect.origin.x.0 + (x as f32 + 0.5) / scale;
                let py = rect.origin.y.0 + (y as f32 + 0.5) / scale;
                if let Some((sx, sy)) = project(&layer.transform, px, py) {
                    let sx = (sx - self.scene.bounds.origin.x.0) * self.scale;
                    let sy = (sy - self.scene.bounds.origin.y.0) * self.scale;
                    if sx >= 0.0 && sy >= 0.0 && sx < self.width as f32 && sy < self.height as f32 {
                        put(&mut local, x, y, output.sample(sx, sy));
                    }
                }
            }
        }
        effects::apply(&mut local, filters, scale);
        for y in 0..self.height {
            for x in 0..self.width {
                let (sx, sy) = self.point(x, y);
                let Some((px, py)) = unproject(&layer.transform, sx, sy) else {
                    put(output, x, y, [0.0; 4]);
                    continue;
                };
                put(
                    output,
                    x,
                    y,
                    local.sample(
                        (px - rect.origin.x.0) * scale,
                        (py - rect.origin.y.0) * scale,
                    ),
                );
            }
        }
        Ok(())
    }

    fn clip(&self, layer: &Layer, output: &mut Raster) {
        if layer.clip.origin.x.0 <= self.scene.bounds.origin.x.0
            && layer.clip.origin.y.0 <= self.scene.bounds.origin.y.0
            && layer.clip.origin.x.0 + layer.clip.size.width.0
                >= self.scene.bounds.origin.x.0 + self.scene.bounds.size.width.0
            && layer.clip.origin.y.0 + layer.clip.size.height.0
                >= self.scene.bounds.origin.y.0 + self.scene.bounds.size.height.0
        {
            return;
        }
        for y in 0..self.height {
            for x in 0..self.width {
                if output.rgba[(y as usize * self.width as usize + x as usize) * 4 + 3] == 0 {
                    continue;
                }
                let (sx, sy) = self.point(x, y);
                if !contains(layer.clip, sx, sy) {
                    put(output, x, y, [0.0; 4]);
                }
            }
        }
    }
}

pub(crate) fn rounded_contains(size: Size<Points>, radii: CornerRadii, x: f32, y: f32) -> bool {
    if x < 0.0 || y < 0.0 || x >= size.width.0 || y >= size.height.0 {
        return false;
    }
    let radii = radii.fit(size);
    if !radii.continuous {
        for (cx, cy, radius, on) in [
            (
                radii.top_left.0,
                radii.top_left.0,
                radii.top_left.0,
                x < radii.top_left.0 && y < radii.top_left.0,
            ),
            (
                size.width.0 - radii.top_right.0,
                radii.top_right.0,
                radii.top_right.0,
                x > size.width.0 - radii.top_right.0 && y < radii.top_right.0,
            ),
            (
                size.width.0 - radii.bottom_right.0,
                size.height.0 - radii.bottom_right.0,
                radii.bottom_right.0,
                x > size.width.0 - radii.bottom_right.0 && y > size.height.0 - radii.bottom_right.0,
            ),
            (
                radii.bottom_left.0,
                size.height.0 - radii.bottom_left.0,
                radii.bottom_left.0,
                x < radii.bottom_left.0 && y > size.height.0 - radii.bottom_left.0,
            ),
        ] {
            if on && radius > 0.0 && (x - cx).hypot(y - cy) > radius {
                return false;
            }
        }
        return true;
    }
    let points = outline(Bounds::new(Point::default(), size), radii);
    let mut inside = false;
    for (a, b) in points
        .iter()
        .zip(points.iter().cycle().skip(1))
        .take(points.len())
    {
        if (a.1 > y) != (b.1 > y) && x < (b.0 - a.0) * (y - a.1) / (b.1 - a.1) + a.0 {
            inside = !inside;
        }
    }
    inside
}

fn outline(rect: Bounds<Points>, radii: CornerRadii) -> Vec<(f32, f32)> {
    if !valid_rect(rect) {
        return Vec::new();
    }
    let radii = radii.fit(rect.size);
    let mut points = Vec::new();
    let mut at = (0.0, 0.0);
    nsh_core::shape::rounded_rect(
        rect,
        radii.corners().map(|&radius| Size::new(radius, radius)),
        radii.continuous,
        false,
        &mut |segment| match segment {
            nsh_core::shape::Segment::Move(point) | nsh_core::shape::Segment::Line(point) => {
                at = (f64::from(point.x.0), f64::from(point.y.0));
                points.push((point.x.0, point.y.0));
            }
            nsh_core::shape::Segment::Cubic(controls) => {
                let [(x1, y1), (x2, y2), (x3, y3)] =
                    controls.map(|point| (f64::from(point.x.0), f64::from(point.y.0)));
                let (x0, y0) = at;
                for i in 1..=16 {
                    let t = f64::from(i) / 16.0;
                    let u = 1.0 - t;
                    points.push((
                        (u * u * u * x0
                            + 3.0 * u * u * t * x1
                            + 3.0 * u * t * t * x2
                            + t * t * t * x3) as f32,
                        (u * u * u * y0
                            + 3.0 * u * u * t * y1
                            + 3.0 * u * t * t * y2
                            + t * t * t * y3) as f32,
                    ));
                }
                at = (x3, y3);
            }
            nsh_core::shape::Segment::Close => {}
        },
    );
    points
}

fn expanded_radii(radii: CornerRadii, amount: Points) -> CornerRadii {
    CornerRadii {
        top_left: (radii.top_left + amount).max(Points::ZERO),
        top_right: (radii.top_right + amount).max(Points::ZERO),
        bottom_right: (radii.bottom_right + amount).max(Points::ZERO),
        bottom_left: (radii.bottom_left + amount).max(Points::ZERO),
        continuous: radii.continuous,
    }
}

fn project(matrix: &Matrix, x: f32, y: f32) -> Option<(f32, f32)> {
    crate::geometry::project(matrix, x, y)
}

fn unproject(matrix: &Matrix, x: f32, y: f32) -> Option<(f32, f32)> {
    let m = matrix.0;
    let (x, y) = (f64::from(x), f64::from(y));
    let (a, b, c, d) = (
        m[0] - x * m[3],
        m[4] - x * m[7],
        m[1] - y * m[3],
        m[5] - y * m[7],
    );
    let (e, f) = (x * m[15] - m[12], y * m[15] - m[13]);
    let det = a * d - b * c;
    if !det.is_finite() || det.abs() < 1e-9 {
        return None;
    }
    let point = (
        ((e * d - b * f) / det) as f32,
        ((a * f - e * c) / det) as f32,
    );
    (point.0.is_finite() && point.1.is_finite()).then_some(point)
}

fn transform_scale(matrix: &Matrix) -> f32 {
    let Some((x, y)) = project(matrix, 0.0, 0.0) else {
        return 1.0;
    };
    let (a, b) = (
        project(matrix, 1.0, 0.0).unwrap_or((x + 1.0, y)),
        project(matrix, 0.0, 1.0).unwrap_or((x, y + 1.0)),
    );
    ((a.0 - x).hypot(a.1 - y) * (b.0 - x).hypot(b.1 - y))
        .sqrt()
        .clamp(0.001, 1000.0)
}

fn transformed_bounds(matrix: &Matrix, rect: Bounds<Points>) -> Option<Bounds<Points>> {
    let mut bounds = (
        f32::INFINITY,
        f32::INFINITY,
        f32::NEG_INFINITY,
        f32::NEG_INFINITY,
    );
    for (x, y) in [
        (rect.origin.x.0, rect.origin.y.0),
        (rect.origin.x.0 + rect.size.width.0, rect.origin.y.0),
        (rect.origin.x.0, rect.origin.y.0 + rect.size.height.0),
        (
            rect.origin.x.0 + rect.size.width.0,
            rect.origin.y.0 + rect.size.height.0,
        ),
    ] {
        let (x, y) = project(matrix, x, y)?;
        bounds = (
            bounds.0.min(x),
            bounds.1.min(y),
            bounds.2.max(x),
            bounds.3.max(y),
        );
    }
    Some(Bounds::new(
        Point::new(Points(bounds.0), Points(bounds.1)),
        Size::new(Points(bounds.2 - bounds.0), Points(bounds.3 - bounds.1)),
    ))
}

fn contains(rect: Bounds<Points>, x: f32, y: f32) -> bool {
    x >= rect.origin.x.0
        && y >= rect.origin.y.0
        && x < rect.origin.x.0 + rect.size.width.0
        && y < rect.origin.y.0 + rect.size.height.0
}

fn premul(color: Color) -> [f32; 4] {
    let [r, g, b, a] = color_bytes(color);
    let a = f32::from(a) / 255.0;
    [
        f32::from(r) / 255.0 * a,
        f32::from(g) / 255.0 * a,
        f32::from(b) / 255.0 * a,
        a,
    ]
}
fn color_bytes(color: Color) -> [u8; 4] {
    [
        (color.0 >> 24) as u8,
        (color.0 >> 16) as u8,
        (color.0 >> 8) as u8,
        color.0 as u8,
    ]
}
fn with_alpha(color: Color, alpha: f32) -> Color {
    Color(
        (color.0 & 0xffff_ff00)
            | ((f32::from(color.0 as u8) * alpha.clamp(0.0, 1.0)).round() as u32),
    )
}

fn valid_rect(rect: Bounds<Points>) -> bool {
    [
        rect.origin.x.0,
        rect.origin.y.0,
        rect.size.width.0,
        rect.size.height.0,
    ]
    .iter()
    .all(|v| v.is_finite())
        && rect.size.width.0 > 0.0
        && rect.size.height.0 > 0.0
}

fn resample(source: &Raster, destination: &mut Raster) {
    for y in 0..destination.height {
        for x in 0..destination.width {
            let sample = source.sample(
                (x as f32 + 0.5) * source.width as f32 / destination.width as f32,
                (y as f32 + 0.5) * source.height as f32 / destination.height as f32,
            );
            put(destination, x, y, sample);
        }
    }
}

fn get(raster: &Raster, x: u32, y: u32) -> [f32; 4] {
    let i = (y as usize * raster.width as usize + x as usize) * 4;
    let a = raster.rgba[i + 3] as f32 / 255.0;
    [
        raster.rgba[i] as f32 / 255.0 * a,
        raster.rgba[i + 1] as f32 / 255.0 * a,
        raster.rgba[i + 2] as f32 / 255.0 * a,
        a,
    ]
}

fn put(raster: &mut Raster, x: u32, y: u32, pixel: [f32; 4]) {
    let i = (y as usize * raster.width as usize + x as usize) * 4;
    let alpha = pixel[3].clamp(0.0, 1.0);
    for (c, channel) in pixel.iter().take(3).enumerate() {
        raster.rgba[i + c] = if alpha > 0.0 {
            (channel / alpha * 255.0).round().clamp(0.0, 255.0) as u8
        } else {
            0
        };
    }
    raster.rgba[i + 3] = (alpha * 255.0).round() as u8;
}

fn composite_into(source: &Raster, destination: &mut Raster, opacity: f32, mode: BlendMode) {
    for y in 0..destination.height {
        for x in 0..destination.width {
            if source.rgba[(y as usize * source.width as usize + x as usize) * 4 + 3] == 0 {
                continue;
            }
            put(
                destination,
                x,
                y,
                blend::over(get(source, x, y), get(destination, x, y), opacity, mode),
            );
        }
    }
}

fn apply_mask(raster: &mut Raster, mask: &tiny_skia::Mask) {
    for (pixel, &mask) in raster
        .rgba
        .as_chunks_mut::<4>()
        .0
        .iter_mut()
        .zip(mask.data())
    {
        pixel[3] = ((u16::from(pixel[3]) * u16::from(mask) + 127) / 255) as u8;
    }
}

fn tint(raster: &mut Raster, color: Color) {
    for pixel in raster.rgba.as_chunks_mut::<4>().0 {
        pixel[0] = (color.0 >> 24) as u8;
        pixel[1] = (color.0 >> 16) as u8;
        pixel[2] = (color.0 >> 8) as u8;
        pixel[3] = ((u16::from(pixel[3]) * u16::from(color.0 as u8) + 127) / 255) as u8;
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{Effects, Filter, TransformKind};
    use ratatui::{layout::Rect as CellRect, style::Color as CellColor};

    use super::*;

    fn layer(id: NodeId, width: f32, height: f32, color: Color) -> Layer {
        Layer {
            id,
            size: Size::new(Points(width), Points(height)),
            transform: Matrix::IDENTITY,
            clip: Bounds::new(Point::default(), Size::new(Points(8.0), Points(8.0))),
            style: ViewStyle {
                background_color: color,
                ..ViewStyle::default()
            },
            images: Vec::new(),
            text: None,
            cells: None,
            overlay: None,
            children: Vec::new(),
        }
    }

    fn scene(root: Layer) -> Scene {
        let mut backdrop = Buffer::empty(CellRect::new(0, 0, 8, 8));
        for cell in &mut backdrop.content {
            cell.set_bg(CellColor::Rgb(255, 255, 255));
        }
        Scene {
            bounds: Bounds::new(Point::default(), Size::new(Points(8.0), Points(8.0))),
            root,
            backdrop,
            metrics: CellMetrics::new(Points(1.0), Points(1.0)).unwrap(),
            font_revision: 0,
            inherited_opacity: 1.0,
        }
    }

    fn rgba(raster: &Raster, x: usize, y: usize) -> [u8; 4] {
        raster.rgba[(y * raster.width as usize + x) * 4..][..4]
            .try_into()
            .unwrap()
    }

    #[test]
    fn raster_planes_bound_area_and_sides_before_allocation() {
        for (width, height) in [
            (f32::MAX, 1.0),
            (1.0, f32::MAX),
            (f32::MAX, f32::MIN_POSITIVE),
            (1_000_000.0, 1_000_000.0),
            (1280.0, 800.0),
        ] {
            let (width, height, scale) = raster_dimensions(
                Bounds::new(Point::default(), Size::new(Points(width), Points(height))),
                1.0,
            );
            assert!(width > 0 && width <= MAX_SIDE);
            assert!(height > 0 && height <= MAX_SIDE);
            assert!(u64::from(width) * u64::from(height) <= MAX_PIXELS);
            assert!(scale > 0.0 && scale.is_finite());
        }
    }

    #[test]
    fn opacity_is_applied_once_to_the_complete_overlapping_group() {
        let mut root = layer(1, 8.0, 8.0, Color::TRANSPARENT);
        root.style.opacity = 0.5;
        root.children.push(layer(2, 6.0, 6.0, Color(0xff00_00ff)));
        let mut blue = layer(3, 6.0, 6.0, Color(0x0000_ffff));
        blue.transform = Matrix::of(TransformKind::TranslateX, 2.0);
        root.children.push(blue);
        let raster = rasterize(&scene(root), &FontCatalog::default()).unwrap();
        assert_eq!(rgba(&raster, 1, 2), [255, 128, 128, 255]);
        assert_eq!(rgba(&raster, 3, 2), [128, 128, 255, 255]);
    }

    #[test]
    fn rounded_overflow_clips_descendant_pixels_and_matches_hit_geometry() {
        let mut root = layer(1, 8.0, 8.0, Color::TRANSPARENT);
        root.style.overflow_hidden = true;
        root.style.border_radius = Points(4.0);
        root.children.push(layer(2, 8.0, 8.0, Color(0xff00_00ff)));
        let raster = rasterize(&scene(root), &FontCatalog::default()).unwrap();
        assert_eq!(rgba(&raster, 0, 0), [255, 255, 255, 255]);
        assert_eq!(rgba(&raster, 4, 4), [255, 0, 0, 255]);
        assert!(!rounded_contains(
            Size::new(Points(8.0), Points(8.0)),
            CornerRadii::all(Points(4.0)),
            0.5,
            0.5
        ));
        assert!(rounded_contains(
            Size::new(Points(8.0), Points(8.0)),
            CornerRadii::all(Points(4.0)),
            4.5,
            4.5
        ));
        let continuous = CornerRadii {
            continuous: true,
            ..CornerRadii::all(Points(4.0))
        };
        assert!(!rounded_contains(
            Size::new(Points(8.0), Points(8.0)),
            continuous,
            0.1,
            0.1
        ));
        assert!(rounded_contains(
            Size::new(Points(8.0), Points(8.0)),
            continuous,
            4.0,
            4.0
        ));
    }

    #[test]
    fn transforms_rotate_actual_image_pixels_instead_of_stretching_bounds() {
        let mut root = layer(1, 2.0, 1.0, Color::TRANSPARENT);
        root.transform = Matrix::of(TransformKind::Rotate, 90.0)
            .mul(&Matrix::of(TransformKind::TranslateX, 4.0))
            .mul(&Matrix::of(TransformKind::TranslateY, 2.0));
        root.images.push(Image {
            raster: Arc::new(Raster {
                width: 2,
                height: 1,
                rgba: vec![255, 0, 0, 255, 0, 0, 255, 255],
            }),
            frame: Bounds::new(Point::default(), Size::new(Points(2.0), Points(1.0))),
            mode: ResizeMode::Stretch,
            tint: None,
            opacity: 1.0,
        });
        let raster = rasterize(&scene(root), &FontCatalog::default()).unwrap();
        assert_eq!(rgba(&raster, 3, 2), [255, 0, 0, 255]);
        assert_eq!(rgba(&raster, 3, 3), [0, 0, 255, 255]);
        assert_eq!(rgba(&raster, 4, 2), [255, 255, 255, 255]);
    }

    #[test]
    fn group_filters_cover_view_image_and_terminal_glyph_content_together() {
        let mut root = layer(1, 8.0, 8.0, Color::TRANSPARENT);
        root.style.effects = Some(Arc::new(Effects {
            filters: vec![Filter::Invert(1.0)],
            ..Effects::default()
        }));
        root.children.push(layer(2, 2.0, 2.0, Color(0xff00_00ff)));
        let mut image = layer(3, 2.0, 2.0, Color::TRANSPARENT);
        image.transform = Matrix::of(TransformKind::TranslateX, 3.0);
        image.images.push(Image {
            raster: Arc::new(Raster {
                width: 1,
                height: 1,
                rgba: vec![0, 255, 0, 255],
            }),
            frame: Bounds::new(Point::default(), Size::new(Points(2.0), Points(2.0))),
            mode: ResizeMode::Stretch,
            tint: None,
            opacity: 1.0,
        });
        root.children.push(image);
        let mut text = layer(4, 1.0, 1.0, Color::TRANSPARENT);
        text.transform = Matrix::of(TransformKind::TranslateX, 6.0);
        let mut glyph = Buffer::empty(CellRect::new(0, 0, 1, 1));
        glyph[(0, 0)]
            .set_symbol("█")
            .set_fg(CellColor::Rgb(0, 0, 255));
        text.cells = Some(glyph);
        root.children.push(text);
        let raster = rasterize(&scene(root), &FontCatalog::default()).unwrap();
        assert_eq!(rgba(&raster, 0, 0), [0, 255, 255, 255]);
        assert_eq!(rgba(&raster, 3, 0), [255, 0, 255, 255]);
        assert_eq!(rgba(&raster, 6, 0), [255, 255, 0, 255]);
    }

    #[test]
    fn backdrop_blur_samples_the_pixels_already_behind_the_group() {
        let mut root = layer(1, 8.0, 8.0, Color::TRANSPARENT);
        root.style.effects = Some(Arc::new(Effects {
            backdrop_filters: vec![Filter::Blur(Points(1.0))],
            ..Effects::default()
        }));
        let mut scene = scene(root);
        for y in 0..8 {
            for x in 0..4 {
                scene.backdrop[(x, y)].set_bg(CellColor::Rgb(0, 0, 0));
            }
        }
        let raster = rasterize(&scene, &FontCatalog::default()).unwrap();
        let left = rgba(&raster, 3, 4)[0];
        let right = rgba(&raster, 4, 4)[0];
        assert!(left > 0 && left < 128);
        assert!(right > 128 && right < 255);
    }

    #[test]
    fn rounded_content_clips_do_not_erase_outer_shadow_pixels() {
        let mut root = layer(1, 8.0, 8.0, Color::TRANSPARENT);
        let mut child = layer(2, 4.0, 4.0, Color(0xff00_00ff));
        child.transform = Matrix::of(TransformKind::TranslateX, 2.0)
            .mul(&Matrix::of(TransformKind::TranslateY, 2.0));
        child.style.overflow_hidden = true;
        child.style.border_radius = Points(1.0);
        child.style.effects = Some(Arc::new(Effects {
            box_shadows: vec![nsh_core::BoxShadow {
                color: Color::BLACK,
                offset_x: Points(2.0),
                offset_y: Points(0.0),
                blur: Points(0.0),
                spread: Points::ZERO,
                inset: false,
            }],
            ..Effects::default()
        }));
        root.children.push(child);
        let raster = rasterize(&scene(root), &FontCatalog::default()).unwrap();
        assert_eq!(rgba(&raster, 4, 4), [255, 0, 0, 255]);
        assert_eq!(rgba(&raster, 7, 4), [0, 0, 0, 255]);
    }

    #[test]
    fn failed_and_retired_jobs_never_republish_an_old_group_frame() {
        let snapshot = Arc::new(scene(layer(1, 8.0, 8.0, Color::BLACK)));
        let frame = Frame {
            bounds: snapshot.bounds,
            raster: Arc::new(Raster {
                width: 1,
                height: 1,
                rgba: vec![255, 0, 0, 255],
            }),
        };
        let mut cache = Cache::default();
        cache.entries.insert(
            1,
            Entry {
                scene: snapshot.clone(),
                sequence: 1,
                pending: true,
                retired: false,
                frame: Some(frame.clone()),
                used: 1,
            },
        );
        assert!(cache.complete(1, 1, Err("test allocation budget".into())));
        assert!(cache.entries[&1].frame.is_none());
        cache.entries.insert(
            1,
            Entry {
                scene: snapshot,
                sequence: 2,
                pending: true,
                retired: false,
                frame: Some(frame),
                used: 2,
            },
        );
        cache.invalidate(1);
        assert!(
            cache.pending(),
            "invalidation must still count outstanding work"
        );
        assert!(cache.complete(
            1,
            2,
            Ok(Raster {
                width: 1,
                height: 1,
                rgba: vec![255; 4]
            })
        ));
        assert!(!cache.entries.contains_key(&1));
        assert!(!cache.pending());
    }

    #[test]
    fn completed_frames_remain_available_while_the_next_animation_frame_encodes() {
        let fonts = FontCatalog::default();
        let graphics = Graphics::new(fonts);
        let mut cache = Cache::default();
        let first = scene(layer(1, 8.0, 8.0, Color(0xff00_00ff)));
        assert!(cache.request(1, first.clone(), &graphics).is_none());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while cache.pending() {
            assert!(std::time::Instant::now() < deadline);
            if let Some(crate::worker::GraphicsResult::Composite(id, sequence, result)) =
                graphics.poll()
            {
                cache.complete(id, sequence, result);
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let mut next = first;
        next.root.transform = Matrix::of(TransformKind::TranslateX, 1.0);
        let completed = cache
            .request(1, next, &graphics)
            .expect("the previous complete frame must remain drawable");
        assert_eq!(
            completed.bounds,
            Bounds::new(Point::default(), Size::new(Points(8.0), Points(8.0)))
        );
        assert_eq!(rgba(&completed.raster, 0, 0), [255, 0, 0, 255]);
        assert!(cache.pending());
    }
}

//! Terminal image protocols with bounded worker encoding. A surface opts in
//! using measured terminal cell pixels; this module never queries terminal IO.
//!
//! The static ratatui-image widget only writes encoded data into a buffer.
//! Layout, clipping, tint, opacity and background composition happen before
//! encoding, and overlapping foreground content keeps the half-block painter.

use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    sync::Arc,
};

use nsh_core::{Bounds, Color, NodeId, Points, ResizeMode};
use ratatui::{
    buffer::{Buffer, CellDiffOption},
    layout::{Rect as CellRect, Size},
    widgets::Widget,
};
pub use ratatui_image::picker::ProtocolType;
use ratatui_image::protocol::{Protocol, iterm2::Iterm2, kitty::Kitty, sixel::Sixel};

use crate::{
    CellMetrics,
    image::{Raster, fitted_frame, rgb},
    worker::Graphics,
};

const MAX_PIXELS: u64 = 8 << 20;
const MAX_ENTRIES: usize = 64;
const MAX_ENCODED_BYTES: usize = 64 << 20;

/// A terminal graphics protocol and its physical cell dimensions in pixels.
///
/// Embedding hosts supply their own detection results. Standalone applications
/// detect these capabilities before starting their terminal event reader.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ImageProtocol {
    kind: ProtocolType,
    cell_width: u16,
    cell_height: u16,
    tmux: bool,
}

impl ImageProtocol {
    /// Configures a protocol with finite, nonzero pixel dimensions per cell.
    pub fn new(kind: ProtocolType, cell_width: u16, cell_height: u16) -> Result<Self, String> {
        if cell_width == 0 || cell_height == 0 {
            return Err("terminal image cell dimensions must be nonzero".into());
        }
        Ok(Self {
            kind,
            cell_width,
            cell_height,
            tmux: false,
        })
    }

    /// Wraps protocol output for a tmux host that permits passthrough.
    pub fn with_tmux(mut self, tmux: bool) -> Self {
        self.tmux = tmux;
        self
    }

    /// The selected terminal image protocol.
    pub fn protocol_type(self) -> ProtocolType {
        self.kind
    }

    /// The physical width and height of one terminal cell, in pixels.
    pub fn cell_size(self) -> (u16, u16) {
        (self.cell_width, self.cell_height)
    }
}

/// Exact inputs for one encoding. Holding the raster makes pointer identity
/// safe across node deletion, cache eviction and allocator address reuse.
#[derive(Clone)]
pub(crate) struct Request {
    raster: Arc<Raster>,
    config: ImageProtocol,
    frame: Bounds<Points>,
    clip: Bounds<Points>,
    mode: ResizeMode,
    tint: Option<Color>,
    opacity: f32,
    metrics: CellMetrics,
    region: CellRect,
    origin: (u16, u16),
    /// Top and bottom RGB samples for each cell before the image is drawn.
    background: Vec<[[u8; 3]; 2]>,
    kitty_id: u32,
}

impl PartialEq for Request {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.raster, &other.raster)
            && self.config == other.config
            && self.frame == other.frame
            && self.clip == other.clip
            && self.mode == other.mode
            && self.tint == other.tint
            && self.opacity == other.opacity
            && self.metrics == other.metrics
            && self.region == other.region
            && self.origin == other.origin
            && self.background == other.background
            && self.kitty_id == other.kitty_id
    }
}

impl Request {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capture(
        raster: Arc<Raster>,
        config: ImageProtocol,
        frame: Bounds<Points>,
        clip: Bounds<Points>,
        mode: ResizeMode,
        tint: Option<Color>,
        opacity: f32,
        metrics: CellMetrics,
        area: CellRect,
        buffer: &Buffer,
    ) -> Option<Self> {
        if config.kind == ProtocolType::Halfblocks
            || raster.width == 0
            || raster.height == 0
            || raster.rgba.len() != raster.width as usize * raster.height as usize * 4
            || !opacity.is_finite()
            || opacity <= 0.0
        {
            return None;
        }
        let dest = fitted_frame(&raster, frame, mode);
        let left = frame
            .origin
            .x
            .max(clip.origin.x)
            .max(dest.origin.x)
            .max(Points::ZERO);
        let top = frame
            .origin
            .y
            .max(clip.origin.y)
            .max(dest.origin.y)
            .max(Points::ZERO);
        let right = (frame.origin.x + frame.size.width)
            .min(clip.origin.x + clip.size.width)
            .min(dest.origin.x + dest.size.width);
        let bottom = (frame.origin.y + frame.size.height)
            .min(clip.origin.y + clip.size.height)
            .min(dest.origin.y + dest.size.height);
        if ![left, top, right, bottom, dest.size.width, dest.size.height]
            .iter()
            .all(|n| n.is_finite())
            || right <= left
            || bottom <= top
        {
            return None;
        }
        let x0 = (left / metrics.width()).floor().min(f32::from(area.width)) as u16;
        let y0 = (top / metrics.height()).floor().min(f32::from(area.height)) as u16;
        let x1 = (right / metrics.width()).ceil().min(f32::from(area.width)) as u16;
        let y1 = (bottom / metrics.height())
            .ceil()
            .min(f32::from(area.height)) as u16;
        let region = CellRect::new(
            area.x + x0,
            area.y + y0,
            x1.saturating_sub(x0),
            y1.saturating_sub(y0),
        );
        // ratatui-image 11's Kitty placeholder table has 297 rows/columns.
        if region.is_empty()
            || (config.kind == ProtocolType::Kitty && (region.width > 297 || region.height > 297))
            || u64::from(region.width)
                * u64::from(config.cell_width)
                * u64::from(region.height)
                * u64::from(config.cell_height)
                > MAX_PIXELS
        {
            return None;
        }
        let mut background =
            Vec::with_capacity(usize::from(region.width) * usize::from(region.height));
        for y in region.y..region.bottom() {
            for x in region.x..region.right() {
                let cell = buffer.cell((x, y))?;
                if cell.diff_option != CellDiffOption::None || !cell.modifier.is_empty() {
                    return None;
                }
                let colors = match cell.symbol() {
                    " " => [rgb(cell.bg); 2],
                    "▀" => [rgb(cell.fg), rgb(cell.bg)],
                    "▄" => [rgb(cell.bg), rgb(cell.fg)],
                    "█" => [rgb(cell.fg); 2],
                    // Encoding an opaque raster would erase text outside the
                    // true pixel clip; keep the ordinary painter in that case.
                    _ => return None,
                };
                background.push(colors);
            }
        }
        Some(Self {
            raster,
            config,
            frame,
            clip,
            mode,
            tint,
            opacity: opacity.clamp(0.0, 1.0),
            metrics,
            region,
            origin: (area.x, area.y),
            background,
            kitty_id: 0,
        })
    }

    pub(crate) fn region(&self) -> CellRect {
        self.region
    }

    /// Composes a cell-aligned, opaque texture. Pixel clips can be fractional;
    /// their untouched pixels retain the captured background samples.
    fn pixels(&self) -> Result<image::DynamicImage, String> {
        let (cw, ch) = (
            u32::from(self.config.cell_width),
            u32::from(self.config.cell_height),
        );
        let (width, height) = (
            u32::from(self.region.width) * cw,
            u32::from(self.region.height) * ch,
        );
        if u64::from(width) * u64::from(height) > MAX_PIXELS {
            return Err("terminal image protocol exceeds 8 million pixels".into());
        }
        let dest = fitted_frame(&self.raster, self.frame, self.mode);
        let left = self
            .frame
            .origin
            .x
            .max(self.clip.origin.x)
            .max(dest.origin.x);
        let top = self
            .frame
            .origin
            .y
            .max(self.clip.origin.y)
            .max(dest.origin.y);
        let right = (self.frame.origin.x + self.frame.size.width)
            .min(self.clip.origin.x + self.clip.size.width)
            .min(dest.origin.x + dest.size.width);
        let bottom = (self.frame.origin.y + self.frame.size.height)
            .min(self.clip.origin.y + self.clip.size.height)
            .min(dest.origin.y + dest.size.height);
        let tint = self.tint.map(|color| {
            let (r, g, b, a) = color.to_f64();
            [r as f32, g as f32, b as f32, a as f32]
        });
        let mut pixels = image::RgbaImage::new(width, height);
        for y in 0..height {
            let row = y / ch;
            let half = usize::from((y % ch) * 2 >= ch);
            let py = (f32::from(self.region.y - self.origin.1) + (y as f32 + 0.5) / ch as f32)
                * self.metrics.height();
            for x in 0..width {
                let column = x / cw;
                let bg =
                    self.background[(row * u32::from(self.region.width) + column) as usize][half];
                let px = (f32::from(self.region.x - self.origin.0) + (x as f32 + 0.5) / cw as f32)
                    * self.metrics.width();
                let mut source = [0.0; 4];
                if px >= left && px < right && py >= top && py < bottom {
                    source = self.raster.sample(
                        (px - dest.origin.x) / dest.size.width * self.raster.width as f32,
                        (py - dest.origin.y) / dest.size.height * self.raster.height as f32,
                    );
                    if let Some([r, g, b, a]) = tint {
                        source = [
                            r * source[3] * a,
                            g * source[3] * a,
                            b * source[3] * a,
                            source[3] * a,
                        ];
                    }
                }
                let mut out = [0, 0, 0, 255];
                for k in 0..3 {
                    out[k] = (source[k] * self.opacity * 255.0
                        + f32::from(bg[k]) * (1.0 - source[3] * self.opacity))
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
                pixels.put_pixel(x, y, image::Rgba(out));
            }
        }
        Ok(image::DynamicImage::ImageRgba8(pixels))
    }
}

pub(crate) struct Encoded {
    protocol: Protocol,
    bytes: usize,
}

impl Encoded {
    fn render(&self, area: CellRect, buffer: &mut Buffer) {
        ratatui_image::Image::new(&self.protocol).render(area, buffer);
    }
}

/// Encodes once on a graphics worker; drawing the result does no encoding IO.
pub(crate) fn encode(request: &Request) -> Result<Encoded, String> {
    let image = request.pixels()?;
    let size = Size::new(request.region.width, request.region.height);
    let pixel_bytes = image.as_bytes().len();
    let protocol = match request.config.kind {
        ProtocolType::Kitty => {
            if request.kitty_id == 0 {
                return Err("Kitty images need a retained surface identifier".into());
            }
            Protocol::Kitty(
                Kitty::new(image, size, request.kitty_id, request.config.tmux, false)
                    .map_err(|e| e.to_string())?,
            )
        }
        ProtocolType::Sixel => Protocol::Sixel(
            Sixel::new(image, size, request.config.tmux).map_err(|e| e.to_string())?,
        ),
        ProtocolType::Iterm2 => Protocol::ITerm2(
            Iterm2::new(image, size, request.config.tmux).map_err(|e| e.to_string())?,
        ),
        ProtocolType::Halfblocks => {
            return Err("half blocks use the ordinary raster painter".into());
        }
    };
    let bytes = match &protocol {
        Protocol::Sixel(sixel) => sixel.data.len(),
        Protocol::ITerm2(iterm) => iterm.data.len(),
        // Kitty's private buffer stores chunked base64 RGBA plus control
        // headers; a conservative bound keeps the per-surface cache finite.
        Protocol::Kitty(_) => pixel_bytes.saturating_mul(2).saturating_add(1024),
        Protocol::Halfblocks(_) => 0,
    };
    if bytes > MAX_ENCODED_BYTES {
        return Err("terminal image encoding exceeds 64 MiB".into());
    }
    Ok(Encoded { protocol, bytes })
}

struct Entry {
    slot: usize,
    wanted: Request,
    loading: Option<(u64, Request)>,
    ready: Option<Arc<Encoded>>,
    failed: bool,
}

/// Cache state belongs to one surface. Render requests are cheap channel
/// sends; completed encodings are accepted only for the exact retained input.
#[derive(Default)]
pub(crate) struct Images {
    config: Cell<Option<ImageProtocol>>,
    sequence: Cell<u64>,
    entries: RefCell<HashMap<NodeId, Entry>>,
    ids: RefCell<Vec<u32>>,
    routes: Cell<[bool; 2]>,
}

impl Images {
    pub(crate) fn configure(&self, config: Option<ImageProtocol>) {
        let mut config = config.filter(|c| c.kind != ProtocolType::Halfblocks);
        if let Some(current) = config.filter(|c| c.kind == ProtocolType::Kitty) {
            if self.ids.borrow().is_empty() {
                let mut ids = Vec::with_capacity(MAX_ENTRIES);
                while ids.len() < MAX_ENTRIES {
                    let mut bytes = [0; 4];
                    if let Err(error) = getrandom::fill(&mut bytes) {
                        log::warn!("terminal image identifiers unavailable: {error}");
                        config = None;
                        break;
                    }
                    let id = u32::from_ne_bytes(bytes);
                    if id != 0 && !ids.contains(&id) {
                        ids.push(id);
                    }
                }
                if config.is_some() {
                    *self.ids.borrow_mut() = ids;
                }
            }
            if config.is_some() {
                let mut routes = self.routes.get();
                routes[usize::from(current.tmux)] = true;
                self.routes.set(routes);
            }
        }
        if self.config.replace(config) != config {
            self.entries.borrow_mut().clear();
        }
    }

    pub(crate) fn config(&self) -> Option<ImageProtocol> {
        self.config.get()
    }

    pub(crate) fn reset_entries(&self) {
        self.entries.borrow_mut().clear();
    }

    /// The host writes this before releasing its terminal. Keeping the ID
    /// pool across scene reloads makes this cleanup string stable.
    pub(crate) fn cleanup(&self) -> String {
        use std::fmt::Write as _;
        let mut output = String::new();
        for (tmux, used) in self.routes.get().into_iter().enumerate() {
            if !used {
                continue;
            }
            let (start, escape, end) =
                ratatui_image::picker::cap_parser::Parser::tmux_start_escape_end(tmux != 0);
            for id in self.ids.borrow().iter() {
                let _ = write!(
                    output,
                    "{start}{escape}_Ga=d,d=I,i={id},q=2;{escape}\\{end}"
                );
            }
        }
        output
    }

    pub(crate) fn retain(&self, ids: &[NodeId]) {
        self.entries.borrow_mut().retain(|id, _| ids.contains(id));
    }

    pub(crate) fn pending(&self) -> bool {
        self.entries
            .borrow()
            .values()
            .any(|entry| entry.loading.is_some())
    }

    pub(crate) fn paint(
        &self,
        id: NodeId,
        mut request: Request,
        graphics: &Graphics,
        buffer: &mut Buffer,
    ) -> bool {
        let mut entries = self.entries.borrow_mut();
        if !entries.contains_key(&id) {
            if entries.len() >= MAX_ENTRIES {
                return false;
            }
            let slot = (0..MAX_ENTRIES)
                .find(|slot| entries.values().all(|entry| entry.slot != *slot))
                .expect("bounded protocol slots");
            entries.insert(
                id,
                Entry {
                    slot,
                    wanted: request.clone(),
                    loading: None,
                    ready: None,
                    failed: false,
                },
            );
        }
        let entry = entries.get_mut(&id).expect("retained protocol entry");
        if request.config.kind == ProtocolType::Kitty {
            let Some(id) = self.ids.borrow().get(entry.slot).copied() else {
                return false;
            };
            request.kitty_id = id;
        }
        if entry.wanted != request {
            entry.wanted = request;
            entry.ready = None;
            entry.failed = false;
        }
        if let Some(ready) = &entry.ready {
            ready.render(entry.wanted.region, buffer);
            return true;
        }
        if entry.loading.is_none() && !entry.failed {
            let sequence = self.sequence.get().wrapping_add(1);
            self.sequence.set(sequence);
            graphics.protocol(id, sequence, entry.wanted.clone());
            entry.loading = Some((sequence, entry.wanted.clone()));
        }
        false
    }

    pub(crate) fn complete(&self, id: NodeId, sequence: u64, result: Result<Encoded, String>) {
        let mut entries = self.entries.borrow_mut();
        let total: usize = entries
            .values()
            .filter_map(|e| e.ready.as_ref())
            .map(|e| e.bytes)
            .sum();
        let Some(entry) = entries.get_mut(&id) else {
            return;
        };
        if entry
            .loading
            .as_ref()
            .is_none_or(|(pending, _)| *pending != sequence)
        {
            return;
        }
        let (_, request) = entry.loading.take().expect("matching encoding in flight");
        if request != entry.wanted {
            return;
        }
        match result {
            Ok(encoded) if total.saturating_add(encoded.bytes) <= MAX_ENCODED_BYTES => {
                entry.ready = Some(Arc::new(encoded))
            }
            Ok(_) => entry.failed = true,
            Err(error) => {
                log::debug!("terminal image encoding: {error}");
                entry.failed = true;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::{point, px};
    use ratatui::style::Color as CellColor;

    use super::*;

    fn request(kind: ProtocolType) -> Request {
        let area = CellRect::new(3, 2, 2, 2);
        let mut buffer = Buffer::empty(area);
        for cell in &mut buffer.content {
            cell.set_bg(CellColor::Rgb(0, 255, 0));
        }
        let mut request = Request::capture(
            Arc::new(Raster {
                width: 1,
                height: 1,
                rgba: vec![255, 0, 0, 128],
            }),
            ImageProtocol::new(kind, 8, 16).unwrap(),
            Bounds::new(
                point(px(0.0), px(0.0)),
                nsh_core::Size::new(px(16.0), px(32.0)),
            ),
            Bounds::new(
                point(px(0.0), px(0.0)),
                nsh_core::Size::new(px(16.0), px(32.0)),
            ),
            ResizeMode::Stretch,
            None,
            0.5,
            CellMetrics::default(),
            area,
            &buffer,
        )
        .unwrap();
        request.kitty_id = 42;
        request
    }

    #[test]
    fn protocol_pixels_compose_tint_opacity_clipping_and_embedding_origin() {
        let mut request = request(ProtocolType::Iterm2);
        request.clip.size.height = px(8.0);
        request.tint = Some(Color(0x0000_ffff));
        let image = request.pixels().unwrap().into_rgba8();
        assert_eq!(image.dimensions(), (16, 32));
        assert_eq!(image.get_pixel(0, 0).0, [0, 191, 64, 255]);
        assert_eq!(image.get_pixel(0, 10).0, [0, 255, 0, 255]);
    }

    #[test]
    fn each_graphics_protocol_encodes_and_renders_a_static_widget() {
        for kind in [
            ProtocolType::Kitty,
            ProtocolType::Sixel,
            ProtocolType::Iterm2,
        ] {
            let request = request(kind);
            let encoded = encode(&request).unwrap();
            let mut buffer = Buffer::empty(request.region);
            encoded.render(request.region, &mut buffer);
            assert!(
                buffer
                    .content
                    .iter()
                    .any(|cell| cell.symbol().contains('\u{1b}'))
            );
            assert!(
                buffer
                    .content
                    .iter()
                    .any(|cell| cell.diff_option != CellDiffOption::None)
            );
        }
    }

    #[test]
    fn stale_encoding_cannot_replace_a_new_geometry_or_raster() {
        let state = Images::default();
        let config = ImageProtocol::new(ProtocolType::Iterm2, 8, 16).unwrap();
        state.configure(Some(config));
        let graphics = Graphics::new(crate::fonts::FontCatalog::default());
        let request = request(ProtocolType::Iterm2);
        let mut buffer = Buffer::empty(request.region);
        assert!(!state.paint(2, request.clone(), &graphics, &mut buffer));
        let sequence = state.entries.borrow()[&2].loading.as_ref().unwrap().0;
        let mut newer = request.clone();
        newer.opacity = 0.75;
        assert!(!state.paint(2, newer, &graphics, &mut buffer));
        state.complete(2, sequence, encode(&request));
        assert!(state.entries.borrow()[&2].ready.is_none());
        assert!(!state.pending());
        state.configure(None);
        state.complete(2, sequence, encode(&request));
        assert!(state.entries.borrow().is_empty());
    }

    #[test]
    fn invalid_cell_sizes_and_text_underlays_keep_the_half_block_path() {
        assert!(ImageProtocol::new(ProtocolType::Kitty, 0, 16).is_err());
        let original = request(ProtocolType::Kitty);
        let mut buffer = Buffer::empty(original.region);
        buffer[(3, 2)].set_symbol("T");
        assert!(
            Request::capture(
                original.raster,
                original.config,
                original.frame,
                original.clip,
                original.mode,
                None,
                1.0,
                original.metrics,
                original.region,
                &buffer
            )
            .is_none()
        );
    }

    #[test]
    fn kitty_identifiers_are_bounded_reused_and_available_for_host_cleanup() {
        let state = Images::default();
        state.configure(Some(
            ImageProtocol::new(ProtocolType::Kitty, 8, 16).unwrap(),
        ));
        let initial_cleanup = state.cleanup();
        assert_eq!(initial_cleanup.matches("a=d,d=I").count(), MAX_ENTRIES);
        let graphics = Graphics::new(crate::fonts::FontCatalog::default());
        let request = request(ProtocolType::Kitty);
        let mut buffer = Buffer::empty(request.region);
        state.paint(2, request.clone(), &graphics, &mut buffer);
        let original = state.entries.borrow()[&2].wanted.kitty_id;
        let mut next = request.clone();
        next.opacity = 0.75;
        state.paint(2, next, &graphics, &mut buffer);
        assert_eq!(state.entries.borrow()[&2].wanted.kitty_id, original);
        assert_eq!(state.cleanup(), initial_cleanup);
        state.retain(&[]);
        state.paint(4, request, &graphics, &mut buffer);
        assert_eq!(state.entries.borrow()[&4].wanted.kitty_id, original);
        assert_eq!(state.ids.borrow().len(), MAX_ENTRIES);
        state.configure(None);
        assert_eq!(state.cleanup(), initial_cleanup);
    }
}

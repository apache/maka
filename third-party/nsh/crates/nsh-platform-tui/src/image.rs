//! `<Image>` loading, half-block fallback, and background Sixel encoding.

use std::{
    collections::HashMap,
    io::Cursor,
    num::NonZeroU16,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use image::{AnimationDecoder, GenericImageView, imageops::FilterType};
use nsh_core::{
    Color as CoreColor, EventKind, EventMask, EventPayload, ImageData, ImageOptions, ImageSource,
    NodeId, ObjectPosition, PayloadValue, Points, ROOT_ID, ResizeMode, Size, ViewStyle,
    access::Access,
    blur_radius,
    geometry::{Bounds, DevicePixels},
    image::{
        DiskCache, Frames, Images, Key, Lease, Natural, Request, Target, Want, budget,
        loader::{AssetBase, Context, Priority, ReadAsset, Ticket, loader},
    },
};
use ratatui_core::{
    buffer::{Buffer, CellDiffOption},
    layout::Rect,
    style::Color,
};

use crate::{
    CellSize, ColorDepth,
    geometry::CellBounds,
    surface::{Message, Sink},
};

const MAX_DIMENSION: u32 = 8192;
const MAX_FRAMES: usize = 600;
const MAX_ANIMATION_BYTES: usize = 48 << 20;

static NEXT_SURFACE_ID: AtomicU64 = AtomicU64::new(1);

/// How `<Image>` renders into a terminal cell grid.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProtocolType {
    /// Two vertical pixels per cell via `▀` (`U+2580`).
    Halfblocks,
    /// Pixel graphics encoded as DEC SIXEL escape sequences.
    Sixel,
}

/// Terminal image protocol and cell pixel geometry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ImageProtocol {
    kind: ProtocolType,
    cell_width: NonZeroU16,
    cell_height: NonZeroU16,
    tmux: bool,
}

impl ImageProtocol {
    /// Creates a protocol using measured non-zero pixel dimensions per cell.
    pub fn new(kind: ProtocolType, cell_width: u16, cell_height: u16) -> Result<Self, String> {
        let cell_width = NonZeroU16::new(cell_width)
            .ok_or_else(|| "terminal cell width in pixels must be non-zero".to_owned())?;
        let cell_height = NonZeroU16::new(cell_height)
            .ok_or_else(|| "terminal cell height in pixels must be non-zero".to_owned())?;
        Ok(Self {
            kind,
            cell_width,
            cell_height,
            tmux: false,
        })
    }

    /// Universal Unicode half-block fallback (8 × 16 virtual pixels per cell).
    #[must_use]
    pub const fn halfblocks() -> Self {
        Self {
            kind: ProtocolType::Halfblocks,
            cell_width: NonZeroU16::new(8).unwrap(),
            cell_height: NonZeroU16::new(16).unwrap(),
            tmux: false,
        }
    }

    /// Wraps SIXEL output in tmux DCS passthrough (`\x1bPtmux;...\x1b\\`).
    #[must_use]
    pub const fn with_tmux(mut self, tmux: bool) -> Self {
        self.tmux = tmux;
        self
    }

    /// Returns the active terminal graphics protocol kind.
    #[must_use]
    pub const fn protocol_type(self) -> ProtocolType {
        self.kind
    }

    /// Returns the pixel dimensions `(width, height)` of one terminal cell.
    #[must_use]
    pub const fn cell_size(self) -> (u16, u16) {
        (self.cell_width.get(), self.cell_height.get())
    }

    /// Returns whether SIXEL output is wrapped in tmux DCS passthrough.
    #[must_use]
    pub const fn tmux(self) -> bool {
        self.tmux
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ImageMount {
    pub(crate) source: Option<ImageSource>,
    pub(crate) resize_mode: ResizeMode,
    pub(crate) options: ImageOptions,
}

#[derive(Clone)]
pub(crate) struct Raster {
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// Straight RGBA8 (`width * height * 4`).
    pub(crate) rgba: Vec<u8>,
}

#[derive(Clone)]
pub(crate) struct DecodedPicture {
    frames: Vec<Arc<Raster>>,
    delays: Vec<Duration>,
    total_ms: u64,
    natural: Natural,
}

impl DecodedPicture {
    fn single(raster: Raster, natural: Natural) -> Self {
        Self {
            frames: vec![Arc::new(raster)],
            delays: Vec::new(),
            total_ms: 0,
            natural,
        }
    }

    fn is_animated(&self) -> bool {
        self.frames.len() > 1 && self.total_ms > 0
    }

    fn frame_at(&self, elapsed: Duration) -> (usize, Option<Duration>) {
        if !self.is_animated() {
            return (0, None);
        }
        let cycle_ms = self.total_ms.max(1);
        let pos_ms = (elapsed.as_millis() as u64) % cycle_ms;
        let mut acc = 0u64;
        for (idx, delay) in self.delays.iter().enumerate() {
            let d = (delay.as_millis() as u64).max(20);
            if pos_ms < acc + d {
                let rem = Duration::from_millis((acc + d) - pos_ms);
                return (idx, Some(rem));
            }
            acc += d;
        }
        (0, Some(Duration::from_millis(20)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct SixelKey {
    load_id: u64,
    frame_idx: usize,
    width_px: u32,
    height_px: u32,
    fit_w: u32,
    fit_h: u32,
    placed_x: u32,
    placed_y: u32,
    placed_w: u32,
    placed_h: u32,
    bg: [u8; 3],
    tint: Option<[u8; 4]>,
    alpha_q8: u8,
    blur_q4: u16,
    tmux: bool,
}

enum SixelSlot {
    Pending(SixelKey),
    Ready(SixelKey, String),
}

struct ViewEntry {
    source_uri: Option<Arc<str>>,
    key: Option<Key>,
    load_id: u64,
    ticket: Option<Ticket>,
    picture: Option<DecodedPicture>,
    _lease: Option<Lease>,
    loaded_at: Option<Instant>,
    fade_ms: u32,
    anim_origin: Instant,
    sixel: Option<SixelSlot>,
}

pub(crate) struct SixelCandidate {
    pub(crate) id: NodeId,
    pub(crate) region: Rect,
    pub(crate) hit_index: usize,
    checksum: u64,
    key: SixelKey,
    raster: Arc<Raster>,
}

pub(crate) struct ImageStore {
    surface_id: u64,
    protocol: Option<ImageProtocol>,
    asset_base: Option<AssetBase>,
    read_asset: Option<ReadAsset>,
    access: Arc<Access>,
    media_files: Arc<nsh_core::access::MediaFiles>,
    disk: Option<DiskCache>,
    entries: HashMap<NodeId, ViewEntry>,
    next_load_id: u64,
}

impl Default for ImageStore {
    fn default() -> Self {
        Self {
            surface_id: NEXT_SURFACE_ID.fetch_add(1, Ordering::Relaxed),
            protocol: None,
            asset_base: None,
            read_asset: None,
            access: Arc::default(),
            media_files: Arc::default(),
            disk: None,
            entries: HashMap::new(),
            next_load_id: 1,
        }
    }
}

static IMAGES: LazyLock<Images<DecodedPicture>> =
    LazyLock::new(|| Images::new(budget(), decode_image));

struct SixelJob {
    surface_id: u64,
    sink: Sink,
    id: NodeId,
    key: SixelKey,
    raster: Arc<Raster>,
}

static SIXEL_QUEUE: LazyLock<crossbeam_channel::Sender<SixelJob>> = LazyLock::new(|| {
    let (tx, rx) = crossbeam_channel::unbounded::<SixelJob>();
    for idx in 0..2 {
        let rx = rx.clone();
        let _ = std::thread::Builder::new()
            .name(format!("nsh-tui-sixel-{idx}"))
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut latest: HashMap<(u64, NodeId), SixelJob> = HashMap::new();
                    latest.insert((first.surface_id, first.id), first);
                    while let Ok(next) = rx.try_recv() {
                        latest.insert((next.surface_id, next.id), next);
                    }
                    for (_, job) in latest {
                        if let Some(sixel) = encode_sixel_job(&job) {
                            job.sink.send(Message::SixelEncoded {
                                id: job.id,
                                key: job.key,
                                sixel,
                            });
                        }
                    }
                }
            });
    }
    tx
});

fn unpremultiply_rgba(mut pixels: Vec<u8>) -> Vec<u8> {
    for px in pixels.chunks_exact_mut(4) {
        let a = u32::from(px[3]);
        if a > 0 && a < 255 {
            px[0] = ((u32::from(px[0]) * 255 + a / 2) / a).min(255) as u8;
            px[1] = ((u32::from(px[1]) * 255 + a / 2) / a).min(255) as u8;
            px[2] = ((u32::from(px[2]) * 255 + a / 2) / a).min(255) as u8;
        }
    }
    pixels
}

fn scale_rgba(width: u32, height: u32, rgba: Vec<u8>, longest: u32) -> (u32, u32, Vec<u8>) {
    let max_side = if longest == 0 {
        MAX_DIMENSION
    } else {
        longest.min(MAX_DIMENSION)
    };
    if width.max(height) <= max_side {
        return (width, height, rgba);
    }
    let Some(img) = image::RgbaImage::from_raw(width, height, rgba) else {
        return (width, height, Vec::new());
    };
    let resized =
        image::DynamicImage::ImageRgba8(img).resize(max_side, max_side, FilterType::Triangle);
    let out = resized.to_rgba8();
    let (rw, rh) = out.dimensions();
    (rw, rh, out.into_raw())
}

fn decode_frames<'a, D: AnimationDecoder<'a>>(
    decoder: D,
    orig_w: u32,
    orig_h: u32,
    longest: u32,
) -> Option<(DecodedPicture, Natural, usize)> {
    let mut frames = Vec::new();
    let mut delays = Vec::new();
    let mut total_bytes = 0usize;
    let mut total_ms = 0u64;
    for frame in decoder.into_frames() {
        let Ok(frame) = frame else {
            break;
        };
        let (num, denom) = frame.delay().numer_denom_ms();
        let raw_ms = if denom == 0 {
            100
        } else {
            u64::from(num) / u64::from(denom)
        };
        let ms = if raw_ms < 20 { 100 } else { raw_ms };
        let buffer = frame.into_buffer();
        let (fw, fh) = buffer.dimensions();
        let (rw, rh, rgba) = scale_rgba(fw, fh, buffer.into_raw(), longest);
        if rgba.is_empty() {
            break;
        }
        let bytes = rgba.len();
        if !frames.is_empty()
            && (frames.len() >= MAX_FRAMES || total_bytes + bytes > MAX_ANIMATION_BYTES)
        {
            break;
        }
        total_bytes += bytes;
        total_ms += ms;
        frames.push(Arc::new(Raster {
            width: rw,
            height: rh,
            rgba,
        }));
        delays.push(Duration::from_millis(ms));
    }
    if frames.is_empty() {
        return None;
    }
    let natural = Natural::Pixels(orig_w.max(1), orig_h.max(1));
    if frames.len() == 1 {
        delays.clear();
        total_ms = 0;
    }
    Some((
        DecodedPicture {
            frames,
            delays,
            total_ms,
            natural,
        },
        natural,
        total_bytes,
    ))
}

fn decode_image(
    bytes: &ImageData,
    target: &Target,
) -> Result<(DecodedPicture, Natural, usize), String> {
    let raw = bytes.bytes();
    if nsh_core::svg::sniff(raw) {
        let side = if target.longest == 0 {
            nsh_core::svg::MAX_OVERSAMPLED_SIDE
        } else {
            target.longest.clamp(1, nsh_core::svg::MAX_SIDE)
        };
        let svg = nsh_core::svg::rasterize(raw, side).map_err(|e| e.to_string())?;
        let rgba = unpremultiply_rgba(svg.pixels);
        let cost = rgba.len();
        let natural = Natural::Vector(svg.size);
        let raster = Raster {
            width: svg.width,
            height: svg.height,
            rgba,
        };
        return Ok((DecodedPicture::single(raster, natural), natural, cost));
    }

    if target.frames == Frames::All {
        if raw.starts_with(b"GIF87a") || raw.starts_with(b"GIF89a") {
            if let Ok(gif) = image::codecs::gif::GifDecoder::new(Cursor::new(raw)) {
                let (w, h) = image::ImageDecoder::dimensions(&gif);
                if let Some(anim) = decode_frames(gif, w, h, target.longest) {
                    return Ok(anim);
                }
            }
        } else if raw.len() >= 12
            && &raw[0..4] == b"RIFF"
            && &raw[8..12] == b"WEBP"
            && let Ok(webp) = image::codecs::webp::WebPDecoder::new(Cursor::new(raw))
            && webp.has_animation()
        {
            let (w, h) = image::ImageDecoder::dimensions(&webp);
            if let Some(anim) = decode_frames(webp, w, h, target.longest) {
                return Ok(anim);
            }
        }
    }

    let decoded = image::load_from_memory(raw).map_err(|e| e.to_string())?;
    let (orig_w, orig_h) = decoded.dimensions();
    if orig_w == 0 || orig_h == 0 {
        return Err("image has zero dimensions".to_owned());
    }
    let rgba8 = decoded.to_rgba8();
    let (rw, rh, rgba) = scale_rgba(orig_w, orig_h, rgba8.into_raw(), target.longest);
    if rgba.is_empty() {
        return Err("failed to scale image".to_owned());
    }
    let cost = rgba.len();
    let natural = Natural::Pixels(orig_w, orig_h);
    let raster = Raster {
        width: rw,
        height: rh,
        rgba,
    };
    Ok((DecodedPicture::single(raster, natural), natural, cost))
}

pub(crate) fn reported_size(natural: Natural) -> Size<DevicePixels> {
    match natural {
        Natural::Vector(points) => nsh_core::svg::reported_size(points),
        Natural::Pixels(w, h) => Size::new(DevicePixels(w as i32), DevicePixels(h as i32)),
    }
}

fn fade_duration_ms(options: &ImageOptions) -> u32 {
    options.fade_ms.map_or(0, |ms| ms.max(0.0).round() as u32)
}

impl ImageStore {
    pub(crate) fn protocol(&self) -> Option<ImageProtocol> {
        self.protocol
    }

    pub(crate) fn set_protocol(&mut self, protocol: Option<ImageProtocol>) -> bool {
        if self.protocol == protocol {
            return false;
        }
        self.protocol = protocol;
        for entry in self.entries.values_mut() {
            entry.sixel = None;
        }
        true
    }

    pub(crate) fn set_resources(
        &mut self,
        assets: Option<Arc<dyn nsh_engine::Assets>>,
        access: Arc<Access>,
        media_files: Arc<nsh_core::access::MediaFiles>,
        disk: Option<DiskCache>,
    ) {
        self.asset_base = assets.as_ref().and_then(|a| a.base());
        self.read_asset = assets.map(|a| ReadAsset::new(move |uri: &str| a.read(uri)));
        self.access = access;
        self.media_files = media_files;
        self.disk = disk;
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
    }

    pub(crate) fn remove(&mut self, id: NodeId) {
        self.entries.remove(&id);
    }

    fn context(&self, uri: &str) -> Context {
        let remote = uri.starts_with("http://") || uri.starts_with("https://");
        Context {
            asset_base: self.asset_base.clone(),
            read_asset: self.read_asset.clone(),
            access: self.access.clone(),
            media_files: self.media_files.clone(),
            disk: remote.then(|| self.disk.clone()).flatten(),
            transport: None,
        }
    }

    fn scale_for_cells(&self, cells: CellSize) -> f32 {
        let Some(protocol) = self.protocol else {
            return 1.0;
        };
        let (cw, ch) = protocol.cell_size();
        let sx = f32::from(cw) / cells.width().0.max(1.0);
        let sy = f32::from(ch) / cells.height().0.max(1.0);
        sx.max(sy).max(1.0)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn sync_view(
        &mut self,
        id: NodeId,
        mount: Option<&ImageMount>,
        frame_size: Size<Points>,
        events: EventMask,
        cells: CellSize,
        sink: &Sink,
        control: Option<&nsh_engine::EngineControl>,
    ) {
        let wants_events = events.contains(EventKind::LoadStart)
            || events.contains(EventKind::Progress)
            || events.contains(EventKind::Load)
            || events.contains(EventKind::Error)
            || events.contains(EventKind::LoadEnd);
        if self.protocol.is_none() && !wants_events {
            return;
        }
        let Some(mount) = mount else {
            self.entries.remove(&id);
            return;
        };
        let Some(source) = mount.source.as_ref().filter(|s| !s.uri.is_empty()) else {
            self.entries.remove(&id);
            return;
        };

        let context = self.context(&source.uri);
        let Some(location) = context.locate(source) else {
            let load_id = self.alloc_load_id();
            self.entries.insert(
                id,
                ViewEntry {
                    source_uri: Some(source.uri.clone()),
                    key: None,
                    load_id,
                    ticket: None,
                    picture: None,
                    _lease: None,
                    loaded_at: None,
                    fade_ms: fade_duration_ms(&mount.options),
                    anim_origin: Instant::now(),
                    sixel: None,
                },
            );
            dispatch_start(control, id, events);
            dispatch_finish(
                control,
                id,
                events,
                Err(format!("unsupported image source `{}`", source.uri)),
            );
            return;
        };

        let want = Want {
            size: frame_size,
            scale: self.scale_for_cells(cells),
            mode: mount.resize_mode,
        };
        let source_key = location.key();
        if let Some(existing) = self.entries.get(&id)
            && existing.source_uri.as_ref() == Some(&source.uri)
        {
            if existing.ticket.is_some() {
                return;
            }
            if let Some(pic) = &existing.picture {
                let desired_longest = want.longest(pic.natural, location.density(), source.size);
                if existing
                    .key
                    .as_ref()
                    .is_some_and(|k| k.source == source_key && k.longest >= desired_longest)
                {
                    return;
                }
            } else {
                return;
            }
        }

        let load_id = self.alloc_load_id();
        let same_source = self
            .entries
            .get(&id)
            .is_some_and(|e| e.source_uri.as_ref() == Some(&source.uri) && e.picture.is_some());

        let progress = events.contains(EventKind::Progress).then(|| {
            let sink = sink.clone();
            Arc::new(move |loaded: u64, total: u64| {
                sink.send(Message::ImageProgress {
                    id,
                    load_id,
                    loaded,
                    total,
                });
            }) as nsh_core::image::loader::Progress
        });

        let request = Request {
            location,
            context,
            declared: source.size,
            want,
            frames: Frames::All,
            priority: Priority::Normal,
            progress,
        };

        if !same_source {
            dispatch_start(control, id, events);
        }

        if let Some((decoded, lease)) = IMAGES.cached(&request) {
            let key = IMAGES.key_of(&request, decoded.natural);
            let natural = decoded.natural;
            self.entries.insert(
                id,
                ViewEntry {
                    source_uri: Some(source.uri.clone()),
                    key: Some(key),
                    load_id,
                    ticket: None,
                    picture: Some(decoded.value),
                    _lease: Some(lease),
                    loaded_at: None,
                    fade_ms: 0,
                    anim_origin: Instant::now(),
                    sixel: None,
                },
            );
            if !same_source {
                dispatch_finish(control, id, events, Ok(natural));
            }
            return;
        }

        let prev = self.entries.remove(&id);
        let sink_done = sink.clone();
        let done_slot: Arc<Mutex<Option<Result<(DecodedPicture, Lease), String>>>> =
            Arc::new(Mutex::new(None));
        let done_capture = Arc::clone(&done_slot);
        let ticket = IMAGES.load(
            request.clone(),
            Box::new(move |res| {
                let mapped = res.map(|(d, lease)| (d.value, lease));
                *done_capture.lock().unwrap_or_else(|e| e.into_inner()) = Some(mapped.clone());
                sink_done.send(Message::ImageLoaded {
                    id,
                    load_id,
                    result: mapped,
                });
            }),
        );

        let immediate = done_slot.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(result) = immediate {
            let entry = match result {
                Ok((pic, lease)) => {
                    let key = IMAGES.key_of(&request, pic.natural);
                    let natural = pic.natural;
                    if !same_source {
                        dispatch_finish(control, id, events, Ok(natural));
                    }
                    ViewEntry {
                        source_uri: Some(source.uri.clone()),
                        key: Some(key),
                        load_id,
                        ticket: None,
                        picture: Some(pic),
                        _lease: Some(lease),
                        loaded_at: None,
                        fade_ms: 0,
                        anim_origin: Instant::now(),
                        sixel: None,
                    }
                }
                Err(err) => {
                    if !same_source {
                        dispatch_finish(control, id, events, Err(err));
                    }
                    ViewEntry {
                        source_uri: Some(source.uri.clone()),
                        key: None,
                        load_id,
                        ticket: None,
                        picture: None,
                        _lease: None,
                        loaded_at: None,
                        fade_ms: 0,
                        anim_origin: Instant::now(),
                        sixel: None,
                    }
                }
            };
            self.entries.insert(id, entry);
            return;
        }

        self.entries.insert(
            id,
            ViewEntry {
                source_uri: Some(source.uri.clone()),
                key: prev.as_ref().and_then(|p| p.key.clone()),
                load_id,
                ticket: Some(ticket),
                picture: if same_source {
                    prev.as_ref().and_then(|p| p.picture.clone())
                } else {
                    None
                },
                _lease: if same_source {
                    prev.and_then(|p| p._lease)
                } else {
                    None
                },
                loaded_at: None,
                fade_ms: if same_source {
                    0
                } else {
                    fade_duration_ms(&mount.options)
                },
                anim_origin: Instant::now(),
                sixel: None,
            },
        );
    }

    pub(crate) fn on_progress(
        &self,
        id: NodeId,
        load_id: u64,
        loaded: u64,
        total: u64,
        events: EventMask,
        control: Option<&nsh_engine::EngineControl>,
    ) {
        let Some(entry) = self.entries.get(&id) else {
            return;
        };
        if entry.load_id != load_id || !events.contains(EventKind::Progress) {
            return;
        }
        if let Some(control) = control {
            control.dispatch_event(
                id,
                EventKind::Progress,
                EventPayload::Map(vec![
                    ("loaded", PayloadValue::Number(loaded as f64)),
                    ("total", PayloadValue::Number(total as f64)),
                ]),
            );
        }
    }

    pub(crate) fn on_loaded(
        &mut self,
        id: NodeId,
        load_id: u64,
        result: Result<(DecodedPicture, Lease), String>,
        mount: Option<&ImageMount>,
        events: EventMask,
        control: Option<&nsh_engine::EngineControl>,
    ) -> bool {
        let Some(entry) = self.entries.get_mut(&id) else {
            return false;
        };
        if entry.load_id != load_id || entry.ticket.is_none() {
            return false;
        }
        entry.ticket = None;
        let upgraded = entry.picture.is_some();
        match result {
            Ok((pic, lease)) => {
                let natural = pic.natural;
                if let Some(source) = mount.and_then(|m| m.source.as_ref()) {
                    let ctx = Context {
                        asset_base: self.asset_base.clone(),
                        read_asset: self.read_asset.clone(),
                        access: self.access.clone(),
                        media_files: self.media_files.clone(),
                        disk: None,
                        transport: None,
                    };
                    if let Some(loc) = ctx.locate(source) {
                        entry.key = Some(Key {
                            source: loc.key(),
                            longest: pic.frames.first().map_or(0, |f| f.width.max(f.height)),
                            frames: Frames::All,
                        });
                    }
                }
                entry.picture = Some(pic);
                entry._lease = Some(lease);
                entry.loaded_at = (entry.fade_ms > 0).then(Instant::now);
                entry.anim_origin = Instant::now();
                entry.sixel = None;
                if !upgraded {
                    dispatch_finish(control, id, events, Ok(natural));
                }
            }
            Err(err) => {
                if !upgraded {
                    entry.picture = None;
                    entry._lease = None;
                    entry.sixel = None;
                    dispatch_finish(control, id, events, Err(err));
                }
            }
        }
        true
    }

    pub(crate) fn on_sixel_encoded(&mut self, id: NodeId, key: SixelKey, sixel: String) -> bool {
        let Some(entry) = self.entries.get_mut(&id) else {
            return false;
        };
        if entry.load_id != key.load_id {
            return false;
        }
        if matches!(&entry.sixel, Some(SixelSlot::Pending(pending)) if *pending == key) {
            entry.sixel = Some(SixelSlot::Ready(key, sixel));
            return true;
        }
        false
    }

    pub(crate) fn image_info(
        &self,
        request_id: u32,
        uri: &str,
        sink: &Sink,
        control: Option<&nsh_engine::EngineControl>,
    ) {
        let context = self.context(uri);
        let Some(location) = context.resolve(uri) else {
            send_image_info(
                control,
                request_id,
                Err(format!("unsupported image source `{uri}`")),
            );
            return;
        };
        if let Some(natural) = IMAGES.natural(&location.key()) {
            send_image_info(control, request_id, Ok(natural));
            return;
        }
        let decode = Request {
            location: location.clone(),
            context: context.clone(),
            declared: None,
            want: Want::natural(1.0),
            frames: Frames::First,
            priority: Priority::Prefetch,
            progress: None,
        };
        let sink = sink.clone();
        loader()
            .read(
                location,
                &context,
                Priority::Prefetch,
                None,
                Box::new(move |bytes| match bytes.map(|b| Natural::of(&b)) {
                    Ok(Some(natural)) => sink.send(Message::ImageInfo {
                        request_id,
                        result: Ok(natural),
                    }),
                    Ok(None) => IMAGES
                        .load(
                            decode,
                            Box::new(move |r| {
                                sink.send(Message::ImageInfo {
                                    request_id,
                                    result: r.map(|(d, _)| d.natural),
                                });
                            }),
                        )
                        .detach(),
                    Err(e) => sink.send(Message::ImageInfo {
                        request_id,
                        result: Err(e),
                    }),
                }),
            )
            .detach();
    }

    pub(crate) fn next_deadline(
        &self,
        now: Instant,
        tree: &crate::mount::Mounter,
    ) -> Option<Instant> {
        self.protocol?;
        let mut earliest: Option<Instant> = None;
        let mut push = |candidate: Instant| {
            earliest = Some(earliest.map_or(candidate, |cur| cur.min(candidate)));
        };
        for (&id, entry) in &self.entries {
            let Some(pic) = &entry.picture else {
                continue;
            };
            if tree.get(id).is_none() {
                continue;
            }
            if let Some(started) = entry.loaded_at {
                let dur = Duration::from_millis(u64::from(entry.fade_ms));
                if now < started + dur {
                    push(now + Duration::from_millis(16));
                }
            }
            if pic.is_animated()
                && let (_, Some(rem)) =
                    pic.frame_at(now.saturating_duration_since(entry.anim_origin))
            {
                push(now + rem);
            }
        }
        earliest
    }

    pub(crate) fn is_animating(&self, now: Instant, tree: &crate::mount::Mounter) -> bool {
        self.next_deadline(now, tree).is_some()
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn draw_halfblocks(
        &mut self,
        id: NodeId,
        mount: &ImageMount,
        style: &ViewStyle,
        animated_bg: Option<CoreColor>,
        animated_opacity: Option<f32>,
        frame_points: Size<Points>,
        bounds: CellBounds,
        visible: Rect,
        hit_index: usize,
        depth: ColorDepth,
        buffer: &mut Buffer,
    ) -> Option<SixelCandidate> {
        let protocol = self.protocol?;
        if visible.is_empty() || depth == ColorDepth::Monochrome {
            return None;
        }
        let entry = self.entries.get_mut(&id)?;
        let pic = entry.picture.as_ref()?;
        let now = Instant::now();
        let (frame_idx, _) = pic.frame_at(now.saturating_duration_since(entry.anim_origin));
        let raster = pic.frames.get(frame_idx)?;

        let mut alpha = animated_opacity.unwrap_or(style.opacity).clamp(0.0, 1.0);
        if let Some(started) = entry.loaded_at {
            let dur = Duration::from_millis(u64::from(entry.fade_ms));
            let elapsed = now.saturating_duration_since(started);
            if elapsed < dur {
                alpha *= (elapsed.as_secs_f32() / dur.as_secs_f32()).clamp(0.0, 1.0);
            } else {
                entry.loaded_at = None;
            }
        }
        if alpha <= 0.0 {
            return None;
        }

        let natural_points = mount
            .source
            .as_ref()
            .and_then(|s| s.size)
            .filter(|s| s.width.0 > 0.0 && s.height.0 > 0.0)
            .unwrap_or_else(|| pic.natural.points(1.0));
        let tint = style.tint_color.map(|c| c.0.to_be_bytes());
        let style_blur: f32 = style
            .effects
            .as_deref()
            .map_or(0.0, |e| blur_radius(&e.filters).0.max(0.0));
        let blur = style_blur.max(mount.options.blur_radius.0.max(0.0));
        let bg = cell_bg_rgb(&buffer[(visible.x, visible.y)], style, animated_bg);
        let unclipped = i32::from(visible.width) == bounds.right - bounds.left
            && i32::from(visible.height) == bounds.bottom - bounds.top
            && region_allows_sixel(buffer, visible);

        paint_halfblocks(
            buffer,
            bounds,
            visible,
            raster,
            natural_points,
            frame_points,
            mount.resize_mode,
            mount.options.position,
            tint,
            alpha,
            blur,
            style,
            animated_bg,
            depth,
        );

        if protocol.kind != ProtocolType::Sixel || !unclipped {
            return None;
        }

        let (cw, ch) = protocol.cell_size();
        let width_px = u32::from(visible.width) * u32::from(cw);
        let height_px = u32::from(visible.height) * u32::from(ch);
        let fit_box = if frame_points.width.0 > 0.0 && frame_points.height.0 > 0.0 {
            frame_points
        } else {
            Size::new(Points(width_px as f32), Points(height_px as f32))
        };
        let placed = mount
            .resize_mode
            .fit(natural_points, fit_box, mount.options.position);
        let key = SixelKey {
            load_id: entry.load_id,
            frame_idx,
            width_px,
            height_px,
            fit_w: fit_box.width.0.to_bits(),
            fit_h: fit_box.height.0.to_bits(),
            placed_x: placed.origin.x.0.to_bits(),
            placed_y: placed.origin.y.0.to_bits(),
            placed_w: placed.size.width.0.to_bits(),
            placed_h: placed.size.height.0.to_bits(),
            bg,
            tint,
            alpha_q8: (alpha * 255.0).round() as u8,
            blur_q4: (blur.min(64.0) * 16.0).round() as u16,
            tmux: protocol.tmux,
        };
        Some(SixelCandidate {
            id,
            region: visible,
            hit_index,
            checksum: region_checksum(buffer, visible),
            key,
            raster: Arc::clone(raster),
        })
    }

    pub(crate) fn finish_sixel(
        &mut self,
        candidate: SixelCandidate,
        sink: &Sink,
        buffer: &mut Buffer,
    ) {
        if region_checksum(buffer, candidate.region) != candidate.checksum {
            return;
        }
        let Some(entry) = self.entries.get_mut(&candidate.id) else {
            return;
        };
        match &entry.sixel {
            Some(SixelSlot::Ready(ready_key, sixel)) if *ready_key == candidate.key => {
                write_sixel_cells(buffer, candidate.region, sixel);
            }
            Some(SixelSlot::Pending(pending_key)) if *pending_key == candidate.key => {}
            _ => {
                entry.sixel = Some(SixelSlot::Pending(candidate.key));
                let _ = SIXEL_QUEUE.send(SixelJob {
                    surface_id: self.surface_id,
                    sink: sink.clone(),
                    id: candidate.id,
                    key: candidate.key,
                    raster: candidate.raster,
                });
            }
        }
    }

    fn alloc_load_id(&mut self) -> u64 {
        let id = self.next_load_id;
        self.next_load_id = self.next_load_id.wrapping_add(1).max(1);
        id
    }
}

pub(crate) fn send_image_info(
    control: Option<&nsh_engine::EngineControl>,
    request_id: u32,
    result: Result<Natural, String>,
) {
    let Some(control) = control else {
        return;
    };
    let mut fields = vec![("id", PayloadValue::Number(f64::from(request_id)))];
    match result {
        Ok(natural) => {
            let size = reported_size(natural);
            fields.push(("width", PayloadValue::Number(size.width.0 as f64)));
            fields.push(("height", PayloadValue::Number(size.height.0 as f64)));
        }
        Err(message) => fields.push(("error", PayloadValue::Str(message))),
    }
    control.dispatch_event(ROOT_ID, EventKind::ImageInfo, EventPayload::Map(fields));
}

fn dispatch_start(control: Option<&nsh_engine::EngineControl>, id: NodeId, events: EventMask) {
    let Some(control) = control else {
        return;
    };
    if events.contains(EventKind::LoadStart) {
        control.dispatch_event(id, EventKind::LoadStart, EventPayload::None);
    }
}

fn dispatch_finish(
    control: Option<&nsh_engine::EngineControl>,
    id: NodeId,
    events: EventMask,
    result: Result<Natural, String>,
) {
    let Some(control) = control else {
        return;
    };
    match result {
        Ok(natural) => {
            if events.contains(EventKind::Load) {
                control.dispatch_event(
                    id,
                    EventKind::Load,
                    EventPayload::Image(reported_size(natural)),
                );
            }
        }
        Err(message) => {
            if events.contains(EventKind::Error) {
                control.dispatch_event(id, EventKind::Error, EventPayload::Error { message });
            }
        }
    }
    if events.contains(EventKind::LoadEnd) {
        control.dispatch_event(id, EventKind::LoadEnd, EventPayload::None);
    }
}

fn cell_bg_rgb(
    cell: &ratatui_core::buffer::Cell,
    style: &ViewStyle,
    animated_bg: Option<CoreColor>,
) -> [u8; 3] {
    let bg = animated_bg.unwrap_or(style.background_color);
    if !bg.is_transparent() {
        let [r, g, b, _] = bg.0.to_be_bytes();
        return [r, g, b];
    }
    match cell.bg {
        Color::Rgb(r, g, b) => [r, g, b],
        _ => [0, 0, 0],
    }
}

fn region_allows_sixel(buffer: &Buffer, region: Rect) -> bool {
    for y in region.y..region.bottom() {
        for x in region.x..region.right() {
            let cell = &buffer[(x, y)];
            if cell.symbol() != " " || !cell.modifier.is_empty() {
                return false;
            }
        }
    }
    true
}

fn region_checksum(buffer: &Buffer, region: Rect) -> u64 {
    use std::hash::{Hash, Hasher};
    struct Fnv(u64);
    impl Hasher for Fnv {
        fn finish(&self) -> u64 {
            self.0
        }
        fn write(&mut self, bytes: &[u8]) {
            for &b in bytes {
                self.0 ^= u64::from(b);
                self.0 = self.0.wrapping_mul(0x1000_0000_01b3);
            }
        }
    }
    let mut h = Fnv(0xcbf2_9ce4_8422_2325);
    for y in region.y..region.bottom() {
        for x in region.x..region.right() {
            let cell = &buffer[(x, y)];
            cell.symbol().hash(&mut h);
            cell.fg.hash(&mut h);
            cell.bg.hash(&mut h);
            cell.modifier.hash(&mut h);
        }
    }
    h.finish()
}

fn write_sixel_cells(buffer: &mut Buffer, region: Rect, sixel: &str) {
    for y in region.y..region.bottom() {
        for x in region.x..region.right() {
            let cell = &mut buffer[(x, y)];
            cell.reset();
            if x == region.x && y == region.y {
                cell.set_symbol(sixel);
                cell.set_diff_option(CellDiffOption::ForcedWidth(NonZeroU16::MIN));
            } else {
                cell.set_diff_option(CellDiffOption::Skip);
            }
        }
    }
}

fn sample_fitted_pixel(
    raster: &Raster,
    placed: Bounds<Points>,
    px: f32,
    py: f32,
    tint: Option<[u8; 4]>,
    alpha_scale: f32,
) -> Option<[u8; 4]> {
    if raster.width == 0
        || raster.height == 0
        || placed.size.width.0 <= 0.0
        || placed.size.height.0 <= 0.0
        || px < placed.origin.x.0
        || py < placed.origin.y.0
        || px >= placed.origin.x.0 + placed.size.width.0
        || py >= placed.origin.y.0 + placed.size.height.0
    {
        return None;
    }
    let u = (px - placed.origin.x.0) / placed.size.width.0;
    let v = (py - placed.origin.y.0) / placed.size.height.0;
    let sx =
        ((u * raster.width as f32).floor() as i64).clamp(0, i64::from(raster.width) - 1) as usize;
    let sy =
        ((v * raster.height as f32).floor() as i64).clamp(0, i64::from(raster.height) - 1) as usize;
    let idx = (sy * raster.width as usize + sx) * 4;
    let mut r = raster.rgba[idx];
    let mut g = raster.rgba[idx + 1];
    let mut b = raster.rgba[idx + 2];
    let mut a = (f32::from(raster.rgba[idx + 3]) * alpha_scale)
        .round()
        .clamp(0.0, 255.0) as u8;
    if a == 0 {
        return None;
    }
    if let Some([tr, tg, tb, ta]) = tint {
        r = tr;
        g = tg;
        b = tb;
        a = ((u16::from(a) * u16::from(ta) + 127) / 255) as u8;
    }
    (a > 0).then_some([r, g, b, a])
}

fn blend_over(fg: [u8; 4], bg: [u8; 3]) -> [u8; 3] {
    let a = u16::from(fg[3]);
    let inv = 255 - a;
    [
        ((u16::from(fg[0]) * a + u16::from(bg[0]) * inv + 127) / 255) as u8,
        ((u16::from(fg[1]) * a + u16::from(bg[1]) * inv + 127) / 255) as u8,
        ((u16::from(fg[2]) * a + u16::from(bg[2]) * inv + 127) / 255) as u8,
    ]
}

fn box_blur_rgba(pixels: &mut [u8], width: usize, height: usize, radius: usize) {
    if radius == 0 || width <= 1 || height <= 1 {
        return;
    }
    let mut scratch = pixels.to_vec();
    let r = radius.min(32);
    for _ in 0..2 {
        for y in 0..height {
            for x in 0..width {
                let x0 = x.saturating_sub(r);
                let x1 = (x + r).min(width - 1);
                let count = (x1 - x0 + 1) as u32;
                let mut sum = [0u32; 4];
                for sx in x0..=x1 {
                    let idx = (y * width + sx) * 4;
                    for c in 0..4 {
                        sum[c] += u32::from(pixels[idx + c]);
                    }
                }
                let out = (y * width + x) * 4;
                for c in 0..4 {
                    scratch[out + c] = (sum[c] / count) as u8;
                }
            }
        }
        for y in 0..height {
            for x in 0..width {
                let y0 = y.saturating_sub(r);
                let y1 = (y + r).min(height - 1);
                let count = (y1 - y0 + 1) as u32;
                let mut sum = [0u32; 4];
                for sy in y0..=y1 {
                    let idx = (sy * width + x) * 4;
                    for c in 0..4 {
                        sum[c] += u32::from(scratch[idx + c]);
                    }
                }
                let out = (y * width + x) * 4;
                for c in 0..4 {
                    pixels[out + c] = (sum[c] / count) as u8;
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn paint_halfblocks(
    buffer: &mut Buffer,
    bounds: CellBounds,
    visible: Rect,
    raster: &Raster,
    natural_points: Size<Points>,
    frame_points: Size<Points>,
    mode: ResizeMode,
    position: ObjectPosition,
    tint: Option<[u8; 4]>,
    alpha: f32,
    blur: f32,
    style: &ViewStyle,
    animated_bg: Option<CoreColor>,
    depth: ColorDepth,
) {
    let full_w = (bounds.right - bounds.left).max(0) as usize;
    let full_h2 = (bounds.bottom - bounds.top).max(0) as usize * 2;
    if full_w == 0 || full_h2 == 0 || visible.is_empty() {
        return;
    }
    let fit_box = if frame_points.width.0 > 0.0 && frame_points.height.0 > 0.0 {
        frame_points
    } else {
        Size::new(Points(full_w as f32), Points(full_h2 as f32))
    };
    let placed = mode.fit(natural_points, fit_box, position);

    let blurred_holder;
    let source_raster = if blur >= 0.5 {
        let radius = (blur.round() as usize).clamp(1, 16);
        let mut copy = raster.rgba.clone();
        box_blur_rgba(
            &mut copy,
            raster.width as usize,
            raster.height as usize,
            radius,
        );
        blurred_holder = Raster {
            width: raster.width,
            height: raster.height,
            rgba: copy,
        };
        &blurred_holder
    } else {
        raster
    };

    let to_color = |rgb: [u8; 3]| -> Color { crate::palette::convert(rgb, depth) };

    for y in visible.y..visible.bottom() {
        let cy = (i32::from(y) - bounds.top).max(0) as usize;
        let py_top = ((cy * 2) as f32 + 0.5) / full_h2 as f32 * fit_box.height.0;
        let py_bot = ((cy * 2 + 1) as f32 + 0.5) / full_h2 as f32 * fit_box.height.0;
        for x in visible.x..visible.right() {
            let cx = (i32::from(x) - bounds.left).max(0) as usize;
            let px = (cx as f32 + 0.5) / full_w as f32 * fit_box.width.0;
            let top = sample_fitted_pixel(source_raster, placed, px, py_top, tint, alpha);
            let bot = sample_fitted_pixel(source_raster, placed, px, py_bot, tint, alpha);
            if top.is_none() && bot.is_none() {
                continue;
            }
            let cell = &mut buffer[(x, y)];
            let base_bg = cell_bg_rgb(cell, style, animated_bg);
            match (top, bot) {
                (Some(t), Some(b)) => {
                    let tc = blend_over(t, base_bg);
                    let bc = blend_over(b, base_bg);
                    cell.set_symbol("▀");
                    cell.set_fg(to_color(tc));
                    cell.set_bg(to_color(bc));
                }
                (Some(t), None) => {
                    cell.set_symbol("▀");
                    cell.set_fg(to_color(blend_over(t, base_bg)));
                }
                (None, Some(b)) => {
                    cell.set_symbol("▄");
                    cell.set_fg(to_color(blend_over(b, base_bg)));
                }
                (None, None) => {}
            }
        }
    }
}

fn encode_sixel_job(job: &SixelJob) -> Option<String> {
    let w = job.key.width_px as usize;
    let h = job.key.height_px as usize;
    if w == 0 || h == 0 || w > MAX_DIMENSION as usize || h > MAX_DIMENSION as usize {
        return None;
    }
    let fit_box = Size::new(
        Points(f32::from_bits(job.key.fit_w)),
        Points(f32::from_bits(job.key.fit_h)),
    );
    let placed = Bounds::new(
        nsh_core::Point::new(
            Points(f32::from_bits(job.key.placed_x)),
            Points(f32::from_bits(job.key.placed_y)),
        ),
        Size::new(
            Points(f32::from_bits(job.key.placed_w)),
            Points(f32::from_bits(job.key.placed_h)),
        ),
    );
    let alpha = f32::from(job.key.alpha_q8) / 255.0;
    let blur = f32::from(job.key.blur_q4) / 16.0;

    let mut rgba = vec![0u8; w * h * 4];
    for py in 0..h {
        let fy = (py as f32 + 0.5) / h as f32 * fit_box.height.0;
        for px in 0..w {
            let fx = (px as f32 + 0.5) / w as f32 * fit_box.width.0;
            let idx = (py * w + px) * 4;
            if let Some(fg) = sample_fitted_pixel(&job.raster, placed, fx, fy, job.key.tint, alpha)
            {
                let rgb = blend_over(fg, job.key.bg);
                rgba[idx] = rgb[0];
                rgba[idx + 1] = rgb[1];
                rgba[idx + 2] = rgb[2];
                rgba[idx + 3] = 255;
            } else {
                rgba[idx] = job.key.bg[0];
                rgba[idx + 1] = job.key.bg[1];
                rgba[idx + 2] = job.key.bg[2];
                rgba[idx + 3] = 0;
            }
        }
    }

    if blur >= 0.5 {
        let scale = (w.max(h) as f32 / fit_box.width.0.max(fit_box.height.0).max(1.0)).max(1.0);
        let radius = ((blur * scale).round() as usize).clamp(1, 24);
        box_blur_rgba(&mut rgba, w, h, radius);
    }

    let mut image = icy_sixel::SixelImage::from_rgba(rgba, w, h);
    image.background_mode = icy_sixel::BackgroundMode::Transparent;
    let encoded = image.encode().ok()?;
    if job.key.tmux {
        Some(wrap_tmux_dcs(&encoded))
    } else {
        Some(encoded)
    }
}

fn wrap_tmux_dcs(sixel: &str) -> String {
    let mut out = String::with_capacity(sixel.len() + 16);
    out.push_str("\x1bPtmux;");
    for ch in sixel.chars() {
        if ch == '\x1b' {
            out.push_str("\x1b\x1b");
        } else {
            out.push(ch);
        }
    }
    out.push_str("\x1b\\");
    out
}

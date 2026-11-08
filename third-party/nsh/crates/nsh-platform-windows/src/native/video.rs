//! Videos: Media Foundation's media engine in frame server mode.
//!
//! The engine decodes on the thread's Direct3D device (shared through a
//! DXGI device manager, with Direct3D's multithread protection on, since
//! Media Foundation's worker threads use the device too). While a video
//! plays, a frame client of its surface ([`Surface::on_draw_frame`]) asks
//! the engine for a new frame at every display frame (`OnVideoStreamTick`)
//! and copies it into a texture Direct2D draws as a bitmap
//! (`TransferVideoFrame`): the picture is ordinary view content, clipped,
//! transformed and covered like any other.
//!
//! The engine reports to [`Notify`] on its own threads; each notification
//! is posted to the UI thread of its surface ([`UiThread::invoke`]) and finds its
//! video again by surface key and node id, with the serial of the source
//! it was opened for (so a late notification of a replaced source is
//! dropped).
//!
//! Events follow the other platforms: `onLoadStart` when a source opens,
//! `onLoad` with its duration and size once its metadata is known,
//! `onProgress` every `progressUpdateInterval` while playing, `onBuffer`,
//! `onEnd` (not for a looping video: the engine starts over without
//! ending), `onError`. `controls` draws a control bar of nsh's own (play /
//! pause, a scrubber, the time) that drives the engine directly, as the
//! platforms' controls do.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::OnceLock,
};

use nsh_core::{Color, EventKind, EventPayload, NodeId, PayloadValue, ResizeMode, VideoProps};
use windows::{
    Win32::{
        Foundation::{RECT, S_OK},
        Graphics::{
            Direct2D::{
                Common::{
                    D2D1_ALPHA_MODE_IGNORE, D2D1_FIGURE_BEGIN_FILLED, D2D1_FIGURE_END_CLOSED,
                    D2D1_PIXEL_FORMAT,
                },
                D2D1_BITMAP_OPTIONS_NONE, D2D1_BITMAP_PROPERTIES1, D2D1_DRAW_TEXT_OPTIONS_NONE,
                D2D1_ELLIPSE, D2D1_INTERPOLATION_MODE_LINEAR, D2D1_ROUNDED_RECT, ID2D1Bitmap1,
            },
            Direct3D11::{
                D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC,
                D3D11_USAGE_DEFAULT, ID3D11Multithread, ID3D11Texture2D,
            },
            DirectWrite::{
                DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL, DWRITE_FONT_WEIGHT_NORMAL,
                DWRITE_MEASURING_MODE_NATURAL, DWRITE_PARAGRAPH_ALIGNMENT_CENTER,
                DWRITE_TEXT_ALIGNMENT_TRAILING, IDWriteTextFormat,
            },
            Dxgi::{
                Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
                IDXGISurface,
            },
        },
        Media::MediaFoundation::{
            CLSID_MFMediaEngineClassFactory, IMFAttributes, IMFDXGIDeviceManager, IMFMediaEngine,
            IMFMediaEngineClassFactory, IMFMediaEngineNotify, IMFMediaEngineNotify_Impl,
            MF_MEDIA_ENGINE_CALLBACK, MF_MEDIA_ENGINE_DXGI_MANAGER, MF_MEDIA_ENGINE_EVENT,
            MF_MEDIA_ENGINE_EVENT_BUFFERINGENDED, MF_MEDIA_ENGINE_EVENT_BUFFERINGSTARTED,
            MF_MEDIA_ENGINE_EVENT_CANPLAY, MF_MEDIA_ENGINE_EVENT_ENDED,
            MF_MEDIA_ENGINE_EVENT_ERROR, MF_MEDIA_ENGINE_EVENT_FIRSTFRAMEREADY,
            MF_MEDIA_ENGINE_EVENT_LOADEDMETADATA, MF_MEDIA_ENGINE_EVENT_PAUSE,
            MF_MEDIA_ENGINE_EVENT_PLAYING, MF_MEDIA_ENGINE_EVENT_SEEKED,
            MF_MEDIA_ENGINE_EVENT_WAITING, MF_MEDIA_ENGINE_VIDEO_OUTPUT_FORMAT, MF_VERSION, MFARGB,
            MFCreateAttributes, MFCreateDXGIDeviceManager, MFSTARTUP_FULL, MFStartup,
        },
        System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
    },
    core::{BSTR, HSTRING, Interface, Result, implement},
};

use super::{Emitter, Location, error, locate};
use crate::{
    gfx,
    image::AssetBase,
    input::{Cursor, PointerKind},
    render::{DrawCx, rect_f},
    surface::Surface,
    view::{Hosted, ItemPointer},
    window::UiThread,
};

/// The control bar's height (points).
const BAR: f32 = 40.0;
/// The play / pause button's width at the bar's left.
const BUTTON: f32 = 40.0;
/// The room the time takes at the bar's right.
const TIME: f32 = 96.0;
/// How long a paused video waits for the frame it asked for (a seek, the
/// first frame) before the frame client stops (seconds).
const FRAME_WAIT: f64 = 3.0;

/// A video: its media engine and the picture its view shows.
pub(crate) struct VideoItem {
    emitter: Emitter,
    key: u64,
    id: NodeId,
    engine: RefCell<Option<IMFMediaEngine>>,
    /// Bumped with every source opened (and when closed): notifications
    /// for another serial are stale.
    serial: Cell<u64>,
    status: Status,
    /// The props applied (`None` before the first).
    props: RefCell<Option<VideoProps>>,
    /// The last frame.
    frame: RefCell<Option<Frame>>,
    /// The video's size in pixels.
    natural: Cell<(u32, u32)>,
    /// The frame client runs.
    pumping: Cell<bool>,
    /// A paused video waits for a frame until then (the surface's clock):
    /// after a seek, for the first frame.
    want_frame: Cell<Option<f64>>,
    /// When `onProgress` was last sent.
    progress_at: Cell<f64>,
    /// The scrubber is being dragged.
    scrubbing: Cell<bool>,
}

/// What the engine reported so far.
#[derive(Default)]
struct Status {
    loaded: Cell<bool>,
    failed: Cell<bool>,
    buffering: Cell<bool>,
    /// Playing was asked for (applied again once the metadata is known).
    playing: Cell<bool>,
}

/// A frame in a texture shared with Direct2D.
struct Frame {
    texture: ID3D11Texture2D,
    bitmap: ID2D1Bitmap1,
    size: (u32, u32),
    /// The device generation they were made in.
    generation: u64,
    /// A frame was copied into it.
    filled: bool,
}

impl VideoItem {
    pub(crate) fn new(surface: &Rc<Surface>, id: NodeId) -> Rc<Self> {
        Rc::new(VideoItem {
            emitter: Emitter::new(surface, id),
            key: surface.key(),
            id,
            engine: RefCell::new(None),
            serial: Cell::new(0),
            status: Status::default(),
            props: RefCell::new(None),
            frame: RefCell::new(None),
            natural: Cell::new((0, 0)),
            pumping: Cell::new(false),
            want_frame: Cell::new(None),
            progress_at: Cell::new(f64::NEG_INFINITY),
            scrubbing: Cell::new(false),
        })
    }

    pub(crate) fn set(
        self: &Rc<Self>,
        surface: &Rc<Surface>,
        p: &VideoProps,
        base: Option<&AssetBase>,
    ) {
        let old = self.props.borrow_mut().take();
        let reopened = old.as_ref().is_none_or(|o| o.source != p.source);
        if reopened {
            self.open(surface, p.source.as_deref(), base);
        }
        *self.props.borrow_mut() = Some(p.clone());
        self.status.playing.set(!p.paused);
        let engine = self.engine.borrow().clone();
        if let Some(engine) = engine {
            // SAFETY: calls on a live engine, from the thread that made it.
            unsafe {
                let _ = engine.SetMuted(p.muted);
                let _ = engine.SetVolume(p.volume.clamp(0.0, 1.0) as f64);
                let _ = engine.SetLoop(p.repeat);
                // A rate of 0 would freeze the picture rather than pause it.
                let rate = if p.rate > 0.0 { p.rate as f64 } else { 1.0 };
                let _ = engine.SetDefaultPlaybackRate(rate);
                let _ = engine.SetPlaybackRate(rate);
                if p.paused {
                    let _ = engine.Pause();
                } else if !self.status.failed.get() {
                    let _ = engine.Play();
                }
            }
            let waiting = !p.paused && !self.status.loaded.get() && !self.status.failed.get();
            self.set_buffering(waiting);
            if !p.paused {
                self.pump(surface);
            }
        }
        surface.invalidate();
    }

    /// Opens `source` (or nothing).
    fn open(
        self: &Rc<Self>,
        surface: &Rc<Surface>,
        source: Option<&str>,
        base: Option<&AssetBase>,
    ) {
        self.close();
        let Some(source) = source else { return };
        let url = match locate(source, base) {
            Some(location) => location.url(),
            None => {
                self.status.failed.set(true);
                let message = format!("{source}: no asset directory to resolve it from");
                self.emitter.emit(EventKind::Error, || error(message));
                return;
            }
        };
        let serial = self.serial.get();
        let engine = match make_engine(self.key, surface.ui_thread(), self.id, serial) {
            Ok(engine) => engine,
            Err(err) => {
                self.status.failed.set(true);
                log::warn!(target: "js", "video {source}: cannot create a media engine: {err}");
                let message = format!("cannot play videos: {}", err.message());
                self.emitter.emit(EventKind::Error, || error(message));
                return;
            }
        };
        self.emitter
            .emit(EventKind::LoadStart, || EventPayload::None);
        // SAFETY: a call on the engine just made.
        if let Err(err) = unsafe { engine.SetSource(&BSTR::from(url.as_str())) } {
            self.status.failed.set(true);
            let message = format!("{source}: {}", err.message());
            self.emitter.emit(EventKind::Error, || error(message));
        }
        if matches!(locate(source, base), Some(Location::Path(ref p)) if !p.exists()) {
            log::warn!(target: "js", "video {source}: no such file");
        }
        *self.engine.borrow_mut() = Some(engine);
        self.want_frame.set(Some(surface.clock() + FRAME_WAIT));
    }

    /// Stops the engine and forgets the source (the last frame stays, for
    /// a removal animation).
    pub(crate) fn close(&self) {
        self.serial.set(self.serial.get() + 1);
        if let Some(engine) = self.engine.borrow_mut().take() {
            // SAFETY: calls on a live engine; it is not used afterwards.
            unsafe {
                let _ = engine.Pause();
                let _ = engine.Shutdown();
            }
        }
        for flag in [
            &self.status.loaded,
            &self.status.failed,
            &self.status.buffering,
        ] {
            flag.set(false);
        }
        self.natural.set((0, 0));
        self.want_frame.set(None);
        self.progress_at.set(f64::NEG_INFINITY);
    }

    pub(crate) fn seek(self: &Rc<Self>, seconds: f64) {
        let engine = self.engine.borrow().clone();
        if let Some(engine) = engine {
            // SAFETY: a call on a live engine.
            let _ = unsafe { engine.SetCurrentTime(seconds.max(0.0)) };
        }
    }

    fn set_buffering(&self, buffering: bool) {
        if self.status.buffering.replace(buffering) != buffering {
            self.emitter
                .emit(EventKind::Buffer, || buffer_payload(buffering));
        }
    }

    /// A notification of the engine, on the main thread.
    fn notified(
        self: &Rc<Self>,
        surface: &Rc<Surface>,
        serial: u64,
        event: u32,
        param1: usize,
        param2: u32,
    ) {
        if serial != self.serial.get() {
            return;
        }
        let Some(engine) = self.engine.borrow().clone() else {
            return;
        };
        let event = MF_MEDIA_ENGINE_EVENT(event as i32);
        match event {
            MF_MEDIA_ENGINE_EVENT_LOADEDMETADATA => {
                if self.status.loaded.replace(true) || self.status.failed.get() {
                    return;
                }
                let (mut w, mut h) = (0u32, 0u32);
                // SAFETY: calls on a live engine with out pointers to locals.
                let duration = unsafe {
                    let _ = engine.GetNativeVideoSize(Some(&mut w), Some(&mut h));
                    engine.GetDuration()
                };
                self.natural.set((w, h));
                // Playing asked for before the source was ready.
                // SAFETY: as above.
                unsafe {
                    if self.status.playing.get() && engine.IsPaused().as_bool() {
                        let _ = engine.Play();
                    }
                }
                self.set_buffering(false);
                self.emitter
                    .emit(EventKind::Load, || load_payload(duration, w, h));
                self.want_frame.set(Some(surface.clock() + FRAME_WAIT));
                self.pump(surface);
            }
            MF_MEDIA_ENGINE_EVENT_PLAYING => {
                if self.status.loaded.get() {
                    self.set_buffering(false);
                }
                self.pump(surface);
            }
            MF_MEDIA_ENGINE_EVENT_CANPLAY | MF_MEDIA_ENGINE_EVENT_BUFFERINGENDED => {
                if self.status.loaded.get() {
                    self.set_buffering(false);
                }
            }
            MF_MEDIA_ENGINE_EVENT_WAITING | MF_MEDIA_ENGINE_EVENT_BUFFERINGSTARTED => {
                if self.status.playing.get() && !self.status.failed.get() {
                    self.set_buffering(true);
                }
            }
            MF_MEDIA_ENGINE_EVENT_FIRSTFRAMEREADY | MF_MEDIA_ENGINE_EVENT_SEEKED => {
                self.want_frame.set(Some(surface.clock() + FRAME_WAIT));
                self.pump(surface);
            }
            MF_MEDIA_ENGINE_EVENT_PAUSE => surface.invalidate(),
            MF_MEDIA_ENGINE_EVENT_ENDED => {
                let repeat = self.props.borrow().as_ref().is_some_and(|p| p.repeat);
                if !repeat {
                    self.emitter.emit(EventKind::End, || EventPayload::None);
                }
                surface.invalidate();
            }
            MF_MEDIA_ENGINE_EVENT_ERROR => {
                if self.status.failed.replace(true) {
                    return;
                }
                let message = media_error(param1 as u16, param2 as i32);
                let source = self
                    .props
                    .borrow()
                    .as_ref()
                    .and_then(|p| p.source.clone())
                    .unwrap_or_default();
                log::warn!(target: "js", "video {source}: {message}");
                self.set_buffering(false);
                self.emitter.emit(EventKind::Error, || error(message));
            }
            _ => {}
        }
    }

    /// Runs the frame client (once) while the video plays or waits for a
    /// frame.
    fn pump(self: &Rc<Self>, surface: &Rc<Surface>) {
        if self.pumping.replace(true) {
            return;
        }
        let weak: Weak<Self> = Rc::downgrade(self);
        surface.on_draw_frame(move |surface, now| {
            let Some(item) = weak.upgrade() else {
                return false;
            };
            let keep = item.tick(surface, now);
            if !keep {
                item.pumping.set(false);
            }
            keep
        });
    }

    /// One display frame while pumping: copies a new video frame, reports
    /// progress. False when there is nothing more to do.
    fn tick(&self, surface: &Surface, now: f64) -> bool {
        let Some(engine) = self.engine.borrow().clone() else {
            return false;
        };
        let mut pts = 0i64;
        // SAFETY: a call on a live engine; S_FALSE (no new frame) is a
        // success code `windows` would not tell apart, hence the raw call.
        let fresh = unsafe {
            (Interface::vtable(&engine).OnVideoStreamTick)(engine.as_raw(), &mut pts) == S_OK
        };
        if fresh && self.transfer(&engine) {
            self.want_frame.set(None);
            surface.invalidate();
        }
        // SAFETY: calls on a live engine.
        let (paused, ended) = unsafe { (engine.IsPaused().as_bool(), engine.IsEnded().as_bool()) };
        let playing = !paused && !ended;
        if playing && self.status.loaded.get() {
            let interval = self
                .props
                .borrow()
                .as_ref()
                .map_or(0.25, |p| (p.progress_interval_ms.max(16.0) / 1000.0) as f64);
            if now - self.progress_at.get() >= interval {
                self.progress_at.set(now);
                // SAFETY: as above.
                let (time, duration) = unsafe { (engine.GetCurrentTime(), engine.GetDuration()) };
                self.emitter
                    .emit(EventKind::Progress, || progress_payload(time, duration));
                // The control bar's time and scrubber move with it.
                if self.controls() {
                    surface.invalidate();
                }
            }
        }
        playing || self.want_frame.get().is_some_and(|until| now < until)
    }

    /// Copies the engine's current frame into the texture (made again for
    /// a new size or device).
    fn transfer(&self, engine: &IMFMediaEngine) -> bool {
        let (mut w, mut h) = (0u32, 0u32);
        // SAFETY: a call on a live engine with out pointers to locals.
        let _ = unsafe { engine.GetNativeVideoSize(Some(&mut w), Some(&mut h)) };
        if w == 0 || h == 0 {
            return false;
        }
        self.natural.set((w, h));
        let Ok(gfx) = gfx::get() else { return false };
        let generation = gfx::generation();
        let mut slot = self.frame.borrow_mut();
        if slot
            .as_ref()
            .is_none_or(|f| f.size != (w, h) || f.generation != generation)
        {
            *slot = match make_frame(&gfx, (w, h), generation) {
                Ok(frame) => Some(frame),
                Err(err) => {
                    log::warn!("video: cannot make a frame texture: {err}");
                    return false;
                }
            };
        }
        let Some(frame) = slot.as_mut() else {
            return false;
        };
        let rect = RECT {
            left: 0,
            top: 0,
            right: w as i32,
            bottom: h as i32,
        };
        let black = MFARGB {
            rgbBlue: 0,
            rgbGreen: 0,
            rgbRed: 0,
            rgbAlpha: 255,
        };
        // SAFETY: the texture is a render target of the engine's device,
        // as large as `rect`.
        match unsafe { engine.TransferVideoFrame(&frame.texture, None, &rect, Some(&black)) } {
            Ok(()) => {
                frame.filled = true;
                true
            }
            Err(err) => {
                log::debug!("video: frame not transferred: {err}");
                false
            }
        }
    }

    fn controls(&self) -> bool {
        self.props.borrow().as_ref().is_some_and(|p| p.controls)
    }

    fn resize_mode(&self) -> ResizeMode {
        self.props
            .borrow()
            .as_ref()
            .map_or(ResizeMode::Contain, |p| p.resize_mode)
    }

    /// Current time and duration (seconds; 0 when unknown).
    fn times(&self) -> (f64, f64) {
        let Some(engine) = self.engine.borrow().clone() else {
            return (0.0, 0.0);
        };
        // SAFETY: calls on a live engine.
        let (t, d) = unsafe { (engine.GetCurrentTime(), engine.GetDuration()) };
        (finite(t), finite(d))
    }

    fn playing(&self) -> bool {
        let Some(engine) = self.engine.borrow().clone() else {
            return false;
        };
        // SAFETY: calls on a live engine.
        unsafe { !engine.IsPaused().as_bool() && !engine.IsEnded().as_bool() }
    }

    /// Seeks to where `x` falls on the scrubber of a bar `width` wide.
    fn scrub(&self, x: f32, width: f32) {
        let (start, end) = scrubber(width);
        let (_, duration) = self.times();
        let Some(engine) = self.engine.borrow().clone() else {
            return;
        };
        if duration > 0.0 && end > start {
            let fraction = ((x - start) / (end - start)).clamp(0.0, 1.0) as f64;
            // SAFETY: a call on a live engine.
            let _ = unsafe { engine.SetCurrentTime(fraction * duration) };
        }
    }

    fn surface(&self) -> Option<Rc<Surface>> {
        Surface::by_key(self.key)
    }

    fn draw_bar(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        let (w, h) = size;
        if w < BUTTON + 24.0 || h < BAR {
            return;
        }
        let top = h - BAR;
        let dc = cx.dc;
        // SAFETY: Direct2D calls between BeginDraw and EndDraw.
        unsafe {
            dc.FillRectangle(
                &rect_f(0.0, top, w, BAR),
                cx.solid(Color::rgba(0, 0, 0, 140)),
            );
        }
        let white = Color::rgba(255, 255, 255, 255);
        // Play / pause.
        let (cx0, cy) = (BUTTON / 2.0, top + BAR / 2.0);
        if self.playing() {
            for dx in [-5.0, 2.0] {
                let r = D2D1_ROUNDED_RECT {
                    rect: rect_f(cx0 + dx, cy - 7.0, 3.5, 14.0),
                    radiusX: 1.0,
                    radiusY: 1.0,
                };
                // SAFETY: as above.
                unsafe { dc.FillRoundedRectangle(&r, cx.solid(white)) };
            }
        } else {
            // SAFETY: COM calls on the live factory and context; the sink
            // is closed before the geometry is drawn.
            unsafe {
                if let Ok(path) = cx.gfx.factory.CreatePathGeometry()
                    && let Ok(sink) = path.Open()
                {
                    let p = |x: f32, y: f32| windows_numerics::Vector2 { X: x, Y: y };
                    sink.BeginFigure(p(cx0 - 5.0, cy - 8.0), D2D1_FIGURE_BEGIN_FILLED);
                    sink.AddLine(p(cx0 + 8.0, cy));
                    sink.AddLine(p(cx0 - 5.0, cy + 8.0));
                    sink.EndFigure(D2D1_FIGURE_END_CLOSED);
                    if sink.Close().is_ok() {
                        dc.FillGeometry(&path, cx.solid(white), None);
                    }
                }
            }
        }
        // The scrubber.
        let (time, duration) = self.times();
        let (start, end) = scrubber(w);
        if end > start {
            let fraction = if duration > 0.0 {
                (time / duration).clamp(0.0, 1.0) as f32
            } else {
                0.0
            };
            let track = |x0: f32, x1: f32| D2D1_ROUNDED_RECT {
                rect: rect_f(x0, cy - 2.0, (x1 - x0).max(0.0), 4.0),
                radiusX: 2.0,
                radiusY: 2.0,
            };
            let knob = start + (end - start) * fraction;
            // SAFETY: as above.
            unsafe {
                dc.FillRoundedRectangle(
                    &track(start, end),
                    cx.solid(Color::rgba(255, 255, 255, 90)),
                );
                dc.FillRoundedRectangle(&track(start, knob), cx.solid(white));
                let r = if self.scrubbing.get() { 7.0 } else { 6.0 };
                dc.FillEllipse(
                    &D2D1_ELLIPSE {
                        point: windows_numerics::Vector2 { X: knob, Y: cy },
                        radiusX: r,
                        radiusY: r,
                    },
                    cx.solid(white),
                );
            }
        }
        // The time.
        if let Some(format) = time_format() {
            let text: Vec<u16> = format!("{} / {}", clock(time), clock(duration))
                .encode_utf16()
                .collect();
            // SAFETY: as above, with a valid string and format.
            unsafe {
                dc.DrawText(
                    &text,
                    &format,
                    &rect_f(w - TIME, top, TIME - 10.0, BAR),
                    cx.solid(white),
                    D2D1_DRAW_TEXT_OPTIONS_NONE,
                    DWRITE_MEASURING_MODE_NATURAL,
                );
            }
        }
    }
}

impl Hosted for VideoItem {
    fn draw(&self, cx: &mut DrawCx<'_>, size: (f32, f32)) {
        let (w, h) = size;
        cx.push_clip_rect(0.0, 0.0, w, h);
        if let Some(frame) = &*self.frame.borrow()
            && frame.filled
            && frame.generation == gfx::generation()
        {
            let natural = (frame.size.0 as f32, frame.size.1 as f32);
            let (x, y, fw, fh) = fit(self.resize_mode(), natural, size);
            // SAFETY: a Direct2D call between BeginDraw and EndDraw, with a
            // bitmap of the context's device.
            unsafe {
                cx.dc.DrawBitmap(
                    &frame.bitmap,
                    Some(&rect_f(x, y, fw, fh)),
                    1.0,
                    D2D1_INTERPOLATION_MODE_LINEAR,
                    None,
                    None,
                );
            }
        }
        if self.controls() {
            self.draw_bar(cx, size);
        }
        cx.pop();
    }

    fn hit(&self, x: f32, y: f32, size: (f32, f32)) -> bool {
        // Only the control bar: touches elsewhere go to the view.
        self.controls() && x >= 0.0 && x < size.0 && y >= size.1 - BAR && y < size.1
    }

    fn pointer(&self, event: &ItemPointer) -> bool {
        let Some(surface) = self.surface() else {
            return false;
        };
        let Some(width) = super::view_of(&surface, self.id).map(|v| v.state().frame.size.width.0)
        else {
            return false;
        };
        match event.kind {
            PointerKind::Down if event.x < BUTTON => {
                let engine = self.engine.borrow().clone();
                if let Some(engine) = engine {
                    // SAFETY: calls on a live engine.
                    unsafe {
                        if self.playing() {
                            let _ = engine.Pause();
                        } else {
                            if engine.IsEnded().as_bool() {
                                let _ = engine.SetCurrentTime(0.0);
                            }
                            let _ = engine.Play();
                        }
                    }
                }
            }
            PointerKind::Down => {
                self.scrubbing.set(true);
                self.scrub(event.x, width);
            }
            PointerKind::Move if self.scrubbing.get() => self.scrub(event.x, width),
            PointerKind::Up | PointerKind::Cancel => self.scrubbing.set(false),
            _ => return false,
        }
        surface.invalidate();
        true
    }

    fn cursor(&self, x: f32, _y: f32) -> Option<Cursor> {
        self.controls().then_some(if x < BUTTON {
            Cursor::Hand
        } else {
            Cursor::Arrow
        })
    }
}

/// The scrubber's ends on a control bar `width` wide.
fn scrubber(width: f32) -> (f32, f32) {
    (BUTTON + 8.0, width - TIME - 4.0)
}

/// Where a picture of `natural` size goes in a box of `size` (x, y, width,
/// height).
fn fit(mode: ResizeMode, natural: (f32, f32), size: (f32, f32)) -> (f32, f32, f32, f32) {
    let (nw, nh) = natural;
    let (w, h) = size;
    if nw <= 0.0 || nh <= 0.0 || matches!(mode, ResizeMode::Stretch) {
        return (0.0, 0.0, w, h);
    }
    let s = match mode {
        ResizeMode::Cover => (w / nw).max(h / nh),
        // Natural size (cropped where larger).
        ResizeMode::Center => 1.0,
        // Shrunk to fit, never enlarged.
        ResizeMode::ScaleDown => (w / nw).min(h / nh).min(1.0),
        _ => (w / nw).min(h / nh),
    };
    let (fw, fh) = (nw * s, nh * s);
    ((w - fw) / 2.0, (h - fh) / 2.0, fw, fh)
}

/// A time for the control bar: `m:ss`, `h:mm:ss` from an hour on.
fn clock(seconds: f64) -> String {
    let total = if seconds.is_finite() && seconds > 0.0 {
        seconds.floor() as u64
    } else {
        0
    };
    let (h, m, s) = (total / 3600, total / 60 % 60, total % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m}:{s:02}")
    }
}

/// `x`, or 0 when it is not a finite number (live streams have no
/// duration).
fn finite(x: f64) -> f64 {
    if x.is_finite() { x } else { 0.0 }
}

fn load_payload(duration: f64, width: u32, height: u32) -> EventPayload {
    EventPayload::Map(vec![
        ("duration", PayloadValue::Number(finite(duration))),
        ("width", PayloadValue::Number(width as f64)),
        ("height", PayloadValue::Number(height as f64)),
    ])
}

fn progress_payload(time: f64, duration: f64) -> EventPayload {
    EventPayload::Map(vec![
        ("currentTime", PayloadValue::Number(finite(time))),
        ("duration", PayloadValue::Number(finite(duration))),
    ])
}

fn buffer_payload(buffering: bool) -> EventPayload {
    EventPayload::Map(vec![("isBuffering", PayloadValue::Bool(buffering))])
}

/// What a media engine error means, for apps.
fn media_error(code: u16, hr: i32) -> String {
    let what = match code {
        1 => "Loading was aborted.",
        2 => "A network error stopped the download.",
        3 => "The video cannot be decoded.",
        4 => "The source cannot be played (unsupported format, or not found).",
        5 => "The video is encrypted.",
        _ => "The video cannot be played.",
    };
    if hr == 0 {
        what.to_owned()
    } else {
        format!("{what} (0x{:08X})", hr as u32)
    }
}

/// Media Foundation, started once for the process.
fn mf_started() -> bool {
    static STARTED: OnceLock<bool> = OnceLock::new();
    *STARTED.get_or_init(|| {
        // SAFETY: process-wide startup; never shut down (the process may
        // play videos until it exits).
        match unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) } {
            Ok(()) => true,
            Err(err) => {
                log::error!("cannot start Media Foundation: {err}");
                false
            }
        }
    })
}

thread_local! {
    /// The device manager media engines decode with: the thread's Direct3D
    /// device, its reset token, and the device generation it holds.
    static MANAGER: RefCell<Option<(IMFDXGIDeviceManager, u32, u64)>> = const { RefCell::new(None) };
}

/// The thread's DXGI device manager, holding the current device.
fn device_manager() -> Result<IMFDXGIDeviceManager> {
    let gfx = gfx::get()?;
    let generation = gfx::generation();
    MANAGER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some((manager, token, held)) = &mut *slot {
            if *held != generation {
                protect(&gfx);
                // SAFETY: a call on a live manager with its own token.
                unsafe { manager.ResetDevice(&gfx.d3d, *token)? };
                *held = generation;
            }
            return Ok(manager.clone());
        }
        protect(&gfx);
        let mut token = 0u32;
        let mut manager = None;
        // SAFETY: out pointers to locals.
        unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager)? };
        let manager = manager.ok_or_else(|| {
            windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
        })?;
        // SAFETY: a call on the manager just made.
        unsafe { manager.ResetDevice(&gfx.d3d, token)? };
        *slot = Some((manager.clone(), token, generation));
        Ok(manager)
    })
}

/// Media Foundation decodes on the device from its own threads: Direct3D
/// must serialize the immediate context.
fn protect(gfx: &gfx::Gfx) {
    // SAFETY: plain COM calls on the live device.
    unsafe {
        if let Ok(context) = gfx.d3d.GetImmediateContext()
            && let Ok(mt) = context.cast::<ID3D11Multithread>()
        {
            let _ = mt.SetMultithreadProtected(true);
        }
    }
}

/// A media engine reporting to a [`Notify`] for video `id` of surface
/// `key` (which lives on `ui`), source `serial`.
fn make_engine(key: u64, ui: UiThread, id: NodeId, serial: u64) -> Result<IMFMediaEngine> {
    if !mf_started() {
        return Err(windows::core::Error::from_hresult(
            windows::Win32::Foundation::E_FAIL,
        ));
    }
    let manager = device_manager()?;
    let notify: IMFMediaEngineNotify = Notify {
        key,
        ui,
        id,
        serial,
    }
    .into();
    // SAFETY: COM calls with valid attributes; the factory needs Media
    // Foundation started (above).
    unsafe {
        let mut attributes: Option<IMFAttributes> = None;
        MFCreateAttributes(&mut attributes, 3)?;
        let attributes = attributes.ok_or_else(|| {
            windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
        })?;
        attributes.SetUnknown(&MF_MEDIA_ENGINE_DXGI_MANAGER, &manager)?;
        attributes.SetUnknown(&MF_MEDIA_ENGINE_CALLBACK, &notify)?;
        attributes.SetUINT32(
            &MF_MEDIA_ENGINE_VIDEO_OUTPUT_FORMAT,
            DXGI_FORMAT_B8G8R8A8_UNORM.0 as u32,
        )?;
        let factory: IMFMediaEngineClassFactory =
            CoCreateInstance(&CLSID_MFMediaEngineClassFactory, None, CLSCTX_INPROC_SERVER)?;
        factory.CreateInstance(0, &attributes)
    }
}

/// A BGRA texture of `size` pixels and the Direct2D bitmap on it.
fn make_frame(gfx: &gfx::Gfx, size: (u32, u32), generation: u64) -> Result<Frame> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: size.0,
        Height: size.1,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    // SAFETY: COM calls on the live devices with a valid description.
    unsafe {
        let mut texture = None;
        gfx.d3d.CreateTexture2D(&desc, None, Some(&mut texture))?;
        let texture: ID3D11Texture2D = texture.ok_or_else(|| {
            windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
        })?;
        let surface: IDXGISurface = texture.cast()?;
        let bitmap = gfx.dc.CreateBitmapFromDxgiSurface(
            &surface,
            Some(&D2D1_BITMAP_PROPERTIES1 {
                pixelFormat: D2D1_PIXEL_FORMAT {
                    format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    alphaMode: D2D1_ALPHA_MODE_IGNORE,
                },
                dpiX: 96.0,
                dpiY: 96.0,
                bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
                colorContext: std::mem::ManuallyDrop::new(None),
            }),
        )?;
        Ok(Frame {
            texture,
            bitmap,
            size,
            generation,
            filled: false,
        })
    }
}

/// The control bar's time format, made once per thread.
fn time_format() -> Option<IDWriteTextFormat> {
    thread_local! {
        static FORMAT: Option<IDWriteTextFormat> = {
            // SAFETY: plain DirectWrite calls with valid strings.
            unsafe {
                gfx::dwrite()
                    .CreateTextFormat(
                        &HSTRING::from("Segoe UI"),
                        None,
                        DWRITE_FONT_WEIGHT_NORMAL,
                        DWRITE_FONT_STYLE_NORMAL,
                        DWRITE_FONT_STRETCH_NORMAL,
                        12.0,
                        &HSTRING::from(""),
                    )
                    .ok()
                    .inspect(|f| {
                        let _ = f.SetTextAlignment(DWRITE_TEXT_ALIGNMENT_TRAILING);
                        let _ = f.SetParagraphAlignment(DWRITE_PARAGRAPH_ALIGNMENT_CENTER);
                    })
            }
        };
    }
    FORMAT.with(Clone::clone)
}

/// Receives the media engine's notifications (on Media Foundation's
/// threads) and posts them to the surface's UI thread.
#[implement(IMFMediaEngineNotify)]
struct Notify {
    key: u64,
    /// The UI thread of the surface, where notifications return to.
    ui: UiThread,
    id: NodeId,
    serial: u64,
}

impl IMFMediaEngineNotify_Impl for Notify_Impl {
    fn EventNotify(&self, event: u32, param1: usize, param2: u32) -> Result<()> {
        let (key, id, serial) = (self.key, self.id, self.serial);
        self.ui.invoke(move || {
            let Some(surface) = Surface::by_key(key) else {
                return;
            };
            let item = match surface.native.hosts.try_borrow() {
                Ok(hosts) => match hosts.get(&id) {
                    Some(super::Host::Video(item)) => Some(item.clone()),
                    _ => None,
                },
                Err(_) => None,
            };
            if let Some(item) = item {
                item.notified(&surface, serial, event, param1, param2);
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_times() {
        assert_eq!(clock(0.0), "0:00");
        assert_eq!(clock(5.9), "0:05");
        assert_eq!(clock(75.0), "1:15");
        assert_eq!(clock(3725.0), "1:02:05");
        assert_eq!(clock(f64::NAN), "0:00");
        assert_eq!(clock(f64::INFINITY), "0:00");
    }

    #[test]
    fn fits_pictures() {
        let natural = (1920.0, 1080.0);
        assert_eq!(
            fit(ResizeMode::Stretch, natural, (100.0, 100.0)),
            (0.0, 0.0, 100.0, 100.0)
        );
        let (x, y, w, h) = fit(ResizeMode::Contain, natural, (320.0, 320.0));
        assert_eq!((x, w), (0.0, 320.0));
        assert!((h - 180.0).abs() < 1e-3 && (y - 70.0).abs() < 1e-3);
        let (x, y, w, h) = fit(ResizeMode::Cover, natural, (320.0, 320.0));
        assert_eq!((y, h), (0.0, 320.0));
        assert!(w > 320.0 && x < 0.0);
        // Center and scale-down never enlarge; center never shrinks.
        for mode in [ResizeMode::Center, ResizeMode::ScaleDown] {
            assert_eq!(
                fit(mode, (100.0, 50.0), (400.0, 200.0)),
                (150.0, 75.0, 100.0, 50.0)
            );
        }
        assert_eq!(
            fit(ResizeMode::Center, (800.0, 400.0), (400.0, 200.0)),
            (-200.0, -100.0, 800.0, 400.0)
        );
        // No size yet: the box.
        assert_eq!(
            fit(ResizeMode::Contain, (0.0, 0.0), (10.0, 20.0)),
            (0.0, 0.0, 10.0, 20.0)
        );
    }

    #[test]
    fn makes_payloads() {
        assert_eq!(
            load_payload(f64::NAN, 640, 360),
            EventPayload::Map(vec![
                ("duration", PayloadValue::Number(0.0)),
                ("width", PayloadValue::Number(640.0)),
                ("height", PayloadValue::Number(360.0)),
            ])
        );
        assert_eq!(
            progress_payload(1.5, 10.0),
            EventPayload::Map(vec![
                ("currentTime", PayloadValue::Number(1.5)),
                ("duration", PayloadValue::Number(10.0)),
            ])
        );
        assert_eq!(
            buffer_payload(true),
            EventPayload::Map(vec![("isBuffering", PayloadValue::Bool(true))])
        );
    }

    #[test]
    fn words_media_errors() {
        assert_eq!(media_error(3, 0), "The video cannot be decoded.");
        assert_eq!(
            media_error(4, 0xC00D36C4u32 as i32),
            "The source cannot be played (unsupported format, or not found). (0xC00D36C4)"
        );
    }

    #[test]
    fn lays_out_the_scrubber() {
        let (start, end) = scrubber(400.0);
        assert!(start > BUTTON && end < 400.0 - TIME + 1.0 && end > start);
    }
}

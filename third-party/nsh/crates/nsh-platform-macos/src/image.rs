//! `<Image>`: loading (`asset:/`, files, HTTP, `data:` URIs and `blob:`
//! URLs, whose bytes the source carries), decoding with
//! ImageIO off the main thread, and showing the result in an image sublayer
//! of the view ([`crate::decor`]).
//!
//! Loads go through the core's shared loader and decoded images
//! ([`nsh_core::image::Images`], `docs/dev/images.md`): one read per source
//! in flight, reads and decodes on their own pools, the encoded bytes and
//! failures remembered, and pictures kept in the process's image budget,
//! leased by the views that show them. An image decodes at the size its
//! view shows it ([`Want`]: the size bucket covering its box in device
//! pixels, never above its natural size) with ImageIO thumbnails
//! (`CGImageSourceCreateThumbnailAtIndex`); a view that grows past its
//! bucket loads the next one. A picture's pixels are its CGImages'; Core
//! Animation draws them from there, so they count once.
//!
//! A blur (`blurRadius`, `blur()`) and the color matrix of the view's other
//! filters are baked into the pixels ([`crate::blur`]): such a picture is a
//! variant of the decoded one, an entry of its own in the same budget.
//!
//! A view decodes once its frame is known: the core sends the image before
//! the frame, so [`set`] waits for [`crate::decor::apply`] to see a size
//! (or the next display frame, for views that stay empty).
//!
//! SVG images (sniffed from their bytes) are drawn by
//! [`nsh_core::svg`] at the bucket's size, then go through the same blur,
//! color matrix, tint and budget as decoded bitmaps; their size is their
//! intrinsic size in points (CSS pixels of the SVG). Canvases draw bitmaps
//! only.
//!
//! Animated GIF / PNG / WebP images play through a keyframe animation of the
//! layer's `contents`. The `placeholder` shows until the image arrives (and
//! stays on error); an image that had to load fades in over `fadeDuration`
//! (default 0, as iOS).

use std::{
    any::Any,
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{
        Arc, LazyLock, Mutex,
        atomic::Ordering,
        mpsc::{self, RecvTimeoutError},
    },
    time::{Duration, Instant},
};

use dispatch2::{DispatchQueue, DispatchQueueGlobalPriority, GlobalQueueIdentifier};
pub use nsh_core::image::loader::AssetBase;
use nsh_core::{
    Command, EventKind, EventPayload, ImageData, ImageOptions, ImageSource, NodeId, PayloadValue,
    ResizeMode,
    access::Access,
    geometry::{DevicePixels, Size, size},
    image::{
        CacheHeaders, DiskCache, Fetched, Frames, Images, Key, Lease, MemoryCache, Natural,
        Request, Target, Want,
        loader::{Context, Get, Priority, ReadAsset, Ticket, Transport, loader},
    },
};
use objc2::{
    AnyThread, DefinedClass, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::ProtocolObject,
};
use objc2_core_foundation::{
    CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGFloat, kCFBooleanTrue,
};
use objc2_core_graphics::CGImage;
use objc2_foundation::{
    NSData, NSError, NSHTTPURLResponse, NSMutableURLRequest, NSObject, NSObjectProtocol, NSString,
    NSURL, NSURLRequest, NSURLRequestCachePolicy, NSURLResponse, NSURLSession,
    NSURLSessionDataDelegate, NSURLSessionDataTask, NSURLSessionDelegate,
    NSURLSessionResponseDisposition, NSURLSessionTask, NSURLSessionTaskDelegate,
};
use objc2_image_io::{
    CGImageSource, kCGImageSourceCreateThumbnailFromImageAlways,
    kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceShouldCacheImmediately,
    kCGImageSourceThumbnailMaxPixelSize,
};
use rustc_hash::FxHashMap;

use crate::{
    surface::{Surface, quiet},
    view::{NshView, ViewObj},
};

/// Frames of an animated image decoded at most (longer ones play the first
/// ones).
const MAX_FRAMES: usize = 600;

/// Reads `asset:/…` files for the engine (fonts): synchronously, on the
/// engine thread.
pub(crate) struct AssetReader(pub(crate) Option<AssetBase>);

impl nsh_engine::Assets for AssetReader {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        if !uri.starts_with("asset:/") {
            return Err(format!("not an asset URI: {uri}"));
        }
        let context = Context {
            asset_base: self.0.clone(),
            ..Context::default()
        };
        match context.resolve(uri) {
            Some(location) => {
                nsh_core::image::loader::read_now(&location, &context).map(|b| b.to_vec())
            }
            None => Err(format!("{uri}: no asset location configured")),
        }
    }

    fn base(&self) -> Option<AssetBase> {
        self.0.clone()
    }
}

/// The disk cache of what this surface's images download (`None`: none).
pub(crate) fn set_disk_cache(surface: &Surface, cache: Option<DiskCache>) {
    *surface.image_cache.borrow_mut() = cache;
}

/// Where this surface's images resolve `asset:/` URIs.
pub(crate) fn set_asset_base(surface: &Rc<Surface>, base: Option<AssetBase>) {
    *surface.asset_base.borrow_mut() = base;
}

/// Where a surface's image `asset:/` URIs go: the location its asset base
/// names, or the reader bound to an engine load. `Engine(None)` disables them
/// rather than falling back to a base.
#[derive(Default)]
pub(crate) enum AssetSource {
    #[default]
    Base,
    Engine(Option<ReadAsset>),
}

impl AssetSource {
    pub(crate) fn engine(assets: Option<Arc<dyn nsh_engine::Assets>>) -> Self {
        Self::Engine(assets.map(|assets| ReadAsset::new(move |uri: &str| assets.read(uri))))
    }
}

/// What a load of `uri` for `surface` goes through: its asset base and,
/// for remote images, its disk cache (`asset:/` URIs, served by the dev
/// server during development, change as the app does: never kept).
/// Surfaces here keep no access policy: redirects are allowed anywhere
/// but from `https` down to `http`.
fn context(surface: &Surface, uri: &str) -> Context {
    let remote = uri.starts_with("http://") || uri.starts_with("https://");
    let (asset_base, read_asset) = match &*surface.image_assets.borrow() {
        AssetSource::Base => (surface.asset_base.borrow().clone(), None),
        AssetSource::Engine(read) => (None, read.clone()),
    };
    Context {
        asset_base,
        read_asset,
        access: Arc::default(),
        disk: remote
            .then(|| surface.image_cache.borrow().clone())
            .flatten(),
        transport: None,
    }
}

/// Has the core loader download with `NSURLSession` ([`UrlSession`]), for
/// every load of the process (the engine's `svg()` too).
pub(crate) fn install_transport() {
    nsh_core::image::loader::set_transport(Arc::new(UrlSession));
}

/// What a download's delegate hears (on the session's queue).
enum Heard {
    /// The response's status, size (0: unknown) and caching headers.
    Response(u16, u64, CacheHeaders),
    Data(Vec<u8>),
    /// The task ended (with an error).
    Done(Option<String>),
}

struct DownloadIvars {
    heard: Mutex<mpsc::Sender<Heard>>,
    /// The URL of the hop it is at, the redirects so far, and why one was
    /// refused.
    hop: Mutex<(String, usize, Option<String>)>,
    access: Access,
}

define_class!(
    /// A download's delegate: hands what it hears to the loader thread that
    /// waits for it, and checks every redirect.
    #[unsafe(super(NSObject))]
    #[name = "NshImageDownload"]
    #[ivars = DownloadIvars]
    struct ImageDownload;

    unsafe impl NSObjectProtocol for ImageDownload {}

    unsafe impl NSURLSessionDelegate for ImageDownload {}

    unsafe impl NSURLSessionTaskDelegate for ImageDownload {
        #[unsafe(method(URLSession:task:didCompleteWithError:))]
        fn did_complete(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionTask,
            error: Option<&NSError>,
        ) {
            let error = error.map(|e| e.localizedDescription().to_string());
            self.hear(Heard::Done(error));
        }

        #[unsafe(method(URLSession:task:willPerformHTTPRedirection:newRequest:completionHandler:))]
        fn will_redirect(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionTask,
            _response: &NSHTTPURLResponse,
            request: &NSURLRequest,
            completion: &block2::DynBlock<dyn Fn(*mut NSURLRequest)>,
        ) {
            let next = request
                .URL()
                .and_then(|u| u.absoluteString())
                .map(|u| u.to_string())
                .unwrap_or_default();
            let mut hop = self.ivars().hop.lock().unwrap_or_else(|e| e.into_inner());
            let granted = match hop.1 {
                n if n >= nsh_core::image::loader::MAX_REDIRECTS => {
                    Err("too many redirects".to_owned())
                }
                _ => nsh_core::image::loader::redirect(&self.ivars().access, &hop.0, &next),
            };
            match granted {
                Ok(url) => {
                    hop.0 = url;
                    hop.1 += 1;
                    drop(hop);
                    completion.call((request as *const NSURLRequest as *mut NSURLRequest,));
                }
                Err(refused) => {
                    hop.2 = Some(refused);
                    drop(hop);
                    // Not followed: the redirect is the response, and the
                    // refusal its error.
                    completion.call((std::ptr::null_mut(),));
                }
            }
        }
    }

    unsafe impl NSURLSessionDataDelegate for ImageDownload {
        #[unsafe(method(URLSession:dataTask:didReceiveResponse:completionHandler:))]
        fn did_receive_response(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionDataTask,
            response: &NSURLResponse,
            completion: &block2::DynBlock<dyn Fn(NSURLSessionResponseDisposition)>,
        ) {
            let total = response.expectedContentLength().max(0) as u64;
            let (status, headers) = match response.downcast_ref::<NSHTTPURLResponse>() {
                Some(http) => (http.statusCode().clamp(0, 999) as u16, cache_headers(http)),
                None => (200, CacheHeaders::default()),
            };
            self.hear(Heard::Response(status, total, headers));
            completion.call((NSURLSessionResponseDisposition::Allow,));
        }

        #[unsafe(method(URLSession:dataTask:didReceiveData:))]
        fn did_receive_data(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionDataTask,
            data: &NSData,
        ) {
            self.hear(Heard::Data(data.to_vec()));
        }
    }
);

impl ImageDownload {
    fn hear(&self, heard: Heard) {
        let tx = self.ivars().heard.lock().unwrap_or_else(|e| e.into_inner());
        let _ = tx.send(heard);
    }
}

/// The caching headers of `response`.
fn cache_headers(response: &NSHTTPURLResponse) -> CacheHeaders {
    let (keys, values) = response.allHeaderFields().to_vecs();
    let pairs: Vec<(String, String)> = keys
        .iter()
        .zip(values.iter())
        .filter_map(|(k, v)| {
            let k = k.downcast_ref::<NSString>()?;
            let v = v.downcast_ref::<NSString>()?;
            Some((k.to_string(), v.to_string()))
        })
        .collect();
    CacheHeaders::from_pairs(pairs.iter().map(|(k, v)| (k.as_str(), v.as_str())))
}

/// Downloads with the shared `NSURLSession`: the system's proxies,
/// authentication and App Transport Security apply. The core loader keeps
/// the policy; this keeps its limits: every redirect checked
/// ([`nsh_core::image::loader::redirect`]), at most
/// [`nsh_core::image::loader::MAX_BYTES`], a [`nsh_core::image::loader::TIMEOUT`]
/// a request, and the task cancelled as soon as nobody waits for it.
struct UrlSession;

impl Transport for UrlSession {
    fn get(&self, get: Get<'_>) -> Result<Fetched, String> {
        use nsh_core::image::loader::{MAX_BYTES, TIMEOUT};
        let ns = NSURL::URLWithString(&NSString::from_str(get.url))
            .ok_or_else(|| format!("bad URL {}", get.url))?;
        let (tx, rx) = mpsc::channel();
        let delegate = ImageDownload::alloc().set_ivars(DownloadIvars {
            heard: Mutex::new(tx),
            hop: Mutex::new((get.url.to_owned(), 0, None)),
            access: get.access.clone(),
        });
        // SAFETY: NSObject's designated initializer.
        let delegate: Retained<ImageDownload> = unsafe { msg_send![super(delegate), init] };
        let request = NSMutableURLRequest::requestWithURL(&ns);
        request.setTimeoutInterval(TIMEOUT.as_secs_f64());
        if get.cached {
            // The disk cache answers for these: the shared URL cache must not
            // serve a copy it never saw (nor hide a revalidation's 304).
            request.setCachePolicy(NSURLRequestCachePolicy::ReloadIgnoringLocalCacheData);
        }
        for (name, value) in get.headers {
            request.setValue_forHTTPHeaderField(
                Some(&NSString::from_str(value)),
                &NSString::from_str(name),
            );
        }
        let task = NSURLSession::sharedSession().dataTaskWithRequest(&request);
        // The task keeps its delegate until it completes.
        task.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        task.resume();
        let give_up = |why: String| {
            task.cancel();
            Err(why)
        };
        let deadline = Instant::now() + TIMEOUT;
        let (mut status, mut total, mut headers) = (0, 0, CacheHeaders::default());
        let mut bytes = Vec::new();
        loop {
            if get.cancelled.load(Ordering::Relaxed) {
                return give_up("cancelled".into());
            }
            if Instant::now() >= deadline {
                return give_up("timed out".into());
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Heard::Response(s, t, h)) => {
                    if t > MAX_BYTES {
                        return give_up(format!("larger than {MAX_BYTES} bytes"));
                    }
                    (status, total, headers) = (s, t, h);
                    bytes.clear();
                }
                Ok(Heard::Data(data)) => {
                    bytes.extend_from_slice(&data);
                    if bytes.len() as u64 > MAX_BYTES {
                        return give_up(format!("larger than {MAX_BYTES} bytes"));
                    }
                    (get.progress)(bytes.len() as u64, total);
                }
                Ok(Heard::Done(error)) => {
                    let refused = delegate
                        .ivars()
                        .hop
                        .lock()
                        .ok()
                        .and_then(|mut h| h.2.take());
                    if let Some(refused) = refused {
                        return Err(refused);
                    }
                    if let Some(error) = error {
                        return Err(error);
                    }
                    return Ok(Fetched::new(status, headers, bytes));
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return Err("download lost".into()),
            }
        }
    }
}

/// A decoded image: its frames (one unless animated) and its own size.
#[derive(Clone)]
pub(crate) struct Picture {
    /// The frames, each once.
    pub(crate) frames: Arc<[CFRetained<CGImage>]>,
    /// When each frame starts, as a fraction of `duration`, and 1 at the
    /// end (a discrete keyframe animation's times).
    pub(crate) key_times: Arc<[f64]>,
    /// One loop of the animation, in seconds.
    pub(crate) duration: f64,
    /// Its own size (an SVG's in points: what it lays out at and reports,
    /// whatever its file name says), whatever size it was decoded at.
    natural: Natural,
}

// SAFETY: CGImages are immutable and documented as thread-safe; they are
// created off the main thread, then shared.
unsafe impl Send for Picture {}
// SAFETY: as above: nothing in a picture changes once made.
unsafe impl Sync for Picture {}

impl Picture {
    /// The decoded width in pixels (of the first frame).
    pub(crate) fn pixel_width(&self) -> usize {
        CGImage::width(Some(&self.frames[0]))
    }

    /// The decoded longest side in pixels (of the first frame).
    fn pixel_longest(&self) -> u32 {
        let first = Some(&*self.frames[0]);
        CGImage::width(first).max(CGImage::height(first)) as u32
    }

    /// Bytes its pixels take (4 per pixel, every frame).
    fn cost(&self) -> usize {
        self.frames
            .iter()
            .map(|f| CGImage::width(Some(f)) * CGImage::height(Some(f)) * 4)
            .sum()
    }
}

/// What a view's filters bake into a picture's pixels: a blur radius in
/// pixels and a color matrix.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct Look {
    blur: f64,
    matrix: Option<[f32; 20]>,
}

/// A picture with a [`Look`]: the decoded entry's key and the look's bits.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Variant {
    image: Key,
    blur: u64,
    matrix: Option<[u32; 20]>,
}

impl Look {
    /// It changes nothing.
    fn plain(&self) -> bool {
        self.blur <= 0.0 && self.matrix.is_none()
    }

    /// The key of the decoded entry `image` with this look.
    fn variant(&self, image: Key) -> Variant {
        Variant {
            image,
            blur: self.blur.to_bits(),
            matrix: self.matrix.map(|m| m.map(f32::to_bits)),
        }
    }

    /// `picture` with this look (any thread).
    fn apply(&self, picture: &Picture) -> Picture {
        let frames: Vec<CFRetained<CGImage>> = picture
            .frames
            .iter()
            .map(|f| crate::blur::filtered(f, self.blur, self.matrix).unwrap_or_else(|| f.clone()))
            .collect();
        Picture {
            frames: frames.into(),
            ..picture.clone()
        }
    }
}

/// The process's decoded images, in the core's budget.
fn images() -> &'static Images<Picture> {
    static IMAGES: LazyLock<Images<Picture>> = LazyLock::new(|| {
        Images::new(
            nsh_core::image::budget(),
            |bytes: &ImageData, target: &Target| {
                let picture = decode(bytes, target)?;
                let cost = picture.cost();
                Ok((picture.clone(), picture.natural, cost))
            },
        )
    });
    &IMAGES
}

/// Pictures with a look, in the same budget.
fn variants() -> &'static MemoryCache<Variant, Picture> {
    static VARIANTS: LazyLock<MemoryCache<Variant, Picture>> =
        LazyLock::new(|| MemoryCache::new(nsh_core::image::budget()));
    &VARIANTS
}

/// Runs `f` on a global queue.
fn in_background(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
        DispatchQueueGlobalPriority::Default,
    ))
    .exec_async(f);
}

/// Runs `f` on the main queue.
fn on_main_queue(f: impl FnOnce() + Send + 'static) {
    DispatchQueue::main().exec_async(f);
}

/// Called with a load's picture (and the lease that keeps it) or error.
type Done = Box<dyn FnOnce(Result<(Picture, Lease), String>)>;

/// Called with a download's bytes so far and its size (0: unknown).
type Progress = Box<dyn Fn(u64, u64)>;

/// Main-thread callbacks by id.
type Waiting<T> = RefCell<FxHashMap<u64, T>>;

thread_local! {
    /// The main thread's side of the loads running: their callbacks
    /// (`Box<dyn FnOnce(T)>`) and progress listeners, by id.
    static WAITING: Waiting<Box<dyn Any>> = RefCell::default();
    static PROGRESS: Waiting<Rc<dyn Fn(u64, u64)>> = RefCell::default();
    static NEXT: Cell<u64> = const { Cell::new(0) };
}

fn next_id() -> u64 {
    NEXT.with(|n| {
        n.set(n.get() + 1);
        n.get()
    })
}

/// Keeps `f` on the main thread as callback `id`; the function returned
/// runs it there from any thread (queued, also from the main thread),
/// unless it was forgotten ([`Load`]'s drop).
fn on_main<T: Send + 'static>(f: impl FnOnce(T) + 'static) -> (u64, impl FnOnce(T) + Send) {
    let id = next_id();
    let f: Box<dyn FnOnce(T)> = Box::new(f);
    WAITING.with_borrow_mut(|w| w.insert(id, Box::new(f) as Box<dyn Any>));
    let run = move |value: T| {
        on_main_queue(move || {
            let f = WAITING.with_borrow_mut(|w| w.remove(&id));
            if let Some(f) = f.and_then(|f| f.downcast::<Box<dyn FnOnce(T)>>().ok()) {
                f(value);
            }
        });
    };
    (id, run)
}

/// A load running for a view: dropping it gives up (and cancels the load
/// when nobody else waits for it).
pub(crate) struct Load {
    ticket: Option<Ticket>,
    /// Its callback and progress listener.
    ids: (u64, u64),
}

impl Load {
    /// Lets it run to its end, callback included.
    fn detach(mut self) {
        if let Some(ticket) = self.ticket.take() {
            ticket.detach();
        }
    }
}

impl Drop for Load {
    fn drop(&mut self) {
        if self.ticket.is_some() {
            WAITING.with_borrow_mut(|w| w.remove(&self.ids.0));
            PROGRESS.with_borrow_mut(|p| p.remove(&self.ids.1));
        }
    }
}

/// Loads `source` at `want` with `look` for `surface`; `done` runs on the
/// main thread. Returns the load while it runs, `None` when `done` already
/// ran (in memory, or a source that cannot load).
///
/// A cached picture is handed over before this returns: callers must not
/// hold a borrow of view state that `done` takes.
#[allow(clippy::too_many_arguments)]
fn fetch(
    surface: &Surface,
    source: &ImageSource,
    want: Want,
    frames: Frames,
    look: Look,
    priority: Priority,
    progress: Option<Progress>,
    done: Done,
) -> Option<Load> {
    let context = context(surface, &source.uri);
    let Some(location) = context.locate(source) else {
        done(Err(format!("unsupported image source `{}`", source.uri)));
        return None;
    };
    let listener = next_id();
    let progress = progress.map(|p| {
        PROGRESS.with_borrow_mut(|m| m.insert(listener, Rc::from(p)));
        Arc::new(move |loaded: u64, total: u64| {
            on_main_queue(move || {
                if let Some(p) = PROGRESS.with_borrow(|m| m.get(&listener).cloned()) {
                    p(loaded, total);
                }
            });
        }) as nsh_core::image::loader::Progress
    });
    let request = Request {
        location,
        context,
        declared: source.size,
        want,
        frames,
        priority,
        progress,
    };
    // In memory: here and now, as the callers expect.
    if let Some((decoded, lease)) = images().cached(&request) {
        let hit = match look.plain() {
            true => Some((decoded.value, lease)),
            false => variants().get(&look.variant(images().key_of(&request, decoded.natural))),
        };
        if let Some(hit) = hit {
            PROGRESS.with_borrow_mut(|p| p.remove(&listener));
            done(Ok(hit));
            return None;
        }
    }
    let (id, done) = on_main(move |result| {
        PROGRESS.with_borrow_mut(|p| p.remove(&listener));
        done(result);
    });
    let keyed = request.clone();
    let ticket = images().load(
        request,
        Box::new(move |result| {
            let (decoded, lease) = match result {
                Ok(loaded) => loaded,
                Err(e) => return done(Err(e)),
            };
            if look.plain() {
                return done(Ok((decoded.value, lease)));
            }
            let key = look.variant(images().key_of(&keyed, decoded.natural));
            if let Some(hit) = variants().get(&key) {
                return done(Ok(hit));
            }
            // Baked off the decoding threads, the decoded picture kept
            // meanwhile.
            in_background(move || {
                let picture = look.apply(&decoded.value);
                drop(lease);
                let cost = picture.cost();
                let lease = variants().insert(key, picture.clone(), cost);
                done(Ok((picture, lease)));
            });
        }),
    );
    Some(Load {
        ticket: Some(ticket),
        ids: (id, listener),
    })
}

/// Decodes `bytes` at `target` with ImageIO (a thumbnail when it shrinks:
/// `CGImageSourceCreateThumbnailAtIndex`), every frame of an animation
/// when it asks; any thread.
fn decode(bytes: &[u8], target: &Target) -> Result<Picture, String> {
    if nsh_core::svg::sniff(bytes) {
        return decode_svg(bytes, target.longest);
    }
    let data = CFData::from_bytes(bytes);
    // SAFETY: valid data and option dictionaries of the documented types.
    unsafe {
        let source =
            CGImageSource::with_data(&data, None).ok_or("not an image ImageIO can read")?;
        let yes: &CFType = kCFBooleanTrue.ok_or("no kCFBooleanTrue")?;
        let (width, height) = source_size(&source);
        // Never above its own size (a thumbnail can grow it).
        let shrinks = target.longest > 0 && target.longest < width.max(height);
        let max = CFNumber::new_cgfloat(target.longest as CGFloat);
        let mut keys: Vec<&CFString> = vec![
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceShouldCacheImmediately,
        ];
        let mut values: Vec<&CFType> = vec![yes, yes, yes];
        if shrinks {
            keys.push(kCGImageSourceThumbnailMaxPixelSize);
            values.push(&max);
        }
        let options = CFDictionary::from_slices(&keys, &values);
        let options: &CFDictionary = options.as_opaque();
        let count = match target.frames {
            Frames::First => 1,
            Frames::All => source.count().clamp(1, MAX_FRAMES),
        };
        let mut frames = Vec::with_capacity(count);
        let mut delays = Vec::with_capacity(count);
        for i in 0..count {
            let Some(image) = source.thumbnail_at_index(i, Some(options)) else {
                break;
            };
            frames.push(image);
            delays.push(if count > 1 {
                frame_delay(&source, i)
            } else {
                1
            });
        }
        let Some(first) = frames.first() else {
            return Err("cannot decode the image".into());
        };
        let natural = match (width, height) {
            (0, _) | (_, 0) => Natural::Pixels(
                CGImage::width(Some(first)) as u32,
                CGImage::height(Some(first)) as u32,
            ),
            (w, h) => Natural::Pixels(w, h),
        };
        let total: u32 = delays.iter().sum();
        let mut key_times = Vec::with_capacity(frames.len() + 1);
        let mut at = 0;
        for delay in &delays {
            key_times.push(at as f64 / total as f64);
            at += delay;
        }
        key_times.push(1.0);
        Ok(Picture {
            frames: frames.into(),
            key_times: key_times.into(),
            duration: total as f64 / 100.0,
            natural,
        })
    }
}

/// Draws an SVG, its longest side `longest` pixels; any thread.
fn decode_svg(bytes: &[u8], longest: u32) -> Result<Picture, String> {
    let raster = nsh_core::svg::rasterize(bytes, longest.max(1)).map_err(|e| e.to_string())?;
    let image = rgba_image(&raster).ok_or("cannot make a CGImage")?;
    Ok(Picture {
        frames: Arc::new([image]),
        key_times: Arc::new([0.0, 1.0]),
        duration: 0.0,
        natural: Natural::Vector(raster.size),
    })
}

/// The size `onLoad` and `Image.getSize` report: pixels, or an SVG's whole
/// points.
fn reported_size(natural: Natural) -> Size<DevicePixels> {
    match natural {
        Natural::Vector(points) => nsh_core::svg::reported_size(points),
        Natural::Pixels(w, h) => size(DevicePixels(w as i32), DevicePixels(h as i32)),
    }
}

/// The natural size of encoded `bytes` from their header, as displayed
/// (EXIF orientations 5–8 turn it a quarter); an SVG's, parsed.
fn info_size(bytes: &[u8]) -> Option<Natural> {
    if nsh_core::svg::sniff(bytes) {
        return Natural::of(bytes);
    }
    let data = CFData::from_bytes(bytes);
    // SAFETY: valid data; only the header is read.
    let source = unsafe { CGImageSource::with_data(&data, None) }?;
    match source_size(&source) {
        (0, _) | (_, 0) => None,
        (w, h) => Some(Natural::Pixels(w, h)),
    }
}

/// A CGImage of premultiplied sRGB RGBA pixels.
fn rgba_image(raster: &nsh_core::svg::Raster) -> Option<CFRetained<CGImage>> {
    use objc2_core_graphics::{
        CGBitmapContextCreate, CGBitmapContextCreateImage, CGBitmapContextGetBytesPerRow,
        CGBitmapContextGetData, CGColorSpace, CGImageAlphaInfo, CGImageByteOrderInfo,
        kCGColorSpaceSRGB,
    };
    let (width, height) = (raster.width as usize, raster.height as usize);
    // SAFETY: a constant of CoreGraphics.
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }))?;
    // SAFETY: CoreGraphics allocates the pixels (null data) of an RGBA
    // context of these dimensions; the rows are copied within
    // `bytes_per_row * height` bytes while `context` lives.
    unsafe {
        let context = CGBitmapContextCreate(
            std::ptr::null_mut(),
            width,
            height,
            8,
            width * 4,
            Some(&space),
            CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
        )?;
        let data = CGBitmapContextGetData(Some(&context)).cast::<u8>();
        if data.is_null() {
            return None;
        }
        let stride = CGBitmapContextGetBytesPerRow(Some(&context));
        let pixels = std::slice::from_raw_parts_mut(data, stride * height);
        for (row, src) in raster.pixels.chunks_exact(width * 4).enumerate() {
            pixels[row * stride..row * stride + width * 4].copy_from_slice(src);
        }
        CGBitmapContextCreateImage(Some(&context))
    }
}

/// The pixel size of the first image, as displayed (EXIF orientations 5–8
/// turn it a quarter).
pub(crate) fn source_size(source: &CGImageSource) -> (u32, u32) {
    use objc2_image_io::{
        kCGImagePropertyOrientation, kCGImagePropertyPixelHeight, kCGImagePropertyPixelWidth,
    };
    // SAFETY: a CoreFoundation dictionary of CFString keys, read with the
    // documented ImageIO keys and value types.
    unsafe {
        let Some(props) = source.properties_at_index(0, None) else {
            return (0, 0);
        };
        let props: &CFDictionary<CFString, CFType> = props.cast_unchecked();
        let number = |key: &CFString| {
            props
                .get(key)
                .and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_i64()))
                .unwrap_or(0)
                .max(0) as u32
        };
        let (w, h) = (
            number(kCGImagePropertyPixelWidth),
            number(kCGImagePropertyPixelHeight),
        );
        match number(kCGImagePropertyOrientation) {
            5..=8 => (h, w),
            _ => (w, h),
        }
    }
}

/// The delay of frame `i` in centiseconds (GIF's unit), at least 2 (as
/// browsers: shorter ones show for 10).
fn frame_delay(source: &CGImageSource, i: usize) -> u32 {
    use objc2_image_io::{
        kCGImagePropertyAPNGDelayTime, kCGImagePropertyAPNGUnclampedDelayTime,
        kCGImagePropertyGIFDelayTime, kCGImagePropertyGIFDictionary,
        kCGImagePropertyGIFUnclampedDelayTime, kCGImagePropertyPNGDictionary,
        kCGImagePropertyWebPDelayTime, kCGImagePropertyWebPDictionary,
        kCGImagePropertyWebPUnclampedDelayTime,
    };
    // SAFETY: CoreFoundation dictionaries of CFString keys, read with the
    // documented ImageIO keys and value types.
    let seconds = unsafe {
        source.properties_at_index(i, None).and_then(|props| {
            let props: &CFDictionary<CFString, CFType> = props.cast_unchecked();
            [
                (
                    kCGImagePropertyGIFDictionary,
                    kCGImagePropertyGIFUnclampedDelayTime,
                    kCGImagePropertyGIFDelayTime,
                ),
                (
                    kCGImagePropertyPNGDictionary,
                    kCGImagePropertyAPNGUnclampedDelayTime,
                    kCGImagePropertyAPNGDelayTime,
                ),
                (
                    kCGImagePropertyWebPDictionary,
                    kCGImagePropertyWebPUnclampedDelayTime,
                    kCGImagePropertyWebPDelayTime,
                ),
            ]
            .into_iter()
            .find_map(|(dict, unclamped, clamped)| {
                let format = props.get(dict)?;
                let format: &CFDictionary<CFString, CFType> =
                    format.downcast_ref::<CFDictionary>()?.cast_unchecked();
                let number = |key| {
                    format
                        .get(key)
                        .and_then(|v| v.downcast_ref::<CFNumber>().and_then(|n| n.as_cgfloat()))
                        .filter(|s| *s > 0.0)
                };
                number(unclamped).or_else(|| number(clamped))
            })
        })
    };
    match seconds {
        Some(s) if s >= 0.02 => (s * 100.0).round() as u32,
        _ => 10,
    }
}

/// Loads the bitmap `uri` (`https://…`, `asset:/…`, a file path, `data:`)
/// for a canvas, at its natural size, and hands over its (first) frame;
/// `done` runs on the main thread (before this returns when it is in
/// memory: callers must not hold a borrow `done` takes). Canvases draw
/// bitmaps: an SVG is an image that failed to load.
pub(crate) fn load(
    surface: &Rc<Surface>,
    uri: &str,
    done: impl FnOnce(Result<CFRetained<CGImage>, String>) + 'static,
) {
    let name = uri.to_owned();
    let done =
        move |r: Result<(Picture, Lease), String>| done(r.and_then(|(p, _)| bitmap(&name, p)));
    let source = ImageSource {
        uri: uri.into(),
        size: None,
        scales: nsh_core::ImageScales::NONE,
        data: None,
    };
    // A canvas keeps the image itself: the load runs to its end.
    if let Some(load) = fetch(
        surface,
        &source,
        Want::natural(1.0),
        Frames::First,
        Look::default(),
        Priority::Normal,
        None,
        Box::new(done),
    ) {
        load.detach();
    }
}

/// The first frame of `picture`, loaded from `uri`, unless it is an SVG.
fn bitmap(uri: &str, picture: Picture) -> Result<CFRetained<CGImage>, String> {
    match picture.natural {
        Natural::Vector(_) => Err(format!(
            "{uri} is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)"
        )),
        Natural::Pixels(..) => Ok(picture.frames[0].clone()),
    }
}

/// `Command::ImageInfo` (`Image.getSize`, `Image.prefetch`): reads the
/// image's bytes (into the loader's memory and disk caches) and reports its
/// size in pixels (an SVG's: its intrinsic size in points), from its
/// header when it says, else by decoding it.
pub(crate) fn command(surface: &Rc<Surface>, _id: NodeId, command: &Command) {
    let Command::ImageInfo { id, uri } = command else {
        return;
    };
    let request = *id;
    let weak = Rc::downgrade(surface);
    let report = move |result: Result<Natural, String>| {
        let Some(surface) = weak.upgrade() else {
            return;
        };
        let mut fields = vec![("id", PayloadValue::Number(request as f64))];
        match result {
            Ok(natural) => {
                let size = reported_size(natural);
                fields.push(("width", PayloadValue::Number(size.width.0 as f64)));
                fields.push(("height", PayloadValue::Number(size.height.0 as f64)));
            }
            Err(message) => fields.push(("error", PayloadValue::Str(message))),
        }
        surface.event(
            nsh_core::ROOT_ID,
            EventKind::ImageInfo,
            EventPayload::Map(fields),
        );
    };
    let context = context(surface, uri);
    let Some(location) = context.resolve(uri) else {
        report(Err(format!("unsupported image source `{uri}`")));
        return;
    };
    let (_, report) = on_main(report);
    let decode = Request {
        location: location.clone(),
        context: context.clone(),
        declared: None,
        want: Want::natural(1.0),
        frames: Frames::First,
        priority: Priority::Prefetch,
        progress: None,
    };
    // The header first; a decode only for what it cannot tell.
    loader()
        .read(
            location,
            &context,
            Priority::Prefetch,
            None,
            Box::new(move |bytes| match bytes.map(|b| info_size(&b)) {
                Ok(Some(natural)) => report(Ok(natural)),
                Ok(None) => images()
                    .load(decode, Box::new(move |r| report(r.map(|(d, _)| d.natural))))
                    .detach(),
                Err(e) => report(Err(e)),
            }),
        )
        .detach();
}

/// What an image view shows.
#[derive(Default)]
pub(crate) struct ImageState {
    source: Option<ImageSource>,
    options: ImageOptions,
    /// Bumped on every source change: older loads are stale.
    generation: u64,
    /// The source's picture (not the placeholder) shown, and the lease that
    /// keeps it.
    image: Option<Picture>,
    lease: Lease,
    /// The source's load running (a first one, or a larger size).
    load: Option<Load>,
    /// The placeholder's lease and load, until the image shows.
    placeholder_lease: Lease,
    placeholder_load: Option<Load>,
    /// Waiting for a size to decode at.
    pending: bool,
    /// The surface's key ([`Surface::with_key`]).
    surface: u64,
}

/// Sets up an image view.
pub(crate) fn create(view: &NshView) {
    view.state_mut().image = Some(ImageState::default());
}

/// An image view's source changed.
pub(crate) fn set(
    surface: &Rc<Surface>,
    view: &NshView,
    source: Option<&ImageSource>,
    mode: ResizeMode,
    options: &ImageOptions,
) {
    let restart = {
        let mut guard = view.state_mut();
        let s = &mut *guard;
        s.decor.set_fit(mode, options.position);
        let image = s.image.get_or_insert_with(ImageState::default);
        image.surface = surface.key();
        let same_source = image.source.as_ref().map(|i| &i.uri) == source.map(|i| &i.uri);
        let same_look = image.options.placeholder == options.placeholder
            && image.options.blur_radius == options.blur_radius;
        image.options = options.clone();
        if same_source && same_look {
            false
        } else {
            image.generation += 1;
            image.image = None;
            image.lease = Lease::none();
            image.load = None;
            image.placeholder_lease = Lease::none();
            image.placeholder_load = None;
            image.source = source.cloned();
            image.pending = image.source.is_some() || image.options.placeholder.is_some();
            s.decor.set_image(None, 0.0);
            true
        }
    };
    view.changed();
    // A new resize mode may show it larger.
    resume(view);
    if restart {
        wait_for_frame(surface, view);
    }
}

/// The view's filters changed: it decodes again (showing what it shows
/// meanwhile).
pub(crate) fn filters_changed(view: &NshView) {
    {
        let mut guard = view.state_mut();
        let s = &mut *guard;
        let Some(image) = s.image.as_mut() else {
            return;
        };
        if image.source.is_none() {
            return;
        }
        image.generation += 1;
        image.load = None;
        image.pending = true;
    }
    resume(view);
}

/// Starts the view's pending loads once it has a size, or loads a larger
/// size when it grew past the one shown (called whenever its decoration
/// is applied).
pub(crate) fn resume(view: &NshView) {
    let (key, pending, sized) = {
        let s = view.state();
        let Some(i) = &s.image else { return };
        let sized = s.frame.size.width.0 > 0.0 && s.frame.size.height.0 > 0.0;
        (i.surface, i.pending, sized)
    };
    let Some(surface) = Surface::with_key(key) else {
        return;
    };
    match pending {
        true if sized => start(&surface, view),
        true => {}
        false => resized(&surface, view),
    }
}

/// Loads at the natural size if the view still has no size by the next
/// display frame.
fn wait_for_frame(surface: &Rc<Surface>, view: &NshView) {
    let pending = view.state().image.as_ref().is_some_and(|i| i.pending);
    if !pending {
        return;
    }
    let weak = Weak::from_retained(&Retained::from(&**view as &ViewObj));
    surface.add_frame_callback(move |surface, _| {
        if let Some(view) = weak.load().and_then(|v| NshView::from_ns(&v))
            && view.state().image.as_ref().is_some_and(|i| i.pending)
        {
            start(surface, &view);
        }
        false
    });
}

/// The size `view` shows its image at, and the look its filters give it.
fn want(view: &NshView) -> (Want, Look) {
    let scale = view.ns().window().map_or(2.0, |w| w.backingScaleFactor());
    let s = view.state();
    let filters = s
        .style
        .effects
        .as_ref()
        .map(|e| &e.filters[..])
        .unwrap_or(&[]);
    let blur = nsh_core::blur_radius(filters).0;
    let own = s.image.as_ref().map_or(0.0, |i| i.options.blur_radius.0);
    let want = Want {
        size: s.frame.size,
        scale: scale as f32,
        mode: s.decor.resize_mode(),
    };
    let look = Look {
        blur: ((own + blur) as CGFloat * scale).max(0.0),
        matrix: nsh_core::compose_color_matrices(filters),
    };
    (want, look)
}

/// Requests the view's image (and placeholder) at its current size.
fn start(surface: &Rc<Surface>, view: &NshView) {
    let (want, look) = want(view);
    let (generation, source, placeholder, events, id) = {
        let mut guard = view.state_mut();
        let s = &mut *guard;
        let (events, id) = (s.events, s.id);
        let Some(image) = s.image.as_mut() else {
            return;
        };
        image.pending = false;
        let placeholder = image
            .options
            .placeholder
            .clone()
            .filter(|_| image.image.is_none() && image.placeholder_load.is_none());
        (
            image.generation,
            image.source.clone(),
            placeholder,
            events,
            id,
        )
    };
    let weak = Weak::from_retained(&Retained::from(&**view as &ViewObj));
    if let Some(source) = source {
        let progress = events.contains(EventKind::Progress).then(|| {
            let surface = Rc::downgrade(surface);
            let weak = weak.clone();
            Box::new(move |loaded: u64, total: u64| {
                let current = weak
                    .load()
                    .and_then(|v| NshView::from_ns(&v))
                    .is_some_and(|v| {
                        v.state()
                            .image
                            .as_ref()
                            .is_some_and(|i| i.generation == generation)
                    });
                if let (true, Some(surface)) = (current, surface.upgrade()) {
                    surface.event(
                        id,
                        EventKind::Progress,
                        EventPayload::Map(vec![
                            ("loaded", PayloadValue::Number(loaded as f64)),
                            ("total", PayloadValue::Number(total as f64)),
                        ]),
                    );
                }
            }) as Progress
        });
        // Fades only what had to wait.
        let waited = Rc::new(Cell::new(false));
        let done = {
            let surface = Rc::downgrade(surface);
            let weak = weak.clone();
            let waited = waited.clone();
            move |result: Result<(Picture, Lease), String>| {
                let view = weak.load().and_then(|v| NshView::from_ns(&v));
                if let (Some(view), Some(surface)) = (view, surface.upgrade()) {
                    loaded(&surface, &view, generation, result, waited.get());
                }
            }
        };
        let load = fetch(
            surface,
            &source,
            want,
            Frames::All,
            look,
            Priority::Visible,
            progress,
            Box::new(done),
        );
        waited.set(true);
        if let Some(load) = load {
            if let Some(i) = view.state_mut().image.as_mut()
                && i.generation == generation
            {
                i.load = Some(load);
            }
            if events.contains(EventKind::LoadStart) {
                surface.event(id, EventKind::LoadStart, EventPayload::None);
            }
        }
    }
    // The placeholder, until the image shows.
    let shown = view
        .state()
        .image
        .as_ref()
        .is_some_and(|i| i.image.is_some());
    let Some(placeholder) = placeholder.filter(|_| !shown) else {
        return;
    };
    let done = move |result: Result<(Picture, Lease), String>| {
        let Some(view) = weak.load().and_then(|v| NshView::from_ns(&v)) else {
            return;
        };
        match result {
            Ok((picture, lease)) => {
                {
                    let mut guard = view.state_mut();
                    let s = &mut *guard;
                    let Some(image) = s
                        .image
                        .as_mut()
                        .filter(|i| i.generation == generation && i.image.is_none())
                    else {
                        return;
                    };
                    image.placeholder_lease = lease;
                    image.placeholder_load = None;
                    let natural = natural(picture.natural, image.options.placeholder.as_ref());
                    s.decor.set_image(Some((&picture, natural)), 0.0);
                }
                view.changed();
            }
            Err(message) => log::warn!("image placeholder failed: {message}"),
        }
    };
    let load = fetch(
        surface,
        &placeholder,
        want,
        Frames::All,
        Look::default(),
        Priority::Visible,
        None,
        Box::new(done),
    );
    if let Some(load) = load
        && let Some(i) = view.state_mut().image.as_mut()
        && i.generation == generation
    {
        i.placeholder_load = Some(load);
    }
}

/// `view`'s frame changed: an image now shown larger than it was decoded
/// loads the larger size, showing the smaller one meanwhile.
fn resized(surface: &Surface, view: &NshView) {
    let (want, look) = want(view);
    let (generation, source) = {
        let s = view.state();
        let Some(image) = s.image.as_ref() else {
            return;
        };
        let (Some(picture), Some(source)) = (&image.image, &image.source) else {
            return;
        };
        if image.load.is_some() || image.pending {
            return;
        }
        let density = context(surface, &source.uri)
            .locate(source)
            .map_or(1.0, |l| l.density());
        let longest = want.longest(picture.natural, density, source.size);
        if longest <= picture.pixel_longest() {
            return;
        }
        (image.generation, source.clone())
    };
    let weak = Weak::from_retained(&Retained::from(&**view as &ViewObj));
    let done = move |result: Result<(Picture, Lease), String>| {
        let Some(view) = weak.load().and_then(|v| NshView::from_ns(&v)) else {
            return;
        };
        {
            let mut guard = view.state_mut();
            let s = &mut *guard;
            let Some(image) = s.image.as_mut().filter(|i| i.generation == generation) else {
                return;
            };
            image.load = None;
            let Ok((picture, lease)) = result else { return };
            // The same image, larger: no new load events.
            let natural = natural(picture.natural, image.source.as_ref());
            image.image = Some(picture.clone());
            image.lease = lease;
            quiet(|| s.decor.set_image(Some((&picture, natural)), 0.0));
        }
        view.changed();
    };
    let load = fetch(
        surface,
        &source,
        want,
        Frames::All,
        look,
        Priority::Visible,
        None,
        Box::new(done),
    );
    if let Some(load) = load
        && let Some(i) = view.state_mut().image.as_mut()
        && i.generation == generation
    {
        i.load = Some(load);
    }
}

/// The source of `view` loaded (or failed); `waited`: it was not cached,
/// so it fades in (when the app asked for a fade).
fn loaded(
    surface: &Surface,
    view: &NshView,
    generation: u64,
    result: Result<(Picture, Lease), String>,
    waited: bool,
) {
    let (events, id) = {
        let mut guard = view.state_mut();
        let s = &mut *guard;
        let (events, id) = (s.events, s.id);
        let Some(image) = s.image.as_mut().filter(|i| i.generation == generation) else {
            return;
        };
        image.load = None;
        match &result {
            Ok((picture, lease)) => {
                image.image = Some(picture.clone());
                image.lease = lease.clone();
                // The image shows: the placeholder is no longer needed.
                image.placeholder_lease = Lease::none();
                image.placeholder_load = None;
                let natural = natural(picture.natural, image.source.as_ref());
                let fade = match image.options.fade_ms {
                    Some(ms) if waited && ms > 0.0 => ms as f64 / 1000.0,
                    _ => 0.0,
                };
                quiet(|| s.decor.set_image(Some((picture, natural)), fade));
            }
            // The placeholder (if any) stays.
            Err(message) => log::warn!("image failed: {message}"),
        }
        (events, id)
    };
    view.changed();
    match &result {
        Ok((picture, _)) if events.contains(EventKind::Load) => surface.event(
            id,
            EventKind::Load,
            EventPayload::Image(reported_size(picture.natural)),
        ),
        Err(message) if events.contains(EventKind::Error) => surface.event(
            id,
            EventKind::Error,
            EventPayload::Error {
                message: message.clone(),
            },
        ),
        _ => {}
    }
    if events.contains(EventKind::LoadEnd) {
        surface.event(id, EventKind::LoadEnd, EventPayload::None);
    }
    // It may have been laid out larger while it loaded.
    if result.is_ok() {
        resized(surface, view);
    }
}

/// The natural size in points of a picture of `own` size loaded from
/// `source`: the size the source declares, an SVG's intrinsic size, or its
/// pixels over the file name's density.
fn natural(own: Natural, source: Option<&ImageSource>) -> (f32, f32) {
    if let Some(size) = source
        .and_then(|s| s.size)
        .map(|s| (s.width.0, s.height.0))
        .filter(|(w, h)| *w > 0.0 && *h > 0.0)
    {
        return size;
    }
    let d = source.map_or(1.0, |s| nsh_core::image::loader::density(&s.uri));
    let points = own.points(d);
    (points.width.0, points.height.0)
}

#[cfg(test)]
mod tests {
    use nsh_core::geometry::Points;

    use super::*;

    const SVG_ICON: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#000"/></svg>"##;
    const SVG_LOGO: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="24" height="24" fill="#f00"/><rect x="24" width="24" height="24" fill="#00f"/></svg>"##;

    /// `bytes` decoded with its longest side `longest` pixels (0: its own).
    fn decoded(bytes: &[u8], longest: u32) -> Result<Picture, String> {
        let target = Target {
            natural: Natural::of(bytes),
            longest,
            frames: Frames::All,
        };
        decode(bytes, &target)
    }

    /// The pixels of `image` as premultiplied sRGB RGBA, row by row.
    fn rgba(image: &CGImage) -> (usize, usize, Vec<u8>) {
        use objc2_core_foundation::{CGPoint, CGRect, CGSize};
        use objc2_core_graphics::{
            CGBitmapContextCreate, CGColorSpace, CGContext, CGImageAlphaInfo, CGImageByteOrderInfo,
            kCGColorSpaceSRGB,
        };
        let (w, h) = (CGImage::width(Some(image)), CGImage::height(Some(image)));
        let mut pixels = vec![0u8; w * h * 4];
        // SAFETY: `pixels` holds `w * 4 * h` bytes and outlives the context.
        unsafe {
            let space = CGColorSpace::with_name(Some(kCGColorSpaceSRGB)).unwrap();
            let context = CGBitmapContextCreate(
                pixels.as_mut_ptr().cast(),
                w,
                h,
                8,
                w * 4,
                Some(&space),
                CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0,
            )
            .unwrap();
            CGContext::draw_image(
                Some(&context),
                CGRect::new(CGPoint::ZERO, CGSize::new(w as f64, h as f64)),
                Some(image),
            );
        }
        (w, h, pixels)
    }

    fn at((w, _, pixels): &(usize, usize, Vec<u8>), x: usize, y: usize) -> [u8; 4] {
        let i = (y * w + x) * 4;
        pixels[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn svg_decodes_at_the_size_shown() {
        let icon = decoded(SVG_ICON, 54).unwrap();
        assert_eq!(
            icon.natural,
            Natural::Vector(Size::new(Points(24.0), Points(24.0)))
        );
        assert_eq!(icon.frames.len(), 1);
        assert_eq!(icon.pixel_width(), 54);
        // `cover` in a square box: its shorter side as long as the box.
        let cover = Want {
            size: Size::new(Points(144.0), Points(144.0)),
            scale: 1.0,
            mode: ResizeMode::Cover,
        };
        let longest = cover.longest(Natural::of(SVG_LOGO).unwrap(), 1.0, None);
        let logo = decoded(SVG_LOGO, longest).unwrap();
        assert!(
            CGImage::height(Some(&logo.frames[0])) >= 144,
            "sharp when `cover` crops it"
        );
        let logo = decoded(SVG_LOGO, 288).unwrap();
        let first = &logo.frames[0];
        assert_eq!(
            (CGImage::width(Some(first)), CGImage::height(Some(first))),
            (288, 144)
        );
        // Colours survive the trip through CGImage.
        let pixels = rgba(first);
        assert_eq!(at(&pixels, 10, 36), [255, 0, 0, 255]);
        assert_eq!(at(&pixels, 270, 72), [0, 0, 255, 255]);
        assert!(decoded(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect", 24).is_err());
    }

    #[test]
    fn svg_info_reports_points() {
        let reported = |bytes: &[u8]| {
            info_size(bytes)
                .map(reported_size)
                .map(|s| (s.width.0, s.height.0))
        };
        assert_eq!(reported(SVG_ICON), Some((24, 24)));
        assert_eq!(reported(SVG_LOGO), Some((48, 24)));
        assert_eq!(reported(b"<svg><rect"), None);
        // A file name's density does not apply to an SVG.
        let source = ImageSource {
            uri: "asset:/logo@2x.svg".into(),
            size: None,
            scales: nsh_core::ImageScales::NONE,
            data: None,
        };
        let logo = decoded(SVG_LOGO, 96).unwrap();
        assert_eq!(natural(logo.natural, Some(&source)), (48.0, 24.0));
        // Fractions lay out as they are; reports round them.
        let odd = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="10"/>"#;
        let odd = decoded(odd, 32).unwrap();
        assert_eq!(natural(odd.natural, None), (10.5, 10.0));
        let size = reported_size(odd.natural);
        assert_eq!((size.width.0, size.height.0), (11, 10));
        let huge = br#"<svg xmlns="http://www.w3.org/2000/svg" width="1e30" height="1"/>"#;
        assert_eq!(reported(huge), Some((i32::MAX, 1)));
    }

    /// A 1 × 1 PNG.
    fn png_pixel() -> Vec<u8> {
        nsh_core::image::decode_data_uri("data:;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==").unwrap().1
    }

    #[test]
    fn svg_is_no_canvas_image() {
        let logo = decoded(SVG_LOGO, 48).unwrap();
        let error = bitmap("asset:/logo.svg", logo).unwrap_err();
        assert!(error.starts_with("asset:/logo.svg"), "{error}");
        let png = decoded(&png_pixel(), 0).unwrap();
        assert_eq!(png.natural, Natural::Pixels(1, 1));
        assert!(bitmap("asset:/a.png", png).is_ok());
    }

    #[test]
    fn svg_tints_through_alpha() {
        // `tintColor` shows a color through the image's alpha (a mask): the
        // SVG's shape is opaque, the rest transparent, whatever its colour.
        let icon = decoded(SVG_ICON, 48).unwrap();
        let pixels = rgba(&icon.frames[0]);
        assert_eq!(at(&pixels, 24, 24)[3], 255);
        assert_eq!(at(&pixels, 1, 1)[3], 0);
        // Filters apply to SVGs as to bitmaps: an inverting matrix, baked
        // into a variant of the decoded picture.
        let mut invert = [0.0f32; 20];
        invert[0] = -1.0;
        invert[4] = 1.0;
        invert[6] = -1.0;
        invert[9] = 1.0;
        invert[12] = -1.0;
        invert[14] = 1.0;
        invert[18] = 1.0;
        let look = Look {
            blur: 0.0,
            matrix: Some(invert),
        };
        assert!(!look.plain() && Look::default().plain());
        let inverted = look.apply(&icon);
        let pixels = rgba(&inverted.frames[0]);
        assert_eq!(at(&pixels, 24, 24), [255, 255, 255, 255]);
        assert_eq!(at(&pixels, 1, 1)[3], 0);
        assert_eq!(inverted.natural, icon.natural);
    }

    #[test]
    fn reads_densities() {
        let source = ImageSource {
            uri: "asset:/logo@2x.png".into(),
            size: None,
            scales: Default::default(),
            data: None,
        };
        assert_eq!(
            natural(Natural::Pixels(200, 100), Some(&source)),
            (100.0, 50.0)
        );
    }
}

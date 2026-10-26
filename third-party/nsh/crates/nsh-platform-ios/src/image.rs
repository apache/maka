//! Image loading: fetch (NSURLSession, reporting progress, or file) once
//! per URI (a source that carries its bytes, a `data:` URI or a blob, is not
//! fetched: they are wrapped in an `NSData` without a copy), downsample-decode with ImageIO on a background queue at each
//! requested pixel size, cache decoded images in an `NSCache` (purged under
//! memory pressure), coalesce concurrent requests and cancel downloads
//! nobody waits for. `Image.prefetch` / `getSize` keep the bytes they
//! fetched for the views that show them next. Remote images go through the
//! surface's disk cache ([`nsh_core::image::DiskCache`]): it is read on a
//! background queue, and a download starts (revalidating a stale copy)
//! only when it holds no fresh one.
//!
//! SVG images (sniffed from their bytes) are drawn by [`nsh_core::svg`] at
//! the requested pixel size instead, then blurred, filtered, tinted and
//! cached as bitmaps; their size is their intrinsic size in points.
//! Canvases draw bitmaps only.

use dispatch2::{DispatchQueue, DispatchQueueGlobalPriority, GlobalQueueIdentifier};
use nsh_core::{
    ImageData, NodeId,
    geometry::{Points, Size},
    image::{CacheHeaders, DiskCache, Fetched, Lookup},
};
use objc2::{
    AnyThread, DefinedClass, Message, define_class, msg_send, rc::Retained, runtime::ProtocolObject,
};
use objc2_core_foundation::{
    CFData, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGFloat, kCFBooleanTrue,
};
use objc2_core_graphics::CGImage;
use objc2_foundation::{
    NSCache, NSData, NSDataReadingOptions, NSError, NSHTTPURLResponse, NSMutableURLRequest,
    NSObject, NSObjectProtocol, NSString, NSURL, NSURLRequest, NSURLResponse, NSURLSession,
    NSURLSessionDataDelegate, NSURLSessionDataTask, NSURLSessionDelegate,
    NSURLSessionResponseDisposition, NSURLSessionTask, NSURLSessionTaskDelegate,
};
use objc2_image_io::{
    CGImageSource, kCGImageSourceCreateThumbnailFromImageAlways,
    kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceShouldCacheImmediately,
    kCGImageSourceThumbnailMaxPixelSize,
};
use objc2_ui_kit::{UIImage, UIImageOrientation};
use rustc_hash::FxHashMap;

/// Decoded images kept in memory (bytes), before `NSCache` evicts.
const CACHE_BYTES: usize = 96 << 20;

/// A decoded image handed from a background queue to the main thread,
/// with the pixel size of its source (before downsampling: `onLoad`
/// reports it, whatever size the view decodes at; an SVG's is in whole
/// points).
#[derive(Clone)]
pub(crate) struct DecodedImage {
    pub(crate) image: Retained<UIImage>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    /// An SVG, which canvases do not draw.
    pub(crate) vector: bool,
}

/// Why a canvas leaves out the SVG image `uri`.
pub(crate) fn not_a_bitmap(uri: &str) -> String {
    format!("{uri} is an SVG image: canvases draw bitmaps (PNG, JPEG, ...)")
}

define_class!(
    /// A cache entry: [`DecodedImage`] as an object.
    #[unsafe(super(NSObject))]
    #[ivars = DecodedImage]
    struct CachedImage;
);

impl CachedImage {
    fn new(image: DecodedImage) -> Retained<Self> {
        let this = Self::alloc().set_ivars(image);
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

// SAFETY: UIImage is immutable and documented as safe to use from any
// thread; it is only created off the main thread and then moved.
unsafe impl Send for DecodedImage {}

/// Where an `asset:/path` URI points.
#[derive(Debug, Clone)]
pub enum AssetBase {
    /// Served over HTTP (the dev server): `http://host:port/assets/`.
    Http(String),
    /// A directory on disk (built app resources).
    Directory(std::path::PathBuf),
}

/// Reads `asset:/…` files for the engine (fonts): synchronously, on the
/// engine thread.
pub(crate) struct AssetReader(pub(crate) Option<AssetBase>);

impl nsh_engine::Assets for AssetReader {
    fn read(&self, uri: &str) -> Result<Vec<u8>, String> {
        let path = uri
            .strip_prefix("asset:/")
            .ok_or_else(|| format!("not an asset URI: {uri}"))?;
        match &self.0 {
            Some(AssetBase::Directory(dir)) => {
                std::fs::read(dir.join(path)).map_err(|e| e.to_string())
            }
            Some(AssetBase::Http(base)) => {
                let url = url(&format!("{base}{path}")).ok_or("bad asset URL")?;
                NSData::dataWithContentsOfURL_options_error(&url, NSDataReadingOptions::empty())
                    .map(|d| d.to_vec())
                    .map_err(|e| e.localizedDescription().to_string())
            }
            None => Err("no asset location configured".to_owned()),
        }
    }
}

enum Source {
    Url(Retained<NSURL>),
    File(std::path::PathBuf),
    /// A `data:` URI (base64), decoded off the main thread.
    Data,
}

/// What the loader tells the mounter, on the main thread.
pub(crate) enum LoadEvent {
    /// The image for cache key `key` decoded (or failed).
    Decoded {
        key: String,
        result: Result<DecodedImage, String>,
    },
    /// Bytes of `uri` arrived so far, of `total` (0: unknown).
    Progress {
        uri: String,
        loaded: u64,
        total: u64,
    },
    /// The bytes of `uri` arrived (or failed): the loader's own step,
    /// passed back to [`ImageLoader::bytes_ready`].
    Bytes {
        uri: String,
        result: Result<Retained<NSData>, String>,
    },
    /// `Image.getSize` / `Image.prefetch` request `id`: the image's pixel
    /// size.
    Info {
        id: u32,
        result: Result<(u32, u32), String>,
    },
    /// The disk cache holds no fresh copy of `uri`: download it with
    /// `headers` (a stale copy's validators), passed back to
    /// [`ImageLoader::download`].
    Download {
        uri: String,
        headers: Vec<(&'static str, String)>,
    },
}

// SAFETY: NSData is immutable and thread-safe; the rest is plain data.
unsafe impl Send for LoadEvent {}

/// Delivers [`LoadEvent`]s; always called on the main thread.
pub(crate) type Notify = std::sync::Arc<dyn Fn(LoadEvent) + Send + Sync>;

fn on_main(notify: &Notify, event: LoadEvent) {
    let notify = notify.clone();
    DispatchQueue::main().exec_async(move || notify(event));
}

/// A decode waiting for its bytes, or decoding.
struct Inflight {
    uri: String,
    decoding: Decoding,
    waiters: Vec<NodeId>,
}

/// What a download is for.
enum Want {
    /// Decode for this cache key.
    Decode(String),
    /// Answer an `Image.getSize` / `Image.prefetch` request.
    Info(u32),
}

/// One download (or file read) per URI, whatever it is for.
struct Download {
    task: Option<Retained<NSURLSessionDataTask>>,
    wants: Vec<Want>,
}

/// Result of a request.
pub(crate) enum Request {
    /// Already decoded.
    Ready(DecodedImage),
    /// Loading; [`ImageLoader::finish`] is called on the main thread.
    Pending,
}

pub(crate) struct ImageLoader {
    cache: Retained<NSCache<NSString, CachedImage>>,
    /// Encoded images fetched by `Image.prefetch` / `Image.getSize`, until
    /// a view decodes them (purged under memory pressure).
    data: Retained<NSCache<NSString, NSData>>,
    inflight: FxHashMap<String, Inflight>,
    downloads: FxHashMap<String, Download>,
    asset_base: Option<AssetBase>,
    notify: Notify,
    /// What the app may load, checked at every redirect.
    access: std::sync::Arc<nsh_engine::Access>,
    /// The disk cache remote images go through.
    disk: Option<DiskCache>,
}

impl ImageLoader {
    pub(crate) fn new(
        asset_base: Option<AssetBase>,
        notify: Notify,
        access: std::sync::Arc<nsh_engine::Access>,
    ) -> Self {
        // SAFETY: fresh caches with NSString keys and the declared values;
        // plain setters.
        let (cache, data) = unsafe {
            let cache = NSCache::new();
            cache.setTotalCostLimit(CACHE_BYTES);
            let data = NSCache::new();
            data.setTotalCostLimit(DATA_BYTES);
            (cache, data)
        };
        Self {
            cache,
            data,
            inflight: FxHashMap::default(),
            downloads: FxHashMap::default(),
            asset_base,
            notify,
            access,
            disk: None,
        }
    }

    /// The disk cache remote images go through.
    pub(crate) fn set_disk_cache(&mut self, disk: Option<DiskCache>) {
        self.disk = disk;
    }

    /// Cache key: the same URI decoded at different sizes (or blurred or
    /// filtered differently) is a different image.
    pub(crate) fn key(uri: &str, max_pixels: u32, look: Look) -> String {
        let mut key = format!("{max_pixels}@");
        if look.blur > 0.0 {
            key.push_str(&format!("b{}@", look.blur));
        }
        if let Some(m) = look.matrix {
            use std::hash::{Hash, Hasher};
            let mut h = std::hash::DefaultHasher::new();
            m.map(f32::to_bits).hash(&mut h);
            key.push_str(&format!("m{:x}@", h.finish()));
        }
        key.push_str(uri);
        key
    }

    /// Requests `uri` for `view`, decoded to at most `max_pixels` on its
    /// longer side (0 = natural size); completions come as
    /// [`LoadEvent::Decoded`]. `data` is its bytes, when the source carries
    /// them (a `data:` URI, a blob): `uri` is then only the cache key.
    pub(crate) fn request(
        &mut self,
        view: NodeId,
        uri: &str,
        data: Option<&ImageData>,
        max_pixels: u32,
        scale: f64,
        look: Look,
    ) -> Request {
        let key = Self::key(uri, max_pixels, look);
        // SAFETY: NSString key and CachedImage value, as declared.
        if let Some(cached) = unsafe { self.cache.objectForKey(&NSString::from_str(&key)) } {
            return Request::Ready(cached.ivars().clone());
        }
        if let Some(inflight) = self.inflight.get_mut(&key) {
            if !inflight.waiters.contains(&view) {
                inflight.waiters.push(view);
            }
            return Request::Pending;
        }
        let decoding = Decoding {
            max_pixels,
            scale,
            blur: look.blur as f64 * scale,
            matrix: look.matrix,
        };
        self.inflight.insert(
            key.clone(),
            Inflight {
                uri: uri.to_owned(),
                decoding,
                waiters: vec![view],
            },
        );
        match data {
            Some(data) => self.serve(uri, &ns_data(data), Want::Decode(key)),
            None => self.fetch(uri, Want::Decode(key)),
        }
        Request::Pending
    }

    /// `Image.getSize` (and `Image.prefetch`): the pixel size of `uri`,
    /// keeping its bytes for the views that show it next.
    pub(crate) fn info(&mut self, id: u32, uri: &str) {
        self.fetch(uri, Want::Info(id));
    }

    /// The views waiting for `uri`.
    pub(crate) fn waiting(&self, uri: &str) -> Vec<NodeId> {
        self.inflight
            .values()
            .filter(|i| i.uri == uri)
            .flat_map(|i| i.waiters.iter().copied())
            .collect()
    }

    /// Gets the bytes of `uri` for `want`: from the data cache, a running
    /// download, or a new one.
    fn fetch(&mut self, uri: &str, want: Want) {
        // SAFETY: NSString key and NSData value, as declared.
        if let Some(data) = unsafe { self.data.objectForKey(&NSString::from_str(uri)) } {
            self.serve(uri, &data, want);
            return;
        }
        if let Some(download) = self.downloads.get_mut(uri) {
            download.wants.push(want);
            return;
        }
        let notify = self.notify.clone();
        let remote = uri.starts_with("http://") || uri.starts_with("https://");
        let task = match self.resolve(uri) {
            // The disk cache is read off the main thread; the download
            // starts from there (`LoadEvent::Download`) unless it holds a
            // fresh copy.
            Some(Source::Url(_)) if remote && self.disk.is_some() => {
                let cache = self.disk.clone().expect("a disk cache");
                let uri = uri.to_owned();
                DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
                    DispatchQueueGlobalPriority::Default,
                ))
                .exec_async(move || {
                    let event = match cache.lookup(&uri) {
                        Lookup::Fresh(bytes) => LoadEvent::Bytes {
                            uri,
                            result: Ok(ns_data(&bytes)),
                        },
                        lookup => LoadEvent::Download {
                            headers: lookup.request_headers(),
                            uri,
                        },
                    };
                    on_main(&notify, event);
                });
                None
            }
            Some(Source::Url(url)) => Some(crate::image::download(
                &url,
                uri.to_owned(),
                &[],
                None,
                notify,
                self.access.clone(),
            )),
            Some(Source::File(path)) => {
                let uri = uri.to_owned();
                DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
                    DispatchQueueGlobalPriority::Default,
                ))
                .exec_async(move || {
                    let result = std::fs::read(&path)
                        .map(|bytes| NSData::with_bytes(&bytes))
                        .map_err(|e| format!("{}: {e}", path.display()));
                    on_main(&notify, LoadEvent::Bytes { uri, result });
                });
                None
            }
            Some(Source::Data) => {
                let uri = uri.to_owned();
                DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
                    DispatchQueueGlobalPriority::Default,
                ))
                .exec_async(move || {
                    let result = nsh_core::image::decode_data_uri(&uri)
                        .map(|(_, bytes)| NSData::from_vec(bytes));
                    on_main(&notify, LoadEvent::Bytes { uri, result });
                });
                None
            }
            None => {
                let result = Err(format!("unsupported image source `{uri}`"));
                on_main(
                    &notify,
                    LoadEvent::Bytes {
                        uri: uri.to_owned(),
                        result,
                    },
                );
                None
            }
        };
        self.downloads.insert(
            uri.to_owned(),
            Download {
                task,
                wants: vec![want],
            },
        );
    }

    /// Downloads `uri` through the disk cache, with `headers` (main thread),
    /// unless nobody waits for it any more.
    pub(crate) fn download(&mut self, uri: &str, headers: &[(&'static str, String)]) {
        // Gone (nobody waits), or started by an earlier lookup of a request
        // made again.
        if self.downloads.get(uri).is_none_or(|d| d.task.is_some()) {
            return;
        }
        let Some(url) = url(uri) else {
            self.bytes_ready(uri, Err(format!("bad URL {uri}")));
            return;
        };
        let task = crate::image::download(
            &url,
            uri.to_owned(),
            headers,
            self.disk.clone(),
            self.notify.clone(),
            self.access.clone(),
        );
        if let Some(download) = self.downloads.get_mut(uri) {
            download.task = Some(task);
        }
    }

    /// The bytes of a download arrived (main thread).
    pub(crate) fn bytes_ready(&mut self, uri: &str, result: Result<Retained<NSData>, String>) {
        let Some(download) = self.downloads.remove(uri) else {
            return;
        };
        match result {
            Ok(data) => {
                if download.wants.iter().any(|w| matches!(w, Want::Info(_))) {
                    // Kept for the views that show it next.
                    // SAFETY: NSString key and NSData value, as declared.
                    unsafe {
                        self.data
                            .setObject_forKey_cost(&data, &NSString::from_str(uri), data.len())
                    };
                }
                for want in download.wants {
                    self.serve(uri, &data, want);
                }
            }
            Err(message) => {
                for want in download.wants {
                    let event = match want {
                        Want::Decode(key) => LoadEvent::Decoded {
                            key,
                            result: Err(message.clone()),
                        },
                        Want::Info(id) => LoadEvent::Info {
                            id,
                            result: Err(message.clone()),
                        },
                    };
                    // The mounter is busy calling us: answer on the next turn.
                    on_main(&self.notify, event);
                }
            }
        }
    }

    /// Decodes or measures `data` for `want`.
    fn serve(&self, uri: &str, data: &NSData, want: Want) {
        match want {
            Want::Decode(key) => {
                let Some(inflight) = self.inflight.get(&key) else {
                    return;
                };
                let decoding = inflight.decoding;
                let data = data.retain();
                let notify = self.notify.clone();
                let what = uri.to_owned();
                // SAFETY: NSData is immutable and thread-safe.
                let data = unsafe { Shared::new(data) };
                DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
                    DispatchQueueGlobalPriority::Default,
                ))
                .exec_async(move || {
                    let data = data.get();
                    // SAFETY: NSData is toll-free bridged with CFData.
                    let cf = unsafe { &*(Retained::as_ptr(data) as *const CFData) };
                    let result =
                        decode(cf, decoding).ok_or_else(|| format!("cannot decode {what}"));
                    on_main(&notify, LoadEvent::Decoded { key, result });
                });
            }
            Want::Info(id) => {
                // An SVG's size takes parsing it: measured off the main
                // thread, as decodes are.
                let notify = self.notify.clone();
                let what = uri.to_owned();
                // SAFETY: NSData is immutable and thread-safe.
                let data = unsafe { Shared::new(data.retain()) };
                DispatchQueue::global_queue(GlobalQueueIdentifier::Priority(
                    DispatchQueueGlobalPriority::Default,
                ))
                .exec_async(move || {
                    // SAFETY: NSData is toll-free bridged with CFData.
                    let cf = unsafe { &*(Retained::as_ptr(data.get()) as *const CFData) };
                    let result =
                        info_size(cf).ok_or_else(|| format!("cannot read the size of {what}"));
                    on_main(&notify, LoadEvent::Info { id, result });
                });
            }
        }
    }

    /// `view` no longer wants `key`; cancels the download if nobody does.
    pub(crate) fn cancel(&mut self, view: NodeId, key: &str) {
        let Some(inflight) = self.inflight.get_mut(key) else {
            return;
        };
        inflight.waiters.retain(|&v| v != view);
        if !inflight.waiters.is_empty() {
            return;
        }
        let uri = inflight.uri.clone();
        self.inflight.remove(key);
        let Some(download) = self.downloads.get_mut(&uri) else {
            return;
        };
        download
            .wants
            .retain(|w| !matches!(w, Want::Decode(k) if k == key));
        if download.wants.is_empty() {
            if let Some(task) = &download.task {
                task.cancel();
            }
            self.downloads.remove(&uri);
        }
    }

    /// Completes a load (main thread). Returns the views waiting for it.
    pub(crate) fn finish(
        &mut self,
        key: &str,
        result: &Result<DecodedImage, String>,
    ) -> Vec<NodeId> {
        let Some(inflight) = self.inflight.remove(key) else {
            return Vec::new();
        };
        if let Ok(decoded) = result {
            let image = &decoded.image;
            // SAFETY: plain getters on a valid image.
            let (size, scale) = unsafe { (image.size(), image.scale()) };
            // Animated images repeat frames for long delays: count distinct
            // ones.
            // SAFETY: a plain getter.
            let frames = unsafe { image.images() }.map_or(1, |frames| {
                let mut seen: Vec<*const UIImage> =
                    frames.iter().map(|f| Retained::as_ptr(&f)).collect();
                seen.sort_unstable();
                seen.dedup();
                seen.len()
            });
            let cost = (size.width * scale * size.height * scale * 4.0) as usize * frames;
            // SAFETY: NSString key and CachedImage value, as declared.
            unsafe {
                self.cache.setObject_forKey_cost(
                    &CachedImage::new(decoded.clone()),
                    &NSString::from_str(key),
                    cost,
                )
            };
            // Shown now: the encoded bytes are not needed any more.
            // SAFETY: an NSString key, as declared.
            unsafe {
                self.data
                    .removeObjectForKey(&NSString::from_str(&inflight.uri))
            };
        }
        inflight.waiters
    }

    fn resolve(&self, uri: &str) -> Option<Source> {
        if let Some(path) = uri.strip_prefix("asset:/") {
            return match self.asset_base.as_ref()? {
                AssetBase::Http(base) => url(&format!("{base}{path}")).map(Source::Url),
                AssetBase::Directory(dir) => Some(Source::File(dir.join(path))),
            };
        }
        if uri.starts_with("http://") || uri.starts_with("https://") {
            return url(uri).map(Source::Url);
        }
        if uri.starts_with("data:") {
            return Some(Source::Data);
        }
        let path = uri.strip_prefix("file://").unwrap_or(uri);
        path.starts_with('/').then(|| Source::File(path.into()))
    }
}

/// `data`'s bytes as an `NSData`, not copied: the `NSData` keeps `data`
/// alive until it is deallocated.
fn ns_data(data: &ImageData) -> Retained<NSData> {
    use std::ffi::c_void;

    use block2::{DynBlock, RcBlock};
    let keep = data.clone();
    let bytes = keep.bytes();
    let (ptr, len) = (bytes.as_ptr() as *mut c_void, bytes.len());
    // Dropping the block (when the NSData goes) drops `keep`.
    let dealloc = RcBlock::new(move |_: *mut c_void, _: usize| {
        let _ = &keep;
    });
    let dealloc: &DynBlock<dyn Fn(*mut c_void, usize) + 'static> = &dealloc;
    // SAFETY: an immutable NSData only reads the bytes, which the
    // deallocator block keeps alive (`ImageData` is shared and immutable)
    // for as long as the NSData lives.
    unsafe {
        msg_send![
            NSData::alloc(),
            initWithBytesNoCopy: ptr,
            length: len,
            deallocator: dealloc,
        ]
    }
}

/// An object moved to another thread.
struct Shared<T>(T);

// SAFETY: only constructed (unsafely) for thread-safe objects.
unsafe impl<T> Send for Shared<T> {}

impl<T> Shared<T> {
    /// # Safety
    ///
    /// `T` must be safe to use from any thread.
    unsafe fn new(value: T) -> Self {
        Self(value)
    }

    fn get(&self) -> &T {
        &self.0
    }
}

fn url(s: &str) -> Option<Retained<NSURL>> {
    NSURL::URLWithString(&NSString::from_str(s))
}

/// How a decoded image is changed: `blurRadius` plus `blur()` filters (in
/// points), and the composed color matrix of the other filters.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub(crate) struct Look {
    pub(crate) blur: f32,
    pub(crate) matrix: Option<[f32; 20]>,
}

/// How to decode: the longer side in pixels (0: natural), the screen
/// scale, the blur radius in pixels, a color matrix.
#[derive(Clone, Copy)]
struct Decoding {
    max_pixels: u32,
    scale: f64,
    blur: f64,
    matrix: Option<[f32; 20]>,
}

/// Bytes of a download kept at most for `Image.prefetch` / `getSize`.
const DATA_BYTES: usize = 32 << 20;

/// Progress reports at most this often (a download reports its end too).
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(100);

struct DownloadIvars {
    uri: String,
    notify: Notify,
    access: std::sync::Arc<nsh_engine::Access>,
    /// The disk cache it goes through.
    cache: Option<DiskCache>,
    data: std::sync::Mutex<DownloadState>,
}

#[derive(Default)]
struct DownloadState {
    bytes: Vec<u8>,
    total: u64,
    status: isize,
    headers: CacheHeaders,
    reported: Option<std::time::Instant>,
}

define_class!(
    /// A download's delegate: collects the bytes and reports progress.
    #[unsafe(super(NSObject))]
    #[name = "NshImageDownload"]
    #[ivars = DownloadIvars]
    struct ImageDownload;

    unsafe impl NSObjectProtocol for ImageDownload {}

    unsafe impl NSURLSessionDelegate for ImageDownload {}

    unsafe impl NSURLSessionTaskDelegate for ImageDownload {
        // Redirects are followed only to what the app may load: a refused
        // hop is never requested (the 3xx response then ends the load).
        #[unsafe(method(URLSession:task:willPerformHTTPRedirection:newRequest:completionHandler:))]
        fn will_redirect(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionTask,
            _response: &NSHTTPURLResponse,
            request: &NSURLRequest,
            completion: &block2::DynBlock<dyn Fn(*mut NSURLRequest)>,
        ) {
            let ivars = self.ivars();
            let next = request
                .URL()
                .and_then(|u| u.absoluteString())
                .map(|u| u.to_string());
            // The app's own assets (the dev server's) are not network access.
            let granted = ivars.uri.starts_with("asset:/")
                || next.is_some_and(|next| ivars.access.media_redirect(&ivars.uri, &next).is_ok());
            let next = if granted {
                request as *const NSURLRequest as *mut NSURLRequest
            } else {
                std::ptr::null_mut()
            };
            completion.call((next,));
        }

        #[unsafe(method(URLSession:task:didCompleteWithError:))]
        fn did_complete(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionTask,
            error: Option<&NSError>,
        ) {
            let ivars = self.ivars();
            let state = std::mem::take(&mut *ivars.data.lock().expect("download"));
            let result = match (&ivars.cache, error) {
                // Delegates run on the session's queue, off the main
                // thread: the cache's file IO is done here.
                (Some(cache), error) => {
                    let response = match error {
                        Some(e) => Err(e.localizedDescription().to_string()),
                        None => Ok(Fetched::new(
                            state.status as u16,
                            state.headers,
                            state.bytes,
                        )),
                    };
                    cache.complete(&ivars.uri, response).map(|b| ns_data(&b))
                }
                (None, Some(e)) => Err(e.localizedDescription().to_string()),
                (None, None) if state.status >= 400 => Err(format!("HTTP {}", state.status)),
                (None, None) if (300..400).contains(&state.status) => {
                    Err(format!("redirect refused (HTTP {})", state.status))
                }
                (None, None) => Ok(NSData::from_vec(state.bytes)),
            };
            on_main(
                &ivars.notify,
                LoadEvent::Bytes {
                    uri: ivars.uri.clone(),
                    result,
                },
            );
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
            let mut state = self.ivars().data.lock().expect("download");
            state.total = response.expectedContentLength().max(0) as u64;
            if let Some(http) = response.downcast_ref::<NSHTTPURLResponse>() {
                state.status = http.statusCode();
                if self.ivars().cache.is_some() {
                    state.headers = cache_headers(http);
                }
            }
            drop(state);
            completion.call((NSURLSessionResponseDisposition::Allow,));
        }

        #[unsafe(method(URLSession:dataTask:didReceiveData:))]
        fn did_receive_data(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionDataTask,
            data: &NSData,
        ) {
            let ivars = self.ivars();
            let mut state = ivars.data.lock().expect("download");
            state.bytes.extend_from_slice(&data.to_vec());
            let now = std::time::Instant::now();
            let due = state.reported.is_none_or(|t| now - t >= PROGRESS_INTERVAL);
            let done = state.total > 0 && state.bytes.len() as u64 >= state.total;
            if due || done {
                state.reported = Some(now);
                let (loaded, total) = (state.bytes.len() as u64, state.total);
                drop(state);
                on_main(
                    &ivars.notify,
                    LoadEvent::Progress {
                        uri: ivars.uri.clone(),
                        loaded,
                        total,
                    },
                );
            }
        }
    }
);

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

/// Downloads `url` with `headers` (a revalidation's conditions), through
/// `cache` when there is one, reporting progress and then
/// [`LoadEvent::Bytes`].
fn download(
    url: &NSURL,
    uri: String,
    headers: &[(&'static str, String)],
    cache: Option<DiskCache>,
    notify: Notify,
    access: std::sync::Arc<nsh_engine::Access>,
) -> Retained<NSURLSessionDataTask> {
    let cached = cache.is_some();
    let delegate = ImageDownload::alloc().set_ivars(DownloadIvars {
        uri,
        notify,
        access,
        cache,
        data: std::sync::Mutex::new(DownloadState::default()),
    });
    // SAFETY: NSObject's designated initializer.
    let delegate: Retained<ImageDownload> = unsafe { msg_send![super(delegate), init] };
    let request = NSMutableURLRequest::requestWithURL(url);
    if cached {
        // The disk cache answers for these: the shared URL cache must not
        // serve a copy it never saw (nor hide a revalidation's 304).
        request.setCachePolicy(
            objc2_foundation::NSURLRequestCachePolicy::ReloadIgnoringLocalCacheData,
        );
    }
    for (name, value) in headers {
        request.setValue_forHTTPHeaderField(
            Some(&NSString::from_str(value)),
            &NSString::from_str(name),
        );
    }
    let task = NSURLSession::sharedSession().dataTaskWithRequest(&request);
    // The task keeps its delegate until it completes.
    task.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    task.resume();
    task
}

/// Frames of an animated image decoded at most (longer ones play the
/// first ones).
const MAX_FRAMES: usize = 600;

/// The size `Image.getSize` reports: pixels, or an SVG's whole points.
fn info_size(data: &CFData) -> Option<(u32, u32)> {
    // SAFETY: the data is immutable while it is read.
    let bytes = unsafe { data.as_bytes_unchecked() };
    let size = if nsh_core::svg::sniff(bytes) {
        nsh_core::svg::size(bytes)
            .inspect_err(|e| log::warn!("{e}"))
            .ok()
            .map(svg_size)
    } else {
        // SAFETY: valid data; only the header is read.
        unsafe { CGImageSource::with_data(data, None) }.map(|source| source_size(&source))
    };
    size.filter(|(w, h)| *w > 0 && *h > 0)
}

/// An SVG's intrinsic size in whole points, as `onLoad` and
/// `Image.getSize` report it.
fn svg_size(size: Size<Points>) -> (u32, u32) {
    let reported = nsh_core::svg::reported_size(size);
    (reported.width.0 as u32, reported.height.0 as u32)
}

/// Draws an SVG for a view `max_pixels` pixels on its longer side, with
/// its shorter side that long, so it stays sharp in every resize mode
/// (natural: at its intrinsic size in points at the screen scale), then
/// blurs and filters it as [`decode`] does bitmaps. Thread-safe.
fn decode_svg(bytes: &[u8], d: Decoding) -> Option<DecodedImage> {
    let raster = match d.max_pixels {
        0 => nsh_core::svg::rasterize_scaled(bytes, d.scale as f32),
        n => nsh_core::svg::rasterize_covering(bytes, n),
    }
    .inspect_err(|e| log::warn!("{e}"))
    .ok()?;
    let image = rgba_image(&raster)?;
    let image = match d.blur > 0.0 || d.matrix.is_some() {
        true => crate::blur::filtered(&image, d.blur, d.matrix).unwrap_or(image),
        false => image,
    };
    // `center` shows an image at its size in points, the raster's pixels
    // over its scale: the SVG's intrinsic size, or as large as a bitmap
    // decoded for the view when that is smaller.
    let scale = (raster.width as f64 / raster.size.width.0 as f64).max(d.scale);
    let (width, height) = svg_size(raster.size);
    Some(DecodedImage {
        image: UIImage::imageWithCGImage_scale_orientation(
            &image,
            scale as CGFloat,
            UIImageOrientation::Up,
        ),
        width,
        height,
        vector: true,
    })
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

/// Decodes (and downsamples, blurs) with ImageIO. Animated GIF / PNG /
/// WebP images become an animated `UIImage` whose frames repeat for their
/// delays. Thread-safe.
fn decode(data: &CFData, d: Decoding) -> Option<DecodedImage> {
    // SAFETY: the data is immutable while it is read.
    let bytes = unsafe { data.as_bytes_unchecked() };
    if nsh_core::svg::sniff(bytes) {
        return decode_svg(bytes, d);
    }
    let Decoding {
        max_pixels,
        scale,
        blur,
        matrix,
    } = d;
    // SAFETY: valid data and option dictionaries of the documented types.
    unsafe {
        let source = CGImageSource::with_data(data, None)?;
        let yes: &CFType = kCFBooleanTrue?;
        let max = CFNumber::new_cgfloat(max_pixels as CGFloat);
        let mut keys: Vec<&CFString> = vec![
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceShouldCacheImmediately,
        ];
        let mut values: Vec<&CFType> = vec![yes, yes, yes];
        if max_pixels > 0 {
            keys.push(kCGImageSourceThumbnailMaxPixelSize);
            values.push(&max);
        }
        let options = CFDictionary::from_slices(&keys, &values);
        let options: &CFDictionary = options.as_opaque();
        let frame = |i: usize| -> Option<Retained<UIImage>> {
            let image = source.thumbnail_at_index(i, Some(options))?;
            let image = match blur > 0.0 || matrix.is_some() {
                true => crate::blur::filtered(&image, blur, matrix).unwrap_or(image),
                false => image,
            };
            Some(UIImage::imageWithCGImage_scale_orientation(
                &image,
                scale as CGFloat,
                UIImageOrientation::Up,
            ))
        };
        let (width, height) = source_size(&source);
        let decoded = |image| DecodedImage {
            image,
            width,
            height,
            vector: false,
        };
        let count = source.count().min(MAX_FRAMES);
        if count <= 1 {
            return frame(0).map(decoded);
        }
        let mut frames = Vec::with_capacity(count);
        for i in 0..count {
            let Some(image) = frame(i) else { break };
            frames.push((image, frame_delay(&source, i)));
        }
        animated(frames).map(decoded)
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

/// An animated image from frames and their delays (centiseconds): each
/// frame repeats for its delay in units of their common divisor, as
/// `UIImage` animations have one frame duration.
fn animated(frames: Vec<(Retained<UIImage>, u32)>) -> Option<Retained<UIImage>> {
    fn gcd(a: u32, b: u32) -> u32 {
        if b == 0 { a } else { gcd(b, a % b) }
    }
    let unit = frames.iter().fold(0, |g, &(_, d)| gcd(g, d)).max(1);
    let total: u32 = frames.iter().map(|&(_, d)| d).sum();
    // Very uneven delays: a coarser unit keeps the frame list short.
    let unit = unit.max(total / 2000);
    let mut sequence = Vec::new();
    for (image, delay) in &frames {
        for _ in 0..(delay / unit).max(1) {
            sequence.push(image.clone());
        }
    }
    let list = objc2_foundation::NSArray::from_retained_slice(&sequence);
    UIImage::animatedImageWithImages_duration(&list, total as f64 / 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ICON: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="#000"/></svg>"##;
    const LOGO: &[u8] = br##"<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"><rect width="24" height="24" fill="#f00"/><rect x="24" width="24" height="24" fill="#00f"/></svg>"##;

    fn decoding(max_pixels: u32, scale: f64) -> Decoding {
        Decoding {
            max_pixels,
            scale,
            blur: 0.0,
            matrix: None,
        }
    }

    fn cg(decoded: &DecodedImage) -> CFRetained<CGImage> {
        // SAFETY: a plain property of an immutable image.
        unsafe { decoded.image.CGImage() }.unwrap().into()
    }

    /// The pixel at (`x`, `y`) of `image` as premultiplied sRGB RGBA.
    fn pixel(image: &CGImage, x: usize, y: usize) -> [u8; 4] {
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
        let i = (y * w + x) * 4;
        pixels[i..i + 4].try_into().unwrap()
    }

    #[test]
    fn svg_decodes_at_the_requested_size() {
        let icon = decode(&CFData::from_bytes(ICON), decoding(54, 3.0)).unwrap();
        assert_eq!(
            (icon.width, icon.height),
            (24, 24),
            "intrinsic size in points"
        );
        let image = cg(&icon);
        assert_eq!(
            (CGImage::width(Some(&image)), CGImage::height(Some(&image))),
            (54, 54)
        );
        // SAFETY: a plain property of an immutable image.
        assert_eq!(unsafe { icon.image.scale() }, 3.0);
        let logo = decode(&CFData::from_bytes(LOGO), decoding(144, 2.0)).unwrap();
        assert!(logo.vector);
        let image = cg(&logo);
        assert_eq!(
            (CGImage::width(Some(&image)), CGImage::height(Some(&image))),
            (288, 144),
            "the shorter side at the view's longer one: sharp when `cover` crops it"
        );
        // `center` shows it at its intrinsic size.
        // SAFETY: a plain property of an immutable image.
        let size = unsafe { logo.image.size() };
        assert_eq!((size.width, size.height), (48.0, 24.0));
        assert_eq!(pixel(&image, 10, 36), [255, 0, 0, 255]);
        assert_eq!(pixel(&image, 270, 72), [0, 0, 255, 255]);
        // Natural size: the intrinsic size at the screen scale.
        let natural = decode(&CFData::from_bytes(LOGO), decoding(0, 2.0)).unwrap();
        assert_eq!(CGImage::width(Some(&cg(&natural))), 96);
        // SAFETY: a plain property of an immutable image.
        let size = unsafe { natural.image.size() };
        assert_eq!((size.width, size.height), (48.0, 24.0));
        assert!(decode(&CFData::from_bytes(b"<svg><rect"), decoding(24, 1.0)).is_none());
    }

    #[test]
    fn svg_info_reports_points() {
        assert_eq!(info_size(&CFData::from_bytes(ICON)), Some((24, 24)));
        assert_eq!(info_size(&CFData::from_bytes(LOGO)), Some((48, 24)));
        assert_eq!(info_size(&CFData::from_bytes(b"<svg><rect")), None);
        let odd = br#"<svg xmlns="http://www.w3.org/2000/svg" width="10.5" height="1e30"/>"#;
        assert_eq!(
            info_size(&CFData::from_bytes(odd)),
            Some((11, i32::MAX as u32))
        );
    }

    #[test]
    fn svg_tints_through_alpha() {
        // `tintColor` shows a color through the image's alpha.
        let icon = decode(&CFData::from_bytes(ICON), decoding(48, 2.0)).unwrap();
        let image = cg(&icon);
        assert_eq!(pixel(&image, 24, 24)[3], 255);
        assert_eq!(pixel(&image, 1, 1)[3], 0);
        let mut invert = [0.0f32; 20];
        for (i, v) in [
            (0, -1.0),
            (4, 1.0),
            (6, -1.0),
            (9, 1.0),
            (12, -1.0),
            (14, 1.0),
            (18, 1.0),
        ] {
            invert[i] = v;
        }
        let inverted = decode(
            &CFData::from_bytes(ICON),
            Decoding {
                matrix: Some(invert),
                ..decoding(48, 2.0)
            },
        )
        .unwrap();
        let image = cg(&inverted);
        assert_eq!(pixel(&image, 24, 24), [255, 255, 255, 255]);
        assert_eq!(pixel(&image, 1, 1)[3], 0);
    }
}

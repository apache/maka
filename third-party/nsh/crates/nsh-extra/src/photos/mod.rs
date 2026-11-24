//! `Photos` (feature `photos`): the user's photo library, read by the app
//! once the user allows it: the most recent photos ([`recent`]), a small
//! image of one to show ([`thumbnail`]) and the photo itself ([`load`]),
//! which reaches the app as `Picker.pickImages` gives a picked image
//! ([`PickedImage`]: upright, scaled to the request, a JPEG without its
//! metadata unless it is a PNG, GIF or WebP). It serves a strip of recent photos the user adds with one
//! press; `Picker.pickImages`, which needs no permission, stays the way to
//! let the user choose from the whole library.
//!
//! [`PhotosPicker`] embeds the system's own picker in the layout instead
//! (iOS 17 and later, [`picker_view_available`]): a row of the library the
//! user selects photos in, which needs no permission either. The app reads
//! the photos selected with [`load_picked`] (`picker.rs`).
//!
//! iOS reads the library with the Photos framework (`ios.rs`), after the
//! user allows it ([`request_access`]): all of it ([`Access::Full`]) or the
//! photos the user selected ([`Access::Limited`]), which the user changes
//! in the system's selection sheet ([`present_limited_picker`]). Changes to
//! the library (a photo taken, a selection changed) are reported
//! ([`on_change`]) so the app refreshes what it shows.
//!
//! Android has no such module: an app that is not a gallery or photo
//! editor may not ask for the whole library there (Google Play restricts
//! `READ_MEDIA_IMAGES` to apps whose core purpose needs it), and the
//! system's Photo Picker (`Picker.pickImages`) is the way to the user's
//! photos. There, on the desktops, the web and in headless runs, [`access`]
//! is [`Access::Unavailable`] and the functions that read the library fail
//! with [`UNAVAILABLE`]. An embedding app or a test answers in place of the
//! platform with a [`PhotosBackend`] ([`set_backend`]).
//!
//! From JS the module needs the `picker` capability, as `Picker` does: the
//! photos it reads reach the app as picked ones do, and what the user
//! allowed holds for the whole app, so the capability decides which code
//! reaches them. The packaged iOS app needs `NSPhotoLibraryUsageDescription`,
//! which `nsh` adds from this crate's `[package.metadata.nsh.features.photos]`
//! when the feature is on.

#[cfg(target_os = "ios")]
mod ios;
#[cfg(target_os = "ios")]
mod ios_picker;
mod picker;

use std::{
    fmt,
    future::Future,
    pin::Pin,
    sync::{
        Arc, Mutex, RwLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

#[cfg(target_os = "ios")]
pub(crate) use ios_picker::register as register_components;
use nsh_core::{
    element::codes,
    geometry::{DevicePixels, Percentage, Size},
    picker::{DEFAULT_QUALITY, PickFormat, PickRequest, PickedFile, PickedImage},
    prelude::*,
};
pub use picker::{
    PICKER_COMPONENT, PhotosPicker, PhotosPickerApi, PhotosPickerElement, PhotosPickerEvent,
    PhotosPickerFilter, PhotosPickerProps, load_picked, photos_picker, picker_view_available,
};
use tokio::sync::Notify;

#[cfg(target_os = "ios")]
use self::ios as platform;

/// The code of a read the user does not allow: the app has no access to
/// the library, or not to that photo (Node's `EACCES`: the OS refused).
/// [`request_access`] asks the user once; after that only the system's
/// settings change it:
/// [`open_app_settings`](nsh_core::mobile::open_app_settings) takes the
/// user to the app's page there.
pub const DENIED: &str = "EACCES";

/// The code of a photo that is not in the library (any longer), or not
/// among those the user selected (Node's `ENOENT`).
pub const NOT_FOUND: &str = "ENOENT";

/// The code of a read where there is no photo library to read.
pub const UNAVAILABLE: &str = codes::UNAVAILABLE;

/// At most this many photos answer one [`recent`].
pub const MAX_RECENT: u32 = 1000;

/// What the user lets the app read of the photo library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
#[non_exhaustive]
pub enum Access {
    /// The whole library.
    Full,
    /// The photos the user selected ([`present_limited_picker`] changes
    /// them).
    Limited,
    /// The user was not asked yet: [`request_access`] asks.
    NotDetermined,
    /// The user (or a restriction of the device) does not let the app read
    /// the library; only the system's settings change it.
    Denied,
    /// There is no photo library to read here.
    #[default]
    Unavailable,
}

impl Access {
    /// Whether the app may read photos: [`Access::Full`] or
    /// [`Access::Limited`].
    pub fn allows_reading(self) -> bool {
        matches!(self, Self::Full | Self::Limited)
    }
}

/// A photo of the library.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct Asset {
    /// Its identifier in the library, which [`thumbnail`] and [`load`]
    /// take; stable across launches.
    pub id: String,
    /// Its size in pixels, as it shows.
    pub size: Size<DevicePixels>,
}

impl Asset {
    /// The photo `id`, `size` pixels large.
    pub fn new(id: impl Into<String>, size: Size<DevicePixels>) -> Self {
        Self {
            id: id.into(),
            size,
        }
    }
}

/// What the app asked a photo for, checked: how the photo [`load`] reads
/// is prepared.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct PhotoRequest {
    /// A photo whose longer side is longer than this is scaled down to it;
    /// `None` keeps its size.
    pub max_dimension: Option<DevicePixels>,
    /// The quality of the JPEG, from 0 (smallest) to 1 (best); `None`:
    /// [`DEFAULT_QUALITY`].
    pub quality: Option<Percentage>,
}

impl PhotoRequest {
    /// The pick of one image that prepares the photo as a picked one: in a
    /// format every browser and server takes, a JPEG encoded again (so it
    /// comes upright and without its metadata) at the request's quality.
    pub fn pick_request(&self) -> PickRequest {
        let mut request = PickRequest::new(false, 1);
        request.max_dimension = self.max_dimension;
        request.quality = Some(self.quality.unwrap_or(DEFAULT_QUALITY));
        request.format = PickFormat::Compatible;
        request
    }

    /// The request of a thumbnail whose longer side is at most
    /// `max_dimension`.
    pub fn thumbnail(max_dimension: DevicePixels) -> Self {
        Self {
            max_dimension: Some(max_dimension),
            quality: None,
        }
    }
}

/// Why the library was not read.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct PhotosError {
    /// A stable code the app can branch on ([`DENIED`], [`NOT_FOUND`],
    /// [`UNAVAILABLE`]); `None` for other failures.
    pub code: Option<String>,
    /// What went wrong, in words.
    pub message: String,
}

impl PhotosError {
    /// A failure with `message` and no code.
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    /// There is no photo library here ([`UNAVAILABLE`]).
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::coded(UNAVAILABLE, message)
    }

    /// The user does not let the app read it ([`DENIED`]).
    pub fn denied(message: impl Into<String>) -> Self {
        Self::coded(DENIED, message)
    }

    /// The photo is not there ([`NOT_FOUND`]).
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::coded(NOT_FOUND, message)
    }

    fn coded(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: Some(code.into()),
            message: message.into(),
        }
    }

    /// The error a read fails with under `access`, which does not allow
    /// it.
    fn not_allowed(access: Access) -> Self {
        match access {
            Access::Unavailable => Self::unavailable("there is no photo library to read here"),
            Access::NotDetermined => Self::denied(
                "the user has not let the app read the photo library yet: request access first",
            ),
            _ => Self::denied("the user does not let the app read the photo library"),
        }
    }

    /// How JS gets it: an `Error` with its `code`.
    fn to_js(&self) -> JsError {
        match &self.code {
            Some(code) => JsError::Error(self.message.clone()).with_code(code),
            None => JsError::Error(self.message.clone()),
        }
    }
}

impl fmt::Display for PhotosError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PhotosError {}

/// What a [`PhotosBackend`] answers.
pub type PhotosFuture<T> = Pin<Box<dyn Future<Output = Result<T, PhotosError>> + Send>>;

/// The access a [`PhotosBackend`] answers a request with.
pub type AccessFuture = Pin<Box<dyn Future<Output = Access> + Send>>;

/// Reads photos in place of the platform's library: an embedding app's own
/// library, or a test's photos. It reports changes to its library with
/// [`notify_change`].
pub trait PhotosBackend: Send + Sync {
    /// What the user lets the app read ([`access`]).
    fn access(&self) -> Access;

    /// Asks the user for access when it was not asked yet, and answers what
    /// the user allows ([`request_access`]).
    fn request_access(&self) -> AccessFuture;

    /// The `limit` most recent photos, the newest first ([`recent`]); the
    /// module asks only while [`access`](Self::access) allows reading.
    fn recent(&self, limit: u32) -> PhotosFuture<Vec<Asset>>;

    /// A small image of the photo `id` for `request`, prepared as the
    /// backend sees fit ([`thumbnail`]). The module only completes what is
    /// missing: its type, size and name from its bytes
    /// ([`nsh_core::picker::finish`]).
    fn thumbnail(&self, id: String, request: PhotoRequest) -> PhotosFuture<PickedFile>;

    /// The photo `id` for `request` ([`load`]), completed as a thumbnail
    /// is.
    fn load(&self, id: String, request: PhotoRequest) -> PhotosFuture<PickedFile>;

    /// Lets the user change the photos the app may read
    /// ([`present_limited_picker`]); by default there is no such sheet.
    fn present_limited_picker(&self) -> PhotosFuture<Vec<String>> {
        Box::pin(std::future::ready(Err(PhotosError::unavailable(
            "the photo library has no selection to change",
        ))))
    }
}

/// The backend answering in place of the platform ([`set_backend`]).
static BACKEND: RwLock<Option<Arc<dyn PhotosBackend>>> = RwLock::new(None);

/// Reads every photo from `backend` from now on (`None`: the platform's
/// library again). Process-wide on purpose: there is one photo library per
/// device, and the module's code is the process's, whichever surface asks.
pub fn set_backend(backend: Option<Arc<dyn PhotosBackend>>) {
    *BACKEND.write().unwrap_or_else(|e| e.into_inner()) = backend;
}

fn backend() -> Option<Arc<dyn PhotosBackend>> {
    BACKEND.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// What the user lets the app read now: on iOS, what the user allowed
/// ([`Access::Unavailable`] for an app whose `Info.plist` has no
/// `NSPhotoLibraryUsageDescription`, which the system would end the app
/// for asking without); elsewhere [`Access::Unavailable`]. Asks the user
/// nothing.
pub fn access() -> Access {
    match backend() {
        Some(backend) => backend.access(),
        None => platform::access(),
    }
}

/// Asks the user to let the app read the photo library when the user was
/// not asked yet ([`Access::NotDetermined`]), and resolves with what the
/// user allows; otherwise resolves with [`access`] at once. In a task.
pub async fn request_access() -> Access {
    let access = match backend() {
        Some(backend) => backend.request_access().await,
        None => platform::request_access().await,
    };
    if access.allows_reading() {
        observe();
    }
    access
}

/// The `limit` most recent photos the app may read (at most
/// [`MAX_RECENT`]), the newest first: images only, without those the user
/// hid. Fails with [`DENIED`] unless [`access`] allows reading. In a task.
pub async fn recent(limit: u32) -> Result<Vec<Asset>, PhotosError> {
    let limit = limit.min(MAX_RECENT);
    let backend = backend();
    let access = backend
        .as_ref()
        .map_or_else(platform::access, |backend| backend.access());
    if !access.allows_reading() {
        return Err(PhotosError::not_allowed(access));
    }
    if limit == 0 {
        return Ok(Vec::new());
    }
    observe();
    let mut assets = match backend {
        Some(backend) => backend.recent(limit).await,
        None => platform::recent(limit).await,
    }?;
    assets.truncate(limit as usize);
    Ok(assets)
}

/// A small image of the photo `id` to show: a JPEG whose longer side is at
/// most `max_dimension` pixels, upright. Reading a photo stored only in
/// iCloud downloads it. Dropping the future cancels the read. Fails with
/// [`DENIED`] unless [`access`] allows reading, and [`NOT_FOUND`] when the
/// photo is not there. In a task.
pub async fn thumbnail(id: &str, max_dimension: DevicePixels) -> Result<PickedFile, PhotosError> {
    read(id, PhotoRequest::thumbnail(max_dimension), Read::Thumbnail).await
}

/// The photo `id`, prepared as `request` says, as `Picker.pickImages`
/// prepares a picked image: scaled down to `max_dimension`, upright, a
/// JPEG without its metadata (HEIC becomes one) unless it is a PNG, GIF or
/// WebP, which stay as they are when not scaled. Reading a photo stored only in iCloud downloads
/// it. Dropping the future cancels the read. Fails as [`thumbnail`] does.
/// In a task.
pub async fn load(id: &str, request: PhotoRequest) -> Result<PickedFile, PhotosError> {
    read(id, request, Read::Photo).await
}

/// What [`read`] reads of a photo.
#[derive(Clone, Copy)]
enum Read {
    Thumbnail,
    Photo,
}

/// A thumbnail or a photo, from the backend or the platform.
async fn read(id: &str, request: PhotoRequest, what: Read) -> Result<PickedFile, PhotosError> {
    let backend = backend();
    let access = backend
        .as_ref()
        .map_or_else(platform::access, |backend| backend.access());
    let id = id.to_owned();
    let file = if !access.allows_reading() {
        Err(PhotosError::not_allowed(access))
    } else {
        match (backend, what) {
            (Some(backend), Read::Thumbnail) => backend.thumbnail(id.clone(), request).await,
            (Some(backend), Read::Photo) => backend.load(id.clone(), request).await,
            (None, Read::Thumbnail) => platform::thumbnail(id.clone(), request).await,
            (None, Read::Photo) => platform::load(id.clone(), request).await,
        }
    };
    match file {
        Ok(file) => nsh_core::picker::finish(&request.pick_request(), vec![file])
            .pop()
            .ok_or_else(|| PhotosError::failed("the photo cannot be read")),
        Err(error) => {
            log::warn!("photo {id} not read: {error}");
            Err(error)
        }
    }
}

/// Shows the system's sheet where the user changes the photos the app may
/// read, while the user allows only those ([`Access::Limited`]), and
/// resolves with the identifiers of the photos the user selected in it.
/// Fails with [`DENIED`] under any other access, as the sheet only changes
/// a limited selection. The change is reported to [`on_change`] too. In a
/// task.
pub async fn present_limited_picker() -> Result<Vec<String>, PhotosError> {
    let backend = backend();
    let access = backend
        .as_ref()
        .map_or_else(platform::access, |backend| backend.access());
    if access != Access::Limited {
        return Err(match access {
            Access::Full => {
                PhotosError::denied("the app reads the whole library: there is no selection")
            }
            other => PhotosError::not_allowed(other),
        });
    }
    match backend {
        Some(backend) => backend.present_limited_picker().await,
        None => platform::present_limited_picker().await,
    }
}

// --- Changes ----------------------------------------------------------------

/// What hears that the library changed.
#[derive(Default)]
struct Observers {
    /// Rust's ([`on_change`]), for the process's life.
    native: Vec<Arc<dyn Fn() + Send + Sync>>,
    /// JS listeners', while their VMs listen.
    listeners: Vec<Weak<Listener>>,
}

static OBSERVERS: Mutex<Observers> = Mutex::new(Observers {
    native: Vec::new(),
    listeners: Vec::new(),
});

fn observers() -> std::sync::MutexGuard<'static, Observers> {
    OBSERVERS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Calls `observer` whenever the photo library changes (a photo added,
/// removed or changed, the user's selection changed), on any thread, for
/// the process's life. The platform observes the library once the user
/// allows reading it.
pub fn on_change(observer: impl Fn() + Send + Sync + 'static) {
    observers().native.push(Arc::new(observer));
    observe();
}

/// Tells [`on_change`]'s observers and the JS listeners that the library
/// changed: what a [`PhotosBackend`] calls when its library does, and the
/// platform when the system's does.
pub fn notify_change() {
    let native = {
        let mut observers = observers();
        observers
            .listeners
            .retain(|listener| match listener.upgrade() {
                // Changes that come while the listener's last one is on its way
                // fold into one: the app reads the library again anyway.
                Some(listener) => {
                    listener.changed.notify_one();
                    true
                }
                None => false,
            });
        observers.native.clone()
    };
    for observer in native {
        observer();
    }
}

/// Starts observing the platform's library for changes, when something
/// listens and the user allows reading (the system's library would ask
/// otherwise); once.
fn observe() {
    if backend().is_some() {
        return;
    }
    let listening = {
        let observers = observers();
        !observers.native.is_empty() || !observers.listeners.is_empty()
    };
    if listening && platform::access().allows_reading() {
        platform::observe();
    }
}

/// One JS listener of `change`: woken by [`notify_change`].
struct Listener {
    changed: Notify,
    stopped: AtomicBool,
}

/// Where NSH reads no photo library: Android (see the module's
/// documentation), the desktops, the web, headless runs.
#[cfg(not(target_os = "ios"))]
mod platform {
    use super::{Access, Asset, PhotoRequest, PhotosError, PickedFile};

    pub(super) fn access() -> Access {
        Access::Unavailable
    }

    pub(super) async fn request_access() -> Access {
        Access::Unavailable
    }

    fn unavailable<T>() -> Result<T, PhotosError> {
        Err(PhotosError::not_allowed(Access::Unavailable))
    }

    pub(super) async fn recent(_: u32) -> Result<Vec<Asset>, PhotosError> {
        unavailable()
    }

    pub(super) async fn thumbnail(_: String, _: PhotoRequest) -> Result<PickedFile, PhotosError> {
        unavailable()
    }

    pub(super) async fn load(_: String, _: PhotoRequest) -> Result<PickedFile, PhotosError> {
        unavailable()
    }

    pub(super) async fn present_limited_picker() -> Result<Vec<String>, PhotosError> {
        unavailable()
    }

    pub(super) fn observe() {}
}

// --- JS ---------------------------------------------------------------------

/// Whether the calling VM may read the photo library: why not when it may
/// not. The photos reach the app as picked ones do, so `Picker`'s
/// capability grants them; what the user allowed is the whole app's, so
/// this check in each call is what keeps a VM without the grant from them.
fn granted(sys: &System) -> Result<(), JsError> {
    if sys.access.allows_picker() {
        return Ok(());
    }
    Err(JsError::access_denied(
        "the photo library is not granted: add `\"picker\": true` to capabilities in nsh.json",
        "picker",
        "",
    ))
}

/// The user's photo library. Needs the `picker` capability when the app
/// declares capabilities: without it every function but `access` rejects
/// or throws `ERR_ACCESS_DENIED` (checked here, in the call).
#[module]
pub(crate) struct Photos;

#[module]
impl Photos {
    /// What the user lets the app read now: `"full"`, `"limited"` (the
    /// photos the user selected), `"notDetermined"` (not asked yet),
    /// `"denied"` (only the system's settings change it) or
    /// `"unavailable"`: on Android, the desktops and the web, where
    /// `Picker.pickImages` is the way to the user's photos, and in an iOS
    /// app whose `Info.plist` has no `NSPhotoLibraryUsageDescription`. Asks
    /// the user nothing and needs no capability.
    pub(crate) fn access() -> Access {
        crate::photos::access()
    }

    /// Asks the user to let the app read the photo library when the user
    /// was not asked yet, and resolves with what the user allows; resolves
    /// with `access()` at once otherwise. Rejects with `ERR_ACCESS_DENIED`
    /// when the `picker` capability is not granted.
    pub(crate) async fn request_access(sys: System) -> Result<Access, JsError> {
        granted(&sys)?;
        Ok(crate::photos::request_access().await)
    }

    /// Resolves with the most recent photos the app may read, the newest
    /// first (`limit`, 30 when not given, at most 1000): images only,
    /// without those the user hid, each with its `id` and its `size`.
    /// Rejects with `EACCES` unless `access()` is `"full"` or `"limited"`,
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where it is `"unavailable"`,
    /// `ERR_ACCESS_DENIED` when the `picker` capability is not granted, and
    /// a `RangeError` for a `limit` out of range.
    pub(crate) async fn recent(
        options: Option<RecentPhotosOptions>,
        sys: System,
    ) -> Result<Vec<PhotoAsset>, JsError> {
        granted(&sys)?;
        let limit = options.unwrap_or_default().limit()?;
        match crate::photos::recent(limit).await {
            Ok(assets) => Ok(assets.into_iter().map(PhotoAsset::from).collect()),
            Err(error) => Err(error.to_js()),
        }
    }

    /// Resolves with a small image of the photo `id` to show, as
    /// `Picker.pickImages` gives a picked image (its bytes native: show it
    /// with `URL.createObjectURL(image.file)`): a JPEG whose longer side is
    /// at most `maxDimension` pixels (256 when not given, at most 2048),
    /// upright. A photo stored only in iCloud is downloaded. Rejects as
    /// `recent` does, with `ENOENT` when the photo is not there (any
    /// longer, or not among those the user selected), and a `RangeError`
    /// for options out of range.
    pub(crate) async fn thumbnail(
        id: String,
        options: Option<PhotoThumbnailOptions>,
        sys: System,
    ) -> Result<PickedImage, JsError> {
        granted(&sys)?;
        let max = options.unwrap_or_default().max_dimension()?;
        match crate::photos::thumbnail(&id, max).await {
            Ok(file) => Ok(PickedImage::new(file)),
            Err(error) => Err(error.to_js()),
        }
    }

    /// Resolves with the photo `id`, as `Picker.pickImages` gives a picked
    /// image, its bytes native: upright, a JPEG without its metadata (HEIC
    /// becomes one) unless it is a PNG, GIF or WebP.
    /// `maxDimension` scales it down natively; `quality` is the JPEG's,
    /// from 0 to 1 (0.9 when not given). A photo stored only in iCloud is
    /// downloaded. Rejects as `thumbnail` does.
    pub(crate) async fn load(
        id: String,
        options: Option<LoadPhotoOptions>,
        sys: System,
    ) -> Result<PickedImage, JsError> {
        granted(&sys)?;
        let request = options.unwrap_or_default().request()?;
        match crate::photos::load(&id, request).await {
            Ok(file) => Ok(PickedImage::new(file)),
            Err(error) => Err(error.to_js()),
        }
    }

    /// Shows the system's sheet where the user changes the photos the app
    /// may read, while `access()` is `"limited"`, and resolves with the
    /// `id`s of the photos the user selected in it; `change` listeners hear
    /// the change too. Rejects with `EACCES` under any other access (the
    /// sheet only changes a limited selection),
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where there is no library, and
    /// `ERR_ACCESS_DENIED` when the `picker` capability is not granted.
    pub(crate) async fn present_limited_picker(sys: System) -> Result<Vec<String>, JsError> {
        granted(&sys)?;
        crate::photos::present_limited_picker()
            .await
            .map_err(|error| error.to_js())
    }

    /// Whether `PhotosPicker` shows the system's picker here: on iOS 17
    /// and later. Elsewhere it takes no room, and the app lets the user
    /// choose with `Picker.pickImages`. Needs no capability.
    pub(crate) fn picker_view_available() -> bool {
        crate::photos::picker_view_available()
    }

    /// Resolves with the photo `id` selected in a `PhotosPicker` (its
    /// `change`), as `Picker.pickImages` gives a picked image, its bytes
    /// native: upright, a JPEG without its metadata (HEIC becomes one)
    /// unless it is a PNG, GIF or WebP. Takes `load`'s options. Needs no
    /// access to the library. A photo stored only in iCloud is downloaded.
    /// Rejects with `ENOENT` for an id that is not selected (any longer) in
    /// a picker shown, `ERR_ACCESS_DENIED` when the `picker` capability is
    /// not granted, and a `RangeError` for options out of range.
    pub(crate) async fn load_picked(
        id: String,
        options: Option<LoadPhotoOptions>,
        sys: System,
    ) -> Result<PickedImage, JsError> {
        granted(&sys)?;
        let request = options.unwrap_or_default().request()?;
        match crate::photos::load_picked(&id, request).await {
            Ok(file) => Ok(PickedImage::new(file)),
            Err(error) => Err(error.to_js()),
        }
    }

    /// Listens to `change`: the photo library changed (a photo added,
    /// removed or changed, the user's selection changed), so what the app
    /// shows of it may be out of date. Changes that come close together
    /// are reported once. It is heard once the user allows reading the
    /// library. Returns a function that stops listening. Throws
    /// `ERR_ACCESS_DENIED` when the `picker` capability is not granted.
    pub(crate) fn on(
        event: PhotosEvent,
        listener: Callback,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<Stop, JsError> {
        granted(&sys)?;
        let PhotosEvent::Change = event;
        let watch = Arc::new(Listener {
            changed: Notify::new(),
            stopped: AtomicBool::new(false),
        });
        observers().listeners.push(Arc::downgrade(&watch));
        observe();
        let task = watch.clone();
        // The task keeps the listener while the VM runs; closing the VM
        // drops it, which leaves only a dead entry for the next change to
        // remove.
        cx.start(async move {
            loop {
                task.changed.notified().await;
                if task.stopped.load(Ordering::Acquire) {
                    return;
                }
                listener.post(());
            }
        });
        Ok(Stop::new(move || {
            watch.stopped.store(true, Ordering::Release);
            watch.changed.notify_one();
            observers()
                .listeners
                .retain(|listener| !std::ptr::eq(listener.as_ptr(), Arc::as_ptr(&watch)));
        }))
    }
}

/// The event `Photos.on` listens to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub(crate) enum PhotosEvent {
    /// The photo library changed.
    #[default]
    Change,
}

/// A photo of the library (`recent`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct PhotoAsset {
    /// Its identifier in the library, which `thumbnail` and `load` take;
    /// stable across launches.
    id: String,
    /// Its size in pixels, as it shows.
    size: Size<DevicePixels>,
}

impl From<Asset> for PhotoAsset {
    fn from(asset: Asset) -> Self {
        Self {
            id: asset.id,
            size: asset.size,
        }
    }
}

/// How many photos `recent` reads.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RecentPhotosOptions {
    /// At most this many photos, from 1 to 1000 (30 when not given).
    pub(crate) limit: Option<f64>,
}

impl RecentPhotosOptions {
    /// The photos `recent` reads when no `limit` is given.
    const DEFAULT_LIMIT: u32 = 30;

    fn limit(self) -> Result<u32, JsError> {
        let Some(limit) = self.limit else {
            return Ok(Self::DEFAULT_LIMIT);
        };
        if limit.fract() != 0.0 || !(1.0..=f64::from(MAX_RECENT)).contains(&limit) {
            return Err(JsError::Range(format!(
                "`limit` must be a whole number from 1 to {MAX_RECENT}"
            )));
        }
        Ok(limit as u32)
    }
}

/// How large `thumbnail` reads the photo.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct PhotoThumbnailOptions {
    /// Its longer side in pixels at most, from 1 to 2048 (256 when not
    /// given); for a larger image, `load` reads the photo.
    pub(crate) max_dimension: Option<DevicePixels>,
}

impl PhotoThumbnailOptions {
    /// The longer side of a thumbnail when no `maxDimension` is given.
    const DEFAULT: DevicePixels = DevicePixels(256);
    /// The longest side a thumbnail has.
    const MAX: DevicePixels = DevicePixels(2048);

    fn max_dimension(self) -> Result<DevicePixels, JsError> {
        let max = self.max_dimension.unwrap_or(Self::DEFAULT);
        if !(1..=Self::MAX.0).contains(&max.0) {
            return Err(JsError::Range(format!(
                "`maxDimension` must be from 1 to {}",
                Self::MAX.0
            )));
        }
        Ok(max)
    }
}

/// How `load` prepares the photo.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct LoadPhotoOptions {
    /// A photo whose longer side is longer than this many pixels is scaled
    /// down to it (none: its size is kept).
    pub(crate) max_dimension: Option<DevicePixels>,
    /// The quality of the JPEG, from 0 (smallest) to 1 (best; 0.9 when not
    /// given).
    pub(crate) quality: Option<f64>,
}

impl LoadPhotoOptions {
    /// The request these options make, or why they make none.
    fn request(self) -> Result<PhotoRequest, JsError> {
        let mut request = PhotoRequest::default();
        if let Some(max) = self.max_dimension {
            if max.0 < 1 {
                return Err(JsError::Range("`maxDimension` must be at least 1".into()));
            }
            request.max_dimension = Some(max);
        }
        if let Some(quality) = self.quality {
            if !(0.0..=1.0).contains(&quality) {
                return Err(JsError::Range("`quality` must be from 0 to 1".into()));
            }
            request.quality = Some(Percentage(quality as f32));
        }
        Ok(request)
    }
}

#[cfg(test)]
mod tests;

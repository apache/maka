use std::{
    future::Future,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll, Waker},
};

use nsh_core::ImageData;

use super::{
    picker::{PickedSource, Selection},
    *,
};

/// The backend and the observers are process-wide: the tests that touch
/// them take turns.
static BACKEND_TESTS: Mutex<()> = Mutex::new(());

/// Polls `future`, which must finish without waiting.
fn ready<T>(future: impl Future<Output = T>) -> T {
    let mut future = std::pin::pin!(future);
    match future
        .as_mut()
        .poll(&mut Context::from_waker(Waker::noop()))
    {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("the future waited"),
    }
}

/// A 2×1 PNG's bytes.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
];

fn size(width: i32, height: i32) -> Size<DevicePixels> {
    Size::new(DevicePixels(width), DevicePixels(height))
}

/// A library of `count` photos under `access`, recording what it is asked.
struct TestLibrary {
    access: Mutex<Access>,
    /// What `request_access` turns a `NotDetermined` into.
    allows: Access,
    count: u32,
    asked: Mutex<Vec<String>>,
}

impl TestLibrary {
    fn new(access: Access, count: u32) -> Arc<Self> {
        Arc::new(Self {
            access: Mutex::new(access),
            allows: Access::Limited,
            count,
            asked: Mutex::new(Vec::new()),
        })
    }

    fn asked(&self) -> Vec<String> {
        self.asked.lock().unwrap().clone()
    }

    fn photo(&self, id: &str) -> Result<PickedFile, PhotosError> {
        if id.starts_with("photo-") {
            Ok(PickedFile::new(id, "", ImageData::from(PNG.to_vec())))
        } else {
            Err(PhotosError::not_found(format!("no photo {id}")))
        }
    }
}

impl PhotosBackend for TestLibrary {
    fn access(&self) -> Access {
        *self.access.lock().unwrap()
    }

    fn request_access(&self) -> AccessFuture {
        self.asked.lock().unwrap().push("access".into());
        let mut access = self.access.lock().unwrap();
        if *access == Access::NotDetermined {
            *access = self.allows;
        }
        Box::pin(std::future::ready(*access))
    }

    fn recent(&self, limit: u32) -> PhotosFuture<Vec<Asset>> {
        self.asked.lock().unwrap().push(format!("recent {limit}"));
        // More than asked: the module keeps at most `limit`.
        let assets = (0..self.count)
            .map(|i| Asset::new(format!("photo-{i}"), size(4000, 3000)))
            .collect();
        Box::pin(std::future::ready(Ok(assets)))
    }

    fn thumbnail(&self, id: String, request: PhotoRequest) -> PhotosFuture<PickedFile> {
        self.asked
            .lock()
            .unwrap()
            .push(format!("thumbnail {id} {:?}", request.max_dimension));
        Box::pin(std::future::ready(self.photo(&id)))
    }

    fn load(&self, id: String, request: PhotoRequest) -> PhotosFuture<PickedFile> {
        self.asked
            .lock()
            .unwrap()
            .push(format!("load {id} {:?}", request.max_dimension));
        Box::pin(std::future::ready(self.photo(&id)))
    }

    fn present_limited_picker(&self) -> PhotosFuture<Vec<String>> {
        self.asked.lock().unwrap().push("picker".into());
        notify_change();
        Box::pin(std::future::ready(Ok(vec!["photo-7".into()])))
    }
}

#[test]
fn options_make_requests() {
    assert_eq!(RecentPhotosOptions::default().limit(), Ok(30));
    assert_eq!(RecentPhotosOptions { limit: Some(12.0) }.limit(), Ok(12));
    for limit in [0.0, 1.5, 1001.0, -1.0, f64::NAN] {
        let options = RecentPhotosOptions { limit: Some(limit) };
        assert!(
            matches!(options.limit(), Err(JsError::Range(_))),
            "limit {limit}"
        );
    }

    assert_eq!(
        PhotoThumbnailOptions::default().max_dimension(),
        Ok(DevicePixels(256))
    );
    for max in [0, 2049] {
        let options = PhotoThumbnailOptions {
            max_dimension: Some(DevicePixels(max)),
        };
        assert!(matches!(options.max_dimension(), Err(JsError::Range(_))));
    }

    let request = LoadPhotoOptions {
        max_dimension: Some(DevicePixels(1200)),
        quality: Some(0.5),
    }
    .request()
    .unwrap();
    assert_eq!(request.max_dimension, Some(DevicePixels(1200)));
    assert_eq!(request.quality, Some(Percentage(0.5)));
    assert_eq!(
        LoadPhotoOptions::default().request(),
        Ok(PhotoRequest::default())
    );
    for out_of_range in [
        LoadPhotoOptions {
            max_dimension: Some(DevicePixels(0)),
            ..Default::default()
        },
        LoadPhotoOptions {
            quality: Some(1.5),
            ..Default::default()
        },
    ] {
        assert!(matches!(out_of_range.request(), Err(JsError::Range(_))));
    }
}

#[test]
fn a_photo_is_prepared_as_a_picked_image() {
    let request = PhotoRequest {
        max_dimension: Some(DevicePixels(800)),
        ..Default::default()
    }
    .pick_request();
    assert_eq!(request.limit, 1);
    assert_eq!(request.max_dimension, Some(DevicePixels(800)));
    assert_eq!(request.format, PickFormat::Compatible);
    // A JPEG is always encoded again: upright, without its metadata.
    assert_eq!(request.quality, Some(DEFAULT_QUALITY));

    let thumbnail = PhotoRequest::thumbnail(DevicePixels(200));
    assert_eq!(thumbnail.max_dimension, Some(DevicePixels(200)));
}

#[test]
fn errors_keep_their_codes() {
    assert_eq!(PhotosError::denied("x").to_js().code(), Some(DENIED));
    assert_eq!(PhotosError::not_found("x").to_js().code(), Some(NOT_FOUND));
    assert_eq!(
        PhotosError::unavailable("x").to_js().code(),
        Some("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM")
    );
    assert_eq!(PhotosError::failed("x").to_js().code(), None);
    assert_eq!(
        PhotosError::not_allowed(Access::NotDetermined)
            .code
            .as_deref(),
        Some(DENIED)
    );
    assert_eq!(
        PhotosError::not_allowed(Access::Unavailable)
            .code
            .as_deref(),
        Some(UNAVAILABLE)
    );
}

#[cfg(not(target_os = "ios"))]
#[test]
fn there_is_no_library_off_ios() {
    let _turn = BACKEND_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    set_backend(None);
    assert_eq!(access(), Access::Unavailable);
    assert_eq!(ready(request_access()), Access::Unavailable);
    let error = ready(recent(10)).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(UNAVAILABLE));
    let error = ready(thumbnail("photo-0", DevicePixels(100))).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(UNAVAILABLE));
    let error = ready(load("photo-0", PhotoRequest::default())).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(UNAVAILABLE));
    let error = ready(present_limited_picker()).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(UNAVAILABLE));
}

#[test]
fn reading_waits_for_the_users_permission() {
    let _turn = BACKEND_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    let library = TestLibrary::new(Access::NotDetermined, 3);
    set_backend(Some(library.clone()));
    assert_eq!(access(), Access::NotDetermined);
    // Not read before the user allows it.
    let error = ready(recent(10)).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(DENIED));
    let error = ready(thumbnail("photo-0", DevicePixels(100))).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(DENIED));
    assert!(library.asked().is_empty());

    assert_eq!(ready(request_access()), Access::Limited);
    assert_eq!(access(), Access::Limited);
    assert_eq!(ready(recent(10)).unwrap().len(), 3);

    *library.access.lock().unwrap() = Access::Denied;
    let error = ready(load("photo-0", PhotoRequest::default())).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(DENIED));
    set_backend(None);
    assert_eq!(library.asked(), ["access", "recent 10"]);
}

#[test]
fn recent_keeps_the_limit() {
    let _turn = BACKEND_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    let library = TestLibrary::new(Access::Full, 50);
    set_backend(Some(library.clone()));
    let assets = ready(recent(5)).unwrap();
    assert_eq!(assets.len(), 5);
    assert_eq!(assets[0], Asset::new("photo-0", size(4000, 3000)));
    // None asked: the backend is not.
    assert!(ready(recent(0)).unwrap().is_empty());
    // At most `MAX_RECENT`.
    let _ = ready(recent(5000));
    set_backend(None);
    assert_eq!(library.asked(), ["recent 5", "recent 1000"]);
}

#[test]
fn thumbnails_and_photos_are_completed_as_picked_images() {
    let _turn = BACKEND_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    let library = TestLibrary::new(Access::Full, 1);
    set_backend(Some(library.clone()));
    let thumbnail = ready(thumbnail("photo-0", DevicePixels(120))).unwrap();
    let photo = ready(load(
        "photo-0",
        PhotoRequest {
            max_dimension: Some(DevicePixels(640)),
            ..Default::default()
        },
    ))
    .unwrap();
    let missing = ready(load("gone", PhotoRequest::default())).unwrap_err();
    set_backend(None);
    for file in [thumbnail, photo] {
        // Its type, size and extension from its bytes.
        assert_eq!(file.mime, "image/png");
        assert_eq!(file.name, "photo-0.png");
        assert_eq!(file.size, size(2, 1));
    }
    assert_eq!(missing.code.as_deref(), Some(NOT_FOUND));
    assert_eq!(
        library.asked(),
        [
            "thumbnail photo-0 Some(120px (device))",
            "load photo-0 Some(640px (device))",
            "load gone None",
        ]
    );
}

#[test]
fn the_limited_picker_needs_limited_access() {
    let _turn = BACKEND_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    let library = TestLibrary::new(Access::Full, 1);
    set_backend(Some(library.clone()));
    let error = ready(present_limited_picker()).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(DENIED));
    *library.access.lock().unwrap() = Access::Limited;
    assert_eq!(ready(present_limited_picker()).unwrap(), ["photo-7"]);
    set_backend(None);
    assert_eq!(library.asked(), ["picker"]);
}

#[test]
fn changes_reach_the_observers() {
    let _turn = BACKEND_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    static HEARD: AtomicUsize = AtomicUsize::new(0);
    let library = TestLibrary::new(Access::Limited, 1);
    set_backend(Some(library));
    on_change(|| {
        HEARD.fetch_add(1, Ordering::SeqCst);
    });
    // A JS listener's watch, as `Photos.on` registers it.
    let watch = Arc::new(Listener {
        changed: Notify::new(),
        stopped: AtomicBool::new(false),
    });
    observers().listeners.push(Arc::downgrade(&watch));
    let before = HEARD.load(Ordering::SeqCst);
    ready(present_limited_picker()).unwrap();
    notify_change();
    assert_eq!(HEARD.load(Ordering::SeqCst), before + 2);
    // Two changes fold into one wake-up of the listener.
    ready(watch.changed.notified());
    {
        let mut again = std::pin::pin!(watch.changed.notified());
        assert!(
            again
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
    }
    // A listener whose VM went is forgotten at the next change.
    drop(watch);
    notify_change();
    assert!(observers().listeners.is_empty());
    set_backend(None);
}

#[test]
fn the_set_declares_the_library() {
    let ts = nsh_core::element::declarations(&crate::registry(), &[]);
    for declared in [
        "Photos",
        "access(",
        "requestAccess(",
        "recent(",
        "RecentPhotosOptions",
        "PhotoAsset",
        "thumbnail(",
        "PhotoThumbnailOptions",
        "load(",
        "LoadPhotoOptions",
        "PickedImage",
        "presentLimitedPicker(",
        "\"notDetermined\"",
        "\"change\"",
        "pickerViewAvailable(",
        "loadPicked(",
        "PhotosPicker",
        "selectionLimit",
        "\"livePhotos\"",
        "deselect(",
    ] {
        assert!(ts.contains(declared), "{declared} is not declared:\n{ts}");
    }
}

/// A selected photo the test reads: a PNG, or a failure; counts its reads.
struct TestSource {
    fails: bool,
    reads: AtomicUsize,
}

impl TestSource {
    fn new(fails: bool) -> Arc<Self> {
        Arc::new(Self {
            fails,
            reads: AtomicUsize::new(0),
        })
    }
}

impl PickedSource for TestSource {
    fn load(&self, request: PhotoRequest) -> PhotosFuture<PickedFile> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        let file = if self.fails {
            Err(PhotosError::failed("the provider failed"))
        } else {
            let mut file = PickedFile::new("IMG_0001", "", ImageData::from(PNG.to_vec()));
            // What the platform scaled it to stands in for the request's.
            file.size = request
                .max_dimension
                .map_or(size(2, 1), |max| size(max.0, 1));
            Ok(file)
        };
        Box::pin(std::future::ready(file))
    }
}

fn source(source: &Arc<TestSource>) -> Arc<dyn PickedSource> {
    source.clone()
}

#[test]
fn picked_photos_read_while_selected() {
    let first = TestSource::new(false);
    let second = TestSource::new(false);
    let mut selection = Selection::new();
    let ids = selection
        .set(vec![
            ("A/L0/001".into(), source(&first)),
            ("B/L0/001".into(), source(&second)),
        ])
        .unwrap();
    assert_eq!(ids.len(), 2);
    assert_eq!(selection.key(&ids[0]), Some("A/L0/001"));
    assert_eq!(selection.keys(), ["A/L0/001", "B/L0/001"]);
    // Read as a picked image: its type and extension from its bytes.
    let file = ready(load_picked(&ids[0], PhotoRequest::default())).unwrap();
    assert_eq!(file.mime, "image/png");
    assert_eq!(file.name, "IMG_0001.png");
    assert_eq!(file.size, size(2, 1));
    assert_eq!(first.reads.load(Ordering::SeqCst), 1);

    // The same selection again changes nothing.
    assert_eq!(
        selection.set(vec![
            ("A/L0/001".into(), source(&TestSource::new(true))),
            ("B/L0/001".into(), source(&second)),
        ]),
        None
    );
    // A photo selected already keeps its source: the system gives none for
    // one it shows selected in a picker made again.
    ready(load_picked(&ids[0], PhotoRequest::default())).unwrap();
    assert_eq!(first.reads.load(Ordering::SeqCst), 2);

    // Deselected in the picker: its id reads no more.
    assert_eq!(
        selection.set(vec![("B/L0/001".into(), source(&second))]),
        Some(vec![ids[1].clone()])
    );
    let error = ready(load_picked(&ids[0], PhotoRequest::default())).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(NOT_FOUND));

    // Deselected by the app.
    assert_eq!(selection.remove(&ids[1]), Some(Vec::new()));
    assert_eq!(selection.remove(&ids[1]), None);
    let error = ready(load_picked(&ids[1], PhotoRequest::default())).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(NOT_FOUND));
}

#[test]
fn each_picker_has_its_own_ids() {
    let photo = TestSource::new(false);
    let mut one = Selection::new();
    let mut other = Selection::new();
    let first = one.set(vec![("A".into(), source(&photo))]).unwrap();
    let second = other.set(vec![("A".into(), source(&photo))]).unwrap();
    assert_ne!(first, second);
    assert_eq!(one.key(&second[0]), None);
    // A picker gone takes its selection with it; the other's stays.
    drop(one);
    let error = ready(load_picked(&first[0], PhotoRequest::default())).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(NOT_FOUND));
    ready(load_picked(&second[0], PhotoRequest::default())).unwrap();
}

#[test]
fn a_picked_photo_is_prepared_as_requested() {
    let photo = TestSource::new(false);
    let failing = TestSource::new(true);
    let mut selection = Selection::new();
    let ids = selection
        .set(vec![
            ("A".into(), source(&photo)),
            ("B".into(), source(&failing)),
        ])
        .unwrap();
    let request = LoadPhotoOptions {
        max_dimension: Some(DevicePixels(640)),
        quality: Some(0.5),
    }
    .request()
    .unwrap();
    let file = ready(load_picked(&ids[0], request)).unwrap();
    assert_eq!(file.size, size(640, 1));
    let error = ready(load_picked(&ids[1], request)).unwrap_err();
    assert_eq!(error.code, None);
    assert_eq!(error.message, "the provider failed");
    let error = ready(load_picked("no-such-id", request)).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(NOT_FOUND));
}

#[cfg(not(target_os = "ios"))]
#[test]
fn the_picker_view_is_ios_only() {
    assert!(!picker_view_available());
}

#[test]
fn the_picker_filter_names() {
    assert_eq!(PhotosPickerFilter::default(), PhotosPickerFilter::Images);
    for (filter, name) in [
        (PhotosPickerFilter::Images, "images"),
        (PhotosPickerFilter::LivePhotos, "livePhotos"),
        (PhotosPickerFilter::Screenshots, "screenshots"),
    ] {
        assert_eq!(filter.name(), name);
    }
}

use std::{
    future::Future,
    sync::Mutex,
    task::{Context, Poll, Waker},
};

use nsh_core::ImageData;

use super::*;

/// The backend is process-wide: the tests that set one take turns.
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

/// A camera that answers each photo with `photo`.
struct TestCamera {
    photo: Result<Option<PickedFile>, PhotoError>,
    asked: Mutex<Vec<PhotoRequest>>,
}

impl CameraBackend for TestCamera {
    fn available(&self) -> bool {
        true
    }

    fn take_photo(&self, request: PhotoRequest) -> PhotoFuture {
        self.asked.lock().unwrap().push(request);
        Box::pin(std::future::ready(self.photo.clone()))
    }
}

/// A 2×1 PNG's bytes.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00,
];

#[test]
fn options_make_requests() {
    let request = TakePhotoOptions {
        max_dimension: Some(DevicePixels(1200)),
        quality: Some(0.5),
    }
    .request()
    .unwrap();
    assert_eq!(request.max_dimension, Some(DevicePixels(1200)));
    assert_eq!(request.quality, Some(Percentage(0.5)));
    assert_eq!(
        TakePhotoOptions::default().request(),
        Ok(PhotoRequest::default())
    );
    for out_of_range in [
        TakePhotoOptions {
            max_dimension: Some(DevicePixels(0)),
            ..Default::default()
        },
        TakePhotoOptions {
            quality: Some(1.5),
            ..Default::default()
        },
    ] {
        assert!(matches!(out_of_range.request(), Err(JsError::Range(_))));
    }
}

#[test]
fn a_photo_is_prepared_as_one_compatible_jpeg() {
    let request = PhotoRequest {
        max_dimension: Some(DevicePixels(800)),
        ..Default::default()
    }
    .pick_request();
    assert_eq!(request.limit, 1);
    assert_eq!(request.max_dimension, Some(DevicePixels(800)));
    assert_eq!(request.format, PickFormat::Compatible);
    // Always encoded again: upright, without the camera's metadata.
    assert_eq!(request.quality, Some(DEFAULT_QUALITY));
}

#[test]
fn errors_keep_their_codes() {
    assert_eq!(
        PhotoError::denied("the camera is off").to_js().code(),
        Some(DENIED)
    );
    assert_eq!(
        PhotoError::unavailable("no camera").to_js().code(),
        Some("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM")
    );
    assert_eq!(PhotoError::failed("x").to_js().code(), None);
}

#[cfg(not(any(target_os = "ios", target_os = "android")))]
#[test]
fn there_is_no_camera_off_the_mobile_platforms() {
    let _turn = BACKEND_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    set_backend(None);
    assert!(!ready(available()));
    let error = ready(take_photo(PhotoRequest::default())).unwrap_err();
    assert_eq!(error.code.as_deref(), Some(UNAVAILABLE));
}

#[test]
fn a_backend_answers_in_place_of_the_platform() {
    let _turn = BACKEND_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    let camera = Arc::new(TestCamera {
        photo: Ok(Some(PickedFile::new(
            "photo",
            "",
            ImageData::from(PNG.to_vec()),
        ))),
        asked: Mutex::new(Vec::new()),
    });
    set_backend(Some(camera.clone()));
    assert!(ready(available()));
    let request = PhotoRequest {
        max_dimension: Some(DevicePixels(640)),
        ..Default::default()
    };
    let photo = ready(take_photo(request)).unwrap().unwrap();
    set_backend(None);
    assert_eq!(camera.asked.lock().unwrap().as_slice(), [request]);
    // Completed as a picked image: its type, size and extension from its bytes.
    assert_eq!(photo.mime, "image/png");
    assert_eq!(photo.name, "photo.png");
    assert_eq!(
        photo.size,
        nsh_core::geometry::Size::new(DevicePixels(2), DevicePixels(1))
    );
}

#[test]
fn a_backend_cancels_and_fails() {
    let _turn = BACKEND_TESTS.lock().unwrap_or_else(|e| e.into_inner());
    for answer in [Ok(None), Err(PhotoError::denied("no"))] {
        set_backend(Some(Arc::new(TestCamera {
            photo: answer.clone(),
            asked: Mutex::new(Vec::new()),
        })));
        assert_eq!(ready(take_photo(PhotoRequest::default())), answer);
    }
    set_backend(None);
}

#[test]
fn the_set_declares_the_camera() {
    let ts = nsh_core::element::declarations(&crate::registry(), &[]);
    for declared in [
        "Camera",
        "takePhoto(",
        "TakePhotoOptions",
        "PickedImage",
        "available(",
    ] {
        assert!(ts.contains(declared), "{declared} is not declared:\n{ts}");
    }
}

//! `Camera` (feature `camera`): a photo taken with the system's camera,
//! which reaches the app as `Picker.pickImages` gives a picked image
//! ([`PickedImage`]: a JPEG, upright, scaled to the request, without the
//! camera's metadata).
//!
//! iOS shows `UIImagePickerController` full screen over the surface that
//! asked (`ios.rs`); Android starts the camera app for a result, writing
//! through the runtime's file provider (`android.rs`). One photo is taken at
//! a time: another asked meanwhile fails. Elsewhere (the
//! desktops, the web, headless runs) there is no camera: [`available`] is
//! false and [`take_photo`] fails with [`UNAVAILABLE`]. An embedding app
//! or a test answers in place of the platform with a [`CameraBackend`]
//! ([`set_backend`]).
//!
//! The packaged app needs `NSCameraUsageDescription` on iOS and queries the
//! camera apps on Android: `nsh` adds both from this crate's
//! `[package.metadata.nsh.features.camera]` when the feature is on.

#[cfg(target_os = "android")]
mod android;
#[cfg(target_os = "ios")]
mod ios;

use std::{
    fmt,
    future::Future,
    pin::Pin,
    sync::{Arc, RwLock},
};

use nsh_core::{
    element::codes,
    geometry::{DevicePixels, Percentage},
    picker::{DEFAULT_QUALITY, PickFormat, PickRequest, PickedFile, PickedImage},
    prelude::*,
};

#[cfg(target_os = "android")]
use self::android as platform;
#[cfg(target_os = "ios")]
use self::ios as platform;

/// The code of a photo the system refused to take: the user does not let
/// the app use the camera (Node's `EACCES`: the OS refused). Only the
/// system's settings change that:
/// [`open_app_settings`](nsh_core::mobile::open_app_settings) takes the
/// user to the app's page there.
pub const DENIED: &str = "EACCES";

/// The code of a photo where there is no camera to take one with.
pub const UNAVAILABLE: &str = codes::UNAVAILABLE;

/// What the app asked a photo for, checked: how the photo the user takes
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
    /// The pick of one image that prepares the photo as a picked one: a
    /// JPEG every browser and server takes, encoded again (so it comes
    /// upright and without the camera's metadata) at the request's quality.
    pub fn pick_request(&self) -> PickRequest {
        let mut request = PickRequest::new(false, 1);
        request.max_dimension = self.max_dimension;
        request.quality = Some(self.quality.unwrap_or(DEFAULT_QUALITY));
        request.format = PickFormat::Compatible;
        request
    }
}

/// Why a photo was not taken.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct PhotoError {
    /// A stable code the app can branch on ([`DENIED`], [`UNAVAILABLE`]);
    /// `None` for other failures.
    pub code: Option<String>,
    /// What went wrong, in words.
    pub message: String,
}

impl PhotoError {
    /// A failure with `message` and no code.
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    /// There is no camera to take a photo with here ([`UNAVAILABLE`]).
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: Some(UNAVAILABLE.into()),
            message: message.into(),
        }
    }

    /// The user does not let the app use the camera ([`DENIED`]).
    pub fn denied(message: impl Into<String>) -> Self {
        Self {
            code: Some(DENIED.into()),
            message: message.into(),
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

impl fmt::Display for PhotoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for PhotoError {}

/// The photo a [`CameraBackend`] takes: `None` when the user cancels.
pub type PhotoFuture = Pin<Box<dyn Future<Output = Result<Option<PickedFile>, PhotoError>> + Send>>;

/// Takes photos in place of the platform's camera: an embedding app's own
/// camera, or a test's photos.
pub trait CameraBackend: Send + Sync {
    /// Whether it takes photos ([`available`]).
    fn available(&self) -> bool;

    /// The photo the user took for `request`, prepared as the backend sees
    /// fit (`request` says how the platforms prepare theirs, and
    /// [`PhotoRequest::pick_request`] is the pick that does it). The module
    /// only completes what is missing: its type, size and name from its
    /// bytes ([`nsh_core::picker::finish`]); it encodes nothing again.
    fn take_photo(&self, request: PhotoRequest) -> PhotoFuture;
}

/// The backend answering in place of the platform ([`set_backend`]).
static BACKEND: RwLock<Option<Arc<dyn CameraBackend>>> = RwLock::new(None);

/// Answers every photo with `backend` from now on (`None`: the platform's
/// camera again). Process-wide on purpose: there is one camera per device,
/// and the module's code is the process's, whichever surface asks.
pub fn set_backend(backend: Option<Arc<dyn CameraBackend>>) {
    *BACKEND.write().unwrap_or_else(|e| e.into_inner()) = backend;
}

fn backend() -> Option<Arc<dyn CameraBackend>> {
    BACKEND.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Whether photos can be taken here: on iOS and Android devices with a
/// camera (on iOS, also only when the app's `Info.plist` describes the
/// camera's use, `NSCameraUsageDescription`), or with a [`CameraBackend`]
/// that takes them. Whether the user lets the app use the camera is asked
/// when a photo is taken. In a task.
pub async fn available() -> bool {
    match backend() {
        Some(backend) => backend.available(),
        None => platform::available().await,
    }
}

/// Shows the system's camera and resolves with the photo the user took,
/// prepared as `request` says; `None` when the user cancels. The system
/// asks the user for the camera the first time. A [`CameraBackend`]'s photo
/// comes as the backend prepared it. In a task.
pub async fn take_photo(request: PhotoRequest) -> Result<Option<PickedFile>, PhotoError> {
    let photo = match backend() {
        Some(backend) => backend.take_photo(request).await,
        None => platform::take_photo(request).await,
    };
    match photo {
        Ok(photo) => Ok(nsh_core::picker::finish(
            &request.pick_request(),
            photo.into_iter().collect(),
        )
        .pop()),
        Err(error) => {
            log::warn!("no photo taken: {error}");
            Err(error)
        }
    }
}

/// The name a photo taken now gets, the same on every platform:
/// `IMG_<seconds since 1970>.jpg`.
#[cfg(any(target_os = "ios", target_os = "android"))]
fn photo_name() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    format!("IMG_{seconds}.jpg")
}

/// Where NSH shows no camera: the desktops, the web, headless runs.
#[cfg(not(any(target_os = "ios", target_os = "android")))]
mod platform {
    use super::{PhotoError, PhotoRequest, PickedFile};

    pub(super) async fn available() -> bool {
        false
    }

    pub(super) async fn take_photo(_: PhotoRequest) -> Result<Option<PickedFile>, PhotoError> {
        Err(PhotoError::unavailable(
            "there is no camera to take a photo with here",
        ))
    }
}

/// The system's camera.
#[module]
pub(crate) struct Camera;

#[module]
impl Camera {
    /// Shows the system's camera and resolves with the photo the user
    /// took, as `Picker.pickImages` gives a picked image (a JPEG, upright,
    /// without the camera's metadata, its bytes native); `null` when the
    /// user cancels. `maxDimension` scales it down natively. The system asks
    /// the user for the camera the first time. Rejects with `EACCES` when
    /// the user does not let the app use the camera (only the system's
    /// settings change that), `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where
    /// there is no camera (ask `available()` first), and a `RangeError` for
    /// options out of range.
    pub(crate) async fn take_photo(
        options: Option<TakePhotoOptions>,
    ) -> Result<Option<PickedImage>, JsError> {
        let request = options.unwrap_or_default().request()?;
        match crate::camera::take_photo(request).await {
            Ok(photo) => Ok(photo.map(PickedImage::new)),
            Err(error) => Err(error.to_js()),
        }
    }

    /// Resolves with whether photos can be taken here: `true` on iOS and
    /// Android devices with a camera, `false` on the desktops, the web, a
    /// simulator, devices without one and iOS apps whose `Info.plist` has
    /// no `NSCameraUsageDescription`, where `takePhoto` rejects with
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`. Whether the user lets the app
    /// use the camera is asked when a photo is taken.
    pub(crate) async fn available() -> bool {
        crate::camera::available().await
    }
}

/// How `takePhoto` prepares the photo.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct TakePhotoOptions {
    /// A photo whose longer side is longer than this many pixels is scaled
    /// down to it (none: its size is kept).
    pub(crate) max_dimension: Option<DevicePixels>,
    /// The quality of the JPEG, from 0 (smallest) to 1 (best; 0.9 when not
    /// given).
    pub(crate) quality: Option<f64>,
}

impl TakePhotoOptions {
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

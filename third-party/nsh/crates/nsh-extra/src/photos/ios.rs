//! The photo library on iOS: the Photos framework. Access is asked with
//! `PHPhotoLibrary`'s read-write level (reading needs it; adding only does
//! not read), and only while the app's `Info.plist` describes the use,
//! `NSPhotoLibraryUsageDescription`: without it the system would end the
//! app, so the library is unavailable instead (an embedding app may lack
//! it). Mac Catalyst reads none: NSH's development host there is not
//! entitled to the user's photos.
//!
//! The recent photos are a fetch of `PHAsset`s, the images by creation
//! date; thumbnails come from `PHImageManager` at the size asked, photos
//! as their data, both allowed to download from iCloud, and each read is
//! cancelled when its future is dropped. Every image is prepared off the
//! main thread as a picked image (`nsh_platform_ios::prepare_image`). The
//! library's changes come from one `PHPhotoLibraryChangeObserver`,
//! registered once the user allows reading.

use std::sync::{Mutex, Once};

use block2::RcBlock;
use nsh_core::{
    geometry::{DevicePixels, Size},
    picker::PickedFile,
    prelude::*,
};
use objc2::{
    ClassType, MainThreadMarker, define_class, msg_send,
    rc::{Retained, autoreleasepool},
    runtime::{AnyClass, AnyObject, AnyProtocol, Bool},
};
use objc2_core_foundation::CGSize;
use objc2_foundation::{
    NSArray, NSBundle, NSData, NSDictionary, NSError, NSNumber, NSObject, NSObjectProtocol,
    NSString,
};
use objc2_ui_kit::UIImage;
use tokio::sync::oneshot;

use super::{Access, Asset, PhotoRequest, PhotosError};

#[link(name = "Photos", kind = "framework")]
unsafe extern "C" {}
// `presentLimitedLibraryPickerFromViewController:` is PhotosUI's.
#[link(name = "PhotosUI", kind = "framework")]
unsafe extern "C" {}

/// `PHAccessLevelReadWrite`.
const READ_WRITE: isize = 2;

/// `PHAuthorizationStatus`.
const NOT_DETERMINED: isize = 0;
const RESTRICTED: isize = 1;
const DENIED: isize = 2;
const AUTHORIZED: isize = 3;
const LIMITED: isize = 4;

/// `PHAssetMediaTypeImage`.
const MEDIA_IMAGE: isize = 1;

/// `PHImageRequestOptionsDeliveryModeHighQualityFormat`: one answer, not
/// a degraded one first (the future answers once).
const HIGH_QUALITY: isize = 1;

/// `PHImageRequestOptionsResizeModeExact`.
const RESIZE_EXACT: isize = 2;

/// `PHImageContentModeAspectFit`.
const ASPECT_FIT: isize = 0;

/// `PHImageRequestOptionsVersionCurrent`: the photo as it shows, its edits
/// applied.
const VERSION_CURRENT: isize = 0;

/// `PHInvalidImageRequestID`.
const INVALID_REQUEST: i32 = 0;

/// A `UIImage` handed to another thread.
struct SentImage(Retained<UIImage>);

// SAFETY: a `UIImage` is immutable, and UIKit documents it safe to use from
// any thread.
unsafe impl Send for SentImage {}

pub(super) fn access() -> Access {
    if cfg!(target_abi = "macabi") || !described() {
        return Access::Unavailable;
    }
    let Some(library) = AnyClass::get(c"PHPhotoLibrary") else {
        return Access::Unavailable;
    };
    // SAFETY: Photos' documented class method, callable from any thread.
    let status: isize =
        unsafe { msg_send![library, authorizationStatusForAccessLevel: READ_WRITE] };
    access_of(status)
}

/// Whether the app's Info.plist describes the library's use.
fn described() -> bool {
    NSBundle::mainBundle()
        .objectForInfoDictionaryKey(&NSString::from_str("NSPhotoLibraryUsageDescription"))
        .is_some()
}

fn access_of(status: isize) -> Access {
    match status {
        NOT_DETERMINED => Access::NotDetermined,
        AUTHORIZED => Access::Full,
        LIMITED => Access::Limited,
        RESTRICTED | DENIED => Access::Denied,
        _ => Access::Denied,
    }
}

pub(super) async fn request_access() -> Access {
    let now = access();
    if now != Access::NotDetermined {
        return now;
    }
    let (answer, answered) = oneshot::channel();
    // The prompt is UI: asked from the main thread.
    let asked = run_on_main_thread(move || {
        let Some(library) = AnyClass::get(c"PHPhotoLibrary") else {
            return;
        };
        let answer = Mutex::new(Some(answer));
        let handler = RcBlock::new(move |status: isize| {
            if let Some(answer) = answer.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = answer.send(access_of(status));
            }
        });
        // SAFETY: Photos' documented class method; the handler runs once,
        // on a queue of Photos'.
        unsafe {
            let _: () = msg_send![
                library,
                requestAuthorizationForAccessLevel: READ_WRITE,
                handler: &*handler
            ];
        }
    })
    .await;
    if asked.is_err() {
        return access();
    }
    answered.await.unwrap_or_else(|_| access())
}

pub(super) async fn recent(limit: u32) -> Result<Vec<Asset>, PhotosError> {
    blocking(move || autoreleasepool(|_| fetch_recent(limit)))
        .await
        .map_err(|error| PhotosError::failed(format!("cannot read the photo library: {error}")))?
}

/// The `limit` newest images of the library (hidden ones are left out by
/// default).
fn fetch_recent(limit: u32) -> Result<Vec<Asset>, PhotosError> {
    let unavailable = || PhotosError::unavailable("the Photos framework cannot be loaded");
    let options_class = AnyClass::get(c"PHFetchOptions").ok_or_else(unavailable)?;
    let asset_class = AnyClass::get(c"PHAsset").ok_or_else(unavailable)?;
    let sort_class = AnyClass::get(c"NSSortDescriptor").ok_or_else(unavailable)?;
    // SAFETY: Photos' and Foundation's documented API, with arguments of
    // the documented types.
    unsafe {
        let options: Retained<AnyObject> = msg_send![options_class, new];
        let key = NSString::from_str("creationDate");
        let newest: Retained<AnyObject> =
            msg_send![sort_class, sortDescriptorWithKey: &*key, ascending: Bool::NO];
        let sorts = NSArray::from_retained_slice(&[newest]);
        let _: () = msg_send![&options, setSortDescriptors: &*sorts];
        let _: () = msg_send![&options, setFetchLimit: limit as usize];
        let found: Retained<AnyObject> =
            msg_send![asset_class, fetchAssetsWithMediaType: MEDIA_IMAGE, options: &*options];
        let count: usize = msg_send![&found, count];
        let mut assets = Vec::with_capacity(count);
        for index in 0..count {
            let asset: Retained<AnyObject> = msg_send![&found, objectAtIndex: index];
            assets.push(asset_of(&asset));
        }
        Ok(assets)
    }
}

/// The [`Asset`] of a `PHAsset`.
///
/// # Safety
///
/// `asset` is a `PHAsset`.
unsafe fn asset_of(asset: &AnyObject) -> Asset {
    // SAFETY: `PHAsset`'s documented properties.
    unsafe {
        let id: Retained<NSString> = msg_send![asset, localIdentifier];
        let width: usize = msg_send![asset, pixelWidth];
        let height: usize = msg_send![asset, pixelHeight];
        Asset::new(
            id.to_string(),
            Size::new(DevicePixels(width as i32), DevicePixels(height as i32)),
        )
    }
}

/// The image `id` names, among those the app may read.
fn find(id: &str) -> Result<Retained<AnyObject>, PhotosError> {
    let asset_class = AnyClass::get(c"PHAsset")
        .ok_or_else(|| PhotosError::unavailable("the Photos framework cannot be loaded"))?;
    let ids = NSArray::from_retained_slice(&[NSString::from_str(id)]);
    // SAFETY: Photos' documented API.
    let asset: Option<Retained<AnyObject>> = unsafe {
        let found: Retained<AnyObject> = msg_send![
            asset_class,
            fetchAssetsWithLocalIdentifiers: &*ids,
            options: Option::<&AnyObject>::None
        ];
        msg_send![&found, firstObject]
    };
    let asset = asset.ok_or_else(|| {
        PhotosError::not_found(format!("there is no photo {id} the app may read"))
    })?;
    // SAFETY: `PHAsset`'s documented property.
    let media: isize = unsafe { msg_send![&asset, mediaType] };
    if media != MEDIA_IMAGE {
        return Err(PhotosError::not_found(format!("{id} is not a photo")));
    }
    Ok(asset)
}

/// The name the photo was added to the library with (`IMG_0042.HEIC`),
/// `photo` when it has none.
///
/// # Safety
///
/// `asset` is a `PHAsset`.
unsafe fn file_name(asset: &AnyObject) -> String {
    let Some(class) = AnyClass::get(c"PHAssetResource") else {
        return "photo".into();
    };
    // SAFETY: Photos' documented API.
    unsafe {
        let resources: Retained<NSArray<AnyObject>> =
            msg_send![class, assetResourcesForAsset: asset];
        let Some(first) = resources.firstObject() else {
            return "photo".into();
        };
        let name: Retained<NSString> = msg_send![&first, originalFilename];
        name.to_string()
    }
}

/// The options of one image request: the image as it shows, one answer,
/// downloaded from iCloud when stored there only.
fn request_options() -> Result<Retained<AnyObject>, PhotosError> {
    let class = AnyClass::get(c"PHImageRequestOptions")
        .ok_or_else(|| PhotosError::unavailable("the Photos framework cannot be loaded"))?;
    // SAFETY: Photos' documented API.
    unsafe {
        let options: Retained<AnyObject> = msg_send![class, new];
        let _: () = msg_send![&options, setVersion: VERSION_CURRENT];
        let _: () = msg_send![&options, setDeliveryMode: HIGH_QUALITY];
        let _: () = msg_send![&options, setNetworkAccessAllowed: Bool::YES];
        Ok(options)
    }
}

fn image_manager() -> Result<Retained<AnyObject>, PhotosError> {
    let class = AnyClass::get(c"PHImageManager")
        .ok_or_else(|| PhotosError::unavailable("the Photos framework cannot be loaded"))?;
    // SAFETY: Photos' documented class method.
    Ok(unsafe { msg_send![class, defaultManager] })
}

/// Cancels its image request when dropped before the request answered: the
/// future reading it went away.
struct Pending(i32);

impl Pending {
    fn answered(mut self) {
        self.0 = INVALID_REQUEST;
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if self.0 == INVALID_REQUEST {
            return;
        }
        if let Ok(manager) = image_manager() {
            // SAFETY: Photos' documented API, callable from any thread.
            unsafe {
                let _: () = msg_send![&manager, cancelImageRequest: self.0];
            }
        }
    }
}

/// Why a request answered without an image: its `info`'s error, or that
/// it was cancelled.
fn failure(info: Option<&NSDictionary<NSString, AnyObject>>) -> PhotosError {
    let error = info
        .and_then(|info| info.objectForKey(&NSString::from_str("PHImageErrorKey")))
        .and_then(|error| error.downcast::<NSError>().ok());
    match error {
        Some(error) => PhotosError::failed(format!(
            "the photo cannot be read: {}",
            error.localizedDescription()
        )),
        None => PhotosError::failed("the photo's read was cancelled"),
    }
}

/// Whether `info` says its image is a degraded one, a better one following.
fn degraded(info: Option<&NSDictionary<NSString, AnyObject>>) -> bool {
    info.and_then(|info| info.objectForKey(&NSString::from_str("PHImageResultIsDegradedKey")))
        .and_then(|value| value.downcast::<NSNumber>().ok())
        .is_some_and(|value| value.boolValue())
}

pub(super) async fn thumbnail(
    id: String,
    request: PhotoRequest,
) -> Result<PickedFile, PhotosError> {
    let side = request.max_dimension.map_or(256, |max| max.0.max(1)) as f64;
    let (answer, answered) = oneshot::channel::<Result<SentImage, PhotosError>>();
    let pending = {
        let asset = find(&id)?;
        let options = request_options()?;
        // SAFETY: Photos' documented API.
        unsafe {
            let _: () = msg_send![&options, setResizeMode: RESIZE_EXACT];
        }
        let answer = Mutex::new(Some(answer));
        let handler = RcBlock::new(
            move |image: *mut UIImage, info: *mut NSDictionary<NSString, AnyObject>| {
                // SAFETY: Photos passes a dictionary or nil, valid for the call.
                let info = unsafe { info.as_ref() };
                if degraded(info) {
                    return;
                }
                let Some(answer) = answer.lock().unwrap_or_else(|e| e.into_inner()).take() else {
                    return;
                };
                // SAFETY: Photos passes an image or nil.
                let image = unsafe { Retained::retain(image) };
                drop(answer.send(match image {
                    Some(image) => Ok(SentImage(image)),
                    None => Err(failure(info)),
                }));
            },
        );
        let manager = image_manager()?;
        // SAFETY: Photos' documented API; the handler runs once (no
        // degraded image is asked for), on the main queue or one of Photos'.
        let request: i32 = unsafe {
            msg_send![
                &manager,
                requestImageForAsset: &*asset,
                targetSize: CGSize::new(side, side),
                contentMode: ASPECT_FIT,
                options: &*options,
                resultHandler: &*handler
            ]
        };
        Pending(request)
    };
    let image = answered
        .await
        .map_err(|_| PhotosError::failed("the photo's read ended without an image"));
    pending.answered();
    let image = image??;
    blocking(move || prepare_thumbnail(image, request))
        .await
        .map_err(|error| PhotosError::failed(format!("cannot prepare the thumbnail: {error}")))?
}

/// The thumbnail `image` as a JPEG, drawn upright. Off the main thread.
fn prepare_thumbnail(image: SentImage, request: PhotoRequest) -> Result<PickedFile, PhotosError> {
    autoreleasepool(|_| {
        // Its pixels at the best quality, its orientation a tag; ImageIO
        // then draws it upright at the request's quality.
        let data = UIImage::jpeg_representation(&image.0, 1.0)
            .ok_or_else(|| PhotosError::failed("the thumbnail cannot be encoded"))?;
        nsh_platform_ios::prepare_image(data.to_vec(), "thumbnail.jpg", &request.pick_request())
            .ok_or_else(|| PhotosError::failed("the thumbnail cannot be encoded"))
    })
}

/// The bytes a photo was read as.
struct SentData(Retained<NSData>);

// SAFETY: an `NSData` is immutable.
unsafe impl Send for SentData {}

impl SentData {
    fn to_vec(&self) -> Vec<u8> {
        self.0.to_vec()
    }
}

pub(super) async fn load(id: String, request: PhotoRequest) -> Result<PickedFile, PhotosError> {
    let (answer, answered) = oneshot::channel::<Result<SentData, PhotosError>>();
    let (pending, name) = {
        let asset = find(&id)?;
        // SAFETY: `asset` is a `PHAsset`.
        let name = unsafe { file_name(&asset) };
        let options = request_options()?;
        let answer = Mutex::new(Some(answer));
        let handler = RcBlock::new(
            move |data: *mut NSData,
                  _uti: *mut NSString,
                  _orientation: u32,
                  info: *mut NSDictionary<NSString, AnyObject>| {
                let Some(answer) = answer.lock().unwrap_or_else(|e| e.into_inner()).take() else {
                    return;
                };
                // SAFETY: Photos passes data and a dictionary or nil, valid
                // for the call.
                let (data, info) = unsafe { (Retained::retain(data), info.as_ref()) };
                drop(answer.send(match data {
                    Some(data) => Ok(SentData(data)),
                    None => Err(failure(info)),
                }));
            },
        );
        let manager = image_manager()?;
        // SAFETY: Photos' documented API (iOS 13); the handler runs once.
        // The data carries its orientation, which preparing applies.
        let request: i32 = unsafe {
            msg_send![
                &manager,
                requestImageDataAndOrientationForAsset: &*asset,
                options: &*options,
                resultHandler: &*handler
            ]
        };
        (Pending(request), name)
    };
    let data = answered
        .await
        .map_err(|_| PhotosError::failed("the photo's read ended without its data"));
    pending.answered();
    let data = data??;
    blocking(move || {
        autoreleasepool(|_| {
            nsh_platform_ios::prepare_image(data.to_vec(), &name, &request.pick_request())
                .ok_or_else(|| PhotosError::failed("the photo cannot be decoded"))
        })
    })
    .await
    .map_err(|error| PhotosError::failed(format!("cannot prepare the photo: {error}")))?
}

pub(super) async fn present_limited_picker() -> Result<Vec<String>, PhotosError> {
    let (answer, answered) = oneshot::channel::<Result<Vec<String>, PhotosError>>();
    let shown = run_on_main_thread(move || {
        let fail = |answer: oneshot::Sender<_>, error| drop(answer.send(Err(error)));
        let mtm = MainThreadMarker::new().expect("the sheet shows from the main thread");
        let Some(top) = nsh_platform_ios::presenting_controller(mtm) else {
            return fail(
                answer,
                PhotosError::failed("there is no window to show the selection over"),
            );
        };
        let Some(library_class) = AnyClass::get(c"PHPhotoLibrary") else {
            return fail(
                answer,
                PhotosError::unavailable("the Photos framework cannot be loaded"),
            );
        };
        let answer = Mutex::new(Some(answer));
        let handler = RcBlock::new(move |ids: *mut NSArray<NSString>| {
            let Some(answer) = answer.lock().unwrap_or_else(|e| e.into_inner()).take() else {
                return;
            };
            // SAFETY: Photos passes an array of identifiers or nil, valid
            // for the call.
            let ids = unsafe { ids.as_ref() }
                .map(|ids| ids.iter().map(|id| id.to_string()).collect())
                .unwrap_or_default();
            drop(answer.send(Ok(ids)));
        });
        // SAFETY: PhotosUI's documented API (iOS 15); the handler runs
        // once, when the sheet closes.
        unsafe {
            let library: Retained<AnyObject> = msg_send![library_class, sharedPhotoLibrary];
            let _: () = msg_send![
                &library,
                presentLimitedLibraryPickerFromViewController: &*top,
                completionHandler: &*handler
            ];
        }
    })
    .await;
    if let Err(error) = shown {
        return Err(PhotosError::failed(format!(
            "the selection cannot be shown: {error}"
        )));
    }
    answered.await.unwrap_or_else(|_| {
        Err(PhotosError::failed(
            "the selection closed without an answer",
        ))
    })
}

define_class!(
    /// Hears the photo library's changes and reports them.
    #[unsafe(super(NSObject))]
    pub(crate) struct LibraryObserver;

    unsafe impl NSObjectProtocol for LibraryObserver {}

    impl LibraryObserver {
        /// `PHPhotoLibraryChangeObserver`'s one method, called on a queue
        /// of Photos'.
        #[unsafe(method(photoLibraryDidChange:))]
        fn did_change(&self, _change: &AnyObject) {
            super::notify_change();
        }
    }
);

static OBSERVE: Once = Once::new();

pub(super) fn observe() {
    OBSERVE.call_once(|| {
        let Some(library_class) = AnyClass::get(c"PHPhotoLibrary") else {
            return;
        };
        let class = LibraryObserver::class();
        // The library takes observers of its protocol: the class declares
        // it at run time, as the protocol is Photos'.
        if let Some(protocol) = AnyProtocol::get(c"PHPhotoLibraryChangeObserver") {
            // SAFETY: the class is NSH's own, and the protocol's one
            // required method is defined above.
            unsafe {
                objc2::ffi::class_addProtocol(
                    std::ptr::from_ref(class).cast_mut(),
                    std::ptr::from_ref(protocol),
                );
            }
        }
        // SAFETY: `NSObject`'s `new`; the class has no fields of its own.
        let observer: Retained<LibraryObserver> = unsafe { msg_send![class, new] };
        // SAFETY: Photos' documented API. The observer is kept for the
        // process's life: the library does not keep it.
        unsafe {
            let library: Retained<AnyObject> = msg_send![library_class, sharedPhotoLibrary];
            let _: () = msg_send![&library, registerChangeObserver: &*observer];
        }
        std::mem::forget(observer);
        // Photos reports only the changes to what the app holds a fetch
        // of, and `recent`'s go when it returns: the library's images are
        // held for the process's life. The fetch must have run (its count
        // read; its objects still load only when asked): one never read
        // hears nothing.
        if let Some(asset_class) = AnyClass::get(c"PHAsset") {
            // SAFETY: Photos' documented API.
            let images: Retained<AnyObject> = unsafe {
                msg_send![
                    asset_class,
                    fetchAssetsWithMediaType: MEDIA_IMAGE,
                    options: Option::<&AnyObject>::None
                ]
            };
            // SAFETY: `PHFetchResult`'s documented property.
            let _: usize = unsafe { msg_send![&images, count] };
            std::mem::forget(images);
        }
    });
}

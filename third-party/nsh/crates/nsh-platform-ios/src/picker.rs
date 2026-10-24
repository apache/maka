//! `Picker.pickImages`: the system's photo picker, `PHPickerViewController`
//! (no photo library permission: the picker runs out of process and hands
//! over only what the user picks). PhotosUI is loaded on first use
//! (`dlopen`), as WebKit is. Each picked item's file is read on the item
//! provider's queue (its file is deleted when the completion returns),
//! prepared as the request says ([`nsh_core::picker`]: ImageIO scales and
//! encodes, its orientation applied) and the files go to the engine in one
//! root `Pick` event, in the order picked.

use std::{
    cell::RefCell,
    ffi::CStr,
    sync::{Arc, Mutex, OnceLock},
};

use block2::RcBlock;
use nsh_core::{
    EventKind, EventPayload, ImageData,
    geometry::{DevicePixels, Size},
    picker::{Encoding, PickFormat, PickRequest, PickedFile},
};
use nsh_engine::EngineControl;
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Allocated, Retained},
    runtime::{AnyClass, AnyObject},
};
use objc2_core_foundation::{
    CFData, CFDictionary, CFMutableData, CFNumber, CFString, CFType, CGFloat, kCFBooleanTrue,
};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_ui_kit::{UIView, UIViewController};

fn photos_ui() -> bool {
    static LOADED: OnceLock<bool> = OnceLock::new();
    *LOADED.get_or_init(|| {
        let path = c"/System/Library/Frameworks/PhotosUI.framework/PhotosUI";
        // SAFETY: loads a system framework; the handle is never closed.
        let handle = unsafe { libc::dlopen(path.as_ptr(), libc::RTLD_LAZY) };
        if handle.is_null() {
            log::error!("cannot load PhotosUI");
        }
        !handle.is_null()
    })
}

fn class(name: &CStr) -> Option<&'static AnyClass> {
    AnyClass::get(name)
}

thread_local! {
    /// The delegates of the pickers shown (a picker holds its delegate
    /// weakly).
    static SHOWN: RefCell<Vec<Retained<PickerDelegate>>> = const { RefCell::new(Vec::new()) };
}

pub(crate) struct DelegateIvars {
    id: u32,
    request: PickRequest,
    control: EngineControl,
}

define_class!(
    /// The delegate of one picker: reads what the user picked.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    pub(crate) struct PickerDelegate;

    unsafe impl NSObjectProtocol for PickerDelegate {}

    impl PickerDelegate {
        #[unsafe(method(picker:didFinishPicking:))]
        fn did_finish(&self, picker: &UIViewController, results: &NSArray<AnyObject>) {
            // The picker stays until it is dismissed.
            picker.dismissViewControllerAnimated_completion(true, None);
            let DelegateIvars { id, request, control } = self.ivars();
            read_results(*id, *request, control.clone(), results);
            let this: *const Self = self;
            SHOWN.with_borrow_mut(|shown| shown.retain(|d| !std::ptr::eq(&**d, this)));
        }

        /// A sheet swiped down (iOS 13+'s card presentation): no files.
        #[unsafe(method(presentationControllerDidDismiss:))]
        fn did_dismiss(&self, _controller: &AnyObject) {
            let DelegateIvars { id, control, .. } = self.ivars();
            answer(control, *id, Vec::new());
            let this: *const Self = self;
            SHOWN.with_borrow_mut(|shown| shown.retain(|d| !std::ptr::eq(&**d, this)));
        }
    }
);

fn answer(control: &EngineControl, id: u32, files: Vec<PickedFile>) {
    control.dispatch_event(
        nsh_core::ROOT_ID,
        EventKind::Pick,
        EventPayload::Picked { id, files },
    );
}

/// Shows the picker over `view`'s window for pick `id`; a picker that
/// cannot be shown answers with no files.
pub(crate) fn pick_images(id: u32, request: PickRequest, view: &UIView, control: &EngineControl) {
    let mtm = MainThreadMarker::from(view);
    let (Some(config_class), Some(filter_class), Some(picker_class), Some(top)) = (
        photos_ui()
            .then(|| class(c"PHPickerConfiguration"))
            .flatten(),
        class(c"PHPickerFilter"),
        class(c"PHPickerViewController"),
        crate::system::top_controller(view),
    ) else {
        log::warn!("the photo picker cannot be shown");
        answer(control, id, Vec::new());
        return;
    };
    // SAFETY: PhotosUI's documented API, sent dynamically.
    unsafe {
        let config: Retained<AnyObject> = msg_send![config_class, new];
        let limit = if request.multiple() { request.limit } else { 1 };
        let _: () = msg_send![&config, setSelectionLimit: limit as isize];
        let filter: Retained<AnyObject> = msg_send![filter_class, imagesFilter];
        let _: () = msg_send![&config, setFilter: &*filter];
        // PHPickerConfigurationAssetRepresentationMode: current 1,
        // compatible 2 (the system turns HEIC into JPEG).
        let mode: isize = match request.format {
            PickFormat::Current => 1,
            _ => 2,
        };
        let _: () = msg_send![&config, setPreferredAssetRepresentationMode: mode];
        if request.multiple() {
            // PHPickerConfigurationSelection.ordered (iOS 15): numbered, in
            // the order the user picks.
            let ordered: bool = msg_send![&config, respondsToSelector: objc2::sel!(setSelection:)];
            if ordered {
                let _: () = msg_send![&config, setSelection: 1isize];
            }
        }
        let alloc: Allocated<AnyObject> = msg_send![picker_class, alloc];
        let picker: Option<Retained<AnyObject>> = msg_send![alloc, initWithConfiguration: &*config];
        let Some(picker) = picker else {
            answer(control, id, Vec::new());
            return;
        };
        let picker: Retained<UIViewController> = Retained::cast_unchecked(picker);
        let delegate = PickerDelegate::alloc(mtm).set_ivars(DelegateIvars {
            id,
            request,
            control: control.clone(),
        });
        let delegate: Retained<PickerDelegate> = msg_send![super(delegate), init];
        let _: () = msg_send![&picker, setDelegate: &*delegate];
        picker.setOverrideUserInterfaceStyle(crate::system::appearance());
        if let Some(sheet) = picker.presentationController() {
            let _: () = msg_send![&sheet, setDelegate: &*delegate];
        }
        SHOWN.with_borrow_mut(|shown| shown.push(delegate));
        top.presentViewController_animated_completion(&picker, true, None);
    }
}

/// The files of what was picked so far, by position.
struct Reading {
    files: Vec<Option<PickedFile>>,
    left: usize,
}

/// Reads the picked items' files, then answers pick `id` with them.
fn read_results(
    id: u32,
    request: PickRequest,
    control: EngineControl,
    results: &NSArray<AnyObject>,
) {
    let count = results.count();
    if count == 0 {
        answer(&control, id, Vec::new());
        return;
    }
    let reading = Arc::new(Mutex::new(Reading {
        files: vec![None; count],
        left: count,
    }));
    let image = NSString::from_str("public.image");
    for (index, result) in results.iter().enumerate() {
        // SAFETY: a PHPickerResult's documented API.
        let provider: Retained<AnyObject> = unsafe { msg_send![&result, itemProvider] };
        // SAFETY: as above (iOS 11+).
        let suggested: Option<Retained<NSString>> = unsafe { msg_send![&provider, suggestedName] };
        let name = suggested.map(|n| n.to_string()).unwrap_or_default();
        let reading = reading.clone();
        let control = control.clone();
        let done = move |file: Option<PickedFile>| {
            let mut state = reading.lock().unwrap_or_else(|e| e.into_inner());
            state.files[index] = file;
            state.left -= 1;
            if state.left == 0 {
                let files = state.files.drain(..).flatten().collect();
                answer(&control, id, files);
            }
        };
        let done = Mutex::new(Some(done));
        let handler = RcBlock::new(move |url: *mut NSURL, _error: *mut NSError| {
            // SAFETY: the URL of the file the provider wrote, valid until
            // this returns (null on failure).
            let url = unsafe { url.as_ref() };
            let file = url.and_then(|url| {
                let path = url.path()?.to_string();
                let bytes = std::fs::read(&path).ok()?;
                let file_name = if name.is_empty() {
                    path.rsplit('/').next().unwrap_or_default().to_owned()
                } else {
                    let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or_default();
                    format!("{name}.{ext}")
                };
                prepare(bytes, &file_name, &request)
            });
            if let Some(done) = done.lock().unwrap_or_else(|e| e.into_inner()).take() {
                done(file);
            }
        });
        // SAFETY: NSItemProvider's documented API; the handler runs once
        // on a queue of the provider's.
        let _: Option<Retained<AnyObject>> = unsafe {
            msg_send![&provider, loadFileRepresentationForTypeIdentifier: &*image, completionHandler: &*handler]
        };
    }
}

/// `bytes`, an image file named `name`, prepared as `request` says: kept,
/// or decoded with its orientation applied, scaled down and encoded again.
/// `None` when it is no image ImageIO reads.
pub(crate) fn prepare(bytes: Vec<u8>, name: &str, request: &PickRequest) -> Option<PickedFile> {
    use objc2_image_io::{
        CGImageDestination, CGImageSource, kCGImageDestinationLossyCompressionQuality,
        kCGImageSourceCreateThumbnailFromImageAlways, kCGImageSourceCreateThumbnailWithTransform,
        kCGImageSourceThumbnailMaxPixelSize,
    };
    let data = CFData::from_bytes(&bytes);
    // SAFETY: ImageIO's documented API, with option dictionaries of the
    // documented key and value types.
    unsafe {
        let source = CGImageSource::with_data(&data, None)?;
        let uti = source.r#type().map(|t| t.to_string()).unwrap_or_default();
        let mime = mime_for_uti(&uti)
            .or_else(|| nsh_core::picker::sniff(&bytes))
            .unwrap_or("application/octet-stream");
        let size = crate::image::source_size(&source);
        let size = Size::new(DevicePixels(size.0 as i32), DevicePixels(size.1 as i32));
        let encoding = request.needs_encoding(mime, size);
        if encoding == Encoding::Keep {
            let mut file = PickedFile::new(name, mime, ImageData::new(bytes));
            file.size = size;
            return Some(file);
        }
        let target = request.scaled_size(size);
        let longer = target.width.0.max(target.height.0).max(1);
        let yes: &CFType = kCFBooleanTrue?;
        let max = CFNumber::new_cgfloat(longer as CGFloat);
        let keys: [&CFString; 3] = [
            kCGImageSourceCreateThumbnailFromImageAlways,
            kCGImageSourceCreateThumbnailWithTransform,
            kCGImageSourceThumbnailMaxPixelSize,
        ];
        let values: [&CFType; 3] = [yes, yes, &max];
        let options = CFDictionary::from_slices(&keys, &values);
        let image = source.thumbnail_at_index(0, Some(options.as_opaque()))?;
        let (uti, mime) = match encoding {
            Encoding::Png => ("public.png", "image/png"),
            _ => ("public.jpeg", "image/jpeg"),
        };
        let out = CFMutableData::new(None, 0)?;
        let destination = CGImageDestination::with_data(&out, &CFString::from_str(uti), 1, None)?;
        let quality = CFNumber::new_cgfloat(request.jpeg_quality().0 as CGFloat);
        let keys: [&CFString; 1] = [kCGImageDestinationLossyCompressionQuality];
        let values: [&CFType; 1] = [&quality];
        let properties = CFDictionary::from_slices(&keys, &values);
        destination.add_image(&image, Some(properties.as_opaque()));
        if !destination.finalize() {
            return None;
        }
        let mut file = PickedFile::new(name, mime, ImageData::new(out.to_vec()));
        file.size = Size::new(
            DevicePixels(CGImage::width(Some(&image)) as i32),
            DevicePixels(CGImage::height(Some(&image)) as i32),
        );
        Some(file)
    }
}

/// The media type of an image's uniform type identifier.
fn mime_for_uti(uti: &str) -> Option<&'static str> {
    Some(match uti {
        "public.jpeg" => "image/jpeg",
        "public.png" => "image/png",
        "com.compuserve.gif" => "image/gif",
        "org.webmproject.webp" => "image/webp",
        "public.heic" => "image/heic",
        "public.heif" | "public.heics" => "image/heif",
        "public.avif" => "image/avif",
        "public.tiff" => "image/tiff",
        "com.microsoft.bmp" => "image/bmp",
        _ => return None,
    })
}

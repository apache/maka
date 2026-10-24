//! `Picker.pickImages`: an open panel filtered to images, as a sheet of the
//! surface's window. The picked files are read and prepared as the request
//! says ([`nsh_core::picker`]: ImageIO scales and encodes them, their
//! orientation applied, HEIC as JPEG) on a thread of their own, and go to
//! the engine in one root `Pick` event, in the order the panel lists them.

use std::rc::Rc;

use block2::RcBlock;
use nsh_core::{
    EventKind, EventPayload, ImageData, ROOT_ID,
    geometry::{DevicePixels, Size},
    picker::{Encoding, PickRequest, PickedFile},
};
use nsh_engine::EngineControl;
use objc2::{
    msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject},
};
use objc2_core_foundation::{
    CFData, CFDictionary, CFMutableData, CFNumber, CFString, CFType, CGFloat, kCFBooleanTrue,
};
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSArray, NSString, NSURL};

use crate::surface::Surface;

/// The extensions the panel offers.
const EXTENSIONS: [&str; 12] = [
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "avif", "tif", "tiff", "bmp", "jpe",
];

fn answer(control: &EngineControl, id: u32, files: Vec<PickedFile>) {
    control.dispatch_event(ROOT_ID, EventKind::Pick, EventPayload::Picked { id, files });
}

/// Shows the panel for pick `id`.
pub(crate) fn pick_images(surface: &Rc<Surface>, id: u32, request: PickRequest) {
    let mut control = None;
    surface.control(|c| control = Some(c.clone()));
    let Some(control) = control else { return };
    let Some(class) = AnyClass::get(c"NSOpenPanel") else {
        answer(&control, id, Vec::new());
        return;
    };
    // SAFETY: AppKit's documented NSOpenPanel API, on the main thread.
    unsafe {
        let panel: Retained<AnyObject> = msg_send![class, openPanel];
        let _: () = msg_send![&panel, setCanChooseFiles: true];
        let _: () = msg_send![&panel, setCanChooseDirectories: false];
        let _: () = msg_send![&panel, setAllowsMultipleSelection: request.multiple()];
        let types: Vec<Retained<NSString>> =
            EXTENSIONS.iter().map(|e| NSString::from_str(e)).collect();
        let types = NSArray::from_retained_slice(&types);
        // `allowedContentTypes` needs UniformTypeIdentifiers; the
        // extensions say the same.
        let _: () = msg_send![&panel, setAllowedFileTypes: &*types];
        let chosen = panel.clone();
        let handler = RcBlock::new(move |response: isize| {
            // NSModalResponseOK = 1.
            let urls: Vec<String> = if response == 1 {
                let urls: Retained<NSArray<NSURL>> = msg_send![&chosen, URLs];
                urls.iter()
                    .filter_map(|u| u.path().map(|p| p.to_string()))
                    .collect()
            } else {
                Vec::new()
            };
            let control = control.clone();
            std::thread::Builder::new()
                .name("nsh-picker".into())
                .spawn(move || {
                    let files = urls
                        .iter()
                        .take(request.limit as usize)
                        .filter_map(|path| {
                            let bytes = std::fs::read(path).ok()?;
                            let name = path.rsplit('/').next().unwrap_or_default();
                            let mut file = prepare(bytes, name, &request)?;
                            file.last_modified =
                                std::fs::metadata(path).and_then(|m| m.modified()).ok();
                            Some(file)
                        })
                        .collect();
                    answer(&control, id, files);
                })
                .ok();
        });
        match surface.root.ns().window() {
            Some(window) => {
                let _: () = msg_send![&panel, beginSheetModalForWindow: &*window, completionHandler: &*handler];
            }
            None => {
                let _: () = msg_send![&panel, beginWithCompletionHandler: &*handler];
            }
        }
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
        let (w, h) = crate::image::source_size(&source);
        let size = Size::new(DevicePixels(w as i32), DevicePixels(h as i32));
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

#[cfg(test)]
mod tests {
    use nsh_core::{
        geometry::{DevicePixels, Percentage},
        picker::{PickFormat, PickRequest},
    };

    /// A 4000×3000 HEIC and PNG made by `sips` from a generated TIFF.
    fn sample(ext: &str, format: &str) -> Option<Vec<u8>> {
        let dir = std::env::temp_dir().join(format!("nsh-picker-{}-{ext}", std::process::id()));
        std::fs::create_dir_all(&dir).ok()?;
        let png = dir.join("base.png");
        if !png.exists() {
            // A 1×1 PNG `sips` scales up.
            let pixel = [
                0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44,
                0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53, 0xde, 0, 0, 0, 12,
                0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01,
                0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
                0x60, 0x82,
            ];
            std::fs::write(&png, pixel).ok()?;
            let ok = std::process::Command::new("sips")
                .args(["-z", "3000", "4000"])
                .arg(&png)
                .output()
                .ok()?
                .status
                .success();
            if !ok {
                return None;
            }
        }
        let out = dir.join(format!("sample.{ext}"));
        let ok = std::process::Command::new("sips")
            .args(["-s", "format", format])
            .arg(&png)
            .arg("--out")
            .arg(&out)
            .output()
            .ok()?
            .status
            .success();
        ok.then(|| std::fs::read(out).ok()).flatten()
    }

    #[test]
    fn heic_becomes_a_scaled_jpeg() {
        let Some(heic) = sample("heic", "heic") else {
            eprintln!("no sips HEIC encoder: skipped");
            return;
        };
        let mut request = PickRequest::new(false, 1);
        request.max_dimension = Some(DevicePixels(1000));
        let file = super::prepare(heic.clone(), "IMG_1.HEIC", &request).expect("prepared");
        assert_eq!(file.mime, "image/jpeg");
        assert_eq!(file.name, "IMG_1.jpg");
        assert_eq!((file.size.width.0, file.size.height.0), (1000, 750));
        assert_eq!(&file.data[..3], &[0xff, 0xd8, 0xff]);
        // Its own format, at its size: as it is.
        request.max_dimension = None;
        request.format = PickFormat::Current;
        let kept = super::prepare(heic.clone(), "IMG_1.HEIC", &request).expect("kept");
        assert_eq!(kept.mime, "image/heic");
        assert_eq!(kept.data.len(), heic.len());
        // Compatible without scaling: a JPEG of its size.
        request.format = PickFormat::Compatible;
        request.quality = Some(Percentage(0.5));
        let jpeg = super::prepare(heic, "IMG_1.HEIC", &request).expect("jpeg");
        assert_eq!((jpeg.size.width.0, jpeg.size.height.0), (4000, 3000));
        assert_eq!(jpeg.mime, "image/jpeg");
    }

    #[test]
    fn a_large_png_stays_a_png() {
        let Some(png) = sample("png", "png") else {
            return;
        };
        let mut request = PickRequest::new(true, 3);
        let kept = super::prepare(png.clone(), "shot.png", &request).expect("kept");
        assert_eq!(kept.data.len(), png.len());
        request.max_dimension = Some(DevicePixels(400));
        let file = super::prepare(png, "shot.png", &request).expect("prepared");
        assert_eq!(file.mime, "image/png");
        assert_eq!((file.size.width.0, file.size.height.0), (400, 300));
    }
}

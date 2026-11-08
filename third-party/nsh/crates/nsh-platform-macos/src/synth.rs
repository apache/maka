//! Development adapters for production native input and capture.
use objc2_app_kit::NSWindow;

pub(crate) use crate::native_events::*;

/// Encodes the production native capture for development screenshots.
pub(crate) fn shot(window: &NSWindow) -> Result<Vec<u8>, String> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey};
    use objc2_foundation::NSDictionary;
    let rep = crate::capture::bitmap(window, None)?;
    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, objc2::runtime::AnyObject>::new();
    // SAFETY: an empty property dictionary is valid for PNG.
    let data =
        unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) };
    Ok(data.ok_or("cannot encode the picture")?.to_vec())
}

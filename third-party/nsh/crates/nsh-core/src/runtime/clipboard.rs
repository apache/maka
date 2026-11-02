//! `nsh/clipboard`: the system clipboard's text, image and files
//! (UIPasteboard, ClipboardManager, NSPasteboard, `navigator.clipboard`,
//! ...). Needs the `clipboard` capability when the app declares
//! capabilities: without it every function rejects with
//! `ERR_ACCESS_DENIED` (checked here, in the call; the core also refuses
//! the commands, for Rust components' calls, which then get nothing).
//! Images are checked here too: where the platform has no images on the
//! clipboard (Android, whose backend reads and writes text only)
//! `writeImage` and `readImage` reject with
//! `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` and `hasImage` answers `false`
//! without asking the platform; an image over
//! [`crate::platform::clipboard::MAX_IMAGE_BYTES`] rejects `readImage`
//! with `ERR_NSH_QUOTA_EXCEEDED`.

use crate::{
    element::{ClipboardImage, JsError, System, codes, module},
    platform::{Os, clipboard::MAX_IMAGE_BYTES},
};

/// Whether the app may use the clipboard: why not when it may not.
fn granted(sys: &System) -> Result<(), JsError> {
    if sys.access.allows_clipboard() {
        return Ok(());
    }
    Err(JsError::access_denied(
        "the clipboard is not granted: add `\"clipboard\": true` to capabilities in nsh.json",
        "clipboard",
        "",
    ))
}

/// Whether the platform puts images on the clipboard and reads them back:
/// every backend but Android's.
fn has_images(sys: &System) -> bool {
    sys.os != Os::Android
}

/// Why `call` cannot run where the platform has no clipboard images.
fn images_available(sys: &System, call: &str) -> Result<(), JsError> {
    if has_images(sys) {
        return Ok(());
    }
    Err(JsError::Error(format!(
        "Clipboard.{call}: the clipboard holds text only on {}",
        sys.os.name()
    ))
    .with_code(codes::UNAVAILABLE))
}

/// The rejection of an image over [`MAX_IMAGE_BYTES`] (`bytes` encoded).
fn too_large(bytes: usize) -> JsError {
    JsError::Error(format!(
        "Clipboard.readImage: the clipboard's image is {} bytes ({} MB), over the {} MB an app reads",
        bytes,
        bytes.div_ceil(1 << 20),
        MAX_IMAGE_BYTES >> 20
    ))
    .with_code(codes::QUOTA_EXCEEDED)
}

/// The system clipboard's text, image and files.
#[module]
pub(crate) struct Clipboard;

#[module]
impl Clipboard {
    /// Puts `text` on the clipboard, replacing what it holds.
    pub(crate) async fn write_text(text: String, sys: System) -> Result<(), JsError> {
        granted(&sys)?;
        crate::prelude::set_clipboard(text);
        Ok(())
    }

    /// The clipboard's text, `""` when it holds none. On iOS, reading it
    /// may show the system's paste notice.
    pub(crate) async fn read_text(sys: System) -> Result<String, JsError> {
        granted(&sys)?;
        Ok(crate::prelude::clipboard_string().await)
    }

    /// Whether the clipboard holds text, without reading it (no paste
    /// notice).
    pub(crate) async fn has_text(sys: System) -> Result<bool, JsError> {
        granted(&sys)?;
        Ok(crate::prelude::clipboard_has_string().await)
    }

    /// Puts the image of `src`, a base64 `data:` URL or the `url`
    /// `readImage` gave, on the clipboard, replacing what it holds. Rejects
    /// with `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the clipboard holds
    /// text only (Android).
    pub(crate) async fn write_image(src: String, sys: System) -> Result<(), JsError> {
        granted(&sys)?;
        images_available(&sys, "writeImage")?;
        crate::prelude::set_clipboard_image(src);
        Ok(())
    }

    /// The clipboard's image, `null` when it holds none: `url` is a URL
    /// that an `Image` shows and `fetch` reads, `size` the image's size in
    /// pixels. Rejects with `ERR_NSH_QUOTA_EXCEEDED` for an image over
    /// 48 MB encoded, more than the app's memory may hold, and with
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` where the clipboard holds text
    /// only (Android). On iOS, reading it may show the system's paste
    /// notice.
    pub(crate) async fn read_image(sys: System) -> Result<Option<ClipboardImage>, JsError> {
        granted(&sys)?;
        images_available(&sys, "readImage")?;
        crate::element::clipboard_checked_image()
            .await
            .map_err(too_large)
    }

    /// Whether the clipboard holds an image, without reading it (no paste
    /// notice); `false` where the clipboard holds text only (Android).
    pub(crate) async fn has_image(sys: System) -> Result<bool, JsError> {
        granted(&sys)?;
        if !has_images(&sys) {
            return Ok(false);
        }
        Ok(crate::prelude::clipboard_has_image().await)
    }

    /// The `file:` URLs of the local files on the clipboard (files copied in
    /// a file manager), `[]` when it holds none.
    pub(crate) async fn read_files(sys: System) -> Result<Vec<String>, JsError> {
        granted(&sys)?;
        Ok(crate::prelude::clipboard_files().await)
    }
}

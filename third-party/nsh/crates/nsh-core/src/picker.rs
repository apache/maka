//! The system's media picker (`nsh/picker`'s `Picker.pickImages`): the
//! user picks photos, which reach the app as `File`s whose bytes stay
//! native.
//!
//! A pick is a [`Command::PickImages`](crate::Command::PickImages) on the
//! root with a [`PickRequest`]; the platform shows its picker (iOS
//! `PHPickerViewController`, Android's Photo Picker, an open panel on the
//! desktops, `<input type=file>` on the web), prepares the picked images as
//! the request says ([`PickRequest::needs_encoding`]: HEIC and other formats
//! browsers do not show become JPEG, images larger than
//! [`PickRequest::max_dimension`] are scaled down) and answers with the
//! root's [`EventKind::Pick`](crate::EventKind::Pick), whose
//! [`EventPayload::Picked`](crate::EventPayload::Picked) carries the files'
//! bytes ([`PickedFile`]). A cancelled picker answers with no files.
//!
//! An embedding app can show a picker of its own instead: a
//! [`PickerBackend`] given to the core
//! ([`Core::set_picker`](crate::Core::set_picker), `EngineConfig::picker`)
//! answers every pick, and the platform's picker is never shown. Tests
//! answer picks the same way.

use std::{future::Future, pin::Pin, time::SystemTime};

use crate::{
    ImageData,
    geometry::{DevicePixels, Percentage, Size},
};

/// At most this many files answer one pick, whatever the request or the
/// platform says.
pub const MAX_PICKED: u32 = 100;

/// The JPEG quality NSH encodes with when the app gives none.
pub const DEFAULT_QUALITY: Percentage = Percentage(0.9);

/// What the app asked a pick for, checked: what the platform's picker
/// shows and what it does with the picked images.
#[derive(Debug, Clone, Copy, PartialEq)]
#[non_exhaustive]
pub struct PickRequest {
    /// At most this many images (1 for a single pick), never more than
    /// [`MAX_PICKED`].
    pub limit: u32,
    /// Images whose longer side is longer than this are scaled down to it
    /// (and encoded again); `None` keeps their size.
    pub max_dimension: Option<DevicePixels>,
    /// The quality of the JPEGs NSH encodes, from 0 (smallest) to 1 (best);
    /// `None`: [`DEFAULT_QUALITY`], and JPEGs that need no other change
    /// stay as they are.
    pub quality: Option<Percentage>,
    /// Which formats the images come in.
    pub format: PickFormat,
}

impl Default for PickRequest {
    fn default() -> Self {
        Self {
            limit: 1,
            max_dimension: None,
            quality: None,
            format: PickFormat::Compatible,
        }
    }
}

/// Which formats picked images come in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PickFormat {
    /// Formats every browser and server takes: JPEG, PNG, GIF and WebP
    /// stay as they are, anything else (HEIC, HEIF, TIFF, RAW) becomes a
    /// JPEG.
    #[default]
    Compatible,
    /// The format the image is stored in (HEIC stays HEIC), unless it has
    /// to be encoded again (scaled down, or a quality given).
    Current,
}

/// What a platform does with one picked image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    /// Its bytes as they are.
    Keep,
    /// Decoded (with its orientation applied), scaled to fit
    /// [`PickRequest::max_dimension`] and encoded as a PNG: an image that
    /// was a PNG.
    Png,
    /// Decoded (with its orientation applied), scaled to fit
    /// [`PickRequest::max_dimension`] and encoded as a JPEG of the
    /// request's quality.
    Jpeg,
}

impl PickRequest {
    /// A request for one image (`multiple: false`) or up to `limit` of them
    /// (0: as many as [`MAX_PICKED`]).
    pub fn new(multiple: bool, limit: u32) -> Self {
        let limit = match (multiple, limit) {
            (false, _) => 1,
            (true, 0) => MAX_PICKED,
            (true, n) => n.min(MAX_PICKED),
        };
        Self {
            limit,
            ..Self::default()
        }
    }

    /// Whether the user may pick several.
    pub fn multiple(&self) -> bool {
        self.limit > 1
    }

    /// The quality NSH encodes JPEGs with.
    pub fn jpeg_quality(&self) -> Percentage {
        Percentage(self.quality.unwrap_or(DEFAULT_QUALITY).0.clamp(0.0, 1.0))
    }

    /// What to do with an image of type `mime` whose pixels are `size`
    /// (with its orientation applied): keep it, or decode and encode it
    /// again.
    pub fn needs_encoding(&self, mime: &str, size: Size<DevicePixels>) -> Encoding {
        let mime = mime.to_ascii_lowercase();
        let png = mime == "image/png";
        let longer = size.width.0.max(size.height.0);
        let scale = self.max_dimension.is_some_and(|max| longer > max.0.max(1));
        let foreign = !matches!(
            mime.as_str(),
            "image/jpeg" | "image/png" | "image/gif" | "image/webp"
        );
        let convert = self.format == PickFormat::Compatible && foreign;
        let requality = self.quality.is_some() && mime == "image/jpeg";
        match () {
            _ if png && scale => Encoding::Png,
            _ if scale || convert || requality => Encoding::Jpeg,
            _ => Encoding::Keep,
        }
    }

    /// The size an image of `size` pixels is scaled to: fitting
    /// [`Self::max_dimension`], its aspect ratio kept.
    pub fn scaled_size(&self, size: Size<DevicePixels>) -> Size<DevicePixels> {
        let Some(max) = self.max_dimension else {
            return size;
        };
        let (w, h) = (size.width.0.max(1), size.height.0.max(1));
        let longer = w.max(h);
        let max = max.0.max(1);
        if longer <= max {
            return size;
        }
        let fit = |side: i32| ((side as f64 * max as f64 / longer as f64).round() as i32).max(1);
        Size::new(DevicePixels(fit(w)), DevicePixels(fit(h)))
    }
}

/// A file the user picked: what the app gets as a `File`.
#[derive(Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct PickedFile {
    /// Its name, with an extension that matches [`Self::mime`]
    /// (`IMG_0042.jpg`).
    pub name: String,
    /// Its media type (`image/jpeg`).
    pub mime: String,
    /// Its bytes, shared with the `File` and with an `Image` showing it.
    pub data: ImageData,
    /// Its size in pixels, with its orientation applied (as it shows);
    /// zero when the platform does not say, then read from the bytes.
    pub size: Size<DevicePixels>,
    /// When it was last changed (`File.lastModified`); `None`: when the
    /// app gets it.
    pub last_modified: Option<SystemTime>,
}

impl std::fmt::Debug for PickedFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PickedFile")
            .field("name", &self.name)
            .field("mime", &self.mime)
            .field("bytes", &self.data.len())
            .field("size", &self.size)
            .finish()
    }
}

impl PickedFile {
    /// The file `name` of type `mime` holding `data` (its size read from
    /// the bytes).
    pub fn new(name: impl Into<String>, mime: impl Into<String>, data: ImageData) -> Self {
        let mut file = Self {
            name: name.into(),
            mime: mime.into(),
            data,
            ..Self::default()
        };
        file.fill_in();
        file
    }

    /// Completes what the platform left out: the size from the bytes, the
    /// type from them or the name, and an extension matching the type.
    pub fn fill_in(&mut self) {
        if self.mime.is_empty() {
            self.mime = sniff(&self.data)
                .or_else(|| mime_for_name(&self.name))
                .unwrap_or("application/octet-stream")
                .into();
        }
        if self.size.width.0 <= 0 || self.size.height.0 <= 0 {
            self.size = image_size(&self.data).unwrap_or_default();
        }
        self.name = file_name(&self.name, &self.mime);
    }
}

/// The size in pixels the header of an image's bytes says (before any
/// orientation), `None` when they are no image it knows.
pub fn image_size(bytes: &[u8]) -> Option<Size<DevicePixels>> {
    let size = imagesize::blob_size(bytes).ok()?;
    Some(Size::new(
        DevicePixels(size.width as i32),
        DevicePixels(size.height as i32),
    ))
}

/// The media type an image's bytes start with, if they are a format it
/// knows.
pub fn sniff(bytes: &[u8]) -> Option<&'static str> {
    use imagesize::ImageType;
    Some(match imagesize::image_type(bytes).ok()? {
        ImageType::Jpeg => "image/jpeg",
        ImageType::Png => "image/png",
        ImageType::Gif => "image/gif",
        ImageType::Webp => "image/webp",
        ImageType::Heif(imagesize::Compression::Av1) => "image/avif",
        ImageType::Heif(_) => "image/heic",
        ImageType::Tiff => "image/tiff",
        ImageType::Bmp => "image/bmp",
        _ => return None,
    })
}

/// The media type a file's name says (its extension), if it is an image's.
pub fn mime_for_name(name: &str) -> Option<&'static str> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "jpg" | "jpeg" | "jpe" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "tif" | "tiff" => "image/tiff",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

/// The extension a file of type `mime` has (`jpg`), if it is an image's.
pub fn extension(mime: &str) -> Option<&'static str> {
    Some(match mime.to_ascii_lowercase().as_str() {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/heic" => "heic",
        "image/heif" => "heif",
        "image/avif" => "avif",
        "image/tiff" => "tiff",
        "image/bmp" => "bmp",
        _ => return None,
    })
}

/// `name` with the extension of `mime` (`IMG_0042.HEIC` as a JPEG is
/// `IMG_0042.jpg`); a name without a stem becomes `image`.
pub fn file_name(name: &str, mime: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let Some(ext) = extension(mime) else {
        return if name.is_empty() {
            "file".into()
        } else {
            name.into()
        };
    };
    let stem = match name.rsplit_once('.') {
        Some((stem, old)) if mime_for_name(name).is_some() || old.len() <= 4 => stem,
        _ => name,
    };
    let stem = if stem.is_empty() { "image" } else { stem };
    if mime_for_name(name) == Some(mime) {
        return name.into();
    }
    format!("{stem}.{ext}")
}

/// The files a pick resolves with, as the core hands them to the app.
pub type PickFuture = Pin<Box<dyn Future<Output = Vec<PickedFile>> + Send>>;

/// Answers the app's picks in place of the platform's picker: an embedding
/// app's own picker, or a test's files.
pub trait PickerBackend: Send + Sync {
    /// The files the user picked for `request` (none when cancelled). The
    /// future may finish on any thread; the core truncates what goes past
    /// the request's limit and fills in sizes and types the files lack
    /// ([`PickedFile::fill_in`]).
    fn pick_images(&self, request: PickRequest) -> PickFuture;
}

/// Puts `files` in the form the app gets: at most `request.limit`, each
/// completed ([`PickedFile::fill_in`]).
pub fn finish(request: &PickRequest, mut files: Vec<PickedFile>) -> Vec<PickedFile> {
    files.truncate(request.limit.max(1) as usize);
    for file in &mut files {
        file.fill_in();
    }
    files
}

/// The extensions a desktop open dialog offers for `request` whose
/// backend reads files as they are ([`read_files`]): with
/// [`PickFormat::Compatible`], only the formats browsers show.
pub fn dialog_extensions(request: &PickRequest) -> &'static [&'static str] {
    match request.format {
        PickFormat::Compatible => &["jpg", "jpeg", "jpe", "png", "gif", "webp"],
        PickFormat::Current => &[
            "jpg", "jpeg", "jpe", "png", "gif", "webp", "heic", "heif", "avif", "tif", "tiff",
            "bmp",
        ],
    }
}

/// The files at `paths`, read as they are (the backends without an image
/// encoder: Windows, Linux, GPUI), at most the request's limit; those that
/// cannot be read are left out.
#[cfg(not(target_arch = "wasm32"))]
pub fn read_files(paths: &[std::path::PathBuf], request: &PickRequest) -> Vec<PickedFile> {
    paths
        .iter()
        .take(request.limit.max(1) as usize)
        .filter_map(|path| {
            let bytes = std::fs::read(path).ok()?;
            let name = path.file_name()?.to_string_lossy().into_owned();
            let mime = sniff(&bytes)
                .or_else(|| mime_for_name(&name))
                .unwrap_or_default();
            let mut file = PickedFile::new(name, mime, ImageData::new(bytes));
            file.last_modified = std::fs::metadata(path).and_then(|m| m.modified()).ok();
            Some(file)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn px(w: i32, h: i32) -> Size<DevicePixels> {
        Size::new(DevicePixels(w), DevicePixels(h))
    }

    #[test]
    fn limits() {
        assert_eq!(PickRequest::new(false, 5).limit, 1);
        assert_eq!(PickRequest::new(true, 0).limit, MAX_PICKED);
        assert_eq!(PickRequest::new(true, 3).limit, 3);
        assert_eq!(PickRequest::new(true, 1000).limit, MAX_PICKED);
        assert!(!PickRequest::new(true, 1).multiple());
    }

    #[test]
    fn encodings() {
        let mut r = PickRequest::default();
        assert_eq!(
            r.needs_encoding("image/jpeg", px(4000, 3000)),
            Encoding::Keep
        );
        assert_eq!(r.needs_encoding("image/heic", px(400, 300)), Encoding::Jpeg);
        assert_eq!(r.needs_encoding("image/gif", px(400, 300)), Encoding::Keep);
        r.format = PickFormat::Current;
        assert_eq!(r.needs_encoding("image/heic", px(400, 300)), Encoding::Keep);
        r.max_dimension = Some(DevicePixels(1000));
        assert_eq!(
            r.needs_encoding("image/heic", px(4000, 3000)),
            Encoding::Jpeg
        );
        assert_eq!(r.needs_encoding("image/png", px(4000, 3000)), Encoding::Png);
        assert_eq!(r.needs_encoding("image/png", px(400, 300)), Encoding::Keep);
        r.quality = Some(Percentage(0.5));
        assert_eq!(r.needs_encoding("image/jpeg", px(400, 300)), Encoding::Jpeg);
        assert_eq!(r.scaled_size(px(4000, 3000)), px(1000, 750));
        assert_eq!(r.scaled_size(px(300, 4000)), px(75, 1000));
        assert_eq!(r.scaled_size(px(400, 300)), px(400, 300));
    }

    #[test]
    fn names() {
        assert_eq!(file_name("IMG_0042.HEIC", "image/jpeg"), "IMG_0042.jpg");
        assert_eq!(file_name("IMG_0042", "image/jpeg"), "IMG_0042.jpg");
        assert_eq!(file_name("a.jpeg", "image/jpeg"), "a.jpeg");
        assert_eq!(file_name("/tmp/x/shot.png", "image/png"), "shot.png");
        assert_eq!(file_name("", "image/png"), "image.png");
        assert_eq!(file_name("v1.2 draft", "image/png"), "v1.2 draft.png");
    }

    #[test]
    fn fill_in_reads_the_bytes() {
        // A 1×1 PNG.
        let png = vec![
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
            0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0,
        ];
        let file = PickedFile::new("pic", "", ImageData::new(png));
        assert_eq!(file.mime, "image/png");
        assert_eq!(file.name, "pic.png");
        assert_eq!(file.size, px(3, 2));
    }
}

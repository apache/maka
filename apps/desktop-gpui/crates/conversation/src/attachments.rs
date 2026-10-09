/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Files attached to a message: what the composer checks when they are
//! picked, pasted, or dropped, and the upload that turns each into an
//! [`AttachmentRef`] when the message is sent.
//!
//! The Desktop's main process does the same before it hands a message to
//! the Host (`resolveAttachmentRefs` in
//! `apps/desktop/src/main/attachment-ingest.ts`): read the file once under
//! the byte cap, decide its media type with the content winning over the
//! name (`resolveAttachmentMimeType`, `sniffAttachmentMimeType`,
//! `guessMimeFromName` in `packages/core/src/attachments.ts`), fit an image
//! to what the model is sent (`resizeImageForAttachment` in
//! `apps/desktop/src/main/attachment-resize-native.ts`), and ingest it into
//! the Session through `artifact.ingest`. The Host decides the attachment's
//! kind from that media type.

use std::io::{Cursor, Read as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gpui_kit::{BackgroundExecutor, SharedString};
use host_protocol::{
    ArtifactIngest, ArtifactIngestInput, ArtifactIngestResult, AttachmentKind, AttachmentRef,
    MAX_ATTACHMENT_BYTES, StorageRef,
};
use image::imageops::FilterType;
use image::{DynamicImage, ImageDecoder as _, ImageFormat, ImageReader};
use shared::copy::conversation as copy;
use shared::copy::{Locale, failure};
use workspace::HostRequester;

/// `PDF_HEADER_SCAN_BYTES`: how much of a file sniffing reads; image
/// signatures sit in its first 16 bytes.
const SNIFF_BYTES: usize = 1024;

/// `MAX_MODEL_IMAGE_EDGE`: the longest edge, in pixels, of an image sent to
/// the model.
const MAX_IMAGE_EDGE: u32 = 2000;

/// The name of an image pasted from the clipboard, before its extension
/// (the Desktop's `clipboard-image.png`).
const PASTED_IMAGE_STEM: &str = "clipboard-image";

/// A file picked, pasted, or dropped for the next message.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct PickedFile {
    pub source: AttachmentSource,
    /// The file name, as the attachment is named.
    pub name: SharedString,
    pub bytes: u64,
    /// Its first bytes are an image the model can see, or a TIFF or BMP,
    /// which is sent as PNG.
    pub image: bool,
    /// The kind its chip shows, as the Host will decide it from the media
    /// type (Desktop's pick-time `attachmentKindFromMimeType`).
    pub kind: AttachmentKind,
}

/// Where the bytes of a file for the next message are until it is sent.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum AttachmentSource {
    /// A file on disk, read when the message is sent.
    Path(PathBuf),
    /// An image pasted from the clipboard, held in memory.
    Pasted(PastedBytes),
}

impl AttachmentSource {
    /// What tells this file apart from the others for the next message: its
    /// path, or for a paste a key of its own.
    pub fn key(&self) -> String {
        match self {
            Self::Path(path) => path.to_string_lossy().into_owned(),
            Self::Pasted(pasted) => format!("pasted:{}", pasted.id.simple()),
        }
    }
}

/// The bytes of one paste. Each paste is an attachment of its own, so the
/// same image pasted twice is two; `Debug` shows the length, not the bytes.
#[derive(Clone)]
pub struct PastedBytes {
    id: uuid::Uuid,
    content: Arc<[u8]>,
}

impl PastedBytes {
    fn new(content: &[u8]) -> Self {
        Self { id: uuid::Uuid::new_v4(), content: content.into() }
    }
}

impl PartialEq for PastedBytes {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for PastedBytes {}

impl std::fmt::Debug for PastedBytes {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PastedBytes")
            .field("id", &self.id)
            .field("len", &self.content.len())
            .finish()
    }
}

/// Why a picked file cannot be attached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PickRefusal {
    TooLarge(SharedString),
    Unreadable(SharedString),
    /// A folder; only files are attached.
    Folder,
}

/// Reads the size and first bytes of each path. Blocking file I/O: run it
/// on a background thread.
#[allow(clippy::disallowed_methods)] // Runs on a background thread only.
pub(crate) fn inspect(paths: Vec<PathBuf>) -> Vec<Result<PickedFile, PickRefusal>> {
    paths
        .into_iter()
        .map(|path| {
            let name: SharedString = file_name(&path).into();
            let metadata =
                std::fs::metadata(&path).map_err(|_| PickRefusal::Unreadable(name.clone()))?;
            if metadata.is_dir() {
                return Err(PickRefusal::Folder);
            }
            if !metadata.is_file() {
                return Err(PickRefusal::Unreadable(name));
            }
            if metadata.len() > MAX_ATTACHMENT_BYTES {
                return Err(PickRefusal::TooLarge(name));
            }
            let mut prefix = Vec::with_capacity(SNIFF_BYTES);
            std::fs::File::open(&path)
                .and_then(|file| file.take(SNIFF_BYTES as u64).read_to_end(&mut prefix))
                .map_err(|_| PickRefusal::Unreadable(name.clone()))?;
            let source = AttachmentSource::Path(path);
            let image = is_image(&prefix);
            let kind = if image {
                AttachmentKind::Image
            } else {
                attachment_kind(&resolve_mime(&prefix, &name), &name)
            };
            Ok(PickedFile { source, name, bytes: metadata.len(), image, kind })
        })
        .collect()
}

/// An image pasted from the clipboard as the file it becomes, refused past
/// [`MAX_ATTACHMENT_BYTES`]. It is named `clipboard-image` with the
/// extension its bytes call for: `.jpg`, `.gif`, or `.webp` for those,
/// `.png` for a PNG and for a TIFF or BMP (sent as PNG), else the one the
/// clipboard's format has.
pub(crate) fn pasted_image(image: &gpui_kit::Image) -> Result<PickedFile, PickRefusal> {
    let content = &image.bytes;
    let extension = match sniff_mime(content) {
        Some("image/jpeg") => "jpg",
        Some("image/gif") => "gif",
        Some("image/webp") => "webp",
        Some("image/png") => "png",
        _ if convertible(content).is_some() => "png",
        _ => image.format.extension(),
    };
    let name: SharedString = format!("{PASTED_IMAGE_STEM}.{extension}").into();
    let bytes = content.len() as u64;
    if bytes > MAX_ATTACHMENT_BYTES {
        return Err(PickRefusal::TooLarge(name));
    }
    let source = AttachmentSource::Pasted(PastedBytes::new(content));
    let image = is_image(content);
    let kind = if image { AttachmentKind::Image } else { AttachmentKind::Generic };
    Ok(PickedFile { source, name, bytes, image, kind })
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or_else(|| path.display().to_string(), |name| name.to_string_lossy().into())
}

/// Uploads `file` into `session_id` with `artifact.ingest` and returns the
/// attachment to put in the message. The file is read once and fitted to
/// the model ([`normalize`]) on a background thread, under
/// [`MAX_ATTACHMENT_BYTES`]; an upload that fails after it opened is
/// aborted.
pub(crate) async fn upload(
    requester: &HostRequester,
    session_id: &str,
    file: &PickedFile,
    executor: &BackgroundExecutor,
    locale: Locale,
) -> Result<AttachmentRef, SharedString> {
    let (source, name) = (file.source.clone(), file.name.to_string());
    let failed = |reason: &str| -> SharedString {
        failure(locale, &copy::attach_failed(locale, &file.name), reason).into()
    };
    let (content, name) = executor
        .spawn(async move { prepare(source, &name, locale) })
        .await
        .map_err(|reason| failed(&reason))?;
    let mime_type = resolve_mime(&content, &name);
    let upload_id = uuid::Uuid::new_v4().simple().to_string();
    let begin = ArtifactIngestInput::begin(session_id, &upload_id, name, &mime_type, &content);
    let opened = requester
        .request::<ArtifactIngest>(&begin)
        .await
        .map_err(|error| failed(&error.to_string()))?;
    let mut offset = match opened {
        ArtifactIngestResult::Committed { attachment, .. } => {
            return checked(attachment, session_id)
                .ok_or_else(|| failed(copy::ATTACH_UNEXPECTED.in_locale(locale)));
        }
        ArtifactIngestResult::UploadOpened { next_offset, .. } => next_offset,
        _ => return Err(failed(copy::ATTACH_UNEXPECTED.in_locale(locale))),
    };
    let sent = async {
        while let Some(chunk) = ArtifactIngestInput::chunk(session_id, &upload_id, &content, offset)
        {
            match requester.request::<ArtifactIngest>(&chunk).await {
                Ok(ArtifactIngestResult::ChunkAccepted { next_offset, .. })
                    if next_offset > offset =>
                {
                    offset = next_offset;
                }
                Ok(_) => return Err(copy::ATTACH_UNEXPECTED.in_locale(locale).to_owned()),
                Err(error) => return Err(error.to_string()),
            }
        }
        let commit = ArtifactIngestInput::commit(session_id, &upload_id);
        match requester.request::<ArtifactIngest>(&commit).await {
            Ok(ArtifactIngestResult::Committed { attachment, .. }) => {
                checked(attachment, session_id)
                    .ok_or_else(|| copy::ATTACH_UNEXPECTED.in_locale(locale).to_owned())
            }
            Ok(_) => Err(copy::ATTACH_UNEXPECTED.in_locale(locale).to_owned()),
            Err(error) => Err(error.to_string()),
        }
    }
    .await;
    match sent {
        Ok(attachment) => Ok(attachment),
        Err(reason) => {
            let abort = ArtifactIngestInput::abort(session_id, &upload_id);
            if let Err(error) = requester.request::<ArtifactIngest>(&abort).await {
                log::debug!("aborting upload {upload_id} failed: {error}");
            }
            Err(failed(&reason))
        }
    }
}

/// The attachment, when its bytes are a file of this Session (what the
/// Desktop's decoder asserts, `assertOutputForInput`).
fn checked(attachment: AttachmentRef, session_id: &str) -> Option<AttachmentRef> {
    matches!(&attachment.storage, StorageRef::SessionFile { session_id: owner, .. } if owner == session_id)
        .then_some(attachment)
}

/// The whole file, refused past [`MAX_ATTACHMENT_BYTES`].
#[allow(clippy::disallowed_methods)] // Runs on a background thread only.
fn read_capped(path: &Path, locale: Locale) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut content = Vec::new();
    file.take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut content)
        .map_err(|error| error.to_string())?;
    if content.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(copy::ATTACH_TOO_LARGE_REASON.in_locale(locale).to_owned());
    }
    Ok(content)
}

/// The bytes and name to upload for the file at `source` named `name`: read
/// once, fitted to the model ([`normalize`]), and refused when what would
/// be uploaded is past [`MAX_ATTACHMENT_BYTES`]. Blocking and CPU-bound:
/// run it on a background thread.
fn prepare(
    source: AttachmentSource,
    name: &str,
    locale: Locale,
) -> Result<(Vec<u8>, String), String> {
    let content = match source {
        AttachmentSource::Path(path) => read_capped(&path, locale)?,
        AttachmentSource::Pasted(pasted) => pasted.content.to_vec(),
    };
    let (content, name) = normalize(content, name);
    if content.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(copy::ATTACH_TOO_LARGE_REASON.in_locale(locale).to_owned());
    }
    Ok((content, name))
}

/// The bytes and name to upload for `content` named `name`, fitted to what
/// the model is sent. As the Desktop's `resizeImageForAttachment`, an image
/// the model can see (PNG, JPEG, GIF, WebP) whose longest edge is over
/// [`MAX_IMAGE_EDGE`] is scaled down to it and re-encoded as PNG, a GIF
/// keeping only its first frame. A TIFF or BMP, which a macOS clipboard can
/// hold and the model cannot see, is decoded and sent as PNG (scaled down
/// the same way) under a `.png` name. Anything else, and bytes that do not
/// decode, go as they are. CPU-bound: run it on a background thread.
pub(crate) fn normalize(content: Vec<u8>, name: &str) -> (Vec<u8>, String) {
    let (format, converts) = match (model_image_format(&content), convertible(&content)) {
        (Some(format), _) => (format, false),
        (None, Some(format)) => (format, true),
        (None, None) => return (content, name.to_owned()),
    };
    match reencode(&content, format, converts) {
        Ok(Some(png)) if converts => (png, png_name(name)),
        Ok(Some(png)) => (png, name.to_owned()),
        Ok(None) => (content, name.to_owned()),
        Err(error) => {
            log::debug!("{name} is sent as it is: {error}");
            (content, name.to_owned())
        }
    }
}

/// `content` decoded, upright, fitted within [`MAX_IMAGE_EDGE`], and
/// encoded as PNG; `None` when it fits already and need not be converted.
fn reencode(
    content: &[u8],
    format: ImageFormat,
    convert: bool,
) -> image::ImageResult<Option<Vec<u8>>> {
    let mut decoder = ImageReader::with_format(Cursor::new(content), format).into_decoder()?;
    let (width, height) = decoder.dimensions();
    if width.max(height) <= MAX_IMAGE_EDGE && !convert {
        return Ok(None);
    }
    let orientation = decoder.orientation()?;
    let mut image = DynamicImage::from_decoder(decoder)?;
    image.apply_orientation(orientation);
    if let Some((width, height)) = fitted(image.width(), image.height()) {
        image = image.resize_exact(width, height, FilterType::Triangle);
    }
    let mut png = Vec::new();
    image.write_to(Cursor::new(&mut png), ImageFormat::Png)?;
    Ok(Some(png))
}

/// `computeResizeDimensions`: the size that brings the longest edge down to
/// [`MAX_IMAGE_EDGE`], keeping the aspect ratio; `None` when it fits.
fn fitted(width: u32, height: u32) -> Option<(u32, u32)> {
    let longest = width.max(height);
    if longest <= MAX_IMAGE_EDGE {
        return None;
    }
    let scale = f64::from(MAX_IMAGE_EDGE) / f64::from(longest);
    let edge = |length: u32| ((f64::from(length) * scale).round() as u32).max(1);
    Some((edge(width), edge(height)))
}

/// `name` with its extension replaced by `.png` (or `.png` added).
fn png_name(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => format!("{stem}.png"),
        _ => format!("{name}.png"),
    }
}

/// The format of an image the model can see, by its bytes.
fn model_image_format(bytes: &[u8]) -> Option<ImageFormat> {
    match sniff_mime(bytes)? {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" => Some(ImageFormat::Jpeg),
        "image/gif" => Some(ImageFormat::Gif),
        "image/webp" => Some(ImageFormat::WebP),
        _ => None,
    }
}

/// An image format the model cannot see that is sent as PNG, by its bytes:
/// TIFF (what macOS puts on the clipboard for many apps) or BMP.
fn convertible(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some(ImageFormat::Tiff)
    } else if bytes.starts_with(b"BM") && bytes.get(6..10) == Some(&[0; 4]) {
        // The two reserved words of a BMP file header are zero.
        Some(ImageFormat::Bmp)
    } else {
        None
    }
}

/// Whether the file whose first bytes are `prefix` is sent as an image.
fn is_image(prefix: &[u8]) -> bool {
    model_image_format(prefix).is_some() || convertible(prefix).is_some()
}

/// `sniffAttachmentMimeType`: the formats whose bytes change how Maka
/// handles a file.
pub(crate) fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    let prefix = &bytes[..bytes.len().min(16)];
    if prefix.starts_with(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) {
        Some("image/png")
    } else if prefix.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes[..bytes.len().min(SNIFF_BYTES)].windows(5).any(|window| window == b"%PDF-") {
        Some("application/pdf")
    } else {
        None
    }
}

/// `guessMimeFromName`, with the Desktop's table.
fn guess_mime_from_name(name: &str) -> &'static str {
    let extension = name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("pdf") => "application/pdf",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("doc") => "application/msword",
        Some("xls") => "application/vnd.ms-excel",
        Some("ppt") => "application/vnd.ms-powerpoint",
        _ => "application/octet-stream",
    }
}

/// The extensions Desktop gives the `code` kind (`CODE_FILE_EXTENSIONS` in
/// packages/core/src/attachments.ts): the kind only changes the chip's
/// glyph.
const CODE_FILE_EXTENSIONS: &[&str] = &[
    "c", "cc", "cpp", "cs", "css", "go", "h", "hpp", "java", "js", "json", "jsx", "kt", "mjs",
    "cjs", "php", "py", "rb", "rs", "sh", "sql", "svelte", "swift", "ts", "tsx", "vue", "yaml",
    "yml", "zsh",
];

/// `attachmentKindFromMimeType`: an image or a PDF by its media type, an
/// Office document or source code by its name, anything else `other`.
pub(crate) fn attachment_kind(mime_type: &str, name: &str) -> AttachmentKind {
    let mime = mime_type.to_ascii_lowercase();
    if mime.starts_with("image/") {
        return AttachmentKind::Image;
    }
    if mime == "application/pdf" {
        return AttachmentKind::Pdf;
    }
    let name = name.to_lowercase();
    if [".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"].iter().any(|ext| name.ends_with(ext)) {
        return AttachmentKind::Doc;
    }
    match name.rsplit_once('.') {
        Some((_, extension)) if CODE_FILE_EXTENSIONS.contains(&extension) => AttachmentKind::Code,
        _ => AttachmentKind::Generic,
    }
}

/// `resolveAttachmentMimeType`: sniffed bytes win; an image or PDF type
/// claimed only by the name becomes `application/octet-stream`, so
/// unverified bytes never take the image or PDF path.
pub(crate) fn resolve_mime(bytes: &[u8], name: &str) -> String {
    if let Some(sniffed) = sniff_mime(bytes) {
        return sniffed.to_owned();
    }
    match guess_mime_from_name(name) {
        claimed if claimed.starts_with("image/") || claimed == "application/pdf" => {
            "application/octet-stream".to_owned()
        }
        claimed => claimed.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_files_kind_follows_its_media_type_then_its_name() {
        assert_eq!(attachment_kind("image/png", "x.txt"), AttachmentKind::Image);
        assert_eq!(attachment_kind("application/pdf", "x"), AttachmentKind::Pdf);
        assert_eq!(attachment_kind("application/octet-stream", "Plan.DOCX"), AttachmentKind::Doc);
        assert_eq!(attachment_kind("application/octet-stream", "main.rs"), AttachmentKind::Code);
        assert_eq!(
            attachment_kind("application/octet-stream", "notes.txt"),
            AttachmentKind::Generic
        );
        assert_eq!(
            attachment_kind("application/octet-stream", "Makefile"),
            AttachmentKind::Generic
        );
        // A name claiming a PDF without the bytes of one is not a PDF.
        assert_eq!(
            attachment_kind(&resolve_mime(b"plain", "fake.pdf"), "fake.pdf"),
            AttachmentKind::Generic
        );
    }

    #[test]
    fn content_wins_over_the_name() {
        let png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];
        assert_eq!(resolve_mime(&png, "photo.txt"), "image/png");
        assert_eq!(resolve_mime(b"not an image", "photo.png"), "application/octet-stream");
        assert_eq!(resolve_mime(b"hello", "notes.txt"), "application/octet-stream");
        assert_eq!(resolve_mime(b"x%PDF-1.7", "a.bin"), "application/pdf");
        assert_eq!(resolve_mime(b"PK", "Report.DOCX"), guess_mime_from_name("r.docx"));
        let webp = *b"RIFF\0\0\0\0WEBPVP8 ";
        assert_eq!(sniff_mime(&webp), Some("image/webp"));
    }

    fn encoded(width: u32, height: u32, format: ImageFormat) -> Vec<u8> {
        let mut content = Vec::new();
        DynamicImage::new_rgb8(width, height)
            .write_to(Cursor::new(&mut content), format)
            .expect("encode");
        content
    }

    fn png_size(content: &[u8]) -> (u32, u32) {
        let image = image::load_from_memory_with_format(content, ImageFormat::Png).expect("PNG");
        (image.width(), image.height())
    }

    #[test]
    fn an_image_past_the_edge_is_scaled_down_to_png() {
        let (content, name) = normalize(encoded(3000, 1000, ImageFormat::Png), "wide.png");
        assert_eq!(resolve_mime(&content, &name), "image/png");
        assert_eq!(png_size(&content), (2000, 667), "the aspect ratio is kept, rounded");
        assert_eq!(name, "wide.png");
        // A tall JPEG becomes a PNG under its own name, as in the Desktop.
        let (content, name) = normalize(encoded(900, 2700, ImageFormat::Jpeg), "tall.jpg");
        assert_eq!((sniff_mime(&content), png_size(&content)), (Some("image/png"), (667, 2000)));
        assert_eq!(name, "tall.jpg");
    }

    #[test]
    fn an_image_within_the_edge_is_sent_as_it_is() {
        let jpeg = encoded(100, 100, ImageFormat::Jpeg);
        assert_eq!(normalize(jpeg.clone(), "small.jpg"), (jpeg, "small.jpg".to_owned()));
        let square = encoded(2000, 2000, ImageFormat::Png);
        assert_eq!(normalize(square.clone(), "edge.png").0, square, "the edge itself fits");
    }

    #[test]
    fn a_tiff_or_bmp_is_sent_as_png_under_a_png_name() {
        for (format, name, renamed) in [
            (ImageFormat::Tiff, "scan.tiff", "scan.png"),
            (ImageFormat::Bmp, "shot.bmp", "shot.png"),
        ] {
            let content = encoded(40, 30, format);
            assert!(is_image(&content), "{name} counts as an image");
            assert_eq!(resolve_mime(&content, name), "application/octet-stream");
            let (content, name) = normalize(content, name);
            assert_eq!(
                (resolve_mime(&content, &name).as_str(), name.as_str()),
                ("image/png", renamed)
            );
            assert_eq!(png_size(&content), (40, 30));
        }
        let (content, name) = normalize(encoded(4000, 100, ImageFormat::Tiff), "strip");
        assert_eq!((png_size(&content), name.as_str()), ((2000, 50), "strip.png"));
    }

    #[test]
    fn anything_else_is_sent_as_it_is() {
        let text = b"BM is not always a bitmap".to_vec();
        assert_eq!(normalize(text.clone(), "notes.txt"), (text, "notes.txt".to_owned()));
        let pdf = b"%PDF-1.7 ...".to_vec();
        assert_eq!(normalize(pdf.clone(), "a.pdf"), (pdf, "a.pdf".to_owned()));
        // An image signature over bytes that do not decode.
        let broken = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3].to_vec();
        assert_eq!(normalize(broken.clone(), "broken.png"), (broken, "broken.png".to_owned()));
        let tiff = b"II*\0 not really".to_vec();
        assert_eq!(normalize(tiff.clone(), "x.tif"), (tiff, "x.tif".to_owned()));
    }

    #[test]
    fn a_pasted_image_is_named_for_its_bytes() {
        let name = |format: gpui_kit::ImageFormat, content: Vec<u8>| {
            let image = gpui_kit::Image::from_bytes(format, content);
            pasted_image(&image).map(|file| file.name.to_string())
        };
        use gpui_kit::ImageFormat as Clipboard;
        let png = encoded(4, 4, ImageFormat::Png);
        assert_eq!(name(Clipboard::Png, png).as_deref(), Ok("clipboard-image.png"));
        let jpeg = encoded(4, 4, ImageFormat::Jpeg);
        assert_eq!(name(Clipboard::Jpeg, jpeg).as_deref(), Ok("clipboard-image.jpg"));
        let tiff = encoded(4, 4, ImageFormat::Tiff);
        assert_eq!(name(Clipboard::Tiff, tiff).as_deref(), Ok("clipboard-image.png"));
        assert_eq!(name(Clipboard::Svg, b"<svg/>".to_vec()).as_deref(), Ok("clipboard-image.svg"));
    }
}

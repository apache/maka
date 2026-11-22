//! `nsh/picker`: the system's pickers for photos (iOS
//! `PHPickerViewController`, Android's Photo Picker, an open panel on the
//! desktops, `<input type=file>` in a browser) and for files of any type
//! (iOS `UIDocumentPickerViewController`, Android's `ACTION_OPEN_DOCUMENT`,
//! the same panel and input). What is picked reaches JS as `File`s whose
//! bytes stay native ([`crate::picker`]). Needs the
//! `picker` capability when the app declares capabilities: without it a
//! pick rejects with `ERR_ACCESS_DENIED` (checked here, in the call; the
//! core also refuses the picks of Rust components, which then get none).

use crate::{
    element::{
        JsError, JsHost, JsIn, JsObject, JsOwned, JsValue, Later, PropEnum, PropError, System,
        TsTypes, module,
    },
    file_dialog,
    geometry::{DevicePixels, Size},
    picker::{self, FilePickRequest, PickRequest, PickedFile},
};

/// The system's picker.
#[module]
pub(crate) struct Picker;

#[module]
impl Picker {
    /// Shows the system's picker for photos and resolves with the images
    /// the user picked, in the order picked, as `File`s (their bytes stay
    /// native: show one with `URL.createObjectURL(file)`, upload it with
    /// `fetch` or `FormData`); `[]` when the user cancels. HEIC and other
    /// formats browsers do not show come as JPEG unless `format` is
    /// `"current"`; `maxDimension` scales large photos down natively. On
    /// iOS and Android the system's photo picker needs no permission.
    /// Rejects with `ERR_ACCESS_DENIED` when the `picker` capability is not
    /// granted, and with a `RangeError` for options out of range.
    pub(crate) fn pick_images(
        options: Option<PickImagesOptions>,
        sys: System,
    ) -> Result<Later<Vec<PickedImage>>, JsError> {
        let request = options.unwrap_or_default().request()?;
        if !sys.access.allows_picker() {
            return Err(JsError::access_denied(
                "the picker is not granted: add `\"picker\": true` to capabilities in nsh.json",
                "picker",
                "",
            ));
        }
        Ok(Later::new(async move {
            let files = crate::prelude::pick_images(request).await;
            Ok::<_, JsError>(files.into_iter().map(PickedImage).collect())
        }))
    }

    /// Shows the system's picker for files of any type (the open dialog on
    /// the desktops, the document picker on iOS and Android, a file input
    /// on the web) and resolves with the files the user picked, their bytes
    /// and names as they are; `[]` when the user cancels. `filters` limit
    /// what the picker offers, so check what you get: a system's picker may
    /// let other files through. Every file's bytes are read into memory,
    /// except a file larger than `maxSize` (or 512 MiB): that one comes
    /// with its name and size only, `file` null and `status`
    /// `"tooLarge"`, so the app can tell the user. Needs no permission on any
    /// platform. Rejects with `ERR_ACCESS_DENIED` when the `picker`
    /// capability is not granted, and with a `RangeError` for options out
    /// of range.
    pub(crate) fn pick_files(
        options: Option<PickFilesOptions>,
        sys: System,
    ) -> Result<Later<Vec<PickedDocument>>, JsError> {
        let request = options.unwrap_or_default().request()?;
        if !sys.access.allows_picker() {
            return Err(JsError::access_denied(
                "the picker is not granted: add `\"picker\": true` to capabilities in nsh.json",
                "picker",
                "",
            ));
        }
        Ok(Later::new(async move {
            let files = crate::prelude::pick_files(request).await;
            Ok::<_, JsError>(files.into_iter().map(PickedDocument).collect())
        }))
    }
}

/// How `pickFiles` picks files.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct PickFilesOptions {
    /// Lets the user pick several files (false: one).
    multiple: Option<bool>,
    /// At most this many files when `multiple` (none: up to 100, the most
    /// one pick gives).
    limit: Option<u32>,
    /// The file types offered, the first chosen (none: any file).
    filters: Option<Vec<PickFileFilter>>,
    /// The largest file read, in bytes (none: 512 MiB, also the most a
    /// larger one reads): a larger one comes with its name and size only
    /// (`status` `"tooLarge"`).
    max_size: Option<f64>,
}

/// A group of file types `pickFiles` offers.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct PickFileFilter {
    /// What the picker shows for it (`"Documents"`), where it shows names.
    name: String,
    /// Its file extensions (`"pdf"`, `".pdf"` or `"*.pdf"`, any case).
    extensions: Vec<String>,
}

impl PickFilesOptions {
    /// The request these options make, or why they make none.
    fn request(self) -> Result<FilePickRequest, JsError> {
        if self.limit == Some(0) {
            return Err(JsError::Range("`limit` must be at least 1".into()));
        }
        let mut request =
            FilePickRequest::new(self.multiple.unwrap_or(false), self.limit.unwrap_or(0));
        if let Some(max) = self.max_size {
            if max.is_nan() || max < 0.0 {
                return Err(JsError::Range(
                    "`maxSize` must be a number of bytes, at least 0".into(),
                ));
            }
            // Past `u64::MAX` (infinity too) saturates: NSH's own limit.
            request = request.max_size(max as u64);
        }
        for filter in self.filters.unwrap_or_default() {
            let filter = file_dialog::FileFilter::new(filter.name, filter.extensions);
            if filter.extensions.is_empty() {
                return Err(JsError::Range(
                    "a filter's `extensions` must name at least one extension".into(),
                ));
            }
            request = request.filter(filter);
        }
        Ok(request)
    }
}

/// A file the user picked with `pickFiles`.
pub(crate) struct PickedDocument(PickedFile);

impl JsValue for PickedDocument {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("PickedFile", |_| {
            "/** A file the user picked (`Picker.pickFiles`). */\n\
             export interface PickedFile {\n\
             \x20 /** The file: its name, type, size in bytes and bytes; `null` when its bytes were not read (`status`). */\n\
             \x20 file: File | null;\n\
             \x20 /** Its name, without its folders. */\n\
             \x20 name: string;\n\
             \x20 /** Its media type (`application/pdf`; `application/octet-stream` when unknown). */\n\
             \x20 type: string;\n\
             \x20 /** Its size in bytes, read or not. */\n\
             \x20 size: number;\n\
             \x20 /** `\"read\"`: `file` holds its bytes; `\"tooLarge\"`: it is larger than `maxSize` (or 512 MiB), so its bytes were not read. */\n\
             \x20 status: \"read\" | \"tooLarge\";\n\
             }"
            .into()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("no value: a picked file is only returned"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let file = &self.0;
        let owned = JsOwned::new(host, host.new_object()?);
        let object = owned.get().raw();
        let (js_file, status) = match file.status {
            picker::PickedStatus::TooLarge => (host.null(), "tooLarge"),
            _ => (
                host.new_file(&file.data, &file.mime, &file.name, file.last_modified)?,
                "read",
            ),
        };
        host.set_field(object, "file", js_file)?;
        host.set_field(object, "name", host.new_string(&file.name)?)?;
        host.set_field(object, "type", host.new_string(&file.mime)?)?;
        host.set_field(object, "size", host.new_number(file.len as f64))?;
        host.set_field(object, "status", host.new_string(status)?)?;
        Ok(owned)
    }
}

/// How `pickImages` picks and prepares images.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct PickImagesOptions {
    /// Lets the user pick several images (false: one).
    multiple: Option<bool>,
    /// At most this many images when `multiple` (none: up to 100, the
    /// most one pick gives).
    limit: Option<u32>,
    /// Images whose longer side is longer than this many pixels are scaled
    /// down to it and encoded again (none: their size is kept).
    max_dimension: Option<DevicePixels>,
    /// The quality of the JPEGs encoded, from 0 (smallest) to 1 (best;
    /// 0.9 when not given). Given, JPEGs are encoded again at it too.
    quality: Option<f64>,
    /// `"compatible"` (default): JPEG, PNG, GIF and WebP stay as they are,
    /// any other format (HEIC, HEIF, TIFF) becomes a JPEG. `"current"`:
    /// the format the photo is stored in.
    format: Option<PickFormat>,
}

/// The formats picked images come in.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub(crate) enum PickFormat {
    /// JPEG, PNG, GIF and WebP as they are, anything else as a JPEG.
    #[default]
    Compatible,
    /// The format the photo is stored in.
    Current,
}

impl PickImagesOptions {
    /// The request these options make, or why they make none.
    fn request(self) -> Result<PickRequest, JsError> {
        if self.limit == Some(0) {
            return Err(JsError::Range("`limit` must be at least 1".into()));
        }
        let mut request = PickRequest::new(self.multiple.unwrap_or(false), self.limit.unwrap_or(0));
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
            request.quality = Some(crate::geometry::Percentage(quality as f32));
        }
        request.format = match self.format.unwrap_or_default() {
            PickFormat::Compatible => picker::PickFormat::Compatible,
            PickFormat::Current => picker::PickFormat::Current,
        };
        Ok(request)
    }
}

/// A picked image: its `File` and its size in pixels.
pub(crate) struct PickedImage(PickedFile);

impl JsValue for PickedImage {
    fn ts_type(types: &mut TsTypes) -> String {
        let size = Size::<DevicePixels>::ts_type(types);
        types.declare("PickedImage", |_| {
            format!(
                "/** An image the user picked (`Picker.pickImages`). */\n\
                 export interface PickedImage {{\n\
                 \x20 /** The image's file: its name, type (`image/jpeg`), size in bytes and bytes. */\n\
                 \x20 file: File;\n\
                 \x20 /** Its size in pixels, as it shows (its orientation applied). */\n\
                 \x20 size: {size};\n\
                 }}"
            )
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("no value: a picked image is only returned"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let file = &self.0;
        let owned = JsOwned::new(host, host.new_object()?);
        let object = owned.get().raw();
        let js_file = host.new_file(&file.data, &file.mime, &file.name, file.last_modified)?;
        host.set_field(object, "file", js_file)?;
        host.set_field(object, "size", file.size.to_js(host)?.into_raw())?;
        Ok(owned)
    }
}

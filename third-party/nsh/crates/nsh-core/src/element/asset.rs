//! The files a crate ships (`asset!`, `assets!`): images with their
//! natural size, fonts with their family, other files by URI, as TS's
//! imports of them give. A crate's files live in its `assets/` directory
//! and are published at `asset:/@<package>/<path>`; the registry lists
//! them ([`super::Registry::assets`]) so that `nsh run` serves and `nsh
//! package` copies them, and the engine registers the fonts before the
//! first render.

use super::SharedString;
use crate::geometry::{Points, Size};

/// An image file of a crate (`asset!("logo@2x.png")`; TS: `import logo
/// from "./logo@2x.png"`): its URL and natural size, which lays the image
/// out before it loads.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageAsset {
    /// `asset:/@<package>/<path>`.
    pub url: &'static str,
    /// Its size in points, the size it lays out at: the file's pixels over
    /// the `@2x` / `@3x` of its name. (What decoding reports, as
    /// [`super::ImageSize`] does, is in [`crate::geometry::DevicePixels`].)
    pub size: Size<Points>,
    /// The pixel densities it ships in, 1 being the file itself:
    /// `asset!("logo.png")` with `logo@2x.png` and `logo@3x.png` next to it
    /// gives `[1.0, 2.0, 3.0]`, and images load the one for the screen's
    /// pixel ratio. Empty when the file is the only one (or its name has a
    /// density suffix).
    pub scales: &'static [f32],
}

/// A font file of a crate (`asset!("Pacifico-Regular.ttf")`; TS: `import
/// pacifico from "./Pacifico-Regular.ttf"`): styles name it by
/// [`Self::family`] (`.font_family(PACIFICO.family)`). The engine registers
/// the fonts the registry ships ([`super::Registry::assets`]) before the
/// first render.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FontAsset {
    /// `asset:/@<package>/<path>`.
    pub uri: &'static str,
    /// Its family name.
    pub family: &'static str,
}

/// Any other file of a crate (a video, a page): its URI for the elements
/// that load URIs (`video(CLIP.uri)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileAsset {
    /// `asset:/@<package>/<path>`.
    pub uri: &'static str,
}

/// What an [`AssetFile`] is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
    /// An image (`png`, `jpg`, `jpeg`, `gif`, `webp`, `heic`).
    Image,
    /// A font (`ttf`, `otf`), registered before the first render.
    Font,
    /// Anything else.
    File,
}

/// A file a crate ships, as `assets!()` lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssetFile {
    /// `asset:/@<package>/<path>`.
    pub uri: &'static str,
    /// The file where the crate was built (what `nsh` serves and copies).
    pub source: &'static str,
    /// What it is.
    pub kind: AssetKind,
}

impl AssetFile {
    /// Its path among the app's assets (`@gallery-native/logo@2x.png`): the
    /// URI without `asset:/`.
    pub fn path(&self) -> &'static str {
        self.uri.strip_prefix("asset:/").unwrap_or(self.uri)
    }
}

/// What an image shows ([`super::image`], [`super::Image::placeholder`]):
/// a URL, a file path or `asset:/` URI (strings), or an [`ImageAsset`],
/// whose natural size lays it out before it loads.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageSrc {
    pub(crate) uri: SharedString,
    pub(crate) size: Option<(f32, f32)>,
    pub(crate) scales: crate::ImageScales,
    /// The bytes of a `blob:` URL the app's VM resolved, as `<Image>`'s
    /// `src` has them ([`super::JsHost::image_blob`]); the URI is then their
    /// key.
    pub(crate) data: Option<crate::ImageData>,
}

impl<T: Into<SharedString>> From<T> for ImageSrc {
    fn from(uri: T) -> Self {
        Self {
            uri: uri.into(),
            size: None,
            scales: crate::ImageScales::NONE,
            data: None,
        }
    }
}

impl From<ImageAsset> for ImageSrc {
    fn from(asset: ImageAsset) -> Self {
        Self {
            uri: asset.url.into(),
            size: Some((asset.size.width.0, asset.size.height.0)),
            scales: asset.scales.iter().copied().collect(),
            data: None,
        }
    }
}

impl From<&ImageAsset> for ImageSrc {
    fn from(asset: &ImageAsset) -> Self {
        (*asset).into()
    }
}

impl ImageSrc {
    /// Whether its URL is empty: no image, as an `<Image>` whose `src`
    /// is `""` shows none.
    pub fn is_empty(&self) -> bool {
        self.uri.is_empty()
    }

    /// The source of a menu item's icon; `None` for an empty URL.
    pub(crate) fn menu_icon(&self) -> Option<crate::ImageSource> {
        (!self.is_empty()).then(|| {
            crate::ImageSource {
                uri: self.uri.to_arc(),
                size: self.size.map(|(w, h)| crate::geometry::size_pt(w, h)),
                scales: self.scales,
                data: self.data.clone(),
            }
            .inline()
        })
    }

    /// A `width` × `height` pixel buffer as a source: straight (not
    /// premultiplied) 8-bit RGBA, rows top to bottom with no padding,
    /// `width * height * 4` bytes, held as they are (`Vec<u8>`,
    /// `Arc<[u8]>`, ...; not copied). It lays out at `width` × `height`
    /// points, as a `data:` image does. Frames made elsewhere (a renderer,
    /// a camera, a thread drawing a preview) show without being encoded;
    /// each buffer is an image of its own, which the caches drop once no
    /// view shows it.
    ///
    /// ```ignore
    /// let pixels: Arc<[u8]> = render_page(); // 1192 × 1684 × 4 bytes
    /// image(ImageSrc::rgba(1192, 1684, pixels)).w_full()
    /// ```
    ///
    /// # Panics
    ///
    /// When `pixels` is not `width * height * 4` bytes long, or a side is 0.
    pub fn rgba(width: u32, height: u32, pixels: impl AsRef<[u8]> + Send + Sync + 'static) -> Self {
        Self {
            uri: crate::image::rgba_key().into(),
            size: Some((width as f32, height as f32)),
            scales: crate::ImageScales::NONE,
            data: Some(crate::ImageData::from_rgba(width, height, pixels)),
        }
    }

    /// The SVG document `markup` itself as a source ([`super::svg`],
    /// [`super::image`]): its markup is the image, as an `<svg>` written
    /// inline in a web page is.
    pub fn svg_markup(markup: &str) -> Self {
        use std::fmt::Write;
        let mut uri = String::with_capacity(markup.len() + 32);
        uri.push_str("data:image/svg+xml,");
        for b in markup.bytes() {
            if b.is_ascii_alphanumeric() || b" -._~!$'()*+,;=:@/?".contains(&b) {
                uri.push(b as char);
            } else {
                let _ = write!(uri, "%{b:02X}");
            }
        }
        uri.into()
    }
}

crate::static_reactive!(
    ImageSrc: ImageSrc,
    ImageAsset,
    &ImageAsset,
    super::SharedString,
    String,
    &'static str
);

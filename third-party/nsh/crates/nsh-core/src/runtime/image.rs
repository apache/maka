//! `nsh/image`: image information and loading ahead, the functions of
//! `Image` (`nsh-js` makes it the image element's component).

use crate::{
    ImageScales, ImageSource,
    element::{ImageSize, JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, TsTypes, module},
    geometry::DevicePixels,
};

/// Image information and loading ahead.
#[module]
pub(crate) struct Image;

/// An image's address: a string or an imported image (`ImageAsset`, with
/// the `scales` of its variants).
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ImageUrl {
    url: String,
    scales: ImageScales,
    size: Option<ImageSize>,
}

impl ImageUrl {
    /// The URL the views load at the surface's pixel ratio, and the scale
    /// of that variant (1 for the URL itself).
    fn pick(self) -> (String, f32) {
        let source = ImageSource {
            uri: self.url.into(),
            size: None,
            scales: self.scales,
            data: None,
        };
        let ratio = crate::prelude::pixel_ratio();
        let scale = source.variant(ratio).unwrap_or(1.0);
        (source.uri_for(ratio).to_string(), scale)
    }
}

impl JsValue for ImageUrl {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string | ImageAsset".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if let Some(url) = value.as_string() {
            return Ok(Self {
                url,
                scales: ImageScales::NONE,
                size: None,
            });
        }
        if value.kind() == JsKind::Object
            && let Some(url) = value.field("url")?.get().as_string()
        {
            let list = value.field("scales")?;
            let list = list.get();
            let mut scales = ImageScales::NONE;
            let len = list.array_len()?.unwrap_or(0);
            for i in 0..len.min(crate::ops::SCALES_READ) {
                if let Some(n) = list.index(i)?.get().as_number() {
                    scales = scales.with(n as f32);
                }
            }
            // Only variant assets use the imported file's dimensions.
            // Plain sources keep reporting the loaded file's pixels.
            let size =
                if !scales.is_empty() && url.starts_with("asset:/") && !url.contains(['?', '#']) {
                    let extent = value.field("size")?;
                    let extent = extent.get();
                    let dimension = |key| -> Result<Option<DevicePixels>, PropError> {
                        if extent.kind() != JsKind::Object {
                            return Ok(None);
                        }
                        Ok(extent
                            .field(key)?
                            .get()
                            .as_number()
                            .filter(|n| n.is_finite() && *n > 0.0 && *n <= f64::from(i32::MAX))
                            .map(|n| DevicePixels(n.round() as i32)))
                    };
                    dimension("width")?
                        .zip(dimension("height")?)
                        .map(|(width, height)| ImageSize { width, height })
                } else {
                    None
                };
            return Ok(Self { url, scales, size });
        }
        Err(value.expected("a URL or an imported image"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        Ok(JsOwned::new(host, host.new_string(&self.url)?))
    }
}

#[module]
impl Image {
    /// The image's size in pixels; its bytes stay loaded for the views that
    /// show it next. An imported image with variants loads the variant the
    /// views load and resolves with the imported file's size. Without
    /// dimensions, it falls back to the variant's pixels over its scale.
    pub(crate) async fn get_size(src: ImageUrl) -> Result<ImageSize, String> {
        let imported_size = src.size;
        let (url, scale) = src.pick();
        let size = crate::prelude::image_size(url).await?;
        if let Some(size) = imported_size {
            return Ok(size);
        }
        let unscaled = |px: DevicePixels| DevicePixels((px.0 as f32 / scale).round() as i32);
        Ok(ImageSize {
            width: unscaled(size.width),
            height: unscaled(size.height),
        })
    }

    /// Loads the image ahead of showing it: true once its bytes are in
    /// memory. An imported image with variants loads the variant the views
    /// load at the screen's pixel ratio.
    pub(crate) async fn prefetch(src: ImageUrl) -> bool {
        crate::prelude::prefetch_image(src.pick().0).await
    }
}

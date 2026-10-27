//! The files the gallery ships (`assets/`, as the TSX gallery imports
//! them): `asset!` reads each at compile time, the registry ships them all
//! ([`crate::registry`]).

use nsh_core::element::{FontAsset, ImageAsset, asset};

/// The gallery's logo (`logo@2x.png`: 2 pixels per point).
pub(crate) const LOGO: ImageAsset = asset!("logo@2x.png");

/// An animated GIF.
pub(crate) const BOUNCE: ImageAsset = asset!("bounce.gif");

/// An animated WebP.
pub(crate) const SPINNER: ImageAsset = asset!("spinner.webp");

/// A script font (registered before the first render).
pub(crate) const PACIFICO: FontAsset = asset!("fonts/Pacifico-Regular.ttf");

#[cfg(test)]
mod tests {
    use nsh_core::element::{px, size};

    use super::*;

    #[test]
    fn assets_are_read_at_compile_time() {
        // 128 pixels at 2 per point.
        assert_eq!(
            (LOGO.url, LOGO.size),
            (
                "asset:/@gallery-native/logo@2x.png",
                size(px(64.0), px(64.0))
            )
        );
        assert_eq!(BOUNCE.size, size(px(96.0), px(96.0)));
        assert_eq!(
            PACIFICO,
            FontAsset {
                uri: "asset:/@gallery-native/fonts/Pacifico-Regular.ttf",
                family: "Pacifico",
            }
        );
    }
}

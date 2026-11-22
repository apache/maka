//! SVG images for `Images.java`: `BitmapFactory` cannot read them, so the
//! image threads hand their bytes to the shared rasterizer
//! ([`nsh_core::svg`]) through `Native.svg` and copy the pixels into a
//! premultiplied `ARGB_8888` bitmap (whose bytes are RGBA, as the raster's).

use jni::{
    JNIEnv,
    objects::{JByteArray, JClass, JFloatArray, JIntArray},
    sys::{jfloat, jint},
};

/// `Native.svg(bytes, maxPx, density, size, intrinsic)`: draws the SVG `bytes` for a
/// view `max_px` pixels on its longer side, with its shorter side that
/// long, so it stays sharp in every resize mode (0: at its intrinsic size,
/// `density` pixels per point), as premultiplied RGBA, and sets `size` to
/// the raster's width and height and the SVG's intrinsic size in whole
/// points, and `intrinsic` to its unrounded size in points; `max_px` below
/// 0 only measures (an empty array). Null when the
/// bytes are not an SVG or not a valid one. Called on the image threads.
#[unsafe(no_mangle)]
extern "system" fn Java_com_longbridge_nsh_Native_svg<'local>(
    env: JNIEnv<'local>,
    _: JClass<'local>,
    bytes: JByteArray<'local>,
    max_px: jint,
    density: jfloat,
    size: JIntArray<'local>,
    intrinsic: JFloatArray<'local>,
) -> JByteArray<'local> {
    let Ok(bytes) = env.convert_byte_array(&bytes) else {
        return JByteArray::default();
    };
    if !nsh_core::svg::sniff(&bytes) {
        return JByteArray::default();
    }
    let drawn = match max_px {
        ..0 => nsh_core::svg::size(&bytes).map(|size| (0, 0, Vec::new(), size)),
        0 => nsh_core::svg::rasterize_scaled(&bytes, density)
            .map(|r| (r.width, r.height, r.pixels, r.size)),
        // Its shorter side at the view's longer one: sharp in every
        // resize mode.
        n => nsh_core::svg::rasterize_covering(&bytes, n as u32)
            .map(|r| (r.width, r.height, r.pixels, r.size)),
    };
    let (width, height, pixels, points) = match drawn {
        Ok(drawn) => drawn,
        Err(e) => {
            log::warn!("{e}");
            return JByteArray::default();
        }
    };
    if env
        .set_float_array_region(&intrinsic, 0, &[points.width.0, points.height.0])
        .is_err()
    {
        return JByteArray::default();
    }
    let reported = nsh_core::svg::reported_size(points);
    let sizes = [
        width as jint,
        height as jint,
        reported.width.0,
        reported.height.0,
    ];
    if env.set_int_array_region(&size, 0, &sizes).is_err() {
        return JByteArray::default();
    }
    env.byte_array_from_slice(&pixels).unwrap_or_default()
}

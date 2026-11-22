//! The web text engine (`src/text.rs`) off WebAssembly, with the browser's
//! measurements stubbed (every character of a font equally wide), so its
//! line breaking, layout and their costs can be checked on the host.

// In a module of the source directory, so `text.rs`'s own modules
// (`src/text/*.rs`) are found where the crate finds them.
#[path = "../../src"]
#[allow(dead_code, unused_imports)]
mod src {
    pub(crate) mod text;
}
use src::text;

/// What `canvas_width` in `src/text.rs` asks for.
mod canvas {
    pub(crate) fn font(_: &nsh_core::canvas::CanvasFont) -> String {
        "16px sans-serif".to_owned()
    }
}

/// What `src/text.rs` asks the browser (`src/ffi.rs`), answered by rule.
mod ffi {
    pub(crate) fn measure_text(font: &str, text: &str) -> f32 {
        // Fonts differ in width, so a style's change shows.
        text.chars().count() as f32 * (8.0 + (font.len() % 3) as f32)
    }
    pub(crate) fn measure_numeric_text(font: &str, _numeric: &str, text: &str) -> f32 {
        measure_text(font, text)
    }
    pub(crate) fn font_metrics(_font: &str) -> (f32, f32) {
        (12.0, 4.0)
    }
    pub(crate) fn font_x_height(_font: &str) -> f32 {
        8.0
    }
    pub(crate) fn register_font(_: &str, _: &[u8], _: u16, _: bool) {}
    pub(crate) fn text_cluster_boxes(
        _: &str,
        _: &str,
        _: f32,
        _: &str,
        ranges: &[[u32; 2]],
        out: &mut [[f32; 2]],
    ) {
        for (r, o) in ranges.iter().zip(out) {
            *o = [r[0] as f32 * 8.0, r[1] as f32 * 8.0];
        }
    }
}

mod clamp;
mod edits;

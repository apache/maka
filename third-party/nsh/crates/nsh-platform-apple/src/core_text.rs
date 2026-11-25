use std::{ptr::NonNull, sync::OnceLock};

use nsh_core::TextAlign;
use objc2_core_foundation::{
    CFAttributedString, CFDictionary, CFMutableAttributedString, CFRange, CFRetained, CFString,
    CFType, CGAffineTransform, CGFloat, CGPoint,
};
use objc2_core_graphics::{CGColor, CGContext, CGLineCap};
use objc2_core_text::{
    CTFont, CTFontSymbolicTraits, CTLine, CTRun, kCTFontAttributeName, kCTRunDelegateAttributeName,
};

struct CFStringKey(CFRetained<CFString>);
// SAFETY: CFStrings are immutable and thread-safe.
unsafe impl Send for CFStringKey {}
// SAFETY: as above.
unsafe impl Sync for CFStringKey {}

fn static_key(slot: &'static OnceLock<CFStringKey>, name: &'static str) -> &'static CFString {
    &slot
        .get_or_init(|| CFStringKey(CFString::from_static_str(name)))
        .0
}

/// Attribute marking struck through characters: drawn by the platform in the
/// text's decoration color.
pub fn strikethrough_key() -> &'static CFString {
    static KEY: OnceLock<CFStringKey> = OnceLock::new();
    static_key(&KEY, "NshStrikethroughColor")
}

/// Attribute marking underlined characters whose line CoreText cannot draw
/// (styled, thick or offset).
pub fn underline_key() -> &'static CFString {
    static KEY: OnceLock<CFStringKey> = OnceLock::new();
    static_key(&KEY, "NshUnderlineColor")
}

/// Attribute carrying how drawn decoration lines look: a `CFArray` of
/// [style, thickness (0: the font's), offset (NaN: the font's)].
pub fn decoration_key() -> &'static CFString {
    static KEY: OnceLock<CFStringKey> = OnceLock::new();
    static_key(&KEY, "NshDecorationStyle")
}

/// Attribute marking the characters of a span background (the node that set it,
/// a `CFNumber`).
pub fn background_key() -> &'static CFString {
    static KEY: OnceLock<CFStringKey> = OnceLock::new();
    static_key(&KEY, "NshBackground")
}

/// Attribute marking the ellipsis token of a truncated line (a `CFNumber`):
/// its run claims the characters it cut, which are not on screen to select.
pub fn ellipsis_key() -> &'static CFString {
    static KEY: OnceLock<CFStringKey> = OnceLock::new();
    static_key(&KEY, "NshEllipsis")
}

/// Whether `run` is an inline attachment's placeholder delegate run.
///
/// # Safety
///
/// `run` must be a valid CoreText run belonging to a laid-out line.
pub unsafe fn is_attachment_run(run: &CTRun) -> bool {
    let key: *const CFString = unsafe { kCTRunDelegateAttributeName };
    // SAFETY: caller guarantees `run` is valid; `kCTRunDelegateAttributeName` is
    // an immutable CoreText key.
    unsafe { run.attributes().contains_ptr_key(key.cast()) }
}

/// The angle synthesized italics lean by: CSS's for `oblique` (14°), the
/// slant browsers and Android give italic text in a font without an
/// italic face.
const OBLIQUE_ANGLE: CGFloat = 14.0;

/// `font` leaning by [`OBLIQUE_ANGLE`]: a shear in its matrix, which
/// `CTLineDraw` draws its glyphs with, their advances unchanged
/// (`CTRunDraw` draws in the context's text matrix: set the run's,
/// `CTRunGetTextMatrix`, first).
pub fn oblique(font: &CTFont) -> CFRetained<CTFont> {
    let skew = CGAffineTransform {
        a: 1.0,
        b: 0.0,
        c: OBLIQUE_ANGLE.to_radians().tan(),
        d: 1.0,
        tx: 0.0,
        ty: 0.0,
    };
    // SAFETY: a valid font; size 0 keeps its size; a live matrix.
    unsafe { font.copy_with_attributes(0.0, &skew, None) }
}

/// The italic face of `font`'s family, if it has one.
pub fn italic_face(font: &CTFont) -> Option<CFRetained<CTFont>> {
    let italic = CTFontSymbolicTraits::TraitItalic;
    // SAFETY: a valid font; size 0 and a null matrix keep its own.
    unsafe { font.copy_with_symbolic_traits(0.0, std::ptr::null(), italic, italic) }
}

/// The font of italic text in `font`: its italic face, or `font` leaning
/// ([`oblique`]) where its family has none (CJK fonts, a family shipped
/// without italics), as CSS synthesizes one (`font-synthesis: style`).
pub fn italic(font: &CTFont) -> CFRetained<CTFont> {
    italic_face(font).unwrap_or_else(|| oblique(font))
}

/// Whether text in `font` comes out slanted: an italic face, or a shear in
/// its matrix.
fn slanted(font: &CTFont) -> bool {
    // SAFETY: a valid font.
    unsafe {
        font.symbolic_traits()
            .contains(CTFontSymbolicTraits::TraitItalic)
            || font.matrix().c != 0.0
    }
}

/// Whether `font` has a glyph for every character of `range` in `text`
/// (CoreText maps line breaks and tabs in every font).
fn covers(font: &CTFont, text: &CFString, range: CFRange) -> bool {
    let len = match usize::try_from(range.length) {
        Ok(len) if len > 0 => len,
        _ => return true,
    };
    let mut chars = vec![0_u16; len];
    let mut glyphs = vec![0_u16; len];
    // SAFETY: `range` lies within the string; both buffers hold its length.
    unsafe {
        text.characters(range, chars.as_mut_ptr());
        font.glyphs_for_characters(
            NonNull::from(&mut chars[..]).cast(),
            NonNull::from(&mut glyphs[..]).cast(),
            range.length,
        )
    }
}

/// Slants the characters of `range` in `string` that CoreText takes from
/// another font than `font`, the range's italic font ([`italic`]), where
/// that font has no italic face: CJK text in the system font's italic,
/// whose fallback fonts are upright, and a family list's fallbacks without
/// one, upright in its cascade list (CoreText ignores a matrix there). Each
/// such run gets its font leaning ([`oblique`]). Text `font` has every
/// character of costs one lookup of its glyphs; call it for italic text
/// only.
pub fn slant_fallbacks(string: &CFMutableAttributedString, range: CFRange, font: &CTFont) {
    let attributed: &CFAttributedString = string;
    let Some(text) = attributed.string() else {
        return;
    };
    if covers(font, &text, range) {
        return;
    }
    // The fonts CoreText typesets the range in: its runs' fonts.
    // SAFETY: a valid string and a range within it.
    let Some(part) = (unsafe { CFAttributedString::with_substring(None, Some(attributed), range) })
    else {
        return;
    };
    // SAFETY: a valid attributed string; the line's own run array (of
    // CTRuns) and attribute dictionaries, whose font values are CTFonts;
    // ranges within the string.
    unsafe {
        let line = CTLine::with_attributed_string(&part);
        let runs = line.glyph_runs();
        for i in 0..runs.count() {
            let run = &*runs.value_at_index(i).cast::<CTRun>();
            let attributes = run.attributes();
            let attributes: &CFDictionary<CFString, CFType> = attributes.cast_unchecked();
            let Some(fallback) = attributes
                .get(kCTFontAttributeName)
                .and_then(|f| f.downcast::<CTFont>().ok())
            else {
                continue;
            };
            if slanted(&fallback) {
                continue;
            }
            let at = run.string_range();
            CFMutableAttributedString::set_attribute(
                Some(string),
                CFRange {
                    location: range.location + at.location,
                    length: at.length,
                },
                Some(kCTFontAttributeName),
                Some(oblique(&fallback).as_ref()),
            );
        }
    }
}

/// Returns `(left, width)` relative to the line's origin for glyph `range` in
/// `run` (`range.length == 0` measures the whole run), reusing `positions`.
/// Returns `None` when the run has no glyphs or zero width.
///
/// # Safety
///
/// `run` must be a valid CoreText run and `range` (if non-empty) must lie
/// within `0..run.glyph_count()`.
pub unsafe fn run_visual_span(
    run: &CTRun,
    range: CFRange,
    positions: &mut Vec<CGPoint>,
) -> Option<(CGFloat, CGFloat)> {
    // SAFETY: caller guarantees `run` is valid.
    let count = unsafe { run.glyph_count() };
    let range = if range.length <= 0 {
        CFRange {
            location: 0,
            length: count,
        }
    } else {
        range
    };
    if range.length <= 0 || count <= 0 {
        return None;
    }
    let len = usize::try_from(range.length).ok()?;
    positions.clear();
    positions.resize(len, CGPoint::new(0.0, 0.0));
    let ptr = NonNull::new(positions.as_mut_ptr())?;
    // SAFETY: `positions` has `range.length` elements and `range` lies within `run`.
    unsafe { run.positions(range, ptr) };
    // In right-to-left runs, glyphs appear visually right-to-left while logical
    // indices and string-index offsets sit at the right edge; taking the
    // minimum glyph x gives the visual left edge in both LTR and RTL runs.
    let left = positions
        .iter()
        .map(|p| p.x)
        .fold(CGFloat::INFINITY, CGFloat::min);
    // SAFETY: null out pointers are documented optional by CoreText.
    let width = unsafe {
        run.typographic_bounds(
            range,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    (width > 0.0 && left.is_finite()).then_some((left, width))
}

/// One decoration line centered on `y` (y-up), `style` as encoded by the
/// text engine: solid, double, dotted, dashed, wavy.
pub fn stroke_decoration(
    cx: &CGContext,
    color: &CGColor,
    style: i32,
    x: CGFloat,
    y: CGFloat,
    width: CGFloat,
    thickness: CGFloat,
) {
    let c = Some(cx);
    CGContext::save_g_state(c);
    CGContext::set_stroke_color_with_color(c, Some(color));
    CGContext::set_line_width(c, thickness);
    let line = |y: CGFloat| {
        CGContext::move_to_point(c, x, y);
        CGContext::add_line_to_point(c, x + width, y);
    };
    match style {
        1 => {
            // Two lines a thickness apart.
            line(y + thickness);
            line(y - thickness);
        }
        2 => {
            let pattern = [0.0, thickness * 2.0];
            // SAFETY: a two-element pattern.
            unsafe { CGContext::set_line_dash(c, 0.0, pattern.as_ptr(), 2) };
            CGContext::set_line_cap(c, CGLineCap::Round);
            line(y);
        }
        3 => {
            let pattern = [thickness * 3.0, thickness * 2.0];
            // SAFETY: a two-element pattern.
            unsafe { CGContext::set_line_dash(c, 0.0, pattern.as_ptr(), 2) };
            line(y);
        }
        4 => {
            // A sine wave, one period per four thicknesses.
            let amplitude = thickness * 1.5;
            let period = (thickness * 4.0).max(4.0);
            let steps = ((width / period) * 8.0).ceil().max(2.0) as usize;
            CGContext::move_to_point(c, x, y);
            for i in 1..=steps {
                let t = width * i as CGFloat / steps as CGFloat;
                let phase = t / period * std::f64::consts::TAU;
                CGContext::add_line_to_point(c, x + t, y + amplitude * phase.sin());
            }
        }
        _ => line(y),
    }
    CGContext::stroke_path(c);
    CGContext::restore_g_state(c);
}

/// Paragraph base direction for the paragraph containing `utf16_offset`, using
/// Unicode UAX #9 rules P2 and P3 (the first strong character outside isolates).
pub fn natural_rtl_at(text: &str, utf16_offset: usize) -> bool {
    use unicode_bidi::{BidiClass, bidi_class};

    let mut paragraph_start = 0;
    let mut utf16 = 0;
    let mut iter = text.char_indices().peekable();
    while let Some((_, ch)) = iter.next() {
        if utf16 >= utf16_offset {
            break;
        }
        utf16 += ch.len_utf16();
        let is_sep = match ch {
            '\r' => {
                if let Some(&(_, '\n')) = iter.peek() {
                    let (_, lf) = iter.next().expect("peeked");
                    utf16 += lf.len_utf16();
                }
                true
            }
            '\n' | '\u{0085}' | '\u{2029}' => true,
            _ => false,
        };
        if is_sep && utf16 <= utf16_offset {
            paragraph_start = iter.peek().map_or(text.len(), |&(next_byte, _)| next_byte);
        }
    }

    let mut isolate_depth = 0usize;
    for ch in text[paragraph_start..].chars() {
        match ch {
            '\n' | '\r' | '\u{0085}' | '\u{2029}' => break,
            // LRI, RLI, FSI open an explicit directional isolate (UAX #9 P2).
            '\u{2066}' | '\u{2067}' | '\u{2068}' => {
                isolate_depth += 1;
                continue;
            }
            // PDI closes the innermost isolate.
            '\u{2069}' => {
                isolate_depth = isolate_depth.saturating_sub(1);
                continue;
            }
            _ => {}
        }
        if isolate_depth > 0 {
            continue;
        }
        match bidi_class(ch) {
            BidiClass::R | BidiClass::AL => return true,
            BidiClass::L => return false,
            _ => {}
        }
    }
    false
}

/// Resolved base writing direction (`true` = RTL) for the paragraph at
/// `utf16_offset`.
pub fn paragraph_is_rtl(writing_direction: Option<bool>, text: &str, utf16_offset: usize) -> bool {
    writing_direction.unwrap_or_else(|| natural_rtl_at(text, utf16_offset))
}

/// CoreText flush factor matching `CTParagraphStyle`'s alignment and writing
/// direction for a line (in particular, a truncated last line).
pub fn flush_factor(align: TextAlign, layout_rtl: bool, paragraph_rtl: bool) -> CGFloat {
    match align {
        TextAlign::Left => 0.0,
        TextAlign::Center => 0.5,
        TextAlign::Right => 1.0,
        TextAlign::Auto => {
            if layout_rtl || paragraph_rtl {
                1.0
            } else {
                0.0
            }
        }
        TextAlign::Justify => {
            if paragraph_rtl {
                1.0
            } else {
                0.0
            }
        }
    }
}

/// Pen origin x for a truncated or clipped `line` in a box `width` wide.
///
/// # Safety
///
/// `line` must be a valid CoreText line.
pub unsafe fn truncated_line_x(
    line: &CTLine,
    align: TextAlign,
    layout_rtl: bool,
    paragraph_rtl: bool,
    width: CGFloat,
) -> CGFloat {
    let flush = flush_factor(align, layout_rtl, paragraph_rtl);
    // SAFETY: caller guarantees `line` is valid.
    let (x, right_flush) = unsafe {
        (
            line.pen_offset_for_flush(flush, width),
            line.pen_offset_for_flush(1.0, width),
        )
    };
    if right_flush < 0.0 {
        // A clipped line wider than the box starts at its inline start edge and
        // overflows its inline end edge (the right edge for RTL paragraphs /
        // RTL Auto layouts, `x = 0` for LTR).
        let rtl_start = match align {
            TextAlign::Auto => layout_rtl || paragraph_rtl,
            _ => paragraph_rtl,
        };
        if rtl_start { right_flush } else { 0.0 }
    } else {
        x
    }
}

#[cfg(test)]
mod tests {
    use std::{ffi::c_void, ptr::NonNull};

    use objc2_core_foundation::{
        CFIndex, CFMutableAttributedString, CFRange, CFRetained, CFString,
    };
    use objc2_core_text::{
        CTFont, CTLine, CTRun, CTRunDelegate, CTRunDelegateCallbacks, kCTFontAttributeName,
        kCTRunDelegateCurrentVersion,
    };

    use super::*;

    fn test_font() -> CFRetained<CTFont> {
        let name = CFString::from_static_str("Helvetica");
        // SAFETY: valid font name and positive size.
        unsafe { CTFont::with_name(&name, 16.0, std::ptr::null()) }
    }

    fn make_line(text: &str) -> CFRetained<CTLine> {
        let attr = CFMutableAttributedString::new(None, 0).expect("CFMutableAttributedString::new");
        let whole = CFRange {
            location: 0,
            length: 0,
        };
        let s = Some(&*attr);
        let content = CFString::from_str(text);
        // SAFETY: valid mutable attributed string and whole range.
        unsafe { CFMutableAttributedString::replace_string(s, whole, Some(&content)) };
        let len = text.encode_utf16().count() as CFIndex;
        let range = CFRange {
            location: 0,
            length: len,
        };
        let font = test_font();
        // SAFETY: valid range and CTFont attribute value.
        unsafe {
            CFMutableAttributedString::set_attribute(
                s,
                range,
                Some(kCTFontAttributeName),
                Some(font.as_ref()),
            );
        }
        // SAFETY: `attr` is a valid CFAttributedString.
        unsafe { CTLine::with_attributed_string(&attr) }
    }

    #[test]
    fn natural_rtl_follows_uax9_p2_p3_per_paragraph() {
        assert!(!natural_rtl_at("Hello world", 0));
        assert!(natural_rtl_at("مرحبا بالعالم", 0));
        assert!(natural_rtl_at("שלום", 0));
        assert!(natural_rtl_at("123 ! مرحبا", 0));
        // Isolates are skipped when determining paragraph direction (UAX #9 P2).
        assert!(natural_rtl_at("\u{2067}Hello\u{2069} مرحبا", 0));
        assert!(!natural_rtl_at("\u{2067}مرحبا\u{2069} Hello", 0));
        // Multi-paragraph strings resolve each paragraph independently.
        let two = "Hello\nمرحبا";
        assert!(!natural_rtl_at(two, 0));
        assert!(natural_rtl_at(two, 6));
        let crlf = "Hello\r\nمرحبا";
        assert!(!natural_rtl_at(crlf, 0));
        assert!(natural_rtl_at(crlf, 7));
        // Soft line break (U+2028) stays in the same paragraph; U+2029 starts a new one.
        assert!(!natural_rtl_at("Hello\u{2028}مرحبا", 6));
        assert!(natural_rtl_at("Hello\u{2029}مرحبا", 6));
        // No strong characters defaults to LTR.
        assert!(!natural_rtl_at("12345...", 0));
    }

    #[test]
    fn run_visual_span_uses_leftmost_glyph_for_rtl_runs_and_detects_delegates() {
        let line = make_line("مرحبا بالعالم");
        // SAFETY: valid line and glyph runs array.
        let runs = unsafe { line.glyph_runs() };
        assert!(runs.count() >= 1);
        let mut rtl_runs = 0;
        let mut positions = Vec::new();
        for i in 0..runs.count() {
            // SAFETY: `i` is within bounds.
            let run = unsafe { &*runs.value_at_index(i).cast::<CTRun>() };
            // SAFETY: valid run.
            assert!(!unsafe { is_attachment_run(run) });
            // SAFETY: valid run.
            let (left, width) = unsafe {
                run_visual_span(
                    run,
                    CFRange {
                        location: 0,
                        length: 0,
                    },
                    &mut positions,
                )
            }
            .expect("non-empty run span");
            assert!(width > 0.0, "expected positive width, got {width}");
            // SAFETY: valid run.
            let is_rtl =
                unsafe { run.status() }.contains(objc2_core_text::CTRunStatus::RightToLeft);
            if is_rtl {
                rtl_runs += 1;
                // CoreText places `run.string_range().location` at the *right* edge of an RTL run;
                // `run_visual_span` must return its visual left edge so decorations stay over glyphs.
                // SAFETY: valid run and line.
                let run_start = unsafe { run.string_range().location };
                // SAFETY: valid line and string index.
                let start_x =
                    unsafe { line.offset_for_string_index(run_start, std::ptr::null_mut()) };
                assert!(
                    (start_x - (left + width)).abs() < 1.0,
                    "run_start ({run_start}) sits at the right edge of RTL run {i}: start_x={start_x}, span=({left}, {width})"
                );
            }
        }
        assert!(rtl_runs >= 1, "expected at least one RTL run");

        // Attachment delegate run is recognized by `is_attachment_run`.
        unsafe extern "C-unwind" fn get_zero(_: NonNull<c_void>) -> CGFloat {
            12.0
        }
        static CALLBACKS: CTRunDelegateCallbacks = CTRunDelegateCallbacks {
            version: kCTRunDelegateCurrentVersion as CFIndex,
            dealloc: None,
            getAscent: Some(get_zero),
            getDescent: Some(get_zero),
            getWidth: Some(get_zero),
        };
        // SAFETY: static callbacks, dangling sentinel pointer never dereferenced.
        let delegate =
            unsafe { CTRunDelegate::new(NonNull::from(&CALLBACKS), std::ptr::dangling_mut()) }
                .expect("CTRunDelegate");
        let attr = CFMutableAttributedString::new(None, 0).expect("CFMutableAttributedString::new");
        let content = CFString::from_static_str("\u{fffc}");
        let s = Some(&*attr);
        // SAFETY: valid attributed string and range.
        unsafe {
            CFMutableAttributedString::replace_string(
                s,
                CFRange {
                    location: 0,
                    length: 0,
                },
                Some(&content),
            );
            CFMutableAttributedString::set_attribute(
                s,
                CFRange {
                    location: 0,
                    length: 1,
                },
                Some(kCTRunDelegateAttributeName),
                Some(delegate.as_ref()),
            );
        }
        // SAFETY: valid attributed string.
        let attach_line = unsafe { CTLine::with_attributed_string(&attr) };
        // SAFETY: valid line.
        let attach_runs = unsafe { attach_line.glyph_runs() };
        assert_eq!(attach_runs.count(), 1);
        // SAFETY: index 0 is within bounds.
        let attach_run = unsafe { &*attach_runs.value_at_index(0).cast::<CTRun>() };
        // SAFETY: valid run.
        assert!(unsafe { is_attachment_run(attach_run) });
    }

    #[test]
    fn truncated_line_x_aligns_rtl_and_clip_overflow() {
        let short = make_line("مرحبا");
        // SAFETY: valid line.
        let short_w = unsafe {
            short.typographic_bounds(
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        let box_w = 240.0;
        // SAFETY: valid line.
        let x_auto = unsafe { truncated_line_x(&short, TextAlign::Auto, false, true, box_w) };
        let x_justify = unsafe { truncated_line_x(&short, TextAlign::Justify, false, true, box_w) };
        assert!((x_auto - (box_w - short_w)).abs() < 0.1, "x_auto={x_auto}");
        assert!(
            (x_justify - (box_w - short_w)).abs() < 0.1,
            "x_justify={x_justify}"
        );
        // `EllipsizeMode::Clip` line wider than the box keeps inline-start at `box_w` for RTL
        // and at `0` for LTR.
        let long_rtl = make_line("مرحبا بالعالم الجميل جدا");
        let long_ltr = make_line("Hello wonderful world of native shell");
        let narrow = 40.0;
        // SAFETY: valid lines.
        let rtl_clip_x =
            unsafe { truncated_line_x(&long_rtl, TextAlign::Auto, false, true, narrow) };
        let rtl_w = unsafe {
            long_rtl.typographic_bounds(
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        let ltr_clip_x =
            unsafe { truncated_line_x(&long_ltr, TextAlign::Auto, false, false, narrow) };
        assert!((rtl_clip_x + rtl_w - narrow).abs() < 0.1, "{rtl_clip_x}");
        assert!(ltr_clip_x.abs() < 0.01, "{ltr_clip_x}");
    }

    /// The system font (SF, with an italic face) at 16 pt.
    fn system_font() -> CFRetained<CTFont> {
        // SAFETY: a UI font type and a positive size.
        unsafe {
            CTFont::new_ui_font_for_language(objc2_core_text::CTFontUIFontType::System, 16.0, None)
        }
        .expect("the system font")
    }

    /// PingFang SC, a CJK font without an italic face, at 16 pt.
    fn ping_fang() -> CFRetained<CTFont> {
        let name = CFString::from_static_str("PingFangSC-Regular");
        // SAFETY: valid font name and positive size.
        unsafe { CTFont::with_name(&name, 16.0, std::ptr::null()) }
    }

    fn lean() -> CGFloat {
        OBLIQUE_ANGLE.to_radians().tan()
    }

    /// `text` set in `font` throughout, as an italic span is.
    fn set_in(text: &str, font: &CTFont) -> (CFRetained<CFMutableAttributedString>, CFRange) {
        let attr = CFMutableAttributedString::new(None, 0).expect("CFMutableAttributedString::new");
        let s = Some(&*attr);
        let range = CFRange {
            location: 0,
            length: text.encode_utf16().count() as CFIndex,
        };
        // SAFETY: a valid mutable attributed string; the range covers it;
        // a CTFont for the font key.
        unsafe {
            CFMutableAttributedString::replace_string(
                s,
                CFRange {
                    location: 0,
                    length: 0,
                },
                Some(&CFString::from_str(text)),
            );
            CFMutableAttributedString::set_attribute(
                s,
                range,
                Some(kCTFontAttributeName),
                Some(font.as_ref()),
            );
        }
        (attr, range)
    }

    /// The typeset runs of `string`: each one's text, its font's shear and
    /// whether that font is an italic face.
    fn typeset(string: &CFMutableAttributedString) -> Vec<(String, CGFloat, bool)> {
        let attributed: &CFAttributedString = string;
        let text = attributed.string().expect("a string").to_string();
        let utf16: Vec<u16> = text.encode_utf16().collect();
        // SAFETY: a valid attributed string; the line's own run array (of
        // CTRuns) and attribute dictionaries, whose font values are CTFonts.
        unsafe {
            let line = CTLine::with_attributed_string(attributed);
            let runs = line.glyph_runs();
            (0..runs.count())
                .map(|i| {
                    let run = &*runs.value_at_index(i).cast::<CTRun>();
                    let attributes = run.attributes();
                    let attributes: &CFDictionary<CFString, CFType> = attributes.cast_unchecked();
                    let font = attributes
                        .get(kCTFontAttributeName)
                        .and_then(|f| f.downcast::<CTFont>().ok())
                        .expect("a font");
                    let at = run.string_range();
                    let (start, end) = (at.location as usize, (at.location + at.length) as usize);
                    (
                        String::from_utf16_lossy(&utf16[start..end]),
                        font.matrix().c,
                        font.symbolic_traits()
                            .contains(CTFontSymbolicTraits::TraitItalic),
                    )
                })
                .collect()
        }
    }

    #[test]
    fn italic_is_the_italic_face_or_the_font_leaning() {
        let face = italic(&system_font());
        let leaning = italic(&ping_fang());
        // SAFETY: valid fonts.
        unsafe {
            assert!(
                face.symbolic_traits()
                    .contains(CTFontSymbolicTraits::TraitItalic)
            );
            assert_eq!(face.matrix().c, 0.0);
            assert!(italic_face(&ping_fang()).is_none());
            assert!((leaning.matrix().c - lean()).abs() < 1e-9);
            assert_eq!(leaning.size(), 16.0);
            assert_eq!(
                leaning.family_name().to_string(),
                ping_fang().family_name().to_string()
            );
        }
    }

    /// The system font's italic face falls back to upright PingFang for
    /// CJK: those runs lean, the face's own runs keep their shapes.
    #[test]
    fn cjk_in_the_system_italic_leans() {
        let font = italic(&system_font());
        let (string, range) = set_in("Italic 斜体中文 ABC", &font);
        assert!(
            typeset(&string)
                .iter()
                .any(|(text, c, _)| text == "斜体中文" && *c == 0.0),
            "upright before"
        );
        slant_fallbacks(&string, range, &font);
        let runs = typeset(&string);
        for &(ref text, c, face) in &runs {
            if text.contains('斜') {
                assert!(!face && (c - lean()).abs() < 1e-9, "{runs:?}");
            } else {
                assert!(face && c == 0.0, "{runs:?}");
            }
        }
        assert!(runs.iter().any(|(text, ..)| text == "斜体中文"), "{runs:?}");
    }

    /// The fonts CoreText falls back to from a leaning font lean with it
    /// (Hangul from PingFang's lean): their runs are left as set.
    #[test]
    fn fallbacks_of_a_leaning_font_lean_with_it() {
        let font = italic(&ping_fang());
        let (string, range) = set_in("苹方 한글", &font);
        let runs = typeset(&string);
        assert!(
            runs.iter()
                .any(|(text, c, _)| text == "한글" && (c - lean()).abs() < 1e-9),
            "{runs:?}"
        );
        slant_fallbacks(&string, range, &font);
        let mut effective = CFRange {
            location: 0,
            length: 0,
        };
        // SAFETY: a valid string, a location within it, a live out range.
        unsafe { string.attribute(0, Some(kCTFontAttributeName), &mut effective) };
        assert_eq!((effective.location, effective.length), (0, range.length));
    }

    /// Text the font has every character of, line breaks included, is
    /// left as it was set: one font throughout.
    #[test]
    fn text_the_italic_face_has_is_left_as_set() {
        let font = italic(&system_font());
        let whole = |s: &str| CFRange {
            location: 0,
            length: s.encode_utf16().count() as CFIndex,
        };
        let latin = "Italic text,\nits second line\r\nand a third";
        assert!(covers(&font, &CFString::from_str(latin), whole(latin)));
        assert!(!covers(
            &font,
            &CFString::from_static_str("Italic 斜体"),
            whole("Italic 斜体")
        ));
        let (string, range) = set_in(latin, &font);
        slant_fallbacks(&string, range, &font);
        let mut effective = CFRange {
            location: 0,
            length: 0,
        };
        // SAFETY: a valid string, a location within it, a live out range.
        let set = unsafe { string.attribute(0, Some(kCTFontAttributeName), &mut effective) };
        assert!(set.is_some_and(|f| std::ptr::eq((&*f as *const CFType).cast::<CTFont>(), &*font)));
        assert_eq!((effective.location, effective.length), (0, range.length));
    }
}

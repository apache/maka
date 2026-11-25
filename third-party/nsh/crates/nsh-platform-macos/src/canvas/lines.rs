//! The laid out lines of a canvas's `fillText` / `strokeText`, by text and
//! font, kept across paints as Windows and Linux keep their layouts.
//!
//! Without them every paint made a `CTFont` (with its cascade list), an
//! attributed string and a `CTLine` for each text: a window being resized
//! repaints each canvas every frame on the main thread, and that was most
//! of the replay of a text-heavy canvas (a quote table).
//!
//! A line holds no color: its text takes the context's
//! (`kCTForegroundColorFromContextAttributeName`), so one line serves fills
//! and strokes in any paint.
//!
//! Bounded: lines are added up to [`MAX_LINES`]; when a canvas gets a new
//! drawing ([`TextCache::trim`]) only the lines the previous one drew stay
//! (texts that change, such as live prices, are dropped with the drawings
//! that had them).

use std::sync::Arc;

use nsh_core::canvas::CanvasFont;
use objc2_core_foundation::{
    CFAttributedString, CFBoolean, CFMutableAttributedString, CFRange, CFRetained, CFString, CFType,
};
use objc2_core_text::{
    CTFont, CTLine, kCTFontAttributeName, kCTForegroundColorFromContextAttributeName,
};
use rustc_hash::FxHashMap;

/// Lines a canvas keeps.
pub(super) const MAX_LINES: usize = 1024;
/// Fonts a canvas keeps; a drawing rarely uses more than a few.
const MAX_FONTS: usize = 32;

/// A [`CanvasFont`] (with `fontVariantNumeric` applied) as a hash key:
/// everything that picks or shapes its glyphs.
#[derive(Clone, PartialEq, Eq, Hash)]
struct FontKey {
    size: u32,
    weight: u16,
    italic: bool,
    family: Option<Arc<str>>,
    variant: u8,
}

impl FontKey {
    fn new(font: &CanvasFont) -> Self {
        FontKey {
            size: font.size.0.to_bits(),
            weight: font.weight,
            italic: font.italic,
            family: font.family.clone(),
            variant: font.variant.0,
        }
    }
}

/// A text laid out on one line, and its typographic bounds.
#[derive(Clone)]
pub(super) struct TextLine {
    pub(super) line: CFRetained<CTLine>,
    pub(super) width: f64,
    pub(super) ascent: f64,
    pub(super) descent: f64,
}

struct Entry {
    line: TextLine,
    /// The [`TextCache::generation`] it was last drawn in.
    used: u32,
}

/// A canvas's fonts and lines ([`CanvasState`](super::CanvasState)).
#[derive(Default)]
pub(super) struct TextCache {
    fonts: FxHashMap<FontKey, CFRetained<CTFont>>,
    lines: FxHashMap<(Arc<str>, FontKey), Entry>,
    /// Counts the canvas's drawings ([`TextCache::trim`]).
    generation: u32,
    /// [`crate::text::fonts_registered`] when the fonts and lines were made.
    registered: u32,
}

impl TextCache {
    /// Called for each new drawing: keeps the lines the previous drawing
    /// drew and drops the rest.
    pub(super) fn trim(&mut self) {
        let generation = self.generation;
        self.lines.retain(|_, e| e.used == generation);
        self.generation = generation.wrapping_add(1);
    }

    /// `text` in `font` on one line.
    pub(super) fn line(&mut self, text: &Arc<str>, font: &CanvasFont) -> TextLine {
        let registered = crate::text::fonts_registered();
        if registered != self.registered {
            self.registered = registered;
            self.fonts.clear();
            self.lines.clear();
        }
        let key = (text.clone(), FontKey::new(font));
        if let Some(entry) = self.lines.get_mut(&key) {
            entry.used = self.generation;
            return entry.line.clone();
        }
        let ct_font = self.font(&key.1, font);
        let line = make_line(text, &ct_font, font.italic);
        // Past the bound, the drawing's further texts are laid out per paint.
        if self.lines.len() < MAX_LINES {
            self.lines.insert(
                key,
                Entry {
                    line: line.clone(),
                    used: self.generation,
                },
            );
        }
        line
    }

    fn font(&mut self, key: &FontKey, font: &CanvasFont) -> CFRetained<CTFont> {
        if let Some(f) = self.fonts.get(key) {
            return f.clone();
        }
        if self.fonts.len() >= MAX_FONTS {
            // Lines keep their own fonts.
            self.fonts.clear();
        }
        let f = crate::text::make_font(&font.text_style());
        self.fonts.insert(key.clone(), f.clone());
        f
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.lines.len()
    }
}

/// `text` in `font` as a `CTLine` whose glyphs take the context's color.
fn make_line(text: &str, font: &CTFont, italic: bool) -> TextLine {
    let string = CFMutableAttributedString::new(None, 0).expect("CFAttributedStringCreateMutable");
    let whole = CFRange {
        location: 0,
        length: 0,
    };
    // SAFETY: a valid mutable string; attribute values have the types
    // CoreText expects for their keys; the range covers the string.
    unsafe {
        CFMutableAttributedString::replace_string(
            Some(&string),
            whole,
            Some(&CFString::from_str(text)),
        );
        let range = CFRange {
            location: 0,
            length: CFAttributedString::length(&string),
        };
        CFMutableAttributedString::set_attribute(
            Some(&string),
            range,
            Some(kCTFontAttributeName),
            Some(font.as_ref()),
        );
        let yes: &CFType = CFBoolean::new(true).as_ref();
        CFMutableAttributedString::set_attribute(
            Some(&string),
            range,
            Some(kCTForegroundColorFromContextAttributeName),
            Some(yes),
        );
    }
    if italic {
        // Text in fallback fonts without an italic face (CJK) leans too.
        let range = CFRange {
            location: 0,
            length: CFAttributedString::length(&string),
        };
        nsh_platform_apple::core_text::slant_fallbacks(&string, range, font);
    }
    // SAFETY: a valid attributed string.
    let line = unsafe { CTLine::with_attributed_string(&string) };
    let (mut ascent, mut descent, mut leading) = (0.0, 0.0, 0.0);
    // SAFETY: valid out pointers.
    let width = unsafe { line.typographic_bounds(&mut ascent, &mut descent, &mut leading) };
    TextLine {
        line,
        width,
        ascent,
        descent,
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{FontVariant, geometry::Points};

    use super::*;

    fn font(size: f32) -> CanvasFont {
        CanvasFont {
            size: Points(size),
            ..CanvasFont::default()
        }
    }

    #[test]
    fn the_same_text_and_font_reuse_one_line() {
        let mut cache = TextCache::default();
        let text: Arc<str> = "123.45".into();
        let a = cache.line(&text, &font(12.0));
        // Another string with the same characters, as a new drawing has.
        let b = cache.line(&Arc::from("123.45"), &font(12.0));
        assert!(std::ptr::eq(&*a.line, &*b.line));
        assert_eq!(cache.len(), 1);
    }

    #[test]
    fn whatever_shapes_the_glyphs_takes_its_own_line() {
        let mut cache = TextCache::default();
        let text: Arc<str> = "1111".into();
        let base = font(12.0);
        let fonts = [
            base.clone(),
            font(13.0),
            CanvasFont {
                weight: 700,
                ..base.clone()
            },
            CanvasFont {
                italic: true,
                ..base.clone()
            },
            CanvasFont {
                family: Some("Menlo".into()),
                ..base.clone()
            },
            base.with_numeric(FontVariant(FontVariant::TABULAR_NUMS)),
        ];
        let lines: Vec<_> = fonts.iter().map(|f| cache.line(&text, f)).collect();
        assert_eq!(cache.len(), fonts.len());
        for (i, a) in lines.iter().enumerate() {
            for b in &lines[i + 1..] {
                assert!(!std::ptr::eq(&*a.line, &*b.line));
            }
        }
        // Wider at a larger size, as made afresh.
        assert!(lines[1].width > lines[0].width);
        let fresh = make_line("1111", &crate::text::make_font(&base.text_style()), false);
        assert_eq!(lines[0].width, fresh.width);
    }

    #[test]
    fn a_new_drawing_keeps_only_the_lines_the_last_one_drew() {
        let mut cache = TextCache::default();
        let f = font(12.0);
        cache.line(&"a".into(), &f);
        cache.line(&"b".into(), &f);
        cache.trim();
        // The next drawing draws "b" and "c" only.
        cache.line(&"b".into(), &f);
        cache.line(&"c".into(), &f);
        assert_eq!(cache.len(), 3);
        cache.trim();
        assert_eq!(cache.len(), 2, "\"a\" went");
    }

    #[test]
    fn lines_stay_bounded() {
        let mut cache = TextCache::default();
        let f = font(12.0);
        for i in 0..MAX_LINES + 10 {
            cache.line(&i.to_string().into(), &f);
        }
        assert_eq!(cache.len(), MAX_LINES);
        // Live prices: every drawing draws new texts.
        for round in 0..4 {
            cache.trim();
            for i in 0..MAX_LINES / 2 {
                cache.line(&format!("{round}-{i}").into(), &f);
            }
            assert!(cache.len() <= MAX_LINES);
        }
        cache.trim();
        assert_eq!(cache.len(), MAX_LINES / 2, "only the last drawing's");
    }
}

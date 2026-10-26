//! CoreText text engine: typesets on the engine thread, draws on the main
//! thread from finished `CTLine`s, so every text is laid out once.

use std::{cell::RefCell, ffi::c_void, ptr::NonNull};

use nsh_core::{
    Affinity, AttributedText, Color, EllipsizeMode, FontFamily, Point, Points, ResolvedTextStyle,
    Size, TextAlign, TextEngine, TextLayout, TextPosition,
};
use objc2::rc::Retained;
use objc2_core_foundation::{
    CFArray, CFAttributedString, CFDictionary, CFIndex, CFMutableAttributedString, CFNumber,
    CFRange, CFRetained, CFString, CFType, CFURL, CGFloat, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{CGColor, CGPath};
use objc2_core_text::{
    CTFont, CTFontDescriptor, CTFontManagerRegisterFontsForURL, CTFontManagerScope,
    CTFontSymbolicTraits, CTFrame, CTFramesetter, CTLine, CTLineTruncationType, CTParagraphStyle,
    CTParagraphStyleSetting, CTParagraphStyleSpecifier, CTRun, CTRunDelegate,
    CTRunDelegateCallbacks, CTRunStatus, CTTextAlignment, CTTypesetter, CTWritingDirection,
    kCTFontAttributeName, kCTFontFamilyNameAttribute, kCTFontFeatureSettingsAttribute,
    kCTFontOpenTypeFeatureTag, kCTFontOpenTypeFeatureValue, kCTFontTraitsAttribute,
    kCTFontWeightTrait, kCTForegroundColorAttributeName, kCTKernAttributeName,
    kCTParagraphStyleAttributeName, kCTRunDelegateAttributeName, kCTRunDelegateCurrentVersion,
    kCTUnderlineColorAttributeName, kCTUnderlineStyleAttributeName,
};
use objc2_ui_kit::{
    UIFont, UIFontWeight, UIFontWeightBlack, UIFontWeightBold, UIFontWeightHeavy,
    UIFontWeightLight, UIFontWeightMedium, UIFontWeightRegular, UIFontWeightSemibold,
    UIFontWeightThin, UIFontWeightUltraLight,
};
use rustc_hash::FxHashMap;

/// Attribute carrying the strikethrough color: CoreText draws underlines
/// but not strikethroughs, so [`crate::text_view::TextView`] draws those.
pub(crate) fn strikethrough_key() -> &'static CFString {
    static KEY: std::sync::OnceLock<CFStringKey> = std::sync::OnceLock::new();
    &KEY.get_or_init(|| CFStringKey(CFString::from_static_str("NshStrikethroughColor")))
        .0
}

/// Attribute carrying the color of an underline CoreText cannot draw
/// (styled, thick or offset): [`crate::text_view::TextView`] draws it.
pub(crate) fn underline_key() -> &'static CFString {
    static KEY: std::sync::OnceLock<CFStringKey> = std::sync::OnceLock::new();
    &KEY.get_or_init(|| CFStringKey(CFString::from_static_str("NshUnderlineColor")))
        .0
}

/// Attribute carrying how drawn decoration lines look: a `CFArray` of
/// [style, thickness (0: the font's), offset (NaN: the font's)].
pub(crate) fn decoration_key() -> &'static CFString {
    static KEY: std::sync::OnceLock<CFStringKey> = std::sync::OnceLock::new();
    &KEY.get_or_init(|| CFStringKey(CFString::from_static_str("NshDecorationStyle")))
        .0
}

/// Attribute marking the characters of a span background (the node that
/// set it, a `CFNumber`): CoreText splits runs where it changes, so
/// the text view fills each background behind its own runs.
fn background_key() -> &'static CFString {
    static KEY: std::sync::OnceLock<CFStringKey> = std::sync::OnceLock::new();
    &KEY.get_or_init(|| CFStringKey(CFString::from_static_str("NshBackground")))
        .0
}

/// Attribute marking the ellipsis token of a truncated line (a `CFNumber`):
/// its run claims the characters it cut, which are not on screen to select.
fn ellipsis_key() -> &'static CFString {
    static KEY: std::sync::OnceLock<CFStringKey> = std::sync::OnceLock::new();
    &KEY.get_or_init(|| CFStringKey(CFString::from_static_str("NshEllipsis")))
        .0
}

struct CFStringKey(CFRetained<CFString>);
// SAFETY: CFStrings are immutable and thread-safe.
unsafe impl Send for CFStringKey {}
// SAFETY: as above.
unsafe impl Sync for CFStringKey {}

/// Identifies a font: size bits, weight, family, italic, OpenType features.
type FontKey = (u32, u16, Option<FontFamily>, bool, u8);

/// Caches fonts. Bounded: an app animating `fontSize` would otherwise grow
/// it without limit.
#[derive(Default)]
struct FontCache {
    fonts: RefCell<FxHashMap<FontKey, CFRetained<CTFont>>>,
}

impl FontCache {
    const MAX: usize = 64;

    fn get(&self, style: &ResolvedTextStyle) -> CFRetained<CTFont> {
        let key = (
            style.font_size.0.to_bits(),
            style.font_weight,
            style.font_family,
            style.italic,
            style.font_variant.0,
        );
        let mut fonts = self.fonts.borrow_mut();
        if let Some(font) = fonts.get(&key) {
            return font.clone();
        }
        if fonts.len() >= Self::MAX {
            fonts.clear();
        }
        let font = make_font(style);
        fonts.insert(key, font.clone());
        font
    }

    fn clear(&self) {
        self.fonts.borrow_mut().clear();
    }
}

pub(crate) fn make_font(style: &ResolvedTextStyle) -> CFRetained<CTFont> {
    let size = style.font_size.0 as CGFloat;
    let font = style
        .font_family
        .and_then(|family| {
            let name = family.name();
            generic_font(&name, size, style.font_weight)
                .unwrap_or_else(|| family_font(&name, size, style.font_weight))
        })
        .unwrap_or_else(|| system_font(size, style.font_weight));
    let font = if style.italic {
        let italic = CTFontSymbolicTraits::TraitItalic;
        // SAFETY: a valid font; size 0 keeps the size, null matrix keeps it.
        unsafe { font.copy_with_symbolic_traits(0.0, std::ptr::null(), italic, italic) }
            // No italic face: keep the upright one, as web browsers do (they
            // synthesize an oblique; CoreText cannot).
            .unwrap_or(font)
    } else {
        font
    };
    with_features(font, style.font_variant)
}

/// `font` with the OpenType features of `variant` (`fontVariant`).
fn with_features(font: CFRetained<CTFont>, variant: nsh_core::FontVariant) -> CFRetained<CTFont> {
    if variant.0 == 0 {
        return font;
    }
    let one = CFNumber::new_i32(1);
    let features: Vec<CFRetained<CFDictionary<CFString, CFType>>> = variant
        .tags()
        .map(|tag| {
            let tag = CFString::from_str(tag);
            // SAFETY: immutable CoreText constants.
            let keys = unsafe { [kCTFontOpenTypeFeatureTag, kCTFontOpenTypeFeatureValue] };
            CFDictionary::from_slices(&keys, &[tag.as_ref(), one.as_ref()])
        })
        .collect();
    let features = CFArray::from_retained_objects(&features);
    // SAFETY: an immutable CoreText constant.
    let key = unsafe { kCTFontFeatureSettingsAttribute };
    let attributes = CFDictionary::<CFString, CFType>::from_slices(&[key], &[features.as_ref()]);
    // SAFETY: attribute values have the types CoreText documents; size 0
    // and a null matrix keep the font's.
    unsafe {
        let descriptor = CTFontDescriptor::with_attributes(attributes.as_opaque());
        font.copy_with_attributes(0.0, std::ptr::null(), Some(&descriptor))
    }
}

/// The font of `style` as a `UIFont` (toll-free bridged with `CTFont`), for
/// UIKit text views such as inputs.
pub(crate) fn ui_font(style: &ResolvedTextStyle) -> Retained<UIFont> {
    let font = make_font(style);
    let ptr = CFRetained::into_raw(font).as_ptr().cast::<UIFont>();
    // SAFETY: toll-free bridging; ownership of the +1 reference moves over.
    unsafe { Retained::from_raw(ptr).expect("non-null font") }
}

/// CSS generic families (`font-mono`, `font-serif`): the system font's
/// designs. `Some(None)` is the plain system font; `None` is not generic.
fn generic_font(family: &str, size: CGFloat, weight: u16) -> Option<Option<CFRetained<CTFont>>> {
    use objc2_ui_kit::{
        UIFontDescriptorSystemDesign, UIFontDescriptorSystemDesignRounded,
        UIFontDescriptorSystemDesignSerif,
    };
    let design: &UIFontDescriptorSystemDesign = match family {
        "system-ui" | "sans-serif" | "ui-sans-serif" | "-apple-system" => return Some(None),
        "monospace" | "ui-monospace" => {
            let font = UIFont::monospacedSystemFontOfSize_weight(size, font_weight(weight));
            return Some(Some(bridge(font)));
        }
        // SAFETY: immutable UIKit constants.
        "serif" | "ui-serif" => unsafe { UIFontDescriptorSystemDesignSerif },
        "ui-rounded" => unsafe { UIFontDescriptorSystemDesignRounded },
        _ => return None,
    };
    let base = UIFont::systemFontOfSize_weight(size, font_weight(weight));
    // SAFETY: a plain getter of a valid font.
    let descriptor = unsafe { base.fontDescriptor() };
    let font = descriptor
        .fontDescriptorWithDesign(design)
        .map(|d| UIFont::fontWithDescriptor_size(&d, size))
        .unwrap_or(base);
    Some(Some(bridge(font)))
}

/// A `UIFont` as the `CTFont` it is (toll-free bridged).
fn bridge(font: Retained<UIFont>) -> CFRetained<CTFont> {
    let ptr = Retained::into_raw(font).cast::<CTFont>();
    // SAFETY: toll-free bridging; ownership of the +1 reference moves over.
    unsafe { CFRetained::from_raw(NonNull::new(ptr).expect("non-null font")) }
}

/// A font of an installed or registered family, or `None` (logged) if the
/// family does not exist.
fn family_font(family: &str, size: CGFloat, weight: u16) -> Option<CFRetained<CTFont>> {
    let name = CFString::from_str(family);
    let weight = CFNumber::new_cgfloat(font_weight(weight));
    let traits = CFDictionary::<CFString, CFType>::from_slices(
        // SAFETY: immutable CoreText constants.
        &[unsafe { kCTFontWeightTrait }],
        &[weight.as_ref()],
    );
    // SAFETY: immutable CoreText constants.
    let keys = unsafe { [kCTFontFamilyNameAttribute, kCTFontTraitsAttribute] };
    let attributes =
        CFDictionary::<CFString, CFType>::from_slices(&keys, &[name.as_ref(), traits.as_ref()]);
    // SAFETY: attribute values have the types CoreText documents.
    let font = unsafe {
        let descriptor = CTFontDescriptor::with_attributes(attributes.as_opaque());
        CTFont::with_font_descriptor(&descriptor, size, std::ptr::null())
    };
    // An unknown family silently resolves to a default font: detect it.
    // SAFETY: a valid font.
    let resolved = unsafe { font.family_name() }.to_string();
    if resolved.eq_ignore_ascii_case(family) {
        Some(font)
    } else {
        log::warn!("font family `{family}` is not available; using the system font");
        None
    }
}

/// The system font as a `CTFont`. `UIFont` is toll-free bridged with
/// `CTFont`, and the UIKit constructor is the supported way to get the
/// system font at an arbitrary weight.
fn system_font(size: CGFloat, weight: u16) -> CFRetained<CTFont> {
    let font: Retained<UIFont> = UIFont::systemFontOfSize_weight(size, font_weight(weight));
    let ptr = Retained::into_raw(font).cast::<CTFont>();
    // SAFETY: toll-free bridging; ownership of the +1 reference moves over.
    unsafe { CFRetained::from_raw(NonNull::new(ptr).expect("non-null font")) }
}

fn font_weight(weight: u16) -> UIFontWeight {
    // SAFETY: UIKit's font weight constants are immutable statics.
    unsafe {
        match weight {
            0..=149 => UIFontWeightUltraLight,
            150..=249 => UIFontWeightThin,
            250..=349 => UIFontWeightLight,
            350..=449 => UIFontWeightRegular,
            450..=549 => UIFontWeightMedium,
            550..=649 => UIFontWeightSemibold,
            650..=749 => UIFontWeightBold,
            750..=849 => UIFontWeightHeavy,
            _ => UIFontWeightBlack,
        }
    }
}

pub(crate) fn cg_color(color: Color) -> CFRetained<CGColor> {
    let (r, g, b, a) = color.to_f64();
    CGColor::new_srgb(r, g, b, a)
}

/// The font of the first run of `line`.
fn line_font(line: &CTLine) -> Option<CFRetained<CTFont>> {
    // SAFETY: the line's own run array (of CTRuns) and attribute
    // dictionary, whose font value is a CTFont.
    unsafe {
        let runs = line.glyph_runs();
        if runs.count() == 0 {
            return None;
        }
        let run = &*runs.value_at_index(0).cast::<objc2_core_text::CTRun>();
        let attributes = run.attributes();
        let attributes: &objc2_core_foundation::CFDictionary<CFString, CFType> =
            attributes.cast_unchecked();
        attributes
            .get(kCTFontAttributeName)
            .and_then(|f| f.downcast::<CTFont>().ok())
    }
}

/// Typesetting state of one text content.
pub struct Prepared {
    framesetter: CFRetained<CTFramesetter>,
    string: CFRetained<CFMutableAttributedString>,
    /// String length in UTF-16 units.
    length: CFIndex,
    max_lines: u32,
    ellipsize: EllipsizeMode,
    align: TextAlign,
    /// Attachments: placeholder offset (UTF-16) and how far its top is
    /// above the baseline (`TextAttachment::ascent`).
    attachments: Vec<(CFIndex, CGFloat)>,
    /// The hard line breaks: UTF-16 offset and length (2 for CRLF), in order.
    breaks: Vec<(CFIndex, CFIndex)>,
}

/// A finished line and its origin (CoreText's y-up space, from the bottom of
/// the box).
pub(crate) struct LaidLine {
    pub(crate) line: CFRetained<CTLine>,
    pub(crate) origin: CGPoint,
    /// Its characters in the text (before any ellipsis).
    pub(crate) range: CFRange,
    /// Where its caret positions end: `range`'s end, before a hard break
    /// that ends the line (the caret never goes after it). A truncated
    /// line can display the original text's suffix, up to its full length.
    pub(crate) caret_end: CFIndex,
    /// An ellipsis stands for the text after `range`.
    pub(crate) truncated: bool,
}

/// A laid out line in content coordinates (y down), for hit testing.
pub(crate) struct LineBox<'a> {
    line: &'a LaidLine,
    /// Its characters (`start..end`, the caret positions up to `caret_end`).
    pub(crate) start: usize,
    pub(crate) end: usize,
    caret_end: usize,
    /// The x of its origin.
    x: CGFloat,
    /// As `TextEngine::lines` reports it: ascent, descent and leading high.
    top: CGFloat,
    height: CGFloat,
    width: CGFloat,
}

impl LineBox<'_> {
    /// The x of the caret before character `index`.
    pub(crate) fn x_of(&self, index: usize) -> CGFloat {
        let index = isize::try_from(index).unwrap_or(isize::MAX);
        // SAFETY: a valid line; no secondary offset wanted.
        self.x
            + unsafe {
                self.line
                    .line
                    .offset_for_string_index(index, std::ptr::null_mut())
            }
    }

    /// The caret index nearest to `x`.
    pub(crate) fn index_at(&self, x: CGFloat) -> usize {
        // SAFETY: a valid line.
        let index = unsafe {
            self.line
                .line
                .string_index_for_position(CGPoint::new(x - self.x, 0.0))
        };
        usize::try_from(index)
            .unwrap_or(0)
            .clamp(self.start, self.caret_end)
    }

    /// Fills `spans` with the stretches of x the characters `a..b` cover,
    /// left to right, adjacent ones joined: one per run (bidirectional text
    /// splits a range), through the line's end when the range goes on past
    /// it. The ellipsis token is never covered.
    fn spans(&self, a: usize, b: usize, spans: &mut Vec<(CGFloat, CGFloat)>) {
        let (a, b) = (a as CFIndex, b as CFIndex);
        let (start, end) = (self.start as CFIndex, self.end as CFIndex);
        spans.clear();
        let past = b > end;
        let (a, b) = (a.max(start), b.min(end));
        let (mut text_left, mut text_right) = (CGFloat::INFINITY, CGFloat::NEG_INFINITY);
        let (mut first_rtl, mut last_rtl) = (false, false);
        // SAFETY: the line's own run array (of CTRuns).
        let runs = unsafe { self.line.line.glyph_runs() };
        for i in 0..runs.count() {
            // SAFETY: an index within the array.
            let run = unsafe { &*runs.value_at_index(i).cast::<CTRun>() };
            // SAFETY: a valid run; an immutable key of ours.
            let (range, status, glyphs, token) = unsafe {
                let key: *const CFString = ellipsis_key();
                (
                    run.string_range(),
                    run.status(),
                    run.glyph_count(),
                    run.attributes().contains_ptr_key(key.cast()),
                )
            };
            if token || glyphs <= 0 {
                continue;
            }
            let mut origin = CGPoint::new(0.0, 0.0);
            // SAFETY: one position (the run has a glyph) into a one-point
            // buffer, and the whole run's width.
            let width = unsafe {
                run.positions(
                    CFRange {
                        location: 0,
                        length: 1,
                    },
                    NonNull::from(&mut origin),
                );
                run.typographic_bounds(
                    WHOLE,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            };
            let (left, right) = (self.x + origin.x, self.x + origin.x + width);
            let rtl = status.contains(CTRunStatus::RightToLeft);
            text_left = text_left.min(left);
            text_right = text_right.max(right);
            let run_end = range.location + range.length;
            if range.location <= start {
                first_rtl = rtl;
            }
            if run_end >= end {
                last_rtl = rtl;
            }
            let (s, e) = (a.max(range.location), b.min(run_end));
            if s >= e {
                continue;
            }
            // A run's own edges, not the offsets of the characters beyond
            // it, which belong to the next run.
            let edge = |index: CFIndex| {
                if index <= range.location {
                    if rtl { right } else { left }
                } else if index >= run_end {
                    if rtl { left } else { right }
                } else {
                    self.x_of(index as usize)
                }
            };
            let (x1, x2) = (edge(s), edge(e));
            spans.push((x1.min(x2), x1.max(x2)));
        }
        if spans.is_empty() {
            return;
        }
        spans.sort_by(|p, q| p.0.total_cmp(&q.0));
        if past {
            // The line's end is its left side in right-to-left text.
            if first_rtl && last_rtl {
                if let Some(first) = spans.first_mut() {
                    first.0 = text_left;
                }
            } else if let Some(last) = spans.last_mut() {
                last.1 = last.1.max(text_right);
            }
        }
        // `dedup_by` hands each span with the last one kept: touching spans
        // join into it.
        spans.dedup_by(|(left, right), kept| {
            let joins = *left <= kept.1 + 0.01;
            if joins {
                kept.1 = kept.1.max(*right);
            }
            joins
        });
    }

    /// The bottom edge.
    pub(crate) fn bottom(&self) -> CGFloat {
        self.top + self.height
    }
}

/// The index of the line of `lines` holding offset `at` on the side
/// `affinity` says (as [`TextPosition::line`] does for `TextLine`s): the
/// one containing it, the earlier of two for `Upstream` at a wrap; past
/// every line, the last one starting at or before it. `None` without lines.
pub(crate) fn line_of(lines: &[LineBox], at: usize, affinity: Affinity) -> Option<usize> {
    let unit = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    TextPosition::new(unit(at), affinity).line_in(lines.iter().map(|l| unit(l.start)..unit(l.end)))
}

impl CoreTextLayout {
    /// The lines in content coordinates.
    pub(crate) fn boxes(&self) -> Vec<LineBox<'_>> {
        self.lines
            .iter()
            .map(|l| {
                let (mut ascent, mut descent, mut leading) = (0.0, 0.0, 0.0);
                // SAFETY: a valid line and out pointers.
                let width = unsafe {
                    l.line
                        .typographic_bounds(&mut ascent, &mut descent, &mut leading)
                } as CGFloat;
                let start = usize::try_from(l.range.location).unwrap_or(0);
                let end = if l.truncated {
                    usize::try_from(l.caret_end).unwrap_or(start)
                } else {
                    start.saturating_add(usize::try_from(l.range.length).unwrap_or(0))
                };
                LineBox {
                    line: l,
                    start,
                    end,
                    caret_end: usize::try_from(l.caret_end)
                        .unwrap_or(end)
                        .clamp(start, end),
                    x: l.origin.x,
                    top: self.height - l.origin.y - ascent,
                    height: ascent + descent + leading,
                    width,
                }
            })
            .collect()
    }

    /// The caret position nearest to `point` (content coordinates): the line
    /// at its height (the first above the text, the last below it), then the
    /// caret edge nearest on it. Past the end of a line that continues in
    /// the next (or an ellipsis) the position is the line's end, upstream.
    pub(crate) fn position_at(&self, point: CGPoint) -> TextPosition {
        let lines = self.boxes();
        let Some(l) = lines.iter().find(|l| point.y < l.bottom()).or(lines.last()) else {
            return TextPosition::default();
        };
        let at = l.index_at(point.x);
        // A line ending in a hard break ends before it: the position there
        // is the end of that line, not the start of the next.
        let wrapped = l.caret_end == l.end;
        let affinity = if at == l.end && wrapped && at > l.start {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        TextPosition::new(u32::try_from(at).unwrap_or(u32::MAX), affinity)
    }

    /// The zero-width caret box at `position` (content coordinates). `None`
    /// without lines.
    pub(crate) fn caret_box(&self, position: TextPosition) -> Option<CGRect> {
        let lines = self.boxes();
        let at = usize::try_from(position.offset).unwrap_or(usize::MAX);
        let l = lines.get(line_of(&lines, at, position.affinity)?)?;
        Some(CGRect::new(
            CGPoint::new(l.x_of(at), l.top),
            CGSize::new(0.0, l.height),
        ))
    }

    /// The character under `point` (content coordinates) of the line nearest
    /// to it, if the point is within a few points of that line's glyphs: a
    /// little slack so that a press near a span still hits it.
    pub(crate) fn char_at(&self, point: CGPoint) -> Option<usize> {
        const SLACK: CGFloat = 4.0;
        let lines = self.boxes();
        let mut best: Option<(&LineBox, CGFloat)> = None;
        for l in &lines {
            if point.x < l.x - SLACK || point.x > l.x + l.width + SLACK {
                continue;
            }
            let distance = if point.y < l.top {
                l.top - point.y
            } else if point.y > l.bottom() {
                point.y - l.bottom()
            } else {
                0.0
            };
            if distance <= SLACK && best.is_none_or(|(_, d)| distance < d) {
                best = Some((l, distance));
            }
        }
        let (l, _) = best?;
        let index = l.index_at(point.x);
        // The caret index nearest to the point: the character is the one
        // before it when the point is left of the caret.
        Some(if point.x < l.x_of(index) && index > 0 {
            index - 1
        } else {
            index
        })
    }

    /// The boxes of the UTF-16 range `a..b` on each line it covers (content
    /// coordinates), with whether each holds the range's start and its end.
    pub(crate) fn range_boxes(&self, a: usize, b: usize) -> Vec<(CGRect, bool, bool)> {
        let mut out = Vec::new();
        if a >= b {
            return out;
        }
        let mut spans = Vec::new();
        for l in &self.boxes() {
            if l.end <= a || l.start >= b {
                continue;
            }
            l.spans(a, b, &mut spans);
            out.extend(spans.iter().map(|&(x1, x2)| {
                (
                    CGRect::new(CGPoint::new(x1, l.top), CGSize::new(x2 - x1, l.height)),
                    a >= l.start && a < l.end && x1 <= l.x_of(a) && l.x_of(a) <= x2,
                    b <= l.end && b > l.start && x1 <= l.x_of(b) && l.x_of(b) <= x2,
                )
            }));
        }
        if !out.iter().any(|r| r.1)
            && let Some(first) = out.first_mut()
        {
            first.1 = true;
        }
        if !out.iter().any(|r| r.2)
            && let Some(last) = out.last_mut()
        {
            last.2 = true;
        }
        out
    }
}

/// Finished lines, drawn by [`crate::text_view::TextView`].
pub(crate) struct CoreTextLayout {
    pub(crate) lines: Vec<LaidLine>,
    /// The box's height (lines are placed y up from its bottom).
    pub(crate) height: CGFloat,
    /// Some run carries a strikethrough.
    pub(crate) strikethrough: bool,
    /// Top left of each attachment's placeholder (y down), if shown.
    attachments: Vec<Option<(f32, f32)>>,
}

// SAFETY: lines are immutable once created, and CoreText objects are
// thread-safe; they are created on the engine thread and only read (drawn)
// on the main thread.
unsafe impl Send for CoreTextLayout {}
// SAFETY: see `Send`.
unsafe impl Sync for CoreTextLayout {}

/// [`TextEngine`] backed by CoreText.
#[derive(Default)]
pub struct CoreTextEngine {
    fonts: FontCache,
}

const WHOLE: CFRange = CFRange {
    location: 0,
    length: 0,
};

impl CoreTextEngine {
    /// Where attachment `a` of `text` sits: how far its top is above the
    /// baseline, and its run delegate's ascent and descent
    /// (`TextAttachment::ascent` and `extent` in its placeholder's font).
    fn attachment_metrics(
        &self,
        text: &AttributedText,
        a: &nsh_core::TextAttachment,
        alignments: &nsh_core::AttachmentAlignments,
    ) -> (CGFloat, CGFloat, CGFloat) {
        let font = if alignments.get(a.index) == nsh_core::VerticalAlign::Baseline {
            nsh_core::FontExtent::default()
        } else {
            let style = text
                .span_at(a.index)
                .map_or_else(Default::default, |s| s.style);
            let f = self.fonts.get(&style);
            // SAFETY: a valid font.
            let (ascent, descent, x) = unsafe { (f.ascent(), f.descent(), f.x_height()) };
            nsh_core::FontExtent::new(
                Points(ascent as f32),
                Points(descent as f32),
                Points(x as f32),
            )
        };
        let (up, down) = a.extent(font, alignments.get(a.index));
        (
            a.ascent(font, alignments.get(a.index)).0 as CGFloat,
            up.0 as CGFloat,
            down.0 as CGFloat,
        )
    }

    fn attributed_string(
        &self,
        text: &AttributedText,
        alignments: &nsh_core::AttachmentAlignments,
    ) -> CFRetained<CFMutableAttributedString> {
        let string =
            CFMutableAttributedString::new(None, 0).expect("CFAttributedStringCreateMutable");
        let s = Some(&*string);
        // SAFETY: valid mutable string and range.
        unsafe {
            CFMutableAttributedString::replace_string(
                s,
                WHOLE,
                Some(&CFString::from_str(&text.text)),
            )
        };
        let length = text.spans.last().map_or(0, |span| span.end as CFIndex);
        CFMutableAttributedString::begin_editing(s);
        let set = |range: CFRange, key: &CFString, value: &CFType| {
            // SAFETY: values have the types CoreText requires for their keys
            // (checked at each call), and every range lies within the string
            // because span offsets are UTF-16 units, like CFString.
            unsafe { CFMutableAttributedString::set_attribute(s, range, Some(key), Some(value)) }
        };
        let paragraph = paragraph_style(text);
        // SAFETY: immutable CoreText constants (here and below).
        set(
            CFRange {
                location: 0,
                length,
            },
            unsafe { kCTParagraphStyleAttributeName },
            paragraph.as_ref(),
        );
        for span in &text.spans {
            let range = CFRange {
                location: span.start as CFIndex,
                length: (span.end - span.start) as CFIndex,
            };
            let style = &span.style;
            set(
                range,
                unsafe { kCTFontAttributeName },
                self.fonts.get(style).as_ref(),
            );
            set(
                range,
                unsafe { kCTForegroundColorAttributeName },
                cg_color(style.color).as_ref(),
            );
            if style.letter_spacing != Points::ZERO {
                let kern = CFNumber::new_cgfloat(style.letter_spacing.0 as CGFloat);
                set(range, unsafe { kCTKernAttributeName }, kern.as_ref());
            }
            let decoration = cg_color(style.decoration_color.unwrap_or(style.color));
            let custom = style.decoration_style != nsh_core::DecorationStyle::Solid
                || style.decoration_thickness.is_some()
                || style.underline_offset.is_some();
            if custom && !style.decoration.is_none() {
                let code = match style.decoration_style {
                    nsh_core::DecorationStyle::Solid => 0,
                    nsh_core::DecorationStyle::Double => 1,
                    nsh_core::DecorationStyle::Dotted => 2,
                    nsh_core::DecorationStyle::Dashed => 3,
                    nsh_core::DecorationStyle::Wavy => 4,
                };
                let numbers = [
                    CFNumber::new_i32(code),
                    CFNumber::new_cgfloat(
                        style.decoration_thickness.unwrap_or(Points::ZERO).0 as CGFloat,
                    ),
                    CFNumber::new_cgfloat(
                        style
                            .underline_offset
                            .map_or(CGFloat::NAN, |o| o.0 as CGFloat),
                    ),
                ];
                let array = CFArray::from_retained_objects(&numbers);
                set(range, decoration_key(), array.as_ref());
            }
            if style.decoration.underline && custom {
                set(range, underline_key(), decoration.as_ref());
            } else if style.decoration.underline {
                // kCTUnderlineStyleSingle.
                let single = CFNumber::new_i32(1);
                set(
                    range,
                    unsafe { kCTUnderlineStyleAttributeName },
                    single.as_ref(),
                );
                set(
                    range,
                    unsafe { kCTUnderlineColorAttributeName },
                    decoration.as_ref(),
                );
            }
            if style.decoration.line_through {
                set(range, strikethrough_key(), decoration.as_ref());
            }
            if let Some(b) = style.background {
                let node = CFNumber::new_i64(b.node as i64);
                set(range, background_key(), node.as_ref());
            }
        }
        // Attachments: their placeholders take the attachment's width and
        // its extent around the baseline (`verticalAlign`), and draw
        // nothing.
        let clear = cg_color(Color::TRANSPARENT);
        for a in &text.attachments {
            let range = CFRange {
                location: a.index as CFIndex,
                length: 1,
            };
            let (_, ascent, descent) = self.attachment_metrics(text, a, alignments);
            if let Some(delegate) = run_delegate(a.width.0 as CGFloat, ascent, descent) {
                set(
                    range,
                    unsafe { kCTRunDelegateAttributeName },
                    delegate.as_ref(),
                );
            }
            set(
                range,
                unsafe { kCTForegroundColorAttributeName },
                clear.as_ref(),
            );
        }
        CFMutableAttributedString::end_editing(s);
        string
    }
}

/// A run delegate reserving `width`, `ascent` above the baseline and
/// `descent` below it.
fn run_delegate(
    width: CGFloat,
    ascent: CGFloat,
    descent: CGFloat,
) -> Option<CFRetained<CTRunDelegate>> {
    type Size = [CGFloat; 3];
    unsafe extern "C-unwind" fn dealloc(refcon: NonNull<c_void>) {
        // SAFETY: the box created below, freed once by CoreText.
        drop(unsafe { Box::from_raw(refcon.as_ptr().cast::<Size>()) });
    }
    unsafe extern "C-unwind" fn get_ascent(refcon: NonNull<c_void>) -> CGFloat {
        // SAFETY: the live box created below.
        unsafe { (*refcon.as_ptr().cast::<Size>())[1] }
    }
    unsafe extern "C-unwind" fn get_descent(refcon: NonNull<c_void>) -> CGFloat {
        // SAFETY: as above.
        unsafe { (*refcon.as_ptr().cast::<Size>())[2] }
    }
    unsafe extern "C-unwind" fn get_width(refcon: NonNull<c_void>) -> CGFloat {
        // SAFETY: as above.
        unsafe { (*refcon.as_ptr().cast::<Size>())[0] }
    }
    static CALLBACKS: CTRunDelegateCallbacks = CTRunDelegateCallbacks {
        version: kCTRunDelegateCurrentVersion as CFIndex,
        dealloc: Some(dealloc),
        getAscent: Some(get_ascent),
        getDescent: Some(get_descent),
        getWidth: Some(get_width),
    };
    let refcon = Box::into_raw(Box::new([width, ascent, descent]));
    // SAFETY: static callbacks; the delegate owns `refcon` (freed by
    // `dealloc`).
    let delegate = unsafe { CTRunDelegate::new(NonNull::from(&CALLBACKS), refcon.cast()) };
    if delegate.is_none() {
        // SAFETY: not handed over.
        drop(unsafe { Box::from_raw(refcon) });
    }
    delegate
}

/// The UTF-16 offset and length of every hard line break in `text` (a CRLF
/// is one), in order: the caret never goes after one.
fn hard_breaks(text: &str) -> Vec<(CFIndex, CFIndex)> {
    let mut breaks = Vec::new();
    let mut at: CFIndex = 0;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let mut len = c.len_utf16() as CFIndex;
        if matches!(
            c,
            '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{85}' | '\u{2028}' | '\u{2029}'
        ) {
            let mut width = len;
            if c == '\r' && chars.peek() == Some(&'\n') {
                chars.next();
                width += 1;
                len += 1;
            }
            breaks.push((at, width));
        }
        at += len;
    }
    breaks
}

/// A box in content coordinates as the engine contract reports it.
fn bounds_of(rect: CGRect) -> nsh_core::Bounds<Points> {
    nsh_core::Bounds::new(
        Point::new(Points(rect.origin.x as f32), Points(rect.origin.y as f32)),
        Size::new(
            Points(rect.size.width as f32),
            Points(rect.size.height as f32),
        ),
    )
}

/// Where the lines put the placeholders at `attachments` (offset, top
/// above the baseline): the top left of each (y down in a box `height`
/// tall), if shown.
fn attachment_points(
    lines: &[LaidLine],
    attachments: &[(CFIndex, CGFloat)],
    height: CGFloat,
) -> Vec<Option<(f32, f32)>> {
    let mut points = vec![None; attachments.len()];
    for l in lines {
        // SAFETY: the line's own run array (of CTRuns).
        let runs = unsafe { l.line.glyph_runs() };
        for r in 0..runs.count() {
            // SAFETY: an index within the array.
            let run = unsafe { &*runs.value_at_index(r).cast::<CTRun>() };
            // SAFETY: a valid run.
            let range = unsafe { run.string_range() };
            // Only placeholder runs: an ellipsis token claims the range it
            // cut.
            // SAFETY: a valid run; an immutable CoreText key.
            let placeholder = unsafe {
                let key: *const CFString = kCTRunDelegateAttributeName;
                run.attributes().contains_ptr_key(key.cast())
            };
            if !placeholder {
                continue;
            }
            for (i, &(at, h)) in attachments.iter().enumerate() {
                if points[i].is_some() || at < range.location || at >= range.location + range.length
                {
                    continue;
                }
                // A delegate run holds its one placeholder glyph.
                let mut p = CGPoint::new(0.0, 0.0);
                // SAFETY: one position into a one-point buffer.
                unsafe {
                    run.positions(
                        CFRange {
                            location: 0,
                            length: 1,
                        },
                        NonNull::from(&mut p),
                    )
                };
                points[i] = Some(((l.origin.x + p.x) as f32, (height - l.origin.y - h) as f32));
            }
        }
    }
    points
}

fn paragraph_style(text: &AttributedText) -> CFRetained<CTParagraphStyle> {
    let alignment = match text.align {
        // React Native: the right side in right-to-left layouts.
        TextAlign::Auto if text.rtl => CTTextAlignment::Right,
        TextAlign::Auto => CTTextAlignment::Natural,
        TextAlign::Left => CTTextAlignment::Left,
        TextAlign::Center => CTTextAlignment::Center,
        TextAlign::Right => CTTextAlignment::Right,
        TextAlign::Justify => CTTextAlignment::Justified,
    };
    let line_height = text.spans.first().map_or(0.0, |s| s.style.line_height.0) as CGFloat;
    let setting = |spec, value: *const c_void, size| CTParagraphStyleSetting {
        spec,
        valueSize: size,
        value: NonNull::new(value.cast_mut()).expect("non-null setting"),
    };
    // `writingDirection`; natural (from the content) by default.
    let direction = match text.writing_direction {
        None => CTWritingDirection::Natural,
        Some(false) => CTWritingDirection::LeftToRight,
        Some(true) => CTWritingDirection::RightToLeft,
    };
    let mut settings = vec![
        setting(
            CTParagraphStyleSpecifier::Alignment,
            (&raw const alignment).cast(),
            size_of::<CTTextAlignment>(),
        ),
        setting(
            CTParagraphStyleSpecifier::BaseWritingDirection,
            (&raw const direction).cast(),
            size_of::<CTWritingDirection>(),
        ),
    ];
    if line_height > 0.0 {
        for spec in [
            CTParagraphStyleSpecifier::MinimumLineHeight,
            CTParagraphStyleSpecifier::MaximumLineHeight,
        ] {
            settings.push(setting(
                spec,
                (&raw const line_height).cast(),
                size_of::<CGFloat>(),
            ));
        }
    }
    // SAFETY: every setting points at a live value of the declared size.
    unsafe { CTParagraphStyle::new(settings.as_ptr(), settings.len()) }
}

impl Prepared {
    fn typesetter(&self) -> CFRetained<CTTypesetter> {
        // SAFETY: a valid framesetter.
        unsafe { self.framesetter.typesetter() }
    }

    /// Length (UTF-16 units) of the first `lines` lines at `width`.
    fn lines_length(&self, lines: u32, width: f64) -> CFIndex {
        let typesetter = self.typesetter();
        let mut end = 0;
        for _ in 0..lines {
            if end >= self.length {
                break;
            }
            // SAFETY: `end` lies within the string.
            let count = unsafe { typesetter.suggest_line_break(end, width) };
            if count <= 0 {
                break;
            }
            end += count;
        }
        end
    }

    /// `line` (starting at `start`) cut to `width` with an ellipsis, as
    /// `ellipsizeMode` says, standing for the rest of the text.
    fn truncate(&self, start: CFIndex, width: f64) -> Option<CFRetained<CTLine>> {
        let kind = match self.ellipsize {
            EllipsizeMode::Tail => CTLineTruncationType::End,
            EllipsizeMode::Head => CTLineTruncationType::Start,
            EllipsizeMode::Middle => CTLineTruncationType::Middle,
            // The rest of the text on one line, cut where the box ends
            // (not at the last word that fits).
            EllipsizeMode::Clip => {
                // SAFETY: the range lies within the string.
                return Some(unsafe {
                    self.typesetter().line(CFRange {
                        location: start,
                        length: self.length - start,
                    })
                });
            }
        };
        // The token copies the attributes of the last character that is
        // not an attachment (a placeholder's would make it invisible).
        let mut last = (self.length - 1).max(start);
        while last > start && self.attachments.iter().any(|&(at, _)| at == last) {
            last -= 1;
        }
        // SAFETY: ranges lie within the string.
        unsafe {
            let rest = self.typesetter().line(CFRange {
                location: start,
                length: self.length - start,
            });
            let token_string =
                CFMutableAttributedString::new(None, 0).expect("CFAttributedStringCreateMutable");
            CFMutableAttributedString::replace_string(
                Some(&token_string),
                WHOLE,
                Some(&CFString::from_static_str("\u{2026}")),
            );
            let source: &CFAttributedString = &self.string;
            let attributes = CFAttributedString::attributes(source, last, std::ptr::null_mut());
            if let Some(attributes) = attributes {
                CFMutableAttributedString::set_attributes(
                    Some(&token_string),
                    CFRange {
                        location: 0,
                        length: 1,
                    },
                    Some(&attributes),
                    false,
                );
            }
            // Marks the token's run (see `ellipsis_key`).
            CFMutableAttributedString::set_attribute(
                Some(&token_string),
                CFRange {
                    location: 0,
                    length: 1,
                },
                Some(ellipsis_key()),
                Some(CFNumber::new_i32(1).as_ref()),
            );
            let token = CTLine::with_attributed_string(&token_string);
            rest.truncated_line(width, kind, Some(&token))
        }
    }

    fn flush_factor(&self) -> CGFloat {
        match self.align {
            TextAlign::Center => 0.5,
            TextAlign::Right => 1.0,
            TextAlign::Auto | TextAlign::Left | TextAlign::Justify => 0.0,
        }
    }
}

impl TextEngine for CoreTextEngine {
    type Prepared = Prepared;

    fn prepare(&self, text: &AttributedText) -> Prepared {
        self.prepare_aligned(text, &nsh_core::AttachmentAlignments::default())
    }

    fn prepare_aligned(
        &self,
        text: &AttributedText,
        alignments: &nsh_core::AttachmentAlignments,
    ) -> Prepared {
        let string = self.attributed_string(text, alignments);
        let attributed: &CFAttributedString = &string;
        // SAFETY: a valid attributed string.
        let framesetter = unsafe { CTFramesetter::with_attributed_string(attributed) };
        Prepared {
            framesetter,
            length: text.text.encode_utf16().count() as CFIndex,
            string,
            max_lines: text.max_lines,
            ellipsize: text.ellipsize,
            align: text.align,
            attachments: text
                .attachments
                .iter()
                .map(|a| {
                    (
                        a.index as CFIndex,
                        self.attachment_metrics(text, a, alignments).0,
                    )
                })
                .collect(),
            breaks: hard_breaks(&text.text),
        }
    }

    fn measure(&self, prepared: &Prepared, max_width: Option<Points>) -> Size<Points> {
        let width = max_width.map_or(CGFloat::MAX, |w| w.0 as CGFloat);
        let range = if prepared.max_lines > 0 {
            CFRange {
                location: 0,
                length: prepared.lines_length(prepared.max_lines, width),
            }
        } else {
            WHOLE
        };
        // SAFETY: a range within the string, no frame attributes, no fit
        // range out-param.
        let size = unsafe {
            prepared.framesetter.suggest_frame_size_with_constraints(
                range,
                None,
                CGSize::new(width, CGFloat::MAX),
                std::ptr::null_mut(),
            )
        };
        Size::new(Points(size.width as f32), Points(size.height as f32))
    }

    fn layout(&self, prepared: &Prepared, size: Size<Points>) -> TextLayout {
        let (width, height) = (size.width.0 as CGFloat, size.height.0 as CGFloat);
        let rect = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width, height));
        // SAFETY: a valid rectangle path and whole-string range.
        let frame: CFRetained<CTFrame> = unsafe {
            let path = CGPath::with_rect(rect, std::ptr::null());
            prepared.framesetter.frame(WHOLE, &path, None)
        };
        // SAFETY: the frame's own line array (of CTLines) and origins.
        let mut lines = unsafe {
            let array = frame.lines();
            let count = array.count();
            let mut origins = vec![CGPoint::new(0.0, 0.0); count as usize];
            if let Some(ptr) = NonNull::new(origins.as_mut_ptr()) {
                frame.line_origins(WHOLE, ptr);
            }
            (0..count)
                .map(|i| {
                    let line = array.value_at_index(i).cast::<CTLine>();
                    let line = CFRetained::retain(NonNull::new(line.cast_mut()).expect("line"));
                    let range = line.string_range();
                    // The caret stays before the hard break ending the line.
                    let end = range.location + range.length;
                    let caret_end = prepared
                        .breaks
                        .binary_search_by_key(&end, |&(at, len)| at + len)
                        .ok()
                        .and_then(|b| prepared.breaks.get(b))
                        .map_or(end, |&(at, _)| at.max(range.location));
                    LaidLine {
                        line,
                        origin: origins[i as usize],
                        range,
                        caret_end,
                        truncated: false,
                    }
                })
                .collect::<Vec<_>>()
        };
        if prepared.max_lines > 0 {
            lines.truncate(prepared.max_lines as usize);
        }
        // Text left over (cut by `numberOfLines` or the box): ellipsize the
        // last line.
        if let Some(last) = lines.last_mut() {
            // SAFETY: a valid line.
            let range = unsafe { last.line.string_range() };
            if range.location + range.length < prepared.length
                && let Some(truncated) = prepared.truncate(range.location, width)
            {
                // SAFETY: a valid line.
                let x = unsafe { truncated.pen_offset_for_flush(prepared.flush_factor(), width) };
                // A clipped line wider than the box starts at its start edge
                // and overflows the end (CSS), centered or not.
                last.origin.x = x.max(0.0);
                last.line = truncated;
                last.caret_end = prepared.length;
                last.truncated = true;
            }
        }
        let attachments = if prepared.attachments.is_empty() {
            Vec::new()
        } else {
            attachment_points(&lines, &prepared.attachments, height)
        };
        TextLayout(std::sync::Arc::new(CoreTextLayout {
            strikethrough: has_strikethrough(prepared),
            lines,
            height,
            attachments,
        }))
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<Point<Points>>> {
        layout
            .downcast::<CoreTextLayout>()
            .map_or_else(Vec::new, |l| {
                l.attachments
                    .iter()
                    .map(|a| a.map(|(x, y)| Point::new(Points(x), Points(y))))
                    .collect()
            })
    }

    fn lines(&self, layout: &TextLayout) -> Vec<nsh_core::TextLine> {
        let Some(layout) = layout.downcast::<CoreTextLayout>() else {
            return Vec::new();
        };
        layout
            .lines
            .iter()
            .map(|l| {
                let (mut ascent, mut descent, mut leading) = (0.0, 0.0, 0.0);
                // SAFETY: a valid line and out pointers.
                let width = unsafe {
                    l.line
                        .typographic_bounds(&mut ascent, &mut descent, &mut leading)
                };
                let (cap, x_height) =
                    line_font(&l.line).map_or((ascent * 0.7, ascent * 0.5), |f| {
                        // SAFETY: a valid font.
                        unsafe { (f.cap_height(), f.x_height()) }
                    });
                nsh_core::TextLine {
                    text: String::new(),
                    start: l.range.location as u32,
                    end: (l.range.location + l.range.length) as u32,
                    x: Points(l.origin.x as f32),
                    y: Points((layout.height - l.origin.y - ascent) as f32),
                    width: Points(width as f32),
                    height: Points((ascent + descent + leading) as f32),
                    ascender: Points(ascent as f32),
                    descender: Points(descent as f32),
                    cap_height: Points(cap as f32),
                    x_height: Points(x_height as f32),
                }
            })
            .collect()
    }

    fn hit_test(&self, layout: &TextLayout, point: Point<Points>) -> TextPosition {
        layout
            .downcast::<CoreTextLayout>()
            .map_or_else(TextPosition::default, |l| {
                l.position_at(CGPoint::new(point.x.0 as CGFloat, point.y.0 as CGFloat))
            })
    }

    fn caret_rect(
        &self,
        layout: &TextLayout,
        position: TextPosition,
    ) -> Option<nsh_core::Bounds<Points>> {
        layout
            .downcast::<CoreTextLayout>()?
            .caret_box(position)
            .map(bounds_of)
    }

    fn range_rects(
        &self,
        layout: &TextLayout,
        range: std::ops::Range<u32>,
        out: &mut Vec<nsh_core::Bounds<Points>>,
    ) {
        let Some(layout) = layout.downcast::<CoreTextLayout>() else {
            return;
        };
        out.extend(
            layout
                .range_boxes(range.start as usize, range.end as usize)
                .into_iter()
                .map(|(rect, ..)| bounds_of(rect)),
        );
    }

    fn register_font(&self, data: &[u8]) -> Result<(), String> {
        // CoreText registers fonts synchronously only from files: write the
        // data to a content-addressed file first.
        let path = font_file(data).map_err(|e| format!("cannot store font: {e}"))?;
        let url = CFURL::from_file_path(&path).ok_or("bad font path")?;
        let mut error = std::ptr::null_mut();
        // SAFETY: a valid file URL and error out-param.
        let ok = unsafe {
            CTFontManagerRegisterFontsForURL(&url, CTFontManagerScope::Process, &mut error)
        };
        // Fonts resolve differently now (a family may have been missing).
        self.fonts.clear();
        if ok {
            return Ok(());
        }
        // SAFETY: on failure the out-param holds a +1 CFError.
        let error = unsafe { CFRetained::from_raw(NonNull::new(error).ok_or("unknown error")?) };
        // kCTFontManagerErrorAlreadyRegistered: e.g. after a hot reload.
        if error.code() == 105 {
            return Ok(());
        }
        Err(error
            .description()
            .map_or_else(|| "font rejected".to_owned(), |d| d.to_string()))
    }
}

/// Writes font data to `<temp>/nsh-fonts/<hash>.font` (once).
fn font_file(data: &[u8]) -> std::io::Result<std::path::PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    data.hash(&mut hasher);
    let dir = std::env::temp_dir().join("nsh-fonts");
    let path = dir.join(format!("{:016x}.font", hasher.finish()));
    if !path.exists() {
        std::fs::create_dir_all(&dir)?;
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, data)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(path)
}

fn has_strikethrough(prepared: &Prepared) -> bool {
    let mut index = 0;
    let source: &CFAttributedString = &prepared.string;
    while index < prepared.length {
        let mut range = CFRange {
            location: 0,
            length: 0,
        };
        // SAFETY: `index` lies within the string; `range` is a valid out-param.
        let value = unsafe {
            CFAttributedString::attribute(source, index, Some(strikethrough_key()), &mut range)
        };
        if value.is_some() {
            return true;
        }
        let mut other = CFRange {
            location: 0,
            length: 0,
        };
        // SAFETY: as above.
        let underline = unsafe {
            CFAttributedString::attribute(source, index, Some(underline_key()), &mut other)
        };
        if underline.is_some() {
            return true;
        }
        if other.location + other.length < range.location + range.length {
            range = other;
        }
        index = (range.location + range.length).max(index + 1);
    }
    false
}

/// Warms up font and CoreText caches (process-wide) on a background thread
/// so the first real layout does not pay for them.
pub(crate) fn prewarm() {
    let engine = CoreTextEngine::default();
    for (size, weight) in [(14.0, 400), (17.0, 400), (17.0, 700)] {
        let mut text = AttributedText::default();
        let style = ResolvedTextStyle {
            font_size: Points(size),
            font_weight: weight,
            ..Default::default()
        };
        text.push("Hg 0123 ab", style);
        let prepared = engine.prepare(&text);
        let measured = engine.measure(&prepared, Some(Points(100.0)));
        let _ = engine.layout(&prepared, measured);
    }
}

/// Fills the span backgrounds of `layout` (view coordinates, y down),
/// behind the glyphs: per line, its runs (CoreText
/// splits them where a background starts or ends) joined by
/// [`nsh_core::BackgroundBox::join`], as tall as their fonts.
pub(crate) fn draw_backgrounds(
    cx: &objc2_core_graphics::CGContext,
    text: &AttributedText,
    layout: &CoreTextLayout,
    content: nsh_core::Bounds<nsh_core::Points>,
) {
    let c = Some(cx);
    let bottom = (content.origin.y.0 + content.size.height.0) as CGFloat;
    let mut pieces = Vec::new();
    for line in &layout.lines {
        pieces.clear();
        // SAFETY: the line's own run array (of CTRuns), valid out pointers
        // and a one-glyph range inside each non-empty run.
        let (width, trailing) = unsafe {
            let runs = line.line.glyph_runs();
            for i in 0..runs.count() {
                let run = &*runs.value_at_index(i).cast::<CTRun>();
                if run.glyph_count() == 0 {
                    continue;
                }
                let mut first = CGPoint::new(0.0, 0.0);
                run.positions(
                    CFRange {
                        location: 0,
                        length: 1,
                    },
                    NonNull::from(&mut first),
                );
                let (mut ascent, mut descent) = (0.0, 0.0);
                let width =
                    run.typographic_bounds(WHOLE, &mut ascent, &mut descent, std::ptr::null_mut());
                let index = run.string_range().location.max(0) as u32;
                // An attachment's placeholder is as tall as it: the text
                // around it sets the box.
                if text.attachments.iter().any(|a| a.index == index) {
                    (ascent, descent) = (0.0, 0.0);
                }
                pieces.push(nsh_core::LinePiece {
                    x: Points((line.origin.x + first.x) as f32),
                    width: Points(width as f32),
                    background: text.background_at(index),
                    ascent: Points(ascent as f32),
                    descent: Points(descent as f32),
                });
            }
            (
                line.line.typographic_bounds(
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                ),
                line.line.trailing_whitespace_width(),
            )
        };
        pieces.sort_by(|a, b| a.x.0.total_cmp(&b.x.0));
        // Whitespace hanging past the line's end: on its left right to left.
        let x = line.origin.x as f32;
        let (left, right) = if text.rtl {
            (x + trailing as f32, x + width as f32)
        } else {
            (x, x + (width - trailing) as f32)
        };
        let baseline = bottom - line.origin.y;
        nsh_core::BackgroundBox::join(pieces.iter().copied(), (Points(left), Points(right)), |b| {
            let rect = CGRect::new(
                CGPoint::new(
                    content.origin.x.0 as CGFloat + b.x.0 as CGFloat,
                    baseline - b.ascent.0 as CGFloat,
                ),
                CGSize::new(b.width.0 as CGFloat, (b.ascent + b.descent).0 as CGFloat),
            );
            let path = crate::decor::rounded(rect, nsh_core::CornerRadii::all(b.radius()));
            objc2_core_graphics::CGContext::set_fill_color_with_color(
                c,
                Some(&cg_color(b.background.color)),
            );
            objc2_core_graphics::CGContext::add_path(c, Some(&path));
            objc2_core_graphics::CGContext::fill_path(c);
        });
    }
}

#[cfg(test)]
mod hit_regressions {
    use super::*;
    fn layout(text: &str, ellipsize: Option<EllipsizeMode>) -> (CoreTextEngine, TextLayout) {
        let engine = CoreTextEngine::default();
        let mut text_value = AttributedText::default();
        text_value.push(
            text,
            ResolvedTextStyle {
                font_size: Points(20.0),
                ..Default::default()
            },
        );
        if let Some(mode) = ellipsize {
            text_value.max_lines = 1;
            text_value.ellipsize = mode;
        }
        let prepared = engine.prepare(&text_value);
        let size = if ellipsize.is_some() {
            Size::new(Points(65.0), Points(40.0))
        } else {
            engine.measure(&prepared, None)
        };
        let laid = engine.layout(&prepared, size);
        (engine, laid)
    }
    #[test]
    fn bidi_ranges_follow_visual_runs() {
        let (engine, layout) = layout("abc אבג xyz", None);
        let mut rects = Vec::new();
        engine.range_rects(&layout, 0..5, &mut rects);
        assert_eq!(
            rects.len(),
            2,
            "a logical range crosses two disjoint visual runs: {rects:?}"
        );
        assert!(rects[0].origin.x + rects[0].size.width < rects[1].origin.x);
        let boxes = layout
            .downcast::<CoreTextLayout>()
            .unwrap()
            .range_boxes(0, 5);
        assert_eq!(
            boxes.iter().map(|r| (r.1, r.2)).collect::<Vec<_>>(),
            [(true, false), (false, true)]
        );
    }
    #[test]
    fn truncated_lines_keep_visible_suffix_offsets() {
        for mode in [EllipsizeMode::Head, EllipsizeMode::Middle] {
            let (engine, layout) = layout("abcdefghijklmnopqrstuvwxyz", Some(mode));
            let line = &engine.lines(&layout)[0];
            let hit = engine.hit_test(
                &layout,
                Point::new(
                    line.x + line.width - Points(1.0),
                    line.y + line.height * 0.5,
                ),
            );
            assert!(hit.offset >= 24, "{mode:?}: {hit:?}");
            let mut rects = Vec::new();
            engine.range_rects(&layout, 25..26, &mut rects);
            assert!(!rects.is_empty(), "{mode:?}: visible final character");
            let caret = engine
                .caret_rect(&layout, TextPosition::new(26, Affinity::Downstream))
                .unwrap();
            assert!(
                caret.origin.x >= line.x + line.width - Points(1.0),
                "{mode:?}: {caret:?}"
            );
        }
    }
    #[test]
    fn head_ellipsis_does_not_highlight_omitted_characters() {
        let (engine, layout) = layout("abcdefghijklmnopqrstuvwxyz", Some(EllipsizeMode::Head));
        let mut rects = Vec::new();
        engine.range_rects(&layout, 0..1, &mut rects);
        assert!(
            rects.is_empty(),
            "the token has no source character: {rects:?}"
        );
    }
}

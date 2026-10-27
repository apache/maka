//! CoreText text engine: typesets on the engine thread, draws on the main
//! thread from finished `CTLine`s, so every text is laid out once.

use std::{cell::RefCell, ffi::c_void, ops::Range, ptr::NonNull};

use nsh_core::{
    Affinity, AttributedText, Bounds, Color, EllipsizeMode, FontFamily, Point, Points,
    ResolvedTextStyle, Size, TextAlign, TextEngine, TextLayout, TextPosition,
};
use objc2::rc::Retained;
use objc2_app_kit::{
    NSFont, NSFontWeight, NSFontWeightBlack, NSFontWeightBold, NSFontWeightHeavy,
    NSFontWeightLight, NSFontWeightMedium, NSFontWeightRegular, NSFontWeightSemibold,
    NSFontWeightThin, NSFontWeightUltraLight,
};
use objc2_core_foundation::{
    CFArray, CFAttributedString, CFDictionary, CFIndex, CFMutableAttributedString, CFNumber,
    CFRange, CFRetained, CFString, CFType, CFURL, CGFloat, CGPoint, CGRect, CGSize,
};
use objc2_core_graphics::{CGColor, CGContext, CGPath};
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
use rustc_hash::FxHashMap;

/// Attribute carrying the strikethrough color: CoreText draws underlines
/// but not strikethroughs, so [`draw`] draws those.
pub(crate) fn strikethrough_key() -> &'static CFString {
    static KEY: std::sync::OnceLock<CFStringKey> = std::sync::OnceLock::new();
    &KEY.get_or_init(|| CFStringKey(CFString::from_static_str("NshStrikethroughColor")))
        .0
}

/// Attribute carrying the color of an underline CoreText cannot draw
/// (styled, thick or offset): [`draw`] draws it.
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
/// [`draw`] fills each background behind its own runs.
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

/// The font of `style` as a `NSFont` (toll-free bridged with `CTFont`), for
/// AppKit text views such as inputs.
pub(crate) fn ns_font(style: &ResolvedTextStyle) -> Retained<NSFont> {
    let font = make_font(style);
    let ptr = CFRetained::into_raw(font).as_ptr().cast::<NSFont>();
    // SAFETY: toll-free bridging; ownership of the +1 reference moves over.
    unsafe { Retained::from_raw(ptr).expect("non-null font") }
}

/// CSS generic families (`font-mono`, `font-serif`): the system font's
/// designs. `Some(None)` is the plain system font; `None` is not generic.
fn generic_font(family: &str, size: CGFloat, weight: u16) -> Option<Option<CFRetained<CTFont>>> {
    use objc2_app_kit::{
        NSFontDescriptorSystemDesign, NSFontDescriptorSystemDesignRounded,
        NSFontDescriptorSystemDesignSerif,
    };
    let design: &NSFontDescriptorSystemDesign = match family {
        "system-ui" | "sans-serif" | "ui-sans-serif" | "-apple-system" => return Some(None),
        "monospace" | "ui-monospace" => {
            let font = NSFont::monospacedSystemFontOfSize_weight(size, font_weight(weight));
            return Some(Some(bridge(font)));
        }
        // SAFETY: immutable AppKit constants.
        "serif" | "ui-serif" => unsafe { NSFontDescriptorSystemDesignSerif },
        "ui-rounded" => unsafe { NSFontDescriptorSystemDesignRounded },
        _ => return None,
    };
    let base = NSFont::systemFontOfSize_weight(size, font_weight(weight));
    let descriptor = base.fontDescriptor();
    let font = descriptor
        .fontDescriptorWithDesign(design)
        .and_then(|d| NSFont::fontWithDescriptor_size(&d, size))
        .unwrap_or(base);
    Some(Some(bridge(font)))
}

/// A `NSFont` as the `CTFont` it is (toll-free bridged).
fn bridge(font: Retained<NSFont>) -> CFRetained<CTFont> {
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

/// The system font as a `CTFont`. `NSFont` is toll-free bridged with
/// `CTFont`, and the AppKit constructor is the supported way to get the
/// system font at an arbitrary weight.
fn system_font(size: CGFloat, weight: u16) -> CFRetained<CTFont> {
    let font: Retained<NSFont> = NSFont::systemFontOfSize_weight(size, font_weight(weight));
    let ptr = Retained::into_raw(font).cast::<CTFont>();
    // SAFETY: toll-free bridging; ownership of the +1 reference moves over.
    unsafe { CFRetained::from_raw(NonNull::new(ptr).expect("non-null font")) }
}

fn font_weight(weight: u16) -> NSFontWeight {
    // SAFETY: AppKit's font weight constants are immutable statics.
    unsafe {
        match weight {
            0..=149 => NSFontWeightUltraLight,
            150..=249 => NSFontWeightThin,
            250..=349 => NSFontWeightLight,
            350..=449 => NSFontWeightRegular,
            450..=549 => NSFontWeightMedium,
            550..=649 => NSFontWeightSemibold,
            650..=749 => NSFontWeightBold,
            750..=849 => NSFontWeightHeavy,
            _ => NSFontWeightBlack,
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
}

/// A finished line and its origin (CoreText's y-up space, from the bottom of
/// the box).
pub(crate) struct LaidLine {
    pub(crate) line: CFRetained<CTLine>,
    pub(crate) origin: CGPoint,
    /// Its characters in the text (before any ellipsis).
    pub(crate) range: CFRange,
    /// How many of its last characters (UTF-16 units) are a hard line break
    /// (`\n`, `\r\n`, ...): the caret goes before them, never after.
    pub(crate) break_len: CFIndex,
    /// End of the source a truncated line can display, including its suffix.
    hit_end: CFIndex,
}

/// Finished lines, drawn by [`draw`] on the main thread.
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
    /// `textOverflow` says, standing for the rest of the text.
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
        let attributed: &CFAttributedString = &prepared.string;
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
                    LaidLine {
                        line,
                        origin: origins[i as usize],
                        range,
                        break_len: break_len(attributed, range),
                        hit_end: range.location + range.length,
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
                last.hit_end = prepared.length;
                last.break_len = 0;
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
                l.hit_test(point.x.0 as CGFloat, point.y.0 as CGFloat)
            })
    }

    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        layout.downcast::<CoreTextLayout>()?.caret_rect(position)
    }

    fn range_rects(&self, layout: &TextLayout, range: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        if let Some(l) = layout.downcast::<CoreTextLayout>() {
            l.range_rects(range, out);
        }
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

// ---- Drawing (main thread) ----

/// iOS's system blue: the selection's tint without `selectionColor`.
const SYSTEM_BLUE: Color = Color(0x007a_ffff);

/// What a text view draws: the text, its final layout and content box.
pub(crate) struct DrawnText {
    /// The text (spans, links, selection options).
    pub(crate) text: std::sync::Arc<AttributedText>,
    /// Its final layout ([`CoreTextLayout`]).
    pub(crate) layout: TextLayout,
    /// The content box in the view (inside padding and borders).
    pub(crate) content: nsh_core::Bounds<nsh_core::Points>,
    /// The selection of selectable text, kept across new content.
    selection: Option<Selection>,
    /// The part of a selectable view's selection in this text
    /// ([`crate::selectable_view`]).
    area_range: std::cell::Cell<Option<(u32, u32)>>,
}

/// A text view got new text or a new layout.
pub(crate) fn set(
    view: &crate::view::NshView,
    text: &std::sync::Arc<AttributedText>,
    layout: &TextLayout,
    content: nsh_core::Bounds<nsh_core::Points>,
) {
    let old = view.state_mut().text.take();
    let was = old.as_ref().is_some_and(|o| o.text.is_selectable());
    // The area's selection is set again at the end of the batch; the same
    // content keeps its part until then.
    let area_range = old
        .as_ref()
        .filter(|o| o.text.text == text.text)
        .and_then(|o| o.area_range.get());
    let selection = match old {
        Some(DrawnText {
            text: old,
            selection: Some(s),
            ..
        }) if text.is_selectable() => {
            // Offsets into other text mean nothing.
            if old.text != text.text {
                s.range.set(None);
            }
            Some(s)
        }
        _ if text.is_selectable() => Some(Selection::default()),
        _ => None,
    };
    view.state_mut().text = Some(DrawnText {
        text: text.clone(),
        layout: layout.clone(),
        content,
        selection,
        area_range: std::cell::Cell::new(area_range),
    });
    if was != text.is_selectable() {
        // The I-beam.
        crate::input::style_changed(view);
    }
    // The mounter draws it, when it shows.
    view.restyle();
}

/// The view draws selectable text: mouse drags over it select rather
/// than scroll, and its pointer is the I-beam.
pub(crate) fn selectable(state: &crate::view::ViewState) -> bool {
    state.text.as_ref().is_some_and(|t| t.text.is_selectable())
}

/// Draws a text view's text (in `drawRect:`; the context is y down).
pub(crate) fn draw(cx: &CGContext, state: &crate::view::ViewState) {
    use objc2_core_foundation::CGAffineTransform;
    let Some(drawn) = &state.text else { return };
    let Some(text) = drawn.layout.downcast::<CoreTextLayout>() else {
        return;
    };
    let content = drawn.content;
    let c = Some(cx);
    CGContext::save_g_state(c);
    if drawn.text.has_backgrounds() {
        draw_backgrounds(cx, &drawn.text, text, content);
    }
    let range = drawn.selection.as_ref().and_then(|s| s.range.get());
    if let Some(range) = range.or(drawn.area_range.get()) {
        // iOS tints the selection with the view's tint at about 30%.
        let tint = drawn.text.selection_color.unwrap_or(SYSTEM_BLUE);
        let alpha = (tint.0 & 0xff) as f32 / 255.0 * 0.3;
        let tint = Color((tint.0 & !0xff) | (alpha * 255.0).round() as u32);
        CGContext::set_fill_color_with_color(c, Some(&cg_color(tint)));
        for rect in selection_rects(text, content, range) {
            CGContext::fill_rect(c, rect);
        }
    }
    // CoreText draws in a y-up space with the origin at the bottom of the
    // box.
    CGContext::set_text_matrix(
        c,
        CGAffineTransform {
            a: 1.0,
            b: 0.0,
            c: 0.0,
            d: 1.0,
            tx: 0.0,
            ty: 0.0,
        },
    );
    CGContext::translate_ctm(
        c,
        content.origin.x.0 as CGFloat,
        (content.origin.y.0 + content.size.height.0) as CGFloat,
    );
    CGContext::scale_ctm(c, 1.0, -1.0);
    if let Some(shadow) = drawn.text.shadow {
        // Shadow offsets are in the layer's base space, which is y up under
        // AppKit's flipped context: a positive offset must still go down.
        CGContext::set_shadow_with_color(
            c,
            CGSize::new(shadow.offset_x.0 as CGFloat, -shadow.offset_y.0 as CGFloat),
            shadow.radius.0 as CGFloat,
            Some(&cg_color(shadow.color)),
        );
    }
    // An animated color: the text (decorations too) drawn as is into a
    // layer, then painted over in the color where it drew, so its
    // antialiasing stays; the layer casts the shadow.
    let color = state.anim.color;
    if color.is_some() {
        // SAFETY: no auxiliary info.
        unsafe { CGContext::begin_transparency_layer(c, None) };
    }
    for line in &text.lines {
        CGContext::set_text_position(c, line.origin.x, line.origin.y);
        // SAFETY: a valid line and context.
        unsafe { line.line.draw(cx) };
        if text.strikethrough {
            draw_decorations(cx, line);
        }
    }
    if let Some(color) = color {
        CGContext::set_blend_mode(c, objc2_core_graphics::CGBlendMode::SourceIn);
        CGContext::set_fill_color_with_color(c, Some(&cg_color(color)));
        // Wherever the text drew (glyphs may reach past the box); the clip
        // bounds the rest.
        CGContext::fill_rect(c, CGContext::clip_bounding_box(c));
        CGContext::end_transparency_layer(c);
    }
    CGContext::restore_g_state(c);
}

/// Fills the span backgrounds of `layout` (view coordinates, y down),
/// behind the selection and the glyphs: per line, its runs (CoreText
/// splits them where a background starts or ends) joined by
/// [`nsh_core::BackgroundBox::join`], as tall as their fonts.
fn draw_backgrounds(
    cx: &CGContext,
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
            CGContext::set_fill_color_with_color(c, Some(&cg_color(b.background.color)));
            CGContext::add_path(c, Some(&path));
            CGContext::fill_path(c);
        });
    }
}

/// A laid out line in the content box (y down, points: the box
/// [`CoreTextLayout::lines`] are reported in).
struct LineBox<'a> {
    line: &'a CTLine,
    /// Its characters.
    start: CFIndex,
    end: CFIndex,
    /// `end` without a hard break's characters: the last caret position.
    content_end: CFIndex,
    /// The x of its origin.
    x: CGFloat,
    top: CGFloat,
    /// Below the descent (the leading excluded).
    bottom: CGFloat,
    /// The space below `bottom` the line reports as part of its height.
    leading: CGFloat,
    width: CGFloat,
}

impl<'a> LineBox<'a> {
    fn of(layout: &CoreTextLayout, l: &'a LaidLine) -> Self {
        let (mut ascent, mut descent, mut leading) = (0.0, 0.0, 0.0);
        // SAFETY: valid out pointers.
        let width = unsafe {
            l.line
                .typographic_bounds(&mut ascent, &mut descent, &mut leading)
        };
        let start = l.range.location.max(0);
        let end = l.hit_end.max(start);
        LineBox {
            line: &l.line,
            start,
            end,
            content_end: end.saturating_sub(l.break_len).max(start),
            x: l.origin.x,
            // As `TextEngine::lines` places it.
            top: layout.height - (l.origin.y + ascent),
            bottom: layout.height - (l.origin.y - descent),
            leading,
            width,
        }
    }

    /// Its height as `TextEngine::lines` reports it.
    fn height(&self) -> CGFloat {
        self.bottom - self.top + self.leading
    }

    /// The x of the caret before character `index`.
    fn x_of(&self, index: CFIndex) -> CGFloat {
        // SAFETY: a valid line; no secondary offset wanted.
        self.x
            + unsafe {
                self.line
                    .offset_for_string_index(index, std::ptr::null_mut())
            }
    }

    /// The x of the caret at `index`: where the characters before it end
    /// (`upstream`) or the ones after it start, which differ where
    /// bidirectional text meets.
    fn caret_x(&self, index: CFIndex, upstream: bool) -> CGFloat {
        let mut secondary = CGFloat::NAN;
        // SAFETY: a valid line and out pointer.
        let primary = unsafe { self.line.offset_for_string_index(index, &mut secondary) };
        // CoreText may leave the secondary offset alone where there is none.
        self.x
            + if upstream && secondary.is_finite() {
                secondary
            } else {
                primary
            }
    }

    /// The caret index nearest to `x`.
    fn caret_at(&self, x: CGFloat) -> CFIndex {
        // SAFETY: a valid line.
        let index = unsafe {
            self.line
                .string_index_for_position(CGPoint::new(x - self.x, 0.0))
        };
        index.clamp(self.start, self.end)
    }

    /// How far `y` is above or below it (0 inside).
    fn distance(&self, y: CGFloat) -> CGFloat {
        if y < self.top {
            self.top - y
        } else if y > self.bottom {
            y - self.bottom
        } else {
            0.0
        }
    }

    /// Fills `spans` with the stretches of x the characters `a..b` cover,
    /// left to right, adjacent ones joined: one per run (bidirectional text
    /// splits a range), through the line's end when the range goes on past
    /// it. The ellipsis token is never covered.
    fn spans(&self, a: CFIndex, b: CFIndex, spans: &mut Vec<(CGFloat, CGFloat)>) {
        spans.clear();
        let past = b > self.end;
        let (a, b) = (a.max(self.start), b.min(self.end));
        let (mut text_left, mut text_right) = (CGFloat::INFINITY, CGFloat::NEG_INFINITY);
        let (mut first_rtl, mut last_rtl) = (false, false);
        // SAFETY: the line's own run array (of CTRuns).
        let runs = unsafe { self.line.glyph_runs() };
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
            if range.location <= self.start {
                first_rtl = rtl;
            }
            if run_end >= self.end {
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
                    self.x_of(index)
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
}

/// The lines of `layout` in its content box.
fn line_boxes(layout: &CoreTextLayout) -> impl Iterator<Item = LineBox<'_>> {
    layout.lines.iter().map(|l| LineBox::of(layout, l))
}

/// How many UTF-16 units of a hard line break (`\n`, `\r\n`, ...) end the
/// characters `range` of `string`.
fn break_len(string: &CFAttributedString, range: CFRange) -> CFIndex {
    let Some(chars) = string.string() else {
        return 0;
    };
    let end = range.location + range.length;
    let len = chars.length();
    let at = |i: CFIndex| {
        if i < range.location.max(0) || i >= end.min(len) {
            return None;
        }
        // SAFETY: an index within the string.
        Some(unsafe { chars.character_at_index(i) })
    };
    let is_break = |c: u16| matches!(c, 0x0a | 0x0d | 0x85 | 0x2028 | 0x2029);
    match at(end - 1) {
        Some(c) if is_break(c) => {
            if c == 0x0a && at(end - 2) == Some(0x0d) {
                2
            } else {
                1
            }
        }
        _ => 0,
    }
}

/// A UTF-16 offset as a CoreText index.
fn to_index(offset: u32) -> CFIndex {
    CFIndex::try_from(offset).unwrap_or(CFIndex::MAX)
}

/// A CoreText index as a UTF-16 offset.
fn to_offset(index: CFIndex) -> u32 {
    u32::try_from(index.max(0)).unwrap_or(u32::MAX)
}

/// A box in the content box from CoreText numbers.
fn content_box(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat) -> Bounds<Points> {
    Bounds::new(
        Point::new(Points(x as f32), Points(y as f32)),
        Size::new(Points(width as f32), Points(height as f32)),
    )
}

impl CoreTextLayout {
    /// The caret position nearest `(x, y)` (the content box, y down): on
    /// the line at that height (the first above the text, the last below
    /// it), at the caret edge nearest x. Past the end of a soft wrapped line
    /// it is the line's end, upstream; a hard break is never passed.
    pub(crate) fn hit_test(&self, x: CGFloat, y: CGFloat) -> TextPosition {
        let mut found = None;
        for (i, b) in line_boxes(self).enumerate() {
            let below = y >= b.top + b.height();
            found = Some((i, b));
            if !below {
                break;
            }
        }
        let Some((i, line)) = found else {
            return TextPosition::default();
        };
        let index = line.caret_at(x).min(line.content_end);
        let wrapped = line.content_end == line.end
            && self
                .lines
                .get(i + 1)
                .is_some_and(|next| next.range.location == line.end);
        let affinity = if wrapped && index == line.end && index > line.start {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        TextPosition::new(to_offset(index), affinity)
    }

    /// The caret at `position` (the content box, y down): a box of no width
    /// as high as its line; `None` without lines.
    pub(crate) fn caret_rect(&self, position: TextPosition) -> Option<Bounds<Points>> {
        // `TextPosition::line` picks the line from the ranges alone.
        let ranges: Vec<nsh_core::TextLine> = self
            .lines
            .iter()
            .map(|l| nsh_core::TextLine {
                start: to_offset(l.range.location),
                end: to_offset(l.hit_end),
                ..Default::default()
            })
            .collect();
        let line = self.lines.get(position.line(&ranges)?)?;
        let line = LineBox::of(self, line);
        let index = to_index(position.offset).clamp(line.start, line.content_end);
        let upstream = position.affinity == Affinity::Upstream && index > line.start;
        Some(content_box(
            line.caret_x(index, upstream),
            line.top,
            0.0,
            line.height(),
        ))
    }

    /// Appends the boxes (the content box, y down) covering the characters
    /// of `range`, line high, one per stretch of adjacent characters of
    /// each line.
    pub(crate) fn range_rects(&self, range: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        if range.start >= range.end {
            return;
        }
        let (a, b) = (to_index(range.start), to_index(range.end));
        let mut spans = Vec::new();
        for line in line_boxes(self).filter(|l| l.end > a && l.start < b) {
            line.spans(a, b, &mut spans);
            out.extend(
                spans
                    .iter()
                    .map(|&(x1, x2)| content_box(x1, line.top, x2 - x1, line.height())),
            );
        }
    }
}

/// The UTF-16 offset of the character at `(x, y)` (view coordinates), with
/// a little slack around the glyphs; `None` off the text.
pub(crate) fn char_at(state: &crate::view::ViewState, x: f32, y: f32) -> Option<u32> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<CoreTextLayout>()?;
    let content = drawn.content;
    let (x, y) = (
        (x - content.origin.x.0) as CGFloat,
        (y - content.origin.y.0) as CGFloat,
    );
    const SLACK: CGFloat = 4.0;
    let line = line_boxes(layout)
        .filter(|l| x >= l.x - SLACK && x <= l.x + l.width + SLACK && l.distance(y) <= SLACK)
        .min_by(|a, b| a.distance(y).total_cmp(&b.distance(y)))?;
    let index = line.caret_at(x);
    // The caret nearest the point: the character is the one before it when
    // the point is left of the caret.
    let index = if x < line.x_of(index) && index > line.start {
        index - 1
    } else {
        index
    };
    (index < line.end.max(line.start + 1)).then_some(index as u32)
}

/// The pressable span (nested `<Text onPress>`) under `(x, y)` (view
/// coordinates).
pub(crate) fn link_at(
    state: &crate::view::ViewState,
    x: f32,
    y: f32,
) -> Option<nsh_core::TextLink> {
    let text = &state.text.as_ref()?.text;
    if text.links.is_empty() {
        return None;
    }
    text.link_at(char_at(state, x, y)?).cloned()
}

/// The caret offset nearest `(x, y)` (view coordinates): on the nearest
/// line, at the caret position nearest x.
pub(crate) fn caret_at(state: &crate::view::ViewState, x: f32, y: f32) -> u32 {
    let Some(drawn) = state.text.as_ref() else {
        return 0;
    };
    let Some(layout) = drawn.layout.downcast::<CoreTextLayout>() else {
        return 0;
    };
    let content = drawn.content;
    layout
        .hit_test(
            (x - content.origin.x.0) as CGFloat,
            (y - content.origin.y.0) as CGFloat,
        )
        .offset
}

/// The rectangles (view coordinates) the characters `start..end` of the
/// text view with `state` cover, one per line (the test agent's spans).
#[cfg(feature = "dev")]
pub(crate) fn range_rects(state: &crate::view::ViewState, start: u32, end: u32) -> Vec<CGRect> {
    let Some(drawn) = state.text.as_ref() else {
        return Vec::new();
    };
    let Some(layout) = drawn.layout.downcast::<CoreTextLayout>() else {
        return Vec::new();
    };
    selection_rects(layout, drawn.content, (start, end))
}

/// The rectangles (view coordinates) the selected `range` covers: the
/// layout's [`CoreTextLayout::range_rects`] moved to the content box.
fn selection_rects(
    layout: &CoreTextLayout,
    content: nsh_core::Bounds<nsh_core::Points>,
    (a, b): (u32, u32),
) -> Vec<CGRect> {
    let mut rects = Vec::new();
    layout.range_rects(a..b, &mut rects);
    rects
        .into_iter()
        .map(|r| {
            CGRect::new(
                CGPoint::new(
                    (content.origin.x.0 + r.origin.x.0) as CGFloat,
                    (content.origin.y.0 + r.origin.y.0) as CGFloat,
                ),
                CGSize::new(r.size.width.0 as CGFloat, r.size.height.0 as CGFloat),
            )
        })
        .collect()
}

// ---- Selection ----

/// How far (points) the mouse moves on selectable text before a drag
/// selects: past input's press slop where the press would fire (a link, an
/// `onPress`), so a click never does both.
const SELECT_SLOP: f32 = 3.0;
/// The same over a press target.
const SELECT_SLOP_PRESS: f32 = 10.0;

/// What a drag extends the selection by.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Unit {
    #[default]
    Char,
    Word,
    Paragraph,
}

/// The range selection of a selectable text view, desktop style: a mouse
/// drag selects characters, a double click words and a triple click the
/// paragraph (and drags on by them), Shift+click extends, Cmd+C copies,
/// Cmd+A selects all, Escape or a press anywhere else clears. Offsets are
/// UTF-16, as CoreText's string indices.
///
/// [`crate::input`] drives it ([`selection_down`], [`selection_drag`],
/// [`selection_up`], [`selection_key`]); the surface remembers which view
/// holds the selection ([`Selected`]).
#[derive(Default)]
pub(crate) struct Selection {
    /// The selected range (`start < end`).
    range: std::cell::Cell<Option<(u32, u32)>>,
    /// The range a drag started from (a caret, the word or paragraph
    /// pressed), which stays selected while it extends.
    anchor: std::cell::Cell<(u32, u32)>,
    unit: std::cell::Cell<Unit>,
    /// The pressed button moved far enough to select.
    dragging: std::cell::Cell<bool>,
    /// The press began over a press target (links, `onPress`).
    over_press: std::cell::Cell<bool>,
}

/// The text selection of a surface: the view whose text was last pressed
/// to select (it takes Cmd+A, and Cmd+C and Escape while it has a
/// selection), or the selectable view last pressed (`area`). Only one view
/// or area has a selection at a time, as a window has one focus.
#[derive(Default)]
pub(crate) struct Selected {
    view: RefCell<Option<objc2::rc::Weak<crate::view::ViewObj>>>,
    /// The selection of the selectable view last pressed.
    pub(crate) area: crate::selectable_view::AreaSelection,
}

impl Selected {
    fn get(&self) -> Option<crate::view::NshView> {
        let view = self.view.borrow().as_ref()?.load()?;
        crate::view::NshView::from_ns(&view)
    }

    fn set(&self, view: Option<&crate::view::NshView>) {
        *self.view.borrow_mut() = view.map(|v| objc2::rc::Weak::from(&**v));
    }

    /// The selected view, if its text has a selection.
    fn with_range(&self) -> Option<crate::view::NshView> {
        self.get()
            .filter(|v| with_selection(v, |s, _| s.range.get().is_some()) == Some(true))
    }
}

/// Runs `f` with `view`'s selection, if its text is selectable.
fn with_selection<R>(
    view: &crate::view::NshView,
    f: impl FnOnce(&Selection, &DrawnText) -> R,
) -> Option<R> {
    let state = view.state();
    let drawn = state.text.as_ref()?;
    Some(f(drawn.selection.as_ref()?, drawn))
}

/// Sets `view`'s selection (`None` or empty clears it).
fn select(view: &crate::view::NshView, range: Option<(u32, u32)>) {
    let range = range.filter(|(a, b)| a < b);
    if with_selection(view, |s, _| s.range.replace(range) != range) == Some(true) {
        crate::surface::quiet(|| view.redraw());
    }
}

/// Sets the part of a selectable view's selection `view`'s text shows
/// (`None` or empty clears it).
pub(crate) fn set_area_range(view: &crate::view::NshView, range: Option<(u32, u32)>) {
    let range = range.filter(|(a, b)| a < b);
    let changed = view
        .state()
        .text
        .as_ref()
        .is_some_and(|t| t.area_range.replace(range) != range);
    if changed {
        crate::surface::quiet(|| view.redraw());
    }
}

/// Clears the surface's selection (a text's or an area's).
pub(crate) fn clear(surface: &crate::surface::Surface) {
    if let Some(view) = surface.selection.get() {
        select(&view, None);
    }
    surface.selection.set(None);
    surface.selection.area.clear();
}

/// The primary button went down: on `view`'s selectable text at `(x, y)`
/// (view coordinates), or elsewhere (`None`), the `clicks`th click in a
/// row; `over_press` if a press target (a link, `onPress`) is under it.
/// Clears the selection of any other view; on the text, starts selecting
/// (a double click a word, a triple click the paragraph, Shift extends).
#[allow(clippy::too_many_arguments)]
pub(crate) fn selection_down(
    surface: &crate::surface::Surface,
    view: Option<&crate::view::NshView>,
    x: f32,
    y: f32,
    clicks: usize,
    shift: bool,
    over_press: bool,
) {
    let view = view.filter(|v| selectable(&v.state()));
    // A press outside the area that has the selection.
    surface.selection.area.clear();
    if surface.selection.get().as_ref() != view {
        clear(surface);
    }
    let Some(view) = view else { return };
    surface.selection.set(Some(view));
    let (caret, at, text) = {
        let state = view.state();
        let Some(drawn) = &state.text else { return };
        let caret = caret_at(&state, x, y);
        let at = char_at(&state, x, y).unwrap_or(caret);
        (caret, at, drawn.text.clone())
    };
    let range = with_selection(view, |s, _| {
        s.over_press.set(over_press);
        match clicks {
            0 | 1 if shift => {
                // Extends from the end away from the press.
                let anchor = match s.range.get() {
                    Some((a, b)) if caret <= a => (b, b),
                    Some((a, _)) => (a, a),
                    None => (caret, caret),
                };
                s.anchor.set(anchor);
                s.unit.set(Unit::Char);
                s.dragging.set(true);
                Some(extend(&text.text, anchor, caret, Unit::Char))
            }
            0 | 1 => {
                s.anchor.set((caret, caret));
                s.unit.set(Unit::Char);
                s.dragging.set(false);
                None
            }
            n => {
                let unit = if n == 2 { Unit::Word } else { Unit::Paragraph };
                let range = unit_at(&text.text, at, unit);
                s.anchor.set(range);
                s.unit.set(unit);
                s.dragging.set(true);
                Some(range)
            }
        }
    });
    if let Some(range) = range {
        select(view, range);
    }
}

/// The primary button, pressed on `view`'s selectable text, moved by
/// `(dx, dy)` from where it went down, to `(x, y)` (view coordinates).
/// True while the drag selects (past a slop): presses must not fire then.
pub(crate) fn selection_drag(
    view: &crate::view::NshView,
    dx: f32,
    dy: f32,
    x: f32,
    y: f32,
) -> bool {
    let started = with_selection(view, |s, _| {
        if !s.dragging.get() {
            let slop = if s.over_press.get() {
                SELECT_SLOP_PRESS
            } else {
                SELECT_SLOP
            };
            if dx.hypot(dy) <= slop {
                return false;
            }
            s.dragging.set(true);
        }
        true
    });
    if started != Some(true) {
        return false;
    }
    let range = {
        let state = view.state();
        let caret = caret_at(&state, x, y);
        with_selection(view, |s, drawn| {
            extend(&drawn.text.text, s.anchor.get(), caret, s.unit.get())
        })
    };
    if let Some(range) = range {
        select(view, Some(range));
    }
    true
}

/// The primary button, pressed on `view`'s selectable text, went up. True
/// if it ended a selecting drag.
pub(crate) fn selection_up(view: &crate::view::NshView) -> bool {
    with_selection(view, |s, _| s.dragging.replace(false)) == Some(true)
}

/// A key went down: Cmd+C copies the selection, Escape clears it, Cmd+A
/// selects all of the last pressed selectable text. True if it was
/// handled.
pub(crate) fn selection_key(
    surface: &crate::surface::Surface,
    event: &objc2_app_kit::NSEvent,
) -> bool {
    use objc2_app_kit::NSEventModifierFlags;
    let command = event
        .modifierFlags()
        .contains(NSEventModifierFlags::Command);
    match crate::input::shortcut_key(event) {
        Some('c') if command => copy(surface),
        Some('a') if command => select_all(surface),
        // Escape.
        _ if event.keyCode() == 53
            && (surface.selection.with_range().is_some()
                || surface.selection.area.has_selection()) =>
        {
            clear(surface);
            true
        }
        _ => false,
    }
}

/// Copies the selection to the general pasteboard (the Edit menu's Copy).
/// False if there is none.
pub(crate) fn copy(surface: &crate::surface::Surface) -> bool {
    let Some(text) = surface.selection.area.text().or_else(|| {
        surface
            .selection
            .with_range()
            .and_then(|v| selected_text(&v))
    }) else {
        return false;
    };
    let board = objc2_app_kit::NSPasteboard::generalPasteboard();
    board.clearContents();
    // SAFETY: an immutable AppKit constant.
    let kind = unsafe { objc2_app_kit::NSPasteboardTypeString };
    board.setString_forType(&objc2_foundation::NSString::from_str(&text), kind);
    true
}

/// Selects all of the last pressed selectable text or selectable view (the
/// Edit menu's Select All). False if there is none.
pub(crate) fn select_all(surface: &crate::surface::Surface) -> bool {
    if surface.selection.area.select_all() {
        return true;
    }
    let Some(view) = surface.selection.get() else {
        return false;
    };
    let Some(len) = view.state().text.as_ref().map(|t| t.text.len_utf16()) else {
        return false;
    };
    select(&view, Some((0, len)));
    true
}

/// The selected text, without attachments' placeholders.
fn selected_text(view: &crate::view::NshView) -> Option<String> {
    let state = view.state();
    let drawn = state.text.as_ref()?;
    let (a, b) = drawn.selection.as_ref()?.range.get()?;
    let units: Vec<u16> = drawn
        .text
        .text
        .encode_utf16()
        .skip(a as usize)
        .take((b - a) as usize)
        .collect();
    Some(String::from_utf16_lossy(&units).replace(nsh_core::ATTACHMENT_CHAR, ""))
}

/// The selection from `anchor` (a range) to `caret`, by `unit`.
fn extend(text: &str, anchor: (u32, u32), caret: u32, unit: Unit) -> (u32, u32) {
    let (a, b) = match unit {
        Unit::Char => (caret, caret),
        // The unit after the caret going forward, before it going back.
        _ if caret >= anchor.1 => unit_at(text, caret.saturating_sub(1).max(anchor.0), unit),
        _ => unit_at(text, caret, unit),
    };
    (a.min(anchor.0), b.max(anchor.1))
}

/// A character's class for word selection.
fn word_class(c: char) -> u8 {
    let cjk = matches!(c as u32,
        0x2E80..=0x2FDF | 0x3040..=0x30FF | 0x3100..=0x31FF | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0x20000..=0x3FFFF);
    if c.is_whitespace() {
        0
    } else if cjk {
        2
    } else if c.is_alphanumeric() || c == '_' {
        1
    } else {
        3
    }
}

/// The word or paragraph (`unit`) holding the character at `index`
/// (UTF-16): a run of letters and digits (apostrophes inside them too),
/// of CJK characters or of spaces, or one other character.
fn unit_at(text: &str, index: u32, unit: Unit) -> (u32, u32) {
    let chars: Vec<(u32, char)> = text
        .chars()
        .scan(0u32, |at, c| {
            let i = *at;
            *at += c.len_utf16() as u32;
            Some((i, c))
        })
        .collect();
    let len = chars.last().map_or(0, |&(i, c)| i + c.len_utf16() as u32);
    let Some(k) = chars.iter().rposition(|&(i, _)| i <= index) else {
        return (0, 0);
    };
    let end_of = |j: usize| chars.get(j).map_or(len, |&(i, _)| i);
    match unit {
        Unit::Char => (chars[k].0, end_of(k + 1)),
        Unit::Paragraph => {
            let sep = |c: char| matches!(c, '\n' | '\r' | '\u{2029}');
            let start = chars[..k]
                .iter()
                .rposition(|&(_, c)| sep(c))
                .map_or(0, |j| j + 1);
            let end = chars[k..]
                .iter()
                .position(|&(_, c)| sep(c))
                .map_or(chars.len(), |j| k + j);
            (end_of(start), end_of(end))
        }
        Unit::Word => {
            let class = |j: usize| {
                let c = chars[j].1;
                let word = |j: Option<usize>| {
                    j.and_then(|j| chars.get(j))
                        .is_some_and(|&(_, c)| word_class(c) == 1)
                };
                if matches!(c, '\'' | '\u{2019}') && word(j.checked_sub(1)) && word(Some(j + 1)) {
                    1
                } else {
                    word_class(c)
                }
            };
            let own = class(k);
            if own == 3 {
                return (chars[k].0, end_of(k + 1));
            }
            let mut start = k;
            while start > 0 && class(start - 1) == own {
                start -= 1;
            }
            let mut end = k + 1;
            while end < chars.len() && class(end) == own {
                end += 1;
            }
            (chars[start].0, end_of(end))
        }
    }
}

/// Draws the decoration lines CoreText does not: strikethroughs, and
/// underlines with a style, thickness or offset (y-up text space).
fn draw_decorations(cx: &CGContext, line: &LaidLine) {
    // SAFETY: the line's own run array (of CTRuns) and their attribute
    // dictionaries, whose values have the types set by the text engine.
    unsafe {
        let runs = line.line.glyph_runs();
        for i in 0..runs.count() {
            let run = &*runs.value_at_index(i).cast::<CTRun>();
            let attributes = run.attributes();
            let attributes: &CFDictionary<CFString, CFType> = attributes.cast_unchecked();
            let strike = attributes
                .get(strikethrough_key())
                .and_then(|c| c.downcast::<CGColor>().ok());
            let under = attributes
                .get(underline_key())
                .and_then(|c| c.downcast::<CGColor>().ok());
            if strike.is_none() && under.is_none() {
                continue;
            }
            let Some(font) = attributes
                .get(kCTFontAttributeName)
                .and_then(|f| f.downcast::<CTFont>().ok())
            else {
                continue;
            };
            let (mut style, mut thickness, mut offset) = (0, 0.0, CGFloat::NAN);
            if let Some(d) = attributes
                .get(decoration_key())
                .and_then(|d| d.downcast::<CFArray>().ok())
            {
                let n = |i: CFIndex| {
                    (*d.value_at_index(i).cast::<CFNumber>())
                        .as_cgfloat()
                        .unwrap_or(0.0)
                };
                style = n(0) as i32;
                thickness = n(1);
                offset = n(2);
            }
            if thickness <= 0.0 {
                thickness = font.underline_thickness().max(1.0);
            }
            let range = run.string_range();
            let x = line.origin.x
                + line
                    .line
                    .offset_for_string_index(range.location, std::ptr::null_mut());
            let width = run.typographic_bounds(
                CFRange {
                    location: 0,
                    length: 0,
                },
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            );
            if let Some(color) = strike {
                let y = line.origin.y + font.x_height() / 2.0;
                stroke_decoration(cx, &color, style, x, y, width, thickness);
            }
            if let Some(color) = under {
                // Below the baseline: the font's position, or the offset.
                let below = if offset.is_nan() {
                    -font.underline_position()
                } else {
                    offset + thickness / 2.0
                };
                stroke_decoration(
                    cx,
                    &color,
                    style,
                    x,
                    line.origin.y - below,
                    width,
                    thickness,
                );
            }
        }
    }
}

/// One decoration line centered on `y` (y-up), `style` as encoded by the
/// text engine: solid, double, dotted, dashed, wavy.
fn stroke_decoration(
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
            CGContext::set_line_cap(c, objc2_core_graphics::CGLineCap::Round);
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

#[cfg(test)]
mod tests {
    use nsh_core::{AttributedText, Points, ResolvedTextStyle, Size, TextEngine, VerticalAlign};

    use super::CoreTextEngine;

    /// The baseline of the first line, the attachment's top and the line's
    /// extent above and below the baseline.
    fn place(align: VerticalAlign) -> (f32, f32, f32, f32) {
        let engine = CoreTextEngine::default();
        let style = ResolvedTextStyle {
            font_size: Points(14.0),
            ..ResolvedTextStyle::default()
        };
        let mut t = AttributedText::default();
        t.push("Ax", style);
        let mut alignments = nsh_core::AttachmentAlignments::default();
        alignments.push(&mut t, Size::new(Points(10.0), Points(30.0)), align, style);
        let prepared = engine.prepare_aligned(&t, &alignments);
        let size = engine.measure(&prepared, None);
        let layout = engine.layout(&prepared, size);
        let line = engine.lines(&layout).remove(0);
        let top = engine.attachments(&layout)[0].expect("shown").y.0;
        let baseline = line.y.0 + line.ascender.0;
        (baseline, top, line.ascender.0, line.descender.0)
    }

    #[test]
    fn attachments_sit_by_vertical_align() {
        let font = CoreTextEngine::default().fonts.get(&ResolvedTextStyle {
            font_size: Points(14.0),
            ..ResolvedTextStyle::default()
        });
        // SAFETY: a valid font.
        let (ascent, descent, x) = unsafe { (font.ascent(), font.descent(), font.x_height()) };
        let (ascent, descent, x) = (ascent as f32, descent as f32, x as f32);
        let near = |a: f32, b: f32| (a - b).abs() < 0.5;

        let (baseline, top, up, down) = place(VerticalAlign::Baseline);
        assert!(near(top, baseline - 30.0), "{top} {baseline}");
        assert!(near(up, 30.0) && near(down, descent), "{up} {down}");

        // Its top at the font's: the line grows below the baseline.
        let (baseline, top, up, down) = place(VerticalAlign::TextTop);
        assert!(near(top, baseline - ascent), "{top} {baseline}");
        assert!(near(up, ascent) && near(down, 30.0 - ascent), "{up} {down}");

        // Its bottom at the font's (Android's `ImageSpan` default).
        let (baseline, top, up, down) = place(VerticalAlign::TextBottom);
        assert!(near(top + 30.0, baseline + descent), "{top} {baseline}");
        assert!(
            near(up, 30.0 - descent) && near(down, descent),
            "{up} {down}"
        );

        let (baseline, top, _, _) = place(VerticalAlign::Middle);
        assert!(near(top + 15.0, baseline - x / 2.0), "{top} {baseline}");
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

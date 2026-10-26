//! DirectWrite text engine (engine thread) and text drawing (main thread).
//!
//! Text is typeset once, on the engine thread, with DirectWrite's shared
//! factory (free-threaded). Each prepared text keeps an `IDWriteTextLayout`
//! that measuring re-breaks at every width asked for (no reshaping); the
//! final layout ([`WinLayout`]) is plain data: per glyph run the font face,
//! glyph ids, advances and offsets, and the UTF-16 offset of each glyph's
//! cluster, recorded by drawing the layout into a text renderer of our own
//! ([`Recorder`]). The main thread draws those runs with Direct2D
//! (`DrawGlyphRun`) where the engine put them, so what was measured is what
//! is drawn, and hit-tests them for selections and links.
//!
//! Line heights follow Pango's (and so the Linux backend's) model rather
//! than DirectWrite's: each span is as tall as its own font's ascent and
//! descent (a fallback font for CJK or emoji does not grow the line), an
//! explicit `lineHeight` spreads evenly above and below it, and an
//! attachment stands on the baseline. DirectWrite only breaks lines: it
//! lays them out on a fixed pitch ([`PITCH`]), which makes its own height
//! limit cut after exactly `numberOfLines` lines, and the lines are stacked
//! again from the spans they hold.
//!
//! Colors and decorations are not part of a layout: the core reuses a
//! layout for a text that only differs in them (`AttributedText::layout_eq`),
//! so they are read from the drawn text's spans, per glyph cluster.

use std::{
    cell::{Cell, RefCell},
    ffi::c_void,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use nsh_core::{
    ATTACHMENT_CHAR, Affinity, AttributedText, Bounds, Color, DecorationStyle, EllipsizeMode,
    EventKind, FontFamily, Points, ResolvedTextStyle, Size, TextAlign, TextEngine, TextLayout,
    TextLine, TextPosition, TextSpan, geometry::px,
};
use rustc_hash::FxHashMap;
use windows::{
    Win32::{
        Foundation::DWRITE_E_NOCOLOR,
        Graphics::{
            Direct2D::{
                CLSID_D2D1Shadow,
                Common::{D2D1_COLOR_F, D2D1_COMPOSITE_MODE_SOURCE_OVER},
                D2D1_CAP_STYLE_FLAT, D2D1_CAP_STYLE_ROUND, D2D1_DASH_STYLE_CUSTOM,
                D2D1_DASH_STYLE_SOLID, D2D1_DEVICE_CONTEXT_OPTIONS_NONE,
                D2D1_INTERPOLATION_MODE_LINEAR, D2D1_LINE_JOIN_ROUND, D2D1_PROPERTY_TYPE_FLOAT,
                D2D1_PROPERTY_TYPE_VECTOR4, D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION,
                D2D1_SHADOW_PROP_COLOR, D2D1_STROKE_STYLE_PROPERTIES1,
                D2D1_STROKE_TRANSFORM_TYPE_NORMAL, ID2D1DeviceContext, ID2D1Effect,
                ID2D1SolidColorBrush, ID2D1StrokeStyle1,
            },
            DirectWrite::{
                DWRITE_BREAK_CONDITION, DWRITE_BREAK_CONDITION_NEUTRAL, DWRITE_FONT_FEATURE,
                DWRITE_FONT_FEATURE_TAG, DWRITE_FONT_METRICS, DWRITE_FONT_STRETCH_NORMAL,
                DWRITE_FONT_STYLE, DWRITE_FONT_STYLE_ITALIC, DWRITE_FONT_STYLE_NORMAL,
                DWRITE_FONT_WEIGHT, DWRITE_GLYPH_OFFSET, DWRITE_GLYPH_RUN,
                DWRITE_GLYPH_RUN_DESCRIPTION, DWRITE_HIT_TEST_METRICS,
                DWRITE_INLINE_OBJECT_METRICS, DWRITE_LINE_METRICS,
                DWRITE_LINE_SPACING_METHOD_UNIFORM, DWRITE_MATRIX, DWRITE_MEASURING_MODE,
                DWRITE_MEASURING_MODE_NATURAL, DWRITE_OVERHANG_METRICS,
                DWRITE_READING_DIRECTION_LEFT_TO_RIGHT, DWRITE_READING_DIRECTION_RIGHT_TO_LEFT,
                DWRITE_STRIKETHROUGH, DWRITE_TEXT_ALIGNMENT, DWRITE_TEXT_ALIGNMENT_CENTER,
                DWRITE_TEXT_ALIGNMENT_JUSTIFIED, DWRITE_TEXT_ALIGNMENT_LEADING,
                DWRITE_TEXT_ALIGNMENT_TRAILING, DWRITE_TEXT_METRICS, DWRITE_TEXT_RANGE,
                DWRITE_TRIMMING, DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                DWRITE_TRIMMING_GRANULARITY_NONE, DWRITE_UNDERLINE, DWRITE_WORD_WRAPPING_NO_WRAP,
                DWRITE_WORD_WRAPPING_WRAP, IDWriteFactory2, IDWriteFactory5, IDWriteFontCollection,
                IDWriteFontCollection1, IDWriteFontFace, IDWriteFontFace2, IDWriteFontFile,
                IDWriteInMemoryFontFileLoader, IDWriteInlineObject, IDWriteInlineObject_Impl,
                IDWritePixelSnapping_Impl, IDWriteTextFormat, IDWriteTextLayout,
                IDWriteTextLayout1, IDWriteTextRenderer, IDWriteTextRenderer_Impl,
                IDWriteTypography,
            },
        },
    },
    core::{BOOL, HSTRING, IUnknown, Interface, Ref, implement},
};
use windows_core::ComObjectInterface;
use windows_numerics::Vector2;

use crate::{
    gfx::Gfx,
    render::{DrawCx, rect_f},
    view::{NshView, ViewState},
};

/// The line pitch DirectWrite lays lines out on, and the baseline in each
/// line: any constant works, since lines are stacked again from their
/// spans; a fixed pitch makes `numberOfLines` lines exactly
/// `numberOfLines * PITCH` tall for DirectWrite's height limit (and its
/// ellipsis).
const PITCH: f32 = 1024.0;
const PITCH_BASELINE: f32 = 768.0;

/// "No limit" for DirectWrite's layout box.
const UNBOUNDED: f32 = 1.0e9;
/// "No limit" for widths: small enough that positions measured from the
/// right (right-to-left, centered text) keep their fractions in an `f32`.
const UNBOUNDED_WIDTH: f32 = 8192.0;

/// Cap height and x height (in ems) of fonts whose tables do not say.
const CAP_HEIGHT: f32 = 0.7;
const X_HEIGHT: f32 = 0.5;

/// Ascent and descent (ems) when no font can be found at all.
const DEFAULT_METRICS: Metrics = Metrics {
    ascent: 1.07,
    descent: 0.26,
    cap: CAP_HEIGHT,
    x: X_HEIGHT,
};

/// A DirectWrite object shared between threads.
pub(crate) struct Shared<T>(pub(crate) T);

// SAFETY: the objects wrapped are those of DirectWrite's shared factory
// (font faces, files, collections, loaders), which are free-threaded;
// faces and collections are immutable once made.
unsafe impl<T> Send for Shared<T> {}
// SAFETY: as above.
unsafe impl<T> Sync for Shared<T> {}

// --- Custom fonts ---------------------------------------------------------------------

/// Fonts registered by any engine (`register_font`): one collection every
/// engine searches before the system's.
struct Registry {
    /// The loader of in-memory font files (registered once with the
    /// shared factory).
    loader: Option<IDWriteInMemoryFontFileLoader>,
    /// The registered files, with a hash of their data.
    files: Vec<(u64, IDWriteFontFile)>,
    /// A collection of all of them.
    collection: Option<IDWriteFontCollection1>,
}

static REGISTRY: Mutex<Shared<Registry>> = Mutex::new(Shared(Registry {
    loader: None,
    files: Vec::new(),
    collection: None,
}));

/// Bumped when a font is registered: engines resolve families again.
static FONT_GENERATION: AtomicU64 = AtomicU64::new(0);

fn hash(data: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    data.hash(&mut hasher);
    hasher.finish()
}

/// Adds the font in `data` to the registry's collection.
fn add_font(data: &[u8]) -> Result<(), String> {
    let factory: IDWriteFactory5 = crate::gfx::dwrite()
        .cast()
        .map_err(|_| "custom fonts need Windows 10 1703 or later".to_owned())?;
    let key = hash(data);
    let mut registry = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    let r = &mut registry.0;
    if r.files.iter().any(|(k, _)| *k == key) {
        return Ok(());
    }
    // SAFETY: COM calls on live objects; without an owner object
    // DirectWrite copies the font data, which only has to live through the
    // call.
    unsafe {
        if r.loader.is_none() {
            let loader = factory
                .CreateInMemoryFontFileLoader()
                .map_err(|e| e.to_string())?;
            factory
                .RegisterFontFileLoader(&loader)
                .map_err(|e| e.to_string())?;
            r.loader = Some(loader);
        }
        let Some(loader) = &r.loader else {
            return Err("no font loader".to_owned());
        };
        let file = loader
            .CreateInMemoryFontFileReference(
                &factory,
                data.as_ptr() as *const c_void,
                data.len() as u32,
                None::<&IUnknown>,
            )
            .map_err(|e| e.to_string())?;
        let builder = factory.CreateFontSetBuilder().map_err(|e| e.to_string())?;
        builder
            .AddFontFile(&file)
            .map_err(|e| format!("font rejected: {e}"))?;
        for (_, f) in &r.files {
            let _ = builder.AddFontFile(f);
        }
        let set = builder.CreateFontSet().map_err(|e| e.to_string())?;
        let collection = factory
            .CreateFontCollectionFromFontSet(&set)
            .map_err(|e| e.to_string())?;
        r.files.push((key, file));
        r.collection = Some(collection);
    }
    FONT_GENERATION.fetch_add(1, Ordering::Release);
    Ok(())
}

/// The registered fonts' collection.
fn custom_collection() -> Option<IDWriteFontCollection> {
    let registry = REGISTRY.lock().unwrap_or_else(|e| e.into_inner());
    registry.0.collection.as_ref().and_then(|c| c.cast().ok())
}

// --- Fonts ------------------------------------------------------------------------------

/// The family of the system's UI font (the message font: Segoe UI).
pub(crate) fn ui_family() -> Arc<str> {
    use windows::Win32::UI::WindowsAndMessaging::{
        NONCLIENTMETRICSW, SPI_GETNONCLIENTMETRICS, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS,
        SystemParametersInfoW,
    };
    let mut metrics = NONCLIENTMETRICSW {
        cbSize: std::mem::size_of::<NONCLIENTMETRICSW>() as u32,
        ..Default::default()
    };
    // SAFETY: the structure's size is set as the call requires.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETNONCLIENTMETRICS,
            metrics.cbSize,
            Some(&mut metrics as *mut _ as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    }
    .is_ok();
    let face = &metrics.lfMessageFont.lfFaceName;
    let len = face.iter().position(|c| *c == 0).unwrap_or(face.len());
    if ok && len > 0 {
        String::from_utf16_lossy(&face[..len]).into()
    } else {
        "Segoe UI".into()
    }
}

/// The families a `fontFamily` value names, in order: CSS generic and
/// system names map to Windows' fonts, a comma-separated stack stays a
/// list (DirectWrite takes one family: the first installed one is used).
fn family_names(name: &str, ui: &str) -> Vec<String> {
    let mut out = Vec::new();
    for family in name.split(',') {
        let family = family.trim().trim_matches(|c| c == '"' || c == '\'');
        let family = match family {
            "" => continue,
            "system-ui" | "-apple-system" | "BlinkMacSystemFont" | "ui-sans-serif"
            | "ui-rounded" | "sans-serif" => ui,
            "ui-monospace" | "monospace" => "Consolas",
            "ui-serif" | "serif" => "Times New Roman",
            "cursive" => "Comic Sans MS",
            "fantasy" => "Impact",
            f => f,
        };
        out.push(family.to_owned());
    }
    if out.is_empty() {
        out.push(ui.to_owned());
    }
    out
}

/// What apps written for Apple platforms name, as the fonts Windows has.
fn alias(family: &str) -> Option<&'static str> {
    Some(match family {
        "Menlo" | "Monaco" | "SF Mono" | "Courier" => "Consolas",
        "Times" | "New York" => "Times New Roman",
        "Helvetica" | "Helvetica Neue" => "Arial",
        _ => return None,
    })
}

fn font_style(italic: bool) -> DWRITE_FONT_STYLE {
    if italic {
        DWRITE_FONT_STYLE_ITALIC
    } else {
        DWRITE_FONT_STYLE_NORMAL
    }
}

/// Vertical metrics of a font, in ems.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Metrics {
    ascent: f32,
    descent: f32,
    cap: f32,
    x: f32,
}

impl Metrics {
    fn of(m: &DWRITE_FONT_METRICS) -> Metrics {
        let em = f32::from(m.designUnitsPerEm.max(1));
        let or = |v: u16, default: f32| {
            if v > 0 { f32::from(v) / em } else { default }
        };
        Metrics {
            ascent: f32::from(m.ascent) / em,
            descent: f32::from(m.descent) / em,
            cap: or(m.capHeight, CAP_HEIGHT),
            x: or(m.xHeight, X_HEIGHT),
        }
    }
}

/// The metrics of the font of `collection` named `name` nearest to
/// `weight` and `italic`, if the collection has the family.
fn find_font(
    collection: &IDWriteFontCollection,
    name: &str,
    weight: u16,
    italic: bool,
) -> Option<Metrics> {
    let name = HSTRING::from(name);
    let (mut index, mut exists) = (0u32, BOOL(0));
    // SAFETY: COM calls on a live collection with local out values.
    unsafe {
        collection
            .FindFamilyName(&name, &mut index, &mut exists)
            .ok()?;
        if !exists.as_bool() {
            return None;
        }
        let font = collection
            .GetFontFamily(index)
            .ok()?
            .GetFirstMatchingFont(
                DWRITE_FONT_WEIGHT(i32::from(weight)),
                DWRITE_FONT_STRETCH_NORMAL,
                font_style(italic),
            )
            .ok()?;
        let mut m = DWRITE_FONT_METRICS::default();
        font.GetMetrics(&mut m);
        Some(Metrics::of(&m))
    }
}

/// A `fontFamily` resolved to an installed (or registered) family.
#[derive(Debug)]
struct Face {
    /// The family name DirectWrite gets.
    name: HSTRING,
    /// It is a registered font (in [`custom_collection`]).
    custom: bool,
    /// Its primary font's metrics.
    metrics: Metrics,
}

/// Metrics of a font a run is set in.
#[derive(Debug)]
struct FontInfo {
    face: Shared<IDWriteFontFace>,
    /// Em size (points).
    size: f32,
    /// Top of the underline above the baseline, and its thickness.
    underline: (f32, f32),
    /// Top of the strikethrough above the baseline, and its thickness.
    strikethrough: (f32, f32),
    /// Cap height and x height (points), for `onTextLayout`.
    cap_x: (f32, f32),
    /// Ascent and descent (points), for span backgrounds.
    extents: (f32, f32),
    /// It has color glyphs (emoji).
    color: bool,
}

impl std::fmt::Debug for Shared<IDWriteFontFace> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("IDWriteFontFace")
    }
}

// --- The final layout ---------------------------------------------------------------------

/// A layer of a color glyph run (an emoji's colored parts).
struct Layer {
    face: Shared<IDWriteFontFace>,
    size: f32,
    glyphs: Box<[u16]>,
    advances: Box<[f32]>,
    offsets: Box<[DWRITE_GLYPH_OFFSET]>,
    /// Origin relative to its run's.
    dx: f32,
    dy: f32,
    /// Its color; `None` is the text's.
    color: Option<Color>,
}

/// A glyph run in one font, at its pen position in the content box.
struct Run {
    font: Arc<FontInfo>,
    /// Pen x of the first glyph: the left end of a left-to-right run, the
    /// right end of a right-to-left one (glyphs are in text order).
    x: f32,
    /// Baseline (points).
    baseline: f32,
    /// Bidi level (odd: right to left).
    bidi: u32,
    glyphs: Box<[u16]>,
    advances: Box<[f32]>,
    offsets: Box<[DWRITE_GLYPH_OFFSET]>,
    /// UTF-16 offset of each glyph's cluster.
    indices: Box<[u32]>,
    /// The color layers when the run has color glyphs.
    layers: Option<Box<[Layer]>>,
    /// Whether it is the ellipsis DirectWrite trimmed the text with: drawn,
    /// but not text a selection covers.
    sign: bool,
}

impl Run {
    fn rtl(&self) -> bool {
        self.bidi % 2 == 1
    }

    fn width(&self) -> f32 {
        self.advances.iter().sum()
    }

    /// The left edge and width of its glyphs, in text order.
    fn boxes(&self) -> impl Iterator<Item = (f32, f32, u32)> + '_ {
        let rtl = self.rtl();
        let mut pen = 0.0;
        self.advances
            .iter()
            .zip(self.indices.iter())
            .map(move |(&w, &index)| {
                let x = if rtl { self.x - pen - w } else { self.x + pen };
                pen += w;
                (x, w, index)
            })
    }

    /// Its left edge.
    fn left(&self) -> f32 {
        if self.rtl() {
            self.x - self.width()
        } else {
            self.x
        }
    }
}

/// One line of a final layout.
struct Line {
    info: TextLine,
    /// Its runs in [`WinLayout::runs`].
    runs: std::ops::Range<usize>,
}

/// An attachment as placed in a final layout.
struct Inline {
    /// Its placeholder (UTF-16 offset).
    index: u32,
    /// Left edge (content coordinates).
    x: f32,
    width: f32,
}

/// A box on a line a caret sits next to: a glyph, or an attachment.
struct Stop {
    /// Left edge (content coordinates).
    x: f32,
    width: f32,
    /// UTF-16 offset of the cluster (or the placeholder) it shows.
    index: u32,
    /// Whether it is right to left: its cluster starts at its right edge.
    rtl: bool,
    /// Whether it is a glyph of the trimming ellipsis.
    sign: bool,
}

/// A final layout: plain data, drawn on the main thread.
#[derive(Default)]
pub(crate) struct WinLayout {
    runs: Vec<Run>,
    lines: Vec<Line>,
    attachments: Vec<Option<(f32, f32)>>,
    /// The attachments placed, to hit test lines that hold them (the text
    /// is not at hand there).
    inline: Vec<Inline>,
}

// --- Recording ------------------------------------------------------------------------------

/// A glyph run as DirectWrite drew it.
struct RawRun {
    face: IDWriteFontFace,
    size: f32,
    x: f32,
    y: f32,
    bidi: u32,
    glyphs: Vec<u16>,
    advances: Vec<f32>,
    offsets: Vec<DWRITE_GLYPH_OFFSET>,
    indices: Vec<u32>,
    /// The glyphs of an ellipsis DirectWrite trimmed text with.
    sign: bool,
}

#[derive(Default)]
struct Recording {
    runs: Vec<RawRun>,
    /// Placeholders drawn: their number, top left.
    objects: Vec<(usize, f32, f32)>,
    /// The offset after the last glyph seen (where an ellipsis goes).
    next: u32,
}

/// A text renderer that records what a layout draws.
#[implement(IDWriteTextRenderer)]
struct Recorder {
    /// The attachments' inline objects (their pointers), in order.
    placeholders: Vec<usize>,
    out: RefCell<Recording>,
    /// While an ellipsis sign draws: the offset its glyphs stand for.
    sign: Cell<Option<u32>>,
}

impl IDWritePixelSnapping_Impl for Recorder_Impl {
    fn IsPixelSnappingDisabled(&self, _context: *const c_void) -> windows::core::Result<BOOL> {
        // Positions independent of the pixel grid: the main thread draws
        // at any scale and transform.
        Ok(true.into())
    }

    fn GetCurrentTransform(
        &self,
        _context: *const c_void,
        transform: *mut DWRITE_MATRIX,
    ) -> windows::core::Result<()> {
        // SAFETY: DirectWrite passes a valid out pointer.
        unsafe {
            *transform = DWRITE_MATRIX {
                m11: 1.0,
                m12: 0.0,
                m21: 0.0,
                m22: 1.0,
                dx: 0.0,
                dy: 0.0,
            };
        }
        Ok(())
    }

    fn GetPixelsPerDip(&self, _context: *const c_void) -> windows::core::Result<f32> {
        Ok(1.0)
    }
}

impl IDWriteTextRenderer_Impl for Recorder_Impl {
    fn DrawGlyphRun(
        &self,
        _context: *const c_void,
        x: f32,
        y: f32,
        _mode: DWRITE_MEASURING_MODE,
        run: *const DWRITE_GLYPH_RUN,
        description: *const DWRITE_GLYPH_RUN_DESCRIPTION,
        _effect: Ref<IUnknown>,
    ) -> windows::core::Result<()> {
        // SAFETY: DirectWrite passes a valid run (and description, when not
        // null) whose arrays hold `glyphCount` glyphs and `stringLength`
        // cluster entries, alive for the call.
        unsafe {
            let Some(run) = run.as_ref() else {
                return Ok(());
            };
            let Some(face) = (*run.fontFace).clone() else {
                return Ok(());
            };
            let n = run.glyphCount as usize;
            if n == 0 {
                return Ok(());
            }
            let glyphs = std::slice::from_raw_parts(run.glyphIndices, n).to_vec();
            let advances = if run.glyphAdvances.is_null() {
                vec![0.0; n]
            } else {
                std::slice::from_raw_parts(run.glyphAdvances, n).to_vec()
            };
            let offsets = if run.glyphOffsets.is_null() {
                vec![DWRITE_GLYPH_OFFSET::default(); n]
            } else {
                std::slice::from_raw_parts(run.glyphOffsets, n).to_vec()
            };
            let mut indices = vec![u32::MAX; n];
            let mut out = self.out.borrow_mut();
            match (self.sign.get(), description.as_ref()) {
                (Some(at), _) => indices.fill(at),
                (None, Some(d)) if !d.clusterMap.is_null() => {
                    let clusters =
                        std::slice::from_raw_parts(d.clusterMap, d.stringLength as usize);
                    // The first character of each cluster names its glyphs.
                    for (i, &g) in clusters.iter().enumerate().rev() {
                        if let Some(slot) = indices.get_mut(g as usize) {
                            *slot = d.textPosition + i as u32;
                        }
                    }
                    let mut last = d.textPosition;
                    for slot in &mut indices {
                        if *slot == u32::MAX {
                            *slot = last;
                        }
                        last = *slot;
                    }
                    out.next = out.next.max(d.textPosition + d.stringLength);
                }
                _ => indices.fill(out.next),
            }
            out.runs.push(RawRun {
                face,
                size: run.fontEmSize,
                x,
                y,
                bidi: run.bidiLevel,
                glyphs,
                advances,
                offsets,
                indices,
                sign: self.sign.get().is_some(),
            });
        }
        Ok(())
    }

    fn DrawUnderline(
        &self,
        _context: *const c_void,
        _x: f32,
        _y: f32,
        _underline: *const DWRITE_UNDERLINE,
        _effect: Ref<IUnknown>,
    ) -> windows::core::Result<()> {
        // Decorations are drawn from the spans, never set on layouts.
        Ok(())
    }

    fn DrawStrikethrough(
        &self,
        _context: *const c_void,
        _x: f32,
        _y: f32,
        _strikethrough: *const DWRITE_STRIKETHROUGH,
        _effect: Ref<IUnknown>,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn DrawInlineObject(
        &self,
        context: *const c_void,
        x: f32,
        y: f32,
        object: Ref<IDWriteInlineObject>,
        sideways: BOOL,
        rtl: BOOL,
        effect: Ref<IUnknown>,
    ) -> windows::core::Result<()> {
        let object = object.ok()?;
        let ptr = object.as_raw() as usize;
        if let Some(n) = self.placeholders.iter().position(|p| *p == ptr) {
            self.out.borrow_mut().objects.push((n, x, y));
            return Ok(());
        }
        // The ellipsis of trimmed text: it draws its glyphs through us.
        let at = self.out.borrow().next;
        self.sign.set(Some(at));
        let renderer: windows_core::InterfaceRef<'_, IDWriteTextRenderer> = self.as_interface_ref();
        // SAFETY: a COM call with the arguments DirectWrite gave us.
        let result = unsafe {
            object.Draw(
                (!context.is_null()).then_some(context),
                &*renderer,
                x,
                y,
                sideways.as_bool(),
                rtl.as_bool(),
                effect.as_ref(),
            )
        };
        self.sign.set(None);
        result
    }
}

/// An attachment's placeholder: an inline object of its size, all above
/// the baseline.
#[implement(IDWriteInlineObject)]
struct Placeholder {
    width: f32,
    height: f32,
}

impl IDWriteInlineObject_Impl for Placeholder_Impl {
    fn Draw(
        &self,
        _context: *const c_void,
        _renderer: Ref<IDWriteTextRenderer>,
        _x: f32,
        _y: f32,
        _sideways: BOOL,
        _rtl: BOOL,
        _effect: Ref<IUnknown>,
    ) -> windows::core::Result<()> {
        Ok(())
    }

    fn GetMetrics(&self) -> windows::core::Result<DWRITE_INLINE_OBJECT_METRICS> {
        Ok(DWRITE_INLINE_OBJECT_METRICS {
            width: self.width,
            height: self.height,
            baseline: self.height,
            supportsSideways: false.into(),
        })
    }

    fn GetOverhangMetrics(&self) -> windows::core::Result<DWRITE_OVERHANG_METRICS> {
        Ok(DWRITE_OVERHANG_METRICS::default())
    }

    fn GetBreakConditions(
        &self,
        before: *mut DWRITE_BREAK_CONDITION,
        after: *mut DWRITE_BREAK_CONDITION,
    ) -> windows::core::Result<()> {
        // SAFETY: DirectWrite passes valid out pointers.
        unsafe {
            *before = DWRITE_BREAK_CONDITION_NEUTRAL;
            *after = DWRITE_BREAK_CONDITION_NEUTRAL;
        }
        Ok(())
    }
}

// --- The engine ---------------------------------------------------------------------------

/// A span's line box: its primary font's ascent and descent (points) and
/// its `lineHeight` (0: the font's).
#[derive(Debug, Clone, Copy)]
struct SpanBox {
    start: u32,
    end: u32,
    ascent: f32,
    descent: f32,
    line_height: f32,
}

impl SpanBox {
    /// Its extent above and below the baseline: the font's, with an
    /// explicit line height spread evenly above and below (as Pango and
    /// CSS do).
    fn extents(&self) -> (f32, f32) {
        if self.line_height > 0.0 {
            let half = (self.line_height - self.ascent - self.descent) / 2.0;
            (self.ascent + half, self.descent + half)
        } else {
            (self.ascent, self.descent)
        }
    }
}

/// An attachment as its line holds it: placed by its `verticalAlign` in
/// its placeholder's font (`TextAttachment::ascent` and `extent`).
#[derive(Debug, Clone, Copy)]
struct AttachmentBox {
    /// Its placeholder (UTF-16 offset).
    index: u32,
    width: f32,
    height: f32,
    /// How far its top is above the baseline.
    top: f32,
    /// What its line reserves above and below the baseline.
    up: f32,
    down: f32,
}

/// A part of the original text placed in a layout's text: `(start, end)`
/// of the original at offset `at`.
type Piece = (u32, u32, u32);

/// The extent (left, right) of a run's glyphs that are not trailing
/// whitespace.
type Ink = Option<(f32, f32)>;

/// A layout of a text cut for an ellipsis of our own (`head`, `middle`,
/// the end of a paragraph).
struct Cut {
    layout: IDWriteTextLayout,
    placeholders: Vec<IDWriteInlineObject>,
    /// The parts of the original text it holds.
    pieces: Vec<Piece>,
    /// Its text.
    text: Vec<u16>,
}

/// True for the characters that end a line (DirectWrite gives them
/// glyphs of their own, which draw nothing).
fn is_break(unit: Option<&u16>) -> bool {
    matches!(
        unit,
        Some(0x0A | 0x0B | 0x0C | 0x0D | 0x85 | 0x2028 | 0x2029)
    )
}

/// The line metrics of a configured layout.
fn line_metrics(layout: &IDWriteTextLayout, buf: &mut Vec<DWRITE_LINE_METRICS>) {
    if buf.is_empty() {
        buf.resize(4, DWRITE_LINE_METRICS::default());
    }
    let mut count = 0u32;
    // SAFETY: COM calls with a buffer of the length passed.
    unsafe {
        if layout.GetLineMetrics(Some(buf), &mut count).is_err() && count as usize > buf.len() {
            buf.resize(count as usize, DWRITE_LINE_METRICS::default());
            let _ = layout.GetLineMetrics(Some(buf), &mut count);
        }
    }
    buf.truncate(count as usize);
}

/// What [`DWriteTextEngine::prepare`] makes.
pub(crate) struct Prepared {
    text: Vec<u16>,
    /// The layout every measurement re-breaks (engine thread only).
    layout: Option<IDWriteTextLayout>,
    /// Its format (cut layouts of `head` / `middle` ellipses).
    format: Option<IDWriteTextFormat>,
    /// The attachments' inline objects, in order.
    placeholders: Vec<IDWriteInlineObject>,
    spans: Vec<SpanBox>,
    /// The line box of text without spans.
    base: (f32, f32),
    /// The attachments, in order.
    attachments: Vec<AttachmentBox>,
    no_wrap: bool,
    max_lines: u32,
    /// `head` / `middle` ellipses are made by cutting the text (one line).
    cut: bool,
    /// The content, for cut layouts.
    attributed: Option<Box<AttributedText>>,
    /// Line metrics of the last configuration (a reused buffer).
    lines: RefCell<Vec<DWRITE_LINE_METRICS>>,
    /// The base style's size (lines without runs).
    base_size: f32,
    /// The width of an ellipsis at the end of a paragraph (0: none).
    ellipsis_width: f32,
}

/// What resolves a family: `(fontFamily, weight, italic)`.
type FaceKey = (Option<FontFamily>, u16, bool);

/// The text engine of a surface (one per engine thread).
pub(crate) struct DWriteTextEngine {
    factory: IDWriteFactory2,
    system: Option<IDWriteFontCollection>,
    ui_family: Arc<str>,
    /// Resolved families by `(fontFamily, weight, italic)`.
    faces: RefCell<FxHashMap<FaceKey, Rc<Face>>>,
    /// Fonts runs are set in, by face and size.
    fonts: RefCell<FxHashMap<(usize, u32), Arc<FontInfo>>>,
    /// Typographies by `fontVariant`.
    typographies: RefCell<FxHashMap<u8, IDWriteTypography>>,
    /// The registered fonts as of [`FONT_GENERATION`].
    custom: RefCell<(u64, Option<IDWriteFontCollection>)>,
}

/// The first strong direction of `s`: right to left for Hebrew and Arabic
/// letters, left to right for other letters.
fn first_strong(s: &str) -> Option<bool> {
    s.chars().find_map(|c| {
        let u = c as u32;
        if matches!(u, 0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF)
        {
            Some(true)
        } else if c.is_alphabetic() {
            Some(false)
        } else {
            None
        }
    })
}

/// The index of the span containing the UTF-16 offset `index` (the last
/// one past the end).
fn span_at(spans: &[TextSpan], index: u32) -> usize {
    spans
        .partition_point(|s| s.end <= index)
        .min(spans.len().saturating_sub(1))
}

/// Where the original offset `index` is in a layout made of `pieces`.
fn to_cut(pieces: &[Piece], index: u32) -> Option<u32> {
    pieces
        .iter()
        .find(|&&(s, e, _)| index >= s && index < e)
        .map(|&(s, _, at)| at + index - s)
}

/// The original offset of `index` in a layout made of `pieces`: an
/// ellipsis between them stands for the first character cut.
fn from_cut(pieces: &[Piece], index: u32) -> u32 {
    let mut gap = 0;
    for &(s, e, at) in pieces {
        if index < at {
            return gap;
        }
        if index < at + (e - s) {
            return s + index - at;
        }
        gap = e;
    }
    gap
}

fn range(start: u32, end: u32) -> DWRITE_TEXT_RANGE {
    DWRITE_TEXT_RANGE {
        startPosition: start,
        length: end.saturating_sub(start),
    }
}

impl DWriteTextEngine {
    /// An engine whose default family is `ui_family`.
    pub(crate) fn new(ui_family: Arc<str>) -> Self {
        let factory = crate::gfx::dwrite();
        let mut system = None;
        // SAFETY: a COM call with a local out value.
        let _ = unsafe { factory.GetSystemFontCollection(&mut system, false) };
        DWriteTextEngine {
            factory,
            system,
            ui_family,
            faces: RefCell::default(),
            fonts: RefCell::default(),
            typographies: RefCell::default(),
            custom: RefCell::new((u64::MAX, None)),
        }
    }

    /// The registered fonts' collection, current.
    fn custom(&self) -> Option<IDWriteFontCollection> {
        let generation = FONT_GENERATION.load(Ordering::Acquire);
        let mut custom = self.custom.borrow_mut();
        if custom.0 != generation {
            *custom = (generation, custom_collection());
            // Families resolve differently now (one may have been missing).
            self.faces.borrow_mut().clear();
        }
        custom.1.clone()
    }

    /// The installed family `style` is set in.
    fn face(&self, style: &ResolvedTextStyle) -> Rc<Face> {
        let custom = self.custom();
        let key = (style.font_family, style.font_weight, style.italic);
        if let Some(face) = self.faces.borrow().get(&key) {
            return face.clone();
        }
        let names = match style.font_family {
            Some(f) => family_names(&f.name(), &self.ui_family),
            None => vec![self.ui_family.to_string()],
        };
        let (weight, italic) = (style.font_weight, style.italic);
        let find = |name: &str| -> Option<Face> {
            if let Some(c) = &custom
                && let Some(metrics) = find_font(c, name, weight, italic)
            {
                return Some(Face {
                    name: name.into(),
                    custom: true,
                    metrics,
                });
            }
            let metrics = find_font(self.system.as_ref()?, name, weight, italic)?;
            Some(Face {
                name: name.into(),
                custom: false,
                metrics,
            })
        };
        let face = names
            .iter()
            .find_map(|n| find(n))
            .or_else(|| names.iter().find_map(|n| alias(n).and_then(find)))
            .unwrap_or_else(|| {
                // Not installed: DirectWrite falls back per character;
                // lines take the UI font's metrics.
                let metrics = self
                    .system
                    .as_ref()
                    .and_then(|s| find_font(s, &self.ui_family, weight, italic))
                    .unwrap_or(DEFAULT_METRICS);
                Face {
                    name: names[0].as_str().into(),
                    custom: false,
                    metrics,
                }
            });
        let face = Rc::new(face);
        self.faces.borrow_mut().insert(key, face.clone());
        face
    }

    fn typography(&self, variant: nsh_core::FontVariant) -> Option<IDWriteTypography> {
        if let Some(t) = self.typographies.borrow().get(&variant.0) {
            return Some(t.clone());
        }
        // SAFETY: COM calls on live objects.
        let typography = unsafe {
            let t = self.factory.CreateTypography().ok()?;
            for tag in variant.tags() {
                let b = tag.as_bytes();
                let tag = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                let _ = t.AddFontFeature(DWRITE_FONT_FEATURE {
                    nameTag: DWRITE_FONT_FEATURE_TAG(tag),
                    parameter: 1,
                });
            }
            t
        };
        self.typographies
            .borrow_mut()
            .insert(variant.0, typography.clone());
        Some(typography)
    }

    /// The paragraph format of `t`.
    fn format(&self, t: &AttributedText, rtl: bool) -> Option<IDWriteTextFormat> {
        let base = t
            .spans
            .first()
            .map_or_else(ResolvedTextStyle::default, |s| s.style);
        let face = self.face(&base);
        let custom = if face.custom { self.custom() } else { None };
        // SAFETY: COM calls on live objects with valid strings.
        unsafe {
            let format = self
                .factory
                .CreateTextFormat(
                    &face.name,
                    custom.as_ref(),
                    DWRITE_FONT_WEIGHT(i32::from(base.font_weight)),
                    font_style(base.italic),
                    DWRITE_FONT_STRETCH_NORMAL,
                    base.font_size.0.max(0.1),
                    &HSTRING::new(),
                )
                .ok()?;
            let (left, right) = if rtl {
                (
                    DWRITE_TEXT_ALIGNMENT_TRAILING,
                    DWRITE_TEXT_ALIGNMENT_LEADING,
                )
            } else {
                (
                    DWRITE_TEXT_ALIGNMENT_LEADING,
                    DWRITE_TEXT_ALIGNMENT_TRAILING,
                )
            };
            let align: DWRITE_TEXT_ALIGNMENT = match t.align {
                // React Native: the right side in right-to-left layouts.
                TextAlign::Auto if t.rtl || rtl => right,
                TextAlign::Auto | TextAlign::Left => left,
                TextAlign::Center => DWRITE_TEXT_ALIGNMENT_CENTER,
                TextAlign::Right => right,
                TextAlign::Justify => DWRITE_TEXT_ALIGNMENT_JUSTIFIED,
            };
            let _ = format.SetTextAlignment(align);
            let _ = format.SetReadingDirection(if rtl {
                DWRITE_READING_DIRECTION_RIGHT_TO_LEFT
            } else {
                DWRITE_READING_DIRECTION_LEFT_TO_RIGHT
            });
            let _ = format.SetWordWrapping(if t.no_wrap {
                DWRITE_WORD_WRAPPING_NO_WRAP
            } else {
                DWRITE_WORD_WRAPPING_WRAP
            });
            let _ =
                format.SetLineSpacing(DWRITE_LINE_SPACING_METHOD_UNIFORM, PITCH, PITCH_BASELINE);
            if t.max_lines > 0 && t.ellipsize != EllipsizeMode::Clip {
                // At the end of the last line that shows, and of lines
                // that do not wrap.
                let trimming = DWRITE_TRIMMING {
                    granularity: DWRITE_TRIMMING_GRANULARITY_CHARACTER,
                    delimiter: 0,
                    delimiterCount: 0,
                };
                let sign = self.factory.CreateEllipsisTrimmingSign(&format).ok();
                let _ = format.SetTrimming(&trimming, sign.as_ref());
            }
            Some(format)
        }
    }

    /// A layout of `text` made of `pieces` of `t` (with an ellipsis set in
    /// `ellipsis`'s style at its offset).
    fn build(
        &self,
        text: &[u16],
        format: &IDWriteTextFormat,
        t: &AttributedText,
        pieces: &[Piece],
        ellipsis: Option<(u32, ResolvedTextStyle)>,
        placeholders: &[IDWriteInlineObject],
    ) -> Option<IDWriteTextLayout> {
        // SAFETY: COM calls on live objects with ranges inside the text.
        unsafe {
            let layout = self
                .factory
                .CreateTextLayout(text, format, UNBOUNDED_WIDTH, UNBOUNDED)
                .ok()?;
            let spacing: Option<IDWriteTextLayout1> = layout.cast().ok();
            let apply = |r: DWRITE_TEXT_RANGE, style: &ResolvedTextStyle| {
                if r.length == 0 {
                    return;
                }
                let face = self.face(style);
                let _ = layout.SetFontFamilyName(&face.name, r);
                if face.custom {
                    let _ = layout.SetFontCollection(self.custom().as_ref(), r);
                }
                let _ = layout.SetFontSize(style.font_size.0.max(0.1), r);
                let _ = layout.SetFontWeight(DWRITE_FONT_WEIGHT(i32::from(style.font_weight)), r);
                let _ = layout.SetFontStyle(font_style(style.italic), r);
                if style.letter_spacing.0 != 0.0
                    && let Some(s) = &spacing
                {
                    let _ = s.SetCharacterSpacing(0.0, style.letter_spacing.0, 0.0, r);
                }
                if style.font_variant.0 != 0
                    && let Some(typography) = self.typography(style.font_variant)
                {
                    let _ = layout.SetTypography(&typography, r);
                }
            };
            for span in &t.spans {
                for &(s, e, at) in pieces {
                    let (a, b) = (span.start.max(s), span.end.min(e));
                    if a < b {
                        apply(range(at + a - s, at + b - s), &span.style);
                    }
                }
            }
            if let Some((at, style)) = ellipsis {
                apply(range(at, at + 1), &style);
            }
            for (a, object) in t.attachments.iter().zip(placeholders) {
                if let Some(at) = to_cut(pieces, a.index) {
                    let _ = layout.SetInlineObject(object, range(at, at + 1));
                }
            }
            Some(layout)
        }
    }

    /// Sets `p`'s layout up for `width` (`None`: unbounded) and returns
    /// how many of its lines show; their metrics are in `p.lines`.
    fn configure(&self, p: &Prepared, width: Option<f32>) -> usize {
        let Some(layout) = &p.layout else { return 0 };
        let mut lines = p.lines.borrow_mut();
        // SAFETY: COM calls on the engine thread's layout.
        unsafe {
            let _ = layout.SetMaxWidth(width.map_or(UNBOUNDED_WIDTH, |w| w.max(0.0)));
            let _ = layout.SetMaxHeight(match p.max_lines {
                0 => UNBOUNDED,
                n => n as f32 * PITCH,
            });
        }
        line_metrics(layout, &mut lines);
        match p.max_lines {
            0 => lines.len(),
            n => lines.len().min(n as usize),
        }
    }

    /// The width of an ellipsis in `format`'s font.
    fn ellipsis_width(&self, format: &IDWriteTextFormat) -> f32 {
        // SAFETY: COM calls on live objects with a local out value.
        unsafe {
            let Ok(layout) =
                self.factory
                    .CreateTextLayout(&[0x2026], format, UNBOUNDED_WIDTH, UNBOUNDED)
            else {
                return 0.0;
            };
            let mut m = DWRITE_TEXT_METRICS::default();
            let _ = layout.GetMetrics(&mut m);
            m.widthIncludingTrailingWhitespace
        }
    }

    /// True when the last of `shown` configured lines of `p` ends a
    /// paragraph that lines after it continue: it gets an ellipsis of its
    /// own ([`DWriteTextEngine::paragraph_cut`]).
    fn ends_paragraph(p: &Prepared, shown: usize) -> bool {
        let lines = p.lines.borrow();
        p.ellipsis_width > 0.0
            && lines.len() > shown
            && shown > 0
            && lines[shown - 1].newlineLength > 0
    }

    /// The extents above and below the baseline of the line of `p` from
    /// `start` to `end` (UTF-16): those of the spans in it (spans that only
    /// hold attachments there aside) and of its attachments.
    fn line_box(p: &Prepared, start: u32, end: u32) -> (f32, f32) {
        let mut ascent = f32::NEG_INFINITY;
        let mut descent = f32::NEG_INFINITY;
        let placeholders = |a: u32, b: u32| {
            p.attachments
                .iter()
                .filter(|t| t.index >= a && t.index < b)
                .count() as u32
        };
        if start >= end {
            // An empty line (the end of text ending in a line break): the
            // span it would continue.
            if let Some(s) = p.spans.get(
                p.spans
                    .partition_point(|s| s.end < start)
                    .min(p.spans.len().saturating_sub(1)),
            ) {
                (ascent, descent) = s.extents();
            }
        } else {
            let first = p.spans.partition_point(|s| s.end <= start);
            for s in p.spans[first..].iter().take_while(|s| s.start < end) {
                let (a, b) = (s.start.max(start), s.end.min(end));
                if s.line_height <= 0.0 && placeholders(a, b) >= b - a {
                    continue;
                }
                let (up, down) = s.extents();
                ascent = ascent.max(up);
                descent = descent.max(down);
            }
            for t in &p.attachments {
                if t.index >= start && t.index < end {
                    ascent = ascent.max(t.up);
                    descent = descent.max(t.down);
                }
            }
        }
        if ascent == f32::NEG_INFINITY {
            return p.base;
        }
        (ascent, descent)
    }

    /// The width of the first `shown` lines of `p`'s configured layout,
    /// the last one `extra` wider.
    fn lines_width(p: &Prepared, shown: usize, extra: f32) -> f32 {
        let Some(layout) = &p.layout else { return 0.0 };
        let lines = p.lines.borrow();
        let mut buf = [DWRITE_HIT_TEST_METRICS::default(); 16];
        let mut width = 0.0f32;
        let mut start = 0;
        for (k, l) in lines[..shown].iter().enumerate() {
            let extra = if k + 1 == shown { extra } else { 0.0 };
            let mut count = 0;
            // SAFETY: a COM call with a local buffer of the length passed.
            let ok = unsafe {
                layout.HitTestTextRange(
                    start,
                    l.length - l.newlineLength,
                    0.0,
                    0.0,
                    Some(&mut buf),
                    &mut count,
                )
            }
            .is_ok();
            if ok {
                let n = (count as usize).min(buf.len());
                let left = buf[..n]
                    .iter()
                    .map(|m| m.left)
                    .fold(f32::INFINITY, f32::min);
                let right = buf[..n]
                    .iter()
                    .map(|m| m.left + m.width)
                    .fold(f32::NEG_INFINITY, f32::max);
                if right > left {
                    width = width.max(right - left + extra);
                }
            }
            start += l.length;
        }
        width
    }

    /// What runs in `face` at `size` points are drawn with.
    fn font_info(&self, face: &IDWriteFontFace, size: f32) -> Arc<FontInfo> {
        let key = (face.as_raw() as usize, size.to_bits());
        if let Some(info) = self.fonts.borrow().get(&key) {
            return info.clone();
        }
        let mut m = DWRITE_FONT_METRICS::default();
        // SAFETY: COM calls on a live face with a local out value.
        let color = unsafe {
            face.GetMetrics(&mut m);
            face.cast::<IDWriteFontFace2>()
                .is_ok_and(|f| f.IsColorFont().as_bool())
        };
        let em = f32::from(m.designUnitsPerEm.max(1));
        let scale = size / em;
        let metrics = Metrics::of(&m);
        let info = Arc::new(FontInfo {
            face: Shared(face.clone()),
            size,
            underline: (
                f32::from(m.underlinePosition) * scale,
                f32::from(m.underlineThickness) * scale,
            ),
            strikethrough: (
                f32::from(m.strikethroughPosition) * scale,
                f32::from(m.strikethroughThickness) * scale,
            ),
            cap_x: (metrics.cap * size, metrics.x * size),
            extents: (metrics.ascent * size, metrics.descent * size),
            color,
        });
        let mut fonts = self.fonts.borrow_mut();
        // Bounded: animated font sizes make new fonts every frame.
        if fonts.len() >= 256 {
            fonts.clear();
        }
        fonts.insert(key, info.clone());
        info
    }

    /// The color layers of a run in a color font, if it has color glyphs.
    fn color_layers(&self, raw: &RawRun) -> Option<Box<[Layer]>> {
        let run = DWRITE_GLYPH_RUN {
            // SAFETY: borrowed without a reference: the run does not outlive
            // `raw.face` and never releases it (`ManuallyDrop`).
            fontFace: unsafe { std::mem::transmute_copy(&raw.face) },
            fontEmSize: raw.size,
            glyphCount: raw.glyphs.len() as u32,
            glyphIndices: raw.glyphs.as_ptr(),
            glyphAdvances: raw.advances.as_ptr(),
            glyphOffsets: raw.offsets.as_ptr(),
            isSideways: false.into(),
            bidiLevel: raw.bidi,
        };
        // SAFETY: COM calls on live objects; each current run is read
        // before moving on.
        unsafe {
            let layers = match self.factory.TranslateColorGlyphRun(
                0.0,
                0.0,
                &run,
                None,
                DWRITE_MEASURING_MODE_NATURAL,
                None,
                0,
            ) {
                Ok(e) => e,
                Err(e) if e.code() == DWRITE_E_NOCOLOR => return None,
                Err(_) => return None,
            };
            let mut out = Vec::new();
            while layers.MoveNext().is_ok_and(|more| more.as_bool()) {
                let Ok(layer) = layers.GetCurrentRun() else {
                    break;
                };
                let Some(layer) = layer.as_ref() else { break };
                let g = &layer.glyphRun;
                let n = g.glyphCount as usize;
                let Some(face) = (*g.fontFace).clone() else {
                    continue;
                };
                if n == 0 {
                    continue;
                }
                let c = layer.runColor;
                out.push(Layer {
                    face: Shared(face),
                    size: g.fontEmSize,
                    glyphs: std::slice::from_raw_parts(g.glyphIndices, n).into(),
                    advances: if g.glyphAdvances.is_null() {
                        vec![0.0; n].into()
                    } else {
                        std::slice::from_raw_parts(g.glyphAdvances, n).into()
                    },
                    offsets: if g.glyphOffsets.is_null() {
                        vec![DWRITE_GLYPH_OFFSET::default(); n].into()
                    } else {
                        std::slice::from_raw_parts(g.glyphOffsets, n).into()
                    },
                    dx: layer.baselineOriginX,
                    dy: layer.baselineOriginY,
                    color: (layer.paletteIndex != 0xFFFF).then(|| {
                        let u = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
                        Color::rgba(u(c.r), u(c.g), u(c.b), u(c.a))
                    }),
                });
            }
            Some(out.into())
        }
    }

    /// Draws `layout` into a recorder.
    fn record(layout: &IDWriteTextLayout, placeholders: &[IDWriteInlineObject]) -> Recording {
        let recorder = windows_core::ComObject::new(Recorder {
            placeholders: placeholders.iter().map(|p| p.as_raw() as usize).collect(),
            out: RefCell::default(),
            sign: Cell::new(None),
        });
        let renderer: IDWriteTextRenderer = recorder.to_interface();
        // SAFETY: a COM call on the engine thread's layout.
        if let Err(err) = unsafe { layout.Draw(None, &renderer, 0.0, 0.0) } {
            log::warn!("text: cannot record a layout: {err}");
        }
        recorder.out.take()
    }

    /// A layout of `p`'s text up to `end` (the end of the paragraph its
    /// last shown line ends) with an ellipsis, `shown` lines high.
    fn paragraph_cut(&self, p: &Prepared, end: u32, width: f32, shown: usize) -> Option<Cut> {
        let t = p.attributed.as_deref()?;
        let format = p.format.as_ref()?;
        let mut text = p.text.get(..end as usize)?.to_vec();
        text.push(0x2026);
        let pieces = vec![(0, end, 0)];
        let style = t
            .spans
            .get(span_at(&t.spans, end.saturating_sub(1)))
            .map_or_else(ResolvedTextStyle::default, |s| s.style);
        let placeholders: Vec<IDWriteInlineObject> = t
            .attachments
            .iter()
            .map(|a| {
                Placeholder {
                    width: a.width.0,
                    height: a.height.0,
                }
                .into()
            })
            .collect();
        let layout = self.build(&text, format, t, &pieces, Some((end, style)), &placeholders)?;
        // SAFETY: COM calls on a layout of this thread.
        unsafe {
            let _ = layout.SetMaxWidth(width.max(0.0));
            let _ = layout.SetMaxHeight(shown as f32 * PITCH);
        }
        Some(Cut {
            layout,
            placeholders,
            pieces,
            text,
        })
    }

    /// A layout of `p`'s single line with its middle or head cut out for
    /// an ellipsis, as wide as fits in `width`; the pieces it is made of.
    fn cut(&self, p: &Prepared, width: f32) -> Option<Cut> {
        let t = p.attributed.as_deref()?;
        let format = p.format.as_ref()?;
        let head = t.ellipsize == EllipsizeMode::Head;
        // Character boundaries (UTF-16).
        let mut bounds: Vec<u32> = Vec::with_capacity(t.text.len() + 1);
        let mut at = 0u32;
        for c in t.text.chars() {
            bounds.push(at);
            at += c.len_utf16() as u32;
        }
        bounds.push(at);
        let chars = bounds.len() - 1;
        let style_at = |i: u32| {
            t.spans
                .get(span_at(&t.spans, i))
                .map_or_else(ResolvedTextStyle::default, |s| s.style)
        };
        let make = |keep: usize| {
            let (pieces, ellipsis_at): (Vec<Piece>, u32) = if head {
                (vec![(bounds[chars - keep], at, 1)], 0)
            } else {
                let front = keep.div_ceil(2);
                let a = bounds[front];
                (
                    vec![(0, a, 0), (bounds[chars - (keep - front)], at, a + 1)],
                    a,
                )
            };
            let mut text = Vec::with_capacity(keep * 2 + 1);
            for &(s, e, piece_at) in &pieces {
                if piece_at > text.len() as u32 {
                    text.push(0x2026);
                }
                text.extend_from_slice(&p.text[s as usize..e as usize]);
            }
            let first_cut = from_cut(&pieces, ellipsis_at);
            let placeholders: Vec<IDWriteInlineObject> = t
                .attachments
                .iter()
                .map(|a| {
                    Placeholder {
                        width: a.width.0,
                        height: a.height.0,
                    }
                    .into()
                })
                .collect();
            let layout = self.build(
                &text,
                format,
                t,
                &pieces,
                Some((ellipsis_at, style_at(first_cut))),
                &placeholders,
            )?;
            // SAFETY: COM calls on a layout of this thread.
            let fits = unsafe {
                let _ = layout.SetWordWrapping(DWRITE_WORD_WRAPPING_NO_WRAP);
                let _ = layout.SetTrimming(
                    &DWRITE_TRIMMING {
                        granularity: DWRITE_TRIMMING_GRANULARITY_NONE,
                        delimiter: 0,
                        delimiterCount: 0,
                    },
                    None::<&IDWriteInlineObject>,
                );
                let _ = layout.SetMaxWidth(width.max(0.0));
                let mut m = DWRITE_TEXT_METRICS::default();
                let _ = layout.GetMetrics(&mut m);
                m.widthIncludingTrailingWhitespace <= width
            };
            Some((
                Cut {
                    layout,
                    placeholders,
                    pieces,
                    text,
                },
                fits,
            ))
        };
        // The most characters that fit with the ellipsis.
        let (mut lo, mut hi) = (0usize, chars.saturating_sub(1));
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            match make(mid) {
                Some((_, true)) => lo = mid,
                _ => hi = mid - 1,
            }
        }
        make(lo).map(|(cut, _)| cut)
    }
}

impl TextEngine for DWriteTextEngine {
    type Prepared = Prepared;

    fn prepare(&self, t: &AttributedText) -> Prepared {
        self.prepare_aligned(t, &nsh_core::AttachmentAlignments::default())
    }

    fn prepare_aligned(
        &self,
        t: &AttributedText,
        alignments: &nsh_core::AttachmentAlignments,
    ) -> Prepared {
        let text: Vec<u16> = t.text.encode_utf16().collect();
        let rtl = t
            .writing_direction
            .unwrap_or_else(|| first_strong(&t.text).unwrap_or(t.rtl));
        let spans: Vec<SpanBox> = t
            .spans
            .iter()
            .map(|s| {
                let m = self.face(&s.style).metrics;
                let size = s.style.font_size.0;
                SpanBox {
                    start: s.start,
                    end: s.end,
                    ascent: m.ascent * size,
                    descent: m.descent * size,
                    line_height: s.style.line_height.0,
                }
            })
            .collect();
        let base_style = t
            .spans
            .first()
            .map_or_else(ResolvedTextStyle::default, |s| s.style);
        let base = spans.first().map_or_else(
            || {
                let m = self.face(&base_style).metrics;
                (
                    m.ascent * base_style.font_size.0,
                    m.descent * base_style.font_size.0,
                )
            },
            SpanBox::extents,
        );
        let placeholders: Vec<IDWriteInlineObject> = t
            .attachments
            .iter()
            .map(|a| {
                Placeholder {
                    width: a.width.0,
                    height: a.height.0,
                }
                .into()
            })
            .collect();
        let format = self.format(t, rtl);
        let len = text.len() as u32;
        let layout = format
            .as_ref()
            .and_then(|f| self.build(&text, f, t, &[(0, len, 0)], None, &placeholders));
        let paragraphs = t.text.contains(['\n', '\r', '\u{2029}']);
        let ellipsis = t.max_lines > 0 && t.ellipsize != EllipsizeMode::Clip;
        let cut = matches!(t.ellipsize, EllipsizeMode::Head | EllipsizeMode::Middle)
            && t.max_lines > 0
            && (t.max_lines == 1 || t.no_wrap)
            && !paragraphs;
        let ellipsis_width = match &format {
            Some(f) if ellipsis && paragraphs => self.ellipsis_width(f),
            _ => 0.0,
        };
        Prepared {
            text,
            layout,
            format,
            placeholders,
            spans,
            base,
            attachments: t
                .attachments
                .iter()
                .map(|a| {
                    let font = if alignments.get(a.index) == nsh_core::VerticalAlign::Baseline {
                        nsh_core::FontExtent::default()
                    } else {
                        let style = t
                            .span_at(a.index)
                            .map_or_else(Default::default, |s| s.style);
                        let m = self.face(&style).metrics;
                        let size = style.font_size.0;
                        nsh_core::FontExtent::new(
                            Points(m.ascent * size),
                            Points(m.descent * size),
                            Points(m.x * size),
                        )
                    };
                    let (up, down) = a.extent(font, alignments.get(a.index));
                    AttachmentBox {
                        index: a.index,
                        width: a.width.0,
                        height: a.height.0,
                        top: a.ascent(font, alignments.get(a.index)).0,
                        up: up.0,
                        down: down.0,
                    }
                })
                .collect(),
            no_wrap: t.no_wrap,
            max_lines: t.max_lines,
            cut,
            attributed: (cut || ellipsis && paragraphs).then(|| Box::new(t.clone())),
            lines: RefCell::default(),
            base_size: base_style.font_size.0,
            ellipsis_width,
        }
    }

    fn measure(&self, p: &Prepared, max_width: Option<Points>) -> Size<Points> {
        let max_width = max_width.map(|m| m.0);
        let shown = self.configure(p, max_width);
        let Some(layout) = &p.layout else {
            return Size::new(px(0.0), px(0.0));
        };
        let mut height = 0.0;
        let mut start = 0;
        let total = {
            let lines = p.lines.borrow();
            for l in &lines[..shown] {
                let (a, d) = Self::line_box(p, start, start + l.length);
                height += a + d;
                start += l.length;
            }
            lines.len()
        };
        let mut width = if shown < total {
            let extra = if Self::ends_paragraph(p, shown) {
                p.ellipsis_width
            } else {
                0.0
            };
            Self::lines_width(p, shown, extra)
        } else {
            let mut m = DWRITE_TEXT_METRICS::default();
            // SAFETY: a COM call with a local out value.
            let _ = unsafe { layout.GetMetrics(&mut m) };
            m.widthIncludingTrailingWhitespace
        };
        if let Some(max) = max_width
            && !p.no_wrap
        {
            width = width.min(max.max(0.0));
        }
        Size::new(Points(width.ceil()), Points(height.ceil()))
    }

    fn layout(&self, p: &Prepared, size: Size<Points>) -> TextLayout {
        let shown = self.configure(p, Some(size.width.0));
        let Some(layout) = &p.layout else {
            return TextLayout(Arc::new(WinLayout::default()));
        };
        let metrics: Vec<DWRITE_LINE_METRICS> = p.lines.borrow()[..shown].to_vec();
        let cut = if p.cut {
            metrics
                .first()
                .is_some_and(|l| l.isTrimmed.as_bool())
                .then(|| self.cut(p, size.width.0))
                .flatten()
        } else if Self::ends_paragraph(p, shown) {
            // DirectWrite (as Pango) only trims a line its paragraph goes
            // on past: one that ends a paragraph gets the ellipsis instead
            // of the line break.
            let end = metrics.iter().map(|l| l.length).sum::<u32>()
                - metrics.last().map_or(0, |l| l.newlineLength);
            self.paragraph_cut(p, end, size.width.0, shown)
        } else {
            None
        };
        let (drawn, recording, pieces, text) = match &cut {
            Some(c) => (
                &c.layout,
                Self::record(&c.layout, &c.placeholders),
                Some(&c.pieces[..]),
                &c.text[..],
            ),
            None => (
                layout,
                Self::record(layout, &p.placeholders),
                None,
                &p.text[..],
            ),
        };
        // Where each line's trailing whitespace and line break start, in
        // the drawn layout's text (a cut one has its own).
        let mut ends = Vec::new();
        line_metrics(drawn, &mut ends);
        let mut at = 0;
        let ends: Vec<(u32, u32)> = ends
            .iter()
            .map(|l| {
                at += l.length;
                (at - l.trailingWhitespaceLength, at - l.newlineLength)
            })
            .collect();
        // The lines stacked from their spans.
        let mut tops = Vec::with_capacity(shown);
        let mut y = 0.0;
        let mut start = 0;
        for l in &metrics {
            let (a, d) = Self::line_box(p, start, start + l.length);
            // A line ends before its line break, as Pango's.
            tops.push((start, start + l.length - l.newlineLength, y, a, d));
            y += a + d;
            start += l.length;
        }
        let line_of = |dwrite_baseline: f32| {
            ((dwrite_baseline - PITCH_BASELINE) / PITCH)
                .round()
                .max(0.0) as usize
        };
        // Runs by line, with the extent of their glyphs that are not
        // trailing whitespace.
        let mut runs: Vec<(usize, Run, Ink)> = Vec::with_capacity(recording.runs.len());
        for mut raw in recording.runs {
            let line = line_of(raw.y);
            let Some(&(_, _, top, ascent, _)) = tops.get(line) else {
                continue;
            };
            let (blank, newline) = ends.get(line).copied().unwrap_or((u32::MAX, u32::MAX));
            if !raw.sign {
                // Line breaks have glyphs too, at the end in text order.
                let keep = raw
                    .indices
                    .iter()
                    .rposition(|&i| i < newline && !is_break(text.get(i as usize)))
                    .map_or(0, |k| k + 1);
                if keep == 0 {
                    continue;
                }
                raw.glyphs.truncate(keep);
                raw.advances.truncate(keep);
                raw.offsets.truncate(keep);
                raw.indices.truncate(keep);
            }
            let font = self.font_info(&raw.face, raw.size);
            let layers = if font.color {
                self.color_layers(&raw)
            } else {
                None
            };
            let ink = {
                let rtl = raw.bidi % 2 == 1;
                let mut pen = 0.0;
                let mut ink: Option<(f32, f32)> = None;
                for (&w, &i) in raw.advances.iter().zip(&raw.indices) {
                    let x = if rtl { raw.x - pen - w } else { raw.x + pen };
                    pen += w;
                    if raw.sign || i < blank {
                        ink = Some(ink.map_or((x, x + w), |(a, b)| (a.min(x), b.max(x + w))));
                    }
                }
                ink
            };
            let indices: Box<[u32]> = match pieces {
                Some(pieces) => raw.indices.iter().map(|&i| from_cut(pieces, i)).collect(),
                None => raw.indices.into(),
            };
            runs.push((
                line,
                Run {
                    font,
                    x: raw.x,
                    baseline: top + ascent,
                    bidi: raw.bidi,
                    glyphs: raw.glyphs.into(),
                    advances: raw.advances.into(),
                    offsets: raw.offsets.into(),
                    indices,
                    layers,
                    sign: raw.sign,
                },
                ink,
            ));
        }
        runs.sort_by_key(|(line, _, _)| *line);
        let mut out = WinLayout {
            attachments: vec![None; p.attachments.len()],
            ..WinLayout::default()
        };
        let mut objects = vec![None; p.attachments.len()];
        for &(n, x, oy) in &recording.objects {
            let Some(a) = p.attachments.get(n) else {
                continue;
            };
            // The placeholder stands on DirectWrite's baseline (its
            // `GetMetrics`); the lines are stacked from their boxes.
            let line = line_of(oy + a.height);
            if let Some(&(_, _, top, ascent, _)) = tops.get(line) {
                out.attachments[n] = Some((x, top + ascent - a.top));
                out.inline.push(Inline {
                    index: a.index,
                    x,
                    width: a.width,
                });
                objects[n] = Some((line, x));
            }
        }
        let mut runs = runs.into_iter().peekable();
        for (k, &(start, end, top, ascent, descent)) in tops.iter().enumerate() {
            let first = out.runs.len();
            let mut left = f32::INFINITY;
            let mut right = f32::NEG_INFINITY;
            let mut em = 0.0f32;
            let mut cap_x = None;
            while let Some((_, run, ink)) = runs.next_if(|(line, _, _)| *line == k) {
                if let Some((a, b)) = ink {
                    left = left.min(a);
                    right = right.max(b);
                }
                if run.font.size > em {
                    em = run.font.size;
                    cap_x = Some(run.font.cap_x);
                }
                out.runs.push(run);
            }
            for (i, o) in objects.iter().enumerate() {
                if let Some((line, x)) = o
                    && *line == k
                {
                    let w = p.attachments.get(i).map_or(0.0, |a| a.width);
                    left = left.min(*x);
                    right = right.max(*x + w);
                }
            }
            if left > right {
                let (mut px, mut py) = (0.0, 0.0);
                let mut m = DWRITE_HIT_TEST_METRICS::default();
                // SAFETY: a COM call with local out values.
                let _ =
                    unsafe { layout.HitTestTextPosition(start, false, &mut px, &mut py, &mut m) };
                (left, right) = (px, px);
            }
            let (cap_height, x_height) =
                cap_x.unwrap_or((p.base_size * CAP_HEIGHT, p.base_size * X_HEIGHT));
            out.lines.push(Line {
                info: TextLine {
                    text: String::new(),
                    start,
                    end,
                    x: Points(left),
                    y: Points(top),
                    width: Points(right - left),
                    height: Points(ascent + descent),
                    ascender: Points(ascent),
                    descender: Points(descent),
                    cap_height: Points(cap_height),
                    x_height: Points(x_height),
                },
                runs: first..out.runs.len(),
            });
        }
        TextLayout(Arc::new(out))
    }

    fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
        layout.downcast::<WinLayout>().map_or_else(Vec::new, |l| {
            l.lines.iter().map(|l| l.info.clone()).collect()
        })
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<nsh_core::Point<Points>>> {
        layout.downcast::<WinLayout>().map_or_else(Vec::new, |l| {
            l.attachments
                .iter()
                .map(|a| a.map(|(x, y)| nsh_core::geometry::point(Points(x), Points(y))))
                .collect()
        })
    }

    fn hit_test(&self, layout: &TextLayout, point: nsh_core::Point<Points>) -> TextPosition {
        layout
            .downcast::<WinLayout>()
            .map_or_else(TextPosition::default, |l| l.hit_test(point.x.0, point.y.0))
    }

    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        layout.downcast::<WinLayout>()?.caret_rect(position)
    }

    fn range_rects(
        &self,
        layout: &TextLayout,
        range: std::ops::Range<u32>,
        out: &mut Vec<Bounds<Points>>,
    ) {
        let Some(layout) = layout.downcast::<WinLayout>() else {
            return;
        };
        layout.range_rects((range.start, range.end), |x, y, w, h| {
            out.push(Bounds::new(
                nsh_core::geometry::point(Points(x), Points(y)),
                nsh_core::geometry::size(Points(w), Points(h)),
            ));
        });
    }

    fn register_font(&self, data: &[u8]) -> Result<(), String> {
        let face = ttf_parser::Face::parse(data, 0).map_err(|e| e.to_string())?;
        let has_family = face.names().into_iter().any(|n| {
            (n.name_id == ttf_parser::name_id::TYPOGRAPHIC_FAMILY
                || n.name_id == ttf_parser::name_id::FAMILY)
                && n.to_string().is_some_and(|s| !s.is_empty())
        });
        if !has_family {
            return Err("the font has no family name".to_owned());
        }
        add_font(data)?;
        self.fonts.borrow_mut().clear();
        Ok(())
    }
}

// --- Drawing --------------------------------------------------------------------------------

/// The text a view draws.
pub(crate) struct DrawnText {
    /// What it says (spans, colors).
    pub(crate) text: Arc<AttributedText>,
    /// The engine's layout of it.
    pub(crate) layout: TextLayout,
    /// Where the layout goes inside the view.
    pub(crate) content: Bounds<Points>,
    /// The selection of `selectable` text, kept across new content.
    selection: Option<Rc<Selection>>,
    /// The part of a selectable view's selection in this text (UTF-16,
    /// `start < end`), which [`crate::selectable_view`] sets.
    pub(crate) area_range: Cell<Option<(u32, u32)>>,
    /// The text shadow's effect, made on first draw (and again on a new
    /// device).
    shadow: RefCell<Option<(u64, ID2D1Effect)>>,
}

/// `Text`: a text view's content changed.
pub(crate) fn set(
    view: &NshView,
    text: &Arc<AttributedText>,
    layout: &TextLayout,
    content: Bounds<Points>,
) {
    let old = view.state_mut().text.take();
    let was = old.as_ref().is_some_and(|o| o.text.is_selectable());
    // The area clamps it to the new content at the batch's end.
    let area_range = old.as_ref().and_then(|o| o.area_range.get());
    let selection = match old.and_then(|o| o.selection.map(|s| (s, o.text))) {
        Some((s, old)) if text.is_selectable() => {
            // Offsets into other text mean nothing.
            if old.text != text.text {
                s.range.set(None);
            }
            Some(s)
        }
        Some(_) => {
            forget_selected(view);
            None
        }
        None if text.is_selectable() => Some(Rc::new(Selection::default())),
        None => None,
    };
    view.state_mut().text = Some(DrawnText {
        text: text.clone(),
        layout: layout.clone(),
        content,
        selection,
        area_range: Cell::new(area_range),
        shadow: RefCell::new(None),
    });
    if was != text.is_selectable() {
        // The I-beam.
        crate::input::style_changed(view);
    }
    view.changed();
}

/// Device resources text drawing shares (per device).
struct Resources {
    generation: u64,
    /// Dashes, round dots, square dots, round caps (wavy lines).
    dashed: ID2D1StrokeStyle1,
    dots: ID2D1StrokeStyle1,
    square_dots: ID2D1StrokeStyle1,
    round: ID2D1StrokeStyle1,
    /// A context of its own that records text shadows into command lists
    /// (the frame's context is mid-draw), and its brush.
    recorder: ID2D1DeviceContext,
    brush: ID2D1SolidColorBrush,
}

thread_local! {
    static RESOURCES: RefCell<Option<Rc<Resources>>> = const { RefCell::new(None) };
}

fn resources(gfx: &Gfx) -> Option<Rc<Resources>> {
    let generation = crate::gfx::generation();
    if let Some(r) = RESOURCES.with_borrow(|r| r.clone())
        && r.generation == generation
    {
        return Some(r);
    }
    let stroke = |cap, dashes: Option<&[f32]>| {
        let props = D2D1_STROKE_STYLE_PROPERTIES1 {
            transformType: D2D1_STROKE_TRANSFORM_TYPE_NORMAL,
            startCap: cap,
            endCap: cap,
            dashCap: cap,
            lineJoin: D2D1_LINE_JOIN_ROUND,
            miterLimit: 10.0,
            dashStyle: if dashes.is_some() {
                D2D1_DASH_STYLE_CUSTOM
            } else {
                D2D1_DASH_STYLE_SOLID
            },
            dashOffset: 0.0,
        };
        // SAFETY: a COM call on the live factory.
        unsafe { gfx.factory.CreateStrokeStyle(&props, dashes) }
    };
    // SAFETY: COM calls on live objects.
    let made = (|| -> windows::core::Result<Resources> {
        let recorder = unsafe {
            gfx.device
                .CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE)?
        };
        let brush =
            unsafe { recorder.CreateSolidColorBrush(&crate::render::color_f(Color::BLACK), None)? };
        Ok(Resources {
            generation,
            dashed: stroke(D2D1_CAP_STYLE_FLAT, Some(&[3.0, 2.0]))?,
            dots: stroke(D2D1_CAP_STYLE_ROUND, Some(&[0.0, 2.0]))?,
            square_dots: stroke(D2D1_CAP_STYLE_FLAT, Some(&[1.0, 1.0]))?,
            round: stroke(D2D1_CAP_STYLE_ROUND, None)?,
            recorder,
            brush,
        })
    })();
    match made {
        Ok(r) => {
            let r = Rc::new(r);
            RESOURCES.with_borrow_mut(|slot| *slot = Some(r.clone()));
            Some(r)
        }
        Err(err) => {
            log::warn!("text: cannot make drawing resources: {err}");
            None
        }
    }
}

/// Draws glyph runs and decorations into one context.
struct Painter<'a> {
    dc: &'a ID2D1DeviceContext,
    brush: &'a ID2D1SolidColorBrush,
    res: &'a Resources,
    /// One device pixel (points): decorations snap to whole pixels.
    px: f32,
}

impl Painter<'_> {
    fn color(&self, c: Color) -> &ID2D1SolidColorBrush {
        // SAFETY: a COM call on a live brush.
        unsafe { self.brush.SetColor(&crate::render::color_f(c)) };
        self.brush
    }

    #[allow(clippy::too_many_arguments)]
    fn glyphs(
        &self,
        face: &IDWriteFontFace,
        size: f32,
        glyphs: &[u16],
        advances: &[f32],
        offsets: &[DWRITE_GLYPH_OFFSET],
        bidi: u32,
        x: f32,
        y: f32,
        color: Color,
    ) {
        if glyphs.is_empty() || color.is_transparent() {
            return;
        }
        let run = DWRITE_GLYPH_RUN {
            // SAFETY: borrowed without a reference: the run does not
            // outlive `face` and never releases it (`ManuallyDrop`).
            fontFace: unsafe { std::mem::transmute_copy(face) },
            fontEmSize: size,
            glyphCount: glyphs.len() as u32,
            glyphIndices: glyphs.as_ptr(),
            glyphAdvances: advances.as_ptr(),
            glyphOffsets: offsets.as_ptr(),
            isSideways: false.into(),
            bidiLevel: bidi,
        };
        let brush = self.color(color);
        // SAFETY: a COM call between BeginDraw and EndDraw; the arrays
        // outlive it.
        unsafe {
            self.dc.DrawGlyphRun(
                Vector2 { X: x, Y: y },
                &run,
                None,
                brush,
                DWRITE_MEASURING_MODE_NATURAL,
            )
        };
    }

    /// Draws `layout`'s glyphs at `(ox, oy)`, colored by `text`'s spans (or
    /// all in `over`), and their decorations.
    fn paint(
        &self,
        text: &AttributedText,
        layout: &WinLayout,
        ox: f32,
        oy: f32,
        over: Option<Color>,
    ) {
        let default = ResolvedTextStyle::default();
        let style = |index: u32| {
            text.spans
                .get(span_at(&text.spans, index))
                .map_or(&default, |s| &s.style)
        };
        for run in &layout.runs {
            let baseline = oy + run.baseline;
            if let (Some(layers), None) = (&run.layers, over) {
                let s = style(run.indices.first().copied().unwrap_or(0));
                for l in layers.iter() {
                    self.glyphs(
                        &l.face.0,
                        l.size,
                        &l.glyphs,
                        &l.advances,
                        &l.offsets,
                        run.bidi,
                        ox + run.x + l.dx,
                        baseline + l.dy,
                        l.color.unwrap_or(s.color),
                    );
                }
                self.decorate(s, &run.font, ox + run.left(), run.width(), baseline, None);
                continue;
            }
            let rtl = run.rtl();
            let n = run.glyphs.len();
            let mut pen = 0.0;
            let mut i = 0;
            while i < n {
                let span = span_at(&text.spans, run.indices[i]);
                let mut j = i + 1;
                while j < n && span_at(&text.spans, run.indices[j]) == span {
                    j += 1;
                }
                let s = text.spans.get(span).map_or(&default, |s| &s.style);
                let w: f32 = run.advances[i..j].iter().sum();
                let origin = if rtl { run.x - pen } else { run.x + pen };
                self.glyphs(
                    &run.font.face.0,
                    run.font.size,
                    &run.glyphs[i..j],
                    &run.advances[i..j],
                    &run.offsets[i..j],
                    run.bidi,
                    ox + origin,
                    baseline,
                    over.unwrap_or(s.color),
                );
                let left = if rtl { origin - w } else { origin };
                self.decorate(s, &run.font, ox + left, w, baseline, over);
                pen += w;
                i = j;
            }
        }
    }

    /// Draws the underline / strikethrough of `width` points of text at
    /// `(x, baseline)`.
    ///
    /// Thicknesses, gaps and offsets are whole device pixels (at least
    /// one): a font's sub-pixel underline would otherwise blur the two
    /// lines of `double` into one, and dots and waves into a smudge.
    fn decorate(
        &self,
        style: &ResolvedTextStyle,
        font: &FontInfo,
        x: f32,
        width: f32,
        baseline: f32,
        over: Option<Color>,
    ) {
        let d = style.decoration;
        if !d.underline && !d.line_through || width <= 0.0 {
            return;
        }
        let px = self.px;
        let pixels = |v: f32| (v / px).round().max(1.0) * px;
        let color = over.unwrap_or(style.decoration_color.unwrap_or(style.color));
        if color.is_transparent() {
            return;
        }
        let line = |top: f32, thickness: f32| {
            let t = pixels(style.decoration_thickness.map_or(thickness, |t| t.0));
            let top = (top / px).round() * px;
            let mid = top + t / 2.0;
            let brush = self.color(color);
            let stroke = |style: &ID2D1StrokeStyle1| {
                // SAFETY: a COM call between BeginDraw and EndDraw.
                unsafe {
                    self.dc.DrawLine(
                        Vector2 { X: x, Y: mid },
                        Vector2 {
                            X: x + width,
                            Y: mid,
                        },
                        brush,
                        t,
                        style,
                    )
                };
            };
            match style.decoration_style {
                DecorationStyle::Solid => {
                    // SAFETY: as above.
                    unsafe { self.dc.FillRectangle(&rect_f(x, top, width, t), brush) };
                }
                DecorationStyle::Double => {
                    // Two lines of the thickness, as far apart (as CSS),
                    // centered where the single line goes: below it, the
                    // second line of small text would fall out of its box.
                    for y in [top - t, top + t] {
                        // SAFETY: as above.
                        unsafe { self.dc.FillRectangle(&rect_f(x, y, width, t), brush) };
                    }
                }
                DecorationStyle::Dashed => stroke(&self.res.dashed),
                // Round dots, a dot apart; thin dots stay square: round
                // ones would only be antialiasing.
                DecorationStyle::Dotted if t >= 3.0 * px => stroke(&self.res.dots),
                DecorationStyle::Dotted => stroke(&self.res.square_dots),
                DecorationStyle::Wavy => {
                    let amplitude = pixels((t * 1.5).max(2.0 * px));
                    let step = amplitude * 2.0;
                    // Each half wave as four segments of a sine.
                    let mut from = Vector2 { X: x, Y: mid };
                    let mut cx = x;
                    let mut up = true;
                    while cx < x + width {
                        let nx = (cx + step).min(x + width);
                        for k in 1..=4 {
                            let f = k as f32 / 4.0;
                            let sign = if up { -1.0 } else { 1.0 };
                            let to = Vector2 {
                                X: cx + (nx - cx) * f,
                                Y: mid + sign * amplitude * (f * std::f32::consts::PI).sin(),
                            };
                            // SAFETY: as above.
                            unsafe { self.dc.DrawLine(from, to, brush, t, &self.res.round) };
                            from = to;
                        }
                        cx = nx;
                        up = !up;
                    }
                }
            }
        };
        if d.underline {
            let top = match style.underline_offset {
                Some(offset) => baseline + offset.0,
                None => baseline - font.underline.0,
            };
            line(top, font.underline.1);
        }
        if d.line_through {
            line(baseline - font.strikethrough.0, font.strikethrough.1);
        }
    }
}

/// The selection highlight's color: `selectionColor` or the system's
/// highlight, at about 30% (as iOS tints selections).
fn selection_tint(text: &AttributedText) -> Color {
    let base = text.selection_color.unwrap_or_else(|| {
        use windows::Win32::Graphics::Gdi::{COLOR_HIGHLIGHT, GetSysColor};
        // SAFETY: a plain query.
        let c = unsafe { GetSysColor(COLOR_HIGHLIGHT) };
        Color::rgba(c as u8, (c >> 8) as u8, (c >> 16) as u8, 255)
    });
    base.with_alpha(0.3)
}

/// Draws a text view's text.
pub(crate) fn draw(cx: &mut DrawCx<'_>, state: &ViewState) {
    let Some(drawn) = &state.text else { return };
    let Some(layout) = drawn.layout.downcast::<WinLayout>() else {
        return;
    };
    let (ox, oy) = (drawn.content.origin.x.0, drawn.content.origin.y.0);
    if drawn.text.has_backgrounds() {
        layout.background_rects(&drawn.text, |x, y, w, h, r, color| {
            let rr = windows::Win32::Graphics::Direct2D::D2D1_ROUNDED_RECT {
                rect: rect_f(ox + x, oy + y, w, h),
                radiusX: r,
                radiusY: r,
            };
            // SAFETY: a COM call between BeginDraw and EndDraw.
            unsafe { cx.dc.FillRoundedRectangle(&rr, cx.solid(color)) };
        });
    }
    let range = drawn.selection.as_ref().and_then(|s| s.range.get());
    if let Some(range) = range.or_else(|| drawn.area_range.get()) {
        let brush = cx.solid(selection_tint(&drawn.text));
        layout.range_rects(range, |x, y, w, h| {
            // SAFETY: a COM call between BeginDraw and EndDraw.
            unsafe { cx.dc.FillRectangle(&rect_f(ox + x, oy + y, w, h), brush) };
        });
    }
    if layout.runs.is_empty() {
        return;
    }
    let Some(res) = resources(cx.gfx) else { return };
    let brush = cx.solid(Color::BLACK).clone();
    let painter = Painter {
        dc: cx.dc,
        brush: &brush,
        res: &res,
        px: 1.0 / cx.scale.max(0.01),
    };
    if let Some(shadow) = drawn.text.shadow
        && !shadow.color.is_transparent()
    {
        if shadow.radius <= Points::ZERO {
            painter.paint(
                &drawn.text,
                layout,
                ox + shadow.offset_x.0,
                oy + shadow.offset_y.0,
                Some(shadow.color),
            );
        } else {
            draw_shadow(cx, &res, drawn, layout, shadow);
        }
    }
    painter.paint(&drawn.text, layout, ox, oy, state.anim.color);
}

/// Draws a blurred text shadow: the glyphs recorded into a command list
/// once, through Direct2D's shadow effect.
fn draw_shadow(
    cx: &DrawCx<'_>,
    res: &Resources,
    drawn: &DrawnText,
    layout: &WinLayout,
    shadow: nsh_core::TextShadow,
) {
    let generation = crate::gfx::generation();
    let mut cache = drawn.shadow.borrow_mut();
    if cache.as_ref().is_none_or(|(g, _)| *g != generation) {
        let painter = Painter {
            dc: &res.recorder,
            brush: &res.brush,
            res,
            px: 1.0 / cx.scale.max(0.01),
        };
        // SAFETY: COM calls on live objects; the recorder's BeginDraw is
        // closed by its EndDraw and its target unset.
        let made = unsafe {
            (|| -> windows::core::Result<ID2D1Effect> {
                let list = res.recorder.CreateCommandList()?;
                res.recorder.SetTarget(&list);
                res.recorder.BeginDraw();
                res.recorder
                    .SetTransform(&windows_numerics::Matrix3x2::identity());
                painter.paint(
                    &drawn.text,
                    layout,
                    drawn.content.origin.x.0,
                    drawn.content.origin.y.0,
                    Some(Color::BLACK),
                );
                let ended = res.recorder.EndDraw(None, None);
                res.recorder.SetTarget(None);
                ended?;
                list.Close()?;
                let effect = cx.dc.CreateEffect(&CLSID_D2D1Shadow)?;
                effect.SetInput(0, &list, true);
                // CSS blur radii are twice the standard deviation.
                let sigma = shadow.radius.0 / 2.0;
                effect.SetValue(
                    D2D1_SHADOW_PROP_BLUR_STANDARD_DEVIATION.0 as u32,
                    D2D1_PROPERTY_TYPE_FLOAT,
                    &sigma.to_le_bytes(),
                )?;
                let D2D1_COLOR_F { r, g, b, a } = crate::render::color_f(shadow.color);
                let mut bytes = [0u8; 16];
                for (i, v) in [r, g, b, a].into_iter().enumerate() {
                    bytes[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
                }
                effect.SetValue(
                    D2D1_SHADOW_PROP_COLOR.0 as u32,
                    D2D1_PROPERTY_TYPE_VECTOR4,
                    &bytes,
                )?;
                Ok(effect)
            })()
        };
        match made {
            Ok(effect) => *cache = Some((generation, effect)),
            Err(err) => {
                log::debug!("text: no shadow: {err}");
                return;
            }
        }
    }
    let Some((_, effect)) = &*cache else { return };
    // SAFETY: COM calls between BeginDraw and EndDraw.
    unsafe {
        if let Ok(output) = effect.GetOutput() {
            cx.dc.DrawImage(
                &output,
                Some(&Vector2 {
                    X: shadow.offset_x.0,
                    Y: shadow.offset_y.0,
                }),
                None,
                D2D1_INTERPOLATION_MODE_LINEAR,
                D2D1_COMPOSITE_MODE_SOURCE_OVER,
            );
        }
    }
}

/// The first rectangle (view coordinates: x, y, width, height) the
/// characters `start..end` of the text view with `state` cover (the test
/// agent's spans).
#[cfg(feature = "dev")]
pub(crate) fn range_rect(state: &ViewState, start: u32, end: u32) -> Option<(f32, f32, f32, f32)> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<WinLayout>()?;
    let (cx, cy) = (drawn.content.origin.x.0, drawn.content.origin.y.0);
    let mut first = None;
    layout.range_rects((start, end), |x, y, w, h| {
        first.get_or_insert((cx + x, cy + y, w, h));
    });
    first
}

/// The UTF-16 offset of the character at `(x, y)` (view coordinates), if
/// any (presses on nested text links).
pub(crate) fn char_at(state: &ViewState, x: f32, y: f32) -> Option<u32> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<WinLayout>()?;
    layout.char_at(x - drawn.content.origin.x.0, y - drawn.content.origin.y.0)
}

/// The caret position (UTF-16 offset) nearest `(x, y)` (view
/// coordinates) in a text view's layout (selectable views).
pub(crate) fn caret_at(state: &ViewState, x: f32, y: f32) -> Option<u32> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<WinLayout>()?;
    let (x, y) = (x - drawn.content.origin.x.0, y - drawn.content.origin.y.0);
    Some(layout.hit_test(x, y).offset)
}

// --- Selection ----------------------------------------------------------------------

/// How far (points) the mouse moves on selectable text before a drag
/// selects: past input's press slop where the press would fire (a link, an
/// `onPress`), so a click never does both.
const SELECT_SLOP: f32 = 3.0;
/// The same over a press target.
const SELECT_SLOP_PRESS: f32 = 10.0;

/// What a drag extends the selection by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Unit {
    #[default]
    Char,
    Word,
    Paragraph,
}

/// The range selection of a `selectable` text view, desktop style: a mouse
/// drag selects characters, a double click words and a triple click the
/// paragraph (and drags on by them), Shift+click extends, Ctrl+C copies,
/// Ctrl+A selects all, Escape or a press anywhere else clears. Offsets are
/// UTF-16, as the layout's glyph clusters.
#[derive(Default)]
pub(crate) struct Selection {
    /// The selected range (`start < end`).
    range: Cell<Option<(u32, u32)>>,
    /// The range a drag started from (a caret, the word or paragraph
    /// pressed), which stays selected while it extends.
    anchor: Cell<(u32, u32)>,
    unit: Cell<Unit>,
    /// Where the button went down, while it is down.
    down: Cell<Option<(f32, f32)>>,
    /// The pressed button moved far enough to select.
    dragging: Cell<bool>,
    /// The press began over a press target (links, `onPress`).
    over_press: Cell<bool>,
}

thread_local! {
    /// The view whose text has a selection, with its surface's key: one
    /// at a time, as on desktops.
    static SELECTED: RefCell<Option<(u64, NshView)>> = const { RefCell::new(None) };
}

/// The selection of `view`'s text, if it is selectable.
fn view_selection(view: &NshView) -> Option<Rc<Selection>> {
    view.state().text.as_ref()?.selection.clone()
}

/// `view` no longer has selectable text.
fn forget_selected(view: &NshView) {
    SELECTED.with_borrow_mut(|s| {
        if s.as_ref().is_some_and(|(_, v)| v == view) {
            *s = None;
        }
    });
}

/// Sets `view`'s selection (`None` or empty clears it).
fn select(surface: u64, view: &NshView, range: Option<(u32, u32)>) {
    let Some(s) = view_selection(view) else {
        return;
    };
    let range = range.filter(|(a, b)| a < b);
    if s.range.replace(range) == range {
        return;
    }
    view.changed();
    if range.is_some() {
        // One selection at a time, a selectable view's too.
        crate::selectable_view::clear();
    }
    let previous = SELECTED.with_borrow_mut(|selected| match range {
        Some(_) => selected.replace((surface, view.clone())),
        None => {
            if selected.as_ref().is_some_and(|(_, v)| v == view) {
                *selected = None;
            }
            None
        }
    });
    // One selection at a time.
    if let Some((_, other)) = previous
        && other != *view
        && let Some(s) = view_selection(&other)
        && s.range.take().is_some()
    {
        other.changed();
    }
}

/// Clears the selection of a single text, if any (a selectable view
/// selects).
pub(crate) fn clear_selected() {
    let selected = SELECTED.with_borrow(|s| s.clone());
    if let Some((key, view)) = selected {
        select(key, &view, None);
    }
}

/// True when the text can be selected (`selectable`).
pub(crate) fn selectable(state: &ViewState) -> bool {
    state.text.as_ref().is_some_and(|t| t.text.is_selectable())
}

/// A press anywhere in the window at `(x, y)` (root coordinates), before
/// the views get it: clears a selection the press is not on.
pub(crate) fn window_pressed(surface: &crate::surface::Surface, x: f32, y: f32) {
    let Some(view) = SELECTED.with_borrow(|s| {
        s.as_ref()
            .filter(|(key, _)| *key == surface.key())
            .map(|(_, v)| v.clone())
    }) else {
        return;
    };
    let inside = view
        .to_root()
        .and_then(|m| m.unproject(x, y))
        .is_some_and(|(lx, ly)| {
            let s = view.state();
            lx >= 0.0 && ly >= 0.0 && lx < s.frame.size.width.0 && ly < s.frame.size.height.0
        });
    if !inside {
        select(surface.key(), &view, None);
    }
}

/// A pointer event on selectable text `view` (selecting with the mouse;
/// view coordinates); true when handled. A press over a link or a view
/// with press listeners is left to them (false) and only selects once
/// dragged past a larger slop.
pub(crate) fn pointer(
    surface: &std::rc::Rc<crate::surface::Surface>,
    view: &NshView,
    event: &crate::view::ItemPointer,
) -> bool {
    use crate::input::PointerKind;
    let Some(s) = view_selection(view) else {
        return false;
    };
    let key = surface.key();
    match event.kind {
        PointerKind::Down => {
            s.down.set(Some((event.x, event.y)));
            pressed(
                key,
                view,
                &s,
                event.clicks,
                event.x,
                event.y,
                event.modifiers.shift,
            );
            !s.over_press.get()
        }
        PointerKind::Move => {
            let Some((x0, y0)) = s.down.get() else {
                return false;
            };
            dragged(key, view, &s, event.x - x0, event.y - y0, event.x, event.y);
            s.dragging.get()
        }
        PointerKind::Up | PointerKind::Cancel => {
            s.down.take().is_some() && s.dragging.replace(false)
        }
        PointerKind::Leave => false,
    }
}

/// A press of the primary button (`clicks`: the click count).
fn pressed(key: u64, view: &NshView, s: &Selection, clicks: u32, x: f32, y: f32, shift: bool) {
    let (caret, char_index, text, over_press) = {
        let state = view.state();
        let Some(drawn) = &state.text else { return };
        let Some(layout) = drawn.layout.downcast::<WinLayout>() else {
            return;
        };
        let (lx, ly) = (x - drawn.content.origin.x.0, y - drawn.content.origin.y.0);
        let char_index = layout.char_at(lx, ly);
        let press = [EventKind::Press, EventKind::LongPress, EventKind::PressDown];
        let over_press = press.iter().any(|&k| state.events.contains(k))
            || char_index
                .and_then(|i| drawn.text.link_at(i))
                .is_some_and(|l| press.iter().any(|&k| l.events.contains(k)));
        (
            layout.hit_test(lx, ly).offset,
            char_index,
            drawn.text.clone(),
            over_press,
        )
    };
    s.over_press.set(over_press);
    let at = char_index.unwrap_or(caret);
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
            select(
                key,
                view,
                Some(extend(&text.text, anchor, caret, Unit::Char)),
            );
        }
        0 | 1 => {
            s.anchor.set((caret, caret));
            s.unit.set(Unit::Char);
            s.dragging.set(false);
            select(key, view, None);
        }
        n => {
            let unit = if n == 2 { Unit::Word } else { Unit::Paragraph };
            let range = unit_at(&text.text, at, unit);
            s.anchor.set(range);
            s.unit.set(unit);
            s.dragging.set(true);
            select(key, view, Some(range));
        }
    }
}

/// The pressed mouse moved by `(dx, dy)` to `(x, y)` (view coordinates).
fn dragged(key: u64, view: &NshView, s: &Selection, dx: f32, dy: f32, x: f32, y: f32) {
    if !s.dragging.get() {
        let slop = if s.over_press.get() {
            SELECT_SLOP_PRESS
        } else {
            SELECT_SLOP
        };
        if dx.hypot(dy) <= slop {
            return;
        }
        s.dragging.set(true);
    }
    let range = {
        let state = view.state();
        let Some(drawn) = &state.text else { return };
        let Some(layout) = drawn.layout.downcast::<WinLayout>() else {
            return;
        };
        let caret = layout
            .hit_test(x - drawn.content.origin.x.0, y - drawn.content.origin.y.0)
            .offset;
        extend(&drawn.text.text, s.anchor.get(), caret, s.unit.get())
    };
    select(key, view, Some(range));
}

/// A right click on selectable text `view`: Copy (its selection) and
/// Select All.
pub(crate) fn context_menu(surface: &Rc<crate::surface::Surface>, view: &NshView) {
    use nsh_core::desktop::MenuRole;

    use crate::chrome::LocalItem;
    let selected = selected_text(view).is_some_and(|t| !t.is_empty());
    let (copy, all) = (view.clone(), view.clone());
    crate::chrome::popup_actions(
        surface,
        vec![
            LocalItem::Item {
                role: Some(MenuRole::Copy),
                label: "",
                enabled: selected,
                action: Rc::new(move |_| {
                    if let Some(text) = selected_text(&copy) {
                        crate::system::set_clipboard_text(&text);
                    }
                }),
            },
            LocalItem::Item {
                role: Some(MenuRole::SelectAll),
                label: "",
                enabled: true,
                action: Rc::new(move |s| {
                    let len = all.state().text.as_ref().map_or(0, |t| t.text.len_utf16());
                    select(s.key(), &all, Some((0, len)));
                }),
            },
        ],
    );
}

/// The selected text of `view`, without attachments' placeholders.
fn selected_text(view: &NshView) -> Option<String> {
    let (a, b) = view_selection(view)?.range.get()?;
    let state = view.state();
    let text: Vec<u16> = state.text.as_ref()?.text.text.encode_utf16().collect();
    let part = text.get(a as usize..(b as usize).min(text.len()))?;
    Some(String::from_utf16_lossy(part).replace(ATTACHMENT_CHAR, ""))
}

/// Keys for the text selection (Ctrl+C, Ctrl+A, Escape); true when
/// handled.
pub(crate) fn key(
    surface: &std::rc::Rc<crate::surface::Surface>,
    event: &crate::input::KeyEvent,
) -> bool {
    const VK_A: u16 = 0x41;
    const VK_C: u16 = 0x43;
    const VK_INSERT: u16 = 0x2D;
    const VK_ESCAPE: u16 = 0x1B;
    if !event.down {
        return false;
    }
    let Some(view) = SELECTED.with_borrow(|s| {
        s.as_ref()
            .filter(|(key, v)| *key == surface.key() && v.attached())
            .map(|(_, v)| v.clone())
    }) else {
        return false;
    };
    let ctrl = event.modifiers.ctrl && !event.modifiers.alt;
    match event.vk {
        VK_C | VK_INSERT if ctrl => {
            if let Some(text) = selected_text(&view) {
                crate::system::set_clipboard_text(&text);
            }
        }
        VK_A if ctrl => {
            let len = view.state().text.as_ref().map_or(0, |t| t.text.len_utf16());
            select(surface.key(), &view, Some((0, len)));
        }
        VK_ESCAPE => select(surface.key(), &view, None),
        _ => return false,
    }
    true
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

impl WinLayout {
    /// The glyphs of `line` with their left edge and advance (content
    /// coordinates), cluster offset and whether their run is right to
    /// left.
    fn line_glyphs<'a>(&'a self, line: &Line) -> impl Iterator<Item = Stop> + 'a {
        self.runs
            .get(line.runs.clone())
            .unwrap_or_default()
            .iter()
            .flat_map(|run| {
                let (rtl, sign) = (run.rtl(), run.sign);
                run.boxes().map(move |(x, width, index)| Stop {
                    x,
                    width,
                    index,
                    rtl,
                    sign,
                })
            })
    }

    /// The glyphs and the attachments of `line`: what a caret sits next to.
    fn line_stops<'a>(&'a self, line: &Line) -> impl Iterator<Item = Stop> + 'a {
        let (start, end) = (line.info.start, line.info.end);
        let objects = self
            .inline
            .iter()
            .filter(move |o| o.index >= start && o.index < end)
            .map(|o| Stop {
                x: o.x,
                width: o.width,
                index: o.index,
                rtl: false,
                sign: false,
            });
        self.line_glyphs(line).chain(objects)
    }

    /// The line at height `y`, if any.
    fn line_at(&self, y: f32) -> Option<&Line> {
        self.lines
            .iter()
            .find(|l| y >= l.info.y.0 && y < (l.info.y + l.info.height).0)
    }

    /// The UTF-16 offset of the character at `(x, y)` (content
    /// coordinates).
    fn char_at(&self, x: f32, y: f32) -> Option<u32> {
        let line = self.line_at(y)?;
        self.line_glyphs(line)
            .find(|s| x >= s.x && x < s.x + s.width)
            .map(|s| s.index)
    }

    /// The caret position (UTF-16 offset) nearest `(x, y)` in content
    /// coordinates: on the line at that height (the first above the text,
    /// the last below it), at the cluster edge nearest x. A hit that ends
    /// a soft-wrapped line is its end, [`Affinity::Upstream`].
    fn hit_test(&self, x: f32, y: f32) -> TextPosition {
        let Some(k) = self
            .lines
            .iter()
            .position(|l| y < (l.info.y + l.info.height).0)
            .or_else(|| self.lines.len().checked_sub(1))
        else {
            return TextPosition::default();
        };
        let Some(line) = self.lines.get(k) else {
            return TextPosition::default();
        };
        // Distance, the cluster, the caret goes after it.
        let mut best: Option<(f32, u32, bool)> = None;
        for s in self.line_stops(line) {
            for (edge, right) in [(s.x, false), (s.x + s.width, true)] {
                let d = (x - edge).abs();
                if best.is_none_or(|b| d < b.0) {
                    best = Some((d, s.index, right != s.rtl));
                }
            }
        }
        let offset = match best {
            None => line.info.start,
            Some((_, index, false)) => index,
            Some((_, index, true)) => self
                .line_stops(line)
                .map(|s| s.index)
                .filter(|&i| i > index)
                .min()
                .unwrap_or(line.info.end),
        };
        // A hard break leaves a gap before the next line's start: only a
        // soft wrap has the offset on both lines.
        let wrapped = offset == line.info.end
            && self
                .lines
                .get(k.saturating_add(1))
                .is_some_and(|next| next.info.start == offset);
        let affinity = if wrapped {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        TextPosition::new(offset, affinity)
    }

    /// The line a caret at `position` is on (the rule of
    /// [`TextPosition::line`], without copying the lines out).
    fn line_of(&self, position: TextPosition) -> Option<&Line> {
        let i = position.line_in(self.lines.iter().map(|l| l.info.start..l.info.end))?;
        self.lines.get(i)
    }

    /// The x (content coordinates) of the caret at `offset` on `line`: the
    /// leading edge of the cluster that starts there (the one it is in,
    /// when inside one), the trailing edge of the last one at the line's end.
    fn caret_x(&self, line: &Line, offset: u32) -> f32 {
        let cluster = self
            .line_stops(line)
            .map(|s| s.index)
            .filter(|&i| i <= offset)
            .max()
            .or_else(|| self.line_stops(line).map(|s| s.index).min());
        let Some(cluster) = cluster else {
            return line.info.x.0;
        };
        let trailing = cluster < offset && offset >= line.info.end;
        let mut edge: Option<f32> = None;
        // A cluster can have several glyphs: the outermost edge of them.
        for s in self.line_stops(line).filter(|s| s.index == cluster) {
            let right = trailing != s.rtl;
            let e = if right { s.x + s.width } else { s.x };
            edge = Some(edge.map_or(e, |p| if right { p.max(e) } else { p.min(e) }));
        }
        edge.unwrap_or(line.info.x.0)
    }

    /// The caret at `position` (content coordinates): zero wide, as high as
    /// its line. `None` when there are no lines.
    fn caret_rect(&self, position: TextPosition) -> Option<Bounds<Points>> {
        let line = self.line_of(position)?;
        Some(Bounds::new(
            nsh_core::geometry::point(Points(self.caret_x(line, position.offset)), line.info.y),
            nsh_core::geometry::size(Points(0.0), line.info.height),
        ))
    }

    /// Calls `f(x, y, width, height, radius, color)` with the boxes
    /// (content coordinates) of the span backgrounds of `text`.
    fn background_rects(
        &self,
        text: &AttributedText,
        mut f: impl FnMut(f32, f32, f32, f32, f32, Color),
    ) {
        let mut pieces = Vec::new();
        for line in &self.lines {
            let runs = &self.runs[line.runs.clone()];
            let Some(baseline) = runs.first().map(|r| r.baseline) else {
                continue;
            };
            pieces.clear();
            for run in runs {
                let (ascent, descent) = run.font.extents;
                pieces.extend(run.boxes().map(|(x, width, index)| nsh_core::LinePiece {
                    x: Points(x),
                    width: Points(width),
                    background: text.background_at(index),
                    ascent: Points(ascent),
                    descent: Points(descent),
                }));
            }
            pieces.sort_by(|a, b| a.x.0.total_cmp(&b.x.0));
            let clip = (line.info.x, line.info.x + line.info.width);
            nsh_core::BackgroundBox::join(pieces.iter().copied(), clip, |b| {
                f(
                    b.x.0,
                    baseline - b.ascent.0,
                    b.width.0,
                    (b.ascent + b.descent).0,
                    b.radius().0,
                    b.background.color,
                );
            });
        }
    }

    /// Calls `f(x, y, width, height)` with the rectangles (content
    /// coordinates) that highlight the characters of `range`: per line,
    /// the spans of selected glyphs and attachments, line high. The
    /// trimming ellipsis is never selected.
    fn range_rects(&self, (a, b): (u32, u32), mut f: impl FnMut(f32, f32, f32, f32)) {
        let mut spans: Vec<(f32, f32)> = Vec::new();
        for line in &self.lines {
            let (y, h) = (line.info.y.0, line.info.height.0);
            spans.clear();
            for s in self.line_stops(line) {
                if !s.sign && s.index >= a && s.index < b {
                    spans.push((s.x, s.x + s.width));
                }
            }
            spans.sort_by(|p, q| p.0.total_cmp(&q.0));
            let mut current: Option<(f32, f32)> = None;
            for &(x0, x1) in &spans {
                current = match current {
                    Some((c0, c1)) if x0 <= c1 + 0.5 => Some((c0, c1.max(x1))),
                    Some((c0, c1)) => {
                        f(c0, y, c1 - c0, h);
                        Some((x0, x1))
                    }
                    None => Some((x0, x1)),
                };
            }
            if let Some((c0, c1)) = current {
                f(c0, y, c1 - c0, h);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(parts: &[(&str, ResolvedTextStyle)]) -> AttributedText {
        let mut t = AttributedText::default();
        for (s, style) in parts {
            t.push(s, *style);
        }
        t
    }

    fn engine() -> DWriteTextEngine {
        DWriteTextEngine::new(ui_family())
    }

    fn plain(size: f32) -> ResolvedTextStyle {
        ResolvedTextStyle {
            font_size: px(size),
            ..Default::default()
        }
    }

    fn layout_of(
        engine: &DWriteTextEngine,
        t: &AttributedText,
        width: Option<f32>,
    ) -> (Size<Points>, TextLayout) {
        let prepared = engine.prepare(t);
        let size = engine.measure(&prepared, width.map(px));
        (size, engine.layout(&prepared, size))
    }

    /// The text a layout draws, by its glyphs' cluster offsets.
    fn drawn(t: &AttributedText, layout: &TextLayout) -> String {
        let l = layout.downcast::<WinLayout>().unwrap();
        let units: Vec<u16> = t.text.encode_utf16().collect();
        let mut seen = Vec::new();
        for run in &l.runs {
            for &i in run.indices.iter() {
                if seen.last() != Some(&i) {
                    seen.push(i);
                }
            }
        }
        seen.iter()
            .filter_map(|&i| units.get(i as usize))
            .map(|&u| char::from_u32(u32::from(u)).unwrap_or('?'))
            .collect()
    }

    #[test]
    fn families() {
        assert_eq!(family_names("Inter", "Segoe UI"), ["Inter"]);
        assert_eq!(family_names("system-ui", "Segoe UI"), ["Segoe UI"]);
        assert_eq!(family_names("ui-monospace", "X"), ["Consolas"]);
        assert_eq!(
            family_names("\"Fira Code\", ui-monospace, monospace", "X"),
            ["Fira Code", "Consolas", "Consolas"]
        );
        assert_eq!(family_names(" , ", "X"), ["X"]);
        assert_eq!(alias("Menlo"), Some("Consolas"));
    }

    #[test]
    fn directions() {
        assert_eq!(first_strong("123 hello"), Some(false));
        assert_eq!(first_strong("123 שלום"), Some(true));
        assert_eq!(first_strong("مرحبا hello"), Some(true));
        assert_eq!(first_strong("123 !"), None);
    }

    #[test]
    fn cut_offsets() {
        // "ab…ef" from "abcdef": the ellipsis stands for "c".
        let pieces = [(0, 2, 0), (4, 6, 3)];
        assert_eq!(from_cut(&pieces, 0), 0);
        assert_eq!(from_cut(&pieces, 1), 1);
        assert_eq!(from_cut(&pieces, 2), 2);
        assert_eq!(from_cut(&pieces, 3), 4);
        assert_eq!(from_cut(&pieces, 4), 5);
        assert_eq!(to_cut(&pieces, 5), Some(4));
        assert_eq!(to_cut(&pieces, 3), None);
        // "…ef": the ellipsis stands for the start.
        assert_eq!(from_cut(&[(4, 6, 1)], 0), 0);
        assert_eq!(from_cut(&[(4, 6, 1)], 1), 4);
    }

    /// What is measured at a width lays out in as many lines at the
    /// measured size (the core sizes text views from `measure`).
    #[test]
    fn layout_matches_measure() {
        let engine = engine();
        let plain = plain(15.0);
        let texts = [
            text(&[(
                "The quick brown fox jumps over the lazy dog, again and again.",
                plain,
            )]),
            text(&[
                (
                    "Spaced letters ",
                    ResolvedTextStyle {
                        letter_spacing: px(1.3),
                        ..plain
                    },
                ),
                (
                    "and bold italic",
                    ResolvedTextStyle {
                        font_weight: 700,
                        italic: true,
                        ..plain
                    },
                ),
                (
                    " mixed with big text",
                    ResolvedTextStyle {
                        font_size: px(31.0),
                        line_height: px(40.0),
                        ..plain
                    },
                ),
            ]),
            text(&[(
                "中文排版测试：原生文本在引擎线程排版。日本語のテキスト 😀",
                plain,
            )]),
            text(&[(
                "First paragraph\nsecond one, a little longer\n\nthird",
                plain,
            )]),
        ];
        for t in &texts {
            let prepared = engine.prepare(t);
            let natural = engine.measure(&prepared, None);
            let layout = engine.layout(&prepared, natural);
            let paragraphs = t.text.split('\n').count();
            assert_eq!(
                engine.lines(&layout).len(),
                paragraphs,
                "{:?} unwrapped",
                t.text
            );
            for width in (40..400).step_by(7) {
                let size = engine.measure(&prepared, Some(px(width as f32)));
                let measured_lines = engine.configure(&prepared, Some(width as f32));
                let lines = engine.lines(&engine.layout(&prepared, size));
                assert_eq!(lines.len(), measured_lines, "{:?} at {width}", t.text);
                let bottom = lines.last().map_or(0.0, |l| (l.y + l.height).0);
                assert!(
                    bottom <= size.height.0,
                    "{:?} at {width}: {bottom} > {size:?}",
                    t.text
                );
                for line in &lines {
                    assert!(
                        line.x.0 >= -0.01 && line.x + line.width <= size.width + px(2.0),
                        "{:?} at {width}: {line:?} in {size:?}",
                        t.text
                    );
                }
            }
        }
    }

    #[test]
    fn wrapping_widths() {
        let engine = engine();
        let t = text(&[("The quick brown fox jumps over the lazy dog", plain(15.0))]);
        let prepared = engine.prepare(&t);
        let one = engine.measure(&prepared, None);
        let wrapped = engine.measure(&prepared, Some(one.width / 2.0));
        assert!(wrapped.width <= (one.width / 2.0).ceil(), "{wrapped:?}");
        assert!(wrapped.height >= one.height * 2.0, "{wrapped:?} vs {one:?}");
        // No wrapping: as wide as the text, past the width.
        let mut t = t.clone();
        t.no_wrap = true;
        let prepared = engine.prepare(&t);
        assert_eq!(engine.measure(&prepared, Some(px(50.0))), one);
    }

    #[test]
    fn line_heights() {
        let engine = engine();
        let t = text(&[(
            "Line height on every line of a paragraph that wraps a few times",
            ResolvedTextStyle {
                font_size: px(16.0),
                line_height: px(30.0),
                ..Default::default()
            },
        )]);
        let (size, layout) = layout_of(&engine, &t, Some(150.0));
        let lines = engine.lines(&layout);
        assert!(lines.len() > 2);
        for (i, l) in lines.iter().enumerate() {
            assert!((l.height.0 - 30.0).abs() < 0.01, "{l:?}");
            assert!((l.y.0 - 30.0 * i as f32).abs() < 0.01, "{l:?}");
        }
        assert_eq!(size.height, Points((30.0 * lines.len() as f32).ceil()));
        // A bigger span only grows its own line.
        let small = plain(14.0);
        let t = text(&[
            ("Small ", small),
            ("Big", plain(32.0)),
            (" and then enough small text to wrap onto more lines", small),
        ]);
        let (_, layout) = layout_of(&engine, &t, Some(180.0));
        let lines = engine.lines(&layout);
        assert!(lines.len() > 2);
        assert!(lines[0].height > lines[1].height * 1.5, "{lines:?}");
        assert!(
            (lines[1].height - lines[2].height).0.abs() < 0.01,
            "{lines:?}"
        );
    }

    #[test]
    fn letter_spacing_widens() {
        let engine = engine();
        let t = text(&[("Spacing", plain(15.0))]);
        let spaced = text(&[(
            "Spacing",
            ResolvedTextStyle {
                letter_spacing: px(4.0),
                ..plain(15.0)
            },
        )]);
        let a = engine.measure(&engine.prepare(&t), None);
        let b = engine.measure(&engine.prepare(&spaced), None);
        // Seven letters, four points after each.
        assert!(
            (b.width - a.width - px(28.0)).abs() <= px(1.0),
            "{a:?} {b:?}"
        );
        assert_eq!(a.height, b.height);
    }

    #[test]
    fn font_variants_apply() {
        let engine = engine();
        let digits = |variant: u8| {
            let style = ResolvedTextStyle {
                font_variant: nsh_core::FontVariant(variant),
                // Not the UI font: that is another one in some languages.
                font_family: Some(nsh_core::FontFamily::new("Segoe UI")),
                ..plain(20.0)
            };
            engine
                .measure(&engine.prepare(&text(&[("1111 abc", style)])), None)
                .width
        };
        // Segoe UI's digits are tabular; proportional ones make "1" narrow.
        let proportional = digits(nsh_core::FontVariant::PROPORTIONAL_NUMS);
        assert!(
            proportional < digits(0) - px(5.0),
            "{proportional} {}",
            digits(0)
        );
    }

    #[test]
    fn attachments_sit_by_vertical_align() {
        let engine = engine();
        let style = ResolvedTextStyle::default();
        // The first line's top of a 30 pt attachment after "Ax", and the
        // line's extent above and below its baseline.
        let place = |align| {
            let mut t = text(&[("Ax", style)]);
            let mut alignments = nsh_core::AttachmentAlignments::default();
            alignments.push(
                &mut t,
                nsh_core::geometry::size(Points(10.0), Points(30.0)),
                align,
                style,
            );
            let prepared = engine.prepare_aligned(&t, &alignments);
            let size = engine.measure(&prepared, None);
            let layout = engine.layout(&prepared, size);
            let line = engine.lines(&layout).remove(0);
            let top = engine.attachments(&layout)[0].expect("shown").y.0;
            (top, line.ascender.0, line.descender.0)
        };
        let near = |a: f32, b: f32| (a - b).abs() < 0.01;
        // Its bottom on the baseline.
        let (top, up, _) = place(nsh_core::VerticalAlign::Baseline);
        assert!(near(top + 30.0, up), "{top} {up}");
        // Its top at the font's: the line grows below the baseline.
        let (top, up, down) = place(nsh_core::VerticalAlign::TextTop);
        assert!(near(top, 0.0) && near(up + down, 30.0), "{top} {up} {down}");
        // Its bottom at the font's: the line grows above the baseline.
        let (top, up, down) = place(nsh_core::VerticalAlign::TextBottom);
        assert!(
            near(top + 30.0, up + down) && near(top, 0.0),
            "{top} {up} {down}"
        );
        // Its middle above the baseline.
        let (top, up, _) = place(nsh_core::VerticalAlign::Middle);
        assert!(top + 15.0 < up, "{top} {up}");
    }

    #[test]
    fn max_lines_and_attachments() {
        let engine = engine();
        let style = ResolvedTextStyle::default();
        let mut t = text(&[("Before ", style)]);
        t.push_attachment(nsh_core::geometry::size(px(20.0), px(30.0)), style);
        t.push(
            " after the attachment, and long enough to wrap a few times here.",
            style,
        );
        let prepared = engine.prepare(&t);
        let size = engine.measure(&prepared, Some(px(120.0)));
        let layout = engine.layout(&prepared, size);
        let points = engine.attachments(&layout);
        assert_eq!(points.len(), 1);
        let nsh_core::Point { x, y } = points[0].expect("attachment shown");
        let (x, y) = (x.0, y.0);
        assert!(x > 0.0 && y >= 0.0, "{x}, {y}");
        let lines = engine.lines(&layout);
        assert!(lines[0].height.0 >= 30.0, "{:?}", lines[0]);
        // On the baseline.
        assert!(
            (y + 30.0 - lines[0].ascender.0).abs() < 0.01,
            "{y} {:?}",
            lines[0]
        );

        t.max_lines = 2;
        t.ellipsize = EllipsizeMode::Tail;
        let prepared = engine.prepare(&t);
        let two = engine.measure(&prepared, Some(px(120.0)));
        assert!(two.height < size.height);
        let layout = engine.layout(&prepared, two);
        assert_eq!(engine.lines(&layout).len(), 2);
        let shown = drawn(&t, &layout);
        assert!(shown.chars().count() < t.text.chars().count(), "{shown}");

        let mut t = text(&[("One\ntwo\nthree", style)]);
        t.max_lines = 2;
        t.ellipsize = EllipsizeMode::Tail;
        let prepared = engine.prepare(&t);
        let size = engine.measure(&prepared, Some(px(200.0)));
        let layout = engine.layout(&prepared, size);
        let lines = engine.lines(&layout);
        assert_eq!(lines.len(), 2);
        let l = layout.downcast::<WinLayout>().unwrap();
        // "two" and the ellipsis, which stands for the line break.
        let last: Vec<u32> = l.runs[l.lines[1].runs.clone()]
            .iter()
            .flat_map(|r| r.indices.iter().copied())
            .collect();
        assert!(last.contains(&7), "{last:?}");
        // Measuring again (without the cut) still sees three paragraphs.
        assert_eq!(engine.measure(&prepared, None).height, {
            let p = engine.prepare(&t);
            engine.measure(&p, None).height
        });
    }

    #[test]
    fn head_and_middle_ellipses() {
        let engine = engine();
        let long = "Start of a long line of text that will not fit in the box at all, end";
        for (mode, keeps_start, keeps_end) in [
            (EllipsizeMode::Head, false, true),
            (EllipsizeMode::Middle, true, true),
            (EllipsizeMode::Tail, true, false),
        ] {
            let mut t = text(&[(long, plain(14.0))]);
            t.max_lines = 1;
            t.ellipsize = mode;
            let prepared = engine.prepare(&t);
            let size = engine.measure(&prepared, Some(px(160.0)));
            let layout = engine.layout(&prepared, size);
            let lines = engine.lines(&layout);
            assert_eq!(lines.len(), 1, "{mode:?}");
            assert!(
                (lines[0].x + lines[0].width).0 <= 161.0,
                "{mode:?} {:?}",
                lines[0]
            );
            let shown = drawn(&t, &layout);
            assert_eq!(shown.starts_with("Start"), keeps_start, "{mode:?}: {shown}");
            assert_eq!(shown.ends_with(", end"), keeps_end, "{mode:?}: {shown}");
        }
    }

    #[test]
    fn lines_report_metrics() {
        let engine = engine();
        let t = text(&[("Hx\nsecond line", plain(20.0))]);
        let (_, layout) = layout_of(&engine, &t, None);
        let lines = engine.lines(&layout);
        assert_eq!(lines.len(), 2);
        let (first, second) = (&lines[0], &lines[1]);
        assert_eq!((first.start, first.end), (0, 2));
        assert_eq!((second.start, second.end), (3, 14));
        assert_eq!(first.y, px(0.0));
        assert!((second.y - first.height).0.abs() < 0.01);
        assert!((first.ascender + first.descender - first.height).0.abs() < 0.01);
        assert!(
            first.ascender.0 > 15.0 && first.descender.0 > 3.0,
            "{first:?}"
        );
        let (cap, x) = (first.cap_height.0, first.x_height.0);
        assert!(cap > 11.0 && cap < 16.0 && x > 8.0 && x < cap, "{cap} {x}");
        assert!(second.width > first.width);
    }

    #[test]
    fn alignment() {
        let engine = engine();
        let mut t = text(&[("Short", plain(15.0))]);
        let size = Size::new(px(300.0), px(30.0));
        let x = |t: &AttributedText| {
            let p = engine.prepare(t);
            engine.lines(&engine.layout(&p, size))[0].x.0
        };
        assert!(x(&t) < 1.0);
        t.align = TextAlign::Right;
        assert!(x(&t) > 200.0);
        t.align = TextAlign::Center;
        assert!(x(&t) > 100.0 && x(&t) < 200.0);
        // `auto` in a right-to-left layout is the right side.
        t.align = TextAlign::Auto;
        t.rtl = true;
        assert!(x(&t) > 200.0);
        let mut hebrew = text(&[("שלום", plain(15.0))]);
        assert!(x(&hebrew) > 200.0);
        hebrew.align = TextAlign::Left;
        assert!(x(&hebrew) < 1.0);
    }

    #[test]
    fn registered_fonts_lay_out() {
        let engine = engine();
        let data = include_bytes!("../../../examples/gallery/fonts/Pacifico-Regular.ttf");
        let style = ResolvedTextStyle {
            font_family: Some(nsh_core::FontFamily::new("Pacifico")),
            font_size: px(20.0),
            ..Default::default()
        };
        let t = text(&[("Custom fonts", style)]);
        let before = engine.measure(&engine.prepare(&t), None);
        engine.register_font(data).expect("registered");
        assert!(engine.register_font(b"not a font").is_err());
        let prepared = engine.prepare(&t);
        let after = engine.measure(&prepared, None);
        assert_ne!(before, after);
        assert!(engine.face(&style).custom);
        // Pacifico is tall: its lines are more than 1.5 ems.
        assert!(after.height > px(30.0), "{after:?}");
    }

    #[test]
    fn fallback_fonts_keep_the_line_height() {
        let engine = engine();
        let h = |s: &str| {
            engine
                .measure(&engine.prepare(&text(&[(s, plain(16.0))])), None)
                .height
        };
        let latin = h("Grace");
        assert_eq!(h("Grace你好世界"), latin, "CJK");
        assert_eq!(h("Grace😀"), latin, "emoji");
    }

    #[test]
    fn emoji_have_color_layers() {
        let engine = engine();
        let t = text(&[("a😀", plain(16.0))]);
        let (_, layout) = layout_of(&engine, &t, None);
        let l = layout.downcast::<WinLayout>().unwrap();
        assert!(l.runs.iter().any(|r| r.layers.is_some()));
    }

    #[test]
    fn empty_text_has_one_line() {
        let engine = engine();
        let t = AttributedText::default();
        let (size, layout) = layout_of(&engine, &t, Some(100.0));
        assert_eq!(size.width, px(0.0));
        assert!(size.height > px(10.0));
        assert_eq!(engine.lines(&layout).len(), 1);
    }

    #[test]
    fn spans_by_offset() {
        let style = ResolvedTextStyle::default();
        let spans = [
            TextSpan {
                start: 0,
                end: 2,
                style,
            },
            TextSpan {
                start: 2,
                end: 5,
                style,
            },
        ];
        assert_eq!(span_at(&spans, 0), 0);
        assert_eq!(span_at(&spans, 1), 0);
        assert_eq!(span_at(&spans, 2), 1);
        assert_eq!(span_at(&spans, 4), 1);
        assert_eq!(span_at(&spans, 9), 1);
        assert_eq!(span_at(&[], 3), 0);
    }

    #[test]
    fn word_and_paragraph_units() {
        let s = "Hello, don't stop\n中文字 next  end";
        assert_eq!(unit_at(s, 1, Unit::Word), (0, 5));
        assert_eq!(unit_at(s, 5, Unit::Word), (5, 6));
        // Apostrophes inside a word belong to it.
        assert_eq!(unit_at(s, 8, Unit::Word), (7, 12));
        assert_eq!(unit_at(s, 18, Unit::Word), (18, 21));
        // Runs of spaces are a unit.
        assert_eq!(unit_at(s, 27, Unit::Word), (26, 28));
        assert_eq!(unit_at(s, 3, Unit::Paragraph), (0, 17));
        assert_eq!(unit_at(s, 20, Unit::Paragraph), (18, 31));
        assert_eq!(unit_at(s, 99, Unit::Word), (28, 31));
        assert_eq!(unit_at("", 0, Unit::Word), (0, 0));
        // Surrogate pairs count two units.
        assert_eq!(unit_at("a😀b c", 3, Unit::Word), (3, 4));
    }

    #[test]
    fn extending_by_units() {
        let s = "one two three";
        assert_eq!(extend(s, (5, 5), 2, Unit::Char), (2, 5));
        assert_eq!(extend(s, (5, 5), 9, Unit::Char), (5, 9));
        // From "two": forward to the end of "three", back to "one".
        assert_eq!(extend(s, (4, 7), 10, Unit::Word), (4, 13));
        assert_eq!(extend(s, (4, 7), 1, Unit::Word), (0, 7));
        // A caret at a word's end stays in it.
        assert_eq!(extend(s, (0, 3), 7, Unit::Word), (0, 7));
    }

    #[test]
    fn span_backgrounds_box_each_line() {
        let engine = engine();
        let style = plain(15.0);
        let code = ResolvedTextStyle {
            font_size: px(13.0),
            background: Some(nsh_core::TextBackground {
                color: Color(0xeeee_eeff),
                radius: px(4.0),
                node: 4,
            }),
            ..style
        };
        let t = text(&[("Run ", style), ("cargo test --all", code), (" now", style)]);
        let boxes = |width: Option<f32>| {
            let (size, layout) = layout_of(&engine, &t, width);
            let l = layout.downcast::<WinLayout>().unwrap();
            let mut rects = Vec::new();
            l.background_rects(&t, |x, y, w, h, r, _| rects.push((x, y, w, h, r)));
            (size, rects)
        };
        let (size, rects) = boxes(None);
        assert_eq!(rects.len(), 1, "{rects:?}");
        let (x, y, w, h, r) = rects[0];
        assert!(
            x > 0.0 && x + w < size.width.0 && y >= 0.0 && h <= size.height.0,
            "{rects:?}"
        );
        assert_eq!(r, 4.0);
        // Wrapped: a box on each line the span reaches.
        let (_, rects) = boxes(Some(w * 0.7));
        assert!(rects.len() >= 2, "{rects:?}");
        assert!(rects[1].1 > rects[0].1);
    }

    #[test]
    fn carets_and_highlights() {
        let engine = engine();
        let style = plain(15.0);
        let t = text(&[("First line here\nsecond", style)]);
        let (size, layout) = layout_of(&engine, &t, None);
        let l = layout.downcast::<WinLayout>().unwrap();
        assert_eq!(l.lines.len(), 2);
        let at = |x: f32, y: f32| l.hit_test(x, y).offset;
        assert_eq!(at(-5.0, 2.0), 0);
        assert_eq!(at((size.width + px(20.0)).0, 2.0), 15);
        // Below the text: the last line.
        assert_eq!(
            at((size.width + px(20.0)).0, (size.height + px(50.0)).0),
            22
        );
        let mid = at((size.width / 2.0).0, 2.0);
        assert!(mid > 3 && mid < 12, "{mid}");
        // Nearest glyph edge: just right of a glyph's start is before it.
        let g = l.line_glyphs(&l.lines[0]).nth(2).unwrap();
        assert_eq!(at(g.x + g.width * 0.2, 2.0), g.index);
        assert_eq!(at(g.x + g.width * 0.8, 2.0), g.index + 1);
        assert_eq!(l.char_at(g.x + g.width * 0.5, 2.0), Some(g.index));

        let mut rects = Vec::new();
        l.range_rects((6, 19), |x, y, w, h| rects.push((x, y, w, h)));
        // "line here" on the first line, "sec" on the second.
        assert_eq!(rects.len(), 2, "{rects:?}");
        assert!(rects[0].0 > 0.0 && rects[0].1 == 0.0);
        assert!(rects[1].0.abs() < 0.01);
        assert!(rects[1].1 >= rects[0].3);

        let mut rtl = text(&[("שלום עולם", style)]);
        rtl.rtl = true;
        let (size, layout) = layout_of(&engine, &rtl, None);
        let l = layout.downcast::<WinLayout>().unwrap();
        // Right to left: the right edge is the start.
        assert_eq!(l.hit_test((size.width + px(5.0)).0, 2.0).offset, 0);
        assert_eq!(l.hit_test(-5.0, 2.0).offset, 9);
    }

    #[test]
    fn hit_testing_through_the_engine() {
        let engine = engine();
        let t = text(&[("The quick brown fox jumps over the lazy dog", plain(15.0))]);
        let (size, layout) = layout_of(&engine, &t, Some(90.0));
        let lines = engine.lines(&layout);
        assert!(lines.len() > 2);
        let far = size.width.0 + 50.0;
        // Past the end of a wrapped line: its end, upstream; the caret
        // box is on that line.
        let p = engine.hit_test(&layout, nsh_core::geometry::point(Points(far), lines[0].y));
        assert_eq!(p.offset, lines[0].end);
        assert_eq!(p.affinity, Affinity::Upstream);
        let caret = engine.caret_rect(&layout, p).unwrap();
        assert_eq!(caret.origin.y, lines[0].y);
        assert_eq!(caret.size.height, lines[0].height);
        assert_eq!(caret.size.width, Points(0.0));
        // The same offset downstream is the start of the next line.
        let next = engine
            .caret_rect(
                &layout,
                TextPosition::new(lines[1].start, Affinity::Downstream),
            )
            .unwrap();
        assert_eq!(next.origin.y, lines[1].y);
        // The last line ends the text, downstream.
        let last = lines.last().unwrap();
        let p = engine.hit_test(&layout, nsh_core::geometry::point(Points(far), last.y));
        assert_eq!(p.offset, last.end);
        assert_eq!(p.affinity, Affinity::Downstream);
        // A range across lines appends one box per line, through the
        // first line's end, and an empty one nothing.
        let origin = nsh_core::geometry::point(Points(0.0), Points(0.0));
        let mut out = vec![Bounds::new(origin, Size::new(Points(0.0), Points(0.0)))];
        engine.range_rects(&layout, 2..lines[1].end - 1, &mut out);
        assert_eq!(out.len(), 3);
        assert_eq!(out[1].origin.y, lines[0].y);
        assert_eq!(out[2].origin.y, lines[1].y);
        engine.range_rects(&layout, 4..4, &mut out);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn hard_breaks_keep_the_caret_before_them() {
        let engine = engine();
        let t = text(&[("ab\ncd", plain(15.0))]);
        let (size, layout) = layout_of(&engine, &t, None);
        let lines = engine.lines(&layout);
        assert_eq!(lines.len(), 2);
        let far = nsh_core::geometry::point(size.width + px(30.0), px(1.0));
        let p = engine.hit_test(&layout, far);
        assert_eq!(p, TextPosition::new(2, Affinity::Downstream));
        let c = engine.caret_rect(&layout, p).unwrap();
        assert_eq!(c.origin.y, lines[0].y);
        // Another layout type: nothing.
        let other = TextLayout(Arc::new(0u8));
        assert_eq!(
            engine.hit_test(&other, nsh_core::geometry::point(px(0.0), px(0.0))),
            TextPosition::default()
        );
        assert!(engine.caret_rect(&other, p).is_none());
    }
}

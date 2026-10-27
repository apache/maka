//! Pango text engine (engine thread) and text drawing (main thread).
//!
//! Text is typeset once, on the engine thread, with a font map of the
//! engine's own (Pango objects are not thread-safe, and GTK's font map
//! belongs to the main thread). The final layout is plain data: per glyph
//! run the font's description, the glyph ids and positions; the main thread
//! loads the same fonts by description from GTK's font map and draws the
//! glyphs where the engine put them (`gsk::TextNode`), so what was measured
//! is what is drawn. Hinted metrics and rounded glyph positions are off on
//! both sides, so measuring is resolution-independent.
//!
//! Colors and decorations are not part of a layout: the core reuses a
//! layout for a text that only differs in them (`AttributedText::layout_eq`),
//! so they are read from the drawn text's spans, per glyph cluster.

use std::{
    cell::{Cell, OnceCell, RefCell},
    ffi::c_void,
    path::PathBuf,
    rc::Rc,
    sync::{Arc, Mutex},
};

use gtk4::{self as gtk, glib, glib::translate::ToGlibPtr, graphene, gsk, prelude::*};
use nsh_core::{
    ATTACHMENT_CHAR, Affinity, AttributedText, Bounds, Color, DecorationStyle, EllipsizeMode,
    EventKind, Points, ResolvedTextStyle, Size, TextAlign, TextEngine, TextLayout, TextLine,
    TextPosition, TextSpan,
};
use rustc_hash::FxHashMap;

use crate::view::{NshView, ViewState};

/// Pango units per point.
const SCALE: f32 = pango::SCALE as f32;

/// Pango's glyph of a shaped (attachment) or invisible character.
const GLYPH_EMPTY: u32 = 0x0FFF_FFFF;

/// The bits of `PangoGlyphVisAttr` (`is_cluster_start`, `is_color`); the
/// rest of its word is padding.
const VIS_ATTRS: u32 = 0b11;

/// `PANGO_ANALYSIS_FLAG_IS_ELLIPSIS`: the run is the ellipsis standing in
/// for the text a line cut off.
const ANALYSIS_FLAG_IS_ELLIPSIS: u8 = 1 << 1;

/// iOS's system blue: the selection's tint without `selectionColor`.
const SYSTEM_BLUE: Color = Color(0x007a_ffff);

/// Cap height and x height (in ems) of fonts whose tables do not say.
const CAP_HEIGHT: f32 = 0.7;
const X_HEIGHT: f32 = 0.5;

/// Font files registered by any engine; the main thread adds them to its
/// font map before loading fonts to draw with.
static FONT_FILES: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn to_pango(points: f32) -> i32 {
    (points * SCALE).round() as i32
}

fn from_pango(units: i32) -> f32 {
    units as f32 / SCALE
}

#[link(name = "harfbuzz")]
unsafe extern "C" {
    fn hb_ot_metrics_get_position(font: *mut c_void, tag: u32, position: *mut i32) -> i32;
    fn hb_font_get_scale(font: *mut c_void, x: *mut i32, y: *mut i32);
}

/// The cap height and x height (points) of `font` at `size` points, from
/// its OS/2 table (HarfBuzz's metrics; Pango's have neither); typical
/// proportions when the table has none.
fn cap_and_x_height(font: &pango::Font, size: f32) -> (f32, f32) {
    const CAP: u32 = u32::from_be_bytes(*b"cpht");
    const X: u32 = u32::from_be_bytes(*b"xhgt");
    // SAFETY: `font` is a live `PangoFont`; the HarfBuzz font it returns
    // is owned by it (not referenced here) and outlives this call.
    let hb = unsafe { pango::ffi::pango_font_get_hb_font(font.to_glib_none().0) } as *mut c_void;
    let fallback = (size * CAP_HEIGHT, size * X_HEIGHT);
    if hb.is_null() {
        return fallback;
    }
    let (mut sx, mut sy) = (0, 0);
    // SAFETY: `hb` is a valid `hb_font_t`; both out pointers are locals.
    unsafe { hb_font_get_scale(hb, &mut sx, &mut sy) };
    if sy == 0 {
        return fallback;
    }
    let get = |tag: u32, default: f32| {
        let mut position = 0;
        // SAFETY: as above.
        let found = unsafe { hb_ot_metrics_get_position(hb, tag, &mut position) } != 0;
        if found && position > 0 {
            position as f32 / sy as f32 * size
        } else {
            default
        }
    };
    (get(CAP, fallback.0), get(X, fallback.1))
}

/// The family of the desktop's UI font (`gtk-font-name`), read on the main
/// thread for the engine's default family.
pub(crate) fn ui_family() -> Arc<str> {
    gtk::Settings::default()
        .and_then(|s| s.gtk_font_name())
        .and_then(|name| pango::FontDescription::from_string(&name).family())
        .filter(|f| !f.is_empty())
        .map_or_else(|| "sans-serif".into(), |f| f.as_str().into())
}

/// The font of `style` as text views lay it out: `ui_family` stands for
/// `fontFamily` unset, the size is absolute (1 point is 1 GTK pixel).
/// Letter spacing (`AttrInt::new_letter_spacing`), line height
/// (`AttrInt::new_line_height_absolute`) and `fontVariant` are attributes,
/// not part of the font.
pub(crate) fn font_description(
    style: &ResolvedTextStyle,
    ui_family: &str,
) -> pango::FontDescription {
    let mut desc = pango::FontDescription::new();
    match style.font_family {
        Some(family) => desc.set_family(&resolve_family(&family.name(), ui_family)),
        None => desc.set_family(ui_family),
    }
    desc.set_weight(weight(style.font_weight));
    // Always set: a run's font attribute leaves unset fields to the
    // layout's base font, which is the first run's (an italic comment
    // first would make the whole text italic).
    desc.set_style(if style.italic {
        pango::Style::Italic
    } else {
        pango::Style::Normal
    });
    desc.set_absolute_size(f64::from(style.font_size.0) * f64::from(pango::SCALE));
    desc
}

thread_local! {
    static UI_FAMILY: OnceCell<Arc<str>> = const { OnceCell::new() };
}

/// [`font_description`] on the main thread, with the desktop's UI family.
pub(crate) fn main_font_description(style: &ResolvedTextStyle) -> pango::FontDescription {
    UI_FAMILY.with(|family| font_description(style, family.get_or_init(ui_family)))
}

/// The Pango family list of a `fontFamily` value: CSS generic and system
/// names map to fontconfig's, a comma-separated stack stays one (Pango
/// takes family lists).
fn resolve_family(name: &str, ui: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for family in name.split(',') {
        let family = family.trim().trim_matches(|c| c == '"' || c == '\'');
        let family = match family {
            "" => continue,
            "system-ui" | "-apple-system" | "BlinkMacSystemFont" | "ui-sans-serif"
            | "ui-rounded" | "sans-serif" => ui,
            "ui-monospace" | "monospace" => "monospace",
            "ui-serif" | "serif" => "serif",
            f => f,
        };
        if !out.is_empty() {
            out.push(',');
        }
        out.push_str(family);
    }
    if out.is_empty() {
        out.push_str(ui);
    }
    out
}

/// Pango's weight nearest to a CSS weight.
fn weight(w: u16) -> pango::Weight {
    match (w + 50) / 100 {
        0 | 1 => pango::Weight::Thin,
        2 => pango::Weight::Ultralight,
        3 => pango::Weight::Light,
        4 => pango::Weight::Normal,
        5 => pango::Weight::Medium,
        6 => pango::Weight::Semibold,
        7 => pango::Weight::Bold,
        8 => pango::Weight::Ultrabold,
        _ => pango::Weight::Heavy,
    }
}

/// The UTF-16 offset of every byte offset of `text` that starts a
/// character (and of its end); other entries are those of the character
/// they are in.
fn utf16_offsets(text: &str) -> Box<[u32]> {
    let mut out = vec![0u32; text.len() + 1];
    let mut units = 0u32;
    for (i, c) in text.char_indices() {
        out[i..i + c.len_utf8()].fill(units);
        units += c.len_utf16() as u32;
    }
    out[text.len()] = units;
    out.into()
}

/// The byte offset of the UTF-16 offset `units` in `text`, walking on from
/// `(byte, unit)` (a character boundary at or before it); offsets inside a
/// surrogate pair round up, offsets past the end clamp.
fn utf16_to_byte(text: &str, from: (usize, u32), units: u32) -> usize {
    let (mut byte, mut at) = from;
    for c in text[byte..].chars() {
        if at >= units {
            break;
        }
        at += c.len_utf16() as u32;
        byte += c.len_utf8();
    }
    byte
}

/// The length in bytes of the paragraph separator `text` starts with.
fn separator_len(text: &str) -> usize {
    if text.starts_with("\r\n") {
        2
    } else if text.starts_with(['\n', '\r']) {
        1
    } else if text.starts_with('\u{2029}') {
        3
    } else {
        0
    }
}

/// The index of the span containing the UTF-16 offset `index` (the last
/// one past the end).
fn span_at(spans: &[TextSpan], index: u32) -> usize {
    spans
        .partition_point(|s| s.end <= index)
        .min(spans.len().saturating_sub(1))
}

/// Metrics of a font a run is set in.
#[derive(Debug)]
struct FontInfo {
    /// `Font::describe_with_absolute_size`, to load it on the main thread.
    desc: Arc<str>,
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
}

/// One glyph of a run (Pango units, as Pango shaped it).
#[derive(Debug, Clone, Copy)]
struct Glyph {
    id: u32,
    /// Advance.
    width: i32,
    x_offset: i32,
    y_offset: i32,
    /// `PangoGlyphVisAttr` bits (cluster start, color glyph).
    attr: u32,
    /// UTF-16 offset of the glyph's cluster.
    index: u32,
}

/// A glyph run in one font, at its pen position in the content box.
#[derive(Debug)]
struct Run {
    font: Arc<FontInfo>,
    /// Pen x of the first glyph (points).
    x: f32,
    /// Pen x after the last glyph.
    end: f32,
    /// Baseline (points).
    baseline: f32,
    /// Set right to left: its glyphs go in decreasing text order.
    rtl: bool,
    /// The run is the ellipsis of a cut off line: it stands for text that
    /// is not shown, so it is never selected.
    ellipsis: bool,
    glyphs: Vec<Glyph>,
}

/// One line of a final layout.
#[derive(Debug)]
struct Line {
    info: TextLine,
    /// Its runs in [`LinuxLayout::runs`].
    runs: std::ops::Range<usize>,
}

/// A final layout: plain data, drawn on the main thread.
#[derive(Debug, Default)]
pub(crate) struct LinuxLayout {
    runs: Vec<Run>,
    lines: Vec<Line>,
    attachments: Vec<Option<(f32, f32)>>,
    /// Per attachment, in order: its UTF-16 index in the text and its
    /// width (points), for hit testing (the glyph runs hold no glyph for
    /// it).
    attachment_extents: Vec<(u32, f32)>,
}

/// A stretch of one line the caret moves over as a unit (content
/// coordinates): the glyphs of one cluster, or an attachment.
#[derive(Debug, Clone, Copy)]
struct Cluster {
    /// Left and right edge.
    x0: f32,
    x1: f32,
    /// The UTF-16 offsets it starts and ends at (logical order).
    start: u32,
    end: u32,
    /// Its glyphs run right to left: the start is at the right edge.
    rtl: bool,
    /// It is the ellipsis of a cut off line.
    ellipsis: bool,
}

impl Cluster {
    /// The text offset of the caret at its left edge.
    fn left_offset(&self) -> u32 {
        if self.rtl { self.end } else { self.start }
    }

    /// The text offset of the caret at its right edge.
    fn right_offset(&self) -> u32 {
        if self.rtl { self.start } else { self.end }
    }
}

/// What [`PangoTextEngine::prepare`] makes.
pub(crate) struct Prepared {
    layout: pango::Layout,
    /// UTF-16 offset of each byte offset of the text.
    utf16: Box<[u32]>,
    /// Byte offsets of the attachments' placeholders, in order, with how
    /// far the attachment's top is above the baseline
    /// (`TextAttachment::ascent`).
    attachments: Vec<(u32, f32)>,
    /// Per attachment, in order: its UTF-16 index and width (points).
    attachment_extents: Vec<(u32, f32)>,
    max_lines: u32,
    ellipsize: pango::EllipsizeMode,
    no_wrap: bool,
    /// The text, when it has more than one paragraph and is ellipsized
    /// after a number of lines.
    paragraphs: Option<Box<str>>,
    /// The layout's text is cut after the last line that shows (see
    /// [`PangoTextEngine::configure`]).
    joined: Cell<bool>,
    /// Font size of the spans, by the byte offset each ends at.
    sizes: Vec<(u32, f32)>,
    /// Extra width lines may take when breaking (Pango units): letter
    /// spacing ends a line measured without a width, but counts when a
    /// width is set.
    slack: i32,
    /// Where lines go in extra width when Pango does not align them (no
    /// width set): 0 left, 0.5 center, 1 right.
    flush: f32,
}

/// The text engine of one engine thread.
pub(crate) struct PangoTextEngine {
    font_map: pango::FontMap,
    /// Contexts with a left-to-right and a right-to-left base direction.
    ltr: pango::Context,
    rtl: pango::Context,
    /// The family of `fontFamily` unset (the desktop's UI font).
    ui_family: Arc<str>,
    fonts: RefCell<FxHashMap<(pango::Font, u32), Arc<FontInfo>>>,
    /// The ascent and descent (Pango units) of each font description's
    /// primary face, by its string.
    line_heights: RefCell<FxHashMap<String, (i32, i32)>>,
}

/// Sets the line height of spans without one to their font's natural
/// height (`natural`: byte range, ascent and descent of the spans' own
/// fonts), around the attachments' placeholders, which keep their own.
///
/// Runs in fallback fonts (CJK, emoji) must not grow the line either: Pango
/// spreads an absolute line height evenly above and below a run, so a face
/// with other proportions would still stick out of the primary font's
/// ascent or descent. Those runs get the line height that brings them
/// inside. Finding them takes a layout pass, skipped for ASCII text (no
/// fallback).
fn natural_line_heights(
    layout: &pango::Layout,
    attrs: &pango::AttrList,
    s: &str,
    natural: &[(u32, u32, i32, i32)],
    placeholders: &[(u32, u32)],
) {
    if natural.is_empty() {
        return;
    }
    // Byte range and line height of each run in a fallback face.
    let mut fallbacks: Vec<(u32, u32, i32)> = Vec::new();
    if !s.is_ascii() {
        let mut iter = layout.iter();
        loop {
            if let Some(run) = iter.run_readonly() {
                let item = run.item();
                let start = item.offset() as u32;
                let end = start + item.length() as u32;
                let on_placeholder = placeholders.iter().any(|&(a, b)| a < end && b > start);
                let span = natural.iter().find(|&&(a, b, _, _)| start >= a && end <= b);
                if let (false, Some(&(_, _, ascent, descent))) = (on_placeholder, span) {
                    let metrics = item.analysis().font().metrics(None);
                    let (a, d) = (metrics.ascent(), metrics.descent());
                    if a > ascent || d > descent {
                        let height = (2 * ascent - a + d).min(2 * descent - d + a).max(1);
                        fallbacks.push((start, end, height));
                    }
                }
            }
            if !iter.next_run() {
                break;
            }
        }
    }
    let insert = |start: u32, end: u32, height: i32| {
        if end > start {
            let mut attr = pango::AttrInt::new_line_height_absolute(height);
            attr.set_start_index(start);
            attr.set_end_index(end);
            attrs.insert(attr);
        }
    };
    for &(start, end, ascent, descent) in natural {
        // Cut around the placeholders and the fallback runs.
        let mut cuts: Vec<(u32, u32)> = placeholders
            .iter()
            .copied()
            .chain(fallbacks.iter().map(|&(a, b, _)| (a, b)))
            .filter(|&(a, b)| a < end && b > start)
            .collect();
        cuts.sort_unstable();
        let mut from = start;
        for (a, b) in cuts.into_iter().chain(std::iter::once((end, end))) {
            insert(from, a.max(from), ascent + descent);
            from = from.max(b);
        }
    }
    for &(start, end, height) in &fallbacks {
        insert(start, end, height);
    }
    // The layout holds this very list (not a copy), so setting it again
    // would compare equal and change nothing: unset it first.
    layout.set_attributes(None);
    layout.set_attributes(Some(attrs));
}

/// Font options both threads use: unhinted metrics, so advances do not
/// depend on the pixel grid.
fn font_options(hint: pangocairo::cairo::HintStyle) -> Option<pangocairo::cairo::FontOptions> {
    let mut options = pangocairo::cairo::FontOptions::new().ok()?;
    options.set_hint_metrics(pangocairo::cairo::HintMetrics::Off);
    options.set_hint_style(hint);
    options.set_antialias(pangocairo::cairo::Antialias::Gray);
    Some(options)
}

fn context(font_map: &pango::FontMap, hint: pangocairo::cairo::HintStyle) -> pango::Context {
    let context = font_map.create_context();
    pangocairo::functions::context_set_font_options(&context, font_options(hint).as_ref());
    context.set_round_glyph_positions(false);
    context
}

impl PangoTextEngine {
    /// Ascent and descent of the font `desc` names (its primary face,
    /// not fallbacks), in Pango units; cached.
    /// The metrics of the font around attachment `a` of `text` (its
    /// placeholder's), which its `verticalAlign` places it against.
    fn attachment_font(
        &self,
        context: &pango::Context,
        text: &AttributedText,
        a: &nsh_core::TextAttachment,
    ) -> nsh_core::FontExtent {
        let style = text
            .span_at(a.index)
            .map_or_else(Default::default, |s| s.style);
        let desc = font_description(&style, &self.ui_family);
        let (ascent, descent) = self.natural_metrics(context, &desc);
        let size = style.font_size.0;
        let x = context
            .load_font(&desc)
            .map_or(size * X_HEIGHT, |f| cap_and_x_height(&f, size).1);
        nsh_core::FontExtent::new(
            Points(from_pango(ascent)),
            Points(from_pango(descent)),
            Points(x),
        )
    }

    fn natural_metrics(
        &self,
        context: &pango::Context,
        desc: &pango::FontDescription,
    ) -> (i32, i32) {
        let key = desc.to_string();
        if let Some(&m) = self.line_heights.borrow().get(&key) {
            return m;
        }
        let metrics = context.metrics(Some(desc), None);
        let m = (metrics.ascent(), metrics.descent());
        self.line_heights.borrow_mut().insert(key, m);
        m
    }

    /// Made on the engine thread; `ui_family` is the family of the system
    /// font ([`ui_family`], read on the main thread).
    pub(crate) fn new(ui_family: Arc<str>) -> Self {
        let font_map = pangocairo::FontMap::new();
        for file in FONT_FILES.lock().unwrap_or_else(|e| e.into_inner()).iter() {
            if let Err(err) = add_font_file(font_map.upcast_ref(), file) {
                log::warn!("cannot add font {}: {err}", file.display());
            }
        }
        let ltr = context(&font_map, pangocairo::cairo::HintStyle::None);
        ltr.set_base_dir(pango::Direction::Ltr);
        let rtl = context(&font_map, pangocairo::cairo::HintStyle::None);
        rtl.set_base_dir(pango::Direction::Rtl);
        PangoTextEngine {
            font_map,
            ltr,
            rtl,
            ui_family,
            fonts: RefCell::default(),
            line_heights: RefCell::default(),
        }
    }

    /// What runs in `font`, asked for at `size` points, are drawn with.
    fn font_info(&self, font: &pango::Font, size: f32) -> Arc<FontInfo> {
        let key = (font.clone(), size.to_bits());
        if let Some(info) = self.fonts.borrow().get(&key) {
            return info.clone();
        }
        let mut desc = font.describe_with_absolute_size();
        // A bitmap font (color emoji) describes its strike's size; it is
        // scaled to the size asked for.
        desc.set_absolute_size(f64::from(size) * f64::from(pango::SCALE));
        let metrics = font.metrics(None);
        let info = Arc::new(FontInfo {
            desc: desc.to_str().as_str().into(),
            size,
            underline: (
                from_pango(metrics.underline_position()),
                from_pango(metrics.underline_thickness()),
            ),
            strikethrough: (
                from_pango(metrics.strikethrough_position()),
                from_pango(metrics.strikethrough_thickness()),
            ),
            cap_x: cap_and_x_height(font, size),
            extents: (from_pango(metrics.ascent()), from_pango(metrics.descent())),
        });
        let mut fonts = self.fonts.borrow_mut();
        // Bounded: animated font sizes make new fonts every frame.
        if fonts.len() >= 256 {
            fonts.clear();
        }
        fonts.insert(key, info.clone());
        info
    }

    /// Sets `p`'s layout up for `width` (`None`: unbounded) and returns
    /// how many of its lines show.
    fn configure(&self, p: &Prepared, width: Option<f32>) -> usize {
        let layout = &p.layout;
        let ellipsize = p.max_lines > 0 && p.ellipsize != pango::EllipsizeMode::None;
        let width = match width {
            // `nowrap` text only gets a width to ellipsize at.
            Some(w) if !p.no_wrap || ellipsize => to_pango(w).max(0) + p.slack,
            _ => -1,
        };
        layout.set_width(width);
        if p.no_wrap || (ellipsize && p.paragraphs.is_none()) {
            // One line per paragraph (`nowrap`), or at most `max_lines`
            // (Pango limits lines per paragraph).
            layout.set_ellipsize(if ellipsize {
                p.ellipsize
            } else {
                pango::EllipsizeMode::None
            });
            layout.set_height(if p.no_wrap { -1 } else { -(p.max_lines as i32) });
        } else {
            if p.joined.replace(false)
                && let Some(text) = &p.paragraphs
            {
                layout.set_text(text);
            }
            layout.set_ellipsize(pango::EllipsizeMode::None);
            layout.set_height(-1);
            if ellipsize
                && layout.line_count() > p.max_lines as i32
                && let Some(text) = &p.paragraphs
            {
                // Several paragraphs: a height limit ellipsizes across
                // them, at the bottom of the last line that shows.
                let mut iter = layout.iter();
                for _ in 1..p.max_lines {
                    iter.next_line();
                }
                let (_, bottom) = iter.line_yrange();
                // Pango only ellipsizes a line whose paragraph goes on: one
                // that ends a paragraph ends with an ellipsis instead of
                // the rest of the text (byte offsets up to it hold).
                if let Some(line) = iter.line_readonly() {
                    let end = (line.start_index() + line.length()).max(0) as usize;
                    if text.get(end..).is_some_and(|rest| separator_len(rest) > 0) {
                        let mut cut = String::with_capacity(end + 3);
                        cut.push_str(&text[..end]);
                        cut.push('\u{2026}');
                        layout.set_text(&cut);
                        p.joined.set(true);
                    }
                }
                layout.set_ellipsize(p.ellipsize);
                layout.set_height(bottom);
            }
        }
        let count = layout.line_count().max(0) as usize;
        match p.max_lines {
            0 => count,
            n => count.min(n as usize),
        }
    }
}

impl TextEngine for PangoTextEngine {
    type Prepared = Prepared;

    fn prepare(&self, text: &AttributedText) -> Prepared {
        self.prepare_aligned(text, &nsh_core::AttachmentAlignments::default())
    }

    fn prepare_aligned(
        &self,
        text: &AttributedText,
        alignments: &nsh_core::AttachmentAlignments,
    ) -> Prepared {
        let s = text.text.as_str();
        let rtl = match text.writing_direction {
            Some(rtl) => rtl,
            None => match pango::find_base_dir(s) {
                pango::Direction::Rtl => true,
                pango::Direction::Ltr => false,
                _ => text.rtl,
            },
        };
        let context = if rtl { &self.rtl } else { &self.ltr };
        let layout = pango::Layout::new(context);
        layout.set_text(s);
        layout.set_wrap(pango::WrapMode::WordChar);
        // Paragraph directions from their content (unless set); lines are
        // aligned in absolute terms below, which Pango only swaps for
        // paragraphs against the base direction.
        layout.set_auto_dir(text.writing_direction.is_none());
        let (alignment, justify) = match text.align {
            // React Native: the right side in right-to-left layouts.
            TextAlign::Auto if text.rtl || rtl => (pango::Alignment::Right, false),
            TextAlign::Auto | TextAlign::Left => (pango::Alignment::Left, false),
            TextAlign::Center => (pango::Alignment::Center, false),
            TextAlign::Right => (pango::Alignment::Right, false),
            TextAlign::Justify if rtl => (pango::Alignment::Right, true),
            TextAlign::Justify => (pango::Alignment::Left, true),
        };
        layout.set_alignment(alignment);
        layout.set_justify(justify);

        let attrs = pango::AttrList::new();
        let mut hyphens = pango::AttrInt::new_insert_hyphens(false);
        hyphens.set_start_index(0);
        hyphens.set_end_index(u32::MAX);
        attrs.insert(hyphens);
        let base = text
            .spans
            .first()
            .map_or_else(ResolvedTextStyle::default, |s| s.style);
        layout.set_font_description(Some(&font_description(&base, &self.ui_family)));
        // The attachments' placeholders (byte ranges): they make their
        // line as tall as they are.
        let mut placeholders = Vec::with_capacity(text.attachments.len());
        let mut at = (0usize, 0u32);
        for a in &text.attachments {
            let start = utf16_to_byte(s, at, a.index);
            at = (start, a.index);
            let end = start + s[start..].chars().next().map_or(0, char::len_utf8);
            placeholders.push((start as u32, end as u32));
        }
        let mut sizes = Vec::with_capacity(text.spans.len());
        // Spans on their font's natural line height: byte range, ascent,
        // descent.
        let mut natural = Vec::new();
        let mut at = (0usize, 0u32);
        for span in &text.spans {
            let start = utf16_to_byte(s, at, span.start);
            let end = utf16_to_byte(s, (start, span.start), span.end);
            at = (end, span.end);
            sizes.push((end as u32, span.style.font_size.0));
            if start >= end {
                continue;
            }
            let (start, end) = (start as u32, end as u32);
            let style = &span.style;
            let insert = |mut attr: pango::Attribute| {
                attr.set_start_index(start);
                attr.set_end_index(end);
                attrs.insert(attr);
            };
            let desc = font_description(style, &self.ui_family);
            insert(pango::AttrFontDesc::new(&desc).into());
            if style.letter_spacing.0 != 0.0 {
                insert(pango::AttrInt::new_letter_spacing(to_pango(style.letter_spacing.0)).into());
            }
            // Lines are as tall as the span's own font
            // ([`natural_line_heights`]): a fallback font (CJK, emoji) must
            // not grow them, or an input grows when the user types Chinese
            // (UIKit keeps the font's line height too).
            if style.line_height.0 > 0.0 {
                insert(
                    pango::AttrInt::new_line_height_absolute(to_pango(style.line_height.0)).into(),
                );
            } else {
                let (ascent, descent) = self.natural_metrics(context, &desc);
                natural.push((start, end, ascent, descent));
            }
            if style.font_variant.0 != 0 {
                let features: Vec<String> = style
                    .font_variant
                    .tags()
                    .map(|t| format!("{t}=1"))
                    .collect();
                insert(pango::AttrFontFeatures::new(&features.join(",")).into());
            }
        }
        let mut attachments = Vec::with_capacity(text.attachments.len());
        let mut attachment_extents = Vec::with_capacity(text.attachments.len());
        let mut at = (0usize, 0u32);
        for a in &text.attachments {
            let start = utf16_to_byte(s, at, a.index);
            at = (start, a.index);
            let end = start + s[start..].chars().next().map_or(0, char::len_utf8);
            // Placed by its `verticalAlign` in its placeholder's font, as
            // the other platforms place them: the ink is the attachment,
            // the logical rectangle what its line reserves.
            let font = if alignments.get(a.index) == nsh_core::VerticalAlign::Baseline {
                nsh_core::FontExtent::default()
            } else {
                self.attachment_font(context, text, a)
            };
            let top = a.ascent(font, alignments.get(a.index));
            let (up, down) = a.extent(font, alignments.get(a.index));
            let ink = pango::Rectangle::new(
                0,
                -to_pango(top.0),
                to_pango(a.width.0),
                to_pango(a.height.0),
            );
            let logical = pango::Rectangle::new(
                0,
                -to_pango(up.0),
                to_pango(a.width.0),
                to_pango((up + down).0),
            );
            let mut shape = pango::AttrShape::new(&ink, &logical);
            shape.set_start_index(start as u32);
            shape.set_end_index(end as u32);
            attrs.insert(shape);
            attachments.push((start as u32, top.0));
            attachment_extents.push((a.index, a.width.0));
        }
        layout.set_attributes(Some(&attrs));
        natural_line_heights(&layout, &attrs, s, &natural, &placeholders);
        let flush = match alignment {
            pango::Alignment::Center => 0.5,
            pango::Alignment::Right => 1.0,
            _ => 0.0,
        };
        Prepared {
            layout,
            utf16: utf16_offsets(s),
            attachments,
            attachment_extents,
            max_lines: text.max_lines,
            ellipsize: match text.ellipsize {
                EllipsizeMode::Head => pango::EllipsizeMode::Start,
                EllipsizeMode::Middle => pango::EllipsizeMode::Middle,
                EllipsizeMode::Tail => pango::EllipsizeMode::End,
                EllipsizeMode::Clip => pango::EllipsizeMode::None,
            },
            no_wrap: text.no_wrap,
            paragraphs: (text.max_lines > 0
                && text.ellipsize != EllipsizeMode::Clip
                && s.contains(['\n', '\r', '\u{2029}']))
            .then(|| s.into()),
            joined: Cell::new(false),
            sizes,
            slack: text
                .spans
                .iter()
                .map(|s| to_pango(s.style.letter_spacing.0.abs()))
                .max()
                .unwrap_or(0),
            flush,
        }
    }

    fn measure(&self, prepared: &Prepared, max_width: Option<Points>) -> Size<Points> {
        let max_width = max_width.map(|m| m.0);
        let shown = self.configure(prepared, max_width);
        let mut iter = prepared.layout.iter();
        let mut width = 0i32;
        let mut bottom = 0i32;
        for n in 0..shown {
            if n > 0 && !iter.next_line() {
                break;
            }
            let (_, logical) = iter.line_extents();
            width = width.max(logical.width());
            bottom = iter.line_yrange().1;
        }
        let mut width = from_pango(width).ceil();
        if let Some(max) = max_width
            && !prepared.no_wrap
        {
            width = width.min(max.max(0.0));
        }
        Size::new(Points(width), Points(from_pango(bottom).ceil()))
    }

    fn layout(&self, prepared: &Prepared, size: Size<Points>) -> TextLayout {
        let shown = self.configure(prepared, Some(size.width.0));
        let layout = &prepared.layout;
        let utf16 = &prepared.utf16;
        let at = |byte: i32| utf16[(byte.max(0) as usize).min(utf16.len() - 1)];
        let base_size = from_pango(layout.font_description().map_or(0, |d| d.size()));
        // Lines Pango did not align in the box (no width) move as a block;
        // lines it aligned in the box with the slack move back.
        let dx = if layout.width() < 0 {
            let (_, logical) = layout.extents();
            (size.width.0 - from_pango(logical.width())).max(0.0) * prepared.flush
        } else {
            (Points(-from_pango(prepared.slack) * prepared.flush)).0
        };
        let mut out = LinuxLayout {
            attachments: vec![None; prepared.attachments.len()],
            attachment_extents: prepared.attachment_extents.clone(),
            ..LinuxLayout::default()
        };
        let mut iter = layout.iter();
        for n in 0..shown {
            if n > 0 && !iter.next_line() {
                break;
            }
            let Some(line) = iter.line_readonly() else {
                break;
            };
            let (_, logical) = iter.line_extents();
            let (top, bottom) = iter.line_yrange();
            let baseline = from_pango(iter.baseline());
            let first = out.runs.len();
            let mut x = from_pango(logical.x()) + dx;
            // Cap and x height of the line's largest font.
            let mut em = 0.0f32;
            let mut cap_x = None;
            for run in line.runs() {
                let item = run.item();
                let glyphs = run.glyph_string();
                let width = from_pango(glyphs.width());
                let offset = item.offset();
                let infos = glyphs.glyph_info();
                if infos.len() == 1
                    && infos[0].glyph() == GLYPH_EMPTY
                    && let Some(i) = prepared
                        .attachments
                        .iter()
                        .position(|&(b, _)| b as i32 == offset)
                {
                    out.attachments[i] = Some((x, baseline - prepared.attachments[i].1));
                    x += width;
                    continue;
                }
                let size = prepared
                    .sizes
                    .get(
                        prepared
                            .sizes
                            .partition_point(|&(end, _)| end as i32 <= offset),
                    )
                    .or(prepared.sizes.last())
                    .map_or(base_size, |&(_, size)| size);
                let font = self.font_info(&item.analysis().font(), size);
                let rtl = item.analysis().level() % 2 == 1;
                let ellipsis = item.analysis().flags() & ANALYSIS_FLAG_IS_ELLIPSIS != 0;
                if font.size > em {
                    em = font.size;
                    cap_x = Some(font.cap_x);
                }
                let clusters = glyphs.log_clusters();
                let glyphs = infos
                    .iter()
                    .zip(clusters)
                    .map(|(g, &cluster)| {
                        let geometry = g.geometry();
                        // SAFETY: `as_ptr` points at the `PangoGlyphInfo`
                        // this borrowed `GlyphInfo` wraps; only read here.
                        let attr = unsafe { (*g.as_ptr()).attr.is_cluster_start } & VIS_ATTRS;
                        Glyph {
                            id: g.glyph(),
                            width: geometry.width(),
                            x_offset: geometry.x_offset(),
                            y_offset: geometry.y_offset(),
                            attr,
                            index: at(offset + cluster),
                        }
                    })
                    .collect::<Vec<_>>();
                match out.runs[first..].last_mut() {
                    // Pango splits CJK text into a run per character.
                    Some(last)
                        if Arc::ptr_eq(&last.font, &font)
                            && last.end == x
                            && last.baseline == baseline
                            && last.rtl == rtl
                            && last.ellipsis == ellipsis =>
                    {
                        last.glyphs.extend(glyphs);
                        last.end = x + width;
                    }
                    _ => out.runs.push(Run {
                        font,
                        x,
                        end: x + width,
                        baseline,
                        rtl,
                        glyphs,
                        ellipsis,
                    }),
                }
                x += width;
            }
            let start = line.start_index();
            let (top, bottom) = (from_pango(top), from_pango(bottom));
            let (cap_height, x_height) =
                cap_x.unwrap_or((base_size * CAP_HEIGHT, base_size * X_HEIGHT));
            out.lines.push(Line {
                info: TextLine {
                    text: String::new(),
                    start: at(start),
                    end: at(start + line.length()),
                    x: Points(from_pango(logical.x()) + dx),
                    y: Points(top),
                    width: Points(from_pango(logical.width())),
                    height: Points(bottom - top),
                    ascender: Points(baseline - from_pango(logical.y())),
                    descender: Points(from_pango(logical.y() + logical.height()) - baseline),
                    cap_height: Points(cap_height),
                    x_height: Points(x_height),
                },
                runs: first..out.runs.len(),
            });
        }
        TextLayout(Arc::new(out))
    }

    fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
        layout.downcast::<LinuxLayout>().map_or_else(Vec::new, |l| {
            l.lines.iter().map(|l| l.info.clone()).collect()
        })
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<nsh_core::Point<Points>>> {
        layout.downcast::<LinuxLayout>().map_or_else(Vec::new, |l| {
            l.attachments
                .iter()
                .map(|a| a.map(|(x, y)| nsh_core::geometry::point(Points(x), Points(y))))
                .collect()
        })
    }

    fn hit_test(
        &self,
        layout: &TextLayout,
        point: nsh_core::geometry::Point<Points>,
    ) -> TextPosition {
        layout
            .downcast::<LinuxLayout>()
            .map_or_else(TextPosition::default, |l| l.hit_test(point.x.0, point.y.0))
    }

    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        layout.downcast::<LinuxLayout>()?.caret_rect(position)
    }

    fn range_rects(
        &self,
        layout: &TextLayout,
        range: std::ops::Range<u32>,
        out: &mut Vec<Bounds<Points>>,
    ) {
        if let Some(l) = layout.downcast::<LinuxLayout>() {
            l.range_rects(range, out);
        }
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
        let path = font_file(data).map_err(|e| format!("cannot store font: {e}"))?;
        let mut files = FONT_FILES.lock().unwrap_or_else(|e| e.into_inner());
        if !files.contains(&path) {
            files.push(path.clone());
        }
        drop(files);
        add_font_file(self.font_map.upcast_ref(), &path)
            .map_err(|e| format!("font rejected: {e}"))?;
        // Fonts resolve differently now (a family may have been missing).
        self.ltr.changed();
        self.rtl.changed();
        self.fonts.borrow_mut().clear();
        Ok(())
    }
}

mod fontconfig {
    //! Fontconfig and PangoFc functions the bindings lack: an app font for
    //! a Fontconfig font map without `pango_font_map_add_font_file`, which
    //! only Pango 1.56 has (Ubuntu 24.04 ships 1.52).

    use std::ffi::{c_char, c_int, c_void};

    #[link(name = "fontconfig")]
    unsafe extern "C" {
        pub(super) fn FcConfigAppFontAddFile(config: *mut c_void, file: *const c_char) -> c_int;
    }

    #[link(name = "pangoft2-1.0")]
    unsafe extern "C" {
        pub(super) fn pango_fc_font_map_get_type() -> usize;
        pub(super) fn pango_fc_font_map_get_config(map: *mut c_void) -> *mut c_void;
        pub(super) fn pango_fc_font_map_config_changed(map: *mut c_void);
    }
}

/// Adds the font in `file` to `map` (a Fontconfig font map, as Pango's on
/// Linux are): to the map's Fontconfig configuration, which the
/// process's other font maps share, then drops the map's cached fonts.
fn add_font_file(map: &pango::FontMap, file: &std::path::Path) -> Result<(), String> {
    use std::os::unix::ffi::OsStrExt;

    use gtk::glib::translate::ToGlibPtr;
    let path = std::ffi::CString::new(file.as_os_str().as_bytes())
        .map_err(|_| "the font's path has a NUL byte".to_owned())?;
    let ptr: *mut pango::ffi::PangoFontMap = map.to_glib_none().0;
    // SAFETY: a GType query with no arguments.
    let fc_type = unsafe { fontconfig::pango_fc_font_map_get_type() };
    // SAFETY: `ptr` is a live GObject instance (the borrowed `map`).
    let is_fc = unsafe {
        gtk::glib::gobject_ffi::g_type_check_instance_is_a(ptr.cast(), fc_type as _) != 0
    };
    if !is_fc {
        return Err("the font map does not use Fontconfig".to_owned());
    }
    // SAFETY: `ptr` is a PangoFcFontMap (checked above); a null config is
    // Fontconfig's current one, which the map then uses.
    let added = unsafe {
        let config = fontconfig::pango_fc_font_map_get_config(ptr.cast());
        fontconfig::FcConfigAppFontAddFile(config, path.as_ptr())
    };
    if added == 0 {
        return Err("Fontconfig could not read it".to_owned());
    }
    // SAFETY: as above; this only invalidates the map's caches.
    unsafe { fontconfig::pango_fc_font_map_config_changed(ptr.cast()) };
    Ok(())
}

/// Writes font data to `<user cache>/nsh/fonts/<hash>.ttf` (once).
fn font_file(data: &[u8]) -> std::io::Result<PathBuf> {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::hash::DefaultHasher::new();
    data.hash(&mut hasher);
    let dir = gtk::glib::user_cache_dir().join("nsh").join("fonts");
    let path = dir.join(format!("{:016x}.ttf", hasher.finish()));
    if !path.exists() {
        std::fs::create_dir_all(&dir)?;
        let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
        std::fs::write(&tmp, data)?;
        std::fs::rename(&tmp, &path)?;
    }
    Ok(path)
}

/// Fonts of the main thread, loaded from GTK's font map.
struct MainFonts {
    context: pango::Context,
    fonts: FxHashMap<Arc<str>, Option<pango::Font>>,
    /// How many of [`FONT_FILES`] were added to the font map.
    files: usize,
}

thread_local! {
    static MAIN_FONTS: RefCell<Option<MainFonts>> = const { RefCell::new(None) };
}

/// The main thread's font for a description the engine laid text out with.
fn main_font(desc: &Arc<str>) -> Option<pango::Font> {
    MAIN_FONTS.with_borrow_mut(|fonts| {
        let fonts = fonts.get_or_insert_with(|| MainFonts {
            context: context(
                &pangocairo::FontMap::default(),
                pangocairo::cairo::HintStyle::Slight,
            ),
            fonts: FxHashMap::default(),
            files: 0,
        });
        if let Some(font) = fonts.fonts.get(desc) {
            return font.clone();
        }
        let files = FONT_FILES.lock().unwrap_or_else(|e| e.into_inner());
        if files.len() > fonts.files
            && let Some(map) = fonts.context.font_map()
        {
            for file in &files[fonts.files..] {
                if let Err(err) = add_font_file(&map, file) {
                    log::warn!("cannot add font {}: {err}", file.display());
                }
            }
            fonts.files = files.len();
            fonts.context.changed();
        }
        drop(files);
        let font = fonts.context.font_map().and_then(|map| {
            map.load_font(&fonts.context, &pango::FontDescription::from_string(desc))
        });
        if font.is_none() {
            log::warn!("cannot load font {desc}");
        }
        if fonts.fonts.len() >= 256 {
            fonts.fonts.clear();
        }
        fonts.fonts.insert(desc.clone(), font.clone());
        font
    })
}

/// The text a view draws.
pub(crate) struct DrawnText {
    /// The content.
    pub(crate) text: Arc<AttributedText>,
    /// Where the layout goes in the view.
    pub(crate) content: Bounds<Points>,
    /// The engine's layout of it.
    pub(crate) layout: TextLayout,
    /// The render node, built on first draw.
    node: OnceCell<Option<gsk::RenderNode>>,
    /// Selection geometry reused across redraws, including selectable views.
    selection_rects: RefCell<Vec<Bounds<Points>>>,
    /// The selection of `selectable` text, kept across new content.
    selection: Option<Rc<Selection>>,
}

/// A text view's new content.
pub(crate) fn set(
    view: &NshView,
    text: &Arc<AttributedText>,
    layout: &TextLayout,
    content: Bounds<Points>,
) {
    let old = view.state_mut().text.take();
    let was = old.as_ref().is_some_and(|o| o.text.is_selectable());
    let mut selection = None;
    match old.and_then(|o| o.selection.map(|s| (s, o.text))) {
        Some((s, old)) if text.is_selectable() => {
            // Offsets into other text mean nothing.
            if old.text != text.text {
                s.range.set(None);
            }
            selection = Some(s);
        }
        Some((s, _)) => s.uninstall(view),
        None if text.is_selectable() => selection = Some(Selection::install(view)),
        None => {}
    }
    view.state_mut().text = Some(DrawnText {
        text: text.clone(),
        content,
        layout: layout.clone(),
        node: OnceCell::new(),
        selection_rects: RefCell::new(Vec::new()),
        selection,
    });
    if was != text.is_selectable() {
        // The I-beam.
        crate::input::style_changed(view);
    }
    view.changed();
}

/// The view draws `selectable` text: mouse drags over it select rather
/// than scroll, and its pointer is the I-beam.
pub(crate) fn selectable(state: &ViewState) -> bool {
    state.text.as_ref().is_some_and(|t| t.text.is_selectable())
}

/// Draws a text view's text.
pub(crate) fn draw(snapshot: &gtk::Snapshot, state: &ViewState) {
    let Some(drawn) = &state.text else { return };
    if drawn.text.has_backgrounds()
        && let Some(layout) = drawn.layout.downcast::<LinuxLayout>()
    {
        let (cx, cy) = (drawn.content.origin.x.0, drawn.content.origin.y.0);
        layout.background_rects(&drawn.text, |x, y, w, h, r, color| {
            let rect = graphene::Rect::new(cx + x, cy + y, w, h);
            snapshot.push_rounded_clip(&gsk::RoundedRect::from_rect(rect, r));
            snapshot.append_color(&crate::decor::rgba(color), &rect);
            snapshot.pop();
        });
    }
    // A selectable text's own selection, or its part of its area's.
    let range = drawn
        .selection
        .as_ref()
        .and_then(|s| s.range.get())
        .or(state.area_selection);
    if let Some(range) = range
        && let Some(layout) = drawn.layout.downcast::<LinuxLayout>()
    {
        // iOS tints the selection with the view's tint at about 30%.
        let color = crate::decor::rgba(drawn.text.selection_color.unwrap_or(SYSTEM_BLUE));
        let color = gtk::gdk::RGBA::new(
            color.red(),
            color.green(),
            color.blue(),
            color.alpha() * 0.3,
        );
        let (cx, cy) = (drawn.content.origin.x.0, drawn.content.origin.y.0);
        let mut rects = drawn.selection_rects.borrow_mut();
        rects.clear();
        layout.range_rects(range.0..range.1, &mut rects);
        for r in rects.iter() {
            let (x, y) = (cx + r.origin.x.0, cy + r.origin.y.0);
            snapshot.append_color(
                &color,
                &graphene::Rect::new(x, y, r.size.width.0, r.size.height.0),
            );
        }
    }
    let node = drawn.node.get_or_init(|| {
        let layout = drawn.layout.downcast::<LinuxLayout>()?;
        build(&drawn.text, layout, drawn.content)
    });
    let Some(node) = node else { return };
    // An animated color (`AnimationProp::Color`) recolors the cached
    // glyphs, keeping their coverage, rather than building them again on
    // every frame.
    match state.anim.color {
        Some(c) => {
            let c = crate::decor::rgba(c);
            snapshot.push_color_matrix(
                &graphene::Matrix::from_float([
                    0.0,
                    0.0,
                    0.0,
                    0.0, //
                    0.0,
                    0.0,
                    0.0,
                    0.0, //
                    0.0,
                    0.0,
                    0.0,
                    0.0, //
                    0.0,
                    0.0,
                    0.0,
                    c.alpha(),
                ]),
                &graphene::Vec4::new(c.red(), c.green(), c.blue(), 0.0),
            );
            snapshot.append_node(node);
            snapshot.pop();
        }
        None => snapshot.append_node(node),
    }
}

/// The render node of a laid out text: glyph runs split where the color
/// or decoration changes, decorations, the shadow.
fn build(
    text: &AttributedText,
    layout: &LinuxLayout,
    content: Bounds<Points>,
) -> Option<gsk::RenderNode> {
    if layout.runs.is_empty() {
        return None;
    }
    let snapshot = gtk::Snapshot::new();
    if let Some(shadow) = text.shadow {
        snapshot.push_shadow(&[gsk::Shadow::new(
            crate::decor::rgba(shadow.color),
            shadow.offset_x.0,
            shadow.offset_y.0,
            shadow.radius.0,
        )]);
    }
    let default = ResolvedTextStyle::default();
    for run in &layout.runs {
        let Some(font) = main_font(&run.font.desc) else {
            continue;
        };
        let baseline = content.origin.y.0 + run.baseline;
        let mut x = content.origin.x.0 + run.x;
        let mut i = 0;
        while i < run.glyphs.len() {
            let span = span_at(&text.spans, run.glyphs[i].index);
            let mut j = i + 1;
            while j < run.glyphs.len() && span_at(&text.spans, run.glyphs[j].index) == span {
                j += 1;
            }
            let glyphs = &run.glyphs[i..j];
            let style = text.spans.get(span).map_or(&default, |s| &s.style);
            let mut string = pango::GlyphString::new();
            string.set_size(glyphs.len() as i32);
            let mut width = 0;
            for (info, g) in string.glyph_info_mut().iter_mut().zip(glyphs) {
                info.set_glyph(g.id);
                let geometry = info.geometry_mut();
                geometry.set_width(g.width);
                geometry.set_x_offset(g.x_offset);
                geometry.set_y_offset(g.y_offset);
                // SAFETY: `as_ptr` points at the `PangoGlyphInfo` this
                // exclusively borrowed `GlyphInfo` wraps.
                unsafe { (*info.as_ptr()).attr.is_cluster_start = g.attr };
                width += g.width;
            }
            let width = from_pango(width);
            if let Some(node) = gsk::TextNode::new(
                &font,
                &string,
                &crate::decor::rgba(style.color),
                &graphene::Point::new(x, baseline),
            ) {
                snapshot.append_node(node);
            }
            decorate(&snapshot, style, &run.font, x, width, baseline);
            x += width;
            i = j;
        }
    }
    if text.shadow.is_some() {
        snapshot.pop();
    }
    snapshot.to_node()
}

/// One device pixel in points on the monitor with the fewest pixels per
/// point: decorations at least this thick (and this far apart) stay
/// legible wherever the text shows. Text nodes are built once and shared
/// by every scale, so this cannot be the window's own.
fn device_pixel() -> f32 {
    let Some(display) = gtk::gdk::Display::default() else {
        return 1.0;
    };
    let monitors = display.monitors();
    let scale = (0..monitors.n_items())
        .filter_map(|i| monitors.item(i).and_downcast::<gtk::gdk::Monitor>())
        .map(|m| m.scale())
        .filter(|s| *s > 0.0)
        .fold(f64::INFINITY, f64::min);
    if scale.is_finite() {
        (1.0 / scale) as f32
    } else {
        1.0
    }
}

/// Draws the underline / strikethrough of `width` points of text at
/// `(x, baseline)`.
///
/// Thicknesses, gaps and offsets are whole device pixels (at least one):
/// a font's sub-pixel underline would otherwise blur the two lines of
/// `double` into one, and dots and waves into a smudge.
fn decorate(
    snapshot: &gtk::Snapshot,
    style: &ResolvedTextStyle,
    font: &FontInfo,
    x: f32,
    width: f32,
    baseline: f32,
) {
    let d = style.decoration;
    if !d.underline && !d.line_through || width <= 0.0 {
        return;
    }
    let px = device_pixel();
    let pixels = |v: f32| (v / px).round().max(1.0) * px;
    let color = crate::decor::rgba(style.decoration_color.unwrap_or(style.color));
    let line = |top: f32, thickness: f32| {
        let thickness = pixels(style.decoration_thickness.map_or(thickness, |t| t.0));
        let top = (top / px).round() * px;
        let mid = top + thickness / 2.0;
        match style.decoration_style {
            DecorationStyle::Solid => {
                snapshot.append_color(&color, &graphene::Rect::new(x, top, width, thickness));
            }
            DecorationStyle::Double => {
                // Two lines of the thickness, as far apart (as CSS),
                // centered where the single line goes: below it, the
                // second line of small text would fall out of its box.
                for y in [top - thickness, top + thickness] {
                    snapshot.append_color(&color, &graphene::Rect::new(x, y, width, thickness));
                }
            }
            DecorationStyle::Dotted | DecorationStyle::Dashed | DecorationStyle::Wavy => {
                let path = gsk::PathBuilder::new();
                path.move_to(x, mid);
                let stroke = gsk::Stroke::new(thickness);
                if style.decoration_style == DecorationStyle::Wavy {
                    let amplitude = pixels((thickness * 1.5).max(2.0 * px));
                    let step = amplitude * 2.0;
                    let mut cx = x;
                    let mut up = true;
                    while cx < x + width {
                        let nx = (cx + step).min(x + width);
                        let peak = if up { mid - amplitude } else { mid + amplitude };
                        path.quad_to((cx + nx) / 2.0, peak, nx, mid);
                        cx = nx;
                        up = !up;
                    }
                } else {
                    path.line_to(x + width, mid);
                    let dash = if style.decoration_style == DecorationStyle::Dashed {
                        [thickness * 3.0, thickness * 2.0]
                    } else if thickness >= 3.0 * px {
                        // Round dots, a dot apart.
                        stroke.set_line_cap(gsk::LineCap::Round);
                        [0.0, thickness * 2.0]
                    } else {
                        // Thin dots stay square: round ones would only
                        // be antialiasing.
                        [thickness, thickness]
                    };
                    stroke.set_dash(&dash);
                }
                snapshot.append_stroke(&path.to_path(), &stroke, &color);
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

/// The first rectangle (view coordinates: x, y, width, height) the
/// characters `start..end` of the text view with `state` cover (the test
/// agent's spans).
#[cfg(feature = "dev")]
pub(crate) fn range_rect(state: &ViewState, start: u32, end: u32) -> Option<(f32, f32, f32, f32)> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<LinuxLayout>()?;
    let (cx, cy) = (drawn.content.origin.x.0, drawn.content.origin.y.0);
    let mut rects = Vec::new();
    layout.range_rects(start..end, &mut rects);
    rects.first().map(|r| {
        (
            cx + r.origin.x.0,
            cy + r.origin.y.0,
            r.size.width.0,
            r.size.height.0,
        )
    })
}

/// The UTF-16 offset of the character at `(x, y)` (view coordinates), for
/// presses on nested text links.
pub(crate) fn char_at(state: &ViewState, x: f32, y: f32) -> Option<u32> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<LinuxLayout>()?;
    let (x, y) = (x - drawn.content.origin.x.0, y - drawn.content.origin.y.0);
    let line = layout
        .lines
        .iter()
        .find(|l| y >= l.info.y.0 && y < (l.info.y + l.info.height).0)?;
    for run in &layout.runs[line.runs.clone()] {
        let mut gx = run.x;
        for g in &run.glyphs {
            let w = from_pango(g.width);
            if x >= gx && x < gx + w {
                return Some(g.index);
            }
            gx += w;
        }
    }
    None
}

// --- Selection ----------------------------------------------------------------------

/// How far (points) the mouse moves on selectable text before a drag
/// selects: past input's press slop where the press would fire (a link, an
/// `onPress`), so a click never does both.
pub(crate) const SELECT_SLOP: f32 = 3.0;
/// The same over a press target.
pub(crate) const SELECT_SLOP_PRESS: f32 = 10.0;

/// What a drag extends the selection by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Unit {
    Char,
    Word,
    Paragraph,
}

/// The range selection of a `selectable` text view, desktop style: a mouse
/// drag selects characters, a double click words and a triple click the
/// paragraph (and drags on by them), Shift+click extends, Ctrl+C copies,
/// Ctrl+A selects all, Escape or a press anywhere else clears. Offsets are
/// UTF-16, as the layout's glyph clusters.
///
/// The view takes keyboard focus only while it has a selection (views are
/// not focusable otherwise, so they never take Tab focus).
pub(crate) struct Selection {
    /// The selected range (`start < end`).
    range: Cell<Option<(u32, u32)>>,
    /// The range a drag started from (a caret, the word or paragraph
    /// pressed), which stays selected while it extends.
    anchor: Cell<(u32, u32)>,
    unit: Cell<Unit>,
    /// The pressed button moved far enough to select.
    dragging: Cell<bool>,
    /// The press began over a press target (links, `onPress`).
    over_press: Cell<bool>,
    /// The view's controllers (click, drag, keys, focus).
    controllers: [gtk::EventController; 4],
    /// While there is a selection: the window's controller that clears it
    /// on presses elsewhere.
    outside: RefCell<Option<(gtk::Widget, gtk::EventController)>>,
}

impl Selection {
    /// Gives `view` its selection controllers.
    fn install(view: &NshView) -> Rc<Selection> {
        let click = gtk::GestureClick::new();
        click.set_button(gtk::gdk::BUTTON_PRIMARY);
        let drag = gtk::GestureDrag::new();
        drag.set_button(gtk::gdk::BUTTON_PRIMARY);
        let keys = gtk::EventControllerKey::new();
        let focus = gtk::EventControllerFocus::new();
        let selection = Rc::new(Selection {
            range: Cell::new(None),
            anchor: Cell::new((0, 0)),
            unit: Cell::new(Unit::Char),
            dragging: Cell::new(false),
            over_press: Cell::new(false),
            controllers: [
                click.clone().upcast(),
                drag.clone().upcast(),
                keys.clone().upcast(),
                focus.clone().upcast(),
            ],
            outside: RefCell::new(None),
        });
        let weak = view.downgrade();
        click.connect_pressed(move |g, n, x, y| {
            if let Some(view) = weak.upgrade()
                && !from_touch(g.upcast_ref())
            {
                pressed(&view, n, x as f32, y as f32, g.current_event_state());
            }
        });
        let weak = view.downgrade();
        drag.connect_drag_update(move |g, dx, dy| {
            let (Some(view), Some((x, y))) = (weak.upgrade(), g.start_point()) else {
                return;
            };
            if !from_touch(g.upcast_ref()) {
                dragged(
                    &view,
                    dx as f32,
                    dy as f32,
                    (x + dx) as f32,
                    (y + dy) as f32,
                );
            }
        });
        let weak = view.downgrade();
        drag.connect_drag_end(move |_, _, _| {
            if let Some(view) = weak.upgrade()
                && let Some(s) = view_selection(&view)
                && s.dragging.replace(false)
            {
                // X11 / Wayland: what is selected is the primary selection.
                if let Some(text) = selected_text(&view) {
                    view.primary_clipboard().set_text(&text);
                }
            }
        });
        let weak = view.downgrade();
        keys.connect_key_pressed(move |_, key, _, modifiers| {
            let Some(view) = weak.upgrade() else {
                return glib::Propagation::Proceed;
            };
            use gtk::gdk::{Key, ModifierType};
            let ctrl = modifiers.contains(ModifierType::CONTROL_MASK);
            match key {
                Key::c | Key::C | Key::Insert if ctrl => copy(&view),
                Key::a | Key::A if ctrl => {
                    let len = view.state().text.as_ref().map_or(0, |t| t.text.len_utf16());
                    select(&view, Some((0, len)));
                }
                // Without a selection Escape goes on (to going back).
                Key::Escape if view_selection(&view).is_some_and(|s| s.range.get().is_some()) => {
                    select(&view, None)
                }
                _ => return glib::Propagation::Proceed,
            }
            glib::Propagation::Stop
        });
        let weak = view.downgrade();
        focus.connect_leave(move |_| {
            // The window going to the background keeps its focus widget,
            // and so the selection.
            if let Some(view) = weak.upgrade()
                && view.root().and_then(|r| r.focus()).as_ref() != Some(view.upcast_ref())
            {
                select(&view, None);
            }
        });
        for c in &selection.controllers {
            view.add_controller(c.clone());
        }
        selection
    }

    /// Takes the controllers off `view` (its text is no longer
    /// selectable).
    fn uninstall(&self, view: &NshView) {
        self.range.set(None);
        self.watch_outside(view, false);
        for c in &self.controllers {
            view.remove_controller(c);
        }
        view.set_focusable(false);
    }

    /// Starts or stops clearing the selection on presses outside `view`.
    fn watch_outside(&self, view: &NshView, on: bool) {
        if let Some((root, controller)) = self.outside.take() {
            root.remove_controller(&controller);
        }
        if !on {
            return;
        }
        let Some(root) = view.root().map(|r| r.upcast::<gtk::Widget>()) else {
            return;
        };
        let legacy = gtk::EventControllerLegacy::new();
        legacy.set_propagation_phase(gtk::PropagationPhase::Capture);
        let weak = view.downgrade();
        legacy.connect_event(move |c, event| {
            if event.event_type() != gtk::gdk::EventType::ButtonPress
                && event.event_type() != gtk::gdk::EventType::TouchBegin
            {
                return glib::Propagation::Proceed;
            }
            let Some(view) = weak.upgrade() else {
                return glib::Propagation::Proceed;
            };
            let root = c.widget();
            let inside = root
                .as_ref()
                .and_then(|root| {
                    let (x, y) = event.position()?;
                    let (sx, sy) = root.native()?.surface_transform();
                    root.pick(x - sx, y - sy, gtk::PickFlags::DEFAULT)
                })
                .is_some_and(|w| w == *view.upcast_ref::<gtk::Widget>() || w.is_ancestor(&view));
            if !inside {
                // Later: the controller is not removed while it runs.
                glib::idle_add_local_once(move || select(&view, None));
            }
            glib::Propagation::Proceed
        });
        root.add_controller(legacy.clone());
        self.outside.replace(Some((root, legacy.upcast())));
    }
}

/// The selection of `view`'s text, if it is selectable.
fn view_selection(view: &NshView) -> Option<Rc<Selection>> {
    view.state().text.as_ref()?.selection.clone()
}

/// The event a gesture handles comes from a touchscreen, which scrolls
/// rather than selects.
fn from_touch(c: &gtk::EventController) -> bool {
    c.current_event_device()
        .is_some_and(|d| d.source() == gtk::gdk::InputSource::Touchscreen)
        || c.current_event().is_some_and(|e| e.is_pointer_emulated())
}

/// Sets `view`'s selection (`None` or empty clears it), taking keyboard
/// focus while it has one.
fn select(view: &NshView, range: Option<(u32, u32)>) {
    let Some(s) = view_selection(view) else {
        return;
    };
    let range = range.filter(|(a, b)| a < b);
    if s.range.replace(range) == range {
        return;
    }
    view.queue_draw();
    match range {
        Some(_) => {
            if !view.has_focus() {
                view.set_focusable(true);
                view.grab_focus();
            }
            if s.outside.borrow().is_none() {
                s.watch_outside(view, true);
            }
        }
        None => {
            s.watch_outside(view, false);
            view.set_focusable(false);
        }
    }
}

/// A press of the primary button (`n`: the click count).
fn pressed(view: &NshView, n: i32, x: f32, y: f32, modifiers: gtk::gdk::ModifierType) {
    // In a selectable view the area selects (`selectable_view.rs`).
    let Some(s) = view_selection(view).filter(|_| crate::selectable_view::area_of(view).is_none())
    else {
        return;
    };
    let (caret, char_index, text, over_press) = {
        let state = view.state();
        let Some(drawn) = &state.text else { return };
        let Some(layout) = drawn.layout.downcast::<LinuxLayout>() else {
            return;
        };
        let (lx, ly) = (x - drawn.content.origin.x.0, y - drawn.content.origin.y.0);
        let char_index = char_at(&state, x, y);
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
    match n {
        1 if modifiers.contains(gtk::gdk::ModifierType::SHIFT_MASK) => {
            // Extends from the end away from the press.
            let anchor = match s.range.get() {
                Some((a, b)) if caret <= a => (b, b),
                Some((a, _)) => (a, a),
                None => (caret, caret),
            };
            s.anchor.set(anchor);
            s.unit.set(Unit::Char);
            s.dragging.set(true);
            select(view, Some(extend(&text.text, anchor, caret, Unit::Char)));
        }
        1 => {
            s.anchor.set((caret, caret));
            s.unit.set(Unit::Char);
            s.dragging.set(false);
            select(view, None);
        }
        n => {
            let unit = if n == 2 { Unit::Word } else { Unit::Paragraph };
            let range = unit_at(&text.text, at, unit);
            s.anchor.set(range);
            s.unit.set(unit);
            s.dragging.set(true);
            select(view, Some(range));
        }
    }
}

/// The pressed mouse moved by `(dx, dy)` to `(x, y)` (view coordinates).
fn dragged(view: &NshView, dx: f32, dy: f32, x: f32, y: f32) {
    let Some(s) = view_selection(view).filter(|_| crate::selectable_view::area_of(view).is_none())
    else {
        return;
    };
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
        let Some(layout) = drawn.layout.downcast::<LinuxLayout>() else {
            return;
        };
        let caret = layout
            .hit_test(x - drawn.content.origin.x.0, y - drawn.content.origin.y.0)
            .offset;
        extend(&drawn.text.text, s.anchor.get(), caret, s.unit.get())
    };
    select(view, Some(range));
}

/// Copies the selection to the clipboard.
fn copy(view: &NshView) {
    if let Some(text) = selected_text(view) {
        view.clipboard().set_text(&text);
    }
}

/// The selected text, without attachments' placeholders.
fn selected_text(view: &NshView) -> Option<String> {
    let (a, b) = view_selection(view)?.range.get()?;
    let state = view.state();
    let s = state.text.as_ref()?.text.text.as_str();
    let start = utf16_to_byte(s, (0, 0), a);
    let end = utf16_to_byte(s, (start, a), b);
    Some(s[start..end].replace(ATTACHMENT_CHAR, ""))
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

impl LinuxLayout {
    /// Fills `out` with the clusters of `line` in visual order (left to
    /// right), their `end`s not yet set (see [`Self::set_ends`]).
    fn line_clusters(&self, line: &Line, out: &mut Vec<Cluster>) {
        out.clear();
        let Some(runs) = self.runs.get(line.runs.clone()) else {
            return;
        };
        for run in runs {
            let mut gx = run.x;
            for g in &run.glyphs {
                let w = from_pango(g.width);
                match out.last_mut() {
                    // Glyphs of one cluster (a ligature, a base and its
                    // marks) are one stop for the caret.
                    Some(c)
                        if c.start == g.index && c.rtl == run.rtl && c.ellipsis == run.ellipsis =>
                    {
                        c.x1 = gx + w;
                    }
                    _ => out.push(Cluster {
                        x0: gx,
                        x1: gx + w,
                        start: g.index,
                        end: g.index,
                        rtl: run.rtl,
                        ellipsis: run.ellipsis,
                    }),
                }
                gx += w;
            }
        }
        // Attachments have no glyph: they stand where their placeholder
        // was laid out, in the direction of the text next to them.
        for (&(index, width), at) in self.attachment_extents.iter().zip(&self.attachments) {
            let Some((x, _)) = *at else { continue };
            if index < line.info.start || index >= line.info.end {
                continue;
            }
            let at = out.partition_point(|c| c.x0 < x);
            let rtl = at
                .checked_sub(1)
                .and_then(|i| out.get(i))
                .or(out.get(at))
                .is_some_and(|c| c.rtl);
            out.insert(
                at,
                Cluster {
                    x0: x,
                    x1: x + width,
                    start: index,
                    end: index,
                    rtl,
                    ellipsis: false,
                },
            );
        }
    }

    /// Sets the end of each of `clusters` (those of `line`): where the next
    /// cluster in the text starts, the line's end for the last.
    fn set_ends(line: &Line, clusters: &mut [Cluster]) {
        let mut starts: Vec<u32> = clusters.iter().map(|c| c.start).collect();
        starts.sort_unstable();
        starts.dedup();
        for c in clusters {
            let next = starts.get(starts.partition_point(|&s| s <= c.start));
            c.end = next.copied().unwrap_or(line.info.end).max(c.start);
        }
    }

    /// The caret position nearest `(x, y)` in content coordinates: on the
    /// line at that height (the first above the text, the last below it), at
    /// the cluster edge nearest x. The end of a wrapped line is
    /// [`Affinity::Upstream`], which keeps the caret on that line rather
    /// than at the start of the next.
    pub(crate) fn hit_test(&self, x: f32, y: f32) -> TextPosition {
        let Some(i) = self
            .lines
            .iter()
            .position(|l| y < (l.info.y + l.info.height).0)
            .or(self.lines.len().checked_sub(1))
        else {
            return TextPosition::default();
        };
        let Some(line) = self.lines.get(i) else {
            return TextPosition::default();
        };
        let mut clusters = Vec::new();
        self.line_clusters(line, &mut clusters);
        Self::set_ends(line, &mut clusters);
        // Distance and offset of the nearest edge; a tie goes to the later
        // edge, so that where a wrapped line's trailing space has no width
        // the caret lands after it.
        let mut best: Option<(f32, u32)> = None;
        for c in &clusters {
            for (edge, offset) in [(c.x0, c.left_offset()), (c.x1, c.right_offset())] {
                let d = (x - edge).abs();
                if best.is_none_or(|b| d <= b.0) {
                    best = Some((d, offset));
                }
            }
        }
        let offset = best.map_or(line.info.start, |b| b.1);
        // A line that goes on in the next without a break between ended by
        // wrapping.
        let wrapped = i
            .checked_add(1)
            .and_then(|n| self.lines.get(n))
            .is_some_and(|next| next.info.start == line.info.end);
        let affinity = if wrapped && offset == line.info.end && offset > line.info.start {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        TextPosition::new(offset, affinity)
    }

    /// The index of the line the caret at `position` is on (as
    /// [`TextPosition::line`] says, without copying the lines out).
    fn line_of(&self, position: TextPosition) -> Option<usize> {
        position.line_in(self.lines.iter().map(|l| l.info.start..l.info.end))
    }

    /// The caret at `position` (content coordinates): no width, as high as
    /// its line, at the cluster edge of that offset (the nearest, where the
    /// offset is not an edge). `None` without lines.
    pub(crate) fn caret_rect(&self, position: TextPosition) -> Option<Bounds<Points>> {
        let line = self.lines.get(self.line_of(position)?)?;
        let mut clusters = Vec::new();
        self.line_clusters(line, &mut clusters);
        Self::set_ends(line, &mut clusters);
        let mut best: Option<(u32, f32)> = None;
        for c in &clusters {
            for (edge, offset) in [(c.x0, c.left_offset()), (c.x1, c.right_offset())] {
                let d = offset.abs_diff(position.offset);
                if best.is_none_or(|b| d < b.0) {
                    best = Some((d, edge));
                }
            }
        }
        let x = best.map_or(line.info.x.0, |b| b.1);
        Some(Bounds::new(
            nsh_core::geometry::point(Points(x), line.info.y),
            nsh_core::geometry::size(Points(0.0), line.info.height),
        ))
    }

    /// Calls `f(x, y, width, height, radius, color)` with the boxes
    /// (content coordinates) of the span backgrounds of `text`.
    fn background_rects(
        &self,
        text: &AttributedText,
        mut f: impl FnMut(f32, f32, f32, f32, f32, nsh_core::Color),
    ) {
        for line in &self.lines {
            let runs = &self.runs[line.runs.clone()];
            let Some(baseline) = runs.first().map(|r| r.baseline) else {
                continue;
            };
            let pieces = runs.iter().flat_map(|run| {
                let mut gx = run.x;
                let (ascent, descent) = run.font.extents;
                run.glyphs.iter().map(move |g| {
                    let x = gx;
                    let width = from_pango(g.width);
                    gx += width;
                    nsh_core::LinePiece {
                        x: Points(x),
                        width: Points(width),
                        background: text.background_at(g.index),
                        ascent: Points(ascent),
                        descent: Points(descent),
                    }
                })
            });
            let clip = (line.info.x, line.info.x + line.info.width);
            nsh_core::BackgroundBox::join(pieces, clip, |b| {
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

    /// Appends to `out` the rectangles (content coordinates) that
    /// highlight the characters of `range`: per line, the spans of
    /// selected glyphs and attachments, line high, through the line's end
    /// where the range goes on past it.
    pub(crate) fn range_rects(&self, range: std::ops::Range<u32>, out: &mut Vec<Bounds<Points>>) {
        if range.start >= range.end {
            return;
        }
        for line in self
            .lines
            .iter()
            .filter(|l| l.info.start < range.end && range.start < l.info.end)
        {
            let (y, h) = (line.info.y, line.info.height);
            let first = out.len();
            // The piece of the last selected character in the text (index in
            // `out`, offset, direction): the one a range going on past the
            // line extends.
            let mut last: Option<(usize, u32, bool)> = None;
            let runs = self.runs.get(line.runs.clone()).unwrap_or_default();
            for run in runs.iter().filter(|r| !r.ellipsis) {
                let mut gx = run.x;
                for g in &run.glyphs {
                    let w = from_pango(g.width);
                    if range.contains(&g.index) {
                        if last.is_none_or(|l| g.index >= l.1) {
                            last = Some((out.len(), g.index, run.rtl));
                        }
                        out.push(Bounds::new(
                            nsh_core::geometry::point(Points(gx), y),
                            nsh_core::geometry::size(Points(w), h),
                        ));
                    }
                    gx += w;
                }
            }
            let line_rtl = runs.first().is_some_and(|r| r.rtl);
            for (&(index, width), at) in self.attachment_extents.iter().zip(&self.attachments) {
                if let Some((x, _)) = *at
                    && range.contains(&index)
                    && index >= line.info.start
                    && index < line.info.end
                {
                    if last.is_none_or(|l| index >= l.1) {
                        last = Some((out.len(), index, line_rtl));
                    }
                    out.push(Bounds::new(
                        nsh_core::geometry::point(Points(x), y),
                        nsh_core::geometry::size(Points(width), h),
                    ));
                }
            }
            if range.end > line.info.end
                && let Some((at, _, rtl)) = last
                && let Some(piece) = out.get_mut(at)
            {
                let right = piece.origin.x.0 + piece.size.width.0;
                if rtl {
                    piece.origin.x = line.info.x;
                    piece.size.width = Points(right - line.info.x.0);
                } else {
                    let edge = (line.info.x + line.info.width).0;
                    piece.size.width = Points((edge - piece.origin.x.0).max(piece.size.width.0));
                }
            }
            // Left to right, adjacent pieces joined.
            let Some(pieces) = out.get_mut(first..) else {
                continue;
            };
            pieces.sort_unstable_by(|a, b| a.origin.x.0.total_cmp(&b.origin.x.0));
            let mut kept = first;
            for read in first..out.len() {
                let Some(piece) = out.get(read).copied() else {
                    break;
                };
                let joined = kept
                    .checked_sub(1)
                    .filter(|&k| k >= first)
                    .and_then(|k| out.get_mut(k))
                    .filter(|p| piece.origin.x.0 <= p.origin.x.0 + p.size.width.0 + 0.5);
                match joined {
                    Some(p) => {
                        let right = (piece.origin.x.0 + piece.size.width.0)
                            .max(p.origin.x.0 + p.size.width.0);
                        p.size.width = Points(right - p.origin.x.0);
                    }
                    None => {
                        if let Some(slot) = out.get_mut(kept) {
                            *slot = piece;
                        }
                        kept += 1;
                    }
                }
            }
            out.truncate(kept);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_offsets_of_bytes() {
        // "a" 1 byte / 1 unit, "é" 2 / 1, "中" 3 / 1, "😀" 4 / 2.
        let t = utf16_offsets("aé中😀b");
        assert_eq!(t.len(), "aé中😀b".len() + 1);
        assert_eq!(t[0], 0);
        assert_eq!(t[1], 1);
        assert_eq!(t[3], 2);
        assert_eq!(t[6], 3);
        assert_eq!(t[10], 5);
        assert_eq!(t[11], 6);
        // Inside a character: the character's offset.
        assert_eq!(t[2], 1);
        assert_eq!(t[8], 3);
        assert_eq!(&*utf16_offsets(""), &[0]);
    }

    #[test]
    fn utf16_to_byte_offsets() {
        let s = "aé中😀b";
        assert_eq!(utf16_to_byte(s, (0, 0), 0), 0);
        assert_eq!(utf16_to_byte(s, (0, 0), 1), 1);
        assert_eq!(utf16_to_byte(s, (0, 0), 2), 3);
        assert_eq!(utf16_to_byte(s, (0, 0), 3), 6);
        assert_eq!(utf16_to_byte(s, (0, 0), 5), 10);
        // Inside the surrogate pair: after the character.
        assert_eq!(utf16_to_byte(s, (0, 0), 4), 10);
        // Walking on from an earlier boundary.
        assert_eq!(utf16_to_byte(s, (3, 2), 5), 10);
        // Past the end.
        assert_eq!(utf16_to_byte(s, (0, 0), 99), s.len());
    }

    #[test]
    fn families() {
        assert_eq!(resolve_family("Inter", "Adwaita Sans"), "Inter");
        assert_eq!(resolve_family("system-ui", "Adwaita Sans"), "Adwaita Sans");
        assert_eq!(resolve_family("ui-monospace", "X"), "monospace");
        assert_eq!(
            resolve_family("\"Fira Code\", ui-monospace, monospace", "X"),
            "Fira Code,monospace,monospace"
        );
        assert_eq!(resolve_family(" , ", "X"), "X");
    }

    fn text(parts: &[(&str, ResolvedTextStyle)]) -> AttributedText {
        let mut t = AttributedText::default();
        for (s, style) in parts {
            t.push(s, *style);
        }
        t
    }

    /// What is measured at a width lays out in as many lines at the
    /// measured size (the core sizes text views from `measure`).
    #[test]
    fn attachments_sit_by_vertical_align() {
        let engine = PangoTextEngine::new("sans-serif".into());
        let style = ResolvedTextStyle::default();
        for height in [4.0, 30.0] {
            for align in [
                nsh_core::VerticalAlign::Baseline,
                nsh_core::VerticalAlign::TextTop,
                nsh_core::VerticalAlign::TextBottom,
                nsh_core::VerticalAlign::Middle,
            ] {
                let mut text = text(&[("Ax", style)]);
                let mut alignments = nsh_core::AttachmentAlignments::default();
                alignments.push(
                    &mut text,
                    nsh_core::Size::new(Points(10.0), Points(height)),
                    align,
                    style,
                );
                let a = text.attachments[0];
                let font = engine.attachment_font(&engine.ltr, &text, &a);
                let prepared = engine.prepare_aligned(&text, &alignments);
                let layout = engine.layout(&prepared, engine.measure(&prepared, None));
                let line = engine.lines(&layout).remove(0);
                let top = engine.attachments(&layout)[0].expect("shown").y;
                let expected = line.y + line.ascender - a.ascent(font, align);
                assert!(
                    (top - expected).0.abs() < 0.01,
                    "{align:?} {height}: {top:?} {expected:?}"
                );
            }
        }
    }

    #[test]
    fn layout_matches_measure() {
        let engine = PangoTextEngine::new("sans-serif".into());
        let plain = ResolvedTextStyle {
            font_size: Points(15.0),
            ..Default::default()
        };
        let texts = [
            text(&[(
                "The quick brown fox jumps over the lazy dog, again and again.",
                plain,
            )]),
            text(&[
                (
                    "Spaced letters ",
                    ResolvedTextStyle {
                        letter_spacing: Points(1.3),
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
                        font_size: Points(31.0),
                        line_height: Points(40.0),
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
                let size = engine.measure(&prepared, Some(Points(width as f32)));
                // The core rounds measurements up.
                let size = Size::new(size.width.ceil(), size.height.ceil());
                let measured_lines = {
                    let p = engine.prepare(t);
                    engine.configure(&p, Some(width as f32))
                };
                let lines = engine.lines(&engine.layout(&prepared, size));
                assert_eq!(lines.len(), measured_lines, "{:?} at {width}", t.text);
                let bottom = lines.last().map_or(0.0, |l| (l.y + l.height).0);
                assert!(
                    bottom <= size.height.0,
                    "{:?} at {width}: {bottom} > {size:?}",
                    t.text
                );
                // Lines may end in letter spacing past the box.
                let slack = from_pango(prepared.slack) + 0.01;
                for line in &lines {
                    assert!(
                        (line.x + line.width).0 <= size.width.0 + slack,
                        "{:?} at {width}: {line:?}",
                        t.text
                    );
                }
            }
        }
    }

    #[test]
    fn max_lines_and_attachments() {
        let engine = PangoTextEngine::new("sans-serif".into());
        let style = ResolvedTextStyle::default();
        let mut t = text(&[("Before ", style)]);
        t.push_attachment(Size::new(Points(20.0), Points(30.0)), style);
        t.push(
            " after the attachment, and long enough to wrap a few times here.",
            style,
        );
        let prepared = engine.prepare(&t);
        let size = engine.measure(&prepared, Some(Points(120.0)));
        let layout = engine.layout(&prepared, size);
        let points = engine.attachments(&layout);
        assert_eq!(points.len(), 1);
        let at = points[0].expect("attachment shown");
        let (x, y) = (at.x.0, at.y.0);
        assert!(x > 0.0 && y >= 0.0, "{x}, {y}");
        let lines = engine.lines(&layout);
        assert!(lines[0].height.0 >= 30.0, "{:?}", lines[0]);

        t.max_lines = 2;
        t.ellipsize = EllipsizeMode::Tail;
        let prepared = engine.prepare(&t);
        let two = engine.measure(&prepared, Some(Points(120.0)));
        assert!(two.height < size.height);
        assert_eq!(engine.lines(&engine.layout(&prepared, two)).len(), 2);

        let mut t = text(&[("One\ntwo\nthree", style)]);
        t.max_lines = 2;
        t.ellipsize = EllipsizeMode::Tail;
        let prepared = engine.prepare(&t);
        let size = engine.measure(&prepared, Some(Points(200.0)));
        let layout = engine.layout(&prepared, size);
        let lines = engine.lines(&layout);
        assert_eq!(lines.len(), 2);
        // The second line ends with an ellipsis glyph run of its own.
        let l = layout.downcast::<LinuxLayout>().unwrap();
        assert!(!l.lines[1].runs.is_empty());
        // Measuring again (without the cut) still sees three paragraphs.
        assert_eq!(engine.measure(&prepared, None).height, {
            let p = engine.prepare(&t);
            engine.measure(&p, None).height
        });
    }

    #[test]
    fn registered_fonts_lay_out() {
        let engine = PangoTextEngine::new("sans-serif".into());
        let data = include_bytes!("../../../examples/gallery/fonts/Pacifico-Regular.ttf");
        engine.register_font(data).expect("registered");
        assert!(engine.register_font(b"not a font").is_err());
        let style = ResolvedTextStyle {
            font_family: Some(nsh_core::FontFamily::new("Pacifico")),
            ..Default::default()
        };
        let t = text(&[("Custom fonts", style)]);
        let prepared = engine.prepare(&t);
        let layout = engine.layout(&prepared, engine.measure(&prepared, None));
        let l = layout.downcast::<LinuxLayout>().unwrap();
        assert!(
            l.runs[0].font.desc.starts_with("Pacifico"),
            "{}",
            l.runs[0].font.desc
        );
    }

    #[test]
    fn separators() {
        assert_eq!(separator_len("\r\nb"), 2);
        assert_eq!(separator_len("\nb"), 1);
        assert_eq!(separator_len("\r"), 1);
        assert_eq!(separator_len("\u{2029}b"), 3);
        assert_eq!(separator_len("b\n"), 0);
        assert_eq!(separator_len(""), 0);
    }

    #[test]
    fn weights() {
        assert_eq!(weight(100), pango::Weight::Thin);
        assert_eq!(weight(400), pango::Weight::Normal);
        assert_eq!(weight(450), pango::Weight::Medium);
        assert_eq!(weight(700), pango::Weight::Bold);
        assert_eq!(weight(900), pango::Weight::Heavy);
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

    /// Cap and x heights are plausible: from the font's OS/2 table, or the
    /// estimate for fonts without one (which depends on the machine's
    /// default font, so either is accepted).
    #[test]
    fn cap_and_x_heights() {
        let engine = PangoTextEngine::new("sans-serif".into());
        let style = ResolvedTextStyle {
            font_size: Points(20.0),
            ..Default::default()
        };
        let t = text(&[("Hx", style)]);
        let prepared = engine.prepare(&t);
        let size = engine.measure(&prepared, None);
        let lines = engine.lines(&engine.layout(&prepared, size));
        let (cap, x) = (lines[0].cap_height.0, lines[0].x_height.0);
        assert!(cap > 11.0 && cap < 16.0 && x > 8.0 && x < cap, "{cap} {x}");
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
        let engine = PangoTextEngine::new("sans-serif".into());
        let style = ResolvedTextStyle {
            font_size: Points(15.0),
            ..Default::default()
        };
        let code = ResolvedTextStyle {
            font_size: Points(13.0),
            background: Some(nsh_core::TextBackground {
                color: nsh_core::Color(0xeeee_eeff),
                radius: Points(4.0),
                node: 4,
            }),
            ..style
        };
        let t = text(&[("Run ", style), ("cargo test --all", code), (" now", style)]);
        let boxes = |width: Option<f32>| {
            let prepared = engine.prepare(&t);
            let size = engine.measure(&prepared, width.map(Points));
            let layout = engine.layout(&prepared, size);
            let l = layout.downcast::<LinuxLayout>().unwrap();
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
        let engine = PangoTextEngine::new("sans-serif".into());
        let style = ResolvedTextStyle {
            font_size: Points(15.0),
            ..Default::default()
        };
        let t = text(&[("First line here\nsecond", style)]);
        let prepared = engine.prepare(&t);
        let size = engine.measure(&prepared, None);
        let layout = engine.layout(&prepared, size);
        let l = layout.downcast::<LinuxLayout>().unwrap();
        assert_eq!(l.lines.len(), 2);
        assert_eq!(l.hit_test(-5.0, 2.0).offset, 0);
        // Past the end of a line that ends in a break: before the break.
        let end = l.hit_test(size.width.0 + 20.0, 2.0);
        assert_eq!(end, TextPosition::new(15, Affinity::Downstream));
        // Below the text: the last line.
        let last = l.hit_test(size.width.0 + 20.0, size.height.0 + 50.0);
        assert_eq!(last.offset, 22);
        let mid = l.hit_test((size.width / 2.0).0, 2.0).offset;
        assert!(mid > 3 && mid < 12, "{mid}");
        // Nearest glyph edge: just right of a glyph's start is before it.
        let mut clusters = Vec::new();
        l.line_clusters(&l.lines[0], &mut clusters);
        let c = clusters[2];
        let (gx, w) = (c.x0, c.x1 - c.x0);
        assert_eq!(l.hit_test(gx + w * 0.2, 2.0).offset, c.start);
        assert_eq!(l.hit_test(gx + w * 0.8, 2.0).offset, c.start + 1);

        let mut rects = Vec::new();
        l.range_rects(6..19, &mut rects);
        // "line here" on the first line, "sec" on the second.
        assert_eq!(rects.len(), 2, "{rects:?}");
        assert!(rects[0].origin.x.0 > 0.0 && rects[0].origin.y.0 == 0.0);
        assert_eq!(rects[1].origin.x.0, 0.0);
        assert!(rects[1].origin.y.0 >= rects[0].size.height.0);

        let mut rtl = text(&[("שלום עולם", style)]);
        rtl.rtl = true;
        let prepared = engine.prepare(&rtl);
        let size = engine.measure(&prepared, None);
        let layout = engine.layout(&prepared, size);
        let l = layout.downcast::<LinuxLayout>().unwrap();
        // Right to left: the right edge is the start.
        assert_eq!(l.hit_test(size.width.0 + 5.0, 2.0).offset, 0);
        assert_eq!(l.hit_test(-5.0, 2.0).offset, 9);
    }

    #[test]
    fn wrapped_lines_keep_their_end() {
        let engine = PangoTextEngine::new("sans-serif".into());
        let style = ResolvedTextStyle {
            font_size: Points(15.0),
            ..Default::default()
        };
        let t = text(&[("alpha beta gamma delta epsilon", style)]);
        let prepared = engine.prepare(&t);
        let size = engine.measure(&prepared, Some(Points(90.0)));
        let layout = engine.layout(&prepared, size);
        let l = layout.downcast::<LinuxLayout>().unwrap();
        assert!(l.lines.len() >= 2, "{}", l.lines.len());
        let end = l.lines[0].info.end;
        assert_eq!(l.lines[1].info.start, end);
        // Past the end of a wrapped line: its end, on that line.
        let p = l.hit_test(size.width.0 + 20.0, 2.0);
        assert_eq!(p, TextPosition::new(end, Affinity::Upstream));
        let upstream = l.caret_rect(p).unwrap();
        let downstream = l
            .caret_rect(TextPosition::new(end, Affinity::Downstream))
            .unwrap();
        assert_eq!(upstream.origin.y, l.lines[0].info.y);
        assert_eq!(upstream.size.height, l.lines[0].info.height);
        assert_eq!(upstream.size.width, Points(0.0));
        assert_eq!(downstream.origin.y, l.lines[1].info.y);
        assert!(upstream.origin.x.0 > downstream.origin.x.0);
        // The start of the next line is downstream.
        let next = l.hit_test(-5.0, l.lines[1].info.y.0 + 2.0);
        assert_eq!(next, TextPosition::new(end, Affinity::Downstream));

        // A range going on past a line takes it through its end, and
        // appends to what `out` holds.
        let mut rects = vec![Bounds::new(
            nsh_core::geometry::point(Points(-1.0), Points(-1.0)),
            nsh_core::geometry::size(Points(1.0), Points(1.0)),
        )];
        l.range_rects(2..end + 3, &mut rects);
        assert_eq!(rects.len(), 3, "{rects:?}");
        assert_eq!(rects[0].origin.x, Points(-1.0));
        let line = &l.lines[0].info;
        let right = rects[1].origin.x.0 + rects[1].size.width.0;
        assert!((right - (line.x + line.width).0).abs() < 0.01, "{right}");
        assert_eq!(rects[2].origin.y, l.lines[1].info.y);
        l.range_rects(4..4, &mut rects);
        assert_eq!(rects.len(), 3);
    }
}

#[cfg(test)]
mod fallback_tests {
    use super::*;

    fn one(s: &str) -> AttributedText {
        let mut t = AttributedText::default();
        t.push(
            s,
            ResolvedTextStyle {
                font_size: Points(16.0),
                ..Default::default()
            },
        );
        t
    }

    #[test]
    fn fallback_fonts_keep_the_line_height() {
        let engine = PangoTextEngine::new("sans-serif".into());
        let h = |s: &str| engine.measure(&engine.prepare(&one(s)), None).height;
        let latin = h("Grace");
        assert_eq!(h("Grace你好世界"), latin, "CJK");
        assert_eq!(h("Grace😀"), latin, "emoji");
    }
}

//! Text layout for the web: line breaking runs here, widths come from the
//! browser (`CanvasRenderingContext2D.measureText`, the `nsh.measure_text`
//! import), and the DOM draws the result run by run at the positions laid
//! out here, so what was measured is what is drawn (the browser never
//! wraps a run itself).
//!
//! Lines break after spaces, around CJK characters and at `\n`, except
//! where the line start and end rules forbid it (closing punctuation never
//! starts a line, opening punctuation never ends one: [`wrap`]); a word
//! longer than the line breaks between characters. That is a subset of
//! UAX #14, enough for app text.

use std::{
    cell::RefCell,
    ops::Range,
    rc::Rc,
    sync::{Arc, OnceLock},
};

use nsh_core::{
    AttributedText, Bounds, EllipsizeMode, Point, Points, ResolvedTextStyle, Size, TextAlign,
    TextEngine, TextLayout, TextLine, TextPosition, text_edit::next_cluster,
};
use rustc_hash::FxHashMap;

pub(crate) use self::css::{css_font, font_variant_numeric};
use self::{
    css::{emoji_excess, figure_width, measured_by_char},
    hit::Stop,
};
use crate::ffi;

mod css;
pub(crate) use css::family_list;
mod hit;
mod wrap;

/// The placeholder character of an inline attachment.
const OBJECT: char = '\u{fffc}';

/// What a measured width is keyed by: font, `font-variant-numeric`, text.
type WidthKey = (Arc<str>, Option<Arc<str>>, String);

#[derive(Default)]
pub(crate) struct WebTextEngine {
    /// Width of `(font, font-variant-numeric, text)`.
    widths: RefCell<FxHashMap<WidthKey, f32>>,
    /// How much wider the DOM draws an emoji cluster in a font than canvas
    /// measures it.
    emoji: RefCell<FxHashMap<(Arc<str>, String), f32>>,
    /// Ascent and descent of a font.
    metrics: RefCell<FxHashMap<Arc<str>, (f32, f32)>>,
    /// The x height of a font (attachments in the middle of a line).
    x_heights: RefCell<FxHashMap<Arc<str>, f32>>,
    /// The long texts prepared last, newest last: an edit of one keeps the
    /// pieces and lines outside what it changed ([`Recent`]).
    recent: RefCell<Vec<Recent>>,
}

impl WebTextEngine {
    /// Forgets the measurements: a font finished loading, so what was
    /// measured with a fallback font is stale, or the pixel ratio changed.
    pub(crate) fn clear_caches(&self) {
        self.widths.borrow_mut().clear();
        self.emoji.borrow_mut().clear();
        self.metrics.borrow_mut().clear();
        self.x_heights.borrow_mut().clear();
        // Their pieces' widths are stale too.
        self.recent.borrow_mut().clear();
    }

    fn x_height(&self, font: &Arc<str>, size: f32) -> f32 {
        if let Some(&x) = self.x_heights.borrow().get(font) {
            return x;
        }
        let x = match ffi::font_x_height(font) {
            x if x > 0.0 => x,
            // As `TextLine::x_height` estimates it.
            _ => size * 0.5,
        };
        self.x_heights.borrow_mut().insert(font.clone(), x);
        x
    }

    /// The width of `text` in a run style's font and numeric variant.
    fn width(&self, font: &Arc<str>, numeric: Option<&Arc<str>>, text: &str) -> f32 {
        if text.is_empty() {
            return 0.0;
        }
        // A figure is measured by its characters and pairs, each once: a
        // live value lays the page out for no new one, and its strings, new
        // on every update, stay out of the cache.
        if numeric.is_some() && text.chars().nth(1).is_some() && measured_by_char(text) {
            return figure_width(text, |part| self.measured(font, numeric, part));
        }
        self.measured(font, numeric, text)
    }

    /// The width of `text` measured whole, cached.
    fn measured(&self, font: &Arc<str>, numeric: Option<&Arc<str>>, text: &str) -> f32 {
        let key = (font.clone(), numeric.cloned(), text.to_owned());
        if let Some(&w) = self.widths.borrow().get(&key) {
            return w;
        }
        let w = match numeric {
            // Canvas cannot measure numeric variants: tabular digits are
            // wider than the proportional ones it measures.
            Some(numeric) => ffi::measure_numeric_text(font, numeric, text),
            None => {
                ffi::measure_text(font, text)
                    + emoji_excess(text, |cluster| self.cluster_excess(font, cluster))
            }
        };
        let mut widths = self.widths.borrow_mut();
        // Bounded: a long-running app measures many distinct strings.
        if widths.len() > 20_000 {
            widths.clear();
        }
        widths.insert(key, w);
        w
    }

    /// How much wider the DOM draws emoji `cluster` than canvas measures
    /// it: measured in the DOM once per font, so a line being typed is
    /// still measured on canvas.
    fn cluster_excess(&self, font: &Arc<str>, cluster: &str) -> f32 {
        let key = (font.clone(), cluster.to_owned());
        if let Some(&e) = self.emoji.borrow().get(&key) {
            return e;
        }
        let e =
            ffi::measure_numeric_text(font, "normal", cluster) - ffi::measure_text(font, cluster);
        let mut emoji = self.emoji.borrow_mut();
        if emoji.len() > 20_000 {
            emoji.clear();
        }
        emoji.insert(key, e);
        e
    }

    fn run_width(&self, run: &RunStyle, text: &str) -> f32 {
        let advance = self.width(&run.font, run.numeric.as_ref(), text);
        if text.is_empty() || run.style.letter_spacing.0 == 0.0 {
            advance
        } else {
            advance + run.style.letter_spacing.0 * cluster_count(text) as f32
        }
    }

    fn metrics(&self, font: &Arc<str>, size: f32) -> (f32, f32) {
        if let Some(&m) = self.metrics.borrow().get(font) {
            return m;
        }
        let (ascent, descent) = ffi::font_metrics(font);
        let m = if ascent > 0.0 {
            (ascent, descent)
        } else {
            (size * 0.93, size * 0.24)
        };
        self.metrics.borrow_mut().insert(font.clone(), m);
        m
    }

    /// Where the caret can stand on line `i` of `layout`: measured at the
    /// first call and kept with the layout, which is as stale as the
    /// measurements are once a font loads (the page lays out again then).
    fn stops<'l>(&self, layout: &'l WebLayout, i: usize) -> &'l [Stop] {
        let Some(line) = layout.hit.get(i) else {
            return &[];
        };
        line.stops
            .get_or_init(|| {
                let mut stops = Vec::new();
                for part in &line.parts {
                    let Some(run) = layout.styles.get(usize::from(part.style)) else {
                        continue;
                    };
                    // An attachment: one unit, its box.
                    let Some(t) = &part.text else {
                        hit::push_stops(&mut stops, part.x, part.width, part.start, None, |_| {
                            (0.0, 0.0)
                        });
                        continue;
                    };
                    // The piece's characters, its drawn run and what the
                    // run holds before it.
                    let Some((drawn, text, before)) = layout.runs.get(t.run).and_then(|drawn| {
                        let end = t.byte.checked_add(t.len)?;
                        Some((
                            drawn,
                            drawn.text.get(t.byte..end)?,
                            drawn.text.get(..t.byte)?,
                        ))
                    }) else {
                        log::warn!("a piece of a line lost its run");
                        continue;
                    };
                    // Measured in the whole drawn run: an ellipsis or a
                    // neighbouring piece can change bidi ordering.
                    let base = u32::try_from(before.encode_utf16().count()).unwrap_or(0);
                    let mut ranges = Vec::new();
                    let (mut byte, mut unit) = (0, base);
                    while byte < text.len() {
                        let next = next_cluster(text, byte);
                        let Some(cluster) = text.get(byte..next).filter(|_| next > byte) else {
                            break;
                        };
                        let end = unit.saturating_add(
                            u32::try_from(cluster.encode_utf16().count()).unwrap_or(0),
                        );
                        ranges.push([unit, end]);
                        unit = end;
                        byte = next;
                    }
                    let mut boxes = vec![[0.0; 2]; ranges.len()];
                    ffi::text_cluster_boxes(
                        &run.font,
                        run.numeric.as_deref().unwrap_or(""),
                        run.style.letter_spacing.0,
                        &drawn.text,
                        &ranges,
                        &mut boxes,
                    );
                    let mut boxes = boxes.into_iter();
                    hit::push_stops(
                        &mut stops,
                        drawn.x,
                        part.width,
                        part.start,
                        Some(text),
                        |_| {
                            boxes
                                .next()
                                .map_or((0.0, 0.0), |[left, right]| (left, right))
                        },
                    );
                }
                stops
            })
            .as_slice()
    }
}

/// A style of a prepared text: its CSS font and metrics.
#[derive(Debug, Clone)]
pub(crate) struct RunStyle {
    pub(crate) style: ResolvedTextStyle,
    pub(crate) font: Arc<str>,
    /// Its `font-variant-numeric`, which the width measurements take.
    numeric: Option<Arc<str>>,
    pub(crate) ascent: f32,
    pub(crate) descent: f32,
}

impl RunStyle {
    /// The height of a line of this style alone, and where the glyphs'
    /// top sits in it (CSS half-leading).
    fn line(&self) -> (f32, f32) {
        let natural = self.ascent + self.descent;
        if self.style.line_height.0 > 0.0 {
            let h = self.style.line_height.0;
            (h, (h - natural) / 2.0)
        } else {
            (natural, 0.0)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum AtomKind {
    /// Text; the line may break after it.
    Text,
    /// Spaces (do not count at the end of a line).
    Space,
    /// A forced line break.
    Newline,
    /// An inline attachment: width, how far its top is above the baseline,
    /// and what its line reserves above and below the baseline
    /// (`TextAttachment::ascent` and `extent`).
    Attachment(f32, f32, f32, f32),
}

/// A piece of text that is never broken across lines (except words wider
/// than a line).
#[derive(Debug, Clone)]
struct Atom {
    text: Rc<str>,
    style: u16,
    width: f32,
    kind: AtomKind,
    /// UTF-16 offsets in the text.
    start: u32,
    end: u32,
}

/// What [`WebTextEngine::prepare`] makes.
#[derive(Debug)]
pub(crate) struct Prepared {
    atoms: Rc<[Atom]>,
    /// Its lines at the widths it was broken at ([`Broken`]).
    lines: LinesCache,
    /// The text it is an edit of, whose lines it reuses where the edit
    /// cannot have changed them.
    base: Option<Base>,
    styles: Arc<[RunStyle]>,
    align: TextAlign,
    max_lines: u32,
    ellipsize: EllipsizeMode,
    no_wrap: bool,
    rtl: bool,
    /// The UTF-16 ranges of the text's links (`AttributedText::links`), in
    /// their order.
    links: Box<[(u32, u32)]>,
}

/// One drawn run.
#[derive(Debug, Clone)]
pub(crate) struct Run {
    pub(crate) x: f32,
    /// Top of the glyph box (ascent above the baseline).
    pub(crate) y: f32,
    pub(crate) text: String,
    pub(crate) style: u16,
    /// Offset of its first character (UTF-16 units); `None` when it begins
    /// with a truncated line's `…`, which belongs to no offset.
    pub(crate) start: Option<u32>,
    /// Its characters in links: `(from, to, link)`, UTF-16 units in the
    /// run and an index into `AttributedText::links` (the innermost).
    /// They stay in the run, whose shaping and bidi order they keep.
    pub(crate) links: Vec<(u32, u32, u16)>,
    /// It ends with a truncated line's `…`, which belongs to no offset.
    ellipsis: bool,
    /// What follows the run when the text is copied: the line's break (a
    /// newline, or the spaces a wrap dropped) after its last run.
    pub(crate) after: String,
    /// The height of its line when it is not the run's own (a line height
    /// the text sets, a taller run beside it): the DOM gives the run a line
    /// box that tall around its baseline, so a selection highlights the
    /// whole line, as a browser's own text does.
    pub(crate) line_height: Option<f32>,
}

/// A box of a span background, behind the runs.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Background {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
    pub(crate) radius: f32,
    pub(crate) color: nsh_core::Color,
}

/// A final layout.
#[derive(Debug)]
pub(crate) struct WebLayout {
    pub(crate) runs: Vec<Run>,
    /// Span backgrounds, drawn behind the runs: one box per span and line,
    /// across the runs of the styles inside it.
    pub(crate) backgrounds: Vec<Background>,
    pub(crate) styles: Arc<[RunStyle]>,
    lines: Vec<TextLine>,
    /// What the caret stops of each line are made of, line for line as
    /// `lines`.
    hit: Vec<HitLine>,
    attachments: Vec<Option<(f32, f32)>>,
}

impl WebLayout {
    /// Where a copy of the text puts the attachment at UTF-16 offset
    /// `index` among the runs, which hold no attachments: after the
    /// characters of run `r` (`false`: before the line's break after them)
    /// or before them (`true`). It goes after the last run before it on its
    /// line, else before the first after it on its line, else before the
    /// first run of a later line, else after the last run. `None` when it is
    /// not laid out (cut off with the lines after `numberOfLines`).
    pub(crate) fn attachment_place(&self, index: u32) -> Option<(usize, bool)> {
        let run_of = |p: &HitPart| p.text.as_ref().map(|t| t.run);
        for (n, line) in self.hit.iter().enumerate() {
            let Some(at) = line
                .parts
                .iter()
                .position(|p| p.text.is_none() && p.start == index)
            else {
                continue;
            };
            if let Some(r) = line.parts[..at].iter().rev().find_map(run_of) {
                return Some((r, false));
            }
            if let Some(r) = line.parts[at + 1..].iter().find_map(run_of) {
                return Some((r, true));
            }
            if let Some(r) = self.hit[n + 1..]
                .iter()
                .flat_map(|l| &l.parts)
                .find_map(run_of)
            {
                return Some((r, true));
            }
            return self.runs.len().checked_sub(1).map(|r| (r, false));
        }
        None
    }
}

/// A line's drawn pieces, for hit testing, and where the caret can stand on
/// it: measured at the first hit test of the line, when the text is
/// selected or edited, not for every layout.
#[derive(Debug)]
struct HitLine {
    parts: Vec<HitPart>,
    stops: OnceLock<Vec<Stop>>,
}

/// A piece of a line as laid out, without the ellipsis (never selected).
#[derive(Debug)]
struct HitPart {
    x: f32,
    width: f32,
    style: u16,
    /// Offset of its first character.
    start: u32,
    /// Its characters; `None` for an attachment.
    text: Option<RunText>,
}

/// Where a piece's characters are in the layout's runs (they are drawn
/// there, so they are not kept twice): bytes `byte..byte + len` of run
/// `run`.
#[derive(Debug)]
struct RunText {
    run: usize,
    byte: usize,
    len: usize,
}

impl wrap::Item for Atom {
    fn piece(&self) -> wrap::Piece {
        match self.kind {
            AtomKind::Text => wrap::Piece::Text,
            AtomKind::Space => wrap::Piece::Space,
            AtomKind::Newline => wrap::Piece::Newline,
            AtomKind::Attachment(..) => wrap::Piece::Object,
        }
    }

    fn width(&self) -> f32 {
        match self.kind {
            AtomKind::Attachment(w, ..) => w,
            _ => self.width,
        }
    }

    fn text(&self) -> &str {
        &self.text
    }
}

#[derive(Debug, Clone, Copy)]
struct LineBox {
    /// Atoms `start..end`.
    start: usize,
    end: usize,
    /// The last atom breaking the line looked at ([`wrap::Filled::next`]).
    next: usize,
    /// Width without trailing spaces.
    width: f32,
    height: f32,
    /// The largest ascent (with half-leading) above the baseline.
    above: f32,
}

/// The `font-weight` range a face covers: its `wght` axis for a variable
/// font, else its one OS/2 weight. A single-value `FontFace` descriptor pins
/// a variable font's `wght` axis, so every requested weight would draw at the
/// default instance.
fn weight_range(face: &ttf_parser::Face) -> (u16, u16) {
    let weight = face.weight().to_number();
    face.variation_axes()
        .into_iter()
        .find(|a| a.tag == ttf_parser::Tag::from_bytes(b"wght"))
        .map(|a| {
            let (lo, hi) = (
                a.min_value.round().clamp(1.0, 1000.0),
                a.max_value.round().clamp(1.0, 1000.0),
            );
            (lo as u16, hi as u16)
        })
        .filter(|(lo, hi)| lo < hi)
        .unwrap_or((weight, weight))
}

#[cfg(test)]
impl Prepared {
    /// Whether it was prepared as an edit of a recent text ([`Base`]).
    pub(crate) fn is_edit(&self) -> bool {
        self.base.is_some()
    }

    /// Its atoms, for comparing.
    pub(crate) fn atoms_debug(&self) -> String {
        format!("{:?}", self.atoms)
    }
}

/// The lines of a prepared text at one maximum width.
#[derive(Debug)]
struct Broken {
    /// The maximum width's bits (unbounded: `None`).
    key: Option<u32>,
    /// The atoms the lines are of, when words wider than a line were split
    /// into characters; the prepared ones otherwise.
    split: Option<Vec<Atom>>,
    lines: Vec<LineBox>,
}

impl Broken {
    fn atoms<'a>(&'a self, p: &'a Prepared) -> &'a [Atom] {
        self.split.as_deref().unwrap_or(&p.atoms)
    }
}

/// The widths a prepared text was broken at, few: a measure, a layout
/// and the baseline all take the same lines.
type LinesCache = Rc<RefCell<Vec<Rc<Broken>>>>;

/// What a prepared text that is an edit of another keeps of it: atoms
/// before `first` are the other's, and atoms from `new_after` on are its
/// atoms from `old_after` on, moved.
#[derive(Debug)]
struct Base {
    lines: LinesCache,
    first: usize,
    old_after: usize,
    new_after: usize,
}

/// A long text prepared recently: what an edit of it is compared with.
struct Recent {
    units: Vec<u16>,
    spans: Vec<(u32, u32, ResolvedTextStyle)>,
    attachments: Vec<(u32, AttachmentBox)>,
    atoms: Rc<[Atom]>,
    lines: LinesCache,
}

/// An attachment's width, top above the baseline and extent above and
/// below it.
type AttachmentBox = (f32, f32, f32, f32);

/// Texts at least this long (UTF-16 units) are kept for the edits after
/// them ([`Recent`]); shorter ones are prepared again whole, quickly.
const RECENT_MIN_UNITS: usize = 1024;

/// How many recent texts are kept ([`Recent`]), how many widths each
/// prepared text keeps lines at ([`LinesCache`]).
const RECENT: usize = 4;
const WIDTHS: usize = 4;

/// A piece of a line on its way to the runs.
struct Part {
    text: Rc<str>,
    style: u16,
    width: f32,
    kind: AtomKind,
    /// Offset of its first character (not meaningful for the ellipsis).
    start: u32,
    /// The `…` of a truncated last line, which is drawn but belongs to no
    /// offset.
    ellipsis: bool,
}

/// Number of extended grapheme clusters in `text`, segmented with
/// [`nsh_core::text_edit::next_cluster`] (the same boundaries [`WebTextEngine::stops`]
/// and `emoji_excess` use). CSS `letter-spacing` applies once per typographic
/// character unit (grapheme cluster), not once per Unicode scalar value.
fn cluster_count(text: &str) -> usize {
    if text.is_empty() {
        return 0;
    }
    if text.is_ascii() {
        return text.len();
    }
    let mut at = 0;
    let mut count = 0;
    while at < text.len() {
        at = next_cluster(text, at);
        count += 1;
    }
    count
}

/// Advances one cluster from `pos` in `s`, returning `(next_byte, first_char, utf16_len)`.
///
/// Every code point that [`next_cluster`] joins onto a preceding base
/// (`extends`, regional indicators, ZWJ) is `>= U+0300` (UTF-8 lead byte
/// `>= 0xCC`). When the current character is not ZWJ and the following byte is
/// `< 0xCC` (or end of string), the cluster is that single scalar, avoiding
/// `next_cluster` and `encode_utf16` on plain ASCII and standalone BMP/CJK runs.
#[inline]
fn step_cluster(s: &str, pos: usize) -> Option<(usize, char, u32)> {
    let bytes = s.as_bytes();
    let &b = bytes.get(pos)?;
    if b < 0x80 && bytes.get(pos + 1).is_none_or(|&n| n < 0xCC) {
        return Some((pos + 1, b as char, 1));
    }
    let c = s[pos..].chars().next()?;
    let first_end = pos + c.len_utf8();
    if c != '\u{200D}' && bytes.get(first_end).is_none_or(|&n| n < 0xCC) {
        return Some((first_end, c, c.len_utf16() as u32));
    }
    let next = next_cluster(s, pos);
    if next <= first_end {
        return Some((first_end, c, c.len_utf16() as u32));
    }
    let len = u32::try_from(s[pos..next].encode_utf16().count()).unwrap_or(0);
    Some((next, c, len))
}

/// The end of the paragraph atom `from` is in: its break, or the end.
fn paragraph_end(atoms: &[Atom], from: usize) -> usize {
    atoms[from..]
        .iter()
        .position(|a| a.kind == AtomKind::Newline)
        .map_or(atoms.len(), |i| from + i)
}

/// How many UTF-16 units `old` and `new` share at their start and, of the
/// rest, at their end, never splitting a surrogate pair.
fn common_ends(old: &[u16], new: &[u16]) -> (usize, usize) {
    let mut prefix = old.iter().zip(new).take_while(|(a, b)| a == b).count();
    if prefix > 0
        && (0xD800..0xDC00).contains(&new[prefix - 1])
        && prefix < new.len().min(old.len())
    {
        prefix -= 1;
    }
    let most = old.len().min(new.len()) - prefix;
    let mut suffix = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(most)
        .take_while(|(a, b)| a == b)
        .count();
    if suffix > 0 && (0xDC00..0xE000).contains(&new[new.len() - suffix]) {
        suffix -= 1;
    }
    (prefix, suffix)
}

/// The characters of a run starting at `start` that are in `links`:
/// `(from, to, link)` in the run, each part in one innermost link.
fn link_parts(links: &[(u32, u32)], start: u32, text: &str) -> Vec<(u32, u32, u16)> {
    let end = start + text.encode_utf16().count() as u32;
    let mut cuts: Vec<u32> = links
        .iter()
        .flat_map(|&(s, e)| [s, e])
        .filter(|&b| b > start && b < end)
        .collect();
    cuts.push(start);
    cuts.push(end);
    cuts.sort_unstable();
    cuts.dedup();
    let mut parts: Vec<(u32, u32, u16)> = Vec::new();
    for pair in cuts.windows(2) {
        let (from, to) = (pair[0], pair[1]);
        let Some(link) = links
            .iter()
            .enumerate()
            .filter(|(_, (s, e))| from >= *s && from < *e)
            .min_by_key(|(_, (s, e))| e - s)
            .and_then(|(i, _)| u16::try_from(i).ok())
        else {
            continue;
        };
        match parts.last_mut() {
            Some(last) if last.1 == from - start && last.2 == link => last.1 = to - start,
            _ => parts.push((from - start, to - start, link)),
        }
    }
    parts
}

impl WebTextEngine {
    /// Cuts the characters `range` (UTF-16 offsets) of a text into atoms,
    /// measured: `range` starts and ends where atoms do, as the text's
    /// ends, its spans' and its pieces' (between which atoms are cut by
    /// the characters on either side alone) do.
    fn atomize(
        &self,
        out: &mut Vec<Atom>,
        units: &[u16],
        spans: &[nsh_core::TextSpan],
        styles: &[RunStyle],
        attachments: &FxHashMap<u32, AttachmentBox>,
        range: Range<u32>,
    ) {
        for (index, span) in spans.iter().enumerate() {
            let Some(run) = styles.get(index) else {
                break;
            };
            let index = index as u16;
            let start = (span.start.max(range.start)) as usize;
            let end = (span.end.min(range.end) as usize).min(units.len());
            if start >= end {
                continue;
            }
            let s = String::from_utf16_lossy(&units[start..end]);
            let mut at = start as u32;
            let mut word_byte: Option<usize> = None;
            let mut word_start = at;
            let empty: Rc<str> = Rc::from("");
            let push = |atoms: &mut Vec<Atom>, text: &str, kind, start, end| {
                let (width, text) = match kind {
                    AtomKind::Text | AtomKind::Space => (self.run_width(run, text), Rc::from(text)),
                    // Its placeholder's room on the line.
                    AtomKind::Attachment(w, ..) => (w, Rc::clone(&empty)),
                    AtomKind::Newline => (0.0, Rc::clone(&empty)),
                };
                atoms.push(Atom {
                    text,
                    style: index,
                    width,
                    kind,
                    start,
                    end,
                });
            };
            // Walk by extended grapheme clusters (with a byte fast path on
            // ASCII and standalone scalars) so CJK base characters stay joined
            // with trailing combining marks or variation selectors.
            let mut pos = 0;
            while let Some((next, c, len)) = step_cluster(&s, pos) {
                let single = next - pos == c.len_utf8();
                let attachment = (single && c == OBJECT)
                    .then(|| attachments.get(&at))
                    .flatten();
                let newline = c == '\n';
                let space = single && (c == ' ' || c == '\t');
                let cjk = wrap::is_cjk(c);
                if newline || space || cjk || attachment.is_some() {
                    if let Some(wb) = word_byte.take() {
                        push(out, &s[wb..pos], AtomKind::Text, word_start, at);
                    }
                    if newline {
                        push(out, "", AtomKind::Newline, at, at + len);
                        pos = next;
                    } else if let Some(&(w, top, up, down)) = attachment {
                        push(
                            out,
                            "",
                            AtomKind::Attachment(w, top, up, down),
                            at,
                            at + len,
                        );
                        pos = next;
                    } else if cjk {
                        push(out, &s[pos..next], AtomKind::Text, at, at + len);
                        pos = next;
                    } else {
                        // A run of spaces is one atom.
                        let space_byte = pos;
                        let mut end = at + len;
                        pos = next;
                        while let Some((peek_next, pc, _)) = step_cluster(&s, pos) {
                            if peek_next - pos != 1 || (pc != ' ' && pc != '\t') {
                                break;
                            }
                            end += 1;
                            pos = peek_next;
                        }
                        push(out, &s[space_byte..pos], AtomKind::Space, at, end);
                        at = end;
                        continue;
                    }
                    at += len;
                } else {
                    if word_byte.is_none() {
                        word_byte = Some(pos);
                        word_start = at;
                    }
                    at += len;
                    pos = next;
                    // A hyphen ends a word (the line may break after it).
                    if single
                        && c == '-'
                        && s.as_bytes().get(pos).is_some_and(|&b| {
                            if b < 0x80 {
                                b.is_ascii_alphanumeric()
                            } else {
                                s[pos..].chars().next().is_some_and(char::is_alphanumeric)
                            }
                        })
                        && let Some(wb) = word_byte.take()
                    {
                        push(out, &s[wb..pos], AtomKind::Text, word_start, at);
                    }
                }
            }
            if let Some(wb) = word_byte {
                push(out, &s[wb..], AtomKind::Text, word_start, at);
            }
        }
    }

    /// `units` as an edit of a long text prepared recently ([`Recent`]):
    /// its atoms, the other's outside the characters the edit changed (with
    /// the words they touch) and new ones for those, measured, and what its
    /// lines can reuse. `None` when no recent text has its spans, styles and
    /// attachments outside the edit.
    fn edit_of_recent(
        &self,
        units: &[u16],
        text: &AttributedText,
        attachments: &[(u32, AttachmentBox)],
        styles: &[RunStyle],
    ) -> Option<(Rc<[Atom]>, Option<Base>)> {
        if units.len() < RECENT_MIN_UNITS
            || !text
                .spans
                .windows(2)
                .all(|w| w[0].start <= w[0].end && w[0].end <= w[1].start)
        {
            return None;
        }
        let mut recent = self.recent.borrow_mut();
        // The one sharing the most with it, at either end.
        let (index, prefix, suffix) = recent
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let (p, s) = common_ends(&r.units, units);
                (i, p, s)
            })
            .max_by_key(|&(_, p, s)| p + s)?;
        if (prefix + suffix) * 2 < units.len() {
            return None;
        }
        let old = recent.remove(index);
        drop(recent);
        let atoms = &old.atoms;
        let old_len = old.units.len() as u32;
        let new_len = units.len() as u32;
        let (prefix, suffix) = (prefix as u32, suffix as u32);
        let old_end = old_len - suffix;
        let delta = i64::from(new_len) - i64::from(old_len);
        let moved = |at: u32| (i64::from(at) + delta) as u32;
        // From the first atom the edit touches (a word typed on grows)
        // to the first one after the edit and the character before it.
        let first = atoms.partition_point(|a| a.end < prefix);
        let from = atoms.get(first).map_or(prefix, |a| a.start.min(prefix));
        let old_after = atoms.partition_point(|a| a.start <= old_end);
        let old_to = atoms.get(old_after).map_or(old_len, |a| a.start);
        let to = moved(old_to);
        // Spans, styles and attachments the same before `from` and after
        // `to` (moved).
        let new_spans: Vec<(u32, u32, ResolvedTextStyle)> = text
            .spans
            .iter()
            .map(|s| (s.start, s.end, s.style))
            .collect();
        let clamp = |(start, end, style): (u32, u32, ResolvedTextStyle), len: u32| {
            (start, end.min(len), style)
        };
        let before = |spans: &[(u32, u32, ResolvedTextStyle)], len| {
            spans
                .iter()
                .map(move |&s| clamp(s, len))
                .filter(|&(start, ..)| start < from)
                // A span ending at `from` ends an atom there.
                .map(|(start, end, style)| (start, end.min(from), end > from, style))
                .collect::<Vec<_>>()
        };
        if before(&old.spans, old_len) != before(&new_spans, new_len)
            || old.spans.first().map(|s| s.2) != new_spans.first().map(|s| s.2)
        {
            return None;
        }
        let after_old: Vec<_> = old
            .spans
            .iter()
            .map(|&s| clamp(s, old_len))
            .enumerate()
            .filter(|&(_, (_, end, _))| end > old_to)
            .collect();
        let after_new: Vec<_> = new_spans
            .iter()
            .map(|&s| clamp(s, new_len))
            .enumerate()
            .filter(|&(_, (_, end, _))| end > to)
            .collect();
        if after_old.len() != after_new.len()
            || !after_old.iter().zip(&after_new).all(|(o, n)| {
                let ((_, (os, oe, ostyle)), (_, (ns, ne, nstyle))) = (o, n);
                // A span starting at `to` starts an atom there.
                ostyle == nstyle
                    && moved(*oe) == *ne
                    && moved(*os).max(to) == (*ns).max(to)
                    && (*os < old_to) == (*ns < to)
            })
        {
            return None;
        }
        // Atoms after the edit take the style of the same span moved.
        let style_shift = match (after_old.first(), after_new.first()) {
            (Some((o, _)), Some((n, _))) => *n as i64 - *o as i64,
            _ => 0,
        };
        let attachments_before =
            |list: &[(u32, AttachmentBox)]| list.iter().take_while(|a| a.0 < from).count();
        let old_before = attachments_before(&old.attachments);
        if old.attachments[..old_before] != attachments[..attachments_before(attachments)]
            || !old
                .attachments
                .iter()
                .filter(|a| a.0 >= old_to)
                .map(|&(i, b)| (moved(i), b))
                .eq(attachments.iter().filter(|a| a.0 >= to).copied())
        {
            return None;
        }
        let mut edited = Vec::with_capacity(atoms.len() + 8);
        edited.extend_from_slice(&atoms[..first]);
        let map: FxHashMap<u32, AttachmentBox> = attachments
            .iter()
            .filter(|a| (from..to).contains(&a.0))
            .copied()
            .collect();
        self.atomize(&mut edited, units, &text.spans, styles, &map, from..to);
        let new_after = edited.len();
        edited.extend(atoms[old_after..].iter().map(|a| Atom {
            start: moved(a.start),
            end: moved(a.end),
            style: (i64::from(a.style) + style_shift) as u16,
            ..a.clone()
        }));
        Some((
            edited.into(),
            Some(Base {
                lines: Rc::clone(&old.lines),
                first,
                old_after,
                new_after,
            }),
        ))
    }

    /// Lines of `p` at `max_width` (unbounded: `None`), kept with it: a
    /// measure, the baseline and the layout at one width break it once.
    fn break_lines(&self, p: &Prepared, max_width: Option<f32>) -> Rc<Broken> {
        let max = if p.no_wrap { None } else { max_width };
        let key = max.map(f32::to_bits);
        if let Some(broken) = p.lines.borrow().iter().find(|b| b.key == key) {
            return Rc::clone(broken);
        }
        let wide = max.is_some_and(|max| {
            p.atoms
                .iter()
                .any(|a| a.kind == AtomKind::Text && a.width > max + 0.01)
        });
        let broken = Rc::new(if wide {
            self.break_split(p, max, key)
        } else {
            Broken {
                key,
                split: None,
                lines: Self::break_atoms(p, max, key),
            }
        });
        let mut lines = p.lines.borrow_mut();
        if lines.len() >= WIDTHS {
            lines.remove(0);
        }
        lines.push(Rc::clone(&broken));
        broken
    }

    /// The lines of `p`'s atoms as they are (no word wider than a line):
    /// of an edit, the lines of the text it edits up to the first one the
    /// edit can change and from the first one that starts on the text
    /// after it as it started there before, and only those between broken
    /// again.
    fn break_atoms(p: &Prepared, max: Option<f32>, key: Option<u32>) -> Vec<LineBox> {
        let atoms = &p.atoms[..];
        let old = p.base.as_ref().and_then(|base| {
            let lines = base.lines.borrow();
            let old = lines.iter().find(|b| b.key == key && b.split.is_none())?;
            Some((base, Rc::clone(old)))
        });
        let Some((base, old)) = old else {
            let filled = wrap::fill_from(atoms, max, 0, |_| false);
            return Self::line_boxes(p, atoms, &filled);
        };
        // Lines that looked at nothing from the first changed atom on.
        let keep = old.lines.partition_point(|l| l.next < base.first);
        let from = old.lines.get(keep).map_or(0, |l| l.start);
        let shift = |i: usize| (i + base.new_after).wrapping_sub(base.old_after);
        // A line starting on the moved atoms (after the one before them,
        // which an empty line takes its height from) as one did before:
        // the lines from there are the ones before, moved.
        let resume = |start: usize| -> Option<usize> {
            if start <= base.new_after {
                return None;
            }
            let old_start = (start + base.old_after).checked_sub(base.new_after)?;
            let i = old.lines[keep..].partition_point(|l| l.start < old_start) + keep;
            (old.lines.get(i)?.start == old_start).then_some(i)
        };
        let filled = wrap::fill_from(atoms, max, from, |start| resume(start).is_some());
        let mut lines = Vec::with_capacity(old.lines.len() + filled.lines.len());
        lines.extend_from_slice(&old.lines[..keep]);
        lines.extend(Self::line_boxes(p, atoms, &filled));
        if let Some(i) = filled.stopped.and_then(resume) {
            lines.extend(old.lines[i..].iter().map(|l| LineBox {
                start: shift(l.start),
                end: shift(l.end),
                next: shift(l.next),
                ..*l
            }));
        }
        lines
    }

    /// The lines of `p` with words wider than a line split into
    /// characters.
    fn break_split(&self, p: &Prepared, max: Option<f32>, key: Option<u32>) -> Broken {
        // Words wider than a line are split into characters first.
        let mut atoms: Vec<Atom> = Vec::with_capacity(p.atoms.len());
        for atom in p.atoms.iter() {
            match max {
                Some(max) if atom.kind == AtomKind::Text && atom.width > max + 0.01 => {
                    let run = &p.styles[atom.style as usize];
                    let mut at = atom.start;
                    let mut from = 0;
                    // By cluster: a caret never stands inside one.
                    while from < atom.text.len() {
                        let to = next_cluster(&atom.text, from);
                        let (Some(cluster), true) = (atom.text.get(from..to), to > from) else {
                            break;
                        };
                        let len = u32::try_from(cluster.encode_utf16().count()).unwrap_or(0);
                        atoms.push(Atom {
                            width: self.run_width(run, cluster),
                            text: cluster.into(),
                            style: atom.style,
                            kind: AtomKind::Text,
                            start: at,
                            end: at + len,
                        });
                        at += len;
                        from = to;
                    }
                }
                _ => atoms.push(atom.clone()),
            }
        }
        let filled = wrap::fill_from(&atoms, max, 0, |_| false);
        let lines = Self::line_boxes(p, &atoms, &filled);
        Broken {
            key,
            split: Some(atoms),
            lines,
        }
    }

    /// The boxes of filled lines: their heights and baselines, from the
    /// metrics of the styles on each (of the previous atom's style for an
    /// empty line).
    fn line_boxes(p: &Prepared, atoms: &[Atom], filled: &wrap::Filled) -> Vec<LineBox> {
        filled
            .lines
            .iter()
            .zip(&filled.next)
            .map(|(line, &next)| {
                let end = line.end;
                let mut height = 0.0f32;
                let mut above = 0.0f32;
                // Below the baseline, and whether an attachment reaches below
                // it or above the text (the line is then as tall as its
                // extents, as a replaced inline box grows a CSS line; lines
                // of attachments on the baseline that fit keep their height).
                let mut below = 0.0f32;
                let mut reaches_below = false;
                let mut text_above = 0.0f32;
                let mut attachment_above = 0.0f32;
                let range = if line.start < end {
                    line.start..end
                } else {
                    end.saturating_sub(1)..end.min(atoms.len())
                };
                for atom in &atoms[range] {
                    let s = &p.styles[atom.style as usize];
                    let (h, lead) = s.line();
                    height = height.max(h);
                    above = above.max(lead + s.ascent);
                    text_above = text_above.max(lead + s.ascent);
                    below = below.max(h - lead - s.ascent);
                    if let AtomKind::Attachment(_, _, up, down) = atom.kind {
                        above = above.max(up);
                        attachment_above = attachment_above.max(up);
                        height = height.max(up + down);
                        below = below.max(down);
                        reaches_below |= down > 0.0;
                    }
                }
                if reaches_below || attachment_above > text_above {
                    height = height.max(above + below);
                }
                if height == 0.0 && !p.styles.is_empty() {
                    let s = &p.styles[0];
                    let (h, lead) = s.line();
                    height = h;
                    above = lead + s.ascent;
                }
                LineBox {
                    start: line.start,
                    end,
                    next,
                    width: line.width,
                    height,
                    above,
                }
            })
            .collect()
    }
}

impl TextEngine for WebTextEngine {
    type Prepared = Prepared;

    fn prepare(&self, text: &AttributedText) -> Prepared {
        self.prepare_aligned(text, &nsh_core::AttachmentAlignments::default())
    }

    fn prepare_aligned(
        &self,
        text: &AttributedText,
        alignments: &nsh_core::AttachmentAlignments,
    ) -> Prepared {
        let mut styles: Vec<RunStyle> = Vec::with_capacity(text.spans.len());
        // UTF-16 offset -> attachment: width, top above the baseline,
        // extent above and below it.
        let mut attachments: Vec<(u32, AttachmentBox)> = text
            .attachments
            .iter()
            .map(|a| {
                let font = if alignments.get(a.index) == nsh_core::VerticalAlign::Baseline {
                    nsh_core::FontExtent::default()
                } else {
                    let style = text
                        .span_at(a.index)
                        .map_or_else(Default::default, |s| s.style);
                    let css: Arc<str> = css_font(&style).into();
                    let size = style.font_size.0;
                    let (ascent, descent) = self.metrics(&css, size);
                    nsh_core::FontExtent::new(
                        Points(ascent),
                        Points(descent),
                        Points(self.x_height(&css, size)),
                    )
                };
                let (up, down) = alignments.extent(a, font);
                (
                    a.index,
                    (a.width.0, alignments.ascent(a, font).0, up.0, down.0),
                )
            })
            .collect();
        attachments.sort_by_key(|&(index, _)| index);
        let units: Vec<u16> = text.text.encode_utf16().collect();
        for span in &text.spans {
            let style = span.style;
            let font: Arc<str> = css_font(&style).into();
            let numeric: Option<Arc<str>> =
                font_variant_numeric(style.font_variant).map(Into::into);
            let (ascent, descent) = self.metrics(&font, style.font_size.0);
            styles.push(RunStyle {
                style,
                font,
                numeric,
                ascent,
                descent,
            });
        }
        let edit = self.edit_of_recent(&units, text, &attachments, &styles);
        let (atoms, base) = match edit {
            Some(edit) => edit,
            None => {
                let mut atoms = Vec::new();
                let attachments = attachments.iter().copied().collect();
                self.atomize(
                    &mut atoms,
                    &units,
                    &text.spans,
                    &styles,
                    &attachments,
                    0..units.len() as u32,
                );
                (atoms.into(), None)
            }
        };
        let lines = LinesCache::default();
        if units.len() >= RECENT_MIN_UNITS {
            let mut recent = self.recent.borrow_mut();
            if recent.len() >= RECENT {
                recent.remove(0);
            }
            recent.push(Recent {
                units,
                spans: text
                    .spans
                    .iter()
                    .map(|s| (s.start, s.end, s.style))
                    .collect(),
                attachments,
                atoms: Rc::clone(&atoms),
                lines: Rc::clone(&lines),
            });
        }
        if styles.is_empty() {
            let style = ResolvedTextStyle::default();
            let font: Arc<str> = css_font(&style).into();
            let (ascent, descent) = self.metrics(&font, style.font_size.0);
            styles.push(RunStyle {
                style,
                font,
                numeric: None,
                ascent,
                descent,
            });
        }
        Prepared {
            atoms,
            lines,
            base,
            styles: styles.into(),
            align: text.align,
            max_lines: text.max_lines,
            ellipsize: text.ellipsize,
            no_wrap: text.no_wrap,
            rtl: text.writing_direction.unwrap_or(text.rtl),
            links: text.links.iter().map(|l| (l.start, l.end)).collect(),
        }
    }

    fn measure(&self, prepared: &Prepared, max_width: Option<Points>) -> Size<Points> {
        let max_width = max_width.map(|m| m.0);
        let broken = self.break_lines(prepared, max_width);
        let lines = &broken.lines;
        let shown = match prepared.max_lines {
            0 => lines.len(),
            n => lines.len().min(n as usize),
        };
        let lines = &lines[..shown];
        let mut width = lines.iter().fold(0.0f32, |w, l| w.max(l.width));
        // A clamp's last line inside its paragraph holds the rest of it,
        // cut at the box (`layout`).
        if shown < broken.lines.len()
            && prepared.ellipsize != EllipsizeMode::Clip
            && let (Some(max), Some(last)) = (max_width, lines.last())
            && broken
                .atoms(prepared)
                .get(last.end)
                .is_some_and(|a| a.kind != AtomKind::Newline)
        {
            width = max;
        }
        let height: f32 = lines.iter().map(|l| l.height).sum();
        let width = match max_width {
            Some(max) => width.min(max),
            None => width,
        };
        Size::new(Points(width.ceil()), Points(height.ceil()))
    }

    fn first_baseline(&self, prepared: &Prepared, width: Points) -> Option<Points> {
        // `layout` puts the first line's baseline its tallest ascent (with
        // half-leading) below the top.
        self.break_lines(prepared, Some(width.0))
            .lines
            .first()
            .map(|line| Points(line.above))
    }

    fn layout(&self, prepared: &Prepared, size: Size<Points>) -> TextLayout {
        let broken = self.break_lines(prepared, Some(size.width.0));
        let atoms = broken.atoms(prepared);
        let mut lines = &broken.lines[..];
        let mut truncated = false;
        if prepared.max_lines > 0 && lines.len() > prepared.max_lines as usize {
            lines = &lines[..prepared.max_lines as usize];
            truncated = true;
        }
        let styles = prepared.styles.clone();
        let mut runs: Vec<Run> = Vec::new();
        let mut backgrounds = Vec::new();
        let mut line_pieces = Vec::new();
        let mut hit_lines = Vec::with_capacity(lines.len());
        let mut text_lines = Vec::with_capacity(lines.len());
        let mut attachments = vec![
            None;
            atoms
                .iter()
                .filter(|a| matches!(a.kind, AtomKind::Attachment(..)))
                .count()
        ];
        let mut attachment_index = 0;
        let mut y = 0.0f32;
        let count = lines.len();
        for (n, line) in lines.iter().enumerate() {
            let last = n + 1 == count;
            let clamped = last && truncated && prepared.ellipsize != EllipsizeMode::Clip;
            // The last line a clamp shows holds the rest of its paragraph
            // and is cut at the box, as CoreText, Pango and StaticLayout
            // cut it: ending it where it broke would leave the ellipsis
            // after a word that fit and the box empty past it.
            let line = &if clamped {
                LineBox {
                    end: paragraph_end(atoms, line.end),
                    ..*line
                }
            } else {
                *line
            };
            // Atoms of the line, without trailing spaces.
            let mut end = line.end;
            while end > line.start && atoms[end - 1].kind == AtomKind::Space {
                end -= 1;
            }
            let mut pieces: Vec<Part> = atoms[line.start..end]
                .iter()
                .map(|a| Part {
                    text: a.text.clone(),
                    style: a.style,
                    width: a.width,
                    kind: a.kind,
                    start: a.start,
                    ellipsis: false,
                })
                .collect();
            let mut width = if clamped {
                pieces.iter().map(|p| p.width).sum()
            } else {
                line.width
            };
            // Not drawn, but a caret after them stands past them: the line
            // reports them in its width, as CoreText's lines do.
            let mut hanging: f32 = atoms[end..line.end].iter().map(|a| a.width).sum();
            if clamped {
                hanging = 0.0;
                let style = pieces.last().map_or(0, |p| p.style);
                let ellipsis = self.run_width(&styles[style as usize], "…");
                let fits = |width: f32| width + ellipsis <= size.width.0 + 0.01;
                // Pieces wholly past the box go at once (the line can hold
                // a long paragraph); the one the box ends in loses
                // characters from its end until the ellipsis fits.
                while !fits(width)
                    && let Some(mut piece) = pieces.pop()
                {
                    width -= piece.width;
                    if fits(width) && piece.kind == AtomKind::Text {
                        let run = &styles[piece.style as usize];
                        let s: &str = &piece.text;
                        let mut ends = Vec::new();
                        let mut pos = 0;
                        while let Some((next, _, _)) = step_cluster(s, pos) {
                            if next >= s.len() {
                                break;
                            }
                            ends.push(next);
                            pos = next;
                        }
                        let found = if ends.len() > 16 && run.style.letter_spacing.0 >= 0.0 {
                            // Long unbroken tokens (URLs, hashes): binary-search
                            // cluster boundaries so WASM crosses FFI O(log K) times.
                            let keep = ends.partition_point(|&end| {
                                let trimmed = s[..end].trim_end();
                                trimmed.is_empty() || fits(width + self.run_width(run, trimmed))
                            });
                            keep.checked_sub(1).and_then(|i| {
                                let trimmed = s[..ends[i]].trim_end();
                                (!trimmed.is_empty()).then(|| {
                                    let w = self.run_width(run, trimmed);
                                    (trimmed, w)
                                })
                            })
                        } else {
                            ends.iter().rev().find_map(|&end| {
                                let trimmed = s[..end].trim_end();
                                (!trimmed.is_empty()).then(|| {
                                    let w = self.run_width(run, trimmed);
                                    fits(width + w).then_some((trimmed, w))
                                })?
                            })
                        };
                        if let Some((trimmed, w)) = found {
                            piece.text = trimmed.into();
                            piece.width = w;
                            width += w;
                            pieces.push(piece);
                            break;
                        }
                    }
                }
                // Trailing spaces before the ellipsis go.
                while let Some(space) = pieces.pop_if(|p| p.kind == AtomKind::Space) {
                    width -= space.width;
                }
                pieces.push(Part {
                    text: "…".into(),
                    style,
                    width: ellipsis,
                    kind: AtomKind::Text,
                    start: 0,
                    ellipsis: true,
                });
                width += ellipsis;
            }
            let free = (size.width.0 - width).max(0.0);
            let align = match prepared.align {
                TextAlign::Auto | TextAlign::Justify if prepared.rtl => TextAlign::Right,
                TextAlign::Auto | TextAlign::Justify => TextAlign::Left,
                a => a,
            };
            let mut x = match align {
                TextAlign::Center => free / 2.0,
                TextAlign::Right => free,
                _ => 0.0,
            };
            let x0 = x;
            let baseline = y + line.above;
            // Neighbouring pieces of one style draw as one run.
            let mut merge = false;
            line_pieces.clear();
            let mut hit_parts: Vec<HitPart> = Vec::with_capacity(pieces.len());
            for part in pieces {
                let Part {
                    text,
                    style,
                    width: w,
                    kind,
                    start,
                    ellipsis,
                } = part;
                let s = &styles[style as usize];
                let attachment = matches!(kind, AtomKind::Attachment(..));
                line_pieces.push(nsh_core::LinePiece {
                    x: Points(x),
                    width: Points(w),
                    background: s.style.background,
                    ascent: Points(if attachment { 0.0 } else { s.ascent }),
                    descent: Points(if attachment { 0.0 } else { s.descent }),
                });
                if let AtomKind::Attachment(_, top, ..) = kind {
                    if let Some(slot) = attachments.get_mut(attachment_index) {
                        *slot = Some((x, baseline - top));
                    }
                    attachment_index += 1;
                    hit_parts.push(HitPart {
                        x,
                        width: w,
                        style,
                        start,
                        text: None,
                    });
                    x += w;
                    merge = false;
                    continue;
                }
                let s = &styles[style as usize];
                let len = text.len();
                let index = runs.len();
                let (run, byte) = match runs.last_mut() {
                    Some(r) if merge && r.style == style => {
                        let byte = r.text.len();
                        r.text.push_str(&text);
                        r.ellipsis |= ellipsis;
                        (index.saturating_sub(1), byte)
                    }
                    _ => {
                        let natural = s.ascent + s.descent;
                        runs.push(Run {
                            line_height: ((line.height - natural).abs() > 0.01)
                                .then_some(line.height),
                            x,
                            y: baseline - s.ascent,
                            text: text.to_string(),
                            style,
                            start: (!ellipsis).then_some(start),
                            links: Vec::new(),
                            ellipsis,
                            after: String::new(),
                        });
                        (index, 0)
                    }
                };
                if !ellipsis {
                    if let Some(last) = hit_parts.last_mut()
                        && let Some(previous) = &mut last.text
                        && previous.run == run
                        && previous.byte + previous.len == byte
                    {
                        previous.len += len;
                        last.width += w;
                    } else {
                        hit_parts.push(HitPart {
                            x,
                            width: w,
                            style,
                            start,
                            text: Some(RunText { run, byte, len }),
                        });
                    }
                }
                merge = true;
                x += w;
            }
            let range = (Points(x0), Points(x0 + width));
            nsh_core::BackgroundBox::join(line_pieces.drain(..), range, |b| {
                backgrounds.push(Background {
                    x: b.x.0,
                    y: baseline - b.ascent.0,
                    width: b.width.0,
                    height: (b.ascent + b.descent).0,
                    radius: b.radius().0,
                    color: b.background.color,
                });
            });
            if !last && let Some(run) = runs.last_mut() {
                // An empty line adds its newline to the one before.
                match atoms.get(line.end) {
                    Some(a) if a.kind == AtomKind::Newline => run.after.push('\n'),
                    _ => atoms[end..line.end]
                        .iter()
                        .for_each(|a| run.after.push_str(&a.text)),
                }
            }
            let first = &styles[atoms.get(line.start).map_or(0, |a| a.style) as usize];
            // An empty line (a break right after another, or after the last
            // one) starts where the break before it ended.
            let start = atoms.get(line.start).map_or_else(
                || {
                    line.start
                        .checked_sub(1)
                        .and_then(|i| atoms.get(i))
                        .map_or(0, |a| a.end)
                },
                |a| a.start,
            );
            // Before the break character, never after it.
            let line_end = match line.end.checked_sub(1).and_then(|i| atoms.get(i)) {
                Some(a) if line.end > line.start => a.end,
                _ => start,
            };
            text_lines.push(TextLine {
                text: String::new(),
                start,
                end: line_end,
                x: Points(x0),
                y: Points(y),
                width: Points(width + hanging),
                height: Points(line.height),
                ascender: Points(first.ascent),
                descender: Points(first.descent),
                cap_height: first.style.font_size * 0.7,
                x_height: first.style.font_size * 0.5,
            });
            hit_lines.push(HitLine {
                parts: hit_parts,
                stops: OnceLock::new(),
            });
            y += line.height;
        }
        if !prepared.links.is_empty() {
            for run in &mut runs {
                if let Some(start) = run.start {
                    let text = match run.ellipsis {
                        true => run.text.strip_suffix('…').unwrap_or(&run.text),
                        false => &run.text,
                    };
                    run.links = link_parts(&prepared.links, start, text);
                }
            }
        }
        TextLayout(Arc::new(WebLayout {
            runs,
            backgrounds,
            styles,
            lines: text_lines,
            hit: hit_lines,
            attachments,
        }))
    }

    fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
        layout
            .downcast::<WebLayout>()
            .map_or_else(Vec::new, |l| l.lines.clone())
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<nsh_core::Point<Points>>> {
        layout.downcast::<WebLayout>().map_or_else(Vec::new, |l| {
            l.attachments
                .iter()
                .map(|a| a.map(|(x, y)| nsh_core::geometry::point(Points(x), Points(y))))
                .collect()
        })
    }

    fn hit_test(&self, layout: &TextLayout, point: Point<Points>) -> TextPosition {
        let Some(l) = layout.downcast::<WebLayout>() else {
            return TextPosition::default();
        };
        hit::hit_test(&l.lines, |i| self.stops(l, i), point)
    }

    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        let l = layout.downcast::<WebLayout>()?;
        hit::caret_rect(&l.lines, |i| self.stops(l, i), position)
    }

    fn range_rects(&self, layout: &TextLayout, range: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        let Some(l) = layout.downcast::<WebLayout>() else {
            return;
        };
        hit::range_rects(&l.lines, |i| self.stops(l, i), range, out);
    }

    fn register_font(&self, data: &[u8]) -> Result<(), String> {
        let face = ttf_parser::Face::parse(data, 0).map_err(|e| e.to_string())?;
        let name = |id| {
            face.names()
                .into_iter()
                .filter(|n| n.name_id == id && n.is_unicode())
                .find_map(|n| n.to_string())
        };
        let family = name(ttf_parser::name_id::TYPOGRAPHIC_FAMILY)
            .or_else(|| name(ttf_parser::name_id::FAMILY))
            .ok_or("the font has no family name")?;
        let (min, max) = weight_range(&face);
        ffi::register_font(&family, data, min, max, face.is_italic());
        // Widths measured with a fallback font are stale now (and again
        // when the face finishes loading: `nsh_fonts_loaded`).
        self.clear_caches();
        Ok(())
    }
}

/// Canvas drawings use the same font and numeric-variant measurements as text.
#[cfg(feature = "browser-core")]
pub(crate) fn canvas_width(font: &nsh_core::canvas::CanvasFont, text: &str) -> f32 {
    let css = crate::canvas::font(font);
    match css::font_variant_numeric(font.variant) {
        Some(numeric) => ffi::measure_numeric_text(&css, &numeric, text),
        None => ffi::measure_text(&css, text),
    }
}

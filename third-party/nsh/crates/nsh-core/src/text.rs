use std::{
    any::Any,
    fmt,
    hash::{Hash, Hasher},
    ops::Range,
    sync::Arc,
};

use rustc_hash::FxHashMap;

use crate::{
    geometry::{Bounds, Point, Points, Size, point, px, size},
    ops::{EventMask, NodeId},
    style::{
        Color, DecorationStyle, EllipsizeMode, FontFamily, FontVariant, TextAlign, TextDecoration,
        TextShadow, TextStyle, TextTransform, VerticalAlign,
    },
};

/// Fully resolved character style of a text run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedTextStyle {
    /// Foreground color.
    pub color: Color,
    /// Font size.
    pub font_size: Points,
    /// Font weight, `100..=900`.
    pub font_weight: u16,
    /// Line height; zero means the font's natural line height.
    pub line_height: Points,
    /// Font family; `None` is the system font.
    pub font_family: Option<FontFamily>,
    /// Italic.
    pub italic: bool,
    /// Extra space between characters.
    pub letter_spacing: Points,
    /// A line height set as a multiple of the font size (0: none), kept
    /// so nested text with another size gets its own line height.
    pub line_height_multiple: f32,
    /// Underline / strikethrough.
    pub decoration: TextDecoration,
    /// Color of the decoration lines; `None` uses `color`.
    pub decoration_color: Option<Color>,
    /// How the decoration lines are drawn.
    pub decoration_style: DecorationStyle,
    /// Thickness of the decoration lines; `None` is the font's.
    pub decoration_thickness: Option<Points>,
    /// Distance of the underline below the baseline; `None` is the font's.
    pub underline_offset: Option<Points>,
    /// Case transform (applied by the core when building the text).
    pub transform: TextTransform,
    /// OpenType features (`fontVariant`).
    pub font_variant: FontVariant,
    /// The background of the nested text this run is in (drawing only).
    pub background: Option<TextBackground>,
}

/// The background of a nested `<Text>` (`backgroundColor` and
/// `borderRadius` on a span): drawing only, behind its characters and
/// those of the spans inside it, on each line it reaches as the font's
/// ascent to descent around the baseline (as CSS paints inline boxes),
/// every line's box rounded alike (`box-decoration-break: clone`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextBackground {
    /// Fill color (never fully transparent).
    pub color: Color,
    /// Corner radius.
    pub radius: Points,
    /// The span that set it, so neighboring spans that look the same still
    /// get a box each.
    pub node: NodeId,
}

/// A piece of a laid out line, in visual order, for
/// [`BackgroundBox::join`]: a cluster, glyph or run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LinePiece {
    /// Left edge.
    pub x: Points,
    /// Advance.
    pub width: Points,
    /// The background of its characters
    /// ([`AttributedText::background_at`]).
    pub background: Option<TextBackground>,
    /// Its font's ascent above the baseline (0 for an attachment).
    pub ascent: Points,
    /// Its font's descent below the baseline.
    pub descent: Points,
}

/// One box of a span's background on one line (see
/// [`BackgroundBox::join`]).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackgroundBox {
    /// Left edge, in the coordinates of the pieces.
    pub x: Points,
    /// Width.
    pub width: Points,
    /// Top, above the baseline: the tallest ascent of its pieces.
    pub ascent: Points,
    /// Bottom, below the baseline.
    pub descent: Points,
    /// What fills it.
    pub background: TextBackground,
}

impl BackgroundBox {
    /// Calls `f` with the boxes of span backgrounds on one line, given its
    /// `pieces` in visual order: neighboring pieces of one background join
    /// into one box, cut to `(left, right)` (whitespace hanging past the
    /// line's end is not painted).
    pub fn join(
        pieces: impl IntoIterator<Item = LinePiece>,
        (left, right): (Points, Points),
        mut f: impl FnMut(BackgroundBox),
    ) {
        let mut current: Option<BackgroundBox> = None;
        let mut emit = |b: Option<BackgroundBox>| {
            if let Some(mut b) = b {
                let x1 = (b.x + b.width).min(right);
                b.x = b.x.max(left);
                b.width = x1 - b.x;
                if b.width > Points::ZERO && b.ascent + b.descent > Points::ZERO {
                    f(b);
                }
            }
        };
        for p in pieces {
            let Some(background) = p.background else {
                emit(current.take());
                continue;
            };
            match &mut current {
                Some(b) if b.background == background => {
                    b.width = (p.x + p.width).max(b.x + b.width) - b.x;
                    b.ascent = b.ascent.max(p.ascent);
                    b.descent = b.descent.max(p.descent);
                }
                _ => {
                    emit(current.take());
                    current = Some(BackgroundBox {
                        x: p.x,
                        width: p.width,
                        ascent: p.ascent,
                        descent: p.descent,
                        background,
                    });
                }
            }
        }
        emit(current);
    }

    /// The radius of its corners: the background's, at most half its
    /// width or height.
    pub fn radius(&self) -> Points {
        self.background
            .radius
            .min(self.width / 2.0)
            .min((self.ascent + self.descent) / 2.0)
            .max(Points::ZERO)
    }
}

impl Default for ResolvedTextStyle {
    /// React Native defaults.
    fn default() -> Self {
        Self {
            color: Color::BLACK,
            font_size: px(14.0),
            font_weight: 400,
            line_height: Points::ZERO,
            font_family: None,
            italic: false,
            letter_spacing: Points::ZERO,
            decoration: TextDecoration {
                underline: false,
                line_through: false,
            },
            decoration_color: None,
            decoration_style: DecorationStyle::Solid,
            decoration_thickness: None,
            underline_offset: None,
            line_height_multiple: 0.0,
            transform: TextTransform::None,
            font_variant: FontVariant(0),
            background: None,
        }
    }
}

impl ResolvedTextStyle {
    /// Applies the properties set on a node on top of the inherited style.
    #[inline]
    pub(crate) fn inherit(self, style: &TextStyle) -> Self {
        let font_size = style.font_size.unwrap_or(self.font_size);
        // A multiple follows each nested font size (unitless CSS
        // line-height); points stay points.
        let (line_height, line_height_multiple) = match (
            style.line_height_multiple,
            style.line_height,
            style.line_height_em,
        ) {
            (_, _, Some(em)) => (em * font_size, 0.0),
            (Some(m), _, _) => (m * font_size, m),
            (None, Some(points), _) => (points, 0.0),
            (None, None, _) if self.line_height_multiple > 0.0 => (
                self.line_height_multiple * font_size,
                self.line_height_multiple,
            ),
            (None, None, _) => (self.line_height, 0.0),
        };
        Self {
            color: style.color.unwrap_or(self.color),
            font_size,
            font_weight: style.font_weight.unwrap_or(self.font_weight),
            line_height,
            line_height_multiple,
            font_family: style.font_family.or(self.font_family),
            italic: style.italic.unwrap_or(self.italic),
            // Ems are of the node's own font size, then inherited as points.
            letter_spacing: match style.letter_spacing_em {
                Some(em) => em * font_size,
                None => style.letter_spacing.unwrap_or(self.letter_spacing),
            },
            decoration: style.decoration.unwrap_or(self.decoration),
            decoration_color: style.decoration_color.or(self.decoration_color),
            decoration_style: style.decoration_style.unwrap_or(self.decoration_style),
            decoration_thickness: style.decoration_thickness.or(self.decoration_thickness),
            underline_offset: style.underline_offset.or(self.underline_offset),
            transform: style.transform.unwrap_or(self.transform),
            font_variant: style.font_variant.unwrap_or(self.font_variant),
            background: self.background,
        }
    }

    /// True if both styles produce the same glyph metrics (colors and
    /// decorations ignored).
    #[inline]
    fn layout_eq(&self, other: &Self) -> bool {
        self.font_size == other.font_size
            && self.font_weight == other.font_weight
            && self.line_height == other.line_height
            && self.font_family == other.font_family
            && self.italic == other.italic
            && self.letter_spacing == other.letter_spacing
            && self.font_variant == other.font_variant
    }
}

/// A run of characters with one style.
///
/// Offsets are in UTF-16 code units, which is what both Apple
/// (`NSAttributedString`) and Android (`Spannable`) text APIs index by.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextSpan {
    /// Start offset (UTF-16 units, inclusive).
    pub start: u32,
    /// End offset (UTF-16 units, exclusive).
    pub end: u32,
    /// Style of the run.
    pub style: ResolvedTextStyle,
}

/// The merged content of a `<text>` block: its own text plus all nested
/// spans and raw text nodes, flattened into one string with style runs.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AttributedText {
    /// The full string.
    pub text: String,
    /// Non-overlapping, sorted style runs covering `text`.
    pub spans: Vec<TextSpan>,
    /// Paragraph alignment.
    pub align: TextAlign,
    /// Maximum number of lines; 0 means no limit (`numberOfLines`).
    pub max_lines: u32,
    /// How text beyond `max_lines` is cut.
    pub ellipsize: EllipsizeMode,
    /// Lines never wrap (`whitespace-nowrap`): measured at their natural
    /// width, overflowing the box.
    pub no_wrap: bool,
    /// Shadow behind the whole block (drawing only, not layout).
    pub shadow: Option<TextShadow>,
    /// Nested `<text>` spans that take presses (they may nest).
    pub links: Vec<TextLink>,
    /// Nested `<Text>` spans with a `testID` (they may nest). Platforms
    /// draw nothing from them. Tests name a span by its id.
    pub test_ids: Vec<SpanTestId>,
    /// `writingDirection`: right to left (`Some(true)`), left to right, or
    /// from the content (`None`).
    pub writing_direction: Option<bool>,
    /// The block is laid out right to left: `auto` alignment is the right
    /// side.
    pub rtl: bool,
    /// A long press copies the text (`selectable` or `select-text`;
    /// drawing only): `Some(false)` when set off, `None` when not set, which
    /// is not selectable except where text is by default (desktop
    /// browsers). [`is_selectable`](Self::is_selectable) is whether it is asked for.
    pub selectable: Option<bool>,
    /// The highlight of the selection of selectable text (`selectionColor`);
    /// the platform's tint when `None`.
    pub selection_color: Option<Color>,
    /// Inline views and images, in text order: each is an object
    /// replacement character (U+FFFC) the engine gives the attachment's
    /// size. Their optional alignment is passed separately to
    /// `TextEngine::prepare_aligned`; `prepare` places them on the baseline.
    pub attachments: Vec<TextAttachment>,
}

/// A view or image inside a text block (see
/// [`AttributedText::attachments`]).
///
/// Optional placement is held by [`AttachmentAlignments`], leaving this
/// struct's three-field construction compatible with existing engines.
/// Every engine places it with the same rule: its top
/// [`ascent`](Self::ascent) above the baseline, the line reserving its
/// [`extent`](Self::extent) (so a line grows where the attachment reaches
/// past the font around it). Only the font's metrics are the platform's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextAttachment {
    /// Its placeholder character (UTF-16 offset).
    pub index: u32,
    /// Width.
    pub width: Points,
    /// Height.
    pub height: Points,
}

/// The vertical metrics of the font around an attachment (the style of
/// its placeholder), which [`TextAttachment::ascent`] places it against.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
#[non_exhaustive]
pub struct FontExtent {
    /// Above the baseline (positive).
    pub ascent: Points,
    /// Below the baseline (positive).
    pub descent: Points,
    /// Height of lowercase letters.
    pub x_height: Points,
}

impl FontExtent {
    /// A font's ascent, descent and x height.
    pub fn new(ascent: Points, descent: Points, x_height: Points) -> Self {
        Self {
            ascent,
            descent,
            x_height,
        }
    }
}

impl TextAttachment {
    /// The distance of its top above the baseline (negative: below it),
    /// in a line of `font`: CSS `vertical-align` for a replaced inline
    /// box. `baseline` needs no metrics (the height, whatever `font` is).
    pub fn ascent(&self, font: FontExtent, align: VerticalAlign) -> Points {
        let h = self.height;
        match align {
            VerticalAlign::Baseline => h,
            VerticalAlign::TextTop => font.ascent,
            VerticalAlign::TextBottom => h - font.descent,
            VerticalAlign::Middle => (h + font.x_height) / 2.0,
        }
    }

    /// What its line reserves for it above and below the baseline (each
    /// at least 0): with the font's own, the line's extent, so the line
    /// grows where the attachment reaches past the font. Engines give the
    /// placeholder these metrics (a run delegate's ascent and descent, a
    /// replacement span's font metrics) and draw its top
    /// [`ascent`](Self::ascent) above the baseline.
    pub fn extent(&self, font: FontExtent, align: VerticalAlign) -> (Points, Points) {
        let ascent = self.ascent(font, align);
        (
            ascent.max(Points::ZERO),
            (self.height - ascent).max(Points::ZERO),
        )
    }
}

/// Optional alignment of inline attachments, keyed by their UTF-16 offsets.
/// Kept separately so existing `TextAttachment` and `AttributedText` literals
/// and custom text engines remain source compatible.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
#[non_exhaustive]
pub struct AttachmentAlignments {
    values: Vec<(u32, VerticalAlign)>,
}

impl AttachmentAlignments {
    /// The alignment at `index`; unspecified attachments stand on the baseline.
    pub fn get(&self, index: u32) -> VerticalAlign {
        self.values
            .binary_search_by_key(&index, |v| v.0)
            .map_or(VerticalAlign::Baseline, |i| self.values[i].1)
    }

    /// Sets an attachment's alignment. Baseline needs no stored entry.
    pub fn set(&mut self, index: u32, align: VerticalAlign) {
        match self.values.binary_search_by_key(&index, |v| v.0) {
            Ok(i) if align == VerticalAlign::Baseline => {
                self.values.remove(i);
            }
            Ok(i) => self.values[i].1 = align,
            Err(i) if align != VerticalAlign::Baseline => self.values.insert(i, (index, align)),
            Err(_) => {}
        }
    }

    /// Appends an attachment and records its alignment.
    pub fn push(
        &mut self,
        text: &mut AttributedText,
        size: Size<Points>,
        align: VerticalAlign,
        style: ResolvedTextStyle,
    ) {
        self.set(text.len_utf16(), align);
        text.push_attachment(size, style);
    }

    /// Whether all attachments use the default baseline alignment.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// The text's layout hash including attachment alignment.
    pub fn layout_hash(&self, text: &AttributedText) -> u64 {
        if self.is_empty() {
            return text.layout_hash();
        }
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        text.layout_hash().hash(&mut h);
        self.hash(&mut h);
        h.finish()
    }
}

/// The character standing for an attachment.
pub const ATTACHMENT_CHAR: char = '\u{FFFC}';

/// A nested `<text>` span with press listeners: presses on its characters
/// go to it rather than to the block.
#[derive(Debug, Clone, PartialEq)]
pub struct TextLink {
    /// Start offset (UTF-16 units, inclusive).
    pub start: u32,
    /// End offset (UTF-16 units, exclusive).
    pub end: u32,
    /// The span's node.
    pub node: NodeId,
    /// Its listeners.
    pub events: EventMask,
    /// The span's native interaction and accessibility properties. A span
    /// has no view of its own; these travel with its character range.
    pub props: Arc<crate::ViewProps>,
}

impl TextLink {
    /// Whether the mounted span accepts native interaction.
    pub fn is_enabled(&self) -> bool {
        self.start < self.end
            && self.props.pointer_events != crate::PointerEvents::None
            && !self.props.accessibility.state.disabled
    }

    /// Whether the enabled span participates in keyboard traversal.
    pub fn is_tab_stop(&self) -> bool {
        self.is_enabled() && self.props.focusable != Some(false)
    }
}

/// A nested `<Text>` span with a `testID` ([`AttributedText::test_ids`]).
#[derive(Debug, Clone, PartialEq, Default)]
#[non_exhaustive]
pub struct SpanTestId {
    /// Start offset (UTF-16 units, inclusive).
    pub start: u32,
    /// End offset (UTF-16 units, exclusive).
    pub end: u32,
    /// Its `testID`.
    pub test_id: Arc<str>,
}

impl AttributedText {
    /// Whether the text was made selectable (`selectable`, `select-text`).
    pub fn is_selectable(&self) -> bool {
        self.selectable == Some(true)
    }

    /// Whether a span has a background ([`TextBackground`]).
    pub fn has_backgrounds(&self) -> bool {
        self.spans.iter().any(|s| s.style.background.is_some())
    }

    /// The span containing the UTF-16 offset `index` (the last one past the
    /// end).
    pub fn span_at(&self, index: u32) -> Option<&TextSpan> {
        let i = self.spans.partition_point(|s| s.end <= index);
        self.spans.get(i.min(self.spans.len().saturating_sub(1)))
    }

    /// The background of the character at the UTF-16 offset `index`.
    pub fn background_at(&self, index: u32) -> Option<TextBackground> {
        self.span_at(index)?.style.background
    }

    /// Length of the text so far, in UTF-16 units.
    pub fn len_utf16(&self) -> u32 {
        self.spans.last().map_or(0, |s| s.end)
    }

    /// The innermost link containing the UTF-16 offset `index`.
    pub fn link_at(&self, index: u32) -> Option<&TextLink> {
        self.links
            .iter()
            .filter(|l| index >= l.start && index < l.end)
            .min_by_key(|l| l.end - l.start)
    }

    /// Appends an attachment of `size` on the baseline.
    pub fn push_attachment(&mut self, size: Size<Points>, style: ResolvedTextStyle) {
        let index = self.len_utf16();
        self.push(ATTACHMENT_CHAR.encode_utf8(&mut [0; 3]), style);
        self.attachments.push(TextAttachment {
            index,
            width: size.width,
            height: size.height,
        });
    }

    /// Appends `s` with `style`, merging with the previous run when the
    /// style is identical.
    pub fn push(&mut self, s: &str, style: ResolvedTextStyle) {
        if s.is_empty() {
            return;
        }
        let s = &*style.transform.apply(s);
        let len = s.encode_utf16().count() as u32;
        self.text.push_str(s);
        match self.spans.last_mut() {
            Some(last) if last.style == style => last.end += len,
            last => {
                let start = last.map_or(0, |l| l.end);
                self.spans.push(TextSpan {
                    start,
                    end: start + len,
                    style,
                });
            }
        }
    }

    /// Equality of the content the platform draws, excluding test metadata.
    pub(crate) fn rendering_eq(&self, other: &Self) -> bool {
        // Enumerating the fields makes additions revisit this comparison.
        let Self {
            text,
            spans,
            align,
            max_lines,
            ellipsize,
            no_wrap,
            shadow,
            links,
            writing_direction,
            rtl,
            selectable,
            selection_color,
            attachments,
            test_ids: _,
        } = self;
        text == &other.text
            && spans == &other.spans
            && align == &other.align
            && max_lines == &other.max_lines
            && ellipsize == &other.ellipsize
            && no_wrap == &other.no_wrap
            && shadow == &other.shadow
            && links == &other.links
            && writing_direction == &other.writing_direction
            && rtl == &other.rtl
            && selectable == &other.selectable
            && selection_color == &other.selection_color
            && attachments == &other.attachments
    }

    /// True if both texts lay out identically: same characters, runs,
    /// metrics and alignment. Decorative attributes (colors) are ignored.
    pub fn layout_eq(&self, other: &Self) -> bool {
        self.align == other.align
            && self.writing_direction == other.writing_direction
            && self.rtl == other.rtl
            && self.max_lines == other.max_lines
            && self.ellipsize == other.ellipsize
            && self.no_wrap == other.no_wrap
            && self.text == other.text
            && self.attachments == other.attachments
            && self.spans.len() == other.spans.len()
            && self
                .spans
                .iter()
                .zip(&other.spans)
                .all(|(a, b)| a.start == b.start && a.end == b.end && a.style.layout_eq(&b.style))
    }

    /// A 64-bit hash of everything [`AttributedText::layout_eq`] compares.
    /// SipHash (not Fx): it keys a cache without a full equality check.
    pub fn layout_hash(&self) -> u64 {
        let mut h = std::hash::DefaultHasher::new();
        self.text.hash(&mut h);
        (self.align as u8, self.writing_direction, self.rtl).hash(&mut h);
        (self.max_lines, self.ellipsize, self.no_wrap).hash(&mut h);
        for s in &self.spans {
            (s.start, s.end, s.style.font_weight).hash(&mut h);
            (s.style.font_family, s.style.italic, s.style.font_variant).hash(&mut h);
            s.style.font_size.0.to_bits().hash(&mut h);
            s.style.line_height.0.to_bits().hash(&mut h);
            s.style.letter_spacing.0.to_bits().hash(&mut h);
        }
        for a in &self.attachments {
            (a.index, a.width.0.to_bits(), a.height.0.to_bits()).hash(&mut h);
        }
        h.finish()
    }
}

/// An immutable, fully laid out text produced by a [`TextEngine`] on the
/// engine thread and drawn as-is by the platform on the UI thread, so text
/// is typeset exactly once.
#[derive(Clone)]
pub struct TextLayout(pub Arc<dyn Any + Send + Sync>);

impl TextLayout {
    /// Returns the platform layout object.
    pub fn downcast<T: Any>(&self) -> Option<&T> {
        self.0.downcast_ref()
    }
}

impl fmt::Debug for TextLayout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("TextLayout")
    }
}

/// The platform text engine (CoreText, Android `StaticLayout`, ...).
///
/// All methods run on the engine thread, so implementations must not touch
/// UI-thread-only objects. The split mirrors how native text stacks work:
/// typesetting state is prepared once per content, measured at any number
/// of widths during layout, and finally laid out once at the final size.
pub trait TextEngine {
    /// Typesetting state for one content, reused across measurements
    /// (e.g. a `CTFramesetter`).
    type Prepared;

    /// Prepares `text` for measuring and layout.
    fn prepare(&self, text: &AttributedText) -> Self::Prepared;

    /// Prepares text with optional inline alignment. Existing engines retain
    /// baseline placement until they opt into this extension.
    fn prepare_aligned(
        &self,
        text: &AttributedText,
        alignments: &AttachmentAlignments,
    ) -> Self::Prepared {
        let _ = alignments;
        self.prepare(text)
    }

    /// Size of the prepared text with an optional maximum width.
    fn measure(&self, prepared: &Self::Prepared, max_width: Option<Points>) -> Size<Points>;

    /// The final layout in a box of exactly `size`, for drawing.
    fn layout(&self, prepared: &Self::Prepared, size: Size<Points>) -> TextLayout;

    /// An optional Canvas-specific line advance in points.
    ///
    /// Backends whose Canvas fonts differ from their regular text geometry can
    /// measure with the same shaping used by Canvas drawing. Returning `None`
    /// keeps the default path through [`Self::prepare`] and [`Self::measure`].
    fn measure_canvas(&self, font: &crate::canvas::CanvasFont, text: &str) -> Option<Points> {
        let _ = (font, text);
        None
    }

    /// The lines of a final layout (`onTextLayout`); `text` is left empty
    /// (the core fills it in).
    fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
        let _ = layout;
        Vec::new()
    }

    /// Where a final layout put the text's attachments, in order: the
    /// top left of each placeholder in the content box (y down), or `None`
    /// when it was cut off (lines past the limit, an ellipsis).
    fn attachments(&self, layout: &TextLayout) -> Vec<Option<Point<Points>>> {
        let _ = layout;
        Vec::new()
    }

    /// The caret position nearest `point` (content box, y down) in a final
    /// layout: on the line at that height (the first line above the text,
    /// the last below it), at the character edge nearest its x. A point
    /// past the end of a wrapped line gives the line's end with
    /// [`Affinity::Upstream`], so the caret stays on that line.
    ///
    /// The default estimates it from [`TextEngine::lines`], each line's
    /// characters spread evenly over its width; engines that know where
    /// their glyphs are override it.
    fn hit_test(&self, layout: &TextLayout, point: Point<Points>) -> TextPosition {
        estimate::hit_test(&self.lines(layout), point)
    }

    /// The caret at `position` in a final layout: a box of no width as high
    /// as its line (content box, y down), at the edge of the characters
    /// `position` stands between; `None` when the layout has no lines.
    ///
    /// The default estimates it from [`TextEngine::lines`], as
    /// [`TextEngine::hit_test`] does.
    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        estimate::caret_rect(&self.lines(layout), position)
    }

    /// Appends to `out` the boxes (content box, y down) that cover the
    /// characters of `range` (UTF-16 offsets), line high: per line, one box
    /// per stretch of adjacent characters (several where bidirectional text
    /// splits the range), and through the line's end where the range goes
    /// on past it. `out` is the caller's, so a selection drawn every frame
    /// reuses one buffer.
    ///
    /// The default estimates them from [`TextEngine::lines`], as
    /// [`TextEngine::hit_test`] does.
    fn range_rects(&self, layout: &TextLayout, range: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        estimate::range_rects(&self.lines(layout), range, out);
    }

    /// Makes the font in `data` (TrueType / OpenType) available by its
    /// family name. Fonts are registered before the text using them is
    /// measured.
    fn register_font(&self, data: &[u8]) -> Result<(), String> {
        let _ = data;
        Err("this text engine does not support custom fonts".to_owned())
    }
}

/// A shared engine, e.g. one the core lays text out with and canvas
/// `measureText` measures with.
impl<T: TextEngine> TextEngine for std::rc::Rc<T> {
    type Prepared = T::Prepared;

    fn prepare(&self, text: &AttributedText) -> Self::Prepared {
        (**self).prepare(text)
    }

    fn prepare_aligned(
        &self,
        text: &AttributedText,
        alignments: &AttachmentAlignments,
    ) -> Self::Prepared {
        (**self).prepare_aligned(text, alignments)
    }

    fn measure(&self, prepared: &Self::Prepared, max_width: Option<Points>) -> Size<Points> {
        (**self).measure(prepared, max_width)
    }

    fn layout(&self, prepared: &Self::Prepared, size: Size<Points>) -> TextLayout {
        (**self).layout(prepared, size)
    }

    fn measure_canvas(&self, font: &crate::canvas::CanvasFont, text: &str) -> Option<Points> {
        (**self).measure_canvas(font, text)
    }

    fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
        (**self).lines(layout)
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<Point<Points>>> {
        (**self).attachments(layout)
    }

    fn hit_test(&self, layout: &TextLayout, point: Point<Points>) -> TextPosition {
        (**self).hit_test(layout, point)
    }

    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        (**self).caret_rect(layout, position)
    }

    fn range_rects(&self, layout: &TextLayout, range: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        (**self).range_rects(layout, range, out);
    }

    fn register_font(&self, data: &[u8]) -> Result<(), String> {
        (**self).register_font(data)
    }
}

/// One line of laid-out text (`onTextLayout`), in the content box (y
/// down, points).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TextLine {
    /// Its characters.
    pub text: String,
    /// Start offset in the text (UTF-16 units, inclusive).
    pub start: u32,
    /// End offset (UTF-16 units, exclusive).
    pub end: u32,
    /// Left edge.
    pub x: Points,
    /// Top edge.
    pub y: Points,
    /// Typographic width.
    pub width: Points,
    /// Height (ascender + descender + leading).
    pub height: Points,
    /// Above the baseline.
    pub ascender: Points,
    /// Below the baseline.
    pub descender: Points,
    /// Height of capitals.
    pub cap_height: Points,
    /// Height of lowercase letters.
    pub x_height: Points,
}

/// Which side a caret offset is on where one offset is two places on
/// screen: the end of a wrapped line and the start of the next.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Affinity {
    /// With the character before the offset: at the end of the earlier
    /// line.
    Upstream,
    /// With the character after the offset: at the start of the later
    /// line.
    #[default]
    Downstream,
}

/// A caret position in a text: a UTF-16 offset and the side it is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
#[non_exhaustive]
pub struct TextPosition {
    /// The offset (UTF-16 units).
    pub offset: u32,
    /// Which line it is on where it ends one and starts the next.
    pub affinity: Affinity,
}

impl TextPosition {
    /// The position at `offset` on the side `affinity` says.
    pub const fn new(offset: u32, affinity: Affinity) -> Self {
        Self { offset, affinity }
    }

    /// The index of the line of `lines` (a final layout's, in order) the
    /// caret at this position is on: the line holding the offset, the
    /// earlier of two for [`Affinity::Upstream`] at a line's end; past every
    /// line (the text's end, an empty last line), the last line starting at
    /// or before it. `None` when there are no lines.
    pub fn line(self, lines: &[TextLine]) -> Option<usize> {
        self.line_in(lines.iter().map(|l| l.start..l.end))
    }

    /// [`TextPosition::line`] over the UTF-16 ranges of the lines, for
    /// engines that keep their lines in a type of their own.
    pub fn line_in<I>(self, ranges: I) -> Option<usize>
    where
        I: IntoIterator<Item = Range<u32>>,
        I::IntoIter: Clone,
    {
        let ranges = ranges.into_iter();
        let o = self.offset;
        let holds = |r: &Range<u32>| match self.affinity {
            Affinity::Upstream => r.start < o && o <= r.end,
            Affinity::Downstream => r.start <= o && o < r.end,
        };
        ranges
            .clone()
            .position(|r| holds(&r))
            .or_else(|| {
                let starts = ranges.clone().enumerate();
                starts.filter(|(_, r)| r.start <= o).last().map(|(i, _)| i)
            })
            .or_else(|| ranges.clone().next().map(|_| 0))
    }
}

/// The hit testing of engines that only report their lines: each line's
/// characters spread evenly over its width, left to right.
mod estimate {
    use super::*;

    /// The line a point at height `y` lands on: the one at that height, the
    /// first above the text, the last below it.
    pub(super) fn line_at(lines: &[TextLine], y: Points) -> Option<&TextLine> {
        lines.iter().find(|l| y < l.y + l.height).or(lines.last())
    }

    /// The x of offset `o` (clamped to the line).
    fn x_of(l: &TextLine, o: u32) -> Points {
        let count = l.end.saturating_sub(l.start);
        if count == 0 {
            return l.x;
        }
        let done = o.clamp(l.start, l.end) - l.start;
        l.x + l.width * (done as f32 / count as f32)
    }

    pub(super) fn hit_test(lines: &[TextLine], p: Point<Points>) -> TextPosition {
        let Some(l) = line_at(lines, p.y) else {
            return TextPosition::default();
        };
        let count = l.end.saturating_sub(l.start);
        let fraction = if l.width > Points::ZERO {
            ((p.x - l.x) / l.width).clamp(0.0, 1.0)
        } else {
            0.0
        };
        // At most `count`: the cast cannot truncate.
        let offset = l.start + (fraction * count as f32).round() as u32;
        let affinity = if offset == l.end && count > 0 {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        TextPosition::new(offset, affinity)
    }

    pub(super) fn caret_rect(lines: &[TextLine], position: TextPosition) -> Option<Bounds<Points>> {
        let l = lines.get(position.line(lines)?)?;
        Some(Bounds::new(
            point(x_of(l, position.offset), l.y),
            size(Points::ZERO, l.height),
        ))
    }

    pub(super) fn range_rects(lines: &[TextLine], r: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        if r.start >= r.end {
            return;
        }
        for l in lines.iter().filter(|l| l.start < r.end && r.start < l.end) {
            let x1 = x_of(l, r.start);
            let x2 = if r.end > l.end {
                l.x + l.width
            } else {
                x_of(l, r.end)
            };
            out.push(Bounds::new(point(x1, l.y), size(x2 - x1, l.height)));
        }
    }
}

/// A deterministic, platform-free [`TextEngine`] for headless runs and
/// tests: every character is `0.55 × font size` wide and lines are
/// `1.2 × font size` tall, their baseline at the bottom (the font's ascent
/// is the line, its descent 0, its x height `0.5 × font size`), where
/// attachments are placed by [`TextAttachment::ascent`] on the first line.
#[derive(Debug, Default, Clone, Copy)]
pub struct ApproxTextEngine;

impl TextEngine for ApproxTextEngine {
    /// `(character count, font size, max lines, attachments, the indices of
    /// the characters two UTF-16 units long)`.
    type Prepared = (usize, Points, u32, Vec<TextAttachment>, Vec<u32>);

    fn prepare(&self, text: &AttributedText) -> Self::Prepared {
        self.prepare_aligned(text, &AttachmentAlignments::default())
    }

    fn prepare_aligned(
        &self,
        text: &AttributedText,
        alignments: &AttachmentAlignments,
    ) -> Self::Prepared {
        let size = text.spans.first().map_or(px(14.0), |s| s.style.font_size);
        // Empty (no allocation) for text in the Basic Multilingual Plane.
        let astral = text
            .text
            .chars()
            .enumerate()
            .filter(|(_, c)| c.len_utf16() == 2)
            .filter_map(|(i, _)| u32::try_from(i).ok())
            .collect();
        (
            text.text.chars().count(),
            size,
            text.max_lines,
            text.attachments
                .iter()
                .map(|a| {
                    let metrics = FontExtent::new(size * 1.2, Points::ZERO, size * 0.5);
                    TextAttachment {
                        height: a.ascent(metrics, alignments.get(a.index)),
                        ..*a
                    }
                })
                .collect(),
            astral,
        )
    }

    fn measure(
        &self,
        &(chars, font, max_lines, ..): &Self::Prepared,
        max_width: Option<Points>,
    ) -> Size<Points> {
        // The order of the products is kept: it decides the last bit.
        let width = Points(chars as f32 * font.0 * 0.55);
        let line = font * 1.2;
        let (width, mut lines) = match max_width {
            Some(max) if width > max && max > Points::ZERO => (max, (width / max).ceil()),
            _ => (width, 1.0),
        };
        if max_lines > 0 {
            lines = lines.min(max_lines as f32);
        }
        size(width, line * lines)
    }

    fn layout(&self, prepared: &Self::Prepared, size: Size<Points>) -> TextLayout {
        // On one line, each character as wide as the others.
        let (chars, font, _, attachments, astral) = prepared;
        let line = *font * 1.2;
        let advance = *font * 0.55;
        let attachments = attachments
            .iter()
            .map(|a| {
                Some(point(
                    Points(a.index as f32 * font.0 * 0.55),
                    (line - a.height).max(Points::ZERO),
                ))
            })
            .collect();
        // Baseline at the bottom of the line: the ascent is the line and
        // the descent is 0, the same extent attachments are placed against.
        let units = chars.saturating_add(astral.len());
        let line = TextLine {
            end: u32::try_from(units).unwrap_or(u32::MAX),
            width: size.width,
            height: line,
            ascender: line,
            x_height: *font * 0.5,
            ..TextLine::default()
        };
        TextLayout(Arc::new(ApproxLayout {
            attachments,
            line,
            advance,
            chars: u32::try_from(*chars).unwrap_or(u32::MAX),
            astral: astral.clone(),
        }))
    }

    fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
        layout
            .downcast::<ApproxLayout>()
            .map_or_else(Vec::new, |l| vec![l.line.clone()])
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<Point<Points>>> {
        layout
            .downcast::<ApproxLayout>()
            .map_or_else(Vec::new, |l| l.attachments.clone())
    }

    fn hit_test(&self, layout: &TextLayout, p: Point<Points>) -> TextPosition {
        let Some(l) = layout.downcast::<ApproxLayout>() else {
            return TextPosition::default();
        };
        let k = if l.advance > Points::ZERO {
            // Clamped to `0..=chars` first: the cast cannot truncate.
            (p.x / l.advance).round().clamp(0.0, l.chars as f32) as u32
        } else {
            0
        };
        TextPosition::new(l.unit_of(k), Affinity::Downstream)
    }

    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        let l = layout.downcast::<ApproxLayout>()?;
        Some(Bounds::new(
            point(l.x_of(position.offset), l.line.y),
            size(Points::ZERO, l.line.height),
        ))
    }

    fn range_rects(&self, layout: &TextLayout, range: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        let Some(l) = layout.downcast::<ApproxLayout>() else {
            return;
        };
        if range.start >= range.end || range.start >= l.line.end {
            return;
        }
        let (x1, x2) = (l.x_of(range.start), l.x_of(range.end));
        out.push(Bounds::new(
            point(x1, l.line.y),
            size(x2 - x1, l.line.height),
        ));
    }

    fn register_font(&self, _: &[u8]) -> Result<(), String> {
        Ok(())
    }
}

/// [`ApproxTextEngine`]'s final layout: one line.
struct ApproxLayout {
    attachments: Vec<Option<Point<Points>>>,
    line: TextLine,
    /// The width of every character.
    advance: Points,
    chars: u32,
    /// The indices of the characters two UTF-16 units long, in order.
    astral: Vec<u32>,
}

impl ApproxLayout {
    /// The UTF-16 offset of character `k`.
    fn unit_of(&self, k: u32) -> u32 {
        let before = self.astral.partition_point(|&i| i < k);
        k.saturating_add(u32::try_from(before).unwrap_or(u32::MAX))
    }

    /// The character at UTF-16 offset `o`: the one it starts, or the one
    /// it is inside (between the two units of a surrogate pair).
    fn char_at(&self, o: u32) -> u32 {
        let mut k = o;
        for (j, &i) in self.astral.iter().enumerate() {
            let start = i.saturating_add(u32::try_from(j).unwrap_or(u32::MAX));
            if start >= o {
                break;
            }
            k = if start.saturating_add(1) == o {
                i
            } else {
                k.saturating_sub(1)
            };
        }
        k.min(self.chars)
    }

    /// The x of the caret at UTF-16 offset `o`.
    fn x_of(&self, o: u32) -> Points {
        self.advance * self.char_at(o) as f32
    }
}

/// Content-addressed text measurements shared by all nodes of a surface,
/// so identical texts (list rows, recycled cells) are measured once.
///
/// Approximate LRU with two generations: lookups hit the current one or
/// promote from the previous one; when the current generation is full it
/// becomes the previous one. O(1), and never more than `2 * GENERATION`
/// entries.
#[derive(Default)]
pub(crate) struct MeasureCache {
    current: FxHashMap<(u64, u32), Size<Points>>,
    previous: FxHashMap<(u64, u32), Size<Points>>,
}

impl MeasureCache {
    const GENERATION: usize = 512;

    #[inline]
    fn key(layout_hash: u64, max_width: Option<Points>) -> (u64, u32) {
        // NaN never comes from taffy, so it can stand for "unconstrained".
        (layout_hash, max_width.map_or(f32::NAN, |w| w.0).to_bits())
    }

    pub(crate) fn get(
        &mut self,
        layout_hash: u64,
        max_width: Option<Points>,
    ) -> Option<Size<Points>> {
        let key = Self::key(layout_hash, max_width);
        if let Some(&size) = self.current.get(&key) {
            return Some(size);
        }
        let size = self.previous.remove(&key)?;
        self.insert_key(key, size);
        Some(size)
    }

    pub(crate) fn insert(
        &mut self,
        layout_hash: u64,
        max_width: Option<Points>,
        size: Size<Points>,
    ) {
        self.insert_key(Self::key(layout_hash, max_width), size);
    }

    fn insert_key(&mut self, key: (u64, u32), size: Size<Points>) {
        if self.current.len() >= Self::GENERATION {
            self.previous = std::mem::take(&mut self.current);
            self.current.reserve(Self::GENERATION);
        }
        self.current.insert(key, size);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.current.len() + self.previous.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_merges_and_counts_utf16() {
        let mut t = AttributedText::default();
        let a = ResolvedTextStyle::default();
        let b = ResolvedTextStyle {
            font_weight: 700,
            ..a
        };
        t.push("ab", a);
        t.push("", b);
        t.push("😀", a);
        t.push("c", b);
        assert_eq!(t.text, "ab😀c");
        assert_eq!(t.spans.len(), 2);
        assert_eq!((t.spans[0].start, t.spans[0].end), (0, 4));
        assert_eq!((t.spans[1].start, t.spans[1].end), (4, 5));
    }

    #[test]
    fn color_does_not_affect_layout_identity() {
        let mut a = AttributedText::default();
        a.push("hello", ResolvedTextStyle::default());
        let mut b = AttributedText::default();
        b.push(
            "hello",
            ResolvedTextStyle {
                color: Color(0xff00_00ff),
                ..Default::default()
            },
        );
        assert_ne!(a, b);
        assert!(a.layout_eq(&b));
        assert_eq!(a.layout_hash(), b.layout_hash());
        let mut c = b.clone();
        c.spans[0].style.font_size = px(15.0);
        assert!(!a.layout_eq(&c));
        assert_ne!(a.layout_hash(), c.layout_hash());
    }

    #[test]
    fn measure_cache_is_bounded_and_promotes() {
        let mut cache = MeasureCache::default();
        cache.insert(1, Some(px(100.0)), size(px(1.0), px(1.0)));
        for i in 0..10_000u64 {
            cache.insert(1000 + i, None, Size::default());
            // Keep entry 1 hot: every lookup promotes it.
            assert!(cache.get(1, Some(px(100.0))).is_some());
            assert!(cache.len() <= 2 * MeasureCache::GENERATION);
        }
        assert!(cache.get(1, Some(px(99.0))).is_none());
        assert!(cache.get(1000, None).is_none(), "cold entries are evicted");
    }

    #[test]
    fn attachments_sit_in_their_line_by_vertical_align() {
        // A font 10 above and 3 below the baseline, x height 5; a 20 pt
        // tall attachment.
        let font = FontExtent::new(px(10.0), px(3.0), px(5.0));
        let at = || TextAttachment {
            index: 0,
            width: px(8.0),
            height: px(20.0),
        };
        let place = |align| {
            let a = at();
            (a.ascent(font, align), a.extent(font, align))
        };
        // Bottom on the baseline: all of it above.
        assert_eq!(
            place(VerticalAlign::Baseline),
            (px(20.0), (px(20.0), px(0.0)))
        );
        // Top at the font's top: 10 above, 10 below (the line grows down).
        assert_eq!(
            place(VerticalAlign::TextTop),
            (px(10.0), (px(10.0), px(10.0)))
        );
        // Bottom at the font's bottom (Android's `ImageSpan` default).
        assert_eq!(
            place(VerticalAlign::TextBottom),
            (px(17.0), (px(17.0), px(3.0)))
        );
        // Middle 2.5 above the baseline.
        assert_eq!(
            place(VerticalAlign::Middle),
            (px(12.5), (px(12.5), px(7.5)))
        );
        // Smaller than the font: what it does not reach reserves nothing.
        let small = TextAttachment {
            height: px(4.0),
            ..at()
        };
        assert_eq!(small.ascent(font, VerticalAlign::TextTop), px(10.0));
        assert_eq!(
            small.extent(font, VerticalAlign::TextTop),
            (px(10.0), px(0.0))
        );
        let small = TextAttachment {
            height: px(2.0),
            ..at()
        };
        assert_eq!(small.ascent(font, VerticalAlign::TextBottom), px(-1.0));
        assert_eq!(
            small.extent(font, VerticalAlign::TextBottom),
            (px(0.0), px(3.0))
        );
    }

    #[test]
    fn approx_engine_places_aligned_attachments() {
        let engine = ApproxTextEngine;
        let style = ResolvedTextStyle {
            font_size: px(10.0),
            ..ResolvedTextStyle::default()
        };
        let y = |align| {
            let mut t = AttributedText::default();
            t.push("ab", style);
            let mut alignments = AttachmentAlignments::default();
            alignments.push(&mut t, size(px(8.0), px(6.0)), align, style);
            let prepared = engine.prepare_aligned(&t, &alignments);
            let layout = engine.layout(&prepared, size(px(100.0), px(12.0)));
            engine.attachments(&layout)[0].map(|p| (p.x, p.y))
        };
        // A 12 pt line with its baseline at the bottom, x height 5.
        assert_eq!(y(VerticalAlign::Baseline), Some((px(11.0), px(6.0))));
        assert_eq!(y(VerticalAlign::TextTop), Some((px(11.0), px(0.0))));
        assert_eq!(y(VerticalAlign::TextBottom), Some((px(11.0), px(6.0))));
        assert_eq!(y(VerticalAlign::Middle), Some((px(11.0), px(6.5))));
    }

    fn line(start: u32, end: u32, y: f32) -> TextLine {
        TextLine {
            start,
            end,
            x: px(0.0),
            y: px(y),
            width: px((end - start) as f32 * 10.0),
            height: px(20.0),
            ..TextLine::default()
        }
    }

    #[test]
    fn caret_positions_take_their_line_by_affinity() {
        // "abcd" wrapped after its 4th character, then a hard break and an
        // empty last line.
        let lines = [line(0, 4, 0.0), line(4, 9, 20.0), line(9, 9, 40.0)];
        let at = |o, a| TextPosition::new(o, a).line(&lines);
        assert_eq!(at(4, Affinity::Upstream), Some(0));
        assert_eq!(at(4, Affinity::Downstream), Some(1));
        assert_eq!(at(0, Affinity::Upstream), Some(0));
        assert_eq!(at(9, Affinity::Upstream), Some(1));
        assert_eq!(at(9, Affinity::Downstream), Some(2));
        assert_eq!(at(50, Affinity::Downstream), Some(2));
        assert_eq!(TextPosition::default().line(&[]), None);
    }

    /// An engine that only reports its lines (the defaults' hit testing).
    struct LinesOnly(Vec<TextLine>);

    impl TextEngine for LinesOnly {
        type Prepared = ();

        fn prepare(&self, _: &AttributedText) {}

        fn measure(&self, (): &(), _: Option<Points>) -> Size<Points> {
            Size::default()
        }

        fn layout(&self, (): &(), _: Size<Points>) -> TextLayout {
            TextLayout(Arc::new(()))
        }

        fn lines(&self, _: &TextLayout) -> Vec<TextLine> {
            self.0.clone()
        }
    }

    #[test]
    fn line_only_engines_estimate_hits_carets_and_ranges() {
        let engine = LinesOnly(vec![line(0, 4, 0.0), line(4, 8, 20.0)]);
        let layout = engine.layout(&(), Size::default());
        // Past the end of the wrapped first line: its end, on that line.
        let end = engine.hit_test(&layout, point(px(70.0), px(5.0)));
        assert_eq!(end, TextPosition::new(4, Affinity::Upstream));
        assert_eq!(
            engine.caret_rect(&layout, end),
            Some(Bounds::new(
                point(px(40.0), px(0.0)),
                size(px(0.0), px(20.0))
            ))
        );
        assert_eq!(
            engine.caret_rect(&layout, TextPosition::new(4, Affinity::Downstream)),
            Some(Bounds::new(
                point(px(0.0), px(20.0)),
                size(px(0.0), px(20.0))
            ))
        );
        // Below the text: the last line, the nearest character edge.
        let below = engine.hit_test(&layout, point(px(16.0), px(90.0)));
        assert_eq!(below, TextPosition::new(6, Affinity::Downstream));
        let mut rects = Vec::new();
        engine.range_rects(&layout, 2..6, &mut rects);
        assert_eq!(
            rects,
            [
                Bounds::new(point(px(20.0), px(0.0)), size(px(20.0), px(20.0))),
                Bounds::new(point(px(0.0), px(20.0)), size(px(20.0), px(20.0))),
            ]
        );
        rects.clear();
        engine.range_rects(&layout, 3..3, &mut rects);
        assert!(rects.is_empty());
    }

    #[test]
    fn approx_engine_hit_tests_whole_characters() {
        let engine = ApproxTextEngine;
        let mut t = AttributedText::default();
        // Characters 5.5 wide; the emoji is two UTF-16 units (1..3).
        t.push(
            "a😀b",
            ResolvedTextStyle {
                font_size: px(10.0),
                ..ResolvedTextStyle::default()
            },
        );
        let layout = engine.layout(&engine.prepare(&t), size(px(100.0), px(12.0)));
        assert_eq!(engine.lines(&layout)[0].end, 4);
        let hit = |x| engine.hit_test(&layout, point(px(x), px(6.0))).offset;
        assert_eq!([hit(-3.0), hit(5.0), hit(11.5), hit(99.0)], [0, 1, 3, 4]);
        let caret_x = |o| {
            engine
                .caret_rect(&layout, TextPosition::new(o, Affinity::Downstream))
                .map(|b| b.origin.x)
        };
        // Inside the surrogate pair: at the emoji's start.
        assert_eq!(caret_x(2), Some(px(5.5)));
        assert_eq!(caret_x(3), Some(px(11.0)));
        assert_eq!(caret_x(9), Some(px(16.5)));
        let mut rects = Vec::new();
        engine.range_rects(&layout, 1..3, &mut rects);
        assert_eq!(
            rects,
            [Bounds::new(
                point(px(5.5), px(0.0)),
                size(px(5.5), px(12.0))
            )]
        );
    }
}

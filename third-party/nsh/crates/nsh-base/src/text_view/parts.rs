//! The parts of a [`super::TextView`] the app styles: Tailwind classes
//! ([`TextViewClasses`]) and inline styles ([`TextViewStyles`]) by part.

use std::rc::Rc;

use nsh_core::ui::{JsHost, JsIn, JsOwned, PropError, Style, StyleRefinement, TsTypes, prelude::*};

/// Declares the parts once: the classes' object, the styles' object and
/// [`Part`], each field documented alike.
macro_rules! parts {
    ($( $(#[doc = $doc:literal])* $field:ident => $variant:ident ),* $(,)?) => {
        /// Tailwind classes of a `TextView`'s parts
        /// (`classes={{ heading1: "text-2xl font-bold", code: "font-mono" }}`),
        /// after the part's own styles: at equal rank they win.
        #[derive(Debug, Clone, Default, PartialEq, JsObject)]
        pub struct TextViewClasses {
            $( $(#[doc = $doc])* pub $field: Option<SharedString>, )*
        }

        /// Inline styles of a `TextView`'s parts
        /// (`styles={{ link: { color: "#2563eb" } }}`), over its classes.
        #[derive(Debug, Clone, Default, PartialEq, JsObject)]
        pub struct TextViewStyles {
            $( $(#[doc = $doc])* pub $field: Option<PartStyle>, )*
        }

        /// A part of a [`super::TextView`], for the styles a Rust view
        /// gives it ([`TextViewParts`]).
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        pub enum TextViewPart {
            $( $(#[doc = $doc])* $variant, )*
        }

        impl TextViewClasses {
            /// Part `part`'s classes.
            pub(crate) fn get(&self, part: TextViewPart) -> Option<&SharedString> {
                match part {
                    $( TextViewPart::$variant => self.$field.as_ref(), )*
                }
            }
        }

        impl TextViewStyles {
            /// Part `part`'s style.
            pub(crate) fn get(&self, part: TextViewPart) -> Option<&Style> {
                match part {
                    $( TextViewPart::$variant => self.$field.as_ref().map(|s| &s.0), )*
                }
            }
        }
    };
}

parts! {
    /// The native document viewport: outer geometry and text styles.
    /// Text styles pass to every part; `contentStyle` lays out its rows.
    root => Root,
    /// Every paragraph.
    paragraph => Paragraph,
    /// Every heading (then its level's part).
    heading => Heading,
    /// Level 1 headings.
    heading1 => Heading1,
    /// Level 2 headings.
    heading2 => Heading2,
    /// Level 3 headings.
    heading3 => Heading3,
    /// Level 4 headings.
    heading4 => Heading4,
    /// Level 5 headings.
    heading5 => Heading5,
    /// Level 6 headings.
    heading6 => Heading6,
    /// Quotations (a column of their blocks, a line at their side) and
    /// alerts.
    blockquote => Blockquote,
    /// Every alert (`> [!NOTE]`: a tinted box, a row of its icon and the
    /// column of its blocks), after `blockquote` (then its kind's part).
    alert => Alert,
    /// `[!NOTE]` alerts.
    alert_note => AlertNote,
    /// `[!TIP]` alerts.
    alert_tip => AlertTip,
    /// `[!IMPORTANT]` alerts.
    alert_important => AlertImportant,
    /// `[!WARNING]` alerts.
    alert_warning => AlertWarning,
    /// `[!CAUTION]` alerts.
    alert_caution => AlertCaution,
    /// The icon of an alert (a ring with a glyph in the alert's color).
    alert_icon => AlertIcon,
    /// Every list (a column of its items).
    list => List,
    /// Numbered lists, after `list`.
    ordered_list => OrderedList,
    /// Bulleted lists, after `list`.
    unordered_list => UnorderedList,
    /// Every item (a row: its marker, then its blocks).
    list_item => ListItem,
    /// The marker of an item (`•`, `◦`, `▪` by depth, or `1.`): placed
    /// over the indent, right-aligned against the item's content.
    list_marker => ListMarker,
    /// The marker of a task item (a box drawn as a view, filled with a `✓`
    /// when done), after `listMarker`.
    task_marker => TaskMarker,
    /// The marker of a done task item, after `taskMarker`.
    task_marker_checked => TaskMarkerChecked,
    /// The column of an item's blocks.
    list_item_content => ListItemContent,
    /// Code blocks (the code, the actions floating over it).
    code_block => CodeBlock,
    /// The row of a code block's actions (`codeBlockActions`), floating
    /// over its top right corner (only with actions).
    code_block_header => CodeBlockHeader,
    /// The horizontal scroll view of a code block's code.
    code_block_scroll => CodeBlockScroll,
    /// The code of a code block (monospace, as written).
    code_block_code => CodeBlockCode,
    /// Code in text (monospace).
    code => Code,
    /// Keys (`<kbd>`, monospace).
    keyboard => Keyboard,
    /// Strong text (semibold).
    strong => Strong,
    /// Emphasized text (italic).
    emphasis => Emphasis,
    /// Struck-through text.
    strikethrough => Strikethrough,
    /// Underlined text.
    underline => Underline,
    /// Highlighted text (`<mark>`; on the document's color when it gives
    /// one).
    highlight => Highlight,
    /// Superscript (smaller).
    superscript => Superscript,
    /// Subscript (smaller).
    subscript => Subscript,
    /// Smaller text (`<small>`).
    small => Small,
    /// Links (in the theme's link color, underlined).
    link => Link,
    /// Images: alone in a paragraph or a cell, as wide as they ask (their
    /// natural size when they ask for nothing), at most the text's width;
    /// in a line of text, the size they ask for, else three quarters of a
    /// line tall.
    image => Image,
    /// Formulas in text, without a `renderMath` (their TeX, monospace).
    math => Math,
    /// Formula blocks, without a `renderMath` (their TeX, monospace, in a
    /// box as a code block's).
    math_block => MathBlock,
    /// Tables (a column: the app's `renderTableActions`, then the
    /// scroll view of the cells).
    table => Table,
    /// The horizontal scroll view of a table's cells: they scroll when the
    /// columns cannot shrink further.
    table_scroll => TableScroll,
    /// The header row of a table, after `tableRow`.
    table_head => TableHead,
    /// Every row of a table: a view behind its cells, for backgrounds and
    /// borders (text styles go on the cells).
    table_row => TableRow,
    /// Every cell of a table.
    table_cell => TableCell,
    /// The header row's cells, after `tableCell`.
    table_header_cell => TableHeaderCell,
    /// Thematic breaks (a line: a top border).
    rule => Rule,
    /// Disclosures (`<details>`).
    details => Details,
    /// The summary of a disclosure (a press toggles it).
    summary => Summary,
    /// The marker of a summary (`▸`, `▾`).
    summary_marker => SummaryMarker,
    /// The footnotes after the blocks (a column).
    footnotes => Footnotes,
    /// A footnote (a row: its number, then its blocks).
    footnote => Footnote,
    /// The number of a footnote.
    footnote_label => FootnoteLabel,
    /// A reference to a footnote in text (its number, smaller).
    footnote_reference => FootnoteReference,
    /// Custom nodes shown as their content (no `renderCustom`).
    custom => Custom,
}

/// What a styling function of [`TextViewParts`] is.
type Refine = Rc<dyn Fn(StyleRefinement) -> StyleRefinement>;

/// Typed styles of [`super::TextView`]'s parts, for Rust views: given to
/// the text views below with `provide_context`, applied before the app's
/// `classes` and `styles` (theme colors follow the appearance natively).
///
/// ```ignore
/// provide_context(
///     TextViewParts::new()
///         .part(TextViewPart::Heading1, |s| s.text_2xl().font_weight(FontWeight::BOLD))
///         .part(TextViewPart::Code, |s| s.bg(theme().muted).rounded(px(4.0))),
/// );
/// ```
#[derive(Clone, Default)]
pub struct TextViewParts(Rc<Vec<(TextViewPart, Refine)>>);

impl TextViewParts {
    /// None.
    pub fn new() -> Self {
        Self::default()
    }

    /// With `style` applied to part `part` (after the styles given it
    /// before).
    pub fn part(
        mut self,
        part: TextViewPart,
        style: impl Fn(StyleRefinement) -> StyleRefinement + 'static,
    ) -> Self {
        Rc::make_mut(&mut self.0).push((part, Rc::new(style)));
        self
    }

    /// `style` refined by the styles of `part`.
    pub(crate) fn refine(&self, part: TextViewPart, mut style: StyleRefinement) -> StyleRefinement {
        for (p, f) in self.0.iter() {
            if *p == part {
                style = f(style);
            }
        }
        style
    }

    /// Whether there are none.
    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl std::fmt::Debug for TextViewParts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.0.iter().map(|(p, _)| p))
            .finish()
    }
}

/// The inline style of a part of a [`super::TextView`]: a [`Style`] whose
/// TypeScript type takes text styles too (`StyleProp<TextStyle>`), since
/// most parts are texts or pass text styles to the texts inside them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PartStyle(pub Style);

impl From<Style> for PartStyle {
    fn from(style: Style) -> Self {
        Self(style)
    }
}

impl JsValue for PartStyle {
    fn ts_type(_types: &mut TsTypes) -> String {
        "StyleProp<TextStyle>".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Style::from_js(value).map(Self)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        self.0.to_js(host)
    }
}

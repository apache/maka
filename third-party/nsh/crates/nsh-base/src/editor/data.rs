//! The values an [`super::Editor`] and the app pass each other: positions,
//! ranges, selections, searches, diagnostics and decorations. Positions are
//! lines and UTF-16 columns from 0, as a language server's (LSP's
//! `Position`), so its diagnostics pass through as they come.

use nsh_core::{element::Style, prelude::*};

/// A position in an editor's text: a line and a column, both from 0. The
/// column counts UTF-16 code units, as JS strings and language servers do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorPosition {
    /// The line, from 0.
    pub line: u32,
    /// The UTF-16 code units before it in its line.
    pub column: u32,
}

impl EditorPosition {
    /// Line `line`, column `column`.
    pub fn new(line: u32, column: u32) -> EditorPosition {
        EditorPosition { line, column }
    }
}

/// A range of an editor's text, from `start` to `end` (`end` not
/// included).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorRange {
    /// Where it starts.
    pub start: EditorPosition,
    /// Where it ends, not included.
    pub end: EditorPosition,
}

impl EditorRange {
    /// From `start` to `end`.
    pub fn new(start: EditorPosition, end: EditorPosition) -> EditorRange {
        EditorRange { start, end }
    }
}

/// A selection of an editor: from `anchor`, where it started, to `head`,
/// where the caret is. Equal, it is a caret.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorSelection {
    /// Where the selection started.
    pub anchor: EditorPosition,
    /// Where the caret is.
    pub head: EditorPosition,
}

impl EditorSelection {
    /// From `anchor` to `head`.
    pub fn new(anchor: EditorPosition, head: EditorPosition) -> EditorSelection {
        EditorSelection { anchor, head }
    }

    /// A caret at `at`.
    pub fn caret(at: EditorPosition) -> EditorSelection {
        EditorSelection {
            anchor: at,
            head: at,
        }
    }
}

/// What an editor finds (`search`): its matches are highlighted, and
/// `findNext` / `findPrevious` / `replace` / `replaceAll` act on them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorSearch {
    /// The text to find (a regular expression with `regex`). Empty finds
    /// nothing.
    pub query: SharedString,
    /// Matches only text of the same case (default: any case).
    #[prop(default)]
    pub case_sensitive: bool,
    /// Matches only whole words.
    #[prop(default)]
    pub whole_word: bool,
    /// `query` is a regular expression (Rust's `regex` syntax; a
    /// replacement refers to its groups as `$1` and `${name}`).
    #[prop(default)]
    pub regex: bool,
    /// Matches only inside what was selected when the search turned to the
    /// selection (the carets' lines when nothing was): find in selection.
    /// The scope stays while this stays on, carried through edits.
    #[prop(default)]
    pub in_selection: bool,
}

impl EditorSearch {
    /// Finds `query` as it is written, in any case.
    pub fn new(query: impl Into<SharedString>) -> EditorSearch {
        EditorSearch {
            query: query.into(),
            ..Default::default()
        }
    }
}

/// What an editor's search found: how many matches, and which of them the
/// selection is on (`onSearchChange`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorSearchResult {
    /// How many matches there are (at most 10 000 are counted).
    pub count: u32,
    /// The match the primary selection is on, from 0 (`null`: none).
    #[prop(skip_none)]
    pub current: Option<u32>,
    /// The query is not a valid regular expression: why.
    #[prop(skip_none)]
    pub error: Option<SharedString>,
}

/// How serious a diagnostic is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PropEnum)]
pub enum EditorDiagnosticSeverity {
    /// An error.
    #[default]
    Error,
    /// A warning.
    Warning,
    /// Information.
    Info,
    /// A hint.
    Hint,
}

/// A problem in an editor's text, as a language server or linter reports
/// it: its range is marked (the `diagnostic` parts) and its line's number
/// too.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorDiagnostic {
    /// What it is about. An empty range marks the character after it (or
    /// the end of its line).
    pub range: EditorRange,
    /// How serious it is (default `error`).
    #[prop(default)]
    pub severity: EditorDiagnosticSeverity,
    /// What it says.
    pub message: SharedString,
    /// Who reported it (`"rustc"`, `"eslint"`).
    #[prop(skip_none)]
    pub source: Option<SharedString>,
    /// Its code (`"E0308"`).
    #[prop(skip_none)]
    pub code: Option<SharedString>,
    /// Where its code is described (a rule's page): a link the app opens
    /// from its hover card.
    #[prop(skip_none)]
    pub code_description: Option<EditorDiagnosticCodeDescription>,
    /// What else it is (`unnecessary` code is faded, `deprecated` code
    /// struck through: the `unnecessaryText` / `deprecatedText` parts).
    #[prop(default)]
    pub tags: Vec<EditorDiagnosticTag>,
    /// Other places that tell about it (the first definition of a name
    /// defined twice), for the app's hover card.
    #[prop(default)]
    pub related_information: Vec<EditorDiagnosticRelatedInformation>,
}

/// Where a diagnostic's code is described (LSP's `CodeDescription`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorDiagnosticCodeDescription {
    /// The page's URL.
    pub href: SharedString,
}

impl EditorDiagnosticCodeDescription {
    /// The page at `href`.
    pub fn new(href: impl Into<SharedString>) -> EditorDiagnosticCodeDescription {
        EditorDiagnosticCodeDescription { href: href.into() }
    }
}

/// What else a diagnostic is (LSP's `DiagnosticTag`, by name: `1` is
/// `unnecessary`, `2` `deprecated`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PropEnum)]
pub enum EditorDiagnosticTag {
    /// Code that is not needed: unused, unreachable (faded).
    Unnecessary,
    /// Code that uses what is deprecated (struck through).
    Deprecated,
}

/// A place in a document: its range in the editor's text, or in the
/// document at `uri` (LSP's `Location`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorLocation {
    /// The document (absent: the editor's own).
    #[prop(skip_none)]
    pub uri: Option<SharedString>,
    /// Where in it.
    pub range: EditorRange,
}

impl EditorLocation {
    /// `range` of the document at `uri` (`None`: the editor's own).
    pub fn new(uri: Option<SharedString>, range: EditorRange) -> EditorLocation {
        EditorLocation { uri, range }
    }
}

/// Another place that tells about a diagnostic, and what it says there
/// (LSP's `DiagnosticRelatedInformation`). Its range is passed back as the
/// app gave it, not carried through edits.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorDiagnosticRelatedInformation {
    /// The place.
    pub location: EditorLocation,
    /// What it says about it.
    pub message: SharedString,
}

impl EditorDiagnosticRelatedInformation {
    /// `message` about `location`.
    pub fn new(
        location: EditorLocation,
        message: impl Into<SharedString>,
    ) -> EditorDiagnosticRelatedInformation {
        EditorDiagnosticRelatedInformation {
            location,
            message: message.into(),
        }
    }
}

/// A range of an editor's text the app styles: semantic highlights, a
/// statement being run, the changes of a review. Its classes and style
/// apply to the range's text, and its `lineClass` / `lineStyle` to the
/// rows of its lines, behind the text.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorDecoration {
    /// What it styles.
    pub range: EditorRange,
    /// Tailwind classes of the range's text (`text-*`, `font-*`,
    /// `underline`, `bg-*`).
    #[prop(skip_none)]
    pub class: Option<SharedString>,
    /// The inline style of the range's text, over `class`.
    #[prop(skip_none)]
    pub style: Option<Style>,
    /// Tailwind classes of the rows of the lines it covers (a background).
    #[prop(skip_none)]
    pub line_class: Option<SharedString>,
    /// The inline style of those rows, over `lineClass`.
    #[prop(skip_none)]
    pub line_style: Option<Style>,
    /// The kind of token its text is, colored as the built-in highlighting
    /// colors it, in place of what that found there (the app's own
    /// highlighter: a language server's semantic tokens, a parser's). Its
    /// `class` and `style` apply over the token's colors.
    #[prop(skip_none)]
    pub token: Option<EditorToken>,
    /// A mark in the strip before the line numbers, beside the lines the
    /// range covers (a version-control diff's added or modified lines). An
    /// empty range marks the boundary between two lines (deleted lines).
    #[prop(skip_none)]
    pub gutter: Option<EditorGutterMark>,
    /// A mark on the overview ruler, the strip along the editor's right
    /// edge that maps the whole text to its height (Monaco's).
    #[prop(skip_none)]
    pub overview_ruler: Option<EditorOverviewRulerMark>,
}

/// A decoration's mark in the gutter's strip of marks
/// ([`EditorDecoration::gutter`]): a bar the strip's width beside each line
/// of its range (an empty range's line, as `lineClass` styles it), or a
/// line across the strip between two lines (`placement: "before"`). Its
/// look is the app's; without any, it is the foreground color.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorGutterMark {
    /// Where it is drawn (default `lines`).
    #[prop(default)]
    pub placement: EditorGutterPlacement,
    /// Tailwind classes of the mark (`bg-*`, `opacity-*`).
    #[prop(skip_none)]
    pub class: Option<SharedString>,
    /// The inline style of the mark, over `class`.
    #[prop(skip_none)]
    pub style: Option<Style>,
}

/// Where a gutter mark is drawn ([`EditorGutterMark::placement`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PropEnum)]
pub enum EditorGutterPlacement {
    /// A bar beside every line the range covers; an empty range covers
    /// its line (added or modified lines, a breakpoint).
    #[default]
    Lines,
    /// A line across the strip at the boundary before the range's start:
    /// at the top of its line when it starts a line, otherwise at the
    /// bottom of its line (lines deleted there, at the end of a text with
    /// no final line break too).
    Before,
}

/// A decoration's mark on the overview ruler
/// ([`EditorDecoration::overview_ruler`]): the range's rows, scaled to
/// the ruler's height, at least 6 points tall, in one of its lanes. Its
/// look is the app's; without any, it is the foreground color.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorOverviewRulerMark {
    /// The part of the ruler's width it takes (default `center`).
    #[prop(default)]
    pub lane: EditorOverviewRulerLane,
    /// Tailwind classes of the mark (`bg-*`, `opacity-*`).
    #[prop(skip_none)]
    pub class: Option<SharedString>,
    /// The inline style of the mark, over `class`.
    #[prop(skip_none)]
    pub style: Option<Style>,
}

/// The part of the overview ruler's width a mark takes, as Monaco's lanes:
/// thirds, or the whole width.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PropEnum)]
pub enum EditorOverviewRulerLane {
    /// The left third (version control's changes, by convention).
    Left,
    /// The middle third.
    #[default]
    Center,
    /// The right third (diagnostics, by convention).
    Right,
    /// The whole width.
    Full,
}

/// A kind of token of an editor's syntax highlighting, as the built-in
/// highlighter colors it (the palette `TextView`'s code blocks share), for
/// the app's tokens ([`EditorDecoration::token`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PropEnum)]
pub enum EditorToken {
    /// Comments (italic).
    Comment,
    /// Keywords, and operators that are words (`as`, `typeof`).
    Keyword,
    /// Strings, regular expressions, escapes.
    String,
    /// Numbers, constants and literals (`true`, `null`).
    Number,
    /// Names of functions and classes.
    Title,
    /// Attributes, parameters, properties, keys, `self` / `this`.
    Attr,
    /// Built-ins: types, functions, macros; tags.
    Built,
    /// Removed lines.
    Deletion,
}

impl EditorToken {
    /// The built-in highlighter's token of this kind.
    pub(crate) fn syntax(self) -> crate::syntax::Token {
        use crate::syntax::Token;
        match self {
            Self::Comment => Token::Comment,
            Self::Keyword => Token::Keyword,
            Self::String => Token::String,
            Self::Number => Token::Number,
            Self::Title => Token::Title,
            Self::Attr => Token::Attr,
            Self::Built => Token::Built,
            Self::Deletion => Token::Deletion,
        }
    }
}

/// Lines of an editor that fold: line `startLine` stays visible and shows
/// the fold, the lines after it through `endLine` hide. A language
/// server's `FoldingRange` has this shape (its other keys are ignored), so
/// its ranges pass through as they come.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorFoldRange {
    /// The line that stays visible, from 0.
    pub start_line: u32,
    /// The last line it hides.
    pub end_line: u32,
}

impl EditorFoldRange {
    /// Lines `start_line + 1..=end_line` hidden under `start_line`.
    pub fn new(start_line: u32, end_line: u32) -> EditorFoldRange {
        EditorFoldRange {
            start_line,
            end_line,
        }
    }
}

/// A replacement of an editor's text (`edit`): `range`, as the text is
/// before the edit, becomes `text`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, JsObject)]
#[non_exhaustive]
pub struct EditorEdit {
    /// What is replaced (empty: `text` goes in at its start).
    pub range: EditorRange,
    /// What takes its place (empty: the range is deleted).
    pub text: SharedString,
}

impl EditorEdit {
    /// `range` replaced with `text`.
    pub fn new(range: EditorRange, text: impl Into<SharedString>) -> EditorEdit {
        EditorEdit {
            range,
            text: text.into(),
        }
    }
}

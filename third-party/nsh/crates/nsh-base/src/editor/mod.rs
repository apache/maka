//! `Editor`: a code editor (`nsh/base`), the port of GPUI Kit's `Editor`
//! to NSH's primitives.
//!
//! The editor draws its text itself, as texts of display rows, and keeps
//! its own model: a rope ([`buffer`]), selections (several carets),
//! movements, editing commands, undo, a display map (tabs, soft wrap,
//! folds), incremental syntax highlighting, search, diagnostics and
//! decorations. Keys reach it through the keymap while it has the focus;
//! typed text and input methods through a native text input kept at the
//! primary caret, which holds only what was just typed. `docs/dev/editor.md`
//! has the design.

mod app_highlight;
mod buffer;
mod commands;
mod completion;
pub(crate) mod controller;
mod data;
mod definition;
mod diagnostics;
mod display;
mod fold;
mod fold_set;
pub(crate) mod highlight;
mod highlighter;
mod hooks;
mod keymap;
pub(crate) mod language;
pub(crate) mod languages;
pub(crate) mod layout;
mod movement;
mod parts;
mod search;
mod select;
pub(crate) mod state;
mod touch;
mod types;
mod view;

pub use completion::{
    EditorCompletionAcceptEvent, EditorCompletionItem, EditorCompletionKind,
    EditorCompletionRequest, EditorCompletionTrigger, EditorInlineCompletionRequest,
};
pub use data::{
    EditorDecoration, EditorDiagnostic, EditorDiagnosticCodeDescription,
    EditorDiagnosticRelatedInformation, EditorDiagnosticSeverity, EditorDiagnosticTag, EditorEdit,
    EditorFoldRange, EditorLocation, EditorPosition, EditorRange, EditorSearch, EditorSearchResult,
    EditorSelection, EditorToken,
};
pub use definition::{EditorCodeActionRequest, EditorDefinitionRequest, EditorDefinitionTrigger};
pub use highlighter::{
    EditorHighlighter, EditorText, EditorTextEdit, EditorTextPoint, EditorTokens,
};
pub use hooks::{EditorBounds, EditorHoverEvent, EditorTextPressEvent};
pub use languages::{EditorLanguage, register_highlighter, register_language};
pub use layout::EditorScrollBeyond;
use nsh_core::prelude::*;
pub use parts::{EditorClasses, EditorPart, EditorStyles};
pub use touch::EditorRect;

use self::controller::Ed;

/// A code editor: syntax highlighting, line numbers, several carets,
/// folding, soft wrap, search and replace, diagnostics and decorations,
/// with the keys of code editors. The text is controlled (`value` and
/// `onChange`) or the editor's own (`defaultValue`). It has a look of its
/// own built from the theme's tokens (a monospaced font, muted line
/// numbers, a faint active line, the built-in syntax colors), every part of
/// which the app restyles (`classes`, `styles`).
#[derive(Clone, Copy, PartialEq, Props)]
pub struct EditorProps {
    /// The text, when the app controls it (set it again from `onChange`).
    /// A new value replaces the text as an edit undo takes back.
    pub value: Prop<Option<SharedString>>,
    /// The first text, when the editor keeps its own.
    pub default_value: Prop<Option<SharedString>>,
    /// The language: a name (`"rust"`, `"typescript"`), an extension
    /// (`"tsx"`) or a file name (`"main.go"`, `"Dockerfile"`). It decides
    /// the highlighting, comments, brackets and indentation (default plain
    /// text).
    pub language: Prop<Option<SharedString>>,
    /// Shown while the text is empty.
    pub placeholder: Prop<Option<SharedString>>,
    /// The text can be selected and copied but not changed.
    #[prop(default)]
    pub read_only: Prop<bool>,
    /// The editor takes the focus when it appears.
    #[prop(default)]
    pub auto_focus: Prop<bool>,
    /// The gutter's line numbers (default true).
    #[prop(default = true)]
    pub line_numbers: Prop<bool>,
    /// Long lines wrap at the editor's width, rather than scrolling
    /// sideways.
    #[prop(default)]
    pub soft_wrap: Prop<bool>,
    /// The columns of a tab and of an indentation level (default the
    /// language's: 4, 2 for web languages).
    pub tab_size: Prop<Option<u32>>,
    /// Indents with tabs (default the language's: Go and Makefiles do).
    pub hard_tabs: Prop<Option<bool>>,
    /// Lines indented under a line fold away with the gutter's markers
    /// (default true).
    #[prop(default = true)]
    pub folding: Prop<bool>,
    /// Brackets and quotes close as they are typed (default true).
    #[prop(default = true)]
    pub auto_close: Prop<bool>,
    /// A new line keeps the indentation, and indents after an opening
    /// bracket (default true).
    #[prop(default = true)]
    pub auto_indent: Prop<bool>,
    /// The rows of the lines with a caret are highlighted (the
    /// `activeLine` part; default true).
    #[prop(default = true)]
    pub active_line: Prop<bool>,
    /// The guides of indentation (default true).
    #[prop(default = true)]
    pub indent_guides: Prop<bool>,
    /// How far the text scrolls on past its last line: `true` up to a
    /// screen (the default), `false` not at all, a number that many rows.
    #[prop(default)]
    pub scroll_beyond_last_line: Prop<EditorScrollBeyond>,
    /// The font family (default the theme's `font-mono`, else the
    /// system's monospaced font). The editor measures its text in it, so
    /// set the font here rather than with classes.
    pub font_family: Prop<Option<SharedString>>,
    /// The font size, in points (default 13).
    #[prop(default = Points(13.0))]
    pub font_size: Prop<Points>,
    /// The height of a row, in points (default 20).
    #[prop(default = Points(20.0))]
    pub line_height: Prop<Points>,
    /// What to find: its matches are highlighted, and `findNext`,
    /// `findPrevious`, `replace` and `replaceAll` act on them.
    pub search: Prop<Option<EditorSearch>>,
    /// Problems to mark (a language server's or a linter's), carried
    /// through edits until the app sets new ones.
    #[prop(default)]
    pub diagnostics: Prop<Vec<EditorDiagnostic>>,
    /// Ranges the app styles (semantic highlighting, a statement being
    /// run), carried through edits until the app sets new ones.
    #[prop(default)]
    pub decorations: Prop<Vec<EditorDecoration>>,
    /// Classes of the editor's parts, after their own styles.
    #[prop(default)]
    pub classes: Prop<EditorClasses>,
    /// Inline styles of the editor's parts, over their classes.
    #[prop(default)]
    pub styles: Prop<EditorStyles>,
    /// What screen readers call the editor.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// Spaces and tabs show, as `·` and `→` (the `whitespace` part).
    #[prop(default)]
    pub show_whitespaces: Prop<bool>,
    /// Columns to draw a vertical line at (the `ruler` part), as guides of
    /// a line's length (`[80, 120]`).
    #[prop(default)]
    pub rulers: Prop<Vec<u32>>,
    /// The editor grows with its text from this many rows (with or without
    /// `maxRows`): its height follows the rows rather than the app's
    /// layout, and the text does not scroll past its last line.
    pub min_rows: Prop<Option<u32>>,
    /// The editor grows with its text up to this many rows, then scrolls
    /// (with or without `minRows`, which is 1 then).
    pub max_rows: Prop<Option<u32>>,
    /// The rows kept in view above and below the caret as it moves (default
    /// one, at most a quarter of the editor's height; never more than
    /// half of what the caret's row leaves).
    pub cursor_surrounding_lines: Prop<Option<u32>>,
    /// Where folds can start, the app's (a language server's folding
    /// ranges), instead of by indentation; carried through edits until the
    /// app sets new ones. An empty list: nothing folds.
    pub fold_ranges: Prop<Option<Vec<EditorFoldRange>>>,
    /// The built-in syntax highlighting (default true). Off, the language
    /// still decides comments, brackets and indentation, and the app's
    /// decorations (their `token`s) color the text alone.
    #[prop(default = true)]
    pub highlighting: Prop<bool>,
    /// Completion: typing a word, a trigger character or
    /// `showCompletions` asks the app (`onCompletionRequest`), whose
    /// answer (`presentCompletions`) the editor shows as a list below the
    /// caret, filters as typing goes on, and inserts from (Up / Down,
    /// Enter / Tab, Escape); a pause in typing asks for an inline
    /// completion (`onInlineCompletionRequest`).
    #[prop(default)]
    pub completion: Prop<bool>,
    /// What else asks for completions as it is typed, with an empty query
    /// after it (`["."]`, `["::", "<"]`; default none).
    #[prop(default)]
    pub completion_trigger_characters: Prop<Vec<SharedString>>,
    /// Milliseconds typing pauses before an inline completion is asked for
    /// (default 300).
    #[prop(default = 300.0)]
    pub inline_completion_delay: Prop<f64>,
}

/// The events of an [`Editor`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum EditorEvent {
    /// The text changed (the whole new text).
    #[args(value)]
    Change(SharedString),
    /// The selections changed: every one, the primary (newest) last.
    #[args(selections)]
    SelectionChange(Vec<EditorSelection>),
    /// The editor took the focus.
    Focus,
    /// The editor lost the focus.
    Blur,
    /// The search's matches changed (a new `search`, an edit, a move to
    /// another match).
    #[args(result)]
    SearchChange(EditorSearchResult),
    /// A line number was pressed (a breakpoint's place): the line, from 0.
    #[args(line)]
    LineNumberPress(u32),
    /// The secondary button was pressed over the text (a right click,
    /// Control-click on Apple platforms), or a touch selected text (with
    /// `selection`): where, in the text and in the root view, to open a
    /// menu at (`Menu.popup(items, { x, y })`).
    #[args(event)]
    ContextMenu(EditorContextMenuEvent),
    /// The mouse rests over a character (desktops and the web): what to
    /// ask a language server about and where to show its answer, with the
    /// diagnostics there. A new hover replaces the last one as the mouse
    /// moves to another word.
    #[args(event)]
    Hover(EditorHoverEvent),
    /// The hover ended: the mouse left the word or the editor, or the text
    /// changed or scrolled under it.
    HoverEnd,
    /// A character was pressed, after the editor placed its caret: with
    /// Mod held, a definition to go to.
    #[args(event)]
    TextPress(EditorTextPressEvent),
    /// The user asked to find the primary selection's text (a caret: its
    /// word; `findWithSelection`, Command+E on Apple platforms): the app's
    /// find bar takes it as its query.
    #[args(query)]
    FindWithSelection(String),
    /// The folded ranges changed (a fold, an unfold, an edit or a caret
    /// moving into a fold): every one, nested ones included, by start.
    #[args(folds)]
    FoldChange(Vec<EditorFoldRange>),
    /// The editor asks for completions at its caret (with `completion`):
    /// a word is being typed, a trigger character was, or
    /// `showCompletions`. Answer with `presentCompletions(id, items)`.
    #[args(event)]
    CompletionRequest(EditorCompletionRequest),
    /// A completion item was accepted and inserted.
    #[args(event)]
    CompletionAccept(EditorCompletionAcceptEvent),
    /// Typing paused for `inlineCompletionDelay` with no list open (with
    /// `completion`): answer with `presentInlineCompletion(id, text)`.
    #[args(event)]
    InlineCompletionRequest(EditorInlineCompletionRequest),
    /// The editor asks for the definition of a word: Mod held over it
    /// (trigger `hover`: answer with `presentDefinitionLink(id, range)` to
    /// underline it), a Mod-click on it (`press`) or `goToDefinition`
    /// (F12, `key`) at the caret: go to it.
    #[args(event)]
    DefinitionRequest(EditorDefinitionRequest),
    /// The user asked for the code actions at the primary selection
    /// (`showCodeActions`, Mod+.): the app shows its menu at `bounds`.
    #[args(event)]
    CodeActionRequest(EditorCodeActionRequest),
}

/// Where a context menu was asked for in an [`Editor`].
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorContextMenuEvent {
    /// The position in the text under the pointer.
    pub position: EditorPosition,
    /// The pointer's x in the root view.
    pub x: Points,
    /// The pointer's y in the root view.
    pub y: Points,
    /// On touch screens, where the selection a touch made is in the root
    /// view (a long press, a double tap, a handle let go, a tap on the
    /// selection): the edit menu goes above or below it; `x` and `y` are
    /// then its top middle.
    #[prop(skip_none)]
    pub selection: Option<EditorRect>,
}

/// A command of an [`Editor`] (`run(command)`), as its keys run it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PropEnum)]
pub enum EditorCommand {
    /// Left one character.
    MoveLeft,
    /// Right one character.
    MoveRight,
    /// Up one row.
    MoveUp,
    /// Down one row.
    MoveDown,
    /// To the start of the previous word.
    MoveWordLeft,
    /// To the end of the next word.
    MoveWordRight,
    /// To the line's first non-blank character, then its start.
    MoveLineStart,
    /// To the line's end.
    MoveLineEnd,
    /// Up a page.
    MovePageUp,
    /// Down a page.
    MovePageDown,
    /// To the start of the text.
    MoveDocumentStart,
    /// To the end of the text.
    MoveDocumentEnd,
    /// Extends the selections left one character.
    SelectLeft,
    /// Extends the selections right one character.
    SelectRight,
    /// Extends the selections up one row.
    SelectUp,
    /// Extends the selections down one row.
    SelectDown,
    /// Extends the selections to the start of the previous word.
    SelectWordLeft,
    /// Extends the selections to the end of the next word.
    SelectWordRight,
    /// Extends the selections to the line's start.
    SelectLineStart,
    /// Extends the selections to the line's end.
    SelectLineEnd,
    /// Extends the selections up a page.
    SelectPageUp,
    /// Extends the selections down a page.
    SelectPageDown,
    /// Extends the selections to the start of the text.
    SelectDocumentStart,
    /// Extends the selections to the end of the text.
    SelectDocumentEnd,
    /// To the bracket matching the one at the caret.
    MoveToMatchingBracket,
    /// Selects the whole text.
    SelectAll,
    /// Selects the carets' lines (again: the next line too).
    SelectLine,
    /// Selects the word at each caret.
    SelectWord,
    /// Adds a selection at the next occurrence of the selected text (or
    /// selects the word at the caret).
    SelectNextOccurrence,
    /// Selects every occurrence of the selected text.
    SelectAllOccurrences,
    /// Adds a caret on the row above.
    AddCaretAbove,
    /// Adds a caret on the row below.
    AddCaretBelow,
    /// Back to one selection, then to a caret.
    SingleSelection,
    /// Deletes the selection, else the character before the caret.
    DeleteBackward,
    /// Deletes the selection, else the character after the caret.
    DeleteForward,
    /// Deletes to the start of the previous word.
    DeleteWordLeft,
    /// Deletes to the end of the next word.
    DeleteWordRight,
    /// Deletes to the line's start.
    DeleteToLineStart,
    /// Deletes to the line's end.
    DeleteToLineEnd,
    /// Deletes the carets' lines.
    DeleteLine,
    /// A new line at the caret, indented.
    Newline,
    /// A new line below the caret's.
    NewlineBelow,
    /// A new line above the caret's.
    NewlineAbove,
    /// Indents the selected lines (a tab at a caret).
    Indent,
    /// Outdents the selected lines.
    Outdent,
    /// Comments the selected lines out, or back in.
    ToggleComment,
    /// Moves the selected lines up.
    MoveLinesUp,
    /// Moves the selected lines down.
    MoveLinesDown,
    /// Copies the selected lines above them.
    DuplicateLinesUp,
    /// Copies the selected lines below them.
    DuplicateLinesDown,
    /// Joins the selected lines (the next line to the caret's).
    JoinLines,
    /// Swaps the characters around the caret.
    TransposeCharacters,
    /// Takes back the last edit.
    Undo,
    /// Does again the edit undo took back.
    Redo,
    /// Folds the lines under the caret's line.
    Fold,
    /// Unfolds the caret's line.
    Unfold,
    /// Folds every fold.
    FoldAll,
    /// Unfolds everything.
    UnfoldAll,
    /// Selects the next match of the search.
    FindNext,
    /// Selects the previous match of the search.
    FindPrevious,
    /// Copies the selections (the carets' lines).
    Copy,
    /// Cuts the selections (the carets' lines).
    Cut,
    /// Pastes the clipboard's text.
    Paste,
    /// Adds a selection at the previous occurrence of the selected text (or
    /// selects the word at the caret).
    SelectPreviousOccurrence,
    /// Back to the selections before the last move of the carets.
    UndoSelection,
    /// Forward again to the selections `undoSelection` went back from.
    RedoSelection,
    /// Grows each selection to the unit around it: the word, a string's
    /// contents and the string, a bracket pair's contents and the pair, the
    /// line, the text.
    ExpandSelection,
    /// Back to what `expandSelection` grew the selections from.
    ShrinkSelection,
    /// Each selection over several lines becomes one selection per line.
    SplitSelectionIntoLines,
    /// Reports the selected text (a caret: its word) for the app's find bar
    /// (`onFindWithSelection`).
    FindWithSelection,
    /// To the start of the previous part of a word (camelCase humps,
    /// snake_case parts).
    MoveSubwordLeft,
    /// Past the end of the next part of a word.
    MoveSubwordRight,
    /// Extends the selections to the start of the previous part of a word.
    SelectSubwordLeft,
    /// Extends the selections past the end of the next part of a word.
    SelectSubwordRight,
    /// To the blank line before the paragraph.
    MoveParagraphUp,
    /// To the blank line after the paragraph.
    MoveParagraphDown,
    /// Extends the selections to the blank line before the paragraph.
    SelectParagraphUp,
    /// Extends the selections to the blank line after the paragraph.
    SelectParagraphDown,
    /// Sorts the selected lines in ascending order (every line when there
    /// is only a caret).
    SortLinesAscending,
    /// Sorts the selected lines in descending order.
    SortLinesDescending,
    /// Upper-cases the selections (a caret: its word).
    TransformToUppercase,
    /// Lower-cases the selections.
    TransformToLowercase,
    /// Capitalizes each word of the selections.
    TransformToTitleCase,
    /// Removes the whitespace at the end of every line.
    TrimTrailingWhitespace,
    /// Wraps the selections in the language's block comment, or unwraps
    /// them.
    ToggleBlockComment,
    /// Folds the caret's fold and every fold inside it.
    FoldRecursive,
    /// Unfolds the caret's fold and every fold inside it.
    UnfoldRecursive,
    /// Folds the lines of each selection that spans several, wherever
    /// they are.
    FoldSelection,
    /// Asks for completions at the caret, the word before it the query
    /// (with `completion`; no default keys).
    ShowCompletions,
    /// Asks for the definition of the word at the primary caret
    /// (`onDefinitionRequest`, trigger `key`; F12).
    GoToDefinition,
    /// Asks for the code actions at the primary selection
    /// (`onCodeActionRequest`; Mod+.).
    ShowCodeActions,
}

/// The methods of an [`Editor`]'s ref.
pub struct EditorApi {
    ed: Ed,
}

#[methods]
impl EditorApi {
    /// Takes the focus.
    pub fn focus(&self) {
        self.ed.focus();
    }

    /// Gives the focus up.
    pub fn blur(&self) {
        self.ed.blur();
    }

    /// The text.
    pub fn value(&self) -> String {
        self.ed.text()
    }

    /// Replaces the text, as an edit undo takes back.
    pub fn set_value(&self, value: String) {
        self.ed.set_text(&value);
    }

    /// Applies `edits` (ranges of the text as it is, not overlapping; an
    /// overlapping one is dropped) as one edit undo takes back in one step:
    /// the selections follow the text as they do through any edit.
    pub fn edit(&self, edits: Vec<EditorEdit>) {
        self.ed.edit(&edits);
    }

    /// Types `text` at each selection (as typing it would, without the
    /// closing of brackets).
    pub fn insert(&self, text: String) {
        self.ed.insert_plain(&text);
    }

    /// The selections, the primary (newest) last.
    pub fn selections(&self) -> Vec<EditorSelection> {
        self.ed.selections()
    }

    /// Sets the selections (the last one primary) and shows the primary
    /// one.
    pub fn set_selections(&self, selections: Vec<EditorSelection>) {
        self.ed.set_selections(&selections);
    }

    /// Runs `command`, as its keys would.
    pub fn run(&self, command: EditorCommand) {
        self.ed.run_public(command);
    }

    /// Replaces the match the primary selection is on with `text` and
    /// selects the next one (`$1`, `${name}` refer to a regular
    /// expression's groups).
    pub fn replace(&self, text: String) {
        self.ed.replace_current(&text);
    }

    /// Replaces every match with `text`, as one edit: how many.
    pub fn replace_all(&self, text: String) -> u32 {
        self.ed.replace_all(&text)
    }

    /// Folds the lines under line `line` (from 0).
    pub fn fold(&self, line: u32) {
        self.ed.fold(line as usize, Some(true));
    }

    /// Unfolds line `line`.
    pub fn unfold(&self, line: u32) {
        self.ed.fold(line as usize, Some(false));
    }

    /// Scrolls line `line` (from 0) into view.
    pub fn scroll_to_line(&self, line: u32) {
        self.ed.scroll_to_line(line as usize);
    }

    /// Whether there is an edit to take back.
    pub fn can_undo(&self) -> bool {
        self.ed.can_undo()
    }

    /// Whether there is an edit to do again.
    pub fn can_redo(&self) -> bool {
        self.ed.can_redo()
    }

    /// The primary caret's box, in the editor and in the root view: where
    /// a completion menu opens (`null` before the editor is laid out).
    pub fn caret_bounds(&self) -> Option<EditorBounds> {
        self.ed.caret_bounds()
    }

    /// The boxes of `range`, one per row it covers (folded rows have none),
    /// in the editor and in the root view; an empty range's is the caret's
    /// place, without a width.
    pub fn range_bounds(&self, range: EditorRange) -> Vec<EditorBounds> {
        self.ed.range_bounds(range)
    }

    /// How far the text is scrolled, down and to the right.
    pub fn scroll_offset(&self) -> Point<Points> {
        self.ed.scroll_offset()
    }

    /// Scrolls the text to `offset` (the horizontal one is ignored while
    /// lines wrap).
    pub fn set_scroll_offset(&self, offset: Point<Points>) {
        self.ed.set_scroll_offset(offset);
    }

    /// The text the viewport shows: from the start of its first row to the
    /// end of its last, partly shown rows included.
    pub fn visible_range(&self) -> EditorRange {
        self.ed.visible_range()
    }

    /// The primary selection's text.
    pub fn selected_text(&self) -> String {
        self.ed.selected_text()
    }

    /// The position of `offset`, in UTF-16 code units of the text as
    /// `value()` returns it (`\r\n` came in as `\n`); past the end, the
    /// end.
    pub fn offset_to_position(&self, offset: u32) -> EditorPosition {
        self.ed.offset_to_position(offset)
    }

    /// The offset of `position`, in UTF-16 code units of the text as
    /// `value()` returns it.
    pub fn position_to_offset(&self, position: EditorPosition) -> u32 {
        self.ed.position_to_offset(position)
    }

    /// Scrolls `position` into view (unfolding what hides it), in the
    /// middle of the viewport with `center`.
    pub fn reveal_position(&self, position: EditorPosition, center: bool) {
        self.ed.reveal_position(position, center);
    }

    /// Puts the caret at the start of line `line` (from 0) and scrolls it
    /// to the middle of the viewport.
    pub fn go_to_line(&self, line: u32) {
        self.ed.go_to_line(line);
    }

    /// Folds the fold on line `line` (starting there, else the innermost
    /// one around it) and every fold inside it.
    pub fn fold_recursive(&self, line: u32) {
        let line = line as usize;
        self.ed.fold_with(|st| st.fold_recursive(line));
    }

    /// Unfolds the fold on line `line` and every fold inside it.
    pub fn unfold_recursive(&self, line: u32) {
        let line = line as usize;
        self.ed.fold_with(|st| st.unfold_recursive(line));
    }

    /// Folds every fold at nesting level `level` (1: those inside no
    /// other), leaving the others as they are.
    pub fn fold_level(&self, level: u32) {
        self.ed.fold_with(|st| st.fold_level(level as usize));
    }

    /// Folds the lines of `range`, whether a fold can start there or not.
    pub fn fold_range(&self, range: EditorFoldRange) {
        let (start, end) = (range.start_line as usize, range.end_line as usize);
        self.ed.fold_with(|st| st.fold_lines(start, end));
    }

    /// The folded ranges, nested ones included, by start.
    pub fn folds(&self) -> Vec<EditorFoldRange> {
        self.ed.folds()
    }

    /// Replaces the folded ranges (any lines; a range crossing an earlier
    /// one's end is dropped).
    pub fn set_folds(&self, folds: Vec<EditorFoldRange>) {
        self.ed.set_folds(&folds);
    }

    /// Asks for completions at the caret (`onCompletionRequest`, trigger
    /// `invoked`), the word before it the query.
    pub fn show_completions(&self) {
        self.ed.show_completions();
    }

    /// Answers completion request `id` with `items`: the list shows them,
    /// filtered by what has been typed since; `incomplete`, typing on asks
    /// again. Dropped when stale (a request since, the caret left the
    /// word); no items close the list.
    pub fn present_completions(
        &self,
        id: u32,
        items: Vec<EditorCompletionItem>,
        incomplete: Option<bool>,
    ) {
        self.ed
            .present_completions(id, items, incomplete.unwrap_or(false));
    }

    /// Closes the completion list.
    pub fn hide_completions(&self) {
        self.ed.hide_completions();
    }

    /// Answers inline completion request `id` with `text`, shown at the
    /// caret until Tab inserts it or an edit or a move clears it; dropped
    /// when stale (the caret or the text changed since).
    pub fn present_inline_completion(&self, id: u32, text: String) {
        self.ed.present_inline_completion(id, text);
    }

    /// Clears the inline completion.
    pub fn hide_inline_completion(&self) {
        self.ed.hide_inline_completion();
    }

    /// Answers definition request `id` (trigger `hover`) with `range`, the
    /// symbol a definition was found for: it is underlined, with a hand
    /// over it, until Mod is released, the pointer leaves it or the text
    /// changes. Dropped when stale (a request since, Mod released, an
    /// edit).
    pub fn present_definition_link(&self, id: u32, range: EditorRange) {
        self.ed.present_definition_link(id, range);
    }

    /// Hides the definition link.
    pub fn hide_definition_link(&self) {
        self.ed.hide_definition_link();
    }
}

/// A code editor: the text drawn row by row with the built-in syntax
/// colors (or the app's decorations), a gutter of line numbers and fold
/// markers, carets and selections, with the keys and commands of code
/// editors (several carets, moving and duplicating lines, comments,
/// indentation, brackets that close), folding, soft wrap, search and
/// replace, and diagnostics. Only the rows in view are made, so long files
/// scroll as short ones do.
#[component(methods = EditorApi)]
pub fn Editor(props: EditorProps, cx: Scope<EditorEvent>) -> impl IntoElement {
    let ed = Ed::new(props, cx);
    cx.methods(EditorApi { ed: ed.clone() });
    view::render(ed)
}

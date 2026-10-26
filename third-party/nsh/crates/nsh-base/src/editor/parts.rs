//! The parts of an [`super::Editor`] the app styles: Tailwind classes
//! ([`EditorClasses`]) and inline styles ([`EditorStyles`]) by part, over
//! the editor's defaults (the theme's tokens).

use nsh_core::{element::Style, prelude::*};

use crate::text_view::PartStyle;

/// Declares the parts once: the classes' object, the styles' object and
/// [`EditorPart`], each field documented alike.
macro_rules! parts {
    ($( $(#[doc = $doc:literal])* $field:ident => $variant:ident ),* $(,)?) => {
        /// Tailwind classes of an `Editor`'s parts
        /// (`classes={{ gutter: "bg-muted", lineNumber: "text-xs" }}`),
        /// after the part's own styles: at equal rank they win.
        #[derive(Debug, Clone, Default, PartialEq, JsObject)]
        #[non_exhaustive]
        pub struct EditorClasses {
            $( $(#[doc = $doc])* #[prop(skip_none)] pub $field: Option<SharedString>, )*
        }

        /// Inline styles of an `Editor`'s parts
        /// (`styles={{ caret: { backgroundColor: "#f59e0b" } }}`), over
        /// its classes.
        #[derive(Debug, Clone, Default, PartialEq, JsObject)]
        #[non_exhaustive]
        pub struct EditorStyles {
            $( $(#[doc = $doc])* #[prop(skip_none)] pub $field: Option<PartStyle>, )*
        }

        /// A part of an [`super::Editor`].
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        #[non_exhaustive]
        pub enum EditorPart {
            $( $(#[doc = $doc])* $variant, )*
        }

        impl EditorClasses {
            /// Part `part`'s classes.
            pub(crate) fn get(&self, part: EditorPart) -> Option<&SharedString> {
                match part {
                    $( EditorPart::$variant => self.$field.as_ref(), )*
                }
            }
        }

        impl EditorStyles {
            /// Part `part`'s style.
            pub(crate) fn get(&self, part: EditorPart) -> Option<&Style> {
                match part {
                    $( EditorPart::$variant => self.$field.as_ref().map(|s| &s.0), )*
                }
            }
        }
    };
}

parts! {
    /// The gutter: the column of line numbers and fold markers at the
    /// start of the rows (its padding is the room around them).
    gutter => Gutter,
    /// Every line number (right-aligned in the gutter, muted).
    line_number => LineNumber,
    /// The numbers of the lines with a caret, after `lineNumber`.
    active_line_number => ActiveLineNumber,
    /// The marker of a line where a fold starts (`⌄`, `›` folded), shown
    /// in the gutter.
    fold_marker => FoldMarker,
    /// The text area: the rows, beside the gutter (its padding is the room
    /// around the text).
    content => Content,
    /// Every row of text.
    line => Line,
    /// The background of the rows of the lines with a caret, behind the
    /// text (a faint fill).
    active_line => ActiveLine,
    /// The background of selected text.
    selection => Selection,
    /// The carets (2 points wide, in the text's color).
    caret => Caret,
    /// The text an input method is composing at the caret (underlined).
    composition => Composition,
    /// The matches of `search` (a translucent amber).
    search_match => SearchMatch,
    /// The match the primary selection is on, after `searchMatch`.
    current_search_match => CurrentSearchMatch,
    /// The bracket matching the one at the caret, and that one (a
    /// border).
    matching_bracket => MatchingBracket,
    /// The guides of indentation (a 1 point line per level).
    indent_guide => IndentGuide,
    /// What a folded line shows after its text (`…`).
    fold_placeholder => FoldPlaceholder,
    /// The placeholder, shown while the text is empty.
    placeholder => Placeholder,
    /// An error's range: its text underlined with a 1 point wavy line in
    /// the theme's `destructive` (a short line on an empty line).
    diagnostic_error => DiagnosticError,
    /// A warning's range, underlined the same way in amber.
    diagnostic_warning => DiagnosticWarning,
    /// An information's range, underlined the same way in blue.
    diagnostic_info => DiagnosticInfo,
    /// A hint's range, underlined the same way in `muted-foreground`.
    diagnostic_hint => DiagnosticHint,
    /// The text of an `unnecessary` diagnostic (unused, unreachable code):
    /// faded, in the theme's `muted-foreground`; a hint's mark is left
    /// out under it.
    unnecessary_text => UnnecessaryText,
    /// The text of a `deprecated` diagnostic (struck through).
    deprecated_text => DeprecatedText,
    /// The marks of spaces (`·`) and tabs (`→`) while `showWhitespaces`
    /// is set (muted, translucent).
    whitespace => Whitespace,
    /// The lines of `rulers` (a 1 point line in the theme's `border`).
    ruler => Ruler,
    /// The knobs of the handles at the ends of a selection a touch made
    /// (a 10 point dot in `primary`, above the start's line and below the
    /// end's); the hit area around each is the editor's.
    selection_handle => SelectionHandle,
    /// The start's knob, after `selectionHandle`.
    selection_handle_start => SelectionHandleStart,
    /// The end's knob, after `selectionHandle`.
    selection_handle_end => SelectionHandleEnd,
    /// The completion list (`completion`): the box of its items, below the
    /// query (above it without room), in the theme's `popover` with a
    /// border, rounded and shadowed.
    completion_menu => CompletionMenu,
    /// Every item of the completion list (a row's height, its kind, label
    /// and detail in a row).
    completion_item => CompletionItem,
    /// The selected item, after `completionItem` (the theme's `accent`).
    selected_completion_item => SelectedCompletionItem,
    /// The characters of an item's label the query matched (semibold, in
    /// the theme's `primary`).
    completion_match => CompletionMatch,
    /// An item's detail, right-aligned after its label (muted).
    completion_detail => CompletionDetail,
    /// An item's kind, a short label before it (muted).
    completion_kind => CompletionKind,
    /// The selected item's documentation, beside the list (as the list's
    /// box, at most 320 points wide).
    completion_documentation => CompletionDocumentation,
    /// The inline completion's text at the caret (muted; on the editor's
    /// background over the text after the caret).
    inline_completion => InlineCompletion,
    /// The underline of the definition link, shown while Mod is held over
    /// a word the app answered for (a 1 point line under the text, in the
    /// theme's `primary`).
    definition_link => DefinitionLink,
}

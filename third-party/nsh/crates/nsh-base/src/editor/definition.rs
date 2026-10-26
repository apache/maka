//! Go to definition and code actions, built into the editor in the shape
//! of completion: the editor asks the app (`onDefinitionRequest`,
//! `onCodeActionRequest`) and the app answers later through the ref
//! (`presentDefinitionLink`), so the main thread never waits for JS.
//!
//! With Mod held (Command on Apple platforms, Control elsewhere) the word
//! under the pointer is asked about at once (trigger `hover`); the app's
//! answer underlines the range it gives (the `definitionLink` part) and
//! turns the pointer into a hand over it, until Mod is released, the
//! pointer leaves the range or the editor, or the text changes or scrolls.
//! A Mod-click on the text asks with trigger `press` (on the link the caret
//! stays where it is, as GPUI Kit's editor does), F12 (`goToDefinition`)
//! with trigger `key` at the primary caret. Requests count up (`id`); an
//! answer to any but the last hover request is dropped.
//!
//! `showCodeActions` (Mod+.) reports the primary selection and the
//! caret's box (`onCodeActionRequest`): the app asks its language server
//! and shows its own menu there, then applies what is picked with `edit`.

use std::{cell::RefCell, ops::Range, rc::Rc};

use nsh_core::{element::Os, keymap::Modifiers, prelude::*};

use super::{
    EditorBounds, EditorEvent, EditorPart, EditorPosition, EditorRange,
    controller::Ed,
    hooks::{hit, utf16_offset, word_at},
    movement,
    state::State,
    view::part,
};
use crate::theme;

/// The thickness of the definition link's underline.
const UNDERLINE: f32 = 1.0;

/// What asks an [`super::Editor`] for a definition.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PropEnum)]
pub enum EditorDefinitionTrigger {
    /// The pointer is over the word with Mod held: answer with
    /// `presentDefinitionLink(id, range)` to underline it.
    #[default]
    Hover,
    /// A Mod-click on the word: go to its definition.
    Press,
    /// `goToDefinition` (F12) at the primary caret: go to its definition.
    Key,
}

/// An editor asks for the definition of a word (`onDefinitionRequest`):
/// what to ask a language server (`textDocument/definition`) and why.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorDefinitionRequest {
    /// Which request this is: they count up, and only the answer to the
    /// last hover request underlines.
    pub id: u32,
    /// The character asked about (the caret's place for trigger `key`).
    pub position: EditorPosition,
    /// The same place as an offset in the text (UTF-16 code units).
    pub offset: u32,
    /// The word there.
    pub range: EditorRange,
    /// What asks.
    pub trigger: EditorDefinitionTrigger,
}

/// An editor asks for the code actions at its primary selection
/// (`onCodeActionRequest`, `showCodeActions`): what to ask a language
/// server (`textDocument/codeAction`) and where to show its answer.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct EditorCodeActionRequest {
    /// The primary selection, start before end (a caret: empty).
    pub range: EditorRange,
    /// The primary caret.
    pub position: EditorPosition,
    /// The caret's box, in the editor and in the root view: where the
    /// menu opens (absent before the editor is laid out).
    #[prop(skip_none)]
    pub bounds: Option<EditorBounds>,
}

/// A hover request being answered.
#[derive(Debug, Clone)]
struct Asked {
    id: u32,
    /// The word asked about: the pointer moving inside it asks nothing
    /// more.
    word: Range<usize>,
    /// The buffer's version it is for.
    version: u64,
}

#[derive(Debug, Default)]
struct Inner {
    /// The last request's id.
    last_id: u32,
    asked: Option<Asked>,
}

/// The editor's definition link. Cloned with the controller.
#[derive(Clone)]
pub(crate) struct Definition {
    inner: Rc<RefCell<Inner>>,
    /// The range underlined, while the app's answer shows.
    pub(crate) link: Signal<Option<Range<usize>>>,
}

impl Definition {
    pub(crate) fn new() -> Definition {
        Definition {
            inner: Rc::default(),
            link: signal(None),
        }
    }
}

/// Whether `modifiers` hold Mod alone of Mod and Alt (Command on Apple
/// platforms, Control elsewhere, as the keymap's `mod`); Alt adds carets.
pub(crate) fn mod_held(modifiers: Modifiers) -> bool {
    mod_of(modifiers, matches!(os(), Os::Ios | Os::MacOs))
}

/// [`mod_held`] on Apple platforms (`apple`) or the others.
fn mod_of(modifiers: Modifiers, apple: bool) -> bool {
    let held = if apple { modifiers.cmd } else { modifiers.ctrl };
    held && !modifiers.alt
}

/// Whether `range` holds anything a definition can be of: a character of a
/// word (not blanks or punctuation alone).
fn is_symbol(st: &State, range: &Range<usize>) -> bool {
    let word_chars = st.language.word_chars;
    st.buffer
        .slice(range.clone())
        .chars()
        .any(|c| c.is_alphanumeric() || c == '_' || word_chars.contains(c))
}

/// Whether `range` holds character `offset`.
fn holds(range: &Range<usize>, offset: usize) -> bool {
    range.start <= offset && offset < range.end
}

impl Ed {
    /// What ends the link: an edit or a new layout of the text, and
    /// scrolling (the text moves from under the pointer).
    pub(crate) fn follow_definition(&self) {
        let ed = self.clone();
        effect(move || {
            ed.text_rev.get();
            ed.scroll_x.get();
            ed.scroll_y.get();
            untracked(|| ed.hide_definition_link());
        });
    }

    /// The pointer is at `local` of the rows' box with `modifiers`: with
    /// Mod held over a word, asks for its definition (trigger `hover`),
    /// unless it is the word asked about or the link shown; anything else
    /// hides the link.
    pub(crate) fn definition_hover(&self, local: Point<Points>, modifiers: Modifiers) {
        if !mod_held(modifiers) {
            self.hide_definition_link();
            return;
        }
        let found = {
            let st = self.st.borrow();
            let hit = hit(&st, local);
            hit.over.then(|| (hit.offset, word_at(&st, hit.offset)))
        };
        let Some((offset, word)) = found else {
            self.hide_definition_link();
            return;
        };
        if let Some(link) = self.definition.link.get_untracked() {
            if holds(&link, offset) {
                return;
            }
        } else if let Some(asked) = &self.definition.inner.borrow().asked
            && holds(&asked.word, offset)
        {
            return;
        }
        self.hide_definition_link();
        if is_symbol(&self.st.borrow(), &word) {
            self.request_definition(offset, word, EditorDefinitionTrigger::Hover);
        }
    }

    /// Whether a press at `local` with `modifiers` is a Mod-click on the
    /// link shown: the caret then stays where it is.
    pub(crate) fn on_definition_link(
        &self,
        local: Point<Points>,
        modifiers: Modifiers,
        clicks: u32,
    ) -> bool {
        if !mod_held(modifiers) || clicks > 1 {
            return false;
        }
        let Some(link) = self.definition.link.get_untracked() else {
            return false;
        };
        let hit = hit(&self.st.borrow(), local);
        hit.over && holds(&link, hit.offset)
    }

    /// A press at `local` with `modifiers`, after the caret was placed (or
    /// kept, on the link): a Mod-click on a word asks for its definition
    /// (trigger `press`).
    pub(crate) fn definition_press(&self, local: Point<Points>, modifiers: Modifiers, clicks: u32) {
        if !mod_held(modifiers) || clicks > 1 {
            return;
        }
        let found = {
            let st = self.st.borrow();
            let hit = hit(&st, local);
            let word = word_at(&st, hit.offset);
            (hit.over && is_symbol(&st, &word)).then_some((hit.offset, word))
        };
        if let Some((offset, word)) = found {
            self.request_definition(offset, word, EditorDefinitionTrigger::Press);
        }
    }

    /// `goToDefinition`: asks for the definition of the word at the
    /// primary caret (trigger `key`), the word before it at a word's end.
    pub(crate) fn go_to_definition(&self) {
        let (offset, word) = {
            let st = self.st.borrow();
            let head = st.primary_head();
            let word = movement::word_range(&st.buffer, head, st.language.word_chars);
            (head, word)
        };
        self.request_definition(offset, word, EditorDefinitionTrigger::Key);
    }

    fn request_definition(
        &self,
        offset: usize,
        word: Range<usize>,
        trigger: EditorDefinitionTrigger,
    ) {
        let event = {
            let st = self.st.borrow();
            let mut inner = self.definition.inner.borrow_mut();
            inner.last_id = inner.last_id.wrapping_add(1).max(1);
            let id = inner.last_id;
            if trigger == EditorDefinitionTrigger::Hover {
                inner.asked = Some(Asked {
                    id,
                    word: word.clone(),
                    version: st.buffer.version(),
                });
            }
            EditorDefinitionRequest {
                id,
                position: st.position(offset),
                offset: utf16_offset(&st.buffer, offset),
                range: EditorRange::new(st.position(word.start), st.position(word.end)),
                trigger,
            }
        };
        self.cx.emit(EditorEvent::DefinitionRequest(event));
    }

    /// Answers hover request `id`: underlines `range`. Dropped when stale
    /// (a request since, Mod released, the pointer gone, an edit) or
    /// empty.
    pub(crate) fn present_definition_link(&self, id: u32, range: EditorRange) {
        let link = {
            let st = self.st.borrow();
            let inner = self.definition.inner.borrow();
            let Some(asked) = &inner.asked else { return };
            if asked.id != id || asked.version != st.buffer.version() {
                return;
            }
            let (a, b) = (st.offset_of(range.start), st.offset_of(range.end));
            if a == b {
                return;
            }
            a.min(b)..a.max(b)
        };
        self.definition.link.set(Some(link));
    }

    /// Hides the link, and drops the answer of the hover request out.
    pub(crate) fn hide_definition_link(&self) {
        self.definition.inner.borrow_mut().asked = None;
        if self.definition.link.get_untracked().is_some() {
            self.definition.link.set(None);
        }
    }

    /// `showCodeActions`: reports the primary selection and the caret's
    /// box.
    pub(crate) fn show_code_actions(&self) {
        let (range, position) = {
            let st = self.st.borrow();
            let selection = st.selections.primary().range();
            (
                EditorRange::new(st.position(selection.start), st.position(selection.end)),
                st.position(st.primary_head()),
            )
        };
        let event = EditorCodeActionRequest {
            range,
            position,
            bounds: self.caret_bounds(),
        };
        self.cx.emit(EditorEvent::CodeActionRequest(event));
    }
}

/// The link's underline on the rows in view, under the text of each row it
/// covers.
pub(crate) fn link_marks(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        let Some(link) = ed.definition.link.get() else {
            return Vec::new();
        };
        ed.text_rev.get();
        let rows = ed.visible_rows();
        let st = ed.st.borrow();
        // Under the glyphs rather than at the row's bottom, where the
        // diagnostics' marks go: the font's descent below the baseline of a
        // row's text, centered in its row.
        let under = st.line_height() / 2.0 + st.font.size * 0.45;
        st.range_rects(link, rows, false)
            .into_iter()
            .map(|b| {
                let bar = Bounds::new(
                    Point::new(
                        b.origin.x,
                        b.origin.y + under.min(b.size.height - px(UNDERLINE)),
                    ),
                    Size::new(b.size.width, px(UNDERLINE)),
                );
                part(
                    view()
                        .absolute()
                        .left(Length::from(bar.origin.x))
                        .top(Length::from(bar.origin.y))
                        .w(Length::from(bar.size.width))
                        .h(Length::from(bar.size.height))
                        .pointer_events(PointerEvents::None)
                        .bg(|| theme().primary),
                    props,
                    EditorPart::DefinitionLink,
                )
            })
            .collect::<Vec<_>>()
    })
}

#[cfg(test)]
mod tests {
    use super::{
        super::{
            commands::EditOptions,
            language,
            state::{Font, State},
        },
        *,
    };

    fn state(text: &str) -> State {
        let font = Font {
            family: "monospace".into(),
            size: px(13.0),
            line_height: px(20.0),
        };
        let measure: Rc<dyn Fn(&str) -> Points> =
            Rc::new(|text: &str| px(10.0 * text.chars().count() as f32));
        State::new(
            text,
            language::language("rust"),
            EditOptions::default(),
            font,
            measure,
        )
    }

    #[test]
    fn symbols_are_words_not_blanks_or_punctuation() {
        let st = state("let foo = a_b;");
        assert!(is_symbol(&st, &(4..7)));
        assert!(is_symbol(&st, &(10..13)));
        assert!(!is_symbol(&st, &(3..4)));
        assert!(!is_symbol(&st, &(8..9)));
        assert!(!is_symbol(&st, &(13..14)));
    }

    #[test]
    fn a_range_holds_its_characters_only() {
        assert!(holds(&(4..7), 4));
        assert!(holds(&(4..7), 6));
        assert!(!holds(&(4..7), 7));
        assert!(!holds(&(4..7), 3));
    }

    /// The link's underline follows its word's characters in any text:
    /// Chinese (three bytes, one UTF-16 unit), an emoji (four bytes, two
    /// units), and `\r\n` and `\r` line breaks (one `\n` in the buffer).
    #[test]
    fn a_word_is_underlined_where_its_characters_are() {
        for text in [
            "let 名字 = foo;\nlet bar = 你好世界(foo, 👍x);\nbaz(bar)",
            "let 名字 = foo;\r\nlet bar = 你好世界(foo, 👍x);\r\nbaz(bar)",
            "let 名字 = foo;\rlet bar = 你好世界(foo, 👍x);\rbaz(bar)",
        ] {
            let st = state(text);
            let lines = st.buffer.line_count();
            assert_eq!(lines, 3, "{text:?}");
            let rows = 0..st.display.row_count();
            for word in ["名字", "foo", "bar", "你好世界", "baz"] {
                let at = st.buffer.text().find(word).unwrap();
                let found = word_at(&st, at);
                assert_eq!(found, at..at + word.len(), "{word} in {text:?}");
                // Through the position the app answers with.
                let (a, b) = (st.position(found.start), st.position(found.end));
                assert_eq!(
                    (st.offset_of(a), st.offset_of(b)),
                    (found.start, found.end),
                    "{word} in {text:?}"
                );
                // The columns count UTF-16 units of the (normalized) line.
                let line = st
                    .buffer
                    .text()
                    .lines()
                    .nth(a.line as usize)
                    .unwrap()
                    .to_owned();
                let before: usize = line[..line.find(word).unwrap()].encode_utf16().count();
                assert_eq!(a.column as usize, before, "{word} in {text:?}");
                // Its rectangle starts where its first character is and
                // is as wide as the word.
                let rects = st.range_rects(found.clone(), rows.clone(), false);
                assert_eq!(rects.len(), 1, "{word} in {text:?}");
                let row = st.display.locate(&st.buffer.snapshot(), found.start).0;
                assert_eq!(
                    rects[0].origin.x,
                    st.display.x_in(&st.buffer, row, found.start)
                );
                assert_eq!(
                    rects[0].size.width,
                    st.display.x_in(&st.buffer, row, found.end)
                        - st.display.x_in(&st.buffer, row, found.start)
                );
                // A pointer over its middle hits one of its characters.
                let mid = Point::new(
                    rects[0].origin.x + rects[0].size.width / 2.0,
                    rects[0].origin.y + px(5.0),
                );
                let hit = hit(&st, mid);
                assert!(hit.over && holds(&found, hit.offset), "{word} in {text:?}");
            }
        }
    }

    #[test]
    fn mod_is_command_on_apple_platforms_and_control_elsewhere_without_alt() {
        let modifier = |cmd: bool, ctrl: bool, alt: bool| Modifiers {
            cmd,
            ctrl,
            alt,
            shift: false,
        };
        assert!(mod_of(modifier(true, false, false), true));
        assert!(!mod_of(modifier(false, true, false), true));
        assert!(mod_of(modifier(false, true, false), false));
        assert!(!mod_of(modifier(true, false, false), false));
        assert!(!mod_of(modifier(true, false, true), true));
        assert!(!mod_of(modifier(false, true, true), false));
        assert!(!mod_of(Modifiers::default(), false));
    }
}

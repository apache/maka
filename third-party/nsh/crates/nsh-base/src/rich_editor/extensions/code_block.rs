//! The key bindings of Tiptap's `CodeBlock`: `Mod-Alt-c` toggles a code
//! block; Backspace at the very start or in an empty block turns it back
//! into a paragraph; a third Enter at the end leaves it; ArrowDown at its
//! end and ArrowUp at the start of a first block leave it; Tab and
//! Shift-Tab indent when enabled. Ported from
//! `@tiptap/extension-code-block`.

use serde_json::Value;

use super::helpers::{Step, chain, clear_nodes, insert_default_block};
use crate::rich_editor::{
    commands::{BoxCommand, Dispatch, command, exit_code, tiptap},
    model::NodeType,
    state::{EditorState, Selection, TextSelection},
};

/// The options of [`code_block_keymap`], with Tiptap's defaults.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct CodeBlockOptions {
    /// Whether a third Enter at the end (after two line breaks) leaves the
    /// block (default true).
    pub exit_on_triple_enter: bool,
    /// Whether ArrowDown at the end leaves the block (default true).
    pub exit_on_arrow_down: bool,
    /// Whether ArrowUp at the start of the document's first block puts a
    /// paragraph before it (default true).
    pub exit_on_arrow_up: bool,
    /// Whether Tab and Shift-Tab indent and outdent lines (default false).
    pub enable_tab_indentation: bool,
    /// The spaces of an indentation (default 4).
    pub tab_size: usize,
}

impl Default for CodeBlockOptions {
    fn default() -> Self {
        Self {
            exit_on_triple_enter: true,
            exit_on_arrow_down: true,
            exit_on_arrow_up: true,
            enable_tab_indentation: false,
            tab_size: 4,
        }
    }
}

/// The bindings of Tiptap's code block for the code block type `ty`, its
/// toggle going back to `paragraph`.
pub fn code_block_keymap(
    ty: &NodeType,
    paragraph: Option<NodeType>,
    options: &CodeBlockOptions,
) -> Vec<(String, BoxCommand)> {
    let mut keys = Vec::new();
    if let Some(paragraph) = paragraph {
        keys.push((
            "Mod-Alt-c".into(),
            tiptap::toggle_node(ty.clone(), paragraph, Default::default()),
        ));
    }
    let t = ty.clone();
    keys.push((
        "Backspace".into(),
        command(move |state, dispatch| backspace(state, dispatch, &t)),
    ));
    if options.enable_tab_indentation {
        let (t, size) = (ty.clone(), options.tab_size);
        keys.push((
            "Tab".into(),
            command(move |state, dispatch| indent(state, dispatch, &t, size)),
        ));
        let t = ty.clone();
        keys.push((
            "Shift-Tab".into(),
            command(move |state, dispatch| outdent(state, dispatch, &t, size)),
        ));
    }
    if options.exit_on_triple_enter {
        let t = ty.clone();
        keys.push((
            "Enter".into(),
            command(move |state, dispatch| triple_enter(state, dispatch, &t)),
        ));
    }
    if options.exit_on_arrow_up {
        let t = ty.clone();
        keys.push((
            "ArrowUp".into(),
            command(move |state, dispatch| arrow_up(state, dispatch, &t)),
        ));
    }
    if options.exit_on_arrow_down {
        let t = ty.clone();
        keys.push((
            "ArrowDown".into(),
            command(move |state, dispatch| arrow_down(state, dispatch, &t)),
        ));
    }
    keys
}

// The cursor, when the selection is one in a block of `ty`.
fn cursor_in<'a>(
    state: &'a EditorState,
    ty: &NodeType,
) -> Option<&'a crate::rich_editor::model::ResolvedPos> {
    let selection = state.selection();
    let from = selection.resolved_from();
    (selection.empty() && from.parent().ty() == ty).then_some(from)
}

fn backspace(state: &EditorState, dispatch: Dispatch<'_>, ty: &NodeType) -> bool {
    let Some(at) = cursor_in(state, ty) else {
        return false;
    };
    if at.pos == 1 || at.parent().text_content().is_empty() {
        return clear_nodes(state, dispatch);
    }
    false
}

fn triple_enter(state: &EditorState, dispatch: Dispatch<'_>, ty: &NodeType) -> bool {
    let Some(at) = cursor_in(state, ty) else {
        return false;
    };
    let at_end = at.parent_offset == at.parent().content().size();
    if !at_end || !at.parent().text_content().ends_with("\n\n") {
        return false;
    }
    let pos = at.pos;
    let delete = move |state: &EditorState, dispatch: Dispatch<'_>| {
        let mut tr = state.tr();
        if tr.delete(pos - 2, pos).is_err() {
            return false;
        }
        if let Some(dispatch) = dispatch {
            dispatch(tr);
        }
        true
    };
    let steps: [Step<'_>; 2] = [&delete, &exit_code];
    chain(state, dispatch, &steps)
}

fn arrow_up(state: &EditorState, dispatch: Dispatch<'_>, ty: &NodeType) -> bool {
    let Some(at) = cursor_in(state, ty) else {
        return false;
    };
    if at.parent_offset != 0 || at.before(at.depth) > 0 {
        return false;
    }
    insert_default_block(state, 0, dispatch)
}

fn arrow_down(state: &EditorState, dispatch: Dispatch<'_>, ty: &NodeType) -> bool {
    let Some(at) = cursor_in(state, ty) else {
        return false;
    };
    if at.parent_offset != at.parent().content().size() {
        return false;
    }
    let after = at.after(at.depth);
    if state.doc().node_at(after).is_some() {
        let Ok(after) = state.doc().resolve(after) else {
            return false;
        };
        if let Some(dispatch) = dispatch {
            let mut tr = state.tr();
            tr.set_selection(Selection::near(&after, 1));
            dispatch(tr);
        }
        return true;
    }
    exit_code(state, dispatch)
}

fn indent(state: &EditorState, dispatch: Dispatch<'_>, ty: &NodeType, size: usize) -> bool {
    let selection = state.selection();
    if selection.resolved_from().parent().ty() != ty {
        return false;
    }
    let indent = " ".repeat(size);
    if let Some(dispatch) = dispatch {
        let mut tr = state.tr();
        if selection.empty() {
            tr.insert_text(&indent, None, None);
        } else {
            let (from, to) = (selection.from(), selection.to());
            let text = state.doc().text_between(from, to, Some("\n"), Some("\n"));
            let lines: Vec<String> = text.split('\n').map(|l| format!("{indent}{l}")).collect();
            let node = state.schema().text(&lines.join("\n"), vec![]);
            if tr.replace_with(from, to, node.into()).is_err() {
                return false;
            }
        }
        dispatch(tr);
    }
    true
}

fn outdent(state: &EditorState, dispatch: Dispatch<'_>, ty: &NodeType, size: usize) -> bool {
    let selection = state.selection();
    let from = selection.resolved_from();
    if from.parent().ty() != ty {
        return false;
    }
    let leading = |line: &str| line.len() - line.trim_start_matches(' ').len();
    let Some(dispatch) = dispatch else {
        return true;
    };
    let mut tr = state.tr();
    if selection.empty() {
        let (start, end) = (from.start(from.depth), from.end(from.depth));
        let text = state.doc().text_between(start, end, Some("\n"), Some("\n"));
        let lines: Vec<&str> = text.split('\n').collect();
        let relative = from.pos - start;
        let mut index = 0;
        let mut count = 0;
        for (i, line) in lines.iter().enumerate() {
            let len = crate::rich_editor::model::utf16_len(line);
            if count + len >= relative {
                index = i;
                break;
            }
            count += len + 1;
        }
        let remove = leading(lines[index]).min(size);
        if remove == 0 {
            return true;
        }
        let line_start = start
            + lines[..index]
                .iter()
                .map(|l| crate::rich_editor::model::utf16_len(l) + 1)
                .sum::<usize>();
        if tr.delete(line_start, line_start + remove).is_err() {
            return false;
        }
        if from.pos - line_start <= remove {
            tr.set_selection(TextSelection::create(tr.doc(), line_start, None));
        }
    } else {
        let (from, to) = (selection.from(), selection.to());
        let text = state.doc().text_between(from, to, Some("\n"), Some("\n"));
        let lines: Vec<&str> = text
            .split('\n')
            .map(|l| &l[leading(l).min(size)..])
            .collect();
        let joined = lines.join("\n");
        let replaced = if joined.is_empty() {
            tr.delete(from, to).is_ok()
        } else {
            let node = state.schema().text(&joined, vec![]);
            tr.replace_with(from, to, node.into()).is_ok()
        };
        if !replaced {
            return false;
        }
    }
    dispatch(tr);
    true
}

/// The language a fence's match names: its first group, when there is one
/// (``` ```rust ``` gives `rust`).
pub(crate) fn fence_language(language: Option<&str>) -> Value {
    language.map_or(Value::Null, Value::from)
}

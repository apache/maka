//! Paste rules, after Tiptap's: expressions run over the text of pasted
//! content, which change it as it goes in (`**bold**` pasted is bold
//! text). A rule finds every match in each pasted text node (outside code
//! blocks) and marks it (`mark_paste_rule`), replaces it with an inline
//! node (`node_paste_rule`) or with text (`text_paste_rule`). The rules
//! run on the pasted slice, before it is inserted (the plugin's
//! `transform_pasted`).

use std::sync::Arc;

use regex::Regex;

use super::input_rules::{GetAttrs, InputMatch};
use crate::rich_editor::{
    model::{Fragment, Mark, MarkType, Node, NodeType, Slice},
    state::{EditorState, Plugin, PluginKey, PluginSpec},
};

/// Finds every match in a text: each match's byte offset in the text and
/// what it matched (groups' offsets in UTF-16 units from its start).
pub type PasteFinder = Arc<dyn Fn(&str) -> Vec<(usize, InputMatch)> + Send + Sync>;

/// What a paste rule does with a match.
#[derive(Clone)]
#[non_exhaustive]
pub enum PasteAction {
    /// Marks the last capture group and drops the rest of the match but
    /// its leading white space (Tiptap's `markPasteRule`).
    Mark(MarkType, Option<GetAttrs>),
    /// Replaces the match with an inline node (Tiptap's `nodePasteRule`).
    Node(NodeType, Option<GetAttrs>),
    /// Replaces the first capture group (or the match) with text, keeping
    /// what follows it (Tiptap's `textPasteRule`).
    Text(String),
}

/// A paste rule: how it finds matches and what it does with them.
#[derive(Clone)]
#[non_exhaustive]
pub struct PasteRule {
    /// Finds the matches in a text node's text.
    pub find: PasteFinder,
    /// What it does with each.
    pub action: PasteAction,
}

impl std::fmt::Debug for PasteRule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PasteRule").finish_non_exhaustive()
    }
}

impl PasteRule {
    /// A rule matching what `find` finds.
    pub fn new(
        find: impl Fn(&str) -> Vec<(usize, InputMatch)> + Send + Sync + 'static,
        action: PasteAction,
    ) -> Self {
        Self {
            find: Arc::new(find),
            action,
        }
    }

    /// A rule matching every match of `regex` (Tiptap's global
    /// expressions), keeping only those `accept` takes.
    pub fn regex(
        regex: Regex,
        accept: impl Fn(&str, usize, &InputMatch) -> bool + Send + Sync + 'static,
        action: PasteAction,
    ) -> Self {
        Self::new(
            move |text| {
                regex
                    .captures_iter(text)
                    .filter_map(|captures| {
                        let start = captures.get(0)?.start();
                        let found = InputMatch::from_captures(text, &captures);
                        accept(text, start, &found).then_some((start, found))
                    })
                    .collect()
            },
            action,
        )
    }
}

/// A rule marking each match of `regex` with `ty`.
pub fn mark_paste_rule(regex: Regex, ty: MarkType, get_attrs: Option<GetAttrs>) -> PasteRule {
    PasteRule::regex(regex, |_, _, _| true, PasteAction::Mark(ty, get_attrs))
}

/// A rule replacing each match of `regex` with an inline node of `ty`.
pub fn node_paste_rule(regex: Regex, ty: NodeType, get_attrs: Option<GetAttrs>) -> PasteRule {
    PasteRule::regex(regex, |_, _, _| true, PasteAction::Node(ty, get_attrs))
}

/// A rule replacing each match of `regex` (its first group, when it has
/// one) with `replace`.
pub fn text_paste_rule(regex: Regex, replace: &str) -> PasteRule {
    PasteRule::regex(regex, |_, _, _| true, PasteAction::Text(replace.to_owned()))
}

/// `slice` with `rules` applied, one after the other, to each of its text
/// nodes outside code.
pub fn apply_paste_rules(rules: &[PasteRule], slice: Slice) -> Slice {
    let mut content = slice.content.clone();
    for rule in rules {
        content = map_fragment(&content, rule, false);
    }
    Slice::new(content, slice.open_start, slice.open_end)
}

fn map_fragment(fragment: &Fragment, rule: &PasteRule, in_code: bool) -> Fragment {
    let mut out = Vec::with_capacity(fragment.child_count());
    for node in fragment.iter() {
        if node.is_text() {
            if in_code {
                out.push(node.clone());
            } else {
                out.extend(apply_to_text(node, rule));
            }
        } else if node.content().child_count() > 0 {
            let code = in_code || node.ty().spec().code;
            out.push(node.copy(map_fragment(node.content(), rule, code)));
        } else {
            out.push(node.clone());
        }
    }
    out.into()
}

fn apply_to_text(node: &Node, rule: &PasteRule) -> Vec<Node> {
    let text = node.text().unwrap_or_default();
    let marks = node.marks();
    let schema = node.schema();
    let mut out = Vec::new();
    let mut last = 0;
    let push = |out: &mut Vec<Node>, s: &str, marks: Vec<Mark>| {
        if !s.is_empty() {
            out.push(schema.text(s, marks));
        }
    };
    for (start, found) in (rule.find)(text) {
        if start < last {
            continue;
        }
        let end = start + found.text.len();
        match &rule.action {
            PasteAction::Mark(ty, get_attrs) => {
                let Some(Some((_, capture))) = found.groups.last() else {
                    continue;
                };
                if capture.is_empty() || marks.iter().any(|m| &m.ty != ty && m.ty.excludes(ty)) {
                    continue;
                }
                let Ok(mark) = ty.create(get_attrs.as_ref().and_then(|get| get(&found))) else {
                    continue;
                };
                let spaces = found
                    .text
                    .char_indices()
                    .find(|(_, c)| !c.is_whitespace())
                    .map_or(0, |(i, _)| i);
                push(&mut out, &text[last..start + spaces], marks.to_vec());
                push(&mut out, capture, mark.add_to_set(marks));
            }
            PasteAction::Node(ty, get_attrs) => {
                if !ty.is_inline() {
                    continue;
                }
                let attrs = get_attrs.as_ref().and_then(|get| get(&found));
                let Ok(inline) = ty.create(attrs, Fragment::empty(), vec![]) else {
                    continue;
                };
                push(&mut out, &text[last..start], marks.to_vec());
                out.push(inline);
            }
            PasteAction::Text(replace) => {
                let (keep, tail) = match found.group(1).filter(|g| !g.is_empty()) {
                    Some(group) => {
                        let Some(offset) = found.text.rfind(group) else {
                            continue;
                        };
                        (&found.text[..offset], &found.text[offset + group.len()..])
                    }
                    None => ("", ""),
                };
                push(&mut out, &text[last..start], marks.to_vec());
                push(&mut out, &format!("{keep}{replace}{tail}"), marks.to_vec());
            }
        }
        last = end;
    }
    if last == 0 {
        return vec![node.clone()];
    }
    push(&mut out, &text[last..], marks.to_vec());
    out
}

struct PasteRules {
    key: PluginKey,
    rules: Vec<PasteRule>,
}

impl PluginSpec for PasteRules {
    fn key(&self) -> PluginKey {
        self.key.clone()
    }

    fn transform_pasted(&self, state: &EditorState, slice: Slice) -> Slice {
        // Text pasted into code stays as it was (Tiptap skips code too).
        if state.selection().resolved_from().parent().ty().spec().code {
            return slice;
        }
        apply_paste_rules(&self.rules, slice)
    }
}

// Gives each paste rules plugin a key of its own.
static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A plugin applying `rules` to pasted and dropped content.
pub fn paste_rules(rules: Vec<PasteRule>) -> Plugin {
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Arc::new(PasteRules {
        key: PluginKey::new(&format!("pasteRules${id}")),
        rules,
    })
}

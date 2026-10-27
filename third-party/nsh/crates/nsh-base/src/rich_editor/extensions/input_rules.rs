//! Input rules, a port of `prosemirror-inputrules`: patterns matched
//! against the text before the cursor as the user types, which change the
//! document when they match (`"# "` makes a heading, `"--"` an em dash).
//!
//! A rule's regular expression must end with `$`: it is matched against
//! up to 500 characters of the textblock before the cursor, with the typed
//! text after them. Offsets the handlers get are positions in the
//! document (UTF-16 units). The change a rule makes can be undone with
//! [`undo_input_rule`] (bound to Backspace by the starter keymap), which
//! leaves the typed text as it was typed.

use std::sync::Arc;

use regex::Regex;
use serde_json::{Value, json};

use crate::rich_editor::{
    commands::Dispatch,
    model::{Attrs, Mark, MarkType, Node, NodeType, utf16_len},
    state::{
        EditorState, EditorStateConfig, KeyEvent, Plugin, PluginKey, PluginSpec, PluginState,
        Transaction,
    },
    transform::{BoxStep, can_join, find_wrapping},
};

// How much text before the cursor rules look at, in characters.
const MAX_MATCH: usize = 500;

const INPUT_RULE_META: &str = "inputRule$";

/// What a rule's expression matched, with its offsets in UTF-16 units from
/// the start of the match.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct InputMatch {
    /// The whole match: the text before the cursor it covers and the typed
    /// text.
    pub text: String,
    /// The capture groups (1 on), each with its offset in the match;
    /// `None` for a group that did not take part.
    pub groups: Vec<Option<(usize, String)>>,
}

impl InputMatch {
    /// Capture group `i` (0 is the whole match).
    pub fn group(&self, i: usize) -> Option<&str> {
        if i == 0 {
            return Some(&self.text);
        }
        self.groups
            .get(i - 1)?
            .as_ref()
            .map(|(_, text)| text.as_str())
    }

    /// The UTF-16 offset of capture group `i` in the match.
    pub fn group_offset(&self, i: usize) -> Option<usize> {
        if i == 0 {
            return Some(0);
        }
        self.groups.get(i - 1)?.as_ref().map(|(offset, _)| *offset)
    }

    /// The length of the match in UTF-16 units.
    pub fn len_utf16(&self) -> usize {
        utf16_len(&self.text)
    }

    /// The match of `captures` (of an expression run on `text`), its group
    /// offsets in UTF-16 units from its start.
    pub fn from_captures(text: &str, captures: &regex::Captures<'_>) -> Self {
        let whole = captures.get(0).expect("the whole match");
        Self {
            text: whole.as_str().to_owned(),
            groups: (1..captures.len())
                .map(|i| {
                    captures.get(i).map(|group| {
                        (
                            utf16_len(&text[whole.start()..group.start()]),
                            group.as_str().to_owned(),
                        )
                    })
                })
                .collect(),
        }
    }
}

/// What a rule does when it matches: given the state, the match and the
/// document range it covers (`start..end`, where `end` is the end of the
/// typed range, which the typed text replaces), the transaction to
/// dispatch, or `None` to let typing go on.
pub type InputRuleHandler =
    Arc<dyn Fn(&EditorState, &InputMatch, usize, usize) -> Option<Transaction> + Send + Sync>;

/// Where a rule applies in code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[non_exhaustive]
pub enum InCode {
    /// Outside code blocks only (the default).
    #[default]
    No,
    /// Everywhere.
    Yes,
    /// In code blocks only.
    Only,
}

/// Finds a rule's match in the text before the cursor (with the typed text
/// at its end), instead of its expression: a match that ends at the end of
/// the text, or `None` (Tiptap's function `find`, for what expressions
/// without look-around cannot say).
pub type InputFinder = Arc<dyn Fn(&str) -> Option<InputMatch> + Send + Sync>;

/// A rule: an expression and what to do when it matches.
#[derive(Clone)]
pub struct InputRule {
    /// The expression, ending with `$`.
    pub regex: Regex,
    /// Finds the match instead of [`InputRule::regex`] when set.
    pub finder: Option<InputFinder>,
    /// What it does.
    pub handler: InputRuleHandler,
    /// Whether [`undo_input_rule`] can undo it (default true).
    pub undoable: bool,
    /// Whether it applies in code blocks (nodes whose spec has `code`).
    pub in_code: InCode,
    /// Whether it applies in text with a code mark (default false).
    pub in_code_mark: bool,
}

impl std::fmt::Debug for InputRule {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("InputRule")
            .field("regex", &self.regex.as_str())
            .finish_non_exhaustive()
    }
}

impl InputRule {
    /// A rule running `handler`.
    pub fn new(
        regex: Regex,
        handler: impl Fn(&EditorState, &InputMatch, usize, usize) -> Option<Transaction>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            regex,
            finder: None,
            handler: Arc::new(handler),
            undoable: true,
            in_code: InCode::No,
            in_code_mark: false,
        }
    }

    /// A rule that replaces the match with `replacement`. When the
    /// expression has a group, only the group is replaced and the text
    /// around it stays (`/(?:^|\s)(")$/` replaces only the quote).
    pub fn text(regex: Regex, replacement: &str) -> Self {
        let replacement = replacement.to_owned();
        Self::new(regex, move |state, found, start, end| {
            let mut insert = replacement.clone();
            let mut start = start;
            if let (Some(group), Some(offset)) = (found.group(1), found.group_offset(1)) {
                let group_end = offset + utf16_len(group);
                insert.push_str(utf16_tail(&found.text, group_end));
                start += offset;
                if start > end {
                    // The group reaches into the typed text: keep what of
                    // the match comes before the group and is typed.
                    let cut = start - end;
                    insert = format!("{}{insert}", utf16_range(&found.text, offset - cut, offset));
                    start = end;
                }
            }
            let mut tr = state.tr();
            tr.insert_text(&insert, Some(start), Some(end));
            Some(tr)
        })
    }

    /// Sets [`InputRule::finder`]: the rule matches what `finder` finds.
    pub fn with_finder(
        mut self,
        finder: impl Fn(&str) -> Option<InputMatch> + Send + Sync + 'static,
    ) -> Self {
        self.finder = Some(Arc::new(finder));
        self
    }

    /// Wraps the handler so that the rule applies only to matches `accept`
    /// takes (what a look-ahead of Tiptap's expression checks).
    pub fn accepting(
        mut self,
        accept: impl Fn(&InputMatch) -> bool + Send + Sync + 'static,
    ) -> Self {
        let handler = self.handler.clone();
        self.handler = Arc::new(move |state, found, start, end| {
            if accept(found) {
                handler(state, found, start, end)
            } else {
                None
            }
        });
        self
    }

    /// The match of the rule in `text`, which must end at its end.
    pub fn find(&self, text: &str) -> Option<InputMatch> {
        if let Some(finder) = &self.finder {
            return finder(text).filter(|found| text.ends_with(&found.text));
        }
        let captures = self.regex.captures(text)?;
        Some(InputMatch::from_captures(text, &captures))
    }

    /// Sets [`InputRule::undoable`].
    pub fn undoable(mut self, undoable: bool) -> Self {
        self.undoable = undoable;
        self
    }

    /// Sets [`InputRule::in_code`].
    pub fn in_code(mut self, in_code: InCode) -> Self {
        self.in_code = in_code;
        self
    }

    /// Sets [`InputRule::in_code_mark`].
    pub fn in_code_mark(mut self, in_code_mark: bool) -> Self {
        self.in_code_mark = in_code_mark;
        self
    }
}

fn utf16_range(text: &str, from: usize, to: usize) -> &str {
    let start = crate::rich_editor::model::utf16_to_byte(text, from);
    let end = crate::rich_editor::model::utf16_to_byte(text, to);
    &text[start..end]
}

fn utf16_tail(text: &str, from: usize) -> &str {
    &text[crate::rich_editor::model::utf16_to_byte(text, from)..]
}

// What `undo_input_rule` needs: the steps to invert and the typed text.
#[derive(Debug)]
struct Undoable {
    steps: Vec<(BoxStep, Node)>,
    from: usize,
    to: usize,
    text: String,
}

struct InputRules {
    key: PluginKey,
    rules: Vec<InputRule>,
}

impl PluginSpec for InputRules {
    fn key(&self) -> PluginKey {
        self.key.clone()
    }

    fn init_state(&self, _: &EditorStateConfig, _: &EditorState) -> Option<PluginState> {
        Some(Arc::new(InputRulesState::default()))
    }

    fn apply_state(
        &self,
        tr: &Transaction,
        value: &PluginState,
        _: &EditorState,
        _: &EditorState,
    ) -> PluginState {
        record_rule(self.key.name(), tr, value)
    }

    fn handle_text_input(
        &self,
        state: &EditorState,
        from: usize,
        to: usize,
        text: &str,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        run(self, state, from, to, text, dispatch)
    }

    // Enter runs the rules too, with a line break as the typed text (as
    // Tiptap's input rules do, for code block fences): a rule fired so
    // keeps nothing typed when undone.
    fn handle_key_down(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        if event.key != "Enter" {
            return false;
        }
        let Some(cursor) = state.selection().cursor() else {
            return false;
        };
        let pos = cursor.pos;
        let mut fired = None;
        if !run(self, state, pos, pos, "\n", &mut |tr| fired = Some(tr)) {
            return false;
        }
        let Some(mut tr) = fired else {
            return false;
        };
        if tr.get_meta(INPUT_RULE_META).is_some() {
            mark_rule(&mut tr, self.key.name(), pos, pos, "");
        }
        dispatch(tr);
        true
    }
}

/// Marks `tr` as a rule's change that [`undo_input_rule`] can take back,
/// for the plugin `key`: the text typed at `from..to` that fired it.
pub(crate) fn mark_rule(tr: &mut Transaction, key: &str, from: usize, to: usize, text: &str) {
    tr.set_meta(
        INPUT_RULE_META,
        json!({ "key": key, "from": from, "to": to, "text": text }),
    );
}

/// The state of the plugin `key` after `tr`: the rule's change it marks
/// ([`mark_rule`]), kept until the selection or the document changes.
pub(crate) fn record_rule(key: &str, tr: &Transaction, value: &PluginState) -> PluginState {
    if let Some(meta) = tr
        .get_meta(INPUT_RULE_META)
        .filter(|meta| meta["key"] == key)
    {
        let pos = |name: &str| meta[name].as_u64().unwrap_or(0) as usize;
        let steps = tr
            .steps
            .iter()
            .zip(tr.docs.iter())
            .map(|(step, doc)| (step.clone(), doc.clone()))
            .collect();
        return Arc::new(InputRulesState {
            undoable: Some(Arc::new(Undoable {
                steps,
                from: pos("from"),
                to: pos("to"),
                text: meta["text"].as_str().unwrap_or_default().to_owned(),
            })),
        });
    }
    // A plugin's transaction appended after the rule's (the trailing node)
    // keeps it undoable while it changes nothing up to the rule's end.
    if tr.is_appended()
        && !tr.selection_set()
        && let Some(state) = value.downcast_ref::<InputRulesState>()
        && let Some(undoable) = &state.undoable
        && tr.mapping.maps.iter().all(|map| {
            let mut untouched = true;
            map.for_each(|start, _, _, _| untouched &= start >= undoable.to);
            untouched
        })
    {
        return value.clone();
    }
    if tr.selection_set() || tr.doc_changed() {
        Arc::new(InputRulesState::default())
    } else {
        value.clone()
    }
}

/// The state of an input rules plugin: the last rule's change while it
/// can still be undone.
#[derive(Debug, Default)]
pub struct InputRulesState {
    undoable: Option<Arc<Undoable>>,
}

fn run(
    plugin: &InputRules,
    state: &EditorState,
    from: usize,
    to: usize,
    text: &str,
    dispatch: &mut dyn FnMut(Transaction),
) -> bool {
    let Ok(start) = state.doc().resolve(from) else {
        return false;
    };
    let parent = start.parent();
    let before = parent
        .content()
        .text_between(0, start.parent_offset, None, Some("\u{fffc}"));
    let skip = before.chars().count().saturating_sub(MAX_MATCH);
    let before: String = before.chars().skip(skip).collect();
    let text_before = format!("{before}{text}");
    let text_len = utf16_len(text);
    let in_code_mark = start.marks().iter().any(|mark| is_code_mark(&mark.ty));
    let in_code_block = parent.ty().spec().code;
    for rule in &plugin.rules {
        if !rule.in_code_mark && in_code_mark {
            continue;
        }
        match (in_code_block, rule.in_code) {
            (true, InCode::No) | (false, InCode::Only) => continue,
            _ => {}
        }
        let Some(found) = rule.find(&text_before) else {
            continue;
        };
        let len = found.len_utf16();
        if len < text_len {
            continue;
        }
        let Some(mut tr) = (rule.handler)(state, &found, from - (len - text_len), to) else {
            continue;
        };
        if rule.undoable {
            mark_rule(&mut tr, plugin.key.name(), from, to, text);
        }
        dispatch(tr);
        return true;
    }
    false
}

// Gives each input rules plugin a key of its own.
static NEXT_INPUT_RULES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A plugin applying `rules` as text is typed.
pub fn input_rules(rules: Vec<InputRule>) -> Plugin {
    let id = NEXT_INPUT_RULES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Arc::new(InputRules {
        key: PluginKey::new(&format!("inputRules${id}")),
        rules,
    })
}

/// Undoes the change the last input rule made, right after it (before
/// anything else changed the document or the selection), leaving the
/// typed text.
pub fn undo_input_rule(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    for plugin in state.plugins() {
        let Some(value) = state.plugin_state(&plugin.key()) else {
            continue;
        };
        let Some(rules_state) = value.downcast_ref::<InputRulesState>() else {
            continue;
        };
        let Some(undoable) = &rules_state.undoable else {
            continue;
        };
        if let Some(dispatch) = dispatch {
            let mut tr = state.tr();
            for (step, doc) in undoable.steps.iter().rev() {
                let _ = tr.step(step.invert(doc));
            }
            if undoable.text.is_empty() {
                let _ = tr.delete(undoable.from, undoable.to);
            } else {
                let marks = tr
                    .doc()
                    .resolve(undoable.from)
                    .map(|pos| pos.marks())
                    .unwrap_or_default();
                let node = state.schema().text(&undoable.text, marks);
                let _ = tr.replace_with(undoable.from, undoable.to, node.into());
            }
            dispatch(tr);
        }
        return true;
    }
    false
}

/// What a builder's rule gives its node: attributes from the match.
pub type GetAttrs = Arc<dyn Fn(&InputMatch) -> Option<Attrs> + Send + Sync>;

/// Whether a wrapping rule joins the new node with the node of its type
/// before it.
pub type JoinPredicate = Arc<dyn Fn(&InputMatch, &Node) -> bool + Send + Sync>;

/// A rule that wraps the textblock in a node of `ty` when the text typed
/// at its start matches (`"> "` for a blockquote, `"- "` for a list),
/// deleting the matched text. The new node joins one of its type right
/// before it when `join` says so (always when `join` is `None`).
pub fn wrapping_input_rule(
    regex: Regex,
    ty: NodeType,
    get_attrs: Option<GetAttrs>,
    join: Option<JoinPredicate>,
) -> InputRule {
    InputRule::new(regex, move |state, found, start, end| {
        let attrs = get_attrs.as_ref().and_then(|get| get(found));
        let mut tr = state.tr();
        let _ = tr.delete(start, end);
        let at = tr.doc().resolve(start).ok()?;
        let range = at.block_range(&at, None)?;
        let wrapping = find_wrapping(&range, &ty, attrs, None)?;
        tr.wrap(&range, &wrapping).ok()?;
        let before = tr.doc().resolve(start - 1).ok()?.node_before();
        if let Some(before) = before
            && before.ty() == &ty
            && can_join(tr.doc(), start - 1)
            && join.as_ref().is_none_or(|join| join(found, &before))
        {
            let _ = tr.join(start - 1, 1);
        }
        Some(tr)
    })
}

/// A rule that turns the textblock into a node of `ty` when the text typed
/// at its start matches (`"# "` for a heading), deleting the matched text.
pub fn textblock_type_input_rule(
    regex: Regex,
    ty: NodeType,
    get_attrs: Option<GetAttrs>,
) -> InputRule {
    InputRule::new(regex, move |state, found, start, end| {
        let at = state.doc().resolve(start).ok()?;
        let attrs = get_attrs.as_ref().and_then(|get| get(found));
        let d = at.depth.checked_sub(1)?;
        if !at
            .node(d)
            .can_replace_with(at.index(d), at.index_after(d), &ty, None)
        {
            return None;
        }
        let mut tr = state.tr();
        let _ = tr.delete(start, end);
        tr.set_block_type(start, start, &ty, attrs).ok()?;
        Some(tr)
    })
}

/// A rule that gives text a mark when it is typed between delimiters
/// (`"**bold**"`), as Tiptap's `markInputRule`: the last capture group is
/// the text to mark; everything else the match covers is deleted except
/// the white space it starts with (`(?:^|\s)` keeps the space before the
/// delimiters). Text with a mark that excludes this one is left as is. The
/// mark does not continue past the typed text.
pub fn mark_input_rule(regex: Regex, ty: MarkType, get_attrs: Option<GetAttrs>) -> InputRule {
    InputRule::new(regex, move |state, found, start, end| {
        let attrs = get_attrs.as_ref().and_then(|get| get(found));
        let mark = ty.create(attrs).ok()?;
        let mut tr = state.tr();
        mark_match(&mut tr, state.doc(), found, start, end, &mark)?;
        tr.remove_stored_mark_type(&ty);
        Some(tr)
    })
}

/// Marks the last capture group of `found`, which covers `start..end`, with
/// `mark` and deletes the rest of the match but its leading white space
/// (Tiptap's `markInputRule` and `markPasteRule`): the end of the mark, or
/// `None` when the match has no text to mark or text there has a mark
/// excluding `mark`.
pub(crate) fn mark_match(
    tr: &mut Transaction,
    doc: &Node,
    found: &InputMatch,
    start: usize,
    end: usize,
    mark: &Mark,
) -> Option<usize> {
    let (_, capture) = found.groups.last()?.as_ref()?;
    if capture.is_empty() {
        return None;
    }
    let full = &found.text;
    let start_spaces = full
        .char_indices()
        .find(|(_, c)| !c.is_whitespace())
        .map_or(0, |(i, _)| utf16_len(&full[..i]));
    let text_start = start + utf16_len(&full[..full.find(capture.as_str())?]);
    let text_end = text_start + utf16_len(capture);
    let mut excluded = false;
    doc.nodes_between(start, end, &mut |node, pos, _, _| {
        if node.is_text() && pos + node.node_size() > text_start {
            excluded |= node
                .marks()
                .iter()
                .any(|m| m.ty != mark.ty && m.ty.excludes(&mark.ty));
        }
        true
    });
    if excluded {
        return None;
    }
    if text_end < end {
        tr.delete(text_end, end).ok()?;
    }
    if text_start > start {
        tr.delete(start + start_spaces, text_start).ok()?;
    }
    let mark_end = start + start_spaces + utf16_len(capture);
    tr.add_mark(start + start_spaces, mark_end, mark.clone())
        .ok()?;
    Some(mark_end)
}

/// A rule that inserts a node of `ty` when the typed text matches, as
/// Tiptap's `nodeInputRule`. With a first capture group, the group is
/// replaced by the node (an inline node: `![alt](src)` for an image) and
/// the typed character is kept before it is replaced; without one, a block
/// node goes in before the textblock and the match is deleted (`---` for a
/// horizontal rule, leaving the textblock after it).
pub fn node_input_rule(regex: Regex, ty: NodeType, get_attrs: Option<GetAttrs>) -> InputRule {
    InputRule::new(regex, move |state, found, start, end| {
        let attrs = get_attrs.as_ref().and_then(|get| get(found));
        let node = ty.create(attrs, Default::default(), vec![]).ok()?;
        let mut tr = state.tr();
        match found.group(1).filter(|group| !group.is_empty()) {
            Some(group) => {
                let full = &found.text;
                let offset = utf16_len(&full[..full.rfind(group)?]);
                let mut match_start = start + offset;
                let mut end = end;
                if match_start > end {
                    match_start = end;
                } else {
                    end = match_start + utf16_len(group);
                }
                let last = full.chars().last()?;
                let last_len = last.len_utf16();
                tr.insert_text(
                    &last.to_string(),
                    Some(start + found.len_utf16() - last_len),
                    None,
                );
                tr.replace_with(match_start, end, node.into()).ok()?;
            }
            None if !found.text.is_empty() => {
                let at = if ty.is_inline() {
                    start
                } else {
                    start.checked_sub(1)?
                };
                tr.insert(at, node.into()).ok()?;
                let (from, to) = (tr.mapping.map(start, 1), tr.mapping.map(end, 1));
                tr.delete(from, to).ok()?;
            }
            None => return None,
        }
        tr.scroll_into_view();
        Some(tr)
    })
}

/// Whether marks of `ty` hold code (ProseMirror's mark spec `code`), which
/// input rules leave alone.
pub(crate) fn is_code_mark(ty: &MarkType) -> bool {
    ty.spec().code || ty.spec().extra.get("code") == Some(&Value::Bool(true))
}

/// Converts two dashes into an em dash.
pub fn em_dash() -> InputRule {
    InputRule::text(Regex::new("--$").expect("a valid expression"), "\u{2014}")
}

/// Converts three dots into an ellipsis.
pub fn ellipsis() -> InputRule {
    InputRule::text(
        Regex::new(r"\.\.\.$").expect("a valid expression"),
        "\u{2026}",
    )
}

/// Typographic double quotes: opening after white space or an opening
/// bracket, closing elsewhere.
pub fn open_double_quote() -> InputRule {
    InputRule::text(
        Regex::new(r#"(?:^|[\s{\[(<'"\u{2018}\u{201C}])(")$"#).expect("a valid expression"),
        "\u{201C}",
    )
}

/// The closing double quote.
pub fn close_double_quote() -> InputRule {
    InputRule::text(Regex::new(r#""$"#).expect("a valid expression"), "\u{201D}")
}

/// The opening single quote.
pub fn open_single_quote() -> InputRule {
    InputRule::text(
        Regex::new(r#"(?:^|[\s{\[(<'"\u{2018}\u{201C}])(')$"#).expect("a valid expression"),
        "\u{2018}",
    )
}

/// The closing single quote (and apostrophe).
pub fn close_single_quote() -> InputRule {
    InputRule::text(Regex::new("'$").expect("a valid expression"), "\u{2019}")
}

/// The smart quote rules, in the order they must run.
pub fn smart_quotes() -> Vec<InputRule> {
    vec![
        open_double_quote(),
        close_double_quote(),
        open_single_quote(),
        close_single_quote(),
    ]
}

// Reads a JSON number for attribute getters.
pub(crate) fn number(value: &str) -> Value {
    value.parse::<u64>().map_or(Value::Null, Value::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::{extensions::starter, state::TextSelection};

    // Types `text` at the cursor the way the view does: the plugins first,
    // else an insertion.
    fn type_text(state: &EditorState, text: &str) -> EditorState {
        let (from, to) = (state.selection().from(), state.selection().to());
        let mut out = None;
        let handled = state.plugins().iter().any(|plugin| {
            plugin.handle_text_input(state, from, to, text, &mut |tr| out = Some(tr))
        });
        let tr = if handled {
            out.unwrap()
        } else {
            let mut tr = state.tr();
            tr.insert_text(text, Some(from), Some(to));
            tr
        };
        state.apply(tr).unwrap()
    }

    fn type_all(state: &EditorState, text: &str) -> EditorState {
        text.chars().fold(state.clone(), |state, ch| {
            type_text(&state, &ch.to_string())
        })
    }

    fn new_state() -> EditorState {
        let schema = starter::schema();
        let plugins = vec![starter::input_rules(&schema)];
        let state = EditorState::create(EditorStateConfig::new(schema).plugins(plugins)).unwrap();
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), 1, None));
        state.apply(tr).unwrap()
    }

    #[test]
    fn hash_space_makes_a_heading() {
        let state = type_all(&new_state(), "## ");
        let block = state.doc().child(0);
        assert_eq!(block.ty().name(), "heading");
        assert_eq!(block.attrs()["level"], Value::from(2));
        assert_eq!(block.text_content(), "");
    }

    #[test]
    fn dash_space_makes_a_bullet_list() {
        let state = type_all(&new_state(), "- a");
        let list = state.doc().child(0);
        assert_eq!(list.ty().name(), "bulletList");
        assert_eq!(list.child(0).ty().name(), "listItem");
        assert_eq!(list.text_content(), "a");
    }

    #[test]
    fn delimiters_mark_text() {
        let state = type_all(&new_state(), "a **bold**");
        let paragraph = state.doc().child(0);
        assert_eq!(paragraph.text_content(), "a bold");
        let bold = state.schema().mark_type("bold").unwrap();
        let last = paragraph.last_child().unwrap();
        assert_eq!(last.text(), Some("bold"));
        assert!(bold.is_in_set(last.marks()).is_some());
        let after = type_text(&state, "x");
        let last = after.doc().child(0).last_child().unwrap().clone();
        assert_eq!(last.text(), Some("x"), "the mark does not continue");
    }

    #[test]
    fn undo_input_rule_restores_the_typed_text() {
        let state = type_all(&new_state(), "# ");
        assert_eq!(state.doc().child(0).ty().name(), "heading");
        let mut out = None;
        assert!(undo_input_rule(&state, Some(&mut |tr| out = Some(tr))));
        let undone = state.apply(out.unwrap()).unwrap();
        assert_eq!(undone.doc().child(0).ty().name(), "paragraph");
        assert_eq!(undone.doc().child(0).text_content(), "# ");
        assert!(!undo_input_rule(&undone, None));
    }

    #[test]
    fn text_rules_replace() {
        let state = type_all(&new_state(), "a--b...");
        assert_eq!(state.doc().text_content(), "a\u{2014}b\u{2026}");
        let state = type_all(&new_state(), "\"q\"");
        assert_eq!(state.doc().text_content(), "\u{201C}q\u{201D}");
    }
}

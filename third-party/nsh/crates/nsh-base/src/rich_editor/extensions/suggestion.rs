//! Tiptap's `Suggestion` utility, natively: a plugin that follows a
//! trigger character (`@`, `/`, `#`) typed before the cursor and keeps the
//! active range, query and text in its state, decorates that range with
//! the app's class, and lets a key handler (the app's list: arrows, Enter)
//! take keys while it is active; Escape dismisses it. The popup is the
//! app's: it reads the state ([`suggestion_state`]), places itself with the
//! session's `coords_at_pos` and runs [`replace_suggestion`] or
//! [`insert_mention`] with what the user picked. Ported from
//! `@tiptap/suggestion` (`findSuggestionMatch`, the plugin's state and
//! props) and `@tiptap/extension-mention` ([`mention_node`],
//! [`insert_mention`]).

use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use regex::Regex;
use serde_json::{Value, json};

use crate::rich_editor::{
    commands::{BoxCommand, CommandRegistry, command, registry::content_fragment},
    model::{
        AttrSpec, Attrs, DomOutputSpec, Fragment, Node, NodeSpec, ParseRule, ResolvedPos,
        TextRender, utf16_len,
    },
    state::{
        Decoration, DecorationSet, EditorState, EditorStateConfig, KeyEvent, Plugin, PluginKey,
        PluginSpec, PluginState, TextSelection, Transaction, TransactionOrigin,
    },
};

/// The default key of a suggestion plugin (Tiptap's `suggestion`).
pub const SUGGESTION_KEY: &str = "suggestion";

/// A range of the document.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct SuggestionRange {
    /// Its start.
    pub from: usize,
    /// Its end.
    pub to: usize,
}

impl SuggestionRange {
    /// `from..to`.
    pub fn new(from: usize, to: usize) -> Self {
        Self { from, to }
    }
}

/// What [`find_suggestion_match`] found before a position.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct SuggestionMatch {
    /// The trigger and the query.
    pub range: SuggestionRange,
    /// The text after the trigger.
    pub query: String,
    /// The trigger and the query.
    pub text: String,
}

/// How a trigger is found (Tiptap's `Trigger`, without the position).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SuggestionTrigger {
    /// The trigger (`@`).
    pub char: String,
    /// The query may hold spaces (it ends at a space before another
    /// trigger, or at the line's end).
    pub allow_spaces: bool,
    /// The query may hold the trigger (then it holds no spaces).
    pub allow_to_include_char: bool,
    /// What may come right before the trigger; `None` for anything. A
    /// trigger at the text's start always matches.
    pub allowed_prefixes: Option<Vec<String>>,
    /// The trigger must start the text.
    pub start_of_line: bool,
}

impl Default for SuggestionTrigger {
    fn default() -> Self {
        Self {
            char: "@".into(),
            allow_spaces: false,
            allow_to_include_char: false,
            allowed_prefixes: Some(vec![" ".into()]),
            start_of_line: false,
        }
    }
}

fn is_space(c: char) -> bool {
    c.is_whitespace()
}

// The byte ranges of the trigger's matches in `text`, in order (the
// expressions of Tiptap's `findSuggestionMatch`, scanned by hand where
// they need a look-ahead).
fn matches_in(trigger: &SuggestionTrigger, text: &str) -> Vec<(usize, usize)> {
    let char = trigger.char.as_str();
    if char.is_empty() {
        return Vec::new();
    }
    let allow_spaces = trigger.allow_spaces && !trigger.allow_to_include_char;
    let line_start = |at: usize| at == 0 || text[..at].ends_with('\n');
    if !allow_spaces {
        let excluded: String = if trigger.allow_to_include_char {
            String::new()
        } else {
            char.chars()
                .map(|c| regex::escape(&c.to_string()))
                .collect()
        };
        let prefix = if trigger.start_of_line { "^" } else { "" };
        let Ok(re) = Regex::new(&format!(
            r"(?m){prefix}{}[^\s{excluded}]*",
            regex::escape(char)
        )) else {
            return Vec::new();
        };
        return re.find_iter(text).map(|m| (m.start(), m.end())).collect();
    }
    // `char.*?(?=\schar|$)`, multi-line: up to a space before another
    // trigger, or the line's end.
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(found) = text[from..].find(char) {
        let start = from + found;
        if trigger.start_of_line && !line_start(start) {
            from = start + char.len();
            continue;
        }
        let mut end = text.len();
        let mut i = start + char.len();
        while i < text.len() {
            let c = text[i..].chars().next().expect("a char");
            if c == '\n' {
                end = i;
                break;
            }
            if is_space(c) && text[i + c.len_utf8()..].starts_with(char) {
                end = i;
                break;
            }
            i += c.len_utf8();
        }
        out.push((start, end));
        from = end.max(start + char.len());
    }
    out
}

/// The suggestion before `pos` (Tiptap's `findSuggestionMatch`): the last
/// match of the trigger in the text right before `pos`, when it holds
/// `pos` and what precedes it is an allowed prefix.
pub fn find_suggestion_match(
    trigger: &SuggestionTrigger,
    pos: &ResolvedPos,
) -> Option<SuggestionMatch> {
    let before = pos.node_before()?;
    let text = before.text()?;
    if text.is_empty() {
        return None;
    }
    let text_from = pos.pos - utf16_len(text);
    let (start, end) = matches_in(trigger, text).pop()?;
    if let Some(prefixes) = &trigger.allowed_prefixes
        && let Some(prev) = text[..start].chars().next_back()
        && prev != '\0'
        && !prefixes.iter().any(|p| p.contains(prev))
    {
        return None;
    }
    let from = text_from + utf16_len(&text[..start]);
    let found = &text[start..end];
    let to = from + utf16_len(found);
    (from < pos.pos && to >= pos.pos).then(|| SuggestionMatch {
        range: SuggestionRange::new(from, to),
        query: found[trigger.char.len()..].to_owned(),
        text: found.to_owned(),
    })
}

/// A key press while a suggestion is active, for its key handler.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct SuggestionKeyDown {
    /// The key.
    pub event: KeyEvent,
    /// The active range.
    pub range: SuggestionRange,
    /// The active query.
    pub query: String,
}

/// Handles a key while a suggestion is active; `true` when it did (Tiptap's
/// `render().onKeyDown`).
pub type SuggestionKeyHandler = Arc<dyn Fn(&SuggestionKeyDown) -> bool + Send + Sync>;

/// Whether a match may become active (Tiptap's `allow`): the state, the
/// range, and whether a suggestion was active before.
pub type SuggestionAllow = Arc<dyn Fn(&EditorState, SuggestionRange, bool) -> bool + Send + Sync>;

/// The options of [`suggestion`], Tiptap's names and defaults.
#[derive(Clone)]
#[non_exhaustive]
pub struct SuggestionOptions {
    /// The plugin's key ([`SUGGESTION_KEY`]); each suggestion of an editor
    /// has its own (`mention`, `slash`).
    pub key: String,
    /// How the trigger is found.
    pub trigger: SuggestionTrigger,
    /// The class of the active range's inline decoration (Tiptap's
    /// `decorationClass`); no decoration when `None`.
    pub decoration_class: Option<String>,
    /// The class added while the query is empty (Tiptap's
    /// `decorationEmptyClass`).
    pub decoration_empty_class: Option<String>,
    /// Whether a match may become active.
    pub allow: Option<SuggestionAllow>,
    /// Handles keys while active (after Escape, which always dismisses).
    pub on_key_down: Option<SuggestionKeyHandler>,
    /// Keys taken while active and recorded in the state (`last_key`,
    /// `key_count`) for an app that reads them afterwards: `"ArrowUp"`,
    /// `"ArrowDown"`, `"Enter"`, `"Tab"` (the web's key names, matched
    /// without Mod, Ctrl or Alt).
    pub capture_keys: Vec<String>,
}

impl Default for SuggestionOptions {
    fn default() -> Self {
        Self {
            key: SUGGESTION_KEY.into(),
            trigger: SuggestionTrigger::default(),
            decoration_class: None,
            decoration_empty_class: None,
            allow: None,
            on_key_down: None,
            capture_keys: Vec::new(),
        }
    }
}

impl std::fmt::Debug for SuggestionOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SuggestionOptions")
            .field("key", &self.key)
            .field("trigger", &self.trigger)
            .field("decoration_class", &self.decoration_class)
            .field("decoration_empty_class", &self.decoration_empty_class)
            .field("capture_keys", &self.capture_keys)
            .finish_non_exhaustive()
    }
}

/// A suggestion plugin's state (Tiptap's `SuggestionPluginState`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct SuggestionState {
    /// Whether a suggestion is active.
    pub active: bool,
    /// The trigger and the query (`0..0` when inactive).
    pub range: SuggestionRange,
    /// The text after the trigger.
    pub query: Option<String>,
    /// The trigger and the query.
    pub text: Option<String>,
    /// The range Escape dismissed: the suggestion stays inactive there until
    /// a space is typed or the trigger moves.
    pub dismissed_range: Option<SuggestionRange>,
    /// An id of the active suggestion, kept while it stays active.
    pub decoration_id: Option<String>,
    /// The last of `capture_keys` taken while active.
    pub last_key: Option<String>,
    /// How many keys of `capture_keys` were taken.
    pub key_count: u64,
}

impl SuggestionState {
    /// The JSON form apps read: `{ active, range: { from, to }, query,
    /// text, decorationId, lastKey, keyCount }`.
    pub fn to_json(&self) -> Value {
        json!({
            "active": self.active,
            "range": { "from": self.range.from, "to": self.range.to },
            "query": self.query,
            "text": self.text,
            "decorationId": self.decoration_id,
            "lastKey": self.last_key,
            "keyCount": self.key_count,
        })
    }
}

static NEXT_DECORATION: AtomicU64 = AtomicU64::new(1);

struct Suggestion {
    key: PluginKey,
    options: SuggestionOptions,
}

// Whether `tr` typed white space.
fn inserted_whitespace(tr: &Transaction) -> bool {
    if !tr.doc_changed() {
        return false;
    }
    let mut found = false;
    for map in &tr.mapping.maps {
        map.for_each(|_, _, new_from, new_to| {
            if new_to > new_from {
                found = true;
            }
        });
    }
    if !found {
        return false;
    }
    tr.changed_range().is_some_and(|(from, to)| {
        tr.doc()
            .text_between(from, to, Some("\n"), None)
            .chars()
            .any(char::is_whitespace)
    })
}

impl Suggestion {
    fn state<'a>(&self, value: &'a PluginState) -> Option<&'a SuggestionState> {
        value.downcast_ref::<SuggestionState>()
    }

    fn keep_dismissed(
        &self,
        found: &SuggestionMatch,
        dismissed: SuggestionRange,
        tr: &Transaction,
    ) -> bool {
        let allow_spaces =
            self.options.trigger.allow_spaces && !self.options.trigger.allow_to_include_char;
        if allow_spaces {
            return found.range.from == dismissed.from;
        }
        found.range.from == dismissed.from && !inserted_whitespace(tr)
    }
}

impl PluginSpec for Suggestion {
    fn key(&self) -> PluginKey {
        self.key.clone()
    }

    fn init_state(&self, _: &EditorStateConfig, _: &EditorState) -> Option<PluginState> {
        Some(Arc::new(SuggestionState::default()))
    }

    fn apply_state(
        &self,
        tr: &Transaction,
        value: &PluginState,
        _: &EditorState,
        new: &EditorState,
    ) -> PluginState {
        let prev = self.state(value).cloned().unwrap_or_default();
        let mut next = prev.clone();
        let meta = tr.get_plugin_meta(&self.key);
        if meta.and_then(|m| m.get("exit")).and_then(Value::as_bool) == Some(true) {
            next.active = false;
            next.decoration_id = None;
            next.range = SuggestionRange::default();
            next.query = None;
            next.text = None;
            next.dismissed_range = if prev.active {
                Some(prev.range)
            } else {
                prev.dismissed_range
            };
            return Arc::new(next);
        }
        if let Some(key) = meta.and_then(|m| m.get("key")).and_then(Value::as_str) {
            next.last_key = Some(key.to_owned());
            next.key_count += 1;
        }
        if tr.doc_changed()
            && let Some(dismissed) = next.dismissed_range
        {
            next.dismissed_range = Some(SuggestionRange::new(
                tr.mapping.map(dismissed.from, 1),
                tr.mapping.map(dismissed.to, 1),
            ));
        }
        let selection = new.selection();
        let editable = new.plugins().iter().all(|p| p.editable(new) != Some(false));
        if editable && selection.empty() {
            let from = selection.from();
            if from < prev.range.from || from > prev.range.to {
                next.active = false;
            }
            let found = find_suggestion_match(&self.options.trigger, selection.resolved_from());
            let allowed = found.as_ref().is_some_and(|m| {
                self.options
                    .allow
                    .as_ref()
                    .is_none_or(|allow| allow(new, m.range, prev.active))
            });
            match found {
                Some(found) if allowed => {
                    if let Some(dismissed) = next.dismissed_range
                        && !self.keep_dismissed(&found, dismissed, tr)
                    {
                        next.dismissed_range = None;
                    }
                    if next.dismissed_range.is_none() {
                        next.active = true;
                        next.decoration_id = prev.decoration_id.clone().or_else(|| {
                            Some(format!(
                                "id_{}",
                                NEXT_DECORATION.fetch_add(1, Ordering::Relaxed)
                            ))
                        });
                        next.range = found.range;
                        next.query = Some(found.query);
                        next.text = Some(found.text);
                    } else {
                        next.active = false;
                    }
                }
                found => {
                    if found.is_none() {
                        next.dismissed_range = None;
                    }
                    next.active = false;
                }
            }
        } else {
            next.active = false;
        }
        if !next.active {
            next.decoration_id = None;
            next.range = SuggestionRange::default();
            next.query = None;
            next.text = None;
        }
        Arc::new(next)
    }

    fn state_to_json(&self, value: &PluginState) -> Option<Value> {
        self.state(value).map(SuggestionState::to_json)
    }

    fn handle_key_down(
        &self,
        state: &EditorState,
        event: &KeyEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        let Some(current) = self.key.get_state::<SuggestionState>(state) else {
            return false;
        };
        if !current.active {
            return false;
        }
        let down = SuggestionKeyDown {
            event: event.clone(),
            range: current.range,
            query: current.query.clone().unwrap_or_default(),
        };
        if event.key == "Escape" || event.key == "Esc" {
            if let Some(handler) = &self.options.on_key_down {
                handler(&down);
            }
            dispatch(exit_transaction(state, &self.key));
            return true;
        }
        if let Some(handler) = &self.options.on_key_down
            && handler(&down)
        {
            return true;
        }
        if !(event.mod_key || event.ctrl || event.alt || event.meta)
            && self.options.capture_keys.iter().any(|k| k == &event.key)
        {
            let mut tr = state.tr();
            tr.set_plugin_meta(&self.key, json!({ "key": event.key }));
            tr.set_add_to_history(false);
            tr.set_origin(TransactionOrigin::Plugin(self.key.name().to_owned()));
            dispatch(tr);
            return true;
        }
        false
    }

    fn decorations(&self, state: &EditorState) -> Option<DecorationSet> {
        let current = self.key.get_state::<SuggestionState>(state)?;
        if !current.active {
            return None;
        }
        let mut classes: Vec<&str> = self
            .options
            .decoration_class
            .iter()
            .map(String::as_str)
            .collect();
        if current.query.as_deref().is_none_or(str::is_empty)
            && let Some(empty) = &self.options.decoration_empty_class
        {
            classes.push(empty);
        }
        if classes.is_empty() {
            return None;
        }
        let mut attrs = BTreeMap::new();
        attrs.insert("class".to_owned(), Value::from(classes.join(" ")));
        if let Some(id) = &current.decoration_id {
            attrs.insert("data-decoration-id".to_owned(), Value::from(id.clone()));
        }
        Some(DecorationSet::create(
            state.doc(),
            vec![Decoration::inline(
                current.range.from,
                current.range.to,
                attrs,
            )],
        ))
    }
}

fn exit_transaction(state: &EditorState, key: &PluginKey) -> Transaction {
    let mut tr = state.tr();
    tr.set_plugin_meta(key, json!({ "exit": true }));
    tr.set_add_to_history(false);
    tr.set_origin(TransactionOrigin::Plugin(key.name().to_owned()));
    tr
}

/// A suggestion plugin with `options`; its key is `options.key`.
pub fn suggestion(options: SuggestionOptions) -> Plugin {
    Arc::new(Suggestion {
        key: PluginKey::new(&options.key),
        options,
    })
}

/// The state of the suggestion plugin keyed `key` in `state`.
pub fn suggestion_state(state: &EditorState, key: &str) -> Option<Arc<SuggestionState>> {
    PluginKey::new(key).get_state::<SuggestionState>(state)
}

/// Dismisses the active suggestion of the plugin keyed `key` (what Escape
/// does); refused when none is active.
pub fn exit_suggestion(key: &str) -> BoxCommand {
    let key = PluginKey::new(key);
    command(move |state, dispatch| {
        if !key
            .get_state::<SuggestionState>(state)
            .is_some_and(|s| s.active)
        {
            return false;
        }
        if let Some(dispatch) = dispatch {
            dispatch(exit_transaction(state, &key));
        }
        true
    })
}

/// Replaces the active suggestion's range (trigger and query) of the
/// plugin keyed `key` with `content`, the cursor after it (Tiptap's
/// suggestion `command`); refused when none is active.
pub fn replace_suggestion(key: &str, content: Fragment) -> BoxCommand {
    let key = PluginKey::new(key);
    command(move |state, dispatch| {
        let Some(current) = key.get_state::<SuggestionState>(state) else {
            return false;
        };
        if !current.active {
            return false;
        }
        replace_range(current.range, content.clone())(state, dispatch)
    })
}

fn replace_range(range: SuggestionRange, content: Fragment) -> BoxCommand {
    command(move |state, dispatch| {
        let mut tr = state.tr();
        if tr
            .replace_with(range.from, range.to, content.clone())
            .is_err()
            || !tr.doc_changed()
        {
            return false;
        }
        let end = tr.mapping.map(range.to, 1);
        let selection = TextSelection::create(tr.doc(), end.min(tr.doc().content().size()), None);
        tr.set_selection(selection);
        tr.scroll_into_view();
        if let Some(dispatch) = dispatch {
            dispatch(tr);
        }
        true
    })
}

// --- Mentions ----------------------------------------------------------------

fn null_attr() -> AttrSpec {
    AttrSpec {
        default: Some(Value::Null),
        rendered: false,
        ..Default::default()
    }
}

/// Tiptap's `Mention` node, named `name` (`mention`): an inline atom with
/// `id`, `label` and `mentionSuggestionChar` (`char` by default), written
/// as `<span data-type="mention" data-id data-label>` and as the text
/// `@label` (the id without a label).
pub fn mention_node(name: &str, char: &str) -> (String, NodeSpec) {
    let char = char.to_owned();
    let char_attr = AttrSpec {
        default: Some(Value::from(char.clone())),
        rendered: false,
        ..Default::default()
    };
    let data_type = name.to_owned();
    (
        name.to_owned(),
        NodeSpec {
            group: Some("inline".into()),
            inline: true,
            atom: true,
            selectable: false,
            attrs: vec![
                ("id".into(), null_attr()),
                ("label".into(), null_attr()),
                ("mentionSuggestionChar".into(), char_attr),
            ],
            parse_dom: vec![
                ParseRule::tag(format!("span[data-type=\"{data_type}\"]")).with_get_attrs(
                    move |input| {
                        let el = input.element()?;
                        let get = |name: &str| el.attr(name).map_or(Value::Null, Value::from);
                        let mut attrs = Attrs::new();
                        attrs.insert("id".into(), get("data-id"));
                        attrs.insert("label".into(), get("data-label"));
                        if let Some(c) = el.attr("data-mention-suggestion-char") {
                            attrs.insert("mentionSuggestionChar".into(), Value::from(c));
                        }
                        Some(attrs)
                    },
                ),
            ],
            to_dom: Some(
                DomOutputSpec::tag("span")
                    .attr("data-type", name)
                    .attr_of("data-id", "id")
                    .attr_of("data-label", "label")
                    .attr_of("data-mention-suggestion-char", "mentionSuggestionChar")
                    .child(DomOutputSpec::AttrText("mentionSuggestionChar".into()))
                    .child(DomOutputSpec::AttrText("label".into())),
            ),
            render_text: Some(TextRender::new(move |node: &Node| {
                mention_text(node, &char)
            })),
            ..Default::default()
        },
    )
}

/// A mention's text: its trigger and its label (its id without one).
pub fn mention_text(node: &Node, default_char: &str) -> String {
    let attrs = node.attrs();
    let char = attrs
        .get("mentionSuggestionChar")
        .and_then(Value::as_str)
        .unwrap_or(default_char);
    let label = attrs
        .get("label")
        .filter(|v| !v.is_null())
        .or_else(|| attrs.get("id"))
        .map(|v| match v {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            other => other.to_string(),
        })
        .unwrap_or_default();
    format!("{char}{label}")
}

/// Tiptap's mention command: replaces `range` with a mention node of type
/// `name` with `attrs` and a space (taking a space already after the range
/// into it), the cursor after the space.
pub fn insert_mention(name: &str, range: SuggestionRange, attrs: Attrs) -> BoxCommand {
    let name = name.to_owned();
    command(move |state, dispatch| {
        let Some(ty) = state.schema().node_type(&name) else {
            return false;
        };
        let Ok(node) = ty.create(Some(attrs.clone()), Fragment::empty(), vec![]) else {
            return false;
        };
        let mut range = range;
        let after = state
            .doc()
            .resolve(range.to)
            .ok()
            .and_then(|r| r.node_after());
        if after
            .as_ref()
            .and_then(|n| n.text())
            .is_some_and(|t| t.starts_with(' '))
        {
            range.to += 1;
        }
        let content = Fragment::from(vec![node, state.schema().text(" ", vec![])]);
        replace_range(range, content)(state, dispatch)
    })
}

/// Registers `exitSuggestion` (`{ key? }`), `replaceSuggestion` (`{ key?,
/// content }`, content as `insertContent` takes it) and `insertMention`
/// (`{ range: { from, to }, id, label?, char?, name? }`) in `registry`.
pub fn register_commands(registry: &mut CommandRegistry) {
    fn key(args: &Value) -> &str {
        args.get("key")
            .and_then(Value::as_str)
            .unwrap_or(SUGGESTION_KEY)
    }
    registry.register("exitSuggestion", |args, _| Ok(exit_suggestion(key(args))));
    registry.register("replaceSuggestion", |args, schema| {
        let content = args
            .get("content")
            .ok_or("replaceSuggestion needs `content`")?;
        Ok(replace_suggestion(
            key(args),
            content_fragment(schema, content)?,
        ))
    });
    registry.register("insertMention", |args, _| {
        let range = args.get("range").ok_or("insertMention needs `range`")?;
        let pos = |k: &str| {
            range
                .get(k)
                .and_then(Value::as_u64)
                .map(|n| n as usize)
                .ok_or_else(|| format!("insertMention: `range.{k}` is a position"))
        };
        let range = SuggestionRange::new(pos("from")?, pos("to")?);
        let mut attrs = Attrs::new();
        for (from, to) in [
            ("id", "id"),
            ("label", "label"),
            ("char", "mentionSuggestionChar"),
        ] {
            if let Some(v) = args.get(from).filter(|v| !v.is_null()) {
                attrs.insert(to.into(), v.clone());
            }
        }
        let name = args
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("mention");
        Ok(insert_mention(name, range, attrs))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::{
        extensions::starter,
        formats::{DocFormat, PlainTextFormat},
        model::{Schema, SchemaSpec},
    };

    fn schema() -> Schema {
        let mut spec: SchemaSpec = starter::schema_spec();
        spec.nodes.push(mention_node("mention", "@"));
        Schema::new(spec).unwrap()
    }

    fn doc_of(schema: &Schema, text: &str) -> Node {
        let content = if text.is_empty() {
            Fragment::empty()
        } else {
            Fragment::from(vec![schema.text(text, vec![])])
        };
        schema
            .node(
                "doc",
                None,
                Fragment::from(vec![
                    schema.node("paragraph", None, content, vec![]).unwrap(),
                ]),
                vec![],
            )
            .unwrap()
    }

    fn find(text: &str, trigger: &SuggestionTrigger) -> Option<SuggestionMatch> {
        let schema = schema();
        let doc = doc_of(&schema, text);
        let pos = doc.resolve(1 + utf16_len(text)).unwrap();
        find_suggestion_match(trigger, &pos)
    }

    fn at(prefixes: &[&str]) -> SuggestionTrigger {
        SuggestionTrigger {
            allowed_prefixes: Some(prefixes.iter().map(|s| (*s).to_owned()).collect()),
            ..SuggestionTrigger::default()
        }
    }

    #[test]
    fn matches_follow_tiptaps_prefix_rules() {
        let bob = SuggestionMatch {
            range: SuggestionRange::new(4, 8),
            query: "bob".into(),
            text: "@bob".into(),
        };
        assert_eq!(find("hi-@bob", &at(&[" ", "-"])), Some(bob.clone()));
        assert_eq!(find("hi]@bob", &at(&[" ", "]"])), Some(bob.clone()));
        assert_eq!(find("hi @bob", &at(&[" "])), Some(bob.clone()));
        assert_eq!(find("hi.@bob", &at(&[" "])), None);
        assert_eq!(find("hi^@bob", &at(&["^"])), Some(bob.clone()));
        assert_eq!(find("hi @bob", &at(&["^"])), None);
        assert_eq!(find("hi\\@bob", &at(&["\\"])), Some(bob));
        // At the text's start, and with any prefix allowed.
        assert_eq!(
            find("@a", &SuggestionTrigger::default()).unwrap().query,
            "a"
        );
        let any = SuggestionTrigger {
            allowed_prefixes: None,
            ..SuggestionTrigger::default()
        };
        assert!(find("x@a", &any).is_some());
    }

    #[test]
    fn spaces_end_a_query_unless_allowed() {
        assert_eq!(find("@bob smith", &SuggestionTrigger::default()), None);
        let spaces = SuggestionTrigger {
            allow_spaces: true,
            ..SuggestionTrigger::default()
        };
        let found = find("@bob smith", &spaces).unwrap();
        assert_eq!(
            (found.query.as_str(), found.range),
            ("bob smith", SuggestionRange::new(1, 11))
        );
        let found = find("@a @b c", &spaces).unwrap();
        assert_eq!(found.text, "@b c");
        let line = SuggestionTrigger {
            start_of_line: true,
            ..SuggestionTrigger::default()
        };
        assert!(find("x @a", &line).is_none());
        assert!(
            find(
                "/cmd",
                &SuggestionTrigger {
                    char: "/".into(),
                    ..line
                }
            )
            .is_some()
        );
    }

    fn editor(options: SuggestionOptions) -> EditorState {
        let schema = schema();
        let doc = doc_of(&schema, "");
        EditorState::create(
            EditorStateConfig::new(schema)
                .doc(doc)
                .plugins(vec![suggestion(options)]),
        )
        .unwrap()
    }

    fn type_text(state: &EditorState, text: &str) -> EditorState {
        let mut tr = state.tr();
        tr.insert_text(text, None, None);
        state.apply(tr).unwrap()
    }

    fn current(state: &EditorState) -> Arc<SuggestionState> {
        suggestion_state(state, SUGGESTION_KEY).unwrap()
    }

    #[test]
    fn typing_the_trigger_activates_and_tracks_the_query() {
        let state = editor(SuggestionOptions {
            decoration_class: Some("mention-query".into()),
            ..SuggestionOptions::default()
        });
        let state = type_text(&state, "hi ");
        assert!(!current(&state).active);
        let state = type_text(&state, "@");
        let s = current(&state);
        assert!(s.active);
        assert_eq!(
            (s.range, s.query.as_deref()),
            (SuggestionRange::new(4, 5), Some(""))
        );
        let state = type_text(&state, "jo");
        let s = current(&state);
        assert_eq!(s.query.as_deref(), Some("jo"));
        assert_eq!(s.text.as_deref(), Some("@jo"));
        let decorations = state.plugins()[0].decorations(&state).unwrap();
        assert_eq!(decorations.iter().count(), 1);
        assert_eq!(current(&state).to_json()["range"]["to"], json!(7));
        let state = type_text(&state, " ");
        assert!(!current(&state).active);
    }

    #[test]
    fn escape_dismisses_until_a_space() {
        let state = type_text(&editor(SuggestionOptions::default()), "@jo");
        let mut out = None;
        assert!(
            state.plugins()[0]
                .handle_key_down(&state, &KeyEvent::new("Escape"), &mut |tr| out = Some(tr))
        );
        let state = state.apply(out.unwrap()).unwrap();
        assert!(!current(&state).active);
        // Typing on in the dismissed query keeps it dismissed.
        let state = type_text(&state, "e");
        assert!(!current(&state).active);
        // A new trigger elsewhere is active again.
        let state = type_text(&state, " @a");
        assert!(current(&state).active);
    }

    #[test]
    fn key_handlers_and_captured_keys() {
        let options = SuggestionOptions {
            capture_keys: vec!["ArrowDown".into(), "Enter".into()],
            on_key_down: Some(Arc::new(|down: &SuggestionKeyDown| down.event.key == "Tab")),
            ..SuggestionOptions::default()
        };
        let state = type_text(&editor(options), "@x");
        let plugin = state.plugins()[0].clone();
        assert!(plugin.handle_key_down(&state, &KeyEvent::new("Tab"), &mut |_| {}));
        let mut out = None;
        assert!(
            plugin.handle_key_down(&state, &KeyEvent::new("ArrowDown"), &mut |tr| out =
                Some(tr))
        );
        let state = state.apply(out.unwrap()).unwrap();
        let s = current(&state);
        assert!(s.active);
        assert_eq!((s.last_key.as_deref(), s.key_count), (Some("ArrowDown"), 1));
        assert!(!plugin.handle_key_down(&state, &KeyEvent::new("a"), &mut |_| {}));
    }

    #[test]
    fn replacing_and_mentioning() {
        let state = type_text(&editor(SuggestionOptions::default()), "hi @jo");
        let range = current(&state).range;
        let mut attrs = Attrs::new();
        attrs.insert("id".into(), json!("u1"));
        attrs.insert("label".into(), json!("Joan"));
        let mut out = None;
        assert!(insert_mention("mention", range, attrs)(
            &state,
            Some(&mut |tr| out = Some(tr))
        ));
        let state = state.apply(out.unwrap()).unwrap();
        let text = PlainTextFormat::default().serialize(state.doc()).unwrap();
        assert_eq!(text.trim_end(), "hi @Joan");
        assert_eq!(state.selection().from(), 6);
        assert!(!current(&state).active);
        // Replacing the range with text.
        let state = type_text(&state, "/x");
        let state = type_text(&state, " @ab");
        let schema = state.schema().clone();
        let mut out = None;
        assert!(replace_suggestion(
            SUGGESTION_KEY,
            Fragment::from(vec![schema.text("done", vec![])])
        )(&state, Some(&mut |tr| out = Some(tr))));
        let state = state.apply(out.unwrap()).unwrap();
        assert!(state.doc().text_content().ends_with("/x done"));
        assert!(!exit_suggestion(SUGGESTION_KEY)(&state, None));
    }
}

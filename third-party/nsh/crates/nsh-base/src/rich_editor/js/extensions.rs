//! The JS face of the Link, CharacterCount and Suggestion plugins
//! (`link(...)`, `characterCount(...)`, `suggestion(...)`): their options
//! as data, resolved into the kernel's plugins when the editor is made, and
//! the queries the session answers for them (`suggestion(key)`,
//! `characters(mode)`, `words()`).

use nsh_core::prelude::*;

use crate::rich_editor::{
    extensions::{
        character_count::{self, CharacterCountMode, CharacterCountOptions},
        link::{self, LinkOptions},
        suggestion::{self, SuggestionOptions, SuggestionTrigger},
    },
    model::Schema,
    state::{EditorState, Plugin},
};

/// What `link` does; Tiptap's options and defaults.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichLinkOptions {
    /// The link mark's type name (`link`).
    pub(crate) mark: Option<String>,
    /// Links URLs as they are typed (a space or Enter ends them) and the
    /// URLs in pasted text (true).
    pub(crate) autolink: Option<bool>,
    /// Pasting a URL over a selection links the selection (true).
    pub(crate) link_on_paste: Option<bool>,
    /// A press on a link opens it while Mod is held or the editor is not
    /// editable (true).
    pub(crate) open_on_click: Option<bool>,
    /// A press on a link selects the whole link (false).
    pub(crate) enable_click_selection: Option<bool>,
    /// Protocols allowed and found beyond `http`, `https`, `ftp`, `ftps`,
    /// `mailto`, `tel`, `callto`, `sms`, `cid` and `xmpp`.
    pub(crate) protocols: Option<Vec<String>>,
    /// The protocol URLs found without one get (`http`).
    pub(crate) default_protocol: Option<String>,
}

/// What `characterCount` counts and limits.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichCharacterCountOptions {
    /// The most characters the document may have; none when left out or 0.
    pub(crate) limit: Option<usize>,
    /// `"textSize"` (the text's UTF-16 length, the default) or
    /// `"nodeSize"` (the document's positions).
    pub(crate) mode: Option<String>,
    /// Trims a first document over the limit (true).
    pub(crate) auto_trim: Option<bool>,
}

/// How `suggestion` finds its trigger and shows its range.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichSuggestionOptions {
    /// The plugin's key (`suggestion`); each suggestion of an editor needs
    /// its own (`mention`, `slash`).
    pub(crate) key: Option<String>,
    /// The trigger (`@`).
    pub(crate) char: Option<String>,
    /// The query may hold spaces (false).
    pub(crate) allow_spaces: Option<bool>,
    /// The query may hold the trigger (false).
    pub(crate) allow_to_include_char: Option<bool>,
    /// What may precede the trigger (`[" "]`); a trigger starting the
    /// text always matches.
    pub(crate) allowed_prefixes: Option<Vec<String>>,
    /// Anything may precede the trigger (Tiptap's `allowedPrefixes: null`;
    /// false).
    pub(crate) any_prefix: Option<bool>,
    /// The trigger must start the line (false).
    pub(crate) start_of_line: Option<bool>,
    /// The class of the active range's decoration.
    pub(crate) decoration_class: Option<String>,
    /// The class added while the query is empty.
    pub(crate) decoration_empty_class: Option<String>,
    /// Keys taken while a suggestion is active, recorded in its state
    /// (`lastKey`, `keyCount`) for the app's list: `"ArrowUp"`,
    /// `"ArrowDown"`, `"Enter"`, `"Tab"`. Escape always dismisses.
    pub(crate) capture_keys: Option<Vec<String>>,
}

/// What `withMention` adds.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[prop(exact)]
pub(crate) struct RichMentionOptions {
    /// The node type's name (`mention`).
    pub(crate) name: Option<String>,
    /// The trigger its text starts with (`@`).
    pub(crate) char: Option<String>,
}

pub(crate) fn link_plugins(options: &RichLinkOptions) -> Vec<Plugin> {
    let mut out = LinkOptions::default();
    if let Some(mark) = &options.mark {
        out.mark = mark.clone();
    }
    if let Some(v) = options.autolink {
        out.autolink = v;
    }
    if let Some(v) = options.link_on_paste {
        out.link_on_paste = v;
    }
    if let Some(v) = options.open_on_click {
        out.open_on_click = v;
    }
    if let Some(v) = options.enable_click_selection {
        out.enable_click_selection = v;
    }
    if let Some(v) = &options.protocols {
        out.protocols = v.clone();
    }
    if let Some(v) = &options.default_protocol {
        out.default_protocol = v.clone();
    }
    link::link(out)
}

pub(crate) fn character_count_plugin(
    options: &RichCharacterCountOptions,
) -> Result<Plugin, String> {
    let mut out = CharacterCountOptions {
        limit: options.limit,
        no_auto_trim: options.auto_trim == Some(false),
        ..CharacterCountOptions::default()
    };
    if let Some(mode) = &options.mode {
        out.mode = mode_of(mode)?;
    }
    Ok(character_count::character_count(out))
}

pub(crate) fn mode_of(name: &str) -> Result<CharacterCountMode, String> {
    CharacterCountMode::from_name(name)
        .ok_or_else(|| format!("no character count mode `{name}` (textSize, nodeSize)"))
}

pub(crate) fn suggestion_plugin(options: &RichSuggestionOptions) -> Plugin {
    let mut trigger = SuggestionTrigger::default();
    if let Some(v) = &options.char {
        trigger.char = v.clone();
    }
    if let Some(v) = options.allow_spaces {
        trigger.allow_spaces = v;
    }
    if let Some(v) = options.allow_to_include_char {
        trigger.allow_to_include_char = v;
    }
    if let Some(v) = &options.allowed_prefixes {
        trigger.allowed_prefixes = Some(v.clone());
    }
    if options.any_prefix == Some(true) {
        trigger.allowed_prefixes = None;
    }
    if let Some(v) = options.start_of_line {
        trigger.start_of_line = v;
    }
    let mut out = SuggestionOptions::default();
    if let Some(key) = &options.key {
        out.key = key.clone();
    }
    out.trigger = trigger;
    out.decoration_class = options.decoration_class.clone();
    out.decoration_empty_class = options.decoration_empty_class.clone();
    out.capture_keys = options.capture_keys.clone().unwrap_or_default();
    suggestion::suggestion(out)
}

/// `schema` with a mention node added (inline, so its paragraphs take it).
pub(crate) fn with_mention(
    schema: &Schema,
    options: &RichMentionOptions,
) -> Result<Schema, String> {
    let name = options.name.as_deref().unwrap_or("mention");
    let char = options.char.as_deref().unwrap_or("@");
    let mut spec = schema.spec();
    if spec.nodes.iter().any(|(n, _)| n == name) {
        return Err(format!("the schema has a node type `{name}` already"));
    }
    spec.nodes.push(suggestion::mention_node(name, char));
    Schema::new(spec).map_err(|e| e.to_string())
}

/// A range of the document.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct RichRange {
    /// Its start.
    pub(crate) from: usize,
    /// Its end.
    pub(crate) to: usize,
}

/// A suggestion plugin's state, as the editor's `suggestion(key)` gives it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct RichSuggestionState {
    /// Whether a suggestion is active.
    pub(crate) active: bool,
    /// The trigger and the query (`0..0` when inactive).
    pub(crate) range: RichRange,
    /// The text after the trigger.
    #[prop(skip_none)]
    pub(crate) query: Option<String>,
    /// The trigger and the query.
    #[prop(skip_none)]
    pub(crate) text: Option<String>,
    /// An id of the active suggestion, kept while it stays active.
    #[prop(skip_none)]
    pub(crate) decoration_id: Option<String>,
    /// The last of `captureKeys` taken while active.
    #[prop(skip_none)]
    pub(crate) last_key: Option<String>,
    /// How many keys of `captureKeys` were taken.
    pub(crate) key_count: f64,
}

/// The suggestion state keyed `key`, `null` without the plugin.
pub(crate) fn suggestion_of(state: &EditorState, key: Option<&str>) -> Option<RichSuggestionState> {
    let s = suggestion::suggestion_state(state, key.unwrap_or(suggestion::SUGGESTION_KEY))?;
    Some(RichSuggestionState {
        active: s.active,
        range: RichRange {
            from: s.range.from,
            to: s.range.to,
        },
        query: s.query.clone(),
        text: s.text.clone(),
        decoration_id: s.decoration_id.clone(),
        last_key: s.last_key.clone(),
        key_count: s.key_count as f64,
    })
}

//! Tiptap's `CharacterCount`: counts a document's characters and words,
//! and keeps it within a limit. Ported from `@tiptap/extensions`'
//! `character-count`.
//!
//! Characters count by `mode`: the text's UTF-16 code units (`TextSize`,
//! JS's `text.length`, with a space for each inline leaf) or the
//! document's node size (`NodeSize`). Words are the text's Unicode words
//! (UAX #29, `unicode-segmentation`). With a `limit`, transactions that
//! would grow the count past it are refused; pasted content is trimmed to
//! what fits; a first document over the limit is trimmed from its start
//! (`auto_trim`). [`set_character_limit`] changes the limit.

use std::sync::Arc;

use serde_json::{Value, json};
use unicode_segmentation::UnicodeSegmentation;

use crate::rich_editor::{
    commands::{BoxCommand, CommandRegistry, command},
    model::{Node, Slice, utf16_len},
    state::{
        EditorState, EditorStateConfig, Plugin, PluginKey, PluginSpec, PluginState, Transaction,
        TransactionOrigin,
    },
};

/// The key of the character count plugin's state (Tiptap's
/// `characterCount`), and of the meta [`set_character_limit`] sets.
pub const CHARACTER_COUNT_KEY: &str = "characterCount";

/// What [`characters`] counts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum CharacterCountMode {
    /// The text's length in UTF-16 code units, inline leaves one each.
    #[default]
    TextSize,
    /// The document's node size (its positions).
    NodeSize,
}

impl CharacterCountMode {
    /// Its name, Tiptap's (`textSize`, `nodeSize`).
    pub fn name(self) -> &'static str {
        match self {
            Self::TextSize => "textSize",
            Self::NodeSize => "nodeSize",
        }
    }

    /// The mode named `name`.
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "textSize" => Some(Self::TextSize),
            "nodeSize" => Some(Self::NodeSize),
            _ => None,
        }
    }
}

/// Counts a text.
pub type TextCounter = Arc<dyn Fn(&str) -> usize + Send + Sync>;

/// The options of [`character_count`], Tiptap's defaults.
#[derive(Clone, Default)]
#[non_exhaustive]
pub struct CharacterCountOptions {
    /// The most characters the document may have; `None` (or 0) for no
    /// limit.
    pub limit: Option<usize>,
    /// What counts as a character.
    pub mode: CharacterCountMode,
    /// Trims a first document over the limit (Tiptap's `autoTrim`; on
    /// unless turned off).
    pub no_auto_trim: bool,
    /// Counts a text's characters in `TextSize` mode; UTF-16 code units
    /// when `None`.
    pub text_counter: Option<TextCounter>,
    /// Counts a text's words; Unicode words when `None`.
    pub word_counter: Option<TextCounter>,
}

impl std::fmt::Debug for CharacterCountOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CharacterCountOptions")
            .field("limit", &self.limit)
            .field("mode", &self.mode)
            .field("no_auto_trim", &self.no_auto_trim)
            .finish_non_exhaustive()
    }
}

/// The plugin's state.
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct CharacterCountState {
    /// The limit now (`setCharacterLimit` changes it).
    pub limit: Option<usize>,
    /// Whether a transaction has applied since the state was created.
    pub initialized: bool,
    /// The plugin's options (its mode and counters).
    pub options: CharacterCountOptions,
}

fn has_limit(limit: Option<usize>) -> Option<usize> {
    limit.filter(|l| *l != 0)
}

/// The words of `text`: its Unicode words (UAX #29).
pub fn count_words(text: &str) -> usize {
    text.unicode_words().count()
}

struct Counter {
    options: CharacterCountOptions,
}

impl Counter {
    fn characters(&self, node: &Node, mode: CharacterCountMode) -> usize {
        match mode {
            CharacterCountMode::TextSize => {
                let text = node.text_between(0, node.content().size(), None, Some(" "));
                match &self.options.text_counter {
                    Some(count) => count(&text),
                    None => utf16_len(&text),
                }
            }
            CharacterCountMode::NodeSize => node.node_size(),
        }
    }

    fn words(&self, node: &Node) -> usize {
        let text = node.text_between(0, node.content().size(), Some(" "), Some(" "));
        match &self.options.word_counter {
            Some(count) => count(&text),
            None => count_words(&text),
        }
    }

    fn limit(&self, state: &EditorState) -> Option<usize> {
        let key = PluginKey::new(CHARACTER_COUNT_KEY);
        key.get_state::<CharacterCountState>(state)
            .map_or(self.options.limit, |s| s.limit)
    }
}

// The limit a transaction's meta sets: `Some(limit)` when it sets one.
fn meta_limit(tr: &Transaction) -> Option<Option<usize>> {
    let meta = tr.get_meta(CHARACTER_COUNT_KEY)?;
    Some(
        meta.get("limit")
            .and_then(Value::as_u64)
            .map(|l| l as usize),
    )
}

impl PluginSpec for Counter {
    fn key(&self) -> PluginKey {
        PluginKey::new(CHARACTER_COUNT_KEY)
    }

    fn init_state(&self, _: &EditorStateConfig, _: &EditorState) -> Option<PluginState> {
        Some(Arc::new(CharacterCountState {
            limit: self.options.limit,
            initialized: false,
            options: self.options.clone(),
        }))
    }

    fn apply_state(
        &self,
        tr: &Transaction,
        value: &PluginState,
        _: &EditorState,
        _: &EditorState,
    ) -> PluginState {
        let previous = value
            .downcast_ref::<CharacterCountState>()
            .cloned()
            .unwrap_or_default();
        Arc::new(CharacterCountState {
            limit: meta_limit(tr).unwrap_or(previous.limit),
            initialized: true,
            options: self.options.clone(),
        })
    }

    fn state_to_json(&self, value: &PluginState) -> Option<Value> {
        let state = value.downcast_ref::<CharacterCountState>()?;
        Some(json!({ "limit": state.limit }))
    }

    fn filter_transaction(&self, tr: &Transaction, state: &EditorState) -> bool {
        let limit = match meta_limit(tr) {
            Some(limit) => limit,
            None => self.limit(state),
        };
        let Some(limit) = has_limit(limit) else {
            return true;
        };
        if !tr.doc_changed() {
            return true;
        }
        let old = self.characters(state.doc(), self.options.mode);
        let new = self.characters(tr.doc(), self.options.mode);
        // Within the limit, or over it already and not growing.
        new <= limit || (old > limit && new <= old)
    }

    fn transform_pasted(&self, state: &EditorState, slice: Slice) -> Slice {
        let Some(limit) = has_limit(self.limit(state)) else {
            return slice;
        };
        let selection = state.selection();
        let (from, to) = (selection.from(), selection.to());
        let fits = |slice: &Slice| {
            state
                .doc()
                .replace(from, to, slice)
                .is_ok_and(|doc| self.characters(&doc, self.options.mode) <= limit)
        };
        if fits(&slice) {
            return slice;
        }
        // The longest start of the pasted content that fits (Tiptap deletes
        // what goes over the limit before the cursor after the paste).
        let size = slice.content.size();
        let (mut low, mut high) = (0, size);
        let cut = |end: usize| Slice::new(slice.content.cut(0, end), slice.open_start, 0);
        while low < high {
            let mid = (low + high).div_ceil(2);
            if fits(&cut(mid)) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        let trimmed = cut(low);
        if fits(&trimmed) {
            trimmed
        } else {
            Slice::empty()
        }
    }

    fn append_transaction(
        &self,
        trs: &[Transaction],
        old: &EditorState,
        new: &EditorState,
    ) -> Option<Transaction> {
        let key = PluginKey::new(CHARACTER_COUNT_KEY);
        if key
            .get_state::<CharacterCountState>(old)
            .is_some_and(|s| s.initialized)
            || trs
                .iter()
                .any(|tr| tr.get_meta(CHARACTER_COUNT_KEY).is_some())
            || self.options.no_auto_trim
        {
            return None;
        }
        let limit = has_limit(self.limit(new))?;
        let size = self.characters(new.doc(), self.options.mode);
        if size <= limit {
            return None;
        }
        log::warn!(
            "CharacterCount: the first content exceeded the limit of {limit} characters and was trimmed"
        );
        // Tiptap deletes `0..over`; the first position inside the document
        // is 1, so the range starts there.
        let mut tr = new.tr();
        let over = size - limit;
        let end = (1 + over).min(new.doc().content().size());
        tr.delete_range(1.min(end), end).ok()?;
        tr.set_origin(TransactionOrigin::Plugin(CHARACTER_COUNT_KEY.into()));
        Some(tr)
    }
}

/// A plugin counting characters and words and keeping the document
/// within `options.limit`; its key is [`CHARACTER_COUNT_KEY`].
pub fn character_count(options: CharacterCountOptions) -> Plugin {
    Arc::new(Counter { options })
}

/// The characters of `state`'s document in `mode` (the plugin's mode when
/// `None`), counted as its character count plugin counts (UTF-16 code
/// units of the text without one).
pub fn characters(state: &EditorState, mode: Option<CharacterCountMode>) -> usize {
    let options = plugin_options(state).unwrap_or_default();
    let mode = mode.unwrap_or(options.mode);
    Counter { options }.characters(state.doc(), mode)
}

/// The words of `state`'s document, counted as its character count plugin
/// counts (Unicode words without one).
pub fn words(state: &EditorState) -> usize {
    let options = plugin_options(state).unwrap_or_default();
    Counter { options }.words(state.doc())
}

/// The limit of `state`'s character count plugin now, if it has one.
pub fn character_limit(state: &EditorState) -> Option<usize> {
    PluginKey::new(CHARACTER_COUNT_KEY)
        .get_state::<CharacterCountState>(state)
        .and_then(|s| has_limit(s.limit))
}

fn plugin_options(state: &EditorState) -> Option<CharacterCountOptions> {
    PluginKey::new(CHARACTER_COUNT_KEY)
        .get_state::<CharacterCountState>(state)
        .map(|s| s.options.clone())
}

/// Tiptap's `setCharacterLimit`: the limit from now on (`None` for none);
/// refused for nothing, applies with or without the plugin.
pub fn set_character_limit(limit: Option<usize>) -> BoxCommand {
    command(move |state, dispatch| {
        if let Some(dispatch) = dispatch {
            let mut tr = state.tr();
            tr.set_meta(CHARACTER_COUNT_KEY, json!({ "limit": limit }));
            dispatch(tr);
        }
        true
    })
}

/// Registers `setCharacterLimit` (`{ limit: number | null }`) in
/// `registry`.
pub fn register_commands(registry: &mut CommandRegistry) {
    registry.register("setCharacterLimit", |args, _| {
        let limit = match args.get("limit") {
            None | Some(Value::Null) => None,
            Some(v) => Some(
                v.as_f64()
                    .filter(|n| n.is_finite() && *n >= 0.0)
                    .map(|n| n as usize)
                    .ok_or("setCharacterLimit: `limit` is a number ≥ 0 or null")?,
            ),
        };
        Ok(set_character_limit(limit))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::{
        extensions::starter,
        model::Fragment,
        state::{EditorStateConfig, TextSelection},
    };

    fn state_with(text: &str, options: CharacterCountOptions) -> EditorState {
        let schema = starter::schema();
        let paragraph = |t: &str| {
            schema
                .node(
                    "paragraph",
                    None,
                    if t.is_empty() {
                        Fragment::empty()
                    } else {
                        Fragment::from(vec![schema.text(t, vec![])])
                    },
                    vec![],
                )
                .unwrap()
        };
        let blocks: Vec<Node> = text.split('\n').map(paragraph).collect();
        let doc = schema
            .node("doc", None, Fragment::from(blocks), vec![])
            .unwrap();
        let end = doc.content().size() - 1;
        let selection = TextSelection::create(&doc, end, None);
        EditorState::create(
            EditorStateConfig::new(schema)
                .doc(doc)
                .selection(selection)
                .plugins(vec![character_count(options)]),
        )
        .unwrap()
    }

    fn limited(limit: usize) -> CharacterCountOptions {
        CharacterCountOptions {
            limit: Some(limit),
            ..CharacterCountOptions::default()
        }
    }

    fn type_text(state: &EditorState, text: &str) -> Result<EditorState, ()> {
        let mut tr = state.tr();
        tr.insert_text(text, None, None);
        let (next, applied) = state.apply_transaction(tr).map_err(|_| ())?;
        if applied.is_empty() {
            Err(())
        } else {
            Ok(next)
        }
    }

    #[test]
    fn counts_characters_and_words() {
        let state = state_with(
            "Hello world\nsecond line, 😀",
            CharacterCountOptions::default(),
        );
        // Blocks join without a separator, as Tiptap's `textSize`; the
        // emoji is two UTF-16 units.
        assert_eq!(characters(&state, None), 11 + 15);
        assert_eq!(words(&state), 4);
        assert_eq!(
            characters(&state, Some(CharacterCountMode::NodeSize)),
            state.doc().node_size()
        );
        assert_eq!(character_limit(&state), None);
    }

    #[test]
    fn typing_past_the_limit_is_refused() {
        let state = state_with("abc", limited(5));
        let state = type_text(&state, "de").unwrap();
        assert_eq!(state.doc().text_content(), "abcde");
        assert!(type_text(&state, "f").is_err());
        // Deleting is always allowed.
        let mut tr = state.tr();
        tr.delete(1, 2).unwrap();
        assert!(state.apply(tr).is_ok());
    }

    #[test]
    fn pasted_content_is_trimmed_to_fit() {
        let state = state_with("abc", limited(6));
        let schema = state.schema().clone();
        let slice = Slice::new(Fragment::from(vec![schema.text("defghij", vec![])]), 0, 0);
        let slice = state
            .plugins()
            .iter()
            .fold(slice, |s, p| p.transform_pasted(&state, s));
        let mut tr = state.tr();
        tr.replace_selection(slice);
        let state = state.apply(tr).unwrap();
        assert_eq!(state.doc().text_content(), "abcdef");
    }

    #[test]
    fn a_first_document_over_the_limit_is_trimmed() {
        let state = state_with("abcdefgh", limited(5));
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), 1, None));
        let state = state.apply(tr).unwrap();
        assert_eq!(state.doc().text_content(), "defgh");
        let off = CharacterCountOptions {
            no_auto_trim: true,
            ..limited(5)
        };
        let state = state_with("abcdefgh", off);
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), 1, None));
        assert_eq!(state.apply(tr).unwrap().doc().text_content(), "abcdefgh");
    }

    #[test]
    fn set_character_limit_changes_it() {
        let state = state_with("abc", limited(3));
        assert!(type_text(&state, "d").is_err());
        let mut out = None;
        assert!(set_character_limit(Some(10))(
            &state,
            Some(&mut |tr| out = Some(tr))
        ));
        let state = state.apply(out.unwrap()).unwrap();
        assert_eq!(character_limit(&state), Some(10));
        assert!(type_text(&state, "d").is_ok());
        let mut out = None;
        set_character_limit(None)(&state, Some(&mut |tr| out = Some(tr)));
        let state = state.apply(out.unwrap()).unwrap();
        assert_eq!(character_limit(&state), None);
    }

    #[test]
    fn custom_counters_count() {
        let options = CharacterCountOptions {
            text_counter: Some(Arc::new(|t: &str| t.graphemes(true).count())),
            word_counter: Some(Arc::new(|t: &str| {
                t.split(' ').filter(|w| !w.is_empty()).count()
            })),
            ..CharacterCountOptions::default()
        };
        let state = state_with("a😀 b", options);
        assert_eq!(characters(&state, None), 4);
        assert_eq!(words(&state), 2);
    }
}

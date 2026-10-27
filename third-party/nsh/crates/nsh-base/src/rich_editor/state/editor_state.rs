//! The editor state, after `prosemirror-state`'s `state.ts`: an immutable
//! snapshot that [`EditorState::apply_transaction`] advances through the
//! plugins' filters, state updates and appended transactions.

use std::{collections::HashMap, fmt, sync::Arc};

use serde_json::{Map, Value};

use super::{
    MAX_APPEND_ROUNDS, StateError,
    plugin::{Plugin, PluginKey, PluginState},
    selection::{Selection, SelectionRegistry},
    transaction::{APPENDED_TRANSACTION, Transaction},
};
use crate::rich_editor::model::{Fragment, Mark, Node, Schema};

/// What a new [`EditorState`] is made of.
#[derive(Clone)]
#[non_exhaustive]
pub struct EditorStateConfig {
    /// The schema.
    pub schema: Schema,
    /// The document; by default the schema's top node, filled with the
    /// least content it needs.
    pub doc: Option<Node>,
    /// The selection; by default at the document's start.
    pub selection: Option<Selection>,
    /// The stored marks.
    pub stored_marks: Option<Vec<Mark>>,
    /// The plugins, in the order their hooks run.
    pub plugins: Vec<Plugin>,
    /// The custom selection kinds [`EditorState::from_json`] reads.
    pub selection_registry: SelectionRegistry,
}

impl EditorStateConfig {
    /// A configuration of `schema` with everything else at its default.
    pub fn new(schema: Schema) -> Self {
        Self {
            schema,
            doc: None,
            selection: None,
            stored_marks: None,
            plugins: Vec::new(),
            selection_registry: SelectionRegistry::default(),
        }
    }

    /// The same with `doc`.
    pub fn doc(mut self, doc: Node) -> Self {
        self.doc = Some(doc);
        self
    }

    /// The same with `selection`.
    pub fn selection(mut self, selection: Selection) -> Self {
        self.selection = Some(selection);
        self
    }

    /// The same with `plugins`.
    pub fn plugins(mut self, plugins: Vec<Plugin>) -> Self {
        self.plugins = plugins;
        self
    }
}

#[derive(Clone)]
struct Inner {
    schema: Schema,
    doc: Node,
    selection: Selection,
    stored_marks: Option<Vec<Mark>>,
    plugins: Vec<Plugin>,
    plugin_index: HashMap<PluginKey, usize>,
    plugin_states: Vec<Option<PluginState>>,
    revision: u64,
    scroll_to_selection: u64,
}

/// An editor's state: its document, selection, stored marks and plugins'
/// states. Immutable and cheap to clone; transactions make new ones.
#[derive(Clone)]
pub struct EditorState(Arc<Inner>);

impl fmt::Debug for EditorState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("EditorState")
            .field("doc", &self.0.doc)
            .field("selection", &self.0.selection)
            .field("stored_marks", &self.0.stored_marks)
            .field("revision", &self.0.revision)
            .finish_non_exhaustive()
    }
}

fn index_plugins(plugins: &[Plugin]) -> Result<HashMap<PluginKey, usize>, StateError> {
    let mut index = HashMap::with_capacity(plugins.len());
    for (i, plugin) in plugins.iter().enumerate() {
        let key = plugin.key();
        if index.contains_key(&key) {
            return Err(StateError::DuplicatePluginKey(key.name().to_owned()));
        }
        index.insert(key, i);
    }
    Ok(index)
}

fn check(doc: &Node) -> Result<(), StateError> {
    doc.check()
        .map_err(|error| StateError::Invalid(error.to_string()))
}

impl EditorState {
    /// A new state from `config`. Fails on two plugins with one key or a
    /// document the schema does not allow.
    pub fn create(config: EditorStateConfig) -> Result<EditorState, StateError> {
        let plugin_index = index_plugins(&config.plugins)?;
        let doc = match &config.doc {
            Some(doc) => doc.clone(),
            None => config
                .schema
                .top_node_type()
                .create_and_fill(Default::default(), Fragment::empty(), Vec::new())
                .ok_or_else(|| StateError::Invalid("the top node cannot be filled".into()))?,
        };
        check(&doc)?;
        let selection = config
            .selection
            .clone()
            .unwrap_or_else(|| Selection::at_start(&doc));
        let mut state = EditorState(Arc::new(Inner {
            schema: config.schema.clone(),
            doc,
            selection,
            stored_marks: config.stored_marks.clone(),
            plugins: config.plugins.clone(),
            plugin_index,
            plugin_states: vec![None; config.plugins.len()],
            revision: 0,
            scroll_to_selection: 0,
        }));
        for (i, plugin) in config.plugins.iter().enumerate() {
            let value = plugin.init_state(&config, &state);
            Arc::make_mut(&mut state.0).plugin_states[i] = value;
        }
        Ok(state)
    }

    /// The schema.
    pub fn schema(&self) -> &Schema {
        &self.0.schema
    }

    /// The document.
    pub fn doc(&self) -> &Node {
        &self.0.doc
    }

    /// The selection.
    pub fn selection(&self) -> &Selection {
        &self.0.selection
    }

    /// The marks the next typed text gets, when set (only at a cursor).
    pub fn stored_marks(&self) -> Option<&[Mark]> {
        self.0.stored_marks.as_deref()
    }

    /// The plugins.
    pub fn plugins(&self) -> &[Plugin] {
        &self.0.plugins
    }

    /// The first answer of the plugins, in order, to `f` (ProseMirror's
    /// `someProp`): `state.some_prop(|p| p.editable(state))`.
    pub fn some_prop<T>(&self, f: impl FnMut(&Plugin) -> Option<T>) -> Option<T> {
        self.0.plugins.iter().find_map(f)
    }

    /// The state of the plugin with `key`.
    pub fn plugin_state(&self, key: &PluginKey) -> Option<PluginState> {
        let index = *self.0.plugin_index.get(key)?;
        self.0.plugin_states[index].clone()
    }

    /// How many transactions made this state since it was created.
    pub fn revision(&self) -> u64 {
        self.0.revision
    }

    /// Grows each time an applied transaction asked to scroll the
    /// selection into view.
    pub fn scroll_to_selection(&self) -> u64 {
        self.0.scroll_to_selection
    }

    /// A transaction starting from this state.
    pub fn tr(&self) -> Transaction {
        Transaction::new(
            self.0.doc.clone(),
            self.0.schema.clone(),
            self.0.selection.clone(),
            self.0.stored_marks.clone(),
            self.0.revision,
        )
    }

    /// The state after `tr` and the transactions plugins appended to it.
    pub fn apply(&self, tr: Transaction) -> Result<EditorState, StateError> {
        self.apply_transaction(tr).map(|(state, _)| state)
    }

    /// The state after `tr`, and the transactions applied: none when a
    /// plugin's filter dropped `tr`, else `tr` followed by those plugins
    /// appended. Each round asks every plugin, in order, for a transaction
    /// to append after those it has not seen yet, until a round appends
    /// none. Fails, applying nothing, on a document the schema does not
    /// allow or after [`MAX_APPEND_ROUNDS`] rounds.
    pub fn apply_transaction(
        &self,
        root: Transaction,
    ) -> Result<(EditorState, Vec<Transaction>), StateError> {
        if !self.filter_transaction(&root, None) {
            return Ok((self.clone(), Vec::new()));
        }
        let mut new_state = self.apply_inner(&root)?;
        let mut trs = vec![root];
        // Per plugin: the state it last saw and how many transactions.
        let mut seen: Option<Vec<(EditorState, usize)>> = None;
        let plugins = self.0.plugins.clone();
        for _ in 0..MAX_APPEND_ROUNDS {
            let mut have_new = false;
            for (i, plugin) in plugins.iter().enumerate() {
                let (old, n) = match &seen {
                    Some(seen) => (seen[i].0.clone(), seen[i].1),
                    None => (self.clone(), 0),
                };
                if n < trs.len()
                    && let Some(mut tr) = plugin.append_transaction(&trs[n..], &old, &new_state)
                    && new_state.filter_transaction(&tr, Some(i))
                {
                    tr.set_meta(APPENDED_TRANSACTION, Value::Bool(true));
                    let seen = seen.get_or_insert_with(|| {
                        (0..plugins.len())
                            .map(|j| {
                                if j < i {
                                    (new_state.clone(), trs.len())
                                } else {
                                    (self.clone(), 0)
                                }
                            })
                            .collect()
                    });
                    new_state = new_state.apply_inner(&tr)?;
                    trs.push(tr);
                    have_new = true;
                    seen[i] = (new_state.clone(), trs.len());
                } else if let Some(seen) = &mut seen {
                    seen[i] = (new_state.clone(), trs.len());
                }
            }
            if !have_new {
                return Ok((new_state, trs));
            }
        }
        Err(StateError::AppendLoop)
    }

    fn filter_transaction(&self, tr: &Transaction, ignore: Option<usize>) -> bool {
        self.0
            .plugins
            .iter()
            .enumerate()
            .all(|(i, plugin)| Some(i) == ignore || plugin.filter_transaction(tr, self))
    }

    fn apply_inner(&self, tr: &Transaction) -> Result<EditorState, StateError> {
        // The revision tells the common case apart cheaply; a transaction
        // of another state with the same document is accepted too.
        if tr.base_revision != self.0.revision && tr.before() != &self.0.doc {
            return Err(StateError::MismatchedTransaction);
        }
        if tr.doc_changed() {
            check(tr.doc())?;
        }
        let selection = tr.selection();
        let stored_marks = if selection.cursor().is_some() {
            tr.stored_marks().map(<[Mark]>::to_vec)
        } else {
            None
        };
        let mut state = EditorState(Arc::new(Inner {
            schema: self.0.schema.clone(),
            doc: tr.doc().clone(),
            selection,
            stored_marks,
            plugins: self.0.plugins.clone(),
            plugin_index: self.0.plugin_index.clone(),
            plugin_states: vec![None; self.0.plugins.len()],
            revision: self.0.revision + 1,
            scroll_to_selection: self.0.scroll_to_selection + u64::from(tr.scrolled_into_view()),
        }));
        for (i, plugin) in self.0.plugins.iter().enumerate() {
            if let Some(value) = &self.0.plugin_states[i] {
                let value = plugin.apply_state(tr, value, self, &state);
                Arc::make_mut(&mut state.0).plugin_states[i] = Some(value);
            }
        }
        Ok(state)
    }

    /// The same document, selection and stored marks with `plugins`:
    /// plugins kept (by key) keep their state, new ones start theirs.
    pub fn reconfigure(&self, plugins: Vec<Plugin>) -> Result<EditorState, StateError> {
        let plugin_index = index_plugins(&plugins)?;
        let config = EditorStateConfig {
            schema: self.0.schema.clone(),
            doc: Some(self.0.doc.clone()),
            selection: Some(self.0.selection.clone()),
            stored_marks: self.0.stored_marks.clone(),
            plugins: plugins.clone(),
            selection_registry: SelectionRegistry::default(),
        };
        let mut state = EditorState(Arc::new(Inner {
            plugin_states: vec![None; plugins.len()],
            plugins: plugins.clone(),
            plugin_index,
            ..(*self.0).clone()
        }));
        for (i, plugin) in plugins.iter().enumerate() {
            let key = plugin.key();
            let value = match self.0.plugin_index.get(&key) {
                Some(_) => self.plugin_state(&key),
                None => plugin.init_state(&config, &state),
            };
            Arc::make_mut(&mut state.0).plugin_states[i] = value;
        }
        Ok(state)
    }

    /// Its JSON form: `doc`, `selection`, `storedMarks` when set, and each
    /// plugin's state that has one ([`PluginSpec::state_to_json`]) under
    /// its key.
    ///
    /// [`PluginSpec::state_to_json`]: super::PluginSpec::state_to_json
    pub fn to_json(&self) -> Value {
        let mut map = Map::new();
        map.insert("doc".into(), self.0.doc.to_json());
        map.insert("selection".into(), self.0.selection.to_json());
        if let Some(marks) = &self.0.stored_marks {
            map.insert(
                "storedMarks".into(),
                Value::Array(marks.iter().map(Mark::to_json).collect()),
            );
        }
        for (i, plugin) in self.0.plugins.iter().enumerate() {
            let key = plugin.key();
            if matches!(key.name(), "doc" | "selection" | "storedMarks") {
                continue;
            }
            if let Some(value) = self.0.plugin_states[i]
                .as_ref()
                .and_then(|value| plugin.state_to_json(value))
            {
                map.insert(key.name().to_owned(), value);
            }
        }
        Value::Object(map)
    }

    /// A state read from its JSON form with `config`'s schema and plugins
    /// (its `doc` and `selection` are ignored). Plugins whose key has a
    /// value read it back; the others start their state.
    pub fn from_json(config: EditorStateConfig, json: &Value) -> Result<EditorState, StateError> {
        let schema = config.schema.clone();
        let doc = json
            .get("doc")
            .ok_or_else(|| StateError::Json("no `doc`".into()))?;
        let doc =
            Node::from_json(&schema, doc).map_err(|error| StateError::Json(error.to_string()))?;
        let selection = match json.get("selection") {
            Some(selection) => config.selection_registry.from_json(&doc, selection)?,
            None => Selection::at_start(&doc),
        };
        let stored_marks = match json.get("storedMarks") {
            Some(Value::Array(marks)) => Some(
                marks
                    .iter()
                    .map(|mark| {
                        Mark::from_json(&schema, mark)
                            .map_err(|error| StateError::Json(error.to_string()))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            _ => None,
        };
        let plugins = config.plugins.clone();
        let config = EditorStateConfig {
            doc: Some(doc),
            selection: Some(selection),
            stored_marks,
            ..config
        };
        let mut state = EditorState::create(EditorStateConfig {
            plugins: Vec::new(),
            ..config.clone()
        })?;
        let inner = Arc::make_mut(&mut state.0);
        inner.plugin_index = index_plugins(&plugins)?;
        inner.plugin_states = vec![None; plugins.len()];
        inner.plugins = plugins.clone();
        for (i, plugin) in plugins.iter().enumerate() {
            let value = match json.get(plugin.key().name()) {
                Some(value) => plugin.state_from_json(&config, value, &state),
                None => plugin.init_state(&config, &state),
            };
            Arc::make_mut(&mut state.0).plugin_states[i] = value;
        }
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;

    use super::*;
    use crate::rich_editor::{
        state::{PluginSpec, TextSelection, test_util::*},
        transform::AttrStep,
    };

    /// Counts the transactions applied; its state is a `u64`.
    struct Counter(&'static str);

    impl PluginSpec for Counter {
        fn key(&self) -> PluginKey {
            PluginKey::new(self.0)
        }

        fn init_state(&self, _: &EditorStateConfig, _: &EditorState) -> Option<PluginState> {
            Some(Arc::new(0_u64))
        }

        fn apply_state(
            &self,
            _: &Transaction,
            value: &PluginState,
            _: &EditorState,
            _: &EditorState,
        ) -> PluginState {
            Arc::new(value.downcast_ref::<u64>().unwrap() + 1)
        }

        fn state_to_json(&self, value: &PluginState) -> Option<Value> {
            Some(json!(*value.downcast_ref::<u64>().unwrap()))
        }

        fn state_from_json(
            &self,
            _: &EditorStateConfig,
            json: &Value,
            _: &EditorState,
        ) -> Option<PluginState> {
            Some(Arc::new(json.as_u64().unwrap()))
        }
    }

    struct RejectAll;

    impl PluginSpec for RejectAll {
        fn filter_transaction(&self, _: &Transaction, _: &EditorState) -> bool {
            false
        }
    }

    /// Appends a transaction typing its name at the start after any
    /// transaction no plugin appended (after every one when `forever`);
    /// logs its calls.
    struct Appender {
        name: &'static str,
        log: Arc<Mutex<Vec<String>>>,
        forever: bool,
    }

    impl PluginSpec for Appender {
        fn key(&self) -> PluginKey {
            PluginKey::new(self.name)
        }

        fn append_transaction(
            &self,
            trs: &[Transaction],
            _: &EditorState,
            new: &EditorState,
        ) -> Option<Transaction> {
            self.log
                .lock()
                .unwrap()
                .push(format!("{}:{}", self.name, trs.len()));
            if trs.iter().all(Transaction::is_appended) && !self.forever {
                return None;
            }
            let mut tr = new.tr();
            tr.insert_text(self.name, Some(1), None);
            tr.set_meta(self.name, json!(true));
            Some(tr)
        }
    }

    #[test]
    fn plugin_state_inits_and_applies() {
        let s = schema();
        let state = state(
            &s,
            doc(&s, vec![p(&s, "")]),
            vec![Arc::new(Counter("count"))],
        );
        let key = PluginKey::new("count");
        assert_eq!(key.get_state::<u64>(&state).as_deref(), Some(&0));
        let state = state.apply(state.tr()).unwrap();
        let state = state.apply(state.tr()).unwrap();
        assert_eq!(key.get_state::<u64>(&state).as_deref(), Some(&2));
        assert_eq!(state.revision(), 2);
    }

    #[test]
    fn a_filter_drops_the_transaction() {
        let s = schema();
        let state = state(&s, doc(&s, vec![p(&s, "")]), vec![Arc::new(RejectAll)]);
        let mut tr = state.tr();
        tr.insert_text("x", Some(1), None);
        let (next, trs) = state.apply_transaction(tr).unwrap();
        assert!(trs.is_empty());
        assert_eq!(next.revision(), 0);
        assert_eq!(next.doc().text_content(), "");
    }

    #[test]
    fn appended_transactions_run_in_plugin_order() {
        let s = schema();
        let log = Arc::new(Mutex::new(Vec::new()));
        let plugins: Vec<Plugin> = vec![
            Arc::new(Appender {
                name: "a",
                log: log.clone(),
                forever: false,
            }),
            Arc::new(Appender {
                name: "b",
                log: log.clone(),
                forever: false,
            }),
        ];
        let state = state(&s, doc(&s, vec![p(&s, "")]), plugins);
        let mut tr = state.tr();
        tr.insert_text("x", Some(1), None);
        let (next, trs) = state.apply_transaction(tr).unwrap();
        // Round 1: a sees the root and appends; b sees both and appends.
        // Round 2: a sees only b's, an appended one, and stops; b has seen all.
        assert!(!trs[0].is_appended());
        assert!(trs[1..].iter().all(Transaction::is_appended));
        assert_eq!(trs[1].get_meta("a"), Some(&json!(true)));
        assert_eq!(trs[2].get_meta("b"), Some(&json!(true)));
        let log = log.lock().unwrap().clone();
        assert_eq!(log, ["a:1", "b:2", "a:1"]);
        assert_eq!(trs.len(), 3);
        assert_eq!(next.revision(), trs.len() as u64);
        assert_eq!(next.doc().text_content(), "bax");
    }

    #[test]
    fn endless_appending_is_an_error() {
        let s = schema();
        let log = Arc::new(Mutex::new(Vec::new()));
        // A plugin never sees its own appended transactions: two that
        // answer each other loop.
        let plugins: Vec<Plugin> = vec![
            Arc::new(Appender {
                name: "a",
                log: log.clone(),
                forever: true,
            }),
            Arc::new(Appender {
                name: "b",
                log,
                forever: true,
            }),
        ];
        let state = state(&s, doc(&s, vec![p(&s, "")]), plugins);
        assert_eq!(
            state.apply_transaction(state.tr()).unwrap_err(),
            StateError::AppendLoop
        );
    }

    #[test]
    fn an_invalid_document_is_rejected_whole() {
        let s = schema();
        let heading = node(&s, "heading", vec![]);
        let state = state(&s, doc(&s, vec![heading, p(&s, "")]), vec![]);
        let mut tr = state.tr();
        tr.insert_text("ok", Some(3), None);
        tr.step(Box::new(AttrStep::new(0, "level", json!("not a number"))))
            .unwrap();
        let error = state.apply(tr).unwrap_err();
        assert!(matches!(error, StateError::Invalid(_)));
        assert_eq!(state.doc().text_content(), "");
        assert_eq!(state.revision(), 0);
    }

    #[test]
    fn duplicate_keys_are_an_error_and_reconfigure_keeps_states() {
        let s = schema();
        let d = doc(&s, vec![p(&s, "")]);
        let config = EditorStateConfig::new(s.clone())
            .doc(d.clone())
            .plugins(vec![Arc::new(Counter("c")), Arc::new(Counter("c"))]);
        assert_eq!(
            EditorState::create(config).unwrap_err(),
            StateError::DuplicatePluginKey("c".into())
        );
        let state = state(&s, d, vec![Arc::new(Counter("c"))]);
        let state = state.apply(state.tr()).unwrap();
        let state = state
            .reconfigure(vec![Arc::new(Counter("c")), Arc::new(Counter("d"))])
            .unwrap();
        assert_eq!(
            PluginKey::new("c").get_state::<u64>(&state).as_deref(),
            Some(&1)
        );
        assert_eq!(
            PluginKey::new("d").get_state::<u64>(&state).as_deref(),
            Some(&0)
        );
    }

    #[test]
    fn json_round_trips() {
        let s = schema();
        let state = state(
            &s,
            doc(&s, vec![p(&s, "hello")]),
            vec![Arc::new(Counter("count"))],
        );
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(tr.doc(), 2, Some(4)));
        let state = state.apply(tr).unwrap();
        let json = state.to_json();
        assert_eq!(
            json["selection"],
            json!({"type": "text", "anchor": 2, "head": 4})
        );
        assert_eq!(json["count"], json!(1));
        let config = EditorStateConfig::new(s.clone()).plugins(vec![Arc::new(Counter("count"))]);
        let back = EditorState::from_json(config, &json).unwrap();
        assert_eq!(back.doc(), state.doc());
        assert!(back.selection().eq(state.selection()));
        assert_eq!(
            PluginKey::new("count").get_state::<u64>(&back).as_deref(),
            Some(&1)
        );
    }

    #[test]
    fn stored_marks_survive_only_at_a_cursor() {
        let s = schema();
        let state = state(&s, doc(&s, vec![p(&s, "ab")]), vec![]);
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(tr.doc(), 2, None));
        tr.set_stored_marks(Some(vec![s.mark("em", None).unwrap()]));
        let next = state.apply(tr).unwrap();
        assert_eq!(next.stored_marks().map(<[Mark]>::len), Some(1));
        let mut tr = next.tr();
        tr.set_selection(TextSelection::create(tr.doc(), 1, Some(3)));
        assert_eq!(next.apply(tr).unwrap().stored_marks(), None);
    }
}

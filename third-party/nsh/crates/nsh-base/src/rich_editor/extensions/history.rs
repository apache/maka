//! Undo and redo, a port of `prosemirror-history`.
//!
//! The history keeps two branches, done and undone, of inverted steps
//! with their maps. Changes the user makes in quick succession and next to
//! each other form one event (group); changes that are not undoable
//! (remote ones, those with meta [`ADD_TO_HISTORY`] `false`) are kept as
//! maps only, so the inverted steps before them are mapped over them
//! when undone. A collaboration plugin rebases with meta `"rebased"` (the
//! number of steps it rebased), as in ProseMirror.

use std::sync::Arc;

use serde_json::Value;

use crate::rich_editor::{
    commands::Dispatch,
    state::{
        ADD_TO_HISTORY, EditorState, EditorStateConfig, Plugin, PluginKey, PluginSpec, PluginState,
        SelectionBookmark, Transaction, TransactionOrigin,
    },
    transform::{BoxStep, Mapping, StepMap, Transform},
};

// How many events past the depth the done branch may hold before the
// oldest are dropped (dropping one at a time would copy the branch each
// time).
const DEPTH_OVERFLOW: usize = 20;

// How many map-only items a branch keeps before it is compressed.
const MAX_EMPTY_ITEMS: usize = 500;

const HISTORY_META: &str = "history$";
const CLOSE_HISTORY_META: &str = "closeHistory$";

/// The key of the history plugin's state.
pub fn history_key() -> PluginKey {
    PluginKey::new("history$")
}

/// How the history groups and how much it keeps, after
/// `prosemirror-history`'s options.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct HistoryOptions {
    /// The most events (undo steps) kept (default 100).
    pub depth: usize,
    /// Changes further apart than this (milliseconds) start a new event
    /// (default 500).
    pub new_group_delay_ms: u64,
}

impl Default for HistoryOptions {
    fn default() -> Self {
        Self {
            depth: 100,
            new_group_delay_ms: 500,
        }
    }
}

// One entry of a branch: a step's map, and the inverted step when it is
// undoable. An entry with a selection starts an event (the selection
// before it).
#[derive(Debug, Clone)]
struct Item {
    map: StepMap,
    step: Option<BoxStep>,
    selection: Option<SelectionBookmark>,
    // For a map added while undoing: how many items back its mirror is.
    mirror_offset: Option<usize>,
}

impl Item {
    fn map_only(map: StepMap) -> Self {
        Self {
            map,
            step: None,
            selection: None,
            mirror_offset: None,
        }
    }

    // `other` (later) merged into this one, when their steps merge and
    // `other` starts no event.
    fn merge(&self, other: &Item) -> Option<Item> {
        let (Some(step), Some(other_step)) = (&self.step, &other.step) else {
            return None;
        };
        if other.selection.is_some() {
            return None;
        }
        let merged = other_step.merge(step.as_ref())?;
        Some(Item {
            map: merged.get_map().invert(),
            step: Some(merged),
            selection: self.selection.clone(),
            mirror_offset: None,
        })
    }
}

// A branch of the history: its items, shared so that states share them.
#[derive(Debug, Clone, Default)]
struct Branch {
    items: Vec<Arc<Item>>,
    event_count: usize,
}

struct Popped {
    remaining: Branch,
    tr: Transaction,
    selection: SelectionBookmark,
}

impl Branch {
    // Undoes the last event on `state`: the transaction, the branch
    // without the event and the selection before it.
    fn pop_event(&self, state: &EditorState, preserve_items: bool) -> Option<Popped> {
        if self.event_count == 0 {
            return None;
        }
        let end = self
            .items
            .iter()
            .rposition(|item| item.selection.is_some())?;
        let mut remap: Option<Mapping> = None;
        let mut map_from = 0usize;
        if preserve_items {
            let mapping = self.remapping(end, self.items.len());
            map_from = mapping.maps.len();
            remap = Some(mapping);
        }
        let mut tr = state.tr();
        let mut add_after: Vec<Arc<Item>> = Vec::new();
        let mut add_before: Vec<Arc<Item>> = Vec::new();
        for i in (0..self.items.len()).rev() {
            let item = &self.items[i];
            let Some(step) = &item.step else {
                if remap.is_none() {
                    let mapping = self.remapping(end, i + 1);
                    map_from = mapping.maps.len();
                    remap = Some(mapping);
                }
                map_from = map_from.saturating_sub(1);
                add_before.push(item.clone());
                continue;
            };
            if let Some(mapping) = &mut remap {
                add_before.push(Arc::new(Item::map_only(item.map.clone())));
                let mut new_map = None;
                if let Some(mapped) = step.map(&mapping.slice_from(map_from))
                    && tr.step(mapped).is_ok()
                {
                    let map = tr
                        .mapping
                        .maps
                        .last()
                        .cloned()
                        .unwrap_or_else(StepMap::empty);
                    add_after.push(Arc::new(Item {
                        mirror_offset: Some(add_after.len() + add_before.len()),
                        ..Item::map_only(map.clone())
                    }));
                    new_map = Some(map);
                }
                map_from = map_from.saturating_sub(1);
                if let Some(map) = new_map {
                    mapping.append_map(map, Some(map_from));
                }
            } else {
                let _ = tr.step(step.clone());
            }
            if let Some(selection) = &item.selection {
                let selection = match &remap {
                    Some(mapping) => selection.map(&mapping.slice_from(map_from)),
                    None => selection.clone(),
                };
                let mut items = self.items[..end].to_vec();
                items.extend(add_before.into_iter().rev());
                items.extend(add_after);
                let remaining = Branch {
                    items,
                    event_count: self.event_count - 1,
                };
                return Some(Popped {
                    remaining,
                    tr,
                    selection,
                });
            }
        }
        None
    }

    // The branch with the inverted steps of `transform` added; a selection
    // starts a new event.
    fn add_transform(
        &self,
        transform: &Transform,
        mut selection: Option<SelectionBookmark>,
        options: &HistoryOptions,
        preserve_items: bool,
    ) -> Branch {
        let mut new_items: Vec<Arc<Item>> = Vec::new();
        let mut event_count = self.event_count;
        let mut old_items = self.items.clone();
        let mut last_item = if preserve_items {
            None
        } else {
            old_items.last().cloned()
        };
        for (i, step) in transform.steps.iter().enumerate() {
            let inverted = step.invert(&transform.docs[i]);
            let mut item = Arc::new(Item {
                map: transform.mapping.maps[i].clone(),
                step: Some(inverted),
                selection: selection.clone(),
                mirror_offset: None,
            });
            if let Some(merged) = last_item.as_ref().and_then(|last| last.merge(&item)) {
                item = Arc::new(merged);
                if i > 0 {
                    new_items.pop();
                } else {
                    old_items.pop();
                }
            }
            new_items.push(item.clone());
            if selection.take().is_some() {
                event_count += 1;
            }
            if !preserve_items {
                last_item = Some(item);
            }
        }
        let overflow = event_count.saturating_sub(options.depth);
        if overflow > DEPTH_OVERFLOW {
            old_items = cut_off_events(&old_items, overflow);
            event_count -= overflow;
        }
        old_items.extend(new_items);
        Branch {
            items: old_items,
            event_count,
        }
    }

    // The maps of the items from..to, with their mirrors.
    fn remapping(&self, from: usize, to: usize) -> Mapping {
        let mut maps = Mapping::new();
        for i in from..to {
            let item = &self.items[i];
            let mirror = item
                .mirror_offset
                .filter(|&offset| i >= offset && i - offset >= from)
                .map(|offset| maps.maps.len() - offset);
            maps.append_map(item.map.clone(), mirror);
        }
        maps
    }

    fn add_maps(&self, maps: &[StepMap]) -> Branch {
        if self.event_count == 0 {
            return self.clone();
        }
        let mut items = self.items.clone();
        items.extend(maps.iter().map(|map| Arc::new(Item::map_only(map.clone()))));
        Branch {
            items,
            event_count: self.event_count,
        }
    }

    // The branch after a collaboration plugin rebased the last
    // `rebased_count` steps (now mirrored in `transform`'s mapping).
    fn rebased(&self, transform: &Transform, rebased_count: usize) -> Branch {
        if self.event_count == 0 {
            return self.clone();
        }
        let mut rebased_items = Vec::new();
        let start = self.items.len().saturating_sub(rebased_count);
        let mapping = &transform.mapping;
        let mut new_until = transform.steps.len();
        let mut event_count = self.event_count;
        event_count -= self.items[start..]
            .iter()
            .filter(|item| item.selection.is_some())
            .count();
        let mut i_rebased = rebased_count;
        for item in &self.items[start..] {
            i_rebased -= 1;
            let Some(pos) = mapping.get_mirror(i_rebased) else {
                continue;
            };
            new_until = new_until.min(pos);
            let map = mapping.maps[pos].clone();
            if item.step.is_some() {
                let step = transform.steps[pos].invert(&transform.docs[pos]);
                let selection = item
                    .selection
                    .as_ref()
                    .map(|selection| selection.map(&mapping.slice(i_rebased + 1, pos)));
                if selection.is_some() {
                    event_count += 1;
                }
                rebased_items.push(Arc::new(Item {
                    map,
                    step: Some(step),
                    selection,
                    mirror_offset: None,
                }));
            } else {
                rebased_items.push(Arc::new(Item::map_only(map)));
            }
        }
        let mut items = self.items[..start].to_vec();
        for i in rebased_count..new_until {
            items.push(Arc::new(Item::map_only(mapping.maps[i].clone())));
        }
        let rebased_len = rebased_items.len();
        items.extend(rebased_items);
        let branch = Branch { items, event_count };
        if branch.empty_item_count() > MAX_EMPTY_ITEMS {
            branch.compress(self.items.len() - rebased_len)
        } else {
            branch
        }
    }

    fn empty_item_count(&self) -> usize {
        self.items.iter().filter(|item| item.step.is_none()).count()
    }

    // Maps the steps before `upto` over the map-only items after them and
    // drops those items.
    fn compress(&self, upto: usize) -> Branch {
        let mut remap = self.remapping(0, upto);
        let mut map_from = remap.maps.len();
        let mut items: Vec<Arc<Item>> = Vec::new();
        let mut events = 0;
        for i in (0..self.items.len()).rev() {
            let item = &self.items[i];
            if i >= upto {
                items.push(item.clone());
                if item.selection.is_some() {
                    events += 1;
                }
            } else if let Some(step) = &item.step {
                let mapped = step.map(&remap.slice_from(map_from));
                let map = mapped.as_ref().map(|step| step.get_map());
                map_from = map_from.saturating_sub(1);
                if let Some(map) = &map {
                    remap.append_map(map.clone(), Some(map_from));
                }
                if let (Some(step), Some(map)) = (mapped, map) {
                    let selection = item
                        .selection
                        .as_ref()
                        .map(|selection| selection.map(&remap.slice_from(map_from)));
                    if selection.is_some() {
                        events += 1;
                    }
                    let new_item = Item {
                        map: map.invert(),
                        step: Some(step),
                        selection,
                        mirror_offset: None,
                    };
                    match items.last().and_then(|last| last.merge(&new_item)) {
                        Some(merged) => *items.last_mut().unwrap() = Arc::new(merged),
                        None => items.push(Arc::new(new_item)),
                    }
                }
            } else {
                map_from = map_from.saturating_sub(1);
            }
        }
        items.reverse();
        Branch {
            items,
            event_count: events,
        }
    }
}

// The items from the `n`th event on.
fn cut_off_events(items: &[Arc<Item>], mut n: usize) -> Vec<Arc<Item>> {
    let mut cut = 0;
    for (i, item) in items.iter().enumerate() {
        if item.selection.is_some() {
            if n == 0 {
                cut = i;
                break;
            }
            n -= 1;
        }
    }
    items[cut..].to_vec()
}

/// The history plugin's state: the done and undone branches and what
/// decides whether the next change starts a new event.
#[derive(Debug, Clone, Default)]
pub struct HistoryState {
    done: Branch,
    undone: Branch,
    // The ranges the last change touched, to tell whether the next is
    // adjacent.
    prev_ranges: Option<Vec<usize>>,
    prev_time: u64,
    prev_composition: Option<i64>,
    // After an undo (false) or redo (true), until the next root
    // transaction: where its appended transactions go.
    after_history: Option<bool>,
    options: HistoryOptions,
}

impl HistoryState {
    /// The number of events that can be undone.
    pub fn undo_depth(&self) -> usize {
        self.done.event_count
    }

    /// The number of events that can be redone.
    pub fn redo_depth(&self) -> usize {
        self.undone.event_count
    }
}

// What an undo or redo transaction carries for the plugin's state.
struct HistoryMeta {
    redo: bool,
    state: HistoryState,
}

fn apply_transaction(history: &HistoryState, old: &EditorState, tr: &Transaction) -> HistoryState {
    if let Some(meta) = tr.get_meta_any::<HistoryMeta>(HISTORY_META) {
        let mut state = meta.state.clone();
        state.after_history = Some(meta.redo);
        return state;
    }
    let mut history = history.clone();
    let appended = tr.is_appended();
    if !appended {
        history.after_history = None;
    }
    if tr.get_meta(CLOSE_HISTORY_META).is_some() {
        history.prev_ranges = None;
        history.prev_time = 0;
        history.prev_composition = None;
    }
    let options = history.options.clone();
    if tr.steps.is_empty() {
        return history;
    }
    if let (true, Some(redo)) = (appended, history.after_history) {
        // Transactions appended to an undo or redo belong to it.
        if redo {
            history.done = history.done.add_transform(tr, None, &options, false);
            history.prev_ranges = Some(ranges_for(&tr.mapping.maps));
        } else {
            history.undone = history.undone.add_transform(tr, None, &options, false);
            history.prev_ranges = None;
        }
        return history;
    }
    if tr.add_to_history() {
        let composition = tr.get_meta("composition").and_then(Value::as_i64);
        let new_group = history.prev_time == 0
            || (!appended
                // A change outside a composition never matches the last
                // one (ProseMirror's -1), so only IME input stays grouped.
                && (composition.is_none() || history.prev_composition != composition)
                && (history.prev_time + options.new_group_delay_ms < tr.time
                    || !is_adjacent_to(tr, history.prev_ranges.as_deref())));
        let prev_ranges = if appended {
            map_ranges(history.prev_ranges.as_deref(), &tr.mapping)
        } else {
            Some(ranges_for(&tr.mapping.maps))
        };
        let selection = new_group.then(|| old.selection().get_bookmark());
        history.done = history.done.add_transform(tr, selection, &options, false);
        history.undone = Branch::default();
        history.prev_ranges = prev_ranges;
        history.prev_time = tr.time;
        if composition.is_some() {
            history.prev_composition = composition;
        }
        return history;
    }
    if let Some(rebased) = tr.get_meta("rebased").and_then(Value::as_u64) {
        history.done = history.done.rebased(tr, rebased as usize);
        history.undone = history.undone.rebased(tr, rebased as usize);
    } else {
        history.done = history.done.add_maps(&tr.mapping.maps);
        history.undone = history.undone.add_maps(&tr.mapping.maps);
    }
    history.prev_ranges = map_ranges(history.prev_ranges.as_deref(), &tr.mapping);
    history
}

fn is_adjacent_to(tr: &Transaction, prev_ranges: Option<&[usize]>) -> bool {
    let Some(prev_ranges) = prev_ranges else {
        return false;
    };
    if !tr.doc_changed() {
        return true;
    }
    let mut adjacent = false;
    if let Some(map) = tr.mapping.maps.first() {
        map.for_each(|start, end, _, _| {
            for pair in prev_ranges.chunks(2) {
                if start <= pair[1] && end >= pair[0] {
                    adjacent = true;
                }
            }
        });
    }
    adjacent
}

// The ranges the last map that changed something touched.
fn ranges_for(maps: &[StepMap]) -> Vec<usize> {
    let mut result = Vec::new();
    for map in maps.iter().rev() {
        if !result.is_empty() {
            break;
        }
        map.for_each(|_, _, from, to| {
            result.push(from);
            result.push(to);
        });
    }
    result
}

fn map_ranges(ranges: Option<&[usize]>, mapping: &Mapping) -> Option<Vec<usize>> {
    let ranges = ranges?;
    let mut result = Vec::new();
    for pair in ranges.chunks(2) {
        let from = mapping.map(pair[0], 1);
        let to = mapping.map(pair[1], -1);
        if from <= to {
            result.push(from);
            result.push(to);
        }
    }
    Some(result)
}

struct History {
    options: HistoryOptions,
}

impl PluginSpec for History {
    fn key(&self) -> PluginKey {
        history_key()
    }

    fn init_state(&self, _: &EditorStateConfig, _: &EditorState) -> Option<PluginState> {
        Some(Arc::new(HistoryState {
            options: self.options.clone(),
            ..Default::default()
        }))
    }

    fn apply_state(
        &self,
        tr: &Transaction,
        value: &PluginState,
        old: &EditorState,
        _: &EditorState,
    ) -> PluginState {
        match value.downcast_ref::<HistoryState>() {
            Some(history) => Arc::new(apply_transaction(history, old, tr)),
            None => value.clone(),
        }
    }
}

/// The history plugin: tracks changes for [`undo`] and [`redo`].
pub fn history(options: HistoryOptions) -> Plugin {
    Arc::new(History { options })
}

/// The history's state in `state`, when it has the history plugin.
pub fn history_state(state: &EditorState) -> Option<Arc<HistoryState>> {
    history_key().get_state::<HistoryState>(state)
}

/// Ends the current event: the next change starts a new one, however soon
/// and near it comes.
pub fn close_history(tr: &mut Transaction) -> &mut Transaction {
    tr.set_meta(CLOSE_HISTORY_META, Value::Bool(true))
}

/// Whether `tr` is an undo or a redo.
pub fn is_history_transaction(tr: &Transaction) -> bool {
    tr.get_meta_any::<HistoryMeta>(HISTORY_META).is_some()
}

/// The number of events that can be undone (0 without the plugin).
pub fn undo_depth(state: &EditorState) -> usize {
    history_state(state).map_or(0, |history| history.undo_depth())
}

/// The number of events that can be redone (0 without the plugin).
pub fn redo_depth(state: &EditorState) -> usize {
    history_state(state).map_or(0, |history| history.redo_depth())
}

fn hist_transaction(
    history: &HistoryState,
    state: &EditorState,
    redo: bool,
) -> Option<Transaction> {
    let branch = if redo { &history.undone } else { &history.done };
    let popped = branch.pop_event(state, false)?;
    let selection = popped.selection.resolve(popped.tr.doc());
    let other = if redo { &history.done } else { &history.undone };
    let added = other.add_transform(
        &popped.tr,
        Some(state.selection().get_bookmark()),
        &history.options,
        false,
    );
    let (done, undone) = if redo {
        (added, popped.remaining)
    } else {
        (popped.remaining, added)
    };
    let new_state = HistoryState {
        done,
        undone,
        prev_ranges: None,
        prev_time: 0,
        prev_composition: None,
        after_history: None,
        options: history.options.clone(),
    };
    let mut tr = popped.tr;
    tr.set_selection(selection);
    tr.set_meta_any(
        HISTORY_META,
        Arc::new(HistoryMeta {
            redo,
            state: new_state,
        }),
    );
    tr.set_origin(TransactionOrigin::History);
    tr.set_meta(ADD_TO_HISTORY, Value::Bool(false));
    Some(tr)
}

fn build_command(redo: bool, scroll: bool) -> impl Fn(&EditorState, Dispatch<'_>) -> bool {
    move |state, dispatch| {
        let Some(history) = history_state(state) else {
            return false;
        };
        let branch = if redo { &history.undone } else { &history.done };
        if branch.event_count == 0 {
            return false;
        }
        if let Some(dispatch) = dispatch {
            let Some(mut tr) = hist_transaction(&history, state, redo) else {
                return false;
            };
            if scroll {
                tr.scroll_into_view();
            }
            dispatch(tr);
        }
        true
    }
}

/// Undoes the last event, scrolling the selection into view.
pub fn undo(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    build_command(false, true)(state, dispatch)
}

/// Redoes the last undone event, scrolling the selection into view.
pub fn redo(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    build_command(true, true)(state, dispatch)
}

/// [`undo`] without scrolling.
pub fn undo_no_scroll(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    build_command(false, false)(state, dispatch)
}

/// [`redo`] without scrolling.
pub fn redo_no_scroll(state: &EditorState, dispatch: Dispatch<'_>) -> bool {
    build_command(true, false)(state, dispatch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rich_editor::{extensions::starter, state::TextSelection};

    fn apply(state: &EditorState, tr: Transaction) -> EditorState {
        state.apply(tr).unwrap()
    }

    fn run(state: &EditorState, command: fn(&EditorState, Dispatch<'_>) -> bool) -> EditorState {
        let mut out = None;
        assert!(command(state, Some(&mut |tr| out = Some(tr))));
        apply(state, out.unwrap())
    }

    fn type_at(state: &EditorState, text: &str, time: u64) -> EditorState {
        let mut tr = state.tr();
        tr.insert_text(text, None, None);
        tr.set_time(time);
        apply(state, tr)
    }

    fn new_state() -> EditorState {
        let schema = starter::schema();
        let config =
            EditorStateConfig::new(schema).plugins(vec![history(HistoryOptions::default())]);
        EditorState::create(config).unwrap()
    }

    #[test]
    fn undo_and_redo_restore_docs_and_selection() {
        let start = new_state();
        let typed = type_at(&start, "abc", 1000);
        assert_eq!(typed.doc().text_content(), "abc");
        assert_eq!(undo_depth(&typed), 1);
        let undone = run(&typed, undo);
        assert!(undone.doc().eq(start.doc()));
        assert_eq!(undone.selection().head(), start.selection().head());
        assert_eq!(redo_depth(&undone), 1);
        let redone = run(&undone, redo);
        assert!(redone.doc().eq(typed.doc()));
        assert_eq!(redone.selection().head(), typed.selection().head());
        assert!(!undo(&start, None));
    }

    #[test]
    fn changes_group_by_delay_and_adjacency() {
        let start = new_state();
        let a = type_at(&start, "a", 1000);
        let ab = type_at(&a, "b", 1100);
        assert_eq!(undo_depth(&ab), 1, "quick adjacent typing is one event");
        let abc = type_at(&ab, "c", 5000);
        assert_eq!(undo_depth(&abc), 2, "a pause starts an event");
        let back = run(&abc, undo);
        assert_eq!(back.doc().text_content(), "ab");
        let mut tr = abc.tr();
        close_history(&mut tr);
        let closed = apply(&abc, tr);
        let abcd = type_at(&closed, "d", 5010);
        assert_eq!(undo_depth(&abcd), 3, "close_history starts an event");
    }

    #[test]
    fn non_history_changes_are_mapped_over() {
        let start = new_state();
        let typed = type_at(&start, "abc", 1000);
        let mut tr = typed.tr();
        tr.insert_text("X", Some(1), None);
        tr.set_add_to_history(false);
        let remote = apply(&typed, tr);
        assert_eq!(remote.doc().text_content(), "Xabc");
        let undone = run(&remote, undo);
        assert_eq!(undone.doc().text_content(), "X");
        let _ = TextSelection::create(undone.doc(), 1, None);
    }
}

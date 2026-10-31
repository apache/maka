//! The view's controller: the session it shows, the tree of rendered
//! blocks and their ids, the geometry, the revisions bindings subscribe to,
//! and what typing, keys, presses, drags, the clipboard and input methods
//! do: each becomes a transaction on the session, after the plugins' hooks
//! had their turn.

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    rc::Rc,
    sync::Arc,
    time::Duration,
};

use nsh_core::{
    keymap::{Modifiers, When},
    prelude::*,
};
use serde_json::Value;
use unicode_segmentation::UnicodeSegmentation;

use super::{
    RichEditorChange, RichEditorEvent, RichEditorFile, RichEditorPastedFiles, RichEditorProps,
    RichEditorSelection,
    geometry::{DOC, Geometry, Hit},
    geometry_handle::{LocalGeometry, register_geometry, retire_geometry},
    keys::{self, Move, Unit},
    node_view::{NodeView, NodeViewEvent},
    session::{EditorSession, NodeViews, ViewRequest},
    table::{TableGesture, TablePreview},
};
use crate::{
    editor::layout::{self, AutoScroll},
    rich_editor::{
        extensions::{HistoryOptions, Keymap, KeymapOptions, history, starter},
        formats::{DomParser, slice_from_text, slice_to_text},
        model::{Fragment, Mark, Node, SchemaSpec, Slice},
        state::{
            Affinity, ClickEvent, Decoration, EditorState, EditorStateConfig, GapCursor, KeyEvent,
            NodeSelection, Plugin, Selection, TextSelection, Transaction, TransactionOrigin,
        },
        tables::{CellSelection, is_table, table_role},
        transform::drop_point,
    },
};

/// The sink is emptied once it holds this many bytes (and no composition
/// is in progress).
const SINK_LIMIT: usize = 256;

/// How much nearer a drop place that takes a block as it is counts than
/// one that takes it wrapped, between blocks.
const DIRECT_SLACK: f32 = 6.0;
/// How many half-line steps a caret moving up or down probes past a gap
/// between blocks before it takes the document's edge.
const GAP_PROBES: usize = 64;

/// A rendered block: its id (kept while the block is the same block across
/// changes), its node and where it starts.
#[derive(Clone, Debug)]
pub(crate) struct BlockItem {
    pub(crate) id: u64,
    pub(crate) node: Node,
    /// The position before the node.
    pub(crate) pos: usize,
    /// The id of the box its frame is measured in.
    pub(crate) parent: u64,
}

impl PartialEq for BlockItem {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
            && self.pos == other.pos
            && self.parent == other.parent
            && self.node.ptr_eq(&other.node)
    }
}

/// The blocks' ids: the children of each rendered container.
#[derive(Default)]
pub(crate) struct Tree {
    pub(crate) children: HashMap<u64, Vec<BlockItem>>,
    next: u64,
}

/// The id of the slot a node view with an editable content slot renders
/// its content in (a box measured in the content box).
pub(crate) fn slot_id(id: u64) -> u64 {
    id | (1 << 62)
}

/// The content's offset from the page (content less page) and the scroll
/// offset it was noted at.
pub(super) type PageOffset = (Point<Points>, Points);

/// A press being dragged.
#[derive(Debug, Clone)]
struct Drag {
    /// The selection's anchor.
    anchor: usize,
    /// The press in the content less the press in the root.
    shift: Point<Points>,
    /// The scroll offset at the press.
    scroll: Points,
    /// Set when the press started inside the selection (or on a draggable
    /// node): the drag moves what is selected rather than selecting.
    moving: Option<Moving>,
    /// Pressed with Mod: a selection the drag makes across blocks covers
    /// them whole on release (Tiptap's NodeRange).
    blocks: bool,
}

/// What a drag that started inside the selection carries
/// (prosemirror-view's `Dragging`).
#[derive(Debug, Clone)]
struct Moving {
    /// The selection's content.
    slice: Slice,
    /// Whether the source is deleted (a move, not a copy).
    moved: bool,
    /// What a release without a drag selects: a caret at the press.
    click: Option<Selection>,
    /// The dragged range, deleted on a move rather than the selection
    /// (prosemirror-view's `dragging.node`: a plugin may turn a selected
    /// table into its cells while it is dragged).
    source: Option<(usize, usize)>,
}

/// What the native input that takes typed text holds.
#[derive(Debug, Default)]
struct Sink {
    text: String,
    emptied: Option<String>,
    composing: bool,
    /// The composition whose commit is still to come (its id).
    composition: Option<i64>,
    /// The sink's text last reported while composing, taken when the
    /// composition ends.
    held: Option<String>,
}

/// The view's controller. Cloned into the closures that need it.
#[derive(Clone)]
pub(crate) struct Rv {
    pub(crate) session: EditorSession,
    pub(crate) props: RichEditorProps,
    pub(crate) cx: Scope<RichEditorEvent>,
    /// The state rendered last.
    pub(crate) st: Rc<RefCell<EditorState>>,
    pub(crate) node_views: Rc<RefCell<NodeViews>>,
    pub(crate) tree: Rc<RefCell<Tree>>,
    pub(crate) geo: Rc<RefCell<Geometry>>,
    pub(crate) decorations: Rc<RefCell<Vec<Decoration>>>,
    /// The document changed: the blocks.
    pub(crate) doc_rev: Signal<u64>,
    /// The selection changed.
    pub(crate) sel_rev: Signal<u64>,
    /// The decorations changed.
    pub(crate) deco_rev: Signal<u64>,
    /// A block's frame or a text's lines changed.
    pub(crate) layout_rev: Signal<u64>,
    /// The session has a state the view has not taken yet.
    notified: Signal<u64>,
    pub(crate) focused: Signal<bool>,
    pub(crate) blink: Signal<bool>,
    pub(crate) composition: Signal<Option<String>>,
    pub(crate) sink_value: Signal<String>,
    sink: Rc<RefCell<Sink>>,
    next_composition: Rc<Cell<i64>>,
    drag: Rc<RefCell<Option<Drag>>>,
    /// The content point less the page point of the last pointer over the
    /// content, and the scroll offset then: how a drag the app starts
    /// from a page point (a drag handle's) maps into the content.
    pointer: Rc<Cell<Option<PageOffset>>>,
    /// Where a drag that moves the selection would drop it (the drop
    /// cursor).
    pub(crate) drop_at: Signal<Option<usize>>,
    /// The x Up and Down keep to.
    goal_x: Rc<Cell<Option<Points>>>,
    /// The node a node selection holds, as last told to its view.
    selected: Rc<RefCell<Option<(usize, Node)>>>,
    pub(crate) input: ElementRef,
    pub(crate) scroll: ElementRef,
    pub(crate) content: ElementRef,
    pub(crate) scroll_y: Signal<Points>,
    /// `scroll_y` outside the reactive graph, for the page queries JS
    /// asks (`pageCoordsAtPos`, `posAtPageCoords`).
    pub(crate) scrolled: Rc<Cell<Points>>,
    pub(crate) viewport: Signal<Size<Points>>,
    /// The content box's height, how far the scroll view scrolls.
    pub(crate) content_height: Signal<Points>,
    /// A drag scrolling on its own past the viewport's edge.
    autoscroll: Rc<RefCell<AutoScroll>>,
    /// The state's scroll request was not carried out yet.
    scroll_pending: Rc<Cell<bool>>,
    blink_task: Rc<RefCell<Option<Spawned<()>>>>,
    base_keymap: Rc<Keymap>,
    /// A press on a table's handle or grip being dragged.
    pub(crate) table_gesture: Rc<RefCell<Option<TableGesture>>>,
    /// What that drag shows: a column's or row's new size, a drop line.
    pub(crate) table_preview: Signal<Option<TablePreview>>,
}

impl Rv {
    pub(crate) fn new(props: RichEditorProps, cx: Scope<RichEditorEvent>) -> Rv {
        let session = props
            .editor
            .get_untracked()
            .unwrap_or_else(|| own_session(&props));
        let state = session.state();
        let mac = apple_keys();
        let base_keymap = Keymap::new(base_keymap_for(mac), &KeymapOptions { mac: Some(mac) })
            .unwrap_or_default();
        let rv = Rv {
            node_views: Rc::new(RefCell::new(session.node_views())),
            session,
            props,
            cx,
            st: Rc::new(RefCell::new(state.clone())),
            tree: Rc::default(),
            geo: Rc::new(RefCell::new(Geometry {
                font: "16px sans-serif".into(),
                measure: Some(Rc::new(nsh_core::element::text_measurer())),
                ..Geometry::default()
            })),
            decorations: Rc::default(),
            doc_rev: signal(0),
            sel_rev: signal(0),
            deco_rev: signal(0),
            layout_rev: signal(0),
            notified: signal(0),
            focused: signal(false),
            blink: signal(true),
            composition: signal(None),
            sink_value: signal(String::new()),
            sink: Rc::default(),
            next_composition: Rc::new(Cell::new(1)),
            drag: Rc::default(),
            pointer: Rc::default(),
            drop_at: signal(None),
            goal_x: Rc::default(),
            selected: Rc::default(),
            input: element_ref(),
            scroll: element_ref(),
            content: element_ref(),
            scroll_y: signal(px(0.0)),
            scrolled: Rc::default(),
            viewport: signal(Size::default()),
            content_height: signal(px(0.0)),
            autoscroll: Rc::default(),
            scroll_pending: Rc::default(),
            blink_task: Rc::default(),
            base_keymap: Rc::new(base_keymap),
            table_gesture: Rc::default(),
            table_preview: signal(None),
        };
        rv.sync_tree(&state);
        rv.sync_decorations(&state);
        rv.connect();
        rv
    }

    /// Subscribes to the session and binds the keys while focused.
    fn connect(&self) {
        // Sessions change inside JS's calls (`run`), on other threads and
        // in the view's own handlers, where the components' graph may not
        // be entered: subscribers only mark the change and wake a task,
        // which writes the view's signals on the engine thread.
        let wake = Wake::default();
        let changed = wake.clone();
        let id = self.session.subscribe(Arc::new(move |_| changed.wake()));
        let pending: Arc<std::sync::Mutex<Vec<ViewRequest>>> = Arc::default();
        let queue = pending.clone();
        let requested = wake.clone();
        let hook = self.session.attach_view(Arc::new(move |request| {
            queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push(request);
            requested.wake();
        }));
        let notified = self.notified;
        spawn(async move {
            loop {
                wake.wait().await;
                notified.update(|n| *n += 1);
            }
        });
        let (geometry, geometry_lease) = register_geometry(LocalGeometry {
            geo: self.geo.clone(),
            state: self.st.clone(),
            tree: self.tree.clone(),
            pointer: self.pointer.clone(),
            scrolled: self.scrolled.clone(),
        });
        let geometry = self.session.attach_geometry(geometry);
        let session = self.session.clone();
        cleanup(move || {
            session.unsubscribe(id);
            session.unsubscribe(hook);
            retire_geometry(&session, geometry, geometry_lease);
            session.set_focused(false);
        });
        let rv = self.clone();
        effect(move || {
            rv.notified.get();
            let requests: Vec<ViewRequest> =
                std::mem::take(&mut *pending.lock().unwrap_or_else(|e| e.into_inner()));
            untracked(|| {
                let state = rv.session.state();
                rv.take_state(state);
                for request in requests {
                    match request {
                        ViewRequest::Focus => rv.focus(),
                        ViewRequest::Blur => rv.blur(),
                        ViewRequest::DragBlock { pos, page } => {
                            rv.drag_block(pos, page);
                        }
                        ViewRequest::DragTo(page) => rv.drag_to(page),
                        ViewRequest::EndDrag => rv.release(),
                        ViewRequest::Place => rv.place(),
                    }
                }
            });
        });
        let rv = self.clone();
        effect(move || {
            if !rv.focused.get() {
                return;
            }
            for spec in keys::key_table() {
                let rv = rv.clone();
                let event = spec.event.clone();
                on_key_with(
                    &spec.keystroke,
                    KeyOptions {
                        when: When::Always,
                        repeat: spec.repeat,
                    },
                    move |_| rv.key(&event),
                );
            }
        });
        let rv = self.clone();
        effect(move || {
            if rv.props.auto_focus.get() {
                // After this commit: the input it focuses is not mounted yet
                // when the view connects.
                let rv = rv.clone();
                spawn(async move { rv.focus() });
            }
        });
        // Scrolls the selection into view once its place is known.
        let rv = self.clone();
        effect(move || {
            rv.layout_rev.get();
            rv.sel_rev.get();
            if rv.scroll_pending.get() {
                untracked(|| rv.scroll_into_view());
            }
        });
    }

    /// Renders `state`: the blocks when the document changed, the
    /// decorations, the selection; reports the changes.
    pub(crate) fn take_state(&self, state: EditorState) {
        let old = std::mem::replace(&mut *self.st.borrow_mut(), state.clone());
        let doc_changed = !old.doc().ptr_eq(state.doc());
        if doc_changed {
            self.sync_tree(&state);
            self.doc_rev.update(|r| *r += 1);
        }
        if self.sync_decorations(&state) {
            self.deco_rev.update(|r| *r += 1);
        }
        let selection_changed = doc_changed
            || old.selection().json_id() != state.selection().json_id()
            || old.selection().anchor() != state.selection().anchor()
            || old.selection().head() != state.selection().head()
            || old.selection().affinity() != state.selection().affinity();
        if selection_changed {
            self.sel_rev.update(|r| *r += 1);
            self.sync_node_selection(&state);
        }
        if state.scroll_to_selection() != old.scroll_to_selection() {
            self.scroll_pending.set(true);
        }
        if doc_changed {
            self.cx.emit(RichEditorEvent::Change(RichEditorChange {
                revision: state.revision(),
            }));
        }
        if selection_changed {
            self.cx
                .emit(RichEditorEvent::SelectionChange(RichEditorSelection::of(
                    &state,
                )));
        }
        self.restart_blink();
    }

    // The tree of blocks.

    /// Gives the blocks of `state`'s document their ids: a block keeps its
    /// id while it is the same node, or the node at its index with its
    /// type, so a changed block patches its views rather than making them
    /// again.
    fn sync_tree(&self, state: &EditorState) {
        let mut tree = self.tree.borrow_mut();
        let mut geo = self.geo.borrow_mut();
        let views = self.node_views.borrow();
        let mut alive = HashSet::new();
        let mut texts = HashMap::new();
        let mut atoms = HashMap::new();
        walk(
            &mut tree,
            &views,
            DOC,
            DOC,
            state.doc(),
            0,
            &mut alive,
            &mut texts,
            &mut atoms,
        );
        tree.children
            .retain(|id, _| *id == DOC || alive.contains(id));
        geo.frames
            .retain(|id, _| alive.contains(&(id & !(1 << 62))));
        let mut old_texts = std::mem::take(&mut geo.texts);
        for (id, start) in texts {
            let mut entry = old_texts.remove(&id).unwrap_or_default();
            entry.start = start;
            geo.texts.insert(id, entry);
        }
        geo.atoms = atoms;
    }

    /// The plugins' decorations of `state`: whether they changed.
    fn sync_decorations(&self, state: &EditorState) -> bool {
        let mut all = Vec::new();
        for plugin in state.plugins() {
            if let Some(set) = plugin.decorations(state) {
                all.extend(set.iter().cloned());
            }
        }
        let mut current = self.decorations.borrow_mut();
        if *current == all {
            return false;
        }
        *current = all;
        true
    }

    /// Tells node views a node selection took or left their node.
    fn sync_node_selection(&self, state: &EditorState) {
        let now = state
            .selection()
            .as_node()
            .map(|n| (state.selection().from(), n.node().clone()));
        let mut selected = self.selected.borrow_mut();
        let same = match (&*selected, &now) {
            (Some((a, x)), Some((b, y))) => a == b && x.ptr_eq(y),
            (None, None) => true,
            _ => false,
        };
        if same {
            return;
        }
        if let Some((_, node)) = selected.take()
            && let Some(view) = self.node_view(node.ty().name())
        {
            view.deselect();
        }
        if let Some((_, node)) = &now
            && let Some(view) = self.node_view(node.ty().name())
        {
            view.select();
        }
        *selected = now;
    }

    /// The node view of type `name`: the session's, else a plugin's.
    pub(crate) fn node_view(&self, name: &str) -> Option<Arc<dyn NodeView>> {
        if let Some(view) = self.node_views.borrow().get(name) {
            return Some(view.clone());
        }
        let state = self.st.borrow();
        for plugin in state.plugins() {
            for (n, factory) in plugin.node_views() {
                if n == name
                    && let Some(view) = factory.downcast_ref::<Arc<dyn NodeView>>()
                {
                    return Some(view.clone());
                }
            }
        }
        None
    }

    /// The decorations over `from..to`.
    pub(crate) fn decorations_in(&self, from: usize, to: usize) -> Vec<Decoration> {
        self.decorations
            .borrow()
            .iter()
            .filter(|d| d.from <= to && d.to >= from)
            .cloned()
            .collect()
    }

    // Committing.

    pub(crate) fn dispatch(&self, tr: Transaction) {
        if let Err(e) = self.session.dispatch(tr) {
            log::warn!("RichEditor: a transaction was refused: {e}");
        }
    }

    /// Whether the document can be edited: the prop and every plugin.
    pub(crate) fn editable(&self) -> bool {
        if !self.props.editable.get_untracked() || !self.session.is_editable() {
            return false;
        }
        let state = self.session.state();
        state
            .plugins()
            .iter()
            .all(|p| p.editable(&state) != Some(false))
    }

    /// Asks each plugin's hook in turn until one handles the event,
    /// dispatching what it does.
    fn some_hook(
        &self,
        state: &EditorState,
        hook: impl Fn(&Plugin, &mut dyn FnMut(Transaction)) -> bool,
    ) -> bool {
        let mut trs = Vec::new();
        let handled = state
            .plugins()
            .iter()
            .any(|p| hook(p, &mut |tr| trs.push(tr)));
        for tr in trs {
            self.dispatch(tr);
        }
        handled
    }

    // Text.

    /// Text typed at the selection: the plugins' `handle_text_input`
    /// first (input rules), then inserted with the stored marks.
    pub(crate) fn text_input(&self, text: &str, composed: bool) {
        if text.is_empty() || !self.editable() {
            return;
        }
        let state = self.session.state();
        // At a gap cursor, the default textblock comes first (as
        // prosemirror-gapcursor's `beforeinput`), then the text.
        if state.selection().is_gap_cursor() {
            if let Some(mut tr) = fill_gap(&state) {
                tr.insert_text(text, None, None);
                tr.set_origin(TransactionOrigin::Input);
                tr.scroll_into_view();
                self.dispatch(tr);
            }
            return;
        }
        let (from, to) = (state.selection().from(), state.selection().to());
        if self.some_hook(&state, |p, d| {
            p.handle_text_input(&state, from, to, text, d)
        }) {
            return;
        }
        let mut tr = state.tr();
        tr.insert_text(text, None, None);
        tr.set_origin(TransactionOrigin::Input);
        tr.scroll_into_view();
        if composed && let Some(id) = self.sink.borrow().composition {
            tr.set_meta("composition", Value::from(id));
        }
        self.dispatch(tr);
    }

    /// The sink's text changed: what was deleted and typed since.
    pub(crate) fn sink_changed(&self, text: &str) {
        // Platforms report the uncommitted text (pinyin, kana) as the sink's
        // while it lasts; the document takes only the commit.
        if self.sink.borrow().composing {
            self.sink.borrow_mut().held = Some(text.to_owned());
            self.sink_value.set(text.to_owned());
            return;
        }
        self.sink_edited(text);
    }

    /// Applies the sink's `text`: what was deleted and typed since.
    fn sink_edited(&self, text: &str) {
        let (deleted, inserted, composed) = {
            let mut sink = self.sink.borrow_mut();
            let base = match sink.emptied.take() {
                Some(old) if text.starts_with(old.as_str()) => old,
                Some(_) => String::new(),
                None => std::mem::take(&mut sink.text),
            };
            let prefix = common_prefix(&base, text);
            let deleted = base[prefix..].chars().count();
            let inserted = text[prefix..].to_owned();
            sink.text = text.to_owned();
            (deleted, inserted, sink.composition.is_some())
        };
        self.sink_value.set(text.to_owned());
        for _ in 0..deleted {
            self.key(&keys::plain_event("Backspace"));
        }
        let mut parts = inserted.split('\n').peekable();
        while let Some(part) = parts.next() {
            for piece in typed_pieces(part, composed) {
                self.text_input(piece, composed);
            }
            if parts.peek().is_some() {
                self.key(&keys::plain_event("Enter"));
            }
        }
        {
            let mut sink = self.sink.borrow_mut();
            if !sink.composing {
                sink.composition = None;
            }
        }
        if self.sink.borrow().text.len() > SINK_LIMIT {
            self.empty_sink();
        }
    }

    /// Empties the sink, unless an input method is composing there.
    fn empty_sink(&self) {
        let mut sink = self.sink.borrow_mut();
        if sink.composing || sink.text.is_empty() {
            return;
        }
        sink.emptied = Some(std::mem::take(&mut sink.text));
        drop(sink);
        self.sink_value.set(String::new());
    }

    /// An input method's composition started, changed or ended: its text
    /// shows at the caret, the document waits for the commit (one
    /// transaction, grouped in the history with the composition's).
    pub(crate) fn composition_changed(&self, composing: bool, text: &str) {
        let held = {
            let mut sink = self.sink.borrow_mut();
            if composing && sink.composition.is_none() {
                let id = self.next_composition.get();
                self.next_composition.set(id + 1);
                sink.composition = Some(id);
            }
            sink.composing = composing;
            if composing { None } else { sink.held.take() }
        };
        self.session.set_composing(composing);
        if let Some(held) = held {
            self.sink_edited(&held);
        }
        self.composition
            .set((composing && !text.is_empty()).then(|| text.to_owned()));
    }

    /// A key the sink reports itself (soft keyboards: Backspace in an
    /// empty sink).
    pub(crate) fn sink_key(&self, key: &str) {
        if key == "Backspace" && self.sink.borrow().text.is_empty() {
            self.key(&keys::plain_event("Backspace"));
        }
    }

    // Keys.

    /// A key: the selected node's view, the plugins' `handle_key_down`
    /// (keymaps), the base keymap, the clipboard keys, then the view's
    /// caret movement.
    pub(crate) fn key(&self, event: &KeyEvent) {
        if self.sink.borrow().composing {
            return;
        }
        let state = self.session.state();
        if let Some(node) = state.selection().as_node()
            && let Some(view) = self.node_view(node.node().ty().name())
            && view.handle_event(&NodeViewEvent::Key(event.clone()))
        {
            return;
        }
        let editable = self.editable();
        let plain = !(event.mod_key || event.ctrl || event.alt || event.meta || event.shift);
        if editable && plain {
            // Enter at a gap cursor opens a textblock there.
            if event.key == "Enter"
                && state.selection().is_gap_cursor()
                && let Some(mut tr) = fill_gap(&state)
            {
                tr.scroll_into_view();
                self.dispatch(tr);
                self.after_key(event);
                return;
            }
            // Tiptap's exitable marks: ArrowRight at the end of one at its
            // textblock's end leaves the mark, not the place.
            if event.key == "ArrowRight" && self.exit_mark(&state) {
                self.after_key(event);
                return;
            }
            // Up and Down from a cell's first or last line: the cell above
            // or below, at the x the caret keeps (the table keys only know
            // positions, not lines).
            let dir = match event.key.as_str() {
                "ArrowUp" => -1,
                "ArrowDown" => 1,
                _ => 0,
            };
            if dir != 0
                && let Some(next) = self.cell_vertical(state.selection(), dir)
            {
                self.set_selection(next, true);
                self.after_key(event);
                return;
            }
        }
        if editable {
            if self.some_hook(&state, |p, d| p.handle_key_down(&state, event, d)) {
                self.after_key(event);
                return;
            }
            let mut trs = Vec::new();
            if self
                .base_keymap
                .handle(&state, event, &mut |tr| trs.push(tr))
            {
                for mut tr in trs {
                    tr.scroll_into_view();
                    self.dispatch(tr);
                }
                self.after_key(event);
                return;
            }
        }
        if event.mod_key && !event.alt && !event.shift {
            match event.key.as_str() {
                "c" => return self.copy(),
                "x" => {
                    self.copy();
                    if editable {
                        self.delete_selection();
                    }
                    return;
                }
                "a" => return self.select_all(),
                _ => {}
            }
        }
        if editable && self.delete_by_key(event) {
            self.after_key(event);
            return;
        }
        if let Some(m) = keys::movement(event) {
            self.move_caret(m);
        }
    }

    /// Backspace and Delete in a textblock's text, which the keymaps leave
    /// to the platform's editing (ProseMirror leaves them to the
    /// browser's): the grapheme before or after the caret, the word with
    /// Control (Option on Apple's), the rest of the line with Command.
    fn delete_by_key(&self, event: &KeyEvent) -> bool {
        let dir = match event.key.as_str() {
            "Backspace" => -1,
            "Delete" => 1,
            _ => return false,
        };
        let state = self.session.state();
        let sel = state.selection();
        if !sel.empty() || sel.as_node().is_some() {
            return false;
        }
        let doc = state.doc().clone();
        let head = sel.head();
        let Ok(at) = doc.resolve(head) else {
            return false;
        };
        if !at.parent().inline_content() {
            return false;
        }
        let apple = apple_keys();
        let (start, end) = (at.start(at.depth), at.end(at.depth));
        let target = if apple && event.meta {
            let geo = self.geo.borrow();
            geo.line_edge(head, sel.affinity(), dir > 0)
        } else if (apple && event.alt) || (!apple && event.ctrl) {
            self.word_step(&doc, head, dir)
        } else {
            self.char_step(&doc, sel, dir).map(|s| s.head())
        };
        // Within the textblock: what lies past its edges is the keymaps'.
        let Some(target) = target.map(|t| t.clamp(start, end)) else {
            return false;
        };
        if target == head {
            return false;
        }
        let (from, to) = (head.min(target), head.max(target));
        let mut tr = state.tr();
        if tr.delete(from, to).is_err() {
            return false;
        }
        tr.scroll_into_view();
        self.dispatch(tr);
        true
    }

    /// Leaves an exitable mark the caret is at the end of, at the end of
    /// its textblock (Tiptap's `Mark.handleExit`): the mark is removed
    /// from the stored marks, so what is typed next is outside it.
    fn exit_mark(&self, state: &EditorState) -> bool {
        let Some(cursor) = state.selection().cursor() else {
            return false;
        };
        if cursor.pos != cursor.end(cursor.depth) || !cursor.parent().inline_content() {
            return false;
        }
        let marks = state
            .stored_marks()
            .map(<[Mark]>::to_vec)
            .unwrap_or_else(|| cursor.marks());
        let Some(mark) = marks.iter().find(|m| mark_exitable(m)) else {
            return false;
        };
        let mut tr = state.tr();
        tr.remove_stored_mark(mark);
        self.dispatch(tr);
        true
    }

    fn after_key(&self, event: &KeyEvent) {
        if !matches!(event.key.as_str(), "ArrowUp" | "ArrowDown") {
            self.goal_x.set(None);
        }
        self.empty_sink();
    }

    fn delete_selection(&self) {
        let state = self.session.state();
        if state.selection().empty() {
            return;
        }
        let mut tr = state.tr();
        tr.delete_selection();
        tr.scroll_into_view();
        self.dispatch(tr);
    }

    fn select_all(&self) {
        let state = self.session.state();
        let mut tr = state.tr();
        tr.set_selection(crate::rich_editor::state::AllSelection::new(state.doc()).into());
        self.dispatch(tr);
    }

    /// Moves (or extends) the selection.
    fn move_caret(&self, m: Move) {
        let state = self.session.state();
        let doc = state.doc().clone();
        let sel = state.selection().clone();
        let vertical = matches!(m.unit, Unit::Line | Unit::Page);
        if !vertical {
            self.goal_x.set(None);
        }
        if !m.extend
            && matches!(m.unit, Unit::Char | Unit::Line)
            && let Some(gap) = self.gap_step(&doc, &sel, m)
        {
            return self.set_selection(gap, true);
        }
        // Without Shift a range collapses to its side first.
        if !m.extend && !sel.empty() && m.unit == Unit::Char {
            let pos = if m.dir < 0 { sel.from() } else { sel.to() };
            let next = match doc.resolve(pos) {
                Ok(p) => Selection::near(&p, m.dir),
                Err(_) => return,
            };
            return self.set_selection(next, false);
        }
        // Up and down from a selected node leave it on that side, as
        // ProseMirror moves out of a node selection.
        if vertical && !m.extend && sel.as_node().is_some() {
            let pos = if m.dir > 0 { sel.to() } else { sel.from() };
            if let Ok(p) = doc.resolve(pos) {
                self.set_selection(Selection::near(&p, m.dir), true);
            }
            return;
        }
        let head = sel.head();
        let affinity = sel.affinity();
        let target: Option<(usize, Affinity, Option<Selection>)> = match m.unit {
            Unit::Char => self
                .char_step(&doc, &sel, m.dir)
                .map(|s| (s.head(), Affinity::Downstream, Some(s))),
            Unit::Word => self
                .word_step(&doc, head, m.dir)
                .map(|p| (p, Affinity::Downstream, None)),
            Unit::LineEdge => {
                let geo = self.geo.borrow();
                geo.line_edge(head, affinity, m.dir > 0).map(|p| {
                    let side = if m.dir > 0 {
                        Affinity::Upstream
                    } else {
                        Affinity::Downstream
                    };
                    (p, side, None)
                })
            }
            Unit::Doc => {
                let s = if m.dir < 0 {
                    Selection::at_start(&doc)
                } else {
                    Selection::at_end(&doc)
                };
                Some((s.head(), Affinity::Downstream, Some(s)))
            }
            Unit::Line | Unit::Page => self.vertical(head, affinity, m),
        };
        let Some((pos, side, whole)) = target else {
            return;
        };
        let next = if m.extend {
            let anchor = sel.anchor();
            match (doc.resolve(anchor), doc.resolve(pos)) {
                (Ok(a), Ok(h)) => TextSelection::between(&a, &h, Some(m.dir)),
                _ => return,
            }
        } else if let Some(whole) = whole {
            whole
        } else {
            match doc.resolve(pos) {
                Ok(p) if p.parent().inline_content() => {
                    TextSelection::with_affinity(p.clone(), p, side).into()
                }
                Ok(p) => Selection::near(&p, m.dir),
                Err(_) => return,
            }
        };
        self.set_selection(next, true);
    }

    /// prosemirror-gapcursor's arrow handler: from the edge of a textblock
    /// (its last or first line, for Up and Down), a selected node or a gap
    /// cursor, the next place a gap cursor can stand, if it comes before
    /// any other selection.
    fn gap_step(&self, doc: &Node, sel: &Selection, m: Move) -> Option<Selection> {
        let dir = m.dir;
        let mut start = if dir > 0 {
            sel.resolved_to().clone()
        } else {
            sel.resolved_from().clone()
        };
        let mut must_move = sel.empty();
        if sel.as_text().is_some() {
            if start.depth == 0 || !self.end_of_textblock(sel, m) {
                return None;
            }
            must_move = false;
            let edge = if dir > 0 {
                start.after(start.depth)
            } else {
                start.before(start.depth)
            };
            start = doc.resolve(edge).ok()?;
        } else if sel.is_all() {
            return None;
        }
        GapCursor::find_from(&start, dir, must_move).map(GapCursor::create)
    }

    /// Whether the head is at its textblock's edge toward the move: its
    /// end or start (graphemes), its last or first line (lines).
    fn end_of_textblock(&self, sel: &Selection, m: Move) -> bool {
        let head = sel.resolved_head();
        if !head.parent().inline_content() {
            return false;
        }
        match m.unit {
            Unit::Char => {
                if m.dir > 0 {
                    head.pos == head.end(head.depth)
                } else {
                    head.pos == head.start(head.depth)
                }
            }
            _ => match self.geo.borrow().line_index(head.pos, sel.affinity()) {
                Some((index, count)) => {
                    if m.dir > 0 {
                        index + 1 == count
                    } else {
                        index == 0
                    }
                }
                None => true,
            },
        }
    }

    /// Up or Down (`dir`) from a caret on its cell's first or last line:
    /// the cell above or below ([`Rv::table_vertical`]).
    fn cell_vertical(&self, sel: &Selection, dir: i32) -> Option<Selection> {
        if sel.as_text().is_none() || !sel.empty() {
            return None;
        }
        let m = Move {
            unit: Unit::Line,
            dir,
            extend: false,
        };
        if !self.end_of_textblock(sel, m) {
            return None;
        }
        let caret = self.geo.borrow().caret_rect(sel.head(), sel.affinity())?;
        let x = self.goal_x.get().unwrap_or(caret.origin.x);
        let next = self.table_vertical(sel.resolved_head(), x, dir)?;
        self.goal_x.set(Some(x));
        Some(next)
    }

    /// One grapheme toward `dir` from the head, out of the textblock at
    /// its ends (to the next cursor or selectable node).
    fn char_step(&self, doc: &Node, sel: &Selection, dir: i32) -> Option<Selection> {
        if let Some(node) = sel.as_node() {
            let _ = node;
            let pos = if dir > 0 { sel.to() } else { sel.from() };
            return Selection::find_from(&doc.resolve(pos).ok()?, dir, false);
        }
        let head = sel.head();
        let p = doc.resolve(head).ok()?;
        if p.parent().inline_content() {
            let start = p.start(p.depth);
            let text = inline_text(p.parent());
            let off = head - start;
            let next = if dir > 0 {
                next_boundary(&text, off)
            } else {
                prev_boundary(&text, off)
            };
            if let Some(next) = next {
                let at = doc.resolve(start + next).ok()?;
                return Some(TextSelection::new(at.clone(), at).into());
            }
            if p.depth == 0 {
                return None;
            }
            let edge = if dir > 0 {
                p.after(p.depth)
            } else {
                p.before(p.depth)
            };
            return Selection::find_from(&doc.resolve(edge).ok()?, dir, false);
        }
        Selection::find_from(&p, dir, false)
    }

    /// The next word's edge toward `dir`, within the head's textblock
    /// (its edge, then the next block's).
    fn word_step(&self, doc: &Node, head: usize, dir: i32) -> Option<usize> {
        let p = doc.resolve(head).ok()?;
        if !p.parent().inline_content() {
            return None;
        }
        let start = p.start(p.depth);
        let text = inline_text(p.parent());
        let off = head - start;
        let words = word_bounds(&text);
        let found = if dir > 0 {
            words.iter().map(|w| w.1).find(|end| *end > off)
        } else {
            words.iter().rev().map(|w| w.0).find(|s| *s < off)
        };
        match found {
            Some(o) => Some(start + o),
            None => self
                .char_step(doc, &TextSelection::new(p.clone(), p).into(), dir)
                .map(|s| s.head()),
        }
    }

    /// The position a line (or a page) up or down, at the goal x.
    #[allow(clippy::cast_precision_loss)]
    fn vertical(
        &self,
        head: usize,
        affinity: Affinity,
        m: Move,
    ) -> Option<(usize, Affinity, Option<Selection>)> {
        let geo = self.geo.borrow();
        let caret = geo.caret_rect(head, affinity)?;
        let x = self.goal_x.get().unwrap_or(caret.origin.x);
        self.goal_x.set(Some(x));
        let distance = match m.unit {
            Unit::Page => self.viewport.get_untracked().height.max(caret.size.height),
            _ => caret.size.height * 0.5 + px(1.0),
        };
        // A gap between blocks (margins, a divider) can be taller than a
        // line: a probe landing in it hits the caret's own block again, so
        // the probe steps on by half a line until it reaches another
        // position or runs out of document.
        let step = caret.size.height * 0.5;
        let mut hit = None;
        let mut moved = false;
        for i in 0..GAP_PROBES {
            let reach = distance + step * i as f32;
            let y = if m.dir < 0 {
                caret.origin.y - reach - px(1.0)
            } else {
                caret.origin.y + caret.size.height + reach - caret.size.height * 0.5
            };
            let Some(found) = geo.hit(Point::new(x, y)) else {
                break;
            };
            // Only a position past the caret, the way it goes, is a move:
            // a probe in a block's padding hits its own line again.
            moved = match found {
                Hit::Text(pos, _) => {
                    if m.dir < 0 {
                        pos < head
                    } else {
                        pos > head
                    }
                }
                Hit::Node(_) => true,
            };
            hit = Some(found);
            if moved || m.unit == Unit::Page {
                break;
            }
        }
        let (pos, side) = match hit? {
            // Nothing past the caret: the first or last line.
            Hit::Text(..) if !moved => (head, affinity),
            Hit::Text(pos, side) => (pos, side),
            Hit::Node(pos) => {
                drop(geo);
                let doc = self.session.state().doc().clone();
                return Some((
                    pos,
                    Affinity::Downstream,
                    Some(NodeSelection::create(&doc, pos)),
                ));
            }
        };
        if pos == head {
            // Past the first or last line: to the document's edge.
            let doc = self.session.state().doc().clone();
            let s = if m.dir < 0 {
                Selection::at_start(&doc)
            } else {
                Selection::at_end(&doc)
            };
            return Some((s.head(), Affinity::Downstream, None));
        }
        Some((pos, side, None))
    }

    /// Selects `selection` (a move: it scrolls into view).
    pub(crate) fn set_selection(&self, selection: Selection, scroll: bool) {
        let state = self.session.state();
        let mut tr = state.tr();
        tr.set_selection(selection);
        if scroll {
            tr.scroll_into_view();
        }
        self.dispatch(tr);
        self.empty_sink();
    }

    /// Selects `anchor..head` (the ref's `setSelection`).
    pub(crate) fn select_range(&self, anchor: usize, head: usize) {
        let state = self.session.state();
        let doc = state.doc();
        let size = doc.content().size();
        // A ref's command runs at the commit and cannot throw: positions
        // outside the document leave the selection as it is, logged.
        if anchor > size || head > size {
            log::warn!(
                "RichEditor.setSelection: {anchor}..{head} out of range (the document's positions are 0 to {size})"
            );
            return;
        }
        let (Ok(a), Ok(h)) = (doc.resolve(anchor), doc.resolve(head)) else {
            return;
        };
        let selection = if anchor == head
            && let Some(node) = h.node_after()
            && !node.is_inline()
            && NodeSelection::is_selectable(&node)
        {
            NodeSelection::create(doc, head)
        } else {
            TextSelection::between(&a, &h, None)
        };
        self.set_selection(selection, true);
    }

    /// Replaces the document (the ref's `setDocJson`): why not, when it
    /// cannot.
    pub(crate) fn set_doc_json(&self, json: &Value) -> Result<(), String> {
        let state = self.session.state();
        let doc = state
            .schema()
            .node_from_json(json)
            .map_err(|e| format!("setDocJson: not a document of the editor's schema: {e}"))?;
        let mut tr = state.tr();
        let size = state.doc().content().size();
        tr.replace_with(0, size, doc.content().clone())
            .map_err(|e| format!("setDocJson: the document does not fit: {e}"))?;
        tr.set_origin(TransactionOrigin::Api);
        self.session
            .dispatch(tr)
            .map(|_| ())
            .map_err(|e| format!("setDocJson: {e}"))
    }

    // The clipboard.

    pub(crate) fn copy(&self) {
        let state = self.session.state();
        if state.selection().empty() {
            return;
        }
        let slice = state.selection().content();
        let text = state
            .some_prop(|p| p.clipboard_text_serializer(&state, &slice))
            .unwrap_or_else(|| slice_to_text(&slice));
        set_clipboard(text);
    }

    /// A paste of `text` and, when the clipboard had it, the same content as
    /// `html` (ProseMirror's order): HTML goes through the plugins'
    /// `transform_pasted_html` and the clipboard parser (the schema's parse
    /// rules), plain text through `transform_pasted_text` and
    /// `clipboard_text_parser`; then `transform_pasted`, and `handle_paste`
    /// or a replace of the selection. Into code, the plain text is pasted
    /// as it is; HTML that parses to nothing falls back to the text.
    /// A paste: files go to the app (`onPasteFiles`), text and HTML into
    /// the document.
    pub(crate) fn paste_event(&self, p: &nsh_core::PasteEvent) {
        if self.editable() && (!p.files.is_empty() || !p.uris.is_empty()) {
            let files = p
                .files
                .iter()
                .map(|f| RichEditorFile {
                    name: f.name.clone(),
                    mime: f.mime.clone(),
                    data: f.data.clone(),
                })
                .collect();
            self.cx
                .emit(RichEditorEvent::PasteFiles(RichEditorPastedFiles {
                    files,
                    uris: p.uris.clone(),
                }));
            return;
        }
        self.paste(&p.text, &p.html);
    }

    pub(crate) fn paste(&self, text: &str, html: &str) {
        if !self.editable() || (text.is_empty() && html.is_empty()) {
            return;
        }
        let state = self.session.state();
        let from = state.selection().resolved_from().clone();
        let in_code = from.parent().ty().spec().code;
        let mut slice = None;
        if !html.is_empty() && !in_code {
            let mut html = html.to_owned();
            for plugin in state.plugins() {
                html = plugin.transform_pasted_html(&state, html);
            }
            let parser = state
                .some_prop(|p| p.clipboard_parser(&state))
                .unwrap_or_else(|| DomParser::from_schema(state.schema()));
            slice = Some(parser.parse_with_context(&html, &from))
                .filter(|s: &Slice| s.content.size() > 0);
        }
        let mut slice = match slice {
            Some(slice) => slice,
            None => {
                if text.is_empty() {
                    return;
                }
                let mut text = text.to_owned();
                for plugin in state.plugins() {
                    text = plugin.transform_pasted_text(&state, text, false);
                }
                state
                    .some_prop(|p| p.clipboard_text_parser(&state, &text, &from, false))
                    .unwrap_or_else(|| slice_from_text(state.schema(), &text, &from))
            }
        };
        for plugin in state.plugins() {
            slice = plugin.transform_pasted(&state, slice);
        }
        if self.some_hook(&state, |p, d| p.handle_paste(&state, &slice, d)) {
            return;
        }
        let mut tr = state.tr();
        tr.replace_selection(slice);
        tr.set_origin(TransactionOrigin::Paste);
        tr.set_meta("paste", Value::Bool(true));
        tr.scroll_into_view();
        self.dispatch(tr);
        self.empty_sink();
    }

    // Presses.

    /// A press at `at` in the content box.
    pub(crate) fn press(
        &self,
        at: Point<Points>,
        page: Point<Points>,
        modifiers: Modifiers,
        clicks: u32,
    ) {
        self.focus();
        self.goal_x.set(None);
        // A table's handle or grip: resizing, or selecting and moving a
        // row or column.
        if self.editable()
            && clicks == 1
            && let Some(target) = self.table_target(at)
        {
            self.start_table_drag(target, at, page);
            return;
        }
        let Some(hit) = self.hit(at) else { return };
        let state = self.session.state();
        let doc = state.doc().clone();
        let mod_key = if apple_keys() {
            modifiers.cmd
        } else {
            modifiers.ctrl
        };
        let click = ClickEvent {
            button: 0,
            mod_key,
            ctrl: modifiers.ctrl,
            alt: modifiers.alt,
            shift: modifiers.shift,
            meta: modifiers.cmd,
            read_only: !self.editable(),
        };
        let pos = match hit {
            Hit::Text(pos, _) | Hit::Node(pos) => pos,
        };
        if let Hit::Node(node_pos) = hit
            && let Some(node) = doc.node_at(node_pos)
            && let Some(view) = self.node_view(node.ty().name())
        {
            let origin = self.node_origin(node_pos);
            let local = Point::new(at.x - origin.x, at.y - origin.y);
            if view.handle_event(&NodeViewEvent::Press {
                at: local,
                click: click.clone(),
            }) {
                return;
            }
        }
        if self.click_hooks(&state, pos, &click, clicks) {
            return;
        }
        self.note_pointer(at, page);
        let shift = Point::new(at.x - page.x, at.y - page.y);
        let scroll = self.scroll_y.get_untracked();
        // A press inside the selection (or on a draggable node) may drag
        // it somewhere else, as prosemirror-view's: it selects only when
        // released without a drag.
        if clicks == 1
            && !modifiers.shift
            && self.editable()
            && let Some((selection, click_sel)) = self.drag_source(&state, hit)
        {
            if !selection.eq(state.selection()) {
                self.set_selection(selection.clone(), false);
            }
            let copy = if apple_keys() {
                modifiers.alt
            } else {
                modifiers.ctrl
            };
            *self.drag.borrow_mut() = Some(Drag {
                anchor: selection.anchor(),
                shift,
                scroll,
                moving: Some(Moving {
                    slice: selection.content(),
                    moved: !copy,
                    click: click_sel,
                    source: None,
                }),
                blocks: false,
            });
            return;
        }
        // A press on a container's own area (its padding, a list item's
        // marker), off its children's text, selects the container.
        if clicks == 1
            && !modifiers.shift
            && let Some(p) = self.container_at(at)
            && let Some(node) = doc.node_at(p)
            && NodeSelection::is_selectable(&node)
            && table_role(node.ty()).is_none()
        {
            self.set_selection(NodeSelection::create(&doc, p), false);
            return;
        }
        let selection = match (hit, clicks) {
            (Hit::Node(p), _) => {
                let Some(node) = doc.node_at(p) else { return };
                if !NodeSelection::is_selectable(&node) {
                    return;
                }
                NodeSelection::create(&doc, p)
            }
            (Hit::Text(p, side), 1) => {
                let Ok(head) = doc.resolve(p) else { return };
                if modifiers.shift {
                    let Ok(anchor) = doc.resolve(state.selection().anchor()) else {
                        return;
                    };
                    self.between(&state, &anchor, &head)
                } else {
                    TextSelection::with_affinity(head.clone(), head, side).into()
                }
            }
            (Hit::Text(p, _), 2) => match word_at(&doc, p) {
                Some((a, b)) => TextSelection::create(&doc, a, Some(b)),
                None => return,
            },
            (Hit::Text(p, _), _) => {
                let Ok(r) = doc.resolve(p) else { return };
                if r.depth == 0 {
                    return;
                }
                TextSelection::create(&doc, r.start(r.depth), Some(r.end(r.depth)))
            }
        };
        let anchor = selection.anchor();
        self.set_selection(selection, false);
        *self.drag.borrow_mut() = Some(Drag {
            anchor,
            shift,
            scroll,
            moving: None,
            blocks: mod_key,
        });
    }

    /// What a press at `hit` drags, if it starts a drag of the selection:
    /// the selection to drag (the pressed draggable node's, else the
    /// current one) and what a release without a drag selects.
    fn drag_source(&self, state: &EditorState, hit: Hit) -> Option<(Selection, Option<Selection>)> {
        let sel = state.selection();
        let doc = state.doc();
        match hit {
            Hit::Node(p) => {
                if sel.as_node().is_some() && sel.from() == p {
                    return Some((sel.clone(), None));
                }
                let node = doc.node_at(p)?;
                (node.ty().spec().draggable && NodeSelection::is_selectable(&node))
                    .then(|| (NodeSelection::create(doc, p), None))
            }
            Hit::Text(p, side) => {
                if sel.empty()
                    || sel.is_all()
                    || sel.is_gap_cursor()
                    || sel.as_custom::<CellSelection>().is_some()
                    || p <= sel.from()
                    || p >= sel.to()
                {
                    return None;
                }
                let at = doc.resolve(p).ok()?;
                Some((
                    sel.clone(),
                    Some(TextSelection::with_affinity(at.clone(), at, side).into()),
                ))
            }
        }
    }

    /// The container block whose own area (not its children's) `at` is
    /// on: where it starts. A point in a container's indent beside one of
    /// its children (a list item's marker) is that child's.
    fn container_at(&self, at: Point<Points>) -> Option<usize> {
        let tree = self.tree.borrow();
        let geo = self.geo.borrow();
        let inside = |id: u64| -> Option<Bounds<Points>> {
            let origin = geo.origin(id)?;
            let (_, frame) = geo.frames.get(&id)?;
            Some(Bounds::new(origin, frame.size))
        };
        let contains = |b: &Bounds<Points>| {
            at.x >= b.origin.x
                && at.x < b.origin.x + b.size.width
                && at.y >= b.origin.y
                && at.y < b.origin.y + b.size.height
        };
        let mut parent = DOC;
        let mut found: Option<usize> = None;
        loop {
            let children = tree.children.get(&parent)?;
            let mut next = None;
            for item in children {
                if let Some(b) = inside(item.id)
                    && contains(&b)
                {
                    next = Some(item);
                    break;
                }
            }
            let Some(item) = next else {
                // Beside a child, in the indent before it.
                if found.is_some() {
                    for item in children {
                        if let Some(b) = inside(item.id)
                            && at.y >= b.origin.y
                            && at.y < b.origin.y + b.size.height
                            && at.x < b.origin.x
                        {
                            return Some(item.pos);
                        }
                    }
                }
                return found;
            };
            let container = !item.node.is_textblock()
                && !geo.atoms.contains_key(&item.id)
                && tree.children.contains_key(&item.id);
            if !container {
                return None;
            }
            found = Some(item.pos);
            parent = item.id;
        }
    }

    /// The plugins' click hooks of a `clicks`-fold press at `pos`: each
    /// node around it, innermost first, then the position.
    fn click_hooks(
        &self,
        state: &EditorState,
        pos: usize,
        click: &ClickEvent,
        clicks: u32,
    ) -> bool {
        let Ok(r) = state.doc().resolve(pos) else {
            return false;
        };
        let direct_node = state.doc().node_at(pos).filter(|n| !n.is_text());
        let mut nodes: Vec<(Node, usize, bool)> = Vec::new();
        if let Some(n) = &direct_node
            && !n.is_inline()
        {
            nodes.push((n.clone(), pos, true));
        }
        for depth in (1..=r.depth).rev() {
            nodes.push((r.node(depth).clone(), r.before(depth), false));
        }
        for (node, node_pos, direct) in &nodes {
            let handled = self.some_hook(state, |p, d| match clicks {
                1 => p.handle_click_on(state, pos, node, *node_pos, click, *direct, d),
                2 => p.handle_double_click_on(state, pos, node, *node_pos, click, *direct, d),
                _ => p.handle_triple_click_on(state, pos, node, *node_pos, click, *direct, d),
            });
            if handled {
                return true;
            }
        }
        self.some_hook(state, |p, d| match clicks {
            1 => p.handle_click(state, pos, click, d),
            2 => p.handle_double_click(state, pos, click, d),
            _ => p.handle_triple_click(state, pos, click, d),
        })
    }

    /// The selection a pointer makes from `anchor` to `head`: a plugin's,
    /// else a text selection.
    fn between(
        &self,
        state: &EditorState,
        anchor: &crate::rich_editor::model::ResolvedPos,
        head: &crate::rich_editor::model::ResolvedPos,
    ) -> Selection {
        state
            .some_prop(|p| p.create_selection_between(state, anchor, head))
            .unwrap_or_else(|| TextSelection::between(anchor, head, None))
    }

    /// The pointer is over the content at `at` and the page at `page`: the
    /// offset a drag the app starts from the page (a handle's) maps by.
    pub(crate) fn note_pointer(&self, at: Point<Points>, page: Point<Points>) {
        self.pointer.set(Some((
            Point::new(at.x - page.x, at.y - page.y),
            self.scroll_y.get_untracked(),
        )));
    }

    /// Measures where the content is on the page (after a layout, and as a
    /// handle drag starts): the offset page queries and handle drags map
    /// by, before any pointer has been over the content.
    pub(crate) fn place(&self) {
        let content = self.content;
        let pointer = self.pointer.clone();
        let scroll = self.scroll_y;
        let drag = self.drag.clone();
        spawn(async move {
            if let Some(m) = content.measure().await {
                let at = scroll.get_untracked();
                let shift = Point::new(-m.page.x, -m.page.y);
                pointer.set(Some((shift, at)));
                // A drag begun on an older offset (the content moved on the
                // page without a layout of its own) maps by the new one.
                if let Some(drag) = drag.borrow_mut().as_mut() {
                    drag.shift = Point::new(shift.x, shift.y - (at - drag.scroll));
                }
            }
        });
    }

    /// Starts moving the block at `pos` from the page point `page`
    /// (prosemirror-view's `dragging` as Tiptap's drag handle sets it): the
    /// block is selected and carried; a release that never moves it keeps
    /// it selected.
    pub(crate) fn drag_block(&self, pos: usize, page: Point<Points>) -> bool {
        if !self.editable() {
            return false;
        }
        let Some((shift, scroll)) = self.pointer.get() else {
            return false;
        };
        let state = self.session.state();
        let doc = state.doc().clone();
        let Some(node) = doc.node_at(pos) else {
            return false;
        };
        // A handle carries any block, a table too: what a press may
        // select (`selectable`) does not limit what the handle moves.
        if node.is_inline() {
            return false;
        }
        // Pressed inside a selection over several of its siblings, the
        // handle carries them all (Tiptap's drag handle with a range
        // selected); else the block alone, closed (a selection's content
        // would carry a list item inside its open list).
        let (from, to) = self
            .sibling_range(state.selection(), pos)
            .unwrap_or((pos, pos + node.node_size()));
        let selection: Selection = if to - from == node.node_size() {
            NodeSelection::create(&doc, pos)
        } else {
            state.selection().clone()
        };
        let Ok(carried) = doc.slice(from, to, false) else {
            return false;
        };
        // The handle owns the pointer: a table's grip under it (a row's,
        // on the table's left border) does not drag along.
        self.table_gesture.borrow_mut().take();
        self.set_selection(selection.clone(), false);
        // The press is where the pointer is now; the scroll since the
        // offset was noted moves the content under it.
        let scrolled = self.scroll_y.get_untracked() - scroll;
        *self.drag.borrow_mut() = Some(Drag {
            anchor: pos,
            shift: Point::new(shift.x, shift.y - scrolled),
            scroll: self.scroll_y.get_untracked(),
            moving: Some(Moving {
                slice: Slice::new(carried.content, 0, 0),
                moved: true,
                click: None,
                source: Some((from, to)),
            }),
            blocks: false,
        });
        // The content may have moved on the page since its last layout.
        self.place();
        // The press is the handle's, off the content; it starts no
        // move of its own, so the drop cursor waits for the first `page`.
        self.drag_at(page);
        true
    }

    /// The blocks a non-empty `selection` spans beside the block at `pos`,
    /// when it covers that block and at least one sibling: `from..to`.
    fn sibling_range(&self, selection: &Selection, pos: usize) -> Option<(usize, usize)> {
        if selection.empty() {
            return None;
        }
        let doc = self.session.state().doc().clone();
        let (from, to) = (
            doc.resolve(selection.from()).ok()?,
            doc.resolve(selection.to()).ok()?,
        );
        let depth = doc.resolve(pos).ok()?.depth;
        let range = from.block_range(&to, None)?;
        (range.depth == depth
            && range.end_index() - range.start_index() > 1
            && range.start() <= pos
            && pos < range.end())
        .then(|| (range.start(), range.end()))
    }

    /// The pointer dragged to `page` (root): the selection extends there.
    pub(crate) fn drag_to(&self, page: Point<Points>) {
        if self.table_dragging() {
            return self.table_drag_to(page);
        }
        self.follow_drag_edge(page);
        self.drag_at(page);
    }

    /// Extends the selection (or moves the drop cursor) to `page`.
    fn drag_at(&self, page: Point<Points>) {
        let Some(drag) = self.drag.borrow().clone() else {
            return;
        };
        let scrolled = self.scroll_y.get_untracked() - drag.scroll;
        let at = Point::new(page.x + drag.shift.x, page.y + drag.shift.y + scrolled);
        if let Some(moving) = &drag.moving {
            let state = self.session.state();
            // A whole block goes between blocks, by the half of the block
            // the pointer is over (ProseMirror's drop point, as Tiptap's
            // drag handle sees it), wherever the pointer is across: a
            // handle sits in the gutter, off the text; other content
            // where it is dropped.
            let slice = &moving.slice;
            // Blocks carried together share a parent: the first stands for
            // them all in where they fit.
            let block =
                (slice.open_start == 0 && slice.open_end == 0 && slice.content.child_count() > 0)
                    .then(|| slice.content.child(0))
                    .filter(|n| n.is_block());
            // ProseMirror's drop point looks for a place the slice fits as
            // it is: a place that takes the block wrapped (an item out of
            // its list) stays where the pointer chose.
            let target = block
                .and_then(|node| {
                    let p = self.block_drop(at, node)?;
                    let rp = state.doc().resolve(p).ok()?;
                    let index = rp.index(rp.depth);
                    if rp.parent().can_replace_with(index, index, node.ty(), None) {
                        return drop_point(state.doc(), p, slice);
                    }
                    // Next to a list that takes the item, it joins that list
                    // (at its start or end) rather than making another.
                    let takes = |n: &Node, i: usize| n.can_replace_with(i, i, node.ty(), None);
                    if let Some(after) = rp.node_after()
                        && takes(&after, 0)
                    {
                        return Some(p + 1);
                    }
                    if let Some(before) = rp.node_before()
                        && takes(&before, before.child_count())
                    {
                        return Some(p - 1);
                    }
                    Some(p)
                })
                .or_else(|| {
                    self.hit_clamped(at)
                        .and_then(|p| drop_point(state.doc(), p, slice))
                });
            if let Some(target) = target
                && self.drop_at.get_untracked() != Some(target)
            {
                self.drop_at.set(Some(target));
            }
            return;
        }
        let Some(pos) = self.hit_clamped(at) else {
            return;
        };
        let state = self.session.state();
        let doc = state.doc();
        let (Ok(a), Ok(h)) = (doc.resolve(drag.anchor), doc.resolve(pos)) else {
            return;
        };
        let selection = self.between(&state, &a, &h);
        let current = state.selection();
        if selection.anchor() == current.anchor() && selection.head() == current.head() {
            return;
        }
        let mut tr = state.tr();
        tr.set_selection(selection);
        self.dispatch(tr);
    }

    /// The position at content point `at`; above or below the content, on
    /// the first or last line (a block dropped past the end goes last).
    fn hit_clamped(&self, at: Point<Points>) -> Option<usize> {
        let bottom = (self.content_height.get_untracked() - px(1.0)).max(px(0.0));
        match self
            .hit(at)
            .or_else(|| self.hit(Point::new(at.x, at.y.min(bottom).max(px(0.0)))))?
        {
            Hit::Text(p, _) | Hit::Node(p) => Some(p),
        }
    }

    /// Where block `node` dropped at content point `at` goes: before or
    /// after the innermost block at that height whose parent takes the
    /// node, by the half the pointer is over; else beside the nearest
    /// block whose parent takes it.
    fn block_drop(&self, at: Point<Points>, node: &Node) -> Option<usize> {
        let state = self.session.state();
        let doc = state.doc();
        let tree = self.tree.borrow();
        let geo = self.geo.borrow();
        let mut inside: Option<(usize, usize)> = None;
        let mut nearest: Option<(Points, usize)> = None;
        for b in tree.children.values().flatten() {
            let (Some(origin), Some((_, frame))) = (geo.origin(b.id), geo.frames.get(&b.id)) else {
                continue;
            };
            let Ok(rp) = doc.resolve(b.pos) else {
                continue;
            };
            let index = rp.index(rp.depth);
            // A node the parent takes wrapped goes there too (a list item
            // dropped between paragraphs lands in a list of its own).
            let direct = rp.parent().can_replace_with(index, index, node.ty(), None);
            let fits = direct
                || rp
                    .parent()
                    .content_match_at(index)
                    .and_then(|m| m.find_wrapping(node.ty()))
                    .is_some();
            if !fits {
                continue;
            }
            let (top, bottom) = (origin.y, origin.y + frame.size.height);
            let boundary = if at.y < top + frame.size.height * 0.5 {
                b.pos
            } else {
                b.pos + b.node.node_size()
            };
            if at.y >= top && at.y < bottom {
                if inside.is_none_or(|(depth, _)| rp.depth > depth) {
                    inside = Some((rp.depth, boundary));
                }
            } else {
                // Past a list's last item, the item still goes in the list.
                let distance = if at.y < top {
                    top - at.y
                } else {
                    at.y - bottom
                };
                // Between blocks, places that take the node as it is win
                // a near tie: an item just past its list's end stays in it,
                // one dragged into the gap above a paragraph leaves it.
                let rank = if direct {
                    distance - px(DIRECT_SLACK)
                } else {
                    distance
                };
                if nearest.is_none_or(|(r, _)| rank < r) {
                    nearest = Some((rank, boundary));
                }
            }
        }
        inside.map(|(_, pos)| pos).or(nearest.map(|(_, pos)| pos))
    }

    /// The press ended: a drag that moves the selection drops it where
    /// the drop cursor is, or selects as a press when it never moved.
    pub(crate) fn release(&self) {
        if self.table_dragging() {
            return self.table_release();
        }
        self.autoscroll.borrow_mut().stop();
        let drag = self.drag.borrow_mut().take();
        let target = self.drop_at.get_untracked();
        if target.is_some() {
            self.drop_at.set(None);
        }
        let Some(Drag {
            moving: Some(moving),
            ..
        }) = drag
        else {
            if drag.is_some_and(|d| d.blocks) {
                self.snap_to_blocks();
            }
            return;
        };
        match target {
            Some(target) => self.drop(&moving.slice, target, moving.moved, moving.source),
            None => {
                if let Some(click) = moving.click {
                    self.set_selection(click, false);
                }
            }
        }
    }

    /// Widens a selection across sibling blocks to cover them whole.
    fn snap_to_blocks(&self) {
        let state = self.session.state();
        if let Some(selection) = blocks_selection(state.doc(), state.selection()) {
            let mut tr = state.tr();
            tr.set_selection(selection);
            self.dispatch(tr);
        }
    }

    /// Starts, changes or stops scrolling on its own as a drag at `page`
    /// (in the root view) nears or leaves the viewport's top or bottom, as
    /// the code `Editor` does, so a selection grows past what shows.
    fn follow_drag_edge(&self, page: Point<Points>) {
        let Some(drag) = self.drag.borrow().clone() else {
            self.autoscroll.borrow_mut().stop();
            return;
        };
        let scroll_y = self.scroll_y.get_untracked();
        let y = page.y + drag.shift.y + (scroll_y - drag.scroll) - scroll_y;
        let viewport = self.viewport.get_untracked();
        let dy = layout::edge_speed(y, viewport.height, layout::AUTOSCROLL_INNER_ZONE);
        let mut auto = self.autoscroll.borrow_mut();
        auto.page = page;
        if dy.0 == 0.0 {
            auto.stop();
            return;
        }
        auto.speed = Point::new(px(0.0), dy);
        if auto.task.is_none() {
            let rv = self.clone();
            let period = Duration::from_millis(layout::AUTOSCROLL_PERIOD_MS);
            auto.task = Some(set_interval(period, move || rv.autoscroll_tick()));
        }
    }

    /// A period of scrolling while dragging: the scroll view moves by the
    /// speed (within its content) and the selection follows the pointer.
    fn autoscroll_tick(&self) {
        if self.drag.borrow().is_none() {
            self.autoscroll.borrow_mut().stop();
            return;
        }
        let (page, speed) = {
            let auto = self.autoscroll.borrow();
            (auto.page, auto.speed)
        };
        let max = (self.content_height.get_untracked() - self.viewport.get_untracked().height)
            .max(px(0.0));
        let from = self.scroll_y.get_untracked();
        let to = (from + speed.y).min(max).max(px(0.0));
        if to != from {
            self.scroll_y.set(to);
            self.scrolled.set(to);
            self.scroll.scroll_to(Point::new(px(0.0), to), false);
            self.drag_at(page);
        }
    }

    /// Drops `slice` at `pos` (prosemirror-view's drop): the plugins'
    /// `handle_drop` first, else the source deleted when `moved` and the
    /// slice inserted, selected (origin `Drop`, meta `uiEvent: "drop"`).
    pub(crate) fn drop(
        &self,
        slice: &Slice,
        pos: usize,
        moved: bool,
        source: Option<(usize, usize)>,
    ) {
        if !self.editable() {
            return;
        }
        let state = self.session.state();
        if self.some_hook(&state, |p, d| p.handle_drop(&state, slice, pos, moved, d)) {
            return;
        }
        if let Some(tr) = drop_transaction(&state, slice, pos, moved, source) {
            self.dispatch(tr);
        }
        self.focus();
    }

    /// A horizontal line at block position `pos` (a gap cursor, a drop
    /// between blocks): along the top of the block starting there, else
    /// the bottom of the block ending there; as wide as that block.
    pub(crate) fn block_edge_rect(&self, pos: usize) -> Option<Bounds<Points>> {
        let tree = self.tree.borrow();
        let geo = self.geo.borrow();
        let blocks = || tree.children.values().flatten();
        let place = |id: u64| -> Option<Bounds<Points>> {
            let origin = geo.origin(id)?;
            let (_, frame) = geo.frames.get(&id)?;
            Some(Bounds::new(origin, frame.size))
        };
        if let Some(b) = blocks().filter(|b| b.pos == pos).find_map(|b| place(b.id)) {
            return Some(Bounds::new(b.origin, Size::new(b.size.width, px(0.0))));
        }
        let b = blocks()
            .filter(|b| b.pos + b.node.node_size() == pos)
            .find_map(|b| place(b.id))?;
        Some(Bounds::new(
            Point::new(b.origin.x, b.origin.y + b.size.height),
            Size::new(b.size.width, px(0.0)),
        ))
    }

    /// Block `pos`'s top left in the content box.
    fn node_origin(&self, pos: usize) -> Point<Points> {
        let tree = self.tree.borrow();
        let id = tree
            .children
            .values()
            .flatten()
            .find(|b| b.pos == pos)
            .map(|b| b.id);
        id.and_then(|id| self.geo.borrow().origin(id))
            .unwrap_or_default()
    }

    // Focus and the caret.

    pub(crate) fn focus(&self) {
        self.input.focus();
    }

    pub(crate) fn blur(&self) {
        self.input.blur();
    }

    pub(crate) fn focus_changed(&self, focused: bool) {
        if self.focused.get_untracked() == focused {
            return;
        }
        self.focused.set(focused);
        self.session.set_focused(focused);
        self.cx.emit(if focused {
            RichEditorEvent::Focus
        } else {
            RichEditorEvent::Blur
        });
        if !focused {
            self.drag.borrow_mut().take();
            self.drop_at.set(None);
        }
        self.restart_blink();
    }

    fn restart_blink(&self) {
        if let Some(task) = self.blink_task.borrow_mut().take() {
            task.cancel();
        }
        self.blink.set(true);
        if !self.focused.get_untracked() {
            return;
        }
        let blink = self.blink;
        let task = set_interval(Duration::from_millis(530), move || {
            blink.update(|b| *b = !*b);
        });
        *self.blink_task.borrow_mut() = Some(task);
    }

    /// The caret's box in the content box (the selection's head).
    pub(crate) fn caret_rect(&self) -> Option<Bounds<Points>> {
        let state = self.st.borrow();
        let sel = state.selection();
        self.geo.borrow().caret_rect(sel.head(), sel.affinity())
    }

    /// The caret as drawn: the glyphs' height of its line.
    pub(crate) fn caret_glyph_rect(&self) -> Option<Bounds<Points>> {
        let state = self.st.borrow();
        let sel = state.selection();
        self.geo
            .borrow()
            .caret_glyph_rect(sel.head(), sel.affinity())
    }

    /// The box around the selection in the content box: its cells' (a
    /// cell selection), its text's lines, else the caret's box.
    pub(crate) fn selection_box(&self) -> Option<Bounds<Points>> {
        if let Some(cells) = self.cells_box() {
            return Some(cells);
        }
        let state = self.st.borrow();
        let sel = state.selection();
        let geo = self.geo.borrow();
        geo.range_rects(sel.from(), sel.to())
            .into_iter()
            .reduce(|a, b| a.union(&b))
            .or_else(|| geo.caret_rect(sel.head(), sel.affinity()))
    }

    /// Scrolls the head into view, once it is laid out.
    fn scroll_into_view(&self) {
        let state = self.session.state();
        if state
            .plugins()
            .iter()
            .any(|p| p.handle_scroll_to_selection(&state))
        {
            self.scroll_pending.set(false);
            return;
        }
        let Some(caret) = self.caret_rect() else {
            return;
        };
        self.scroll_pending.set(false);
        let top = self.scroll_y.get_untracked();
        let height = self.viewport.get_untracked().height;
        if height <= px(0.0) {
            return;
        }
        let y = if caret.origin.y < top {
            caret.origin.y
        } else if caret.origin.y + caret.size.height > top + height {
            caret.origin.y + caret.size.height - height
        } else {
            return;
        };
        self.scroll
            .scroll_to(Point::new(px(0.0), y.max(px(0.0))), false);
    }
}

/// The walk of [`Rv::sync_tree`] over `node`'s children (content starting
/// at `start`), rendered in box `parent`.
#[allow(clippy::too_many_arguments, reason = "the walk's accumulators")]
fn walk(
    tree: &mut Tree,
    views: &NodeViews,
    id: u64,
    parent: u64,
    node: &Node,
    start: usize,
    alive: &mut HashSet<u64>,
    texts: &mut HashMap<u64, usize>,
    atoms: &mut HashMap<u64, usize>,
) {
    let old = tree.children.remove(&id).unwrap_or_default();
    let mut used = vec![false; old.len()];
    // A table's children are its cells, row after row: rows have no view,
    // the table is the grid its cells are placed in.
    let children: Vec<(Node, usize)> = if is_table(node) {
        let mut cells = Vec::new();
        let mut row_pos = start;
        for row in node.content().iter() {
            let mut cell_pos = row_pos + 1;
            for cell in row.content().iter() {
                cells.push((cell.clone(), cell_pos));
                cell_pos += cell.node_size();
            }
            row_pos += row.node_size();
        }
        cells
    } else {
        let mut pos = start;
        node.content()
            .iter()
            .map(|child| {
                let at = pos;
                pos += child.node_size();
                (child.clone(), at)
            })
            .collect()
    };
    let mut items = Vec::with_capacity(children.len());
    for (index, (child, pos)) in children.iter().enumerate() {
        let (child, pos) = (child, *pos);
        // The same node first, then the node at its index with its type.
        let matched = old
            .iter()
            .enumerate()
            .find(|(i, b)| !used[*i] && b.node.ptr_eq(child))
            .map(|(i, _)| i)
            .or_else(|| {
                old.get(index)
                    .filter(|b| !used[index] && b.node.ty() == child.ty())
                    .map(|_| index)
            });
        let child_id = match matched {
            Some(i) => {
                used[i] = true;
                old[i].id
            }
            None => {
                tree.next += 1;
                tree.next
            }
        };
        alive.insert(child_id);
        items.push(BlockItem {
            id: child_id,
            node: child.clone(),
            pos,
            parent,
        });
        let view = views.get(child.ty().name());
        let atom = match view {
            Some(v) => !v.editable_content_slot(),
            None => child.is_leaf() || child.is_atom() && !child.is_textblock(),
        };
        if atom {
            atoms.insert(child_id, pos);
        } else if child.is_textblock() {
            texts.insert(child_id, pos + 1);
        } else {
            let box_id = if view.is_some() {
                slot_id(child_id)
            } else {
                child_id
            };
            walk(
                tree,
                views,
                child_id,
                box_id,
                child,
                pos + 1,
                alive,
                texts,
                atoms,
            );
        }
    }
    tree.children.insert(id, items);
}

/// The session of a view without one: from the `schema`, `content` and
/// `plugins` props.
fn own_session(props: &RichEditorProps) -> EditorSession {
    let schema = props
        .schema
        .get_untracked()
        .and_then(|json| match SchemaSpec::from_json(&json) {
            Ok(schema) => Some(schema),
            Err(e) => {
                log::warn!("RichEditor: the schema cannot be read ({e}); the starter's is used");
                None
            }
        })
        .unwrap_or_else(starter::schema);
    let names: Vec<String> = props
        .plugins
        .get_untracked()
        .map(|list| list.iter().map(|s| s.to_string()).collect())
        .unwrap_or_else(|| vec!["starter".into()]);
    let starter_on = names.iter().any(|n| n == "starter");
    let mut plugins: Vec<Plugin> = Vec::new();
    for name in &names {
        match name.as_str() {
            "starter" => plugins.extend(starter::plugins(&schema)),
            "history" if !starter_on => plugins.push(history(HistoryOptions::default())),
            "baseKeymap" if !starter_on => {
                plugins.push(crate::rich_editor::extensions::keymap_plugin(
                    crate::rich_editor::extensions::keymap::built_in_base_keymap(),
                ))
            }
            "markdown" => plugins.extend(crate::rich_editor::extensions::markdown::markdown(
                Default::default(),
            )),
            "history" | "baseKeymap" => {}
            other => log::warn!("RichEditor: no built-in plugins named {other:?}"),
        }
    }
    let mut config = EditorStateConfig::new(schema.clone()).plugins(plugins.clone());
    if let Some(json) = props.content.get_untracked() {
        match schema.node_from_json(&json) {
            Ok(doc) => config = config.doc(doc),
            Err(e) => log::warn!("RichEditor: the content cannot be read: {e}"),
        }
    }
    let state = EditorState::create(config).unwrap_or_else(|e| {
        log::warn!("RichEditor: the state cannot be made ({e}); an empty one is used");
        EditorState::create(EditorStateConfig::new(schema))
            .expect("an empty state of a valid schema")
    });
    EditorSession::new(state, NodeViews::new())
}

/// The base keymap of the platform the view runs on.
fn base_keymap_for(mac: bool) -> Vec<(String, crate::rich_editor::commands::BoxCommand)> {
    if mac {
        crate::rich_editor::commands::mac_base_keymap()
    } else {
        crate::rich_editor::commands::pc_base_keymap()
    }
}

/// Whether a mark leaves at the end of its textblock with ArrowRight
/// (Tiptap's `exitable`).
pub(crate) fn mark_exitable(mark: &Mark) -> bool {
    mark.ty().spec().exitable
}

/// The transaction inserting the default textblock at a gap cursor (the
/// types the parent's content needs around text there), with the caret in
/// it.
pub(crate) fn fill_gap(state: &EditorState) -> Option<Transaction> {
    let from = state.selection().resolved_from().clone();
    let wrapping = from
        .parent()
        .content_match_at(from.index(from.depth))?
        .find_wrapping(&state.schema().text_type())?;
    let mut fragment = Fragment::empty();
    for ty in wrapping.iter().rev() {
        fragment = Fragment::from(ty.create_and_fill(None, fragment, Vec::new())?);
    }
    let mut tr = state.tr();
    tr.replace(from.pos, from.pos, Slice::new(fragment, 0, 0))
        .ok()?;
    let inside = tr.doc().resolve(from.pos + 1).ok()?;
    tr.set_selection(Selection::near(&inside, 1));
    Some(tr)
}

/// prosemirror-view's drop of `slice` at `insert`: the selection deleted
/// first when `moved`, the slice inserted where `insert` maps to (a single
/// closed node as that node), then selected; `None` when nothing changes.
/// `node` as it goes at `pos` in `doc`: as it is where it fits, else in
/// a copy of `home` (the parent it left) when that fits, else in the
/// schema's first wrapping; none where nothing does.
fn wrapped(doc: &Node, pos: usize, node: Node, home: Option<&Node>) -> Option<Node> {
    let rp = doc.resolve(pos).ok()?;
    let (parent, index) = (rp.parent(), rp.index(rp.depth));
    if parent.can_replace_with(index, index, node.ty(), None) {
        return Some(node);
    }
    if let Some(home) = home
        && home.ty().content_match().match_type(node.ty()).is_some()
        && parent.can_replace_with(index, index, home.ty(), None)
    {
        return home
            .ty()
            .create(Some(home.attrs().clone()), Fragment::from(node), vec![])
            .ok();
    }
    let wrappers = parent.content_match_at(index)?.find_wrapping(node.ty())?;
    wrappers.iter().rev().try_fold(node, |inner, ty| {
        ty.create(None, Fragment::from(inner), vec![]).ok()
    })
}

pub(crate) fn drop_transaction(
    state: &EditorState,
    slice: &Slice,
    insert: usize,
    moved: bool,
    source: Option<(usize, usize)>,
) -> Option<Transaction> {
    let mut tr = state.tr();
    // The parent the moved block leaves, which wraps it again where the
    // drop's place takes it only wrapped (an item dropped out of its list).
    let home = source
        .and_then(|(from, _)| state.doc().resolve(from).ok())
        .filter(|rp| rp.depth > 0)
        .map(|rp| rp.parent().clone());
    match (moved, source) {
        (true, Some((from, to))) => {
            // A parent left empty goes with its last child (a list whose
            // only item moves away).
            let (mut from, mut to) = (from, to);
            while let Ok(rp) = state.doc().resolve(from) {
                if rp.depth == 0 || rp.start(rp.depth) != from || rp.end(rp.depth) != to {
                    break;
                }
                (from, to) = (rp.before(rp.depth), rp.after(rp.depth));
            }
            tr.delete(from, to).ok()?;
        }
        (true, None) => {
            tr.delete_selection();
        }
        (false, _) => {}
    }
    let pos = tr.mapping.map(insert, 1);
    let single = (slice.open_start == 0 && slice.open_end == 0 && slice.content.child_count() == 1)
        .then(|| slice.content.first_child().cloned())
        .flatten();
    let single = single.and_then(|node| wrapped(tr.doc(), pos, node, home.as_ref()));
    let before = tr.doc().clone();
    match &single {
        Some(node) => {
            tr.replace_range_with(pos, pos, node.clone()).ok()?;
        }
        None => {
            tr.replace_range(pos, pos, slice.clone()).ok()?;
        }
    }
    if *tr.doc() == before {
        return None;
    }
    let at = tr.doc().resolve(pos).ok()?;
    let selection = match &single {
        Some(node)
            if NodeSelection::is_selectable(node)
                && at.node_after().is_some_and(|n| n.same_markup(node)) =>
        {
            NodeSelection::new(at).into()
        }
        _ => {
            let mut end = tr.mapping.map(insert, 1);
            if let Some(last) = tr.mapping.maps.last() {
                last.for_each(|_, _, _, new_to| end = new_to);
            }
            let end = tr.doc().resolve(end).ok()?;
            TextSelection::between(&at, &end, None)
        }
    };
    tr.set_selection(selection);
    tr.set_origin(TransactionOrigin::Drop);
    tr.set_meta("uiEvent", Value::from("drop"));
    tr.scroll_into_view();
    Some(tr)
}

/// A textblock's content as text: its texts, and U+FFFC for each inline
/// leaf, so offsets are the content's.
pub(crate) fn inline_text(block: &Node) -> String {
    let mut out = String::new();
    for child in block.content().iter() {
        match child.text() {
            Some(t) => out.push_str(t),
            None => {
                for _ in 0..child.node_size() {
                    out.push('\u{FFFC}');
                }
            }
        }
    }
    out
}

/// The grapheme boundaries of `text` as UTF-16 offsets.
fn boundaries(text: &str) -> Vec<usize> {
    let mut out = vec![0];
    let mut at = 0;
    for g in text.graphemes(true) {
        at += g.encode_utf16().count();
        out.push(at);
    }
    out
}

fn next_boundary(text: &str, off: usize) -> Option<usize> {
    boundaries(text).into_iter().find(|b| *b > off)
}

fn prev_boundary(text: &str, off: usize) -> Option<usize> {
    boundaries(text).into_iter().rev().find(|b| *b < off)
}

/// The words of `text` (UTF-16 ranges).
fn word_bounds(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut at = 0;
    for w in text.split_word_bounds() {
        let len = w.encode_utf16().count();
        if w.chars().any(|c| c.is_alphanumeric()) {
            out.push((at, at + len));
        }
        at += len;
    }
    out
}

/// The word at `pos` (document positions), for a double press.
fn word_at(doc: &Node, pos: usize) -> Option<(usize, usize)> {
    let p = doc.resolve(pos).ok()?;
    if !p.parent().inline_content() {
        return None;
    }
    let start = p.start(p.depth);
    let text = inline_text(p.parent());
    let off = pos - start;
    let mut at = 0;
    for w in text.split_word_bounds() {
        let len = w.encode_utf16().count();
        if off >= at && off < at + len
            || (off == at + len && at + len == text.encode_utf16().count())
        {
            return Some((start + at, start + at + len));
        }
        at += len;
    }
    Some((pos, pos))
}

/// The bytes `a` and `b` start with alike, on a char boundary.
fn common_prefix(a: &str, b: &str) -> usize {
    a.char_indices()
        .zip(b.chars())
        .find(|((_, x), y)| x != y)
        .map(|((i, _), _)| i)
        .unwrap_or_else(|| a.len().min(b.len()))
}

/// The insertions a change of the sink's text makes: an input method's
/// commit as one, else each character on its own, as it was typed. A
/// platform may coalesce a frame's keys (or a test's typed string) into one
/// change; input rules must still see each character.
fn typed_pieces(text: &str, composed: bool) -> Vec<&str> {
    if composed {
        return vec![text];
    }
    text.char_indices()
        .map(|(i, c)| &text[i..i + c.len_utf8()])
        .collect()
}

/// `selection` widened to the whole sibling blocks it spans, when it spans
/// more than one parent.
fn blocks_selection(doc: &Node, selection: &Selection) -> Option<Selection> {
    let (a, h) = (
        doc.resolve(selection.anchor()).ok()?,
        doc.resolve(selection.head()).ok()?,
    );
    if a.same_parent(&h) {
        return None;
    }
    let range = a.block_range(&h, None)?;
    let (start, end) = (
        doc.resolve(range.start()).ok()?,
        doc.resolve(range.end()).ok()?,
    );
    let (anchor, head) = if h.pos >= a.pos {
        (start, end)
    } else {
        (end, start)
    };
    Some(TextSelection::between(&anchor, &head, None))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesced_typing_goes_in_character_by_character() {
        assert_eq!(typed_pieces("a**b", false), ["a", "*", "*", "b"]);
        assert_eq!(typed_pieces("中文", false), ["中", "文"]);
        assert_eq!(typed_pieces("中文", true), ["中文"]);
        assert!(typed_pieces("", false).is_empty());
    }

    #[test]
    fn graphemes_step_whole() {
        let text = "ae\u{301}👍🏽b";
        let b = boundaries(text);
        assert_eq!(b, [0, 1, 3, 7, 8]);
        assert_eq!(next_boundary(text, 1), Some(3));
        assert_eq!(prev_boundary(text, 7), Some(3));
    }

    fn state_of(json: serde_json::Value) -> EditorState {
        let schema = starter::schema();
        let doc = schema.node_from_json(&json).unwrap();
        EditorState::create(EditorStateConfig::new(schema).doc(doc)).unwrap()
    }

    fn para(t: &str) -> serde_json::Value {
        serde_json::json!({"type": "paragraph", "content": [{"type": "text", "text": t}]})
    }

    #[test]
    fn a_drop_moves_the_selection_and_selects_it() {
        let state =
            state_of(serde_json::json!({"type": "doc", "content": [para("abcd"), para("xy")]}));
        // Select "bc" (2..4) and drop it after "x" (8).
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), 2, Some(4)));
        let state = state.apply(tr).unwrap();
        let slice = state.selection().content();
        let tr = drop_transaction(&state, &slice, 8, true, None).unwrap();
        assert_eq!(
            tr.doc()
                .text_between(0, tr.doc().content().size(), Some("|"), None),
            "ad|xbcy"
        );
        assert_eq!((tr.selection().from(), tr.selection().to()), (6, 8));
        assert_eq!(tr.get_meta("uiEvent"), Some(&Value::from("drop")));
        // A copy keeps the source.
        let tr = drop_transaction(&state, &slice, 8, false, None).unwrap();
        assert_eq!(
            tr.doc()
                .text_between(0, tr.doc().content().size(), Some("|"), None),
            "abcd|xbcy"
        );
    }

    #[test]
    fn a_mod_drag_across_blocks_selects_them_whole() {
        let state = state_of(serde_json::json!({
            "type": "doc",
            "content": [para("one"), para("two"), para("three")],
        }));
        let doc = state.doc();
        // From inside "one" to inside "two": both blocks whole.
        let picked = blocks_selection(doc, &TextSelection::create(doc, 2, Some(7))).unwrap();
        assert_eq!((picked.from(), picked.to()), (1, 9));
        // Backwards keeps its direction.
        let back = blocks_selection(doc, &TextSelection::create(doc, 12, Some(2))).unwrap();
        assert_eq!((back.anchor(), back.head()), (16, 1));
        // Inside one block, nothing changes.
        assert!(blocks_selection(doc, &TextSelection::create(doc, 1, Some(3))).is_none());
    }

    #[test]
    fn filling_a_gap_inserts_the_default_textblock() {
        let state =
            state_of(serde_json::json!({"type": "doc", "content": [{"type": "horizontalRule"}]}));
        let mut tr = state.tr();
        tr.set_selection(GapCursor::create(state.doc().resolve(1).unwrap()));
        let state = state.apply(tr).unwrap();
        let tr = fill_gap(&state).unwrap();
        assert_eq!(tr.doc().child_count(), 2);
        assert!(tr.doc().child(1).is_textblock());
        assert_eq!(tr.selection().head(), 2);
    }

    #[test]
    fn words_skip_punctuation() {
        assert_eq!(word_bounds("hi, you"), [(0, 2), (4, 7)]);
    }

    #[test]
    fn a_tables_cells_are_its_children() {
        use crate::rich_editor::tables::test_util::{cell_pos, doc, grid, p};
        let d = doc(vec![p("x"), grid(&[&["a", "b"], &["c", "d"]])]);
        let mut tree = Tree::default();
        let (mut alive, mut texts, mut atoms) = (HashSet::new(), HashMap::new(), HashMap::new());
        let views = NodeViews::default();
        walk(
            &mut tree, &views, DOC, DOC, &d, 0, &mut alive, &mut texts, &mut atoms,
        );
        let table = tree.children[&DOC][1].clone();
        let cells = &tree.children[&table.id];
        // Rows have no blocks: the cells, row after row, at their positions.
        assert_eq!(
            cells.iter().map(|c| c.pos).collect::<Vec<_>>(),
            ["a", "b", "c", "d"].map(|t| cell_pos(&d, t))
        );
        assert!(cells.iter().all(|c| c.parent == table.id));
        // Each cell's paragraph is a textblock of the cell.
        let first = &tree.children[&cells[0].id][0];
        assert_eq!(texts[&first.id], cell_pos(&d, "a") + 2);
    }
}

/// A wake-up that any thread or call may signal and one task awaits:
/// several signals before the task runs count as one.
#[derive(Clone, Default)]
struct Wake(Arc<std::sync::Mutex<(bool, Option<std::task::Waker>)>>);

impl Wake {
    fn wake(&self) {
        let waker = {
            let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
            inner.0 = true;
            inner.1.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
    }

    async fn wait(&self) {
        std::future::poll_fn(|cx| {
            let mut inner = self.0.lock().unwrap_or_else(|e| e.into_inner());
            if std::mem::take(&mut inner.0) {
                std::task::Poll::Ready(())
            } else {
                inner.1 = Some(cx.waker().clone());
                std::task::Poll::Pending
            }
        })
        .await;
    }
}

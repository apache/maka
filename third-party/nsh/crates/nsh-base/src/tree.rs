//! `Tree`: items that hold items, expanded and collapsed, one of them
//! selected, with no look of its own (`gpui-base`'s `Tree` and
//! `TreeState`, `gpui-component`'s `Tree`).
//!
//! - **The model** (pure, tested on its own): the app's `items` flattened
//!   once per change of them, depth first ([`Flat`]: each node's parent,
//!   depth and the end of its subtree, its row key hashed), the expanded
//!   nodes ([`Open`]: as many as are expanded, whatever the items), and
//!   the rows the expanded items show ([`Shown`]: the nodes in order, a
//!   collapsed item's subtree skipped, made in the number of rows shown).
//!   The moves of the selection between the enabled rows
//!   ([`Shown::step`]) and typeahead ([`Shown::find_typed`]) look rows up
//!   by bisection.
//! - **The view**: a virtualized list (`viewport: parent`) in a scroll view
//!   in the tree's root, as `gpui-base`'s `uniform_list`: only the rows in
//!   view exist, and the children of a collapsed item are never made. A
//!   row's look is the app's (`itemClass`, `renderItem`); its states are
//!   its classes' (`selected:`, `aria-expanded:`, `disabled:`, `focus:`
//!   for the keys' row while the tree has the keyboard focus), so the
//!   app's drawing of a row is made once per item and its chevron turns
//!   with a transition (`group-aria-expanded:rotate-90`).
//! - **Its cost**: a move of the selection notifies the rows it leaves and
//!   reaches (spread over [`LIT`] signals, as `Select`'s highlight);
//!   expanding or collapsing makes the rows of the subtree that comes into
//!   view, and the rows after it keep their cells (keyed by id).
//!
//! The root is one stop of the keyboard focus (where views that take
//! presses are: macOS, Windows, Linux, the web), the tree for screen
//! readers. The keys act on one row, the cursor: the selected row, else
//! the row of the collapsed item the selection is hidden under, else
//! (nothing selected) the first enabled row, where Down starts. The arrows
//! move the selection between the rows shown (the WAI-ARIA tree view
//! pattern, which `gpui-base`'s Left / Right extend; Return on a leaf and
//! a double press are its default action, `onAction`; in a right-to-left
//! layout Left and Right trade places, as the pattern says), and the
//! cursor's row takes the screen reader's focus as it moves and as the
//! tree takes the keyboard focus.

use std::{
    hash::{Hash, Hasher},
    rc::Rc,
};

use nsh_core::{
    AccessibilityState,
    element::{Style, TextPartStyle, layout_rtl},
    keymap::When,
    prelude::*,
    time::now,
};
use rustc_hash::{FxHashMap, FxHasher};

use crate::{
    collapsible::REVEAL,
    keys::directed,
    listbox::{self, Typeahead},
    select::SelectValue,
    terminal::{DISCLOSURE_NONE, TREE_INDENT, disclosure, is_terminal},
};

/// How many signals a node the rows follow (the selection, the cursor) is
/// spread over, by `node % LIT` ([`Lit`]): a move wakes the rows whose
/// nodes share a signal with the node it leaves or the node it reaches,
/// about two in `LIT` of the rows made, and those whose state stays send
/// nothing. Nodes, not rows: the rows in view are not consecutive nodes,
/// so two of them may share a signal however few there are.
const LIT: usize = 32;

/// A row is in view when this much of it shows.
const IN_VIEW: Percentage = Percentage(0.995);

/// No parent: a node at the top.
const ROOT: u32 = u32::MAX;

/// An item of a [`Tree`], with the items under it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct TreeItem {
    /// What identifies it in `expanded`, `selected` and the events: the
    /// app's, unique in the tree (a file's path, a record's key), never
    /// its label.
    pub id: SharedString,
    /// Its label: what its row shows (unless `renderItem` draws it), what
    /// screen readers say and what typeahead matches.
    pub label: SharedString,
    /// The items under it, in order: with any, it is a folder that
    /// expands and collapses.
    #[prop(default)]
    pub children: Vec<TreeItem>,
    /// It cannot be selected, expanded or collapsed by the user: the keys
    /// pass over it, presses do nothing, `disabled:` styles apply and
    /// screen readers say it is dimmed. Its children stay as `expanded`
    /// says.
    #[prop(default)]
    pub disabled: bool,
}

impl TreeItem {
    /// An item of `id`, labelled `label`.
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            ..Self::default()
        }
    }

    /// Adds `child` under it.
    pub fn child(mut self, child: TreeItem) -> Self {
        self.children.push(child);
        self
    }

    /// Adds `children` under it.
    pub fn children(mut self, children: impl IntoIterator<Item = TreeItem>) -> Self {
        self.children.extend(children);
        self
    }

    /// Whether the user can act on it ([`TreeItem::disabled`]).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// An item's row as `renderItem` draws it: what the item is, never its
/// state, so the drawing is made once per item and keeps its views while
/// it is selected, expanded or collapsed. The states are the row's
/// (`group-selected:`, `group-aria-expanded:`, `group-focus:`,
/// `group-disabled:` under `group` in `itemClass`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct TreeEntry {
    /// The item's `id`.
    pub id: SharedString,
    /// The item's `label`.
    pub label: SharedString,
    /// How deep it is: 0 at the top, 1 under a top item, ... (indent the
    /// row's content by it).
    pub depth: u32,
    /// It has children: it expands and collapses.
    pub folder: bool,
    /// The item's `disabled`.
    pub disabled: bool,
}

/// A node of the flattened items.
#[derive(Debug)]
struct Node {
    id: SharedString,
    label: SharedString,
    /// Its parent's index, [`ROOT`] at the top.
    parent: u32,
    depth: u32,
    /// The index past its subtree: its next sibling's, or its parent's
    /// next sibling's.
    end: u32,
    disabled: bool,
    /// Its row key, hashed.
    key: u64,
}

impl Node {
    fn folder(&self, at: usize) -> bool {
        self.end as usize > at + 1
    }
}

/// The items, depth first, made once per change of them.
#[derive(Debug, Default)]
pub(crate) struct Flat {
    nodes: Vec<Node>,
    /// Each id's node (the first of an id given twice).
    index: FxHashMap<SharedString, u32>,
}

impl Flat {
    /// The items flattened; ids given twice are logged, once per call.
    pub(crate) fn new(items: &[TreeItem]) -> Self {
        let mut flat = Self::default();
        flat.push(items, ROOT, 0);
        let duplicates = flat.nodes.len() - flat.index.len();
        if duplicates > 0 {
            let first = flat
                .nodes
                .iter()
                .enumerate()
                .find(|(at, n)| flat.index.get(&n.id).is_some_and(|&i| i as usize != *at))
                .map(|(_, n)| n.id.clone())
                .unwrap_or_default();
            log::warn!(
                "Tree: {duplicates} item(s) repeat the id of an item before them (the first, \
                 `{first}`): ids are unique in a tree, and only the first item of an id \
                 expands or is selected"
            );
        }
        flat
    }

    fn push(&mut self, items: &[TreeItem], parent: u32, depth: u32) {
        for item in items {
            let at = self.nodes.len() as u32;
            self.nodes.push(Node {
                id: item.id.clone(),
                label: item.label.clone(),
                parent,
                depth,
                end: at + 1,
                disabled: item.disabled,
                key: hash(&item.id),
            });
            self.index.entry(item.id.clone()).or_insert(at);
            self.push(&item.children, at, depth + 1);
            self.nodes[at as usize].end = self.nodes.len() as u32;
        }
    }

    /// The node of `id`.
    pub(crate) fn find(&self, id: &str) -> Option<usize> {
        self.index.get(id).map(|&n| n as usize)
    }

    fn parent(&self, node: usize) -> Option<usize> {
        let parent = self.nodes.get(node)?.parent;
        (parent != ROOT).then_some(parent as usize)
    }

    fn folder(&self, node: usize) -> bool {
        self.nodes.get(node).is_some_and(|n| n.folder(node))
    }

    fn enabled(&self, node: usize) -> bool {
        self.nodes.get(node).is_some_and(|n| !n.disabled)
    }

    fn id(&self, node: usize) -> Option<SharedString> {
        self.nodes.get(node).map(|n| n.id.clone())
    }

    /// The ancestors of `node`, the nearest first.
    fn ancestors(&self, node: usize) -> impl Iterator<Item = usize> + '_ {
        std::iter::successors(self.parent(node), move |&n| self.parent(n))
    }

    /// The children of `node`, in order.
    fn children(&self, node: usize) -> impl Iterator<Item = usize> + '_ {
        let end = self.nodes.get(node).map_or(0, |n| n.end as usize);
        std::iter::successors(Some(node + 1).filter(|&c| c < end), move |&c| {
            Some(self.nodes[c].end as usize).filter(|&n| n < end)
        })
    }

    /// Which nodes are expanded: the folders of `ids`.
    pub(crate) fn open(&self, ids: &[SharedString]) -> Open {
        let mut open: Vec<u32> = ids
            .iter()
            .filter_map(|id| self.find(id))
            .filter(|&n| self.folder(n))
            .map(|n| n as u32)
            .collect();
        open.sort_unstable();
        open.dedup();
        Open(open)
    }

    /// What `renderItem` gets of `node`.
    fn entry(&self, node: usize) -> Option<TreeEntry> {
        let n = self.nodes.get(node)?;
        Some(TreeEntry {
            id: n.id.clone(),
            label: n.label.clone(),
            depth: n.depth,
            folder: n.folder(node),
            disabled: n.disabled,
        })
    }
}

/// The [`Flat`] items now, compared by identity: no label is compared
/// again.
#[derive(Clone)]
struct Flatted(Rc<Flat>);

impl PartialEq for Flatted {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

fn hash(value: &impl Hash) -> u64 {
    let mut h = FxHasher::default();
    value.hash(&mut h);
    h.finish()
}

/// The expanded nodes, in order: as many as the items expanded, so an
/// expansion costs the expanded items, not every item.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Open(Vec<u32>);

impl Open {
    /// Whether `node` is expanded.
    pub(crate) fn contains(&self, node: usize) -> bool {
        self.0.binary_search(&(node as u32)).is_ok()
    }
}

/// Whether `label`, in lower case, starts with `prefix` (in lower case):
/// typeahead folds only the characters it compares.
fn starts_folded(label: &str, prefix: &str) -> bool {
    let mut label = label.chars().flat_map(char::to_lowercase);
    prefix.chars().all(|c| label.next() == Some(c))
}

/// The rows the items show: every top item, and the children of each
/// expanded item that shows.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Shown {
    /// The nodes shown, in order (increasing).
    pub(crate) rows: Vec<u32>,
    /// Their row keys.
    keys: Vec<u64>,
}

/// A move of the selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Step {
    /// The next enabled row, the first after the last.
    Next,
    /// The previous enabled row, the last before the first.
    Previous,
    /// The first enabled row.
    First,
    /// The last enabled row.
    Last,
}

impl Shown {
    /// The rows of `flat` with the nodes `open` says are expanded: made in
    /// the number of rows, a collapsed subtree skipped whole.
    pub(crate) fn new(flat: &Flat, open: &Open) -> Self {
        let mut shown = Self::default();
        // The nodes shown only increase: the expanded ones are walked once.
        let mut expanded = open.0.iter().map(|&n| n as usize).peekable();
        let mut at = 0;
        while at < flat.nodes.len() {
            let node = &flat.nodes[at];
            shown.rows.push(at as u32);
            shown.keys.push(node.key);
            while expanded.next_if(|&n| n < at).is_some() {}
            at = if expanded.peek() == Some(&at) {
                at + 1
            } else {
                node.end as usize
            };
        }
        shown
    }

    /// The row of `node`, if it shows.
    pub(crate) fn row_of(&self, node: usize) -> Option<usize> {
        self.rows.binary_search(&(node as u32)).ok()
    }

    /// The row of `node`, else of its nearest ancestor that shows.
    fn row_near(&self, flat: &Flat, node: usize) -> Option<usize> {
        self.row_of(node)
            .or_else(|| flat.ancestors(node).find_map(|n| self.row_of(n)))
    }

    /// Where the selection goes from `from` (a node; from its row, or from
    /// its nearest ancestor's when it does not show) by `by`, among the
    /// enabled rows; `None` when none is.
    pub(crate) fn step(&self, flat: &Flat, from: Option<usize>, by: Step) -> Option<usize> {
        let count = self.rows.len();
        let node_at = |r: usize| self.rows[r] as usize;
        let enabled = |r: &usize| flat.enabled(node_at(*r));
        let at = from.and_then(|f| self.row_near(flat, f));
        let row = match (by, at) {
            (Step::First, _) | (Step::Next, None) => (0..count).find(enabled),
            (Step::Last, _) | (Step::Previous, None) => (0..count).rev().find(enabled),
            (Step::Next, Some(r)) => (1..=count).map(|k| (r + k) % count).find(enabled),
            (Step::Previous, Some(r)) => (1..=count).map(|k| (r + count - k) % count).find(enabled),
        };
        row.map(node_at)
    }

    /// The enabled node `typed` jumps to from `from`: the first one, going
    /// on from it and around, whose label starts with it. The same
    /// character typed again moves on to the next label starting with it;
    /// more characters keep the node while it still matches.
    pub(crate) fn find_typed(
        &self,
        flat: &Flat,
        from: Option<usize>,
        typed: &str,
    ) -> Option<usize> {
        let mut chars = typed.chars();
        let first = chars.next()?;
        let repeated = chars.all(|c| c == first);
        let prefix = if repeated {
            &typed[..first.len_utf8()]
        } else {
            typed
        };
        let count = self.rows.len();
        let start = match from.and_then(|f| self.row_near(flat, f)) {
            Some(r) if repeated => r + 1,
            Some(r) => r,
            None => 0,
        };
        (0..count)
            .map(|k| self.rows[(start + k) % count] as usize)
            .find(|&n| flat.enabled(n) && starts_folded(&flat.nodes[n].label, prefix))
    }

    /// The node the keys act on: `selected`'s row, else (hidden under a
    /// collapsed item) the row of its nearest ancestor that shows, else
    /// (nothing selected) the first enabled row.
    fn cursor(&self, flat: &Flat, selected: Option<usize>) -> Option<usize> {
        selected
            .and_then(|n| self.row_near(flat, n))
            .map(|r| self.rows[r] as usize)
            .or_else(|| self.step(flat, None, Step::First))
    }
}

/// The props of [`Tree`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TreeProps {
    /// The items at the top, each with the items under it.
    #[prop(default)]
    pub items: Prop<Vec<TreeItem>>,
    /// The `id`s of the expanded items (controlled): the app owns them and
    /// sets them in `onExpandedChange`. Without it the tree keeps its own.
    /// An item shows while every item above it is expanded.
    pub expanded: Prop<Option<Vec<SharedString>>>,
    /// The expanded items at first, while `expanded` is not set.
    #[prop(default)]
    pub default_expanded: Prop<Vec<SharedString>>,
    /// The selected item's `id` (controlled), `null` for none: the app owns
    /// it and sets it in `onSelectedChange`. Without it the tree keeps its
    /// own.
    #[prop(default)]
    pub selected: Prop<SelectValue>,
    /// The selected item at first, while `selected` is not set.
    pub default_selected: Prop<Option<SharedString>>,
    /// No item takes presses or keys, the tree is no stop of the keyboard
    /// focus, `disabled:` styles apply to every row and screen readers say
    /// each is dimmed; it shows what `expanded` and `selected` say.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// Expanding and collapsing move the rows after the item to their new
    /// places with a spring, critically damped (`Collapsible`'s `reveal`),
    /// run natively; the rows that come show at once and the rows that go
    /// leave at once. Off by default, and with reduced motion.
    #[prop(default)]
    pub reveal: Prop<bool>,
    /// What screen readers call the tree.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The classes of the list, the scroll view of the rows inside the
    /// tree (`gpui-base`'s `list_style`): its padding and gaps. The tree's
    /// own `class` sizes it: give it a height (or `flex-1` in a sized
    /// parent) for the rows to scroll and only those in view to be made.
    pub list_class: Prop<Option<SharedString>>,
    /// The inline style of the list, over its classes.
    #[prop(default)]
    pub list_style: Prop<Style>,
    /// The classes of each item's row: `selected:` while it is selected,
    /// `aria-expanded:` while it is expanded, `focus:` while the tree has
    /// the keyboard focus and the keys act on it (the selected row; the
    /// collapsed item the selection is hidden under; with nothing
    /// selected, the first enabled row), `disabled:` while it
    /// cannot be acted on, `hover:` and `active:`; `group` for its content
    /// to follow them (`group-aria-expanded:rotate-90` on a chevron).
    pub item_class: Prop<Option<SharedString>>,
    /// The inline style of each item's row, over its classes: its text
    /// styles too (`color`, `fontSize`), which its label inherits.
    #[prop(default)]
    pub item_style: Prop<TextPartStyle>,
    /// An item's row drawn by the app (its icon, its label indented by
    /// `depth`, a chevron, a badge), for the rows in view; without it a
    /// row shows the item's label.
    pub render_item: Prop<Option<Renderer<TreeEntry>>>,
}

/// The events of a [`Tree`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum TreeEvent {
    /// The user expanded or collapsed an item (a press, Return or Space,
    /// Right or Left, a ref's `revealItem`): the expanded items' ids as
    /// they would be. Set `expanded` to follow it.
    #[args(expanded)]
    ExpandedChange(Vec<SharedString>),
    /// The user selected another item (a press, the arrows, Home or End,
    /// typeahead): its id. Set `selected` to follow it.
    #[args(selected)]
    SelectedChange(SharedString),
    /// The user expanded the item of `id` (`gpui-base`'s
    /// `TreeEvent::Expanded`), after `onExpandedChange`.
    #[args(id)]
    Expand(SharedString),
    /// The user collapsed the item of `id` (`gpui-base`'s
    /// `TreeEvent::Collapsed`), after `onExpandedChange`.
    #[args(id)]
    Collapse(SharedString),
    /// The user acted on the item of `id`: Return on a selected leaf (on
    /// a folder Return expands or collapses it), or a double press (a
    /// double click, a double tap) on any item, after the press's own
    /// events. Open a file here, not in `onSelectedChange`, which the
    /// arrows report row by row. Disabled items and a disabled tree never
    /// report it. `gpui-base` has none (`docs/dev/api-naming.md`).
    #[args(id)]
    Action(SharedString),
}

/// The methods of a [`Tree`]'s ref.
pub struct TreeApi {
    focus: ElementRef,
    reveal: Rc<dyn Fn(&str) -> bool>,
}

#[methods]
impl TreeApi {
    /// Takes the keyboard focus, as Tab reaching the tree does
    /// (`gpui-base`'s `TreeState::focus`).
    pub fn focus(&self) {
        self.focus.focus();
    }

    /// Brings the item of `id` into view (`gpui-base`'s
    /// `TreeState::reveal_item`): the items above it are expanded
    /// (reported by `onExpandedChange` and `onExpand`), and its row is
    /// scrolled to once it shows. An unknown id does nothing (and is
    /// logged).
    pub fn reveal_item(&self, id: String) {
        if !(self.reveal)(&id) {
            log::warn!("Tree.revealItem: no item `{id}`");
        }
    }
}

/// The expanded ids, the app's when it sets them, else the tree's own.
#[derive(Clone, Copy)]
struct Expanded {
    controlled: Prop<Option<Vec<SharedString>>>,
    own: Signal<Vec<SharedString>>,
}

impl Expanded {
    fn with<R>(self, f: impl FnOnce(&[SharedString]) -> R) -> R {
        match self.controlled.get() {
            Some(ids) => f(&ids),
            None => self.own.with(|ids| f(ids)),
        }
    }

    fn get_untracked(self) -> Vec<SharedString> {
        self.controlled
            .get_untracked()
            .unwrap_or_else(|| self.own.get_untracked())
    }

    /// The user changed them to `ids`: the tree's own follow while the
    /// app sets none.
    fn change(self, ids: Vec<SharedString>) {
        if self.controlled.get_untracked().is_none() {
            self.own.set(ids);
        }
    }
}

/// The selected id, the app's when it sets one, else the tree's own.
#[derive(Clone, Copy)]
struct Selected {
    controlled: Prop<SelectValue>,
    own: Signal<Option<SharedString>>,
}

impl Selected {
    fn get(self) -> Option<SharedString> {
        match self.controlled.get() {
            SelectValue::Uncontrolled => self.own.get(),
            SelectValue::Controlled(id) => id,
        }
    }

    fn get_untracked(self) -> Option<SharedString> {
        match self.controlled.get_untracked() {
            SelectValue::Uncontrolled => self.own.get_untracked(),
            SelectValue::Controlled(id) => id,
        }
    }

    /// The user selected `id`: whether it is a change to report.
    fn choose(self, id: SharedString) -> bool {
        if self.get_untracked().as_ref() == Some(&id) {
            return false;
        }
        if self.controlled.get_untracked() == SelectValue::Uncontrolled {
            self.own.set(Some(id));
        }
        true
    }
}

/// A node the rows follow (the selection, the cursor), spread over [`LIT`]
/// signals as Solid's `createSelector` does: a row reads the signal of its
/// own node only.
#[derive(Clone, Copy)]
struct Lit(Stored<[Signal<Option<usize>>; LIT]>);

impl Lit {
    /// Follows `node` from now on.
    fn following(node: Memo<Option<usize>>) -> Self {
        let lit = Self(stored(std::array::from_fn::<_, LIT, _>(|_| signal(None))));
        let was = stored(None::<usize>);
        effect(move || {
            let now = node.get();
            untracked(|| {
                let before = was.replace(now);
                if before == now {
                    return;
                }
                batch(|| {
                    if let Some(n) = before {
                        lit.of(n).set(None);
                    }
                    if let Some(n) = now {
                        lit.of(n).set(Some(n));
                    }
                });
            });
        });
        lit
    }

    fn of(self, node: usize) -> Signal<Option<usize>> {
        self.0.with(|lit| lit[node % LIT])
    }

    /// Whether the node followed is `node` (tracked): a move notifies only
    /// the readers of its two nodes' signals.
    fn is(self, node: usize) -> bool {
        self.of(node).get() == Some(node)
    }
}

/// What the rows read of the tree, and what they ask of it.
#[derive(Clone)]
struct TreeModel {
    flat: Memo<Flatted>,
    open: Memo<Rc<Open>>,
    shown: Memo<Shown>,
    /// The selected node.
    selected: Lit,
    /// The node the keys act on ([`Shown::cursor`]).
    cursor: Lit,
    /// The tree has the keyboard focus.
    focused: Signal<bool>,
    disabled: Prop<bool>,
    /// The node whose row takes the screen reader's focus once it shows:
    /// a node that shows, cleared when the items change.
    a11y: Signal<Option<usize>>,
    item_class: Prop<Option<SharedString>>,
    item_style: Prop<TextPartStyle>,
    render_item: Prop<Option<Renderer<TreeEntry>>>,
    /// A press on the row of a node, with its click count.
    press: Rc<dyn Fn(usize, u32)>,
}

/// Items that hold items (a project's files, a settings sidebar, an
/// outline), virtualized: only the rows in view are made, and the children
/// of a collapsed item never are. The expanded items are `expanded` and
/// `onExpandedChange` (or the tree's own, from `defaultExpanded`), the
/// selected one `selected` and `onSelectedChange` (or its own). A press on
/// a row selects it and expands or collapses a folder; a double press acts
/// on the item (`onAction`: open a file). The tree is one stop of the
/// keyboard focus: Up and Down move the selection between the rows shown
/// (past disabled items, around the ends), Right expands a folder and then
/// moves to its first enabled child, Left collapses it and then moves to
/// its parent, Home and End go to the first and last row, Return and Space
/// expand or collapse a folder, Return acts on a leaf (`onAction`), and
/// letters and digits select by typeahead; a selection hidden under a
/// collapsed item is acted on from that item's row. It looks like nothing: the app sizes it (`class`), styles the
/// rows (`itemClass` with `selected:`, `aria-expanded:`, `focus:` and
/// `disabled:`) and draws them (`renderItem`, given each item's depth).
/// Screen readers hear a tree of items, each with its level, whether it is
/// expanded and whether it is selected. In a terminal a row the tree draws
/// itself (no `renderItem`) is its label indented two Cells a level after
/// the terminal's own disclosure, `▸ ` collapsed, `▾ ` expanded, two
/// spaces on a leaf ([`crate::terminal`]).
#[component(methods = TreeApi)]
pub fn Tree(props: TreeProps, cx: Scope<TreeEvent>) -> impl IntoElement {
    let expanded = Expanded {
        controlled: props.expanded,
        own: signal(props.default_expanded.get_untracked()),
    };
    let selected = Selected {
        controlled: props.selected,
        own: signal(props.default_selected.get_untracked()),
    };
    let flat = computed(move || Flatted(Rc::new(props.items.with(|items| Flat::new(items)))));
    let open = computed(move || {
        let flat = flat.get().0;
        expanded.with(|ids| Rc::new(flat.open(ids)))
    });
    let shown = computed(move || {
        let flat = flat.get().0;
        open.with(|open| Shown::new(&flat, open))
    });
    // The selected node.
    let current = computed(move || {
        let id = selected.get()?;
        flat.with(|f| f.0.find(&id))
    });
    // The node the keys act on: it shows.
    let cursor = computed(move || {
        let node = current.get();
        flat.with(|f| shown.with(|s| s.cursor(&f.0, node)))
    });
    let lit_selected = Lit::following(current);
    let lit_cursor = Lit::following(cursor);
    let root = element_ref();
    let list = element_ref();
    let focused = signal(false);
    let a11y = signal(None::<usize>);
    // A node of the items before: its row may be another's now.
    effect(move || {
        flat.with(|_| ());
        untracked(|| a11y.set(None));
    });
    // The rows wholly in view, as the list last said, and a row to bring
    // there once it says.
    let visible = stored(None::<(usize, usize)>);
    let pending_row = stored(None::<usize>);
    // An item to bring into view once it shows (`revealItem`): at the
    // first change of the rows after the request, then never (an app that
    // refused the expansion does not see its list jump later).
    let pending = stored(None::<SharedString>);
    let typeahead = stored(Typeahead::default());

    let scroll_to = move |row: usize, (first, last): (usize, usize)| {
        if (first..=last).contains(&row) {
            return;
        }
        let at = if row < first { 0.0 } else { 1.0 };
        list.scroll_to_index(row as u32, Percentage(at), px(0.0), false);
    };
    // Row `row` comes into view, once, when it is not wholly there.
    let bring = move |row: usize| match visible.get() {
        Some(v) => scroll_to(row, v),
        None => {
            pending_row.replace(Some(row));
        }
    };
    // The rows changed after `revealItem`: to its item's row, if it shows.
    effect(move || {
        shown.with(|_| ());
        untracked(|| {
            let Some(id) = pending.replace(None) else {
                return;
            };
            let row = flat.with(|f| f.0.find(&id).and_then(|n| shown.with(|s| s.row_of(n))));
            if let Some(row) = row {
                bring(row);
            }
        });
    });
    // Each change of what is expanded (not of the items): the rows after
    // it spring to their places.
    let last_flat = stored(None::<Flatted>);
    effect(move || {
        let now = flat.get();
        open.with(|_| ());
        untracked(|| {
            let same = last_flat.with(|l| l.as_ref() == Some(&now));
            last_flat.replace(Some(now));
            if same && props.reveal.get() && !reduce_motion() {
                list.animate_layout(REVEAL);
            }
        });
    });

    // Expands (`true`) or collapses `node`, reported to the app.
    let set_open = move |node: usize, next: bool| {
        let (id, folder) = flat.with_untracked(|f| (f.0.id(node), f.0.folder(node)));
        let Some(id) = id.filter(|_| folder) else {
            return;
        };
        if open.with_untracked(|o| o.contains(node)) == next {
            return;
        }
        let mut ids = expanded.get_untracked();
        let before = ids.len();
        if next {
            // Already there: a later item of the same id, which never
            // expands (`Flat::new` logs it).
            if !ids.contains(&id) {
                ids.push(id.clone());
            }
        } else {
            ids.retain(|i| *i != id);
        }
        if ids.len() == before {
            return;
        }
        expanded.change(ids.clone());
        cx.emit(TreeEvent::ExpandedChange(ids));
        cx.emit(if next {
            TreeEvent::Expand(id)
        } else {
            TreeEvent::Collapse(id)
        });
    };
    // Selects `node`; by a key it comes into view and screen readers hear
    // of it.
    let select_node = move |node: usize, by_key: bool| {
        let Some(id) = flat.with_untracked(|f| f.0.id(node)) else {
            return;
        };
        if selected.choose(id.clone()) {
            cx.emit(TreeEvent::SelectedChange(id));
        }
        if by_key && let Some(row) = shown.with_untracked(|s| s.row_of(node)) {
            bring(row);
            if untracked(screen_reader) {
                a11y.set(Some(node));
            }
        }
    };
    let step = move |by: Step| {
        let from = current.get_untracked();
        let next = flat.with_untracked(|f| shown.with_untracked(|s| s.step(&f.0, from, by)));
        if let Some(next) = next {
            select_node(next, true);
        }
    };
    let is_open = move |node: usize| open.with_untracked(|o| o.contains(node));
    // The node Right, Left, Return and Space act on: the cursor, the row
    // the focus shows on (with nothing selected, the first enabled row,
    // where Down starts).
    let acted_on = move || cursor.get_untracked();
    // With nothing selected, a key that would leave the cursor where it
    // is selects its row instead, as Down does: it does something.
    let select_unselected = move |node: usize| {
        if current.get_untracked().is_none() {
            select_node(node, true);
        }
    };
    // Right: a collapsed folder expands, an expanded one moves to its
    // first enabled child (WAI-ARIA's tree view, with nothing selected
    // too: the focus is on the cursor's row).
    let right = move || {
        let Some(node) = acted_on() else { return };
        let (folder, enabled) = flat.with_untracked(|f| (f.0.folder(node), f.0.enabled(node)));
        if !folder || !enabled {
            return select_unselected(node);
        }
        if !is_open(node) {
            set_open(node, true);
        } else if let Some(child) =
            flat.with_untracked(|f| f.0.children(node).find(|&c| f.0.enabled(c)))
        {
            select_node(child, true);
        }
    };
    // Left: an expanded folder collapses, anything else moves to its
    // parent (when it is enabled).
    let left = move || {
        let Some(node) = acted_on() else { return };
        let (folder, enabled, parent) =
            flat.with_untracked(|f| (f.0.folder(node), f.0.enabled(node), f.0.parent(node)));
        if folder && enabled && is_open(node) {
            set_open(node, false);
        } else if let Some(parent) = parent.filter(|&p| flat.with_untracked(|f| f.0.enabled(p))) {
            select_node(parent, true);
        } else {
            select_unselected(node);
        }
    };
    let toggle_current = move || {
        let Some(node) = acted_on() else { return };
        if flat.with_untracked(|f| f.0.enabled(node)) {
            set_open(node, !is_open(node));
        }
    };
    // Reports an action on `node` when it is enabled.
    let act = move |node: usize| {
        let id = flat.with_untracked(|f| f.0.id(node).filter(|_| f.0.enabled(node)));
        if let Some(id) = id {
            cx.emit(TreeEvent::Action(id));
        }
    };
    // Return: a folder expands or collapses (the row a hidden selection is
    // under is one), a leaf is acted on (WAI-ARIA's tree view: Return
    // performs the default action of an end node).
    let activate = move || {
        let Some(node) = acted_on() else { return };
        if flat.with_untracked(|f| f.0.folder(node)) {
            toggle_current();
        } else {
            act(node);
        }
    };

    let active = computed(move || focused.get() && !props.disabled.get());
    effect(move || {
        if !active.get() {
            return;
        }
        // The rows run from the right in a right-to-left layout: Left and
        // Right trade places (WAI-ARIA's tree view). Read only while
        // bound: a direction change binds the keys again.
        let rtl = layout_rtl();
        let bind = |keys: &str, repeat: bool, f: Rc<dyn Fn()>| {
            on_key_with(
                keys,
                KeyOptions {
                    when: When::NotEditing,
                    repeat,
                    ..Default::default()
                },
                move |_| f(),
            );
        };
        bind("down", true, Rc::new(move || step(Step::Next)));
        bind("up", true, Rc::new(move || step(Step::Previous)));
        bind("home", false, Rc::new(move || step(Step::First)));
        bind("end", false, Rc::new(move || step(Step::Last)));
        bind(&directed("right", rtl), true, Rc::new(right));
        bind(&directed("left", rtl), true, Rc::new(left));
        bind("enter", false, Rc::new(activate));
        bind("space", false, Rc::new(toggle_current));
    });
    listbox::bind_typeahead(
        move || active.get(),
        Rc::new(move |c| {
            let at = now();
            let from = current.get_untracked();
            let next = typeahead.with(|t| {
                let typed = t.push(c, at);
                flat.with_untracked(|f| shown.with_untracked(|s| s.find_typed(&f.0, from, typed)))
            });
            if let Some(next) = next {
                select_node(next, true);
            }
        }),
    );

    let desktop = is_desktop();
    let press = Rc::new(move |node: usize, clicks: u32| {
        if props.disabled.get_untracked() || !flat.with_untracked(|f| f.0.enabled(node)) {
            return;
        }
        select_node(node, false);
        set_open(node, !is_open(node));
        // The keys go on from the row pressed.
        if desktop && !focused.get_untracked() {
            root.focus();
        }
        // The second press of a double press (a triple one acts once).
        if clicks == 2 {
            act(node);
        }
    });
    cx.methods(TreeApi {
        focus: root,
        reveal: Rc::new(move |id| {
            let Some(node) = flat.with_untracked(|f| f.0.find(id)) else {
                return false;
            };
            let mut ids = expanded.get_untracked();
            // The collapsed items above it, the outermost first.
            let added: Vec<SharedString> = flat.with_untracked(|f| {
                let mut closed: Vec<usize> = f.0.ancestors(node).filter(|&a| !is_open(a)).collect();
                closed.reverse();
                closed.into_iter().filter_map(|a| f.0.id(a)).collect()
            });
            let added: Vec<SharedString> = added.into_iter().filter(|a| !ids.contains(a)).collect();
            let expanding = !added.is_empty();
            if expanding {
                // Before the change: the rows may change while it is made.
                pending.replace(Some(SharedString::from(id.to_owned())));
                ids.extend(added.iter().cloned());
                expanded.change(ids.clone());
                cx.emit(TreeEvent::ExpandedChange(ids));
                for id in added {
                    cx.emit(TreeEvent::Expand(id));
                }
            }
            // Shown at once (nothing to expand, or the tree's own state
            // and the rows not yet followed).
            let waiting = pending.with(|p| p.is_some());
            if (waiting || !expanding)
                && let Some(row) = shown.with_untracked(|s| s.row_of(node))
            {
                pending.replace(None);
                bring(row);
            }
            true
        }),
    });

    let model = TreeModel {
        flat,
        open,
        shown,
        selected: lit_selected,
        cursor: lit_cursor,
        focused,
        disabled: props.disabled,
        a11y,
        item_class: props.item_class,
        item_style: props.item_style,
        render_item: props.render_item,
        press,
    };
    let rows = virtual_list(
        move || shown.with(|s| s.rows.len()),
        move |at| row(model.clone(), at),
    )
    .keys(move || shown.with(|s| s.keys.clone()))
    .viewport(ListViewport::Parent)
    .viewability(Viewability {
        item_visible_threshold: Some(IN_VIEW),
        ..Viewability::default()
    })
    .on_viewable_items_change(move |v: &ViewableItems| {
        visible.replace(v.viewable);
        if let Some(v) = v.viewable
            && let Some(row) = pending_row.replace(None)
        {
            scroll_to(row, v);
        }
    })
    .element_ref(&list);
    view()
        .element_ref(&root)
        .role(AccessibilityRole::Tree)
        .optional_label(props.accessibility_label)
        .focusable(move || !props.disabled.get())
        .accessibility_state(move || AccessibilityState {
            disabled: props.disabled.get(),
            ..AccessibilityState::default()
        })
        .on_focus(move || {
            focused.set(true);
            // The screen reader's focus goes to the row the keys act on.
            untracked(|| {
                if screen_reader()
                    && let Some(node) = cursor.get()
                    && let Some(row) = shown.with(|s| s.row_of(node))
                {
                    bring(row);
                    a11y.set(Some(node));
                }
            });
        })
        .on_blur(move || focused.set(false))
        .child(
            scroll()
                .flex_grow(1.0)
                .flex_shrink(1.0)
                .min_h(px(0.0))
                .app_class(props.list_class)
                .inline_style(props.list_style)
                .child(rows),
        )
}

/// The row the list shows at `at`: an item, its state its classes'.
fn row(m: TreeModel, at: Position) -> AnyElement {
    let shown = m.shown;
    let node = computed(move || shown.with(|s| s.rows.get(at.index()).map(|&n| n as usize)));
    let flat = m.flat;
    let entry = computed(move || node.get().and_then(|n| flat.with(|f| f.0.entry(n))));
    let disabled = {
        let tree = m.disabled;
        computed(move || tree.get() || entry.with(|e| e.as_ref().is_some_and(|e| e.disabled)))
    };
    let selected = {
        let lit = m.selected;
        computed(move || node.get().is_some_and(|n| lit.is(n)))
    };
    let at_cursor = {
        let lit = m.cursor;
        computed(move || node.get().is_some_and(|n| lit.is(n)))
    };
    let open = m.open;
    let expanded = computed(move || {
        let n = node.get()?;
        let folder = entry.with(|e| e.as_ref().is_some_and(|e| e.folder));
        folder.then(|| open.with(|o| o.contains(n)))
    });
    let focused = m.focused;
    let me = element_ref();
    // A key moved the cursor here, or the tree took the keyboard focus:
    // the screen reader's focus follows.
    let a11y = m.a11y;
    effect(move || {
        let Some(n) = node.get() else { return };
        if a11y.get() == Some(n) {
            untracked(|| {
                me.set_accessibility_focus();
                a11y.set(None);
            });
        }
    });
    let press = m.press.clone();
    let render_item = m.render_item;
    let custom = computed(move || render_item.with(Option::is_some));
    let label = move || entry.with(|e| e.as_ref().map(|e| e.label.clone()).unwrap_or_default());
    let terminal = is_terminal();
    view()
        .role(AccessibilityRole::TreeItem)
        .focusable(false)
        .disabled(disabled)
        .label(label)
        .accessibility_level(move || entry.with(|e| e.as_ref().map_or(1, |e| e.depth + 1)))
        .accessibility_state(move || AccessibilityState {
            selected: selected.get(),
            disabled: disabled.get(),
            expanded: expanded.get(),
            ..AccessibilityState::default()
        })
        .project_focused(move || at_cursor.get() && focused.get())
        .app_class(m.item_class)
        .inline_style(move || m.item_style.get())
        .element_ref(&me)
        .on_press(move |e: &PressEvent| {
            if let Some(n) = node.get_untracked() {
                press(n, e.clicks);
            }
        })
        .child(dynamic(move || {
            if custom.get() {
                return dynamic(move || {
                    let render = render_item.get()?;
                    let entry = entry.get()?;
                    Some(render.render(entry.id.clone(), entry))
                });
            }
            if terminal {
                return text(move || {
                    let depth = entry.with(|e| e.as_ref().map_or(0, |e| e.depth)) as usize;
                    let mark = expanded.get().map_or(DISCLOSURE_NONE, disclosure);
                    SharedString::from(format!(
                        "{:indent$}{mark}{}",
                        "",
                        label(),
                        indent = depth * TREE_INDENT
                    ))
                })
                .into_element();
            }
            text(label).into_element()
        }))
        .into_element()
}

#[cfg(test)]
mod tests {
    use nsh_core::prelude::SharedString;

    use super::{Flat, Shown, Step, TreeItem};

    /// src (lib.rs, ui (tree.rs, list.rs)), docs (guide.md, disabled
    /// old.md), README.md.
    fn items() -> Vec<TreeItem> {
        vec![
            TreeItem::new("src", "src")
                .child(TreeItem::new("src/lib.rs", "lib.rs"))
                .child(
                    TreeItem::new("src/ui", "ui")
                        .child(TreeItem::new("src/ui/tree.rs", "tree.rs"))
                        .child(TreeItem::new("src/ui/list.rs", "list.rs")),
                ),
            TreeItem::new("docs", "docs")
                .child(TreeItem::new("docs/guide.md", "guide.md"))
                .child(TreeItem::new("docs/old.md", "old.md").disabled(true)),
            TreeItem::new("README.md", "README.md"),
        ]
    }

    fn ids(flat: &Flat, shown: &Shown) -> Vec<String> {
        shown
            .rows
            .iter()
            .map(|&n| flat.nodes[n as usize].id.to_string())
            .collect()
    }

    fn shown(flat: &Flat, open: &[&str]) -> Shown {
        let open: Vec<SharedString> = open.iter().map(|&s| s.to_owned().into()).collect();
        Shown::new(flat, &flat.open(&open))
    }

    #[test]
    fn the_items_flatten_depth_first_with_parents_depths_and_subtrees() {
        let flat = Flat::new(&items());
        let at = |id: &str| flat.find(id).unwrap();
        assert_eq!(flat.nodes.len(), 9);
        assert_eq!(flat.nodes[at("src/ui/tree.rs")].depth, 2);
        assert_eq!(flat.parent(at("src/ui/tree.rs")), Some(at("src/ui")));
        assert_eq!(
            flat.ancestors(at("src/ui/list.rs")).collect::<Vec<_>>(),
            [at("src/ui"), at("src")]
        );
        assert!(flat.folder(at("src/ui")));
        assert!(!flat.folder(at("src/lib.rs")));
        assert!(!flat.folder(at("README.md")));
        assert_eq!(flat.nodes[at("src")].end as usize, at("docs"));
    }

    #[test]
    fn rows_show_the_children_of_expanded_items_whose_ancestors_are_expanded() {
        let flat = Flat::new(&items());
        assert_eq!(ids(&flat, &shown(&flat, &[])), ["src", "docs", "README.md"]);
        assert_eq!(
            ids(&flat, &shown(&flat, &["src"])),
            ["src", "src/lib.rs", "src/ui", "docs", "README.md"]
        );
        // `src/ui` expanded under a collapsed `src`: hidden.
        assert_eq!(
            ids(&flat, &shown(&flat, &["src/ui"])),
            ["src", "docs", "README.md"]
        );
        // A leaf or an unknown id expands nothing.
        assert_eq!(
            ids(&flat, &shown(&flat, &["README.md", "nope"])),
            ["src", "docs", "README.md"]
        );
    }

    #[test]
    fn steps_pass_disabled_rows_and_go_around_the_ends() {
        let flat = Flat::new(&items());
        let s = shown(&flat, &["docs"]);
        let at = |id: &str| flat.find(id).unwrap();
        let step = |from: Option<&str>, by| {
            s.step(&flat, from.map(at), by)
                .map(|n| flat.nodes[n].id.to_string())
        };
        assert_eq!(step(None, Step::Next).as_deref(), Some("src"));
        assert_eq!(step(None, Step::Previous).as_deref(), Some("README.md"));
        // guide.md → README.md: old.md is disabled.
        assert_eq!(
            step(Some("docs/guide.md"), Step::Next).as_deref(),
            Some("README.md")
        );
        assert_eq!(
            step(Some("README.md"), Step::Previous).as_deref(),
            Some("docs/guide.md")
        );
        assert_eq!(step(Some("README.md"), Step::Next).as_deref(), Some("src"));
        assert_eq!(
            step(Some("src"), Step::Previous).as_deref(),
            Some("README.md")
        );
        assert_eq!(step(Some("docs"), Step::Last).as_deref(), Some("README.md"));
        // From a hidden node: from its nearest shown ancestor's row.
        assert_eq!(
            step(Some("src/ui/tree.rs"), Step::Next).as_deref(),
            Some("docs")
        );
    }

    #[test]
    fn typeahead_finds_the_next_enabled_label_starting_with_what_was_typed() {
        let flat = Flat::new(&items());
        let s = shown(&flat, &["src", "docs"]);
        let at = |id: &str| flat.find(id).unwrap();
        let typed = |from: Option<&str>, t: &str| {
            s.find_typed(&flat, from.map(at), t)
                .map(|n| flat.nodes[n].id.to_string())
        };
        assert_eq!(typed(None, "d").as_deref(), Some("docs"));
        // The same letter moves on; `old.md` is disabled.
        assert_eq!(typed(Some("docs"), "d").as_deref(), Some("docs"));
        assert_eq!(typed(Some("src"), "l").as_deref(), Some("src/lib.rs"));
        assert_eq!(typed(Some("src/lib.rs"), "o").as_deref(), None);
        assert_eq!(typed(Some("src"), "re").as_deref(), Some("README.md"));
        // Folded as it is compared: `README.md` by `READ`'s lower case.
        assert!(super::starts_folded("README.md", "read"));
        assert!(!super::starts_folded("RE", "read"));
    }

    #[test]
    fn children_are_a_folders_items_one_level_under_it() {
        let flat = Flat::new(&items());
        let at = |id: &str| flat.find(id).unwrap();
        let ids = |node| {
            flat.children(node)
                .map(|c| flat.nodes[c].id.to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(at("src")), ["src/lib.rs", "src/ui"]);
        assert_eq!(ids(at("docs")), ["docs/guide.md", "docs/old.md"]);
        assert!(ids(at("README.md")).is_empty());
        assert!(ids(at("src/ui/list.rs")).is_empty());
    }

    #[test]
    fn the_cursor_is_the_selection_its_nearest_shown_ancestor_or_the_first_row() {
        let flat = Flat::new(&items());
        let at = |id: &str| flat.find(id).unwrap();
        let cursor = |open: &[&str], selected: Option<&str>| {
            shown(&flat, open)
                .cursor(&flat, selected.map(at))
                .map(|n| flat.nodes[n].id.to_string())
        };
        assert_eq!(
            cursor(&["src", "src/ui"], Some("src/ui/tree.rs")).as_deref(),
            Some("src/ui/tree.rs")
        );
        // `src/ui` collapsed: its row; everything collapsed: `src`'s.
        assert_eq!(
            cursor(&["src"], Some("src/ui/tree.rs")).as_deref(),
            Some("src/ui")
        );
        assert_eq!(
            cursor(&["src/ui"], Some("src/ui/tree.rs")).as_deref(),
            Some("src")
        );
        assert_eq!(cursor(&[], None).as_deref(), Some("src"));
    }

    #[test]
    fn the_expanded_nodes_are_the_folders_of_the_ids_each_once() {
        let flat = Flat::new(&items());
        let at = |id: &str| flat.find(id).unwrap();
        let ids: Vec<SharedString> = ["docs", "src", "README.md", "docs", "nope"]
            .into_iter()
            .map(SharedString::from)
            .collect();
        let open = flat.open(&ids);
        assert_eq!(open.0, [at("src") as u32, at("docs") as u32]);
        assert!(open.contains(at("docs")));
        assert!(!open.contains(at("README.md")));
    }

    #[test]
    fn an_id_given_twice_names_its_first_item() {
        let flat = Flat::new(&[
            TreeItem::new("x", "first").child(TreeItem::new("x/a", "a")),
            TreeItem::new("x", "second").child(TreeItem::new("x/b", "b")),
        ]);
        assert_eq!(flat.nodes.len(), 4);
        assert_eq!(flat.find("x"), Some(0));
        let s = shown(&flat, &["x"]);
        assert_eq!(s.rows, [0, 1, 2]);
    }
}

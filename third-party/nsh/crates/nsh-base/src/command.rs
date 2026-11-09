//! `Command`: a command palette, a search field over a filtered list of
//! commands, with no look of its own (`gpui-component`'s `Command`;
//! `gpui-base` has none).
//!
//! - **The model** (pure, tested on its own): the app's `items` indexed
//!   once per change of them ([`Index`]: each item's label and keywords in
//!   lower case, its section, its row key hashed, its id), and the rows a
//!   query shows ([`Shown`]: the items whose label or a keyword holds the
//!   query, ignoring case, in their order; adjacent items of one `group`
//!   form a section under a header, a section with no match goes, and a
//!   separator goes between two sections shown). A query that holds the
//!   last one (a character typed) searches only its matches. The moves of
//!   the highlight and typeahead are `Select`'s (`listbox.rs`'s
//!   [`listbox::step_among`], [`listbox::find_typed_among`]).
//! - **The view**: the app's `header`, the search field (with the app's
//!   `searchPrefix` and `searchSuffix` beside it), the rows in a
//!   virtualized list (`viewport: parent`) in a scroll view, the app's
//!   `empty` while no item shows (and no search is `loading`), the app's
//!   `footer`. A row's look is the app's (`itemClass`, `renderItem`, which
//!   gets what the item is, never its state); its states are its classes'
//!   (`focus:` while highlighted, `checked:`, `disabled:`), so the app's
//!   drawing of a row is made once per item.
//! - **Its cost**: a move of the highlight notifies the two rows it leaves
//!   and reaches (spread over [`LIT`] signals, as `Select`'s highlight);
//!   a query filters natively and the rows keep their cells by key.
//!
//! The keys are bound while the search field (or, without one, the
//! command, then one stop of the keyboard focus) has the focus: Up and
//! Down move the highlight past disabled items and around the ends, Page
//! Up and Down by a page, Return chooses (`onSelect`), Escape clears the
//! query and, once it is empty, is `onCancel` (the app closes the `Dialog`
//! around it). The highlighted row is projected `focus:` (NSH has no
//! active descendant): the keyboard's focus stays in the search field, and
//! screen readers hear the highlighted label.

use std::{
    hash::{Hash, Hasher},
    rc::Rc,
};

use nsh_core::{
    AccessibilityState, Checked,
    element::{InputPartStyle, Style, TextPartStyle, input},
    keymap::{Keystroke, When},
    prelude::*,
    time::now,
};
use rustc_hash::{FxHashMap, FxHasher};

use crate::listbox::{self, Move, Typeahead, Via};

/// How many signals the highlight is spread over for the rows to read
/// ([`Palette::is_highlighted`]): more than the rows a list shows.
const LIT: usize = 32;

/// A row is in view when this much of it shows.
const IN_VIEW: Percentage = Percentage(0.995);

/// The rows a page moves by before the list says how many show.
const PAGE: usize = 10;

/// A command of a [`Command`].
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct CommandItem {
    /// What identifies it in `onSelect` and `onHighlightChange`: the
    /// app's, unique among the items, never its label.
    pub id: SharedString,
    /// Its label: what its row shows (unless `renderItem` draws it), what
    /// screen readers say, and what the query and typeahead match.
    pub label: SharedString,
    /// More words the query matches besides the label (`gpui-component`'s
    /// `CommandItem::keywords`): synonyms, an English name for a
    /// translated label.
    #[prop(default)]
    pub keywords: Vec<SharedString>,
    /// Its section: adjacent items of one group show under a header with
    /// this heading (`renderGroup` draws it otherwise).
    #[prop(skip_none)]
    pub group: Option<SharedString>,
    /// The keystroke that runs the same command, as `keymap` names it
    /// (`"mod+shift+p"`), for its row to show (`renderItem` gets it with
    /// its label here): the app binds it (`keymap.bind`).
    #[prop(skip_none)]
    pub shortcut: Option<SharedString>,
    /// It cannot be chosen: the keys pass over it, presses do nothing,
    /// `disabled:` styles apply and screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: bool,
    /// It is the one in effect (a theme, a language): `checked:` styles
    /// apply to its row and screen readers say it is checked.
    #[prop(default)]
    pub checked: bool,
}

impl CommandItem {
    /// A command of `id`, labelled `label`.
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            ..Self::default()
        }
    }

    /// More words the query matches ([`CommandItem::keywords`]).
    pub fn keywords<I, S>(mut self, keywords: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<SharedString>,
    {
        self.keywords.extend(keywords.into_iter().map(Into::into));
        self
    }

    /// Its section ([`CommandItem::group`]).
    pub fn group(mut self, group: impl Into<SharedString>) -> Self {
        self.group = Some(group.into());
        self
    }

    /// The keystroke its row shows ([`CommandItem::shortcut`]).
    pub fn shortcut(mut self, keys: impl Into<SharedString>) -> Self {
        self.shortcut = Some(keys.into());
        self
    }

    /// Whether it cannot be chosen ([`CommandItem::disabled`]).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Whether it is the one in effect ([`CommandItem::checked`]).
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }
}

/// A command's row as `renderItem` draws it: what the item is, never its
/// state, so the drawing is made once per item and keeps its views while
/// the highlight moves. The highlight is the row's `focus:` (with `group`
/// in `itemClass`, its content's `group-focus:`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct CommandEntry {
    /// The item's `id`.
    pub id: SharedString,
    /// The item's `label`.
    pub label: SharedString,
    /// The item's `keywords`.
    pub keywords: Vec<SharedString>,
    /// The item's `group`.
    #[prop(skip_none)]
    pub group: Option<SharedString>,
    /// The item's `shortcut`.
    #[prop(skip_none)]
    pub shortcut: Option<SharedString>,
    /// The item's `shortcut` as hints show it here (`keymap.label`): `⇧⌘P`
    /// on Apple's platforms, `Ctrl+Shift+P` elsewhere.
    #[prop(skip_none)]
    pub shortcut_label: Option<SharedString>,
    /// The item's `disabled`.
    pub disabled: bool,
    /// The item's `checked`.
    pub checked: bool,
}

impl CommandEntry {
    fn of(item: &CommandItem) -> Self {
        let shortcut_label = item.shortcut.as_deref().and_then(|keys| {
            let apple = apple_keys();
            match Keystroke::parse_with(keys, apple) {
                Ok(k) => Some(SharedString::from(keystroke_label(k))),
                Err(e) => {
                    log::warn!("Command: the shortcut of `{}`: {e}", item.id);
                    None
                }
            }
        });
        Self {
            id: item.id.clone(),
            label: item.label.clone(),
            keywords: item.keywords.clone(),
            group: item.group.clone(),
            shortcut: item.shortcut.clone(),
            shortcut_label,
            disabled: item.disabled,
            checked: item.checked,
        }
    }
}

/// A section's header as `renderGroup` draws it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct CommandGroup {
    /// The section's `group`.
    pub heading: SharedString,
}

/// What the list keeps of its items for every query, made again only when
/// the items change: a keystroke in the search field folds no label and
/// hashes no key.
#[derive(Debug)]
struct Index {
    /// Each item's label, then each of its keywords on a line of its own,
    /// in lower case: what queries match (a query is one line, so it never
    /// spans two of them) and typeahead (which starts on the label).
    folded: Box<[Box<str>]>,
    /// The first item of each item's section (adjacent items of one
    /// `group`).
    section: Box<[u32]>,
    /// Each item's row key, hashed.
    keys: Box<[u64]>,
    /// Each id's item (the first of an id given twice).
    ids: FxHashMap<SharedString, u32>,
}

impl Index {
    fn new(items: &[CommandItem]) -> Self {
        let mut start = 0;
        let section = items
            .iter()
            .enumerate()
            .map(|(i, item)| {
                if i > 0 && items[i - 1].group != item.group {
                    start = i as u32;
                }
                start
            })
            .collect();
        let folded = items
            .iter()
            .map(|item| {
                let mut text = item.label.to_lowercase();
                for keyword in &item.keywords {
                    text.push('\n');
                    text.push_str(&keyword.to_lowercase());
                }
                text.into_boxed_str()
            })
            .collect();
        let mut ids = FxHashMap::default();
        for (at, item) in items.iter().enumerate() {
            ids.entry(item.id.clone()).or_insert(at as u32);
        }
        Self {
            folded,
            section,
            keys: items.iter().map(|i| hash(&(1u8, &i.id))).collect(),
            ids,
        }
    }

    fn find(&self, id: &str) -> Option<usize> {
        self.ids.get(id).map(|&i| i as usize)
    }
}

/// The [`Index`] of the items now, compared by identity: a new one is
/// another, and no label is compared again.
#[derive(Clone)]
struct Indexed(Rc<Index>);

impl PartialEq for Indexed {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}

fn hash(value: &impl Hash) -> u64 {
    let mut h = FxHasher::default();
    value.hash(&mut h);
    h.finish()
}

/// The items whose folded text holds `query` (folded; every item for an
/// empty one), in their order: among `among` when given (the matches of a
/// query this one holds, which hold all of its matches).
fn matching(index: &Index, query: &str, among: Option<&[u32]>) -> Vec<u32> {
    let hit = |i: &u32| query.is_empty() || index.folded[*i as usize].contains(query);
    match among {
        Some(among) => among.iter().copied().filter(hit).collect(),
        None => (0..index.folded.len() as u32).filter(hit).collect(),
    }
}

/// The last query the rows were made for, and its matches: a query that
/// holds it (one more character typed) searches only them.
struct Narrow {
    index: Rc<Index>,
    query: String,
    matches: Vec<u32>,
}

/// A row of the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Row {
    /// The header of the section of items whose `group` is `heading`, the
    /// first of which is item `first`.
    Header {
        /// The section's `group`.
        heading: SharedString,
        /// Its first item.
        first: usize,
    },
    /// Between two sections shown.
    Separator,
    /// Item `0`.
    Item(usize),
}

/// The rows the items show for a query, with what the highlight's moves
/// look up in them.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Shown {
    /// The rows: the items whose label or a keyword holds the query,
    /// ignoring case (every item for an empty one), in their order; a
    /// header before the first item shown of each section with a group, a
    /// separator between two sections shown.
    pub(crate) rows: Vec<Row>,
    /// The items shown, `(row, item)`, in order (both increase).
    items: Vec<(u32, u32)>,
    /// The enabled ones among them.
    enabled: Vec<(u32, u32)>,
    /// The rows' keys, hashed, so rows keep their cells as the query
    /// changes.
    keys: Vec<u64>,
}

impl Shown {
    /// The rows of `matches` (indices of `items`, increasing), with a
    /// separator between two sections when `separators`.
    fn new(items: &[CommandItem], index: &Index, matches: &[u32], separators: bool) -> Self {
        let mut shown = Self {
            rows: Vec::with_capacity(matches.len()),
            items: Vec::with_capacity(matches.len()),
            enabled: Vec::with_capacity(matches.len()),
            keys: Vec::with_capacity(matches.len()),
        };
        let mut section = None;
        for &i in matches {
            let (item, start) = (&items[i as usize], index.section[i as usize]);
            if section != Some(start) {
                // A separator only once a section was shown before this
                // one: never leading, trailing or doubled.
                if separators && section.is_some() {
                    shown.keys.push(hash(&(2u8, start)));
                    shown.rows.push(Row::Separator);
                }
                section = Some(start);
                // Keyed by the section's first item, shown or not, so the
                // header keeps its cell whatever the query hides.
                if let Some(heading) = &item.group {
                    shown.keys.push(hash(&(0u8, heading, start)));
                    shown.rows.push(Row::Header {
                        heading: heading.clone(),
                        first: start as usize,
                    });
                }
            }
            let row = shown.rows.len() as u32;
            shown.rows.push(Row::Item(i as usize));
            shown.keys.push(index.keys[i as usize]);
            shown.items.push((row, i));
            if !item.disabled {
                shown.enabled.push((row, i));
            }
        }
        shown
    }

    /// The rows `items` show for `query`, made at once.
    #[cfg(test)]
    fn of(items: &[CommandItem], query: &str, separators: bool) -> Self {
        let index = Index::new(items);
        Self::new(
            items,
            &index,
            &matching(&index, &query.trim().to_lowercase(), None),
            separators,
        )
    }

    /// The row of item `item`, if it is shown.
    fn row_of(&self, item: usize) -> Option<usize> {
        let at = self
            .items
            .binary_search_by_key(&(item as u32), |&(_, i)| i)
            .ok()?;
        Some(self.items[at].0 as usize)
    }

    /// Whether item `item` is shown and enabled.
    fn is_enabled(&self, item: usize) -> bool {
        self.enabled
            .binary_search_by_key(&(item as u32), |&(_, i)| i)
            .is_ok()
    }

    /// Where the highlight goes from item `from` by `by`, among the
    /// enabled items shown.
    fn step(&self, from: Option<usize>, by: Move) -> Option<usize> {
        let at = from.and_then(|f| self.row_of(f)).map(|r| r as u32);
        listbox::step_among(&self.enabled, at, by)
    }

    /// The enabled item typeahead's `typed` jumps to from item `from`.
    fn find_typed(&self, folded: &[Box<str>], from: Option<usize>, typed: &str) -> Option<usize> {
        let at = from.and_then(|f| self.row_of(f)).map(|r| r as u32);
        listbox::find_typed_among(&self.enabled, at, folded, typed)
    }
}

/// The props of [`Command`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CommandProps {
    /// The commands, in order.
    #[prop(default)]
    pub items: Prop<Vec<CommandItem>>,
    /// The query (controlled): the app owns it and sets the one
    /// `onQueryChange` reports. Without it the search field keeps its own.
    pub query: Prop<Option<SharedString>>,
    /// The query at first, while `query` is not set.
    pub default_query: Prop<Option<SharedString>>,
    /// A search field above the rows (`gpui-component`'s `searchable`,
    /// default `true`). Without it every item shows, and the command is
    /// one stop of the keyboard focus whose letters and digits highlight
    /// by typeahead.
    #[prop(default = true)]
    pub searchable: Prop<bool>,
    /// The query filters the items (default `true`). Off, every item
    /// shows whatever the query (`gpui-component`'s `filterable`): for a
    /// search the app answers itself (a server's, set as `items`), which
    /// `onQueryChange` tells it of; a new query still highlights the first
    /// item.
    #[prop(default = true)]
    pub filterable: Prop<bool>,
    /// The search field's placeholder.
    pub placeholder: Prop<Option<SharedString>>,
    /// The search field takes the keyboard focus once shown (`Input`'s
    /// `autoFocus`): a palette that opens to be typed in.
    #[prop(default)]
    pub auto_focus: Prop<bool>,
    /// A search is under way (`gpui-component`'s `set_loading`): `empty`
    /// does not show while no item does, and the list is busy for screen
    /// readers. The app shows its own indicator (`searchSuffix`).
    #[prop(default)]
    pub loading: Prop<bool>,
    /// A separator row between two sections shown (default `true`), styled
    /// by `separatorClass`: never first, last or doubled.
    #[prop(default = true)]
    pub separator: Prop<bool>,
    /// What screen readers call the list, and the search field while
    /// `searchAccessibilityLabel` is not set.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// What screen readers call the search field (default
    /// `accessibilityLabel`): what it searches, apart from the list's name.
    pub search_accessibility_label: Prop<Option<SharedString>>,
    /// The classes of the search bar: the row of `searchPrefix`, the
    /// search field and `searchSuffix`.
    pub search_bar_class: Prop<Option<SharedString>>,
    /// The inline style of the search bar, over its classes.
    #[prop(default)]
    pub search_bar_style: Prop<Style>,
    /// The classes of the search field.
    pub search_class: Prop<Option<SharedString>>,
    /// The inline style of the search field, over its classes: its text
    /// styles too (`color`, `fontSize`, `placeholderColor`).
    #[prop(default)]
    pub search_style: Prop<InputPartStyle>,
    /// The classes of the list, the scroll view of the rows (its height:
    /// `max-h-*` for the rows to scroll and only those in view to be
    /// made).
    pub list_class: Prop<Option<SharedString>>,
    /// The inline style of the list, over its classes.
    #[prop(default)]
    pub list_style: Prop<Style>,
    /// The classes of each item's row: `focus:` while highlighted (the
    /// keys or the pointer are on it), `checked:` while `checked`,
    /// `disabled:` while it cannot be chosen, `hover:` and `active:`;
    /// `group` for its content to follow them (`group-focus:`).
    pub item_class: Prop<Option<SharedString>>,
    /// The inline style of each item's row, over its classes: its text
    /// styles too (`color`, `fontSize`), which its label inherits.
    #[prop(default)]
    pub item_style: Prop<TextPartStyle>,
    /// The classes of each section's header.
    pub group_class: Prop<Option<SharedString>>,
    /// The inline style of each section's header, over its classes: its
    /// text styles too, which its heading inherits.
    #[prop(default)]
    pub group_style: Prop<TextPartStyle>,
    /// The classes of each separator (with `separator`): a rule's height
    /// and color.
    pub separator_class: Prop<Option<SharedString>>,
    /// The inline style of each separator, over its classes.
    #[prop(default)]
    pub separator_style: Prop<Style>,
    /// What shows above the search field (`gpui-component`'s `header`): a
    /// title, a breadcrumb.
    pub header: Prop<Option<Slot>>,
    /// What shows below the rows (`gpui-component`'s `footer`): the keys'
    /// hints, a count.
    pub footer: Prop<Option<Slot>>,
    /// What shows while no item does (`gpui-component`'s `empty`): a
    /// query that matches nothing, no items; not while `loading`.
    pub empty: Prop<Option<Slot>>,
    /// What shows before the search field in its bar: a search icon.
    pub search_prefix: Prop<Option<Slot>>,
    /// What shows after the search field in its bar: a spinner while
    /// `loading`, a shortcut's hint.
    pub search_suffix: Prop<Option<Slot>>,
    /// An item's row drawn by the app (an icon, the label, the shortcut's
    /// keys), for the rows in view; without it a row shows the item's
    /// label.
    pub render_item: Prop<Option<Renderer<CommandEntry>>>,
    /// A section's header drawn by the app; without it a header shows its
    /// heading.
    pub render_group: Prop<Option<Renderer<CommandGroup>>>,
}

/// The events of a [`Command`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum CommandEvent {
    /// The user chose an item (Return, a press; `gpui-component`'s
    /// `on_confirm`): its id.
    #[args(id)]
    Select(SharedString),
    /// The highlight moved (the keys, the pointer, a new query or new
    /// items, the ref's `highlight`; `gpui-component`'s `on_select`): the
    /// highlighted item's id, `null` while none is.
    #[args(highlighted)]
    HighlightChange(Option<SharedString>),
    /// The user typed in the search field, or Escape cleared it: the
    /// query. Set `query` to follow it.
    #[args(query)]
    QueryChange(SharedString),
    /// Escape with an empty query (`gpui-component`'s `on_cancel`): close
    /// what holds the command (a `Dialog`'s `open`).
    Cancel,
}

/// The methods of a [`Command`]'s ref.
pub struct CommandApi {
    focus: Rc<dyn Fn()>,
    highlight: Rc<dyn Fn(&str) -> bool>,
    count: Rc<dyn Fn() -> u32>,
}

#[methods]
impl CommandApi {
    /// Takes the keyboard focus (`gpui-component`'s `CommandState::focus`):
    /// the search field, else the command.
    pub fn focus(&self) {
        (self.focus)();
    }

    /// Highlights the item of `id` and brings it into view
    /// (`gpui-component`'s `set_selected_index`). An item that is not
    /// shown, a disabled one or an unknown id does nothing (and is
    /// logged).
    pub fn highlight(&self, id: String) {
        if !(self.highlight)(&id) {
            log::warn!("Command.highlight: no item `{id}` shown and enabled");
        }
    }

    /// How many items the query shows (`gpui-component`'s
    /// `matched_count`), disabled ones included.
    pub fn matched_count(&self) -> u32 {
        (self.count)()
    }
}

/// The list's state: its rows for the query, the highlighted item, and
/// what reveals it.
#[derive(Clone, Copy)]
struct Palette {
    items: Prop<Vec<CommandItem>>,
    searchable: Prop<bool>,
    index: Memo<Indexed>,
    shown: Memo<Shown>,
    /// The highlighted item, by its index among the items.
    highlight: Signal<Option<usize>>,
    /// The highlight as each row reads it ([`Palette::is_highlighted`]).
    lit: Stored<[Signal<Option<usize>>; LIT]>,
    /// Its id, which the highlight follows when the items change.
    highlighted: Stored<Option<SharedString>>,
    /// The rows wholly in view, as the list last said.
    visible: Stored<Option<(usize, usize)>>,
    /// A row to reveal once the list says what is in view.
    reveal: Stored<Option<usize>>,
    /// The list, which scrolls its scroll view to a row.
    list: ElementRef,
    /// Where the pointer last was over the rows.
    pointer: Stored<Option<Point<Points>>>,
    typeahead: Stored<Typeahead>,
    /// The item whose row takes the screen reader's focus once it shows.
    a11y: Signal<Option<usize>>,
    cx: Scope<CommandEvent>,
}

impl Palette {
    fn id_of(self, item: usize) -> Option<SharedString> {
        self.items
            .with_untracked(|items| items.get(item).map(|i| i.id.clone()))
    }

    /// Highlights `item`, reported when it is another item; by a key it is
    /// revealed and screen readers hear of it.
    fn set_highlight(self, item: Option<usize>, via: Via) {
        let id = item.and_then(|i| self.id_of(i));
        let changed = self.highlighted.with(|h| *h != id);
        self.highlighted.replace(id.clone());
        let was = self.highlight.get_untracked();
        if was != item {
            batch(|| {
                if let Some(was) = was {
                    self.lit_of(was).set(None);
                }
                if let Some(item) = item {
                    self.lit_of(item).set(Some(item));
                }
                self.highlight.set(item);
            });
        }
        if changed {
            self.cx.emit(CommandEvent::HighlightChange(id));
        }
        if via == Via::Keyboard
            && let Some(item) = item
        {
            self.reveal(item);
            self.tell_screen_reader(item);
        }
    }

    fn lit_of(self, item: usize) -> Signal<Option<usize>> {
        self.lit.with(|lit| lit[item % LIT])
    }

    /// Whether `item` is highlighted (tracked): a move notifies only the
    /// readers of its two items' signals, the rows that changed.
    fn is_highlighted(self, item: usize) -> bool {
        self.lit_of(item).get() == Some(item)
    }

    /// Moves the highlight by a key.
    fn move_by(self, by: Move) {
        let next = self
            .shown
            .with_untracked(|shown| shown.step(self.highlight.get_untracked(), by));
        if next.is_some() {
            self.set_highlight(next, Via::Keyboard);
        }
    }

    /// The rows changed: a new query highlights the first enabled item
    /// (`reset`); new items keep the highlighted one while it is shown and
    /// enabled, else the first enabled item. The first rows' highlight
    /// (`initial`) is neither revealed (the list starts at the top) nor
    /// announced.
    fn follow(self, reset: bool, initial: bool) {
        let kept = if reset {
            None
        } else {
            self.highlighted
                .with(|h| h.clone())
                .and_then(|id| self.index.with_untracked(|ix| ix.0.find(&id)))
                .filter(|&i| self.shown.with_untracked(|s| s.is_enabled(i)))
        };
        let next = kept.or_else(|| self.shown.with_untracked(|s| s.step(None, Move::First)));
        let via = if !initial && (reset || next != self.highlight.get_untracked()) {
            Via::Keyboard
        } else {
            Via::Pointer
        };
        self.set_highlight(next, via);
    }

    /// How many rows a page is: the rows wholly in view.
    fn page(self) -> usize {
        self.visible
            .get()
            .map_or(PAGE, |(first, last)| last + 1 - first)
            .max(1)
    }

    /// Item `item` comes into view, once: scrolled to the nearer edge when
    /// it is not wholly there.
    fn reveal(self, item: usize) {
        let Some(row) = self.shown.with_untracked(|shown| shown.row_of(item)) else {
            return;
        };
        match self.visible.get() {
            Some(visible) => self.scroll_to(row, visible),
            None => {
                self.reveal.replace(Some(row));
            }
        }
    }

    fn scroll_to(self, row: usize, (first, last): (usize, usize)) {
        if (first..=last).contains(&row) {
            return;
        }
        if row < first {
            // Up to the item, with its section's header when it is the
            // first of its section.
            let header = row.checked_sub(1).filter(|&r| {
                self.shown
                    .with_untracked(|s| matches!(s.rows.get(r), Some(Row::Header { .. })))
            });
            self.list.scroll_to_index(
                header.unwrap_or(row) as u32,
                Percentage(0.0),
                px(0.0),
                false,
            );
        } else {
            self.list
                .scroll_to_index(row as u32, Percentage(1.0), px(0.0), false);
        }
    }

    /// The rows wholly in view changed.
    fn viewable(self, items: &ViewableItems) {
        self.visible.replace(items.viewable);
        if let Some(visible) = items.viewable
            && let Some(row) = self.reveal.replace(None)
        {
            self.scroll_to(row, visible);
        }
    }

    /// Screen readers hear of item `item`: while the search field edits
    /// (moving the focus would leave it), its label is announced; else its
    /// row takes their focus.
    fn tell_screen_reader(self, item: usize) {
        if !untracked(screen_reader) {
            return;
        }
        if self.searchable.get_untracked() {
            if let Some(label) = self
                .items
                .with_untracked(|items| items.get(item).map(|i| i.label.clone()))
            {
                announce_for_accessibility(label.to_string());
            }
        } else {
            self.a11y.set(Some(item));
        }
    }

    /// The pointer moved over item `item`'s row to `at` (in the root
    /// view): it is highlighted, unless the pointer is where it was (a row
    /// scrolled under a still pointer does not take it from the keyboard).
    fn hovered(self, item: usize, at: Point<Points>) {
        if self.pointer.replace(Some(at)) == Some(at) {
            return;
        }
        let enabled = self
            .items
            .with_untracked(|items| items.get(item).is_some_and(|i| !i.disabled));
        if enabled && self.highlight.get_untracked() != Some(item) {
            self.set_highlight(Some(item), Via::Pointer);
        }
    }

    /// The highlight jumps by typeahead to the item `c` typed (with what
    /// was typed before it) leads to.
    fn type_ahead(self, c: char) {
        let at = now();
        let from = self.highlight.get_untracked();
        let next = self.typeahead.with(|t| {
            let typed = t.push(c, at);
            self.index.with_untracked(|index| {
                self.shown
                    .with_untracked(|shown| shown.find_typed(&index.0.folded, from, typed))
            })
        });
        if next.is_some() {
            self.set_highlight(next, Via::Keyboard);
        }
    }

    /// The user chose item `item`: reported when it can be chosen.
    fn choose(self, item: usize) {
        let id = self.items.with_untracked(|items| {
            items
                .get(item)
                .filter(|i| !i.disabled)
                .map(|i| i.id.clone())
        });
        if let Some(id) = id {
            self.cx.emit(CommandEvent::Select(id));
        }
    }

    /// The highlighted item is chosen (Return).
    fn accept(self) {
        if let Some(item) = self.highlight.get_untracked() {
            self.choose(item);
        }
    }
}

/// The parts the rows take from the props.
#[derive(Clone, Copy)]
struct Parts {
    item_class: Prop<Option<SharedString>>,
    item_style: Prop<TextPartStyle>,
    group_class: Prop<Option<SharedString>>,
    group_style: Prop<TextPartStyle>,
    separator_class: Prop<Option<SharedString>>,
    separator_style: Prop<Style>,
    render_item: Prop<Option<Renderer<CommandEntry>>>,
    render_group: Prop<Option<Renderer<CommandGroup>>>,
}

/// The query now: the app's, else the field's (tracked).
fn query_of(controlled: Prop<Option<SharedString>>, own: Signal<String>) -> String {
    match controlled.get() {
        Some(q) => q.to_string(),
        None => own.get(),
    }
}

/// A command palette (`gpui-component`'s `Command`): a search field over
/// the app's commands (`items`: an id, a label, keywords, a section, a
/// shortcut to show, disabled or checked), filtered natively as the user
/// types (the label or a keyword holds the query, ignoring case; sections
/// with no match go), in a virtualized list that makes only the rows in
/// view. Up and Down move the highlight past disabled items and around the
/// ends (Page Up and Down by a page), Return or a press chooses
/// (`onSelect({ id })`), Escape clears the query and then reports
/// `onCancel` (the app closes a `Dialog` around it); the pointer highlights
/// the row it moves over. The query is `query` and `onQueryChange` (or the field's
/// own, from `defaultQuery`); with `filterable={false}` the app answers it
/// (`items`, `loading`). It looks like nothing: the app styles every part,
/// draws the rows (`renderItem`, `renderGroup`) and fills the `header`,
/// `footer`, `empty`, `searchPrefix` and `searchSuffix` slots. Screen
/// readers hear a list box of options, the highlighted one announced.
#[component(methods = CommandApi)]
pub fn Command(props: CommandProps, cx: Scope<CommandEvent>) -> impl IntoElement {
    let own_query = signal(
        props
            .default_query
            .get_untracked()
            .map(|q| q.to_string())
            .unwrap_or_default(),
    );
    let index = computed(move || Indexed(Rc::new(props.items.with(|items| Index::new(items)))));
    let narrow = stored(None::<Narrow>);
    let shown = computed(move || {
        let index = index.get().0;
        let filters = props.searchable.get() && props.filterable.get();
        let query = if filters {
            query_of(props.query, own_query).trim().to_lowercase()
        } else {
            String::new()
        };
        let separators = props.separator.get();
        props.items.with(|items| {
            narrow.with(|last| {
                let among = last
                    .as_ref()
                    .filter(|n| Rc::ptr_eq(&n.index, &index) && query.contains(n.query.as_str()))
                    .map(|n| n.matches.as_slice());
                let matches = matching(&index, &query, among);
                let shown = Shown::new(items, &index, &matches, separators);
                *last = (!query.is_empty()).then(|| Narrow {
                    index: index.clone(),
                    query,
                    matches,
                });
                shown
            })
        })
    });
    let palette = Palette {
        items: props.items,
        searchable: props.searchable,
        index,
        shown,
        highlight: signal(None),
        lit: stored(std::array::from_fn(|_| signal(None))),
        highlighted: stored(None),
        visible: stored(None),
        reveal: stored(None),
        list: element_ref(),
        pointer: stored(None),
        typeahead: stored(Typeahead::default()),
        a11y: signal(None),
        cx,
    };
    // Each change of the rows: a new query highlights its first enabled
    // item, new items keep the highlighted one while they can.
    let last_query = stored(None::<String>);
    effect(move || {
        let query = query_of(props.query, own_query);
        shown.with(|_| ());
        untracked(|| {
            let last = last_query.replace(Some(query.clone()));
            palette.follow(last.as_ref() != Some(&query), last.is_none());
        });
    });

    // The search field, or the command without one, has the keyboard
    // focus: the keys are bound.
    let root = element_ref();
    let field = element_ref();
    let field_focused = signal(false);
    let root_focused = signal(false);
    let focused = computed(move || {
        if props.searchable.get() {
            field_focused.get()
        } else {
            root_focused.get()
        }
    });
    effect(move || {
        if !focused.get() {
            return;
        }
        let searchable = props.searchable.get();
        let when = if searchable {
            When::Always
        } else {
            When::NotEditing
        };
        let bind = |keys: &str, when: When, repeat: bool, f: Rc<dyn Fn()>| {
            on_key_with(
                keys,
                KeyOptions {
                    when,
                    repeat,
                    ..Default::default()
                },
                move |_| f(),
            );
        };
        let moves = [
            ("up", Move::Previous, when),
            ("down", Move::Next, when),
            // A search field's own while it edits.
            ("home", Move::First, When::NotEditing),
            ("end", Move::Last, When::NotEditing),
        ];
        for (keys, by, when) in moves {
            bind(keys, when, true, Rc::new(move || palette.move_by(by)));
        }
        bind(
            "pageup",
            when,
            true,
            Rc::new(move || palette.move_by(Move::PageUp(palette.page()))),
        );
        bind(
            "pagedown",
            when,
            true,
            Rc::new(move || palette.move_by(Move::PageDown(palette.page()))),
        );
        bind("enter", when, false, Rc::new(move || palette.accept()));
        if !searchable {
            bind(
                "space",
                When::NotEditing,
                false,
                Rc::new(move || palette.accept()),
            );
        }
    });
    // The user typed `text`: the field's own query follows while the app
    // sets none, and the app hears of it.
    let edited = move |text: &str| {
        if props.query.get_untracked().is_none() {
            own_query.set(text.to_owned());
        }
        cx.emit(CommandEvent::QueryChange(text.to_owned().into()));
    };
    // Escape clears a query, and with none it is `onCancel`
    // (`gpui-component`'s `Cancel`): the app closes what holds the command.
    // An unbound Escape would not reach a dialog around it: in a focused
    // text field the platforms only leave the field.
    effect(move || {
        if !focused.get() {
            return;
        }
        on_key_with(
            "escape",
            KeyOptions {
                when: When::Always,
                repeat: false,
                ..Default::default()
            },
            move |_| {
                let has_query = props.searchable.get_untracked()
                    && untracked(|| !query_of(props.query, own_query).is_empty());
                if has_query {
                    edited("");
                } else {
                    cx.emit(CommandEvent::Cancel);
                }
            },
        );
    });
    listbox::bind_typeahead(
        move || focused.get() && !props.searchable.get(),
        Rc::new(move |c| palette.type_ahead(c)),
    );

    cx.methods(CommandApi {
        focus: Rc::new(move || {
            if props.searchable.get_untracked() {
                field.focus();
            } else {
                root.focus();
            }
        }),
        highlight: Rc::new(move |id| {
            let item = index
                .with_untracked(|ix| ix.0.find(id))
                .filter(|&i| shown.with_untracked(|s| s.is_enabled(i)));
            if item.is_some() {
                palette.set_highlight(item, Via::Keyboard);
            }
            item.is_some()
        }),
        count: Rc::new(move || shown.with_untracked(|s| s.items.len() as u32)),
    });

    let search = when(
        move || props.searchable.get(),
        move || {
            view()
                .app_class(props.search_bar_class)
                .inline_style(props.search_bar_style)
                .child(props.search_prefix.place(|e| e))
                .child(
                    input()
                        .element_ref(&field)
                        .value(move || query_of(props.query, own_query))
                        .placeholder(move || {
                            props
                                .placeholder
                                .get()
                                .map(|p| p.to_string())
                                .unwrap_or_default()
                        })
                        .auto_focus(props.auto_focus)
                        // A touch keyboard's return key chooses and keeps
                        // the field for the next query.
                        .submit_behavior(SubmitBehavior::Submit)
                        .optional_label(move || {
                            props
                                .search_accessibility_label
                                .get()
                                .or_else(|| props.accessibility_label.get())
                        })
                        .app_class(props.search_class)
                        .inline_style(move || props.search_style.get())
                        .on_focus(move || field_focused.set(true))
                        .on_blur(move || field_focused.set(false))
                        .on_change(move |text: &str| edited(text))
                        .on_submit(move |_: &str| palette.accept()),
                )
                .child(props.search_suffix.place(|e| e))
        },
    );
    // A terminal draws a rule under the field: the GUI's border under the
    // search bar is no Cell there, and the query would run into the
    // first row.
    let rule = when(
        move || crate::terminal::is_terminal() && props.searchable.get(),
        crate::terminal::rule_line,
    );
    // The field went: its focus too.
    effect(move || {
        if !props.searchable.get() {
            untracked(|| field_focused.set(false));
        }
    });

    let parts = Parts {
        item_class: props.item_class,
        item_style: props.item_style,
        group_class: props.group_class,
        group_style: props.group_style,
        separator_class: props.separator_class,
        separator_style: props.separator_style,
        render_item: props.render_item,
        render_group: props.render_group,
    };
    let rows = virtual_list(
        move || shown.with(|s| s.rows.len()),
        move |at| row(palette, parts, at),
    )
    .keys(move || shown.with(|s| s.keys.clone()))
    .viewport(ListViewport::Parent)
    .viewability(Viewability {
        item_visible_threshold: Some(IN_VIEW),
        ..Viewability::default()
    })
    .on_viewable_items_change(move |v: &ViewableItems| palette.viewable(v))
    .element_ref(&palette.list);
    let list = scroll()
        .role(AccessibilityRole::Listbox)
        .optional_label(props.accessibility_label)
        .accessibility_state(move || AccessibilityState {
            busy: props.loading.get(),
            ..AccessibilityState::default()
        })
        .flex_shrink(1.0)
        .min_h(px(0.0))
        .app_class(props.list_class)
        .inline_style(props.list_style)
        .child(rows);
    // While a search is under way no item showing is no answer yet, not
    // no match.
    let empty = when(
        move || shown.with(|s| s.rows.is_empty()) && !props.loading.get(),
        move || props.empty.place(|e| e),
    );
    view()
        .element_ref(&root)
        .focusable(move || !props.searchable.get())
        .on_focus(move || root_focused.set(true))
        .on_blur(move || root_focused.set(false))
        .child(props.header.place(|e| e))
        .child(search)
        .child(rule)
        .child(list)
        .child(empty)
        .child(props.footer.place(|e| e))
}

/// The row the list shows at `at`: a section's header, a separator or an
/// item.
fn row(p: Palette, parts: Parts, at: Position) -> AnyElement {
    let entry = computed(move || p.shown.with(|s| s.rows.get(at.index()).cloned()));
    let kind = computed(move || match entry.get() {
        Some(Row::Header { .. }) => 0u8,
        Some(Row::Separator) => 1,
        _ => 2,
    });
    dynamic(move || match kind.get() {
        0 => header_row(entry, parts),
        1 => view()
            .focusable(false)
            .accessibility_elements_hidden(true)
            .app_class(parts.separator_class)
            .inline_style(parts.separator_style)
            .into_element(),
        _ => item_row(p, entry, parts),
    })
}

/// A section's header: the app's `renderGroup`, else its heading.
fn header_row(entry: Memo<Option<Row>>, parts: Parts) -> AnyElement {
    let group = computed(move || match entry.get() {
        Some(Row::Header { heading, first }) => Some((heading, first)),
        _ => None,
    });
    let custom = computed(move || parts.render_group.with(Option::is_some));
    view()
        .role(AccessibilityRole::Header)
        .focusable(false)
        .app_class(parts.group_class)
        .inline_style(move || parts.group_style.get())
        .child(dynamic(move || {
            if custom.get() {
                return dynamic(move || {
                    let render = parts.render_group.get()?;
                    let (heading, first) = group.get()?;
                    Some(render.render(format!("group:{first}"), CommandGroup { heading }))
                });
            }
            text(move || group.get().map(|(heading, _)| heading).unwrap_or_default()).into_element()
        }))
        .into_element()
}

/// An item's row: the app's `renderItem`, else its label.
fn item_row(p: Palette, entry: Memo<Option<Row>>, parts: Parts) -> AnyElement {
    let index = computed(move || match entry.get() {
        Some(Row::Item(i)) => Some(i),
        _ => None,
    });
    let item = computed(move || {
        let i = index.get()?;
        p.items.with(|items| items.get(i).map(CommandEntry::of))
    });
    let disabled = computed(move || item.with(|i| i.as_ref().is_some_and(|i| i.disabled)));
    let checked = computed(move || item.with(|i| i.as_ref().is_some_and(|i| i.checked)));
    let highlighted = computed(move || index.get().is_some_and(|i| p.is_highlighted(i)));
    let label = move || item.with(|i| i.as_ref().map(|i| i.label.clone()).unwrap_or_default());
    let me = element_ref();
    // A key moved the highlight here: the screen reader's focus follows.
    effect(move || {
        let Some(i) = index.get() else { return };
        if p.a11y.get() == Some(i) {
            untracked(|| {
                me.set_accessibility_focus();
                p.a11y.set(None);
            });
        }
    });
    let desktop = is_desktop();
    let downed = stored(false);
    let choose = move || {
        if let Some(i) = index.get_untracked()
            && !disabled.get_untracked()
        {
            p.choose(i);
        }
    };
    let custom = computed(move || parts.render_item.with(Option::is_some));
    view()
        .role(AccessibilityRole::Option)
        .focusable(false)
        .disabled(disabled)
        .label(label)
        .accessibility_state(move || AccessibilityState {
            disabled: disabled.get(),
            checked: checked.get().then_some(Checked::True),
            ..AccessibilityState::default()
        })
        .project_focused(highlighted)
        .project_checked(checked)
        // A terminal marks the highlighted row itself (a band over the
        // whole row, `crate::terminal`): the app's row look would paint
        // a band of its own beside it. Its content (`render_item`) stays.
        .when(!crate::terminal::is_terminal(), |v| {
            v.app_class(parts.item_class)
                .inline_style(move || parts.item_style.get())
        })
        .element_ref(&me)
        // The pointer highlights a row, as long as no button is down.
        .on_mouse_move(move |e: &MouseEvent| {
            if e.pressed_button.is_none()
                && let Some(i) = index.get_untracked()
            {
                p.hovered(i, e.page_position);
            }
        })
        // The desktops choose as the button goes down, so the search field
        // keeps the keyboard focus; the press that ends it chooses nothing
        // more (a screen reader's activation is a press alone).
        .on(EventKind::PressDown, move |_: &EventPayload| {
            if desktop {
                downed.replace(true);
                choose();
            }
        })
        .on_press(move || {
            if !downed.replace(false) {
                choose();
            }
        })
        .child(dynamic(move || {
            if custom.get() {
                return dynamic(move || {
                    let render = parts.render_item.get()?;
                    let entry = item.get()?;
                    Some(render.render(format!("item:{}", entry.id), entry))
                });
            }
            text(label).into_element()
        }))
        .into_element()
}

#[cfg(test)]
mod tests {
    use super::{CommandItem, Index, Move, Row, Shown};

    fn item(id: &'static str, label: &'static str) -> CommandItem {
        CommandItem::new(id, label)
    }

    /// Two ungrouped items, then "Suggestions" (Calendar, Search Emoji
    /// disabled, Calculator) and "Settings" (Profile with keywords,
    /// Billing).
    fn items() -> Vec<CommandItem> {
        vec![
            item("new", "New File"),
            item("open", "Open File"),
            item("calendar", "Calendar").group("Suggestions"),
            item("emoji", "Search Emoji")
                .group("Suggestions")
                .disabled(true),
            item("calculator", "Calculator").group("Suggestions"),
            item("profile", "Profile")
                .group("Settings")
                .keywords(["account", "user"]),
            item("billing", "Billing").group("Settings"),
        ]
    }

    fn header(heading: &'static str, first: usize) -> Row {
        Row::Header {
            heading: heading.into(),
            first,
        }
    }

    #[test]
    fn sections_have_headers_and_separators_between_them() {
        let items = items();
        assert_eq!(
            Shown::of(&items, "", true).rows,
            [
                Row::Item(0),
                Row::Item(1),
                Row::Separator,
                header("Suggestions", 2),
                Row::Item(2),
                Row::Item(3),
                Row::Item(4),
                Row::Separator,
                header("Settings", 5),
                Row::Item(5),
                Row::Item(6),
            ]
        );
        assert!(!Shown::of(&items, "", false).rows.contains(&Row::Separator));
    }

    #[test]
    fn a_query_matches_labels_and_keywords_and_drops_empty_sections() {
        let items = items();
        // Case-insensitive, anywhere in the label; a section with no match
        // goes with its separator: none leads, trails or doubles.
        assert_eq!(
            Shown::of(&items, "CAL", true).rows,
            [header("Suggestions", 2), Row::Item(2), Row::Item(4)]
        );
        // A keyword, and the query trimmed.
        assert_eq!(
            Shown::of(&items, "  account ", true).rows,
            [header("Settings", 5), Row::Item(5)]
        );
        // Anywhere in a label: "Pro*file*" too, after a separator from the
        // ungrouped section.
        assert_eq!(
            Shown::of(&items, "file", true).rows,
            [
                Row::Item(0),
                Row::Item(1),
                Row::Separator,
                header("Settings", 5),
                Row::Item(5)
            ]
        );
        // A query never spans a label and a keyword.
        assert!(Shown::of(&items, "profile account", true).rows.is_empty());
        assert!(Shown::of(&items, "zzz", true).rows.is_empty());
    }

    #[test]
    fn moves_skip_disabled_items_and_wrap_around() {
        let items = items();
        let shown = Shown::of(&items, "", true);
        assert_eq!(shown.step(None, Move::Next), Some(0));
        assert_eq!(
            shown.step(Some(2), Move::Next),
            Some(4),
            "past Search Emoji"
        );
        assert_eq!(shown.step(Some(6), Move::Next), Some(0));
        assert_eq!(shown.step(Some(0), Move::Previous), Some(6));
        assert_eq!(shown.step(Some(1), Move::Last), Some(6));
        let off = vec![item("x", "X").disabled(true)];
        assert_eq!(Shown::of(&off, "", true).step(None, Move::First), None);
    }

    #[test]
    fn typeahead_starts_on_the_label() {
        let items = items();
        let index = Index::new(&items);
        let shown = Shown::of(&items, "", true);
        assert_eq!(shown.find_typed(&index.folded, None, "c"), Some(2));
        // The same letter again moves on, past the disabled item.
        assert_eq!(shown.find_typed(&index.folded, Some(2), "c"), Some(4));
        // A keyword is no label.
        assert_eq!(shown.find_typed(&index.folded, None, "acc"), None);
    }

    #[test]
    fn ids_find_their_first_item() {
        let mut items = items();
        items.push(item("new", "Again"));
        let index = Index::new(&items);
        assert_eq!(index.find("new"), Some(0));
        assert_eq!(index.find("billing"), Some(6));
        assert_eq!(index.find("nope"), None);
    }
}

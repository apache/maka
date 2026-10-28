//! The list `nsh/base`'s choices open: `Select`'s and `Combobox`'s, its
//! state machine and how it presents itself, with no look.
//!
//! `gpui-base`'s `Select` and `Combobox` are thin roots (the combobox
//! role, a controlled `open`, the keys that open them and move the focus
//! into the content); the highlight, the search and the groups live in
//! `gpui-component`'s `SearchableList`, a styled layer NSH does not have.
//! So the unstyled state machine is here:
//!
//! - **The model** (pure, tested on its own): the items' [`rows`] for a
//!   query (a case-insensitive substring of the titles, in their order;
//!   adjacent items of one `group` form a section under a header, and a
//!   section with no match goes), the moves of the highlight between the
//!   enabled items ([`step`]: around the ends, by a page, to the first or
//!   the last), typeahead ([`Typeahead`], [`find_typed`]: the next enabled
//!   item whose title starts with what was typed in the last second) and
//!   where the highlight goes when the items change ([`follow`]).
//! - **[`Listbox`]**: that state in signals, the keys bound while the list
//!   is open ([`Listbox::bind_keys`]), revealing the highlighted row once
//!   per move (only when it is not wholly in view: the wheel can scroll
//!   past it afterwards), telling screen readers (the highlighted row
//!   takes the screen reader's focus; while a search field edits, its
//!   title is announced instead, so the field keeps the focus) and the
//!   pointer's highlight, which moves only when the pointer did (a row
//!   scrolled under a still pointer does not take it from the keyboard).
//!   The query is the search field's, or the app's when it sets one
//!   ([`Query`], `Combobox`'s `query`); each opening starts from its
//!   default, and a new query highlights its first enabled match.
//! - **[`present`]**: on the desktops a popup anchored to the trigger
//!   (`placement`, `align`, `offset`, `margin`), at least as wide as the
//!   trigger and never taller than the room on its side; on touch screens
//!   a sheet at the bottom over a backdrop, with `Menu`'s motion. The rows
//!   are a virtualized list in the popup's scroll view (`viewport:
//!   parent`), so the popup is as tall as its rows up to that room and a
//!   list of thousands makes only the rows in view; the highlighted row is
//!   `focus:` (projected: the keyboard's focus stays on the trigger or the
//!   search field), the selected ones `selected:` (and selected for screen
//!   readers; [`Hooks::selected`] says which: the select's one value, the
//!   combobox's set), a disabled one `disabled:`; a footer part below the
//!   rows (the combobox's, [`Footer`]).
//!
//! Choosing is the component's ([`Hooks::choose`]): the select closes, a
//! combobox of several values toggles the item and stays open.

use std::{rc::Rc, time::Duration};

use nsh_core::{
    AccessibilityValue,
    element::{InputPartStyle, Style, TextPartStyle, input},
    keymap::When,
    prelude::*,
    time::{Instant, now},
};

use crate::{
    popup::{OpenChangeReason, SheetMotion, lifecycle},
    select::{SelectGroup, SelectItem, SelectItemState},
};

/// How long typeahead keeps what was typed before it starts again.
const TYPEAHEAD_RESET: Duration = Duration::from_millis(1000);

/// The rows a page moves by before the list says how many show.
const PAGE: usize = 10;

/// A row is in view when this much of it shows (a row wholly in view, give
/// or take rounding).
const IN_VIEW: Percentage = Percentage(0.995);

/// A row of the list: the header of a section, or an item (its index among
/// the items).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Row {
    /// The header of the section of items whose `group` is `title`, the
    /// first of which is item `first`.
    Header { title: SharedString, first: usize },
    /// Item `0`.
    Item(usize),
}

/// The rows the items show for `query`: the items whose title holds it,
/// ignoring case (every item for an empty one), in their order; a header
/// before the first shown item of each section (adjacent items of the same
/// `group`), none for a section with no item shown or no group.
pub(crate) fn rows(items: &[SelectItem], query: &str) -> Vec<Row> {
    let query = query.to_lowercase();
    let mut rows = Vec::with_capacity(items.len());
    let mut headed = false;
    // The section's first item, shown or not, so that its header keeps its
    // key (and the app's drawing of it) whatever the query hides.
    let mut start = 0;
    for (i, item) in items.iter().enumerate() {
        if i == 0 || items[i - 1].group != item.group {
            headed = false;
            start = i;
        }
        if !query.is_empty() && !item.title.to_lowercase().contains(&query) {
            continue;
        }
        if !headed {
            headed = true;
            if let Some(title) = &item.group {
                rows.push(Row::Header {
                    title: title.clone(),
                    first: start,
                });
            }
        }
        rows.push(Row::Item(i));
    }
    rows
}

/// The row of item `item`, if it is shown.
pub(crate) fn row_of(rows: &[Row], item: usize) -> Option<usize> {
    rows.iter().position(|r| *r == Row::Item(item))
}

/// The enabled items shown, in their rows' order, with their rows.
fn enabled(rows: &[Row], items: &[SelectItem]) -> Vec<(usize, usize)> {
    rows.iter()
        .enumerate()
        .filter_map(|(row, r)| match r {
            Row::Item(i) if items.get(*i).is_some_and(|item| !item.disabled) => Some((row, *i)),
            _ => None,
        })
        .collect()
}

/// A move of the highlight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Move {
    /// The next enabled item, the first after the last.
    Next,
    /// The previous enabled item, the last before the first.
    Previous,
    /// The first enabled item.
    First,
    /// The last enabled item.
    Last,
    /// This many enabled items on, stopping at the last.
    PageDown(usize),
    /// This many enabled items back, stopping at the first.
    PageUp(usize),
}

/// Where the highlight goes from item `from` (none, or one that is
/// disabled or not shown: from its place) by `by`, among the enabled items
/// the rows show; `None` when none is.
pub(crate) fn step(
    rows: &[Row],
    items: &[SelectItem],
    from: Option<usize>,
    by: Move,
) -> Option<usize> {
    let order = enabled(rows, items);
    let last = order.len().checked_sub(1)?;
    let at = from.and_then(|f| row_of(rows, f));
    // How many of them are before `from`'s row, and whether it is one.
    let (before, on) = match at {
        Some(row) => (
            order.iter().take_while(|(r, _)| *r < row).count(),
            order.iter().any(|(r, _)| *r == row),
        ),
        None => (0, false),
    };
    let k = match (by, at) {
        (Move::First, _) | (Move::Next | Move::PageDown(_), None) => 0,
        (Move::Last, _) | (Move::Previous | Move::PageUp(_), None) => last,
        (Move::Next, Some(_)) => {
            let next = if on { before + 1 } else { before };
            if next > last { 0 } else { next }
        }
        (Move::Previous, Some(_)) => before.checked_sub(1).unwrap_or(last),
        (Move::PageDown(n), Some(_)) => {
            let from = if on { before } else { before.saturating_sub(1) };
            (from + n.max(1)).min(last)
        }
        (Move::PageUp(n), Some(_)) => before.min(last).saturating_sub(n.max(1)),
    };
    Some(order[k].1)
}

/// What was typed for typeahead: the characters typed less than a second
/// apart.
#[derive(Debug, Default)]
pub(crate) struct Typeahead {
    typed: String,
    at: Option<Instant>,
}

impl Typeahead {
    /// `c` typed at `at`: what was typed since the last pause.
    pub(crate) fn push(&mut self, c: char, at: Instant) -> &str {
        if self
            .at
            .is_none_or(|last| at.duration_since(last) > TYPEAHEAD_RESET)
        {
            self.typed.clear();
        }
        self.at = Some(at);
        self.typed.extend(c.to_lowercase());
        &self.typed
    }

    /// Starts again.
    pub(crate) fn clear(&mut self) {
        self.typed.clear();
        self.at = None;
    }
}

/// The enabled item `typed` jumps to from item `from`: the first one,
/// going on from `from` and around, whose title starts with it (ignoring
/// case). The same character typed again moves on to the next title
/// starting with it, as native lists do; more characters keep the item
/// while it still matches.
pub(crate) fn find_typed(
    rows: &[Row],
    items: &[SelectItem],
    from: Option<usize>,
    typed: &str,
) -> Option<usize> {
    let mut chars = typed.chars();
    let first = chars.next()?;
    let repeated = chars.all(|c| c == first);
    let prefix = if repeated {
        first.to_string()
    } else {
        typed.to_owned()
    };
    let order = enabled(rows, items);
    let at = from.and_then(|f| row_of(rows, f));
    let start = match at {
        // A repeated character moves on; a longer prefix starts at the
        // item it is on.
        Some(row) if repeated => order.iter().take_while(|(r, _)| *r <= row).count(),
        Some(row) => order.iter().take_while(|(r, _)| *r < row).count(),
        None => 0,
    };
    (0..order.len())
        .map(|k| order[(start + k) % order.len()].1)
        .find(|&i| items[i].title.to_lowercase().starts_with(&prefix))
}

/// Where the highlight goes when the items or the rows change: to the item
/// of `value` while it is shown and enabled, else to the first enabled
/// item.
pub(crate) fn follow(rows: &[Row], items: &[SelectItem], value: &str) -> Option<usize> {
    let order = enabled(rows, items);
    order
        .iter()
        .find(|(_, i)| items[*i].value == value)
        .or_else(|| order.first())
        .map(|(_, i)| *i)
}

/// What moved the highlight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Via {
    /// A key (or the list opening, or a query): the row is revealed and
    /// screen readers are told.
    Keyboard,
    /// The pointer: the row is under it already.
    Pointer,
}

/// Where the query comes from: the app's `query` when it sets one, else
/// the search field's, which each opening starts at `default`.
#[derive(Clone, Copy)]
pub(crate) struct Query {
    /// The app's query (controlled), if it sets one.
    pub(crate) controlled: Prop<Option<SharedString>>,
    /// What each opening starts with while the app sets none.
    pub(crate) default: Prop<Option<SharedString>>,
}

impl Query {
    /// The search field's alone, starting empty (`Select`'s).
    pub(crate) fn own() -> Self {
        Self {
            controlled: Prop::new(None),
            default: Prop::new(None),
        }
    }
}

/// The list's state: its rows for the query, the highlighted item, and
/// what reveals it.
#[derive(Clone, Copy)]
pub(crate) struct Listbox {
    pub(crate) items: Prop<Vec<SelectItem>>,
    pub(crate) searchable: Prop<bool>,
    query_props: Query,
    /// What the search field holds, while the app sets no query.
    own_query: Signal<String>,
    pub(crate) rows: Memo<Rc<[Row]>>,
    /// The highlighted item, by its index among the items.
    pub(crate) highlight: Signal<Option<usize>>,
    /// Its value, which the highlight follows when the items change.
    highlighted: Stored<Option<SharedString>>,
    /// The list is open (between [`Listbox::opened`] and
    /// [`Listbox::closed`]).
    open: Stored<bool>,
    /// The rows wholly in view, as the list last said.
    visible: Stored<Option<(usize, usize)>>,
    /// A row to reveal once the list says what is in view.
    reveal: Stored<Option<usize>>,
    /// The list, which scrolls the popup to a row.
    list: ElementRef,
    /// Where the pointer last was over the rows.
    pointer: Stored<Option<Point<Points>>>,
    typeahead: Stored<Typeahead>,
    /// The item whose row takes the screen reader's focus once it shows.
    pub(crate) a11y: Signal<Option<usize>>,
}

/// The query now: the app's, else the field's (tracked).
fn query_of(props: Query, own: Signal<String>) -> String {
    match props.controlled.get() {
        Some(q) => q.to_string(),
        None => own.get(),
    }
}

impl Listbox {
    pub(crate) fn new(items: Prop<Vec<SelectItem>>, searchable: Prop<bool>, query: Query) -> Self {
        let own_query = signal(String::new());
        let rows = computed(move || {
            let q = query_of(query, own_query);
            Rc::<[Row]>::from(items.with(|items| rows(items, &q)))
        });
        let lb = Self {
            items,
            searchable,
            query_props: query,
            own_query,
            rows,
            highlight: signal(None),
            highlighted: stored(None),
            open: stored(false),
            visible: stored(None),
            reveal: stored(None),
            list: element_ref(),
            pointer: stored(None),
            typeahead: stored(Typeahead::default()),
            a11y: signal(None),
        };
        // Other items (or rows): the highlight follows its value while it
        // is shown and enabled, else goes to the first enabled item.
        effect(move || {
            lb.items.with(|_| ());
            lb.rows.with(|_| ());
            untracked(|| {
                let Some(value) = lb.highlighted.get() else {
                    return;
                };
                let next = lb.items.with(|items| {
                    lb.rows.with(|rows| {
                        let order = enabled(rows, items);
                        let here = lb
                            .highlight
                            .get_untracked()
                            .filter(|&i| order.iter().any(|(_, o)| *o == i))
                            .filter(|&i| items[i].value == value);
                        here.or_else(|| follow(rows, items, &value))
                    })
                });
                if next != lb.highlight.get_untracked() {
                    lb.set_highlight(next, Via::Pointer);
                }
            });
        });
        // The app's query changed while the list is open (it followed the
        // field, or set its own): as a typed one, the first match.
        let last = stored(None::<SharedString>);
        effect(move || {
            let now = query.controlled.get();
            if last.replace(now.clone()) == now || now.is_none() || !lb.open.get() {
                return;
            }
            untracked(|| lb.highlight_first());
        });
        lb
    }

    /// The query now (tracked): what the search field shows and the rows
    /// match.
    pub(crate) fn query(self) -> String {
        query_of(self.query_props, self.own_query)
    }

    /// The field's query at each opening: the default, else none.
    fn default_query(self) -> String {
        self.query_props
            .default
            .get_untracked()
            .map(|q| q.to_string())
            .unwrap_or_default()
    }

    /// The item's value, if there is such an item.
    fn value_of(self, item: usize) -> Option<SharedString> {
        self.items
            .with_untracked(|items| items.get(item).map(|i| i.value.clone()))
    }

    /// Highlights `item`: by a key, it is revealed and screen readers hear
    /// of it.
    pub(crate) fn set_highlight(self, item: Option<usize>, via: Via) {
        self.highlighted
            .replace(item.and_then(|i| self.value_of(i)));
        self.highlight.set(item);
        if via == Via::Keyboard
            && let Some(item) = item
        {
            self.reveal(item);
            self.tell_screen_reader(item);
        }
    }

    /// Moves the highlight by a key.
    pub(crate) fn move_by(self, by: Move) {
        let next = self.items.with_untracked(|items| {
            self.rows
                .with_untracked(|rows| step(rows, items, self.highlight.get_untracked(), by))
        });
        if next.is_some() {
            self.set_highlight(next, Via::Keyboard);
        }
    }

    /// The enabled item a key `c` typed jumps to from `from`.
    pub(crate) fn typed(self, c: char, from: Option<usize>) -> Option<usize> {
        let at = now();
        self.typeahead.with(|t| {
            let typed = t.push(c, at);
            self.items.with_untracked(|items| {
                self.rows
                    .with_untracked(|rows| find_typed(rows, items, from, typed))
            })
        })
    }

    /// How many rows a page is: the rows wholly in view.
    fn page(self) -> usize {
        self.visible
            .get()
            .map_or(PAGE, |(first, last)| last + 1 - first)
            .max(1)
    }

    /// The list opens: the query (its default), the pointer and typeahead
    /// start again, and the item `initial` picks from the rows and the
    /// items is highlighted (revealed, and told to screen readers).
    pub(crate) fn opened(self, initial: impl FnOnce(&[Row], &[SelectItem]) -> Option<usize>) {
        self.own_query.set(self.default_query());
        self.open.replace(true);
        self.pointer.replace(None);
        self.visible.replace(None);
        self.reveal.replace(None);
        self.a11y.set(None);
        self.typeahead.with(Typeahead::clear);
        let item = self
            .items
            .with_untracked(|items| self.rows.with_untracked(|rows| initial(rows, items)));
        self.set_highlight(item, Via::Keyboard);
    }

    /// The list closed: the query goes back to its default.
    pub(crate) fn closed(self) {
        self.open.replace(false);
        self.own_query.set(self.default_query());
        self.a11y.set(None);
        self.typeahead.with(Typeahead::clear);
    }

    /// The user typed `query` in the search field: while the app sets no
    /// query it is the field's, and the highlight goes to the first
    /// enabled item it shows (an app's query does the same once it
    /// follows).
    pub(crate) fn edited(self, query: &str) {
        if self.query_props.controlled.get_untracked().is_some() {
            return;
        }
        self.own_query.set(query.to_owned());
        self.highlight_first();
    }

    /// Highlights the first enabled item the rows show, as a key would.
    fn highlight_first(self) {
        let first = self.items.with_untracked(|items| {
            self.rows
                .with_untracked(|rows| step(rows, items, None, Move::First))
        });
        self.set_highlight(first, Via::Keyboard);
    }

    /// Item `item` comes into view, once: scrolled to the nearer edge when
    /// it is not wholly there.
    fn reveal(self, item: usize) {
        let Some(row) = self.rows.with_untracked(|rows| row_of(rows, item)) else {
            return;
        };
        match self.visible.get() {
            Some(visible) => self.scroll_to(row, visible),
            // Not laid out yet: once the list says what shows.
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
                self.rows
                    .with_untracked(|rows| matches!(rows.get(r), Some(Row::Header { .. })))
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

    /// Screen readers hear of item `item`: its row takes their focus, or,
    /// while a search field edits (moving the focus would leave it), its
    /// title is announced.
    fn tell_screen_reader(self, item: usize) {
        if !untracked(screen_reader) {
            return;
        }
        if self.searchable.get_untracked() {
            if let Some(title) = self
                .items
                .with_untracked(|items| items.get(item).map(|i| i.title.clone()))
            {
                announce_for_accessibility(title.to_string());
            }
        } else {
            self.a11y.set(Some(item));
        }
    }

    /// The pointer moved over item `item`'s row to `at` (in the root
    /// view): it is highlighted, unless the pointer is where it was (a row
    /// scrolled under a still pointer).
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

    /// Binds the keys of the open list while `open` holds: Up and Down
    /// move the highlight (around the ends), Home and End to the first and
    /// the last, Page Up and Down by a page, Return chooses (`choose`, with
    /// the highlighted item), and without a search field Space chooses too
    /// and letters and digits jump by typeahead. With a search field they
    /// fire while it edits (Home and End stay its own).
    pub(crate) fn bind_keys(self, open: impl Fn() -> bool + 'static, choose: Rc<dyn Fn(usize)>) {
        effect(move || {
            if !open() {
                return;
            }
            let searchable = self.searchable.get();
            let when = if searchable {
                When::Always
            } else {
                When::NotEditing
            };
            let bind = |keys: &str, when: When, repeat: bool, f: Rc<dyn Fn()>| {
                on_key_with(keys, KeyOptions { when, repeat }, move |_| f());
            };
            let moves = [
                ("up", Move::Previous, when),
                ("down", Move::Next, when),
                ("home", Move::First, When::NotEditing),
                ("end", Move::Last, When::NotEditing),
            ];
            for (keys, by, when) in moves {
                bind(keys, when, true, Rc::new(move || self.move_by(by)));
            }
            bind(
                "pageup",
                when,
                true,
                Rc::new(move || self.move_by(Move::PageUp(self.page()))),
            );
            bind(
                "pagedown",
                when,
                true,
                Rc::new(move || self.move_by(Move::PageDown(self.page()))),
            );
            let accept = {
                let choose = choose.clone();
                Rc::new(move || {
                    if let Some(item) = self.highlight.get_untracked() {
                        choose(item);
                    }
                })
            };
            bind("enter", when, false, accept.clone());
            if !searchable {
                bind("space", When::NotEditing, false, accept);
                for c in ('a'..='z').chain('0'..='9') {
                    let key = c.to_string();
                    bind(
                        &key,
                        When::NotEditing,
                        false,
                        Rc::new(move || {
                            let from = self.highlight.get_untracked();
                            if let Some(item) = self.typed(c, from) {
                                self.set_highlight(Some(item), Via::Keyboard);
                            }
                        }),
                    );
                }
            }
        });
    }
}

/// The parts and placement the list takes from its component's props.
#[derive(Clone, Copy)]
pub(crate) struct Parts {
    pub(crate) placement: Prop<Placement>,
    pub(crate) align: Prop<Align>,
    pub(crate) offset: Prop<Points>,
    pub(crate) margin: Prop<Points>,
    pub(crate) popup_class: Prop<Option<SharedString>>,
    pub(crate) popup_style: Prop<Style>,
    pub(crate) backdrop_class: Prop<Option<SharedString>>,
    pub(crate) backdrop_style: Prop<Style>,
    pub(crate) list_class: Prop<Option<SharedString>>,
    pub(crate) list_style: Prop<Style>,
    pub(crate) item_class: Prop<Option<SharedString>>,
    pub(crate) item_style: Prop<TextPartStyle>,
    pub(crate) group_class: Prop<Option<SharedString>>,
    pub(crate) group_style: Prop<Style>,
    pub(crate) search_class: Prop<Option<SharedString>>,
    pub(crate) search_style: Prop<InputPartStyle>,
    pub(crate) search_placeholder: Prop<Option<SharedString>>,
    pub(crate) render_item: Prop<Option<Renderer<SelectItemState>>>,
    pub(crate) render_group: Prop<Option<Renderer<SelectGroup>>>,
    pub(crate) empty: Prop<Option<Slot>>,
    /// The content below the rows, in a part of its own (`Combobox`'s
    /// `footer`); none for `Select`.
    pub(crate) footer: Option<Footer>,
}

/// The part below the rows and what it holds.
#[derive(Clone, Copy)]
pub(crate) struct Footer {
    pub(crate) content: Prop<Option<Slot>>,
    pub(crate) class: Prop<Option<SharedString>>,
    pub(crate) style: Prop<Style>,
}

/// What the list asks of its component.
#[derive(Clone)]
pub(crate) struct Hooks {
    /// Whether it is open (tracked).
    pub(crate) open: Rc<dyn Fn() -> bool>,
    /// Whether the item of this value is selected now (tracked): the
    /// select's value, or one of the combobox's.
    pub(crate) selected: Rc<dyn Fn(&SharedString) -> bool>,
    /// Choose item `0` (an enabled one: the list checks).
    pub(crate) choose: Rc<dyn Fn(usize)>,
    /// The user typed this in the search field (`onQueryChange`).
    pub(crate) query_changed: Rc<dyn Fn(&str)>,
    /// The user tried to close it, for this reason.
    pub(crate) dismiss: Rc<dyn Fn(OpenChangeReason)>,
    /// It is all there (`true`) or all gone (`false`).
    pub(crate) shown: Rc<dyn Fn(bool)>,
}

/// The list while it is open, on the desktops a popup anchored to the
/// trigger `anchor` names, at least `width` wide (its width, once it is
/// laid out), on touch screens a sheet at the bottom over a backdrop.
pub(crate) fn present(
    lb: Listbox,
    anchor: ElementRef,
    width: Signal<Option<Points>>,
    parts: Parts,
    hooks: Hooks,
) -> AnyElement {
    let sheet = !is_desktop();
    let open = hooks.open.clone();
    let motion = SheetMotion::new(move || sheet && open(), || Placement::Bottom);
    // The popup waits for the trigger's first layout: open at first
    // (`defaultOpen`), it would be made before the trigger is (a slot is
    // filled after the first render) and placed against nothing.
    let shown = {
        let open = hooks.open.clone();
        move || {
            if sheet {
                motion.shown.get()
            } else {
                open() && width.with(Option::is_some)
            }
        }
    };
    {
        let open = hooks.open.clone();
        let (opened, closed) = (hooks.shown.clone(), hooks.shown.clone());
        lifecycle(
            move || {
                if sheet {
                    motion.there()
                } else {
                    open() && width.with(Option::is_some)
                }
            },
            move || opened(true),
            move || closed(false),
        );
    }
    when(shown, move || {
        let content = content(lb, sheet, parts, hooks.clone());
        let cancel = {
            let dismiss = hooks.dismiss.clone();
            move || dismiss(OpenChangeReason::Cancel)
        };
        if sheet {
            let dismiss = hooks.dismiss.clone();
            let backdrop = overlay()
                .inset_0()
                .bind_opacity(&motion.fade)
                .focusable(false)
                .app_class(parts.backdrop_class)
                .inline_style(parts.backdrop_style)
                .on_press(move || dismiss(OpenChangeReason::BackdropPress));
            let panel = overlay()
                .left_0()
                .right_0()
                .bottom_0()
                // Below the status bar, whatever the rows.
                .max_h(move || Length::from(window().height - safe_area().top))
                .app_class(parts.popup_class)
                .inline_style(parts.popup_style)
                .bind_translate_y(&motion.y)
                .on_layout(move |frame: &Bounds<Points>| motion.laid_out(frame.size))
                .on_cancel(cancel)
                .children(content);
            return vec![backdrop.into_element(), panel.into_element()];
        }
        let room = signal(None::<Points>);
        let dismiss = hooks.dismiss.clone();
        let popup = overlay()
            // The trigger itself: in a TSX app the app's element, whose
            // box is what shows (not the slot's view, which a column
            // stretches).
            .anchor(&anchor)
            .placement(parts.placement)
            .align(parts.align)
            .offset(parts.offset)
            .margin(parts.margin)
            .min_w(move || Length::from(width.get().unwrap_or_default()))
            // Never past the room on its side: its rows scroll. Until
            // the core says where it went, the window bounds it, so the
            // first layout already gives the rows a viewport to
            // virtualize against (unbounded, a list of thousands would
            // make every row).
            .max_h(move || Length::from(room.get().unwrap_or_else(|| window().height)))
            .app_class(parts.popup_class)
            .inline_style(parts.popup_style)
            .on_position(move |p: &OverlayPosition| room.set(Some(p.available.height)))
            .on_press_outside(move |_: &Point<Points>| dismiss(OpenChangeReason::PressOutside))
            .on_cancel(cancel)
            .children(content);
        vec![popup.into_element()]
    })
    .into_element()
}

/// What the popup or sheet holds: the search field, the rows, the `empty`
/// slot while no item shows, and the footer.
fn content(lb: Listbox, sheet: bool, parts: Parts, hooks: Hooks) -> Vec<AnyElement> {
    let query_changed = hooks.query_changed.clone();
    let search = when(
        move || lb.searchable.get(),
        move || {
            let query_changed = query_changed.clone();
            input()
                .value(move || lb.query())
                .placeholder(move || {
                    parts
                        .search_placeholder
                        .get()
                        .map(|p| p.to_string())
                        .unwrap_or_default()
                })
                // The desktops type into it at once; a touch screen's
                // keyboard comes when the user asks.
                .auto_focus(!sheet)
                .app_class(parts.search_class)
                .inline_style(move || parts.search_style.get())
                .on_change(move |text: &str| {
                    lb.edited(text);
                    query_changed(text);
                })
        },
    );
    let rows = {
        let hooks = hooks.clone();
        virtual_list(
            move || lb.rows.with(|r| r.len()),
            move |at| row(lb, parts, hooks.clone(), at),
        )
        .keys(move || {
            lb.items.with(|items| {
                lb.rows
                    .with(|rows| rows.iter().map(|r| key(r, items)).collect::<Vec<_>>())
            })
        })
        .viewport(ListViewport::Parent)
        .viewability(Viewability {
            item_visible_threshold: Some(IN_VIEW),
            ..Viewability::default()
        })
        .on_viewable_items_change(move |v: &ViewableItems| lb.viewable(v))
        .element_ref(&lb.list)
    };
    let list = scroll()
        .role(AccessibilityRole::Listbox)
        .flex_shrink(1.0)
        .min_h(px(0.0))
        .app_class(parts.list_class)
        .inline_style(parts.list_style)
        .child(rows);
    let empty = when(
        move || lb.rows.with(|r| r.is_empty()),
        move || parts.empty.place(|e| e),
    );
    let mut content = vec![
        search.into_element(),
        list.into_element(),
        empty.into_element(),
    ];
    if let Some(footer) = parts.footer {
        let part = when(
            move || footer.content.with(Option::is_some),
            move || {
                view()
                    .app_class(footer.class)
                    .inline_style(footer.style)
                    .child(footer.content.place(|c| c))
            },
        );
        content.push(part.into_element());
    }
    content
}

/// A row's identity, so rows keep their sizes as the query changes.
fn key(row: &Row, items: &[SelectItem]) -> (u8, SharedString, usize) {
    match row {
        Row::Header { title, first } => (0, title.clone(), *first),
        Row::Item(i) => (1, items[*i].value.clone(), 0),
    }
}

/// The row the list shows at `at`: a section's header or an item.
fn row(lb: Listbox, parts: Parts, hooks: Hooks, at: Position) -> AnyElement {
    let entry = computed(move || lb.rows.with(|rows| rows.get(at.index()).cloned()));
    let header = computed(move || matches!(entry.get(), Some(Row::Header { .. })));
    dynamic(move || {
        if header.get() {
            header_row(entry, parts)
        } else {
            item_row(lb, entry, parts, hooks.clone())
        }
    })
}

/// A section's header: the app's `renderGroup`, else its title.
fn header_row(entry: Memo<Option<Row>>, parts: Parts) -> AnyElement {
    let group = computed(move || match entry.get() {
        Some(Row::Header { title, first }) => Some((title, first)),
        _ => None,
    });
    let custom = computed(move || parts.render_group.with(Option::is_some));
    view()
        .role(AccessibilityRole::Header)
        .focusable(false)
        .app_class(parts.group_class)
        .inline_style(parts.group_style)
        .child(dynamic(move || {
            if custom.get() {
                let content = dynamic(move || {
                    let render = parts.render_group.get()?;
                    let (title, first) = group.get()?;
                    Some(render.render(format!("group:{first}"), SelectGroup { title }))
                });
                return content;
            }
            text(move || group.get().map(|(title, _)| title).unwrap_or_default()).into_element()
        }))
        .into_element()
}

/// An item's row: the app's `renderItem`, else its title.
fn item_row(lb: Listbox, entry: Memo<Option<Row>>, parts: Parts, hooks: Hooks) -> AnyElement {
    let index = computed(move || match entry.get() {
        Some(Row::Item(i)) => Some(i),
        _ => None,
    });
    let item = computed(move || {
        index
            .get()
            .and_then(|i| lb.items.with(|items| items.get(i).cloned()))
    });
    let disabled = computed(move || item.with(|i| i.as_ref().is_some_and(|i| i.disabled)));
    let highlighted = computed(move || index.get().is_some() && lb.highlight.get() == index.get());
    let is_selected = hooks.selected.clone();
    let selected =
        computed(move || item.with(|i| i.as_ref().is_some_and(|i| is_selected(&i.value))));
    let me = element_ref();
    // A key moved the highlight here: the screen reader's focus follows.
    effect(move || {
        let Some(i) = index.get() else { return };
        if lb.a11y.get() == Some(i) {
            untracked(|| {
                me.set_accessibility_focus();
                lb.a11y.set(None);
            });
        }
    });
    let desktop = is_desktop();
    let downed = stored(false);
    let choose = move |hooks: &Hooks| {
        if !(hooks.open)() {
            return;
        }
        if let Some(i) = index.get_untracked()
            && !disabled.get_untracked()
        {
            (hooks.choose)(i);
        }
    };
    let (down, tap) = (hooks.clone(), hooks);
    let custom = computed(move || parts.render_item.with(Option::is_some));
    view()
        .role(AccessibilityRole::Option)
        .focusable(false)
        .disabled(disabled)
        .label(move || item.with(|i| i.as_ref().map(|i| i.title.clone()).unwrap_or_default()))
        .accessibility_state(move || AccessibilityState {
            selected: selected.get(),
            disabled: disabled.get(),
            ..AccessibilityState::default()
        })
        .project_focused(highlighted)
        .app_class(parts.item_class)
        .inline_style(move || parts.item_style.get())
        .element_ref(&me)
        // The pointer highlights a row, as long as no button is down.
        .on_mouse_move(move |e: &MouseEvent| {
            if e.pressed_button.is_none()
                && let Some(i) = index.get_untracked()
            {
                lb.hovered(i, e.page_position);
            }
        })
        // The desktops choose as the button goes down, so a search field
        // keeps the keyboard focus; the press that ends it chooses nothing
        // more (a screen reader's activation is a press alone).
        .on(EventKind::PressDown, move |_: &EventPayload| {
            if desktop {
                downed.replace(true);
                choose(&down);
            }
        })
        .on_press(move || {
            if !downed.replace(false) {
                choose(&tap);
            }
        })
        .child(dynamic(move || {
            if custom.get() {
                return dynamic(move || {
                    let render = parts.render_item.get()?;
                    let (i, it) = (index.get()?, item.get()?);
                    let state = SelectItemState {
                        value: it.value,
                        title: it.title,
                        disabled: it.disabled,
                        selected: selected.get(),
                        highlighted: highlighted.get(),
                        index: i as u32,
                        group: it.group,
                    };
                    Some(render.render(format!("item:{i}"), state))
                });
            }
            text(move || item.with(|i| i.as_ref().map(|i| i.title.clone()).unwrap_or_default()))
                .into_element()
        }))
        .into_element()
}

/// The accessibility value of a trigger: the titles of the selected items
/// (`values`, in their order; the select's one), joined by `, `; none
/// while no item is.
pub(crate) fn selected_titles(
    items: &[SelectItem],
    values: &[SharedString],
) -> Option<AccessibilityValue> {
    let titles = values
        .iter()
        .filter_map(|v| items.iter().find(|i| i.value == *v))
        .map(|i| i.title.as_str())
        .collect::<Vec<_>>();
    if titles.is_empty() {
        return None;
    }
    Some(AccessibilityValue {
        text: Some(titles.join(", ").into()),
        ..AccessibilityValue::default()
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use nsh_core::time::Instant;

    use super::{Move, Row, Typeahead, find_typed, follow, rows, selected_titles, step};
    use crate::select::SelectItem;

    fn item(value: &'static str, title: &'static str) -> SelectItem {
        SelectItem::new(value, title)
    }

    /// Fruits in two sections and vegetables with none, one disabled.
    fn items() -> Vec<SelectItem> {
        vec![
            item("apple", "Apple").group("Fruits"),
            item("banana", "Banana").group("Fruits").disabled(true),
            item("blueberry", "Blueberry").group("Fruits"),
            item("carrot", "Carrot").group("Vegetables"),
            item("celery", "Celery").group("Vegetables"),
            item("rice", "Rice"),
        ]
    }

    fn header(title: &'static str, first: usize) -> Row {
        Row::Header {
            title: title.into(),
            first,
        }
    }

    #[test]
    fn sections_are_adjacent_items_of_a_group() {
        let items = items();
        assert_eq!(
            rows(&items, ""),
            [
                header("Fruits", 0),
                Row::Item(0),
                Row::Item(1),
                Row::Item(2),
                header("Vegetables", 3),
                Row::Item(3),
                Row::Item(4),
                Row::Item(5),
            ]
        );
        // The same group again after another is a section of its own.
        let split = vec![
            item("a", "A").group("G"),
            item("b", "B").group("H"),
            item("c", "C").group("G"),
        ];
        assert_eq!(
            rows(&split, ""),
            [
                header("G", 0),
                Row::Item(0),
                header("H", 1),
                Row::Item(1),
                header("G", 2),
                Row::Item(2),
            ]
        );
    }

    #[test]
    fn a_query_keeps_matching_items_in_order_and_drops_empty_sections() {
        let items = items();
        // Case-insensitive, anywhere in the title.
        assert_eq!(
            rows(&items, "ER"),
            [
                header("Fruits", 0),
                Row::Item(2),
                header("Vegetables", 3),
                Row::Item(4),
            ]
        );
        assert_eq!(rows(&items, "rice"), [Row::Item(5)]);
        assert!(rows(&items, "zucchini").is_empty());
    }

    #[test]
    fn moves_skip_disabled_items_and_wrap_around() {
        let items = items();
        let rows = rows(&items, "");
        let go = |from, by| step(&rows, &items, from, by);
        assert_eq!(go(None, Move::Next), Some(0));
        assert_eq!(go(None, Move::Previous), Some(5));
        // Banana is disabled.
        assert_eq!(go(Some(0), Move::Next), Some(2));
        assert_eq!(go(Some(2), Move::Previous), Some(0));
        // Around the ends.
        assert_eq!(go(Some(5), Move::Next), Some(0));
        assert_eq!(go(Some(0), Move::Previous), Some(5));
        assert_eq!(go(Some(3), Move::First), Some(0));
        assert_eq!(go(Some(0), Move::Last), Some(5));
        // From a disabled item: on from its place.
        assert_eq!(go(Some(1), Move::Next), Some(2));
        assert_eq!(go(Some(1), Move::Previous), Some(0));
        // Nothing enabled: nowhere.
        let off = vec![item("x", "X").disabled(true)];
        assert_eq!(step(&super::rows(&off, ""), &off, None, Move::Next), None);
    }

    #[test]
    fn pages_move_by_enabled_items_and_stop_at_the_ends() {
        let items = items();
        let rows = rows(&items, "");
        let go = |from, by| step(&rows, &items, from, by);
        // Enabled: 0, 2, 3, 4, 5.
        assert_eq!(go(Some(0), Move::PageDown(2)), Some(3));
        assert_eq!(go(Some(3), Move::PageDown(10)), Some(5));
        assert_eq!(go(Some(5), Move::PageUp(3)), Some(2));
        assert_eq!(go(Some(2), Move::PageUp(10)), Some(0));
        assert_eq!(go(None, Move::PageDown(3)), Some(0));
        assert_eq!(go(None, Move::PageUp(3)), Some(5));
        // From the disabled banana: as from its place.
        assert_eq!(go(Some(1), Move::PageDown(1)), Some(2));
        assert_eq!(go(Some(1), Move::PageUp(1)), Some(0));
    }

    #[test]
    fn typeahead_finds_the_next_title_starting_with_what_was_typed() {
        let items = items();
        let rows = rows(&items, "");
        let find = |from, typed| find_typed(&rows, &items, from, typed);
        // `c` from nothing: Carrot; again: Celery; again: around.
        assert_eq!(find(None, "c"), Some(3));
        assert_eq!(find(Some(3), "c"), Some(4));
        assert_eq!(find(Some(4), "cc"), Some(3));
        // A longer prefix keeps the item while it matches.
        assert_eq!(find(Some(3), "ce"), Some(4));
        assert_eq!(find(Some(4), "cel"), Some(4));
        // Disabled items are skipped (Banana), case is ignored.
        assert_eq!(find(Some(0), "b"), Some(2));
        assert_eq!(find(None, "r"), Some(5));
        assert_eq!(find(None, "z"), None);
    }

    #[test]
    fn typeahead_starts_again_after_a_pause() {
        let start = Instant::now();
        let mut t = Typeahead::default();
        assert_eq!(t.push('C', start), "c");
        assert_eq!(t.push('e', start + Duration::from_millis(500)), "ce");
        assert_eq!(t.push('l', start + Duration::from_millis(2000)), "l");
        t.clear();
        assert_eq!(t.push('x', start + Duration::from_millis(2100)), "x");
    }

    #[test]
    fn the_highlight_follows_its_value_else_goes_to_the_first_enabled_item() {
        let items = items();
        let rows = rows(&items, "");
        assert_eq!(follow(&rows, &items, "celery"), Some(4));
        // Gone, or disabled: the first enabled item.
        assert_eq!(follow(&rows, &items, "kiwi"), Some(0));
        assert_eq!(follow(&rows, &items, "banana"), Some(0));
        // Items replaced: Celery moved.
        let moved = vec![item("celery", "Celery"), item("kiwi", "Kiwi")];
        assert_eq!(follow(&super::rows(&moved, ""), &moved, "celery"), Some(0));
        // Filtered out: the first enabled match.
        let shown = super::rows(&items, "b");
        assert_eq!(follow(&shown, &items, "apple"), Some(2));
    }

    #[test]
    fn a_triggers_value_is_the_selected_titles_in_their_order() {
        let items = items();
        let text = |values: &[&'static str]| {
            let values = values.iter().map(|&v| v.into()).collect::<Vec<_>>();
            selected_titles(&items, &values).and_then(|v| v.text.map(|t| t.to_string()))
        };
        assert_eq!(text(&["carrot"]).as_deref(), Some("Carrot"));
        assert_eq!(text(&["rice", "apple"]).as_deref(), Some("Rice, Apple"));
        // Values no item has are left out; none at all is no value.
        assert_eq!(text(&["kiwi", "celery"]).as_deref(), Some("Celery"));
        assert_eq!(text(&[]), None);
        assert_eq!(text(&["kiwi"]), None);
    }
}

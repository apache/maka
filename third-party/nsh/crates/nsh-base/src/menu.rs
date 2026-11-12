//! Menus: `Menu` (opened by a trigger), `ContextMenu` (by a secondary
//! click or a held finger), their `MenuItem`s, `MenuSeparator`s and
//! `Submenu`s.
//!
//! One structure for every device, presented as it suits (`popup.rs`): on
//! the desktops a popup at the trigger (or the pointer) whose submenus
//! cascade beside the item that opens them, on hover or press; on phones
//! and tablets a sheet at the bottom of the screen, over a backdrop, whose
//! submenus replace its items (a submenu's `back` row, and Escape or the
//! back button, return to the items above). The items reach their menu
//! through context, so the app arranges them freely (groups, labels,
//! conditions). An item with `checked` is checkable (a setting, or one
//! choice of a group by its `role`): the value is the app's, its indicator
//! a part that takes the item's state.
//!
//! Each level's items are in a scroll view inside its popup, which is held
//! to the room its overlay is told on its side (`onPosition`'s
//! `available`), so the core chooses the side at the popup's natural size
//! and the items scroll past the room rather than run out of the window.
//! The keys measure where the items are to bring the one they move to into
//! view and to page by the viewport.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use nsh_core::{
    AccessibilityState, Checked, ContextMenuEvent, PointerType, TouchEvent, TouchPhase,
    element::{OrderWatch, Style, watch_order},
    geometry::Axis,
    keymap::When,
    overlay::OverlayAnchor,
    prelude::*,
};

use crate::{
    popup::{OpenChangeReason, OpenState, PopupPresence, SheetMotion, StateLooks, lifecycle},
    roving::{bar_trigger, leave_bar, popup_bar},
    terminal::{MENU_CHECK, MENU_RADIO, MENU_UNCHECKED, SUBMENU_ARROW, is_terminal, line, rule},
};

/// How long a finger stays on a context menu's trigger before it opens
/// (less than the platforms' long press, so it opens while the finger is
/// still down), and how far it may move meanwhile.
const HOLD: Duration = Duration::from_millis(400);
const SLOP: f32 = 10.0;

/// What a menu's items reach through context.
#[derive(Clone)]
struct MenuContext {
    /// Closes the whole menu.
    close: Rc<dyn Fn(OpenChangeReason)>,
    /// Presented as a sheet (touch screens).
    sheet: bool,
    /// Sheet: the submenus shown, innermost last.
    path: Signal<Vec<u32>>,
    /// The submenu the items under this context are in (0: the menu).
    level: u32,
    /// Desktops: the submenu of this level that is open.
    open_sub: Signal<Option<u32>>,
    /// Desktops: this level's popup is open (the menu's, or the
    /// submenu's while every level around it is), which its submenus'
    /// follow: they close with it, each with its own exit.
    open: Memo<bool>,
    /// The next submenu's id.
    next: Stored<u32>,
    /// The popup part and its states' looks, for the submenus' popups.
    looks: StateLooks,
    /// Desktops: this level's popup, which its submenus open outside of.
    popup: ElementRef,
    /// Every level's items, which an opening from the keyboard focuses
    /// one of.
    items: Items,
    /// Desktops: inside a submenu, closes it and puts the keyboard focus
    /// back on its trigger (Left on one of its items, Escape); `None` in
    /// the menu itself.
    leave: Option<Rc<dyn Fn()>>,
    /// Why its submenus open or close, as the user asked.
    why: Why,
}

/// Why a menu's submenus last opened or closed as the user asked: each
/// request stamps its reason, and a submenu reports a change of its own
/// (`onOpenChange`) only for a stamp it has not reported. The app opening
/// or closing the menu itself is no request, as `Menu`'s `onOpenChange`
/// does not report it either. A stamp, not a reason taken once: one
/// request can open one submenu and close another, or close a submenu and
/// the ones inside it, and their effects run after it, in a batch.
///
/// The closings come before the openings, whatever order the effects run
/// in: an app cleans up what a submenu showed when it closes and loads
/// what the next one shows when it opens. A submenu that opens first
/// reports the others that closed ([`Why::report_closings`]).
#[derive(Clone, Copy)]
struct Why {
    stamp: Stored<(u64, OpenChangeReason)>,
    /// Each submenu's report of a change not reported yet, by id, in the
    /// order they were made (a submenu after the ones around it).
    reports: Stored<Vec<(u32, Report)>>,
}

/// A submenu's report of a change not reported yet; given `true`, it
/// reports only a closing.
type Report = Rc<dyn Fn(bool)>;

impl Why {
    fn new() -> Self {
        Self {
            stamp: stored((0, OpenChangeReason::TriggerPress)),
            reports: stored(Vec::new()),
        }
    }

    /// The user asked for a change of the menu or its submenus.
    fn stamp(self, reason: OpenChangeReason) {
        self.stamp.with(|(stamp, why)| {
            *stamp += 1;
            *why = reason;
        });
    }

    fn get(self) -> (u64, OpenChangeReason) {
        self.stamp.get()
    }

    /// Adds submenu `id`'s report, removed when the submenu goes.
    fn add(self, id: u32, report: Report) {
        self.reports.with(|r| r.push((id, report)));
        let reports = self.reports;
        // The menu's own state may go before a submenu inside it.
        cleanup(move || {
            reports.try_with(|r| r.retain(|(i, _)| *i != id));
        });
    }

    /// Reports the closings of the submenus other than `id` not reported
    /// yet, the ones inside first.
    fn report_closings(self, id: u32) {
        let reports: Vec<_> = self.reports.with(|r| {
            r.iter()
                .rev()
                .filter(|(i, _)| *i != id)
                .map(|(_, f)| f.clone())
                .collect()
        });
        for report in reports {
            report(true);
        }
    }
}

/// Which item an opening from the keyboard focuses, as WAI-ARIA's menu
/// button and `gpui-base`'s menus do: the first enabled one (Return,
/// Space, Down on the trigger) or the last (Up); for a submenu opened from
/// its trigger (Right, Return, Space), the first enabled one of its items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keyed {
    First,
    Last,
    Submenu(u32),
}

/// What a submenu trigger's keys do while it has the keyboard focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SubmenuKey {
    /// Right, Return, Space: open it with the focus on its first item.
    Enter,
    /// Left: leave the submenu the trigger is in.
    Leave,
}

/// Where an arrow key, Home, End, Page Up or Page Down moves the focus
/// among a level's items.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemStep {
    Previous,
    Next,
    First,
    Last,
    PageUp,
    PageDown,
}

/// The keys that move the focus between a level's items, as WAI-ARIA's
/// menu has them: Up and Down wrap around; Page Up and Page Down go a
/// view at a time and stop at the ends, as the desktops' lists do.
const ITEM_KEYS: &[(&str, bool, ItemStep)] = &[
    ("up", true, ItemStep::Previous),
    ("down", true, ItemStep::Next),
    ("home", false, ItemStep::First),
    ("end", false, ItemStep::Last),
    ("pageup", true, ItemStep::PageUp),
    ("pagedown", true, ItemStep::PageDown),
];

/// An item of a menu, a submenu's trigger among its menu's items, or a
/// [`MenuList`] among them (its rows' items are the list's).
#[derive(Clone)]
struct Entry {
    key: u64,
    node: ElementRef,
    /// The submenu it is in (0: the menu).
    level: u32,
    disabled: Prop<bool>,
    /// A list's rows: the entry stands for all of them, made or not.
    rows: Option<Rc<Rows>>,
}

/// The rows of a [`MenuList`], which the menu's keys walk by index: the
/// rows not made yet too, scrolled to and focused once the list made
/// them.
struct Rows {
    list: ElementRef,
    count: Prop<u32>,
    /// The level the list is in.
    level: u32,
    /// The items of the rows made.
    items: RefCell<Vec<RowItem>>,
    /// The positions of the list's cells: the rows made.
    cells: RefCell<Vec<(u64, Position)>>,
    next_cell: Cell<u64>,
    /// The rows wholly in view, as the list last said.
    visible: Cell<Option<(usize, usize)>>,
}

/// The item of a list's row.
#[derive(Clone, Copy)]
struct RowItem {
    key: u64,
    index: usize,
    node: ElementRef,
    disabled: Prop<bool>,
}

impl Rows {
    fn len(&self) -> usize {
        self.count.get_untracked() as usize
    }

    /// Row `index`'s item, once its row is made.
    fn item(&self, index: usize) -> Option<RowItem> {
        self.items
            .borrow()
            .iter()
            .find(|i| i.index == index)
            .copied()
    }

    /// Row `index` is in a cell of the list.
    fn made(&self, index: usize) -> bool {
        index < self.len()
            && self
                .cells
                .borrow()
                .iter()
                .any(|(_, at)| untracked(|| at.index()) == index)
    }

    /// Scrolls row `index` into view unless it is wholly there: to the
    /// edge it comes in at, as a list's own keys do.
    fn bring(&self, index: usize, dir: Dir) {
        let end = match self.visible.get() {
            Some((first, last)) if (first..=last).contains(&index) => return,
            Some((first, _)) => index > first,
            None => dir == Dir::Forward,
        };
        let at = if end { 1.0 } else { 0.0 };
        self.list
            .scroll_to_index(index as u32, Percentage(at), px(0.0), false);
        // The rows in view once it scrolled, until the list says: a page
        // pressed before then pages from there.
        if let Some((first, last)) = self.visible.get() {
            let shown = last - first;
            let first = match end {
                true => index.saturating_sub(shown),
                false => index.min(self.len().saturating_sub(shown + 1)),
            };
            self.visible.set(Some((first, first + shown)));
        }
    }
}

/// What the row a [`MenuList`] shows reads: the item in it is that row's.
#[derive(Clone)]
struct MenuRow {
    rows: Rc<Rows>,
    index: usize,
}

/// Which way a walk of a level's items goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dir {
    Forward,
    Backward,
}

/// Where a walk of a level's items starts.
#[derive(Debug, Clone, Copy)]
enum Start {
    /// Outside them: the first (forward) or the last (backward) comes
    /// first.
    Outside,
    /// At a place: the one after it (or before it), around the ends.
    At(usize),
    /// On a place: it comes first.
    On(usize),
}

/// One place in a level's walk, as the walk finds it.
enum Spot {
    /// An enabled item: focus it (a list's row: brought into view).
    Focus(ElementRef, Option<(Rc<Rows>, usize)>),
    /// Disabled, or a list's row made without an item.
    Skip,
    /// A list's row not made yet.
    Reveal(Rc<Rows>, usize),
}

/// A row the walk scrolled to, focused once its list made it (or passed
/// over, if it is disabled).
struct Pending {
    level: u32,
    rows: Rc<Rows>,
    index: usize,
    dir: Dir,
    /// The places the walk may still look at.
    budget: usize,
}

/// A level's items in order, each list as many places as it has rows.
struct Walk {
    parts: Vec<Entry>,
    len: usize,
    /// Where its items are in its scroll view, measured for a page.
    geometry: Option<Geometry>,
}

/// Where a level's items (not a list's rows) are in its scroll view.
struct Geometry {
    viewport: f32,
    /// Each item's top and bottom in the viewport, by key.
    spans: Vec<(u64, f32, f32)>,
}

impl Geometry {
    fn span(&self, key: u64) -> Option<(f32, f32)> {
        self.spans
            .iter()
            .find(|s| s.0 == key)
            .map(|&(_, top, bottom)| (top, bottom))
    }
}

impl Walk {
    fn part_at(&self, mut at: usize) -> Option<(&Entry, usize)> {
        for e in &self.parts {
            let n = e.rows.as_ref().map_or(1, |r| r.len());
            if at < n {
                return Some((e, at));
            }
            at -= n;
        }
        None
    }

    /// The place of item `key` (a list's row's: its row's).
    fn place_of(&self, key: u64) -> Option<usize> {
        let mut start = 0;
        for e in &self.parts {
            match &e.rows {
                None if e.key == key => return Some(start),
                None => start += 1,
                Some(rows) => {
                    let row = rows.items.borrow().iter().find(|i| i.key == key).copied();
                    if let Some(row) = row {
                        return Some(start + row.index);
                    }
                    start += rows.len();
                }
            }
        }
        None
    }

    /// The place of row `index` of `rows`.
    fn place_of_row(&self, rows: &Rc<Rows>, index: usize) -> Option<usize> {
        let mut start = 0;
        for e in &self.parts {
            match &e.rows {
                Some(r) if Rc::ptr_eq(r, rows) => return Some(start + index),
                Some(r) => start += r.len(),
                None => start += 1,
            }
        }
        None
    }

    /// Place `at` is in view: an item wholly in the level's scroll view
    /// (any item, unmeasured), or a list's row wholly in its viewport.
    fn shown(&self, at: usize) -> bool {
        self.part_at(at).is_some_and(|(e, row)| match &e.rows {
            None => self.span(e).is_none_or(|(top, bottom)| {
                let viewport = self.geometry.as_ref().map_or(0.0, |g| g.viewport);
                top >= -0.5 && bottom <= viewport + 0.5
            }),
            Some(r) => {
                matches!(r.visible.get(), Some((first, last)) if (first..=last).contains(&row))
            }
        })
    }

    /// Item `e`'s top and bottom in the level's scroll view, measured.
    fn span(&self, e: &Entry) -> Option<(f32, f32)> {
        self.geometry.as_ref()?.span(e.key)
    }

    /// From item place `first`, out of view, the place a view on (back,
    /// going `dir` backward): the last of the items after it that fit in
    /// the viewport with it. `None` for a list's row, or unmeasured.
    fn page_from(&self, first: usize, dir: Dir) -> Option<usize> {
        let viewport = self.geometry.as_ref()?.viewport;
        let span = |at: usize| {
            let (e, _) = self.part_at(at)?;
            if e.rows.is_some() {
                return None;
            }
            self.span(e)
        };
        let (top, bottom) = span(first)?;
        let mut target = first;
        match dir {
            Dir::Forward => {
                let limit = top + viewport + 0.5;
                while span(target + 1).is_some_and(|(_, b)| b <= limit) {
                    target += 1;
                }
            }
            Dir::Backward => {
                let limit = bottom - viewport - 0.5;
                while let Some(at) = target.checked_sub(1)
                    && span(at).is_some_and(|(t, _)| t >= limit)
                {
                    target = at;
                }
            }
        }
        Some(target)
    }

    /// The list place `at` is in: the places of its first and last rows,
    /// and how many rows its viewport shows.
    fn list_at(&self, at: usize) -> Option<(usize, usize, usize)> {
        let (entry, row) = self.part_at(at)?;
        let rows = entry.rows.as_ref()?;
        let start = at - row;
        let page = rows
            .visible
            .get()
            .map_or(1, |(first, last)| last + 1 - first)
            .max(1);
        Some((start, start + rows.len() - 1, page))
    }

    fn spot(&self, at: usize) -> Spot {
        let Some((entry, row)) = self.part_at(at) else {
            return Spot::Skip;
        };
        let Some(rows) = &entry.rows else {
            return match entry.disabled.get_untracked() {
                true => Spot::Skip,
                false => Spot::Focus(entry.node, None),
            };
        };
        match rows.item(row) {
            Some(item) if item.disabled.get_untracked() => Spot::Skip,
            Some(item) => Spot::Focus(item.node, Some((rows.clone(), row))),
            None if rows.made(row) => Spot::Skip,
            None => Spot::Reveal(rows.clone(), row),
        }
    }
}

/// A menu's items, kept in tree order (`watch_order`): items render in
/// the order the core makes them, which conditions and groups change.
#[derive(Clone)]
struct Items {
    list: Rc<RefCell<Vec<Entry>>>,
    next: Rc<Cell<u64>>,
    order: Rc<OrderWatch>,
    keyed: Stored<Option<Keyed>>,
    /// The item with the keyboard focus, if any.
    focused: Signal<Option<u64>>,
    /// A list's row the keys moved to before the list made it.
    pending: Rc<RefCell<Option<Pending>>>,
    /// The item the pointer last moved over, which it gave the keyboard
    /// focus, until the keys move on or the pointer leaves it.
    pointed: Rc<Cell<Option<u64>>>,
    /// Each open level's scroll view and its offset ([`items_scroll`]).
    scrolls: Rc<RefCell<Vec<LevelScroll>>>,
}

/// The scroll view a level's items are in, and how far it is scrolled.
#[derive(Clone)]
struct LevelScroll {
    level: u32,
    view: ElementRef,
    /// Its offset, as it last reported it (or the keys scrolled it to).
    offset: Signal<Points>,
}

impl Items {
    /// The items of an opening, focusing the first or last enabled one of
    /// the menu once they are there when `keyed` asks for it.
    fn new(keyed: Stored<Option<Keyed>>) -> Self {
        let list = Rc::new(RefCell::new(Vec::<Entry>::new()));
        let listed = list.clone();
        // The watch's handler reaches the items once they are made around
        // the watch.
        let made = Rc::new(RefCell::new(None::<Items>));
        let me = made.clone();
        let order = watch_order(
            move || listed.borrow().iter().map(|e| e.node).collect(),
            move |order| {
                let Some(items) = me.borrow().clone() else {
                    return;
                };
                {
                    let mut list = items.list.borrow_mut();
                    let mut taken: Vec<Option<Entry>> = list.drain(..).map(Some).collect();
                    list.extend(order.iter().filter_map(|&i| taken[i].take()));
                }
                items.focus_pending();
            },
        );
        let items = Self {
            list,
            next: Rc::new(Cell::new(0)),
            order: Rc::new(order),
            keyed,
            focused: signal(None),
            pending: Rc::new(RefCell::new(None)),
            pointed: Rc::new(Cell::new(None)),
            scrolls: Rc::new(RefCell::new(Vec::new())),
        };
        *made.borrow_mut() = Some(items.clone());
        items
    }

    /// Focuses what an opening from the keyboard asked for, and a list's
    /// row the keys moved to once it is made. Layout runs even when an
    /// order watch finds the items already in order (and therefore does
    /// not call its change handler).
    fn focus_pending(&self) {
        if let Some(how) = self.keyed.get() {
            let (level, dir) = match how {
                Keyed::First => (0, Dir::Forward),
                Keyed::Last => (0, Dir::Backward),
                Keyed::Submenu(level) => (level, Dir::Forward),
            };
            if self.walk_from(level, Start::Outside, dir, usize::MAX) {
                self.keyed.replace(None);
            }
        }
        self.reveal_pending();
    }

    /// The row the keys moved to while its list had not made it: focused
    /// once it is, or passed over (disabled, no item) for the next one the
    /// way the keys went.
    fn reveal_pending(&self) {
        let (level, place, dir, budget) = {
            let pending = self.pending.borrow();
            let Some(p) = pending.as_ref() else {
                return;
            };
            let walk = self.walk(p.level);
            // The list, or its rows, may have gone meanwhile: the keys
            // start again. Its count is read only while the list is still
            // among the level's items, since a list gone has its props
            // disposed.
            let place = walk
                .place_of_row(&p.rows, p.index)
                .filter(|_| p.index < p.rows.len());
            let Some(place) = place else {
                drop(pending);
                self.pending.replace(None);
                return;
            };
            match walk.spot(place) {
                Spot::Reveal(..) => return,
                Spot::Focus(node, _) => (p.level, place, p.dir, Err(node)),
                Spot::Skip => (p.level, place, p.dir, Ok(p.budget)),
            }
        };
        self.pending.replace(None);
        match budget {
            Err(node) => node.focus(),
            Ok(budget) => {
                self.walk_from(level, Start::At(place), dir, budget);
            }
        }
    }

    /// Level `level`'s items in order.
    fn walk(&self, level: u32) -> Walk {
        let parts: Vec<Entry> = self
            .list
            .borrow()
            .iter()
            .filter(|e| e.level == level)
            .cloned()
            .collect();
        let len = parts
            .iter()
            .map(|e| e.rows.as_ref().map_or(1, |r| r.len()))
            .sum();
        Walk {
            parts,
            len,
            geometry: None,
        }
    }

    /// Moves the focus to the first enabled item of level `level` from
    /// `from` going `dir`, around the ends, looking at no more than
    /// `budget` places. A list's row not made yet is scrolled to and
    /// focused once made ([`Self::reveal_pending`]). Whether it found one.
    fn walk_from(&self, level: u32, from: Start, dir: Dir, budget: usize) -> bool {
        // The keys move on: the item the pointer is on is no longer theirs.
        self.pointed.set(None);
        let walk = self.walk(level);
        let n = walk.len;
        if n == 0 {
            return false;
        }
        let next = |at: usize| match dir {
            Dir::Forward => (at + 1) % n,
            Dir::Backward => (at + n - 1) % n,
        };
        let mut at = match (from, dir) {
            (Start::Outside, Dir::Forward) => 0,
            (Start::Outside, Dir::Backward) => n - 1,
            (Start::At(at), _) => next(at.min(n - 1)),
            (Start::On(at), _) => at.min(n - 1),
        };
        let budget = budget.min(n);
        for looked in 1..=budget {
            match walk.spot(at) {
                Spot::Focus(node, row) => {
                    match row {
                        Some((rows, index)) => rows.bring(index, dir),
                        None => self.reveal(level, node),
                    }
                    node.focus();
                    return true;
                }
                Spot::Skip => {}
                Spot::Reveal(rows, index) => {
                    rows.bring(index, dir);
                    self.pending.replace(Some(Pending {
                        level,
                        rows,
                        index,
                        dir,
                        budget: budget - looked,
                    }));
                    return true;
                }
            }
            at = next(at);
        }
        false
    }

    /// Adds level `level`'s scroll view, forgotten when the current owner
    /// (the level's popup or sheet) ends.
    fn add_scroll(&self, level: u32, view: ElementRef, offset: Signal<Points>) {
        self.scrolls.borrow_mut().push(LevelScroll {
            level,
            view,
            offset,
        });
        let scrolls = self.scrolls.clone();
        cleanup(move || scrolls.borrow_mut().retain(|s| s.view != view));
    }

    /// Scrolls item `node` of level `level` into its scroll view, the keys
    /// having moved to it: the platforms bring only a focused text field
    /// into view, and a menu held to its room scrolls its items past it.
    /// The pointer's focus never scrolls (it is on an item it sees).
    fn reveal(&self, level: u32, node: ElementRef) {
        let Some(LevelScroll { view, offset, .. }) = self.scroll_of(level) else {
            return;
        };
        spawn(async move {
            let (item, port) = (node.measure(), view.measure());
            let (Some(item), Some(port)) = (item.await, port.await) else {
                return;
            };
            let start = item.page.y - port.page.y;
            let delta = nsh_core::scroll::reveal_delta(
                start,
                start + item.frame.size.height,
                port.frame.size.height,
            );
            if delta.0.abs() >= 0.5 {
                let to = offset.get_untracked() + delta;
                offset.set(to);
                view.scroll_to(point(px(0.0), to), false);
            }
        });
    }

    /// Level `level`'s scroll view, while it is open.
    fn scroll_of(&self, level: u32) -> Option<LevelScroll> {
        self.scrolls
            .borrow()
            .iter()
            .rev()
            .find(|s| s.level == level)
            .cloned()
    }

    /// Page Down or Page Up in level `level` ([`Self::page`]), from where
    /// its items are in its scroll view: measured first, a page is what the
    /// viewport shows.
    fn page_in_view(&self, level: u32, place: Option<usize>, dir: Dir) {
        let walk = self.walk(level);
        let Some(LevelScroll { view, .. }) = self.scroll_of(level) else {
            return self.page(level, &walk, place, dir);
        };
        let items = self.clone();
        spawn(async move {
            let port = view.measure();
            let spans: Vec<_> = walk
                .parts
                .iter()
                .filter(|e| e.rows.is_none())
                .map(|e| (e.key, e.node.measure()))
                .collect();
            let Some(port) = port.await else {
                return items.page(level, &walk, place, dir);
            };
            let mut measured = Vec::with_capacity(spans.len());
            for (key, span) in spans {
                if let Some(m) = span.await {
                    let top = (m.page.y - port.page.y).0;
                    measured.push((key, top, top + m.frame.size.height.0));
                }
            }
            let walk = Walk {
                geometry: Some(Geometry {
                    viewport: port.frame.size.height.0,
                    spans: measured,
                }),
                ..walk
            };
            items.page(level, &walk, place, dir);
        });
    }

    /// Focuses the first enabled item of submenu `level` once its items
    /// are there (now, when they already are).
    fn focus_first(&self, level: u32) {
        self.pending.replace(None);
        self.keyed.replace(Some(Keyed::Submenu(level)));
        self.order.invalidate();
        self.focus_pending();
    }

    /// Adds an item of submenu `level` (the item of a [`MenuList`]'s
    /// `row` when it is in one at that level), which the menu forgets
    /// when the current owner (the item's component) ends.
    fn add(&self, node: ElementRef, level: u32, disabled: Prop<bool>) -> u64 {
        let key = self.next.get() + 1;
        self.next.set(key);
        let row = use_context::<MenuRow>().filter(|r| r.rows.level == level);
        if let Some(MenuRow { rows, index }) = row {
            rows.items.borrow_mut().push(RowItem {
                key,
                index,
                node,
                disabled,
            });
            cleanup(move || rows.items.borrow_mut().retain(|i| i.key != key));
            return key;
        }
        self.push(Entry {
            key,
            node,
            level,
            disabled,
            rows: None,
        });
        key
    }

    /// Adds a [`MenuList`]'s rows at level `level`, forgotten when the
    /// current owner ends.
    fn add_rows(&self, rows: Rc<Rows>) {
        let key = self.next.get() + 1;
        self.next.set(key);
        // A row the keys are waiting for goes with its list.
        let (pending, gone) = (self.pending.clone(), rows.clone());
        cleanup(move || {
            let waits = matches!(&*pending.borrow(), Some(p) if Rc::ptr_eq(&p.rows, &gone));
            if waits {
                pending.replace(None);
            }
        });
        self.push(Entry {
            key,
            node: rows.list,
            level: rows.level,
            disabled: Prop::from(false),
            rows: Some(rows),
        });
    }

    fn push(&self, entry: Entry) {
        let key = entry.key;
        self.list.borrow_mut().push(entry);
        self.order.invalidate();
        let (list, order) = (self.list.clone(), self.order.clone());
        cleanup(move || {
            list.borrow_mut().retain(|e| e.key != key);
            order.invalidate();
        });
    }

    /// The level item `key` is in.
    fn level_of(&self, key: u64) -> Option<u32> {
        self.list.borrow().iter().find_map(|e| match &e.rows {
            None => (e.key == key).then_some(e.level),
            Some(rows) => rows
                .items
                .borrow()
                .iter()
                .any(|i| i.key == key)
                .then_some(e.level),
        })
    }

    /// Moves the focus from item `key` (or the one the pointer moved to
    /// since, whose focus may still be on its way) to the enabled item of
    /// its level that `step` names.
    fn step(&self, key: u64, step: ItemStep) {
        let key = self.pointed.get().unwrap_or(key);
        if let Some(level) = self.level_of(key) {
            self.step_in(level, Some(key), step);
        }
    }

    /// The pointer moved over item `key`, enabled: it takes the keyboard
    /// focus, as the desktops' menus highlight one item for the pointer
    /// and the keys alike, so the keys go on from it. A move, not the
    /// pointer coming over it: a list scrolled under a still pointer
    /// leaves the focus where the keys put it.
    fn point(&self, key: u64, node: ElementRef) {
        self.pending.replace(None);
        self.keyed.replace(None);
        self.pointed.set(Some(key));
        if self.focused.get_untracked() != Some(key) {
            node.focus();
        }
    }

    /// The pointer left item `key`: the focus it gave the item goes with
    /// it, as the desktops' menus show no item highlighted then.
    fn unpoint(&self, key: u64, node: ElementRef) {
        if self.pointed.get() != Some(key) {
            return;
        }
        self.pointed.set(None);
        if self.focused.get_untracked() == Some(key) {
            node.blur();
        }
    }

    /// Moves the focus to the enabled item of submenu `level` that `step`
    /// names from item `key`, or from none: Down and Home go to the
    /// first, Up and End to the last, Page Down and Page Up a page from
    /// the start or the end ([`Self::page`]). A list's rows count one by
    /// one, made or not.
    fn step_in(&self, level: u32, key: Option<u64>, step: ItemStep) {
        // A row the keys are still waiting for counts as reached, so keys
        // pressed faster than the list makes rows each move on one.
        let waiting = self.pending.take().filter(|p| p.level == level);
        let walk = self.walk(level);
        let place = waiting
            .and_then(|p| {
                walk.place_of_row(&p.rows, p.index)
                    .filter(|_| p.index < p.rows.len())
            })
            .or_else(|| key.and_then(|key| walk.place_of(key)));
        let (from, dir) = match (step, place) {
            (ItemStep::First, _) => (Start::Outside, Dir::Forward),
            (ItemStep::Last, _) => (Start::Outside, Dir::Backward),
            (ItemStep::Next, None) => (Start::Outside, Dir::Forward),
            (ItemStep::Previous, None) => (Start::Outside, Dir::Backward),
            (ItemStep::Next, Some(at)) => (Start::At(at), Dir::Forward),
            (ItemStep::Previous, Some(at)) => (Start::At(at), Dir::Backward),
            (ItemStep::PageDown, _) => return self.page_in_view(level, place, Dir::Forward),
            (ItemStep::PageUp, _) => return self.page_in_view(level, place, Dir::Backward),
        };
        self.walk_from(level, from, dir, usize::MAX);
    }

    /// Page Down (or Page Up, going `dir` backward) from place `place` of
    /// level `level`, or from outside its items: to the last enabled item
    /// of the ones in view after it (the first, before it), as the
    /// desktops' lists page. With the next place out of view, a view on:
    /// an item the level's scroll view holds, the last of the items that
    /// fit in its viewport with it (scrolled into view as it is focused);
    /// a list's row, the row a view of the list on (the list scrolls to
    /// it). The focus goes to the enabled one nearest it, back toward
    /// `place`. It stops at the ends.
    fn page(&self, level: u32, walk: &Walk, place: Option<usize>, dir: Dir) {
        let n = walk.len;
        let first = match (dir, place) {
            (Dir::Forward, None) => Some(0),
            (Dir::Forward, Some(at)) => Some(at + 1),
            (Dir::Backward, None) => n.checked_sub(1),
            (Dir::Backward, Some(at)) => at.checked_sub(1),
        };
        let Some(first) = first.filter(|&at| at < n) else {
            return;
        };
        let on = |at: usize| match dir {
            Dir::Forward => Some(at + 1).filter(|&next| next < n),
            Dir::Backward => at.checked_sub(1),
        };
        let target = if walk.shown(first) {
            // The places in view from it on, items and rows alike.
            let mut target = first;
            while let Some(next) = on(target).filter(|&next| walk.shown(next)) {
                target = next;
            }
            target
        } else if let Some(target) = walk.page_from(first, dir) {
            // An item the level's scroll view holds out of view.
            target
        } else {
            // A list's row out of view.
            let Some((start, end, page)) = walk.list_at(first) else {
                return;
            };
            match dir {
                Dir::Forward => (first + page - 1).min(end),
                Dir::Backward => first.saturating_sub(page - 1).max(start),
            }
        };
        let back = match dir {
            Dir::Forward => Dir::Backward,
            Dir::Backward => Dir::Forward,
        };
        self.walk_from(level, Start::On(target), back, target.abs_diff(first) + 1);
    }

    /// Binds the keys that move the focus into the menu's items while
    /// `active` and none of them has it (a menu the pointer opened), as
    /// the desktops' menus take them: Down and Home focus the first
    /// enabled item, Up and End the last, Page Down and Page Up a page
    /// from either end; from the item the pointer is on when its focus is
    /// still on its way. Once an item has the focus, its own keys take
    /// over.
    fn bind_entry_keys(&self, active: impl Fn() -> bool + 'static) {
        let (items, current) = (self.clone(), self.focused);
        crate::keys::bind_while(
            move || active() && current.get().is_none(),
            ITEM_KEYS,
            move |step| match items.pointed.get() {
                Some(key) => items.step(key, step),
                None => items.step_in(0, None, step),
            },
        );
    }

    /// Binds the keys that move the focus from item `key` while `focused`
    /// and its level is `open` (none on its way out).
    fn bind_keys(&self, key: u64, focused: Signal<bool>, open: Memo<bool>) {
        let current = self.focused;
        effect(move || {
            if focused.get() {
                current.set(Some(key));
            } else if current.get_untracked() == Some(key) {
                current.set(None);
            }
        });
        // The menu's own state may go before the item.
        cleanup(move || {
            if untracked(|| current.try_get()) == Some(Some(key)) {
                current.try_set(None);
            }
        });
        let items = self.clone();
        crate::keys::bind_while(
            move || focused.get() && open.get(),
            ITEM_KEYS,
            move |step| items.step(key, step),
        );
    }
}

impl MenuContext {
    /// Sheet: the items of this level are the ones shown.
    fn shown(&self) -> bool {
        let level = self.level;
        self.path.with(|p| p.last().copied().unwrap_or(0) == level)
    }
}

/// Closes the submenu of a level that is open unless it is `keep` (the
/// submenu whose trigger the pointer or the keyboard focus came to): the
/// pointer over another item of the level closes it, and so does the
/// keyboard focus moving to one, as the desktops' menus do, so one item of
/// the level is highlighted at a time.
fn close_other_submenu(
    open_sub: Signal<Option<u32>>,
    why: Why,
    keep: Option<u32>,
    reason: OpenChangeReason,
) {
    let open = open_sub.get_untracked();
    if open.is_some() && open != keep {
        why.stamp(reason);
        open_sub.set(None);
    }
}

/// Level `level`'s items in a scroll view, which its popup (held to the
/// room on its side) or sheet (to the window) shrinks: the items scroll
/// past it instead of running out of the window, as `gpui-component`'s
/// menu scrolls its items past its `max_h`. The keys bring the item they
/// focus into view ([`Items::reveal`]).
fn items_scroll(items: &Items, level: u32, children: Prop<Children>) -> AnyElement {
    let me = element_ref();
    let offset = signal(Points::ZERO);
    items.add_scroll(level, me, offset);
    scroll()
        .element_ref(&me)
        .flex_shrink(1.0)
        .min_h(px(0.0))
        .on_scroll(move |e: &ScrollEvent| offset.set(e.offset.y))
        .child(children)
        .into_element()
}

/// The parts and placement both kinds of menus take.
#[derive(Clone, Copy)]
struct Surface {
    placement: Prop<Placement>,
    align: Prop<Align>,
    offset: Prop<Points>,
    margin: Prop<Points>,
    popup_class: Prop<Option<SharedString>>,
    popup_style: Prop<Style>,
    popup_starting_class: Prop<Option<SharedString>>,
    popup_starting_style: Prop<Style>,
    popup_ending_class: Prop<Option<SharedString>>,
    popup_ending_style: Prop<Style>,
    backdrop_class: Prop<Option<SharedString>>,
    backdrop_style: Prop<Style>,
}

impl Surface {
    /// The desktop popup's looks.
    fn looks(self) -> StateLooks {
        StateLooks {
            class: Some(self.popup_class),
            style: Some(self.popup_style),
            starting_class: self.popup_starting_class,
            starting_style: self.popup_starting_style,
            ending_class: self.popup_ending_class,
            ending_style: self.popup_ending_style,
        }
    }
}

/// Where a menu's popup goes on the desktops.
#[derive(Clone)]
enum At {
    Trigger(ElementRef),
    /// At a point, about the element a closing gives the focus back to;
    /// below that element while there is no point (the app opened it).
    Pointer(Signal<Option<Point<Points>>>, ElementRef),
}

/// What the user asked of a menu, which its items read: the item an
/// opening from the keyboard focuses, and why its submenus open or close.
#[derive(Clone, Copy)]
struct Asked {
    keyed: Stored<Option<Keyed>>,
    why: Why,
}

/// The menu while it is open: its popup or sheet, with the context its
/// items read. `change` asks to open or close it.
fn surface(
    open: OpenState,
    change: Rc<dyn Fn(bool, OpenChangeReason)>,
    emit: Rc<dyn Fn(MenuEvent)>,
    at: At,
    parts: Surface,
    asked: Asked,
    children: Prop<Children>,
) -> AnyElement {
    let Asked { keyed, why } = asked;
    let sheet = !is_desktop();
    // Why it last closed: a press outside put the focus where it pressed.
    let closed_by = stored(None::<OpenChangeReason>);
    let change: Rc<dyn Fn(bool, OpenChangeReason)> = Rc::new(move |next, reason| {
        if !next {
            closed_by.replace(Some(reason));
        }
        change(next, reason);
    });
    let path = signal(Vec::<u32>::new());
    let open_sub = signal(None::<u32>);
    let close = {
        let change = change.clone();
        Rc::new(move |reason: OpenChangeReason| change(false, reason))
    };
    let presence = PopupPresence::new(move || !sheet && open.get(), parts.looks());
    let items = Items::new(keyed);
    // A popup opened with no item focused (by the pointer) takes the
    // arrows, Home and End as well.
    if !sheet {
        items.bind_entry_keys(move || presence.mounted() && open.get());
    }
    provide_context(MenuContext {
        close,
        sheet,
        path,
        level: 0,
        open_sub,
        open: computed(move || open.get()),
        next: stored(1),
        looks: parts.looks(),
        popup: presence.popup(),
        items: items.clone(),
        leave: None,
        why,
    });
    // An attempt to close it: reported, then it closes (none while it
    // goes).
    let dismiss = {
        let (change, emit) = (change.clone(), emit.clone());
        Rc::new(move |reason: OpenChangeReason| {
            if !open.get_untracked() {
                return;
            }
            emit(MenuEvent::Cancel);
            change(false, reason);
        })
    };
    // Escape and back leave the innermost submenu of a sheet first.
    let cancel = {
        let dismiss = dismiss.clone();
        move || {
            if !path.with_untracked(|p| p.is_empty()) {
                why.stamp(OpenChangeReason::Cancel);
                path.update(|p| {
                    p.pop();
                });
            } else {
                dismiss(OpenChangeReason::Cancel);
            }
        }
    };
    // A sheet comes in and goes with its motion; a popup with the app's
    // transitions between its looks.
    let motion = SheetMotion::new(move || sheet && open.get(), || Placement::Bottom);
    // The keyboard focus in a trigger's popup as it closes (Escape, an
    // item chosen) goes back to the trigger as the popup starts to go, as
    // a select's does: a key pressed during its exit is the trigger's, not
    // the item's it was on. Not after a press outside, which put the focus
    // where it pressed.
    let trigger = match &at {
        At::Trigger(anchor) | At::Pointer(_, anchor) if !sheet => Some(*anchor),
        _ => None,
    };
    if let Some(anchor) = trigger {
        presence.focus_back_on_close(
            move || open.get(),
            move || {
                if closed_by.get() != Some(OpenChangeReason::PressOutside) {
                    anchor.focus();
                }
            },
        );
    }
    // Opened again from the keyboard on its way out, it is taken back with
    // its items still there: no layout comes to focus the one asked for.
    if !sheet {
        let items = items.clone();
        effect(move || {
            if open.get() && keyed.get().is_some() && presence.mounted_untracked() {
                untracked(|| items.focus_pending());
            }
        });
    }
    {
        let (opened, closed) = (emit.clone(), emit.clone());
        lifecycle(
            move || {
                if sheet {
                    motion.there()
                } else {
                    presence.mounted()
                }
            },
            move || {
                closed_by.replace(None);
                opened(MenuEvent::Open);
            },
            move || {
                closed(MenuEvent::Close);
                closed_by.replace(None);
            },
        );
    }
    let placed = emit.clone();
    when(
        move || {
            if sheet {
                motion.shown.get()
            } else {
                presence.mounted()
            }
        },
        move || {
            // The trigger may be a toolbar's item; the items are not.
            leave_bar();
            // Each opening starts at the top.
            path.set(Vec::new());
            open_sub.set(None);
            if sheet {
                let dismiss = dismiss.clone();
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
                    // Below the status bar, whatever the items.
                    .max_h(move || Length::from(window().height - safe_area().top))
                    .role(AccessibilityRole::Menu)
                    .app_class(parts.popup_class)
                    .inline_style(parts.popup_style)
                    .bind_translate_y(&motion.y)
                    .on_layout(move |frame: &Bounds<Points>| motion.laid_out(frame.size))
                    .on_cancel(cancel.clone())
                    .child(items_scroll(&items, 0, children));
                return vec![backdrop.into_element(), panel.into_element()];
            }
            let popup = match &at {
                At::Trigger(anchor) => overlay().anchor_content(anchor),
                At::Pointer(point, anchor) => {
                    let (point, anchor) = (*point, *anchor);
                    overlay().anchor_to(move || match point.get() {
                        Some(p) => OverlayAnchor::Point(p),
                        None => anchor
                            .node()
                            .map_or(OverlayAnchor::None, OverlayAnchor::Content),
                    })
                }
            };
            let dismiss = dismiss.clone();
            let placed = placed.clone();
            let room = signal(None::<Points>);
            let popup = popup
                .placement(parts.placement)
                .align(parts.align)
                .offset(parts.offset)
                .margin(parts.margin)
                .role(AccessibilityRole::Menu)
                .element_ref(&presence.popup())
                .app_class(move || presence.class())
                .state_inline_style(move || presence.style())
                // Never past the room on its side: its items scroll. Until
                // the core says where it went, the window bounds it.
                .max_h(move || Length::from(room.get().unwrap_or_else(|| window().height)))
                .on_position(move |p: &OverlayPosition| {
                    room.set(Some(p.available.height));
                    placed(MenuEvent::Position(p.placement, p.bounds, p.available))
                })
                .on_press_outside(move |_: &Point<Points>| dismiss(OpenChangeReason::PressOutside))
                .on_cancel(cancel.clone())
                .child(items_scroll(&items, 0, children));
            vec![popup.into_element()]
        },
    )
    .into_element()
}

/// The props of [`Menu`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct MenuProps {
    /// Open (controlled): the app owns the value and changes it in
    /// `onOpenChange`. Without it the menu keeps its own state.
    pub open: Prop<Option<bool>>,
    /// Open at first, while `open` is not set.
    #[prop(default)]
    pub default_open: Prop<bool>,
    /// Desktops: the side of the trigger it goes on (default `"bottom"`);
    /// the other side when only that one has room.
    #[prop(default)]
    pub placement: Prop<Placement>,
    /// Desktops: how it lines up with the trigger (default `"start"`).
    #[prop(default = Align::Start)]
    pub align: Prop<Align>,
    /// Desktops: the gap between the trigger and the popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// Desktops: the distance it keeps from the edges of the safe area.
    #[prop(default)]
    pub margin: Prop<Points>,
    /// The classes of the popup the items are in (desktops), or of the
    /// sheet (touch screens); its submenus' popups take them too.
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the popup or sheet, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// Desktops: classes the popup (and its submenus' popups) has in its
    /// first frame, which its `transition` classes animate from
    /// (Tailwind's `starting:`, CSS's `@starting-style`): its entrance. A
    /// state's classes apply over `popupClass` and `popupStyle`, as a
    /// state's styles do. The sheet of touch screens has its own motion.
    pub popup_starting_class: Prop<Option<SharedString>>,
    /// Desktops: the inline style of the popup in its first frame, over
    /// `popupStyle`.
    #[prop(default)]
    pub popup_starting_style: Prop<Style>,
    /// Desktops: classes the popup has while it goes: it stays, taking no
    /// presses, until the transitions it has then ran (`onClose` after),
    /// so they run its exit.
    pub popup_ending_class: Prop<Option<SharedString>>,
    /// Desktops: the inline style of the popup while it goes, over
    /// `popupStyle`.
    #[prop(default)]
    pub popup_ending_style: Prop<Style>,
    /// Touch screens: the classes of the backdrop behind the sheet
    /// (pressing it closes the menu).
    pub backdrop_class: Prop<Option<SharedString>>,
    /// The inline style of the backdrop, over its classes.
    #[prop(default)]
    pub backdrop_style: Prop<Style>,
    /// What opens it when pressed.
    pub trigger: Prop<Option<Slot>>,
    /// The items (`MenuItem`, `MenuSeparator`, `Submenu`, anything else),
    /// made on each opening.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// The events of a menu.
#[derive(Debug, Clone, PartialEq, Event)]
pub enum MenuEvent {
    /// It opened or closed (by the trigger, a press outside or on the
    /// backdrop, Escape or back, an item chosen), with why: set `open` to
    /// follow it.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
    /// It is shown (a sheet once it came in).
    Open,
    /// It is gone (a sheet once it went, a popup after its exit; also when
    /// the app closed it).
    Close,
    /// The user tried to close it without choosing (Escape or back, a press
    /// outside or on the backdrop).
    Cancel,
    /// Desktops: the popup was placed: the side it went on (the other side
    /// of `placement` when only that one had room), its frame in the root
    /// view and the room on that side.
    #[args(placement, bounds, available)]
    Position(Placement, Bounds<Points>, Size<Points>),
}

/// A menu its trigger opens: a popup at the trigger on the desktops, a
/// sheet at the bottom of the screen on phones and tablets (over a
/// backdrop), whose items are `MenuItem`s, `MenuSeparator`s and `Submenu`s
/// (cascading popups on the desktops, the sheet's next items on touch
/// screens). Choosing an item, a press outside, Escape and the Android back
/// button close it. Return, Space or Down on the focused trigger opens it
/// with the keyboard focus on its first enabled item, Up on its last
/// (WAI-ARIA's menu button); a press opens it with none, and on the
/// desktops Down or Home then focuses the first, Up or End the last, as
/// the desktops' menus do. Page Down and Page Up go to the last and first
/// enabled items in view, a view at a time, stopping at the ends. On the
/// desktops the pointer moving over an item gives it the keyboard focus,
/// so the keys go on from it (its `focus:` styles apply, as `hover:`
/// ones). The popup (each submenu's too) is never taller than the room on
/// the side it goes on, nor the sheet than the window below the status
/// bar: the items scroll inside it, the keys bring the item they move to
/// into view, and a submenu closes once its trigger scrolls out of view.
/// It goes on the side where it fits whole. It looks like nothing: style
/// the popup or sheet with `popupClass` / `popupStyle` (draw the surface
/// there, around the scrolling items), the backdrop with `backdropClass` /
/// `backdropStyle`, and the items.
#[component]
pub fn Menu(props: MenuProps, cx: Scope<MenuEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    // An opening from the keyboard: which item it focuses once they are
    // there.
    let keyed = stored(None::<Keyed>);
    let why = Why::new();
    let change: Rc<dyn Fn(bool, OpenChangeReason)> = Rc::new(move |next, reason| {
        if !next {
            keyed.replace(None);
        }
        why.stamp(reason);
        open.request(next, || cx.emit(MenuEvent::OpenChange(next, reason)));
    });
    let anchor = element_ref();
    let parts = Surface {
        placement: props.placement,
        align: props.align,
        offset: props.offset,
        margin: props.margin,
        popup_class: props.popup_class,
        popup_style: props.popup_style,
        popup_starting_class: props.popup_starting_class,
        popup_starting_style: props.popup_starting_style,
        popup_ending_class: props.popup_ending_class,
        popup_ending_style: props.popup_ending_style,
        backdrop_class: props.backdrop_class,
        backdrop_style: props.backdrop_style,
    };
    let toggle = change.clone();
    // In a toolbar, the trigger is one of its items.
    let around = popup_bar();
    // The trigger's keys while it has the keyboard focus and the menu is
    // closed: open it at its first item (Return, Space, Down) or its last
    // (Up), as WAI-ARIA's menu button does; a press opens it with none.
    let focused = signal(false);
    let vertical = around
        .as_ref()
        .is_some_and(|b| b.axis == Some(Axis::Vertical));
    {
        let change = change.clone();
        effect(move || {
            if !focused.get() || open.get() {
                return;
            }
            let keys = [
                ("enter", Keyed::First),
                ("space", Keyed::First),
                ("down", Keyed::First),
                ("up", Keyed::Last),
            ];
            // A column toolbar's Up and Down move along it.
            let keys = if vertical { &keys[..2] } else { &keys[..] };
            for &(key, how) in keys {
                let change = change.clone();
                on_key_with(
                    key,
                    KeyOptions {
                        when: When::NotEditing,
                        repeat: false,
                        for_focus: true,
                        ..Default::default()
                    },
                    move |_| {
                        keyed.replace(Some(how));
                        change(true, OpenChangeReason::TriggerPress);
                    },
                );
            }
        });
    }
    // In a bar, the menu open is the bar's: the pointer over another
    // menu's trigger moves it there.
    if let Some(menus) = around.as_ref().map(|b| b.open_menu.clone()) {
        let me = change.clone();
        effect(move || {
            let on = open.get();
            let mut menu = menus.borrow_mut();
            if on {
                *menu = Some(me.clone());
            } else if menu.as_ref().is_some_and(|m| Rc::ptr_eq(m, &me)) {
                *menu = None;
            }
        });
    }
    view()
        .child(props.trigger.place(move |trigger| {
            let toggle = toggle.clone();
            let menus = around.as_ref().map(|b| b.open_menu.clone());
            let me = toggle.clone();
            let trigger = trigger
                .element_ref(&anchor)
                .accessibility_state(move || AccessibilityState {
                    expanded: Some(open.get()),
                    has_popup: true,
                    ..AccessibilityState::default()
                })
                .on_focus(move || focused.set(true))
                .on_blur(move || focused.set(false))
                .on_press(move || {
                    keyed.replace(None);
                    toggle(!open.get_untracked(), OpenChangeReason::TriggerPress)
                })
                .on_mouse_enter(move |_: &MouseEvent| {
                    let shown = menus.as_ref().and_then(|m| m.borrow().clone());
                    if let Some(shown) = shown
                        && !Rc::ptr_eq(&shown, &me)
                    {
                        shown(false, OpenChangeReason::Hover);
                        me(true, OpenChangeReason::Hover);
                    }
                });
            bar_trigger(around.clone(), trigger, anchor)
        }))
        .child(surface(
            open,
            change,
            Rc::new(move |e| cx.emit(e)),
            At::Trigger(anchor),
            parts,
            Asked { keyed, why },
            props.children,
        ))
}

/// The props of [`ContextMenu`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ContextMenuProps {
    /// Open (controlled): the app owns the value and changes it in
    /// `onOpenChange`. Without it the menu keeps its own state. Set true
    /// by the app itself (a key of its own, a list with the focus asking
    /// for its row's menu), it opens as from the keyboard: below the
    /// trigger with the keyboard focus on its first enabled item.
    pub open: Prop<Option<bool>>,
    /// No menu: the secondary button and held fingers do nothing.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// Desktops: the gap between the pointer and the popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// Desktops: the distance it keeps from the edges of the safe area.
    #[prop(default)]
    pub margin: Prop<Points>,
    /// The classes of the popup (desktops) or of the sheet (touch
    /// screens).
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the popup or sheet, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// Desktops: classes the popup has in its first frame, which its
    /// `transition` classes animate from: its entrance (as `Menu`'s).
    pub popup_starting_class: Prop<Option<SharedString>>,
    /// Desktops: the inline style of the popup in its first frame.
    #[prop(default)]
    pub popup_starting_style: Prop<Style>,
    /// Desktops: classes the popup has while it goes, until the
    /// transitions it has then ran: its exit (as `Menu`'s).
    pub popup_ending_class: Prop<Option<SharedString>>,
    /// Desktops: the inline style of the popup while it goes.
    #[prop(default)]
    pub popup_ending_style: Prop<Style>,
    /// Touch screens: the classes of the backdrop behind the sheet.
    pub backdrop_class: Prop<Option<SharedString>>,
    /// The inline style of the backdrop, over its classes.
    #[prop(default)]
    pub backdrop_style: Prop<Style>,
    /// What it is about: the secondary button on it (desktops), a finger
    /// held on it (touch screens), Shift+F10 or the Menu key while it has
    /// the focus (the web, Linux) or a screen reader's "show menu" action (macOS,
    /// Windows) opens the menu.
    pub trigger: Prop<Option<Slot>>,
    /// The items, made on each opening.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// A menu about its trigger: the secondary button (a right click, a
/// two-finger click) opens it where the pointer is on the desktops; a
/// finger held on the trigger opens it as a sheet at the bottom of the
/// screen on phones and tablets. While it is open, a secondary click on
/// the trigger opens it again where the pointer is (it reports closing,
/// then opening); one elsewhere closes it. Shift+F10 or the Menu key on the focused
/// trigger (the web, Linux) and a screen reader's "show menu" action (VoiceOver's
/// VO-Shift-M on macOS, UI Automation's `ShowContextMenu` on Windows) open
/// it below the trigger with the keyboard focus on its first enabled item,
/// as WAI-ARIA has it, and closing it gives the focus back to the trigger.
/// So does an opening by the app (`open` set true with no request from
/// the trigger).
/// Opened by the pointer with no item focused, Down or Home focus the
/// first enabled item and Up or End the last, as `Menu`'s keys do.
/// Its items are those of `Menu`, and so is how it
/// closes and how it is styled.
#[component]
pub fn ContextMenu(props: ContextMenuProps, cx: Scope<MenuEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, Prop::from(false));
    // An opening from the keyboard or an assistive technology focuses the
    // first enabled item once they are there.
    let keyed = stored(None::<Keyed>);
    let why = Why::new();
    let change: Rc<dyn Fn(bool, OpenChangeReason)> = Rc::new(move |next, reason| {
        if !next {
            keyed.replace(None);
        }
        if next && props.disabled.get_untracked() {
            return;
        }
        why.stamp(reason);
        open.request(next, || cx.emit(MenuEvent::OpenChange(next, reason)));
    });
    // Where the pointer asked for it; none when the app opened it.
    let point = signal(None::<Point<Points>>);
    let anchor = element_ref();
    // Opened by the app itself (a key of its own, a list with the focus
    // asking for its row's menu) rather than by the trigger: below the
    // trigger with the first enabled item focused, as from the keyboard.
    let shown = stored(false);
    effect(move || {
        let now = open.get();
        let before = shown.replace(now);
        if now && !before && untracked(|| open.opened_by_app()) {
            point.set(None);
            keyed.replace(Some(Keyed::First));
        }
    });
    let parts = Surface {
        placement: Prop::from(Placement::Bottom),
        align: Prop::from(Align::Start),
        offset: props.offset,
        margin: props.margin,
        popup_class: props.popup_class,
        popup_style: props.popup_style,
        popup_starting_class: props.popup_starting_class,
        popup_starting_style: props.popup_starting_style,
        popup_ending_class: props.popup_ending_class,
        popup_ending_style: props.popup_ending_style,
        backdrop_class: props.backdrop_class,
        backdrop_style: props.backdrop_style,
    };
    let hold = stored(None::<(Spawned<()>, Point<Points>)>);
    let opener = change.clone();
    view()
        .child(props.trigger.place(move |trigger| {
            let on_menu = opener.clone();
            let on_hold = opener.clone();
            trigger
                .element_ref(&anchor)
                .on_context_menu(move |e: &ContextMenuEvent| {
                    point.set(Some(e.page_position));
                    // No pointer: the keyboard (Shift+F10, the Menu key) or
                    // an assistive technology, placed at the trigger by the
                    // platform.
                    keyed.replace(e.pointer_type.is_none().then_some(Keyed::First));
                    on_menu(true, OpenChangeReason::ContextMenu);
                })
                // Observed, never claimed: the trigger's presses and the
                // scroll views around it go on.
                // A held finger opens it on any touch screen, a desktop's
                // too (a touch laptop, a browser with a mouse and a touch
                // screen); opening again when the platform also raises a
                // context menu for the hold changes nothing. A held mouse
                // button, which desktops also report as a touch, is a slow
                // click or the start of a drag: it opens nothing (the
                // secondary button does).
                .on_touch(move |e: &TouchEvent| {
                    let at = e.points.first().map(|p| p.page);
                    match e.phase {
                        TouchPhase::Start
                            if e.points.len() == 1
                                && e.points[0].pointer_type != PointerType::Mouse =>
                        {
                            let on_hold = on_hold.clone();
                            let page = at.unwrap_or_default();
                            let task = set_timeout(HOLD, move || {
                                hold.replace(None);
                                // The finger went to the menu: lifting it
                                // presses nothing (no `onPress` or
                                // `onPressUp`) and the trigger's `active:`
                                // styles reset now.
                                anchor.cancel_press();
                                keyed.replace(None);
                                point.set(Some(page));
                                on_hold(true, OpenChangeReason::LongPress);
                            });
                            if let Some((old, _)) = hold.replace(Some((task, page))) {
                                old.cancel();
                            }
                        }
                        TouchPhase::Move => {
                            let moved = hold.with(|h| {
                                h.as_ref().zip(at).is_some_and(|((_, from), to)| {
                                    let (dx, dy) = (to.x.0 - from.x.0, to.y.0 - from.y.0);
                                    dx * dx + dy * dy > SLOP * SLOP
                                })
                            });
                            if moved && let Some((old, _)) = hold.replace(None) {
                                old.cancel();
                            }
                        }
                        _ => {
                            if let Some((old, _)) = hold.replace(None) {
                                old.cancel();
                            }
                        }
                    }
                })
        }))
        .child(surface(
            open,
            change,
            Rc::new(move |e| cx.emit(e)),
            At::Pointer(point, anchor),
            parts,
            // The secondary button and a held finger open it with no item
            // focused, the keyboard with the first.
            Asked { keyed, why },
            props.children,
        ))
}

/// The props of [`MenuItem`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct MenuItemProps {
    /// Not chosen: no presses, `disabled:` styles apply, screen readers say
    /// it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// Checked or not, which makes it a checkable item (a setting the menu
    /// shows, one choice of a group): screen readers say whether it is
    /// checked, and `checked:` styles apply to it and its indicator while
    /// it is. The app owns the value: choosing the item reports `onSelect`,
    /// and the item shows the value the app passes back.
    pub checked: Prop<Option<bool>>,
    /// The style while checked, as `checked:` classes.
    #[prop(default)]
    pub checked_style: Prop<Style>,
    /// What it is for screen readers: `"menuitemcheckbox"` while `checked`
    /// is set, `"menuitem"` otherwise; `"menuitemradio"` for one choice of a
    /// group of items, which the app checks one at a time.
    pub role: Prop<Option<AccessibilityRole>>,
    /// Choosing it closes the menu (default true).
    #[prop(default = true)]
    pub close_on_select: Prop<bool>,
    /// What screen readers say, when its content is not enough.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of the indicator, the part around the mark
    /// before the content; `checked:` and `disabled:` follow the item, and
    /// with `group` the mark's `group-checked:` classes do too.
    pub indicator_class: Prop<Option<SharedString>>,
    /// The style of the indicator, over `indicatorClass`.
    #[prop(default)]
    pub indicator_style: Prop<Style>,
    /// The content of the indicator: the mark that shows the item checked
    /// (a check, a radio's dot), the app's element. It stays while the
    /// value changes; the indicator's `checked:` styles (or the mark's
    /// `group-checked:`) show and hide it.
    pub indicator: Prop<Option<Slot>>,
    /// The content.
    pub children: Prop<Children>,
}

/// The events of a [`MenuItem`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum MenuItemEvent {
    /// It was chosen (a checkable item asks for the other value: the app
    /// sets `checked`).
    Select,
}

/// An item of a `Menu`, `ContextMenu` or `Submenu`: pressing it chooses it
/// (`onSelect`) and closes the menu (unless `closeOnSelect` is false). With
/// `checked` it is a checkable item, alone or one choice of a group (`role`
/// `"menuitemradio"`), as `gpui-component`'s `PopupMenuItem::checked`. Its
/// look is the app's: `class`, `style`, the `active:`, `hover:`,
/// `disabled:` and `checked:` states, and the `indicator` it shows checked
/// with. In a terminal a checkable item is a row of its content from the
/// row's start and the terminal's own mark at its end, in place of the
/// indicator: `✓` checked (`●` on a `"menuitemradio"` item), a blank Cell
/// unchecked ([`crate::terminal`]).
#[component]
pub fn MenuItem(props: MenuItemProps, cx: Scope<MenuItemEvent>) -> impl IntoElement {
    let menu = use_context::<MenuContext>();
    let hover = menu.clone();
    let chosen = menu.clone();
    let laid_out = menu.clone();
    let moved = menu.clone();
    let sheet = menu.filter(|m| m.sheet);
    let (checked, disabled) = (props.checked, props.disabled);
    let node = element_ref();
    let focused = signal(false);
    let key = hover.as_ref().map(|m| {
        let key = m.items.add(node, m.level, disabled);
        m.items.bind_keys(key, focused, m.open);
        key
    });
    // Desktops: the pointer moving over it gives it the keyboard focus.
    let pointer = hover
        .as_ref()
        .filter(|m| !m.sheet)
        .map(|m| m.items.clone())
        .zip(key);
    let (moved_over, left) = (pointer.clone(), pointer);
    // In a submenu, Left on the item leaves it for its trigger.
    if let Some((leave, open)) = hover
        .as_ref()
        .and_then(|m| m.leave.clone().zip(Some(m.open)))
    {
        crate::keys::bind_while(
            move || focused.get() && open.get(),
            &[("left", false, ())],
            move |()| leave(),
        );
    }
    let (indicator, children, role) = (props.indicator, props.children, props.role);
    let (indicator_class, indicator_style) = (props.indicator_class, props.indicator_style);
    // The indicator is a part that takes the item's states, as
    // `Checkbox`'s: it is no checkable element of its own for screen
    // readers, and only it restyles when the value changes.
    let terminal = is_terminal();
    let parts = move || {
        let mark = match terminal {
            // The terminal's own mark at a checkable item's end, in place
            // of the app's indicator: `✓` (`●` on a radio item), a blank
            // Cell unchecked, so the content starts in one column on every
            // row and the marks line up at the right.
            true => when(
                move || checked.get().is_some(),
                move || {
                    text(move || match checked.get() {
                        Some(true) if role.get() == Some(AccessibilityRole::MenuItemRadio) => {
                            MENU_RADIO
                        }
                        Some(true) => MENU_CHECK,
                        _ => MENU_UNCHECKED,
                    })
                    .ml(auto())
                },
            ),
            // A view of its own, as `Checkbox`'s indicator: the projected
            // states and the app's classes land on one node, which the
            // mark inside reads as a group.
            false => when(
                move || indicator.get().is_some(),
                move || {
                    view()
                        .project_checked(move || checked.get() == Some(true))
                        .project_disabled(disabled)
                        .app_class(indicator_class)
                        .inline_style(indicator_style)
                        .child(indicator.place(|mark| mark))
                },
            ),
        };
        match terminal {
            true => vec![children.into_element(), mark.into_element()],
            false => vec![mark.into_element(), children.into_element()],
        }
    };
    let content = match sheet.clone() {
        // Only the items of the level shown are there (for screen readers
        // and tests too).
        Some(m) => vec![when(move || m.shown(), parts).into_element()],
        None => parts(),
    };
    view()
        .role(move || {
            role.get().unwrap_or(if checked.get().is_some() {
                AccessibilityRole::MenuItemCheckbox
            } else {
                AccessibilityRole::Menuitem
            })
        })
        .accessibility_state(move || AccessibilityState {
            checked: checked
                .get()
                .map(|on| if on { Checked::True } else { Checked::False }),
            ..AccessibilityState::default()
        })
        .element_ref(&node)
        .on_layout(move |_: &Bounds<Points>| {
            if let Some(m) = &laid_out {
                m.items.focus_pending();
            }
        })
        .checked_style(props.checked_style)
        .disabled(disabled)
        .optional_label(props.accessibility_label)
        .on_focus(move || {
            focused.set(true);
            // The keyboard on another item of its level closes a submenu
            // of the level the pointer opened.
            if let Some(m) = &moved {
                close_other_submenu(m.open_sub, m.why, None, OpenChangeReason::Focus);
            }
        })
        .on_blur(move || focused.set(false))
        .when(terminal, |v| v.flex_row())
        .when_some(sheet, |v, m| {
            v.style_when(move || !m.shown(), |s| s.hidden())
        })
        // Over another item, a submenu of its level closes.
        .on_mouse_enter(move |_: &MouseEvent| {
            if let Some(m) = &hover {
                close_other_submenu(m.open_sub, m.why, None, OpenChangeReason::Hover);
            }
        })
        .when_some(moved_over, |v, (items, key)| {
            v.on_mouse_move(move |_: &MouseEvent| {
                if !disabled.get_untracked() {
                    items.point(key, node);
                }
            })
        })
        .when_some(left, |v, (items, key)| {
            v.on_mouse_leave(move |_: &MouseEvent| items.unpoint(key, node))
        })
        .on_press(move || {
            // On its way out a menu takes no presses: the pointer's go
            // through it, and the keyboard's (Return on an item the focus
            // has not left yet) do nothing.
            if chosen.as_ref().is_some_and(|m| !m.open.get_untracked()) {
                return;
            }
            cx.emit(MenuItemEvent::Select);
            if props.close_on_select.get_untracked()
                && let Some(m) = &chosen
            {
                (m.close)(OpenChangeReason::Select);
            }
        })
        .children(content)
}

/// The props of [`MenuSeparator`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct MenuSeparatorProps {}

/// A line between groups of a menu's items: a view the app styles (`class`,
/// `style`), shown with its level's items. In a terminal it is a row of
/// `─` across the menu ([`crate::terminal`]).
#[component]
pub fn MenuSeparator(_props: MenuSeparatorProps, cx: Scope<NoEvent>) -> impl IntoElement {
    let _ = cx;
    let menu = use_context::<MenuContext>();
    view()
        .focusable(false)
        .when_some(menu.filter(|m| m.sheet), |v, m| {
            v.style_when(move || !m.shown(), |s| s.hidden())
        })
        // The terminal's own separator: a rule across the menu.
        .when(is_terminal(), |v| v.child(line(rule)))
}

/// A row of a [`MenuList`] as `render_item` draws it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct MenuListEntry {
    /// The row's index, from 0.
    pub index: u32,
}

/// The props of [`MenuList`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct MenuListProps {
    /// How many rows.
    #[prop(default)]
    pub count: Prop<u32>,
    /// Draws row `index`: one `MenuItem` or `Submenu` (a row without one
    /// is passed over by the keys).
    pub render_item: Prop<Option<Renderer<MenuListEntry>>>,
}

/// Rows of a menu's items in a virtualized list (Rust): only the rows near
/// its viewport are made, so a menu of any number of items (models,
/// accounts, recent files) stays cheap. Its rows are items of the level it
/// is in, among the items around it: Up, Down, Home and End walk every row
/// of the list, made or not, scrolling to a row before focusing it and
/// passing over disabled ones, and go on to the items before and after the
/// list (a submenu's trigger too); Page Down and Page Up scroll it a view
/// at a time. Bound its height with a style (`h`,
/// `max_h`); `render_item` draws each row from its index. A row's
/// `Submenu` closes with its row when the list scrolls the row away and
/// reuses its cell.
#[component]
pub fn MenuList(props: MenuListProps, cx: Scope<NoEvent>) -> impl IntoElement {
    let _ = cx;
    let menu = use_context::<MenuContext>();
    let list = element_ref();
    let count = props.count;
    let rows = Rc::new(Rows {
        list,
        count,
        level: menu.as_ref().map_or(0, |m| m.level),
        items: RefCell::new(Vec::new()),
        cells: RefCell::new(Vec::new()),
        next_cell: Cell::new(0),
        visible: Cell::new(None),
    });
    if let Some(m) = &menu {
        m.items.add_rows(rows.clone());
    }
    let render = props.render_item;
    let items = menu.as_ref().map(|m| m.items.clone());
    let sheet = menu.filter(|m| m.sheet);
    let (made, seen) = (rows.clone(), rows);
    virtual_list(
        move || count.get() as usize,
        move |at: Position| {
            let cell = made.next_cell.get() + 1;
            made.next_cell.set(cell);
            made.cells.borrow_mut().push((cell, at));
            let cells = made.clone();
            cleanup(move || cells.cells.borrow_mut().retain(|(c, _)| *c != cell));
            let rows = made.clone();
            // Made again for each row the cell shows: its item is that
            // row's.
            dynamic(move || {
                let index = at.index();
                let render = render.get()?;
                provide_context(MenuRow {
                    rows: rows.clone(),
                    index,
                });
                Some(render.render(
                    index.to_string(),
                    MenuListEntry {
                        index: index as u32,
                    },
                ))
            })
        },
    )
    .element_ref(&list)
    .viewability(Viewability {
        item_visible_threshold: Some(Percentage(0.995)),
        ..Viewability::default()
    })
    .on_viewable_items_change(move |v: &ViewableItems| {
        seen.visible.set(v.viewable);
        if let Some(items) = &items {
            items.reveal_pending();
        }
    })
    .when_some(sheet, |v, m| {
        v.style_when(move || !m.shown(), |s| s.hidden())
    })
}

/// The props of [`Submenu`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SubmenuProps {
    /// It does not open.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// Desktops: the gap between the menu around it and its popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// The item that opens it, among its menu's items.
    pub trigger: Prop<Option<Slot>>,
    /// Touch screens: the row above its items that returns to the items
    /// it is among (Escape and back do too).
    pub back: Prop<Option<Slot>>,
    /// Its items.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// The events of a [`Submenu`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum SubmenuEvent {
    /// It opened or closed as the user asked, with why: its trigger hovered
    /// (`"hover"`) or pressed, or Right, Return or Space on it
    /// (`"triggerPress"`); the pointer over another item of its menu
    /// (`"hover"`), or the keyboard focus moved to one (`"focus"`); Left,
    /// Escape, back or its `back` row (`"cancel"`); the whole menu closing
    /// (the menu's reason: `"select"`, `"pressOutside"`, ...). Its items
    /// are made as it opens, so an app can load them here the first time.
    /// Not when the app closes the menu itself.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
}

/// A menu inside a menu: on the desktops its items are a popup beside its
/// trigger, opened as the pointer comes over the trigger or presses it; on
/// touch screens pressing the trigger shows its items in the sheet instead
/// of the ones around it, with its `back` row first. Its popups take the
/// menu's `popupClass` / `popupStyle` and its states' looks
/// (`popupStartingClass`, `popupEndingClass`, ...). In a terminal its
/// trigger is a row that ends with ` ›` ([`crate::terminal`]).
/// On the desktops and in a terminal, Right, Return or Space on its
/// focused trigger open it with the keyboard focus on its first enabled
/// item; Left on one of its items, or Escape, closes it with the focus
/// back on its trigger, as WAI-ARIA's menus do. `onOpenChange` reports its
/// openings and closings, as `Menu`'s reports the menu's.
#[component]
pub fn Submenu(props: SubmenuProps, cx: Scope<SubmenuEvent>) -> impl IntoElement {
    let Some(menu) = use_context::<MenuContext>() else {
        // Outside a menu: nothing to open.
        return view().child(props.trigger.place(|t| t)).into_element();
    };
    let id = menu.next.with(|n| {
        *n += 1;
        *n
    });
    let (path, open_sub, around, why) = (menu.path, menu.open_sub, menu.open, menu.why);
    // Open while chosen at its level and every level around it is open:
    // closing the menu closes it, no state written.
    let sub_open = computed(move || around.get() && open_sub.get() == Some(id));
    let presence = PopupPresence::new(move || sub_open.get(), menu.looks);
    // A sheet's: while its items are on the path.
    let open = match menu.sheet {
        true => computed(move || around.get() && path.with(|p| p.contains(&id))),
        false => sub_open,
    };
    // Each change the user asked for, once; an opening after the closings
    // of the others.
    {
        let (was, reported) = (stored(false), stored(why.get().0));
        let report = Rc::new(move |closing_only: bool| {
            let now = open.get_untracked();
            if (closing_only && now) || was.get() == now {
                return;
            }
            was.replace(now);
            let (stamp, reason) = why.get();
            if reported.replace(stamp) != stamp {
                cx.emit(SubmenuEvent::OpenChange(now, reason));
            }
        });
        why.add(id, report.clone());
        effect(move || {
            if open.get() {
                untracked(|| why.report_closings(id));
            }
            untracked(|| report(false));
        });
    }
    let anchor = element_ref();
    // Left on one of its items, or Escape: it closes and the keyboard
    // focus goes back to its trigger, as WAI-ARIA's menus do.
    let leave: Rc<dyn Fn()> = Rc::new(move || {
        why.stamp(OpenChangeReason::Cancel);
        open_sub.set(None);
        anchor.focus();
    });
    let inner = MenuContext {
        level: id,
        popup: presence.popup(),
        open_sub: signal(None),
        open,
        leave: (!menu.sheet).then(|| leave.clone()),
        ..menu.clone()
    };
    provide_context(inner.clone());
    if menu.sheet {
        let shown = menu.clone();
        let into = move || {
            if !props.disabled.get_untracked() {
                why.stamp(OpenChangeReason::TriggerPress);
                path.update(|p| p.push(id));
            }
        };
        let back = move || {
            why.stamp(OpenChangeReason::Cancel);
            path.update(|p| {
                p.pop();
            });
        };
        return view()
            .child(when(
                move || shown.shown(),
                move || {
                    props
                        .trigger
                        .place(move |t| t.role(AccessibilityRole::Menuitem).on_press(into))
                },
            ))
            .child(when(
                // While it is on the path: a submenu inside it shows its
                // own items in place of these, which hide themselves.
                move || path.with(|p| p.contains(&id)),
                move || {
                    vec![
                        when(
                            move || path.with(|p| p.last() == Some(&id)),
                            move || props.back.place(move |b| b.on_press(back)),
                        )
                        .into_element(),
                        props.children.into_element(),
                    ]
                },
            ))
            .into_element();
    }
    let item_key = menu.items.add(anchor, menu.level, props.disabled);
    let edges = menu.popup;
    let open_by = move |reason: OpenChangeReason| {
        if !props.disabled.get_untracked() && open_sub.get_untracked() != Some(id) {
            why.stamp(reason);
            open_sub.set(Some(id));
        }
    };
    // The trigger's keys while it has the keyboard focus: Right, Return
    // and Space open it with the focus on its first enabled item (it may
    // be open already, from the pointer); Left leaves the submenu the
    // trigger is in.
    let focused = signal(false);
    menu.items.bind_keys(item_key, focused, around);
    // The keyboard on its trigger closes another submenu of its level
    // that the pointer opened; its own stays as it is.
    let focus_in = move || {
        focused.set(true);
        close_other_submenu(open_sub, why, Some(id), OpenChangeReason::Focus);
    };
    {
        let (items, up) = (menu.items.clone(), menu.leave.clone());
        crate::keys::bind_while(
            move || focused.get() && around.get(),
            &[
                ("right", false, SubmenuKey::Enter),
                ("enter", false, SubmenuKey::Enter),
                ("space", false, SubmenuKey::Enter),
                ("left", false, SubmenuKey::Leave),
            ],
            move |key| match key {
                SubmenuKey::Enter if !props.disabled.get_untracked() => {
                    open_by(OpenChangeReason::TriggerPress);
                    items.focus_first(id);
                }
                SubmenuKey::Enter => {}
                SubmenuKey::Leave => {
                    if let Some(up) = &up {
                        up();
                    }
                }
            },
        );
    }
    // Escape closes it (the top overlay); the focus inside goes back to
    // the trigger.
    let inside = stored(false);
    presence.popup().on_focus_in(move || {
        inside.replace(true);
    });
    presence.popup().on_focus_out(move || {
        inside.replace(false);
    });
    let cancel = move || {
        if inside.replace(false) {
            leave();
        } else {
            why.stamp(OpenChangeReason::Cancel);
            open_sub.set(None);
        }
    };
    // The pointer moving over its trigger gives the trigger the keyboard
    // focus, as over any item of its menu.
    let pointed = {
        let items = menu.items.clone();
        Rc::new(move |_: &MouseEvent| {
            if !props.disabled.get_untracked() {
                items.point(item_key, anchor);
            }
        })
    };
    let unpointed = {
        let items = menu.items.clone();
        Rc::new(move |_: &MouseEvent| items.unpoint(item_key, anchor))
    };
    let trigger = match is_terminal() {
        // The terminal's item: the trigger's content, then ` ›` at the
        // row's end, one item.
        true => view()
            .flex_row()
            .element_ref(&anchor)
            .role(AccessibilityRole::Menuitem)
            .accessibility_state(move || AccessibilityState {
                expanded: Some(open_sub.get() == Some(id)),
                has_popup: true,
                ..AccessibilityState::default()
            })
            .on_focus(focus_in)
            .on_blur(move || focused.set(false))
            .on_mouse_enter(move |_: &MouseEvent| open_by(OpenChangeReason::Hover))
            .on_mouse_move(move |e: &MouseEvent| pointed(e))
            .on_mouse_leave(move |e: &MouseEvent| unpointed(e))
            .on_press(move || open_by(OpenChangeReason::TriggerPress))
            .child(props.trigger.place(|t| t.flex_grow(1.0)))
            .child(text(SUBMENU_ARROW).text_color(move || crate::theme::theme().muted_foreground))
            .into_element(),
        false => props.trigger.place(move |t| {
            let (pointed, unpointed) = (pointed.clone(), unpointed.clone());
            t.element_ref(&anchor)
                .role(AccessibilityRole::Menuitem)
                .accessibility_state(move || AccessibilityState {
                    expanded: Some(open_sub.get() == Some(id)),
                    has_popup: true,
                    ..AccessibilityState::default()
                })
                .on_focus(focus_in)
                .on_blur(move || focused.set(false))
                .on_mouse_enter(move |_: &MouseEvent| open_by(OpenChangeReason::Hover))
                .on_mouse_move(move |e: &MouseEvent| pointed(e))
                .on_mouse_leave(move |e: &MouseEvent| unpointed(e))
                .on_press(move || open_by(OpenChangeReason::TriggerPress))
        }),
    };
    let items = menu.items.clone();
    // Open, it closes once the menu's items scroll its trigger out of
    // view, as a `MenuList` row's does when the list scrolls the row away:
    // its popup stays beside nothing. Measured as the menu scrolls, only
    // while it is open.
    {
        let (items, level) = (items.clone(), menu.level);
        effect(move || {
            if !sub_open.get() {
                return;
            }
            let Some(scroll) = items.scroll_of(level) else {
                return;
            };
            // Returning to zero can hide a trigger at the viewport's end too.
            scroll.offset.get();
            spawn(async move {
                let (trigger, port) = (anchor.measure(), scroll.view.measure());
                let (Some(trigger), Some(port)) = (trigger.await, port.await) else {
                    return;
                };
                let top = trigger.page.y - port.page.y;
                let gone = top + trigger.frame.size.height <= Points::ZERO
                    || top >= port.frame.size.height;
                if gone && open_sub.get_untracked() == Some(id) {
                    open_sub.set(None);
                }
            });
        });
    }
    view()
        .child(trigger)
        .child(when(
            move || presence.mounted(),
            move || {
                let room = signal(None::<Points>);
                overlay()
                    .anchor_beside(&anchor, &edges)
                    .offset(props.offset)
                    .placement(Placement::Right)
                    .align(Align::Start)
                    .role(AccessibilityRole::Menu)
                    .element_ref(&presence.popup())
                    .app_class(move || presence.class())
                    .state_inline_style(move || presence.style())
                    // As the menu's: held to its room, its items scroll.
                    .max_h(move || Length::from(room.get().unwrap_or_else(|| window().height)))
                    .on_position(move |p: &OverlayPosition| room.set(Some(p.available.height)))
                    .on_cancel(cancel.clone())
                    .child(items_scroll(&items, id, props.children))
            },
        ))
        .into_element()
}

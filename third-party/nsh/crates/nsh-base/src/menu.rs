//! Menus: `Menu` (opened by a trigger), `ContextMenu` (by a secondary
//! click or a held finger), their `MenuItem`s, `MenuSeparator`s and
//! `Submenu`s.
//!
//! A `ContextMenu` given `items` (`MenuButton`'s item data) is the system's
//! context menu on iOS instead (`system_menu`): a native component the
//! iOS backend answers without JS, its children the menu elsewhere.
//!
//! One structure for every device, presented as it suits (`popup.rs`): on
//! the desktops, and on an iPad whose window is regular in width, a popup
//! at the trigger (or the pointer) whose submenus cascade beside the item
//! that opens them, on hover or press; on phones and the other tablets,
//! and on an iPad in a compact width, a sheet at the bottom of the screen,
//! over a backdrop, whose submenus replace its items (a submenu's `back`
//! row, and Escape or the back button, return to the items above). The
//! iPad follows UIKit's horizontal size class, as UIKit's own menus and
//! popovers adapt to it: a window resized across it presents the menu the
//! other way ([`as_sheet`]). The items reach their menu
//! through context, so the app arranges them freely (groups, labels,
//! conditions). An item with `checked` is checkable (a setting, or one
//! choice of a group by its `role`): the value is the app's, its indicator
//! a part that takes the item's state. A submenu keeps its own state, one
//! open per level, or with `open` asks the app, which owns it: a submenu
//! the app makes again (its row among items made from changing data)
//! opens as the app has it, and takes the keyboard focus back to where it
//! was in the one it replaces.
//!
//! Each level's items are in a scroll view inside its popup, which is held
//! to the room its overlay is told on its side (`onPosition`'s
//! `available`), so the core chooses the side at the popup's natural size
//! and the items scroll past the room rather than run out of the window.
//! The keys measure where the items are to bring the one they move to into
//! view and to page by the viewport. Typeahead matches `Select`'s
//! (`listbox.rs`) on each item's label or the text the core has for it.

use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    rc::Rc,
    time::Duration,
};

use nsh_core::{
    AccessibilityState, Checked, ContextMenuEvent, JsonValue, PointerType, TouchEvent, TouchPhase,
    element::{OrderWatch, Style, watch_order},
    geometry::Axis,
    keymap::When,
    overlay::OverlayAnchor,
    platform::{CONTEXT_MENU_COMPONENT, Idiom, Os},
    prelude::*,
    time::now,
};

use crate::{
    listbox::{self, Typeahead},
    menu_button::{MenuButtonItem, menu_json},
    popup::{
        OpenChangeReason, OpenState, PopupPresence, SheetMotion, StateLooks,
        bottom_panel_max_height, keyboard_lift, lifecycle,
    },
    roving::{bar_trigger, leave_bar, popup_bar},
    terminal::{MENU_CHECK, MENU_RADIO, MENU_UNCHECKED, SUBMENU_ARROW, is_terminal, line, rule},
};

/// How long a finger stays on a context menu's trigger before it opens
/// (less than the platforms' long press, so it opens while the finger is
/// still down), and how far it may move meanwhile.
const HOLD: Duration = Duration::from_millis(400);

thread_local! {
    /// The finger (its id) whose hold a context menu's trigger took, and
    /// that trigger. A touch reaches every trigger around the finger,
    /// innermost first: the triggers outside the one that took it start no
    /// hold of their own, so one hold opens one menu, as the secondary
    /// click does.
    static HELD: std::cell::Cell<Option<(u32, nsh_core::NodeId)>> = const { std::cell::Cell::new(None) };
}

/// Whether the hold of the finger starting `e` belongs to a context menu
/// inside the trigger `me` (one before it on the finger's path).
fn held_inside(e: &TouchEvent, me: Option<nsh_core::NodeId>) -> bool {
    let (Some(point), Some(me)) = (e.points.first(), me) else {
        return false;
    };
    let Some((finger, by)) = HELD.get() else {
        return false;
    };
    finger == point.id
        && by != me
        && point
            .path
            .iter()
            .position(|&n| n == by)
            .zip(point.path.iter().position(|&n| n == me))
            .is_some_and(|(inner, outer)| inner < outer)
}
const SLOP: f32 = 10.0;
/// iOS's system menu: how long a `ContextMenu`'s preview stays made after
/// the finger lifted or was taken over without the menu coming up (a tap,
/// a scroll); the system asks for it a moment after a takeover.
const PREVIEW_LINGER: Duration = Duration::from_secs(1);

/// What a menu's items reach through context.
#[derive(Clone)]
struct MenuContext {
    /// Closes the whole menu.
    close: Rc<dyn Fn(OpenChangeReason)>,
    /// Presented as a sheet ([`as_sheet`]).
    sheet: bool,
    /// Sheet: the submenus shown, innermost last.
    path: Signal<Vec<u32>>,
    /// The submenu the items under this context are in (0: the menu).
    level: u32,
    /// Desktops: the submenu of this level that is open, of the ones that
    /// keep their own state.
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
    /// The menu's controlled submenus, whose openings and closings the
    /// user asks of the app.
    asks: Asks,
    /// Desktops: where the keyboard focus was in an open submenu that went
    /// while the level it is in stayed open (made again with its row): that
    /// level and the item's place, which the submenu made in its place,
    /// open, focuses.
    regain: Signal<Option<(u32, usize)>>,
    /// Desktops: the submenu whose items have the keyboard focus and the
    /// focused item's place among them, kept by the menu: a submenu's own
    /// state goes with it, before it could tell.
    focus_place: Stored<Option<(u32, usize)>>,
}

impl MenuContext {
    /// Its level, as its items and submenus close the others.
    fn this_level(&self) -> Level {
        Level {
            level: self.level,
            open_sub: self.open_sub,
            why: self.why,
            asks: self.asks,
        }
    }
}

/// A controlled submenu's request to the app: to be open or closed, with
/// why.
type Ask = Rc<dyn Fn(bool, OpenChangeReason)>;

/// A submenu, which asks the app for what the user wants of it while it is
/// controlled.
#[derive(Clone)]
struct Controlled {
    id: u32,
    /// The level it is in.
    level: u32,
    /// The app's value, when the app controls it.
    controlled: Prop<Option<bool>>,
    /// Open as asked (and every level around it is).
    open: Memo<bool>,
    ask: Ask,
}

impl Controlled {
    fn is_controlled(&self) -> bool {
        self.controlled.get_untracked().is_some()
    }
}

/// A menu's submenus, for the requests of the controlled ones.
#[derive(Clone, Copy)]
struct Asks(Stored<Vec<Controlled>>);

impl Asks {
    fn new() -> Self {
        Self(stored(Vec::new()))
    }

    /// Adds one, removed when it goes.
    fn add(self, controlled: Controlled) {
        let id = controlled.id;
        self.0.with(|c| c.push(controlled));
        let all = self.0;
        // The menu's own state may go before a submenu inside it.
        cleanup(move || {
            all.try_with(|c| c.retain(|c| c.id != id));
        });
    }

    /// Submenu `id`'s request, while it is controlled.
    fn of(self, id: u32) -> Option<Ask> {
        self.0.with(|c| {
            c.iter()
                .find(|c| c.id == id && c.is_controlled())
                .map(|c| c.ask.clone())
        })
    }

    /// The requests of the controlled submenus open in `level` but `keep`.
    fn open_in(self, level: u32, keep: Option<u32>) -> Vec<Ask> {
        self.0.with(|c| {
            c.iter()
                .filter(|c| {
                    c.level == level
                        && Some(c.id) != keep
                        && c.is_controlled()
                        && c.open.get_untracked()
                })
                .map(|c| c.ask.clone())
                .collect()
        })
    }
}

/// A level of a menu: the submenu open in it that keeps its own state, and
/// the menu's controlled ones.
#[derive(Clone, Copy)]
struct Level {
    level: u32,
    open_sub: Signal<Option<u32>>,
    why: Why,
    asks: Asks,
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
    /// The last stamp that is the app's own change of a controlled
    /// submenu, no request: what it opens or closes is not reported.
    quiet: Stored<u64>,
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
            quiet: stored(0),
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

    /// The app changed a controlled submenu's value itself: what that opens
    /// or closes is no request.
    fn app_change(self) {
        let stamp = self.stamp.with(|(stamp, _)| {
            *stamp += 1;
            *stamp
        });
        self.quiet.replace(stamp);
    }

    /// Whether `stamp` is a request of the user's.
    fn asked(self, stamp: u64) -> bool {
        self.quiet.get() != stamp
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
/// its trigger (Right, Return, Space), the first enabled one of its items;
/// for a submenu made again open, the item at the place the focus was in
/// the one it replaces (the next enabled one from there).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Keyed {
    First,
    Last,
    Submenu(u32),
    At(u32, usize),
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
    /// What screen readers say for it when its content is not enough,
    /// which typeahead matches in place of its text.
    label: Prop<Option<SharedString>>,
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
    label: Prop<Option<SharedString>>,
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
    /// An enabled item, by key: focus it (a list's row: brought into
    /// view).
    Focus(u64, ElementRef, Option<(Rc<Rows>, usize)>),
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

    /// The enabled items made, by place: what typeahead matches, the
    /// label an item has or else its text. A list's rows not made yet are
    /// not among them.
    fn enabled(&self) -> Vec<(usize, Prop<Option<SharedString>>, ElementRef)> {
        let mut found = Vec::new();
        let mut start = 0;
        for e in &self.parts {
            match &e.rows {
                None => {
                    if !e.disabled.get_untracked() {
                        found.push((start, e.label, e.node));
                    }
                    start += 1;
                }
                Some(rows) => {
                    let len = rows.len();
                    let mut made: Vec<RowItem> = rows
                        .items
                        .borrow()
                        .iter()
                        .filter(|i| i.index < len && !i.disabled.get_untracked())
                        .copied()
                        .collect();
                    made.sort_by_key(|i| i.index);
                    found.extend(made.iter().map(|i| (start + i.index, i.label, i.node)));
                    start += len;
                }
            }
        }
        found
    }

    fn spot(&self, at: usize) -> Spot {
        let Some((entry, row)) = self.part_at(at) else {
            return Spot::Skip;
        };
        let Some(rows) = &entry.rows else {
            return match entry.disabled.get_untracked() {
                true => Spot::Skip,
                false => Spot::Focus(entry.key, entry.node, None),
            };
        };
        match rows.item(row) {
            Some(item) if item.disabled.get_untracked() => Spot::Skip,
            Some(item) => Spot::Focus(item.key, item.node, Some((rows.clone(), row))),
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
    /// The item the keys last moved the focus to, until it has it: the
    /// keys pressed before then go on from it, not from the item the
    /// platform still has focused.
    cursor: Rc<Cell<Option<u64>>>,
    /// Key moves under way that measure first (a reveal, a page): the
    /// keys pressed meanwhile wait in `queued`, so each acts on where the
    /// one before it left the menu, as the desktops' menus take keys typed
    /// ahead.
    busy: Rc<Cell<u32>>,
    queued: Rc<RefCell<VecDeque<Queued>>>,
    /// Each item's select, by key, for a Return or Space typed ahead of
    /// the focus.
    selects: Rc<RefCell<Vec<(u64, Select)>>>,
    /// What was typed for typeahead, as `Select`'s list keeps it, and the
    /// level it was typed in.
    typeahead: Rc<RefCell<(Option<u32>, Typeahead)>>,
}

/// A key's move waiting for the ones under way.
type Queued = Box<dyn FnOnce()>;

/// An item's select.
type Select = Rc<dyn Fn()>;

/// A key move under way: the keys waiting for it go on once it ends.
struct Busy(Items);

impl Busy {
    fn new(items: &Items) -> Self {
        items.busy.set(items.busy.get() + 1);
        Self(items.clone())
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        let items = &self.0;
        items.busy.set(items.busy.get() - 1);
        while items.busy.get() == 0 {
            let Some(next) = items.queued.borrow_mut().pop_front() else {
                break;
            };
            next();
        }
    }
}

/// The scroll view a level's items are in, and how far it is scrolled.
#[derive(Clone)]
struct LevelScroll {
    level: u32,
    view: ElementRef,
    /// Its offset, as it last reported it (or the keys scrolled it to).
    offset: Signal<Points>,
    /// Its offset as it last reported it: where the core measures its
    /// items, until it reports the scroll the keys asked for.
    reported: Signal<Points>,
}

impl LevelScroll {
    /// How far a measured position is from where it is once the scroll
    /// the keys asked for is done.
    fn lag(&self) -> f32 {
        (self.reported.get_untracked() - self.offset.get_untracked()).0
    }
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
            cursor: Rc::new(Cell::new(None)),
            busy: Rc::new(Cell::new(0)),
            queued: Rc::new(RefCell::new(VecDeque::new())),
            selects: Rc::new(RefCell::new(Vec::new())),
            typeahead: Rc::new(RefCell::new((None, Typeahead::default()))),
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
            let (level, start, dir) = match how {
                Keyed::First => (0, Start::Outside, Dir::Forward),
                Keyed::Last => (0, Start::Outside, Dir::Backward),
                Keyed::Submenu(level) => (level, Start::Outside, Dir::Forward),
                Keyed::At(level, place) => (level, Start::On(place), Dir::Forward),
            };
            if self.walk_from(level, start, dir, usize::MAX) {
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
                Spot::Focus(key, node, _) => (p.level, place, p.dir, Err((key, node))),
                Spot::Skip => (p.level, place, p.dir, Ok(p.budget)),
            }
        };
        self.pending.replace(None);
        match budget {
            Err((key, node)) => {
                self.cursor.set(Some(key));
                node.focus();
            }
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
                Spot::Focus(key, node, row) => {
                    match row {
                        Some((rows, index)) => rows.bring(index, dir),
                        None => self.reveal(level, node),
                    }
                    self.cursor.set(Some(key));
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
    fn add_scroll(
        &self,
        level: u32,
        view: ElementRef,
        offset: Signal<Points>,
        reported: Signal<Points>,
    ) {
        self.scrolls.borrow_mut().push(LevelScroll {
            level,
            view,
            offset,
            reported,
        });
        let scrolls = self.scrolls.clone();
        cleanup(move || scrolls.borrow_mut().retain(|s| s.view != view));
    }

    /// Scrolls item `node` of level `level` into its scroll view, the keys
    /// having moved to it: the platforms bring only a focused text field
    /// into view, and a menu held to its room scrolls its items past it.
    /// The pointer's focus never scrolls (it is on an item it sees).
    ///
    /// Measured where the core has the items, which is behind a scroll
    /// the keys asked for and the platform has not reported yet: the
    /// positions are taken back to that scroll ([`LevelScroll::lag`]),
    /// and the keys pressed meanwhile wait for it ([`Busy`]).
    fn reveal(&self, level: u32, node: ElementRef) {
        let Some(scroll) = self.scroll_of(level) else {
            return;
        };
        let last = self
            .walk(level)
            .parts
            .last()
            .map(|e| e.rows.as_ref().map_or(e.node, |r| r.list));
        let busy = Busy::new(self);
        spawn(async move {
            let _busy = busy;
            let LevelScroll { view, offset, .. } = scroll;
            let (item, port) = (node.measure(), view.measure());
            let end = last.map(|n| n.measure());
            let (Some(item), Some(port)) = (item.await, port.await) else {
                return;
            };
            let end = match end {
                Some(end) => end.await,
                None => None,
            };
            let lag = scroll.lag();
            let start = (item.page.y - port.page.y).0 + lag;
            let viewport = port.frame.size.height.0;
            let delta = nsh_core::scroll::reveal_delta(
                Points(start),
                Points(start + item.frame.size.height.0),
                port.frame.size.height,
            );
            if delta.0.abs() >= 0.5 {
                // No further than the content goes (its last item's end).
                let most = end.map_or(f32::INFINITY, |e| {
                    let bottom = (e.page.y - port.page.y).0 + lag + e.frame.size.height.0;
                    (offset.get_untracked().0 + bottom - viewport).max(0.0)
                });
                let to = Points((offset.get_untracked().0 + delta.0).clamp(0.0, most));
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
        let Some(scroll) = self.scroll_of(level) else {
            return self.page(level, &walk, place, dir);
        };
        let view = scroll.view;
        let items = self.clone();
        let busy = Busy::new(self);
        spawn(async move {
            let _busy = busy;
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
            // Where they are once the scroll the keys asked for is done.
            let lag = scroll.lag();
            for (key, span) in spans {
                if let Some(m) = span.await {
                    let top = (m.page.y - port.page.y).0 + lag;
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
        self.focus_keyed(Keyed::Submenu(level));
    }

    /// Focuses what `how` names once its items are there (now, when they
    /// already are).
    fn focus_keyed(&self, how: Keyed) {
        self.pending.replace(None);
        self.keyed.replace(Some(how));
        self.order.invalidate();
        self.focus_pending();
    }

    /// Adds an item of submenu `level` (the item of a [`MenuList`]'s
    /// `row` when it is in one at that level), which the menu forgets
    /// when the current owner (the item's component) ends.
    fn add(
        &self,
        node: ElementRef,
        level: u32,
        disabled: Prop<bool>,
        label: Prop<Option<SharedString>>,
    ) -> u64 {
        let key = self.next.get() + 1;
        self.next.set(key);
        let row = use_context::<MenuRow>().filter(|r| r.rows.level == level);
        if let Some(MenuRow { rows, index }) = row {
            rows.items.borrow_mut().push(RowItem {
                key,
                index,
                node,
                disabled,
                label,
            });
            cleanup(move || rows.items.borrow_mut().retain(|i| i.key != key));
            return key;
        }
        self.push(Entry {
            key,
            node,
            level,
            disabled,
            label,
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
            label: Prop::new(None),
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
        self.in_turn(move |items| {
            let key = items.moved_to().unwrap_or(key);
            if let Some(level) = items.level_of(key) {
                items.step_in(level, Some(key), step);
            }
        });
    }

    /// Runs a key's move now, or once the moves under way ended.
    fn in_turn(&self, run: impl FnOnce(&Items) + 'static) {
        if self.busy.get() == 0 {
            return run(self);
        }
        let items = self.clone();
        self.queued
            .borrow_mut()
            .push_back(Box::new(move || run(&items)));
    }

    /// The item the keys go on from ahead of the focus: the one the pointer
    /// is on, or the one the keys moved to whose focus is still on its way.
    fn moved_to(&self) -> Option<u64> {
        self.pointed
            .get()
            .or(self.cursor.get().filter(|&c| self.level_of(c).is_some()))
    }

    /// Item `key` was pressed while the keys moved the focus from it, or
    /// ahead of a move under way: a Return or Space typed ahead, which
    /// selects the item the keys move to once they are there. Whether it
    /// took the press.
    ///
    /// Only a key is typed ahead: a press from no pointer (`clicks` 0) on
    /// the item with the keyboard focus, which Return and Space press. A
    /// pointer's press (a tap, a click) and an assistive technology's
    /// activation of another item are that item's own, also while the
    /// focus the keys moved has not come: on a touch screen no pointer
    /// moves over the item first to take the keys' place ([`Self::point`]).
    fn press_ahead(&self, key: u64, press: &PressEvent) -> bool {
        let typed = press.clicks == 0 && self.focused.get_untracked() == Some(key);
        let ahead = self.cursor.get().is_some_and(|c| c != key);
        if !typed || (self.busy.get() == 0 && !ahead) {
            return false;
        }
        self.in_turn(move |items| {
            let to = items.cursor.get().unwrap_or(key);
            let select = items
                .selects
                .borrow()
                .iter()
                .find(|s| s.0 == to)
                .map(|s| s.1.clone());
            if let Some(select) = select {
                select();
            }
        });
        true
    }

    /// Adds item `key`'s select, forgotten when the current owner ends.
    fn add_select(&self, key: u64, select: Rc<dyn Fn()>) {
        self.selects.borrow_mut().push((key, select));
        let selects = self.selects.clone();
        cleanup(move || selects.borrow_mut().retain(|s| s.0 != key));
    }

    /// The pointer moved over item `key`, enabled: it takes the keyboard
    /// focus, as the desktops' menus highlight one item for the pointer
    /// and the keys alike, so the keys go on from it. A move, not the
    /// pointer coming over it: a list scrolled under a still pointer
    /// leaves the focus where the keys put it.
    fn point(&self, key: u64, node: ElementRef) {
        self.pending.replace(None);
        self.cursor.set(None);
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

    /// A letter or digit `c` typed: the focus goes to the next enabled
    /// item of the level the keys are in whose label or text starts with
    /// what was typed in that level since the last pause, as `Select`'s
    /// typeahead finds it ([`listbox::find_typed_among`]): the same
    /// character again moves on among the items it starts, several make a
    /// prefix. Read where the
    /// core has the items' texts: the keys pressed meanwhile wait for it
    /// ([`Busy`]). An item out of view is scrolled into it.
    fn type_ahead(&self, c: char) {
        // When it was typed, though it may wait for a move under way.
        let pressed = now();
        self.in_turn(move |items| {
            let from = items.moved_to().or(items.focused.get_untracked());
            let level = from.and_then(|key| items.level_of(key)).unwrap_or(0);
            // Each level starts again: letters typed just before Right
            // opened a submenu are no prefix of its items.
            let typed = {
                let mut typeahead = items.typeahead.borrow_mut();
                let (last, typeahead) = &mut *typeahead;
                if last.replace(level) != Some(level) {
                    typeahead.clear();
                }
                typeahead.push(c, pressed).to_owned()
            };
            let walk = items.walk(level);
            // A row the keys are still waiting for counts as reached.
            let waiting = items.pending.take().filter(|p| p.level == level);
            let at = waiting
                .and_then(|p| {
                    walk.place_of_row(&p.rows, p.index)
                        .filter(|_| p.index < p.rows.len())
                })
                .or_else(|| from.and_then(|key| walk.place_of(key)));
            // Asked all at once, answered in one commit.
            let texts: Vec<_> = walk
                .enabled()
                .into_iter()
                .map(|(place, label, node)| {
                    let text = match label.get_untracked() {
                        Some(label) => Ok(label),
                        None => Err(node.text_content()),
                    };
                    (place, text)
                })
                .collect();
            if texts.is_empty() {
                return;
            }
            let (busy, items) = (Busy::new(items), items.clone());
            spawn(async move {
                let _busy = busy;
                let mut order = Vec::with_capacity(texts.len());
                let mut folded = Vec::with_capacity(texts.len());
                for (i, (place, text)) in texts.into_iter().enumerate() {
                    let text = match text {
                        Ok(label) => label.to_string(),
                        Err(answer) => answer.await,
                    };
                    order.push((place as u32, i as u32));
                    folded.push(text.trim_start().to_lowercase().into_boxed_str());
                }
                let at = at.map(|at| at as u32);
                if let Some(i) = listbox::find_typed_among(&order, at, &folded, &typed) {
                    let place = order[i].0 as usize;
                    items.walk_from(level, Start::On(place), Dir::Forward, 1);
                }
            });
        });
    }

    /// Binds the keys that move the focus into the menu's items while
    /// `active` and none of them has it (a menu the pointer opened), as
    /// the desktops' menus take them: Down and Home focus the first
    /// enabled item, Up and End the last, Page Down and Page Up a page
    /// from either end; from the item the pointer is on when its focus is
    /// still on its way. Once an item has the focus, its own keys take
    /// over. While the keyboard focus is outside the menu (`outside`) they
    /// fire even though a text input edits: the pointer opens a menu over
    /// a field that keeps editing, and the open menu takes its arrows, not
    /// the field's caret. While it is in the menu, a field of the menu's
    /// own (a filter) keeps them.
    fn bind_entry_keys(
        &self,
        active: impl Fn() -> bool + Clone + 'static,
        outside: impl Fn() -> bool + Clone + 'static,
    ) {
        let enter = |items: Items| {
            move |step| {
                items.in_turn(move |items| match items.moved_to() {
                    Some(key) => items.step(key, step),
                    None => items.step_in(0, None, step),
                })
            }
        };
        let current = self.focused;
        for (when, wanted) in [(When::NotEditing, false), (When::Always, true)] {
            let (active, outside) = (active.clone(), outside.clone());
            crate::keys::bind_while_when(
                move || active() && current.get().is_none() && outside() == wanted,
                when,
                ITEM_KEYS,
                enter(self.clone()),
            );
        }
    }

    /// Binds the keys that move the focus from item `key` while `focused`
    /// and its level is `open` (none on its way out).
    fn bind_keys(&self, key: u64, focused: Signal<bool>, open: Memo<bool>) {
        let (current, cursor) = (self.focused, self.cursor.clone());
        effect(move || {
            if focused.get() {
                // The focus the keys moved here has come.
                if cursor.get() == Some(key) {
                    cursor.set(None);
                }
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

/// Closes the submenus of a level that are open unless one is `keep` (the
/// submenu whose trigger the pointer or the keyboard focus came to): the
/// pointer over another item of the level closes it, and so does the
/// keyboard focus moving to one, as the desktops' menus do, so one item of
/// the level is highlighted at a time. A controlled one is asked to close.
fn close_other_submenu(level: Level, keep: Option<u32>, reason: OpenChangeReason) {
    let open = level.open_sub.get_untracked();
    if open.is_some() && open != keep {
        level.why.stamp(reason);
        level.open_sub.set(None);
    }
    for ask in level.asks.open_in(level.level, keep) {
        ask(false, reason);
    }
}

/// Level `level`'s items in a scroll view, which its popup (held to the
/// room on its side) or sheet (to the window) shrinks: the items scroll
/// past it instead of running out of the window, as `gpui-component`'s
/// menu scrolls its items past its `max_h`. The keys bring the item they
/// focus into view ([`Items::reveal`]).
fn items_scroll(items: &Items, level: u32, children: Prop<Children>) -> AnyElement {
    let me = element_ref();
    let (offset, reported) = (signal(Points::ZERO), signal(Points::ZERO));
    items.add_scroll(level, me, offset, reported);
    scroll()
        // Menus stop at their content edges and never show a scroll bar.
        .bounces(false)
        .scrollbar(false)
        .element_ref(&me)
        .flex_shrink(1.0)
        .min_h(px(0.0))
        // An item acts on the first tap while the software keyboard is up
        // for an input the menu opened beside (a composer's): the input
        // keeps it, as with UIKit's menus.
        .keyboard_taps(KeyboardTaps::Handled)
        .on_scroll(move |e: &ScrollEvent| {
            reported.set(e.offset.y);
            offset.set(e.offset.y);
        })
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

/// Where a menu's popup goes.
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

/// Whether a menu is a sheet at the bottom of the screen rather than a
/// popup at its trigger or the pointer: on phones and tablets, an iPad
/// only while its window is compact in width by UIKit's horizontal size
/// class (Slide Over, a narrow Split View or Stage Manager window),
/// as UIKit's own menus and popovers are anchored in a regular width and
/// adapt to a sheet in a compact one. Mac Catalyst keeps the sheet. Read
/// in a binding, it follows the size class as the window is resized.
fn as_sheet() -> bool {
    if is_desktop() {
        return false;
    }
    let ipad = os() == Os::Ios && idiom() == Idiom::Pad && !is_catalyst();
    !(ipad && horizontal_size_class() == SizeClass::Regular)
}

/// The menu's popup or sheet, as [`as_sheet`] has it: made again the other
/// way when that changes (an iPad's window resized across its size class),
/// an open menu staying open in its new presentation.
fn presented(
    open: OpenState,
    change: Rc<dyn Fn(bool, OpenChangeReason)>,
    emit: Rc<dyn Fn(MenuEvent)>,
    at: At,
    parts: Surface,
    asked: Asked,
    children: Prop<Children>,
) -> AnyElement {
    let make = move |at: Option<At>| {
        let (change, emit) = (change.clone(), emit.clone());
        move || {
            surface(
                open,
                change.clone(),
                emit.clone(),
                at.clone(),
                parts,
                asked,
                children,
            )
        }
    };
    when(as_sheet, make(None))
        .otherwise(make(Some(at)))
        .into_element()
}

/// The menu while it is open: its popup at `at`, or its sheet without one,
/// with the context its items read. `change` asks to open or close it.
fn surface(
    open: OpenState,
    change: Rc<dyn Fn(bool, OpenChangeReason)>,
    emit: Rc<dyn Fn(MenuEvent)>,
    at: Option<At>,
    parts: Surface,
    asked: Asked,
    children: Prop<Children>,
) -> AnyElement {
    let Asked { keyed, why } = asked;
    let sheet = at.is_none();
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
        // Whether the keyboard focus is in the popup: a field of the menu's
        // own (a filter) keeps its arrows; one outside it (the field the
        // pointer left editing) does not.
        let inside = signal(false);
        presence.popup().on_focus_in(move || inside.set(true));
        presence.popup().on_focus_out(move || inside.set(false));
        items.bind_entry_keys(
            move || presence.mounted() && open.get(),
            move || !inside.get(),
        );
        // Letters and digits move the focus by typeahead in the level the
        // keys are in, as the desktops' menus do; a text field in the menu
        // keeps them. Each opening starts again.
        let typeahead = items.typeahead.clone();
        effect(move || {
            if open.get() {
                typeahead.borrow_mut().1.clear();
            }
        });
        let typing = items.clone();
        listbox::bind_typeahead(
            When::NotEditing,
            move || presence.mounted() && open.get(),
            Rc::new(move |c| typing.type_ahead(c)),
        );
    }
    let (asks, regain) = (Asks::new(), signal(None::<(u32, usize)>));
    // A place to regain is only for the submenu made in place of the one it
    // was in: the focus anywhere else drops it.
    {
        let focused = items.focused;
        effect(move || {
            if focused.get().is_some() {
                untracked(|| regain.set(None));
            }
        });
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
        asks,
        regain,
        focus_place: stored(None),
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
    // Escape and back leave the innermost submenu of a sheet first (a
    // controlled one asks the app).
    let cancel = {
        let dismiss = dismiss.clone();
        move || match path.with_untracked(|p| p.last().copied()) {
            Some(inner) => match asks.of(inner) {
                Some(ask) => ask(false, OpenChangeReason::Cancel),
                None => {
                    why.stamp(OpenChangeReason::Cancel);
                    path.update(|p| {
                        p.pop();
                    });
                }
            },
            None => dismiss(OpenChangeReason::Cancel),
        }
    };
    // A sheet comes in and goes with its motion; a popup with the app's
    // transitions between its looks.
    let motion = SheetMotion::new(move || sheet && open.get(), || Placement::Bottom);
    // The keyboard focus in a trigger's popup as it closes (Escape, an
    // item chosen) goes back to the trigger as the popup starts to go, as
    // a select's does: a key pressed during its exit is the trigger's, not
    // the item's it was on. Not after a press outside, which put the focus
    // where it pressed, nor over a focus the choice moved elsewhere in the
    // same turn (an item that starts editing a field).
    let trigger = match &at {
        Some(At::Trigger(anchor) | At::Pointer(_, anchor)) => Some(*anchor),
        None => None,
    };
    if let Some(anchor) = trigger {
        // Opened by a pointer, the focus goes back where it was instead.
        crate::popup::note_focus_origin(move || open.get(), anchor);
        presence.focus_back_on_close(
            move || open.get(),
            move || {
                if closed_by.get() != Some(OpenChangeReason::PressOutside) {
                    anchor.focus_back(presence.popup());
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
    // A popup on a touch screen (an iPad's): a press outside only closes
    // it, as a popover's there.
    let touch = !is_desktop();
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
            let Some(at) = &at else {
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
                    // Above the keyboard, below the status bar, whatever
                    // the items.
                    .bottom(move || Length::from(keyboard_lift()))
                    .max_h(bottom_panel_max_height)
                    .role(AccessibilityRole::Menu)
                    .app_class(parts.popup_class)
                    .inline_style(parts.popup_style)
                    .bind_translate_y(&motion.y)
                    .on_layout(move |frame: &Bounds<Points>| motion.laid_out(frame.size))
                    .on_cancel(cancel.clone())
                    .child(items_scroll(&items, 0, children));
                return vec![backdrop.into_element(), panel.into_element()];
            };
            // The press outside a popup on a touch screen is the menu's
            // (not while it goes): a transparent overlay takes it. Made
            // before the popup, as overlays shown together stack in the
            // order they were made, and its submenus' popups come later.
            let backdrop = touch.then(|| {
                let dismiss = dismiss.clone();
                overlay()
                    .inset_0()
                    .focusable(false)
                    .pointer_events(move || {
                        if open.get() {
                            PointerEvents::Auto
                        } else {
                            PointerEvents::None
                        }
                    })
                    .on_press(move || dismiss(OpenChangeReason::PressOutside))
                    .into_element()
            });
            let popup = match at {
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
                .on_press_outside(move |_: &Point<Points>| {
                    // A touch screen's went to the overlay under it.
                    if !touch {
                        dismiss(OpenChangeReason::PressOutside)
                    }
                })
                .on_cancel(cancel.clone())
                .child(items_scroll(&items, 0, children));
            backdrop
                .into_iter()
                .chain([popup.into_element()])
                .collect::<Vec<_>>()
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
    /// As a popup: the side of the trigger it goes on (default
    /// `"bottom"`); the other side when only that one has room.
    #[prop(default)]
    pub placement: Prop<Placement>,
    /// As a popup: how it lines up with the trigger (default `"start"`).
    #[prop(default = Align::Start)]
    pub align: Prop<Align>,
    /// As a popup: the gap between the trigger and the popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// As a popup: the distance it keeps from the edges of the safe area.
    #[prop(default)]
    pub margin: Prop<Points>,
    /// The classes of the popup the items are in, or of the sheet; its
    /// submenus' popups take them too.
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the popup or sheet, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// As a popup: classes the popup (and its submenus' popups) has in
    /// its first frame, which its `transition` classes animate from
    /// (Tailwind's `starting:`, CSS's `@starting-style`): its entrance. A
    /// state's classes apply over `popupClass` and `popupStyle`, as a
    /// state's styles do. A sheet has its own motion.
    pub popup_starting_class: Prop<Option<SharedString>>,
    /// As a popup: the inline style of the popup in its first frame, over
    /// `popupStyle`.
    #[prop(default)]
    pub popup_starting_style: Prop<Style>,
    /// As a popup: classes the popup has while it goes: it stays, taking
    /// no presses, until the transitions it has then ran (`onClose` after),
    /// so they run its exit.
    pub popup_ending_class: Prop<Option<SharedString>>,
    /// As a popup: the inline style of the popup while it goes, over
    /// `popupStyle`.
    #[prop(default)]
    pub popup_ending_style: Prop<Style>,
    /// As a sheet: the classes of the backdrop behind it (pressing it
    /// closes the menu).
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
    /// As a popup: the popup was placed: the side it went on (the other
    /// side of `placement` when only that one had room), its frame in the
    /// root view and the room on that side.
    #[args(placement, bounds, available)]
    Position(Placement, Bounds<Points>, Size<Points>),
}

/// The events of a [`ContextMenu`]: a menu's ([`MenuEvent`]'s), and the
/// choice in the system's menu its `items` make. (`ContextMenuEvent` is
/// the core's `onContextMenu` payload.)
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ContextMenuEvents {
    /// It opened or closed (a secondary click or a held finger, a press
    /// outside or on the backdrop, Escape or back, an item chosen), with
    /// why: set `open` to follow it.
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
    /// As a popup: the popup was placed: the side it went on (the other
    /// side of `placement` when only that one had room), its frame in the
    /// root view and the room on that side.
    #[args(placement, bounds, available)]
    Position(Placement, Bounds<Points>, Size<Points>),
    /// iOS only: the user chose the item of this `id` in the system's
    /// menu (`items`); the menu has closed. Not sent on the other
    /// platforms, whose drawn menu reports through its items' `onSelect`.
    #[args(id)]
    Select(SharedString),
    /// iOS only: the user pressed the system's preview (`preview`); the
    /// menu has closed. Not sent on the other platforms.
    PreviewPress,
}

impl From<MenuEvent> for ContextMenuEvents {
    fn from(event: MenuEvent) -> Self {
        match event {
            MenuEvent::OpenChange(open, reason) => Self::OpenChange(open, reason),
            MenuEvent::Open => Self::Open,
            MenuEvent::Close => Self::Close,
            MenuEvent::Cancel => Self::Cancel,
            MenuEvent::Position(placement, bounds, available) => {
                Self::Position(placement, bounds, available)
            }
        }
    }
}

/// A menu its trigger opens: a popup at the trigger on the desktops and on
/// an iPad whose window is regular in width (UIKit's horizontal size
/// class), a sheet at the bottom of the screen (over a backdrop) on phones
/// and the other tablets and on an iPad in a compact width, whose items
/// are `MenuItem`s, `MenuSeparator`s and `Submenu`s (cascading popups
/// beside a popup's items, the sheet's next items in a sheet). Choosing an
/// item, a press outside, Escape and the Android back button close it.
/// Return, Space or Down on the focused trigger opens it with the keyboard
/// focus on its first enabled item, Up on its last (WAI-ARIA's menu
/// button); a press opens it with none, and in a popup Down or Home then
/// focuses the first, Up or End the last, as the desktops' menus do. Page
/// Down and Page Up go to the last and first enabled items in view, a view
/// at a time, stopping at the ends. In a popup the pointer moving over an
/// item gives it the keyboard focus, so the keys go on from it (its
/// `focus:` styles apply, as `hover:` ones). In a popup a letter or digit
/// moves the focus by `Select`'s
/// typeahead to the next enabled item of the level the focus is in whose
/// `accessibilityLabel`, else its text, starts with what was typed (a text
/// field in the menu keeps its letters). The popup (each submenu's too) is never taller than the room on
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
        .child(presented(
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
    /// As a popup: the gap between the pointer and the popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// As a popup: the distance it keeps from the edges of the safe area.
    #[prop(default)]
    pub margin: Prop<Points>,
    /// The classes of the popup or of the sheet.
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the popup or sheet, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// As a popup: classes the popup has in its first frame, which its
    /// `transition` classes animate from: its entrance (as `Menu`'s).
    pub popup_starting_class: Prop<Option<SharedString>>,
    /// As a popup: the inline style of the popup in its first frame.
    #[prop(default)]
    pub popup_starting_style: Prop<Style>,
    /// As a popup: classes the popup has while it goes, until the
    /// transitions it has then ran: its exit (as `Menu`'s).
    pub popup_ending_class: Prop<Option<SharedString>>,
    /// As a popup: the inline style of the popup while it goes.
    #[prop(default)]
    pub popup_ending_style: Prop<Style>,
    /// As a sheet: the classes of the backdrop behind it.
    pub backdrop_class: Prop<Option<SharedString>>,
    /// The inline style of the backdrop, over its classes.
    #[prop(default)]
    pub backdrop_style: Prop<Style>,
    /// What it is about: the secondary button on it (desktops), a finger
    /// held on it (touch screens), Shift+F10 or the Menu key while it has
    /// the focus (the web, Linux) or a screen reader's "show menu" action (macOS,
    /// Windows) opens the menu.
    pub trigger: Prop<Option<Slot>>,
    /// iOS and Android: the menu as data, for the system's own context
    /// menu. On iOS (and Mac Catalyst) any items make the menu the system's
    /// (`UIContextMenuInteraction`: the trigger lifts as its preview over
    /// the blurred screen, with the system's haptics, placement and
    /// motion), on Android the system's popup menu by the trigger, in
    /// place of the children; a chosen item comes back as
    /// `onSelect({ id })`. `MenuButton`'s items: ids, labels, SF Symbols
    /// (SVG icons on Android), checks, single choices, disabled and
    /// destructive items, submenus and sections. On every other platform
    /// `items`, `title` and `onSelect` are not used: the children are the
    /// menu, drawn as without `items`.
    #[prop(default)]
    pub items: Prop<Vec<MenuButtonItem>>,
    /// iOS and Android: the system's menu's title, above its items
    /// (`items`); none when unset. Not used on the other platforms.
    pub title: Prop<Option<SharedString>>,
    /// iOS only, with `items`: what the system lifts beside the menu in
    /// place of the trigger (a message's or a document's content, a
    /// conversation's last lines). Made when a finger goes down on the
    /// trigger and laid out at its own size out of sight, then shown as a
    /// picture of how it looked when the menu opened; gone once the menu
    /// closed. A press on it closes the menu and reports `onPreviewPress`.
    /// Without it, or when it is not laid out yet, the trigger lifts. Not
    /// used on the other platforms, nor for the secondary click's compact
    /// menu, which has no preview.
    pub preview: Prop<Option<Slot>>,
    /// The items, made on each opening.
    #[prop(lazy)]
    pub children: Prop<Children>,
}

/// A menu about its trigger: the secondary button (a right click, a
/// two-finger click) opens it where the pointer is on the desktops; a
/// finger held on the trigger opens it on touch screens, as a popup where
/// the finger is on an iPad in a regular width, as a sheet at the bottom
/// of the screen on phones, the other tablets and an iPad in a compact
/// width (`Menu`'s presentations). While it is open, a secondary click on
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
///
/// Given `items`, iOS shows the system's context menu instead
/// (`UIContextMenuInteraction`, on the native component
/// [`CONTEXT_MENU_COMPONENT`]): a held finger lifts the trigger over the
/// blurred screen and shows the items below it, a secondary click (an
/// iPad's pointer, Mac Catalyst) shows them at the pointer, all answered
/// natively without waiting for JS. It reports `onOpenChange`, `onOpen`,
/// `onSelect({ id })`, `onCancel` and `onClose` as the drawn menu does;
/// the app cannot open it (`open` set true shows nothing), and `open` set
/// false closes it. Android shows the system's popup menu instead, on the
/// same component: a held finger (as for the drawn menu) opens it below
/// the trigger, lined up with its end, or below the held point when the
/// trigger's bottom is out of sight, with the system's long-press haptic.
/// It reports the same events, and the app can open it there (`open`
/// set true: below the trigger).
#[component]
pub fn ContextMenu(props: ContextMenuProps, cx: Scope<ContextMenuEvents>) -> impl IntoElement {
    let open = OpenState::new(props.open, Prop::from(false));
    let items = props.items;
    // The system's menu: iOS and Android with items. Elsewhere there is
    // nothing to follow: the menu is made as without `items`.
    let system = matches!(os(), Os::Ios | Os::Android)
        .then(|| computed(move || items.with(|i| !i.is_empty())));
    let is_system = move || system.is_some_and(|s| s.get_untracked());
    // iOS opens its system menu itself (the held finger, the secondary
    // click): the drawn menu's openers stand aside, so a held finger opens
    // one menu. Android's popup menu has no opener of its own: the same
    // openers open it, through `open`.
    let opens_itself = move || is_system() && os() == Os::Ios;
    // The system menu's preview (`preview`): made while a finger is down on
    // the trigger, kept while the menu is up.
    let preview = Previewing::new(props.preview);
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
        open.request(next, || {
            cx.emit(ContextMenuEvents::OpenChange(next, reason))
        });
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
    let disabled = props.disabled;
    view()
        .child(props.trigger.place(move |trigger| {
            let on_menu = opener.clone();
            let on_hold = opener.clone();
            trigger
                .element_ref(&anchor)
                .on_context_menu(move |e: &ContextMenuEvent| {
                    if opens_itself() {
                        return;
                    }
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
                    if is_system() {
                        preview.touched(e.phase);
                    }
                    let me = anchor.node();
                    let takes = e.phase == TouchPhase::Start
                        && e.points.len() == 1
                        && e.points[0].pointer_type != PointerType::Mouse
                        && !disabled.get_untracked()
                        && !held_inside(e, me);
                    if e.phase == TouchPhase::Start {
                        // Claimed for the triggers around this one; a
                        // trigger that declines lets go of its old claim.
                        match (takes, me, e.points.first()) {
                            (true, Some(me), Some(p)) => HELD.set(Some((p.id, me))),
                            _ if HELD.get().is_some_and(|(_, by)| Some(by) == me) => HELD.set(None),
                            _ => {}
                        }
                    }
                    match e.phase {
                        // iOS opens its system menu itself: the hold is
                        // taken, with no timer.
                        TouchPhase::Start if takes && !opens_itself() => {
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
        .child({
            let drawn = {
                let change = change.clone();
                move || {
                    presented(
                        open,
                        change.clone(),
                        Rc::new(move |e: MenuEvent| cx.emit(e.into())),
                        At::Pointer(point, anchor),
                        parts,
                        // The secondary button and a held finger open it with
                        // no item focused, the keyboard with the first.
                        Asked { keyed, why },
                        props.children,
                    )
                }
            };
            match system {
                None => drawn(),
                Some(system) => {
                    let (title, disabled) = (props.title, props.disabled);
                    when(system, move || {
                        system_menu(
                            items,
                            title,
                            disabled,
                            preview,
                            open,
                            point,
                            change.clone(),
                            cx,
                        )
                    })
                    .otherwise(drawn)
                    .into_element()
                }
            }
        })
}

/// A `ContextMenu`'s preview in the system's menu (`preview`): made while
/// a finger is down on the trigger (the system asks for the preview as the
/// hold completes, without waiting on the app, so it has to be laid out by
/// then) and while the menu is up.
#[derive(Clone, Copy)]
struct Previewing {
    slot: Prop<Option<Slot>>,
    /// Made now.
    made: Signal<bool>,
    /// The menu is up, as the platform last told.
    up: Stored<bool>,
    /// Lets it go after a finger that opened no menu.
    linger: Stored<Option<Spawned<()>>>,
}

impl Previewing {
    fn new(slot: Prop<Option<Slot>>) -> Self {
        Self {
            slot,
            made: signal(false),
            up: stored(false),
            linger: stored(None),
        }
    }

    /// A touch on the trigger, while the menu is the system's.
    fn touched(self, phase: TouchPhase) {
        match phase {
            TouchPhase::Start => {
                if let Some(old) = self.linger.replace(None) {
                    old.cancel();
                }
                if self.slot.with_untracked(Option::is_some) {
                    self.made.set(true);
                }
            }
            TouchPhase::End | TouchPhase::Cancel if self.made.get_untracked() => {
                let task = set_timeout(PREVIEW_LINGER, move || {
                    self.linger.replace(None);
                    if !self.up.get() {
                        self.made.set(false);
                    }
                });
                if let Some(old) = self.linger.replace(Some(task)) {
                    old.cancel();
                }
            }
            _ => {}
        }
    }

    /// The menu came up (true) or went (false).
    fn menu_up(self, up: bool) {
        self.up.replace(up);
        if !up {
            self.made.set(false);
        }
    }

    /// The preview, out of sight beside the native component: the platform
    /// takes a picture of it when the menu opens. Hidden from assistive
    /// technologies, which have the trigger.
    fn holder(self) -> impl IntoElement {
        let slot = self.slot;
        when(
            move || self.made.get() && slot.with(Option::is_some),
            move || {
                view()
                    .absolute()
                    .top_0()
                    .left(px(-PREVIEW_ASIDE))
                    .accessibility_elements_hidden(true)
                    .child(slot.place(|preview| preview))
            },
        )
    }
}

/// How far left of the trigger a `ContextMenu`'s preview is laid out: off
/// any screen.
const PREVIEW_ASIDE: f32 = 100_000.0;

/// A `ContextMenu`'s system menu (iOS and Android, given `items`): the
/// native component taking no touches, and on iOS the preview out of
/// sight. On iOS the component sits beside the trigger, taking no room;
/// on Android it covers the trigger, whose bounds the popup menu is placed
/// by, and `open` (with `at`, where a finger asked for it) shows it.
#[allow(clippy::too_many_arguments)]
fn system_menu(
    items: Prop<Vec<MenuButtonItem>>,
    title: Prop<Option<SharedString>>,
    disabled: Prop<bool>,
    preview: Previewing,
    open: OpenState,
    point: Signal<Option<Point<Points>>>,
    change: Rc<dyn Fn(bool, OpenChangeReason)>,
    cx: Scope<ContextMenuEvents>,
) -> impl IntoElement {
    let android = os() == Os::Android;
    // Shown, as the platform last told. The platform tells a choice before
    // the dismissal it causes, so a dismissal finding the menu still shown
    // closed it without one.
    let shown = stored(false);
    let component = native(CONTEXT_MENU_COMPONENT)
        .absolute()
        .when(android, |v| v.inset_0())
        .when(!android, |v| v.size_0())
        .pointer_events(PointerEvents::None)
        .prop("preview", move || {
            JsonValue::Bool(preview.slot.with(Option::is_some))
        })
        .prop("items", move || items.with(|items| menu_json(items)))
        .prop("title", move || {
            title
                .get()
                .map_or(JsonValue::Null, |t| JsonValue::from(t.as_ref()))
        })
        .prop("disabled", move || JsonValue::Bool(disabled.get()))
        // iOS: only `false` acts, it closes the menu shown. Android: `true`
        // shows it, at `at` (a point in the surface) or by the trigger.
        .prop("open", move || JsonValue::Bool(open.get()))
        .when(android, |v| {
            v.prop("at", move || match point.get() {
                Some(at) => serde_json::json!({ "x": at.x.0, "y": at.y.0 }),
                None => JsonValue::Null,
            })
        })
        .on_native_event(move |event: &NativeEvent| {
            match &*event.name {
                "open" if !shown.replace(true) => {
                    preview.menu_up(true);
                    // A finger held (the lifted preview), or the secondary
                    // button (the compact menu at the pointer).
                    let reason = match event.data.as_str() {
                        Some("pointer") => OpenChangeReason::ContextMenu,
                        _ => OpenChangeReason::LongPress,
                    };
                    change(true, reason);
                    cx.emit(ContextMenuEvents::Open);
                }
                "select" => {
                    if let Some(id) = event.data.as_str() {
                        // As a drawn menu's item: closing with the choice,
                        // the choice, then gone. A choice told after its
                        // dismissal still reaches the app, alone.
                        let was = shown.replace(false);
                        if was {
                            preview.menu_up(false);
                            change(false, OpenChangeReason::Select);
                        }
                        cx.emit(ContextMenuEvents::Select(SharedString::from(id.to_owned())));
                        if was {
                            cx.emit(ContextMenuEvents::Close);
                        }
                    }
                }
                // The preview pressed: as a choice, before the closing.
                "previewPress" => {
                    let was = shown.replace(false);
                    if was {
                        preview.menu_up(false);
                        change(false, OpenChangeReason::Select);
                    }
                    cx.emit(ContextMenuEvents::PreviewPress);
                    if was {
                        cx.emit(ContextMenuEvents::Close);
                    }
                }
                // Gone without a choice. As the drawn menu's dismissal: the
                // user's attempt (a tap outside, the preview's drag away) is
                // reported, then it closes; when the app closed it, only the
                // closing is.
                "close" if shown.replace(false) => {
                    preview.menu_up(false);
                    if open.get_untracked() {
                        cx.emit(ContextMenuEvents::Cancel);
                        change(false, OpenChangeReason::PressOutside);
                    }
                    cx.emit(ContextMenuEvents::Close);
                }
                // Asked for (Android's `open`) but never shown: the trigger
                // went from the window, or the menu was disabled meanwhile.
                // It never opened, so only the change is reported, and the
                // next hold opens it again.
                "close" if open.get_untracked() => {
                    change(false, OpenChangeReason::Cancel);
                }
                _ => {}
            }
        });
    // The component's view is the first child, the preview's the second:
    // the platform finds the trigger around them and the preview beside
    // its view. Android has no preview, and places the menu by the
    // component's bounds: the trigger's.
    if android {
        return view()
            .absolute()
            .inset_0()
            .pointer_events(PointerEvents::None)
            .child(component)
            .into_element();
    }
    view()
        .absolute()
        .size_0()
        .pointer_events(PointerEvents::None)
        .child(component)
        .child(preview.holder())
        .into_element()
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
    /// More about it than its name, which screen readers read after a
    /// pause, and a user can skip: what a choice does, how a mode differs
    /// from the others.
    pub accessibility_description: Prop<Option<SharedString>>,
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
        let key = m
            .items
            .add(node, m.level, disabled, props.accessibility_label);
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
    let select: Rc<dyn Fn()> = {
        let chosen = chosen.clone();
        let close_on_select = props.close_on_select;
        Rc::new(move || {
            // On its way out a menu takes no presses: the pointer's go
            // through it, and the keyboard's (Return on an item the focus
            // has not left yet) do nothing.
            if chosen.as_ref().is_some_and(|m| !m.open.get_untracked()) {
                return;
            }
            cx.emit(MenuItemEvent::Select);
            if close_on_select.get_untracked()
                && let Some(m) = &chosen
            {
                (m.close)(OpenChangeReason::Select);
            }
        })
    };
    if let (Some(m), Some(key)) = (&hover, key) {
        m.items.add_select(key, select.clone());
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
        .optional_accessibility_description(props.accessibility_description)
        .on_focus(move || {
            focused.set(true);
            // The keyboard on another item of its level closes a submenu
            // of the level the pointer opened.
            if let Some(m) = &moved {
                close_other_submenu(m.this_level(), None, OpenChangeReason::Focus);
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
                close_other_submenu(m.this_level(), None, OpenChangeReason::Hover);
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
        .on_press(move |e: &PressEvent| {
            // A Return or Space typed ahead of a key move selects the item
            // the keys move to.
            if let (Some(m), Some(key)) = (&chosen, key)
                && m.items.press_ahead(key, e)
            {
                return;
            }
            select();
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
/// at a time; typeahead reaches the rows it made, near its viewport. Bound
/// its height with a style (`h`, `max_h`); `render_item` draws each row
/// from its index. A row's
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
    .bounces(false)
    .scrollbar(false)
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
    /// Open (controlled): the app owns the value and changes it in
    /// `onOpenChange`, which asks for each opening and closing the user
    /// wants. A submenu made again (its row among items the app makes
    /// again) opens as the app has it, with the keyboard focus back on
    /// its items when it was in the one it replaces. Without it the
    /// submenu keeps its own state, which starts closed.
    pub open: Prop<Option<bool>>,
    /// It does not open.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// As a popup: the gap between the menu around it and its popup.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// The item that opens it, among its menu's items.
    pub trigger: Prop<Option<Slot>>,
    /// As a sheet: the row above its items that returns to the items it
    /// is among (Escape and back do too).
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
    /// Not when the app closes the menu itself, nor when it changes `open`
    /// itself. With `open` set it asks: set `open` to follow it.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
}

/// A menu inside a menu: in a menu's popup its items are a popup beside
/// its trigger, its first item level with the trigger (inside the popup's
/// padding and border), opened as the pointer comes over the trigger or
/// presses it; in a menu's sheet pressing the trigger shows its items in
/// the sheet instead of the ones around it, with its `back` row first. Its
/// popups take the menu's `popupClass` / `popupStyle` and its states' looks
/// (`popupStartingClass`, `popupEndingClass`, ...). In a terminal its
/// trigger is a row that ends with ` ›` ([`crate::terminal`]).
/// In a popup and in a terminal, Right, Return or Space on its
/// focused trigger open it with the keyboard focus on its first enabled
/// item; Left on one of its items, or Escape, closes it with the focus
/// back on its trigger, as WAI-ARIA's menus do. `onOpenChange` reports its
/// openings and closings, as `Menu`'s reports the menu's, and with `open`
/// the app owns them, as `Menu`'s `open` does: a menu whose items the app
/// makes again keeps the submenu the user is in open.
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
    let (controlled, sheet, level) = (props.open, menu.sheet, menu.level);
    // Desktops: a controlled one whose trigger the menu's items scrolled
    // out of view: open still, its popup hidden until the trigger is back.
    let away = signal(false);
    // Open as asked: while chosen at its level (the app's value, when it
    // controls it) and every level around it is open: closing the menu
    // closes it, no state written.
    let wanted = computed(move || {
        around.get()
            && match controlled.get() {
                Some(open) => open,
                None => open_sub.get() == Some(id),
            }
    });
    let sub_open = computed(move || wanted.get() && !away.get());
    let presence = PopupPresence::new(move || sub_open.get(), menu.looks);
    // A sheet's: while its items are on the path.
    let open = match sheet {
        true => computed(move || around.get() && path.with(|p| p.contains(&id))),
        false => sub_open,
    };
    // What its reports follow: hidden while scrolled away is no closing.
    let asked_open = match sheet {
        true => open,
        false => wanted,
    };
    // Each change the user asked for, once; an opening after the closings
    // of the others.
    let reported = stored(why.get().0);
    {
        let was = stored(false);
        let report = Rc::new(move |closing_only: bool| {
            let now = asked_open.get_untracked();
            if (closing_only && now) || was.get() == now {
                return;
            }
            was.replace(now);
            let (stamp, reason) = why.get();
            // A controlled one asked as the user did ([`Ask`]): what it
            // does while the levels around it stay open is the app's.
            let the_apps = controlled.get_untracked().is_some() && around.get_untracked();
            if reported.replace(stamp) != stamp && why.asked(stamp) && !the_apps {
                cx.emit(SubmenuEvent::OpenChange(now, reason));
            }
        });
        why.add(id, report.clone());
        effect(move || {
            if asked_open.get() {
                untracked(|| why.report_closings(id));
            }
            untracked(|| report(false));
        });
    }
    // Controlled, the user's request goes to the app, once until it
    // answered.
    let ask: Ask = {
        let (owner, asked) = (Owner::current(), stored(None::<bool>));
        Rc::new(move |next: bool, reason: OpenChangeReason| {
            if asked.get().unwrap_or_else(|| asked_open.get_untracked()) == next {
                return;
            }
            why.stamp(reason);
            reported.replace(why.get().0);
            cx.emit(SubmenuEvent::OpenChange(next, reason));
            asked.replace(Some(next));
            owner.run(|| {
                after_answer(move || {
                    asked.replace(None);
                })
            });
        })
    };
    menu.asks.add(Controlled {
        id,
        level,
        controlled,
        open: asked_open,
        ask: ask.clone(),
    });
    // The user asks for it open or closed: the app when it controls it,
    // else its own state.
    let request: Ask = Rc::new(move |next: bool, reason: OpenChangeReason| {
        if controlled.get_untracked().is_some() {
            return ask(next, reason);
        }
        if sheet {
            if path.with_untracked(|p| p.contains(&id)) == next {
                return;
            }
            why.stamp(reason);
            path.update(|p| match next {
                true => p.push(id),
                false => {
                    if let Some(at) = p.iter().position(|&l| l == id) {
                        p.truncate(at);
                    }
                }
            });
        } else if (open_sub.get_untracked() == Some(id)) != next {
            why.stamp(reason);
            open_sub.set(next.then_some(id));
        }
    });
    let anchor = element_ref();
    // Left on one of its items, or Escape: it closes and the keyboard
    // focus goes back to its trigger, as WAI-ARIA's menus do.
    let leave: Rc<dyn Fn()> = {
        let request = request.clone();
        Rc::new(move || {
            request(false, OpenChangeReason::Cancel);
            anchor.focus();
        })
    };
    let inner = MenuContext {
        level: id,
        popup: presence.popup(),
        open_sub: signal(None),
        open,
        leave: (!sheet).then(|| leave.clone()),
        ..menu.clone()
    };
    provide_context(inner.clone());
    if sheet {
        // The app's value is the path's: a submenu it opens shows its
        // items in place of the ones around it.
        effect(move || {
            let Some(want) = controlled.get() else {
                return;
            };
            untracked(|| {
                if path.with(|p| p.contains(&id)) == want {
                    return;
                }
                why.app_change();
                path.update(|p| {
                    if want {
                        match p.iter().position(|&l| l == level) {
                            Some(at) => p.truncate(at + 1),
                            None => p.clear(),
                        }
                        p.push(id);
                    } else if let Some(at) = p.iter().position(|&l| l == id) {
                        p.truncate(at);
                    }
                });
            });
        });
        let shown = menu.clone();
        let into = {
            let request = request.clone();
            move || {
                if !props.disabled.get_untracked() {
                    request(true, OpenChangeReason::TriggerPress);
                }
            }
        };
        let back = move || request(false, OpenChangeReason::Cancel);
        return view()
            .child(when(
                move || shown.shown(),
                move || {
                    let into = into.clone();
                    props
                        .trigger
                        .place(move |t| t.role(AccessibilityRole::Menuitem).on_press(into.clone()))
                },
            ))
            .child(when(
                // While it is on the path: a submenu inside it shows its
                // own items in place of these, which hide themselves.
                move || path.with(|p| p.contains(&id)),
                move || {
                    let back = back.clone();
                    vec![
                        when(
                            move || path.with(|p| p.last() == Some(&id)),
                            move || {
                                let back = back.clone();
                                props.back.place(move |b| b.on_press(back.clone()))
                            },
                        )
                        .into_element(),
                        props.children.into_element(),
                    ]
                },
            ))
            .into_element();
    }
    // A controlled one the app opens closes the one of its level that keeps
    // its own state (the user's openings closed it already).
    effect(move || {
        if controlled.get().is_some() && wanted.get() {
            untracked(|| {
                if open_sub.get().is_some() {
                    why.app_change();
                    open_sub.set(None);
                }
            });
        }
    });
    let this_level = menu.this_level();
    let item_key = menu
        .items
        .add(anchor, menu.level, props.disabled, Prop::new(None));
    let edges = menu.popup;
    let open_by: Rc<dyn Fn(OpenChangeReason)> = {
        let request = request.clone();
        Rc::new(move |reason: OpenChangeReason| {
            if !props.disabled.get_untracked() {
                close_other_submenu(this_level, Some(id), reason);
                request(true, reason);
            }
        })
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
        close_other_submenu(this_level, Some(id), OpenChangeReason::Focus);
    };
    {
        let (items, up, open_by) = (menu.items.clone(), menu.leave.clone(), open_by.clone());
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
            request(false, OpenChangeReason::Cancel);
        }
    };
    // Where the keyboard focus is among its items, and the submenu made in
    // its place (its row made again by the app) opening where it was.
    {
        let (items, regain, focus_place) = (menu.items.clone(), menu.regain, menu.focus_place);
        {
            let items = items.clone();
            effect(move || {
                let Some(key) = items.focused.get() else {
                    // The item went (or the focus left the menu): what was
                    // last kept stays, for the cleanup below.
                    return;
                };
                untracked(|| {
                    let at = items.walk(id).place_of(key);
                    focus_place.with(|p| match at {
                        Some(at) => *p = Some((id, at)),
                        None if p.is_some_and(|(sub, _)| sub == id) => *p = None,
                        None => {}
                    });
                });
            });
        }
        cleanup(move || {
            // Gone with the focus in it, while its level stays open.
            let stays = untracked(|| around.try_get()).unwrap_or(false);
            let at = focus_place
                .try_with(|p| match *p {
                    Some((sub, at)) if sub == id => {
                        *p = None;
                        Some(at)
                    }
                    _ => None,
                })
                .flatten();
            if let Some(at) = at
                && stays
            {
                regain.try_set(Some((level, at)));
            }
        });
        // Made open by the app: where the one it replaces had the focus.
        if controlled.get_untracked() == Some(true) {
            effect(move || {
                if !sub_open.get() {
                    return;
                }
                if let Some((at_level, at)) = regain.get()
                    && at_level == level
                {
                    untracked(|| {
                        regain.set(None);
                        items.focus_keyed(Keyed::At(id, at));
                    });
                }
            });
        }
    }
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
    let (hovered, pressed) = (open_by.clone(), open_by);
    let trigger = match is_terminal() {
        // The terminal's item: the trigger's content, then ` ›` at the
        // row's end, one item.
        true => view()
            .flex_row()
            .element_ref(&anchor)
            .role(AccessibilityRole::Menuitem)
            .accessibility_state(move || AccessibilityState {
                expanded: Some(sub_open.get()),
                has_popup: true,
                ..AccessibilityState::default()
            })
            .on_focus(focus_in)
            .on_blur(move || focused.set(false))
            .on_mouse_enter(move |_: &MouseEvent| hovered(OpenChangeReason::Hover))
            .on_mouse_move(move |e: &MouseEvent| pointed(e))
            .on_mouse_leave(move |e: &MouseEvent| unpointed(e))
            .on_press(move || pressed(OpenChangeReason::TriggerPress))
            .child(props.trigger.place(|t| t.flex_grow(1.0)))
            .child(text(SUBMENU_ARROW).text_color(move || crate::theme::theme().muted_foreground))
            .into_element(),
        false => props.trigger.place(move |t| {
            let (pointed, unpointed) = (pointed.clone(), unpointed.clone());
            let (hovered, pressed) = (hovered.clone(), pressed.clone());
            t.element_ref(&anchor)
                .role(AccessibilityRole::Menuitem)
                .accessibility_state(move || AccessibilityState {
                    expanded: Some(sub_open.get()),
                    has_popup: true,
                    ..AccessibilityState::default()
                })
                .on_focus(focus_in)
                .on_blur(move || focused.set(false))
                .on_mouse_enter(move |_: &MouseEvent| hovered(OpenChangeReason::Hover))
                .on_mouse_move(move |e: &MouseEvent| pointed(e))
                .on_mouse_leave(move |e: &MouseEvent| unpointed(e))
                .on_press(move || pressed(OpenChangeReason::TriggerPress))
        }),
    };
    let items = menu.items.clone();
    // Open, it closes once the menu's items scroll its trigger out of
    // view, as a `MenuList` row's does when the list scrolls the row away:
    // its popup stays beside nothing. Measured as the menu scrolls, only
    // while it is open. A controlled one stays open, its popup hidden until
    // the trigger is back.
    {
        let items = items.clone();
        effect(move || {
            if !wanted.get() {
                untracked(|| away.set(false));
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
                if controlled.get_untracked().is_some() {
                    away.set(gone);
                } else if gone && open_sub.get_untracked() == Some(id) {
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

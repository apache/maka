//! Context menus: `nsh/desktop`'s `Menu.popup`
//! ([`nsh_core::desktop::DesktopCommand::PopupMenu`]), drawn by the backend in the terminal's
//! own look as the desktop backends show the system's (`NSMenu`,
//! `TrackPopupMenuEx`, GTK's `PopoverMenu`): a box of rows at the pointer
//! (or the point the app gives), on the raised surface of an anchored popup
//! with the popover's line: labels from the first Cell, shortcuts at the
//! right and `›` on a submenu, whose box opens beside its row. A box with
//! a checkable item keeps a column for the `✓` at its rows' right end, a
//! Cell inside the line and a Cell after the shortcuts; a submenu's `›`
//! takes that column there. Disabled items are faint; separators are lines across the box.
//! Every label is the app's.
//!
//! An open menu takes every key and press until it closes. Up / Down and
//! Tab / Shift+Tab move between the items that can be chosen, round the
//! box; Home / End go to the first and last; a letter to the next item it
//! starts; Right, Enter or Space opens a submenu; Left or Escape closes
//! one; Enter or Space chooses an item, Escape at the top closes the menu.
//! The pointer moves the focus and opens submenus; a press on an item
//! chooses it, a press outside the boxes closes the menu and goes no
//! further. A chosen item is reported as [`EventKind::Menu`] with its id
//! (an item with a role closing the window ends the app), then the menu's
//! closing as `{ id: 0, closed: true }`, which settles the app's promise.
//!
//! The application menu (`Menu.setApplicationMenu`,
//! [`nsh_core::desktop::DesktopCommand::SetMenu`]) is a menu bar on the
//! surface's top row, as a terminal program's (Midnight Commander's,
//! htop's): its menus' titles on the raised surface, the app laid out in
//! the rows below (with `Window.setMenuBar("autoHide")` it takes no row and
//! shows over the app's top row while it has the keys). F10 gives it the
//! keys: Left / Right move between the titles, Down, Enter, Space or a
//! title's initial open its menu below it (the same box as a context
//! menu's), Escape closes the menu and then leaves the bar, F10 leaves it
//! at once. With a menu open, Left and Right open the menu beside it
//! (Right opens a submenu first). A press on a title opens its menu, one
//! on the open menu's title or outside it closes it; the pointer over
//! another title opens that one's. A chosen item is reported as a context
//! menu's, with no closing after it (no promise waits for it); its
//! shortcut chooses it from the keyboard too (`AppView`'s keys), even
//! while the bar has the keys when it has a modifier (folding the bar
//! up; a letter alone is a title's initial there), and Alt+Escape, two
//! quick Escapes as tmux joins them, is Escape. The edit roles' keys stay
//! the focused field's and the selection's. The
//! items of roles a terminal has no use for (macOS's app menu's, the
//! window's) are left out.

use nsh_core::{
    EventKind, EventPayload, PayloadValue, Point, Points, ROOT_ID,
    desktop::{MenuAction, MenuBarMode, MenuItem, MenuRole, Shortcut},
    keymap::{Key, Modifiers},
};
use ratatui_core::{
    buffer::Buffer,
    layout::{Position, Rect},
    style::{Color, Modifier},
};
use unicode_width::UnicodeWidthStr;

use crate::{
    CellSize,
    dialog::{clear, put},
    key_scheme::{self, Action},
    palette::{RAISED, Ramp, SELECT},
    render::ACCENT,
};

/// Where a menu's top left corner goes.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Anchor {
    /// The pointer's Cell.
    Cell(Position),
    /// The app's point (the surface's coordinates).
    Point(Point<Points>),
    /// Below the menu bar's title `index`.
    Title(usize),
}

/// One box: the root menu or an open submenu.
struct Level {
    items: Vec<MenuItem>,
    /// The focused item (an index of `items`).
    focused: Option<usize>,
    /// The box, as last drawn.
    rect: Rect,
    /// Each item's row, as last drawn (separators included).
    rows: Vec<Rect>,
}

impl Level {
    fn new(items: Vec<MenuItem>, focus_first: bool) -> Self {
        let mut level = Self {
            items,
            focused: None,
            rect: Rect::default(),
            rows: Vec::new(),
        };
        if focus_first {
            level.focused = level.next(None, true);
        }
        level
    }

    fn choosable(&self, index: usize) -> bool {
        match &self.items[index] {
            MenuItem::Action(action) => action.enabled,
            MenuItem::Submenu { enabled, .. } => *enabled,
            MenuItem::Separator => false,
        }
    }

    /// The item that can be chosen after (`forward`) or before `from`,
    /// round the box.
    fn next(&self, from: Option<usize>, forward: bool) -> Option<usize> {
        let count = self.items.len();
        (1..=count)
            .map(|step| match (from, forward) {
                (Some(at), true) => (at + step) % count,
                (Some(at), false) => (at + count - step % count) % count,
                (None, true) => step - 1,
                (None, false) => count - step,
            })
            .find(|&i| self.choosable(i))
    }

    /// The next item after the focused one whose label starts with `c`.
    fn typed(&self, c: char) -> Option<usize> {
        let count = self.items.len();
        let from = self.focused.unwrap_or(count - 1);
        let c = c.to_lowercase().next()?;
        (1..=count).map(|step| (from + step) % count).find(|&i| {
            self.choosable(i)
                && label(&self.items[i])
                    .chars()
                    .next()
                    .and_then(|first| first.to_lowercase().next())
                    == Some(c)
        })
    }

    fn row_at(&self, position: Position) -> Option<usize> {
        self.rows.iter().position(|r| r.contains(position))
    }
}

/// What a key or press did while a menu is open.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Outcome {
    /// The menu took it and stays open.
    Taken,
    /// The menu closed, with the item chosen if any: its id and role.
    Closed(Option<(u32, Option<MenuRole>)>),
    /// The menu bar let the keys go, with the item chosen in its menus if
    /// any: no promise waits for its closing.
    Left(Option<(u32, Option<MenuRole>)>),
}

impl Outcome {
    /// Reports a closing to the app: the chosen item, then the closing.
    /// Returns whether the chosen item ends the app (its role closes the
    /// window).
    pub(crate) fn dispatch(&self, control: &nsh_engine::EngineControl) -> bool {
        let (chosen, bar) = match self {
            Outcome::Taken => return false,
            Outcome::Closed(chosen) => (chosen, false),
            Outcome::Left(chosen) => (chosen, true),
        };
        if let Some((id, _)) = chosen
            && *id != 0
        {
            control.dispatch_event(
                ROOT_ID,
                EventKind::Menu,
                EventPayload::Map(vec![("id", PayloadValue::Number(f64::from(*id)))]),
            );
        }
        if bar {
            return matches!(chosen, Some((_, Some(MenuRole::Quit | MenuRole::Close))));
        }
        control.dispatch_event(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![
                ("id", PayloadValue::Number(0.0)),
                ("closed", PayloadValue::Bool(true)),
            ]),
        );
        matches!(chosen, Some((_, Some(MenuRole::Quit | MenuRole::Close))))
    }
}

/// The context menu open, if any, the application menu's bar, and where
/// the pointer last was.
#[derive(Default)]
pub(crate) struct Menus {
    anchor: Option<Anchor>,
    /// The root box first, then each open submenu.
    levels: Vec<Level>,
    /// The pointer's last Cell: where a menu without a point of its own
    /// opens.
    pub(crate) pointer: Option<Position>,
    bar: Bar,
    /// Ctrl stands in for Command (a macOS terminal that cannot report
    /// it): shortcuts show Ctrl, the key to press.
    pub(crate) ctrl_for_command: bool,
}

/// The application menu's bar.
#[derive(Default)]
struct Bar {
    /// Its menus (the application menu's top-level items).
    menus: Vec<MenuItem>,
    mode: MenuBarMode,
    /// The row it is drawn on.
    row: Rect,
    /// The title that has the keys (its menu open when `levels` holds
    /// one): the bar has them while it is `Some`.
    active: Option<usize>,
}

impl Bar {
    fn enabled(&self, index: usize) -> bool {
        match &self.menus[index] {
            MenuItem::Action(action) => action.enabled,
            MenuItem::Submenu { enabled, .. } => *enabled,
            MenuItem::Separator => false,
        }
    }

    /// The title after (`forward`) or before `from`, round the bar.
    fn next(&self, from: Option<usize>, forward: bool) -> Option<usize> {
        let count = self.menus.len();
        (1..=count)
            .map(|step| match (from, forward) {
                (Some(at), true) => (at + step) % count,
                (Some(at), false) => (at + count - step % count) % count,
                (None, true) => step - 1,
                (None, false) => count - step,
            })
            .find(|&i| self.enabled(i))
    }

    /// The next title after the active one whose label starts with `c`.
    fn typed(&self, c: char) -> Option<usize> {
        let count = self.menus.len();
        let from = self.active.unwrap_or(count - 1);
        let c = c.to_lowercase().next()?;
        (1..=count).map(|step| (from + step) % count).find(|&i| {
            self.enabled(i)
                && label(&self.menus[i])
                    .chars()
                    .next()
                    .and_then(|first| first.to_lowercase().next())
                    == Some(c)
        })
    }

    /// Each title's Cells on the row: ` File `, one after the other from
    /// the row's second Cell, as many as fit.
    fn titles(&self) -> Vec<Rect> {
        let mut x = self.row.x.saturating_add(1);
        let mut titles = Vec::with_capacity(self.menus.len());
        for item in &self.menus {
            let w = width(label(item)).saturating_add(2);
            let w = w.min(self.row.right().saturating_sub(x));
            titles.push(Rect::new(x, self.row.y, w, 1));
            x = x.saturating_add(w);
        }
        titles
    }

    fn title_at(&self, position: Position) -> Option<usize> {
        self.titles()
            .iter()
            .position(|title| title.width > 0 && title.contains(position))
    }
}

/// Whether the terminal leaves out items of `role`: macOS's app menu's and
/// the window's, which a terminal has no use for.
fn left_out(role: Option<MenuRole>) -> bool {
    matches!(
        role,
        Some(
            MenuRole::About
                | MenuRole::Hide
                | MenuRole::HideOthers
                | MenuRole::ShowAll
                | MenuRole::Minimize
                | MenuRole::Zoom
                | MenuRole::ToggleFullScreen
        )
    )
}

/// `items` without the items [`left_out`], the separators they leave
/// around or doubled dropped, and the submenus they empty.
fn kept(items: &[MenuItem]) -> Vec<MenuItem> {
    let mut out: Vec<MenuItem> = Vec::with_capacity(items.len());
    for item in items {
        match item {
            MenuItem::Action(action) if left_out(action.role) => {}
            MenuItem::Separator => {
                if out
                    .last()
                    .is_some_and(|last| !matches!(last, MenuItem::Separator))
                {
                    out.push(MenuItem::Separator);
                }
            }
            MenuItem::Submenu {
                label,
                enabled,
                items,
                ..
            } => {
                let items = kept(items);
                if !items.is_empty() {
                    out.push(MenuItem::Submenu {
                        label: label.clone(),
                        enabled: *enabled,
                        items,
                        // A terminal draws no images.
                        icon: None,
                    });
                }
            }
            item => out.push(item.clone()),
        }
    }
    if matches!(out.last(), Some(MenuItem::Separator)) {
        out.pop();
    }
    out
}

impl Menus {
    /// Opens `items` at `at` (the surface's points) or at the pointer, in
    /// place of a menu open before (its promise is settled by now).
    pub(crate) fn popup(&mut self, items: &[MenuItem], at: Option<Point<Points>>) {
        self.anchor = Some(match at {
            Some(at) => Anchor::Point(at),
            None => Anchor::Cell(self.pointer.unwrap_or_default()),
        });
        self.levels = vec![Level::new(items.to_vec(), false)];
        self.bar.active = None;
    }

    /// Whether a menu is open or the menu bar has the keys (and takes all
    /// input).
    pub(crate) fn is_open(&self) -> bool {
        !self.levels.is_empty() || self.bar.active.is_some()
    }

    /// Closes the open menu and gives the menu bar's keys back.
    pub(crate) fn clear(&mut self) {
        self.levels.clear();
        self.anchor = None;
        self.bar.active = None;
    }

    /// Closes everything and forgets the application menu (the app
    /// stopped).
    pub(crate) fn reset(&mut self) {
        self.clear();
        self.bar = Bar::default();
    }

    fn close(&mut self, chosen: Option<(u32, Option<MenuRole>)>) -> Outcome {
        let bar = self.bar.active.is_some();
        self.clear();
        if bar {
            Outcome::Left(chosen)
        } else {
            Outcome::Closed(chosen)
        }
    }

    /// The application menu (`None`: the app set none, or took it away).
    pub(crate) fn set_application_menu(&mut self, items: Option<&[MenuItem]>) {
        if self.bar.active.is_some() {
            self.clear();
        }
        self.bar.menus = items.map(kept).unwrap_or_default();
    }

    /// When the menu bar shows (`Window.setMenuBar`).
    pub(crate) fn set_menu_bar(&mut self, mode: MenuBarMode) {
        self.bar.mode = mode;
    }

    /// The bar has the keys (F10 or a press on a title gave them).
    pub(crate) fn bar_active(&self) -> bool {
        self.bar.active.is_some()
    }

    /// The app has an application menu: F10 gives its bar the keys.
    pub(crate) fn has_bar(&self) -> bool {
        !self.bar.menus.is_empty()
    }

    /// The menu bar takes the surface's top row from the app.
    pub(crate) fn reserves_row(&self) -> bool {
        self.has_bar() && self.bar.mode == MenuBarMode::Shown
    }

    /// The menu bar shows: always, or while it has the keys.
    pub(crate) fn bar_shown(&self) -> bool {
        self.has_bar() && (self.bar.mode == MenuBarMode::Shown || self.bar.active.is_some())
    }

    /// The row the menu bar is drawn on, for its titles and their menus.
    pub(crate) fn set_bar_row(&mut self, row: Rect) {
        self.bar.row = row;
    }

    /// Whether a press at `position` is the menu bar's.
    pub(crate) fn on_bar(&self, position: Position) -> bool {
        self.bar_shown() && self.bar.row.contains(position)
    }

    /// F10: the menu bar takes the keys, its first title active, or lets
    /// them go when it has them.
    pub(crate) fn toggle_bar(&mut self) -> Option<Outcome> {
        if self.bar.active.is_some() {
            return Some(self.close(None));
        }
        if !self.has_bar() {
            return None;
        }
        self.clear();
        self.bar.active = self.bar.next(None, true);
        self.bar.active.map(|_| Outcome::Taken)
    }

    /// Opens title `index`'s menu below it, its first item focused when
    /// `focus`; a title that is an item of its own is chosen.
    fn open_title(&mut self, index: usize, focus: bool) -> Outcome {
        self.levels.clear();
        self.bar.active = Some(index);
        match &self.bar.menus[index] {
            MenuItem::Submenu {
                enabled: true,
                items,
                ..
            } => {
                self.anchor = Some(Anchor::Title(index));
                self.levels.push(Level::new(items.clone(), focus));
                Outcome::Taken
            }
            MenuItem::Action(MenuAction {
                id,
                role,
                enabled: true,
                ..
            }) => {
                let chosen = (*id, *role);
                self.close(Some(chosen))
            }
            _ => Outcome::Taken,
        }
    }

    /// A key while the menu bar has the keys: `None` leaves it to the open
    /// menu.
    fn bar_key(&mut self, key: Key, shift: bool) -> Option<Outcome> {
        let active = self.bar.active?;
        if self.levels.is_empty() {
            match key {
                Key::Left => self.bar.active = self.bar.next(Some(active), false),
                Key::Right => self.bar.active = self.bar.next(Some(active), true),
                Key::Tab => self.bar.active = self.bar.next(Some(active), !shift),
                Key::Home => self.bar.active = self.bar.next(None, true),
                Key::End => self.bar.active = self.bar.next(None, false),
                Key::Down | Key::Enter | Key::Char(' ') => {
                    return Some(self.open_title(active, true));
                }
                Key::Escape => return Some(self.close(None)),
                Key::Char(c) if !c.is_control() => {
                    if let Some(index) = self.bar.typed(c) {
                        return Some(self.open_title(index, true));
                    }
                }
                _ => {}
            }
            return Some(Outcome::Taken);
        }
        if self.levels.len() > 1 {
            return None;
        }
        let level = &self.levels[0];
        let submenu = matches!(
            level.focused.map(|i| &level.items[i]),
            Some(MenuItem::Submenu { enabled: true, .. })
        );
        match key {
            Key::Left => {
                let to = self.bar.next(Some(active), false)?;
                Some(self.open_title(to, true))
            }
            Key::Right if !submenu => {
                let to = self.bar.next(Some(active), true)?;
                Some(self.open_title(to, true))
            }
            // The menu closes; the bar keeps the keys.
            Key::Escape => {
                self.levels.clear();
                self.anchor = None;
                Some(Outcome::Taken)
            }
            _ => None,
        }
    }

    /// Opens the submenu of the focused item of the innermost box, its
    /// first item focused when `focus`.
    fn open_submenu(&mut self, focus: bool) -> bool {
        let Some(level) = self.levels.last() else {
            return false;
        };
        let Some(MenuItem::Submenu {
            enabled: true,
            items,
            ..
        }) = level.focused.map(|i| &level.items[i])
        else {
            return false;
        };
        let items = items.clone();
        self.levels.push(Level::new(items, focus));
        true
    }

    /// Chooses item `index` of box `depth`: an action closes the menu, a
    /// submenu opens.
    fn choose(&mut self, depth: usize, index: usize) -> Outcome {
        self.levels.truncate(depth + 1);
        let level = &mut self.levels[depth];
        if !level.choosable(index) {
            return Outcome::Taken;
        }
        level.focused = Some(index);
        match &level.items[index] {
            MenuItem::Action(MenuAction { id, role, .. }) => {
                let chosen = (*id, *role);
                self.close(Some(chosen))
            }
            _ => {
                self.open_submenu(true);
                Outcome::Taken
            }
        }
    }

    /// Hands a key to the menu; `None` when none is open.
    pub(crate) fn key(&mut self, name: &str, modifiers: Modifiers) -> Option<Outcome> {
        if !self.is_open() {
            return None;
        }
        let Some(stroke) = key_scheme::keystroke(name, modifiers) else {
            return Some(Outcome::Taken);
        };
        // The terminal's aliases: Ctrl+N / Ctrl+P down and up, Ctrl+F /
        // Ctrl+B right and left, Ctrl+G as Escape.
        let alias = match key_scheme::terminal(stroke) {
            Some(Action::Next) => Some(Key::Down),
            Some(Action::Previous) => Some(Key::Up),
            Some(Action::Right) if stroke.modifiers.ctrl => Some(Key::Right),
            Some(Action::Left) if stroke.modifiers.ctrl => Some(Key::Left),
            Some(Action::Back) => Some(Key::Escape),
            _ => None,
        };
        let (key, m) = match alias {
            Some(key) => (key, Modifiers::default()),
            None => (stroke.key, stroke.modifiers),
        };
        if m.ctrl || m.alt || m.cmd {
            return Some(Outcome::Taken);
        }
        if key == Key::F(10) && self.bar.active.is_some() {
            return Some(self.close(None));
        }
        if let Some(outcome) = self.bar_key(key, m.shift) {
            return Some(outcome);
        }
        let depth = self.levels.len() - 1;
        let level = self.levels.last_mut()?;
        match key {
            Key::Down => level.focused = level.next(level.focused, true),
            Key::Up => level.focused = level.next(level.focused, false),
            Key::Tab => level.focused = level.next(level.focused, !m.shift),
            Key::Home => level.focused = level.next(None, true),
            Key::End => level.focused = level.next(None, false),
            Key::Right => {
                self.open_submenu(true);
            }
            Key::Left if depth > 0 => {
                self.levels.pop();
            }
            Key::Escape if depth > 0 => {
                self.levels.pop();
            }
            Key::Escape => return Some(self.close(None)),
            Key::Enter | Key::Char(' ') => {
                if let Some(index) = level.focused {
                    return Some(self.choose(depth, index));
                }
            }
            Key::Char(c) if !c.is_control() => {
                if let Some(index) = level.typed(c) {
                    level.focused = Some(index);
                }
            }
            _ => {}
        }
        Some(Outcome::Taken)
    }

    /// The box and row under `position`, innermost box first.
    fn hit(&self, position: Position) -> Option<(usize, Option<usize>)> {
        self.levels
            .iter()
            .enumerate()
            .rev()
            .find(|(_, level)| level.rect.contains(position))
            .map(|(depth, level)| (depth, level.row_at(position)))
    }

    /// The pointer moved to `position`: the item under it takes the focus,
    /// a submenu's opens, the boxes past it close.
    pub(crate) fn hover(&mut self, position: Position) -> Option<Outcome> {
        if !self.is_open() {
            return None;
        }
        self.pointer = Some(position);
        // With a menu of the bar open, the pointer over another title
        // opens that one's.
        if self.bar.active.is_some()
            && !self.levels.is_empty()
            && self.on_bar(position)
            && let Some(index) = self.bar.title_at(position)
        {
            if self.bar.active != Some(index)
                && self.bar.enabled(index)
                && let MenuItem::Submenu { .. } = self.bar.menus[index]
            {
                self.open_title(index, false);
            }
            return Some(Outcome::Taken);
        }
        if let Some((depth, Some(index))) = self.hit(position) {
            let level = &self.levels[depth];
            // The item whose submenu is open keeps it.
            let opened = level.focused == Some(index) && self.levels.len() > depth + 1;
            if !opened && level.choosable(index) {
                self.levels.truncate(depth + 1);
                self.levels[depth].focused = Some(index);
                self.open_submenu(false);
            }
        }
        Some(Outcome::Taken)
    }

    /// Hands a press at `position` to the menu; `None` when none is open.
    pub(crate) fn press(&mut self, position: Position) -> Option<Outcome> {
        if self.on_bar(position) {
            let title = self.bar.title_at(position);
            return Some(match title {
                // A press on the open menu's title closes it.
                Some(index) if self.bar.active == Some(index) && !self.levels.is_empty() => {
                    self.close(None)
                }
                // A context menu open closes first.
                _ if !self.levels.is_empty() && self.bar.active.is_none() => self.close(None),
                Some(index) if self.bar.enabled(index) => self.open_title(index, false),
                _ => Outcome::Taken,
            });
        }
        if !self.is_open() {
            return None;
        }
        if self.levels.is_empty() {
            return Some(self.close(None));
        }
        Some(match self.hit(position) {
            Some((depth, Some(index))) => self.choose(depth, index),
            Some((_, None)) => Outcome::Taken,
            None => self.close(None),
        })
    }

    /// Draws the open menu over everything in `area`, on the terminal's
    /// surfaces `ramp` when it has them.
    pub(crate) fn draw(
        &mut self,
        buffer: &mut Buffer,
        area: Rect,
        cells: CellSize,
        ramp: Option<Ramp>,
    ) {
        let area = area.intersection(buffer.area);
        let Some(anchor) = self.anchor else {
            return;
        };
        let at = match anchor {
            Anchor::Cell(at) => at,
            Anchor::Title(index) => {
                let title = self.bar.titles().get(index).copied().unwrap_or_default();
                Position::new(title.x, self.bar.row.bottom())
            }
            Anchor::Point(at) => Position::new(
                area.x
                    .saturating_add((at.x / cells.width()).floor().max(0.0) as u16),
                area.y
                    .saturating_add((at.y / cells.height()).floor().max(0.0) as u16),
            ),
        };
        let mac = crate::app::OS == nsh_core::platform::Os::MacOs;
        let mut beside: Option<(Rect, u16)> = None;
        for level in &mut self.levels {
            let checks = level
                .items
                .iter()
                .any(|i| matches!(i, MenuItem::Action(a) if a.checked.is_some()));
            // A level with an item to check keeps a column for the mark
            // at its rows' right end, after the shortcuts (with a Cell
            // between them); a submenu's `›` takes that column too.
            let mark = u16::from(checks);
            let ctrl = self.ctrl_for_command;
            let rights: Vec<String> = level
                .items
                .iter()
                .map(|i| match i {
                    MenuItem::Submenu { .. } if checks => String::new(),
                    _ => right(i, mac, ctrl),
                })
                .collect();
            let labels = level
                .items
                .iter()
                .map(|i| width(label(i)))
                .max()
                .unwrap_or(0);
            let widest_right = rights.iter().map(|r| width(r)).max().unwrap_or(0);
            let tail = widest_right + mark + u16::from(widest_right > 0 && checks);
            let gap = if tail > 0 { 3 } else { 0 };
            let inner = (labels + gap + tail).max(8);
            let w = (inner + 4).min(area.width);
            let h = (level.items.len() as u16 + 2).min(area.height);
            let (x, y) = match beside {
                // A submenu beside its row, on the other side when it has
                // no room.
                Some((parent, row)) => {
                    let x = if parent.right() + w <= area.right() {
                        parent.right()
                    } else {
                        parent.x.saturating_sub(w).max(area.x)
                    };
                    (x, row.saturating_sub(1))
                }
                None => {
                    let x = if at.x + w <= area.right() {
                        at.x
                    } else {
                        area.right().saturating_sub(w)
                    };
                    // Above the pointer when there is no room below it.
                    let y = if at.y + h <= area.bottom() {
                        at.y
                    } else if at.y + 1 >= area.y + h {
                        at.y + 1 - h
                    } else {
                        area.bottom().saturating_sub(h)
                    };
                    (x, y)
                }
            };
            let y = y.min(area.bottom().saturating_sub(h)).max(area.y);
            let rect = Rect::new(x.max(area.x), y, w, h);
            level.rect = rect;
            clear(buffer, rect);
            let (line, surface, band) = match ramp {
                Some(ramp) => (
                    ramp.popover_line(),
                    ramp.level(RAISED),
                    Some(ramp.level(SELECT)),
                ),
                None => (Color::Reset, Color::Reset, None),
            };
            if ramp.is_some() {
                for y in rect.y..rect.bottom() {
                    for x in rect.x..rect.right() {
                        buffer[(x, y)].bg = surface;
                    }
                }
            }
            border(buffer, rect, line, ramp.is_none());
            level.rows.clear();
            let content = Rect::new(
                rect.x + 1,
                rect.y + 1,
                rect.width.saturating_sub(2),
                rect.height.saturating_sub(2),
            );
            for (index, item) in level.items.iter().enumerate() {
                let y = content.y + index as u16;
                if y >= content.bottom() {
                    break;
                }
                let row = Rect::new(content.x, y, content.width, 1);
                level.rows.push(row);
                if matches!(item, MenuItem::Separator) {
                    for x in rect.x..rect.right() {
                        let symbol = if x == rect.x {
                            "├"
                        } else if x + 1 == rect.right() {
                            "┤"
                        } else {
                            "─"
                        };
                        let cell = &mut buffer[(x, y)];
                        cell.set_symbol(symbol);
                        cell.fg = line;
                        cell.modifier = if ramp.is_none() {
                            Modifier::DIM
                        } else {
                            Modifier::empty()
                        };
                    }
                    continue;
                }
                let enabled = level.choosable(index);
                let (color, mut modifier) = match (enabled, ramp) {
                    (true, _) => (Color::Reset, Modifier::empty()),
                    (false, Some(ramp)) => (ramp.faint(), Modifier::empty()),
                    (false, None) => (Color::Reset, Modifier::DIM),
                };
                let focused = level.focused == Some(index);
                if focused && band.is_none() {
                    modifier |= Modifier::REVERSED;
                }
                let text_x = row.x + 1;
                let room = row.width.saturating_sub(2);
                if focused {
                    for x in row.x..row.right() {
                        let cell = &mut buffer[(x, y)];
                        cell.set_symbol(" ");
                        match band {
                            Some(band) => cell.bg = band,
                            None => cell.modifier = Modifier::REVERSED,
                        }
                    }
                }
                put(buffer, text_x, y, label(item), room, color, modifier);
                // The shortcut ends a Cell before the mark's column.
                let end = room.saturating_sub(if checks { 2 } else { 0 });
                let right = &rights[index];
                if !right.is_empty() {
                    let rw = width(right).min(end);
                    let muted = match (enabled, ramp) {
                        (true, Some(ramp)) => ramp.muted(),
                        _ => color,
                    };
                    put(buffer, text_x + end - rw, y, right, rw, muted, modifier);
                }
                let symbol = match item {
                    MenuItem::Action(MenuAction {
                        checked: Some(true),
                        ..
                    }) => Some("✓"),
                    MenuItem::Submenu { .. } if checks => Some("›"),
                    _ => None,
                };
                if let Some(symbol) = symbol
                    && room > 0
                {
                    put(buffer, text_x + room - 1, y, symbol, 1, color, modifier);
                }
            }
            beside = level
                .focused
                .and_then(|i| level.rows.get(i))
                .map(|row| (rect, row.y));
        }
    }
}

impl Menus {
    /// Draws the menu bar on its row: the titles on the raised surface,
    /// the active one on the accent (reversed without surfaces), a
    /// disabled one faint.
    pub(crate) fn draw_bar(&self, buffer: &mut Buffer, ramp: Option<Ramp>) {
        let row = self.bar.row.intersection(buffer.area);
        if !self.bar_shown() || row.is_empty() {
            return;
        }
        clear(buffer, row);
        if let Some(ramp) = ramp {
            for x in row.x..row.right() {
                buffer[(x, row.y)].bg = ramp.level(RAISED);
            }
        }
        for (index, title) in self.bar.titles().into_iter().enumerate() {
            let title = title.intersection(row);
            if title.is_empty() {
                continue;
            }
            let active = self.bar.active == Some(index);
            let (color, modifier) = match (self.bar.enabled(index), ramp) {
                (false, Some(ramp)) => (ramp.faint(), Modifier::empty()),
                (false, None) => (Color::Reset, Modifier::DIM),
                (true, Some(ramp)) if active => (ramp.base(), Modifier::empty()),
                (true, _) => (Color::Reset, Modifier::empty()),
            };
            if active {
                for x in title.x..title.right() {
                    let cell = &mut buffer[(x, title.y)];
                    match ramp {
                        Some(_) => cell.bg = ACCENT,
                        None => cell.modifier = Modifier::REVERSED,
                    }
                }
            }
            let modifier = if active && ramp.is_none() {
                modifier | Modifier::REVERSED
            } else {
                modifier
            };
            put(
                buffer,
                title.x + 1,
                title.y,
                label(&self.bar.menus[index]),
                title.width.saturating_sub(2),
                color,
                modifier,
            );
        }
    }

    /// The action a shortcut chooses in the application menu: its id, its
    /// role and whether it fires while a text field is being edited.
    pub(crate) fn shortcut(&self, pressed: &Shortcut) -> Option<(u32, Option<MenuRole>, bool)> {
        MenuItem::find_shortcut(&self.bar.menus, pressed)
            .map(|action| (action.id, action.role, action.fires_while_editing()))
    }
}

/// What item `item` shows.
fn label(item: &MenuItem) -> &str {
    match item {
        MenuItem::Action(action) if action.label.is_empty() => {
            action.role.map_or("", MenuRole::label)
        }
        MenuItem::Action(action) => &action.label,
        MenuItem::Submenu { label, .. } => label,
        MenuItem::Separator => "",
    }
}

/// What an item shows at its right: its shortcut, or a submenu's `›`.
fn right(item: &MenuItem, mac: bool, ctrl_for_command: bool) -> String {
    match item {
        MenuItem::Action(action) => action
            .shortcut
            .or_else(|| action.role.and_then(|role| role.shortcut(mac)))
            .map(|mut s| {
                // The key to press: Ctrl where it stands in for Command.
                if ctrl_for_command && s.meta && !s.ctrl {
                    s.meta = false;
                    s.ctrl = true;
                }
                shortcut(&s, mac)
            })
            .unwrap_or_default(),
        MenuItem::Submenu { .. } => "›".into(),
        MenuItem::Separator => String::new(),
    }
}

/// A shortcut as the platform's menus write it: macOS's symbols, else
/// `Ctrl+Shift+N`.
fn shortcut(s: &Shortcut, mac: bool) -> String {
    if !mac {
        return s.label();
    }
    let mut out = String::new();
    for (on, symbol) in [(s.ctrl, "⌃"), (s.alt, "⌥"), (s.shift, "⇧"), (s.meta, "⌘")] {
        if on {
            out.push_str(symbol);
        }
    }
    out.push_str(&s.key.label());
    out
}

/// The rounded box on the edge Cells of `rect`, dim without surfaces.
fn border(buffer: &mut Buffer, rect: Rect, line: Color, dim: bool) {
    if rect.width < 2 || rect.height < 2 {
        return;
    }
    let modifier = if dim {
        Modifier::DIM
    } else {
        Modifier::empty()
    };
    let (right, bottom) = (rect.right() - 1, rect.bottom() - 1);
    let mut set = |x: u16, y: u16, symbol: &str| {
        let cell = &mut buffer[(x, y)];
        cell.set_symbol(symbol);
        cell.fg = line;
        cell.modifier = modifier;
    };
    for x in rect.x + 1..right {
        set(x, rect.y, "─");
        set(x, bottom, "─");
    }
    for y in rect.y + 1..bottom {
        set(rect.x, y, "│");
        set(right, y, "│");
    }
    set(rect.x, rect.y, "╭");
    set(right, rect.y, "╮");
    set(rect.x, bottom, "╰");
    set(right, bottom, "╯");
}

fn width(text: &str) -> u16 {
    text.width().min(usize::from(u16::MAX)) as u16
}

#[cfg(test)]
mod tests {
    use nsh_core::desktop::{MenuAction, MenuItem};
    use ratatui_core::{
        buffer::Buffer,
        layout::{Position, Rect},
    };

    use super::{Menus, Outcome};

    fn action(id: u32, label: &str, enabled: bool) -> MenuItem {
        MenuItem::Action(MenuAction {
            id,
            label: label.into(),
            shortcut: None,
            enabled,
            checked: None,
            role: None,
            when: Default::default(),
            icon: None,
        })
    }

    fn items() -> Vec<MenuItem> {
        vec![
            action(1, "Copy", true),
            action(2, "Paste", false),
            MenuItem::Separator,
            MenuItem::Submenu {
                label: "Share".into(),
                enabled: true,
                items: vec![action(3, "Mail", true)],
                icon: None,
            },
        ]
    }

    fn rows(buffer: &Buffer) -> Vec<String> {
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol())
                    .collect()
            })
            .collect()
    }

    fn draw(menus: &mut Menus, buffer: &mut Buffer) {
        let area = buffer.area;
        menus.draw(buffer, area, crate::CellSize::default(), None);
    }

    #[test]
    fn a_menu_opens_at_the_pointer_with_its_items_in_rows() {
        let mut menus = Menus {
            pointer: Some(Position::new(4, 2)),
            ..Menus::default()
        };
        menus.popup(&items(), None);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 12));
        draw(&mut menus, &mut buffer);
        let rows = rows(&buffer);
        assert!(rows[2][4..].starts_with('╭'), "{rows:#?}");
        assert!(rows[3].contains("│ Copy"), "{rows:#?}");
        assert!(rows[5].contains("├"), "{rows:#?}");
        assert!(
            rows[6].contains("Share") && rows[6].contains('›'),
            "{rows:#?}"
        );
    }

    #[test]
    fn keys_skip_disabled_items_open_submenus_and_choose() {
        let mut menus = Menus::default();
        menus.popup(&items(), None);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 12));
        let none = Default::default();
        assert_eq!(menus.key("ArrowDown", none), Some(Outcome::Taken));
        assert_eq!(menus.key("ArrowDown", none), Some(Outcome::Taken));
        draw(&mut menus, &mut buffer);
        assert_eq!(menus.key("ArrowRight", none), Some(Outcome::Taken));
        draw(&mut menus, &mut buffer);
        assert!(rows(&buffer).iter().any(|r| r.contains("Mail")));
        assert_eq!(
            menus.key("Enter", none),
            Some(Outcome::Closed(Some((3, None))))
        );
        assert!(!menus.is_open());
        menus.popup(&items(), None);
        // Tab goes round the items that can be chosen; Escape closes.
        for _ in 0..3 {
            menus.key("Tab", none);
        }
        assert_eq!(
            menus.key("Enter", none),
            Some(Outcome::Closed(Some((1, None))))
        );
        menus.popup(&items(), None);
        assert_eq!(menus.key("Escape", none), Some(Outcome::Closed(None)));
        assert_eq!(menus.key("Escape", none), None);
    }

    #[test]
    fn a_press_chooses_an_item_and_outside_closes() {
        let mut menus = Menus {
            pointer: Some(Position::new(0, 0)),
            ..Menus::default()
        };
        menus.popup(&items(), None);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 12));
        draw(&mut menus, &mut buffer);
        // A disabled item takes the press and the menu stays.
        assert_eq!(menus.press(Position::new(3, 2)), Some(Outcome::Taken));
        assert_eq!(
            menus.press(Position::new(3, 1)),
            Some(Outcome::Closed(Some((1, None))))
        );
        menus.popup(&items(), None);
        draw(&mut menus, &mut buffer);
        assert_eq!(
            menus.press(Position::new(30, 10)),
            Some(Outcome::Closed(None))
        );
    }

    #[test]
    fn checks_stand_at_the_rows_right_end_after_the_shortcuts() {
        let checkable = |id, label: &str, checked, shortcut: Option<&str>| {
            MenuItem::Action(MenuAction {
                id,
                label: label.into(),
                shortcut: shortcut.map(|s| nsh_core::desktop::Shortcut::parse(s, false).unwrap()),
                enabled: true,
                checked: Some(checked),
                role: None,
                when: Default::default(),
                icon: None,
            })
        };
        let items = vec![
            checkable(1, "Wrap", true, Some("ctrl+w")),
            checkable(2, "Ruler", false, None),
            checkable(3, "Minimap", true, None),
            action(4, "Plain", true),
            MenuItem::Submenu {
                label: "More".into(),
                enabled: true,
                items: vec![action(5, "Mail", true)],
                icon: None,
            },
        ];
        let mut menus = Menus {
            pointer: Some(Position::new(0, 0)),
            ..Menus::default()
        };
        menus.popup(&items, None);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 12));
        draw(&mut menus, &mut buffer);
        let rows = rows(&buffer);
        let mac = crate::app::OS == nsh_core::platform::Os::MacOs;
        let keys = super::shortcut(
            &nsh_core::desktop::Shortcut::parse("ctrl+w", false).unwrap(),
            mac,
        );
        let row = |y: usize| rows[y].trim_end().to_owned();
        // Labels from the first Cell inside the line, checked or not.
        for (y, label) in [
            (1, "│ Wrap"),
            (2, "│ Ruler"),
            (3, "│ Minimap"),
            (4, "│ Plain"),
            (5, "│ More"),
        ] {
            assert!(row(y).starts_with(label), "{rows:#?}");
        }
        // The mark in the last column but one: a Cell, then the line; a
        // shortcut a Cell before it; the submenu's `›` in the mark's column.
        assert!(row(1).ends_with(&format!("{keys} ✓ │")), "{rows:#?}");
        assert!(row(2).ends_with("    │"), "{rows:#?}");
        assert!(row(3).ends_with(" ✓ │"), "{rows:#?}");
        assert!(row(4).ends_with("    │"), "{rows:#?}");
        assert!(row(5).ends_with(" › │"), "{rows:#?}");
        let mark = rows[1].chars().position(|c| c == '✓').unwrap();
        assert_eq!(
            rows[3].chars().position(|c| c == '✓'),
            Some(mark),
            "{rows:#?}"
        );
        assert_eq!(
            rows[5].chars().position(|c| c == '›'),
            Some(mark),
            "{rows:#?}"
        );
    }

    #[test]
    fn a_menu_without_room_below_the_pointer_opens_above_it() {
        let mut menus = Menus {
            pointer: Some(Position::new(38, 11)),
            ..Menus::default()
        };
        menus.popup(&items(), None);
        let mut buffer = Buffer::empty(Rect::new(0, 0, 40, 12));
        draw(&mut menus, &mut buffer);
        let rows = rows(&buffer);
        let bottom = rows.iter().rposition(|r| r.contains('╰')).unwrap();
        assert_eq!(bottom, 11, "{rows:#?}");
        assert!(rows[bottom].ends_with('╯'), "{rows:#?}");
    }
}

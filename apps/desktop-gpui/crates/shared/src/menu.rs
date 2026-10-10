/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! A menu surface on DESIGN.md's floating recipe, for the menus Maka draws
//! itself: the sidebar footer's menu, a task's context menu, the
//! Extensions Add menu, a Host row's menu and the pages' "…" menus.
//!
//! gpui-kit's `PopupMenu` fixes its row height at 26px, forces 12px icons,
//! draws a 2px separator and gives submenu rows no styling hook, so it cannot
//! take the spec's geometry (polish §9, review round 1 S1). This one has the
//! palette's: 32px rows with radius 6 inside a 4px padded surface, a 16px
//! muted icon column, labels at 14, shortcuts as plain 12 muted text (as in
//! the command palette and the sidebar), a check or a chevron at the end, and
//! a 1px `border_soft` separator running to the surface's edges. A heading
//! (a name over its path) can sit above the items.
//!
//! Keyboard: Up and Down move through the enabled items (wrapping), Home and
//! End jump to the ends, Enter or Space chooses (or opens a submenu), Right
//! opens a submenu and Left closes it, Escape closes the submenu and then the
//! menu, and Tab closes the menu. Closing returns focus to what had it when
//! the menu opened, unless the chosen item moved focus elsewhere. A press
//! outside the menu closes it. One level of submenu, opened by hover as well.
//!
//! The owner keeps the [`Menu`] entity while it is open, draws it with
//! [`menu_layer`] as a child of the element it opens from, and drops it on
//! [`DismissEvent`].

use std::cell::Cell;
use std::rc::Rc;

use gpui_kit::base::{ElementExt as _, POPUP_PRIORITY};
use gpui_kit::component::kbd::Kbd;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{ActiveTheme as _, Icon, IconName, StyledExt as _, h_flex, v_flex};
use gpui_kit::{
    Action, Anchor, AnyElement, App, AppContext as _, Bounds, ClickEvent, Context, DismissEvent,
    Entity, EventEmitter, FocusHandle, Focusable, Global, InteractiveElement as _, IntoElement,
    KeyBinding, MouseButton, MouseDownEvent, ParentElement as _, Pixels, Point, Render, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, TestSupportExt as _, Window,
    anchored, deferred, div, point, prelude::FluentBuilder as _, px, rems,
};

use crate::domain_element_id;
use crate::icons::MakaIcon;
use crate::theme::{
    ActiveMakaPalette as _, RADIUS_CONTROL, RADIUS_MODAL, floating_shadow, shortcut_hint,
    tabular_nums,
};

/// Key context of an open menu.
pub const MENU_CONTEXT: &str = "MakaMenu";

/// How far a menu keeps from what it opens from, and from the window's edges.
const ANCHOR_GAP: Pixels = px(8.);
/// The surface's inner padding: rows sit this far inside it.
const PADDING: Pixels = px(4.);
/// The surface's `border_soft` hairline, inside its edge.
const BORDER: Pixels = px(1.);
/// The gap between a menu and its submenu.
const SUBMENU_GAP: Pixels = px(4.);
/// A heading's path wraps at this width (320px) rather than widen the menu
/// past it.
const HEADING_MAX_WIDTH_REMS: f32 = 20.;

gpui_kit::actions!(
    maka_menu,
    [
        /// Highlight the enabled item above, wrapping to the last.
        SelectPreviousItem,
        /// Highlight the enabled item below, wrapping to the first.
        SelectNextItem,
        /// Highlight the first enabled item.
        SelectFirstItem,
        /// Highlight the last enabled item.
        SelectLastItem,
        /// Choose the highlighted item, or open its submenu.
        ChooseItem,
        /// Open the highlighted item's submenu.
        OpenSubmenu,
        /// Close the submenu, back to the item that opened it.
        CloseSubmenu,
        /// Close the submenu if one is open, else the menu.
        DismissMenu,
        /// Close the menu, whatever is open.
        CloseMenu,
    ]
);

/// Marks the menu keys as bound, so [`init`] binds them once.
struct MenuKeys;

impl Global for MenuKeys {}

/// Binds the menu keys. Idempotent; every crate that opens a menu calls it
/// from its own `init`.
pub fn init(cx: &mut App) {
    if cx.has_global::<MenuKeys>() {
        return;
    }
    cx.set_global(MenuKeys);
    let context = Some(MENU_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("up", SelectPreviousItem, context),
        KeyBinding::new("down", SelectNextItem, context),
        KeyBinding::new("home", SelectFirstItem, context),
        KeyBinding::new("end", SelectLastItem, context),
        KeyBinding::new("enter", ChooseItem, context),
        KeyBinding::new("space", ChooseItem, context),
        KeyBinding::new("right", OpenSubmenu, context),
        KeyBinding::new("left", CloseSubmenu, context),
        KeyBinding::new("escape", DismissMenu, context),
        KeyBinding::new("tab", CloseMenu, context),
        KeyBinding::new("shift-tab", CloseMenu, context),
    ]);
}

/// One line of a menu.
#[derive(Debug)]
pub enum MenuEntry {
    Item(Box<MenuItem>),
    /// A hairline between groups of items.
    Separator,
    /// What the menu is about, above its items: a name, and the folder it
    /// stands for. The keyboard passes over it.
    Heading(MenuHeading),
}

impl From<MenuHeading> for MenuEntry {
    fn from(heading: MenuHeading) -> Self {
        Self::Heading(heading)
    }
}

/// A menu's heading: a title in the row's type at weight 500 over a path in
/// compact mono (12/20, muted), which wraps rather than end in an ellipsis
/// (Desktop's `maka-titlebar-menu__project`).
#[derive(Debug, Clone)]
pub struct MenuHeading {
    title: SharedString,
    path: Option<SharedString>,
}

impl MenuHeading {
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self { title: title.into(), path: None }
    }

    /// The path under the title.
    pub fn path(mut self, path: impl Into<SharedString>) -> Self {
        self.path = Some(path.into());
        self
    }
}

impl From<MenuItem> for MenuEntry {
    fn from(item: MenuItem) -> Self {
        Self::Item(Box::new(item))
    }
}

/// A menu item: a label, and what choosing it does (a handler, an Action to
/// dispatch, or a submenu).
pub struct MenuItem {
    /// Stable within its menu: the item's element id derives from it.
    key: SharedString,
    label: SharedString,
    icon: Option<Icon>,
    /// The Action whose key binding the item shows.
    shortcut: Option<Box<dyn Action>>,
    /// Dispatched when the item is chosen and has no handler.
    action: Option<Box<dyn Action>>,
    handler: Option<Rc<dyn Fn(&mut Window, &mut App)>>,
    checked: bool,
    disabled: bool,
    submenu: Vec<MenuEntry>,
    /// A second line under the label (12/20 muted): a folder, what the
    /// item does.
    detail: Option<SharedString>,
    /// Words at the row's end, in the row's own type (Astryx
    /// `DropdownMenuItem` `endContent`): a count, a state, an action.
    end: Option<SharedString>,
    /// The submenu's fixed width (Desktop's `menuWidth`), when it has one.
    submenu_width: Option<Pixels>,
    /// Shown under the pointer: why a disabled item cannot be chosen.
    tooltip: Option<SharedString>,
}

impl std::fmt::Debug for MenuItem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MenuItem")
            .field("key", &self.key)
            .field("label", &self.label)
            .field("checked", &self.checked)
            .field("disabled", &self.disabled)
            .field("submenu", &self.submenu)
            .finish_non_exhaustive()
    }
}

impl MenuItem {
    pub fn new(key: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            icon: None,
            shortcut: None,
            action: None,
            handler: None,
            checked: false,
            disabled: false,
            submenu: Vec::new(),
            detail: None,
            end: None,
            submenu_width: None,
            tooltip: None,
        }
    }

    /// A second line under the label; the row grows to hold it.
    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// Words at the row's end, where a shortcut would go.
    pub fn end(mut self, end: impl Into<SharedString>) -> Self {
        self.end = Some(end.into());
        self
    }

    /// The glyph in the icon column; the menu draws it 16px in muted ink.
    pub fn icon(mut self, icon: impl Into<Icon>) -> Self {
        self.icon = Some(icon.into());
        self
    }

    /// Dispatches `action` when chosen (after focus is back where the menu
    /// opened from) and shows its key binding.
    pub fn action(mut self, action: Box<dyn Action>) -> Self {
        self.shortcut = Some(action.boxed_clone());
        self.action = Some(action);
        self
    }

    /// Shows `action`'s key binding without dispatching it.
    pub fn shortcut(mut self, action: Box<dyn Action>) -> Self {
        self.shortcut = Some(action);
        self
    }

    /// Runs `handler` when chosen, after the menu has closed.
    pub fn on_select(mut self, handler: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.handler = Some(Rc::new(handler));
        self
    }

    /// Shows a check at the end: the current choice of a submenu.
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = checked;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// A tooltip under the pointer, for what the row cannot say: why a
    /// disabled item is disabled.
    pub fn tooltip(mut self, tooltip: impl Into<SharedString>) -> Self {
        self.tooltip = Some(tooltip.into());
        self
    }

    /// Makes the item open `entries` beside the menu.
    pub fn submenu(mut self, entries: Vec<MenuEntry>) -> Self {
        self.submenu = entries;
        self
    }

    /// Fixes the submenu's width (Desktop's `menuWidth`): its details then
    /// end in an ellipsis rather than widen it.
    pub fn submenu_width(mut self, width: Pixels) -> Self {
        self.submenu_width = Some(width);
        self
    }

    fn has_submenu(&self) -> bool {
        !self.submenu.is_empty()
    }
}

/// Where an open menu hangs from the element [`menu_layer`] is a child of.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MenuPlacement {
    /// Above it, left edges aligned, 8px clear of it.
    Above,
    /// Below it, right edges aligned, 8px clear of it.
    BelowEnd,
    /// Below it, left edges aligned, 8px clear of it.
    BelowStart,
    /// With the menu's top-left corner at this point, in window coordinates
    /// (a right-click).
    At(Point<Pixels>),
}

/// The open submenu.
#[derive(Debug, Clone, Copy)]
struct SubmenuState {
    /// The index of the item it belongs to.
    parent: usize,
    highlighted: Option<usize>,
    /// Whether the keyboard acts on it rather than on the menu.
    active: bool,
}

/// An open menu. It owns its focus handle, the highlighted item, the open
/// submenu, and where focus returns.
pub struct Menu {
    focus_handle: FocusHandle,
    entries: Vec<MenuEntry>,
    highlighted: Option<usize>,
    submenu: Option<SubmenuState>,
    restore_focus: Option<FocusHandle>,
    min_width: Option<Pixels>,
    /// Submenus open on the menu's left: a menu that hangs from the
    /// window's right side has no room on its right.
    submenus_left: bool,
    /// The submenu surface's bounds as last painted, so a press inside it
    /// does not count as outside the menu.
    submenu_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    open: bool,
    closed_by_press_at: Option<Point<Pixels>>,
}

impl std::fmt::Debug for Menu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Menu")
            .field("entries", &self.entries.len())
            .field("highlighted", &self.highlighted)
            .field("submenu", &self.submenu)
            .field("open", &self.open)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<DismissEvent> for Menu {}

impl Focusable for Menu {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl Menu {
    pub fn new(entries: Vec<MenuEntry>, cx: &mut App) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            entries,
            highlighted: None,
            submenu: None,
            restore_focus: None,
            min_width: None,
            submenus_left: false,
            submenu_bounds: Rc::new(Cell::new(None)),
            open: true,
            closed_by_press_at: None,
        }
    }

    /// The menu is at least this wide (the row it opens from, say).
    pub fn min_w(mut self, width: Pixels) -> Self {
        self.min_width = Some(width);
        self
    }

    /// Opens submenus on the menu's left instead of its right.
    pub fn submenus_left(mut self, left: bool) -> Self {
        self.submenus_left = left;
        self
    }

    /// Where focus returns when the menu closes; by default, what had focus
    /// when it opened.
    pub fn restore_focus_to(mut self, handle: FocusHandle) -> Self {
        self.restore_focus = Some(handle);
        self
    }

    /// Makes the menu an entity and gives it focus.
    pub fn open(mut self, window: &mut Window, cx: &mut App) -> Entity<Self> {
        if self.restore_focus.is_none() {
            self.restore_focus = window.focused(cx);
        }
        let menu = cx.new(|_| self);
        menu.read(cx).focus_handle.clone().focus(window, cx);
        menu
    }

    /// Whether the menu is still open.
    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Where the pointer press that closed the menu was, when a press
    /// outside it did. The trigger that press lands on uses it to not open
    /// the menu again on the same click ([`reopens_on`]).
    pub fn closed_by_press_at(&self) -> Option<Point<Pixels>> {
        self.closed_by_press_at
    }

    /// Closes the menu: focus goes back where it came from unless it has
    /// already moved elsewhere, and the owner hears [`DismissEvent`].
    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        self.submenu = None;
        let focus_moved = window.focused(cx).is_some() && !self.focus_handle.is_focused(window);
        if !focus_moved && let Some(handle) = &self.restore_focus {
            handle.focus(window, cx);
        }
        cx.emit(DismissEvent);
        cx.notify();
    }

    fn item(&self, ix: usize) -> Option<&MenuItem> {
        match self.entries.get(ix)? {
            MenuEntry::Item(item) => Some(item.as_ref()),
            MenuEntry::Separator | MenuEntry::Heading(_) => None,
        }
    }

    /// The entries the keyboard acts on: the active submenu's, else the
    /// menu's.
    fn active_entries(&self) -> &[MenuEntry] {
        match self.submenu {
            Some(submenu) if submenu.active => {
                self.item(submenu.parent).map_or(&[][..], |item| &item.submenu[..])
            }
            _ => &self.entries,
        }
    }

    fn active_highlight(&self) -> Option<usize> {
        match self.submenu {
            Some(submenu) if submenu.active => submenu.highlighted,
            _ => self.highlighted,
        }
    }

    /// Highlights entry `ix` of the active level. Moving within the menu
    /// closes a submenu the keyboard is not in.
    fn set_active_highlight(&mut self, ix: Option<usize>, cx: &mut Context<Self>) {
        match &mut self.submenu {
            Some(submenu) if submenu.active => submenu.highlighted = ix,
            _ => {
                self.highlighted = ix;
                if self.submenu.is_some_and(|submenu| Some(submenu.parent) != ix) {
                    self.submenu = None;
                }
            }
        }
        cx.notify();
    }

    fn step(&mut self, forward: bool, cx: &mut Context<Self>) {
        let enabled = enabled_items(self.active_entries());
        let Some((&first, &last)) = enabled.first().zip(enabled.last()) else {
            return;
        };
        let next = match self.active_highlight() {
            None => Some(if forward { first } else { last }),
            Some(current) if forward => {
                enabled.iter().copied().find(|ix| *ix > current).or(Some(first))
            }
            Some(current) => enabled.iter().rev().copied().find(|ix| *ix < current).or(Some(last)),
        };
        self.set_active_highlight(next, cx);
    }

    fn select_previous(&mut self, _: &SelectPreviousItem, _: &mut Window, cx: &mut Context<Self>) {
        self.step(false, cx);
    }

    fn select_next(&mut self, _: &SelectNextItem, _: &mut Window, cx: &mut Context<Self>) {
        self.step(true, cx);
    }

    fn select_first(&mut self, _: &SelectFirstItem, _: &mut Window, cx: &mut Context<Self>) {
        let first = enabled_items(self.active_entries()).first().copied();
        self.set_active_highlight(first, cx);
    }

    fn select_last(&mut self, _: &SelectLastItem, _: &mut Window, cx: &mut Context<Self>) {
        let last = enabled_items(self.active_entries()).last().copied();
        self.set_active_highlight(last, cx);
    }

    fn choose_highlighted(&mut self, _: &ChooseItem, window: &mut Window, cx: &mut Context<Self>) {
        match self.submenu {
            Some(submenu) if submenu.active => {
                if let Some(ix) = submenu.highlighted {
                    self.choose(Some(submenu.parent), ix, window, cx);
                }
            }
            _ => {
                if let Some(ix) = self.highlighted {
                    self.choose(None, ix, window, cx);
                }
            }
        }
    }

    fn open_highlighted_submenu(
        &mut self,
        _: &OpenSubmenu,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(ix) = self.highlighted
            && self.submenu.is_none_or(|submenu| !submenu.active)
        {
            self.open_submenu(ix, true, cx);
        }
    }

    fn close_submenu(&mut self, _: &CloseSubmenu, _: &mut Window, cx: &mut Context<Self>) {
        if self.submenu.take().is_some() {
            cx.notify();
        }
    }

    fn dismiss(&mut self, _: &DismissMenu, window: &mut Window, cx: &mut Context<Self>) {
        if self.submenu.is_some_and(|submenu| submenu.active) {
            self.submenu = None;
            cx.notify();
        } else {
            self.close(window, cx);
        }
    }

    fn close_menu(&mut self, _: &CloseMenu, window: &mut Window, cx: &mut Context<Self>) {
        self.close(window, cx);
    }

    /// Opens the submenu of item `ix`, if it has one; `active` moves the
    /// keyboard into it, on its checked item (the current language, say),
    /// else its first enabled one.
    /// Opens the submenu of the item `key` as the pointer would (resting
    /// on it): the item highlighted, no row of the submenu until the
    /// keyboard or the pointer moves into it. Whether the menu has it.
    pub fn open_submenu_of(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let found = self.entries.iter().position(
            |entry| matches!(entry, MenuEntry::Item(item) if item.key == key && item.has_submenu()),
        );
        if let Some(ix) = found {
            self.open_submenu(ix, false, cx);
        }
        found.is_some()
    }

    fn open_submenu(&mut self, ix: usize, active: bool, cx: &mut Context<Self>) {
        let Some(item) = self.item(ix).filter(|item| item.has_submenu() && !item.disabled) else {
            return;
        };
        let enabled = enabled_items(&item.submenu);
        let checked = enabled.iter().copied().find(|&entry| {
            matches!(item.submenu.get(entry), Some(MenuEntry::Item(entry)) if entry.checked)
        });
        let highlighted = active.then(|| checked.or(enabled.first().copied())).flatten();
        self.highlighted = Some(ix);
        self.submenu = Some(SubmenuState { parent: ix, highlighted, active });
        cx.notify();
    }

    /// Chooses entry `ix` of the menu, or of the submenu of item `parent`:
    /// opens its submenu, or closes the menu and then runs its handler or
    /// dispatches its Action from where focus returned.
    fn choose(
        &mut self,
        parent: Option<usize>,
        ix: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let entries = match parent {
            Some(parent) => match self.item(parent) {
                Some(item) => &item.submenu,
                None => return,
            },
            None => &self.entries,
        };
        let Some(MenuEntry::Item(item)) = entries.get(ix) else {
            return;
        };
        if item.disabled {
            return;
        }
        if parent.is_none() && item.has_submenu() {
            self.open_submenu(ix, true, cx);
            return;
        }
        let handler = item.handler.clone();
        let action = item.action.as_ref().map(|action| action.boxed_clone());
        self.close(window, cx);
        if let Some(handler) = handler {
            handler(window, cx);
        } else if let Some(action) = action {
            window.dispatch_action(action, cx);
        }
    }

    /// A press outside the menu (and outside its submenu) closes it.
    fn press_outside(
        &mut self,
        event: &MouseDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.submenu_bounds.get().is_some_and(|bounds| bounds.contains(&event.position)) {
            return;
        }
        self.closed_by_press_at = Some(event.position);
        self.close(window, cx);
    }

    fn hover_item(
        &mut self,
        parent: Option<usize>,
        ix: usize,
        hovered: bool,
        cx: &mut Context<Self>,
    ) {
        match parent {
            None if hovered => {
                if self.item(ix).is_some_and(MenuItem::has_submenu) {
                    if self.submenu.is_none_or(|submenu| submenu.parent != ix) {
                        self.open_submenu(ix, false, cx);
                    }
                } else {
                    self.submenu = None;
                }
                self.highlighted = Some(ix);
            }
            None => {
                let opened = self.submenu.is_some_and(|submenu| submenu.parent == ix);
                if self.highlighted == Some(ix) && !opened {
                    self.highlighted = None;
                }
            }
            Some(_) => {
                if let Some(submenu) = &mut self.submenu {
                    if hovered {
                        submenu.highlighted = Some(ix);
                        submenu.active = true;
                    } else if submenu.highlighted == Some(ix) {
                        submenu.highlighted = None;
                    }
                }
            }
        }
        cx.notify();
    }

    /// The surface of the menu (`parent` None) or of item `parent`'s
    /// submenu: the floating recipe around its rows.
    fn render_surface(
        &self,
        parent: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let palette = cx.maka();
        let dark = cx.theme().is_dark();
        let (entries, highlighted) = match parent {
            Some(parent) => (
                self.item(parent).map_or(&[][..], |item| &item.submenu[..]),
                self.submenu.and_then(|submenu| submenu.highlighted),
            ),
            // One row reads as the current one: while a row of the open
            // submenu is highlighted, the item that opened it gives up its
            // fill (it stays expanded) (review round 13).
            None => (
                &self.entries[..],
                self.highlighted.filter(|&ix| {
                    !self.submenu.is_some_and(|submenu| {
                        submenu.parent == ix && submenu.highlighted.is_some()
                    })
                }),
            ),
        };
        let width = parent.and_then(|parent| self.item(parent)).and_then(|item| item.submenu_width);
        let icons = entries
            .iter()
            .any(|entry| matches!(entry, MenuEntry::Item(item) if item.icon.is_some()));
        let rows: Vec<AnyElement> = entries
            .iter()
            .enumerate()
            .map(|(ix, entry)| match entry {
                MenuEntry::Separator => {
                    div().h(px(1.)).my_1().mx(-PADDING).bg(palette.border_soft).into_any_element()
                }
                MenuEntry::Heading(heading) => v_flex()
                    .id("menu-heading")
                    .test_support()
                    .aria_label(heading.title.clone())
                    .max_w(rems(HEADING_MAX_WIDTH_REMS))
                    .px_2()
                    .py_1()
                    .child(div().text_sm().font_medium().child(heading.title.clone()))
                    .children(heading.path.clone().map(|path| {
                        div()
                            .id("menu-heading-path")
                            .test_support()
                            .aria_label(path.clone())
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_xs()
                            .line_height(rems(1.25))
                            .text_color(palette.ink_muted)
                            .child(path)
                    }))
                    .into_any_element(),
                MenuEntry::Item(item) => {
                    let row = self.render_row(
                        parent,
                        ix,
                        item,
                        highlighted == Some(ix),
                        icons,
                        window,
                        cx,
                    );
                    match self.submenu {
                        Some(submenu) if parent.is_none() && submenu.parent == ix => row
                            .child(self.render_submenu(ix, window, cx))
                            .test_support()
                            .into_any_element(),
                        _ => row.test_support().into_any_element(),
                    }
                }
            })
            .collect();
        v_flex()
            .id(if parent.is_some() { "submenu" } else { "menu" })
            .role(Role::Menu)
            .occlude()
            .min_w(rems(10.))
            .when_some(self.min_width.filter(|_| parent.is_none()), |this, width| this.min_w(width))
            .when_some(width, |this, width| this.w(width))
            .p(PADDING)
            .bg(palette.overlay)
            .border(BORDER)
            .border_color(palette.border_soft)
            .rounded(RADIUS_MODAL)
            .shadow(floating_shadow(&palette, dark))
            .text_color(palette.ink)
            .children(rows)
    }

    /// Item `parent`'s submenu, beside its row: its first row level with
    /// the parent row, 4px clear of the menu's edge.
    fn render_submenu(
        &self,
        parent: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let bounds = self.submenu_bounds.clone();
        let surface = self
            .render_surface(Some(parent), window, cx)
            .on_prepaint(move |painted, _, _| bounds.set(Some(painted)))
            .test_support();
        let (anchor, offset) = if self.submenus_left {
            (Anchor::TopRight, -SUBMENU_GAP)
        } else {
            (Anchor::TopLeft, SUBMENU_GAP)
        };
        div()
            .absolute()
            .top(-(PADDING + BORDER))
            .map(|this| {
                if self.submenus_left {
                    this.left(-(PADDING + BORDER))
                } else {
                    this.right(-(PADDING + BORDER))
                }
            })
            .child(
                deferred(
                    anchored()
                        .anchor(anchor)
                        .offset(point(offset, px(0.)))
                        .snap_to_window_with_margin(ANCHOR_GAP)
                        .child(surface),
                )
                .with_priority(POPUP_PRIORITY + 1),
            )
            .into_any_element()
    }

    #[allow(clippy::too_many_arguments)]
    fn render_row(
        &self,
        parent: Option<usize>,
        ix: usize,
        item: &MenuItem,
        highlighted: bool,
        icons: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> gpui_kit::Stateful<gpui_kit::Div> {
        let palette = cx.maka();
        let disabled = item.disabled;
        let expanded = parent.is_none() && self.submenu.is_some_and(|submenu| submenu.parent == ix);
        let trailing: Option<AnyElement> = if item.has_submenu() {
            Some(
                Icon::new(MakaIcon::ChevronRight)
                    .size_3p5()
                    .text_color(palette.ink_muted)
                    .into_any_element(),
            )
        } else if item.checked {
            Some(
                Icon::new(IconName::Check)
                    .size_4()
                    .text_color(palette.ink_muted)
                    .into_any_element(),
            )
        } else if let Some(end) = &item.end {
            // Astryx draws `endContent` in the item's own type, a count and
            // an action alike (skills-panel.tsx).
            Some(div().font_features(tabular_nums()).child(end.clone()).into_any_element())
        } else {
            item.shortcut
                .as_ref()
                .and_then(|action| {
                    self.restore_focus
                        .as_ref()
                        .and_then(|handle| {
                            Kbd::binding_for_action_in(action.as_ref(), handle, window)
                        })
                        .or_else(|| Kbd::global_binding_for_action(action.as_ref(), window))
                })
                .map(|kbd| shortcut_hint(kbd, cx).into_any_element())
        };
        h_flex()
            .id(domain_element_id("menu-item", &item.key))
            .role(Role::MenuItem)
            .aria_label(item.label.clone())
            .aria_selected(highlighted)
            // A checked item says so to assistive technology, as its check
            // mark does on screen.
            .when(item.checked, |this| this.aria_toggled(gpui_kit::Toggled::True))
            .when(item.has_submenu(), |this| this.aria_expanded(expanded))
            .relative()
            .flex_shrink_0()
            .map(|this| match item.detail {
                Some(_) => this.min_h_8().py_1p5(),
                None => this.h_8(),
            })
            .px_2()
            .gap_2()
            .rounded(RADIUS_CONTROL)
            .text_sm()
            .text_color(if disabled { palette.ink_muted } else { palette.ink })
            .when(highlighted && !disabled, |this| this.bg(palette.active_row))
            .when(icons, |this| {
                this.child(h_flex().size_4().flex_shrink_0().justify_center().children(
                    item.icon.clone().map(|icon| icon.size_4().text_color(palette.ink_muted)),
                ))
            })
            .child(match &item.detail {
                Some(detail) => v_flex()
                    .flex_1()
                    .min_w_0()
                    .child(div().truncate().child(item.label.clone()))
                    .child(
                        // One line, ending in an ellipsis, as Astryx's
                        // string description.
                        div()
                            .truncate()
                            .text_xs()
                            .line_height(rems(1.25))
                            .text_color(palette.ink_muted)
                            .child(detail.clone()),
                    )
                    .into_any_element(),
                None => {
                    div().flex_1().min_w_0().truncate().child(item.label.clone()).into_any_element()
                }
            })
            .children(trailing.map(|trailing| div().flex_shrink_0().ml_4().child(trailing)))
            .when_some(item.tooltip.clone(), |this, tooltip| {
                this.tooltip(move |window, cx| Tooltip::new(tooltip.clone()).build(window, cx))
            })
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                this.hover_item(parent, ix, *hovered, cx);
            }))
            .when(!disabled, |this| {
                this.on_mouse_down(MouseButton::Left, |_, window, cx| {
                    // The menu keeps focus until the choice runs.
                    window.prevent_default();
                    cx.stop_propagation();
                })
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.choose(parent, ix, window, cx);
                }))
            })
    }
}

impl Render for Menu {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return div().into_any_element();
        }
        self.submenu_bounds.set(None);
        self.render_surface(None, window, cx)
            .key_context(MENU_CONTEXT)
            .track_focus(&self.focus_handle)
            .on_action(cx.listener(Self::select_previous))
            .on_action(cx.listener(Self::select_next))
            .on_action(cx.listener(Self::select_first))
            .on_action(cx.listener(Self::select_last))
            .on_action(cx.listener(Self::choose_highlighted))
            .on_action(cx.listener(Self::open_highlighted_submenu))
            .on_action(cx.listener(Self::close_submenu))
            .on_action(cx.listener(Self::dismiss))
            .on_action(cx.listener(Self::close_menu))
            .on_mouse_down_out(cx.listener(Self::press_outside))
            .test_support()
            .into_any_element()
    }
}

/// The indices of `entries` that the keyboard can land on.
fn enabled_items(entries: &[MenuEntry]) -> Vec<usize> {
    entries
        .iter()
        .enumerate()
        .filter_map(|(ix, entry)| match entry {
            MenuEntry::Item(item) if !item.disabled => Some(ix),
            _ => None,
        })
        .collect()
}

/// Draws `menu` above everything, placed against the element this layer is
/// a child of (which must be `relative`), kept 8px inside the window.
pub fn menu_layer(menu: &Entity<Menu>, placement: MenuPlacement) -> AnyElement {
    let layer = anchored().snap_to_window_with_margin(ANCHOR_GAP).child(menu.clone());
    match placement {
        MenuPlacement::At(position) => {
            deferred(layer.position(position)).with_priority(POPUP_PRIORITY).into_any_element()
        }
        MenuPlacement::Above => div()
            .absolute()
            .left_0()
            .top_0()
            .child(
                deferred(layer.anchor(Anchor::BottomLeft).offset(point(px(0.), -ANCHOR_GAP)))
                    .with_priority(POPUP_PRIORITY),
            )
            .into_any_element(),
        MenuPlacement::BelowStart => div()
            .absolute()
            .left_0()
            .bottom_0()
            .child(
                deferred(layer.anchor(Anchor::TopLeft).offset(point(px(0.), ANCHOR_GAP)))
                    .with_priority(POPUP_PRIORITY),
            )
            .into_any_element(),
        MenuPlacement::BelowEnd => div()
            .absolute()
            .right_0()
            .bottom_0()
            .child(
                deferred(layer.anchor(Anchor::TopRight).offset(point(px(0.), ANCHOR_GAP)))
                    .with_priority(POPUP_PRIORITY),
            )
            .into_any_element(),
    }
}

/// One trigger's menu, kept by the view that draws the trigger: the open
/// menu and what drops it on [`DismissEvent`], and where the press that
/// last closed it was, so a click on the trigger closes the menu rather
/// than opening it again. The trigger calls [`MenuSlot::toggle`] on click
/// and draws [`MenuSlot::layer`] as a child of a `relative` element.
#[derive(Default)]
pub struct MenuSlot {
    open: Option<(Entity<Menu>, gpui_kit::Subscription)>,
    closed_at: Option<Point<Pixels>>,
    /// Where the menu hangs from the trigger.
    placement: Option<MenuPlacement>,
}

impl std::fmt::Debug for MenuSlot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MenuSlot").field("open", &self.open.is_some()).finish()
    }
}

impl MenuSlot {
    /// A slot whose menu hangs `placement` from its trigger (below and
    /// right-aligned when not given).
    pub fn new(placement: MenuPlacement) -> Self {
        Self { placement: Some(placement), ..Self::default() }
    }

    fn placement(&self) -> MenuPlacement {
        self.placement.unwrap_or(MenuPlacement::BelowEnd)
    }

    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// The open menu.
    pub fn menu(&self) -> Option<&Entity<Menu>> {
        self.open.as_ref().map(|(menu, _)| menu)
    }

    /// A click on the trigger: closes the open menu, or opens one on
    /// `entries` unless this click's press just closed it. `slot` finds
    /// this slot in the view.
    pub fn toggle<V: 'static>(
        view: &mut V,
        slot: fn(&mut V) -> &mut MenuSlot,
        event: &ClickEvent,
        entries: impl FnOnce(&V, &mut Context<V>) -> Vec<MenuEntry>,
        min_width: Pixels,
        window: &mut Window,
        cx: &mut Context<V>,
    ) {
        let this = slot(view);
        if let Some((menu, _)) = this.open.take() {
            menu.update(cx, |menu, cx| menu.close(window, cx));
            cx.notify();
            return;
        }
        if reopens_on(event, this.closed_at.take()) {
            let entries = entries(view, cx);
            Self::open(view, slot, entries, min_width, window, cx);
        }
    }

    /// Opens a menu on `entries`, unless one is open.
    pub fn open<V: 'static>(
        view: &mut V,
        slot: fn(&mut V) -> &mut MenuSlot,
        entries: Vec<MenuEntry>,
        min_width: Pixels,
        window: &mut Window,
        cx: &mut Context<V>,
    ) {
        if slot(view).open.is_some() {
            return;
        }
        // A menu right-aligned to its trigger grows leftwards, and so do
        // its submenus.
        let left = slot(view).placement() == MenuPlacement::BelowEnd;
        let menu = Menu::new(entries, cx).min_w(min_width).submenus_left(left).open(window, cx);
        let dismiss = cx.subscribe(&menu, move |view, menu, _: &DismissEvent, cx| {
            let this = slot(view);
            if this.open.take_if(|(open, _)| *open == menu).is_some() {
                this.closed_at = menu.read(cx).closed_by_press_at();
                cx.notify();
            }
        });
        slot(view).open = Some((menu, dismiss));
        cx.notify();
    }

    /// The open menu, placed against the trigger's `relative` parent.
    pub fn layer(&self) -> Option<AnyElement> {
        self.menu().map(|menu| menu_layer(menu, self.placement()))
    }
}

/// Whether a click on a menu's trigger opens the menu: not when the press
/// of that same click is the one that just closed the menu (`closed`, as
/// [`Menu::closed_by_press_at`] reported it), so a second click on the
/// trigger closes the menu rather than opening it again.
pub fn reopens_on(event: &ClickEvent, closed: Option<Point<Pixels>>) -> bool {
    match (event, closed) {
        (ClickEvent::Mouse(click), Some(position)) => click.down.position != position,
        _ => true,
    }
}

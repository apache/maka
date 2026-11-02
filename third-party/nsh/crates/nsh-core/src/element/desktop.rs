//! Desktop windows and menus for Rust components, using the platform's
//! native chrome (TS: `nsh/desktop`'s `Window` and `Menu`).
//!
//! A custom title bar calls [`set_title_bar`] once (or in an effect if its
//! height changes), marks its background with [`Interactive::window_drag`],
//! and reserves the left and right edges reported by [`title_bar`]. Native
//! window controls and title-bar double-click behavior remain the platform's.
//! The window's other functions ([`set_title`], [`minimize`], ...) are
//! `Window`'s. The application menu ([`set_application_menu`]) and context
//! menus ([`popup_menu`]) are [`MenuItem`]s whose [`MenuItem::on_select`]
//! runs when the user chooses the item, by a click or its shortcut.
//!
//! On platforms without desktop windows these have no effect.
//!
//! [`Interactive::window_drag`]: super::Interactive::window_drag

use std::{fmt, rc::Rc};

use super::{Owner, cleanup, menus::MenuHandler, task::Answer};
use crate::{
    desktop::{
        self, DesktopCommand, MenuAction, MenuBarMode, MenuRole, Shortcut, TitleBarStyle,
        WindowFrame, WindowLevel,
    },
    geometry::{Edges, Point, Points},
    keymap::When,
    platform::Os,
};

/// Hides the system title text so the app can draw its own title bar, or
/// restores the system bar. `height` is the custom bar's height in points:
/// native window controls are centered in it. Positive finite heights are
/// capped at 200 points; other values use the platform's default height.
/// On macOS it selects compact chrome up to 44 points and regular chrome
/// above; [`title_bar`] reports the actual native height for layout. An
/// embedding host's existing toolbar keeps its own style and height.
/// On platforms without desktop windows this has no effect.
pub fn set_title_bar(style: TitleBarStyle, height: Option<Points>) {
    super::desktop_command(DesktopCommand::SetTitleBar {
        style,
        height: crate::desktop::title_bar_height(height),
    });
}

/// The custom title bar's height (`top`) and the widths its native window
/// controls occupy (`left` and `right`), in points. Reading subscribes to
/// changes, including entering and leaving full screen. These are zero
/// with a system title bar and on platforms without desktop windows.
pub fn title_bar() -> Edges<Points> {
    super::title_bar()
}

/// Sets the window's title: the title bar, the taskbar or Dock, the
/// window switcher (TS: `Window.setTitle`).
pub fn set_title(title: impl Into<String>) {
    super::desktop_command(DesktopCommand::SetTitle(title.into()));
}

/// When the menu bar shows on Windows and Linux where the window draws the
/// application menu as a bar above the app (the GPUI backend):
/// [`MenuBarMode::Shown`] (the default) always; [`MenuBarMode::AutoHide`]
/// only after Alt is pressed and released alone, until Alt alone hides it
/// again. F10 and Alt with a menu's initial open a menu either way, and the
/// bar shows while it is open. macOS's menu bar is the system's (TS:
/// `Window.setMenuBar`).
pub fn set_menu_bar_visibility(mode: MenuBarMode) {
    super::desktop_command(DesktopCommand::SetMenuBar(mode));
}

/// Minimizes the window (TS: `Window.minimize`).
pub fn minimize() {
    super::desktop_command(DesktopCommand::Minimize);
}

/// Maximizes the window, or restores it when it is maximized (TS:
/// `Window.toggleMaximize`).
pub fn toggle_maximize() {
    super::desktop_command(DesktopCommand::ToggleMaximize);
}

/// Enters or leaves full screen (TS: `Window.toggleFullScreen`).
pub fn toggle_full_screen() {
    super::desktop_command(DesktopCommand::ToggleFullScreen);
}

/// Moves and sizes the window in points; fields left out keep their values
/// (TS: `Window.setFrame`). macOS and Windows size the outer frame, window
/// decorations included; Linux sets GTK's default window size. `x` and `y`
/// are the top left corner, from the primary screen's top left with `y`
/// growing down. Sizing works on macOS, Windows and Linux; positioning on
/// macOS and Windows. Widths and heights take positive finite numbers, `x`
/// and `y` finite ones: other values keep the field's value.
pub fn set_frame(frame: WindowFrame) {
    super::desktop_command(DesktopCommand::SetFrame(WindowFrame {
        x: frame.x.filter(|v| v.is_finite()),
        y: frame.y.filter(|v| v.is_finite()),
        width: frame.width.filter(|v| v.is_finite() && v.0 > 0.0),
        height: frame.height.filter(|v| v.is_finite() && v.0 > 0.0),
        animated: frame.animated,
    }));
}

/// Sets the window's level on macOS and Windows (TS: `Window.setLevel`):
/// [`WindowLevel::Floating`] stays above normal windows,
/// [`WindowLevel::Normal`] restores the normal level.
pub fn set_level(level: WindowLevel) {
    super::desktop_command(DesktopCommand::SetLevel(level));
}

/// Brings the window to the front of its level and focuses it; the app
/// activates (TS: `Window.orderFront`).
pub fn order_front() {
    super::desktop_command(DesktopCommand::OrderFront);
}

/// Closes the app's window using the platform's normal close behavior.
/// The embedding host decides whether closing the last window exits.
/// On platforms without desktop windows this has no effect.
pub fn close_window() {
    super::desktop_command(DesktopCommand::Close);
}

/// An item of a menu (TS: `nsh/desktop`'s `MenuItem`): an item that runs
/// its [`on_select`](Self::on_select) or carries out its
/// [`role`](Self::role), a separator, or a submenu.
///
/// ```ignore
/// MenuItem::submenu("File", [
///     MenuItem::new("New").shortcut("mod+n").on_select(new_document),
///     MenuItem::separator(),
///     MenuItem::role(MenuRole::Quit),
/// ])
/// ```
#[derive(Clone)]
pub struct MenuItem {
    kind: Kind,
    label: String,
    role: Option<MenuRole>,
    /// The keystroke as written, checked.
    shortcut: Option<Rc<str>>,
    when: When,
    enabled: bool,
    checked: Option<bool>,
    on_select: Option<MenuHandler>,
}

#[derive(Clone)]
enum Kind {
    Action,
    Separator,
    Submenu(Vec<MenuItem>),
}

impl MenuItem {
    fn of(kind: Kind, label: String) -> Self {
        MenuItem {
            kind,
            label,
            role: None,
            shortcut: None,
            when: When::Always,
            enabled: true,
            checked: None,
            on_select: None,
        }
    }

    /// An item showing `label`.
    pub fn new(label: impl Into<String>) -> Self {
        Self::of(Kind::Action, label.into())
    }

    /// A standard item the platform carries out, with the platform's label
    /// and shortcut unless it is given its own.
    pub fn role(role: MenuRole) -> Self {
        MenuItem {
            role: Some(role),
            ..Self::of(Kind::Action, String::new())
        }
    }

    /// A line between groups of items.
    pub fn separator() -> Self {
        Self::of(Kind::Separator, String::new())
    }

    /// An item opening a menu of `items` (the top-level menus of the
    /// application menu: `File`, `Edit`, ...).
    pub fn submenu(label: impl Into<String>, items: impl IntoIterator<Item = MenuItem>) -> Self {
        Self::of(Kind::Submenu(items.into_iter().collect()), label.into())
    }

    /// What it shows, in place of its role's label.
    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    /// Its keyboard shortcut, as `nsh/keymap` writes keystrokes: `"mod+n"`,
    /// `"mod+shift+z"`, `"alt+f4"`, `"f11"` (`mod` is Command on macOS and
    /// Control elsewhere; [`Shortcut::parse`]).
    ///
    /// # Panics
    ///
    /// On a keystroke that is not one, as TS's menus throw.
    #[track_caller]
    pub fn shortcut(mut self, keystroke: &str) -> Self {
        if let Err(e) = Shortcut::parse(keystroke, false) {
            panic!("MenuItem::shortcut: {e}");
        }
        self.shortcut = Some(keystroke.into());
        self
    }

    /// When its shortcut chooses it while a text field has the keyboard
    /// focus ([`When::Always`] by default), on the GPUI backend.
    pub fn shortcut_when(mut self, when: When) -> Self {
        self.when = when;
        self
    }

    /// It cannot be chosen (or opened): shown dimmed.
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.enabled = !disabled;
        self
    }

    /// A check mark: makes it a checkable item, checked or not.
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
        self
    }

    /// Runs `f` when it is chosen, by a click or its shortcut, under the
    /// owner that showed the menu.
    pub fn on_select(mut self, f: impl Fn() + 'static) -> Self {
        self.on_select = Some(Rc::new(f));
        self
    }
}

impl fmt::Debug for MenuItem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            Kind::Separator => f.write_str("Separator"),
            Kind::Submenu(items) => f
                .debug_struct("Submenu")
                .field("label", &self.label)
                .field("items", items)
                .finish_non_exhaustive(),
            Kind::Action => f
                .debug_struct("MenuItem")
                .field("label", &self.label)
                .field("role", &self.role)
                .field("shortcut", &self.shortcut)
                .finish_non_exhaustive(),
        }
    }
}

/// Makes the platform's items of `items`, keeping their handlers (run
/// under `owner`) in `handlers` with the ids it gives them.
fn decode(
    items: Vec<MenuItem>,
    mac: bool,
    owner: &Owner,
    handlers: &mut Vec<(u32, MenuHandler)>,
) -> Vec<desktop::MenuItem> {
    let menus = super::view_menus();
    items
        .into_iter()
        .map(|item| match item.kind {
            Kind::Separator => desktop::MenuItem::Separator,
            Kind::Submenu(items) => desktop::MenuItem::Submenu {
                label: item.label,
                enabled: item.enabled,
                items: decode(items, mac, owner, handlers),
            },
            Kind::Action => {
                let id = match item.on_select {
                    Some(f) => {
                        let id = menus.borrow_mut().next_id();
                        let owner = *owner;
                        handlers.push((id, Rc::new(move || owner.run(&*f))));
                        id
                    }
                    None => 0,
                };
                let shortcut = match item.shortcut {
                    // Checked when it was given.
                    Some(text) => Shortcut::parse(&text, mac).ok(),
                    None => item.role.and_then(|r| r.shortcut(mac)),
                };
                desktop::MenuItem::Action(MenuAction {
                    id,
                    label: item.label,
                    shortcut,
                    enabled: item.enabled,
                    checked: item.checked,
                    role: item.role,
                    when: item.when,
                })
            }
        })
        .collect()
}

/// Whether the app runs on a desktop OS, where menus show (as TS's).
fn desktop_os() -> bool {
    super::os().is_desktop()
}

/// Sets the application menu, a submenu per top-level item (`File`,
/// `Edit`, ...), or with `None` restores the platform's default (TS:
/// `Menu.setApplicationMenu`). On macOS it is the menu bar, whose first
/// menu is the app menu (titled with the app's name); on Windows and Linux
/// the window's menu bar, not shown while the title bar is hidden (its
/// shortcuts still work: a title bar of the app's own shows its menus with
/// [`popup_menu`]). Call it again to change it; in an [`effect`] it follows
/// the signals it reads. The items' handlers run while the current owner
/// lives: the menu stays after it, inert, until it is set again.
///
/// [`effect`]: super::effect
pub fn set_application_menu(items: impl Into<Option<Vec<MenuItem>>>) {
    if !desktop_os() {
        return;
    }
    let menus = super::view_menus();
    let Some(items) = items.into() else {
        let mut m = menus.borrow_mut();
        m.app_generation += 1;
        let old = std::mem::take(&mut m.app);
        drop(m);
        drop(old);
        super::desktop_command(DesktopCommand::SetMenu(None));
        return;
    };
    let owner = Owner::current();
    let mut handlers = Vec::new();
    let items = decode(items, super::os() == Os::MacOs, &owner, &mut handlers);
    let generation = {
        let mut m = menus.borrow_mut();
        m.app_generation += 1;
        let old = std::mem::replace(&mut m.app, handlers);
        let generation = m.app_generation;
        drop(m);
        drop(old);
        generation
    };
    let weak = Rc::downgrade(&menus);
    cleanup(move || {
        if let Some(menus) = weak.upgrade() {
            let mut m = menus.borrow_mut();
            if m.app_generation == generation {
                let old = std::mem::take(&mut m.app);
                drop(m);
                drop(old);
            }
        }
    });
    super::desktop_command(DesktopCommand::SetMenu(Some(items.into())));
}

/// Shows a context menu of `items` at the pointer (TS: `Menu.popup`). The
/// chosen item's [`MenuItem::on_select`] runs under the current owner. The
/// answer comes once the menu closes, chosen or dismissed (at once off
/// desktops), so a button that opened it can look pressed until then; it
/// need not be awaited.
pub fn popup_menu(items: Vec<MenuItem>) -> Answer<()> {
    popup(items, None)
}

/// As [`popup_menu`], with the menu's top left corner at `at` (the
/// window's coordinates, in points: an
/// [`on_context_menu`](super::Interactive::on_context_menu)'s
/// `page_position`; TS: `Menu.popup(items, at)`).
pub fn popup_menu_at(items: Vec<MenuItem>, at: Point<Points>) -> Answer<()> {
    popup(items, Some(at))
}

fn popup(items: Vec<MenuItem>, at: Option<Point<Points>>) -> Answer<()> {
    let (answer, slot) = Answer::new();
    if !desktop_os() {
        slot.borrow_mut().deliver(());
        return answer;
    }
    let menus = super::view_menus();
    let owner = Owner::current();
    let mut handlers = Vec::new();
    let items = decode(items, super::os() == Os::MacOs, &owner, &mut handlers);
    let generation = {
        let mut m = menus.borrow_mut();
        // One context menu at a time: one shown before is closed by now.
        m.settle_popup();
        m.closed = Some(slot);
        m.popup_generation += 1;
        let old = std::mem::replace(&mut m.popup, handlers);
        let generation = m.popup_generation;
        drop(m);
        drop(old);
        generation
    };
    let weak = Rc::downgrade(&menus);
    cleanup(move || {
        if let Some(menus) = weak.upgrade() {
            let mut m = menus.borrow_mut();
            if m.popup_generation == generation {
                let old = std::mem::take(&mut m.popup);
                drop(m);
                drop(old);
            }
        }
    });
    super::desktop_command(DesktopCommand::PopupMenu {
        items: items.into(),
        at,
    });
    answer
}

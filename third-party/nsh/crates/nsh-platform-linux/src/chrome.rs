//! The window's chrome (`nsh/desktop`): its title, the hidden title bar,
//! drag regions, full screen, the menu bar and context menus.
//!
//! - **Hidden title bar** ([`TitleBarStyle::Hidden`]): the window's header
//!   is hidden, which keeps GTK's client-side decorations (shadows, resize
//!   edges) without it: the title bar its owner set or the one GTK made
//!   (`default-decoration`). A window the window manager decorates (X11, a
//!   Wayland compositor that prefers server-side decorations) gets an
//!   empty, hidden title bar instead, which switches it to client-side
//!   decorations; showing the title bar again removes it. The buttons are
//!   `gtk::WindowControls` over the app (in the `AppView`'s overlay), one
//!   per end, which follow the desktop's decoration layout
//!   (`gtk-decoration-layout`). Their measured widths and the header's
//!   height are the environment's `title_bar`. GTK unrealizes and maps the
//!   window again when it gains or loses a title bar of its own: everything
//!   here is idempotent and applied again when the root is realized.
//! - **Drag regions**: a primary press on a view marked `windowDrag`
//!   ([`crate::input::window_drag`]) moves the window
//!   (`gdk::Toplevel::begin_move`); a double press does what
//!   `gtk-titlebar-double-click` says (maximize by default); a secondary
//!   press opens the window menu. Such presses never reach the app.
//! - **Menus** are `gio::Menu` models: separators split sections, each
//!   item is an action of a group inserted on the window (`nsh.item-N`;
//!   checkable items are stateful boolean actions, so the menu shows the
//!   check), disabled items disabled actions. The menu bar is a
//!   `gtk::PopoverMenuBar` above the app, not shown while the title bar is
//!   hidden or in full screen; shortcuts are a `gtk::ShortcutController` on
//!   the window in the capture phase, so they win over the app's keys,
//!   except the editing roles', which stay the text field's, and a
//!   binding of `nsh/keymap` of the same keystroke (`keymap::claims`). Context menus
//!   are `gtk::PopoverMenu`s with a group of their own (`nshpopup`).

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
    sync::Arc,
};

use gtk4::{self as gtk, gdk, gio, glib, prelude::*};
use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    desktop::{DesktopCommand, Key, MenuItem, MenuRole, Shortcut, TitleBarStyle},
    geometry::{Edges, Points},
};

use crate::surface::Surface;

/// The hidden title bar's height at least, in points (Adwaita's header
/// bar).
const HEADER_HEIGHT: f32 = 46.0;
/// Space around the window buttons, in points.
const MARGIN: i32 = 6;

/// A surface's chrome.
#[derive(Default)]
pub(crate) struct Chrome {
    style: Cell<TitleBarStyle>,
    /// The app's title bar's height (`Window.setTitleBar`'s).
    height: Cell<Option<f32>>,
    /// The `AppView`'s overlay (the window buttons go in it) and the box
    /// above it that holds the menu bar.
    overlay: RefCell<Option<glib::WeakRef<gtk::Overlay>>>,
    slot: RefCell<Option<glib::WeakRef<gtk::Box>>>,
    /// The header hidden (the window's title bar).
    header: RefCell<Option<glib::WeakRef<gtk::Widget>>>,
    /// The empty title bar given to a window the window manager decorated.
    empty: RefCell<Option<gtk::Widget>>,
    /// The window buttons at the start and the end, while hidden.
    controls: RefCell<Option<(gtk::WindowControls, gtk::WindowControls)>>,
    /// The application menu.
    menu: RefCell<Option<Arc<[MenuItem]>>>,
    /// The app's context menu shown, and its items (`nsh test --target
    /// linux` chooses from it).
    #[cfg(feature = "dev")]
    open_popup: RefCell<Option<(Arc<[MenuItem]>, gtk::PopoverMenu)>>,
    /// The menu bar shown.
    bar: RefCell<Option<gtk::PopoverMenuBar>>,
    /// The application menu's shortcuts (on the window).
    shortcuts: RefCell<Option<gtk::ShortcutController>>,
    /// The window watched for full screen.
    watched: RefCell<glib::WeakRef<gtk::Window>>,
    /// The last primary press (ms, surface coordinates), for double
    /// presses.
    last_press: Cell<Option<(u32, f64, f64)>>,
}

/// Ties the chrome to the `AppView`'s widgets (`AppView::new`).
pub(crate) fn attach(surface: &Rc<Surface>, overlay: &gtk::Overlay, slot: &gtk::Box) {
    let c = &surface.chrome;
    *c.overlay.borrow_mut() = Some(overlay.downgrade());
    *c.slot.borrow_mut() = Some(slot.downgrade());
    let weak = Rc::downgrade(surface);
    surface.root.connect_realize(move |_| {
        if let Some(surface) = weak.upgrade() {
            apply(&surface);
        }
    });
}

/// The box above the app holding the menu bar (the menus it opens are
/// inside it), once the `AppView` is made.
pub(crate) fn menu_bar_slot(surface: &Surface) -> Option<gtk::Box> {
    surface.chrome.slot.borrow().as_ref()?.upgrade()
}

/// The window the surface is in.
fn window(surface: &Surface) -> Option<gtk::Window> {
    surface.root.root().and_downcast::<gtk::Window>()
}

fn hidden(surface: &Surface) -> bool {
    surface.chrome.style.get() == TitleBarStyle::Hidden
}

/// Applies the title bar and the menu to the window (again: the window
/// may be new, or realized again).
fn apply(surface: &Rc<Surface>) {
    let Some(window) = window(surface) else {
        return;
    };
    watch(surface, &window);
    apply_title_bar(surface, &window);
    install_menu(surface, &window);
}

/// Follows the window's full screen state.
fn watch(surface: &Rc<Surface>, window: &gtk::Window) {
    let c = &surface.chrome;
    if c.watched.borrow().upgrade().as_ref() == Some(window) {
        return;
    }
    c.watched.borrow().set(Some(window));
    let weak = Rc::downgrade(surface);
    window.connect_fullscreened_notify(move |_| {
        if let Some(surface) = weak.upgrade() {
            update_area(&surface);
            show_menu_bar(&surface);
        }
    });
}

// --- Commands ---------------------------------------------------------------------------

/// A desktop command (on the root).
pub(crate) fn command(surface: &Rc<Surface>, command: &DesktopCommand) {
    let c = &surface.chrome;
    match command {
        DesktopCommand::SetTitleBar { style, height } => {
            let height = height.map(|h| h.0);
            let resized = c.height.replace(height) != height;
            if resized && c.style.get() == *style {
                update_area(surface);
            }
            if c.style.replace(*style) != *style
                && let Some(window) = window(surface)
            {
                apply_title_bar(surface, &window);
                show_menu_bar(surface);
            }
        }
        DesktopCommand::SetMenu(menu) => {
            *c.menu.borrow_mut() = menu.clone();
            if let Some(window) = window(surface) {
                install_menu(surface, &window);
            }
        }
        DesktopCommand::PopupMenu { items, at } => {
            popup(surface, items, at.map(|p| (p.x.0, p.y.0)))
        }
        DesktopCommand::SetTitle(title) => {
            if let Some(window) = window(surface) {
                window.set_title(Some(title));
            }
        }
        DesktopCommand::Minimize => {
            if let Some(window) = window(surface) {
                window.minimize();
            }
        }
        DesktopCommand::ToggleMaximize => toggle_maximize(surface),
        DesktopCommand::ToggleFullScreen => toggle_fullscreen(surface),
        DesktopCommand::SetFrame(frame) => {
            // Merge with the requested size: GTK applies it asynchronously,
            // so the allocation may still reflect an earlier frame.
            if (frame.width.is_some() || frame.height.is_some())
                && let Some(window) = window(surface)
            {
                let (width, height) = window.default_size();
                window.set_default_size(
                    frame.width.map_or(width, |v| v.0.round() as i32),
                    frame.height.map_or(height, |v| v.0.round() as i32),
                );
            }
        }
        // GTK 4 has no window levels.
        DesktopCommand::SetLevel(_) => {}
        DesktopCommand::OrderFront => {
            if let Some(window) = window(surface) {
                window.present();
            }
        }
        DesktopCommand::Close => close(surface),
        // GTK's menu bar always shows.
        DesktopCommand::SetMenuBar(_) => {}
    }
}

fn toggle_maximize(surface: &Surface) {
    if let Some(window) = window(surface) {
        if window.is_maximized() {
            window.unmaximize();
        } else {
            window.maximize();
        }
    }
}

fn toggle_fullscreen(surface: &Surface) {
    if let Some(window) = window(surface) {
        if window.is_fullscreen() {
            window.unfullscreen();
        } else {
            window.fullscreen();
        }
    }
}

/// Closes the window: not while the surface applies a batch (closing
/// destroys the window, whose handler stops the surface).
fn close(surface: &Surface) {
    if let Some(window) = window(surface) {
        glib::idle_add_local_once(move || window.close());
    }
}

// --- The hidden title bar ---------------------------------------------------------------

fn apply_title_bar(surface: &Rc<Surface>, window: &gtk::Window) {
    let c = &surface.chrome;
    let overlay = c.overlay.borrow().as_ref().and_then(|w| w.upgrade());
    if hidden(surface) {
        hide_header(surface, window);
        let missing = c.controls.borrow().is_none();
        if missing && let Some(overlay) = &overlay {
            let make = |pack: gtk::PackType, align: gtk::Align| {
                let controls = gtk::WindowControls::new(pack);
                controls.set_halign(align);
                controls.set_valign(gtk::Align::Start);
                controls.set_margin_start(MARGIN);
                controls.set_margin_end(MARGIN);
                overlay.add_overlay(&controls);
                // The decoration layout changed (or first known).
                let weak = Rc::downgrade(surface);
                controls.connect_empty_notify(move |_| {
                    if let Some(surface) = weak.upgrade() {
                        update_area(&surface);
                    }
                });
                controls
            };
            let start = make(gtk::PackType::Start, gtk::Align::Start);
            let end = make(gtk::PackType::End, gtk::Align::End);
            *c.controls.borrow_mut() = Some((start, end));
        }
    } else {
        show_header(surface, window);
        let taken = c.controls.borrow_mut().take();
        if let Some((start, end)) = taken
            && let Some(overlay) = &overlay
        {
            overlay.remove_overlay(&start);
            overlay.remove_overlay(&end);
        }
    }
    update_area(surface);
    // Measured once styled: the buttons' sizes come from the theme.
    let weak: Weak<Surface> = Rc::downgrade(surface);
    glib::idle_add_local_once(move || {
        if let Some(surface) = weak.upgrade() {
            update_area(&surface);
        }
    });
}

/// The header the window shows: the title bar its owner set, or the one
/// GTK makes for client-side decorations (a `default-decoration` child).
fn header(window: &gtk::Window) -> Option<gtk::Widget> {
    window.titlebar().or_else(|| {
        let mut child = window.first_child();
        while let Some(widget) = child {
            if widget.has_css_class("default-decoration") {
                return Some(widget);
            }
            child = widget.next_sibling();
        }
        None
    })
}

/// Hides the window's header. A shown header is only hidden: giving the
/// window a title bar of its own once realized makes GTK unrealize and map
/// it again (`set_titlebar`). A window without one is decorated by the
/// window manager: then an empty, hidden title bar switches it to
/// client-side decorations without a header, which does map it again.
fn hide_header(surface: &Surface, window: &gtk::Window) {
    let c = &surface.chrome;
    match header(window) {
        Some(header) if c.empty.borrow().as_ref() != Some(&header) => {
            header.set_visible(false);
            *c.header.borrow_mut() = Some(header.downgrade());
        }
        Some(_) => {}
        None => {
            let empty: gtk::Widget = gtk::Box::new(gtk::Orientation::Horizontal, 0).upcast();
            empty.set_visible(false);
            // Realizes the window again, which applies the chrome again.
            *c.empty.borrow_mut() = Some(empty.clone());
            set_titlebar(window, Some(&empty));
        }
    }
}

/// Gives `window` a title bar of its own (or takes it away) once realized:
/// what `gtk_window_set_titlebar` does then (unrealize, set, map again if
/// it was mapped), without the warning it prints on every launch and
/// toggle.
fn set_titlebar(window: &gtk::Window, titlebar: Option<&gtk::Widget>) {
    let widget = window.upcast_ref::<gtk::Widget>();
    let mapped = widget.is_mapped();
    if widget.is_realized() {
        widget.unrealize();
    }
    window.set_titlebar(titlebar);
    if mapped {
        widget.map();
    }
}

/// Shows the header `hide_header` hid.
fn show_header(surface: &Surface, window: &gtk::Window) {
    let c = &surface.chrome;
    let header = c.header.borrow_mut().take().and_then(|w| w.upgrade());
    if let Some(header) = header {
        header.set_visible(true);
    }
    let empty = c.empty.borrow_mut().take();
    if let Some(empty) = empty
        && window.titlebar().as_ref() == Some(&empty)
    {
        set_titlebar(window, None);
    }
}

/// Tells the app the hidden title bar's area, and places the buttons in
/// it (none in full screen).
fn update_area(surface: &Surface) {
    let fullscreen = window(surface).is_some_and(|w| w.is_fullscreen());
    let area = match &*surface.chrome.controls.borrow() {
        Some((start, end)) => {
            for controls in [start, end] {
                controls.set_visible(!fullscreen && !controls.is_empty());
            }
            if fullscreen {
                Edges::default()
            } else {
                let height = |w: &gtk::WindowControls| w.measure(gtk::Orientation::Vertical, -1).1;
                let width = |w: &gtk::WindowControls| {
                    if w.is_empty() {
                        0.0
                    } else {
                        (w.measure(gtk::Orientation::Horizontal, -1).1 + 2 * MARGIN) as f32
                    }
                };
                let top = surface.chrome.height.get().unwrap_or_else(|| {
                    HEADER_HEIGHT.max((height(start).max(height(end)) + 2 * MARGIN) as f32)
                });
                for controls in [start, end] {
                    let h = height(controls) as f32;
                    controls.set_margin_top(((top - h) / 2.0).round() as i32);
                }
                let (mut left, mut right) = (width(start), width(end));
                // The start is on the right in right-to-left layouts.
                if start.direction() == gtk::TextDirection::Rtl {
                    std::mem::swap(&mut left, &mut right);
                }
                Edges {
                    top: Points(top),
                    right: Points(right),
                    bottom: Points(0.0),
                    left: Points(left),
                }
            }
        }
        None => Edges::default(),
    };
    let mut env = surface.environment.get();
    if env.title_bar != area {
        env.title_bar = area;
        surface.set_environment(env);
    }
}

/// A button press at `(x, y)` (root coordinates): true when it was on a
/// view that drags the window, which handled it.
pub(crate) fn press(surface: &Surface, event: &gdk::Event, x: f32, y: f32) -> bool {
    let Some(button_event) = event.downcast_ref::<gdk::ButtonEvent>() else {
        return false;
    };
    let button = button_event.button();
    if !matches!(button, gdk::BUTTON_PRIMARY | gdk::BUTTON_SECONDARY)
        || !crate::input::window_drag(surface, x, y)
    {
        return false;
    }
    let Some(window) = window(surface) else {
        return false;
    };
    let Some(toplevel) = window.surface().and_downcast::<gdk::Toplevel>() else {
        return false;
    };
    if button == gdk::BUTTON_SECONDARY {
        let _ = toplevel.show_window_menu(event);
        return true;
    }
    let Some((sx, sy)) = event.position() else {
        return false;
    };
    let time = event.time();
    let c = &surface.chrome;
    let settings = gtk::Settings::default();
    let (interval, distance) = settings.as_ref().map_or((400, 5), |s| {
        (s.gtk_double_click_time(), s.gtk_double_click_distance())
    });
    let double = c.last_press.get().is_some_and(|(t, px, py)| {
        time.wrapping_sub(t) <= interval as u32
            && (sx - px).abs() <= distance as f64
            && (sy - py).abs() <= distance as f64
    });
    if double {
        c.last_press.set(None);
        let action = settings
            .and_then(|s| s.gtk_titlebar_double_click())
            .map(|a| a.to_string());
        match action.as_deref().unwrap_or("toggle-maximize") {
            "minimize" => window.minimize(),
            "none" | "lower" => {}
            "menu" => {
                let _ = toplevel.show_window_menu(event);
            }
            _ => toggle_maximize(surface),
        }
        return true;
    }
    c.last_press.set(Some((time, sx, sy)));
    if let Some(device) = event.device() {
        toplevel.begin_move(&device, button as i32, sx, sy, time);
    }
    true
}

// --- Menus ------------------------------------------------------------------------------

/// The roles Linux has no use for.
fn unsupported(role: Option<MenuRole>) -> bool {
    matches!(
        role,
        Some(MenuRole::About | MenuRole::Hide | MenuRole::HideOthers | MenuRole::ShowAll)
    )
}

/// The shortcut as a GTK accelerator (`<Control><Shift>n`).
fn accelerator(shortcut: &Shortcut) -> Option<String> {
    let mut out = String::new();
    for (on, name) in [
        (shortcut.ctrl, "<Control>"),
        (shortcut.alt, "<Alt>"),
        (shortcut.shift, "<Shift>"),
        (shortcut.meta, "<Super>"),
    ] {
        if on {
            out.push_str(name);
        }
    }
    let key = match shortcut.key {
        Key::Char(c) => keysym_name(c)?,
        Key::Enter => "Return".into(),
        Key::Escape => "Escape".into(),
        Key::Tab => "Tab".into(),
        Key::Backspace => "BackSpace".into(),
        Key::Delete => "Delete".into(),
        Key::Insert => "Insert".into(),
        Key::Space => "space".into(),
        Key::Up => "Up".into(),
        Key::Down => "Down".into(),
        Key::Left => "Left".into(),
        Key::Right => "Right".into(),
        Key::Home => "Home".into(),
        Key::End => "End".into(),
        Key::PageUp => "Page_Up".into(),
        Key::PageDown => "Page_Down".into(),
        Key::F(n) => format!("F{n}"),
    };
    out.push_str(&key);
    Some(out)
}

/// The X keysym name of a character key (`n`, `1`, `comma`), as GTK
/// accelerators write it.
fn keysym_name(c: char) -> Option<String> {
    if c.is_ascii_alphanumeric() {
        return Some(c.to_string());
    }
    Some(
        match c {
            '+' => "plus",
            '-' => "minus",
            '=' => "equal",
            ',' => "comma",
            '.' => "period",
            '/' => "slash",
            '\\' => "backslash",
            ';' => "semicolon",
            '\'' => "apostrophe",
            '`' => "grave",
            '[' => "bracketleft",
            ']' => "bracketright",
            _ => return None,
        }
        .to_owned(),
    )
}

/// A menu model of `items`, their actions added to `group` (named in
/// `prefix`).
struct Builder<'a> {
    surface: Weak<Surface>,
    group: &'a gio::SimpleActionGroup,
    prefix: &'a str,
    next: u32,
    /// The items' shortcuts: (accelerator, detailed action).
    shortcuts: Vec<(String, String)>,
}

impl Builder<'_> {
    fn menu(&mut self, items: &[MenuItem]) -> gio::Menu {
        let menu = gio::Menu::new();
        let mut section = gio::Menu::new();
        for item in items {
            match item {
                MenuItem::Separator => {
                    if section.n_items() > 0 {
                        menu.append_section(None, &section);
                        section = gio::Menu::new();
                    }
                }
                MenuItem::Submenu {
                    label,
                    enabled,
                    items,
                } => {
                    let sub = self.menu(items);
                    let item = gio::MenuItem::new_submenu(Some(&label.replace('_', "__")), &sub);
                    if !enabled {
                        // A submenu opens while its `submenu-action` is
                        // enabled.
                        let name = self.name("submenu");
                        let action = gio::SimpleAction::new(&name, None);
                        action.set_enabled(false);
                        self.group.add_action(&action);
                        let detailed = format!("{}.{name}", self.prefix);
                        item.set_attribute_value("submenu-action", Some(&detailed.to_variant()));
                    }
                    section.append_item(&item);
                }
                MenuItem::Action(a) => {
                    if unsupported(a.role) {
                        continue;
                    }
                    let name = self.name("item");
                    let action = match a.checked {
                        Some(checked) => {
                            gio::SimpleAction::new_stateful(&name, None, &checked.to_variant())
                        }
                        None => gio::SimpleAction::new(&name, None),
                    };
                    action.set_enabled(a.enabled);
                    let (weak, id, role) = (self.surface.clone(), a.id, a.role);
                    action.connect_activate(move |_, _| {
                        if let Some(surface) = weak.upgrade() {
                            choose(&surface, id, role);
                        }
                    });
                    self.group.add_action(&action);
                    let label = if a.label.is_empty() {
                        a.role.map_or("", MenuRole::label)
                    } else {
                        &a.label
                    };
                    let detailed = format!("{}.{name}", self.prefix);
                    let item = gio::MenuItem::new(Some(&label.replace('_', "__")), Some(&detailed));
                    if let Some(accel) = a.shortcut.as_ref().and_then(accelerator) {
                        item.set_attribute_value("accel", Some(&accel.to_variant()));
                        // The editing roles' keys stay the text field's.
                        if !a.role.is_some_and(MenuRole::edits_text) {
                            self.shortcuts.push((accel, detailed));
                        }
                    }
                    section.append_item(&item);
                }
            }
        }
        if section.n_items() > 0 {
            menu.append_section(None, &section);
        }
        menu
    }

    fn name(&mut self, kind: &str) -> String {
        self.next += 1;
        format!("{kind}-{}", self.next)
    }
}

/// Installs the application menu on `window`: its actions, shortcuts and
/// the menu bar (or removes them).
fn install_menu(surface: &Rc<Surface>, window: &gtk::Window) {
    let c = &surface.chrome;
    if let Some(old) = c.shortcuts.borrow_mut().take() {
        window.remove_controller(&old);
    }
    let menu = c.menu.borrow().clone();
    let Some(items) = menu else {
        window.insert_action_group("nsh", None::<&gio::ActionGroup>);
        set_menu_bar(surface, None);
        return;
    };
    let group = gio::SimpleActionGroup::new();
    let mut builder = Builder {
        surface: Rc::downgrade(surface),
        group: &group,
        prefix: "nsh",
        next: 0,
        shortcuts: Vec::new(),
    };
    let model = builder.menu(&items);
    window.insert_action_group("nsh", Some(&group));
    let controller = gtk::ShortcutController::new();
    controller.set_propagation_phase(gtk::PropagationPhase::Capture);
    for (accel, action) in builder.shortcuts {
        if let Some(trigger) = gtk::ShortcutTrigger::parse_string(&accel) {
            let named = gtk::NamedAction::new(&action);
            let weak = Rc::downgrade(surface);
            let keys = controller.downgrade();
            // A binding of `nsh/keymap` of the same keystroke comes first.
            let action = gtk::CallbackAction::new(move |widget, args| {
                let claimed = weak.upgrade().is_some_and(|surface| {
                    keys.upgrade()
                        .and_then(|c| c.current_event())
                        .is_some_and(|event| crate::keymap::claims(&surface, &event))
                });
                if !claimed && named.activate(gtk::ShortcutActionFlags::empty(), widget, args) {
                    glib::Propagation::Stop
                } else {
                    glib::Propagation::Proceed
                }
            });
            controller.add_shortcut(gtk::Shortcut::new(Some(trigger), Some(action)));
        }
    }
    window.add_controller(controller.clone());
    *c.shortcuts.borrow_mut() = Some(controller);
    set_menu_bar(surface, Some(&model));
}

/// Shows `model` as the menu bar above the app (none: removes it).
fn set_menu_bar(surface: &Surface, model: Option<&gio::Menu>) {
    let c = &surface.chrome;
    let Some(slot) = c.slot.borrow().as_ref().and_then(|w| w.upgrade()) else {
        return;
    };
    if let Some(old) = c.bar.borrow_mut().take() {
        slot.remove(&old);
    }
    if let Some(model) = model {
        let bar = gtk::PopoverMenuBar::from_model(Some(model));
        slot.append(&bar);
        *c.bar.borrow_mut() = Some(bar);
    }
    show_menu_bar(surface);
}

/// The menu bar shows unless the title bar is hidden or the window is in
/// full screen.
fn show_menu_bar(surface: &Surface) {
    let fullscreen = window(surface).is_some_and(|w| w.is_fullscreen());
    if let Some(bar) = &*surface.chrome.bar.borrow() {
        bar.set_visible(!hidden(surface) && !fullscreen);
    }
}

/// Shows a context menu at `at` (root coordinates) or at the pointer.
/// Chooses the item of the app's open context menu at the end of `path`
/// (the labels of the submenus on the way, then its own), as a click on it
/// does: the item is carried out and the menu closes (`nsh test --target
/// linux`).
#[cfg(feature = "dev")]
pub(crate) fn choose_open_menu(surface: &Rc<Surface>, path: &[String]) -> Result<(), String> {
    let (items, menu) = surface
        .chrome
        .open_popup
        .borrow()
        .clone()
        .ok_or("no context menu is open")?;
    let mut level: &[MenuItem] = &items;
    let mut chosen = None;
    for (n, label) in path.iter().enumerate() {
        let last = n + 1 == path.len();
        let item = level
            .iter()
            .find(|item| match item {
                MenuItem::Action(action) => last && action.label == *label,
                MenuItem::Submenu { label: l, .. } => !last && l == label,
                MenuItem::Separator => false,
            })
            .ok_or_else(|| format!("the menu has no item {label:?}"))?;
        match item {
            MenuItem::Action(action) => chosen = Some((action.id, action.role)),
            MenuItem::Submenu { items, .. } => level = items,
            MenuItem::Separator => {}
        }
    }
    let (id, role) = chosen.ok_or("no item chosen")?;
    // What the item's action does.
    choose(surface, id, role);
    menu.popdown();
    Ok(())
}

/// Closes the app's open context menu with nothing chosen.
#[cfg(feature = "dev")]
pub(crate) fn close_open_menu(surface: &Surface) -> Result<(), String> {
    let (_, menu) = surface
        .chrome
        .open_popup
        .borrow()
        .clone()
        .ok_or("no context menu is open")?;
    menu.popdown();
    Ok(())
}

fn popup(surface: &Rc<Surface>, items: &[MenuItem], at: Option<(f32, f32)>) {
    let Some(window) = window(surface) else {
        return;
    };
    let group = gio::SimpleActionGroup::new();
    let mut builder = Builder {
        surface: Rc::downgrade(surface),
        group: &group,
        prefix: "nshpopup",
        next: 0,
        shortcuts: Vec::new(),
    };
    let model = builder.menu(items);
    window.insert_action_group("nshpopup", Some(&group));
    let (x, y) = at
        .or_else(|| crate::input::last_pointer(surface))
        .unwrap_or_default();
    let menu = gtk::PopoverMenu::from_model_full(&model, gtk::PopoverMenuFlags::NESTED);
    #[cfg(feature = "dev")]
    {
        *surface.chrome.open_popup.borrow_mut() = Some((items.into(), menu.clone()));
    }
    menu.set_parent(&surface.root);
    menu.set_has_arrow(false);
    menu.set_halign(gtk::Align::Start);
    menu.set_position(gtk::PositionType::Bottom);
    menu.set_pointing_to(Some(&gdk::Rectangle::new(x as i32, y as i32, 1, 1)));
    // Unparented once closed, after the chosen item's action ran; then the
    // app's `Menu.popup` promise settles.
    let weak = Rc::downgrade(surface);
    menu.connect_closed(move |menu| {
        let menu = menu.clone();
        let weak = weak.clone();
        glib::idle_add_local_once(move || {
            menu.unparent();
            if let Some(surface) = weak.upgrade() {
                #[cfg(feature = "dev")]
                surface.chrome.open_popup.borrow_mut().take();
                surface.event(
                    ROOT_ID,
                    EventKind::Menu,
                    EventPayload::Map(vec![
                        ("id", PayloadValue::Number(0.0)),
                        ("closed", PayloadValue::Bool(true)),
                    ]),
                );
            }
        });
    });
    menu.popup();
}

/// An item was chosen: the platform carries out its role, the app hears
/// about the rest.
fn choose(surface: &Rc<Surface>, id: u32, role: Option<MenuRole>) {
    match role {
        Some(MenuRole::Quit | MenuRole::Close) => close(surface),
        Some(MenuRole::Minimize) => {
            if let Some(window) = window(surface) {
                window.minimize();
            }
        }
        Some(MenuRole::Zoom) => toggle_maximize(surface),
        Some(MenuRole::ToggleFullScreen) => toggle_fullscreen(surface),
        Some(role) if role.edits_text() => {
            let name = match role {
                MenuRole::Undo => "text.undo",
                MenuRole::Redo => "text.redo",
                MenuRole::Cut => "clipboard.cut",
                MenuRole::Copy => "clipboard.copy",
                MenuRole::Paste => "clipboard.paste",
                _ => "selection.select-all",
            };
            // Once the menu closed and gave the focus back to the field.
            let weak = Rc::downgrade(surface);
            glib::idle_add_local_once(move || {
                let focus = weak
                    .upgrade()
                    .and_then(|s| window(&s))
                    .and_then(|w| GtkWindowExt::focus(&w));
                if let Some(focus) = focus {
                    let _ = focus.activate_action(name, None);
                }
            });
        }
        _ => {}
    }
    if id != 0 {
        surface.event(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![("id", PayloadValue::Number(id as f64))]),
        );
    }
}

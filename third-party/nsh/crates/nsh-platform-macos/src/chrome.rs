//! The window's chrome (`nsh/desktop`): its title, the hidden title bar,
//! drag regions, the application menu and context menus.
//!
//! - **Hidden title bar** ([`TitleBarStyle::Hidden`]): the window gets a
//!   full-size content view under a transparent, untitled title bar, so the
//!   app draws up to the window's top edge while the traffic lights stay.
//!   The environment's `title_bar` reports the bar's height (the window's
//!   frame above its content layout rectangle) and the traffic lights'
//!   width; it is zero in full screen, where AppKit shows the bar over the
//!   app only when the pointer reaches the top of the screen.
//! - **Drag regions**: a left press on a view marked `windowDrag`
//!   ([`crate::input::window_drag`]) moves the window with
//!   `performWindowDragWithEvent:` (AppKit's own drag, with snapping and
//!   Mission Control), and a double click does what the user chose in
//!   System Settings (`AppleActionOnDoubleClick`: zoom, minimize or
//!   nothing). The press never reaches the app. This works with the
//!   system's title bar too.
//! - **Menus** are `NSMenu`s: the application menu is the app's main menu
//!   (its first submenu is the app menu, which AppKit titles with the app's
//!   name), context menus pop up in the root view. Items with a role use
//!   AppKit's standard actions with no target, so the responder chain
//!   carries them out (the focused field's `copy:`, the application's
//!   `terminate:`); an item with a role is never reported to the app.
//!   Other items target an [`MenuTarget`] of the surface, which reports
//!   their id as [`EventKind::Menu`]. AppKit enables the items as it
//!   validates the menu, as it does its own: a role is enabled when the
//!   responder chain can carry it out (`Undo` with something to undo,
//!   `Paste` in a field), and gets AppKit's title for the state (`Exit
//!   Full Screen`). A disabled item's action is one nothing answers. The
//!   main menu the app replaced is kept and comes back with
//!   `setApplicationMenu(null)`.
//! - Context menus track the mouse in a loop of their own, so they are
//!   shown from the main queue once the batch is applied, never while it
//!   is.

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

use dispatch2::DispatchQueue;
use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    desktop::{
        DesktopCommand, Key, MenuAction, MenuItem, MenuRole, Shortcut, TitleBarStyle, WindowFrame,
        WindowLevel,
    },
    geometry::{Edges, Points},
};
use objc2::{
    DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    rc::{Retained, Weak},
    runtime::Sel,
    sel,
};
use objc2_app_kit::{
    NSApplication, NSEvent, NSEventModifierFlags, NSFloatingWindowLevel, NSMenu, NSMenuItem,
    NSNormalWindowLevel, NSRunningApplication, NSToolbar, NSWindow, NSWindowButton,
    NSWindowCollectionBehavior, NSWindowStyleMask, NSWindowTitleVisibility, NSWindowToolbarStyle,
};
use objc2_core_graphics::kCGDesktopIconWindowLevel;
use objc2_foundation::{
    NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString, NSUserDefaults, ns_string,
};

use crate::surface::Surface;

/// The title bar's height when AppKit cannot tell (macOS 11 and later).
const TITLE_BAR_HEIGHT: f32 = 28.0;
/// The traffic lights' width when AppKit cannot tell.
const TRAFFIC_LIGHTS_WIDTH: f32 = 78.0;

thread_local! {
    /// The app's name for the app menu's roles ("Quit Gallery"), set by
    /// [`crate::run_app`].
    static APP_NAME: RefCell<Option<String>> = const { RefCell::new(None) };
    /// The main menu before an app set its own: `setApplicationMenu(null)`
    /// brings it back.
    static ORIGINAL_MENU: RefCell<Option<Option<Retained<NSMenu>>>> = const { RefCell::new(None) };
}

/// Names the app for the app menu's roles.
pub(crate) fn set_app_name(name: &str) {
    APP_NAME.with(|n| *n.borrow_mut() = Some(name.to_owned()));
}

fn app_name() -> String {
    APP_NAME
        .with(|n| n.borrow().clone())
        .or_else(|| {
            NSRunningApplication::currentApplication()
                .localizedName()
                .map(|s| s.to_string())
        })
        .unwrap_or_default()
}

define_class!(
    /// The target of a surface's menu items: reports the chosen item's tag
    /// (its id) to the surface with its key.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = u64]
    #[name = "NshMenuTarget"]
    pub(crate) struct MenuTarget;

    unsafe impl NSObjectProtocol for MenuTarget {}

    impl MenuTarget {
        #[unsafe(method(menuItemChosen:))]
        fn chosen(&self, item: &NSMenuItem) {
            let Some(surface) = Surface::with_key(*self.ivars()) else {
                return;
            };
            let id = item.tag();
            if id > 0 {
                surface.event(
                    ROOT_ID,
                    EventKind::Menu,
                    EventPayload::Map(vec![("id", PayloadValue::Number(id as f64))]),
                );
            }
        }
    }
);

/// A surface's chrome.
#[derive(Default)]
pub(crate) struct Chrome {
    style: Cell<TitleBarStyle>,
    /// The app's title bar's height (`Window.setTitleBar`'s).
    height: Cell<Option<f32>>,
    /// The target of its menu items (made with the first menu).
    target: RefCell<Option<Retained<MenuTarget>>>,
    /// The main menu it set (`setApplicationMenu`).
    menu: RefCell<Option<Retained<NSMenu>>>,
    /// Only the toolbar this surface attached; dropping it restores the window.
    toolbar: RefCell<Option<TitleBarToolbar>>,
}

impl Drop for Chrome {
    fn drop(&mut self) {
        // An app view that goes (an embedding app closed it) takes its
        // menu with it, and the one it replaced comes back.
        let (Some(bar), Some(mtm)) = (self.menu.take(), MainThreadMarker::new()) else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        if app.mainMenu().is_some_and(|m| m == bar) {
            restore_menu(&app);
        }
    }
}

fn window(surface: &Surface) -> Option<Retained<NSWindow>> {
    surface.root.ns().window()
}

fn full_screen(window: &NSWindow) -> bool {
    window.styleMask().contains(NSWindowStyleMask::FullScreen)
}

/// Tells the app the hidden title bar's area (after a style change, a
/// resize, full screen).
pub(crate) fn update_area(surface: &Surface) {
    let area = match window(surface) {
        Some(window)
            if surface.chrome.style.get() == TitleBarStyle::Hidden && !full_screen(&window) =>
        {
            let frame = window.frame();
            let mask = window.styleMask() & !NSWindowStyleMask::FullSizeContentView;
            let content = NSWindow::contentRectForFrameRect_styleMask(
                frame,
                mask,
                MainThreadMarker::from(&*window),
            );
            let natural = (frame.size.height - content.size.height) as f32;
            // A toolbar's native height is determined by AppKit, not the
            // requested height that selected its style. Include a host's
            // toolbar too, so the app reserves its actual obscured area.
            let height = if window.toolbar().is_some() {
                toolbar_height(frame.size.height, window.contentLayoutRect(), natural)
            } else {
                natural
            };
            let left = window
                .standardWindowButton(NSWindowButton::ZoomButton)
                .map(|zoom| {
                    let f = zoom.frame();
                    (f.origin.x + f.size.width) as f32 + 8.0
                })
                .filter(|w| *w > 8.0)
                .unwrap_or(TRAFFIC_LIGHTS_WIDTH);
            Edges {
                top: Points(if height > 0.0 {
                    height
                } else {
                    TITLE_BAR_HEIGHT
                }),
                left: Points(left),
                right: Points(0.0),
                bottom: Points(0.0),
            }
        }
        _ => Edges::default(),
    };
    let mut env = surface.environment.get();
    if env.title_bar != area {
        env.title_bar = area;
        surface.set_environment(env);
    }
}

/// The unobscured rectangle is in window coordinates, including its origin.
fn toolbar_height(frame_height: f64, layout: NSRect, natural: f32) -> f32 {
    let height = frame_height - (layout.origin.y + layout.size.height);
    if height.is_finite() && height > 0.0 {
        height as f32
    } else {
        natural
    }
}

/// Owns an empty toolbar without retaining the embedding window.
struct TitleBarToolbar {
    window: Weak<NSWindow>,
    toolbar: Retained<NSToolbar>,
    previous_style: NSWindowToolbarStyle,
    applied_style: NSWindowToolbarStyle,
}

impl TitleBarToolbar {
    /// Whether this window still has the toolbar we installed.
    fn is_installed(&self, window: &NSWindow) -> bool {
        self.window
            .load()
            .is_some_and(|w| std::ptr::eq(&*w, window))
            && window.toolbar().is_some_and(|t| t == self.toolbar)
    }
}

impl Drop for TitleBarToolbar {
    fn drop(&mut self) {
        let Some(window) = self.window.load() else {
            return;
        };
        // A host may have replaced our toolbar or changed its style. Its
        // later changes take precedence over the state we saved.
        if self.is_installed(&window) {
            let restore_style = window.toolbarStyle() == self.applied_style;
            window.setToolbar(None);
            if restore_style {
                window.setToolbarStyle(self.previous_style);
            }
        }
    }
}

// --- Commands ---------------------------------------------------------------------------

/// A desktop command (on the root).
pub(crate) fn command(surface: &Rc<Surface>, command: &DesktopCommand) {
    match command {
        DesktopCommand::SetTitle(title) => {
            if let Some(window) = window(surface) {
                window.setTitle(&NSString::from_str(title));
            }
        }
        DesktopCommand::SetTitleBar { style, height } => {
            surface.chrome.height.set(height.map(|h| h.0));
            surface.chrome.style.set(*style);
            apply_title_bar(surface);
        }
        DesktopCommand::Minimize => {
            if let Some(window) = window(surface) {
                window.miniaturize(None);
            }
        }
        DesktopCommand::ToggleMaximize => {
            if let Some(window) = window(surface) {
                window.zoom(None);
            }
        }
        DesktopCommand::ToggleFullScreen => {
            if let Some(window) = window(surface) {
                window.toggleFullScreen(None);
            }
        }
        DesktopCommand::SetFrame(frame) => {
            if let Some(window) = window(surface) {
                set_frame(&window, frame);
            }
        }
        DesktopCommand::SetLevel(level) => {
            if let Some(window) = window(surface) {
                window.setLevel(match level {
                    WindowLevel::Normal => NSNormalWindowLevel,
                    WindowLevel::Floating => NSFloatingWindowLevel,
                    WindowLevel::DesktopIcon => kCGDesktopIconWindowLevel as isize,
                });
                // A desktop widget is a part of the desktop, not a window:
                // it sits on every space, Mission Control does not list it
                // (it could never be raised above normal windows anyway)
                // and Cmd+` cycles past it. Ordinary levels stay managed.
                window.setCollectionBehavior(match level {
                    WindowLevel::DesktopIcon => {
                        NSWindowCollectionBehavior::Stationary
                            | NSWindowCollectionBehavior::CanJoinAllSpaces
                            | NSWindowCollectionBehavior::IgnoresCycle
                    }
                    _ => NSWindowCollectionBehavior::MoveToActiveSpace,
                });
            }
        }
        DesktopCommand::OrderFront => {
            if let (Some(window), Some(mtm)) = (window(surface), MainThreadMarker::new()) {
                window.deminiaturize(None);
                // activate() first: ordering a window front in an inactive
                // app leaves it behind the front app's windows.
                NSApplication::sharedApplication(mtm).activate();
                window.makeKeyAndOrderFront(None);
            }
        }
        DesktopCommand::Close => {
            if let Some(window) = window(surface) {
                window.performClose(None);
            }
        }
        DesktopCommand::SetMenu(items) => set_menu(surface, items.as_deref()),
        // The menu bar is the system's.
        DesktopCommand::SetMenuBar(_) => {}
        DesktopCommand::PopupMenu { items, at } => {
            // The menu tracks the mouse in a loop of its own: not while the
            // batch is applied. From the run loop, not the main queue: a
            // main-queue block would hold the queue while the menu tracks,
            // and the app's batches (which come through it) would wait.
            let key = surface.key();
            let items = items.clone();
            let at = at.map(|p| (p.x.0, p.y.0));
            let block = block2::RcBlock::new(move || {
                if let Some(surface) = Surface::with_key(key) {
                    popup(&surface, &items, at);
                }
            });
            // SAFETY: the common modes' name is a constant of Foundation's.
            let modes = objc2_foundation::NSArray::from_slice(&[unsafe {
                objc2_foundation::NSRunLoopCommonModes
            }]);
            // SAFETY: the block runs on the main thread, where it was made.
            unsafe {
                objc2_foundation::NSRunLoop::mainRunLoop().performInModes_block(&modes, &block)
            };
        }
    }
}

/// Moves and sizes the window: a field left out keeps its value
/// (`setFrame`'s screen coordinates are the bottom left corner's).
fn set_frame(window: &NSWindow, frame: &WindowFrame) {
    let current = window.frame();
    let points = |v: nsh_core::Points| f64::from(v.0);
    let size = NSSize::new(
        frame.width.map_or(current.size.width, points),
        frame.height.map_or(current.size.height, points),
    );
    // `anchorTop` keeps the top edge where it is: the bottom left origin
    // would otherwise pin the bottom edge, and a content-height window
    // resized around its middle.
    let y = frame.y.map_or_else(
        || {
            if frame.anchor_top == Some(true) {
                current.origin.y + current.size.height - size.height
            } else {
                current.origin.y
            }
        },
        points,
    );
    let point = NSPoint::new(frame.x.map_or(current.origin.x, points), y);
    window.setFrame_display_animate(
        NSRect::new(point, size),
        true,
        frame.animated.unwrap_or(false),
    );
}

/// The window's style for the title bar's.
pub(crate) fn apply_title_bar(surface: &Surface) {
    let Some(window) = window(surface) else {
        return;
    };
    let hidden = surface.chrome.style.get() == TitleBarStyle::Hidden;
    let mut mask = window.styleMask();
    if hidden {
        mask |= NSWindowStyleMask::FullSizeContentView;
    } else {
        mask &= !NSWindowStyleMask::FullSizeContentView;
    }
    window.setStyleMask(mask);
    apply_toolbar(surface, &window, hidden);
    window.setTitlebarAppearsTransparent(hidden);
    window.setTitleVisibility(if hidden {
        NSWindowTitleVisibility::Hidden
    } else {
        NSWindowTitleVisibility::Visible
    });
    update_area(surface);
    // AppKit can restore the old content size after setStyleMask returns.
    // Reconcile it after that pass, using the current window and style so
    // another title bar change in the same batch takes precedence.
    let key = surface.key();
    DispatchQueue::main().exec_async(move || {
        if let Some(surface) = Surface::with_key(key)
            && let Some(window) = surface.root.ns().window()
            && let Some(content) = window.contentView()
        {
            let size = window.contentRectForFrameRect(window.frame()).size;
            if content.frame().size != size {
                content.setFrameSize(size);
            }
            // Toolbar layout can settle after setToolbar/setStyleMask
            // returns, even when the full-size content frame stays the same.
            update_area(&surface);
        }
    });
}

/// Lets AppKit lay out traffic lights on every live-resize frame. The
/// height selects a native style; `update_area` reports the measured height.
fn apply_toolbar(surface: &Surface, window: &NSWindow, hidden: bool) {
    let height = surface.chrome.height.get().filter(|_| hidden);
    let mut owned = surface.chrome.toolbar.borrow_mut().take();
    if height.is_none() || owned.as_ref().is_some_and(|t| !t.is_installed(window)) {
        // Also restores the old window when this surface moves to another.
        owned = None;
    }
    let Some(height) = height else { return };
    let style = if height <= 44.0 {
        NSWindowToolbarStyle::UnifiedCompact
    } else {
        NSWindowToolbarStyle::Unified
    };
    match &mut owned {
        Some(toolbar) => {
            toolbar.applied_style = style;
            if window.toolbarStyle() != style {
                window.setToolbarStyle(style);
            }
        }
        None if window.toolbar().is_none() => {
            let toolbar = NSToolbar::initWithIdentifier(
                NSToolbar::alloc(MainThreadMarker::from(window)),
                ns_string!("nsh.title-bar"),
            );
            let previous_style = window.toolbarStyle();
            window.setToolbar(Some(&toolbar));
            window.setToolbarStyle(style);
            owned = Some(TitleBarToolbar {
                window: Weak::from(window),
                toolbar,
                previous_style,
                applied_style: style,
            });
        }
        // The embedding app owns this toolbar, including its style.
        None => {}
    }
    *surface.chrome.toolbar.borrow_mut() = owned;
}

// --- Drag regions -----------------------------------------------------------------------

/// A left press at `(x, y)` (root coordinates): on a view marked
/// `windowDrag`, it moves (or, double-clicked, zooms) the window; true
/// when it did, and the press is not the app's.
pub(crate) fn mouse_down(surface: &Surface, event: &NSEvent, x: f32, y: f32) -> bool {
    if !crate::input::window_drag(surface, x, y) {
        return false;
    }
    let Some(window) = window(surface) else {
        return false;
    };
    if event.clickCount() == 2 {
        let action = NSUserDefaults::standardUserDefaults()
            .stringForKey(ns_string!("AppleActionOnDoubleClick"))
            .map(|s| s.to_string());
        match action.as_deref() {
            Some("Minimize") => window.miniaturize(None),
            Some("None") => {}
            _ => window.zoom(None),
        }
    } else {
        window.performWindowDragWithEvent(event);
    }
    true
}

// --- Menus ------------------------------------------------------------------------------

/// The target of `surface`'s menu items.
fn target(surface: &Surface) -> Retained<MenuTarget> {
    let mut target = surface.chrome.target.borrow_mut();
    target
        .get_or_insert_with(|| {
            let t = MenuTarget::alloc(surface.mtm).set_ivars(surface.key());
            // SAFETY: NSObject's initializer.
            unsafe { msg_send![super(t), init] }
        })
        .clone()
}

/// The action of disabled items: nothing answers it, so AppKit disables
/// them as it validates the menu.
fn disabled() -> Sel {
    sel!(nshMenuItemDisabled:)
}

/// The standard action of a role (sent down the responder chain).
fn role_action(role: MenuRole) -> Sel {
    match role {
        MenuRole::About => sel!(orderFrontStandardAboutPanel:),
        MenuRole::Hide => sel!(hide:),
        MenuRole::HideOthers => sel!(hideOtherApplications:),
        MenuRole::ShowAll => sel!(unhideAllApplications:),
        MenuRole::Quit => sel!(terminate:),
        MenuRole::Undo => sel!(undo:),
        MenuRole::Redo => sel!(redo:),
        MenuRole::Cut => sel!(cut:),
        MenuRole::Copy => sel!(copy:),
        MenuRole::Paste => sel!(paste:),
        MenuRole::SelectAll => sel!(selectAll:),
        MenuRole::Minimize => sel!(performMiniaturize:),
        MenuRole::Zoom => sel!(performZoom:),
        MenuRole::ToggleFullScreen => sel!(toggleFullScreen:),
        MenuRole::Close => sel!(performClose:),
    }
}

/// An item's title: its label, else its role's (with the app's name where
/// macOS writes it).
fn title(action: &MenuAction) -> String {
    if !action.label.is_empty() {
        return action.label.clone();
    }
    match action.role {
        Some(role @ (MenuRole::About | MenuRole::Hide | MenuRole::Quit)) => {
            format!("{} {}", role.label(), app_name())
        }
        Some(MenuRole::ToggleFullScreen) => "Enter Full Screen".to_owned(),
        Some(role) => role.label().to_owned(),
        None => String::new(),
    }
}

/// A shortcut as a key equivalent and its modifiers.
fn key_equivalent(shortcut: &Shortcut) -> (String, NSEventModifierFlags) {
    let function = |code: u32| char::from_u32(code).map(String::from).unwrap_or_default();
    let key = match shortcut.key {
        Key::Char(c) => c.to_string(),
        Key::Enter => "\r".to_owned(),
        Key::Escape => "\u{1b}".to_owned(),
        Key::Tab => "\t".to_owned(),
        Key::Backspace => "\u{8}".to_owned(),
        Key::Space => " ".to_owned(),
        // AppKit's function key characters (NSUpArrowFunctionKey, ...).
        Key::Up => function(0xF700),
        Key::Down => function(0xF701),
        Key::Left => function(0xF702),
        Key::Right => function(0xF703),
        Key::F(n) => function(0xF704 + u32::from(n) - 1),
        Key::Insert => function(0xF727),
        Key::Delete => function(0xF728),
        Key::Home => function(0xF729),
        Key::End => function(0xF72B),
        Key::PageUp => function(0xF72C),
        Key::PageDown => function(0xF72D),
    };
    let mut mask = NSEventModifierFlags::empty();
    for (on, flag) in [
        (shortcut.meta, NSEventModifierFlags::Command),
        (shortcut.ctrl, NSEventModifierFlags::Control),
        (shortcut.alt, NSEventModifierFlags::Option),
        (shortcut.shift, NSEventModifierFlags::Shift),
    ] {
        if on {
            mask |= flag;
        }
    }
    (key, mask)
}

/// A menu of `items`, titled `title`.
fn menu(surface: &Surface, title: &str, items: &[MenuItem]) -> Retained<NSMenu> {
    let mtm = surface.mtm;
    let menu = NSMenu::initWithTitle(NSMenu::alloc(mtm), &NSString::from_str(title));
    let mut last_separator = true;
    for item in items {
        match item {
            MenuItem::Separator => {
                if !last_separator {
                    menu.addItem(&NSMenuItem::separatorItem(mtm));
                    last_separator = true;
                }
            }
            MenuItem::Action(action) => {
                let (key, mask) = action
                    .shortcut
                    .as_ref()
                    .map(key_equivalent)
                    .unwrap_or_else(|| (String::new(), NSEventModifierFlags::empty()));
                let selector = match action.role {
                    _ if !action.enabled => Some(disabled()),
                    Some(role) => Some(role_action(role)),
                    None if action.id != 0 => Some(sel!(menuItemChosen:)),
                    None => None,
                };
                // SAFETY: the actions are AppKit's standard ones (sent down
                // the responder chain) or the target's own.
                let ns = unsafe {
                    NSMenuItem::initWithTitle_action_keyEquivalent(
                        NSMenuItem::alloc(mtm),
                        &NSString::from_str(&self::title(action)),
                        selector,
                        &NSString::from_str(&key),
                    )
                };
                if action.shortcut.is_some() {
                    ns.setKeyEquivalentModifierMask(mask);
                }
                if selector == Some(sel!(menuItemChosen:)) {
                    let target = target(surface);
                    // SAFETY: the target answers `menuItemChosen:`; the
                    // surface keeps it while its menus exist (menu items do
                    // not retain their targets).
                    unsafe { ns.setTarget(Some(&target)) };
                    ns.setTag(action.id as isize);
                }
                if let Some(checked) = action.checked {
                    ns.setState(if checked { 1 } else { 0 });
                }
                menu.addItem(&ns);
                last_separator = false;
            }
            MenuItem::Submenu {
                label,
                enabled,
                items,
            } => {
                let ns = holder(surface, label, *enabled, items);
                menu.addItem(&ns);
                last_separator = false;
            }
        }
    }
    menu
}

/// An item holding a submenu of `items`.
fn holder(
    surface: &Surface,
    label: &str,
    enabled: bool,
    items: &[MenuItem],
) -> Retained<NSMenuItem> {
    let sub = menu(surface, label, items);
    // SAFETY: an item with no action (or one nothing answers, which
    // disables it), holding the submenu.
    let ns = unsafe {
        NSMenuItem::initWithTitle_action_keyEquivalent(
            NSMenuItem::alloc(surface.mtm),
            &NSString::from_str(label),
            (!enabled).then(disabled),
            ns_string!(""),
        )
    };
    ns.setSubmenu(Some(&sub));
    ns
}

/// The application menu: the main menu, with a menu of the bar per
/// top-level submenu (its top-level actions go to the first one).
fn set_menu(surface: &Surface, items: Option<&[MenuItem]>) {
    let mtm = surface.mtm;
    let app = NSApplication::sharedApplication(mtm);
    ORIGINAL_MENU.with(|o| {
        let mut o = o.borrow_mut();
        if o.is_none() {
            *o = Some(app.mainMenu());
        }
    });
    let Some(items) = items else {
        surface.chrome.menu.borrow_mut().take();
        restore_menu(&app);
        return;
    };
    let bar = NSMenu::new(mtm);
    for item in items {
        // A top-level item that is not a submenu gets one of its own.
        let (label, enabled, sub_items) = match item {
            MenuItem::Submenu {
                label,
                enabled,
                items,
            } => (label.clone(), *enabled, items.clone()),
            MenuItem::Action(action) => (title(action), true, vec![item.clone()]),
            MenuItem::Separator => continue,
        };
        bar.addItem(&holder(surface, &label, enabled, &sub_items));
    }
    app.setMainMenu(Some(&bar));
    *surface.chrome.menu.borrow_mut() = Some(bar);
}

/// Brings back the main menu the app replaced.
fn restore_menu(app: &NSApplication) {
    let original = ORIGINAL_MENU
        .try_with(|o| o.borrow_mut().take())
        .ok()
        .flatten();
    if let Some(original) = original {
        app.setMainMenu(original.as_deref());
    }
}

#[cfg(feature = "dev")]
thread_local! {
    /// The context menu tracking now, for the test agent to choose from
    /// ([`choose_open_menu`]).
    static OPEN_MENU: std::cell::RefCell<Option<Retained<NSMenu>>> =
        const { std::cell::RefCell::new(None) };
}

/// Chooses the item of the open context menu at the end of `path` (the
/// labels of the submenus on the way, then its own), as a click on it
/// does, and closes the menu (`nsh test --target macos`).
#[cfg(feature = "dev")]
pub(crate) fn choose_open_menu(path: &[String]) -> Result<(), String> {
    let root = OPEN_MENU
        .with(|open| open.borrow().clone())
        .ok_or("no context menu is open")?;
    let mut menu = root.clone();
    for (n, label) in path.iter().enumerate() {
        let index = menu.indexOfItemWithTitle(&NSString::from_str(label));
        if index < 0 {
            return Err(format!("the menu has no item {label:?}"));
        }
        if n + 1 == path.len() {
            menu.performActionForItemAtIndex(index);
        } else {
            menu = menu
                .itemAtIndex(index)
                .and_then(|item| item.submenu())
                .ok_or_else(|| format!("{label:?} opens no submenu"))?;
        }
    }
    root.cancelTracking();
    Ok(())
}

/// Closes the open context menu with nothing chosen.
#[cfg(feature = "dev")]
pub(crate) fn close_open_menu() -> Result<(), String> {
    let root = OPEN_MENU
        .with(|open| open.borrow().clone())
        .ok_or("no context menu is open")?;
    root.cancelTracking();
    Ok(())
}

/// Shows a context menu at `at` (root coordinates) or at the mouse.
fn popup(surface: &Rc<Surface>, items: &Arc<[MenuItem]>, at: Option<(f32, f32)>) {
    let root = surface.root.ns();
    let menu = menu(surface, "", items);
    // The root view is flipped: y goes down, as the app's. Without a
    // place, where the root's pointer events put the mouse: the hardware
    // cursor's place only when they put it nowhere, as synthesized input
    // (the test agent's) leaves the cursor where it is, on another display
    // when the window is on a secondary one.
    let location = match at.or_else(|| crate::input::pointer_location(surface)) {
        Some((x, y)) => NSPoint::new(x as f64, y as f64),
        None => {
            let Some(window) = root.window() else { return };
            let in_window = window.convertPointFromScreen(NSEvent::mouseLocation());
            root.convertPoint_fromView(in_window, None)
        }
    };
    #[cfg(feature = "dev")]
    OPEN_MENU.with(|open| *open.borrow_mut() = Some(menu.clone()));
    // Returns once the menu closed (the chosen item's action sent).
    menu.popUpMenuPositioningItem_atLocation_inView(None, location, Some(root));
    #[cfg(feature = "dev")]
    OPEN_MENU.with(|open| open.borrow_mut().take());
    // A menu opened during a press (`onPressDown`, a long press) took its
    // release: the press ends here, or the view would stay pressed.
    crate::input::cancel_pointer(surface);
    // The app's `Menu.popup` promise settles.
    surface.event(
        ROOT_ID,
        EventKind::Menu,
        EventPayload::Map(vec![
            ("id", PayloadValue::Number(0.0)),
            ("closed", PayloadValue::Bool(true)),
        ]),
    );
}

/// The root view moved to a window, or the window changed: a hidden title
/// bar applies to it (a window keeps its own style otherwise).
pub(crate) fn window_changed(surface: &Surface) {
    if window(surface).is_none() {
        let toolbar = surface.chrome.toolbar.borrow_mut().take();
        drop(toolbar);
        update_area(surface);
        return;
    }
    if surface.chrome.style.get() == TitleBarStyle::Hidden {
        apply_title_bar(surface);
    } else {
        update_area(surface);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toolbar_area_uses_native_geometry_including_its_origin() {
        let rect = |y, height| NSRect::new(NSPoint::new(0.0, y), NSSize::new(1200.0, height));
        assert_eq!(toolbar_height(800.0, rect(0.0, 762.0), 22.0), 38.0);
        assert_eq!(toolbar_height(800.0, rect(12.0, 750.0), 22.0), 38.0);
        // An embedding host's expanded toolbar occupies its full native area.
        assert_eq!(toolbar_height(800.0, rect(0.0, 730.0), 22.0), 70.0);
    }

    #[test]
    fn incomplete_toolbar_geometry_falls_back_to_the_native_title_bar() {
        for height in [800.0, 820.0, f64::NAN] {
            let layout = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(1200.0, height));
            assert_eq!(toolbar_height(800.0, layout, 22.0), 22.0);
        }
    }

    #[test]
    fn shortcuts_are_key_equivalents() {
        let equivalent = |text: &str| key_equivalent(&Shortcut::parse(text, true).unwrap());
        // Lowercase: an uppercase key equivalent would add Shift.
        assert_eq!(
            equivalent("mod+shift+n"),
            (
                "n".to_owned(),
                NSEventModifierFlags::Command | NSEventModifierFlags::Shift
            )
        );
        assert_eq!(
            equivalent("ctrl+alt+left"),
            (
                "\u{f702}".to_owned(),
                NSEventModifierFlags::Control | NSEventModifierFlags::Option
            )
        );
        assert_eq!(
            equivalent("f5"),
            ("\u{f708}".to_owned(), NSEventModifierFlags::empty())
        );
        assert_eq!(equivalent("mod+plus").0, "=");
        assert_eq!(equivalent("cmd+pagedown").0, "\u{f72d}");
    }
}

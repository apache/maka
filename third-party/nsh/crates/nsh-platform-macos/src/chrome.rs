//! The window's chrome (`nsh/desktop`): its title, the hidden title bar,
//! drag regions, the application menu and context menus.
//!
//! - **Hidden title bar** ([`TitleBarStyle::Hidden`]): the window gets a
//!   full-size content view under a transparent, untitled title bar, so the
//!   app draws up to the window's top edge while the traffic lights stay.
//!   The environment's `title_bar` reports the bar's height (the window's
//!   frame above its content layout rectangle) and the traffic lights'
//!   width; it is zero in full screen, where AppKit shows the bar over the
//!   app only when the pointer reaches the top of the screen. With the
//!   app's own bar height ([`TrafficLights`]) NSH centers the traffic lights
//!   in it itself and reports that height. It attaches no toolbar for it:
//!   from macOS 26 a window with a toolbar gets larger corners than one
//!   with only a title bar.
//! - **Drag regions**: a left press on a view marked `windowDrag`
//!   ([`crate::input::window_drag`]) moves the window with
//!   `performWindowDragWithEvent:` (AppKit's own drag, with snapping and
//!   Mission Control), and a double click does what the user chose in
//!   System Settings (`AppleActionOnDoubleClick`: zoom, minimize or
//!   nothing). A single click without dragging reaches the app on release,
//!   so overlays can close. This works with the system's title bar too.
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
    ptr::NonNull,
    rc::Rc,
    sync::Arc,
};

use block2::RcBlock;
use dispatch2::DispatchQueue;
use nsh_core::{
    EventKind, EventPayload, ImageSource, NodeId, PayloadValue, ROOT_ID,
    desktop::{
        DesktopCommand, Key, MenuAction, MenuItem, MenuRole, Shortcut, TitleBarOptions,
        TitleBarStyle, WindowFrame, menu_icon,
    },
    geometry::{DevicePixels, Edges, Points, size},
};
use objc2::{
    AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class,
    msg_send,
    rc::{Retained, Weak},
    runtime::{ProtocolObject, Sel},
    sel,
};
use objc2_app_kit::{
    NSApplication, NSButton, NSEvent, NSEventModifierFlags, NSImage, NSMenu, NSMenuItem,
    NSRunningApplication, NSScreen, NSView, NSViewFrameDidChangeNotification, NSWindow,
    NSWindowButton, NSWindowStyleMask, NSWindowTitleVisibility,
};
use objc2_core_graphics::CGImage;
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize,
    NSString, NSUserDefaults, ns_string,
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

pub(crate) fn app_name() -> String {
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
    /// The target of its menu items (made with the first menu).
    target: RefCell<Option<Retained<MenuTarget>>>,
    /// The main menu it set (`setApplicationMenu`).
    menu: RefCell<Option<Retained<NSMenu>>>,
    /// The loads of the icons of that menu, given up with it.
    menu_icons: RefCell<Vec<crate::image::Load>>,
}

/// A window's title bar as the app set it (`titleBar`).
#[derive(Default)]
pub(crate) struct TitleBar {
    pub(crate) style: Cell<TitleBarStyle>,
    /// The app's title bar's height.
    height: Cell<Option<f32>>,
    /// Where the app put the window's buttons: the close button's top left
    /// corner from the window's.
    controls_offset: Cell<Option<(f32, f32)>>,
    /// The traffic lights placed in the app's bar; dropping it gives them
    /// back to AppKit.
    traffic_lights: RefCell<Option<TrafficLights>>,
    /// Set while [`place_controls`] runs: the frames it sets post the
    /// notifications that call it.
    placing: Cell<bool>,
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

pub(crate) fn full_screen(window: &NSWindow) -> bool {
    window.styleMask().contains(NSWindowStyleMask::FullScreen)
}

/// Tells the app the main window's hidden title bar's area (after a style
/// change, a resize, full screen).
pub(crate) fn update_area(surface: &Surface) {
    let bar = &surface.main_window.title_bar;
    let area = match window(surface) {
        Some(window) => {
            // The buttons are placed first: whether NSH holds them decides
            // the height.
            place_controls(surface, ROOT_ID, bar, &window);
            title_bar_area(bar, &window)
        }
        None => Edges::default(),
    };
    let mut env = surface.environment.get();
    if env.title_bar != area {
        env.title_bar = area;
        surface.set_environment(env);
    }
}

/// The area of `window`'s hidden title bar `bar` over its content: its
/// height and the window's buttons' width; nothing for the system's title
/// bar, and in full screen, where AppKit shows the bar over the app only
/// when the pointer reaches the top of the screen.
pub(crate) fn title_bar_area(bar: &TitleBar, window: &NSWindow) -> Edges<Points> {
    if bar.style.get() != TitleBarStyle::Hidden || full_screen(window) {
        return Edges::default();
    }
    let frame = window.frame();
    let mask = window.styleMask() & !NSWindowStyleMask::FullSizeContentView;
    let content =
        NSWindow::contentRectForFrameRect_styleMask(frame, mask, MainThreadMarker::from(window));
    let natural = (frame.size.height - content.size.height) as f32;
    // A host's toolbar has the height AppKit gives it, and the app
    // reserves that obscured area. The title bar view that holds the
    // window's buttons and the toolbar has that height whatever the
    // window's: the content layout rectangle is only laid out for the
    // new frame later, so read during a resize it gives the old one's.
    let height = if window.toolbar().is_some() {
        title_bar_view_height(window).unwrap_or_else(|| {
            toolbar_height(frame.size.height, window.contentLayoutRect(), natural)
        })
    } else if bar.traffic_lights.borrow().is_some() {
        // The app's bar, the traffic lights centered in it.
        bar.height.get().unwrap_or(natural)
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
    let mut top = if height > 0.0 {
        height
    } else {
        TITLE_BAR_HEIGHT
    };
    // Buttons the app moved down take as much room under them as above.
    if let Some((_, y)) = bar.controls_offset.get()
        && let Some(close) = window.standardWindowButton(NSWindowButton::CloseButton)
    {
        top = top.max(2.0 * y + close.frame().size.height as f32);
    }
    Edges {
        top: Points(top),
        left: Points(left),
        right: Points(0.0),
        bottom: Points(0.0),
    }
}

/// The height of the title bar view around the window's buttons (with a
/// toolbar, the toolbar's row too), when the window has one.
fn title_bar_view_height(window: &NSWindow) -> Option<f32> {
    let button = window.standardWindowButton(NSWindowButton::CloseButton)?;
    let height = crate::view::superview(&button)?.frame().size.height;
    (height.is_finite() && height > 0.0).then_some(height as f32)
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

/// The traffic lights centered in the app's bar (`titleBar`'s `height`):
/// the title bar's container (`NSTitlebarContainerView`, the close
/// button's superview's superview) as tall as the bar, and the three
/// buttons moved down to its middle, their `x` kept. AppKit lays them out
/// again when the window resizes (every frame of a live resize), changes
/// screen or leaves full screen: the frame-change notifications of the
/// buttons and the container place them again at once, in the same layout
/// pass, before anything is drawn. Nothing is placed in full screen, where
/// AppKit shows the bar in a window of its own, nor with a toolbar: a
/// host's lays the buttons out itself. Dropping it gives the container and
/// the buttons back their frames.
struct TrafficLights {
    window: Weak<NSWindow>,
    container: Retained<NSView>,
    /// The container's height before (the system title bar's).
    container_height: f64,
    /// The buttons and their `y` before.
    buttons: Vec<(Retained<NSButton>, f64)>,
    /// Frame-change observers (tokens of the default center).
    observers: Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>,
}

impl TrafficLights {
    /// Places the buttons of window `id` of `surface`.
    fn new(surface: &Surface, id: NodeId, window: &NSWindow) -> Option<Self> {
        let close = window.standardWindowButton(NSWindowButton::CloseButton)?;
        let bar = crate::view::superview(&close)?;
        let container = crate::view::superview(&bar)?;
        let buttons: Vec<_> = [
            NSWindowButton::CloseButton,
            NSWindowButton::MiniaturizeButton,
            NSWindowButton::ZoomButton,
        ]
        .into_iter()
        .filter_map(|kind| window.standardWindowButton(kind))
        .map(|button| {
            let y = button.frame().origin.y;
            (button, y)
        })
        .collect();
        let key = surface.key();
        let block = RcBlock::new(move |_: NonNull<NSNotification>| {
            if let Some(surface) = Surface::with_key(key)
                && let Some(window) = crate::window::window_of(&surface, id)
            {
                crate::window::with_title_bar(&surface, id, |bar| {
                    place_controls(&surface, id, bar, &window)
                });
            }
        });
        let center = NSNotificationCenter::defaultCenter();
        let views = std::iter::once(&*container)
            .chain(buttons.iter().map(|(button, _)| -> &NSView { button }));
        let observers = views
            .map(|view| {
                view.setPostsFrameChangedNotifications(true);
                // SAFETY: AppKit posts it on the main thread, where the
                // block runs (no queue: at once, inside the layout that
                // moved the view); the observer is removed on drop.
                unsafe {
                    center.addObserverForName_object_queue_usingBlock(
                        Some(NSViewFrameDidChangeNotification),
                        Some(view),
                        None,
                        &block,
                    )
                }
            })
            .collect();
        Some(Self {
            window: Weak::from(window),
            container_height: container.frame().size.height,
            container,
            buttons,
            observers,
        })
    }

    fn is_for(&self, window: &NSWindow) -> bool {
        self.window
            .load()
            .is_some_and(|w| std::ptr::eq(&*w, window))
    }

    /// Makes the container `height` tall (at least the system's bar) at
    /// the window's top and, with `center`, centers the buttons in the
    /// bar's `height`.
    fn place(&self, window: &NSWindow, height: f64, center: bool) {
        let tall = height.max(self.container_height);
        set_top(&self.container, window, tall);
        if !center {
            return;
        }
        for (button, _) in &self.buttons {
            let Some(bar) = crate::view::superview(button) else {
                continue;
            };
            let own = button.frame().size.height;
            // The bar's `height` is the top of the container.
            let from_top = ((height - own) / 2.0).round();
            let y = if bar.isFlipped() {
                from_top
            } else {
                bar.frame().size.height - from_top - own
            };
            let mut origin = button.frame().origin;
            if origin.y != y {
                origin.y = y;
                button.setFrameOrigin(origin);
            }
        }
    }
}

/// Moves `view` to the top of its superview (the window's theme frame)
/// with `height`, if it is not there.
fn set_top(view: &NSView, window: &NSWindow, height: f64) {
    let mut frame = view.frame();
    let top =
        crate::view::superview(view).map_or(window.frame().size.height, |s| s.frame().size.height);
    let y = if crate::view::superview(view).is_some_and(|s| s.isFlipped()) {
        0.0
    } else {
        top - height
    };
    if frame.size.height != height || frame.origin.y != y {
        frame.size.height = height;
        frame.origin.y = y;
        view.setFrame(frame);
    }
}

impl Drop for TrafficLights {
    fn drop(&mut self) {
        let center = NSNotificationCenter::defaultCenter();
        for observer in self.observers.drain(..) {
            // SAFETY: an observer token of the default center.
            unsafe { center.removeObserver(observer.as_ref()) };
        }
        // In full screen the bar is in AppKit's window of its own, which
        // lays it out again when the window leaves full screen.
        let Some(window) = self.window.load() else {
            return;
        };
        if full_screen(&window) {
            return;
        }
        set_top(&self.container, &window, self.container_height);
        for (button, y) in &self.buttons {
            let mut origin = button.frame().origin;
            origin.y = *y;
            button.setFrameOrigin(origin);
        }
        self.container.setNeedsLayout(true);
    }
}

/// Centers the traffic lights of window `id` in its app's bar, or gives
/// them back to AppKit when there is none ([`TrafficLights`]); buttons the
/// app put somewhere (`controlsOffset`) are only given the bar's height.
fn place_traffic_lights(surface: &Surface, id: NodeId, bar: &TitleBar, window: &NSWindow) {
    let height = bar
        .height
        .get()
        .filter(|_| bar.style.get() == TitleBarStyle::Hidden)
        .filter(|_| !full_screen(window) && window.toolbar().is_none());
    let mut placed = bar.traffic_lights.borrow_mut();
    let Some(height) = height else {
        *placed = None;
        return;
    };
    if placed.as_ref().is_some_and(|p| !p.is_for(window)) {
        // Also gives the old window its buttons back when the surface
        // moves to another.
        *placed = None;
    }
    if placed.is_none() {
        *placed = TrafficLights::new(surface, id, window);
    }
    if let Some(placed) = placed.as_ref() {
        placed.place(
            window,
            f64::from(height),
            bar.controls_offset.get().is_none(),
        );
    }
}

// --- Commands ---------------------------------------------------------------------------

/// A desktop command on the root: the app's menus, tray and shortcuts, and
/// the main window's attributes and requests.
pub(crate) fn command(surface: &Rc<Surface>, command: &DesktopCommand) {
    match command {
        // The main window's: its attributes and requests.
        DesktopCommand::OpenWindow(_)
        | DesktopCommand::SetAttributes(_)
        | DesktopCommand::Request(_) => crate::window::command(surface, ROOT_ID, None, command),
        // As the Quit item: the standalone runner stops and returns, also
        // with its window kept hidden; an embedding app keeps its own
        // lifecycle.
        DesktopCommand::Quit => crate::app::quit_app(),
        // Quits as above, then the runner starts the app again.
        DesktopCommand::Restart => crate::app::restart_app(),
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
        DesktopCommand::SetTray(tray) => crate::tray::set(surface, tray.as_ref()),
        DesktopCommand::RegisterGlobalShortcut { id, shortcut } => {
            crate::global_shortcut::register(surface, *id, shortcut)
        }
        DesktopCommand::UnregisterGlobalShortcut(id) => {
            crate::global_shortcut::unregister(surface, *id)
        }
    }
}

/// Moves and sizes the window: a field left out keeps its value.
pub(crate) fn set_frame(window: &NSWindow, frame: &WindowFrame) {
    let primary_height = NSScreen::screens(MainThreadMarker::from(window))
        .firstObject()
        .map_or(0.0, |s| s.frame().size.height);
    window.setFrame_display_animate(
        appkit_frame(window.frame(), frame, primary_height),
        true,
        frame.animated.unwrap_or(false),
    );
}

/// The AppKit frame of `frame`'s fields merged with the window's `current`
/// one. NSH's origin is the top left corner, measured down from the primary
/// screen's top; Cocoa's screen coordinates go up from the primary
/// screen's bottom (`NSScreen.screens[0]`, `primary_height` tall, on every
/// display arrangement), its origin the bottom left corner. A height
/// changed without a `y` keeps the top edge where it is.
fn appkit_frame(current: NSRect, frame: &WindowFrame, primary_height: f64) -> NSRect {
    let points = |v: Points| f64::from(v.0);
    let size = NSSize::new(
        frame.width.map_or(current.size.width, points),
        frame.height.map_or(current.size.height, points),
    );
    let top = frame.y.map_or(current.origin.y + current.size.height, |y| {
        flip_y(points(y), primary_height)
    });
    let x = frame.x.map_or(current.origin.x, points);
    NSRect::new(NSPoint::new(x, top - size.height), size)
}

/// A screen `y` between NSH's coordinates (down from the primary screen's
/// top) and Cocoa's (up from its bottom); the same in both directions.
fn flip_y(y: f64, primary_height: f64) -> f64 {
    primary_height - y
}

/// The app set window `id`'s title bar (`titleBar`).
pub(crate) fn set_title_bar(
    surface: &Surface,
    id: NodeId,
    bar: &TitleBar,
    window: &NSWindow,
    options: &TitleBarOptions,
) {
    bar.style.set(options.style);
    bar.height.set(options.height.map(|h| h.0));
    bar.controls_offset
        .set(options.controls_offset.map(|p| (p.x.0, p.y.0)));
    apply_title_bar(surface, id, bar, window);
}

/// Window `id`'s style for its title bar `bar`'s.
fn apply_title_bar(surface: &Surface, id: NodeId, bar: &TitleBar, window: &NSWindow) {
    let hidden = bar.style.get() == TitleBarStyle::Hidden;
    let mut mask = window.styleMask();
    if hidden {
        mask |= NSWindowStyleMask::FullSizeContentView;
    } else {
        mask &= !NSWindowStyleMask::FullSizeContentView;
    }
    window.setStyleMask(mask);
    window.setTitlebarAppearsTransparent(hidden);
    window.setTitleVisibility(if hidden {
        NSWindowTitleVisibility::Hidden
    } else {
        NSWindowTitleVisibility::Visible
    });
    place_controls(surface, id, bar, window);
    title_bar_changed(surface, id);
    // AppKit can restore the old content size after setStyleMask returns.
    // Reconcile it after that pass, using the current window and style so
    // another title bar change in the same batch takes precedence.
    let key = surface.key();
    DispatchQueue::main().exec_async(move || {
        if let Some(surface) = Surface::with_key(key)
            && let Some(window) = crate::window::window_of(&surface, id)
            && let Some(content) = window.contentView()
        {
            let size = window.contentRectForFrameRect(window.frame()).size;
            if content.frame().size != size {
                content.setFrameSize(size);
            }
            // The title bar's layout can settle after setStyleMask returns,
            // even when the full-size content frame stays the same.
            crate::window::with_title_bar(&surface, id, |bar| {
                place_controls(&surface, id, bar, &window)
            });
            title_bar_changed(&surface, id);
        }
    });
}

/// Window `id`'s title bar area may have changed.
fn title_bar_changed(surface: &Surface, id: NodeId) {
    if id == ROOT_ID {
        update_area(surface);
    } else {
        crate::window::state_changed(surface, id);
    }
}

/// Puts window `id`'s buttons in its app's bar: centered in its height
/// ([`place_traffic_lights`]), or where the app put them
/// (`titleBar.controlsOffset`). AppKit lays them out again on resizes and
/// on leaving full screen, so this runs after those too.
pub(crate) fn place_controls(surface: &Surface, id: NodeId, bar: &TitleBar, window: &NSWindow) {
    if bar.placing.replace(true) {
        return;
    }
    place_traffic_lights(surface, id, bar, window);
    place_at_offset(bar, window);
    bar.placing.set(false);
}

/// Puts the window's buttons where the app put them, if it did.
fn place_at_offset(bar: &TitleBar, window: &NSWindow) {
    let Some((x, y)) = bar.controls_offset.get() else {
        return;
    };
    if full_screen(window) {
        return;
    }
    let buttons = [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ]
    .map(|b| window.standardWindowButton(b));
    let Some(close) = &buttons[0] else {
        return;
    };
    let Some(holder) = crate::view::superview(close) else {
        return;
    };
    let from = close.frame().origin.x;
    let height = holder.frame().size.height;
    for button in buttons.iter().flatten() {
        let f = button.frame();
        let origin = controls_origin(
            (x, y),
            f.origin.x - from,
            f.size.height,
            height,
            holder.isFlipped(),
        );
        if f.origin != origin {
            button.setFrameOrigin(origin);
        }
    }
}

/// Where a window button `dx` right of the close button goes, its top left
/// corner at `offset` from the window's, in its holder `height` tall
/// (flipped or not).
fn controls_origin(
    offset: (f32, f32),
    dx: f64,
    button: f64,
    height: f64,
    flipped: bool,
) -> NSPoint {
    let x = f64::from(offset.0) + dx;
    let top = f64::from(offset.1);
    let y = if flipped { top } else { height - top - button };
    NSPoint::new(x, y)
}

// --- Drag regions -----------------------------------------------------------------------

/// A left press at `(x, y)` (root coordinates): on a view marked
/// `windowDrag`, it moves (or, double-clicked, zooms) the window; true
/// when it did, and the press is not the app's.
pub(crate) fn mouse_down(surface: &Surface, event: &NSEvent, x: f32, y: f32) -> bool {
    if !crate::input::window_drag(surface, x, y) {
        return false;
    }
    // The window the press is in: the main one or one of the app's own.
    let Some(window) = crate::input::event_root(surface).ns().window() else {
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
pub(crate) fn disabled() -> Sel {
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

/// The pixels per point menu icons draw at: the largest of the screens',
/// since a menu opens on whichever screen it is asked to, not only the
/// window's (the menu bar is on each of them).
pub(crate) fn menu_icon_scale(mtm: MainThreadMarker) -> f32 {
    NSScreen::screens(mtm)
        .iter()
        .map(|screen| screen.backingScaleFactor() as f32)
        .fold(1.0, f32::max)
}

/// Gives `item` its icon once it has loaded (now when it is in memory); one
/// that fails leaves the item as it is. The load goes in `loads`, whose
/// owner gives it up with the menu.
fn set_icon(
    surface: &Surface,
    item: &NSMenuItem,
    icon: Option<&ImageSource>,
    loads: &mut Vec<crate::image::Load>,
) {
    let Some(icon) = icon else { return };
    // From macOS 27 AppKit hides menu items' images unless they ask to be
    // shown (`NSMenuItemImageVisibilityVisible`, a system symbol's too; not
    // in objc2-app-kit yet).
    if item.respondsToSelector(sel!(setPreferredImageVisibility:)) {
        // SAFETY: the property, an `NSInteger`, exists: just checked.
        let () = unsafe { msg_send![item, setPreferredImageVisibility: 1_isize] };
    }
    let item = item.retain();
    let uri = icon.uri.clone();
    let scale = menu_icon_scale(surface.mtm);
    let load = crate::image::load_menu_icon(surface, icon, scale, move |loaded| match loaded {
        Ok(loaded) => item.setImage(Some(&icon_image(&loaded, menu_icon::SIDE))),
        Err(e) => log::warn!("menu icon {uri}: {e}"),
    });
    loads.extend(load);
}

/// `icon` as an image for a menu item or the tray, fitted in a square of
/// `side` whatever the size it was decoded at: AppKit draws the image at its
/// size, so its pixels at the screen's scale are what make it sharp.
pub(crate) fn icon_image(icon: &crate::image::MenuIcon, side: Points) -> Retained<NSImage> {
    let pixels = size(
        DevicePixels(CGImage::width(Some(&icon.image)) as i32),
        DevicePixels(CGImage::height(Some(&icon.image)) as i32),
    );
    let shown = menu_icon::fitted(pixels, side);
    let image = NSImage::initWithCGImage_size(
        NSImage::alloc(),
        &icon.image,
        NSSize::new(shown.width.0 as f64, shown.height.0 as f64),
    );
    image.setTemplate(icon.template);
    image
}

/// A menu of `items`, titled `title`; the loads of their icons go in
/// `loads`.
pub(crate) fn menu(
    surface: &Surface,
    title: &str,
    items: &[MenuItem],
    loads: &mut Vec<crate::image::Load>,
) -> Retained<NSMenu> {
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
                set_icon(surface, &ns, action.icon.as_ref(), loads);
                menu.addItem(&ns);
                last_separator = false;
            }
            MenuItem::Submenu {
                label,
                enabled,
                items,
                icon,
            } => {
                let ns = holder(surface, label, *enabled, items, loads);
                set_icon(surface, &ns, icon.as_ref(), loads);
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
    loads: &mut Vec<crate::image::Load>,
) -> Retained<NSMenuItem> {
    let sub = menu(surface, label, items, loads);
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
/// top-level submenu (its top-level actions go to the first one). The bar's
/// titles are text: an icon is for the items of a menu.
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
        surface.chrome.menu_icons.borrow_mut().clear();
        restore_menu(&app);
        return;
    };
    let bar = NSMenu::new(mtm);
    let mut loads = Vec::new();
    for item in items {
        // A top-level item that is not a submenu gets one of its own.
        let (label, enabled, sub_items) = match item {
            MenuItem::Submenu {
                label,
                enabled,
                items,
                ..
            } => (label.clone(), *enabled, items.clone()),
            MenuItem::Action(action) => (title(action), true, vec![item.clone()]),
            MenuItem::Separator => continue,
        };
        bar.addItem(&holder(surface, &label, enabled, &sub_items, &mut loads));
    }
    app.setMainMenu(Some(&bar));
    *surface.chrome.menu.borrow_mut() = Some(bar);
    *surface.chrome.menu_icons.borrow_mut() = loads;
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

/// Shows a context menu at `at` (root coordinates) or at the mouse, in
/// the window the last pointer event was in (the main one, or a window of
/// the app's own, whose content `at` is in then).
fn popup(surface: &Rc<Surface>, items: &Arc<[MenuItem]>, at: Option<(f32, f32)>) {
    let root = crate::input::event_root(surface);
    let root = root.ns();
    // Kept while the menu is open: an icon that arrives then shows at once.
    let mut loads = Vec::new();
    let menu = menu(surface, "", items, &mut loads);
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
    drop(loads);
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
    let bar = &surface.main_window.title_bar;
    let Some(window) = window(surface) else {
        let placed = bar.traffic_lights.borrow_mut().take();
        drop(placed);
        update_area(surface);
        return;
    };
    if bar.style.get() == TitleBarStyle::Hidden {
        apply_title_bar(surface, ROOT_ID, bar, &window);
    } else {
        update_area(surface);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_buttons_go_where_the_app_put_them() {
        // The close button's top left 12 points in, 16 down, in a 52 tall
        // title bar view whose `y` goes up.
        assert_eq!(
            controls_origin((12.0, 16.0), 0.0, 14.0, 52.0, false),
            NSPoint::new(12.0, 22.0)
        );
        // The zoom button keeps its distance from the close button.
        assert_eq!(
            controls_origin((12.0, 16.0), 40.0, 14.0, 52.0, true),
            NSPoint::new(52.0, 16.0)
        );
    }

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
    fn screen_ys_flip_at_the_primary_screens_height() {
        assert_eq!(flip_y(0.0, 1080.0), 1080.0);
        assert_eq!(flip_y(1080.0, 1080.0), 0.0);
        assert_eq!(flip_y(flip_y(250.0, 1080.0), 1080.0), 250.0);
        // A display above the primary one: NSH's y is negative there.
        assert_eq!(flip_y(-400.0, 1080.0), 1480.0);
    }

    #[test]
    fn frames_are_placed_by_their_top_left_corner() {
        let rect = |x, y, w, h| NSRect::new(NSPoint::new(x, y), NSSize::new(w, h));
        // AppKit's frame: bottom left at (100, 380), 800×600, so its top
        // edge is 980 up, 100 down from the top of a 1080-point screen.
        let current = rect(100.0, 380.0, 800.0, 600.0);
        let frame = |x: Option<f32>, y: Option<f32>, w: Option<f32>, h: Option<f32>| WindowFrame {
            x: x.map(Points),
            y: y.map(Points),
            width: w.map(Points),
            height: h.map(Points),
            ..WindowFrame::default()
        };
        // Nothing given: the frame stays.
        assert_eq!(
            appkit_frame(current, &frame(None, None, None, None), 1080.0),
            current
        );
        // The top left corner at (20, 40): the top edge 1040 up.
        assert_eq!(
            appkit_frame(current, &frame(Some(20.0), Some(40.0), None, None), 1080.0),
            rect(20.0, 440.0, 800.0, 600.0)
        );
        // A height without a y keeps the top edge where it is.
        assert_eq!(
            appkit_frame(current, &frame(None, None, None, Some(400.0)), 1080.0),
            rect(100.0, 580.0, 800.0, 400.0)
        );
        // An origin and a size together.
        assert_eq!(
            appkit_frame(
                current,
                &frame(Some(0.0), Some(0.0), Some(640.0), Some(480.0)),
                1080.0
            ),
            rect(0.0, 600.0, 640.0, 480.0)
        );
        // On a display below the primary one, y goes past its height.
        assert_eq!(
            appkit_frame(current, &frame(None, Some(1200.0), None, None), 1080.0),
            rect(100.0, -720.0, 800.0, 600.0)
        );
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

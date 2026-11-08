//! The app's icon in the menu bar (`DesktopCommand::SetTray`, `nsh/desktop`'s
//! `Tray`): an `NSStatusItem`.
//!
//! - The icon loads through the image pipeline, like a menu item's: an SVG is
//!   a template, drawn in the menu bar's text color. The old one stays until
//!   a new one has loaded, and the item keeps its place when the app changes
//!   it.
//! - Without an `onClick`, the item owns its menu and AppKit opens it at any
//!   click. With one, a primary click is reported, and a secondary click (or
//!   Control and a primary one, as everywhere on macOS) opens the menu.
//! - The menu's items are reported as the application menu's are
//!   ([`crate::chrome::menu`]). The item goes with the app that set it.

use std::cell::RefCell;

use nsh_core::{
    EventKind, EventPayload, ImageSource, PayloadValue, ROOT_ID, ResizeMode,
    desktop::Tray,
    geometry::{Points, size},
    image::Want,
};
use objc2::{
    MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained, runtime::NSObject, sel,
};
use objc2_app_kit::{
    NSAccessibility, NSApplication, NSEventMask, NSEventModifierFlags, NSEventType, NSImage,
    NSMenu, NSStatusBar, NSStatusItem, NSVariableStatusItemLength,
};
use objc2_foundation::{NSCopying, NSObjectProtocol, NSSize, NSString};

use crate::{chrome, image::Load, surface::Surface};

/// The side of the square the icon is fitted in, in points: the menu bar's
/// icon size (`NSStatusBar`'s thickness leaves 3 points around it).
const SIDE: Points = Points(18.0);

/// The app's item.
struct Item {
    /// The surface whose app set it, which its reports go to.
    owner: u64,
    status: Retained<NSStatusItem>,
    /// The button's target (it does not retain it).
    target: Retained<TrayTarget>,
    menu: Option<Retained<NSMenu>>,
    /// The loads of the menu's icons, given up with it.
    menu_icons: Vec<Load>,
    /// The icon shown, or loading.
    icon: Option<Option<ImageSource>>,
    icon_load: Option<Load>,
    click: u32,
}

impl Drop for Item {
    fn drop(&mut self) {
        NSStatusBar::systemStatusBar().removeStatusItem(&self.status);
    }
}

thread_local! {
    static ITEM: RefCell<Option<Item>> = const { RefCell::new(None) };
}

define_class!(
    /// The target of the item's button, when the app has an `onClick`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ()]
    #[name = "NshTrayTarget"]
    struct TrayTarget;

    unsafe impl NSObjectProtocol for TrayTarget {}

    impl TrayTarget {
        #[unsafe(method(trayClicked:))]
        fn clicked(&self, _sender: Option<&NSObject>) {
            let mtm = self.mtm();
            let event = NSApplication::sharedApplication(mtm).currentEvent();
            let secondary = event.is_some_and(|e| {
                matches!(e.r#type(), NSEventType::RightMouseUp | NSEventType::RightMouseDown)
                    || e.modifierFlags().contains(NSEventModifierFlags::Control)
            });
            if secondary {
                open_menu(mtm);
            } else {
                report_click();
            }
        }
    }
);

/// `DesktopCommand::SetTray`.
pub(crate) fn set(surface: &Surface, tray: Option<&Tray>) {
    let Some(tray) = tray else {
        let item = ITEM.with(|i| i.borrow_mut().take());
        drop(item);
        return;
    };
    let mtm = surface.mtm;
    let mut loads = Vec::new();
    let menu = (!tray.menu.is_empty()).then(|| chrome::menu(surface, "", &tray.menu, &mut loads));
    let mut item = ITEM.with(|i| i.borrow_mut().take()).unwrap_or_else(|| {
        let status =
            NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
        Item {
            owner: surface.key(),
            status,
            // SAFETY: NSObject's initializer.
            target: unsafe { msg_send![super(TrayTarget::alloc(mtm).set_ivars(())), init] },
            menu: None,
            menu_icons: Vec::new(),
            icon: None,
            icon_load: None,
            click: 0,
        }
    });
    item.owner = surface.key();
    item.menu = menu;
    item.menu_icons = loads;
    item.click = tray.click;
    let tooltip = if tray.tooltip.is_empty() {
        chrome::app_name()
    } else {
        tray.tooltip.clone()
    };
    if let Some(button) = item.status.button(mtm) {
        let tooltip = NSString::from_str(&tooltip);
        button.setToolTip(Some(&tooltip));
        // An icon alone says nothing to VoiceOver.
        button.setAccessibilityLabel(Some(&tooltip));
        let clicks = tray.click != 0;
        // SAFETY: the target answers the action and lives as long as the
        // button, in the item.
        unsafe {
            button.setTarget(clicks.then_some(&*item.target as _));
            button.setAction(clicks.then_some(sel!(trayClicked:)));
        }
        button.sendActionOn(NSEventMask::LeftMouseUp | NSEventMask::RightMouseUp);
    }
    item.status.setMenu(if tray.click == 0 {
        item.menu.as_deref()
    } else {
        None
    });
    if item.icon.as_ref() != Some(&tray.icon) {
        item.icon = Some(tray.icon.clone());
        item.icon_load = set_icon(surface, &item.status, tray.icon.as_ref());
    }
    ITEM.with(|i| *i.borrow_mut() = Some(item));
}

/// Gives the item `icon` once it has loaded (now when it is in memory), or
/// the app's icon: a failed load leaves the old icon, or that one when there
/// is none, since an item with no image cannot be seen or clicked.
fn set_icon(surface: &Surface, status: &NSStatusItem, icon: Option<&ImageSource>) -> Option<Load> {
    let mtm = surface.mtm;
    let button = status.button(mtm)?;
    let Some(icon) = icon else {
        button.setImage(app_icon(mtm).as_deref());
        return None;
    };
    let want = Want {
        size: size(SIDE, SIDE),
        scale: chrome::menu_icon_scale(mtm),
        mode: ResizeMode::Contain,
    };
    let uri = icon.uri.clone();
    crate::image::load_icon(surface, icon, want, move |loaded| match loaded {
        Ok(loaded) => button.setImage(Some(&chrome::icon_image(&loaded, SIDE))),
        Err(e) => {
            log::warn!("tray icon {uri}: {e}");
            if button.image().is_none() {
                button.setImage(app_icon(mtm).as_deref());
            }
        }
    })
}

/// The app's icon, of the size the item shows it at.
fn app_icon(mtm: MainThreadMarker) -> Option<Retained<NSImage>> {
    let icon = NSApplication::sharedApplication(mtm).applicationIconImage()?;
    // A copy: the application's image is shared, and its size is the image's.
    let icon = icon.copy();
    icon.setSize(NSSize::new(f64::from(SIDE.0), f64::from(SIDE.0)));
    Some(icon)
}

/// A primary click, with an `onClick`.
fn report_click() {
    let Some((owner, click)) = ITEM.with(|i| i.borrow().as_ref().map(|i| (i.owner, i.click)))
    else {
        return;
    };
    if click != 0
        && let Some(surface) = Surface::with_key(owner)
    {
        surface.event(
            ROOT_ID,
            EventKind::Menu,
            EventPayload::Map(vec![("id", PayloadValue::Number(f64::from(click)))]),
        );
    }
}

/// A secondary click, with an `onClick`: the item shows its menu for as long
/// as the click's tracking lasts, as AppKit highlights the item and places
/// the menu only for a menu of its own.
fn open_menu(mtm: MainThreadMarker) {
    // Not kept borrowed: the app can set the tray while the menu tracks.
    let Some((status, menu)) = ITEM.with(|i| {
        let item = i.borrow();
        let item = item.as_ref()?;
        Some((item.status.clone(), item.menu.clone()?))
    }) else {
        return;
    };
    status.setMenu(Some(&menu));
    if let Some(button) = status.button(mtm) {
        // SAFETY: a click without a sender. Returns once the menu closed.
        unsafe { button.performClick(None) };
    }
    // The item as the app has it now.
    ITEM.with(|i| {
        let item = i.borrow();
        status.setMenu(
            item.as_ref()
                .filter(|item| item.click == 0)
                .and_then(|item| item.menu.as_deref()),
        );
    });
}

/// The app of the surface with `key` stopped: its item goes with it.
pub(crate) fn release(key: u64) {
    let item = ITEM.try_with(|i| {
        let mut item = i.borrow_mut();
        item.as_ref()
            .is_some_and(|item| item.owner == key)
            .then(|| item.take())
            .flatten()
    });
    drop(item);
}

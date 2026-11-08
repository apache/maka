//! The app's icon in the system tray on Linux (`DesktopCommand::SetTray`,
//! `nsh/desktop`'s `Tray`): a StatusNotifierItem on the session bus, with
//! its menu as a `com.canonical.dbusmenu` object, through GIO. Plasma,
//! Waybar, Quickshell and most panels host such items (GNOME with the
//! AppIndicator extension); the panel's `org.kde.StatusNotifierWatcher`
//! is told about the item, again whenever a watcher appears (a panel that
//! starts after the app, or restarts).
//!
//! - The icon is sent as pixels (`IconPixmap`, ARGB32 in network byte
//!   order) at a few sizes, so no icon theme is needed. It loads through the
//!   image pipeline, off the main thread: the item shows once it has. An
//!   SVG is a template, as on macOS and Windows: painted white when the
//!   system is dark, black when light (panels don't say their color).
//! - A primary click is `Activate`: the app's `onClick`, or, without one,
//!   `ItemIsMenu` asks the panel to open the menu instead. The menu's items
//!   are chosen through `Event(id, "clicked")` and reported as the menu bar's
//!   are ([`crate::chrome::choose`]).

use std::{cell::RefCell, rc::Weak, sync::Arc};

use gtk4::{gdk, gio, glib, prelude::*};
use nsh_core::{
    EventKind, EventPayload, PayloadValue, ROOT_ID,
    desktop::{MenuItem, MenuRole, Tray},
};

use crate::surface::Surface;

const ITEM_PATH: &str = "/StatusNotifierItem";
const MENU_PATH: &str = "/MenuBar";
const WATCHER: &str = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH: &str = "/StatusNotifierWatcher";
const ITEM_INTERFACE: &str = "org.kde.StatusNotifierItem";
const MENU_INTERFACE: &str = "com.canonical.dbusmenu";
/// The sizes the icon is sent at, in pixels: panels pick the nearest.
const SIDES: [u32; 3] = [16, 24, 32];

const XML: &str = r#"<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
    <method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
    <method name="ProvideXdgActivationToken"><arg name="token" type="s" direction="in"/></method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus"><arg name="status" type="s"/></signal>
  </interface>
  <interface name="com.canonical.dbusmenu">
    <property name="Version" type="u" access="read"/>
    <property name="TextDirection" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="IconThemePath" type="as" access="read"/>
    <method name="GetLayout">
      <arg name="parentId" type="i" direction="in"/>
      <arg name="recursionDepth" type="i" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="revision" type="u" direction="out"/>
      <arg name="layout" type="(ia{sv}av)" direction="out"/>
    </method>
    <method name="GetGroupProperties">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="propertyNames" type="as" direction="in"/>
      <arg name="properties" type="a(ia{sv})" direction="out"/>
    </method>
    <method name="GetProperty">
      <arg name="id" type="i" direction="in"/>
      <arg name="name" type="s" direction="in"/>
      <arg name="value" type="v" direction="out"/>
    </method>
    <method name="Event">
      <arg name="id" type="i" direction="in"/>
      <arg name="eventId" type="s" direction="in"/>
      <arg name="data" type="v" direction="in"/>
      <arg name="timestamp" type="u" direction="in"/>
    </method>
    <method name="EventGroup">
      <arg name="events" type="a(isvu)" direction="in"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <method name="AboutToShow">
      <arg name="id" type="i" direction="in"/>
      <arg name="needUpdate" type="b" direction="out"/>
    </method>
    <method name="AboutToShowGroup">
      <arg name="ids" type="ai" direction="in"/>
      <arg name="updatesNeeded" type="ai" direction="out"/>
      <arg name="idErrors" type="ai" direction="out"/>
    </method>
    <signal name="ItemsPropertiesUpdated">
      <arg name="updatedProps" type="a(ia{sv})"/>
      <arg name="removedProps" type="a(ias)"/>
    </signal>
    <signal name="LayoutUpdated">
      <arg name="revision" type="u"/>
      <arg name="parent" type="i"/>
    </signal>
  </interface>
</node>"#;

/// A menu entry as dbusmenu numbers it (the root is 0).
struct Entry {
    /// The parent's number.
    parent: i32,
    /// Its properties.
    props: glib::Variant,
    /// The action's id (0: none) and role, for a chosen item.
    action: Option<(u32, Option<MenuRole>)>,
}

/// The tray, while the app has one.
struct Shown {
    surface: Weak<Surface>,
    bus: gio::DBusConnection,
    registrations: Vec<gio::RegistrationId>,
    owner: gio::OwnerId,
    /// Stops watching for the tray's watcher.
    unwatch: Box<dyn FnOnce()>,
    name: String,
    title: String,
    tooltip: String,
    click: u32,
    /// `IconPixmap`'s value: empty until the icon has loaded.
    pixmaps: Vec<(i32, i32, Vec<u8>)>,
    /// The menu, numbered: entry `n` is `entries[n - 1]`.
    entries: Vec<Entry>,
    revision: u32,
    /// Bumped by each `SetTray`: a late icon load of an earlier tray is
    /// dropped.
    generation: u64,
}

thread_local! {
    static TRAY: RefCell<Option<Shown>> = const { RefCell::new(None) };
    static GENERATION: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Shows, changes or removes (`None`) the app's tray icon.
pub(crate) fn set(surface: &std::rc::Rc<Surface>, tray: Option<&Tray>) {
    let generation = GENERATION.with(|g| {
        g.set(g.get() + 1);
        g.get()
    });
    let Some(tray) = tray else {
        remove();
        return;
    };
    let (app_id, app_name) = crate::notifications::app();
    let mut entries = Some(number(&tray.menu));
    let changed = TRAY.with(|t| {
        let mut t = t.borrow_mut();
        let Some(shown) = t.as_mut() else {
            return false;
        };
        shown.surface = std::rc::Rc::downgrade(surface);
        shown.tooltip = tray.tooltip.clone();
        shown.click = tray.click;
        shown.entries = entries.take().unwrap_or_default();
        shown.revision += 1;
        shown.generation = generation;
        true
    });
    if changed {
        emit(ITEM_PATH, ITEM_INTERFACE, "NewToolTip", None);
        let revision = TRAY.with(|t| t.borrow().as_ref().map_or(0, |s| s.revision));
        emit(
            MENU_PATH,
            MENU_INTERFACE,
            "LayoutUpdated",
            Some((revision, 0i32).to_variant()),
        );
    } else {
        let bus = match gio::bus_get_sync(gio::BusType::Session, gio::Cancellable::NONE) {
            Ok(bus) => bus,
            Err(e) => {
                log::warn!("nsh: no session bus for the tray icon: {e}");
                return;
            }
        };
        let Some(shown) = publish(
            &bus,
            surface,
            tray,
            entries.take().unwrap_or_default(),
            generation,
            &app_id,
            &app_name,
        ) else {
            return;
        };
        TRAY.with(|t| *t.borrow_mut() = Some(shown));
    }
    load_icon(surface, tray, generation);
}

/// Registers the item and its menu on `bus` and owns its name.
fn publish(
    bus: &gio::DBusConnection,
    surface: &std::rc::Rc<Surface>,
    tray: &Tray,
    entries: Vec<Entry>,
    generation: u64,
    app_id: &str,
    app_name: &str,
) -> Option<Shown> {
    let info = gio::DBusNodeInfo::for_xml(XML).ok()?;
    let mut registrations = Vec::new();
    for (path, interface) in [(ITEM_PATH, ITEM_INTERFACE), (MENU_PATH, MENU_INTERFACE)] {
        let interface = info.lookup_interface(interface)?;
        let registration = bus
            .register_object(path, &interface)
            .method_call(|_, _, _, interface, method, params, invocation| {
                let reply = match interface {
                    Some(MENU_INTERFACE) => menu_call(method, &params),
                    _ => item_call(method, &params),
                };
                invocation.return_value(reply.as_ref());
            })
            .property(|_, _, _, interface, property| match interface {
                MENU_INTERFACE => menu_property(property),
                _ => item_property(property),
            })
            .build();
        match registration {
            Ok(id) => registrations.push(id),
            Err(e) => {
                log::warn!("nsh: cannot publish the tray icon: {e}");
                registrations
                    .into_iter()
                    .for_each(|id| drop(bus.unregister_object(id)));
                return None;
            }
        }
    }
    // The name hosts know the item by; it disappears with the process.
    let name = format!(
        "org.kde.StatusNotifierItem-{}-{generation}",
        std::process::id()
    );
    let owner = gio::bus_own_name_on_connection(
        bus,
        &name,
        gio::BusNameOwnerFlags::NONE,
        |_, _| {},
        |_, name| log::warn!("nsh: lost the tray icon's bus name {name}"),
    );
    // Registers with every watcher that appears, the one there now first.
    let watched = name.clone();
    let watcher = gio::bus_watch_name_on_connection(
        bus,
        WATCHER,
        gio::BusNameWatcherFlags::NONE,
        move |bus, _, _| register(&bus, &watched),
        |_, _| {},
    );
    let title = if app_name.is_empty() {
        app_id.to_owned()
    } else {
        app_name.to_owned()
    };
    Some(Shown {
        surface: std::rc::Rc::downgrade(surface),
        bus: bus.clone(),
        registrations,
        owner,
        unwatch: Box::new(move || gio::bus_unwatch_name(watcher)),
        name,
        title,
        tooltip: tray.tooltip.clone(),
        click: tray.click,
        pixmaps: Vec::new(),
        entries,
        revision: 1,
        generation,
    })
}

/// Tells the watcher about the item called `name`.
fn register(bus: &gio::DBusConnection, name: &str) {
    bus.call(
        Some(WATCHER),
        WATCHER_PATH,
        WATCHER,
        "RegisterStatusNotifierItem",
        Some(&(name,).to_variant()),
        None,
        gio::DBusCallFlags::NONE,
        5000,
        gio::Cancellable::NONE,
        |result| {
            if let Err(e) = result {
                log::warn!("nsh: the tray's watcher refused the icon: {e}");
            }
        },
    );
}

/// Removes the icon only when this surface owns it.
pub(crate) fn clear(surface: &Surface) {
    let owns = TRAY
        .try_with(|t| {
            t.borrow()
                .as_ref()
                .is_some_and(|shown| std::ptr::eq(shown.surface.as_ptr(), surface))
        })
        .unwrap_or(false);
    if owns {
        remove();
    }
}

fn remove() {
    let Some(shown) = TRAY.with(|t| t.borrow_mut().take()) else {
        return;
    };
    for id in shown.registrations {
        let _ = shown.bus.unregister_object(id);
    }
    (shown.unwatch)();
    // Hosts drop an item whose name leaves the bus.
    gio::bus_unown_name(shown.owner);
    let _ = shown.name;
}

/// Loads the icon at [`SIDES`], then shows it.
fn load_icon(surface: &std::rc::Rc<Surface>, tray: &Tray, generation: u64) {
    let Some(source) = &tray.icon else {
        return;
    };
    let loaded = std::rc::Rc::new(RefCell::new(Vec::new()));
    for side in SIDES {
        let loaded = loaded.clone();
        let source_uri = source.uri.clone();
        crate::image::load_icon(surface, source, side, move |result| {
            let (texture, template) = match result {
                Ok(loaded) => loaded,
                Err(e) => {
                    log::warn!("nsh: the tray's icon {source_uri} did not load: {e}");
                    return;
                }
            };
            let mut loaded = loaded.borrow_mut();
            loaded.push(pixmap(&texture, template, side));
            if loaded.len() < SIDES.len() {
                return;
            }
            let mut pixmaps = std::mem::take(&mut *loaded);
            pixmaps.sort_by_key(|p| p.0);
            let current = TRAY.with(|t| {
                let mut t = t.borrow_mut();
                match t.as_mut() {
                    Some(shown) if shown.generation == generation => {
                        shown.pixmaps = pixmaps;
                        true
                    }
                    _ => false,
                }
            });
            if current {
                emit(ITEM_PATH, ITEM_INTERFACE, "NewIcon", None);
            }
        });
    }
}

/// `texture` as an `IconPixmap` entry of `side` × `side` pixels (the
/// image fitted and centered, as menu icons are): ARGB32, unpremultiplied,
/// in network byte order.
fn pixmap(texture: &gdk::Texture, template: bool, side: u32) -> (i32, i32, Vec<u8>) {
    let mut downloader = gdk::TextureDownloader::new(texture);
    downloader.set_format(gdk::MemoryFormat::B8g8r8a8Premultiplied);
    let (bytes, stride) = downloader.download_bytes();
    let (width, height) = (texture.width() as usize, texture.height() as usize);
    let mut packed = Vec::with_capacity(width * height * 4);
    for y in 0..height {
        packed.extend_from_slice(&bytes[y * stride..y * stride + width * 4]);
    }
    let mut square =
        nsh_core::desktop::menu_icon::canvas(&packed, width as u32, height as u32, side);
    if template {
        let color = if crate::system::system_dark() {
            nsh_core::Color::rgba(255, 255, 255, 255)
        } else {
            nsh_core::Color::rgba(0, 0, 0, 255)
        };
        nsh_core::desktop::menu_icon::tint(&mut square, color);
    }
    let mut data = Vec::with_capacity(square.len());
    for &[b, g, r, a] in square.as_chunks::<4>().0 {
        let un = |c: u8| match a {
            0 => 0,
            _ => ((u32::from(c) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8,
        };
        data.extend_from_slice(&[a, un(r), un(g), un(b)]);
    }
    (side as i32, side as i32, data)
}

fn emit(path: &str, interface: &str, signal: &str, args: Option<glib::Variant>) {
    let bus = TRAY.with(|t| t.borrow().as_ref().map(|s| s.bus.clone()));
    if let Some(bus) = bus {
        let _ = bus.emit_signal(None, path, interface, signal, args.as_ref());
    }
}

// --- StatusNotifierItem -------------------------------------------------------------------

fn item_property(name: &str) -> glib::Variant {
    TRAY.with(|t| {
        let t = t.borrow();
        let Some(s) = t.as_ref() else {
            return "".to_variant();
        };
        let pixmaps = || s.pixmaps.clone().to_variant();
        match name {
            "Category" => "ApplicationStatus".to_variant(),
            "Id" => crate::notifications::app().0.to_variant(),
            "Title" => s.title.to_variant(),
            "Status" => "Active".to_variant(),
            "IconName" => "".to_variant(),
            "IconPixmap" => pixmaps(),
            "ToolTip" => {
                let text = if s.tooltip.is_empty() {
                    s.title.clone()
                } else {
                    s.tooltip.clone()
                };
                ("", Vec::<(i32, i32, Vec<u8>)>::new(), text, "").to_variant()
            }
            "ItemIsMenu" => (s.click == 0).to_variant(),
            "Menu" => glib::variant::ObjectPath::try_from(MENU_PATH.to_owned())
                .expect("a valid path")
                .to_variant(),
            _ => "".to_variant(),
        }
    })
}

fn item_call(method: &str, _params: &glib::Variant) -> Option<glib::Variant> {
    if method == "Activate" {
        let (surface, click) = TRAY.with(|t| {
            t.borrow()
                .as_ref()
                .map_or((Weak::new(), 0), |s| (s.surface.clone(), s.click))
        });
        if click != 0
            && let Some(surface) = surface.upgrade()
        {
            surface.event(
                ROOT_ID,
                EventKind::Menu,
                EventPayload::Map(vec![("id", PayloadValue::Number(f64::from(click)))]),
            );
        }
    }
    // `ContextMenu`: hosts open the menu themselves; `Scroll`,
    // `SecondaryActivate`, `ProvideXdgActivationToken`: nothing to do.
    None
}

// --- dbusmenu -----------------------------------------------------------------------------

/// Numbers `items` for dbusmenu, depth first.
fn number(items: &Arc<[MenuItem]>) -> Vec<Entry> {
    fn walk(items: &[MenuItem], parent: i32, out: &mut Vec<Entry>) {
        for item in items {
            let dict = glib::VariantDict::new(None);
            let mut action = None;
            let mut children: Option<&[MenuItem]> = None;
            match item {
                MenuItem::Separator => dict.insert("type", "separator"),
                MenuItem::Action(a) => {
                    let label = if a.label.is_empty() {
                        a.role.map(role_label).unwrap_or_default().to_owned()
                    } else {
                        a.label.replace('_', "__")
                    };
                    dict.insert("label", label);
                    dict.insert("enabled", a.enabled);
                    if let Some(checked) = a.checked {
                        dict.insert("toggle-type", "checkmark");
                        dict.insert("toggle-state", i32::from(checked));
                    }
                    action = Some((a.id, a.role));
                }
                MenuItem::Submenu {
                    label,
                    enabled,
                    items,
                    ..
                } => {
                    dict.insert("label", label.replace('_', "__"));
                    dict.insert("enabled", *enabled);
                    dict.insert("children-display", "submenu");
                    children = Some(items);
                }
            }
            out.push(Entry {
                parent,
                props: dict.end(),
                action,
            });
            let number = out.len() as i32;
            if let Some(children) = children {
                walk(children, number, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(items, 0, &mut out);
    out
}

/// A role's label, for an item that has none.
fn role_label(role: MenuRole) -> &'static str {
    match role {
        MenuRole::Quit => "Quit",
        MenuRole::Close => "Close",
        MenuRole::Minimize => "Minimize",
        MenuRole::Zoom => "Zoom",
        MenuRole::ToggleFullScreen => "Full Screen",
        MenuRole::Undo => "Undo",
        MenuRole::Redo => "Redo",
        MenuRole::Cut => "Cut",
        MenuRole::Copy => "Copy",
        MenuRole::Paste => "Paste",
        MenuRole::SelectAll => "Select All",
        _ => "",
    }
}

/// Entry `id`'s layout, `depth` levels of children deep (-1: all).
fn layout(entries: &[Entry], id: i32, depth: i32) -> glib::Variant {
    let props = match id {
        0 => {
            let dict = glib::VariantDict::new(None);
            dict.insert("children-display", "submenu");
            dict.end()
        }
        _ => entries
            .get(id as usize - 1)
            .map_or_else(|| glib::VariantDict::new(None).end(), |e| e.props.clone()),
    };
    let children: Vec<glib::Variant> = if depth == 0 {
        Vec::new()
    } else {
        entries
            .iter()
            .enumerate()
            .filter(|(_, e)| e.parent == id)
            .map(|(i, _)| layout(entries, i as i32 + 1, depth - 1).to_variant())
            .collect()
    };
    glib::Variant::tuple_from_iter([
        id.to_variant(),
        props,
        glib::Variant::array_from_iter_with_type(glib::VariantTy::VARIANT, children),
    ])
}

fn menu_property(name: &str) -> glib::Variant {
    match name {
        "Version" => 3u32.to_variant(),
        "TextDirection" => "ltr".to_variant(),
        "Status" => "normal".to_variant(),
        "IconThemePath" => Vec::<String>::new().to_variant(),
        _ => "".to_variant(),
    }
}

fn menu_call(method: &str, params: &glib::Variant) -> Option<glib::Variant> {
    match method {
        "GetLayout" => {
            let (parent, depth, _) = params.get::<(i32, i32, Vec<String>)>()?;
            TRAY.with(|t| {
                let t = t.borrow();
                let (entries, revision) = t
                    .as_ref()
                    .map_or((&[][..], 0), |s| (&s.entries[..], s.revision));
                Some(glib::Variant::tuple_from_iter([
                    revision.to_variant(),
                    layout(entries, parent, depth),
                ]))
            })
        }
        "GetGroupProperties" => {
            let (ids, _) = params.get::<(Vec<i32>, Vec<String>)>()?;
            TRAY.with(|t| {
                let t = t.borrow();
                let entries = t.as_ref().map_or(&[][..], |s| &s.entries[..]);
                let found = ids.into_iter().filter_map(|id| {
                    let e = entries.get(usize::try_from(id).ok()?.checked_sub(1)?)?;
                    Some(glib::Variant::tuple_from_iter([
                        id.to_variant(),
                        e.props.clone(),
                    ]))
                });
                let ty = glib::VariantTy::new("(ia{sv})").expect("a valid type");
                Some(glib::Variant::tuple_from_iter([
                    glib::Variant::array_from_iter_with_type(ty, found),
                ]))
            })
        }
        "GetProperty" => {
            let (id, name) = params.get::<(i32, String)>()?;
            let value = TRAY.with(|t| {
                let t = t.borrow();
                let e = t
                    .as_ref()?
                    .entries
                    .get(usize::try_from(id).ok()?.checked_sub(1)?)?;
                glib::VariantDict::new(Some(&e.props)).lookup_value(&name, None)
            });
            Some((value.unwrap_or_else(|| "".to_variant()),).to_variant())
        }
        "Event" => {
            let (id, event, _, _) = params.get::<(i32, String, glib::Variant, u32)>()?;
            if event == "clicked" {
                clicked(id);
            }
            None
        }
        "EventGroup" => {
            let events = params.child_value(0);
            for event in events.iter() {
                if let (Some(id), Some(name)) = (
                    event.child_value(0).get::<i32>(),
                    event.child_value(1).get::<String>(),
                ) && name == "clicked"
                {
                    clicked(id);
                }
            }
            Some((Vec::<i32>::new(),).to_variant())
        }
        "AboutToShow" => Some((false,).to_variant()),
        "AboutToShowGroup" => Some((Vec::<i32>::new(), Vec::<i32>::new()).to_variant()),
        _ => None,
    }
}

/// Entry `id` was chosen.
fn clicked(id: i32) {
    let found = TRAY.with(|t| {
        let t = t.borrow();
        let s = t.as_ref()?;
        let entry = s.entries.get(usize::try_from(id).ok()?.checked_sub(1)?)?;
        Some((s.surface.clone(), entry.action?))
    });
    let Some((surface, (action, role))) = found else {
        return;
    };
    // Out of the bus call: the app's function may change the tray.
    glib::idle_add_local_once(move || {
        if let Some(surface) = surface.upgrade() {
            crate::chrome::choose(&surface, action, role);
        }
    });
}

#[cfg(test)]
mod tests {
    use nsh_core::desktop::MenuAction;

    use super::*;

    fn action(id: u32, label: &str) -> MenuItem {
        MenuItem::Action(MenuAction {
            id,
            label: label.into(),
            shortcut: None,
            enabled: true,
            checked: None,
            role: None,
            when: nsh_core::keymap::When::Always,
            icon: None,
        })
    }

    #[test]
    fn group_properties_obeys_dbusmenu_signature() {
        let args = (Vec::<i32>::new(), Vec::<String>::new()).to_variant();
        let response = menu_call("GetGroupProperties", &args).unwrap();
        assert_eq!(response.type_().as_str(), "(a(ia{sv}))");
    }

    #[test]
    fn property_reply_has_one_variant_box() {
        let args = (1i32, "label").to_variant();
        let response = menu_call("GetProperty", &args).unwrap();
        assert_eq!(response.type_().as_str(), "(v)");
        assert_eq!(
            response
                .child_value(0)
                .as_variant()
                .unwrap()
                .type_()
                .as_str(),
            "s"
        );
    }

    #[test]
    fn menus_number_depth_first_and_lay_out() {
        let items: Arc<[MenuItem]> = vec![
            action(7, "Open_File"),
            MenuItem::Separator,
            MenuItem::Submenu {
                label: "More".into(),
                enabled: true,
                items: vec![action(8, "Inner")],
                icon: None,
            },
        ]
        .into();
        let entries = number(&items);
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[3].parent, 3);
        assert_eq!(entries[3].action.map(|a| a.0), Some(8));
        let l = layout(&entries, 0, -1);
        assert_eq!(l.type_().as_str(), "(ia{sv}av)");
        assert_eq!(l.child_value(2).n_children(), 3);
        // Underscores are mnemonics in dbusmenu: kept literal.
        let label = glib::VariantDict::new(Some(&entries[0].props))
            .lookup_value("label", None)
            .unwrap();
        assert_eq!(label.get::<String>().unwrap(), "Open__File");
        // One level only.
        let shallow = layout(&entries, 0, 1);
        let sub = shallow.child_value(2).child_value(2).as_variant().unwrap();
        assert_eq!(sub.child_value(2).n_children(), 0);
    }
}

#[cfg(test)]
mod template_tests {
    use super::*;

    /// A 1×1 opaque red pixel, as an SVG template's stroke renders.
    fn red() -> gdk::Texture {
        let bytes = glib::Bytes::from_static(&[0, 0, 255, 255]);
        gdk::MemoryTexture::new(1, 1, gdk::MemoryFormat::B8g8r8a8Premultiplied, &bytes, 4).upcast()
    }

    #[test]
    fn template_is_painted_bitmap_kept() {
        let painted = pixmap(&red(), true, 1).2;
        let expected = if crate::system::system_dark() { 255 } else { 0 };
        assert_eq!(painted, vec![255, expected, expected, expected]);
        assert_eq!(pixmap(&red(), false, 1).2, vec![255, 255, 0, 0]);
    }
}

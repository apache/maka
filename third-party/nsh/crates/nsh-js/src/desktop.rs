//! `nsh/desktop`'s hand-written exports (with the registry's
//! `Application`): `isAvailable`, `displays()` (the environment's
//! accessor), the windows (`crate::window`) and `Menu`, `Tray` and
//! `GlobalShortcut`, whose items call the app's functions: the menus are decoded natively
//! into [`MenuItem`]s with an id per item, the functions kept by id, and
//! the platform's [`EventKind::Menu`] calls the chosen item's.

use std::{
    cell::{Cell, RefCell},
    ffi::{CStr, c_int},
    ptr,
    sync::Arc,
};

use nsh_core::{
    Command, EventKind, ImageSource, Op, ROOT_ID,
    desktop::{DesktopCommand, MenuAction, MenuBarMode, MenuItem, MenuRole, Shortcut, Tray},
    geometry::{Points, point},
    keymap::When,
    platform::Os,
};
use rquickjs::{Ctx, Value, qjs};

use crate::{
    dom,
    modules::{Export, Item, Ts},
    reactive::{self, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// Menu items' functions: (id, owned function).
type Functions = Vec<(u32, JsValue)>;

/// The menus' part of a context's state.
pub(crate) struct Menus {
    /// The application menu's functions (id, owned function).
    app: RefCell<Vec<(u32, JsValue)>>,
    /// The last context menu's functions.
    popup: RefCell<Vec<(u32, JsValue)>>,
    /// Resolves the promise of the context menu shown (owned), once the
    /// platform reports it closed.
    closed: Cell<JsValue>,
    /// The tray's functions: its menu's and its click's.
    tray: RefCell<Vec<(u32, JsValue)>>,
    /// The global shortcuts registered.
    globals: RefCell<Vec<Global>>,
    /// The root's `onMenu` handler is set.
    listening: Cell<bool>,
    next: Cell<u32>,
}

impl Default for Menus {
    fn default() -> Self {
        Menus {
            app: RefCell::default(),
            popup: RefCell::default(),
            tray: RefCell::default(),
            globals: RefCell::default(),
            closed: Cell::new(UNDEFINED),
            listening: Cell::new(false),
            next: Cell::new(0),
        }
    }
}

/// Resolves the promise of the context menu shown, if there is one.
fn resolve_closed(cx: *mut JsContext) {
    let resolve = menus(cx).closed.replace(UNDEFINED);
    if !nullish(resolve) {
        // SAFETY: an owned resolving function, called then freed.
        unsafe {
            let r = qjs::JS_Call(cx, resolve, UNDEFINED, 0, ptr::null_mut());
            qjs::JS_FreeValue(cx, r);
            qjs::JS_FreeValue(cx, resolve);
        }
    }
}

/// A global shortcut (`GlobalShortcut.register`).
struct Global {
    id: u32,
    shortcut: Shortcut,
    /// Called at each press (owned).
    on_press: JsValue,
    /// Resolves `register`'s promise once the platform answers (owned;
    /// `undefined` once it did).
    resolve: JsValue,
}

impl Global {
    /// Frees its functions, settling `register`'s promise with `false` when
    /// the platform has not answered yet.
    fn free(self, cx: *mut JsContext) {
        settle(cx, self.resolve, false);
        free(cx, self.on_press);
    }
}

/// Calls the owned resolving function `resolve` (if any) with `value`, then
/// frees it.
fn settle(cx: *mut JsContext, resolve: JsValue, value: bool) {
    if nullish(resolve) {
        return;
    }
    let mut arg = if value { qjs::JS_TRUE } else { qjs::JS_FALSE };
    // SAFETY: an owned resolving function, called then freed.
    unsafe {
        let r = qjs::JS_Call(cx, resolve, UNDEFINED, 1, &mut arg);
        qjs::JS_FreeValue(cx, r);
        qjs::JS_FreeValue(cx, resolve);
    }
}

impl Menus {
    /// Frees the values held (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        for g in self.globals.get_mut().drain(..) {
            // SAFETY: owned values; no JS runs from here on.
            unsafe {
                qjs::JS_FreeValue(raw, g.on_press);
                qjs::JS_FreeValue(raw, g.resolve);
            }
        }
        // SAFETY: owned; no JS runs from here on.
        unsafe { qjs::JS_FreeValue(raw, self.closed.replace(UNDEFINED)) };
        for (_, f) in self
            .app
            .get_mut()
            .drain(..)
            .chain(self.popup.get_mut().drain(..))
            .chain(self.tray.get_mut().drain(..))
        {
            // SAFETY: owned values; no JS runs from here on.
            unsafe { qjs::JS_FreeValue(raw, f) };
        }
    }
}

fn menus<'a>(cx: *mut JsContext) -> &'a Menus {
    // SAFETY: a projection of the state's field, by shared reference.
    unsafe { &(*crate::state::state(cx)).menus }
}

fn os(cx: *mut JsContext) -> Os {
    // SAFETY: the state's renderer, by shared reference.
    unsafe { &(*crate::state::state(cx)).dom }.os()
}

fn throw(cx: *mut JsContext, message: &str) -> JsValue {
    let message = std::ffi::CString::new(message).unwrap_or_default();
    // SAFETY: throws on a live context; `%s` keeps the message literal.
    unsafe { qjs::JS_ThrowTypeError(cx, c"%s".as_ptr(), message.as_ptr()) }
}

/// `undefined` or `null`.
fn nullish(v: JsValue) -> bool {
    // SAFETY: inline tag checks.
    unsafe { qjs::JS_IsUndefined(v) || qjs::JS_IsNull(v) }
}

fn is_object(v: JsValue) -> bool {
    // SAFETY: an inline tag check.
    unsafe { qjs::JS_IsObject(v) }
}

/// Property `key` of `object` (owned).
fn get(cx: *mut JsContext, object: JsValue, key: &CStr) -> JsValue {
    // SAFETY: a read of a live object.
    unsafe { qjs::JS_GetPropertyStr(cx, object, key.as_ptr()) }
}

fn free(cx: *mut JsContext, v: JsValue) {
    // SAFETY: an owned value.
    unsafe { qjs::JS_FreeValue(cx, v) };
}

/// String property `key`, if it is set.
fn string(cx: *mut JsContext, object: JsValue, key: &CStr) -> Option<String> {
    let v = get(cx, object, key);
    let s = if nullish(v) {
        None
    } else {
        dom::string_arg(cx, v)
    };
    free(cx, v);
    s
}

/// The role named `name`, as `MenuRole`'s conversion reads it.
fn menu_role(cx: *mut JsContext, name: &str) -> Option<MenuRole> {
    let host = crate::classes::host_outside_calls(cx);
    let value = nsh_core::element::JsHost::new_string(&host, name).ok()?;
    let value = nsh_core::element::JsOwned::new(&host, value);
    let role = <MenuRole as nsh_core::element::JsValue>::from_js(value.get()).ok();
    host.clear_pending();
    role
}

/// Boolean property `key`, if it is set.
fn flag(cx: *mut JsContext, object: JsValue, key: &CStr) -> Option<bool> {
    let v = get(cx, object, key);
    let b = if nullish(v) {
        None
    } else {
        // SAFETY: `ToBoolean` of a live value.
        Some(unsafe { qjs::JS_ToBool(cx, v) } == 1)
    };
    free(cx, v);
    b
}

/// The source of item `v`'s `icon`, as `<Image>`'s `src` takes it (a `blob:`
/// URL's bytes, in this VM, go with it); `None` when it has none. Anything
/// else throws, as a menu's other wrong values do: a failed load only
/// warns, on the platform.
fn icon(cx: *mut JsContext, v: JsValue) -> Result<Option<ImageSource>, String> {
    let icon = get(cx, v, c"icon");
    if nullish(icon) {
        return Ok(None);
    }
    // SAFETY: a context reference for the decoder, which reads a live
    // value it owns (its reference given to `Value`).
    let value =
        unsafe { Value::from_raw(Ctx::from_raw(std::ptr::NonNull::new_unchecked(cx)), icon) };
    let empty = value.as_string().is_some_and(|s| {
        // A string that cannot be read is no empty one.
        s.to_string().is_ok_and(|s| s.is_empty())
    });
    let Some(mut source) = crate::protocol::image_source(value) else {
        return match empty {
            true => Ok(None),
            false => Err("an item's `icon` is a URL or an imported image".into()),
        };
    };
    if let Some((uri, data)) = crate::web::blob::resolve_image_url(cx, &source.uri) {
        source.uri = uri;
        source.data = Some(data);
    }
    Ok(Some(source.inline()))
}

/// Decodes menus, keeping their functions.
struct Decoder {
    cx: *mut JsContext,
    mac: bool,
    /// The items' functions (id, owned function).
    functions: Vec<(u32, JsValue)>,
}

impl Decoder {
    /// The items of array `list`.
    fn items(&mut self, list: JsValue) -> Result<Vec<MenuItem>, String> {
        let cx = self.cx;
        // SAFETY: an inline tag check.
        if !unsafe { qjs::JS_IsArray(list) } {
            return Err("a menu is an array of items".into());
        }
        let mut len: i64 = 0;
        // SAFETY: the length of a live array.
        unsafe { qjs::JS_GetLength(cx, list, &mut len) };
        let mut out = Vec::with_capacity(len.max(0) as usize);
        for i in 0..len.max(0) {
            // SAFETY: an element of a live array (owned).
            let v = unsafe { qjs::JS_GetPropertyInt64(cx, list, i) };
            let item = self.item(v);
            free(cx, v);
            if let Some(item) = item? {
                out.push(item);
            }
        }
        Ok(out)
    }

    /// One item; `None` for items that are nothing (`null`, `false`: a
    /// condition left them out).
    fn item(&mut self, v: JsValue) -> Result<Option<MenuItem>, String> {
        let cx = self.cx;
        if !is_object(v) {
            // SAFETY: `ToBoolean` of a live value.
            return if unsafe { qjs::JS_ToBool(cx, v) } == 0 {
                Ok(None)
            } else {
                Err("a menu item is an object".into())
            };
        }
        if string(cx, v, c"type").as_deref() == Some("separator") {
            return Ok(Some(MenuItem::Separator));
        }
        let label = string(cx, v, c"label");
        let enabled = !flag(cx, v, c"disabled").unwrap_or(false);
        let icon = icon(cx, v)?;
        let submenu = get(cx, v, c"submenu");
        if !nullish(submenu) {
            let items = self.items(submenu);
            free(cx, submenu);
            return Ok(Some(MenuItem::Submenu {
                label: label.ok_or("a submenu needs a label")?,
                enabled,
                items: items?,
                icon,
            }));
        }
        let role = match string(cx, v, c"role") {
            Some(name) => {
                Some(menu_role(cx, &name).ok_or_else(|| format!("unknown menu role `{name}`"))?)
            }
            None => None,
        };
        if label.is_none() && role.is_none() {
            return Err("a menu item needs a label or a role".into());
        }
        let shortcut = match string(cx, v, c"shortcut") {
            Some(text) => Some(Shortcut::parse(&text, self.mac).map_err(|e| e.to_string())?),
            None => role.and_then(|r| r.shortcut(self.mac)),
        };
        let when = match string(cx, v, c"when").as_deref() {
            None | Some("always") => When::Always,
            Some("auto") => When::Auto,
            Some("notEditing") => When::NotEditing,
            Some(other) => {
                return Err(format!(
                    "when must be \"always\", \"auto\" or \"notEditing\", not {other:?}"
                ));
            }
        };
        let on_select = get(cx, v, c"onSelect");
        // SAFETY: an inline check.
        let id = if unsafe { qjs::JS_IsFunction(cx, on_select) } {
            let id = next_id(cx);
            self.functions.push((id, on_select));
            id
        } else {
            free(cx, on_select);
            0
        };
        Ok(Some(MenuItem::Action(MenuAction {
            id,
            label: label.unwrap_or_default(),
            shortcut,
            enabled,
            checked: flag(cx, v, c"checked"),
            role,
            when,
            icon,
        })))
    }

    fn free(self) {
        for (_, f) in self.functions {
            free(self.cx, f);
        }
    }
}

/// Decodes `list` into items and their functions; throws on a bad menu.
fn decode(cx: *mut JsContext, list: JsValue) -> Result<(Arc<[MenuItem]>, Functions), JsValue> {
    let mut decoder = Decoder {
        cx,
        mac: os(cx) == Os::MacOs,
        functions: Vec::new(),
    };
    match decoder.items(list) {
        Ok(items) => Ok((items.into(), std::mem::take(&mut decoder.functions))),
        Err(message) => {
            decoder.free();
            Err(throw(cx, &format!("nsh/desktop: {message}")))
        }
    }
}

/// Keeps `functions` in `slot`, freeing the ones they replace.
fn keep(cx: *mut JsContext, slot: &RefCell<Vec<(u32, JsValue)>>, functions: Vec<(u32, JsValue)>) {
    let old = slot.replace(functions);
    for (_, f) in old {
        free(cx, f);
    }
}

fn send(cx: *mut JsContext, command: DesktopCommand) -> Result<(), JsValue> {
    dom::push_op(
        cx,
        Op::Command {
            id: ROOT_ID,
            command: Command::Desktop(Box::new(command)),
        },
    )
}

/// Sets the root's `onMenu` handler, once.
fn listen(cx: *mut JsContext) -> Result<(), JsValue> {
    let m = menus(cx);
    if m.listening.get() {
        return Ok(());
    }
    let on = reactive::new_function(cx, c"onMenu", on_menu, 1);
    let r = dom::set_handler(cx, ROOT_ID, EventKind::Menu, on);
    free(cx, on);
    r?;
    m.listening.set(true);
    Ok(())
}

/// `Menu.setApplicationMenu(items | null)`.
unsafe extern "C" fn set_application_menu(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    if !os(cx).is_desktop() {
        return UNDEFINED;
    }
    let list = arg(argc, argv, 0);
    let result = if nullish(list) {
        keep(cx, &menus(cx).app, Vec::new());
        send(cx, DesktopCommand::SetMenu(None))
    } else {
        match decode(cx, list) {
            Ok((items, functions)) => {
                keep(cx, &menus(cx).app, functions);
                listen(cx).and_then(|()| send(cx, DesktopCommand::SetMenu(Some(items))))
            }
            Err(e) => Err(e),
        }
    };
    result.err().unwrap_or(UNDEFINED)
}

/// `Menu.popup(items, at?)`: a promise, which a wrong item rejects.
unsafe extern "C" fn popup(
    cx: *mut JsContext,
    this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    // SAFETY: QuickJS's arguments, passed on.
    crate::web::js::rejecting(cx, unsafe { popup_menu(cx, this, argc, argv) })
}

/// [`popup`]'s work: its promise, or the exception of what it refuses.
unsafe fn popup_menu(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mut funcs = [UNDEFINED; 2];
    // SAFETY: a new promise and its resolving functions (owned).
    let promise = unsafe { qjs::JS_NewPromiseCapability(cx, funcs.as_mut_ptr()) };
    free(cx, funcs[1]);
    if !os(cx).is_desktop() {
        // Nothing shows: settled at once.
        // SAFETY: an owned resolving function, called then freed.
        unsafe {
            let r = qjs::JS_Call(cx, funcs[0], UNDEFINED, 0, ptr::null_mut());
            qjs::JS_FreeValue(cx, r);
        }
        free(cx, funcs[0]);
        return promise;
    }
    let (items, functions) = match decode(cx, arg(argc, argv, 0)) {
        Ok(decoded) => decoded,
        Err(e) => {
            free(cx, funcs[0]);
            free(cx, promise);
            return e;
        }
    };
    keep(cx, &menus(cx).popup, functions);
    // One context menu at a time: one shown before is closed by now.
    resolve_closed(cx);
    menus(cx).closed.set(funcs[0]);
    let at = arg(argc, argv, 1);
    let at = if is_object(at) {
        let number = |key: &CStr| {
            let v = get(cx, at, key);
            let mut n = 0f64;
            // SAFETY: `ToNumber` of a live value.
            unsafe { qjs::JS_ToFloat64(cx, &mut n, v) };
            free(cx, v);
            n as f32
        };
        Some(point(Points(number(c"x")), Points(number(c"y"))))
    } else {
        None
    };
    match listen(cx).and_then(|()| send(cx, DesktopCommand::PopupMenu { items, at })) {
        Ok(()) => promise,
        Err(e) => {
            free(cx, promise);
            e
        }
    }
}

/// The root's `onMenu`: calls the chosen item's function.
unsafe extern "C" fn on_menu(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let e = arg(argc, argv, 0);
    let v = get(cx, e, c"id");
    let mut id = 0f64;
    // SAFETY: `ToNumber` of a live value.
    unsafe { qjs::JS_ToFloat64(cx, &mut id, v) };
    free(cx, v);
    let id = id as u32;
    // The platform's answer to a global shortcut's registration.
    if let Some(registered) = flag(cx, e, c"registered") {
        let m = menus(cx);
        let resolve = m
            .globals
            .borrow_mut()
            .iter_mut()
            .find(|g| g.id == id)
            .map(|g| std::mem::replace(&mut g.resolve, UNDEFINED));
        if !registered {
            m.globals.borrow_mut().retain(|g| {
                if g.id == id {
                    free(cx, g.on_press);
                }
                g.id != id
            });
        }
        if let Some(resolve) = resolve {
            settle(cx, resolve, registered);
        }
        return UNDEFINED;
    }
    // A context menu closed (after its chosen item was reported).
    if flag(cx, e, c"closed") == Some(true) {
        resolve_closed(cx);
        return UNDEFINED;
    }
    let m = menus(cx);
    let f = [&m.app, &m.popup, &m.tray]
        .into_iter()
        .find_map(|slot| {
            slot.borrow()
                .iter()
                .find(|(i, _)| *i == id)
                // SAFETY: a dup for the call.
                .map(|&(_, f)| unsafe { qjs::JS_DupValue(cx, f) })
        })
        .or_else(|| {
            m.globals
                .borrow()
                .iter()
                .find(|g| g.id == id)
                // SAFETY: a dup for the call.
                .map(|g| unsafe { qjs::JS_DupValue(cx, g.on_press) })
        });
    let Some(f) = f else { return UNDEFINED };
    // SAFETY: a call of an owned function, freed after it.
    unsafe {
        let r = qjs::JS_Call(cx, f, UNDEFINED, 0, ptr::null_mut());
        qjs::JS_FreeValue(cx, f);
        if qjs::JS_IsException(r) {
            return r;
        }
        qjs::JS_FreeValue(cx, r);
    }
    UNDEFINED
}

/// The next id of a menu item, a tray's click or a global shortcut.
fn next_id(cx: *mut JsContext) -> u32 {
    let m = menus(cx);
    let id = m.next.get() + 1;
    m.next.set(id);
    id
}

/// `Tray.set(options | null)`.
unsafe extern "C" fn set_tray(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    if !os(cx).is_desktop() {
        return UNDEFINED;
    }
    let options = arg(argc, argv, 0);
    if nullish(options) {
        keep(cx, &menus(cx).tray, Vec::new());
        return send(cx, DesktopCommand::SetTray(None))
            .err()
            .unwrap_or(UNDEFINED);
    }
    if !is_object(options) {
        return throw(cx, "nsh/desktop: Tray.set takes an object or null");
    }
    let icon = match icon(cx, options) {
        Ok(icon) => icon,
        Err(_) => {
            return throw(
                cx,
                "nsh/desktop: the tray's `icon` is a URL or an imported image",
            );
        }
    };
    let menu = get(cx, options, c"menu");
    let (items, mut functions) = if nullish(menu) {
        free(cx, menu);
        (Arc::from([]), Vec::new())
    } else {
        let decoded = decode(cx, menu);
        free(cx, menu);
        match decoded {
            Ok(decoded) => decoded,
            Err(e) => return e,
        }
    };
    let on_click = get(cx, options, c"onClick");
    // SAFETY: an inline check.
    let click = if unsafe { qjs::JS_IsFunction(cx, on_click) } {
        let id = next_id(cx);
        functions.push((id, on_click));
        id
    } else {
        free(cx, on_click);
        0
    };
    keep(cx, &menus(cx).tray, functions);
    let mut tray = Tray::default();
    tray.icon = icon;
    tray.tooltip = string(cx, options, c"tooltip").unwrap_or_default();
    tray.menu = items;
    tray.click = click;
    listen(cx)
        .and_then(|()| send(cx, DesktopCommand::SetTray(Some(tray))))
        .err()
        .unwrap_or(UNDEFINED)
}

/// `Tray`: an object of its functions.
fn tray(cx: *mut JsContext) -> JsValue {
    // SAFETY: a new object taking the function.
    unsafe {
        let o = qjs::JS_NewObject(cx);
        let set = reactive::new_function(cx, c"set", set_tray, 1);
        qjs::JS_SetPropertyStr(cx, o, c"set".as_ptr(), set);
        o
    }
}

/// The keystroke of argument `i`, or the exception of a wrong one.
fn global_shortcut_arg(
    cx: *mut JsContext,
    argc: c_int,
    argv: *mut JsValue,
    name: &str,
) -> Result<Shortcut, JsValue> {
    let v = arg(argc, argv, 0);
    let text = (!nullish(v)).then(|| dom::string_arg(cx, v)).flatten();
    let Some(text) = text else {
        return Err(throw(
            cx,
            &format!(
                "nsh/desktop: GlobalShortcut.{name} takes a keystroke such as \"mod+shift+k\""
            ),
        ));
    };
    Shortcut::parse(&text, os(cx) == Os::MacOs)
        .map_err(|e| throw(cx, &format!("nsh/desktop: GlobalShortcut.{name}: {e}")))
}

/// Gives back the global shortcuts `remove` picks.
fn unregister_where(cx: *mut JsContext, remove: impl Fn(&Global) -> bool) -> Result<(), JsValue> {
    let removed: Vec<Global> = {
        let mut globals = menus(cx).globals.borrow_mut();
        let (removed, kept) = std::mem::take(&mut *globals).into_iter().partition(&remove);
        *globals = kept;
        removed
    };
    let mut result = Ok(());
    for g in removed {
        result = result.and(send(cx, DesktopCommand::UnregisterGlobalShortcut(g.id)));
        g.free(cx);
    }
    result
}

/// `GlobalShortcut.register(shortcut, onPress)`: a promise of whether the
/// system took it.
unsafe extern "C" fn register_global(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let shortcut = match global_shortcut_arg(cx, argc, argv, "register") {
        Ok(s) => s,
        Err(e) => return e,
    };
    let on_press = arg(argc, argv, 1);
    // SAFETY: an inline check.
    if !unsafe { qjs::JS_IsFunction(cx, on_press) } {
        return throw(
            cx,
            "nsh/desktop: GlobalShortcut.register takes a function to call at each press",
        );
    }
    let mut funcs = [UNDEFINED; 2];
    // SAFETY: a new promise and its resolving functions (owned).
    let promise = unsafe { qjs::JS_NewPromiseCapability(cx, funcs.as_mut_ptr()) };
    free(cx, funcs[1]);
    if !os(cx).is_desktop() {
        settle(cx, funcs[0], false);
        return promise;
    }
    // Registering a keystroke again replaces its function.
    if let Err(e) = unregister_where(cx, |g| g.shortcut == shortcut) {
        settle(cx, funcs[0], false);
        free(cx, promise);
        return e;
    }
    let id = next_id(cx);
    menus(cx).globals.borrow_mut().push(Global {
        id,
        shortcut,
        // SAFETY: a dup kept with the shortcut.
        on_press: unsafe { qjs::JS_DupValue(cx, on_press) },
        resolve: funcs[0],
    });
    match listen(cx)
        .and_then(|()| send(cx, DesktopCommand::RegisterGlobalShortcut { id, shortcut }))
    {
        Ok(()) => promise,
        Err(e) => {
            let _ = unregister_where(cx, |g| g.id == id);
            free(cx, promise);
            e
        }
    }
}

/// `GlobalShortcut.unregister(shortcut)`.
unsafe extern "C" fn unregister_global(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let shortcut = match global_shortcut_arg(cx, argc, argv, "unregister") {
        Ok(s) => s,
        Err(e) => return e,
    };
    unregister_where(cx, |g| g.shortcut == shortcut)
        .err()
        .unwrap_or(UNDEFINED)
}

/// `GlobalShortcut.unregisterAll()`.
unsafe extern "C" fn unregister_all_globals(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    unregister_where(cx, |_| true).err().unwrap_or(UNDEFINED)
}

/// `GlobalShortcut`: an object of its functions.
fn global_shortcut(cx: *mut JsContext) -> JsValue {
    // SAFETY: a new object taking the functions.
    unsafe {
        let o = qjs::JS_NewObject(cx);
        let f = reactive::new_function(cx, c"register", register_global, 2);
        qjs::JS_SetPropertyStr(cx, o, c"register".as_ptr(), f);
        let f = reactive::new_function(cx, c"unregister", unregister_global, 1);
        qjs::JS_SetPropertyStr(cx, o, c"unregister".as_ptr(), f);
        let f = reactive::new_function(cx, c"unregisterAll", unregister_all_globals, 0);
        qjs::JS_SetPropertyStr(cx, o, c"unregisterAll".as_ptr(), f);
        o
    }
}

/// `Menu`: an object of its functions.
fn menu(cx: *mut JsContext) -> JsValue {
    // SAFETY: a new object taking the functions.
    unsafe {
        let o = qjs::JS_NewObject(cx);
        let set = reactive::new_function(cx, c"setApplicationMenu", set_application_menu, 1);
        qjs::JS_SetPropertyStr(cx, o, c"setApplicationMenu".as_ptr(), set);
        let pop = reactive::new_function(cx, c"popup", popup, 2);
        qjs::JS_SetPropertyStr(cx, o, c"popup".as_ptr(), pop);
        let bar = reactive::new_function(cx, c"setMenuBar", set_menu_bar, 1);
        qjs::JS_SetPropertyStr(cx, o, c"setMenuBar".as_ptr(), bar);
        o
    }
}

/// `Menu.setMenuBar(mode)`: when the window's menu bar shows, where the
/// app's window draws one.
unsafe extern "C" fn set_menu_bar(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let mode = crate::dom::string_arg(cx, arg(argc, argv, 0));
    let host = crate::classes::host_outside_calls(cx);
    let mode = mode.and_then(|m| {
        let value = nsh_core::element::JsHost::new_string(&host, &m).ok()?;
        let value = nsh_core::element::JsOwned::new(&host, value);
        <MenuBarMode as nsh_core::element::JsValue>::from_js(value.get()).ok()
    });
    host.clear_pending();
    let Some(mode) = mode else {
        return throw(cx, "Menu.setMenuBar: the mode is \"shown\" or \"autoHide\"");
    };
    match send(cx, DesktopCommand::SetMenuBar(mode)) {
        Ok(()) => UNDEFINED,
        Err(e) => e,
    }
}

/// The hand-written exports of `nsh/desktop` (with the registry's
/// `Application`).
pub(crate) const EXPORTS: &[Item] = &[
    (
        "isAvailable",
        Export::Value(|cx| {
            if os(cx).is_desktop() {
                qjs::JS_TRUE
            } else {
                qjs::JS_FALSE
            }
        }),
        Ts::value(
            "True where this module's window and menu APIs work: macOS, Windows and\nLinux. `platform.desktop` (desktop behavior) also holds in browsers in the\ndesktop idiom, where the browser keeps its own window and menus.",
            "boolean",
        ),
    ),
    (
        "displays",
        Export::Value(crate::env::displays),
        Ts::value(
            "The displays (reactive): their bounds and the parts of them windows\nuse, in points, in screen coordinates. Plugging in a display, unplugging\none or arranging them again changes them. Empty off desktops.",
            "Accessor<Display[]>",
        ),
    ),
    (
        "Window",
        Export::Value(crate::window::window_export),
        Ts::value(
            "A window of the app's own (desktops), rendered from the app's one engine:\nit shares the app's signals, context and theme. Open while `open` is not\nfalse and the user has not closed it (`onOpenChange` tells the app); it\ncloses when it unmounts. `Window.open` is the same imperatively;\n`Window.get` finds an open window by id. Off the desktops `<Window>`\nrenders nothing and `Window.open` throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`.",
            "WindowComponent",
        ),
    ),
    (
        "currentWindow",
        Export::Function(crate::window::current_window, 0),
        Ts::function(
            "The window the calling component renders in: the nearest `<Window>` (or\n`Window.open`'s) around it, else the main window. Call it while\nrendering and keep the `WindowRef`: outside a component (an event\nhandler, a timer, after an `await`) it throws a `TypeError`.",
            &["(): WindowRef"],
        ),
    ),
    (
        "windows",
        Export::Function(crate::window::all_windows, 0),
        Ts::function(
            "The open windows (reactive): the main window, then the app's own in\nthe order they opened.",
            &["(): WindowRef[]"],
        ),
    ),
    (
        "focusedWindow",
        Export::Function(crate::window::focused_window, 0),
        Ts::function(
            "The window with the keyboard focus, or `null` while another app has it\n(reactive).",
            &["(): WindowRef | null"],
        ),
    ),
    (
        "windowState",
        Export::Function(crate::window::window_state, 0),
        Ts::function(
            "The current window's state (reactive): `currentWindow().state()`.\n`null` off desktops.",
            &["(): WindowState | null"],
        ),
    ),
    (
        "titleBar",
        Export::Function(crate::window::title_bar, 0),
        Ts::function(
            "The current window's hidden title bar area, in points (reactive):\n`currentWindow().titleBar()`. All 0 while the system shows its title\nbar, and off desktops.",
            &["(): TitleBarArea"],
        ),
    ),
    (
        "Menu",
        Export::Value(menu),
        Ts::value(
            "The application menu and context menus (desktops; nothing happens\nelsewhere).",
            "MenuModule",
        ),
    ),
    (
        "Tray",
        Export::Value(tray),
        Ts::value(
            "The app's icon in the system tray (desktops; nothing happens elsewhere).",
            "TrayModule",
        ),
    ),
    (
        "GlobalShortcut",
        Export::Value(global_shortcut),
        Ts::value(
            "Keystrokes the app hears whichever app has the keyboard (desktops;\n`register` resolves `false` elsewhere).",
            "GlobalShortcutModule",
        ),
    ),
];

/// `nsh/desktop`'s types (with the registry's).
pub(crate) const TYPES: &str = r#"/** `<Window>`'s props: the window's options and attributes, whether it is
 * open, its content and its events. */
export interface WindowProps extends WindowOptions {
  /** Whether it is open (controlled). Without it, open from the start
   * unless `defaultOpen` is false. */
  open?: boolean;
  /** Whether it is open at first while `open` is not given (default true). */
  defaultOpen?: boolean;
  /** It closed while `open` held: the user's close press (with
   * `closeOnPress`), Escape (`closeOnEscape`), losing the focus
   * (`closeOnBlur`), its parent closing, or the app's `WindowRef.close()`
   * (`"close"`), so a controlled `open` follows. */
  onOpenChange?: (event: { open: boolean; reason: WindowCloseCause }) => void;
  /** The user asked to close it, whether or not `closeOnPress` lets it close. */
  onClosePress?: (event: { reason: CloseReason }) => void;
  /** It gained or lost the keyboard focus. */
  onFocusChange?: (event: { focused: boolean }) => void;
  /** Its mode changed, or it was minimized or restored. */
  onModeChange?: (event: { mode: WindowMode; minimized: boolean }) => void;
  /** It moved or was resized (once the move or resize settles). */
  onBoundsChange?: (event: { bounds: Bounds }) => void;
  /** It moved to another display. */
  onDisplayChange?: (event: { display: Display }) => void;
  /** What it shows; `currentWindow()` in it is this window. */
  children?: JSX.Element;
  /** Takes the window's `WindowRef` once it opens (a variable, a signal or a
   * function); each opening gives a new one. */
  ref?: WindowRef | ((node: WindowRef) => void);
}

/** `Window`: the component, and opening and finding windows imperatively. */
export interface WindowComponent {
  (props: WindowProps): JSX.Element;
  /** Renders `component` in a window of its own and returns it, or returns
   * the open window of the same `id`. Throws `ERR_ACCESS_DENIED`
   * (`permission: "windows"`) when the app's capabilities do not grant
   * the window, and `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` off the
   * desktops. */
  open(component: () => JSX.Element, options: WindowOptions): WindowRef;
  /** The open window with `id` (`"main"`: the main window), or `null`
   * (reactive). */
  get(id: string): WindowRef | null;
}

/** A window: the main window or one of the app's own. Requests return
 * nothing: the platform may decline or adjust them, and `state()` reports
 * what happened. A closed window's requests do nothing. */
export interface WindowRef {
  /** The app's id for it (`"main"`: the main window). */
  readonly id: string;
  /** It is the main window. */
  readonly main: boolean;
  /** The window that owns it, or `null`. */
  readonly parent: WindowRef | null;
  /** What the platform reports of it (reactive); `null` off desktops,
   * before it shows and once it closed. */
  state(): WindowState | null;
  /** Its hidden title bar's area, in points (reactive). */
  titleBar(): TitleBarArea;
  /** Changes the attributes `attributes` sets; the others keep their
   * values. An attribute the app's capabilities do not grant is left as it
   * is, with a warning. */
  set(attributes: Partial<WindowAttributes>): void;
  /** Shows it, restoring it when minimized. */
  show(): void;
  /** Hides it. */
  hide(): void;
  /** Shows it, brings it to the front of its level and focuses it. */
  focus(): void;
  /** Closes it, whatever `closeOnPress` says. */
  close(): void;
  /** Minimizes it. */
  minimize(): void;
  /** Brings it back from being minimized, in the mode it had. */
  restore(): void;
  /** Puts it in `mode`; doing it again changes nothing. */
  setMode(mode: WindowMode): void;
  /** Moves and sizes it, in points, in screen coordinates; fields left out
   * keep their values. */
  setBounds(bounds: { origin?: Partial<Point>; size?: Partial<Size>; animated?: boolean }): void;
  /** Restores a placement saved from `state().placement`, fitted on the
   * displays there are now. */
  setPlacement(placement: WindowPlacement): void;
  /** Centers it on `display` (its own without it). */
  center(options?: { display?: DisplayId }): void;
  /** Asks for the user's attention (the Dock's icon bounces, the taskbar
   * button flashes); `critical` until the user activates the app. */
  requestAttention(options?: { critical?: boolean }): void;
  /** Listens to it; returns a function that stops. A listener registered
   * while a component renders goes with the component. */
  on(event: "closePress", listener: (event: { reason: CloseReason }) => void): () => void;
  on(event: "close", listener: () => void): () => void;
  on(event: "focusChange", listener: (event: { focused: boolean }) => void): () => void;
  on(event: "modeChange", listener: (event: { mode: WindowMode; minimized: boolean }) => void): () => void;
  on(event: "boundsChange", listener: (event: { bounds: Bounds }) => void): () => void;
  on(event: "displayChange", listener: (event: { display: Display }) => void): () => void;
}

/** What the platform reports of a window. Rectangles are in points, in
 * screen coordinates: from the primary display's top left corner, `y`
 * growing down. */
export interface WindowState {
  /** Its mode (minimized apart). */
  mode: WindowMode;
  /** It is minimized (in the Dock, the taskbar). */
  minimized: boolean;
  /** It is on the screen (not hidden, not minimized). */
  visible: boolean;
  /** It has the keyboard focus. */
  focused: boolean;
  /** Its outer frame now, window decorations included. */
  bounds: Bounds;
  /** Its content area now. */
  contentBounds: Bounds;
  /** Its mode and windowed bounds: what to save, and give to
   * `setPlacement`, to open it the same way next time. */
  placement: WindowPlacement;
  /** The display it is on (the one with most of it). */
  display: Display | null;
  /** Device pixels per point. */
  scaleFactor: number;
}

/** A hidden title bar's area, in points. */
export interface TitleBarArea {
  /** Its height. */
  height: number;
  /** The width the window controls take at its left end (macOS). */
  left: number;
  /** The width the window controls take at its right end (Windows, GTK). */
  right: number;
}

/** A standard menu item: the platform carries it out, and labels it when the
 * item has no label (macOS adds the app's name to `about`, `hide` and
 * `quit`). The editing roles act on the focused text field and keep its own
 * shortcuts. `about`, `hide`, `hideOthers` and `showAll` are macOS's: left
 * out elsewhere. */
export type MenuRole =
  | "about"
  | "hide"
  | "hideOthers"
  | "showAll"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "minimize"
  | "zoom"
  | "toggleFullScreen"
  | "close";

/** An item of a menu: a separator, a submenu, or an item that calls
 * `onSelect` (or carries out its `role`). `null`, `undefined` and `false`
 * items are left out (`cond && { … }`). */
export type MenuItem =
  | { type: "separator" }
  | {
      /** What it shows (a role's own label without it). */
      label?: string;
      /** A standard item. */
      role?: MenuRole;
      /** Its shortcut: modifiers and a key joined by `+`, in any case
       * (lowercase is the recommended style; a capital letter is the same
       * key, not Shift):
       * `"mod+n"`, `"mod+shift+z"`, `"alt+f4"`, `"f11"`. `mod` (`cmdorctrl`)
       * is Command on macOS and Control elsewhere; `cmd` (`command`,
       * `meta`, `super`, `win`), `ctrl` (`control`), `alt` (`option`,
       * `opt`), `shift`. Keys: the character a key types on the US layout
       * without Shift (`n`, `1`, `,`, `/`; `"shift+/"` for `?`), `plus`
       * (`=`), `minus` (`-`), `space`, `enter`, `escape`, `tab`,
       * `backspace`, `delete`, `insert`, `up`, `down`, `left`, `right`,
       * `home`, `end`, `pageup`, `pagedown`, `f1`–`f24`: the keystrokes of
       * `nsh/keymap`. A role has its platform's by default. */
      shortcut?: string;
      /** When its shortcut chooses it while a text field has the keyboard
       * focus: `"always"` (the default), `"auto"` (unless the field uses
       * the keystroke itself: keys that type, move the caret or delete,
       * and the editing shortcuts, as `nsh/keymap`'s bindings) or
       * `"notEditing"` (never). A key the item leaves goes to the field.
       * On the GPUI backend. */
      when?: "always" | "auto" | "notEditing";
      /** It cannot be chosen: shown dimmed (default false). */
      disabled?: boolean;
      /** A check mark: set (true or false) for a checkable item. */
      checked?: boolean;
      /** Called when it is chosen (by a click or its shortcut). */
      onSelect?: () => void;
      /** The image beside its label, as `<Image>`'s `src` takes it (an
       * imported file, or a URL such as a `data:` one), so that an app's menus
       * show its own icon set on every platform. It is fitted in the menu's
       * icon size (16 points on macOS, the small icon size at the window's
       * DPI on Windows) and drawn for the screen. An SVG is a template: only
       * its shape counts, in the color of the menu's text, whatever that is
       * (dark mode, a selected or disabled item); a bitmap keeps its colors.
       * It loads off the main thread, so a menu never blocks on it and the
       * icon shows once it has loaded (a context menu on Windows gives it
       * up to 100ms before opening); one that fails to load leaves the item
       * without an icon and logs a warning. The top-level menus of a
       * menu bar show their titles alone, and so do GPUI's native menus on
       * macOS. GTK's menus show no icon beside a label: GTK draws a menu
       * item's icon only when it has no text. A terminal shows no images. */
      icon?: ImageAsset | string;
      /** Its items: makes it a submenu (`label` is required). */
      submenu?: readonly (MenuItem | null | undefined | false)[];
    };

/** The application menu and context menus. */
export interface MenuModule {
  /** Sets the application menu, a submenu per top-level item (`File`,
   * `Edit`, …): macOS's menu bar, whose first menu is the app menu (titled
   * with the app's name), or the window's menu bar on Windows and Linux,
   * which is not shown while the title bar is hidden (its shortcuts still
   * work: show its menus with `Menu.popup` from a title bar of the app's
   * own). Call it again to change it (in an `effect`, it follows the
   * signals it reads); `null` restores the platform's default menu. */
  setApplicationMenu(items: readonly (MenuItem | null | undefined | false)[] | null): void;
  /** When the window's menu bar shows on Windows and Linux where the app's
   * window draws the application menu as a bar (the GPUI backend):
   * `"shown"` (the default) always; `"autoHide"` only after Alt is pressed
   * and released alone, until Alt alone hides it again. F10 and Alt with a
   * menu's initial open a menu either way. macOS's menu bar is the
   * system's. */
  setMenuBar(mode: "shown" | "autoHide"): void;
  /** Shows a context menu with its top left corner at `at` (the window's
   * coordinates, points: `Menu.popup(items, e.pagePosition)` in an
   * `onContextMenu`), else at the pointer. The promise resolves once
   * the menu closes, chosen or dismissed: a button that opened it can look
   * pressed until then. */
  popup(items: readonly (MenuItem | null | undefined | false)[], at?: Point): Promise<void>;
}

/** The app's icon in the system tray. */
export interface TrayOptions {
  /** The icon, as `<Image>`'s `src` takes it (an imported file, or a URL).
   * Keep it simple and square: panels draw it at 16 to 24 pixels. An SVG is
   * a template on macOS, drawn in the menu bar's text color; elsewhere it
   * keeps its colors. Without one, the app's icon where the system has
   * one. */
  icon?: ImageAsset | string;
  /** Shown when the pointer rests on the icon (the app's name without it). */
  tooltip?: string;
  /** Its menu, opened by a secondary click (and a primary one without
   * `onClick`). */
  menu?: readonly (MenuItem | null | undefined | false)[];
  /** Called when the icon is clicked with the primary button. */
  onClick?: () => void;
}

/** The app's icon in the system tray: the notification area on Windows, the
 * menu bar's right side on macOS, a StatusNotifierItem on Linux (Plasma,
 * Waybar and most panels; GNOME needs the AppIndicator extension). */
export interface TrayModule {
  /** Shows the icon, or changes it (in an `effect`, it follows the signals
   * it reads); `null` removes it. One per app. */
  set(options: TrayOptions | null): void;
}

/** Keystrokes the app hears whichever app has the keyboard. */
export interface GlobalShortcutModule {
  /** Registers `shortcut` (a keystroke as a menu item's `shortcut`:
   * `"mod+shift+k"`) and calls `onPress` at each press. Resolves with
   * whether the system took it: `false` when another app holds it, or off
   * desktops. On Linux it goes through the desktop portal
   * (`org.freedesktop.portal.GlobalShortcuts`): the desktop may ask the user
   * to confirm it or let them pick another keystroke, and Hyprland binds it
   * in its own configuration (`bind = …, global, <app id>:<shortcut>`).
   * Registering a keystroke again replaces its function. */
  register(shortcut: string, onPress: () => void): Promise<boolean>;
  /** Gives back `shortcut`. */
  unregister(shortcut: string): void;
  /** Gives back every shortcut the app registered. */
  unregisterAll(): void;
}
"#;

#[cfg(test)]
mod tests {
    use nsh_core::{desktop::MenuRole, element::JsValue as _};

    /// `MenuRole`'s declaration (written here, with the docs of each role)
    /// names the roles the Rust type reads.
    #[test]
    fn menu_roles_are_declared() {
        let declared = super::TYPES
            .split("export type MenuRole =")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .expect("MenuRole's declaration");
        let mut names: Vec<String> = declared
            .split('|')
            .map(|n| n.trim().trim_matches('"').to_owned())
            .filter(|n| !n.is_empty())
            .collect();
        let host = crate::Host::new().unwrap();
        let mut roles: Vec<String> = host.with_raw(|cx| {
            let js = crate::classes::host_outside_calls(cx);
            MenuRole::ALL
                .iter()
                .map(|r| r.to_js(&js).unwrap().get().as_string().unwrap())
                .collect()
        });
        names.sort();
        roles.sort();
        assert_eq!(names, roles);
    }
}

//! Navigation and dialogs: `createNavStack`, `NavStack`, `NavPage` and
//! `Dialog` (`nsh/base` exports them: `Registry::native_values`).
//!
//! A stack renders each route of its state with the app's function into a
//! native page (UINavigationController on iOS, a stack with a toolbar on
//! Android); pages stay mounted while their route is in the stack. A page
//! the user pops natively removes its route. Pages and dialogs provide
//! their insets to what they render (`safeAreaInsets`).
//!
//! NSH draws no look of its own: the desktops and the web show a page's
//! `header` slot at its top (the core places it) and nothing else; a
//! dialog renders the app's popup and, when styled, its backdrop, inside a
//! native layer that has no look either.
//!
//! The handlers of a page's and a dialog's native events are the
//! runtime's: they keep the stack in step and call the app's props
//! (`onDismiss`, `onBackPress`, `onOpen`, `onClose`, `onCancel`,
//! `onOpenChange`), so the app's names are not the core's events'.

use std::{
    ffi::{CStr, CString, c_int},
    ptr,
};

use nsh_core::{EventKind, Tag};
use rquickjs::qjs;

use crate::{
    dom,
    modules::{Export, Item, Ts},
    reactive::{self, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

type DataFn = unsafe extern "C" fn(
    *mut JsContext,
    JsValue,
    c_int,
    *mut JsValue,
    c_int,
    *mut JsValue,
) -> JsValue;

fn native(cx: *mut JsContext, f: DataFn, length: c_int, data: &mut [JsValue]) -> JsValue {
    // SAFETY: the function keeps dups of `data`.
    unsafe {
        qjs::JS_NewCFunctionData(
            cx,
            Some(f),
            length,
            0,
            data.len() as c_int,
            data.as_mut_ptr(),
        )
    }
}

fn get(cx: *mut JsContext, obj: JsValue, key: &CStr) -> JsValue {
    // SAFETY: a property read of a live value.
    unsafe {
        if !qjs::JS_IsObject(obj) {
            return UNDEFINED;
        }
        qjs::JS_GetPropertyStr(cx, obj, key.as_ptr())
    }
}

fn free(cx: *mut JsContext, v: JsValue) {
    // SAFETY: an owned value.
    unsafe { qjs::JS_FreeValue(cx, v) };
}

/// `nsh/base`'s navigation and dialogs (its `Registry::native_values`).
pub(crate) const EXPORTS: &[Item] = &[
    (
        "createNavStack",
        Export::Function(create_nav_stack, 1),
        Ts::function(
            "The state of a `<NavStack>`: its routes, starting with `routes`.",
            &["<R>(routes: R[]): NavStackState<R>"],
        ),
    ),
    (
        "NavStack",
        Export::Function(stack, 1),
        Ts::function(
            "A native navigation stack: UINavigationController on iOS (swipe back,\nnative header), a stack with a toolbar and predictive back on Android.\nPages stay mounted (with their state) while they are in the stack.",
            &["<R>(props: NavStackProps<R>): JSX.Element"],
        ),
    ),
    (
        "NavPage",
        Export::Function(screen, 1),
        Ts::function(
            "One page of a `<NavStack>`: its `header` (desktops, the web) and the system\nheader's options (iOS, Android).",
            &["(props: NavPageProps): JSX.Element"],
        ),
    ),
    (
        "Dialog",
        Export::Function(modal, 1),
        Ts::function(
            "A modal surface over everything else, in its own native window layer\n(`presentation` picks its form on iOS). It owns no look: `class` and `style`\nstyle the popup, `backdropClass` and `backdropStyle` a backdrop behind it.",
            &["(props: DialogProps): JSX.Element"],
        ),
    ),
];

/// The types of the navigation's exports.
pub(crate) const TYPES: &str = r#"/** The routes of a `<NavStack>`: the app's values; each push is a page of its own, the same route pushed twice included. */
export interface NavStackState<R> {
  /** The routes, bottom to top (reactive). */
  routes: Accessor<readonly R[]>;
  /** Pushes a page. */
  push(route: R): void;
  /** Pops `count` pages (default 1; at least one stays). */
  pop(count?: number): void;
  /** Pops back to the first page. */
  popToRoot(): void;
  /** Replaces the top page. */
  replace(route: R): void;
  /** Replaces the pages with `routes`; a route that stays (the same value)
   * keeps its page and its state. */
  setRoutes(routes: R[]): void;
  /** Removes the topmost page of `route`, wherever it is. */
  remove(route: R): void;
}

export interface NavStackProps<R> {
  state: NavStackState<R>;
  /** Finds the stack in tests and `nsh test --trace`. */
  testID?: string;
  style?: StyleProp<ViewStyle>;
  class?: string;
  /** Renders a route; return a `<NavPage>` for header options. */
  children: (route: R, index: Accessor<number>) => JSX.Element;
}

/** The color of the status bar's content. */
export type StatusBarForeground = "auto" | "light" | "dark";

/** What the status bar shows while a page or dialog is up (`statusBar`; iOS
 * and Android). The fields left out keep what is below: the pages under it
 * and the app's default (`nsh.json` `statusBar`). */
export interface StatusBar {
  /** The content's color: "light" for dark backgrounds, "dark" for light ones, "auto" the platform's for the appearance. */
  foreground?: StatusBarForeground;
  /** Hidden. */
  hidden?: boolean;
  /** Animate the change when the page or dialog comes and goes. */
  animated?: boolean;
}

/** The colors of a page's system header (iOS and Android). */
export interface HeaderStyle {
  backgroundColor?: ColorValue;
  /** The title's. */
  color?: ColorValue;
  /** The back button's and the bar buttons'. */
  tintColor?: ColorValue;
}

export interface NavPageProps extends NavPageHostProps {
  /** Finds the page in tests and `nsh test --trace`. */
  testID?: string;
  ios?: IOSNavPageHostProps;
  /** The app's header on the desktops and the web, which have no system
   * header: placed at the top of the page, as wide as the page and as tall
   * as it lays out, with the content below it. NSH draws nothing else
   * there (no title, no back button); iOS and Android show their system
   * header instead. */
  header?: JSX.Element;
  /** iOS and Android: the system header's leading item. */
  headerLeft?: JSX.Element;
  /** iOS and Android: the system header's trailing item. */
  headerRight?: JSX.Element;
  /** iOS and Android: replaces the system header's title. */
  headerTitle?: JSX.Element;
  /** iOS and Android: the system header's colors. */
  headerStyle?: HeaderStyle;
  /** iOS and Android: the system header's colors as classes (`bg-*`,
   * `text-*` for the title, `tint-*` for the buttons); `headerStyle` wins
   * over them. */
  headerClass?: string;
  /** The user popped the page (back button, swipe); its route is gone. */
  onDismiss?: () => void;
  /** The user pressed back on the page (the header's back button, Android
   * back, Escape / Alt+Left / the mouse's back button on the desktops, the
   * browser's back), whether or not `popOnBack` let it pop. */
  onBackPress?: () => void;
  style?: StyleProp<ViewStyle>;
  class?: string;
  children?: JSX.Element;
}

/** What closed a dialog: Escape or the back button (`"cancel"`), a press
 * on its backdrop part, a sheet swiped down. */
export type DialogChangeReason = "cancel" | "backdropPress" | "swipe";

export interface DialogProps extends DialogHostProps {
  /** Finds the dialog in tests and `nsh test --trace`. */
  testID?: string;
  /** Shown while true (default). */
  open?: boolean;
  /** How it comes in and goes (default `"slide"`). */
  animation?: "slide" | "fade" | "none";
  /** It finished appearing. */
  onOpen?: () => void;
  /** It went away: the user closed it, or the app removed it. */
  onClose?: () => void;
  /** The user tried to close it (Escape, back, a backdrop press, a swipe
   * down), whether or not a `closeOn*` flag let it close. */
  onCancel?: () => void;
  /** The user closed it (the `closeOn*` flag of what they did let it
   * close): it closes whatever `open` says, so keep `open` in sync (set it
   * to false here); while `open` stays true it stays closed, and it opens
   * again when `open` goes from false to true. */
  onOpenChange?: (event: { open: boolean; reason: DialogChangeReason }) => void;
  /** The popup's style: the view holding the children. The dialog itself
   * has no look: on the desktops and the web it is a transparent layer over
   * the window (`presentation` is ignored there). */
  style?: StyleProp<ViewStyle>;
  /** The popup's classes. */
  class?: string;
  /** The backdrop's style: with this or `backdropClass`, a view filling the
   * dialog behind the popup (none otherwise), whose presses are close
   * attempts (`"backdropPress"`, closing when `closeOnBackdropPress`). */
  backdropStyle?: StyleProp<ViewStyle>;
  /** The backdrop's classes (see `backdropStyle`). */
  backdropClass?: string;
  /** Finds the backdrop in tests and `nsh test --trace`. */
  backdropTestID?: string;
  children?: JSX.Element;
  ios?: IOSDialogHostProps;
  android?: AndroidDialogHostProps;
}
"#;

// --- The navigator --------------------------------------------------------------

/// The routes (a JS array) as values (owned).
fn routes_of(cx: *mut JsContext, routes: JsValue) -> Vec<JsValue> {
    let mut len: i64 = 0;
    let mut out = Vec::new();
    // SAFETY: reads of a live array.
    unsafe {
        if !qjs::JS_IsArray(routes) || qjs::JS_GetLength(cx, routes, &mut len) != 0 {
            return out;
        }
        for i in 0..len.max(0) {
            out.push(qjs::JS_GetPropertyInt64(cx, routes, i));
        }
    }
    out
}

/// `createNavStack(routes)`: the route stack of a `<NavStack>`.
unsafe extern "C" fn create_nav_stack(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let initial = arg(argc, argv, 0);
    // SAFETY: an inline tag check.
    if !unsafe { qjs::JS_IsArray(initial) } {
        // SAFETY: throwing in the calling context.
        return unsafe {
            qjs::JS_ThrowTypeError(cx, c"createNavStack: an array of routes".as_ptr())
        };
    }
    let mut entries: Vec<JsValue> = routes_of(cx, initial)
        .into_iter()
        .map(|route| entry(cx, route))
        .collect();
    // SAFETY: a new array taking the entries.
    let entries = unsafe { qjs::JS_NewArrayFrom(cx, entries.len() as c_int, entries.as_mut_ptr()) };
    let signal = reactive::new_signal(cx, entries);
    free(cx, entries);
    // SAFETY: a new object taking the functions.
    let nav = unsafe { qjs::JS_NewObject(cx) };
    let methods: [(&CStr, c_int, c_int); 6] = [
        (c"push", 1, 0),
        (c"pop", 1, 1),
        (c"popToRoot", 0, 2),
        (c"replace", 1, 3),
        (c"setRoutes", 1, 4),
        (c"remove", 1, 5),
    ];
    for (name, length, magic) in methods {
        let mut data = [signal];
        // SAFETY: the function keeps a dup of the signal; the object takes it.
        unsafe {
            let f =
                qjs::JS_NewCFunctionData(cx, Some(navigate), length, magic, 1, data.as_mut_ptr());
            qjs::JS_SetPropertyStr(cx, nav, name.as_ptr(), f);
        }
    }
    // `routes`: a read-only accessor.
    let read = native(cx, read_routes, 0, &mut [signal]);
    let routes = reactive::memo(cx, read, false);
    // SAFETY: the object takes the accessor and the signal, the latter
    // hidden (not enumerable, not writable): `<NavStack>` renders its entries.
    unsafe {
        qjs::JS_SetPropertyStr(cx, nav, c"routes".as_ptr(), routes);
        qjs::JS_DefinePropertyValueStr(cx, nav, ENTRIES.as_ptr(), signal, 0);
    }
    nav
}

/// The hidden property of a navigator holding its entries' signal.
const ENTRIES: &CStr = c"__nshEntries";

/// One screen of a navigator: an object of its own around the route, so a
/// route pushed twice is two screens, and the user popping one removes
/// that one (takes `route`).
fn entry(cx: *mut JsContext, route: JsValue) -> JsValue {
    // SAFETY: a new object taking the route.
    unsafe {
        let entry = qjs::JS_NewObject(cx);
        qjs::JS_SetPropertyStr(cx, entry, c"route".as_ptr(), route);
        entry
    }
}

/// The route of an entry (owned).
fn route_of(cx: *mut JsContext, entry: JsValue) -> JsValue {
    get(cx, entry, c"route")
}

unsafe extern "C" fn read_routes(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value: the entries' signal.
    let entries = unsafe { qjs::JS_Call(cx, *data, UNDEFINED, 0, ptr::null_mut()) };
    let mut routes: Vec<JsValue> = routes_of(cx, entries)
        .into_iter()
        .map(|e| {
            let route = route_of(cx, e);
            free(cx, e);
            route
        })
        .collect();
    free(cx, entries);
    // SAFETY: a new array taking the routes.
    unsafe { qjs::JS_NewArrayFrom(cx, routes.len() as c_int, routes.as_mut_ptr()) }
}

/// The stack state's functions, by magic: push, pop, popToRoot, replace,
/// setRoutes, remove; 6: remove one entry (the user popped its page).
unsafe extern "C" fn navigate(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (the signal); values got are freed or moved.
    let signal = unsafe { *data };
    let current = reactive::peek(cx, signal);
    let mut routes = routes_of(cx, current);
    let a0 = arg(argc, argv, 0);
    let dup = |v: JsValue| unsafe { qjs::JS_DupValue(cx, v) };
    match magic {
        0 => routes.push(entry(cx, dup(a0))),
        1 => {
            let mut count = 1f64;
            // SAFETY: converting a live value.
            if !unsafe { qjs::JS_IsUndefined(a0) } {
                unsafe { qjs::JS_ToFloat64(cx, &mut count, a0) };
            }
            let keep = routes.len().saturating_sub(count.max(0.0) as usize).max(1);
            for v in routes.drain(keep.min(routes.len())..) {
                free(cx, v);
            }
        }
        2 => {
            for v in routes.drain(1.min(routes.len())..) {
                free(cx, v);
            }
        }
        3 => {
            if let Some(v) = routes.pop() {
                free(cx, v);
            }
            routes.push(entry(cx, dup(a0)));
        }
        4 => {
            // A route that stays keeps its page (its entry), in order: the
            // first unused entry of the same route.
            let mut old: Vec<Option<JsValue>> = routes.drain(..).map(Some).collect();
            routes = routes_of(cx, a0)
                .into_iter()
                .map(|route| {
                    let kept = old.iter_mut().find(|slot| {
                        slot.is_some_and(|e| {
                            let r = route_of(cx, e);
                            // SAFETY: an identity comparison of live values.
                            let same = unsafe { qjs::JS_IsStrictEqual(cx, r, route) };
                            free(cx, r);
                            same
                        })
                    });
                    match kept.and_then(Option::take) {
                        Some(e) => {
                            free(cx, route);
                            e
                        }
                        None => entry(cx, route),
                    }
                })
                .collect();
            for e in old.into_iter().flatten() {
                free(cx, e);
            }
        }
        5 => {
            // The topmost screen showing the route.
            let at = routes.iter().rposition(|&e| {
                let route = route_of(cx, e);
                // SAFETY: an identity comparison of live values.
                let same = unsafe { qjs::JS_IsStrictEqual(cx, route, a0) };
                free(cx, route);
                same
            });
            if let Some(at) = at {
                free(cx, routes.remove(at));
            }
        }
        _ => {
            // SAFETY: identity comparisons of live values.
            if let Some(at) = routes
                .iter()
                .position(|&e| unsafe { qjs::JS_IsStrictEqual(cx, e, a0) })
            {
                free(cx, routes.remove(at));
            }
        }
    }
    // SAFETY: a new array taking the routes.
    let next = unsafe { qjs::JS_NewArrayFrom(cx, routes.len() as c_int, routes.as_mut_ptr()) };
    reactive::set_signal(cx, signal, next);
    reactive::finish_value(cx, UNDEFINED)
}

// --- Stack ------------------------------------------------------------------------

/// `<NavStack state>{(route, index) => <NavPage …>}</NavStack>`.
unsafe extern "C" fn stack(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let props = arg(argc, argv, 0);
    let node = match dom::create_element(cx, Tag::Stack) {
        Ok(node) => node,
        Err(e) => return e,
    };
    let result = (|| -> Result<(), JsValue> {
        dom::spread_except(cx, node, props, &["state", "children"])?;
        let navigator = get(cx, props, c"state");
        let entries = get(cx, navigator, ENTRIES);
        free(cx, navigator);
        let render = native(cx, stack_row, 2, &mut [props]);
        // SAFETY: `each(entries, render)`: a row per pushed screen.
        let mut args = [entries, render];
        let rows = unsafe { crate::dom::each(cx, UNDEFINED, 2, args.as_mut_ptr()) };
        free(cx, entries);
        free(cx, render);
        // SAFETY: an inline tag check.
        if unsafe { qjs::JS_IsException(rows) } {
            return Err(rows);
        }
        let r = dom::insert_value_at(cx, node, rows, None);
        free(cx, rows);
        r
    })();
    match result {
        Ok(()) => reactive::finish_value(cx, node),
        Err(e) => {
            free(cx, node);
            e
        }
    }
}

/// One route of a stack: its screen (the app's `<NavPage>`, or one around
/// what it rendered); a native pop removes the route.
unsafe extern "C" fn stack_row(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (the stack's props); `item` is an accessor.
    let props = unsafe { *data };
    let (item, index) = (arg(argc, argv, 0), arg(argc, argv, 1));
    let entry = reactive::untracked_with(cx, || unsafe {
        qjs::JS_Call(cx, item, UNDEFINED, 0, ptr::null_mut())
    });
    let route = route_of(cx, entry);
    let children = get(cx, props, c"children");
    let mut args = [route, index];
    // SAFETY: the app's function, called untracked.
    let rendered = reactive::untracked_with(cx, || unsafe {
        qjs::JS_Call(cx, children, UNDEFINED, 2, args.as_mut_ptr())
    });
    free(cx, children);
    // SAFETY: an inline tag check.
    free(cx, route);
    if unsafe { qjs::JS_IsException(rendered) } {
        free(cx, entry);
        return rendered;
    }
    let navigator = get(cx, props, c"state");
    let entries = get(cx, navigator, ENTRIES);
    free(cx, navigator);
    let popped = native(cx, pop_route, 0, &mut [entries, entry]);
    free(cx, entries);
    free(cx, entry);
    // An accessor (e.g. a component made hot) may render another screen
    // later.
    let result =
        if unsafe { qjs::JS_IsFunction(cx, rendered) } && dom::node_id(cx, rendered).is_none() {
            let wrap = native(cx, screen_of_accessor, 0, &mut [rendered, popped]);
            reactive::memo(cx, wrap, false)
        } else {
            screen_for(cx, rendered, popped)
        };
    free(cx, rendered);
    free(cx, popped);
    result
}

unsafe extern "C" fn pop_route(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values: the navigator's entries and the entry.
    let mut args = [unsafe { *data.add(1) }];
    // SAFETY: `navigate` removing that entry (magic 6) from the signal.
    unsafe { navigate(cx, UNDEFINED, 1, args.as_mut_ptr(), 6, data) }
}

unsafe extern "C" fn screen_of_accessor(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values: the accessor and the pop callback.
    let (accessor, popped) = unsafe { (*data, *data.add(1)) };
    let rendered = unsafe { qjs::JS_Call(cx, accessor, UNDEFINED, 0, ptr::null_mut()) };
    if unsafe { qjs::JS_IsException(rendered) } {
        return rendered;
    }
    let r = reactive::untracked_with(cx, || screen_for(cx, rendered, popped));
    free(cx, rendered);
    r
}

/// The screen for what a route rendered (borrowed): itself when it is one,
/// else a screen around it; told about native pops (`popped`).
fn screen_for(cx: *mut JsContext, rendered: JsValue, popped: JsValue) -> JsValue {
    let node = if dom::node_tag(cx, rendered) == Some(Tag::Screen) {
        // SAFETY: a dup returned.
        unsafe { qjs::JS_DupValue(cx, rendered) }
    } else {
        // SAFETY: new props for a screen around the content.
        let props = unsafe { qjs::JS_NewObject(cx) };
        unsafe {
            qjs::JS_SetPropertyStr(
                cx,
                props,
                c"children".as_ptr(),
                qjs::JS_DupValue(cx, rendered),
            );
        }
        let mut args = [props];
        let node = unsafe { screen(cx, UNDEFINED, 1, args.as_mut_ptr()) };
        free(cx, props);
        node
    };
    // SAFETY: an inline tag check.
    if !unsafe { qjs::JS_IsException(node) } {
        dom::set_popped(cx, node, popped);
    }
    node
}

// --- Screen -------------------------------------------------------------------------

/// The insets a screen or modal reports, with `initial` until it does:
/// `[insets accessor, onInsets handler]` (owned).
fn native_insets(cx: *mut JsContext, top_zero: bool) -> (JsValue, JsValue) {
    let reported = reactive::new_signal(cx, qjs::JS_NULL);
    let read = native(
        cx,
        read_insets,
        0,
        &mut [
            reported,
            if top_zero {
                qjs::JS_TRUE
            } else {
                qjs::JS_FALSE
            },
        ],
    );
    let insets = reactive::memo(cx, read, false);
    let on = native(cx, on_insets, 1, &mut [reported]);
    free(cx, reported);
    (insets, on)
}

unsafe extern "C" fn read_insets(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values: the reported insets signal and whether the
    // top is the header's (0 until reported).
    unsafe {
        let (reported, top_zero) = (*data, qjs::JS_ToBool(cx, *data.add(1)) == 1);
        let v = qjs::JS_Call(cx, reported, UNDEFINED, 0, ptr::null_mut());
        if qjs::JS_IsException(v) || !qjs::JS_IsNull(v) {
            return v;
        }
        let safe_area = crate::env::reexport(cx, "safeArea");
        let area = qjs::JS_Call(cx, safe_area, UNDEFINED, 0, ptr::null_mut());
        qjs::JS_FreeValue(cx, safe_area);
        if !top_zero || qjs::JS_IsException(area) {
            return area;
        }
        let copy = qjs::JS_NewObject(cx);
        for key in [c"right", c"bottom", c"left"] {
            qjs::JS_SetPropertyStr(cx, copy, key.as_ptr(), get(cx, area, key));
        }
        qjs::JS_SetPropertyStr(cx, copy, c"top".as_ptr(), qjs::JS_NewFloat64(0.0));
        qjs::JS_FreeValue(cx, area);
        copy
    }
}

unsafe extern "C" fn on_insets(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (the signal); a copy of the event's insets.
    unsafe {
        let e = arg(argc, argv, 0);
        let copy = qjs::JS_NewObject(cx);
        for key in [c"top", c"right", c"bottom", c"left"] {
            qjs::JS_SetPropertyStr(cx, copy, key.as_ptr(), get(cx, e, key));
        }
        reactive::set_signal(cx, *data, copy);
    }
    reactive::finish_value(cx, UNDEFINED)
}

/// What a provider of the insets context renders: `children` (a reader
/// of the app's props) with `insets`.
fn with_insets(cx: *mut JsContext, insets: JsValue, children: JsValue) -> JsValue {
    let context = crate::env::insets_context(cx);
    let provider = get(cx, context, c"Provider");
    // SAFETY: provider props: the value, and the children as a getter.
    unsafe {
        let props = qjs::JS_NewObject(cx);
        qjs::JS_SetPropertyStr(cx, props, c"value".as_ptr(), qjs::JS_DupValue(cx, insets));
        let atom = qjs::JS_NewAtom(cx, c"children".as_ptr());
        qjs::JS_DefineProperty(
            cx,
            props,
            atom,
            UNDEFINED,
            children,
            UNDEFINED,
            (qjs::JS_PROP_HAS_GET | qjs::JS_PROP_HAS_ENUMERABLE | qjs::JS_PROP_ENUMERABLE) as c_int,
        );
        qjs::JS_FreeAtom(cx, atom);
        let mut args = [props];
        let r = qjs::JS_Call(cx, provider, UNDEFINED, 1, args.as_mut_ptr());
        qjs::JS_FreeValue(cx, props);
        qjs::JS_FreeValue(cx, provider);
        r
    }
}

/// A getter of `props[key]`.
fn reader(cx: *mut JsContext, props: JsValue, key: &str) -> JsValue {
    // SAFETY: a new string the function keeps a dup of.
    let k = unsafe { qjs::JS_NewStringLen(cx, key.as_ptr().cast(), key.len() as _) };
    let f = native(cx, read_prop, 0, &mut [props, k]);
    free(cx, k);
    f
}

unsafe extern "C" fn read_prop(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (props, key).
    unsafe {
        let Some(key) = dom::string_arg(cx, *data.add(1)) else {
            return qjs::JS_EXCEPTION;
        };
        let k = CString::new(key).unwrap_or_default();
        get(cx, *data, &k)
    }
}

/// `<NavPage title … header headerLeft headerRight headerTitle>`: one page
/// of a stack, with its header options.
unsafe extern "C" fn screen(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let props = arg(argc, argv, 0);
    let node = match dom::create_element(cx, Tag::Screen) {
        Ok(node) => node,
        Err(e) => return e,
    };
    let result = (|| -> Result<(), JsValue> {
        dom::spread_except(
            cx,
            node,
            props,
            &[
                "children",
                "header",
                "headerLeft",
                "headerRight",
                "headerTitle",
                "onDismiss",
                "onBackPress",
                "onInsets",
            ],
        )?;
        let (insets, on_insets) = native_insets(cx, true);
        let id = dom::node_id(cx, node).expect("a node");
        let r = dom::set_handler(cx, id, EventKind::Insets, on_insets);
        free(cx, on_insets);
        r?;
        let dismiss = native(cx, on_dismiss, 0, &mut [node, props]);
        let r = dom::set_handler(cx, id, EventKind::Dismiss, dismiss);
        free(cx, dismiss);
        r?;
        // Only when the app listens: the event mask tells the platform
        // whether a back press goes to JS at all.
        let listens = get(cx, props, c"onBackPress");
        // SAFETY: an inline check of a live value.
        let listens_fn = unsafe { !qjs::JS_IsUndefined(listens) && !qjs::JS_IsNull(listens) };
        free(cx, listens);
        if listens_fn {
            forward(cx, id, EventKind::BackRequest, props, "onBackPress")?;
        }
        // The header's slots, then the content with the screen's insets.
        let mut parts = Vec::new();
        for (slot, key) in [
            ("left", "headerLeft"),
            ("right", "headerRight"),
            ("title", "headerTitle"),
            ("header", "header"),
        ] {
            let content = reader(cx, props, key);
            // SAFETY: a new string the function keeps a dup of.
            let name = unsafe { qjs::JS_NewStringLen(cx, slot.as_ptr().cast(), slot.len() as _) };
            let item = native(cx, header_item, 0, &mut [content, name]);
            free(cx, content);
            free(cx, name);
            parts.push(reactive::memo(cx, item, false));
        }
        let children = reader(cx, props, "children");
        let content = with_insets(cx, insets, children);
        free(cx, children);
        free(cx, insets);
        // SAFETY: an inline tag check.
        if unsafe { qjs::JS_IsException(content) } {
            for p in parts {
                free(cx, p);
            }
            return Err(content);
        }
        parts.push(content);
        let all = unsafe { qjs::JS_NewArrayFrom(cx, parts.len() as c_int, parts.as_mut_ptr()) };
        let r = dom::insert_value_at(cx, node, all, None);
        free(cx, all);
        r
    })();
    match result {
        Ok(()) => reactive::finish_value(cx, node),
        Err(e) => {
            free(cx, node);
            e
        }
    }
}

/// A header slot: an item holding the app's content, while it has some.
unsafe extern "C" fn header_item(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values: the content's reader and the slot's name.
    unsafe {
        let (content, name) = (*data, *data.add(1));
        let c = qjs::JS_Call(cx, content, UNDEFINED, 0, ptr::null_mut());
        if qjs::JS_IsException(c) {
            return c;
        }
        if qjs::JS_IsNull(c)
            || qjs::JS_IsUndefined(c)
            || (qjs::JS_IsBool(c) && !qjs::JS_VALUE_GET_BOOL(c))
        {
            qjs::JS_FreeValue(cx, c);
            return qjs::JS_NULL;
        }
        reactive::untracked_with(cx, || {
            let item = match dom::create_element(cx, Tag::HeaderItem) {
                Ok(item) => item,
                Err(e) => {
                    qjs::JS_FreeValue(cx, c);
                    return e;
                }
            };
            let r = dom::set_prop_value(cx, item, "headerSlot", name)
                .and_then(|()| dom::insert_value_at(cx, item, c, None));
            qjs::JS_FreeValue(cx, c);
            match r {
                Ok(()) => item,
                Err(e) => {
                    qjs::JS_FreeValue(cx, item);
                    e
                }
            }
        })
    }
}

/// A page's dismissal: a native pop tells the stack, then the app
/// (`onDismiss`).
unsafe extern "C" fn on_dismiss(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values: the node and the props; values got are
    // freed.
    unsafe {
        let (node, props) = (*data, *data.add(1));
        let popped = dom::popped(cx, node);
        if qjs::JS_IsFunction(cx, popped) {
            let r = qjs::JS_Call(cx, popped, UNDEFINED, 0, ptr::null_mut());
            qjs::JS_FreeValue(cx, popped);
            if qjs::JS_IsException(r) {
                return r;
            }
            qjs::JS_FreeValue(cx, r);
        } else {
            qjs::JS_FreeValue(cx, popped);
        }
        let own = get(cx, props, c"onDismiss");
        let r = if qjs::JS_IsFunction(cx, own) {
            qjs::JS_Call(cx, own, UNDEFINED, 0, ptr::null_mut())
        } else {
            UNDEFINED
        };
        qjs::JS_FreeValue(cx, own);
        r
    }
}

// --- Handlers of the app's props -------------------------------------------------

/// Sets the handler of `event` on node `id` to one calling `props[key]`
/// (read when the event comes) with the event's arguments.
fn forward(
    cx: *mut JsContext,
    id: nsh_core::NodeId,
    event: EventKind,
    props: JsValue,
    key: &str,
) -> Result<(), JsValue> {
    // SAFETY: a new string the function keeps a dup of.
    let k = unsafe { qjs::JS_NewStringLen(cx, key.as_ptr().cast(), key.len() as _) };
    let f = native(cx, call_prop, 1, &mut [props, k]);
    free(cx, k);
    let r = dom::set_handler(cx, id, event, f);
    free(cx, f);
    r
}

unsafe extern "C" fn call_prop(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (props, key); the arguments are borrowed.
    unsafe {
        let Some(key) = dom::string_arg(cx, *data.add(1)) else {
            return qjs::JS_EXCEPTION;
        };
        let k = CString::new(key).unwrap_or_default();
        let f = get(cx, *data, &k);
        let r = if qjs::JS_IsFunction(cx, f) {
            qjs::JS_Call(cx, f, UNDEFINED, argc, argv)
        } else {
            UNDEFINED
        };
        free(cx, f);
        r
    }
}

// --- Dialog -------------------------------------------------------------------------

/// `<Dialog open onOpenChange …>`: content over everything else, in its
/// own native window layer, while it is open: `open` is not false and the
/// user did not close it ([`close_attempt`]).
///
/// What shows is the app's: the popup (a view with the dialog's `class`
/// and `style`, holding the children) and, only when the app styles one
/// (`backdropClass` / `backdropStyle`), a backdrop behind it filling the
/// layer, whose presses are close attempts (`"backdropPress"`).
unsafe extern "C" fn modal(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let props = arg(argc, argv, 0);
    // Closed by the user while `open` stayed true: `closed` (a plain
    // object's flag, which the run resets without writing a signal it
    // reads) and `tick`, which runs it again.
    // SAFETY: a new object.
    let state = unsafe { qjs::JS_NewObject(cx) };
    let tick = reactive::new_signal(cx, qjs::JS_NewFloat64(0.0));
    let run = native(cx, modal_run, 0, &mut [props, state, tick]);
    free(cx, state);
    free(cx, tick);
    let shown = reactive::memo(cx, run, false);
    reactive::finish_value(cx, shown)
}

/// The `closed` flag of a dialog's state object.
fn closed_by_user(cx: *mut JsContext, state: JsValue) -> bool {
    let v = get(cx, state, c"closed");
    // SAFETY: an inline check of a live value.
    let closed = unsafe { qjs::JS_IsBool(v) && qjs::JS_VALUE_GET_BOOL(v) };
    free(cx, v);
    closed
}

fn set_closed_by_user(cx: *mut JsContext, state: JsValue, closed: bool) {
    // SAFETY: a property write of a live object.
    unsafe {
        qjs::JS_SetPropertyStr(
            cx,
            state,
            c"closed".as_ptr(),
            if closed { qjs::JS_TRUE } else { qjs::JS_FALSE },
        );
    }
}

unsafe extern "C" fn modal_run(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (props, state, tick).
    let (props, state, tick) = unsafe { (*data, *data.add(1), *data.add(2)) };
    // Tracked: a close by the user runs this again.
    let t = unsafe { qjs::JS_Call(cx, tick, UNDEFINED, 0, ptr::null_mut()) };
    free(cx, t);
    let open = get(cx, props, c"open");
    // SAFETY: an inline check of a live value.
    let closed = unsafe { qjs::JS_IsBool(open) && !qjs::JS_VALUE_GET_BOOL(open) };
    free(cx, open);
    if closed {
        // The app followed (or closed it itself): the next `open` shows it.
        set_closed_by_user(cx, state, false);
        return qjs::JS_NULL;
    }
    if closed_by_user(cx, state) {
        return qjs::JS_NULL;
    }
    reactive::untracked_with(cx, || {
        let node = match dom::create_element(cx, Tag::Modal) {
            Ok(node) => node,
            Err(e) => return e,
        };
        let result = (|| -> Result<(), JsValue> {
            dom::spread_except(
                cx,
                node,
                props,
                &[
                    "children",
                    "open",
                    "animation",
                    "class",
                    "style",
                    "backdropClass",
                    "backdropStyle",
                    "backdropTestID",
                    "onInsets",
                    "onOpen",
                    "onClose",
                    "onCancel",
                    "onOpenChange",
                ],
            )?;
            // A dialog with a backdrop slides its popup itself and fades
            // the rest: the platforms slide the whole layer, the backdrop
            // with it.
            let slide = slides_popup(cx, props);
            if slide {
                // SAFETY: a new string the prop takes.
                let fade = unsafe { qjs::JS_NewStringLen(cx, c"fade".as_ptr(), 4) };
                dom::set_prop_value(cx, node, "animation", fade)?;
            } else {
                let read = reader(cx, props, "animation");
                let r = dom::bind_prop_with(cx, node, "animation", read);
                free(cx, read);
                r?;
            }
            let (insets, on_insets) = native_insets(cx, false);
            let id = dom::node_id(cx, node).expect("a node");
            let r = dom::set_handler(cx, id, EventKind::Insets, on_insets);
            free(cx, on_insets);
            r?;
            forward(cx, id, EventKind::Show, props, "onOpen")?;
            forward(cx, id, EventKind::Dismiss, props, "onClose")?;
            let cancel = native(cx, on_cancel, 1, &mut [props, state, tick]);
            let r = dom::set_handler(cx, id, EventKind::RequestClose, cancel);
            free(cx, cancel);
            r?;
            // The backdrop part, while the app styles one.
            let has = native(cx, has_backdrop, 0, &mut [props]);
            let make = native(cx, backdrop_part, 0, &mut [props, state, tick]);
            let backdrop = dom::cond_value(cx, has, make);
            free(cx, has);
            free(cx, make);
            // SAFETY: an inline tag check.
            if unsafe { qjs::JS_IsException(backdrop) } {
                free(cx, insets);
                return Err(backdrop);
            }
            let popup = popup_part(cx, props, insets, slide);
            free(cx, insets);
            let popup = match popup {
                Ok(popup) => popup,
                Err(e) => {
                    free(cx, backdrop);
                    return Err(e);
                }
            };
            let mut parts = [backdrop, popup];
            // SAFETY: a new array taking the parts.
            let all = unsafe { qjs::JS_NewArrayFrom(cx, 2, parts.as_mut_ptr()) };
            let r = dom::insert_value_at(cx, node, all, None);
            free(cx, all);
            r
        })();
        match result {
            Ok(()) => node,
            Err(e) => {
                free(cx, node);
                e
            }
        }
    })
}

/// Whether dialog `props` slides its popup itself: it has a backdrop, it
/// slides (the default), the user did not ask for less motion, and its
/// `style` has no `translate` of its own (the slide's would replace it).
fn slides_popup(cx: *mut JsContext, props: JsValue) -> bool {
    // SAFETY: the props borrowed as the function's one data value; it
    // returns a boolean.
    let has = unsafe { has_backdrop(cx, UNDEFINED, 0, ptr::null_mut(), 0, [props].as_mut_ptr()) };
    // SAFETY: an inline read of a boolean.
    if unsafe { !qjs::JS_VALUE_GET_BOOL(has) } {
        return false;
    }
    let animation = get(cx, props, c"animation");
    // SAFETY: an inline check of a live value.
    let unset = unsafe { qjs::JS_IsUndefined(animation) || qjs::JS_IsNull(animation) };
    let slides = unset || dom::string_arg(cx, animation).is_some_and(|a| a == "slide");
    free(cx, animation);
    let style = get(cx, props, c"style");
    let translate = get(cx, style, c"translate");
    // SAFETY: inline checks of live values.
    let own = unsafe { !qjs::JS_IsUndefined(translate) && !qjs::JS_IsNull(translate) };
    free(cx, translate);
    free(cx, style);
    slides && !own && !crate::env::current(cx).reduce_motion
}

/// The popup: a view with the dialog's `class` and `style` holding its
/// children (with the dialog's `insets`, borrowed); owned. `slide`: it
/// comes up from the window's bottom edge (the layer fades).
fn popup_part(
    cx: *mut JsContext,
    props: JsValue,
    insets: JsValue,
    slide: bool,
) -> Result<JsValue, JsValue> {
    let popup = dom::create_element(cx, Tag::View)?;
    let result = (|| -> Result<(), JsValue> {
        let read = reader(cx, props, "class");
        let r = dom::bind_prop_with(cx, popup, "class", read);
        free(cx, read);
        r?;
        if slide {
            let height = crate::env::current(cx).window.height.0 as f64;
            let offset = crate::animated::new_value(cx, height.max(1.0))?;
            let read = native(cx, slid_style, 0, &mut [props, offset]);
            let r = dom::bind_prop_with(cx, popup, "style", read);
            free(cx, read);
            if r.is_ok() {
                crate::animated::run_timing(cx, offset, 0.0, 320.0, [0.2, 0.8, 0.2, 1.0]);
            }
            free(cx, offset);
            r?;
        } else {
            let read = reader(cx, props, "style");
            let r = dom::bind_prop_with(cx, popup, "style", read);
            free(cx, read);
            r?;
        }
        let children = reader(cx, props, "children");
        let content = with_insets(cx, insets, children);
        free(cx, children);
        // SAFETY: an inline tag check.
        if unsafe { qjs::JS_IsException(content) } {
            return Err(content);
        }
        let r = dom::insert_value_at(cx, popup, content, None);
        free(cx, content);
        r
    })();
    match result {
        Ok(()) => Ok(popup),
        Err(e) => {
            free(cx, popup);
            Err(e)
        }
    }
}

/// The popup's style while it slides: the dialog's `style`, then a
/// `translate` down by the offset, which runs to 0.
unsafe extern "C" fn slid_style(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: two data values (the props, the offset), borrowed; new
    // values owned by the arrays and objects that take them.
    unsafe {
        let (props, offset) = (*data, *data.add(1));
        let mut axes = [qjs::JS_NewFloat64(0.0), qjs::JS_DupValue(cx, offset)];
        let translate = qjs::JS_NewArrayFrom(cx, 2, axes.as_mut_ptr());
        let motion = qjs::JS_NewObject(cx);
        qjs::JS_SetPropertyStr(cx, motion, c"translate".as_ptr(), translate);
        let mut both = [get(cx, props, c"style"), motion];
        qjs::JS_NewArrayFrom(cx, 2, both.as_mut_ptr())
    }
}

/// Whether the app styles a backdrop (`backdropClass` or `backdropStyle`).
unsafe extern "C" fn has_backdrop(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (the props).
    let props = unsafe { *data };
    let mut has = false;
    for key in [c"backdropClass", c"backdropStyle"] {
        let v = get(cx, props, key);
        // SAFETY: inline checks of a live value.
        has |= unsafe { !qjs::JS_IsUndefined(v) && !qjs::JS_IsNull(v) };
        free(cx, v);
    }
    if has { qjs::JS_TRUE } else { qjs::JS_FALSE }
}

/// The backdrop: a view filling the dialog behind the popup, with the
/// app's `backdropClass` and `backdropStyle` and no look of its own; a
/// press on it is a close attempt (`"backdropPress"`).
unsafe extern "C" fn backdrop_part(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (props, state, tick).
    let props = unsafe { *data };
    let view = match dom::create_element(cx, Tag::View) {
        Ok(view) => view,
        Err(e) => return e,
    };
    let result = (|| -> Result<(), JsValue> {
        let class = native(cx, backdrop_class, 0, &mut [props]);
        let r = dom::bind_prop_with(cx, view, "class", class);
        free(cx, class);
        r?;
        let style = reader(cx, props, "backdropStyle");
        let r = dom::bind_prop_with(cx, view, "style", style);
        free(cx, style);
        r?;
        let test_id = reader(cx, props, "backdropTestID");
        let r = dom::bind_prop_with(cx, view, "testID", test_id);
        free(cx, test_id);
        r?;
        // SAFETY: the three data values, which the function keeps dups of.
        let press = native(cx, backdrop_press, 0, unsafe {
            std::slice::from_raw_parts_mut(data, 3)
        });
        let r = dom::set_prop_value(cx, view, "onPress", press);
        free(cx, press);
        r
    })();
    match result {
        Ok(()) => view,
        Err(e) => {
            free(cx, view);
            e
        }
    }
}

/// The backdrop's classes: filling the dialog, then the app's.
unsafe extern "C" fn backdrop_class(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value (the props).
    let v = get(cx, unsafe { *data }, c"backdropClass");
    // SAFETY: an inline tag check.
    let own = if unsafe { qjs::JS_IsString(v) } {
        dom::string_arg(cx, v).unwrap_or_default()
    } else {
        String::new()
    };
    free(cx, v);
    let class = format!("absolute inset-0 {own}");
    // SAFETY: a new string.
    unsafe { qjs::JS_NewStringLen(cx, class.as_ptr().cast(), class.len() as _) }
}

unsafe extern "C" fn backdrop_press(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (props, state, tick).
    let (props, state, tick) = unsafe { (*data, *data.add(1), *data.add(2)) };
    close_attempt(cx, props, state, tick, "backdropPress")
}

/// The platform reports that the user tried to close a dialog natively
/// (payload: `reason`).
unsafe extern "C" fn on_cancel(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: three data values (props, state, tick); the event is
    // borrowed.
    let (props, state, tick) = unsafe { (*data, *data.add(1), *data.add(2)) };
    let e = arg(argc, argv, 0);
    let value = get(cx, e, c"reason");
    // SAFETY: an inline tag check.
    let reason = if unsafe { qjs::JS_IsString(value) } {
        dom::string_arg(cx, value).unwrap_or_default()
    } else {
        String::new()
    };
    free(cx, value);
    let reason = match reason.as_str() {
        "backdropPress" => "backdropPress",
        "swipe" => "swipe",
        _ => "cancel",
    };
    close_attempt(cx, props, state, tick, reason)
}

/// The user tried to close a dialog: `onCancel`, then, when the
/// `closeOn*` flag of what they did lets it close, `onOpenChange({ open:
/// false, reason })` and the dialog closes (a platform that closed it natively
/// already reports `onClose`; otherwise removing it does).
fn close_attempt(
    cx: *mut JsContext,
    props: JsValue,
    state: JsValue,
    tick: JsValue,
    reason: &str,
) -> JsValue {
    let flag: &CStr = match reason {
        "backdropPress" => c"closeOnBackdropPress",
        "swipe" => c"closeOnSwipe",
        _ => c"closeOnEscape",
    };
    let call = |key: &CStr, args: &mut [JsValue]| -> JsValue {
        let f = get(cx, props, key);
        // SAFETY: a call of the app's function with borrowed arguments.
        let r = unsafe {
            if qjs::JS_IsFunction(cx, f) {
                qjs::JS_Call(cx, f, UNDEFINED, args.len() as c_int, args.as_mut_ptr())
            } else {
                UNDEFINED
            }
        };
        free(cx, f);
        r
    };
    let r = call(c"onCancel", &mut []);
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(r) } {
        return r;
    }
    free(cx, r);
    let closes = get(cx, props, flag);
    // SAFETY: an inline check of a live value.
    let kept = unsafe { qjs::JS_IsBool(closes) && !qjs::JS_VALUE_GET_BOOL(closes) };
    free(cx, closes);
    if kept || closed_by_user(cx, state) {
        return UNDEFINED;
    }
    reactive::batch_with(cx, || {
        // One object, as every event (`api-naming.md` "Payloads").
        // SAFETY: a new object owning a new string (`JS_SetPropertyStr`
        // takes it), freed after the call.
        let event = unsafe {
            let event = qjs::JS_NewObject(cx);
            qjs::JS_SetPropertyStr(cx, event, c"open".as_ptr(), qjs::JS_FALSE);
            let reason = qjs::JS_NewStringLen(cx, reason.as_ptr().cast(), reason.len() as _);
            qjs::JS_SetPropertyStr(cx, event, c"reason".as_ptr(), reason);
            event
        };
        let r = call(c"onOpenChange", &mut [event]);
        free(cx, event);
        // SAFETY: an inline tag check.
        if unsafe { qjs::JS_IsException(r) } {
            return r;
        }
        free(cx, r);
        // Closed whether or not the app keeps `open` in sync.
        set_closed_by_user(cx, state, true);
        let n = reactive::peek_number(cx, tick).unwrap_or(0.0);
        reactive::set_signal(cx, tick, qjs::JS_NewFloat64(n + 1.0));
        reactive::finish_value(cx, UNDEFINED)
    })
}

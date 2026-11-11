//! The surface's environment: one signal per part
//! (window, safe area, keyboard, color scheme, font scale, screen reader,
//! reduced motion, pixel ratio, locale, locale settings, lifecycle, the
//! desktop window's state and the displays)
//! written when the platform reports a
//! change, read through read-only accessors; `nsh/device` (`platform`) and
//! `nsh/accessibility`; the layout direction, which follows the user's
//! language; the insets
//! context screens and modals provide (`safeAreaInsets`); the design
//! tokens the app is drawn with (`token()` of `nsh`).

use std::{
    cell::{Cell, RefCell},
    ffi::{CStr, c_int},
    ptr,
    sync::Arc,
};

use nsh_core::{
    desktop::Display,
    element::{ThemeTokens, Token, Tokens},
    platform::{Appearance, ColorScheme, Environment, Idiom, Os},
};
use rquickjs::qjs;

use crate::{
    modules::{Export, Item, Ts},
    reactive::{self, arg},
};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

const UNDEFINED: JsValue = qjs::JS_UNDEFINED;

/// The parts of the environment, each a signal.
#[derive(Clone, Copy)]
enum Part {
    Window,
    SafeArea,
    Keyboard,
    ColorScheme,
    FontScale,
    ScreenReader,
    ReduceMotion,
    PixelRatio,
    TitleBar,
    Locale,
    Lifecycle,
    LocaleSettings,
    WindowState,
    Displays,
    Fps,
    Shaders,
}

const PARTS: usize = 16;

/// The environment's part of a context's state.
pub(crate) struct Env {
    /// What the platform reported last (`None`: nothing yet).
    current: RefCell<Option<Environment>>,
    /// One signal per part (owned).
    signals: [Cell<JsValue>; PARTS],
    /// Read-only accessors of the signals (owned memos).
    accessors: [Cell<JsValue>; PARTS],
    /// The app's appearance (`nsh.json`, `setColorScheme`).
    appearance: Cell<Appearance>,
    /// The insets context (owned): screens and modals provide theirs.
    insets: Cell<JsValue>,
    /// The design tokens the app is drawn with ([`set_tokens`]).
    tokens: RefCell<Arc<Tokens>>,
    /// A signal of their version (owned): `token()` reads it, so what read
    /// a token follows a new theme.
    tokens_signal: Cell<JsValue>,
    tokens_version: Cell<u32>,
    /// The tokens the app's theme file gives ([`set_theme_tokens`]), taken
    /// in when the entry hands the theme to the renderer ([`take_theme`]).
    theme: RefCell<ThemeTokens>,
    /// The theme file the app was built with (`nsh.json`), which
    /// `setTheme(null)` gives back (`None`: it has none).
    built_theme: RefCell<Option<String>>,
    /// The displays the platform reported last.
    displays: RefCell<Vec<Display>>,
    /// What `appInfo()` reports: the build's ([`set_app_info`]).
    app: RefCell<AppInfo>,
}

/// The app as it was built (`appInfo()`), from the JSON the bundler writes.
#[derive(Default, serde::Deserialize)]
#[serde(default)]
struct AppInfo {
    id: Option<String>,
    name: Option<String>,
    version: Option<String>,
    build: Option<f64>,
    development: bool,
}

impl Default for Env {
    fn default() -> Self {
        Env {
            current: RefCell::new(None),
            signals: std::array::from_fn(|_| Cell::new(UNDEFINED)),
            accessors: std::array::from_fn(|_| Cell::new(UNDEFINED)),
            appearance: Cell::new(Appearance::System),
            insets: Cell::new(UNDEFINED),
            tokens: RefCell::new(Arc::default()),
            tokens_signal: Cell::new(UNDEFINED),
            tokens_version: Cell::new(0),
            theme: RefCell::new(ThemeTokens::default()),
            built_theme: RefCell::default(),
            displays: RefCell::default(),
            app: RefCell::default(),
        }
    }
}

/// Takes in the app's information as the build wrote it (`setup`'s fifth
/// argument); what this runtime cannot read is left out.
pub(crate) fn set_app_info(cx: *mut JsContext, json: &str) {
    match serde_json::from_str(json) {
        Ok(info) => *env(cx).app.borrow_mut() = info,
        Err(e) => log::warn!("appInfo: {e}, ignored"),
    }
}

/// `appInfo()`: the app as it was built.
unsafe extern "C" fn app_info(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    let app = env(cx).app.borrow();
    let text = |value: &Option<String>| match value {
        Some(value) => string(cx, value),
        None => qjs::JS_NULL,
    };
    object(
        cx,
        &[
            (c"id", text(&app.id)),
            (c"name", text(&app.name)),
            (c"version", text(&app.version)),
            (c"build", app.build.map_or(qjs::JS_NULL, qjs::JS_NewFloat64)),
            (c"development", boolean(app.development)),
        ],
    )
}

/// `appInfo` of `nsh`.
pub(crate) const APP_INFO_EXPORT: crate::modules::Item = (
    "appInfo",
    Export::Function(app_info, 0),
    Ts::function(
        "The app as it was built: its id, name, version and build number\n(`nsh.json`'s; a package's as `nsh package` and `nsh publish` name and\nversion it, `--id`, `--name`, `--version` and `--build` included, with\nversion `1.0.0` and build `1` where nothing gives them), and whether it\nis a development build (`nsh run`, `nsh dev`, `nsh test`, `nsh build`\nwithout `--release`). `nsh/updater`'s `shellInfo()` reports the\ninstalled app's.",
        &["(): AppInfo"],
    ),
);

fn env<'a>(cx: *mut JsContext) -> &'a Env {
    // SAFETY: a projection of the state's field, reached by shared
    // reference only.
    unsafe { &(*crate::state::state(cx)).env }
}

impl Env {
    /// Frees the values the environment holds (the state is unregistered).
    pub(crate) fn free_all(&mut self, raw: *mut JsContext) {
        // SAFETY: the environment's own values; no JS runs from here on.
        unsafe {
            for c in self.signals.iter().chain(&self.accessors) {
                qjs::JS_FreeValue(raw, c.replace(UNDEFINED));
            }
            qjs::JS_FreeValue(raw, self.insets.replace(UNDEFINED));
            qjs::JS_FreeValue(raw, self.tokens_signal.replace(UNDEFINED));
        }
    }
}

/// Makes the signals and accessors (after the graph and the renderer).
pub(crate) fn init(cx: *mut JsContext) {
    let e = env(cx);
    for i in 0..PARTS {
        // The displays are an empty list until the platform reports any
        // (off desktops, for good).
        let initial = if i == Part::Displays as usize {
            // SAFETY: a new array, borrowed by the signal and freed after.
            unsafe { qjs::JS_NewArray(cx) }
        } else if i == Part::Fps as usize {
            // No performance monitor until the platform installs one.
            boolean(false)
        } else {
            UNDEFINED
        };
        let signal = reactive::new_signal(cx, initial);
        // SAFETY: the signal holds its own reference.
        unsafe { qjs::JS_FreeValue(cx, initial) };
        let mut data = [signal];
        // SAFETY: the function keeps a dup of the signal.
        let func = unsafe { qjs::JS_NewCFunctionData(cx, Some(read), 0, 0, 1, data.as_mut_ptr()) };
        e.signals[i].set(signal);
        e.accessors[i].set(reactive::memo(cx, func, false));
    }
    // The insets of the nearest screen or modal: the surface's safe area
    // outside of them.
    let safe_area = e.accessors[Part::SafeArea as usize].get();
    let mut args = [safe_area];
    // SAFETY: a context whose default is the accessor (borrowed).
    let insets = unsafe { crate::dom::context(cx, UNDEFINED, 1, args.as_mut_ptr()) };
    e.insets.set(insets);
    e.tokens_signal.set(reactive::new_signal(cx, number(0.0)));
}

/// Takes in the design tokens the app is drawn with: what read a token
/// runs again.
pub(crate) fn set_tokens(cx: *mut JsContext, tokens: Arc<Tokens>) {
    let e = env(cx);
    if **e.tokens.borrow() == *tokens {
        return;
    }
    e.tokens.replace(tokens);
    let version = e.tokens_version.get().wrapping_add(1);
    e.tokens_version.set(version);
    reactive::set_signal(cx, e.tokens_signal.get(), number(version as f32));
}

/// Sets how the app's theme file makes the tokens it is drawn with
/// ([`nsh_core::Core::theme_tokens`]).
pub(crate) fn set_theme_tokens(cx: *mut JsContext, theme: ThemeTokens) {
    env(cx).theme.replace(theme);
}

/// Takes in the tokens of the app's theme file `json` (`nsh:rt`'s `setup`,
/// the entry's first statement): the core has them only once the theme's
/// op reaches it, after the turn of the first render, which reads them
/// already.
pub(crate) fn take_theme(cx: *mut JsContext, json: &str) {
    let e = env(cx);
    e.built_theme.replace(Some(json.to_owned()));
    let tokens = e.theme.borrow().of(json);
    if let Some(tokens) = tokens {
        set_tokens(cx, Arc::new(tokens));
    }
}

/// A theme file that sets nothing: the default theme's tokens, which an app
/// built without a theme has.
const NO_THEME: &str = r#"{"cssVars":{}}"#;

/// `setTheme(theme)`: the app's theme is `theme` from now on, as if
/// `nsh.json` had it, read whole or not at all (a `TypeError` names each
/// value it cannot read); `null` gives back the one the app was built with,
/// as the entry gave it ([`take_theme`]). `token()` reads the new tokens at
/// once; the core has them when this turn's ops reach it.
unsafe extern "C" fn set_theme(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let e = env(cx);
    let v = arg(argc, argv, 0);
    // SAFETY: inline tag checks.
    let nullish = unsafe { qjs::JS_IsNull(v) || qjs::JS_IsUndefined(v) };
    // SAFETY: an inline tag check.
    let object = unsafe { qjs::JS_IsObject(v) };
    let (json, tokens) = if nullish {
        let json = e.built_theme.borrow().clone();
        let json = json.unwrap_or_else(|| NO_THEME.to_owned());
        let tokens = e.theme.borrow().of(&json);
        (json, tokens)
    } else if object {
        // SAFETY: a context reference and a dup for the converter.
        let value = unsafe {
            let rcx = rquickjs::Ctx::from_raw(ptr::NonNull::new_unchecked(cx));
            rquickjs::Value::from_raw(rcx, qjs::JS_DupValue(cx, v))
        };
        let Ok(json) = crate::protocol::to_json(&value) else {
            return qjs::JS_EXCEPTION;
        };
        let json = json.to_string();
        let checked = e.theme.borrow().checked(&json);
        match checked {
            Some(Err(what)) => return type_error(cx, &format!("setTheme: {what}")),
            Some(Ok(tokens)) => (json, Some(tokens)),
            // No UI set reads themes: the core says so.
            None => (json, None),
        }
    } else {
        return type_error(cx, "setTheme: expected a theme ({ cssVars }) or null");
    };
    let op = nsh_core::Op::SetProp {
        id: nsh_core::ROOT_ID,
        prop: nsh_core::Prop::UiTheme(json.into()),
    };
    if let Err(err) = crate::dom::push_op(cx, op) {
        return err;
    }
    if let Some(tokens) = tokens {
        set_tokens(cx, Arc::new(tokens));
    }
    reactive::finish_value(cx, UNDEFINED)
}

/// Throws a `TypeError` of `message`.
fn type_error(cx: *mut JsContext, message: &str) -> JsValue {
    let message = std::ffi::CString::new(message.replace('\0', "")).unwrap_or_default();
    // SAFETY: throws on a live context; `%s` reads the C string.
    unsafe { qjs::JS_ThrowTypeError(cx, c"%s".as_ptr(), message.as_ptr()) }
}

/// `setTheme` of `nsh`.
pub(crate) const SET_THEME_EXPORT: crate::modules::Item = (
    "setTheme",
    Export::Function(set_theme, 1),
    Ts::function(
        "Makes `theme` the app's theme while it runs, in place of `nsh.json`'s\n`\"theme\"` and over shadcn/ui's tokens as that one is: `token()` reads it\nat once, and classes naming tokens, `nsh/base` and Rust components'\n`theme()` follow with the next frame. An embedding app's theme overrides\nstill win. `null` gives back the theme the app was built with. The theme\nis read whole: a value NSH cannot read (a color it does not know, a value\nthat is no color in one appearance where the other's is) throws a\n`TypeError` naming it, and the theme shown stays.",
        &["(theme: Theme | null): void"],
    ),
);

/// `token(name)`: the design token `name` in the appearance shown (a
/// color as `#rrggbbaa`, a number, a font family), `undefined` when there
/// is none. Reading it tracks the tokens and the appearance.
unsafe extern "C" fn token(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let e = env(cx);
    for tracked in [
        e.tokens_signal.get(),
        e.accessors[Part::ColorScheme as usize].get(),
    ] {
        // SAFETY: calls a signal and an accessor the environment owns.
        unsafe {
            let read = qjs::JS_Call(cx, tracked, UNDEFINED, 0, ptr::null_mut());
            if qjs::JS_IsException(read) {
                return read;
            }
            qjs::JS_FreeValue(cx, read);
        }
    }
    let Some(name) = crate::dom::string_arg(cx, arg(argc, argv, 0)) else {
        return UNDEFINED;
    };
    let dark = scheme(e, &current(cx)) == "dark";
    let value = e.tokens.borrow().get(&name);
    match value {
        Some(Token::Color(c)) => {
            let c = nsh_core::Color::from(if dark { c.dark } else { c.light });
            string(cx, &format!("#{:08x}", c.0))
        }
        Some(Token::Number(n)) => number(n),
        Some(Token::Font(f)) => string(cx, &f),
        _ => UNDEFINED,
    }
}

/// `token` of `nsh`.
pub(crate) const TOKEN_EXPORT: crate::modules::Item = (
    "token",
    Export::Function(token, 1),
    Ts::function(
        "The design token `name` of the app's theme (`nsh.json` `\"theme\"`, over\nshadcn/ui's tokens) in the appearance shown, reactive: a color as\n`#rrggbbaa`, a number (a length in points), a font family. The names are\nthe theme's CSS variables without `--`, which classes name too\n(`bg-primary`, `bg-up/30`, `rounded-(--radius)`).",
        &["<K extends keyof Tokens>(name: K): Tokens[K]"],
    ),
);

/// An accessor's run: reads its signal (tracked).
unsafe extern "C" fn read(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
    _magic: c_int,
    data: *mut JsValue,
) -> JsValue {
    // SAFETY: one data value: a signal object.
    unsafe { qjs::JS_Call(cx, *data, UNDEFINED, 0, ptr::null_mut()) }
}

fn object(cx: *mut JsContext, fields: &[(&CStr, JsValue)]) -> JsValue {
    // SAFETY: a new object taking the field values.
    unsafe {
        let o = qjs::JS_NewObject(cx);
        for (k, v) in fields {
            qjs::JS_SetPropertyStr(cx, o, k.as_ptr(), *v);
        }
        o
    }
}

/// A number as JS shows it: the f32's shortest decimal (`51.809525`, not
/// the f64 widening `51.80952453613281`).
fn number(v: f32) -> JsValue {
    let shortest = v.to_string().parse::<f64>().unwrap_or(v as f64);
    qjs::JS_NewFloat64(shortest)
}

fn boolean(v: bool) -> JsValue {
    if v { qjs::JS_TRUE } else { qjs::JS_FALSE }
}

fn string(cx: *mut JsContext, s: &str) -> JsValue {
    // SAFETY: a new string.
    unsafe { qjs::JS_NewStringLen(cx, s.as_ptr().cast(), s.len() as _) }
}

/// The color scheme shown: the app's, else the system's.
fn scheme(e: &Env, env: &Environment) -> &'static str {
    match e.appearance.get().resolve(env.color_scheme) {
        ColorScheme::Light => "light",
        ColorScheme::Dark => "dark",
    }
}

/// Shows the surface in `appearance` (`nsh.json` `"appearance"`,
/// `setColorScheme`): `colorScheme()` follows it at once, the core
/// (`dark:` classes, the components' theme) and the platform's controls
/// with the root's `appearance` prop.
pub(crate) fn set_appearance(cx: *mut JsContext, appearance: Appearance) -> JsValue {
    let e = env(cx);
    e.appearance.set(appearance);
    let op = nsh_core::Op::SetProp {
        id: nsh_core::ROOT_ID,
        prop: nsh_core::Prop::Appearance(appearance),
    };
    if let Err(err) = crate::dom::push_op(cx, op) {
        return err;
    }
    let value = string(cx, scheme(e, &current(cx)));
    reactive::set_signal(cx, e.signals[Part::ColorScheme as usize].get(), value);
    reactive::finish_value(cx, UNDEFINED)
}

/// `"light"` / `"dark"` / `"system"`.
pub(crate) fn parse_appearance(name: &str) -> Option<Appearance> {
    match name {
        "system" => Some(Appearance::System),
        "light" => Some(Appearance::Light),
        "dark" => Some(Appearance::Dark),
        _ => None,
    }
}

/// `setColorScheme(scheme)`.
unsafe extern "C" fn set_color_scheme(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let name = crate::dom::string_arg(cx, arg(argc, argv, 0)).unwrap_or_default();
    match parse_appearance(&name) {
        Some(appearance) => set_appearance(cx, appearance),
        // SAFETY: throws on a live context.
        None => unsafe {
            qjs::JS_ThrowTypeError(
                cx,
                c"setColorScheme: expected \"light\", \"dark\" or \"system\"".as_ptr(),
            )
        },
    }
}

/// Takes in what the platform reports: writes the parts that changed.
pub(crate) fn set_environment(cx: *mut JsContext, next: &Environment) -> Result<(), ()> {
    let e = env(cx);
    let previous = e.current.replace(Some(*next));
    let changed = |f: &dyn Fn(&Environment) -> bool| match &previous {
        Some(p) => !f(p),
        None => true,
    };
    let insets = |i: &nsh_core::Edges<nsh_core::Points>| {
        [
            (c"top", number(i.top.0)),
            (c"right", number(i.right.0)),
            (c"bottom", number(i.bottom.0)),
            (c"left", number(i.left.0)),
        ]
    };
    let mut writes: Vec<(Part, JsValue)> = Vec::new();
    if changed(&|p| p.window == next.window) {
        let (w, h) = (next.window.width.0, next.window.height.0);
        writes.push((
            Part::Window,
            object(cx, &[(c"width", number(w)), (c"height", number(h))]),
        ));
    }
    if changed(&|p| p.safe_area == next.safe_area) {
        writes.push((Part::SafeArea, object(cx, &insets(&next.safe_area))));
    }
    if changed(&|p| p.title_bar == next.title_bar) {
        let t = next.title_bar;
        writes.push((
            Part::TitleBar,
            object(
                cx,
                &[
                    (c"height", number(t.top.0)),
                    (c"left", number(t.left.0)),
                    (c"right", number(t.right.0)),
                ],
            ),
        ));
    }
    if changed(&|p| {
        p.keyboard_height == next.keyboard_height && p.keyboard_duration == next.keyboard_duration
    }) {
        writes.push((
            Part::Keyboard,
            object(
                cx,
                &[
                    (c"height", number(next.keyboard_height.0)),
                    (c"duration", number(next.keyboard_duration)),
                ],
            ),
        ));
    }
    if changed(&|p| p.color_scheme == next.color_scheme) {
        writes.push((Part::ColorScheme, string(cx, scheme(e, next))));
    }
    if changed(&|p| p.font_scale == next.font_scale) {
        writes.push((Part::FontScale, number(next.font_scale)));
    }
    if changed(&|p| p.locale == next.locale) {
        writes.push((Part::Locale, string(cx, next.locale.as_str())));
    }
    if changed(&|p| p.locale_settings == next.locale_settings) {
        let settings = &next.locale_settings;
        let mut tags: Vec<JsValue> = settings
            .languages
            .iter()
            .map(|l| string(cx, l.as_str()))
            .collect();
        // SAFETY: the array takes the strings.
        let languages = unsafe { qjs::JS_NewArrayFrom(cx, tags.len() as c_int, tags.as_mut_ptr()) };
        let first_day_of_week = f32::from(settings.first_day_of_week.number());
        writes.push((
            Part::LocaleSettings,
            object(
                cx,
                &[
                    (c"languages", languages),
                    (c"timeZone", string(cx, settings.time_zone.as_str())),
                    (c"hourCycle", string(cx, settings.hour_cycle.name())),
                    (c"firstDayOfWeek", number(first_day_of_week)),
                    (
                        c"measurementSystem",
                        string(cx, settings.measurement_system.name()),
                    ),
                    (
                        c"temperatureUnit",
                        string(cx, settings.temperature_unit.name()),
                    ),
                ],
            ),
        ));
    }
    if changed(&|p| p.screen_reader == next.screen_reader) {
        writes.push((Part::ScreenReader, boolean(next.screen_reader)));
    }
    if changed(&|p| p.reduce_motion == next.reduce_motion) {
        writes.push((Part::ReduceMotion, boolean(next.reduce_motion)));
    }
    if changed(&|p| p.pixel_ratio == next.pixel_ratio) {
        writes.push((Part::PixelRatio, number(next.pixel_ratio)));
    }
    if changed(&|p| p.lifecycle == next.lifecycle) {
        writes.push((Part::Lifecycle, string(cx, next.lifecycle.name())));
    }
    if changed(&|p| p.shaders == next.shaders) {
        writes.push((Part::Shaders, boolean(next.shaders)));
    }
    if changed(&|p| p.window_state == next.window_state) {
        writes.push((
            Part::WindowState,
            crate::window::state_value(cx, next.window_state.as_ref()),
        ));
    }
    // The layout direction follows the user's language.
    // SAFETY: the state's renderer, by shared reference.
    unsafe { &(*crate::state::state(cx)).dom }.set_direction(next.rtl);
    reactive::batch_with(cx, || {
        for (part, value) in writes {
            reactive::set_signal(cx, e.signals[part as usize].get(), value);
        }
    });
    // The main window's listeners (`WindowRef.on`).
    crate::window::main_changed(cx, next.window_state);
    let failed = reactive::finish_value(cx, UNDEFINED);
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(failed) } {
        Err(())
    } else {
        Ok(())
    }
}

/// Takes in the displays the platform reports.
pub(crate) fn set_displays(cx: *mut JsContext, displays: &[Display]) -> Result<(), ()> {
    *env(cx).displays.borrow_mut() = displays.to_vec();
    let value = to_js(cx, &displays.to_vec());
    let state = current(cx).window_state;
    reactive::batch_with(cx, || {
        reactive::set_signal(cx, env(cx).signals[Part::Displays as usize].get(), value);
        // The windows' states name their displays: those objects change too.
        let main = crate::window::state_value(cx, state.as_ref());
        reactive::set_signal(cx, env(cx).signals[Part::WindowState as usize].get(), main);
        crate::window::displays_changed(cx);
    });
    let failed = reactive::finish_value(cx, UNDEFINED);
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(failed) } {
        Err(())
    } else {
        Ok(())
    }
}

/// Takes in whether the platform's performance monitor measures
/// (`fpsEnabled()`).
pub(crate) fn set_fps_enabled(cx: *mut JsContext, enabled: bool) -> Result<(), ()> {
    reactive::set_signal(
        cx,
        env(cx).signals[Part::Fps as usize].get(),
        boolean(enabled),
    );
    let failed = reactive::finish_value(cx, UNDEFINED);
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(failed) } {
        Err(())
    } else {
        Ok(())
    }
}

/// `value` as JS (owned): what Rust's conversion makes of it, `undefined`
/// when it fails (it does not for the environment's plain objects).
pub(crate) fn to_js<T: nsh_core::element::JsValue>(cx: *mut JsContext, value: &T) -> JsValue {
    let host = crate::classes::host_outside_calls(cx);
    let converted = value
        .to_js(&host)
        .map(|v| crate::classes::from_raw(v.into_raw()));
    host.clear_pending();
    converted.unwrap_or(UNDEFINED)
}

fn accessor(cx: *mut JsContext, part: Part) -> JsValue {
    // SAFETY: a dup of an accessor the environment owns.
    unsafe { qjs::JS_DupValue(cx, env(cx).accessors[part as usize].get()) }
}

/// The main window's hidden title bar area accessor (owned).
pub(crate) fn title_bar(cx: *mut JsContext) -> JsValue {
    accessor(cx, Part::TitleBar)
}

/// The displays the platform reported last.
pub(crate) fn display_list(cx: *mut JsContext) -> Vec<Display> {
    env(cx).displays.borrow().clone()
}

/// The main window's state accessor (owned): `WindowRef.state()` of the
/// main window.
pub(crate) fn window_state(cx: *mut JsContext) -> JsValue {
    accessor(cx, Part::WindowState)
}

/// `displays()` (`nsh/desktop`): the displays (owned).
pub(crate) fn displays(cx: *mut JsContext) -> JsValue {
    accessor(cx, Part::Displays)
}

pub(crate) fn current(cx: *mut JsContext) -> Environment {
    (*env(cx).current.borrow()).unwrap_or_default()
}

/// The user's locale and preferred languages, read so that what reads them
/// (`nsh/i18n`'s `t`) runs again when they change.
pub(crate) fn tracked_languages(
    cx: *mut JsContext,
) -> (nsh_core::platform::Locale, nsh_core::platform::Languages) {
    for part in [Part::Locale, Part::LocaleSettings] {
        let accessor = env(cx).accessors[part as usize].get();
        // SAFETY: calling the accessor reads (and tracks) the signal; its
        // value is freed at once.
        unsafe {
            let value = qjs::JS_Call(cx, accessor, UNDEFINED, 0, ptr::null_mut());
            qjs::JS_FreeValue(cx, value);
        }
    }
    let current = current(cx);
    (current.locale, current.locale_settings.languages)
}

/// Shows the app in `locale` at once (`setLocale`): `locale()`, `t` and
/// `Intl` read it from now on; the engine keeps it in the environment it
/// reports after.
pub(crate) fn show_locale(cx: *mut JsContext, locale: nsh_core::platform::Locale) {
    let e = env(cx);
    let mut current = e.current.borrow_mut();
    let mut next = current.unwrap_or_default();
    if next.locale == locale {
        return;
    }
    // `localeSettings()` follows when the engine reports it.
    next.locale = locale;
    next.locale_settings.languages = next.locale_settings.languages.preferring(locale);
    *current = Some(next);
    drop(current);
    reactive::set_signal(
        cx,
        e.signals[Part::Locale as usize].get(),
        string(cx, locale.as_str()),
    );
}

/// The user's locale (`Intl`'s default), read where it is used: a change
/// applies to what is formatted next.
pub(crate) fn locale(cx: *mut JsContext) -> nsh_core::platform::Locale {
    current(cx).locale
}

/// The device's time zone (`Intl`'s default, `localeSettings().timeZone`),
/// read where it is used as the locale is; `None` until the platform
/// reports one.
pub(crate) fn time_zone(cx: *mut JsContext) -> Option<nsh_core::platform::TimeZone> {
    env(cx)
        .current
        .borrow()
        .as_ref()
        .map(|e| e.locale_settings.time_zone)
}

/// `safeAreaInsets()`: the insets of the nearest screen or modal (an
/// accessor).
unsafe extern "C" fn safe_area_insets(
    cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    let insets = env(cx).insets.get();
    // SAFETY: calling the context reads its nearest value.
    unsafe { qjs::JS_Call(cx, insets, UNDEFINED, 0, ptr::null_mut()) }
}

/// The insets context (borrowed), which screens and modals provide.
pub(crate) fn insets_context(cx: *mut JsContext) -> JsValue {
    env(cx).insets.get()
}

/// The values registries re-export as they are (`Registry::reexport`):
/// the environment's accessors and hooks the UI sets export.
pub(crate) const REEXPORTS: &[Item] = &[
    (
        "safeArea",
        Export::Value(|cx| accessor(cx, Part::SafeArea)),
        Ts::value(
            "Insets of the surface not covered by system UI (notch, home indicator,\ntitle bar), in points (reactive).",
            "Accessor<Edges>",
        ),
    ),
    (
        "keyboardFrame",
        Export::Value(|cx| accessor(cx, Part::Keyboard)),
        Ts::value(
            "Height of the software keyboard over the surface (0 when hidden) and the\nduration of its animation in milliseconds (reactive).",
            "Accessor<{ height: number; duration: number }>",
        ),
    ),
    (
        "safeAreaInsets",
        Export::Function(safe_area_insets, 0),
        Ts::function(
            "Insets not covered by system UI or headers where this component renders:\nthe surface's safe area, a dialog's, or a page's (below its header).",
            &["(): Accessor<Edges>"],
        ),
    ),
    (
        "nextTick",
        Export::Function(crate::standard::process::next_tick, 1),
        Ts::function(
            "Calls `callback` with `args` as a JS job, after the current one and before timers.",
            &["<A extends unknown[]>(callback: (...args: A) => void, ...args: A): void"],
        ),
    ),
];

/// The host elements a UI set exports (`Registry::native_values`):
/// `nsh/base`'s `Input`, a base component the platforms make natively.
pub(crate) const ELEMENTS: &[Item] = &[(
    "Input",
    Export::Value(|cx| crate::dom::host_component(cx, "input", true)),
    Ts::function(
        "A native text input (UITextField / UITextView, EditText); `ref` has\n`focus()`, `blur()`, `setSelection(start, end)` and `insertText(text)`.",
        &["(props: InputProps): JSX.Element"],
    ),
)];

/// Value `name` a registry re-exports or names as native
/// (`Registry::native_values`): [`REEXPORTS`], [`ELEMENTS`] and
/// navigation's.
pub(crate) fn reexport(cx: *mut JsContext, name: &str) -> JsValue {
    let item = REEXPORTS
        .iter()
        .chain(ELEMENTS)
        .chain(crate::navigation::EXPORTS)
        .find(|(n, ..)| *n == name);
    match item {
        Some((n, Export::Function(f, length), _)) => {
            let cname = std::ffi::CString::new(*n).unwrap_or_default();
            reactive::new_function(cx, &cname, *f, *length)
        }
        Some((_, Export::Value(make), _)) => make(cx),
        None => {
            let message =
                std::ffi::CString::new(format!("nsh: the runtime has no native `{name}`"))
                    .unwrap_or_default();
            // SAFETY: throws on a live context.
            unsafe { qjs::JS_ThrowReferenceError(cx, c"%s".as_ptr(), message.as_ptr()) }
        }
    }
}

// --- nsh/device ---------------------------------------------------------------------

/// The OS version as a string: `"17.5"` (iOS, desktops), the API level on
/// Android (`"35"`), `"0.0"` on the web.
fn os_version(env: &Environment) -> String {
    let (major, minor) = env.os_version;
    if env.os == Os::Android {
        major.to_string()
    } else {
        format!("{major}.{minor}")
    }
}

/// `platform.idiom`: `"terminal"` in a terminal, else `"desktop"` exactly
/// where desktop behavior applies
/// ([`nsh_core::platform::Idiom::reported_on`]).
fn idiom(env: &Environment) -> &'static str {
    match env.reported_idiom() {
        Idiom::Phone => "phone",
        Idiom::Pad => "pad",
        Idiom::Mac => "mac",
        Idiom::Tv => "tv",
        Idiom::Desktop => "desktop",
        Idiom::Terminal => "terminal",
    }
}

/// `platform`: the OS and form factor, constant while the app runs.
fn platform(cx: *mut JsContext) -> JsValue {
    let e = current(cx);
    let select = reactive::new_function(cx, c"select", platform_select, 1);
    object(
        cx,
        &[
            (c"name", string(cx, e.platform_name())),
            (c"os", string(cx, e.os.name())),
            (c"version", string(cx, &os_version(&e))),
            (c"idiom", string(cx, idiom(&e))),
            (c"desktop", boolean(e.desktop())),
            (c"catalyst", boolean(e.os.is_catalyst())),
            (c"select", select),
        ],
    )
}

/// `platform.select(spec)`: this OS's value, else `mobile` / `desktop`,
/// else `native` (not on the web), else `default`.
unsafe extern "C" fn platform_select(
    cx: *mut JsContext,
    _this: JsValue,
    argc: c_int,
    argv: *mut JsValue,
) -> JsValue {
    let spec = arg(argc, argv, 0);
    // SAFETY: an inline check, then property reads of a live object.
    if !unsafe { qjs::JS_IsObject(spec) } {
        return UNDEFINED;
    }
    let env = current(cx);
    let kind = if env.desktop() { "desktop" } else { "mobile" };
    let keys = [env.os.name(), kind, "native", "default"];
    for key in keys
        .into_iter()
        .filter(|k| *k != "native" || env.os != Os::Web)
    {
        let key = std::ffi::CString::new(key).unwrap_or_default();
        let v = unsafe { qjs::JS_GetPropertyStr(cx, spec, key.as_ptr()) };
        if !unsafe { qjs::JS_IsUndefined(v) } {
            return v;
        }
    }
    UNDEFINED
}

/// The exports of `nsh/device`.
pub(crate) const DEVICE_EXPORTS: &[Item] = &[
    (
        "windowSize",
        Export::Value(|cx| accessor(cx, Part::Window)),
        Ts::value(
            "Size of the surface in points (reactive).",
            "Accessor<Size>",
        ),
    ),
    (
        "colorScheme",
        Export::Value(|cx| accessor(cx, Part::ColorScheme)),
        Ts::value(
            "The appearance shown (reactive): the system's, unless the app set its\nown (`nsh.json` `\"appearance\"`, `setColorScheme`).",
            "Accessor<\"light\" | \"dark\">",
        ),
    ),
    (
        "setColorScheme",
        Export::Function(set_color_scheme, 1),
        Ts::function(
            "Shows the app in `scheme` whatever the system's appearance, at once:\n`colorScheme()`, `dark:` classes, the components' theme and the\nplatform's controls (alerts, the status bar's default style) follow it;\n`\"system\"` follows the system again. `nsh.json` `\"appearance\"` sets it\nfrom the start.",
            &["(scheme: \"light\" | \"dark\" | \"system\"): void"],
        ),
    ),
    (
        "fpsEnabled",
        Export::Value(|cx| accessor(cx, Part::Fps)),
        Ts::value(
            "Whether the performance monitor measures (reactive): on with `--fps`,\n`NSH_FPS=1` or `setFpsEnabled(true)` where the platform has one.",
            "Accessor<boolean>",
        ),
    ),
    (
        "fontScale",
        Export::Value(|cx| accessor(cx, Part::FontScale)),
        Ts::value(
            "The user's preferred text size relative to the default (reactive):\nthe system's, unless the embedding app set its own.",
            "Accessor<number>",
        ),
    ),
    (
        "pixelRatio",
        Export::Value(|cx| accessor(cx, Part::PixelRatio)),
        Ts::value(
            "Device pixels per point (reactive): it changes when the window moves to\na screen of another density. A length on whole device pixels is\n`Math.round(x * pixelRatio()) / pixelRatio()`.",
            "Accessor<number>",
        ),
    ),
    (
        "locale",
        Export::Value(|cx| accessor(cx, Part::Locale)),
        Ts::value(
            "The user's locale as a BCP 47 tag (`\"en-US\"`, `\"zh-Hans-CN\"`), which\n`Intl` formats for by default (reactive): the system's, unless the\nembedding app set its own.",
            "Accessor<string>",
        ),
    ),
    (
        "localeSettings",
        Export::Value(|cx| accessor(cx, Part::LocaleSettings)),
        Ts::value(
            "The user's locale settings beside the locale (reactive): the preferred\nlanguages, the device's time zone and the regional preferences, the\nsystem's settings, which change together. Their names and values are\n`Intl`'s, so they pass into its options as they are\n(`new Intl.DateTimeFormat(locale(), { timeZone, hourCycle })`). Read the\none a view shows in a `computed` to follow only it. In headless tests they\nare the locale's (it alone as the languages, its region's preferences)\nin UTC, unless `open` sets `localeSettings`.",
            "Accessor<LocaleSettings>",
        ),
    ),
    (
        "lifecycle",
        Export::Value(|cx| accessor(cx, Part::Lifecycle)),
        Ts::value(
            "Whether the app is in use (reactive): `\"active\"` in the foreground,\n`\"inactive\"` while visible without the focus (another app or window has\nit, or the system shows something over it), `\"background\"` while not\nvisible (in the background, minimized or hidden). An embedded app\nfollows the embedding app's.",
            "Accessor<\"active\" | \"inactive\" | \"background\">",
        ),
    ),
    (
        "platform",
        Export::Value(platform),
        Ts::value(
            "The platform the app runs on, constant while it runs.",
            "PlatformInfo",
        ),
    ),
    (
        "shadersAvailable",
        Export::Value(|cx| accessor(cx, Part::Shaders)),
        Ts::value(
            "Whether the platform draws shader views (`Shader`, `ShaderEffect`,\n`ShaderTransition`, `ScreenEffect`, `ScreenTransition`) (reactive).\n`false` where the platform was built without a renderer or draws in a\nterminal's cells; elsewhere `true` until the first shader mounts on a\nmachine without a GPU (WebGL 2 in a browser), when it turns `false` for\ngood. Show a shader while it holds and the app's own drawing (a `Canvas`,\nan image) otherwise.",
            "Accessor<boolean>",
        ),
    ),
];

/// `nsh/device`'s types.
pub(crate) const DEVICE_TYPES: &str = r#"export interface PlatformSelectSpec<T> {
  ios?: T;
  android?: T;
  macos?: T;
  windows?: T;
  linux?: T;
  web?: T;
  /** Where `platform.desktop` is false: iOS (Mac Catalyst included),
   * Android, and browsers in the phone or tablet idiom. */
  mobile?: T;
  /** Where `platform.desktop` is true: macOS, Windows, Linux, browsers in
   * the desktop idiom, and terminals. */
  desktop?: T;
  /** Every platform but the web. */
  native?: T;
  default?: T;
}

/** The user's locale settings beside the locale (`localeSettings()`). */
export interface LocaleSettings {
  /** The preferred languages as BCP 47 tags, most preferred first: the
   * system's list (`["de-DE", "en-US"]`), with the embedding app's own
   * language first when it sets one. Show the app's text in the first it
   * has, the others are its fallbacks. */
  readonly languages: readonly string[];
  /** The device's time zone as the system names it: an IANA name
   * (`"Europe/Berlin"`, `"America/New_York"`), `"UTC"`, or an offset zone
   * where the system has one (`"GMT+01:00"` on Android). It changes with the
   * system's setting, as the user travels; `Intl` formats local time in it. */
  readonly timeZone: string;
  /** 12- or 24-hour time, as `Intl` names its hour cycles: `"h12"`
   * (`12:30 PM`), `"h23"` (`00:30`), and the rarer `"h11"` (`0:30 PM`) and
   * `"h24"` (`24:30`). The system's setting, else the region's; pass it as
   * `Intl.DateTimeFormat`'s `hourCycle` to write times as the user reads
   * them. `TimeField`'s and `DatePicker`'s `hourCycle` is `"h12"` for
   * `"h11"` and `"h12"`, `"h23"` for the others. */
  readonly hourCycle: "h11" | "h12" | "h23" | "h24";
  /** The day weeks start on, as ISO 8601 numbers days (and `Intl.Locale`'s
   * `firstDay`): 1 for Monday to 7 for Sunday. A calendar's first column.
   * The system's setting, else the region's (7 in the US, 1 in Germany).
   * `Calendar`'s and `DatePicker`'s `firstDayOfWeek` count from 0 for
   * Sunday: pass `firstDayOfWeek % 7`. */
  readonly firstDayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** The units of lengths, weights and volumes: `"metric"`, `"us"` (feet,
   * miles, pounds, gallons) or `"uk"` (metric, with miles and pints). The
   * system's setting, else the region's. */
  readonly measurementSystem: "metric" | "us" | "uk";
  /** The unit of temperatures: `"celsius"` or `"fahrenheit"`. The system's
   * setting, else the region's. */
  readonly temperatureUnit: "celsius" | "fahrenheit";
}

export interface PlatformInfo {
  /** The platform the app runs on: the OS's name on NSH's own platforms
   * (`"ios"`, `"android"`, `"macos"`, `"windows"`, `"linux"`, `"web"`), or
   * the name of a platform built outside NSH (`"miniprogram"`), whose OS is
   * `os`: handle a name you do not know. */
  readonly name: OS | (string & {});
  /** The operating system (`"ios"`, `"android"`, `"macos"`, `"windows"`,
   * `"linux"`, `"web"`). */
  readonly os: OS;
  /** iOS and desktops: the OS version (`"17.5"`); Android: the API level
   * (`"35"`); the web: `"0.0"`. */
  readonly version: string;
  /** The kind of device. `"terminal"` in a terminal: drawn on a grid of
   * character cells, with desktop behavior (`desktop` true; `os` is still
   * the machine's). Elsewhere `"desktop"` exactly where `desktop` is true,
   * else the idiom the system reports: `"phone"`, `"pad"`, `"tv"`, and
   * `"mac"`, UIKit's Mac idiom under Mac Catalyst (a mobile idiom). */
  readonly idiom: "phone" | "pad" | "mac" | "tv" | "desktop" | "terminal";
  /** Desktop behavior applies, NSH's one definition of desktop: macOS,
   * Windows, Linux, browsers in the desktop idiom (a mouse and a wide
   * viewport), and terminals. `desktop={{…}}` props and `select({ desktop })`
   * follow it. Mac Catalyst runs the iOS backend and is mobile.
   * `nsh/desktop`'s `isAvailable` is narrower: its window and menu APIs work
   * on the desktop OSes, not in browsers. */
  readonly desktop: boolean;
  /** The app runs under Mac Catalyst, in the Mac or the iPad idiom
   * (`os` is `"ios"`, `desktop` false). */
  readonly catalyst: boolean;
  /** The value for this platform: its OS (`ios`, `macos`, `web`, ...),
   * else `desktop` / `mobile` (by `platform.desktop`), else `native` (not
   * on the web), else `default`. */
  select<T>(spec: PlatformSelectSpec<T>): T | undefined;
}
"#;

// --- nsh/accessibility --------------------------------------------------------------

/// The exports of `nsh/accessibility` (with the runtime registry's).
pub(crate) const ACCESSIBILITY_EXPORTS: &[Item] = &[
    (
        "reduceMotion",
        Export::Value(|cx| accessor(cx, Part::ReduceMotion)),
        Ts::value(
            "Whether the user asked for less motion (reactive; also `motion-reduce:`).",
            "Accessor<boolean>",
        ),
    ),
    (
        "screenReaderEnabled",
        Export::Value(|cx| accessor(cx, Part::ScreenReader)),
        Ts::value(
            "Whether a screen reader (VoiceOver, TalkBack) runs (reactive).",
            "Accessor<boolean>",
        ),
    ),
];

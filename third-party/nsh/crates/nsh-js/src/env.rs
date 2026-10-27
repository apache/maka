//! The surface's environment: one signal per part
//! (window, safe area, keyboard, color scheme, font scale, screen reader,
//! reduced motion, pixel ratio, locale) written when the platform reports a
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
    element::{ThemeTokens, Token, Tokens},
    platform::{Appearance, ColorScheme, Environment, Idiom, Os, Renderer},
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
}

const PARTS: usize = 10;

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
        }
    }
}

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
        let signal = reactive::new_signal(cx, UNDEFINED);
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
    let tokens = env(cx).theme.borrow().of(json);
    if let Some(tokens) = tokens {
        set_tokens(cx, Arc::new(tokens));
    }
}

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
    if changed(&|p| p.screen_reader == next.screen_reader) {
        writes.push((Part::ScreenReader, boolean(next.screen_reader)));
    }
    if changed(&|p| p.reduce_motion == next.reduce_motion) {
        writes.push((Part::ReduceMotion, boolean(next.reduce_motion)));
    }
    if changed(&|p| p.pixel_ratio == next.pixel_ratio) {
        writes.push((Part::PixelRatio, number(next.pixel_ratio)));
    }
    // The layout direction follows the user's language.
    // SAFETY: the state's renderer, by shared reference.
    unsafe { &(*crate::state::state(cx)).dom }.set_direction(next.rtl);
    reactive::batch_with(cx, || {
        for (part, value) in writes {
            reactive::set_signal(cx, e.signals[part as usize].get(), value);
        }
    });
    let failed = reactive::finish_value(cx, UNDEFINED);
    // SAFETY: an inline tag check.
    if unsafe { qjs::JS_IsException(failed) } {
        Err(())
    } else {
        Ok(())
    }
}

fn accessor(cx: *mut JsContext, part: Part) -> JsValue {
    // SAFETY: a dup of an accessor the environment owns.
    unsafe { qjs::JS_DupValue(cx, env(cx).accessors[part as usize].get()) }
}

/// `titleBar()` (`nsh/desktop`): the hidden title bar's area (owned).
pub(crate) fn title_bar(cx: *mut JsContext) -> JsValue {
    accessor(cx, Part::TitleBar)
}

pub(crate) fn current(cx: *mut JsContext) -> Environment {
    (*env(cx).current.borrow()).unwrap_or_default()
}

/// The user's locale (`Intl`'s default), read where it is used: a change
/// applies to what is formatted next.
pub(crate) fn locale(cx: *mut JsContext) -> nsh_core::platform::Locale {
    current(cx).locale
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
            "Height of the software keyboard over the surface (0 when hidden) and the\nduration of its animation in seconds (reactive).",
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
        "A native text input (UITextField / UITextView, EditText); `ref` has\n`focus()`, `blur()` and `setSelection(start, end)`.",
        &["(props: InputProps): YNode"],
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

fn idiom(env: &Environment) -> &'static str {
    match env.idiom {
        Idiom::Phone => "phone",
        Idiom::Pad => "pad",
        Idiom::Mac => "mac",
        Idiom::Tv => "tv",
        Idiom::Desktop => "desktop",
    }
}

/// `platform`: the OS and form factor, constant while the app runs.
fn platform(cx: *mut JsContext) -> JsValue {
    let e = current(cx);
    let select = reactive::new_function(cx, c"select", platform_select, 1);
    object(
        cx,
        &[
            (c"renderer", string(cx, e.renderer.name())),
            (c"isTerminal", boolean(e.renderer == Renderer::Terminal)),
            (c"os", string(cx, e.os.name())),
            (c"version", string(cx, &os_version(&e))),
            (c"idiom", string(cx, idiom(&e))),
            (c"catalyst", boolean(e.idiom == Idiom::Mac)),
            (c"select", select),
        ],
    )
}

/// `platform.select(spec)`: terminals try `terminal`, then the OS. Graphical
/// surfaces try the OS, then `mobile` / `desktop`. Both try `native` (off
/// the web) and `default` afterwards.
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
    let terminal = env.renderer == Renderer::Terminal;
    let kind = if env.desktop() { "desktop" } else { "mobile" };
    let keys = [
        terminal.then_some("terminal"),
        Some(env.os.name()),
        (!terminal).then_some(kind),
        Some("native"),
        Some("default"),
    ];
    for key in keys
        .into_iter()
        .flatten()
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
        "platform",
        Export::Value(platform),
        Ts::value(
            "The platform the app runs on, constant while it runs.",
            "PlatformInfo",
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
  /** Terminal rendering, before the operating system's value. */
  terminal?: T;
  /** iOS, Android, and phone and tablet browsers. */
  mobile?: T;
  /** Graphical macOS, Windows, Linux, and desktop browsers. */
  desktop?: T;
  /** Every platform but the web. */
  native?: T;
  default?: T;
}

export interface PlatformInfo {
  /** How the surface presents its UI, independently of its operating system. */
  readonly renderer: "native" | "web" | "terminal";
  /** The surface renders in terminal cells. */
  readonly isTerminal: boolean;
  /** The operating system (`"ios"`, `"android"`, `"macos"`, `"windows"`,
   * `"linux"`, `"web"`). */
  readonly os: OS;
  /** iOS and desktops: the OS version (`"17.5"`); Android: the API level
   * (`"35"`); the web: `"0.0"`. */
  readonly version: string;
  /** The kind of device. `"desktop"`: desktop behavior applies (macOS,
   * Windows, Linux, and browsers with a mouse and a wide viewport); Mac
   * Catalyst in the Mac idiom is `"mac"`. */
  readonly idiom: "phone" | "pad" | "mac" | "tv" | "desktop";
  /** Mac Catalyst in the Mac idiom. */
  readonly catalyst: boolean;
  /** Terminals try `terminal`, then the OS. Graphical surfaces try the OS,
   * else `mobile` / `desktop`, else `native` (not on the web), else
   * `default`. */
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

//! What only desktops have: windows ([`window`]), the application menu,
//! context menus and keyboard shortcuts (TS `nsh/desktop`). The platforms
//! get them as [`DesktopCommand`]s on a window's root node (the main
//! window's is the root) and report a chosen menu item as
//! [`crate::EventKind::Menu`]; mobile platforms ignore them. The platforms
//! report the main window's state in the environment ([`WindowState`]),
//! the other windows' as [`WindowEvent`]s, and the displays with their own
//! message ([`Display`]). The app's login item is a backend the runner
//! gives the core ([`LoginItemBackend`]).

use std::sync::Arc;

use crate::{
    ImageSource,
    color::Hsla,
    element::{JsHost, JsIn, JsKind, JsObject, JsOwned, JsValue, PropEnum, PropError, TsTypes},
    geometry::{Point, Points},
    keymap::{self, Keystroke, Modifiers, When},
    platform::Os,
};

mod login_item;
#[cfg(not(target_arch = "wasm32"))]
pub mod menu_icon;
pub mod window;
mod window_state;

pub(crate) use login_item::LoginItems;
pub use login_item::{LaunchAtLoginError, LoginItemBackend, LoginItemStatus};
pub use window::{
    Backdrop, CloseReason, MainWindowOptions, OpenWindow, ProgressState, ResizeEdge, SizeToContent,
    TitleBarOptions, WindowAttributes, WindowBackend, WindowCloseCause, WindowControl, WindowEvent,
    WindowKind, WindowMode, WindowOptions, WindowPointerEvents, WindowPosition, WindowProgress,
    WindowRequest, Workspaces,
};
pub use window_state::{
    Display, DisplayId, NativeDesktopBounds, NativeDesktopUnit, WindowPlacement, WindowState, notch,
};

/// Additional sources of quit requests on standalone macOS apps. Both
/// options default to false and require a quit request listener. Other
/// platforms and embedded views keep their existing lifecycle.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, JsObject)]
#[non_exhaustive]
pub struct QuitRequestOptions {
    /// Asks the app before logout, restart or shutdown. Call `quit()` to
    /// approve, or `cancel_quit_request()` to cancel the system request.
    #[prop(default)]
    pub system: bool,
    /// Asks before a user closes the main window when that would end the
    /// app. A window with `close_on_press: false` uses its close handler
    /// instead; a window kept alive on close still hides as before.
    #[prop(default)]
    pub main_window_close: bool,
}

impl QuitRequestOptions {
    /// Whether logout, restart and shutdown ask the quit listener.
    pub fn system(mut self, system: bool) -> Self {
        self.system = system;
        self
    }

    /// Whether closing the main window asks the quit listener when that
    /// close would end the app.
    pub fn main_window_close(mut self, main_window_close: bool) -> Self {
        self.main_window_close = main_window_close;
        self
    }
}

/// How a window's title bar looks ([`TitleBarOptions::style`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum TitleBarStyle {
    /// The system's title bar, above the app.
    #[default]
    Default,
    /// No system title bar: the app fills the window up to its top edge
    /// and draws its own title bar, which views with `windowDrag` make
    /// draggable. The system's window controls stay (macOS's traffic
    /// lights, Windows' caption buttons, GTK's window buttons) in the area
    /// the environment's `title_bar` reports.
    Hidden,
}

/// When the window's menu bar shows (`Menu.setMenuBar`), where the app's
/// window draws one (the GPUI backend on Windows and Linux).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum MenuBarMode {
    /// Always, above the app.
    #[default]
    Shown,
    /// Hidden until Alt is pressed and released alone, which shows it until
    /// Alt alone hides it again. F10 and Alt with a menu's initial open a
    /// menu, and the bar shows while it is open.
    #[prop(rename = "autoHide")]
    AutoHide,
}

/// A window's frame (`WindowRef.setBounds`): the part of it to move, in
/// points, in screen coordinates; a field left out keeps its value. The
/// origin is the window's top left corner, measured from the top left of
/// the primary screen (the one with the menu bar on macOS) with `y`
/// growing down, on every platform. TS gives `origin` (`x`, `y`) and
/// `size` (`width`, `height`) as `Partial<Point>` and `Partial<Size>`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WindowFrame {
    /// Its left edge.
    pub x: Option<Points>,
    /// Its top edge, growing down; changing the height without a `y`
    /// keeps the top edge where it is (the window grows and shrinks at its
    /// bottom edge).
    pub y: Option<Points>,
    /// Its outer width on macOS / Windows, GTK default width on Linux;
    /// in GPUI windows, the content's width (at least 1 point).
    pub width: Option<Points>,
    /// Its outer height on macOS / Windows, GTK default height on Linux;
    /// in GPUI windows, the content's height (at least 1 point).
    pub height: Option<Points>,
    /// Animates the change on macOS (false by default; GPUI ignores it).
    pub animated: Option<bool>,
}

/// TS: `{ origin?: Partial<Point>; size?: Partial<Size>; animated? }`.
impl JsValue for WindowFrame {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("WindowFrame", |_| {
            "/** A window's frame (`WindowRef.setBounds`): the part of it to move, in points, in screen coordinates; a field left out keeps its value. */\n\
             export interface WindowFrame {\n  \
             /** Its top left corner, from the primary screen's top left corner, `y` growing down. A height changed without a `y` keeps the top edge where it is: the window grows and shrinks at its bottom edge. */\n  \
             origin?: Partial<Point>;\n  \
             /** Its outer size on macOS / Windows, GTK's default size on Linux. */\n  \
             size?: Partial<Size>;\n  \
             /** Animates the change on macOS (false by default). */\n  \
             animated?: boolean;\n}"
                .into()
        })
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        if value.kind() != JsKind::Object {
            return Err(value.expected("an object"));
        }
        // Field `key` of `object` as `T`, `None` when it is left out.
        fn get<T: JsValue>(object: JsIn<'_>, key: &str) -> Result<Option<T>, PropError> {
            let v = object.field(key)?;
            let v = v.get();
            if v.is_nullish() {
                return Ok(None);
            }
            T::from_js(v)
                .map(Some)
                .map_err(|e| PropError(format!("`{key}`: {e}")))
        }
        let mut frame = WindowFrame {
            animated: get(value, "animated")?,
            ..WindowFrame::default()
        };
        let origin = value.field("origin")?;
        if !origin.get().is_nullish() {
            frame.x = get(origin.get(), "x")?;
            frame.y = get(origin.get(), "y")?;
        }
        let size = value.field("size")?;
        if !size.get().is_nullish() {
            frame.width = get(size.get(), "width")?;
            frame.height = get(size.get(), "height")?;
        }
        Ok(frame)
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        let owned = JsOwned::new(host, host.new_object()?);
        let object = owned.get().raw();
        let part = |fields: [(&str, Option<Points>); 2]| -> Result<Option<JsOwned<'a>>, PropError> {
            if fields.iter().all(|(_, v)| v.is_none()) {
                return Ok(None);
            }
            let part = JsOwned::new(host, host.new_object()?);
            for (key, value) in fields {
                if let Some(value) = value {
                    host.set_field(part.get().raw(), key, value.to_js(host)?.into_raw())?;
                }
            }
            Ok(Some(part))
        };
        if let Some(origin) = part([("x", self.x), ("y", self.y)])? {
            host.set_field(object, "origin", origin.into_raw())?;
        }
        if let Some(size) = part([("width", self.width), ("height", self.height)])? {
            host.set_field(object, "size", size.into_raw())?;
        }
        if let Some(v) = self.animated {
            host.set_field(object, "animated", v.to_js(host)?.into_raw())?;
        }
        Ok(owned)
    }
}

/// How high a window floats (its `level`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum WindowLevel {
    /// The normal level.
    #[default]
    Normal,
    /// Above normal windows: a floating palette or a widget.
    Floating,
    /// Above the Dock and the taskbar (an overlay, a launcher).
    #[prop(rename = "aboveDock")]
    AboveDock,
    /// macOS's desktop icon level; on Windows, moves to the bottom of
    /// the current z-order (later activation can raise the window).
    #[prop(rename = "desktopIcon")]
    DesktopIcon,
}

/// Whether a window has the system's frame (its `frame`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, PropEnum)]
pub enum WindowFrameStyle {
    /// The system's title bar and border.
    #[default]
    Default,
    /// No title bar or border: the app draws everything.
    None,
}

/// A key of a [`Shortcut`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
    /// A character key, lowercase (`a`, `1`, `,`, `=`).
    Char(char),
    /// Enter / Return.
    Enter,
    /// Escape.
    Escape,
    /// Tab.
    Tab,
    /// Backspace.
    Backspace,
    /// Delete (forward).
    Delete,
    /// Insert.
    Insert,
    /// The space bar.
    Space,
    /// Arrow up.
    Up,
    /// Arrow down.
    Down,
    /// Arrow left.
    Left,
    /// Arrow right.
    Right,
    /// Home.
    Home,
    /// End.
    End,
    /// Page up.
    PageUp,
    /// Page down.
    PageDown,
    /// A function key, F1 to F24.
    F(u8),
}

impl Key {
    /// The key named `name`: a key name (`"enter"`, `"f5"`, `"plus"`) or
    /// the character the key types on the US layout without Shift (`"n"`,
    /// `"1"`, `","`), in any case ([`Shortcut::parse`]).
    pub fn parse(name: &str) -> Option<Key> {
        parse_key(name, &name.to_ascii_lowercase()).ok()
    }

    /// Its name in a shortcut's label (`N`, `Enter`, `F5`).
    pub fn label(self) -> String {
        match self {
            Key::Char(c) => c.to_uppercase().collect(),
            Key::Enter => "Enter".into(),
            Key::Escape => "Esc".into(),
            Key::Tab => "Tab".into(),
            Key::Backspace => "Backspace".into(),
            Key::Delete => "Del".into(),
            Key::Insert => "Ins".into(),
            Key::Space => "Space".into(),
            Key::Up => "Up".into(),
            Key::Down => "Down".into(),
            Key::Left => "Left".into(),
            Key::Right => "Right".into(),
            Key::Home => "Home".into(),
            Key::End => "End".into(),
            Key::PageUp => "PgUp".into(),
            Key::PageDown => "PgDn".into(),
            Key::F(n) => format!("F{n}"),
        }
    }
}

/// A keyboard shortcut of a menu item (`"mod+shift+n"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Shortcut {
    /// The key.
    pub key: Key,
    /// Control.
    pub ctrl: bool,
    /// Alt / Option.
    pub alt: bool,
    /// Shift.
    pub shift: bool,
    /// Command (macOS) / the Windows key / Super.
    pub meta: bool,
}

impl Shortcut {
    /// A shortcut of `key` alone.
    pub const fn key(key: Key) -> Shortcut {
        Shortcut {
            key,
            ctrl: false,
            alt: false,
            shift: false,
            meta: false,
        }
    }

    /// Parses `"mod+shift+n"`: modifiers and one key joined by `+`, in any
    /// case (lowercase is the style; a capital letter is the same key, not
    /// Shift). `mod` (`cmdorctrl`, `commandorcontrol`) is Command when
    /// `mod_is_meta` (macOS), else Control; `cmd` (`command`, `meta`,
    /// `super`, `win`) is Command, the Windows key or Super; then `ctrl`
    /// (`control`), `alt` (`option`, `opt`) and `shift`. The key is a name
    /// or the US layout's unshifted character ([`Key::parse`]); `plus` is
    /// the `=` key. `nsh/keymap` (`crate::keymap`) reads the same
    /// keystrokes, with the same messages for those that are not.
    pub fn parse(text: &str, mod_is_meta: bool) -> Result<Shortcut, ShortcutError> {
        // Case does not matter; messages quote the text as written and
        // suggest lowercase.
        let lower = text.to_ascii_lowercase();
        let (mods, key) = split(text, &lower)?;
        // Modifiers first, as `nsh/keymap` reads them (so are its errors).
        let mut shortcut = Shortcut::key(Key::Space);
        for name in mods {
            let flag =
                modifier(&mut shortcut, name, mod_is_meta).map_err(|why| error(text, why))?;
            if *flag {
                return Err(error(text, format_args!("{name:?} twice")));
            }
            *flag = true;
        }
        shortcut.key = parse_key(text, key)?;
        Ok(shortcut)
    }

    /// Its label on Windows and Linux (`Ctrl+Shift+N`).
    pub fn label(&self) -> String {
        let mut out = String::new();
        for (on, name) in [
            (self.ctrl, "Ctrl+"),
            (self.alt, "Alt+"),
            (self.shift, "Shift+"),
            (self.meta, "Win+"),
        ] {
            if on {
                out.push_str(name);
            }
        }
        out.push_str(&self.key.label());
        out
    }

    /// Its label on `os`: on macOS as symbols in the order Apple writes
    /// them (`⌃⌥⇧⌘C`), else [`Shortcut::label`].
    pub fn label_for(&self, os: Os) -> String {
        if os != Os::MacOs {
            return self.label();
        }
        self.keystroke().label(os, true)
    }

    /// Whether a focused text field uses this shortcut itself, as it uses
    /// the same keystroke of `nsh/keymap` ([`Keystroke::edits_text`]).
    pub fn edits_text(&self) -> bool {
        self.keystroke().edits_text()
    }

    /// The same keystroke as `nsh/keymap` reads it.
    fn keystroke(&self) -> Keystroke {
        let key = match self.key {
            Key::Char(c) => keymap::Key::Char(c),
            Key::Space => keymap::Key::Char(' '),
            Key::Enter => keymap::Key::Enter,
            Key::Escape => keymap::Key::Escape,
            Key::Tab => keymap::Key::Tab,
            Key::Backspace => keymap::Key::Backspace,
            Key::Delete => keymap::Key::Delete,
            Key::Insert => keymap::Key::Insert,
            Key::Up => keymap::Key::Up,
            Key::Down => keymap::Key::Down,
            Key::Left => keymap::Key::Left,
            Key::Right => keymap::Key::Right,
            Key::Home => keymap::Key::Home,
            Key::End => keymap::Key::End,
            Key::PageUp => keymap::Key::PageUp,
            Key::PageDown => keymap::Key::PageDown,
            Key::F(n) => keymap::Key::F(n),
        };
        let modifiers = Modifiers {
            ctrl: self.ctrl,
            alt: self.alt,
            shift: self.shift,
            cmd: self.meta,
        };
        Keystroke { modifiers, key }
    }
}

/// Why a shortcut's text is not one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShortcutError(pub String);

impl std::fmt::Display for ShortcutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ShortcutError {}

fn error(text: &str, reason: impl std::fmt::Display) -> ShortcutError {
    ShortcutError(format!("invalid keystroke {text:?}: {reason}"))
}

/// Characters typed with Shift on the US layout, and the key typing them.
const SHIFTED: &[(char, char)] = &[
    ('~', '`'),
    ('!', '1'),
    ('@', '2'),
    ('#', '3'),
    ('$', '4'),
    ('%', '5'),
    ('^', '6'),
    ('&', '7'),
    ('*', '8'),
    ('(', '9'),
    (')', '0'),
    ('_', '-'),
    ('+', '='),
    ('{', '['),
    ('}', ']'),
    ('|', '\\'),
    (':', ';'),
    ('"', '\''),
    ('<', ','),
    ('>', '.'),
    ('?', '/'),
];

/// Named keys, by their (lowercase) names.
const NAMED: &[(&str, Key)] = &[
    ("enter", Key::Enter),
    ("return", Key::Enter),
    ("escape", Key::Escape),
    ("esc", Key::Escape),
    ("tab", Key::Tab),
    ("space", Key::Space),
    ("backspace", Key::Backspace),
    ("delete", Key::Delete),
    ("del", Key::Delete),
    ("insert", Key::Insert),
    ("up", Key::Up),
    ("arrowup", Key::Up),
    ("down", Key::Down),
    ("arrowdown", Key::Down),
    ("left", Key::Left),
    ("arrowleft", Key::Left),
    ("right", Key::Right),
    ("arrowright", Key::Right),
    ("home", Key::Home),
    ("end", Key::End),
    ("pageup", Key::PageUp),
    ("pagedown", Key::PageDown),
    // The plus key is the one typing `=`, as on the US layout.
    ("plus", Key::Char('=')),
    ("minus", Key::Char('-')),
];

/// The modifiers and the key of `text` (`"mod+shift+n"`).
fn split<'a>(text: &str, lower: &'a str) -> Result<(Vec<&'a str>, &'a str), ShortcutError> {
    if text.is_empty() {
        return Err(error(text, "empty"));
    }
    if text.contains(char::is_whitespace) {
        return Err(error(
            text,
            "one keystroke per binding (key sequences such as \"mod+k mod+s\" are not supported)",
        ));
    }
    if lower == "+" || lower.ends_with("++") {
        let mods = lower.strip_suffix("++").unwrap_or("");
        let plus = if mods.is_empty() {
            "plus".to_owned()
        } else {
            format!("{mods}+plus")
        };
        return Err(error(
            text,
            format_args!("write the plus key as \"plus\": {plus:?}"),
        ));
    }
    let (mods, key) = match lower.rsplit_once('+') {
        Some((mods, key)) => (mods.split('+').collect(), key),
        None => (Vec::new(), lower),
    };
    if key.is_empty() {
        return Err(error(text, "no key after the modifiers"));
    }
    Ok((mods, key))
}

/// The flag of modifier `name` in `shortcut`, or why it is none.
fn modifier<'a>(
    shortcut: &'a mut Shortcut,
    name: &str,
    mod_is_meta: bool,
) -> Result<&'a mut bool, String> {
    Ok(match name {
        "ctrl" | "control" => &mut shortcut.ctrl,
        "alt" | "option" | "opt" => &mut shortcut.alt,
        "shift" => &mut shortcut.shift,
        "cmd" | "command" | "meta" | "super" | "win" => &mut shortcut.meta,
        "mod" | "cmdorctrl" | "commandorcontrol" if mod_is_meta => &mut shortcut.meta,
        "mod" | "cmdorctrl" | "commandorcontrol" => &mut shortcut.ctrl,
        "" => return Err("an empty modifier".into()),
        other => {
            return Err(format!(
                "unknown modifier {other:?} (ctrl, alt, shift, cmd or mod)"
            ));
        }
    })
}

fn parse_key(text: &str, key: &str) -> Result<Key, ShortcutError> {
    if let Some(&(_, named)) = NAMED.iter().find(|(name, _)| *name == key) {
        return Ok(named);
    }
    if let Some(n) = key
        .strip_prefix('f')
        .filter(|n| !n.starts_with('0'))
        .and_then(|n| n.parse::<u8>().ok())
        && (1..=24).contains(&n)
    {
        return Ok(Key::F(n));
    }
    let mut chars = key.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        let hint = if let Some((first, _)) = key.split_once('-')
            && modifier(&mut Shortcut::key(Key::Space), first, false).is_ok()
        {
            // `mod--` is `mod+-`.
            let joined = match key.strip_suffix("--") {
                Some(mods) => format!("{}+-", mods.replace('-', "+")),
                None => key.replace('-', "+"),
            };
            format!(" (join modifiers and the key with \"+\": {joined:?})")
        } else {
            String::new()
        };
        return Err(error(text, format_args!("unknown key {key:?}{hint}")));
    };
    if let Some(&(_, base)) = SHIFTED.iter().find(|(shifted, _)| *shifted == c) {
        return Err(error(
            text,
            format_args!("{c:?} is typed with Shift: write \"shift+{base}\""),
        ));
    }
    if !c.is_ascii_graphic() {
        return Err(error(
            text,
            "keys are named by the US layout's characters (they match on any layout)",
        ));
    }
    Ok(Key::Char(c))
}

/// A standard menu item: the platform carries it out (and labels it when
/// the item has no label of its own).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PropEnum)]
pub enum MenuRole {
    /// The about panel (macOS).
    About,
    /// Hides the app (macOS).
    Hide,
    /// Hides the other apps (macOS).
    HideOthers,
    /// Shows all apps (macOS).
    ShowAll,
    /// Quits the app.
    Quit,
    /// Undo in the focused text field.
    Undo,
    /// Redo in the focused text field.
    Redo,
    /// Cut the focused text field's selection.
    Cut,
    /// Copy the selection.
    Copy,
    /// Paste into the focused text field.
    Paste,
    /// Select all of the focused text field.
    SelectAll,
    /// Minimizes the window.
    Minimize,
    /// Maximizes (zooms) or restores the window.
    Zoom,
    /// Enters or leaves full screen.
    ToggleFullScreen,
    /// Closes the window.
    Close,
}

impl MenuRole {
    /// Every role.
    pub const ALL: &[MenuRole] = &[
        MenuRole::About,
        MenuRole::Hide,
        MenuRole::HideOthers,
        MenuRole::ShowAll,
        MenuRole::Quit,
        MenuRole::Undo,
        MenuRole::Redo,
        MenuRole::Cut,
        MenuRole::Copy,
        MenuRole::Paste,
        MenuRole::SelectAll,
        MenuRole::Minimize,
        MenuRole::Zoom,
        MenuRole::ToggleFullScreen,
        MenuRole::Close,
    ];

    /// The label of an item with this role and no label of its own.
    pub fn label(self) -> &'static str {
        match self {
            MenuRole::About => "About",
            MenuRole::Hide => "Hide",
            MenuRole::HideOthers => "Hide Others",
            MenuRole::ShowAll => "Show All",
            MenuRole::Quit => "Quit",
            MenuRole::Undo => "Undo",
            MenuRole::Redo => "Redo",
            MenuRole::Cut => "Cut",
            MenuRole::Copy => "Copy",
            MenuRole::Paste => "Paste",
            MenuRole::SelectAll => "Select All",
            MenuRole::Minimize => "Minimize",
            MenuRole::Zoom => "Zoom",
            MenuRole::ToggleFullScreen => "Toggle Full Screen",
            MenuRole::Close => "Close",
        }
    }

    /// The shortcut of an item with this role and no shortcut of its own,
    /// on a Mac (`mac`) or elsewhere.
    pub fn shortcut(self, mac: bool) -> Option<Shortcut> {
        let primary = |key: char| Shortcut {
            ctrl: !mac,
            meta: mac,
            ..Shortcut::key(Key::Char(key))
        };
        Some(match self {
            MenuRole::About | MenuRole::ShowAll => return None,
            MenuRole::Hide if mac => primary('h'),
            MenuRole::HideOthers if mac => Shortcut {
                alt: true,
                ..primary('h')
            },
            MenuRole::Hide | MenuRole::HideOthers => return None,
            MenuRole::Quit if mac => primary('q'),
            MenuRole::Quit => Shortcut {
                alt: true,
                ..Shortcut::key(Key::F(4))
            },
            MenuRole::Undo => primary('z'),
            MenuRole::Redo if mac => Shortcut {
                shift: true,
                ..primary('z')
            },
            MenuRole::Redo => primary('y'),
            MenuRole::Cut => primary('x'),
            MenuRole::Copy => primary('c'),
            MenuRole::Paste => primary('v'),
            MenuRole::SelectAll => primary('a'),
            MenuRole::Minimize if mac => primary('m'),
            MenuRole::Minimize | MenuRole::Zoom => return None,
            MenuRole::ToggleFullScreen if mac => Shortcut {
                ctrl: true,
                ..primary('f')
            },
            MenuRole::ToggleFullScreen => Shortcut::key(Key::F(11)),
            MenuRole::Close => primary('w'),
        })
    }

    /// The role edits the focused text field (its shortcut is the field's
    /// own: a menu does not take it from the field).
    pub fn edits_text(self) -> bool {
        matches!(
            self,
            MenuRole::Undo
                | MenuRole::Redo
                | MenuRole::Cut
                | MenuRole::Copy
                | MenuRole::Paste
                | MenuRole::SelectAll
        )
    }
}

/// The translated labels sent by the core to desktop backends for the
/// menus NSH builds. These follow the app's language (`nsh/i18n`); apps
/// override individual menu items through their existing `label` field.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct MenuLabels {
    /// Role labels; `%{app}` is replaced with the app name on macOS.
    pub roles: std::collections::HashMap<MenuRole, String>,
    /// The title of the standard menu bar's Edit menu (`"Edit"`).
    pub edit_menu: Option<String>,
    /// The title of the standard menu bar's Window menu (`"Window"`).
    pub window_menu: Option<String>,
    /// The Delete item of a text field's edit menu, where NSH shows its own
    /// (`"Delete"`).
    pub delete: Option<String>,
}

impl MenuLabels {
    pub(crate) fn for_locale(locale: crate::platform::Locale, mac: bool) -> Self {
        static TEXTS: std::sync::OnceLock<crate::i18n::Translations> = std::sync::OnceLock::new();
        let texts = TEXTS.get_or_init(|| {
            crate::i18n::Translations::from_json(include_str!("desktop/menu.json"))
                .expect("the built-in menu translations are valid")
        });
        // Region-only Chinese tags select the traditional script there.
        let language = match locale.as_str() {
            "zh-TW" | "zh-HK" | "zh-MO" => "zh-Hant",
            language => language,
        };
        let text = |key: &str| texts.lookup(language, key).map(|text| text.into_owned());
        Self {
            roles: MenuRole::ALL
                .iter()
                .filter_map(|role| {
                    let key = match (role, mac) {
                        (MenuRole::About, true) => "About App",
                        (MenuRole::Hide, true) => "Hide App",
                        (MenuRole::Quit, true) => "Quit App",
                        (MenuRole::ToggleFullScreen, true) => "Enter Full Screen",
                        _ => role.label(),
                    };
                    let label = if mac {
                        text(key)
                    } else {
                        text(&format!("Windows {key}")).or_else(|| text(key))
                    };
                    label.map(|label| (*role, label))
                })
                .collect(),
            edit_menu: text("Edit"),
            window_menu: text("Window"),
            delete: text("Delete"),
        }
    }

    /// NSH's translated label of `role`, when available.
    pub fn role(&self, role: MenuRole) -> Option<&str> {
        self.roles.get(&role).map(String::as_str)
    }

    /// The label of an item with `role` and no label of its own: the
    /// translated label, else [`MenuRole::label`].
    pub fn label(&self, role: MenuRole) -> &str {
        self.role(role).unwrap_or(role.label())
    }
}

/// An item of a menu that does something.
#[derive(Debug, Clone, PartialEq)]
pub struct MenuAction {
    /// Reported as [`crate::EventKind::Menu`] when chosen (0: never
    /// reported, a role-only item).
    pub id: u32,
    /// What it shows.
    pub label: String,
    /// Its keyboard shortcut.
    pub shortcut: Option<Shortcut>,
    /// It can be chosen.
    pub enabled: bool,
    /// A check mark: `Some` makes it a checkable item.
    pub checked: Option<bool>,
    /// What the platform does with it (the app is not told).
    pub role: Option<MenuRole>,
    /// When its shortcut chooses it while a text field has the keyboard
    /// focus (`when`); [`When::Always`] unless the app says otherwise.
    pub when: When,
    /// What it shows beside its label, the app's own image ([`menu_icon`]).
    pub icon: Option<ImageSource>,
    /// An SF Symbol name beside its label in iOS header menus; ignored
    /// elsewhere (including macOS). Prefer this over putting a symbol name
    /// in [`Self::icon`], which is an image source.
    pub symbol: Option<String>,
    /// Shown as a destructive action on iOS (red); the desktops ignore it.
    pub destructive: bool,
}

impl MenuAction {
    /// Whether its shortcut chooses it while a text field has the keyboard
    /// focus: with [`When::Auto`], unless the field uses the keystroke
    /// itself ([`Shortcut::edits_text`]), as `nsh/keymap`'s bindings.
    pub fn fires_while_editing(&self) -> bool {
        match self.when {
            When::Always => true,
            When::NotEditing => false,
            When::Auto => !self.shortcut.is_some_and(|s| s.edits_text()),
        }
    }
}

/// An item of a menu.
#[derive(Debug, Clone, PartialEq)]
pub enum MenuItem {
    /// A line between groups of items.
    Separator,
    /// An item that does something.
    Action(MenuAction),
    /// An item opening a menu of its own (the top-level menus of a menu
    /// bar), or an inline section when [`inline`](Self::Submenu::inline) is
    /// set.
    Submenu {
        /// What it shows.
        label: String,
        /// It can be opened.
        enabled: bool,
        /// Its items.
        items: Vec<MenuItem>,
        /// What it shows beside its label ([`menu_icon`]), but for the
        /// top-level menus of a menu bar, which show their titles alone.
        icon: Option<ImageSource>,
        /// An SF Symbol name beside its label in iOS header menus; ignored
        /// elsewhere (including macOS).
        symbol: Option<String>,
        /// An inline section: on iOS, `UIMenuOptions.displayInline` with
        /// `label` as the section title; on the desktops, its items between
        /// separators, its label not shown ([`Self::with_inline_expanded`]).
        inline: bool,
    },
}

impl MenuItem {
    /// The items of a selection menu (`selectionMenu`), as the platforms
    /// show them after the system's own: plain items and separators.
    /// Inline sections are expanded ([`Self::with_inline_expanded`]);
    /// submenus, roles (the system's items are there already), shortcuts
    /// and check marks are left out, as are items with no label and
    /// separators that separate nothing.
    pub fn selection_menu(items: &[MenuItem]) -> Vec<MenuItem> {
        let mut out: Vec<MenuItem> = Vec::new();
        for item in Self::with_inline_expanded(items) {
            match item {
                MenuItem::Separator => {
                    if matches!(out.last(), Some(MenuItem::Action(_))) {
                        out.push(MenuItem::Separator);
                    }
                }
                MenuItem::Action(action) if action.role.is_none() && !action.label.is_empty() => {
                    out.push(MenuItem::Action(MenuAction {
                        shortcut: None,
                        checked: None,
                        when: When::Always,
                        ..action
                    }));
                }
                MenuItem::Action(_) | MenuItem::Submenu { .. } => {}
            }
        }
        if matches!(out.last(), Some(MenuItem::Separator)) {
            out.pop();
        }
        out
    }

    /// Expands [`inline`](Self::Submenu::inline) submenus into their items
    /// between separators (no leading or trailing separator, label not
    /// shown), for the desktops. Nested non-inline submenus are kept;
    /// their children are expanded the same way. A disabled inline section
    /// disables the items it brings, as iOS disables a disabled section's
    /// children. iOS header menus keep inline sections as they are.
    #[doc(hidden)]
    pub fn with_inline_expanded(items: &[MenuItem]) -> Vec<MenuItem> {
        let mut out = Vec::new();
        for item in items {
            match item {
                MenuItem::Submenu {
                    items,
                    enabled,
                    inline: true,
                    ..
                } => {
                    if !out.is_empty() && !matches!(out.last(), Some(MenuItem::Separator)) {
                        out.push(MenuItem::Separator);
                    }
                    let expanded = Self::with_inline_expanded(items);
                    if *enabled {
                        out.extend(expanded);
                    } else {
                        out.extend(expanded.into_iter().map(MenuItem::disabled));
                    }
                    if !matches!(out.last(), Some(MenuItem::Separator) | None) {
                        out.push(MenuItem::Separator);
                    }
                }
                MenuItem::Submenu {
                    label,
                    enabled,
                    items,
                    icon,
                    symbol,
                    inline: false,
                } => out.push(MenuItem::Submenu {
                    label: label.clone(),
                    enabled: *enabled,
                    items: Self::with_inline_expanded(items),
                    icon: icon.clone(),
                    symbol: symbol.clone(),
                    inline: false,
                }),
                // An explicit separator after an inline section would
                // otherwise double the one the expansion already pushed.
                MenuItem::Separator if matches!(out.last(), Some(MenuItem::Separator)) => {}
                other => out.push(other.clone()),
            }
        }
        while matches!(out.last(), Some(MenuItem::Separator)) {
            out.pop();
        }
        out
    }

    /// This item, disabled: an action can't be chosen, a submenu can't be
    /// opened. A separator stays as it is.
    fn disabled(self) -> MenuItem {
        match self {
            MenuItem::Action(action) => MenuItem::Action(MenuAction {
                enabled: false,
                ..action
            }),
            MenuItem::Submenu {
                label,
                items,
                icon,
                symbol,
                inline,
                ..
            } => MenuItem::Submenu {
                label,
                enabled: false,
                items,
                icon,
                symbol,
                inline,
            },
            MenuItem::Separator => MenuItem::Separator,
        }
    }

    /// The index in `items` (a menu bar's top-level items) of its Window
    /// menu: the first submenu holding a window role (`Minimize`, `Zoom`,
    /// `ToggleFullScreen` or `Close`), at any depth. macOS lists the app's
    /// open windows at its end.
    #[doc(hidden)]
    pub fn window_menu(items: &[MenuItem]) -> Option<usize> {
        fn has_window_role(items: &[MenuItem]) -> bool {
            items.iter().any(|item| match item {
                MenuItem::Action(action) => matches!(
                    action.role,
                    Some(
                        MenuRole::Minimize
                            | MenuRole::Zoom
                            | MenuRole::ToggleFullScreen
                            | MenuRole::Close
                    )
                ),
                MenuItem::Submenu { items, .. } => has_window_role(items),
                MenuItem::Separator => false,
            })
        }
        items.iter().position(|item| match item {
            MenuItem::Submenu { items, .. } => has_window_role(items),
            _ => false,
        })
    }

    /// Calls `f` with the icon of every item of `items`, submenus' too.
    pub fn each_icon<'a>(items: &'a [MenuItem], f: &mut impl FnMut(&'a ImageSource)) {
        for item in items {
            match item {
                MenuItem::Action(action) => action.icon.iter().for_each(&mut *f),
                MenuItem::Submenu { items, icon, .. } => {
                    icon.iter().for_each(&mut *f);
                    MenuItem::each_icon(items, f);
                }
                MenuItem::Separator => {}
            }
        }
    }

    /// Calls `f` with every action of `items`, submenus' too.
    pub fn each_action<'a>(items: &'a [MenuItem], f: &mut impl FnMut(&'a MenuAction)) {
        for item in items {
            match item {
                MenuItem::Action(action) => f(action),
                MenuItem::Submenu { items, .. } => MenuItem::each_action(items, f),
                MenuItem::Separator => {}
            }
        }
    }

    /// The action of `items` (or their submenus) that `shortcut` chooses:
    /// enabled, with an id or a role that is not a text field's own.
    pub fn find_shortcut<'a>(items: &'a [MenuItem], shortcut: &Shortcut) -> Option<&'a MenuAction> {
        for item in items {
            match item {
                MenuItem::Action(action)
                    if action.enabled
                        && action.shortcut.as_ref() == Some(shortcut)
                        && !action.role.is_some_and(MenuRole::edits_text) =>
                {
                    return Some(action);
                }
                MenuItem::Submenu {
                    enabled: true,
                    items,
                    ..
                } => {
                    if let Some(found) = MenuItem::find_shortcut(items, shortcut) {
                        return Some(found);
                    }
                }
                _ => {}
            }
        }
        None
    }
}

/// A desktop command, on a window's root node (the root for the main
/// window and what is the app's: menus, the tray, global shortcuts).
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopCommand {
    /// Shows the dialog root the command is addressed to in a window of its
    /// own, until the node is removed. Sent before the node is inserted; a
    /// platform without windows of its own ignores it (the runtime does not
    /// send it there).
    OpenWindow(Box<OpenWindow>),
    /// The window's attributes that changed since the last commit (the
    /// fields set; one command per window and commit).
    SetAttributes(Box<WindowAttributes>),
    /// A request to the window.
    Request(WindowRequest),
    /// Quits the app, as its `quit` menu role does: its windows close and
    /// its run ends, also when closing the window would leave it running
    /// (a window kept hidden, a tray icon). A view embedded in another app
    /// leaves the app's lifecycle to that app.
    Quit,
    /// Quits the app as [`DesktopCommand::Quit`] does, then starts it again
    /// with the same arguments once this process has exited
    /// ([`crate::restart`]). A view embedded in another app leaves the
    /// app's lifecycle to that app: nothing happens there.
    Restart,
    /// Whether the user's quit requests quit the app: its Quit item and
    /// the platform's quit key (Command-Q, Ctrl+Q). `false` while the app
    /// listens to them ([`crate::element::desktop::on_quit_request`]): the
    /// platform reports them on the root ([`WindowEvent::QuitRequest`])
    /// instead, and the app sends [`DesktopCommand::Quit`] when it is
    /// ready. The system ending the app quits either way by default;
    /// macOS can include it with [`DesktopCommand::SetQuitRequestOptions`].
    /// Sent when it changes; `true` until the first. On the
    /// web, while it is `false`, the user leaving the page is the request.
    SetQuitOnRequest(bool),
    /// Sets the additional macOS quit request sources. Both default to
    /// false. Other platforms ignore this command.
    SetQuitRequestOptions(QuitRequestOptions),
    /// Cancels a pending macOS quit request, including the system's
    /// logout or shutdown. Nothing happens without a pending request.
    CancelQuitRequest,
    /// The application menu (macOS's menu bar, the window's menu bar on
    /// Windows and Linux; not shown there while the title bar is hidden,
    /// its shortcuts still work); `None` restores the platform's default.
    SetMenu(Option<Arc<[MenuItem]>>),
    /// When the menu bar the window draws for the application menu shows.
    SetMenuBar(MenuBarMode),
    /// The core translated the labels of NSH's menus for the language
    /// the app shows. Native backends update their menus at once.
    SetMenuLabels(Box<MenuLabels>),
    /// Shows a context menu at `at` (root coordinates, points) or at the
    /// pointer.
    PopupMenu {
        /// Its items.
        items: Arc<[MenuItem]>,
        /// Where its top left corner goes.
        at: Option<Point<Points>>,
    },
    /// Shows the app's icon in the system tray (the notification area on
    /// Windows, the menu bar's status items on macOS, a StatusNotifierItem
    /// on Linux), or changes it; `None` removes it. One per app: the last
    /// window's wins.
    SetTray(Option<Tray>),
    /// Registers `shortcut` system-wide, whichever app has the keyboard: the
    /// root's [`crate::EventKind::Menu`] reports `id` with `registered`
    /// (whether the system took it), then `id` alone at each press.
    RegisterGlobalShortcut {
        /// Reported at each press (not 0).
        id: u32,
        /// The keystroke.
        shortcut: Shortcut,
    },
    /// Gives back the global shortcut registered as `id`.
    UnregisterGlobalShortcut(u32),
}

impl DesktopCommand {
    /// A command about a window that the core keeps a record of or adjusts
    /// (opening one, its attributes, a placement to fit).
    /// It is addressed to one window: opening it, its attributes or a
    /// request.
    pub(crate) fn is_window_command(&self) -> bool {
        matches!(
            self,
            DesktopCommand::OpenWindow(_)
                | DesktopCommand::SetAttributes(_)
                | DesktopCommand::Request(_)
        )
    }

    pub(crate) fn is_windows(&self) -> bool {
        matches!(
            self,
            DesktopCommand::OpenWindow(_)
                | DesktopCommand::SetAttributes(_)
                | DesktopCommand::Request(WindowRequest::SetPlacement(_))
        )
    }
}

/// A run of a tray's title ([`Tray::title`]): text in one color, as GPUI's
/// `TextRun`s are.
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct TrayTitleRun {
    /// The text.
    pub text: String,
    /// Its color; `None`: the panel's text color (on macOS the menu bar's,
    /// which follows its appearance).
    pub color: Option<Hsla>,
}

impl TrayTitleRun {
    /// A run of `text` in the panel's text color.
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            color: None,
        }
    }

    /// The run in `color`.
    pub fn color(mut self, color: impl Into<Hsla>) -> Self {
        self.color = Some(color.into());
        self
    }
}

/// Which side of the tray's icon its title shows on ([`Tray::title_placement`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum TrayTitlePlacement {
    /// Right of the icon, as menu bar apps usually show it.
    #[default]
    Right,
    /// Left of the icon. macOS only: Linux's panels draw the title right of
    /// the icon.
    Left,
}

/// The app's icon in the system tray ([`DesktopCommand::SetTray`]).
#[derive(Debug, Clone, Default, PartialEq)]
#[non_exhaustive]
pub struct Tray {
    /// The icon, the app's own image (an SVG is a template, drawn in the
    /// panel's text color where the platform has such icons: macOS);
    /// `None`: the app's icon where the platform has one.
    pub icon: Option<ImageSource>,
    /// Shown when the pointer rests on it; `""` for the app's name.
    pub tooltip: String,
    /// Text beside the icon, in runs each of its own color: what the app
    /// keeps in sight (a price, a count). macOS's menu bar shows it in its
    /// colors; Linux's panels that show AppIndicator labels (GNOME's
    /// AppIndicator extension, Unity, MATE, Budgie) show its text right of
    /// the icon; Windows' notification area shows the icon alone. Empty: the
    /// icon alone.
    pub title: Vec<TrayTitleRun>,
    /// Which side of the icon the title shows on.
    pub title_placement: TrayTitlePlacement,
    /// Its menu: opened by a secondary click (a primary one too when
    /// [`Self::click`] is 0); empty for none.
    pub menu: Arc<[MenuItem]>,
    /// Reported as [`crate::EventKind::Menu`] when the icon is clicked
    /// (primary button), with `bounds`: the icon's frame in screen points
    /// (as [`WindowState::bounds`]), left out where the platform does not
    /// know it; 0: the click opens the menu.
    pub click: u32,
}

pub(crate) fn title_bar_height(height: Option<Points>) -> Option<Points> {
    height
        .filter(|h| h.is_finite() && h.0 > 0.0)
        .map(|h| Points(h.0.min(200.0)))
}

#[cfg(test)]
mod tests {
    #[test]
    fn built_in_menu_labels_follow_locale_fallbacks_and_platform_titles() {
        for (locale, copy, quit) in [
            ("en", "Copy", "Quit"),
            ("ja-JP", "コピー", "終了"),
            ("zh-CN", "复制", "退出"),
            ("zh-Hant-TW", "複製", "結束"),
            ("zh-TW", "複製", "結束"),
            ("zh-MO", "複製", "結束"),
            ("fr-FR", "Copy", "Quit"),
        ] {
            let locale = crate::platform::Locale::parse(locale).unwrap();
            let labels = MenuLabels::for_locale(locale, false);
            assert_eq!(labels.label(MenuRole::Copy), copy);
            assert_eq!(labels.label(MenuRole::Quit), quit);
            for role in MenuRole::ALL {
                assert!(!labels.label(*role).contains("%{app}"));
            }
        }
        let japanese = crate::platform::Locale::parse("ja").unwrap();
        let labels = MenuLabels::for_locale(japanese, true);
        assert_eq!(labels.label(MenuRole::Quit), "%{app}を終了");
        assert_eq!(labels.delete.as_deref(), Some("削除"));
        assert_eq!(
            MenuLabels::for_locale(japanese, false).label(MenuRole::Paste),
            "貼り付け"
        );
    }

    use super::*;
    use crate::geometry::px;

    #[test]
    fn window_menu_is_the_submenu_with_a_window_role() {
        let action = |role: Option<MenuRole>| {
            MenuItem::Action(MenuAction {
                id: 0,
                label: String::new(),
                shortcut: None,
                enabled: true,
                checked: None,
                role,
                when: When::default(),
                icon: None,
                symbol: None,
                destructive: false,
            })
        };
        let sub = |items: Vec<MenuItem>| MenuItem::Submenu {
            label: String::new(),
            enabled: true,
            items,
            icon: None,
            symbol: None,
            inline: false,
        };
        let bar = vec![
            sub(vec![action(Some(MenuRole::Quit))]),
            sub(vec![action(Some(MenuRole::Copy))]),
            sub(vec![action(None), sub(vec![action(Some(MenuRole::Zoom))])]),
            sub(vec![action(Some(MenuRole::Minimize))]),
        ];
        assert_eq!(MenuItem::window_menu(&bar), Some(2));
        assert_eq!(MenuItem::window_menu(&bar[..2]), None);
        // A top-level role item is not a submenu of the bar.
        assert_eq!(
            MenuItem::window_menu(&[action(Some(MenuRole::Close))]),
            None
        );
    }

    #[test]
    fn custom_title_bar_height_is_finite_positive_and_bounded() {
        for height in [
            None,
            Some(0.0),
            Some(-1.0),
            Some(f32::NAN),
            Some(f32::INFINITY),
        ] {
            assert_eq!(title_bar_height(height.map(Points)), None);
        }
        assert_eq!(title_bar_height(Some(px(42.0))), Some(px(42.0)));
        assert_eq!(title_bar_height(Some(px(300.0))), Some(px(200.0)));
    }

    #[test]
    fn mac_labels_use_symbols() {
        let copy = MenuRole::Copy.shortcut(true).unwrap();
        assert_eq!(copy.label_for(Os::MacOs), "⌘C");
        assert_eq!(
            MenuRole::Redo.shortcut(true).unwrap().label_for(Os::MacOs),
            "⇧⌘Z"
        );
        assert_eq!(
            MenuRole::ToggleFullScreen
                .shortcut(true)
                .unwrap()
                .label_for(Os::MacOs),
            "⌃⌘F"
        );
        assert_eq!(
            MenuRole::Copy
                .shortcut(false)
                .unwrap()
                .label_for(Os::Windows),
            "Ctrl+C"
        );
        // Off macOS it is `label()` as it was, `Win+` and all.
        let win = Shortcut {
            meta: true,
            ..Shortcut::key(Key::Char('e'))
        };
        assert_eq!(win.label_for(Os::Linux), win.label());
        assert_eq!(win.label_for(Os::Windows), win.label());
        assert_eq!(win.label_for(Os::Linux), "Win+E");
        let copy = MenuRole::Copy.shortcut(false).unwrap();
        assert_eq!(copy.label_for(Os::Linux), copy.label());
    }

    #[test]
    fn shortcuts_parse() {
        let s = Shortcut::parse("mod+shift+n", false).unwrap();
        assert_eq!(
            s,
            Shortcut {
                ctrl: true,
                shift: true,
                ..Shortcut::key(Key::Char('n'))
            }
        );
        // Labels stay the platform's style.
        assert_eq!(s.label(), "Ctrl+Shift+N");
        let mac = Shortcut::parse("cmdorctrl+,", true).unwrap();
        assert!(mac.meta && !mac.ctrl);
        assert_eq!(mac.key, Key::Char(','));
        assert_eq!(
            Shortcut::parse("meta+k", false),
            Shortcut::parse("cmd+k", false)
        );
        // Case does not matter, and a capital letter is not Shift.
        assert_eq!(Shortcut::parse("Mod+Shift+N", false), Ok(s));
        assert_eq!(
            Shortcut::parse("CMD+K", false),
            Shortcut::parse("cmd+k", false)
        );
        assert_eq!(
            Shortcut::parse("mod+N", false),
            Shortcut::parse("mod+n", false)
        );
        assert_eq!(
            Shortcut::parse("Escape", false),
            Shortcut::parse("escape", false)
        );
        assert_eq!(Shortcut::parse("F5", false), Shortcut::parse("f5", false));
        assert_eq!(
            Shortcut::parse("Ctrl+Plus", false),
            Shortcut::parse("ctrl+=", false)
        );
        assert_eq!(Key::parse("PageUp"), Some(Key::PageUp));
        // The plus key is the `=` key.
        assert_eq!(
            Shortcut::parse("ctrl+plus", false),
            Shortcut::parse("ctrl+=", false)
        );
        assert_eq!(
            Shortcut::parse("ctrl+minus", false),
            Shortcut::parse("ctrl+-", false)
        );
        assert_eq!(
            Shortcut::parse("arrowup", false),
            Shortcut::parse("up", false)
        );
        assert_eq!(Shortcut::parse("alt+f4", false).unwrap().key, Key::F(4));
        assert_eq!(
            Shortcut::parse("f11", false).unwrap(),
            Shortcut::key(Key::F(11))
        );
        let win = Shortcut::parse("win+option+pagedown", true).unwrap();
        assert!(win.meta && win.alt && win.key == Key::PageDown);
    }

    #[test]
    fn shortcuts_explain_errors() {
        // The same messages as `nsh/keymap`'s.
        let err = |t| Shortcut::parse(t, false).unwrap_err().0;
        assert_eq!(err(""), "invalid keystroke \"\": empty");
        assert!(err("mod+k mod+s").contains("one keystroke per binding"));
        assert!(err("mod+").contains("no key after the modifiers"));
        assert!(err("hyper+k").contains("unknown modifier \"hyper\""));
        assert!(err("ctrl+ctrl+k").contains("\"ctrl\" twice"));
        assert!(err("mod-k").contains("join modifiers and the key with \"+\": \"mod+k\""));
        // Hints suggest lowercase, whatever case the text was written in.
        assert!(err("Mod-N").contains("join modifiers and the key with \"+\": \"mod+n\""));
        assert!(err("CTRL++").contains("\"ctrl+plus\""));
        assert!(err("mod+?").contains("write \"shift+/\""));
        assert!(err("ctrl++").contains("write the plus key as \"plus\": \"ctrl+plus\""));
        assert!(err("ctrl+f25").contains("unknown key"));
    }

    #[test]
    fn shortcuts_find_items() {
        let copy = Shortcut::parse("ctrl+c", false).unwrap();
        let new = Shortcut::parse("ctrl+n", false).unwrap();
        let action = |id, shortcut, role| {
            MenuItem::Action(MenuAction {
                id,
                label: String::new(),
                shortcut: Some(shortcut),
                enabled: true,
                checked: None,
                role,
                when: When::Always,
                icon: None,
                symbol: None,
                destructive: false,
            })
        };
        let menu = vec![MenuItem::Submenu {
            label: "File".into(),
            enabled: true,
            items: vec![
                action(1, new, None),
                MenuItem::Separator,
                action(0, copy, Some(MenuRole::Copy)),
            ],
            icon: None,
            symbol: None,
            inline: false,
        }];
        assert_eq!(MenuItem::find_shortcut(&menu, &new).map(|a| a.id), Some(1));
        // Text fields keep their own shortcuts.
        assert!(MenuItem::find_shortcut(&menu, &copy).is_none());
    }

    #[test]
    fn items_leave_a_focused_field_the_keys_it_uses_when_asked() {
        let item = |shortcut: &str, when| MenuAction {
            id: 1,
            label: String::new(),
            shortcut: Some(Shortcut::parse(shortcut, false).unwrap()),
            enabled: true,
            checked: None,
            role: None,
            when,
            icon: None,
            symbol: None,
            destructive: false,
        };
        let fires = |shortcut, when| item(shortcut, when).fires_while_editing();
        assert!(fires("ctrl+z", When::Always));
        assert!(!fires("ctrl+z", When::Auto));
        assert!(!fires("ctrl+y", When::Auto));
        assert!(fires("ctrl+y", When::Always));
        assert!(!fires("delete", When::Auto));
        assert!(!fires("ctrl+enter", When::Auto));
        assert!(!fires("space", When::Auto));
        assert!(fires("ctrl+shift+n", When::Auto));
        assert!(fires("f5", When::Auto));
        assert!(!fires("ctrl+shift+n", When::NotEditing));
    }

    #[test]
    fn inline_submenus_expand_between_separators() {
        let action = |label: &str| {
            MenuItem::Action(MenuAction {
                id: 0,
                label: label.into(),
                shortcut: None,
                enabled: true,
                checked: None,
                role: None,
                when: When::Always,
                icon: None,
                symbol: None,
                destructive: false,
            })
        };
        let items = [
            action("New"),
            MenuItem::Submenu {
                label: "Danger".into(),
                enabled: true,
                items: vec![action("Delete"), action("Wipe")],
                icon: None,
                symbol: None,
                inline: true,
            },
            action("Quit"),
            MenuItem::Submenu {
                label: "More".into(),
                enabled: true,
                items: vec![
                    action("Share"),
                    MenuItem::Submenu {
                        label: "Nested".into(),
                        enabled: true,
                        items: vec![action("Deep")],
                        icon: None,
                        symbol: None,
                        inline: true,
                    },
                ],
                icon: None,
                symbol: None,
                inline: false,
            },
        ];
        let expanded = MenuItem::with_inline_expanded(&items);
        assert_eq!(
            expanded
                .iter()
                .map(|i| match i {
                    MenuItem::Separator => "—".into(),
                    MenuItem::Action(a) => a.label.clone(),
                    MenuItem::Submenu {
                        label,
                        items,
                        inline,
                        ..
                    } => {
                        assert!(!inline, "nested non-inline kept");
                        format!(
                            "{label}[{}]",
                            items
                                .iter()
                                .map(|c| match c {
                                    MenuItem::Separator => "—",
                                    MenuItem::Action(a) => a.label.as_str(),
                                    MenuItem::Submenu { .. } => "sub",
                                })
                                .collect::<Vec<_>>()
                                .join(",")
                        )
                    }
                })
                .collect::<Vec<String>>(),
            [
                "New",
                "—",
                "Delete",
                "Wipe",
                "—",
                "Quit",
                "More[Share,—,Deep]",
            ]
            .map(str::to_owned)
        );
        // Separators only between groups: none leading or trailing.
        assert!(!matches!(expanded.first(), Some(MenuItem::Separator)));
        assert!(!matches!(expanded.last(), Some(MenuItem::Separator)));
        // A lone inline group: no separators around it.
        let alone = MenuItem::with_inline_expanded(&[MenuItem::Submenu {
            label: "Only".into(),
            enabled: true,
            items: vec![action("A"), action("B")],
            icon: None,
            symbol: None,
            inline: true,
        }]);
        assert_eq!(
            alone
                .iter()
                .map(|i| match i {
                    MenuItem::Action(a) => a.label.as_str(),
                    _ => "?",
                })
                .collect::<Vec<_>>(),
            ["A", "B"]
        );
        // An explicit separator after an inline section must not double.
        let after_inline = MenuItem::with_inline_expanded(&[
            action("A"),
            MenuItem::Submenu {
                label: "Group".into(),
                enabled: true,
                items: vec![action("B")],
                icon: None,
                symbol: None,
                inline: true,
            },
            MenuItem::Separator,
            action("C"),
        ]);
        assert_eq!(
            after_inline
                .iter()
                .map(|i| match i {
                    MenuItem::Separator => "—",
                    MenuItem::Action(a) => a.label.as_str(),
                    _ => "?",
                })
                .collect::<Vec<_>>(),
            ["A", "—", "B", "—", "C"]
        );
    }

    #[test]
    fn a_disabled_inline_section_disables_its_items() {
        let action = |label: &str| {
            MenuItem::Action(MenuAction {
                id: 1,
                label: label.into(),
                shortcut: None,
                enabled: true,
                checked: None,
                role: None,
                when: Default::default(),
                icon: None,
                symbol: None,
                destructive: false,
            })
        };
        let section = |enabled: bool| MenuItem::Submenu {
            label: "Group".into(),
            enabled,
            items: vec![
                action("B"),
                MenuItem::Submenu {
                    label: "More".into(),
                    enabled: true,
                    items: vec![action("C")],
                    icon: None,
                    symbol: None,
                    inline: false,
                },
            ],
            icon: None,
            symbol: None,
            inline: true,
        };
        let enabled = |items: &[MenuItem]| {
            items
                .iter()
                .map(|i| match i {
                    MenuItem::Action(a) => (a.label.clone(), a.enabled),
                    MenuItem::Submenu { label, enabled, .. } => (label.clone(), *enabled),
                    MenuItem::Separator => ("—".into(), true),
                })
                .collect::<Vec<_>>()
        };
        let off = MenuItem::with_inline_expanded(&[action("A"), section(false)]);
        assert_eq!(
            enabled(&off),
            [
                ("A".into(), true),
                ("—".into(), true),
                ("B".into(), false),
                ("More".into(), false)
            ]
        );
        let on = MenuItem::with_inline_expanded(&[action("A"), section(true)]);
        assert_eq!(
            enabled(&on),
            [
                ("A".into(), true),
                ("—".into(), true),
                ("B".into(), true),
                ("More".into(), true)
            ]
        );
    }
}

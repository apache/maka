//! What only desktops have: the window's title and title bar, the
//! application menu, context menus and keyboard shortcuts (TS
//! `nsh/desktop`). The platforms get them as [`DesktopCommand`]s on the
//! root and report a chosen menu item as [`crate::EventKind::Menu`];
//! mobile platforms ignore them.

use std::sync::Arc;

use crate::{
    element::{JsHost, JsIn, JsKind, JsOwned, JsValue, PropEnum, PropError, TsTypes},
    geometry::{Point, Points},
    keymap::{self, Keystroke, Modifiers, When},
};

/// How the window's title bar looks (`Window.setTitleBar`).
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

/// When the window's menu bar shows (`Window.setMenuBar`), where the app's
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

/// A window's frame (`Window.setFrame`): the part of it to move, in
/// points, in screen coordinates; a field left out keeps its value. TS
/// gives `origin` (`x`, `y`) and `size` (`width`, `height`) as
/// `Partial<Point>` and `Partial<Size>`.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct WindowFrame {
    /// Its left edge (macOS's screen coordinates go up: `x` and `y` are the
    /// window's bottom left corner there).
    pub x: Option<Points>,
    /// Its bottom edge on macOS, its top edge elsewhere.
    pub y: Option<Points>,
    /// Its outer width on macOS / Windows, GTK default width on Linux.
    pub width: Option<Points>,
    /// Its outer height on macOS / Windows, GTK default height on Linux.
    pub height: Option<Points>,
    /// Animates the change on macOS (false by default).
    pub animated: Option<bool>,
    /// The top edge keeps its place when `height` changes without a `y`:
    /// the window grows and shrinks at its bottom edge (a content-sized
    /// window's title area stays put). Elsewhere, where `y` already is the
    /// top edge, this is the default.
    pub anchor_top: Option<bool>,
}

/// TS: `{ origin?: Partial<Point>; size?: Partial<Size>; animated?; anchorTop? }`.
impl JsValue for WindowFrame {
    fn ts_type(types: &mut TsTypes) -> String {
        types.declare("WindowFrame", |_| {
            "/** A window's frame (`Window.setFrame`): the part of it to move, in points, in screen coordinates; a field left out keeps its value. */\n\
             export interface WindowFrame {\n  \
             /** Its left edge and its bottom edge on macOS (whose screen coordinates go up: the window's bottom left corner), its top edge elsewhere. */\n  \
             origin?: Partial<Point>;\n  \
             /** Its outer size on macOS / Windows, GTK's default size on Linux. */\n  \
             size?: Partial<Size>;\n  \
             /** Animates the change on macOS (false by default). */\n  \
             animated?: boolean;\n  \
             /** The top edge keeps its place when the height changes without a `y`: the window grows and shrinks at its bottom edge (a content-sized window's title area stays put). Elsewhere, where `y` already is the top edge, this is the default. */\n  \
             anchorTop?: boolean;\n}"
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
            anchor_top: get(value, "anchorTop")?,
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
        if let Some(v) = self.anchor_top {
            host.set_field(object, "anchorTop", v.to_js(host)?.into_raw())?;
        }
        Ok(owned)
    }
}

/// How high a window floats (`Window.setLevel`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub enum WindowLevel {
    /// The normal level.
    #[default]
    Normal,
    /// Above normal windows: a floating palette or a widget.
    Floating,
    /// macOS's desktop icon level; on Windows, moves to the bottom of
    /// the current z-order (later activation can raise the window).
    #[prop(rename = "desktopIcon")]
    DesktopIcon,
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

    /// Whether a focused text field uses this shortcut itself, as it uses
    /// the same keystroke of `nsh/keymap` ([`Keystroke::edits_text`]).
    pub fn edits_text(&self) -> bool {
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
        Keystroke { modifiers, key }.edits_text()
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
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
    /// bar).
    Submenu {
        /// What it shows.
        label: String,
        /// It can be opened.
        enabled: bool,
        /// Its items.
        items: Vec<MenuItem>,
    },
}

impl MenuItem {
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

/// A desktop command (on the root).
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopCommand {
    /// The window's title.
    SetTitle(String),
    /// The title bar's style.
    SetTitleBar {
        /// Shown or hidden.
        style: TitleBarStyle,
        /// The height of the app's own title bar, in points: the window
        /// controls are centered in it (Windows' caption buttons fill it);
        /// `None` for the platform's height. On macOS this selects a native
        /// toolbar style; the environment reports its actual height.
        height: Option<Points>,
    },
    /// Minimizes the window.
    Minimize,
    /// Maximizes the window, or restores it when it is maximized.
    ToggleMaximize,
    /// Enters or leaves full screen.
    ToggleFullScreen,
    /// Moves and sizes the window (screen coordinates, points; a field
    /// left out keeps its value).
    SetFrame(WindowFrame),
    /// The window's level (a floating window stays above normal ones).
    SetLevel(WindowLevel),
    /// Brings the window to the front of its level and focuses it (the app
    /// activates).
    OrderFront,
    /// Closes the window (the app ends with its last window).
    Close,
    /// The application menu (macOS's menu bar, the window's menu bar on
    /// Windows and Linux; not shown there while the title bar is hidden,
    /// its shortcuts still work); `None` restores the platform's default.
    SetMenu(Option<Arc<[MenuItem]>>),
    /// When the menu bar the window draws for the application menu shows.
    SetMenuBar(MenuBarMode),
    /// Shows a context menu at `at` (root coordinates, points) or at the
    /// pointer.
    PopupMenu {
        /// Its items.
        items: Arc<[MenuItem]>,
        /// Where its top left corner goes.
        at: Option<Point<Points>>,
    },
}

pub(crate) fn title_bar_height(height: Option<Points>) -> Option<Points> {
    height
        .filter(|h| h.is_finite() && h.0 > 0.0)
        .map(|h| Points(h.0.min(200.0)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::px;

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
}

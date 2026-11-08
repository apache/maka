//! What the platform reports about a surface (its size, safe area,
//! keyboard, appearance, device) and the HTTP requests it carries out: the
//! data both Rust components and JS read, with or without a JS runtime.

pub mod clipboard;

use crate::geometry::{Edges, Points, Size};

/// The native component of `nsh/mobile`'s `TabBar`, which the iOS and
/// Android backends register themselves (`TabBarComponent.java`'s `NAME` keeps
/// the same name).
pub const TAB_BAR_COMPONENT: &str = "nsh/tab-bar";

/// Whether native component `name` is NSH's own: names under `nsh/` are, and
/// an embedding app's registration of one is refused, so it can never
/// replace what NSH's exports render.
pub fn is_reserved_component(name: &str) -> bool {
    name.starts_with("nsh/")
}

/// The system appearance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColorScheme {
    /// Light mode.
    #[default]
    Light,
    /// Dark mode.
    Dark,
}

/// The appearance an app asks for (`nsh.json` `"appearance"`, TS
/// `setColorScheme`): one of its own, or the system's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, crate::element::PropEnum)]
pub enum Appearance {
    /// The system appearance (default).
    #[default]
    System,
    /// Always light.
    Light,
    /// Always dark.
    Dark,
}

impl Appearance {
    /// The color scheme shown when the system's is `system`.
    pub fn resolve(self, system: ColorScheme) -> ColorScheme {
        match self {
            Appearance::System => system,
            Appearance::Light => ColorScheme::Light,
            Appearance::Dark => ColorScheme::Dark,
        }
    }
}

/// The operating system (`platform.os`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    /// iOS, iPadOS, Mac Catalyst.
    Ios,
    /// Android.
    Android,
    /// macOS (a desktop backend).
    MacOs,
    /// Windows.
    Windows,
    /// Linux.
    Linux,
    /// A web browser (the WebAssembly runtime): phone, tablet or desktop
    /// by [`Idiom`].
    Web,
}

impl Os {
    /// Its `platform.os` name.
    pub fn name(self) -> &'static str {
        match self {
            Os::Ios => "ios",
            Os::Android => "android",
            Os::MacOs => "macos",
            Os::Windows => "windows",
            Os::Linux => "linux",
            Os::Web => "web",
        }
    }

    /// The OS of a desktop backend (macOS, Windows, Linux): it has windows
    /// and menus (`nsh/desktop`'s `isAvailable`). Desktop behavior
    /// (`desktop={{…}}` props, `platform.select({ desktop })`,
    /// `platform.desktop`) also covers browsers in the desktop idiom:
    /// [`Environment::desktop`].
    pub fn is_desktop(self) -> bool {
        matches!(self, Os::MacOs | Os::Windows | Os::Linux)
    }

    /// iOS running under Mac Catalyst, in every idiom (`platform.catalyst`):
    /// this build is Catalyst's (`target_abi = "macabi"`). Catalyst runs the
    /// iOS backend, so it is mobile, not desktop: `ios={{…}}` props apply and
    /// `nsh/desktop`'s window and menu APIs are not there.
    pub fn is_catalyst(self) -> bool {
        self == Os::Ios && cfg!(target_abi = "macabi")
    }
}

impl Default for Os {
    /// The mobile OS of this build (headless runs, `nsh test`, behave as iOS); desktop
    /// backends set theirs.
    fn default() -> Self {
        if cfg!(target_os = "android") {
            Os::Android
        } else {
            Os::Ios
        }
    }
}

/// The kind of device (`platform.idiom`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Idiom {
    /// A phone.
    #[default]
    Phone,
    /// A tablet.
    Pad,
    /// UIKit's Mac idiom (Mac Catalyst optimized for Mac). Catalyst runs
    /// the iOS backend, so this idiom is mobile, not [`Idiom::Desktop`].
    Mac,
    /// A TV.
    Tv,
    /// Desktop: a desktop backend (macOS, Windows, Linux), or a browser with
    /// a mouse and a wide viewport ([`Idiom::desktop_on`]). Mac Catalyst is
    /// [`Idiom::Pad`] or [`Idiom::Mac`], as UIKit reports.
    Desktop,
    /// A terminal: drawn on a grid of Cells, keyboard first (the terminal
    /// backend). The OS stays the machine's; desktop behavior applies.
    Terminal,
}

impl Idiom {
    /// Whether desktop behavior applies on `os` in this idiom, NSH's one
    /// definition of desktop: a desktop OS (macOS, Windows, Linux), a
    /// browser in the desktop idiom, or a terminal. `desktop={{…}}` props,
    /// `platform.select({ desktop })` and `platform.desktop` all follow it,
    /// and so does `platform.idiom === "desktop"` outside a terminal
    /// ([`Idiom::reported_on`]).
    pub fn desktop_on(self, os: Os) -> bool {
        os.is_desktop() || (os == Os::Web && self == Idiom::Desktop) || self == Idiom::Terminal
    }

    /// The idiom apps see on `os` (TS: `platform.idiom`): [`Idiom::Terminal`]
    /// in a terminal, else [`Idiom::Desktop`] exactly where
    /// [`Idiom::desktop_on`] holds, so that `"desktop"` agrees with desktop
    /// behavior whatever a platform (or a test) set. Elsewhere this idiom,
    /// and [`Idiom::Phone`] for [`Idiom::Desktop`] on a mobile OS.
    pub fn reported_on(self, os: Os) -> Idiom {
        if self == Idiom::Terminal {
            Idiom::Terminal
        } else if self.desktop_on(os) {
            Idiom::Desktop
        } else if self == Idiom::Desktop {
            Idiom::Phone
        } else {
            self
        }
    }
}

/// Whether the app is in use (`lifecycle()`), in React Native's `AppState`
/// terms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lifecycle {
    /// In the foreground and taking input.
    #[default]
    Active,
    /// Still visible, but not taking input: another app or window has the
    /// focus, or the system shows something over it (the app switcher, an
    /// incoming call, Control Center).
    Inactive,
    /// Not visible: in the background, minimized or hidden. The system may
    /// suspend it there.
    Background,
}

impl Lifecycle {
    /// Its `lifecycle()` name: `"active"`, `"inactive"` or `"background"`.
    pub fn name(self) -> &'static str {
        match self {
            Lifecycle::Active => "active",
            Lifecycle::Inactive => "inactive",
            Lifecycle::Background => "background",
        }
    }
}

/// What the platform knows about the surface.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Environment {
    /// Size of the surface in points.
    pub window: Size<Points>,
    /// Insets not covered by system UI (notch, home indicator, title bar).
    pub safe_area: Edges<Points>,
    /// The title bar's area while the app hides it (desktops,
    /// [`crate::desktop::TitleBarStyle::Hidden`]): `top` is its height,
    /// `left` and `right` the widths the system's window controls take at
    /// its ends (`bottom` is 0); all 0 while the system shows its title
    /// bar.
    pub title_bar: Edges<Points>,
    /// The app's window: its bounds on the screen, its mode and display
    /// (desktops; `None` elsewhere and where the surface has no window).
    /// The engine holds back a move or resize until the window stops for
    /// a moment, so platforms report every change.
    pub window_state: Option<crate::desktop::WindowState>,
    /// Height of the software keyboard over the surface; 0 when hidden.
    pub keyboard_height: Points,
    /// Duration of the keyboard's show / hide animation in milliseconds.
    pub keyboard_duration: f32,
    /// Light or dark appearance.
    pub color_scheme: ColorScheme,
    /// Preferred text size relative to the default (1.0).
    pub font_scale: f32,
    /// The user's language is written right to left.
    pub rtl: bool,
    /// The user asked for less motion (iOS Reduce Motion, Android's
    /// animator duration scale at 0).
    pub reduce_motion: bool,
    /// Device pixels per point.
    pub pixel_ratio: f32,
    /// A screen reader runs (VoiceOver, TalkBack).
    pub screen_reader: bool,
    /// The operating system.
    pub os: Os,
    /// The backend supplies native keyboard-focus paths and matches scoped
    /// key bindings against them. This is a host capability, not a JS signal.
    pub native_focus_scopes: bool,
    /// The backend matches fallback key bindings after native input handling.
    /// This is a host capability, not a JS signal.
    pub fallback_key_bindings: bool,
    /// The OS version: major and minor (iOS, desktops), Android's API level
    /// and 0.
    pub os_version: (u16, u16),
    /// The kind of device.
    pub idiom: Idiom,
    /// A browser on an Apple platform (macOS, iOS): its keyboard shortcuts
    /// follow Apple's conventions ([`crate::keymap::apple_keys`]: `mod` is
    /// Command, labels use ⌘). Only read for [`Os::Web`]; the other OSes
    /// imply theirs.
    pub apple_keyboard: bool,
    /// Ctrl stands in for Command: the keyboard cannot report Command (a
    /// terminal on macOS without the kitty keyboard protocol), so a
    /// `mod+` / `cmd+` shortcut takes Ctrl and labels show it as Ctrl
    /// ([`crate::keymap::Keystroke::pressed`]).
    pub ctrl_for_command: bool,
    /// The user's locale (number and date formats: `Intl`'s default).
    pub locale: Locale,
    /// The user's locale settings: the preferred languages, the time zone
    /// and the regional preferences.
    pub locale_settings: LocaleSettings,
    /// The app embedding NSH answers `nsh/host`'s calls
    /// ([`crate::Command::HostCall`]); without it, they reject at once.
    pub host: bool,
    /// Whether the app is in use: in the foreground, visible without the
    /// focus, or in the background. For an embedded surface, the embedding
    /// app's.
    pub lifecycle: Lifecycle,
    /// The platform picks a color from the screen
    /// ([`crate::Command::PickScreenColor`]); without it, a pick answers
    /// no color at once.
    pub screen_color: bool,
    /// The platform shows the system's open and save dialogs and opens,
    /// reveals and trashes local paths ([`crate::Command::FileRequest`],
    /// the desktops); without it, those requests answer at once with an
    /// error.
    pub file_requests: bool,
    /// The platform recognizes speech ([`crate::Command::Speech`],
    /// [`crate::speech`]); without it, a session ends at once
    /// (`unavailable`) unless the core has a [`crate::speech::SpeechBackend`].
    pub speech: bool,
    /// The platform shows notifications ([`crate::Command::Notification`],
    /// [`crate::notifications`]); without it, the permission is
    /// `unavailable` and nothing shows.
    pub notifications: bool,
    /// The platform plays sound ([`crate::Command::Audio`],
    /// [`crate::audio`]); without it, sounds and players fail at once
    /// (`unavailable`) unless the core has a [`crate::audio::AudioBackend`].
    pub audio: bool,
    /// The size of one Cell of a grid surface (a terminal, whose content is
    /// whole character Cells), in points; `None` on every other surface.
    /// With it the core lays out with its terminal algorithm, ratatui's
    /// splits in whole Cells (x the Cell's width, y its height): a border
    /// is one Cell and every frame is whole Cells (`docs/dev/styles.md`
    /// "Layout in a terminal").
    pub cell: Option<Size<Points>>,
    /// The platform gives web views trusted input
    /// ([`crate::Command::SendInput`], macOS); without it, the command
    /// does nothing.
    pub web_input: bool,
}

impl Environment {
    /// Desktop behavior applies: a desktop OS, a browser in the desktop
    /// idiom or a terminal ([`Idiom::desktop_on`]: `desktop={{…}}` props,
    /// `platform.select({ desktop })`, `platform.desktop`, `platform.idiom`
    /// `"desktop"` outside a terminal).
    pub fn desktop(&self) -> bool {
        self.idiom.desktop_on(self.os)
    }

    /// The idiom apps see (TS: `platform.idiom`, [`Idiom::reported_on`]).
    pub fn reported_idiom(&self) -> Idiom {
        self.idiom.reported_on(self.os)
    }
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            window: Size::default(),
            safe_area: Edges::default(),
            title_bar: Edges::default(),
            window_state: None,
            keyboard_height: Points(0.0),
            keyboard_duration: 250.0,
            color_scheme: ColorScheme::Light,
            font_scale: 1.0,
            rtl: false,
            reduce_motion: false,
            pixel_ratio: 1.0,
            screen_reader: false,
            os: Os::default(),
            native_focus_scopes: false,
            fallback_key_bindings: false,
            os_version: (0, 0),
            idiom: Idiom::Phone,
            apple_keyboard: false,
            ctrl_for_command: false,
            locale: Locale::EN_US,
            locale_settings: LocaleSettings::EN_US,
            host: false,
            lifecycle: Lifecycle::Active,
            screen_color: false,
            file_requests: false,
            speech: false,
            notifications: false,
            audio: false,
            cell: None,
            web_input: false,
        }
    }
}

/// The settings an embedding app gives its surfaces in place of the
/// system's (`None`: the system's): its own language and text size, for an
/// app inside a native app that lets its users switch them. The platforms
/// write them over what they read from the system ([`Self::apply`]), so the
/// app's `Intl`, `locale()`, `localeSettings()`'s languages (its language first),
/// `fontScale()` and text follow them like a system change.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct HostEnvironment {
    /// The locale in place of the user's ([`Environment::locale`]).
    pub locale: Option<Locale>,
    /// The text size in place of the user's ([`Environment::font_scale`]);
    /// values that are not finite and positive count as `None`.
    pub font_scale: Option<f32>,
}

impl HostEnvironment {
    /// Writes the settings `self` has over `env`'s.
    pub fn apply(&self, env: &mut Environment) {
        if let Some(locale) = self.locale {
            env.locale = locale;
            env.locale_settings.languages = env.locale_settings.languages.preferring(locale);
        }
        if let Some(scale) = self.font_scale.filter(|s| s.is_finite() && *s > 0.0) {
            env.font_scale = scale;
        }
    }
}

/// A BCP 47 language tag (`en-US`, `zh-Hans-CN`), held inline so that the
/// environment stays `Copy`: the language, script and region subtags fit;
/// variants and extensions are dropped.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Locale {
    bytes: [u8; Locale::CAPACITY],
    len: u8,
}

impl Locale {
    const CAPACITY: usize = 15;

    /// `en-US`, the default when a platform reports none.
    pub const EN_US: Locale = Locale {
        bytes: *b"en-US\0\0\0\0\0\0\0\0\0\0",
        len: 5,
    };

    /// The tag of a platform locale identifier: `en_US`, `en-US`,
    /// `de_DE@calendar=gregorian`, `pt_BR.UTF-8` (POSIX) and `zh-Hans_CN`
    /// all work. Subtags are cased as BCP 47 writes them (`zh-Hans-CN`);
    /// `None` without a language.
    pub fn parse(identifier: &str) -> Option<Locale> {
        let identifier = identifier.split(['@', '.']).next().unwrap_or_default();
        let mut bytes = [0u8; Self::CAPACITY];
        let mut len = 0;
        for (i, part) in identifier.split(['-', '_']).enumerate() {
            let keep = if i == 0 {
                (2..=3).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphabetic())
            } else {
                // A script (4 letters) or a region (2 letters, 3 digits).
                (part.len() == 4 && part.bytes().all(|b| b.is_ascii_alphabetic()))
                    || (part.len() == 2 && part.bytes().all(|b| b.is_ascii_alphabetic()))
                    || (part.len() == 3 && part.bytes().all(|b| b.is_ascii_digit()))
            };
            if !keep {
                if i == 0 {
                    return None;
                }
                // A variant or an extension: dropped with what follows.
                break;
            }
            if len + part.len() + usize::from(i > 0) > Self::CAPACITY {
                break;
            }
            if i > 0 {
                bytes[len] = b'-';
                len += 1;
            }
            for (j, b) in part.bytes().enumerate() {
                bytes[len] = match (i, part.len()) {
                    (0, _) => b.to_ascii_lowercase(),
                    (_, 4) if j == 0 => b.to_ascii_uppercase(),
                    (_, 4) => b.to_ascii_lowercase(),
                    _ => b.to_ascii_uppercase(),
                };
                len += 1;
            }
        }
        Some(Locale {
            bytes,
            len: len as u8,
        })
    }

    /// The tag (`en-US`).
    pub fn as_str(&self) -> &str {
        // ASCII, as parsed.
        std::str::from_utf8(&self.bytes[..usize::from(self.len)]).unwrap_or("en-US")
    }

    /// The language subtag (`en`).
    pub fn language(&self) -> &str {
        self.as_str().split('-').next().unwrap_or_default()
    }

    /// The region subtag (`US`, `419`), if the tag has one.
    pub fn region(&self) -> Option<&str> {
        // What follows the language is a script (4 letters) or a region.
        self.as_str().split('-').skip(1).find(|s| s.len() != 4)
    }
}

impl Default for Locale {
    fn default() -> Self {
        Self::EN_US
    }
}

impl std::fmt::Debug for Locale {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Locale({})", self.as_str())
    }
}

impl std::fmt::Display for Locale {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The user's preferred languages, most preferred first, as BCP 47 tags
/// (`localeSettings()`'s `languages`): never empty, at most eight, each once. Held inline so
/// that the environment stays `Copy`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Languages {
    tags: [Locale; Languages::CAPACITY],
    len: u8,
}

impl Languages {
    /// How many it keeps: systems list a few (iOS and Android up to the
    /// ones the user added, desktops their UI languages).
    const CAPACITY: usize = 8;

    /// `en-US` alone, the default when a platform reports none.
    pub(crate) const EN_US: Languages = Languages {
        tags: [Locale::EN_US; Languages::CAPACITY],
        len: 1,
    };

    /// `locale` alone.
    #[doc(hidden)]
    pub const fn one(locale: Locale) -> Languages {
        Languages {
            tags: [locale; Languages::CAPACITY],
            len: 1,
        }
    }

    /// The languages of platform identifiers, most preferred first
    /// ([`Locale::parse`]'s forms: `en_US`, `zh-Hans-CN`): ones that name
    /// no language and repeats are left out, the first eight kept. `None`
    /// when none is a language.
    #[doc(hidden)]
    pub fn parse<'a>(identifiers: impl IntoIterator<Item = &'a str>) -> Option<Languages> {
        let mut languages = Languages::EN_US;
        languages.len = 0;
        for locale in identifiers.into_iter().filter_map(Locale::parse) {
            if usize::from(languages.len) == Self::CAPACITY {
                break;
            }
            if !languages.as_slice().contains(&locale) {
                languages.tags[usize::from(languages.len)] = locale;
                languages.len += 1;
            }
        }
        (languages.len > 0).then_some(languages)
    }

    /// These with `locale` first (an embedding app's own language, the
    /// app's `set_locale`): it moves there if it is listed, else comes
    /// before them (the last one then left out when they are eight).
    pub fn preferring(&self, locale: Locale) -> Languages {
        let mut languages = Languages::one(locale);
        for &other in self.as_slice() {
            if usize::from(languages.len) == Self::CAPACITY {
                break;
            }
            if other != locale {
                languages.tags[usize::from(languages.len)] = other;
                languages.len += 1;
            }
        }
        languages
    }

    /// The most preferred.
    pub fn first(&self) -> Locale {
        self.tags[0]
    }

    /// All of them, most preferred first.
    pub fn as_slice(&self) -> &[Locale] {
        &self.tags[..usize::from(self.len)]
    }

    /// All of them, most preferred first.
    pub fn iter(&self) -> impl Iterator<Item = Locale> + '_ {
        self.as_slice().iter().copied()
    }
}

impl Default for Languages {
    fn default() -> Self {
        Self::EN_US
    }
}

impl std::fmt::Debug for Languages {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.iter().map(|l| l.to_string()))
            .finish()
    }
}

/// A time zone's name as the system gives it: an IANA name
/// (`Europe/Berlin`, `America/Argentina/Buenos_Aires`, `UTC`), or an offset
/// zone where the system has one (Android's `GMT+01:00`). Held inline so
/// that the environment stays `Copy`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub struct TimeZone {
    bytes: [u8; TimeZone::CAPACITY],
    len: u8,
}

impl TimeZone {
    /// Room for any name the tz database's rules allow: parts of at most 14
    /// characters, four of them with their slashes in 59 bytes (its longest
    /// name, `America/Argentina/ComodRivadavia`, has three in 32), and for
    /// the systems' offset zones (`GMT+05:30`). 64 bytes with the length.
    const CAPACITY: usize = 63;

    /// `UTC`, the default when a platform reports none (and headless).
    pub const UTC: TimeZone = {
        let mut bytes = [0u8; TimeZone::CAPACITY];
        bytes[0] = b'U';
        bytes[1] = b'T';
        bytes[2] = b'C';
        TimeZone { bytes, len: 3 }
    };

    /// The zone of a platform identifier: an IANA name (`Europe/Berlin`),
    /// with POSIX `TZ`'s leading `:` (`:Europe/Berlin`), or as a path into
    /// a zone database (`/usr/share/zoneinfo/Europe/Berlin`,
    /// `/var/db/timezone/zoneinfo/Europe/Berlin`). `None` for what names no
    /// zone: empty, longer than any zone's name, or with characters zone
    /// names do not have.
    pub fn parse(identifier: &str) -> Option<TimeZone> {
        let identifier = identifier.trim();
        let name = match identifier.rsplit_once("zoneinfo/") {
            Some((_, name)) => name,
            None => identifier.strip_prefix(':').unwrap_or(identifier),
        };
        let valid = !name.is_empty()
            && name.len() <= Self::CAPACITY
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/_-+:".contains(&b))
            && name
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..");
        if !valid {
            return None;
        }
        let mut bytes = [0u8; Self::CAPACITY];
        bytes[..name.len()].copy_from_slice(name.as_bytes());
        Some(TimeZone {
            bytes,
            len: name.len() as u8,
        })
    }

    /// The zone a process's local times follow on a POSIX system (Linux,
    /// macOS, the BSDs): the one its `TZ` variable (`tz`, `None` when
    /// unset) names, as the C library reads it, else the system's
    /// (`system`, asked only then), else UTC.
    ///
    /// `TZ` names a zone of the tz database by its name, with a slash or
    /// without (`Europe/Berlin`, `Etc/GMT+5`, `GMT`, `EST`) and with or
    /// without its leading `:`, or by a path into the database
    /// (`/usr/share/zoneinfo/Asia/Tokyo`); empty, it is UTC. A POSIX rule
    /// (`JST-9`, `<+08>-8`, `CET-1CEST,M3.5.0,M10.5.0/3`) names no zone,
    /// nor does a path elsewhere (`:/etc/localtime`, the system's): the
    /// system's zone is reported for them. The database's few names that
    /// read as rules too (`EST5EDT`, `GMT0`) are its zones, which mean the
    /// same.
    #[doc(hidden)]
    pub fn posix(tz: Option<&str>, system: impl FnOnce() -> Option<TimeZone>) -> TimeZone {
        let zone = match tz.map(str::trim) {
            None => None,
            // glibc and tzcode alike take an empty `TZ` for UTC.
            Some("") => Some(Self::UTC),
            Some(tz) => {
                let name = tz.strip_prefix(':').unwrap_or(tz);
                if is_posix_rule(name) && !RULE_NAMED_ZONES.contains(&name) {
                    None
                } else {
                    Self::parse(name)
                }
            }
        };
        zone.or_else(system).unwrap_or_default()
    }

    /// The name (`Europe/Berlin`).
    pub fn as_str(&self) -> &str {
        // ASCII, as parsed.
        std::str::from_utf8(&self.bytes[..usize::from(self.len)]).unwrap_or("UTC")
    }
}

/// The tz database's names that read as POSIX rules too (`EST5EDT` is
/// Eastern time with US rules, `GMT0` UTC under either reading): the C
/// library loads their zones' files.
const RULE_NAMED_ZONES: [&str; 7] = [
    "EST5EDT", "CST6CDT", "MST7MDT", "PST8PDT", "GMT0", "GMT+0", "GMT-0",
];

/// Whether `TZ`'s value `tz` is a POSIX rule: a zone abbreviation, quoted
/// (`<+08>`) or of three letters or more (`JST`), then its offset from UTC
/// (`-9`, `5`, `+5:30`). No zone's name but [`RULE_NAMED_ZONES`] has that
/// shape: the database's other names without a slash have no offset
/// (`GMT`, `Japan`) or a shorter word before it (`NZ-CHAT`).
fn is_posix_rule(tz: &str) -> bool {
    let letters = tz.bytes().take_while(u8::is_ascii_alphabetic).count();
    tz.starts_with('<')
        || letters >= 3
            && tz
                .as_bytes()
                .get(letters)
                .is_some_and(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-'))
}

impl Default for TimeZone {
    fn default() -> Self {
        Self::UTC
    }
}

impl std::fmt::Debug for TimeZone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TimeZone({})", self.as_str())
    }
}

impl std::fmt::Display for TimeZone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The user's locale settings beside the locale (`locale_settings()`; TS
/// `localeSettings()`): the preferred languages, the time zone and the
/// regional preferences the systems keep beside the language (Language &
/// Region on Apple platforms, Android's regional preferences, Windows'
/// region settings). They change together, as the user changes the
/// system's settings or travels. Where the user set no regional preference,
/// it is the region's. The names are `Intl`'s and Foundation's, so they
/// pass into `Intl`'s options as they are.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub struct LocaleSettings {
    /// The preferred languages, most preferred first (the system's list:
    /// the language apps show their text in, then its fallbacks).
    pub languages: Languages,
    /// The device's time zone, as the system names it (`Europe/Berlin`).
    pub time_zone: TimeZone,
    /// 12- or 24-hour time.
    pub hour_cycle: HourCycle,
    /// The day weeks start on: a calendar's first column.
    pub first_day_of_week: Weekday,
    /// The units of lengths, weights and volumes.
    pub measurement_system: MeasurementSystem,
    /// The unit of temperatures.
    pub temperature_unit: TemperatureUnit,
}

impl LocaleSettings {
    /// `en-US`'s (`en-US` alone, 12-hour time, weeks from Sunday, US units,
    /// Fahrenheit) in UTC, the default when a platform reports none.
    pub(crate) const EN_US: LocaleSettings = LocaleSettings {
        languages: Languages::EN_US,
        time_zone: TimeZone::UTC,
        hour_cycle: HourCycle::H12,
        first_day_of_week: Weekday::Sunday,
        measurement_system: MeasurementSystem::Us,
        temperature_unit: TemperatureUnit::Fahrenheit,
    };

    /// `locale`'s: it alone as the languages, UTC, and its region's
    /// preferences as CLDR (48) gives them. A locale without a region has
    /// the world's: 24-hour time, weeks from Monday, metric units and
    /// Celsius.
    #[doc(hidden)]
    pub fn of(locale: Locale) -> LocaleSettings {
        LocaleSettings {
            languages: Languages::one(locale),
            ..Self::of_region(locale.language(), locale.region().unwrap_or("001"))
        }
    }

    /// The settings a platform locale identifier names: its locale alone
    /// as the languages (`en-US` where it names none), UTC, and its
    /// region's preferences ([`Self::of`]; the `rg` keyword's region in
    /// place of its own), with what its Unicode extension keywords set:
    /// `hc` (the hour cycle), `fw` (the first day of the week), `ms` (the
    /// measurement system) and `mu` (the temperature unit), written as BCP
    /// 47 does (`en-US-u-fw-mon-mu-celsius`, Android's regional
    /// preferences) or as ICU does (`en_US@hours=h23;fw=mon;rg=gbzzzz`).
    /// Values it does not know are left out.
    #[doc(hidden)]
    pub fn parse(identifier: &str) -> LocaleSettings {
        let identifier = identifier.trim();
        let (tag, icu) = identifier.split_once('@').unwrap_or((identifier, ""));
        let mut keywords = Keywords::default();
        // BCP 47's `-u-` extension: keys of two characters, each followed
        // by its value.
        let mut extension = false;
        let mut key = "";
        for subtag in tag.split('.').next().unwrap_or_default().split(['-', '_']) {
            if subtag.len() == 1 {
                extension = subtag.eq_ignore_ascii_case("u");
                key = "";
            } else if extension && subtag.len() == 2 {
                key = subtag;
            } else if extension && !key.is_empty() {
                keywords.set(key, subtag);
                key = "";
            }
        }
        for keyword in icu.split(';') {
            if let Some((key, value)) = keyword.split_once('=') {
                keywords.set(key.trim(), value.trim());
            }
        }
        let locale = Locale::parse(identifier);
        let language = locale.as_ref().map_or("", Locale::language);
        let region = match &keywords.region {
            Some((bytes, len)) => std::str::from_utf8(&bytes[..*len]).unwrap_or("001"),
            None => locale.as_ref().and_then(Locale::region).unwrap_or("001"),
        };
        let own = Self::of_region(language, region);
        LocaleSettings {
            languages: Languages::one(locale.unwrap_or(Locale::EN_US)),
            hour_cycle: keywords.hour_cycle.unwrap_or(own.hour_cycle),
            first_day_of_week: keywords.first_day_of_week.unwrap_or(own.first_day_of_week),
            measurement_system: keywords
                .measurement_system
                .unwrap_or(own.measurement_system),
            temperature_unit: keywords.temperature_unit.unwrap_or(own.temperature_unit),
            ..own
        }
    }

    /// CLDR's preferences of `region` (`001`: the world's), for `language`.
    fn of_region(language: &str, region: &str) -> LocaleSettings {
        let listed = |regions: &[&str]| regions.binary_search(&region).is_ok();
        LocaleSettings {
            hour_cycle: match (language, region) {
                // Where a language's differs from its region's.
                ("fr", "CA") | ("ku", "SY") => HourCycle::H23,
                ("ar" | "en", "001") => HourCycle::H12,
                _ if listed(HOUR12_REGIONS) => HourCycle::H12,
                _ => HourCycle::H23,
            },
            first_day_of_week: if listed(SUNDAY_REGIONS) {
                Weekday::Sunday
            } else if listed(SATURDAY_REGIONS) {
                Weekday::Saturday
            } else if listed(FRIDAY_REGIONS) {
                Weekday::Friday
            } else {
                Weekday::Monday
            },
            measurement_system: match region {
                "LR" | "US" => MeasurementSystem::Us,
                "GB" | "MM" => MeasurementSystem::Uk,
                _ => MeasurementSystem::Metric,
            },
            temperature_unit: match region {
                "BS" | "BZ" | "KY" | "PR" | "PW" | "US" => TemperatureUnit::Fahrenheit,
                _ => TemperatureUnit::Celsius,
            },
            ..Self::default()
        }
    }
}

impl Default for LocaleSettings {
    fn default() -> Self {
        Self::EN_US
    }
}

/// What a locale identifier's extension keywords set.
#[derive(Default)]
struct Keywords {
    hour_cycle: Option<HourCycle>,
    first_day_of_week: Option<Weekday>,
    measurement_system: Option<MeasurementSystem>,
    temperature_unit: Option<TemperatureUnit>,
    /// `rg`'s region, upper-cased, and its length.
    region: Option<([u8; 3], usize)>,
}

impl Keywords {
    /// Reads `key`'s `value` (BCP 47's key or ICU's name for it).
    fn set(&mut self, key: &str, value: &str) {
        let is = |names: &[&str]| names.iter().any(|n| key.eq_ignore_ascii_case(n));
        let value_is = |name: &str| value.eq_ignore_ascii_case(name);
        if is(&["hc", "hours"]) {
            self.hour_cycle = HourCycle::parse(value).or(self.hour_cycle);
        } else if is(&["fw"]) {
            self.first_day_of_week = Weekday::ALL
                .into_iter()
                .find(|d| value_is(d.code()))
                .or(self.first_day_of_week);
        } else if is(&["ms", "measure"]) {
            self.measurement_system = match () {
                _ if value_is("metric") => Some(MeasurementSystem::Metric),
                _ if value_is("ussystem") => Some(MeasurementSystem::Us),
                _ if value_is("uksystem") => Some(MeasurementSystem::Uk),
                _ => self.measurement_system,
            };
        } else if is(&["mu"]) {
            // BCP 47 values have at most 8 characters: `fahrenhe`.
            let unit = match value_is("fahrenhe") {
                true => Some(TemperatureUnit::Fahrenheit),
                false => TemperatureUnit::parse(value),
            };
            self.temperature_unit = unit.or(self.temperature_unit);
        } else if is(&["rg"]) {
            // A subdivision: the region (`gb`, `419`), then `zzzz` for all
            // of it.
            let bytes = value.as_bytes();
            let len = match bytes {
                [a, b, c, ..] if [a, b, c].iter().all(|b| b.is_ascii_digit()) => 3,
                [a, b, ..] if a.is_ascii_alphabetic() && b.is_ascii_alphabetic() => 2,
                _ => return,
            };
            let mut region = [0u8; 3];
            for (to, from) in region.iter_mut().zip(bytes) {
                *to = from.to_ascii_uppercase();
            }
            self.region = Some((region, len));
        }
    }
}

/// The regions whose times are 12-hour (`timeData`'s preferred `h`).
const HOUR12_REGIONS: &[&str] = &[
    "419", "AE", "AG", "AL", "AR", "AS", "AU", "BB", "BD", "BH", "BM", "BN", "BO", "BS", "BT",
    "CA", "CL", "CO", "CR", "CU", "CY", "DJ", "DM", "DO", "DZ", "EC", "EG", "EH", "ER", "ET", "FJ",
    "FM", "GD", "GH", "GM", "GR", "GT", "GU", "GY", "HK", "HN", "IN", "IQ", "JM", "JO", "KH", "KI",
    "KN", "KP", "KR", "KW", "KY", "LB", "LC", "LR", "LS", "LY", "MH", "MO", "MP", "MR", "MW", "MX",
    "MY", "NA", "NI", "NZ", "OM", "PA", "PE", "PG", "PH", "PK", "PR", "PS", "PW", "PY", "QA", "SA",
    "SB", "SD", "SG", "SL", "SO", "SS", "SV", "SY", "SZ", "TC", "TD", "TN", "TO", "TT", "TW", "UM",
    "US", "UY", "VC", "VE", "VG", "VI", "VU", "WS", "YE", "ZM",
];

/// The regions whose weeks start on Sunday (`weekData`'s `firstDay`).
const SUNDAY_REGIONS: &[&str] = &[
    "AG", "AS", "BD", "BR", "BS", "BT", "BW", "BZ", "CA", "CO", "DM", "DO", "ET", "GT", "GU", "HK",
    "HN", "ID", "IL", "IN", "IS", "JM", "JP", "KE", "KH", "KR", "LA", "MH", "MM", "MO", "MT", "MX",
    "MZ", "NI", "NP", "PA", "PE", "PH", "PK", "PR", "PT", "PY", "SA", "SG", "SV", "TH", "TT", "TW",
    "UM", "US", "VE", "VI", "WS", "YE", "ZA", "ZW",
];

/// The regions whose weeks start on Saturday.
const SATURDAY_REGIONS: &[&str] = &[
    "AF", "BH", "DJ", "DZ", "EG", "IQ", "IR", "JO", "KW", "LY", "OM", "QA", "SD", "SY",
];

/// The regions whose weeks start on Friday.
const FRIDAY_REGIONS: &[&str] = &["MV"];

/// How hours are counted, as `Intl`'s `hourCycle` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, crate::element::PropEnum)]
pub enum HourCycle {
    /// 12-hour time from 0 to 11 (`h11`: `0:30 PM`).
    H11,
    /// 12-hour time from 1 to 12 (`h12`: `12:30 PM`).
    #[default]
    H12,
    /// 24-hour time from 0 to 23 (`h23`: `00:30`).
    H23,
    /// 24-hour time from 1 to 24 (`h24`: `24:30`).
    H24,
}

impl HourCycle {
    /// Its `Intl` name: `"h11"`, `"h12"`, `"h23"` or `"h24"`.
    pub fn name(self) -> &'static str {
        match self {
            HourCycle::H11 => "h11",
            HourCycle::H12 => "h12",
            HourCycle::H23 => "h23",
            HourCycle::H24 => "h24",
        }
    }

    /// The cycle `Intl` names `name` (`"h23"`, in any case).
    pub fn parse(name: &str) -> Option<HourCycle> {
        [
            HourCycle::H11,
            HourCycle::H12,
            HourCycle::H23,
            HourCycle::H24,
        ]
        .into_iter()
        .find(|c| name.eq_ignore_ascii_case(c.name()))
    }

    /// The cycle of a date pattern's hour field, in the letters of
    /// Unicode's patterns (Apple's and ICU's date formats, Windows' time
    /// formats): `h` (`h:mm a` is `h12`), `H` (`HH:mm` is `h23`), `K` and
    /// `k`. Quoted text (`HH 'Uhr'`) is not read; `None` without an hour.
    #[doc(hidden)]
    pub fn of_pattern(pattern: &str) -> Option<HourCycle> {
        let mut quoted = false;
        pattern.chars().find_map(|c| match c {
            '\'' => {
                quoted = !quoted;
                None
            }
            _ if quoted => None,
            'h' => Some(HourCycle::H12),
            'H' => Some(HourCycle::H23),
            'K' => Some(HourCycle::H11),
            'k' => Some(HourCycle::H24),
            _ => None,
        })
    }

    /// 12-hour time: times have AM and PM.
    pub fn twelve_hour(self) -> bool {
        matches!(self, HourCycle::H11 | HourCycle::H12)
    }
}

/// A day of the week.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Weekday {
    /// Monday (1).
    Monday = 1,
    /// Tuesday (2).
    Tuesday,
    /// Wednesday (3).
    Wednesday,
    /// Thursday (4).
    Thursday,
    /// Friday (5).
    Friday,
    /// Saturday (6).
    Saturday,
    /// Sunday (7).
    Sunday,
}

impl Weekday {
    /// The days, from Monday.
    const ALL: [Weekday; 7] = [
        Weekday::Monday,
        Weekday::Tuesday,
        Weekday::Wednesday,
        Weekday::Thursday,
        Weekday::Friday,
        Weekday::Saturday,
        Weekday::Sunday,
    ];

    /// Its ISO 8601 number, TS's: 1 for Monday to 7 for Sunday (as
    /// `Intl.Locale`'s `firstDay` and Temporal's `dayOfWeek` count).
    pub fn number(self) -> u8 {
        self as u8
    }

    /// The day of an ISO 8601 number (1 for Monday to 7 for Sunday).
    pub fn from_number(number: u8) -> Option<Weekday> {
        Self::ALL.get(usize::from(number).checked_sub(1)?).copied()
    }

    /// Unicode's code for it (`mon`), as the `fw` keyword writes it.
    fn code(self) -> &'static str {
        match self {
            Weekday::Monday => "mon",
            Weekday::Tuesday => "tue",
            Weekday::Wednesday => "wed",
            Weekday::Thursday => "thu",
            Weekday::Friday => "fri",
            Weekday::Saturday => "sat",
            Weekday::Sunday => "sun",
        }
    }
}

/// The units of lengths, weights and volumes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, crate::element::PropEnum)]
pub enum MeasurementSystem {
    /// Metres, kilograms and litres (`metric`).
    #[default]
    Metric,
    /// The US customary units: feet, miles, pounds and gallons (`us`).
    Us,
    /// The UK's: metric, with miles for distances and pints (`uk`).
    Uk,
}

impl MeasurementSystem {
    /// Its TS name: `"metric"`, `"us"` or `"uk"`.
    pub fn name(self) -> &'static str {
        match self {
            MeasurementSystem::Metric => "metric",
            MeasurementSystem::Us => "us",
            MeasurementSystem::Uk => "uk",
        }
    }

    /// The system TS names `name` (`"metric"`, in any case).
    pub fn parse(name: &str) -> Option<MeasurementSystem> {
        [
            MeasurementSystem::Metric,
            MeasurementSystem::Us,
            MeasurementSystem::Uk,
        ]
        .into_iter()
        .find(|s| name.eq_ignore_ascii_case(s.name()))
    }
}

/// The unit of temperatures.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, crate::element::PropEnum)]
pub enum TemperatureUnit {
    /// Degrees Celsius (`celsius`).
    #[default]
    Celsius,
    /// Degrees Fahrenheit (`fahrenheit`).
    Fahrenheit,
}

impl TemperatureUnit {
    /// Its TS name: `"celsius"` or `"fahrenheit"`.
    pub fn name(self) -> &'static str {
        match self {
            TemperatureUnit::Celsius => "celsius",
            TemperatureUnit::Fahrenheit => "fahrenheit",
        }
    }

    /// The unit TS names `name` (`"celsius"`, in any case).
    pub fn parse(name: &str) -> Option<TemperatureUnit> {
        [TemperatureUnit::Celsius, TemperatureUnit::Fahrenheit]
            .into_iter()
            .find(|u| name.eq_ignore_ascii_case(u.name()))
    }
}

/// An HTTP request for the platform's network stack (made by JS `fetch`
/// and by Rust components' [`crate::element::fetch`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    /// Upper-case method (`GET`, `POST`, ...).
    pub method: String,
    /// Absolute URL.
    pub url: String,
    /// Header names and values, in order; names may repeat.
    pub headers: Vec<(String, String)>,
    /// Request body.
    pub body: HttpBody,
    /// Follow redirects (`redirect: "follow"`, the default).
    pub follow_redirects: bool,
}

impl HttpRequest {
    /// A request of `method` (`GET`, `POST`, ...; upper-cased) to `url`,
    /// with no headers or body, following redirects.
    pub fn new(method: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            method: method.into().to_ascii_uppercase(),
            url: url.into(),
            headers: Vec::new(),
            body: HttpBody::Empty,
            follow_redirects: true,
        }
    }

    /// A `GET` of `url`.
    pub fn get(url: impl Into<String>) -> Self {
        Self::new("GET", url)
    }

    /// A `POST` of `body` to `url`.
    pub fn post(url: impl Into<String>, body: impl Into<Vec<u8>>) -> Self {
        Self::new("POST", url).body(body)
    }

    /// Adds the header `name: value`.
    #[must_use]
    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    /// Sends `body`.
    #[must_use]
    pub fn body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = HttpBody::Bytes(body.into());
        self
    }
}

impl From<&str> for HttpRequest {
    fn from(url: &str) -> Self {
        Self::get(url)
    }
}

impl From<String> for HttpRequest {
    fn from(url: String) -> Self {
        Self::get(url)
    }
}

/// The body of an [`HttpRequest`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum HttpBody {
    /// No body.
    #[default]
    Empty,
    /// All of it, known up front.
    Bytes(Vec<u8>),
    /// Produced while the request is sent (a `ReadableStream`), in chunks
    /// the stack asks for one at a time ([`FetchEvent::BodyWanted`]); sent
    /// with chunked transfer encoding.
    Stream,
}

impl HttpBody {
    /// No body at all.
    pub fn is_empty(&self) -> bool {
        match self {
            HttpBody::Empty => true,
            HttpBody::Bytes(b) => b.is_empty(),
            HttpBody::Stream => false,
        }
    }
}

/// The status line and headers of a response, before its body.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HttpHead {
    /// Status code.
    pub status: u16,
    /// Reason phrase, if the stack reports one.
    pub status_text: String,
    /// Final URL, after redirects.
    pub url: String,
    /// True if a redirect was followed.
    pub redirected: bool,
    /// Header names and values.
    pub headers: Vec<(String, String)>,
}

/// The media type of the file at `path` (a path or an `asset:/` URL), by
/// its extension: what the dev server serves files with and what the
/// engine answers requests of the app's files with, so a file has one type
/// however it arrives. Browsers need it to load scripts, WebAssembly
/// (compiled while it streams only as `application/wasm`), images, fonts
/// and media.
#[doc(hidden)]
pub fn content_type(path: &str) -> &'static str {
    match std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("wasm") => "application/wasm",
        Some("css") => "text/css; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("svg") => "image/svg+xml",
        Some("ico") => "image/x-icon",
        Some("heic") => "image/heic",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("mp4" | "m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("wav") => "audio/wav",
        Some("ogg" | "oga" | "opus") => "audio/ogg",
        Some("flac") => "audio/flac",
        Some("aif" | "aiff") => "audio/aiff",
        Some("caf") => "audio/x-caf",
        _ => "application/octet-stream",
    }
}

/// What happens to a request, in order: (for a streamed body) any number
/// of `BodyWanted`; then `Head`, `Data`… and `End` — or `Failed` at any
/// point.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchEvent {
    /// A streamed body's next chunk is wanted: first when the stack is
    /// ready to send, then each time the last chunk was handed on.
    BodyWanted,
    /// The response's status and headers arrived.
    Head(HttpHead),
    /// Bytes of the response body, in order.
    Data(Vec<u8>),
    /// The body is complete.
    End,
    /// The request failed (no response, or the body broke off).
    Failed(String),
}

/// What JS asks of a request it made (the JS host queues these for the
/// engine, which hands them to the stack).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchOp {
    /// Make the request.
    Start(HttpRequest),
    /// The next chunk of a streamed body (after [`FetchEvent::BodyWanted`]).
    Send(Vec<u8>),
    /// A streamed body is complete.
    Finish,
    /// Stop (`true`) or go on (`false`) reading the response body: nobody
    /// reads what arrived.
    Pause(bool),
    /// Abort the request (`AbortController`, or the body was cancelled).
    Cancel,
}

#[cfg(test)]
mod tests {
    use super::{
        Environment, HostEnvironment, HourCycle, Idiom, Languages, Locale, LocaleSettings,
        MeasurementSystem, Os, TemperatureUnit, TimeZone, Weekday, content_type,
    };

    #[test]
    fn desktop_is_a_desktop_os_or_a_desktop_browser() {
        let desktop = |os: Os, idiom: Idiom| Environment {
            os,
            idiom,
            ..Environment::default()
        };
        for (os, idiom, expected) in [
            (Os::MacOs, Idiom::Desktop, true),
            (Os::Windows, Idiom::Desktop, true),
            (Os::Linux, Idiom::Desktop, true),
            // A desktop OS is desktop whatever idiom it was given.
            (Os::Linux, Idiom::Phone, true),
            (Os::Web, Idiom::Desktop, true),
            (Os::Web, Idiom::Pad, false),
            (Os::Web, Idiom::Phone, false),
            (Os::Ios, Idiom::Phone, false),
            (Os::Ios, Idiom::Pad, false),
            // Mac Catalyst: the iOS backend, mobile in either idiom.
            (Os::Ios, Idiom::Mac, false),
            (Os::Ios, Idiom::Desktop, false),
            (Os::Android, Idiom::Tv, false),
        ] {
            let env = desktop(os, idiom);
            assert_eq!(env.desktop(), expected, "{os:?} {idiom:?}");
            // `platform.idiom` is "desktop" exactly where desktop applies.
            assert_eq!(
                env.reported_idiom() == Idiom::Desktop,
                expected,
                "{os:?} {idiom:?}"
            );
        }
        assert_eq!(desktop(Os::Ios, Idiom::Mac).reported_idiom(), Idiom::Mac);
        assert_eq!(
            desktop(Os::Ios, Idiom::Desktop).reported_idiom(),
            Idiom::Phone
        );
        assert!(!Os::MacOs.is_catalyst() && !Os::Web.is_catalyst());
        assert_eq!(Os::Ios.is_catalyst(), cfg!(target_abi = "macabi"));
    }

    #[test]
    fn desktop_behavior_applies_in_the_terminal_idiom_on_any_os() {
        for os in [Os::MacOs, Os::Windows, Os::Linux, Os::Ios, Os::Web] {
            assert!(Idiom::Terminal.desktop_on(os), "{os:?}");
            assert_eq!(Idiom::Terminal.reported_on(os), Idiom::Terminal, "{os:?}");
        }
    }

    #[test]
    fn a_host_environment_replaces_what_it_sets() {
        let mut env = Environment {
            font_scale: 1.25,
            ..Environment::default()
        };
        HostEnvironment::default().apply(&mut env);
        assert_eq!((env.locale, env.font_scale), (Locale::EN_US, 1.25));
        let zh = Locale::parse("zh-Hans-CN").unwrap();
        HostEnvironment {
            locale: Some(zh),
            font_scale: Some(f32::NAN),
        }
        .apply(&mut env);
        assert_eq!((env.locale, env.font_scale), (zh, 1.25));
        HostEnvironment {
            locale: None,
            font_scale: Some(1.5),
        }
        .apply(&mut env);
        assert_eq!((env.locale, env.font_scale), (zh, 1.5));
    }

    #[test]
    fn languages_parse_platform_identifiers_and_an_embedding_app_goes_first() {
        let tags = |l: Languages| l.iter().map(|l| l.to_string()).collect::<Vec<_>>();
        let system = Languages::parse(["de_DE", "C", "en-US", "de-DE", "fr"]).unwrap();
        assert_eq!(tags(system), ["de-DE", "en-US", "fr"]);
        assert_eq!(system.first().as_str(), "de-DE");
        assert_eq!(Languages::parse(["C", ""]), None);
        let many: Vec<String> = (0..20)
            .map(|i| format!("x{}", (b'a' + i) as char))
            .collect();
        let many = Languages::parse(many.iter().map(String::as_str)).unwrap();
        assert_eq!(many.as_slice().len(), Languages::CAPACITY);
        let fr = Locale::parse("fr").unwrap();
        assert_eq!(tags(system.preferring(fr)), ["fr", "de-DE", "en-US"]);
        let ja = Locale::parse("ja-JP").unwrap();
        assert_eq!(
            tags(system.preferring(ja)),
            ["ja-JP", "de-DE", "en-US", "fr"]
        );
        assert_eq!(tags(Languages::default()), ["en-US"]);
        // An embedding app's language comes first.
        let mut env = Environment::default();
        env.locale_settings.languages = system;
        HostEnvironment {
            locale: Some(ja),
            font_scale: None,
        }
        .apply(&mut env);
        assert_eq!(
            tags(env.locale_settings.languages),
            ["ja-JP", "de-DE", "en-US", "fr"]
        );
    }

    #[test]
    fn locales_parse_platform_identifiers() {
        let tag = |s: &str| Locale::parse(s).map(|l| l.as_str().to_owned());
        assert_eq!(tag("en_US").as_deref(), Some("en-US"));
        assert_eq!(tag("zh-hans_cn").as_deref(), Some("zh-Hans-CN"));
        assert_eq!(tag("de_DE@calendar=gregorian").as_deref(), Some("de-DE"));
        assert_eq!(tag("pt_BR.UTF-8").as_deref(), Some("pt-BR"));
        assert_eq!(tag("es-419").as_deref(), Some("es-419"));
        assert_eq!(tag("en-US-u-hc-h23").as_deref(), Some("en-US"));
        assert_eq!(tag("C"), None);
        assert_eq!(Locale::default().as_str(), "en-US");
        let zh = Locale::parse("zh-Hans-CN").unwrap();
        assert_eq!((zh.language(), zh.region()), ("zh", Some("CN")));
        assert_eq!(Locale::parse("zh-Hans").unwrap().region(), None);
        assert_eq!(Locale::parse("es-419").unwrap().region(), Some("419"));
    }

    #[test]
    fn regional_preferences_are_the_regions_unless_the_locale_sets_others() {
        // The regional part of the settings: what the locale decides.
        type Regional = (HourCycle, Weekday, MeasurementSystem, TemperatureUnit);
        let regional = |s: LocaleSettings| -> Regional {
            (
                s.hour_cycle,
                s.first_day_of_week,
                s.measurement_system,
                s.temperature_unit,
            )
        };
        let of = |tag: &str| LocaleSettings::of(Locale::parse(tag).unwrap());
        let us = regional(LocaleSettings::default());
        let world = (
            HourCycle::H23,
            Weekday::Monday,
            MeasurementSystem::Metric,
            TemperatureUnit::Celsius,
        );
        assert_eq!(regional(of("en-US")), us);
        assert_eq!(
            LocaleSettings::default().languages.as_slice(),
            &[Locale::EN_US]
        );
        assert_eq!(LocaleSettings::default().time_zone, TimeZone::UTC);
        // The locale alone is the languages.
        assert_eq!(
            of("de-DE").languages.as_slice(),
            &[Locale::parse("de-DE").unwrap()]
        );
        assert_eq!(regional(of("de-DE")), world);
        // Without a region: the world's.
        assert_eq!(regional(of("ja")), world);
        assert_eq!(of("en-CA").hour_cycle, HourCycle::H12);
        // Where the language's differs from the region's.
        assert_eq!(of("fr-CA").hour_cycle, HourCycle::H23);
        assert_eq!(of("fr-CA").first_day_of_week, Weekday::Sunday);
        assert_eq!(of("en-001").hour_cycle, HourCycle::H12);
        assert_eq!(of("es-419").hour_cycle, HourCycle::H12);
        assert_eq!(of("ar-EG").first_day_of_week, Weekday::Saturday);
        assert_eq!(of("dv-MV").first_day_of_week, Weekday::Friday);
        let gb = of("en-GB");
        assert_eq!(gb.measurement_system, MeasurementSystem::Uk);
        assert_eq!(gb.temperature_unit, TemperatureUnit::Celsius);
        assert_eq!(of("en-LR").temperature_unit, TemperatureUnit::Celsius);
        assert_eq!(of("es-PR").temperature_unit, TemperatureUnit::Fahrenheit);

        let parse = |identifier: &str| regional(LocaleSettings::parse(identifier));
        assert_eq!(
            parse("en-US-u-fw-mon-mu-celsius"),
            (
                HourCycle::H12,
                Weekday::Monday,
                MeasurementSystem::Us,
                TemperatureUnit::Celsius
            )
        );
        assert_eq!(
            parse("en_US@hours=h23;measure=metric"),
            (
                HourCycle::H23,
                Weekday::Sunday,
                MeasurementSystem::Metric,
                TemperatureUnit::Fahrenheit
            )
        );
        assert_eq!(parse("en_US@rg=gbzzzz"), regional(gb));
        assert_eq!(
            parse("ar-u-ca-islamic-umalqura-hc-h11-rg-uszzzz"),
            (HourCycle::H11, us.1, us.2, us.3)
        );
        assert_eq!(
            LocaleSettings::parse("en-GB-u-ms-ussystem-mu-fahrenhe").measurement_system,
            MeasurementSystem::Us
        );
        // What it does not know is left out.
        assert_eq!(parse("de_DE.UTF-8@fw=xyz;hours=h99;rg=1"), world);
        assert_eq!(parse("en-US-x-hc-h23"), us);
        assert_eq!(parse("C"), world);
        // Its locale is the languages, `en-US` where it names none.
        assert_eq!(
            LocaleSettings::parse("de_DE.UTF-8").languages.as_slice(),
            &[Locale::parse("de-DE").unwrap()]
        );
        assert_eq!(
            LocaleSettings::parse("C").languages.as_slice(),
            &[Locale::EN_US]
        );
        assert_eq!(Weekday::from_number(7), Some(Weekday::Sunday));
        assert_eq!(Weekday::from_number(0), None);
        assert_eq!(Weekday::Monday.number(), 1);
        assert!(HourCycle::H11.twelve_hour() && !HourCycle::H24.twelve_hour());
        assert_eq!(HourCycle::of_pattern("h:mm a"), Some(HourCycle::H12));
        assert_eq!(HourCycle::of_pattern("HH 'Uhr'"), Some(HourCycle::H23));
        assert_eq!(HourCycle::of_pattern("'h' K:mm"), Some(HourCycle::H11));
        assert_eq!(HourCycle::of_pattern("mm:ss"), None);
    }

    #[test]
    fn time_zones_parse_platform_identifiers() {
        let zone = |s: &str| TimeZone::parse(s).map(|z| z.as_str().to_owned());
        assert_eq!(zone("Europe/Berlin").as_deref(), Some("Europe/Berlin"));
        assert_eq!(zone(":Asia/Tokyo").as_deref(), Some("Asia/Tokyo"));
        assert_eq!(
            zone("/var/db/timezone/zoneinfo/America/Argentina/Buenos_Aires").as_deref(),
            Some("America/Argentina/Buenos_Aires")
        );
        assert_eq!(
            zone("/usr/share/zoneinfo/Etc/GMT+5").as_deref(),
            Some("Etc/GMT+5")
        );
        assert_eq!(zone("GMT+01:00").as_deref(), Some("GMT+01:00"));
        assert_eq!(
            zone("America/Argentina/ComodRivadavia").as_deref(),
            Some("America/Argentina/ComodRivadavia")
        );
        assert_eq!(zone(""), None);
        assert_eq!(zone("Europe//Berlin"), None);
        assert_eq!(zone("../etc/passwd"), None);
        assert_eq!(zone("Central European Standard Time"), None);
        let parts = ["Abcdefghijklmn"; 4].join("/");
        assert_eq!(zone(&parts).as_deref(), Some(parts.as_str()));
        assert_eq!(zone(&"A".repeat(64)), None);
        assert_eq!(TimeZone::default().as_str(), "UTC");
        assert_eq!(
            Environment::default().locale_settings.time_zone,
            TimeZone::UTC
        );
    }

    #[test]
    fn posix_time_zones_follow_the_zone_tz_names() {
        // A system zone other than UTC, so that falling back on it shows.
        let singapore = || TimeZone::parse("Asia/Singapore");
        let zone = |tz: Option<&str>| TimeZone::posix(tz, singapore).as_str().to_owned();
        // `TZ=GMT` is the process's zone, eight hours from the system's.
        assert_eq!(zone(Some("GMT")), "GMT");
        assert_eq!(
            TimeZone::posix(Some("GMT"), || unreachable!("TZ names the zone")).as_str(),
            "GMT"
        );
        // The tz database's names, with a slash or without, and with `:`.
        for name in [
            "UTC",
            "EST",
            "Japan",
            "NZ-CHAT",
            "Etc/GMT+5",
            "Europe/Berlin",
            "EST5EDT",
            "GMT0",
            "GMT-0",
        ] {
            assert_eq!(zone(Some(name)), name);
            assert_eq!(zone(Some(&format!(":{name}"))), name);
        }
        assert_eq!(zone(Some(":/usr/share/zoneinfo/Asia/Tokyo")), "Asia/Tokyo");
        // An empty `TZ` is UTC.
        assert_eq!(zone(Some("")), "UTC");
        // POSIX rules and other files name no zone: the system's stands.
        for tz in [
            "JST-9",
            "EST5",
            "CET-1CEST",
            "<+08>-8",
            "CET-1CEST,M3.5.0,M10.5.0/3",
            "GMT+01:00",
            ":/etc/localtime",
            ":",
        ] {
            assert_eq!(zone(Some(tz)), "Asia/Singapore", "TZ={tz}");
        }
        assert_eq!(zone(None), "Asia/Singapore");
        assert_eq!(TimeZone::posix(None, || None), TimeZone::UTC);
    }

    #[test]
    fn content_types_follow_the_extension_of_paths_and_asset_urls() {
        assert_eq!(
            content_type("dist/app.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("nsh.WASM"), "application/wasm");
        assert_eq!(
            content_type("asset:/@app/locales/en.json"),
            "application/json"
        );
        assert_eq!(content_type("asset:/images/flag@2x.png"), "image/png");
        assert_eq!(content_type("asset:/fonts/Inter.woff2"), "font/woff2");
        assert_eq!(content_type("asset:/sounds/chime.OGG"), "audio/ogg");
        for unknown in ["asset:/data.bin", "asset:/README", "asset:/.png"] {
            assert_eq!(
                content_type(unknown),
                "application/octet-stream",
                "{unknown}"
            );
        }
    }
}

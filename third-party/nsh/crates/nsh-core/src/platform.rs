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
    /// macOS.
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

    /// A desktop OS (macOS, Windows, Linux). A surface's graphical desktop
    /// behavior (`nsh/desktop`, `desktop={{…}}` props) also depends on its
    /// renderer and browser idiom: [`Environment::desktop`].
    pub fn is_desktop(self) -> bool {
        matches!(self, Os::MacOs | Os::Windows | Os::Linux)
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

/// How a surface presents its UI, independently of its operating system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Renderer {
    /// Platform views or a desktop graphics backend.
    #[default]
    Native,
    /// HTML in a browser page.
    Web,
    /// Character cells in a terminal.
    Terminal,
}

impl Renderer {
    /// Its `platform.renderer` name.
    pub fn name(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Web => "web",
            Self::Terminal => "terminal",
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
    /// A Mac (Mac Catalyst).
    Mac,
    /// A TV.
    Tv,
    /// A desktop computer (a desktop backend, or a browser with a mouse and
    /// a wide viewport; Mac Catalyst is [`Idiom::Mac`]).
    Desktop,
}

impl Idiom {
    /// Whether `os` and this idiom describe a desktop: a desktop OS, or a
    /// browser in the desktop idiom. [`Environment::desktop`] also checks
    /// the surface's renderer.
    pub fn desktop_on(self, os: Os) -> bool {
        os.is_desktop() || (os == Os::Web && self == Idiom::Desktop)
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
    /// How this surface presents its UI (`platform.renderer`).
    pub renderer: Renderer,
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
    /// Command, labels use ⌘). Only read for [`Os::Web`]; graphical native
    /// backends infer theirs from the OS. Terminals use Control.
    pub apple_keyboard: bool,
    /// The host receives terminal key sequences, including when its pixels are
    /// rendered by a graphical backend. Command shortcuts use Control.
    pub terminal_keyboard: bool,
    /// The user's locale (number and date formats: `Intl`'s default).
    pub locale: Locale,
    /// The app embedding NSH answers `nsh/host`'s calls
    /// ([`crate::Command::HostCall`]); without it, they reject at once.
    pub host: bool,
}

impl Environment {
    /// Whether command shortcuts follow terminal Control-key conventions.
    pub fn uses_terminal_keyboard(&self) -> bool {
        self.terminal_keyboard || self.renderer == Renderer::Terminal
    }

    /// Whether command shortcuts follow Apple's Command-key conventions.
    pub fn uses_apple_keys(&self) -> bool {
        !self.uses_terminal_keyboard() && crate::keymap::apple_keys(self.os, self.apple_keyboard)
    }

    /// Graphical desktop behavior applies: a desktop OS with a graphical
    /// renderer, or a browser in the desktop idiom (`desktop={{…}}` props,
    /// `platform.select({ desktop })`).
    pub fn desktop(&self) -> bool {
        self.renderer != Renderer::Terminal && self.idiom.desktop_on(self.os)
    }
}

impl Default for Environment {
    fn default() -> Self {
        Self {
            window: Size::default(),
            safe_area: Edges::default(),
            title_bar: Edges::default(),
            keyboard_height: Points(0.0),
            keyboard_duration: 250.0,
            color_scheme: ColorScheme::Light,
            font_scale: 1.0,
            rtl: false,
            reduce_motion: false,
            pixel_ratio: 1.0,
            screen_reader: false,
            os: Os::default(),
            renderer: Renderer::Native,
            native_focus_scopes: false,
            fallback_key_bindings: false,
            os_version: (0, 0),
            idiom: Idiom::Phone,
            apple_keyboard: false,
            terminal_keyboard: false,
            locale: Locale::EN_US,
            host: false,
        }
    }
}

/// The settings an embedding app gives its surfaces in place of the
/// system's (`None`: the system's): its own language and text size, for an
/// app inside a native app that lets its users switch them. The platforms
/// write them over what they read from the system ([`Self::apply`]), so the
/// app's `Intl`, `locale()`, `fontScale()` and text follow them like a system
/// change.
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

/// An HTTP request for the platform's network stack (made by JS `fetch`
/// and by Rust components' [`crate::element::ambient::fetch`]).
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
    use super::{Environment, HostEnvironment, Idiom, Locale, Os, Renderer};

    #[test]
    fn graphical_terminal_input_retains_control_shortcuts_on_apple_hosts() {
        let desktop = Environment {
            os: Os::MacOs,
            ..Default::default()
        };
        assert!(desktop.uses_apple_keys());
        let terminal = Environment {
            terminal_keyboard: true,
            ..desktop
        };
        assert!(!terminal.uses_apple_keys());
        assert_eq!(terminal.renderer, desktop.renderer);
        assert_eq!(terminal.os, Os::MacOs);
    }

    #[test]
    fn renderer_separates_terminal_from_graphical_desktop_behavior() {
        for os in [Os::MacOs, Os::Windows, Os::Linux] {
            let native = Environment {
                os,
                idiom: Idiom::Desktop,
                ..Environment::default()
            };
            assert!(native.desktop());
            let terminal = Environment {
                renderer: Renderer::Terminal,
                ..native
            };
            assert_eq!(terminal.os, os);
            assert!(!terminal.desktop());
        }
        let browser = Environment {
            os: Os::Web,
            renderer: Renderer::Web,
            idiom: Idiom::Desktop,
            ..Environment::default()
        };
        assert!(browser.desktop());
        assert!(
            !Environment {
                idiom: Idiom::Phone,
                ..browser
            }
            .desktop()
        );
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
    }
}

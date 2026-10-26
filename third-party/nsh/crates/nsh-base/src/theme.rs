//! The theme of NSH apps' UI: shadcn/ui's design tokens, exactly. The
//! surfaces and roles (`background`, `card`, `popover`, `primary`,
//! `secondary`, `muted`, `accent`), each with the color of what is drawn on
//! it (`-foreground`), `destructive`, `border`, `input`, `ring`, the charts'
//! colors (`chart-1` to `chart-5`), the sidebar's (`sidebar`, ...), each
//! with a light and a dark value, and the corner radius (`radius`): the
//! fields of [`Theme`], with its fonts, Tailwind's `font-sans` and
//! `font-mono`, which the default leaves to the system.
//!
//! A theme file is shadcn's `cssVars`, as a registry item has them (what
//! tweakcn and shadcn's themes export): `{ "cssVars": { "theme": { … },
//! "light": { "primary": "oklch(0.205 0 0)", … }, "dark": { … } } }`,
//! values as CSS writes them (colors, `var(--ring)`, `color-mix()`,
//! lengths in `rem` or `px`, font family lists). An app's
//! (`nsh.json` `"theme"`) goes over the default ([`DEFAULT_THEME`], shadcn's
//! `neutral`); names it adds (`surface`, `up`, `radius-card`) are the app's
//! own tokens, as variables a CSS theme adds are.
//!
//! The core keeps the result as design tokens ([`Tokens`]), which Tailwind
//! classes name (`bg-primary`, `bg-up/30`, `rounded-(--radius)`) and TS
//! reads (`token()` of `nsh`); it reads `nsh.json`'s theme with
//! [`tokens_of`], which `nsh/base`'s registry brings. What draws with them
//! is the app's: no component of `nsh/base` reads them, but for the
//! default reading typography of `TextView`.

use std::sync::{Arc, LazyLock};

use nsh_core::{
    Color, JsonValue,
    color::Hsla,
    element::{AdaptiveColor, FONT_MONO, FONT_SANS, SharedString, Tokens},
    geometry::{Points, px},
};
use rustc_hash::{FxHashMap, FxHashSet};

/// The default theme file: shadcn/ui's `neutral` theme.
pub const DEFAULT_THEME: &str = include_str!("default-theme.json");

static DEFAULT: LazyLock<Theme> = LazyLock::new(|| Theme::of(Arc::new(DEFAULT_TOKENS.clone())));

/// Points per `rem`, as Tailwind's theme has them.
const REM: f32 = 16.0;

/// A theme file that does not parse.
#[derive(Debug, Clone, PartialEq)]
pub struct ThemeError(pub String);

impl std::fmt::Display for ThemeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ThemeError {}

thread_local! {
    /// The theme of the tokens last read: `theme()` makes one only when
    /// the tokens change.
    static CURRENT: std::cell::RefCell<Option<Arc<Theme>>> = const { std::cell::RefCell::new(None) };
}

/// The theme the app is drawn with (reading it subscribes: a new theme
/// reaches what read it).
pub fn theme() -> Arc<Theme> {
    let tokens = nsh_core::element::ambient::tokens();
    CURRENT.with_borrow_mut(|current| match current {
        Some(theme) if Arc::ptr_eq(&theme.tokens, &tokens) => theme.clone(),
        _ => current.insert(Arc::new(Theme::of(tokens))).clone(),
    })
}

/// The tokens of theme file `json` over the default's (`None`: the
/// default's): how the core reads `nsh.json`'s `"theme"`
/// ([`nsh_core::element::Registry::tokens_from`]).
pub fn tokens_of(json: Option<&str>) -> Result<Tokens, String> {
    match json {
        Some(json) => Theme::from_json(json)
            .map(Theme::into_tokens)
            .map_err(|e| e.0),
        None => Ok(Theme::default().into_tokens()),
    }
}

macro_rules! theme {
    ($( $(#[doc = $doc:literal])* $name:ident = $key:literal ),* $(,)?) => {
        /// A theme: shadcn/ui's tokens, each a field, and the app's own
        /// ones by name ([`Theme::color`], [`Theme::number`],
        /// [`Theme::font`]).
        #[derive(Debug, Clone, PartialEq)]
        #[non_exhaustive]
        pub struct Theme {
            $(
                $(#[doc = $doc])*
                #[doc = concat!("\n\nToken `", $key, "`.")]
                pub $name: AdaptiveColor,
            )*
            /// The corner radius.
            ///
            /// Token `radius`.
            pub radius: Points,
            /// The app's font family, which text is drawn with unless it
            /// sets its own (`None`: the system's): Tailwind's `--font-sans`,
            /// which a theme may set.
            ///
            /// Token `font-sans`.
            pub font_sans: Option<SharedString>,
            /// The monospaced font family (`None`: the system's): Tailwind's
            /// `--font-mono`.
            ///
            /// Token `font-mono`.
            pub font_mono: Option<SharedString>,
            tokens: Arc<Tokens>,
        }

        impl Theme {
            /// The theme of `tokens`: shadcn's tokens they leave out
            /// (an embedding app's may) are the default's.
            fn of(tokens: Arc<Tokens>) -> Self {
                let default = |name: &str| DEFAULT_TOKENS.color(name);
                let color = |name: &str| {
                    tokens
                        .color(name)
                        .or_else(|| default(name))
                        .unwrap_or(AdaptiveColor::TRANSPARENT)
                };
                Theme {
                    $( $name: color($key), )*
                    radius: px(tokens
                        .number("radius")
                        .or_else(|| DEFAULT_TOKENS.number("radius"))
                        .unwrap_or(0.0)),
                    font_sans: tokens.font(FONT_SANS).cloned().map(SharedString::from),
                    font_mono: tokens.font(FONT_MONO).cloned().map(SharedString::from),
                    tokens,
                }
            }
        }
    };
}

/// The default theme's tokens, which [`Theme::of`] falls back on (the
/// default [`Theme`] is made of them).
static DEFAULT_TOKENS: LazyLock<Tokens> = LazyLock::new(|| {
    let mut tokens = Tokens::default();
    apply(&mut tokens, DEFAULT_THEME).expect("the default theme parses");
    tokens
});

theme! {
    /// The app's background.
    background = "background",
    /// Text and icons on [`Theme::background`].
    foreground = "foreground",
    /// Cards.
    card = "card",
    /// Text on [`Theme::card`].
    card_foreground = "card-foreground",
    /// Popovers, menus, tooltips.
    popover = "popover",
    /// Text on [`Theme::popover`].
    popover_foreground = "popover-foreground",
    /// The main action.
    primary = "primary",
    /// Text on [`Theme::primary`].
    primary_foreground = "primary-foreground",
    /// Secondary actions.
    secondary = "secondary",
    /// Text on [`Theme::secondary`].
    secondary_foreground = "secondary-foreground",
    /// Muted surfaces.
    muted = "muted",
    /// Secondary text: hints, captions, placeholders.
    muted_foreground = "muted-foreground",
    /// What is hovered or focused: menu items, list rows.
    accent = "accent",
    /// Text on [`Theme::accent`].
    accent_foreground = "accent-foreground",
    /// Destructive actions and errors.
    destructive = "destructive",
    /// Borders and dividers.
    border = "border",
    /// The borders of inputs.
    input = "input",
    /// Focus rings.
    ring = "ring",
    /// A chart's first series.
    chart_1 = "chart-1",
    /// A chart's second series.
    chart_2 = "chart-2",
    /// A chart's third series.
    chart_3 = "chart-3",
    /// A chart's fourth series.
    chart_4 = "chart-4",
    /// A chart's fifth series.
    chart_5 = "chart-5",
    /// The sidebar.
    sidebar = "sidebar",
    /// Text on [`Theme::sidebar`].
    sidebar_foreground = "sidebar-foreground",
    /// The sidebar's main action.
    sidebar_primary = "sidebar-primary",
    /// Text on [`Theme::sidebar_primary`].
    sidebar_primary_foreground = "sidebar-primary-foreground",
    /// What is hovered or focused in the sidebar.
    sidebar_accent = "sidebar-accent",
    /// Text on [`Theme::sidebar_accent`].
    sidebar_accent_foreground = "sidebar-accent-foreground",
    /// The sidebar's borders.
    sidebar_border = "sidebar-border",
    /// Focus rings in the sidebar.
    sidebar_ring = "sidebar-ring",
}

impl Default for Theme {
    /// The default theme ([`DEFAULT_THEME`]).
    fn default() -> Self {
        DEFAULT.clone()
    }
}

impl Theme {
    /// The default theme with theme file `json` over it.
    pub fn from_json(json: &str) -> Result<Self, ThemeError> {
        let mut tokens = DEFAULT_TOKENS.clone();
        apply(&mut tokens, json)?;
        Ok(Self::of(Arc::new(tokens)))
    }

    /// The color named `name` (any the theme sets: shadcn's, the app's).
    pub fn color(&self, name: &str) -> Option<AdaptiveColor> {
        self.tokens.color(name)
    }

    /// The highlight of a selection, the one every component draws: the
    /// app's `selection` color if the theme sets one, else `primary` at
    /// 22 %.
    pub fn selection(&self) -> AdaptiveColor {
        self.color("selection")
            .unwrap_or_else(|| self.primary.opacity(0.22))
    }

    /// The number named `name` (any the theme sets).
    pub fn number(&self, name: &str) -> Option<f32> {
        self.tokens.number(name)
    }

    /// The font family named `name` (any the theme sets; its sans and mono
    /// ones are [`Theme::font_sans`] and [`Theme::font_mono`]).
    pub fn font(&self, name: &str) -> Option<Arc<str>> {
        self.tokens.font(name).cloned()
    }

    /// Sets the color named `name` (one of shadcn's sets its field).
    pub fn set_color(&mut self, name: &str, color: AdaptiveColor) {
        self.edit(|t| t.set_color(name, color));
    }

    /// Sets the number named `name` (`radius` sets its field).
    pub fn set_number(&mut self, name: &str, value: f32) {
        self.edit(|t| t.set_number(name, value));
    }

    /// Sets the font family named `name`.
    pub fn set_font(&mut self, name: &str, family: impl Into<Arc<str>>) {
        self.edit(|t| t.set_font(name, family));
    }

    /// Its design tokens.
    pub fn tokens(&self) -> &Tokens {
        &self.tokens
    }

    /// Its design tokens, for the core ([`nsh_core::element::Root::tokens`],
    /// an engine's host theme).
    pub fn into_tokens(self) -> Tokens {
        Arc::unwrap_or_clone(self.tokens)
    }

    /// Changes the tokens with `f`, and the fields with them.
    fn edit(&mut self, f: impl FnOnce(&mut Tokens)) {
        let mut tokens = std::mem::take(&mut self.tokens);
        f(Arc::make_mut(&mut tokens));
        *self = Self::of(tokens);
    }
}

impl From<Theme> for Tokens {
    fn from(theme: Theme) -> Self {
        theme.into_tokens()
    }
}

/// A CSS color.
fn color(value: &str) -> Option<Hsla> {
    Color::parse(value).map(Hsla::from)
}

/// A CSS length in points: `0.625rem`, `10px`, `10`.
fn length(value: &str) -> Option<f32> {
    let value = value.trim();
    let (number, scale) = if let Some(n) = value.strip_suffix("rem") {
        (n, REM)
    } else if let Some(n) = value.strip_suffix("px") {
        (n, 1.0)
    } else {
        (value, 1.0)
    };
    number
        .trim()
        .parse::<f32>()
        .ok()
        .filter(|n| n.is_finite())
        .map(|n| n * scale)
}

/// The family of a CSS `font-family` list that the platform draws with:
/// its first, unquoted (`None`: a generic family, the system's font).
fn font_family(value: &str) -> Option<&str> {
    let first = value.split(',').next()?.trim().trim_matches(['"', '\'']);
    let generic = matches!(
        first,
        "" | "sans-serif"
            | "serif"
            | "system-ui"
            | "ui-sans-serif"
            | "ui-serif"
            | "-apple-system"
            | "BlinkMacSystemFont"
    );
    (!generic).then_some(first)
}

/// The tokens theme file `json` sets, and only those: an embedding app's
/// overrides of the app's theme (the platforms' `AppView`s, the iOS and
/// Android SDKs), which win over the app's tokens of the same names and
/// leave its others as they are (`Core::set_host_tokens`). The file is the
/// one [`Theme::from_json`] reads, shadcn's `cssVars`; a color it names
/// (`var(--ring)`) and does not set is the default theme's.
pub fn theme_overrides(json: &str) -> Result<Tokens, ThemeError> {
    let mut tokens = Tokens::default();
    apply_onto(&mut tokens, &DEFAULT_TOKENS, json)?;
    Ok(tokens)
}

/// Applies theme file `json` (shadcn's `cssVars`) over `tokens`.
fn apply(tokens: &mut Tokens, json: &str) -> Result<(), ThemeError> {
    let base = tokens.clone();
    apply_onto(tokens, &base, json)
}

/// Sets the tokens of theme file `json` in `tokens`; a color it names and
/// does not set is `base`'s.
fn apply_onto(tokens: &mut Tokens, base: &Tokens, json: &str) -> Result<(), ThemeError> {
    let value: JsonValue =
        serde_json::from_str(json).map_err(|e| ThemeError(format!("not JSON: {e}")))?;
    if let Some(vars) = value.get("cssVars") {
        return apply_css_vars(tokens, base, vars);
    }
    Err(ThemeError(
        "expected shadcn's `{ \"cssVars\": { ... } }`".into(),
    ))
}

/// Applies shadcn's `cssVars`: `theme`'s values in both appearances,
/// `light`'s in the light one (and the dark one when `dark` leaves them
/// out), `dark`'s in the dark one. A color may name another
/// (`var(--ring)`, in `color-mix()` too) of the same appearance: the
/// file's or the one under it. Values of no kind a token has (shadows,
/// letter spacing) are left out, as they are of no Tailwind utility NSH
/// draws with a token.
fn apply_css_vars(tokens: &mut Tokens, base: &Tokens, vars: &JsonValue) -> Result<(), ThemeError> {
    let section = |name: &str| -> Result<FxHashMap<String, String>, ThemeError> {
        let Some(v) = vars.get(name) else {
            return Ok(FxHashMap::default());
        };
        let JsonValue::Object(fields) = v else {
            return Err(ThemeError(format!("cssVars.{name}: expected an object")));
        };
        let mut out = FxHashMap::default();
        for (key, value) in fields {
            match value {
                JsonValue::Null => {}
                JsonValue::String(s) => {
                    out.insert(key.clone(), s.clone());
                }
                JsonValue::Number(n) => {
                    out.insert(key.clone(), n.to_string());
                }
                v => {
                    return Err(ThemeError(format!(
                        "cssVars.{name}.{key}: expected a CSS value, got {v}"
                    )));
                }
            }
        }
        Ok(out)
    };
    let (both, light, dark) = (section("theme")?, section("light")?, section("dark")?);
    let mut light_vars = both.clone();
    light_vars.extend(light.iter().map(|(k, v)| (k.clone(), v.clone())));
    let mut dark_vars = light_vars.clone();
    dark_vars.extend(dark.iter().map(|(k, v)| (k.clone(), v.clone())));

    let mut names: Vec<&String> = light_vars.keys().chain(dark.keys()).collect();
    names.sort();
    names.dedup();
    for name in names {
        let value = dark_vars.get(name).or_else(|| light_vars.get(name));
        let Some(value) = value else { continue };
        if name.starts_with("font-") {
            if let Some(family) = font_family(value) {
                tokens.set_font(name, family);
            }
            continue;
        }
        let resolve = |vars: &FxHashMap<String, String>, dark: bool| {
            resolve_color(name, vars, base, dark, &mut FxHashSet::default())
        };
        match (resolve(&light_vars, false)?, resolve(&dark_vars, true)?) {
            (Some(l), Some(d)) => tokens.set_color(name, AdaptiveColor { light: l, dark: d }),
            (Some(c), None) | (None, Some(c)) => tokens.set_color(name, c.into()),
            (None, None) => {
                if let Some(n) = length(value) {
                    tokens.set_number(name, n);
                }
            }
        }
    }
    Ok(())
}

/// The color `name` is in `vars` (of one appearance), with the colors it
/// names (`var(--x)`, `var(--x, fallback)`) resolved: the file's, else
/// `base`'s. `None` when it is no color. A name that names itself is an
/// error.
fn resolve_color(
    name: &str,
    vars: &FxHashMap<String, String>,
    base: &Tokens,
    dark: bool,
    seen: &mut FxHashSet<String>,
) -> Result<Option<Hsla>, ThemeError> {
    let Some(value) = vars.get(name) else {
        return Ok(base
            .color(name)
            .map(|c| if dark { c.dark } else { c.light }));
    };
    if !seen.insert(name.to_owned()) {
        return Err(ThemeError(format!("`{name}` names itself")));
    }
    let mut out = String::with_capacity(value.len());
    let mut rest = value.as_str();
    while let Some(start) = rest.find("var(") {
        out.push_str(&rest[..start]);
        let inner = &rest[start + 4..];
        let mut depth = 1;
        let end = inner
            .char_indices()
            .find(|&(_, c)| {
                depth += match c {
                    '(' => 1,
                    ')' => -1,
                    _ => 0,
                };
                depth == 0
            })
            .map(|(i, _)| i)
            .ok_or_else(|| ThemeError(format!("`{name}`: unclosed var()")))?;
        let (var, fallback) = match inner[..end].split_once(',') {
            Some((v, f)) => (v.trim(), Some(f.trim())),
            None => (inner[..end].trim(), None),
        };
        let Some(var) = var.strip_prefix("--") else {
            return Err(ThemeError(format!(
                "`{name}`: var() names no `--` variable"
            )));
        };
        match resolve_color(var, vars, base, dark, seen)? {
            Some(c) => out.push_str(&format!("#{:08x}", Color::from(c).0)),
            None => match fallback {
                Some(f) => out.push_str(f),
                None => {
                    seen.remove(name);
                    return Ok(None);
                }
            },
        }
        rest = &inner[end + 1..];
    }
    out.push_str(rest);
    seen.remove(name);
    Ok(color(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(c: Hsla) -> u32 {
        Color::from(c).0 >> 8
    }

    /// shadcn's names, every one: the default theme has these and no
    /// other.
    const SHADCN: &[&str] = &[
        "background",
        "foreground",
        "card",
        "card-foreground",
        "popover",
        "popover-foreground",
        "primary",
        "primary-foreground",
        "secondary",
        "secondary-foreground",
        "muted",
        "muted-foreground",
        "accent",
        "accent-foreground",
        "destructive",
        "border",
        "input",
        "ring",
        "chart-1",
        "chart-2",
        "chart-3",
        "chart-4",
        "chart-5",
        "sidebar",
        "sidebar-foreground",
        "sidebar-primary",
        "sidebar-primary-foreground",
        "sidebar-accent",
        "sidebar-accent-foreground",
        "sidebar-border",
        "sidebar-ring",
    ];

    #[test]
    fn the_default_theme_is_shadcns_neutral() {
        let theme = Theme::default();
        let mut colors: Vec<&str> = theme.tokens().colors().map(|(k, _)| k).collect();
        colors.sort_unstable();
        let mut expected = SHADCN.to_vec();
        expected.sort_unstable();
        assert_eq!(colors, expected);
        let numbers: Vec<_> = theme.tokens().numbers().collect();
        assert_eq!(numbers, [("radius", 10.0)]);
        assert_eq!(theme.tokens().fonts().count(), 0);
        // oklch(0.205 0 0) / oklch(0.922 0 0).
        assert_eq!(hex(theme.primary.light), 0x171717);
        assert_eq!(hex(theme.primary.dark), 0xe5e5e5);
        assert_eq!(theme.radius, px(10.0));
        // oklch(1 0 0 / 10%).
        assert!((theme.border.dark.a - 0.1).abs() < 0.01);
        // Tokens without them read the defaults.
        assert_eq!(Theme::of(Arc::default()).ring, theme.ring);
        assert_eq!(theme.font_sans, None);
    }

    #[test]
    fn css_vars_go_over_the_default() {
        let theme = Theme::from_json(
            r##"{ "cssVars": {
                "theme": { "font-sans": "Inter, sans-serif", "font-mono": "'JetBrains Mono', monospace",
                           "radius-card": "14px", "shadow-sm": "0 1px 2px #0000" },
                "light": { "primary": "#7c3aed", "surface": "#ffffff", "up": "#138a5a",
                           "up-subtle": "color-mix(in srgb, var(--up) 50%, transparent)",
                           "sidebar-ring": "var(--primary)", "radius": "0.5rem" },
                "dark": { "surface": "#18191c" }
            } }"##,
        )
        .unwrap();
        assert_eq!(hex(theme.primary.light), 0x7c3aed);
        // Only light: both.
        assert_eq!(hex(theme.primary.dark), 0x7c3aed);
        let surface = theme.color("surface").unwrap();
        assert_eq!(
            (hex(surface.light), hex(surface.dark)),
            (0xffffff, 0x18191c)
        );
        assert_eq!(hex(theme.sidebar_ring.light), 0x7c3aed);
        assert_eq!(theme.radius, px(8.0));
        assert_eq!(theme.number("radius-card"), Some(14.0));
        assert_eq!(theme.font_sans.as_deref(), Some("Inter"));
        assert_eq!(theme.font_mono.as_deref(), Some("JetBrains Mono"));
        // Of no kind a token has.
        assert_eq!(theme.tokens().get("shadow-sm"), None);
        // Keys left out keep the default.
        assert_eq!(theme.muted, Theme::default().muted);
        assert!(
            Theme::from_json(r#"{ "cssVars": { "light": { "a": "var(--b)", "b": "var(--a)" } } }"#)
                .is_err()
        );
        assert!(Theme::from_json(r#"{ "colors": {} }"#).is_err());
    }

    #[test]
    fn a_var_falls_back() {
        let theme = Theme::from_json(
            r##"{ "cssVars": { "light": { "edge": "var(--nothing, #ff0000)", "line": "var(--border)" } } }"##,
        )
        .unwrap();
        assert_eq!(hex(theme.color("edge").unwrap().light), 0xff0000);
        // The default's, in each appearance.
        assert_eq!(theme.color("line").unwrap(), Theme::default().border);
    }

    #[test]
    fn overrides_are_the_tokens_the_file_sets() {
        let tokens = theme_overrides(
            r##"{ "cssVars": {
                "theme": { "radius": "0.75rem" },
                "light": { "primary": "#e11d48", "ring": "var(--primary)", "focus": "var(--border)" },
                "dark": { "primary": "#fb7185" }
            } }"##,
        )
        .unwrap();
        let primary = tokens.color("primary").unwrap();
        assert_eq!(
            (hex(primary.light), hex(primary.dark)),
            (0xe11d48, 0xfb7185)
        );
        // The file's own, per appearance.
        assert_eq!(tokens.color("ring").unwrap(), primary);
        // One it does not set: the default's.
        assert_eq!(tokens.color("focus").unwrap(), Theme::default().border);
        assert_eq!(tokens.number("radius"), Some(12.0));
        // Nothing else: the app's tokens stay.
        assert_eq!(tokens.colors().count(), 3);
        assert_eq!(tokens.color("background"), None);
        assert!(theme_overrides("{}").is_err());
        assert!(theme_overrides("not json").is_err());
    }
}

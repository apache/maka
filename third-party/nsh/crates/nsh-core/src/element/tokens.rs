//! Design tokens: colors with a light and a dark value, numbers and font
//! families, by name (`muted-foreground`, `radius`, `font-sans`). The core
//! gives no name a meaning but `font-sans`, the app's default font (as
//! Tailwind's `--font-sans` is a page's), and has none of its own: a UI set
//! brings them (`nsh-base`'s theme, through
//! [`super::Registry::tokens_from`]), an app sets its own, an embedding app
//! its own over those ([`crate::Core::set_host_tokens`]).
//!
//! A name is a CSS custom property's without its `--`: Tailwind classes name
//! every token as they name a theme variable (`bg-muted`, `bg-up/30`,
//! `rounded-(--radius)`, `font-(family-name:--font-mono)`;
//! `tailwind/theme.rs`), TS reads them with `nsh`'s `token()`, and Rust
//! components with [`super::ambient::tokens`].

use std::sync::Arc;

use rustc_hash::FxHashMap;

use super::style::AdaptiveColor;

/// The app's default font family's token: Tailwind's `--font-sans`.
pub const FONT_SANS: &str = "font-sans";

/// The monospaced font family's token: Tailwind's `--font-mono`.
pub const FONT_MONO: &str = "font-mono";

/// Design tokens by name: colors with a value per appearance, numbers and
/// font families. The default has none.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Tokens {
    colors: FxHashMap<Box<str>, AdaptiveColor>,
    numbers: FxHashMap<Box<str>, f32>,
    fonts: FxHashMap<Box<str>, Arc<str>>,
}

/// A token's value.
#[derive(Debug, Clone, PartialEq)]
pub enum Token {
    /// A color, per appearance.
    Color(AdaptiveColor),
    /// A number: a length in points, or a unitless quantity.
    Number(f32),
    /// A font family.
    Font(Arc<str>),
}

/// Makes the tokens of a theme file's content (`Some`), or the defaults
/// (`None`): how a UI set reads the app's theme ([`super::Registry::tokens_from`]).
pub type TokenSource = fn(Option<&str>) -> Result<Tokens, String>;

/// The tokens a surface is drawn with once the app's theme file reaches its
/// root ([`crate::Core::theme_tokens`]). The entry hands the theme to the
/// renderer in the turn of its first render, before the theme's op reaches
/// the core: JS reads the tokens from here meanwhile, so its first render
/// already has them (`token()` of `nsh`).
#[derive(Debug, Clone, Default)]
#[non_exhaustive]
pub struct ThemeTokens {
    /// How the UI sets read a theme file (`None`: none does).
    source: Option<TokenSource>,
    /// The embedding app's tokens, which win over the app's.
    host: Option<Arc<Tokens>>,
}

impl ThemeTokens {
    pub(crate) fn new(source: Option<TokenSource>, host: Option<Arc<Tokens>>) -> Self {
        Self { source, host }
    }

    /// The tokens drawn with when the app's theme file is `json`: its own
    /// under the embedding app's, as the core makes them. `None`: no UI set
    /// reads themes, or `json` is not one (the core reports it when the
    /// theme reaches it).
    pub fn of(&self, json: &str) -> Option<Tokens> {
        let app = (self.source?)(Some(json)).ok()?;
        Some(match &self.host {
            Some(host) => host.over(&app),
            None => app,
        })
    }
}

impl Tokens {
    /// The color named `name`.
    pub fn color(&self, name: &str) -> Option<AdaptiveColor> {
        self.colors.get(name).copied()
    }

    /// Sets the color named `name`.
    pub fn set_color(&mut self, name: &str, color: AdaptiveColor) {
        self.colors.insert(name.into(), color);
    }

    /// The number named `name`.
    pub fn number(&self, name: &str) -> Option<f32> {
        self.numbers.get(name).copied()
    }

    /// Sets the number named `name`.
    pub fn set_number(&mut self, name: &str, value: f32) {
        self.numbers.insert(name.into(), value);
    }

    /// The font family named `name` ([`FONT_SANS`], [`FONT_MONO`], ...).
    pub fn font(&self, name: &str) -> Option<&Arc<str>> {
        self.fonts.get(name)
    }

    /// Sets the font family named `name`.
    pub fn set_font(&mut self, name: &str, family: impl Into<Arc<str>>) {
        self.fonts.insert(name.into(), family.into());
    }

    /// The token named `name`, of any kind (a color first, as classes take
    /// it).
    pub fn get(&self, name: &str) -> Option<Token> {
        if let Some(c) = self.colors.get(name) {
            return Some(Token::Color(*c));
        }
        if let Some(n) = self.numbers.get(name) {
            return Some(Token::Number(*n));
        }
        self.fonts.get(name).cloned().map(Token::Font)
    }

    /// Whether it has no token.
    pub fn is_empty(&self) -> bool {
        self.colors.is_empty() && self.numbers.is_empty() && self.fonts.is_empty()
    }

    /// Each color by name.
    pub fn colors(&self) -> impl Iterator<Item = (&str, AdaptiveColor)> {
        self.colors.iter().map(|(k, c)| (&**k, *c))
    }

    /// Each number by name.
    pub fn numbers(&self) -> impl Iterator<Item = (&str, f32)> {
        self.numbers.iter().map(|(k, n)| (&**k, *n))
    }

    /// Each font family by name.
    pub fn fonts(&self) -> impl Iterator<Item = (&str, &Arc<str>)> {
        self.fonts.iter().map(|(k, f)| (&**k, f))
    }

    /// `self` with the tokens of `base` it does not have.
    pub fn over(&self, base: &Tokens) -> Tokens {
        let mut out = base.clone();
        out.colors
            .extend(self.colors.iter().map(|(k, c)| (k.clone(), *c)));
        out.numbers
            .extend(self.numbers.iter().map(|(k, n)| (k.clone(), *n)));
        out.fonts
            .extend(self.fonts.iter().map(|(k, f)| (k.clone(), f.clone())));
        out
    }
}

/// Tokens as apps have them (`nsh-base`'s default theme's and a few of an
/// app's own), for the core's tests.
#[cfg(test)]
pub(crate) fn sample() -> Tokens {
    let mut tokens = Tokens::default();
    for (key, light, dark) in [
        ("background", 0xffffff, 0x0a0a0a),
        ("foreground", 0x0a0a0a, 0xfafafa),
        ("border", 0xe5e5e5, 0x262626),
        ("ring", 0xa3a3a3, 0x525252),
        ("muted", 0xf5f5f5, 0x262626),
        ("muted-foreground", 0x737373, 0xa3a3a3),
        ("accent", 0xf5f5f5, 0x262626),
        ("primary", 0x171717, 0xfafafa),
        ("primary-active", 0x0a0a0a, 0xe5e5e5),
        ("primary-foreground", 0xfafafa, 0x171717),
        ("popover", 0xffffff, 0x0a0a0a),
        ("popover-foreground", 0x0a0a0a, 0xfafafa),
    ] {
        tokens.set_color(key, AdaptiveColor::rgb(light, dark));
    }
    for (key, n) in [("radius", 12.0), ("radius-lg", 16.0), ("font-size", 16.0)] {
        tokens.set_number(key, n);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color::rgb;

    #[test]
    fn tokens_over_others_win_and_keep_the_rest() {
        let mut base = Tokens::default();
        base.set_color("primary", rgb(0x111111).into());
        base.set_color("ring", rgb(0x222222).into());
        base.set_number("radius", 12.0);
        base.set_font(FONT_SANS, "Inter");
        let mut top = Tokens::default();
        top.set_color("primary", rgb(0x333333).into());
        top.set_number("radius-card", 10.0);
        top.set_font(FONT_MONO, "Iosevka");
        let tokens = top.over(&base);
        assert_eq!(tokens.color("primary"), Some(rgb(0x333333).into()));
        assert_eq!(tokens.color("ring"), Some(rgb(0x222222).into()));
        assert_eq!(tokens.number("radius"), Some(12.0));
        assert_eq!(tokens.number("radius-card"), Some(10.0));
        assert_eq!(tokens.font(FONT_SANS).map(|f| &**f), Some("Inter"));
        assert_eq!(tokens.font(FONT_MONO).map(|f| &**f), Some("Iosevka"));
        assert!(Tokens::default().is_empty());
    }
}

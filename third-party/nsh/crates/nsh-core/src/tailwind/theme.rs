//! The design tokens classes resolve against: Tailwind CSS v4.1's default
//! theme (`theme.css`) in points (1rem = 16pt), extended by the app's
//! `nsh.json` (`"tailwind": { ... }`), and the app's design tokens
//! ([`ClassTokens`]).

use std::{
    fmt::Write,
    sync::{Arc, LazyLock},
};

use rustc_hash::FxHashMap;

use crate::{
    css,
    effects::BoxShadow,
    element::AdaptiveColor,
    style::{Color, TextShadow},
};

/// Tailwind's design tokens.
#[derive(Debug, Clone)]
pub struct Theme {
    /// Points per spacing step (`p-1`).
    pub(crate) spacing: f32,
    /// Points per `rem` (arbitrary values in `rem`).
    pub(crate) rem: f32,
    /// Flat color names: `red-500`, `black`, `brand`.
    pub(crate) colors: FxHashMap<Box<str>, Color>,
    /// Breakpoints (`sm:`), ascending.
    /// Name, width, and whether Tailwind's is in `rem` (the default
    /// theme's, which Tailwind orders after `px` ones).
    pub(crate) breakpoints: Vec<(Box<str>, f32, bool)>,
    /// `max-w-sm` and friends.
    pub(crate) containers: FxHashMap<Box<str>, f32>,
    /// `text-lg`: size and line height (a multiple of the size).
    pub(crate) text: FxHashMap<Box<str>, (f32, Option<f32>)>,
    /// `font-bold`.
    pub(crate) weights: FxHashMap<Box<str>, u16>,
    /// `font-sans`: the family (`None` is the system font).
    pub(crate) fonts: FxHashMap<Box<str>, Option<Box<str>>>,
    /// `tracking-wide`, in ems.
    pub(crate) tracking: FxHashMap<Box<str>, f32>,
    /// `leading-snug`, multiples of the font size.
    pub(crate) leading: FxHashMap<Box<str>, f32>,
    /// `rounded-lg`.
    pub(crate) radius: FxHashMap<Box<str>, f32>,
    /// `shadow-md`.
    pub(crate) shadows: FxHashMap<Box<str>, Vec<BoxShadow>>,
    /// `inset-shadow-sm`.
    pub(crate) inset_shadows: FxHashMap<Box<str>, Vec<BoxShadow>>,
    /// `drop-shadow-md` (offset x, y, blur, color per layer).
    pub(crate) drop_shadows: FxHashMap<Box<str>, Vec<BoxShadow>>,
    /// `text-shadow-md`.
    pub(crate) text_shadows: FxHashMap<Box<str>, Vec<TextShadow>>,
    /// `blur-md`.
    pub(crate) blur: FxHashMap<Box<str>, f32>,
    /// `perspective-near`.
    pub(crate) perspective: FxHashMap<Box<str>, f32>,
    /// `aspect-video`.
    pub(crate) aspect: FxHashMap<Box<str>, f32>,
    /// `ease-out`.
    pub(crate) ease: FxHashMap<Box<str>, [f32; 4]>,
    /// Default transition duration (ms) and curve.
    pub(crate) transition: (f32, [f32; 4]),
    /// The design tokens classes name (`None`: none).
    tokens: Option<Arc<ClassTokens>>,
}

/// The design tokens (`crate::element::Tokens`) by the names classes give them,
/// their names: as Tailwind's theme variables, colors are names of the
/// color utilities (`bg-primary`, `text-muted-foreground/70`) when the
/// Tailwind theme has no color of that name, and every token is a
/// variable (`bg-(--primary)`, `rounded-(--radius-lg)`,
/// `text-(length:--font-size)`, `font-(family-name:--font-mono)`). The
/// fonts `font-sans` and `font-mono` are what `font-sans` and `font-mono`
/// set, as `--font-sans` and `--font-mono` are in Tailwind.
///
/// Classes naming them are parsed with each appearance's values (one rule
/// per appearance when they differ), so applying them costs what a palette
/// color does; when the tokens change, only they are parsed again
/// ([`super::deps::THEME`]).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct ClassTokens {
    colors: FxHashMap<Box<str>, AdaptiveColor>,
    numbers: FxHashMap<Box<str>, f32>,
    fonts: FxHashMap<Box<str>, Arc<str>>,
}

static DEFAULT_TOKENS: LazyLock<Arc<ClassTokens>> =
    LazyLock::new(|| Arc::new(ClassTokens::new(&crate::element::Tokens::default())));

impl ClassTokens {
    /// The names classes give `theme`'s tokens.
    pub(crate) fn new(theme: &crate::element::Tokens) -> Self {
        ClassTokens {
            colors: theme.colors().map(|(k, c)| (k.into(), c)).collect(),
            numbers: theme.numbers().map(|(k, n)| (k.into(), n)).collect(),
            fonts: theme.fonts().map(|(k, f)| (k.into(), f.clone())).collect(),
        }
    }

    /// The names of the colors, the numbers and the fonts.
    pub(crate) fn names(&self) -> impl Iterator<Item = &str> {
        self.colors
            .keys()
            .chain(self.numbers.keys())
            .chain(self.fonts.keys())
            .map(|n| &**n)
    }

    /// Whether `self` and `other` have the same names (only their values
    /// may differ).
    pub(crate) fn same_names(&self, other: &ClassTokens) -> bool {
        self.colors.len() == other.colors.len()
            && self.numbers.len() == other.numbers.len()
            && self.fonts.len() == other.fonts.len()
            && self.colors.keys().all(|k| other.colors.contains_key(k))
            && self.numbers.keys().all(|k| other.numbers.contains_key(k))
            && self.fonts.keys().all(|k| other.fonts.contains_key(k))
    }

    /// Whether `utility` is one of Tailwind's that a token replaces:
    /// `font-sans` and `font-mono` when the theme has those fonts.
    pub(crate) fn replaces(&self, utility: &str) -> bool {
        self.fonts.contains_key(utility)
    }

    /// `utility` with its tokens replaced by their values in the light or
    /// dark appearance, as arbitrary values: `bg-primary/50` is
    /// `bg-[color:#171717ff]/50`, `rounded-(--radius)` is `rounded-[12px]`.
    /// `None` when it names none, or one there is not.
    pub(crate) fn substitute(&self, utility: &str, dark: bool) -> Option<String> {
        let hex = |out: &mut String, c: &AdaptiveColor| {
            let c = if dark { c.dark } else { c.light };
            let _ = write!(out, "#{:08x}", Color::from(c).0);
        };
        if let Some(family) = self.fonts.get(utility) {
            return Some(format!("font-[family-name:{}]", family.replace(' ', "_")));
        }
        if utility.contains('(') {
            // `(--name)` and `(hint:--name)`, Tailwind 4's shorthand of
            // `[var(--name)]`.
            let mut out = String::with_capacity(utility.len() + 8);
            let mut rest = utility;
            while let Some(open) = rest.find('(') {
                out.push_str(&rest[..open]);
                let close = open + rest[open..].find(')')?;
                let inner = &rest[open + 1..close];
                let (hint, var) = match inner.split_once(':') {
                    Some((h, v)) => (Some(h), v),
                    None => (None, inner),
                };
                let name = var.strip_prefix("--")?;
                out.push('[');
                if let Some(h) = hint {
                    out.push_str(h);
                    out.push(':');
                }
                let color = self
                    .colors
                    .get(name)
                    .filter(|_| hint.is_none_or(|h| h == "color"));
                let font = self.fonts.get(name).filter(|_| hint == Some("family-name"));
                match (color, self.numbers.get(name)) {
                    (Some(c), _) => hex(&mut out, c),
                    (None, _) if let Some(f) = font => out.push_str(&f.replace(' ', "_")),
                    (None, Some(n)) if hint == Some("number") => {
                        let _ = write!(out, "{n}");
                    }
                    (None, Some(n)) => {
                        let _ = write!(out, "{n}px");
                    }
                    (None, None) => return None,
                }
                out.push(']');
                rest = &rest[close + 1..];
            }
            out.push_str(rest);
            return Some(out);
        }
        // A color name after a utility's prefix (`border-t-` `muted`), with
        // an optional opacity modifier.
        let (start, name) = utility.match_indices('-').find_map(|(i, _)| {
            let rest = &utility[i + 1..];
            let name = rest.split_once('/').map_or(rest, |(n, _)| n);
            (i > 0 && self.colors.contains_key(name)).then_some((i, name))
        })?;
        let mut out = String::with_capacity(utility.len() + 16);
        out.push_str(&utility[..=start]);
        out.push_str("[color:");
        hex(&mut out, &self.colors[name]);
        out.push(']');
        out.push_str(&utility[start + 1 + name.len()..]);
        Some(out)
    }
}

fn map<V>(entries: &[(&str, V)]) -> FxHashMap<Box<str>, V>
where
    V: Clone,
{
    entries
        .iter()
        .map(|(k, v)| ((*k).into(), v.clone()))
        .collect()
}

fn shadows(s: &str) -> Vec<BoxShadow> {
    css::box_shadows(s).unwrap_or_default()
}

impl Default for Theme {
    fn default() -> Self {
        let rem = css::REM;
        let mut colors: FxHashMap<Box<str>, Color> = FxHashMap::default();
        for (name, shades) in super::palette::PALETTE.iter() {
            for (shade, rgba) in super::palette::SHADES.iter().zip(shades) {
                colors.insert(format!("{name}-{shade}").into(), Color(*rgba));
            }
        }
        colors.insert("black".into(), Color(0x0000_00ff));
        colors.insert("white".into(), Color(0xffff_ffff));
        colors.insert("transparent".into(), Color::TRANSPARENT);
        let text_shadow = |s: &str| -> Vec<TextShadow> {
            shadows(s)
                .into_iter()
                .map(|l| TextShadow {
                    color: l.color,
                    offset_x: l.offset_x,
                    offset_y: l.offset_y,
                    radius: l.blur,
                })
                .collect()
        };
        Theme {
            spacing: 0.25 * rem,
            rem,
            colors,
            breakpoints: vec![
                ("sm".into(), 40.0 * rem, true),
                ("md".into(), 48.0 * rem, true),
                ("lg".into(), 64.0 * rem, true),
                ("xl".into(), 80.0 * rem, true),
                ("2xl".into(), 96.0 * rem, true),
            ],
            containers: map(&[
                ("3xs", 16.0 * rem),
                ("2xs", 18.0 * rem),
                ("xs", 20.0 * rem),
                ("sm", 24.0 * rem),
                ("md", 28.0 * rem),
                ("lg", 32.0 * rem),
                ("xl", 36.0 * rem),
                ("2xl", 42.0 * rem),
                ("3xl", 48.0 * rem),
                ("4xl", 56.0 * rem),
                ("5xl", 64.0 * rem),
                ("6xl", 72.0 * rem),
                ("7xl", 80.0 * rem),
            ]),
            text: map(&[
                ("xs", (0.75 * rem, Some(1.0 / 0.75))),
                ("sm", (0.875 * rem, Some(1.25 / 0.875))),
                ("base", (rem, Some(1.5))),
                ("lg", (1.125 * rem, Some(1.75 / 1.125))),
                ("xl", (1.25 * rem, Some(1.75 / 1.25))),
                ("2xl", (1.5 * rem, Some(2.0 / 1.5))),
                ("3xl", (1.875 * rem, Some(2.25 / 1.875))),
                ("4xl", (2.25 * rem, Some(2.5 / 2.25))),
                ("5xl", (3.0 * rem, Some(1.0))),
                ("6xl", (3.75 * rem, Some(1.0))),
                ("7xl", (4.5 * rem, Some(1.0))),
                ("8xl", (6.0 * rem, Some(1.0))),
                ("9xl", (8.0 * rem, Some(1.0))),
            ]),
            weights: map(&[
                ("thin", 100),
                ("extralight", 200),
                ("light", 300),
                ("normal", 400),
                ("medium", 500),
                ("semibold", 600),
                ("bold", 700),
                ("extrabold", 800),
                ("black", 900),
            ]),
            fonts: map(&[
                ("sans", None),
                ("serif", Some("serif".into())),
                ("mono", Some("monospace".into())),
            ]),
            tracking: map(&[
                ("tighter", -0.05),
                ("tight", -0.025),
                ("normal", 0.0),
                ("wide", 0.025),
                ("wider", 0.05),
                ("widest", 0.1),
            ]),
            leading: map(&[
                ("none", 1.0),
                ("tight", 1.25),
                ("snug", 1.375),
                ("normal", 1.5),
                ("relaxed", 1.625),
                ("loose", 2.0),
            ]),
            radius: map(&[
                ("xs", 0.125 * rem),
                ("sm", 0.25 * rem),
                ("md", 0.375 * rem),
                ("lg", 0.5 * rem),
                ("xl", 0.75 * rem),
                ("2xl", rem),
                ("3xl", 1.5 * rem),
                ("4xl", 2.0 * rem),
            ]),
            shadows: map(&[
                ("2xs", shadows("0 1px rgb(0 0 0 / 0.05)")),
                ("xs", shadows("0 1px 2px 0 rgb(0 0 0 / 0.05)")),
                (
                    "sm",
                    shadows("0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"),
                ),
                (
                    "md",
                    shadows("0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)"),
                ),
                (
                    "lg",
                    shadows("0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)"),
                ),
                (
                    "xl",
                    shadows("0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)"),
                ),
                ("2xl", shadows("0 25px 50px -12px rgb(0 0 0 / 0.25)")),
                // `shadow` without a size (deprecated in v4, still common).
                (
                    "",
                    shadows("0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)"),
                ),
            ]),
            inset_shadows: map(&[
                ("2xs", shadows("inset 0 1px rgb(0 0 0 / 0.05)")),
                ("xs", shadows("inset 0 1px 1px rgb(0 0 0 / 0.05)")),
                ("sm", shadows("inset 0 2px 4px rgb(0 0 0 / 0.05)")),
            ]),
            drop_shadows: map(&[
                ("xs", shadows("0 1px 1px rgb(0 0 0 / 0.05)")),
                ("sm", shadows("0 1px 2px rgb(0 0 0 / 0.15)")),
                ("md", shadows("0 3px 3px rgb(0 0 0 / 0.12)")),
                ("lg", shadows("0 4px 4px rgb(0 0 0 / 0.15)")),
                ("xl", shadows("0 9px 7px rgb(0 0 0 / 0.1)")),
                ("2xl", shadows("0 25px 25px rgb(0 0 0 / 0.15)")),
                (
                    "",
                    shadows("0 1px 2px rgb(0 0 0 / 0.1), 0 1px 1px rgb(0 0 0 / 0.06)"),
                ),
            ]),
            text_shadows: map(&[
                ("2xs", text_shadow("0px 1px 0px rgb(0 0 0 / 0.15)")),
                ("xs", text_shadow("0px 1px 1px rgb(0 0 0 / 0.2)")),
                (
                    "sm",
                    text_shadow(
                        "0px 1px 0px rgb(0 0 0 / 0.075), 0px 1px 1px rgb(0 0 0 / 0.075), 0px 2px 2px rgb(0 0 0 / 0.075)",
                    ),
                ),
                (
                    "md",
                    text_shadow(
                        "0px 1px 1px rgb(0 0 0 / 0.1), 0px 1px 2px rgb(0 0 0 / 0.1), 0px 2px 4px rgb(0 0 0 / 0.1)",
                    ),
                ),
                (
                    "lg",
                    text_shadow(
                        "0px 1px 2px rgb(0 0 0 / 0.1), 0px 3px 2px rgb(0 0 0 / 0.1), 0px 4px 8px rgb(0 0 0 / 0.1)",
                    ),
                ),
            ]),
            blur: map(&[
                ("xs", 4.0),
                ("sm", 8.0),
                ("md", 12.0),
                ("lg", 16.0),
                ("xl", 24.0),
                ("2xl", 40.0),
                ("3xl", 64.0),
                ("", 8.0),
            ]),
            perspective: map(&[
                ("dramatic", 100.0),
                ("near", 300.0),
                ("normal", 500.0),
                ("midrange", 800.0),
                ("distant", 1200.0),
            ]),
            aspect: map(&[("square", 1.0), ("video", 16.0 / 9.0)]),
            ease: map(&[
                ("linear", [0.0, 0.0, 1.0, 1.0]),
                ("in", [0.4, 0.0, 1.0, 1.0]),
                ("out", [0.0, 0.0, 0.2, 1.0]),
                ("in-out", [0.4, 0.0, 0.2, 1.0]),
            ]),
            transition: (150.0, [0.4, 0.0, 0.2, 1.0]),
            tokens: None,
        }
    }
}

/// Why a theme configuration was rejected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThemeError(pub String);

impl std::fmt::Display for ThemeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ThemeError {}

impl Theme {
    /// The default theme extended by `config`, the `"tailwind"` object of
    /// `nsh.json` (JSON). Entries with an existing name replace the default:
    ///
    /// ```json
    /// {
    ///   "colors": { "brand": { "500": "#7c3aed" }, "accent": "#f59e0b" },
    ///   "spacing": 4,
    ///   "breakpoints": { "tablet": 600 },
    ///   "fontFamily": { "display": "Inter" },
    ///   "fontSize": { "huge": [48, 1.1] },
    ///   "fontWeight": { "heavy": 850 },
    ///   "radius": { "card": 14 },
    ///   "shadow": { "card": "0 2px 8px rgb(0 0 0 / 0.12)" },
    ///   "tracking": { "label": 0.08 },
    ///   "leading": { "dense": 1.15 },
    ///   "blur": { "glass": 20 },
    ///   "aspect": { "photo": 1.5 },
    ///   "ease": { "snappy": [0.2, 0, 0, 1] },
    ///   "container": { "content": 680 }
    /// }
    /// ```
    ///
    /// Lengths are points.
    pub fn from_json(config: &str) -> Result<Theme, ThemeError> {
        let value: serde_json::Value =
            serde_json::from_str(config).map_err(|e| ThemeError(e.to_string()))?;
        let mut theme = Theme::default();
        theme.extend(&value)?;
        Ok(theme)
    }

    fn extend(&mut self, value: &serde_json::Value) -> Result<(), ThemeError> {
        use serde_json::Value;
        let Value::Object(root) = value else {
            return Err(ThemeError("`tailwind` must be an object".into()));
        };
        let num = |v: &Value, what: &str| -> Result<f32, ThemeError> {
            v.as_f64()
                .map(|n| n as f32)
                .ok_or_else(|| ThemeError(format!("{what} must be a number")))
        };
        let color = |v: &Value, what: &str| -> Result<Color, ThemeError> {
            v.as_str()
                .and_then(css::color)
                .ok_or_else(|| ThemeError(format!("{what} must be a CSS color")))
        };
        let entries = |v: &Value, what: &str| -> Result<Vec<(String, Value)>, ThemeError> {
            match v {
                Value::Object(o) => Ok(o.iter().map(|(k, v)| (k.clone(), v.clone())).collect()),
                _ => Err(ThemeError(format!("`{what}` must be an object"))),
            }
        };
        for (key, v) in root {
            match key.as_str() {
                "spacing" => self.spacing = num(v, "`spacing`")?,
                "rem" => self.rem = num(v, "`rem`")?,
                "colors" => {
                    for (name, c) in entries(v, "colors")? {
                        match &c {
                            Value::Object(shades) => {
                                for (shade, c) in shades {
                                    let what = format!("color `{name}-{shade}`");
                                    let key = if shade == "DEFAULT" {
                                        name.clone()
                                    } else {
                                        format!("{name}-{shade}")
                                    };
                                    self.colors.insert(key.into(), color(c, &what)?);
                                }
                            }
                            c => {
                                let parsed = color(c, &format!("color `{name}`"))?;
                                self.colors.insert(name.into(), parsed);
                            }
                        }
                    }
                }
                "breakpoints" => {
                    for (name, w) in entries(v, "breakpoints")? {
                        let w = num(&w, &format!("breakpoint `{name}`"))?;
                        self.breakpoints.retain(|(n, ..)| **n != *name);
                        self.breakpoints.push((name.into(), w, false));
                    }
                    self.breakpoints.sort_by(|a, b| a.1.total_cmp(&b.1));
                }
                "container" => {
                    for (name, w) in entries(v, "container")? {
                        let w = num(&w, &format!("container `{name}`"))?;
                        self.containers.insert(name.into(), w);
                    }
                }
                "fontSize" => {
                    for (name, size) in entries(v, "fontSize")? {
                        let what = format!("font size `{name}`");
                        let entry = match &size {
                            Value::Array(a) if a.len() == 2 => {
                                (num(&a[0], &what)?, Some(num(&a[1], &what)?))
                            }
                            v => (num(v, &what)?, None),
                        };
                        self.text.insert(name.into(), entry);
                    }
                }
                "fontWeight" => {
                    for (name, w) in entries(v, "fontWeight")? {
                        let w = num(&w, &format!("font weight `{name}`"))?;
                        self.weights
                            .insert(name.into(), w.clamp(1.0, 1000.0) as u16);
                    }
                }
                "fontFamily" => {
                    for (name, f) in entries(v, "fontFamily")? {
                        let family = f.as_str().ok_or_else(|| {
                            ThemeError(format!("font family `{name}` must be a string"))
                        })?;
                        self.fonts.insert(name.into(), Some(family.into()));
                    }
                }
                "tracking" => {
                    for (name, em) in entries(v, "tracking")? {
                        self.tracking.insert(
                            name.clone().into(),
                            num(&em, &format!("tracking `{name}`"))?,
                        );
                    }
                }
                "leading" => {
                    for (name, m) in entries(v, "leading")? {
                        self.leading
                            .insert(name.clone().into(), num(&m, &format!("leading `{name}`"))?);
                    }
                }
                "radius" => {
                    for (name, r) in entries(v, "radius")? {
                        self.radius
                            .insert(name.clone().into(), num(&r, &format!("radius `{name}`"))?);
                    }
                }
                "shadow" | "insetShadow" | "dropShadow" => {
                    for (name, s) in entries(v, key)? {
                        let list = s.as_str().and_then(css::box_shadows).ok_or_else(|| {
                            ThemeError(format!("{key} `{name}` must be a CSS box-shadow"))
                        })?;
                        let target = match key.as_str() {
                            "shadow" => &mut self.shadows,
                            "insetShadow" => &mut self.inset_shadows,
                            _ => &mut self.drop_shadows,
                        };
                        target.insert(name.into(), list);
                    }
                }
                "blur" => {
                    for (name, b) in entries(v, "blur")? {
                        self.blur
                            .insert(name.clone().into(), num(&b, &format!("blur `{name}`"))?);
                    }
                }
                "perspective" => {
                    for (name, p) in entries(v, "perspective")? {
                        self.perspective.insert(
                            name.clone().into(),
                            num(&p, &format!("perspective `{name}`"))?,
                        );
                    }
                }
                "aspect" => {
                    for (name, a) in entries(v, "aspect")? {
                        self.aspect
                            .insert(name.clone().into(), num(&a, &format!("aspect `{name}`"))?);
                    }
                }
                "ease" => {
                    for (name, e) in entries(v, "ease")? {
                        let what = format!("ease `{name}` must be [x1, y1, x2, y2]");
                        let Value::Array(a) = &e else {
                            return Err(ThemeError(what));
                        };
                        let n: Vec<f32> = a
                            .iter()
                            .filter_map(|x| x.as_f64().map(|x| x as f32))
                            .collect();
                        let [x1, y1, x2, y2] = n.as_slice() else {
                            return Err(ThemeError(what));
                        };
                        self.ease.insert(name.into(), [*x1, *y1, *x2, *y2]);
                    }
                }
                other => return Err(ThemeError(format!("unknown theme key `{other}`"))),
            }
        }
        Ok(())
    }

    /// A color by name (`red-500`, `brand`).
    pub fn color(&self, name: &str) -> Option<Color> {
        self.colors.get(name).copied()
    }

    /// The names of every scale's entries (`red-500`, `lg`, `video`,
    /// `snappy`, ...), sorted and without repeats: what utilities and
    /// breakpoint variants take by name. Tools enumerate the classes a
    /// theme offers with them (the engine's record of Tailwind classes).
    pub fn names(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.breakpoints.iter().map(|(n, ..)| &**n).collect();
        let keys = [
            self.colors.keys().collect::<Vec<_>>(),
            self.containers.keys().collect(),
            self.text.keys().collect(),
            self.weights.keys().collect(),
            self.fonts.keys().collect(),
            self.tracking.keys().collect(),
            self.leading.keys().collect(),
            self.radius.keys().collect(),
            self.shadows.keys().collect(),
            self.inset_shadows.keys().collect(),
            self.drop_shadows.keys().collect(),
            self.text_shadows.keys().collect(),
            self.blur.keys().collect(),
            self.perspective.keys().collect(),
            self.aspect.keys().collect(),
            self.ease.keys().collect(),
        ];
        names.extend(keys.into_iter().flatten().map(|n| &**n));
        names.sort_unstable();
        names.dedup();
        names
    }

    /// The names of the component theme's tokens (`primary`,
    /// `muted-foreground`, `radius`), sorted: what `bg-primary` and
    /// `rounded-(--radius)` name.
    pub fn token_names(&self) -> Vec<&str> {
        let tokens = self.tokens();
        let mut names: Vec<&str> = tokens.names().collect();
        names.sort_unstable();
        names.dedup();
        names
    }

    /// The design tokens classes name.
    pub(crate) fn tokens(&self) -> &ClassTokens {
        self.tokens.as_deref().unwrap_or(&DEFAULT_TOKENS)
    }

    /// Takes design tokens `theme`, which classes such as `bg-primary`
    /// name. Without them classes name none.
    pub fn set_tokens(&mut self, theme: &crate::element::Tokens) {
        self.tokens = Some(Arc::new(ClassTokens::new(theme)));
    }

    /// The tokens of another theme.
    pub(crate) fn share_tokens(&mut self, from: &Theme) {
        self.tokens = from.tokens.clone();
    }

    /// Replaces the tokens.
    pub(crate) fn replace_tokens(&mut self, tokens: Arc<ClassTokens>) {
        self.tokens = Some(tokens);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_extension() {
        let t = Theme::default();
        assert_eq!(t.color("blue-500"), Some(Color(0x2b7f_ffff)));
        assert_eq!(t.text["sm"], (14.0, Some(1.25 / 0.875)));
        assert_eq!(t.shadows["md"].len(), 2);
        let t = Theme::from_json(
            r##"{ "colors": { "brand": { "500": "#7c3aed", "DEFAULT": "#000" }, "accent": "oklch(70% 0.2 50)" },
                 "breakpoints": { "tablet": 600 }, "spacing": 8 }"##,
        )
        .unwrap();
        assert_eq!(t.color("brand-500"), Some(Color(0x7c3a_edff)));
        assert_eq!(t.color("brand"), Some(Color(0x0000_00ff)));
        assert!(t.color("accent").is_some());
        assert_eq!(t.spacing, 8.0);
        assert_eq!(t.breakpoints[0].0.as_ref(), "tablet");
        assert!(Theme::from_json(r#"{ "colours": {} }"#).is_err());
        assert!(Theme::from_json(r#"{ "colors": { "x": "nope" } }"#).is_err());
    }
}

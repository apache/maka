//! Text: GPUI's text system shapes on the engine thread, nsh breaks and
//! places the lines, the main thread paints the glyphs.
//!
//! GPUI shapes one line of one font size at a time
//! ([`gpui::WindowTextSystem::layout_line`]), and leaves breaking,
//! bidi, line heights and ellipses to its callers. So [`GpuiTextEngine`]
//! shapes each paragraph once, in `prepare`, as segments of one bidi level
//! and one font size (the spans of a segment are runs of one call, so
//! kerning and ligatures go on across them), and keeps the result as
//! clusters in text order: each one's bytes, advance (letter spacing
//! added), glyphs relative to its left edge, span and bidi level. Measuring
//! at any width only walks the clusters' advances ([`Prepared::break_lines`],
//! greedy, at the UAX #14 opportunities `unicode-linebreak` finds), never
//! shapes again; the final layout places the clusters of each line in
//! visual order (`unicode-bidi`'s levels, reordered by rule L2), so what was
//! measured is what is drawn.
//!
//! Line heights follow Pango's (and so the Linux and Windows backends')
//! model: each span is as tall as its own font's ascent and descent (a
//! fallback font for CJK or emoji does not grow the line), an explicit
//! `lineHeight` spreads evenly above and below it, and an attachment sits
//! where its `verticalAlign` puts it in its placeholder's font (on the
//! baseline by default), the line holding it.
//!
//! The final layout ([`GpuiLayout`]) is plain data: per line its metrics,
//! its clusters' boxes (hit testing, selections, decorations) and glyphs
//! (font, id, size, position). Colors and decorations are not part of it:
//! the core reuses a layout for text that only differs in them
//! (`AttributedText::layout_eq`), so [`draw`] reads them from the drawn
//! text's spans.
//!
//! Selectable text follows desktop conventions, as on Windows and Linux
//! ([`Selection`]).

use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    ops::Range,
    rc::Rc,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

use gpui::{
    Font, FontFeatures, FontId, FontStyle, FontWeight, GlyphId, LineLayout, SharedString, TextRun,
    TextSystem, WindowTextSystem, px,
};
use nsh_core::{
    ATTACHMENT_CHAR, Affinity, AttributedText, Bounds, Color, DecorationStyle, EllipsizeMode,
    EventKind, FontFamily, Point, Points, ResolvedTextStyle, Size, TextAlign, TextEngine,
    TextLayout, TextLine, TextPosition, TextSpan,
    geometry::{point, size},
};
use rustc_hash::FxHashMap;
use unicode_bidi::{Level, ParagraphBidiInfo};

use crate::{
    render::DrawCx,
    view::{NshView, ViewState},
};

/// What GPUI calls the platform's UI font.
const SYSTEM_UI: &str = ".SystemUIFont";

/// Cap height and x height (ems) of fonts whose tables do not say.
const CAP_HEIGHT: f32 = 0.7;
const X_HEIGHT: f32 = 0.5;

/// How much wider than its box a line may be measured and still fit:
/// sums of advances in another order differ in the last bits.
const EPSILON: f32 = 0.01;

/// How many lines the shaper's cache may hold before it is made anew:
/// GPUI's line cache keeps every line until its frame is finished, which
/// only a window does.
const CACHE_LINES: u32 = 4096;

// --- Fonts ------------------------------------------------------------------------------

/// The family of the UI font: the one [`ui_family_for`] resolved (a
/// surface does when it starts), else GPUI's name for the system's.
pub(crate) fn ui_family() -> Arc<str> {
    UI_FAMILY
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .map_or_else(|| Arc::from(SYSTEM_UI), |(_, f)| f.clone())
}

/// Prepares this thread for GPUI's text system: on Windows, COM, which
/// GPUI initializes on the main thread only; DirectWrite's font selection
/// fails without it on other threads (the engine's, canvas workers'), and
/// every font then resolves to the fallback face (bold and registered fonts
/// included). Elsewhere, nothing.
pub(crate) fn init_thread() {
    #[cfg(windows)]
    {
        thread_local! {
            static DONE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
        }
        if !DONE.replace(true) {
            use windows_sys::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx};
            // SAFETY: a plain call with no pointers; a thread already in an
            // apartment of another kind keeps it (RPC_E_CHANGED_MODE), which
            // DirectWrite works with too. Never uninitialized: the thread
            // uses the text system until it ends.
            unsafe { CoInitializeEx(std::ptr::null(), COINIT_MULTITHREADED as u32) };
        }
    }
}

/// UI fonts of Linux desktops, in order of preference: GPUI's own name for
/// the UI font stands for a font apps rarely have there.
#[cfg(target_os = "linux")]
const UI_FAMILIES: &[&str] = &[
    "Adwaita Sans",
    "Cantarell",
    "Ubuntu",
    "Noto Sans",
    "DejaVu Sans",
    "Liberation Sans",
];
#[cfg(not(target_os = "linux"))]
const UI_FAMILIES: &[&str] = &[];

/// Fonts tried before the system's fallback for characters the font
/// lacks (Linux): symbols with a text presentation (♥, ✓, ★) take a text
/// font there, as fontconfig gives Pango, rather than an emoji font.
#[cfg(target_os = "linux")]
const TEXT_FALLBACKS: &[&str] = &["DejaVu Sans", "Noto Sans Symbols 2", "Noto Sans Symbols"];
#[cfg(not(target_os = "linux"))]
const TEXT_FALLBACKS: &[&str] = &[];

/// Fonts with text glyphs for symbols that are text by default (♥, ✓,
/// ★) but that a fallback may take from an emoji font, which ignores the
/// text's color. Fonts without Latin letters do not load as fonts in
/// GPUI on Linux, so symbol-only fonts are not among them.
const TEXT_SYMBOLS: &[&str] = &[
    "DejaVu Sans",
    "Segoe UI Symbol",
    "Apple Symbols",
    "Menlo",
    "Noto Sans CJK SC",
    "Noto Sans CJK JP",
    "Noto Sans Mono",
    "Liberation Sans",
    "Adwaita Mono",
];

/// Monospace families, in order of preference (the first installed one
/// stands for `monospace`; static fonts before variable ones, which GPUI
/// draws at one weight).
#[cfg(target_os = "macos")]
pub(crate) const MONOSPACE: &[&str] = &["Menlo", "SF Mono", "Monaco", "Courier New"];
#[cfg(windows)]
pub(crate) const MONOSPACE: &[&str] = &["Cascadia Mono", "Consolas", "Courier New"];
#[cfg(not(any(target_os = "macos", windows)))]
pub(crate) const MONOSPACE: &[&str] = &[
    "DejaVu Sans Mono",
    "Noto Sans Mono",
    "Liberation Mono",
    "Ubuntu Mono",
    "Adwaita Mono",
    "Cantarell Mono",
];

/// The first installed of [`MONOSPACE`] (GPUI resolves exact family
/// names only, no generic `monospace`). Only the dev overlay needs it.
#[cfg(feature = "dev")]
pub(crate) fn monospace_family(system: &TextSystem) -> Option<SharedString> {
    let installed = system.all_font_names();
    MONOSPACE
        .iter()
        .find(|f| installed.iter().any(|i| i.eq_ignore_ascii_case(f)))
        .map(|f| SharedString::from(*f))
}

#[cfg(any(target_os = "macos", windows))]
const SERIF: &[&str] = &["Times New Roman", "Times"];
#[cfg(not(any(target_os = "macos", windows)))]
const SERIF: &[&str] = &[
    "Noto Serif",
    "DejaVu Serif",
    "Liberation Serif",
    "Nimbus Roman",
];

const SANS: &[&str] = &[
    "Helvetica Neue",
    "Helvetica",
    "Arial",
    "Liberation Sans",
    "Nimbus Sans",
];
const CURSIVE: &[&str] = &["Comic Sans MS", "Comic Neue", "URW Chancery L"];
const FANTASY: &[&str] = &["Impact", "Papyrus"];

/// The families a `fontFamily` value names, in order of preference: a
/// comma-separated stack, CSS generic names and Apple's font names as fonts
/// this platform has; `""` is the UI font.
fn family_candidates(name: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for family in name.split(',') {
        let family = family.trim().trim_matches(|c| c == '"' || c == '\'');
        match family {
            "" => {}
            "system-ui" | "-apple-system" | "BlinkMacSystemFont" | "ui-sans-serif"
            | "ui-rounded" | "sans-serif" => out.push(""),
            "ui-monospace" | "monospace" => out.extend_from_slice(MONOSPACE),
            "ui-serif" | "serif" => out.extend_from_slice(SERIF),
            "cursive" => out.extend_from_slice(CURSIVE),
            "fantasy" => out.extend_from_slice(FANTASY),
            f => {
                out.push(f);
                // What apps written for Apple platforms name, as what
                // this platform has (when it lacks the font itself).
                out.extend_from_slice(match f {
                    "Menlo" | "Monaco" | "SF Mono" | "Courier" | "Courier New" => MONOSPACE,
                    "Times" | "New York" | "Georgia" => SERIF,
                    "Helvetica" | "Helvetica Neue" | "Arial" => SANS,
                    _ => &[],
                });
            }
        }
    }
    if out.is_empty() {
        out.push("");
    }
    out
}

/// The family of the UI font among the `installed` ones (by lowercase
/// name): the first of [`UI_FAMILIES`] GPUI can set in bold, or GPUI's
/// name for the system's. GPUI loads variable fonts at their default
/// weight only, so a variable UI font (GNOME's Adwaita Sans) would draw
/// every weight alike.
fn ui_font(system: &TextSystem, installed: &FxHashMap<String, String>) -> String {
    UI_FAMILIES
        .iter()
        .filter_map(|f| installed.get(&f.to_lowercase()))
        .find(|family| {
            let font = gpui::font(family.to_string());
            system.resolve_font(&font) != system.resolve_font(&font.clone().bold())
        })
        .map_or_else(|| SYSTEM_UI.to_owned(), |f| f.clone())
}

/// [`ui_font`] as of a [`FONT_GENERATION`]: what [`ui_family`] answers.
static UI_FAMILY: Mutex<Option<(u64, Arc<str>)>> = Mutex::new(None);

/// The family text views set `fontFamily` unset in, resolved with
/// `system` (when fonts changed since last time): what everything that
/// names the UI font is set in, as GPUI's own name for it is a variable
/// font on GNOME, which GPUI draws at one weight only.
pub(crate) fn ui_family_for(system: &TextSystem) -> SharedString {
    let generation = FONT_GENERATION.load(Ordering::Acquire);
    let mut current = UI_FAMILY.lock().unwrap_or_else(|e| e.into_inner());
    match &*current {
        Some((g, family)) if *g == generation => SharedString::from(family.to_string()),
        _ => {
            let installed: FxHashMap<String, String> = system
                .all_font_names()
                .into_iter()
                .map(|n| (n.to_lowercase(), n))
                .collect();
            let family = ui_font(system, &installed);
            *current = Some((generation, Arc::from(family.as_str())));
            SharedString::from(family)
        }
    }
}

/// Bumped when any engine registers a font: engines resolve families
/// again.
static FONT_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Fonts registered so far: the text system they went to, a hash of their
/// data and their family names (a family a platform does not list yet
/// still resolves).
static REGISTERED: Mutex<Vec<(usize, u64, Vec<String>)>> = Mutex::new(Vec::new());

fn hash(data: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = rustc_hash::FxHasher::default();
    data.hash(&mut hasher);
    hasher.finish()
}

/// The family names in a font's naming table.
fn font_families(data: &[u8]) -> Result<Vec<String>, String> {
    let face = ttf_parser::Face::parse(data, 0).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = face
        .names()
        .into_iter()
        .filter(|n| {
            n.name_id == ttf_parser::name_id::TYPOGRAPHIC_FAMILY
                || n.name_id == ttf_parser::name_id::FAMILY
        })
        .filter_map(|n| n.to_string())
        .filter(|s| !s.is_empty())
        .collect();
    names.dedup();
    if names.is_empty() {
        return Err("the font has no family name".to_owned());
    }
    Ok(names)
}

/// Vertical metrics of a font, in ems.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Metrics {
    ascent: f32,
    descent: f32,
    cap: f32,
    x: f32,
}

/// A style's font, resolved.
#[derive(Debug)]
struct Face {
    font: Font,
    metrics: Metrics,
}

/// What resolves a font: `(fontFamily, weight, italic, fontVariant)`.
type FaceKey = (Option<FontFamily>, u16, bool, u8);

/// The fonts an engine knows, as of a [`FONT_GENERATION`].
struct Fonts {
    generation: u64,
    /// Installed families, by their lowercase name.
    installed: FxHashMap<String, String>,
    /// The UI font's family.
    ui: SharedString,
    /// The installed ones of [`TEXT_FALLBACKS`].
    fallbacks: Option<gpui::FontFallbacks>,
    /// The ascent and descent (ems) of the desktop's own UI font when the
    /// UI font is another (GPUI cannot set it in bold): lines in the UI
    /// font keep the desktop's line heights.
    ui_lines: Option<(f32, f32)>,
    /// The installed fonts of [`TEXT_SYMBOLS`].
    symbols: Vec<SharedString>,
    faces: FxHashMap<FaceKey, Rc<Face>>,
}

// --- The engine ---------------------------------------------------------------------------

/// The text engine of one surface (engine thread).
pub(crate) struct GpuiTextEngine {
    system: Arc<TextSystem>,
    shaper: RefCell<WindowTextSystem>,
    /// Lines shaped since the shaper was made.
    shaped: Cell<u32>,
    /// The family `fontFamily` unset stands for, as given.
    ui: Arc<str>,
    fonts: RefCell<Fonts>,
}

impl GpuiTextEngine {
    /// An engine over the app's text system, with `family` as the UI
    /// font (GPUI's name for the system's: an installed one on Linux).
    pub(crate) fn new(system: Arc<TextSystem>, family: Arc<str>) -> Self {
        init_thread();
        GpuiTextEngine {
            shaper: RefCell::new(WindowTextSystem::new(system.clone())),
            system,
            shaped: Cell::new(0),
            ui: family,
            fonts: RefCell::new(Fonts {
                generation: u64::MAX,
                installed: FxHashMap::default(),
                ui: SharedString::default(),
                fallbacks: None,
                ui_lines: None,
                symbols: Vec::new(),
                faces: FxHashMap::default(),
            }),
        }
    }

    /// The fonts, current.
    fn fonts(&self) -> std::cell::RefMut<'_, Fonts> {
        let generation = FONT_GENERATION.load(Ordering::Acquire);
        let mut fonts = self.fonts.borrow_mut();
        if fonts.generation != generation {
            let mut installed: FxHashMap<String, String> = self
                .system
                .all_font_names()
                .into_iter()
                .map(|n| (n.to_lowercase(), n))
                .collect();
            let key = Arc::as_ptr(&self.system) as usize;
            for (system, _, names) in REGISTERED.lock().unwrap_or_else(|e| e.into_inner()).iter() {
                if *system == key {
                    for n in names {
                        installed.insert(n.to_lowercase(), n.clone());
                    }
                }
            }
            let ui = if &*self.ui == SYSTEM_UI {
                ui_font(&self.system, &installed)
            } else {
                self.ui.to_string()
            };
            let desktop = UI_FAMILIES
                .iter()
                .find_map(|f| installed.get(&f.to_lowercase()));
            fonts.ui_lines = match desktop {
                // Only for a UI font this engine chose (one of the list).
                Some(d) if *d != ui && UI_FAMILIES.iter().any(|f| f.eq_ignore_ascii_case(&ui)) => {
                    let id = self.system.resolve_font(&gpui::font(d.clone()));
                    let em = px(1.0);
                    Some((
                        f32::from(self.system.ascent(id, em)),
                        f32::from(self.system.descent(id, em)).abs(),
                    ))
                }
                _ => None,
            };
            fonts.symbols = TEXT_SYMBOLS
                .iter()
                .filter_map(|f| installed.get(&f.to_lowercase()))
                .map(|f| SharedString::from(f.clone()))
                .collect();
            fonts.ui = SharedString::from(ui);
            let fallbacks: Vec<String> = TEXT_FALLBACKS
                .iter()
                .filter_map(|f| installed.get(&f.to_lowercase()).cloned())
                .collect();
            fonts.fallbacks =
                (!fallbacks.is_empty()).then(|| gpui::FontFallbacks::from_fonts(fallbacks));
            fonts.installed = installed;
            fonts.faces.clear();
            fonts.generation = generation;
        }
        fonts
    }

    /// The GPUI font `style` is set in (canvas text, which must measure as
    /// `measureText` does).
    pub(crate) fn font(&self, style: &ResolvedTextStyle) -> Font {
        self.face(style).font.clone()
    }

    /// The font `style` is set in.
    fn face(&self, style: &ResolvedTextStyle) -> Rc<Face> {
        let key = (
            style.font_family,
            style.font_weight,
            style.italic,
            style.font_variant.0,
        );
        let mut fonts = self.fonts();
        if let Some(face) = fonts.faces.get(&key) {
            return face.clone();
        }
        let family = match style.font_family {
            Some(f) => {
                let name = f.name();
                family_candidates(&name)
                    .into_iter()
                    .find_map(|c| {
                        if c.is_empty() {
                            Some(fonts.ui.clone())
                        } else {
                            fonts
                                .installed
                                .get(&c.to_lowercase())
                                .map(|n| SharedString::from(n.clone()))
                        }
                    })
                    // Not installed: lines take the UI font.
                    .unwrap_or_else(|| fonts.ui.clone())
            }
            None => fonts.ui.clone(),
        };
        let features: Vec<(String, u32)> = style
            .font_variant
            .tags()
            .map(|t| (t.to_owned(), 1))
            .collect();
        let font = Font {
            family,
            features: FontFeatures(Arc::new(features)),
            fallbacks: fonts.fallbacks.clone(),
            weight: FontWeight(f32::from(style.font_weight)),
            style: if style.italic {
                FontStyle::Italic
            } else {
                FontStyle::Normal
            },
        };
        let id = self.system.resolve_font(&font);
        let em = px(1.0);
        let or = |v: f32, default: f32| if v > 0.0 { v } else { default };
        let lines = match fonts.ui_lines {
            Some(lines) if font.family == fonts.ui => lines,
            _ => (
                f32::from(self.system.ascent(id, em)),
                f32::from(self.system.descent(id, em)).abs(),
            ),
        };
        let metrics = Metrics {
            ascent: lines.0,
            descent: lines.1,
            cap: or(f32::from(self.system.cap_height(id, em)), CAP_HEIGHT),
            x: or(f32::from(self.system.x_height(id, em)), X_HEIGHT),
        };
        let face = Rc::new(Face { font, metrics });
        fonts.faces.insert(key, face.clone());
        face
    }

    /// Shapes `text` (one paragraph, one size) in `runs`.
    fn shape(&self, text: &str, size: f32, runs: &[TextRun]) -> Arc<LineLayout> {
        let n = self.shaped.get() + 1;
        if n > CACHE_LINES {
            *self.shaper.borrow_mut() = WindowTextSystem::new(self.system.clone());
            self.shaped.set(0);
        } else {
            self.shaped.set(n);
        }
        self.shaper
            .borrow()
            .layout_line(text, px(size.max(0.1)), runs, None)
    }

    /// The glyphs and advance of symbol `c` in a text font (the first of
    /// [`TEXT_SYMBOLS`] that has it), in `font`'s weight and style.
    fn text_symbol(&self, c: char, font: &Font, size: f32) -> Option<(Vec<PGlyph>, f32)> {
        let families = self.fonts().symbols.clone();
        let mut buf = [0u8; 4];
        let s = c.encode_utf8(&mut buf);
        for family in families {
            let font = Font {
                family,
                fallbacks: None,
                ..font.clone()
            };
            let id = self.system.resolve_font(&font);
            if self.system.advance(id, px(size), c).is_err() {
                continue;
            }
            let layout = self.shape(
                s,
                size,
                &[TextRun {
                    len: s.len(),
                    font,
                    color: gpui::black(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                }],
            );
            let glyphs: Vec<PGlyph> = layout
                .runs
                .iter()
                .flat_map(|r| {
                    r.glyphs.iter().map(|g| PGlyph {
                        dx: f32::from(g.position.x),
                        dy: f32::from(g.position.y),
                        font: r.font_id,
                        id: g.id,
                        emoji: g.is_emoji,
                    })
                })
                .collect();
            if !glyphs.is_empty() && glyphs.iter().all(|g| !g.emoji && g.id.0 != 0) {
                return Some((glyphs, f32::from(layout.width)));
            }
        }
        None
    }

    /// The ellipsis in span `span`'s font: its glyphs and advance.
    fn ellipsis(&self, p: &Prepared, span: u16) -> Rc<Shaped> {
        if let Some((_, e)) = p.ellipses.borrow().iter().find(|(s, _)| *s == span) {
            return e.clone();
        }
        let (font, size) = p.fonts[usize::from(span).min(p.fonts.len() - 1)].clone();
        let layout = self.shape(
            "\u{2026}",
            size,
            &[TextRun {
                len: '\u{2026}'.len_utf8(),
                font,
                color: gpui::black(),
                background_color: None,
                underline: None,
                strikethrough: None,
            }],
        );
        let glyphs = layout
            .runs
            .iter()
            .flat_map(|r| {
                r.glyphs.iter().map(|g| PGlyph {
                    dx: f32::from(g.position.x),
                    dy: f32::from(g.position.y),
                    font: r.font_id,
                    id: g.id,
                    emoji: g.is_emoji,
                })
            })
            .collect();
        let e = Rc::new(Shaped {
            glyphs,
            advance: f32::from(layout.width),
        });
        p.ellipses.borrow_mut().push((span, e.clone()));
        e
    }
}

/// The first strong direction of `s`: right to left for Hebrew and Arabic
/// letters, left to right for other letters.
fn first_strong(s: &str) -> Option<bool> {
    s.chars().find_map(|c| {
        if is_rtl(c) {
            Some(true)
        } else if c.is_alphabetic() {
            Some(false)
        } else {
            None
        }
    })
}

/// Right-to-left scripts' letters (Hebrew, Arabic, Syriac, Thaana, N'Ko,
/// ...).
fn is_rtl(c: char) -> bool {
    matches!(c as u32, 0x0590..=0x08FF | 0xFB1D..=0xFDFF | 0xFE70..=0xFEFF | 0x10800..=0x10FFF | 0x1E800..=0x1EFFF)
}

/// CJK ideographs, kana and hangul (justified by spreading every
/// character).
fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x2FDF | 0x3040..=0x30FF | 0x3100..=0x31FF | 0x3400..=0x4DBF
        | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF
        | 0x20000..=0x3FFFF)
}

/// The mirror image of `c` in right-to-left text (`Bidi_Mirroring_Glyph`,
/// the pairs in common use).
fn mirrored(c: char) -> Option<char> {
    const PAIRS: &[(char, char)] = &[
        ('(', ')'),
        ('[', ']'),
        ('{', '}'),
        ('<', '>'),
        ('«', '»'),
        ('‹', '›'),
        ('⁅', '⁆'),
        ('⁽', '⁾'),
        ('₍', '₎'),
        ('≤', '≥'),
        ('≪', '≫'),
        ('⟨', '⟩'),
        ('⟦', '⟧'),
        ('〈', '〉'),
        ('《', '》'),
        ('「', '」'),
        ('『', '』'),
        ('【', '】'),
        ('〔', '〕'),
        ('（', '）'),
        ('［', '］'),
        ('｛', '｝'),
        ('＜', '＞'),
    ];
    PAIRS.iter().find_map(|&(a, b)| {
        if c == a {
            Some(b)
        } else if c == b {
            Some(a)
        } else {
            None
        }
    })
}

/// True for the symbols that are text by default (`Emoji_Presentation`
/// is no), which a font fallback may still take from an emoji font:
/// dingbats, arrows, card suits, ©, ®, ™.
fn text_symbol(c: char) -> bool {
    let u = c as u32;
    let symbol = matches!(
        u,
        0xA9 | 0xAE | 0x2000..=0x2BFF | 0x3030 | 0x303D | 0x3297 | 0x3299
    );
    // The ones that are emoji by default.
    let emoji = matches!(u,
        0x231A | 0x231B | 0x23E9..=0x23EC | 0x23F0 | 0x23F3 | 0x25FD | 0x25FE
        | 0x2614 | 0x2615 | 0x2648..=0x2653 | 0x267F | 0x2693 | 0x26A1 | 0x26AA
        | 0x26AB | 0x26BD | 0x26BE | 0x26C4 | 0x26C5 | 0x26CE | 0x26D4 | 0x26EA
        | 0x26F2 | 0x26F3 | 0x26F5 | 0x26FA | 0x26FD | 0x2705 | 0x270A | 0x270B
        | 0x2728 | 0x274C | 0x274E | 0x2753..=0x2755 | 0x2757 | 0x2795..=0x2797
        | 0x27B0 | 0x27BF | 0x2B1B | 0x2B1C | 0x2B50 | 0x2B55);
    symbol && !emoji
}

/// True for the characters that end a paragraph.
fn is_paragraph_break(c: char) -> bool {
    matches!(
        c,
        '\n' | '\r' | '\u{0B}' | '\u{0C}' | '\u{85}' | '\u{2028}' | '\u{2029}'
    )
}

/// The index of the span containing the UTF-16 offset `index` (the last
/// one past the end).
fn span_at(spans: &[TextSpan], index: u32) -> usize {
    spans
        .partition_point(|s| s.end <= index)
        .min(spans.len().saturating_sub(1))
}

// --- Prepared text ----------------------------------------------------------------------

/// A glyph of a cluster, relative to the cluster's left edge and the
/// baseline.
#[derive(Debug, Clone, Copy)]
struct PGlyph {
    dx: f32,
    dy: f32,
    font: FontId,
    id: GlyphId,
    emoji: bool,
}

/// Glyphs with their advance (an ellipsis).
#[derive(Debug)]
struct Shaped {
    glyphs: Vec<PGlyph>,
    advance: f32,
}

/// Whitespace: hangs past the end of a line.
const SPACE: u8 = 1;
/// An attachment's placeholder.
const ATTACHMENT: u8 = 2;
/// A line may break after it.
const BREAK: u8 = 4;
/// A CJK character.
const CJK: u8 = 8;

/// A cluster: characters drawn by a group of glyphs, the unit of breaking,
/// hit testing and selection.
#[derive(Debug, Clone, Copy)]
struct Cluster {
    /// UTF-16 offset of its first character.
    utf16: u32,
    /// Advance, letter spacing included.
    advance: f32,
    /// Its glyphs in [`Prepared::glyphs`].
    glyphs: (u32, u32),
    /// Its style run.
    span: u16,
    /// Bidi level.
    level: u8,
    flags: u8,
}

/// A paragraph (text between paragraph breaks).
#[derive(Debug, Clone)]
struct Paragraph {
    /// UTF-16 range, without its break.
    utf16: Range<u32>,
    /// Its clusters in [`Prepared::clusters`].
    clusters: Range<u32>,
    /// The style run at its start (an empty paragraph's line box).
    span: u16,
}

/// A span's line box: its font's ascent and descent (points), its
/// `lineHeight` (0: the font's), and what decorations need.
#[derive(Debug, Clone, Copy)]
struct SpanBox {
    start: u32,
    end: u32,
    ascent: f32,
    descent: f32,
    line_height: f32,
    size: f32,
    cap: f32,
    x: f32,
}

impl SpanBox {
    /// Its extent above and below the baseline: the font's, with an
    /// explicit line height spread evenly above and below (as Pango and
    /// CSS do).
    fn extents(&self) -> (f32, f32) {
        if self.line_height > 0.0 {
            let half = (self.line_height - self.ascent - self.descent) / 2.0;
            (self.ascent + half, self.descent + half)
        } else {
            (self.ascent, self.descent)
        }
    }
}

/// The text shaped for measuring and layout.
pub(crate) struct Prepared {
    alignments: nsh_core::AttachmentAlignments,
    text: AttributedText,
    /// The paragraphs' base direction is right to left.
    rtl: bool,
    clusters: Vec<Cluster>,
    glyphs: Vec<PGlyph>,
    /// Advances summed from the start (`clusters.len() + 1` entries).
    prefix: Vec<f64>,
    paragraphs: Vec<Paragraph>,
    /// One per style run (one for text without spans).
    spans: Vec<SpanBox>,
    /// The fonts of the style runs and their sizes.
    fonts: Vec<(Font, f32)>,
    /// Ellipses shaped so far, by span.
    ellipses: RefCell<Vec<(u16, Rc<Shaped>)>>,
}

/// A line broken from a paragraph.
#[derive(Debug, Clone, Copy)]
struct Broken {
    paragraph: u32,
    /// Its clusters.
    start: u32,
    end: u32,
    /// Width without trailing whitespace.
    width: f32,
    /// It ends its paragraph.
    last: bool,
}

impl Prepared {
    /// How far attachment `a`'s top is above the baseline, and what its
    /// line reserves above and below it (`TextAttachment::ascent` and
    /// `extent` in its placeholder's font).
    fn attachment_box(&self, a: &nsh_core::TextAttachment) -> (f32, f32, f32) {
        let alignments = &self.alignments;
        let font = if alignments.get(a.index) == nsh_core::VerticalAlign::Baseline {
            nsh_core::FontExtent::default()
        } else {
            let i = self
                .spans
                .partition_point(|s| s.end <= a.index)
                .min(self.spans.len() - 1);
            let s = &self.spans[i];
            nsh_core::FontExtent::new(Points(s.ascent), Points(s.descent), Points(s.x))
        };
        let (up, down) = a.extent(font, alignments.get(a.index));
        (a.ascent(font, alignments.get(a.index)).0, up.0, down.0)
    }

    /// The width of clusters `start..end` without trailing whitespace.
    fn width(&self, start: u32, end: u32) -> f32 {
        let mut visible = end;
        while visible > start && self.clusters[visible as usize - 1].flags & SPACE != 0 {
            visible -= 1;
        }
        (self.prefix[visible as usize] - self.prefix[start as usize]) as f32
    }

    /// Breaks the paragraphs into lines at most `max` wide, handing each to
    /// `f` until it returns false.
    fn break_lines(&self, max: f32, mut f: impl FnMut(Broken) -> bool) {
        for (pi, p) in self.paragraphs.iter().enumerate() {
            let (first, end) = (p.clusters.start, p.clusters.end);
            let mut start = first;
            let mut last_break: Option<u32> = None;
            let mut i = start;
            while i < end {
                let c = &self.clusters[i as usize];
                let pen = (self.prefix[i as usize + 1] - self.prefix[start as usize]) as f32;
                if c.flags & SPACE == 0 && pen > max + EPSILON && i > start {
                    // At the last opportunity, or inside a word too long
                    // for its line.
                    let cut = last_break.filter(|&b| b > start).unwrap_or(i);
                    let line = Broken {
                        paragraph: pi as u32,
                        start,
                        end: cut,
                        width: self.width(start, cut),
                        last: false,
                    };
                    if !f(line) {
                        return;
                    }
                    start = cut;
                    last_break = None;
                    i = start;
                    continue;
                }
                if c.flags & BREAK != 0 {
                    last_break = Some(i + 1);
                }
                i += 1;
            }
            let line = Broken {
                paragraph: pi as u32,
                start,
                end,
                width: self.width(start, end),
                last: true,
            };
            if !f(line) {
                return;
            }
        }
    }

    /// The UTF-16 range of a broken line: up to the next line's start, or
    /// to its paragraph's break.
    fn line_range(&self, line: &Broken) -> (u32, u32) {
        let p = &self.paragraphs[line.paragraph as usize];
        let start = if line.start < line.end {
            self.clusters[line.start as usize].utf16
        } else if line.last {
            p.utf16.start
        } else {
            p.utf16.end
        };
        let end = if line.last {
            p.utf16.end
        } else {
            self.clusters[line.end as usize].utf16
        };
        (start.min(end), end)
    }

    /// The extents above and below the baseline of the line from `start`
    /// to `end` (UTF-16): those of the spans in it (spans that only hold
    /// attachments there aside) and of its attachments.
    fn line_box(&self, start: u32, end: u32) -> (f32, f32) {
        let mut ascent = f32::NEG_INFINITY;
        let mut descent = f32::NEG_INFINITY;
        let attachments = &self.text.attachments;
        let placeholders = |a: u32, b: u32| {
            attachments
                .iter()
                .filter(|t| t.index >= a && t.index < b)
                .count() as u32
        };
        if start >= end {
            // An empty line: the span it would continue.
            let i = self
                .spans
                .partition_point(|s| s.end < start)
                .min(self.spans.len() - 1);
            (ascent, descent) = self.spans[i].extents();
        } else {
            let first = self.spans.partition_point(|s| s.end <= start);
            for s in self.spans[first..].iter().take_while(|s| s.start < end) {
                let (a, b) = (s.start.max(start), s.end.min(end));
                if s.line_height <= 0.0 && placeholders(a, b) >= b - a {
                    continue;
                }
                let (up, down) = s.extents();
                ascent = ascent.max(up);
                descent = descent.max(down);
            }
            for t in attachments {
                if t.index >= start && t.index < end {
                    let (_, up, down) = self.attachment_box(t);
                    ascent = ascent.max(up);
                    descent = descent.max(down);
                }
            }
        }
        if ascent == f32::NEG_INFINITY {
            return self.spans[0].extents();
        }
        (ascent, descent)
    }

    /// Lines past `numberOfLines` get an ellipsis of their own kind.
    fn ellipsizes(&self) -> bool {
        self.text.max_lines > 0 && self.text.ellipsize != EllipsizeMode::Clip
    }

    /// `head` / `middle` ellipses cut the one line out of the middle or
    /// the start; with more lines, the end of the last one is cut.
    fn cuts_inside(&self) -> bool {
        matches!(
            self.text.ellipsize,
            EllipsizeMode::Head | EllipsizeMode::Middle
        ) && self.text.max_lines > 0
            && (self.text.max_lines == 1 || self.text.no_wrap)
            && self.paragraphs.len() == 1
    }
}

/// Shapes the text of one engine into a [`Prepared`].
struct Builder<'a> {
    engine: &'a GpuiTextEngine,
    t: &'a AttributedText,
    /// UTF-16 offset of every byte boundary (`len + 1` entries).
    utf16: Vec<u32>,
    /// Byte ranges of the style runs.
    span_bytes: Vec<(usize, usize)>,
    styles: Vec<ResolvedTextStyle>,
    fonts: Vec<(Font, f32)>,
    /// A line may break before the byte (UAX #14).
    allowed: Vec<bool>,
    rtl: bool,
    clusters: Vec<Cluster>,
    glyphs: Vec<PGlyph>,
}

/// A piece of a paragraph in one span and bidi level.
#[derive(Debug, Clone, Copy)]
struct Piece {
    start: usize,
    end: usize,
    span: u16,
    level: u8,
    attachment: bool,
}

impl Builder<'_> {
    fn span_of_byte(&self, b: usize) -> u16 {
        self.span_bytes
            .partition_point(|&(_, e)| e <= b)
            .min(self.span_bytes.len() - 1) as u16
    }

    /// Shapes the paragraph in bytes `range` into clusters.
    fn paragraph(&mut self, range: Range<usize>) {
        let s = &self.t.text[range.clone()];
        let base = Level::from(u8::from(self.rtl));
        let levels = (self.rtl || s.chars().any(is_rtl))
            .then(|| ParagraphBidiInfo::new(s, Some(base)).levels);
        let mut pieces: Vec<Piece> = Vec::new();
        for (off, c) in s.char_indices() {
            let b = range.start + off;
            let span = self.span_of_byte(b);
            let level = levels.as_ref().map_or(base.number(), |l| l[off].number());
            let attachment = c == ATTACHMENT_CHAR;
            match pieces.last_mut() {
                Some(p) if p.span == span && p.level == level && !attachment && !p.attachment => {
                    p.end = b + c.len_utf8();
                }
                _ => pieces.push(Piece {
                    start: b,
                    end: b + c.len_utf8(),
                    span,
                    level,
                    attachment,
                }),
            }
        }
        // Segments: pieces of one level and font size, shaped by one call.
        let mut i = 0;
        while i < pieces.len() {
            let p = pieces[i];
            if p.attachment {
                self.attachment(p);
                i += 1;
                continue;
            }
            let size = self.fonts[p.span as usize].1;
            let mut j = i + 1;
            while j < pieces.len()
                && !pieces[j].attachment
                && pieces[j].level == p.level
                && self.fonts[pieces[j].span as usize].1.to_bits() == size.to_bits()
            {
                j += 1;
            }
            self.segment(&pieces[i..j], size);
            i = j;
        }
    }

    /// An attachment's placeholder: a cluster of its width, no glyphs.
    fn attachment(&mut self, p: Piece) {
        let utf16 = self.utf16[p.start];
        let width = self
            .t
            .attachments
            .iter()
            .find(|a| a.index == utf16)
            .map_or(0.0, |a| a.width.0);
        let flags = ATTACHMENT | if self.allowed[p.end] { BREAK } else { 0 };
        let at = self.glyphs.len() as u32;
        self.clusters.push(Cluster {
            utf16,
            advance: width,
            glyphs: (at, at),
            span: p.span,
            level: p.level,
            flags,
        });
    }

    /// Shapes pieces of one level and size, adding their clusters.
    fn segment(&mut self, pieces: &[Piece], size: f32) {
        let (start, end) = (pieces[0].start, pieces[pieces.len() - 1].end);
        let mut text = Cow::Borrowed(&self.t.text[start..end]);
        if pieces[0].level % 2 == 1
            && !text.chars().any(is_rtl)
            && text.chars().any(|c| mirrored(c).is_some())
        {
            // Rule L4: right to left, brackets and the like show their
            // mirror image. Shapers mirror runs they take as right to left
            // themselves; a run without right-to-left letters (a span of
            // only brackets) they take as left to right. Mirrors have as
            // many bytes: offsets hold.
            text = Cow::Owned(text.chars().map(|c| mirrored(c).unwrap_or(c)).collect());
        }
        let text = &*text;
        let runs: Vec<TextRun> = pieces
            .iter()
            .map(|p| TextRun {
                len: p.end - p.start,
                font: self.fonts[p.span as usize].0.clone(),
                color: gpui::black(),
                background_color: None,
                underline: None,
                strikethrough: None,
            })
            .collect();
        let layout = self.engine.shape(text, size, &runs);
        // Glyphs in visual order, grouped by cluster: a group reaches to
        // the next one's left edge (or the line's end).
        let mut flat: Vec<(f32, f32, FontId, GlyphId, bool, usize)> = layout
            .runs
            .iter()
            .flat_map(|r| {
                r.glyphs.iter().map(|g| {
                    (
                        f32::from(g.position.x),
                        f32::from(g.position.y),
                        r.font_id,
                        g.id,
                        g.is_emoji,
                        g.index.min(text.len()),
                    )
                })
            })
            .collect();
        flat.sort_by(|a, b| a.0.total_cmp(&b.0));
        // (index, left, right, glyphs in `flat`)
        let mut groups: Vec<(usize, f32, f32, Range<usize>)> = Vec::new();
        for (k, g) in flat.iter().enumerate() {
            match groups.last_mut() {
                Some(last) if last.0 == g.5 => last.3.end = k + 1,
                _ => groups.push((g.5, g.0, g.0, k..k + 1)),
            }
        }
        let width = f32::from(layout.width);
        for k in 0..groups.len() {
            groups[k].2 = groups.get(k + 1).map_or(width, |n| n.1).max(groups[k].1);
        }
        // Text order; a cluster split in two places is one.
        groups.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.total_cmp(&b.1)));
        let mut merged: Vec<(usize, f32, f32, Vec<Range<usize>>)> = Vec::new();
        for (index, left, right, glyphs) in groups {
            match merged.last_mut() {
                Some(m) if m.0 == index => {
                    m.2 += right - left;
                    m.1 = m.1.min(left);
                    m.3.push(glyphs);
                }
                _ => merged.push((index, left, right - left, vec![glyphs])),
            }
        }
        if merged.is_empty() {
            // Nothing drawn (a zero-width character): one empty cluster.
            merged.push((0, 0.0, width, Vec::new()));
        }
        // Characters before the first glyph's belong to its cluster.
        merged[0].0 = 0;
        let n = merged.len();
        for k in 0..n {
            let (index, left, advance, ref glyphs) = merged[k];
            let next = merged.get(k + 1).map_or(text.len(), |m| m.0);
            let byte = start + index;
            let span = self.span_of_byte(byte);
            let ch = text[index..].chars().next().unwrap_or(' ');
            let mut flags = 0;
            if ch.is_whitespace() {
                flags |= SPACE;
            }
            if is_cjk(ch) {
                flags |= CJK;
            }
            if self.allowed[start + next] {
                flags |= BREAK;
            }
            let first = self.glyphs.len() as u32;
            let cluster = &text[index..next];
            let mut cluster_chars = cluster.chars();
            let emoji = glyphs.iter().any(|r| flat[r.clone()].iter().any(|g| g.4));
            let symbol = match (cluster_chars.next(), cluster_chars.next()) {
                (Some(c), None | Some('\u{FE0E}')) if emoji && text_symbol(c) => self
                    .engine
                    .text_symbol(c, &self.fonts[span as usize].0, size),
                _ => None,
            };
            let advance = match symbol {
                Some((glyphs, width)) => {
                    self.glyphs.extend(glyphs);
                    let spacing = self.styles[span as usize].letter_spacing.0;
                    self.clusters.push(Cluster {
                        utf16: self.utf16[byte],
                        advance: width + spacing,
                        glyphs: (first, self.glyphs.len() as u32),
                        span,
                        level: pieces[0].level,
                        flags,
                    });
                    continue;
                }
                None => advance,
            };
            for range in glyphs {
                for &(x, y, font, id, emoji, _) in &flat[range.clone()] {
                    self.glyphs.push(PGlyph {
                        dx: x - left,
                        dy: y,
                        font,
                        id,
                        emoji,
                    });
                }
            }
            let spacing = self.styles[span as usize].letter_spacing.0;
            self.clusters.push(Cluster {
                utf16: self.utf16[byte],
                advance: advance + spacing,
                glyphs: (first, self.glyphs.len() as u32),
                span,
                level: pieces[0].level,
                flags,
            });
        }
    }
}

impl TextEngine for GpuiTextEngine {
    type Prepared = Prepared;

    fn prepare(&self, t: &AttributedText) -> Prepared {
        self.prepare_aligned(t, &nsh_core::AttachmentAlignments::default())
    }

    fn prepare_aligned(
        &self,
        t: &AttributedText,
        alignments: &nsh_core::AttachmentAlignments,
    ) -> Prepared {
        let s = t.text.as_str();
        let mut utf16 = Vec::with_capacity(s.len() + 1);
        let mut u = 0u32;
        // Every byte of a character maps to the character's offset, so the
        // first byte at an offset is always a character boundary.
        for c in s.chars() {
            for _ in 0..c.len_utf8() {
                utf16.push(u);
            }
            u += c.len_utf16() as u32;
        }
        utf16.push(u);
        let byte_of = |offset: u32| utf16.partition_point(|&x| x < offset).min(s.len());
        let default = ResolvedTextStyle::default();
        let styles: Vec<ResolvedTextStyle> = if t.spans.is_empty() {
            vec![default]
        } else {
            t.spans.iter().map(|s| s.style).collect()
        };
        let span_bytes: Vec<(usize, usize)> = if t.spans.is_empty() {
            vec![(0, s.len())]
        } else {
            t.spans
                .iter()
                .map(|sp| (byte_of(sp.start), byte_of(sp.end)))
                .collect()
        };
        let mut fonts = Vec::with_capacity(styles.len());
        let mut spans = Vec::with_capacity(styles.len());
        for (i, style) in styles.iter().enumerate() {
            let face = self.face(style);
            let size = style.font_size.0;
            let m = face.metrics;
            let (start, end) = t.spans.get(i).map_or((0, u), |sp| (sp.start, sp.end));
            spans.push(SpanBox {
                start,
                end,
                ascent: m.ascent * size,
                descent: m.descent * size,
                line_height: style.line_height.0,
                size,
                cap: m.cap * size,
                x: m.x * size,
            });
            fonts.push((face.font.clone(), size));
        }
        let mut allowed = vec![false; s.len() + 1];
        for (i, op) in unicode_linebreak::linebreaks(s) {
            if op == unicode_linebreak::BreakOpportunity::Allowed {
                allowed[i] = true;
            }
        }
        let rtl = t
            .writing_direction
            .unwrap_or_else(|| first_strong(s).unwrap_or(t.rtl));
        let mut b = Builder {
            engine: self,
            t,
            utf16,
            span_bytes,
            styles,
            fonts,
            allowed,
            rtl,
            clusters: Vec::new(),
            glyphs: Vec::new(),
        };
        let mut paragraphs = Vec::new();
        let mut start = 0;
        let mut chars = s.char_indices().peekable();
        loop {
            let (end, next) = match chars.next() {
                Some((i, c)) if is_paragraph_break(c) => {
                    let mut next = i + c.len_utf8();
                    if c == '\r' && chars.peek().is_some_and(|&(_, n)| n == '\n') {
                        chars.next();
                        next += 1;
                    }
                    (i, Some(next))
                }
                Some(_) => continue,
                None => (s.len(), None),
            };
            let first = b.clusters.len() as u32;
            if start < end {
                b.paragraph(start..end);
            }
            paragraphs.push(Paragraph {
                utf16: b.utf16[start]..b.utf16[end],
                clusters: first..b.clusters.len() as u32,
                span: b.span_of_byte(start),
            });
            match next {
                Some(n) => start = n,
                None => break,
            }
        }
        let mut prefix = Vec::with_capacity(b.clusters.len() + 1);
        let mut sum = 0.0f64;
        prefix.push(0.0);
        for c in &b.clusters {
            sum += f64::from(c.advance);
            prefix.push(sum);
        }
        Prepared {
            alignments: alignments.clone(),
            text: t.clone(),
            rtl,
            clusters: b.clusters,
            glyphs: b.glyphs,
            prefix,
            paragraphs,
            spans,
            fonts: b.fonts,
            ellipses: RefCell::default(),
        }
    }

    fn measure(&self, p: &Prepared, max_width: Option<Points>) -> Size<Points> {
        let max = match max_width.map(|m| m.0) {
            Some(m) if !p.text.no_wrap => m.max(0.0),
            _ => f32::INFINITY,
        };
        let limit = p.text.max_lines as usize;
        let (mut width, mut height) = (0.0f32, 0.0f32);
        let mut count = 0;
        let mut last: Option<Broken> = None;
        let mut more = false;
        p.break_lines(max, |line| {
            if limit > 0 && count == limit {
                more = true;
                return false;
            }
            count += 1;
            let (start, end) = p.line_range(&line);
            let (a, d) = p.line_box(start, end);
            height += a + d;
            width = width.max(line.width);
            last = Some(line);
            true
        });
        // A last line ending its paragraph gets the ellipsis after it.
        if more
            && p.ellipsizes()
            && !p.cuts_inside()
            && let Some(line) = last
            && line.last
        {
            let span = p.clusters[..line.end as usize]
                .last()
                .map_or(p.paragraphs[line.paragraph as usize].span, |c| c.span);
            width = width.max(line.width + self.ellipsis(p, span).advance);
        }
        if max.is_finite() {
            width = width.min(max);
        }
        Size::new(Points(width.ceil()), Points(height.ceil()))
    }

    fn layout(&self, p: &Prepared, size: Size<Points>) -> TextLayout {
        let t = &p.text;
        let avail = size.width.max(Points(0.0));
        let max = if t.no_wrap { f32::INFINITY } else { avail.0 };
        let limit = t.max_lines as usize;
        let mut broken: Vec<Broken> = Vec::new();
        let mut more = false;
        p.break_lines(max, |line| {
            if limit > 0 && broken.len() == limit {
                more = true;
                return false;
            }
            broken.push(line);
            true
        });
        let mut rows: Vec<Row> = Vec::with_capacity(broken.len());
        let whole = p.paragraphs.first().map(|p| p.clusters.clone());
        let cut = match whole {
            Some(c)
                if p.ellipsizes()
                    && p.cuts_inside()
                    && p.width(c.start, c.end) > avail.0 + EPSILON =>
            {
                Some(c)
            }
            _ => None,
        };
        if let Some(c) = cut {
            let line = Broken {
                paragraph: 0,
                start: c.start,
                end: c.end,
                width: p.width(c.start, c.end),
                last: true,
            };
            rows.push(Row {
                items: self.cut(p, c.start, c.end, avail.0),
                range: p.line_range(&line),
                last: true,
                ellipsis: true,
                paragraph: 0,
            });
        } else {
            let count = broken.len();
            for (k, line) in broken.iter().enumerate() {
                let mut items: Vec<Item> = (line.start..line.end).map(Item::Cluster).collect();
                let trim = p.ellipsizes()
                    && ((k + 1 == count && more) || (t.no_wrap && line.width > avail.0 + EPSILON));
                if trim {
                    self.trim_tail(p, line, &mut items, avail.0);
                }
                rows.push(Row {
                    items,
                    range: p.line_range(line),
                    last: line.last,
                    ellipsis: trim,
                    paragraph: line.paragraph,
                });
            }
        }
        let mut out = GpuiLayout {
            attachments: vec![None; t.attachments.len()],
            ..GpuiLayout::default()
        };
        let mut y = 0.0;
        for row in &rows {
            y += self.place(p, row, avail.0, y, &mut out);
        }
        TextLayout(Arc::new(out))
    }

    fn lines(&self, layout: &TextLayout) -> Vec<TextLine> {
        layout.downcast::<GpuiLayout>().map_or_else(Vec::new, |l| {
            l.lines.iter().map(|l| l.info.clone()).collect()
        })
    }

    fn attachments(&self, layout: &TextLayout) -> Vec<Option<Point<Points>>> {
        layout.downcast::<GpuiLayout>().map_or_else(Vec::new, |l| {
            l.attachments
                .iter()
                .map(|a| a.map(|(x, y)| point(Points(x), Points(y))))
                .collect()
        })
    }

    fn hit_test(&self, layout: &TextLayout, p: Point<Points>) -> TextPosition {
        layout
            .downcast::<GpuiLayout>()
            .map_or_else(TextPosition::default, |l| l.hit_test(p.x.0, p.y.0))
    }

    fn caret_rect(&self, layout: &TextLayout, position: TextPosition) -> Option<Bounds<Points>> {
        layout.downcast::<GpuiLayout>()?.caret_rect(position)
    }

    fn range_rects(&self, layout: &TextLayout, range: Range<u32>, out: &mut Vec<Bounds<Points>>) {
        let Some(l) = layout.downcast::<GpuiLayout>() else {
            return;
        };
        l.selection_rects((range.start, range.end), |x, y, w, h| {
            out.push(Bounds::new(
                point(Points(x), Points(y)),
                size(Points(w), Points(h)),
            ));
        });
    }

    fn register_font(&self, data: &[u8]) -> Result<(), String> {
        let families = font_families(data)?;
        let key = (Arc::as_ptr(&self.system) as usize, hash(data));
        let mut registered = REGISTERED.lock().unwrap_or_else(|e| e.into_inner());
        if registered.iter().any(|(s, h, _)| (*s, *h) == key) {
            return Ok(());
        }
        // GPUI's Windows text system keeps a pointer to the bytes of a font
        // it was given owned (DirectWrite's in-memory font file reference,
        // made without an owner) and frees them on return: bytes that live
        // for the process stay valid. A registered font is never
        // unregistered, and each is registered once per text system.
        let data: &'static [u8] = Box::leak(data.to_vec().into_boxed_slice());
        self.system
            .add_fonts(vec![Cow::Borrowed(data)])
            .map_err(|e| e.to_string())?;
        registered.push((key.0, key.1, families));
        crate::canvas::font_registered(data);
        FONT_GENERATION.fetch_add(1, Ordering::Release);
        Ok(())
    }
}

// --- Final layout -------------------------------------------------------------------------

/// What a line of a final layout shows, in text order.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Item {
    Cluster(u32),
    /// An ellipsis in span `span`'s font, standing for the characters from
    /// UTF-16 offset `at` on.
    Ellipsis {
        span: u16,
        at: u32,
    },
}

/// A line about to be placed.
struct Row {
    items: Vec<Item>,
    /// UTF-16 range of the text it was broken from.
    range: (u32, u32),
    /// It ends its paragraph.
    last: bool,
    /// It has an ellipsis.
    ellipsis: bool,
    paragraph: u32,
}

/// The order in which items of bidi `levels` show from left to right
/// (rule L2: every run at a level or above, from the highest level down to
/// the lowest odd one, is reversed).
fn visual_order(levels: &[u8]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..levels.len()).collect();
    let Some(&highest) = levels.iter().max() else {
        return order;
    };
    let lowest_odd = levels
        .iter()
        .copied()
        .filter(|l| l % 2 == 1)
        .min()
        .unwrap_or(highest + 1);
    let mut level = highest;
    while level >= lowest_odd && level > 0 {
        let mut i = 0;
        while i < order.len() {
            if levels[order[i]] >= level {
                let mut j = i;
                while j < order.len() && levels[order[j]] >= level {
                    j += 1;
                }
                order[i..j].reverse();
                i = j;
            } else {
                i += 1;
            }
        }
        level -= 1;
    }
    order
}

impl GpuiTextEngine {
    /// Cuts the end of `line` for an ellipsis that fits in `avail`.
    fn trim_tail(&self, p: &Prepared, line: &Broken, items: &mut Vec<Item>, avail: f32) {
        let span = p.clusters[line.start as usize..line.end as usize]
            .last()
            .map_or(p.paragraphs[line.paragraph as usize].span, |c| c.span);
        let advance = self.ellipsis(p, span).advance;
        let mut end = line.end;
        while end > line.start && p.width(line.start, end) + advance > avail + EPSILON {
            end -= 1;
        }
        while end > line.start && p.clusters[end as usize - 1].flags & SPACE != 0 {
            end -= 1;
        }
        let at = match p.clusters.get(end as usize) {
            Some(c) if end < line.end || !line.last => c.utf16,
            _ => p.paragraphs[line.paragraph as usize].utf16.end,
        };
        let span = if end > line.start {
            p.clusters[end as usize - 1].span
        } else {
            span
        };
        items.truncate((end - line.start) as usize);
        items.push(Item::Ellipsis { span, at });
    }

    /// The clusters `start..end` (one line) with the middle (or the start)
    /// cut out for an ellipsis, as many as fit in `avail`.
    fn cut(&self, p: &Prepared, start: u32, end: u32, avail: f32) -> Vec<Item> {
        let head = p.text.ellipsize == EllipsizeMode::Head;
        let n = end - start;
        let w = |a: u32, b: u32| (p.prefix[b as usize] - p.prefix[a as usize]) as f32;
        // Clusters kept before and after the ellipsis.
        let split = |keep: u32| {
            if head {
                (0, keep)
            } else {
                let front = keep.div_ceil(2);
                (front, keep - front)
            }
        };
        let span_of = |front: u32| {
            p.clusters
                .get((start + front) as usize)
                .map_or(0, |c| c.span)
        };
        let fits = |keep: u32| {
            let (front, back) = split(keep);
            let advance = self.ellipsis(p, span_of(front)).advance;
            w(start, start + front) + w(end - back, end) + advance <= avail + EPSILON
        };
        let (mut lo, mut hi) = (0, n.saturating_sub(1));
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if fits(mid) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        let (front, back) = split(lo);
        let mut items: Vec<Item> = (start..start + front).map(Item::Cluster).collect();
        items.push(Item::Ellipsis {
            span: span_of(front),
            at: p.clusters[(start + front) as usize].utf16,
        });
        items.extend((end - back..end).map(Item::Cluster));
        items
    }

    /// Places `row` at `y` in a box `avail` wide; returns its height.
    fn place(&self, p: &Prepared, row: &Row, avail: f32, y: f32, out: &mut GpuiLayout) -> f32 {
        let t = &p.text;
        let base = u8::from(p.rtl);
        // Per item: level, advance, it is trailing whitespace.
        let n = row.items.len();
        let mut levels = Vec::with_capacity(n);
        let mut advances = Vec::with_capacity(n);
        for item in &row.items {
            match *item {
                Item::Cluster(c) => {
                    let c = &p.clusters[c as usize];
                    levels.push(c.level);
                    advances.push(c.advance);
                }
                Item::Ellipsis { span, .. } => {
                    levels.push(base);
                    advances.push(self.ellipsis(p, span).advance);
                }
            }
        }
        // Whitespace at the end of a line takes the paragraph's direction
        // (rule L1) and hangs past its end.
        let mut trailing = n;
        while trailing > 0
            && matches!(row.items[trailing - 1], Item::Cluster(c) if p.clusters[c as usize].flags & SPACE != 0)
        {
            trailing -= 1;
            levels[trailing] = base;
        }
        let content: f32 = advances[..trailing].iter().sum();
        let free = avail - content;
        let justify = t.align == TextAlign::Justify && !row.last && !row.ellipsis && free > 0.0;
        // Extra space after items (justification).
        let mut extra = vec![0.0f32; n];
        if justify {
            let spaces: Vec<usize> = (0..trailing)
                .filter(|&i| matches!(row.items[i], Item::Cluster(c) if p.clusters[c as usize].flags & SPACE != 0))
                .collect();
            let cjk = row.items[..trailing]
                .iter()
                .any(|i| matches!(*i, Item::Cluster(c) if p.clusters[c as usize].flags & CJK != 0));
            if !spaces.is_empty() {
                let e = free / spaces.len() as f32;
                for i in spaces {
                    extra[i] = e;
                }
            } else if cjk && trailing > 1 {
                let e = free / (trailing - 1) as f32;
                for x in &mut extra[..trailing - 1] {
                    *x = e;
                }
            }
        }
        let order = visual_order(&levels);
        let first_box = out.boxes.len();
        let first_glyph = out.glyphs.len();
        let mut pen = 0.0f32;
        let (mut left, mut right) = (f32::INFINITY, f32::NEG_INFINITY);
        // Glyphs are placed at the baseline's 0 and moved below.
        for &i in &order {
            let w = advances[i] + extra[i];
            let x = pen;
            pen += w;
            if i < trailing {
                left = left.min(x);
                right = right.max(x + w);
            }
            match row.items[i] {
                Item::Cluster(ci) => {
                    let c = &p.clusters[ci as usize];
                    let s = &p.spans[usize::from(c.span).min(p.spans.len() - 1)];
                    let kind = if c.flags & ATTACHMENT != 0 {
                        BoxKind::Attachment
                    } else if c.flags & SPACE != 0 {
                        BoxKind::Space
                    } else {
                        BoxKind::Char
                    };
                    out.boxes.push(CBox {
                        x,
                        w,
                        at: c.utf16,
                        style: c.utf16,
                        rtl: c.level % 2 == 1,
                        kind,
                        size: s.size,
                        x_height: s.x,
                        ascent: s.ascent,
                        descent: s.descent,
                    });
                    for g in &p.glyphs[c.glyphs.0 as usize..c.glyphs.1 as usize] {
                        out.glyphs.push(Glyph {
                            x: x + g.dx,
                            y: g.dy,
                            font: g.font,
                            id: g.id,
                            size: s.size,
                            emoji: g.emoji,
                            style: c.utf16,
                        });
                    }
                }
                Item::Ellipsis { span, at } => {
                    let s = &p.spans[usize::from(span).min(p.spans.len() - 1)];
                    let e = self.ellipsis(p, span);
                    out.boxes.push(CBox {
                        x,
                        w,
                        at,
                        style: s.start,
                        rtl: p.rtl,
                        kind: BoxKind::Ellipsis,
                        size: s.size,
                        x_height: s.x,
                        ascent: s.ascent,
                        descent: s.descent,
                    });
                    for g in &e.glyphs {
                        out.glyphs.push(Glyph {
                            x: x + g.dx,
                            y: g.dy,
                            font: g.font,
                            id: g.id,
                            size: s.size,
                            emoji: g.emoji,
                            style: s.start,
                        });
                    }
                }
            }
        }
        if left > right {
            // Nothing but whitespace: where the line starts.
            let at = if p.rtl { pen } else { 0.0 };
            (left, right) = (at, at);
        }
        let width = right - left;
        let free = avail - width;
        let start_right = t.rtl || p.rtl;
        let x0 = match t.align {
            TextAlign::Left => 0.0,
            TextAlign::Right => free,
            TextAlign::Center => free / 2.0,
            TextAlign::Auto if start_right => free,
            TextAlign::Auto => 0.0,
            TextAlign::Justify if justify => 0.0,
            TextAlign::Justify if p.rtl => free,
            TextAlign::Justify => 0.0,
        };
        // Text wider than its box keeps its start in sight.
        let x0 = if free < 0.0 {
            if start_right { free } else { 0.0 }
        } else {
            x0
        };
        let shift = x0 - left;
        let (start, end) = row.range;
        let (ascent, descent) = p.line_box(start, end);
        let baseline = y + ascent;
        for b in &mut out.boxes[first_box..] {
            b.x += shift;
        }
        for g in &mut out.glyphs[first_glyph..] {
            g.x += shift;
            g.y += baseline;
        }
        // Attachments by their `verticalAlign`; cap and x height of the
        // largest font.
        let mut largest: Option<&SpanBox> = None;
        for (item, b) in order
            .iter()
            .map(|&i| row.items[i])
            .zip(&out.boxes[first_box..])
        {
            let Item::Cluster(ci) = item else { continue };
            let c = &p.clusters[ci as usize];
            if c.flags & ATTACHMENT != 0 {
                if let Some(k) = t.attachments.iter().position(|a| a.index == c.utf16) {
                    let (top, _, _) = p.attachment_box(&t.attachments[k]);
                    out.attachments[k] = Some((b.x, baseline - top));
                }
                continue;
            }
            let s = &p.spans[usize::from(c.span).min(p.spans.len() - 1)];
            if largest.is_none_or(|l| s.size > l.size) {
                largest = Some(s);
            }
        }
        let largest = largest.unwrap_or(
            &p.spans[usize::from(p.paragraphs[row.paragraph as usize].span).min(p.spans.len() - 1)],
        );
        out.lines.push(Line {
            info: TextLine {
                text: String::new(),
                start,
                end,
                x: Points(x0),
                y: Points(y),
                width: Points(width),
                height: Points(ascent + descent),
                ascender: Points(ascent),
                descender: Points(descent),
                cap_height: Points(largest.cap),
                x_height: Points(largest.x),
            },
            baseline,
            boxes: first_box..out.boxes.len(),
        });
        ascent + descent
    }
}

/// What a box shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoxKind {
    Char,
    Space,
    Attachment,
    Ellipsis,
}

/// A cluster as placed: its box on its line (content coordinates).
#[derive(Debug, Clone, Copy)]
struct CBox {
    x: f32,
    w: f32,
    /// UTF-16 offset of its first character (an ellipsis: of the first
    /// character it stands for).
    at: u32,
    /// UTF-16 offset whose span styles it.
    style: u32,
    /// Its characters run right to left.
    rtl: bool,
    kind: BoxKind,
    /// Font size and x height of its span (decorations).
    size: f32,
    x_height: f32,
    /// Its font's ascent and descent (span backgrounds).
    ascent: f32,
    descent: f32,
}

/// One glyph to paint.
#[derive(Debug, Clone, Copy)]
struct Glyph {
    /// Origin on the baseline (content coordinates).
    x: f32,
    y: f32,
    font: FontId,
    id: GlyphId,
    size: f32,
    emoji: bool,
    /// UTF-16 offset whose span colors it.
    style: u32,
}

/// One line of a final layout.
#[derive(Debug, Clone)]
struct Line {
    info: TextLine,
    baseline: f32,
    /// Its boxes in [`GpuiLayout::boxes`], left to right.
    boxes: Range<usize>,
}

/// The final layout of a text (plain data, sent to the main thread).
#[derive(Debug, Clone, Default)]
pub(crate) struct GpuiLayout {
    lines: Vec<Line>,
    boxes: Vec<CBox>,
    glyphs: Vec<Glyph>,
    /// Attachment top-left corners, in text order.
    attachments: Vec<Option<(f32, f32)>>,
}

impl GpuiLayout {
    /// The line at height `y`, if any.
    fn line_at(&self, y: f32) -> Option<&Line> {
        self.lines
            .iter()
            .find(|l| y >= l.info.y.0 && y < (l.info.y + l.info.height).0)
    }

    /// The UTF-16 offset of the character at `(x, y)` (content
    /// coordinates).
    fn char_at(&self, x: f32, y: f32) -> Option<u32> {
        let line = self.line_at(y)?;
        self.boxes[line.boxes.clone()]
            .iter()
            .find(|b| x >= b.x && x < b.x + b.w)
            .map(|b| b.at)
    }

    /// The boxes of `line`.
    fn line_boxes(&self, line: &Line) -> &[CBox] {
        self.boxes.get(line.boxes.clone()).unwrap_or_default()
    }

    /// Whether line `i` was cut by wrapping rather than by a break
    /// character: the next line then starts where it ends (a break
    /// character sits between the lines of a hard break).
    fn wraps(&self, i: usize) -> bool {
        match (self.lines.get(i), self.lines.get(i + 1)) {
            (Some(line), Some(next)) => next.info.start == line.info.end,
            _ => false,
        }
    }

    /// The index of the line the caret at `position` is on (the rules of
    /// [`nsh_core::TextPosition::line`], without copying the lines).
    fn line_of(&self, position: TextPosition) -> Option<usize> {
        position.line_in(self.lines.iter().map(|l| l.info.start..l.info.end))
    }

    /// The caret position nearest `(x, y)` in content coordinates: on the
    /// line at that height (the first above the text, the last below it),
    /// at the box edge nearest x. At a wrapped line's end it is
    /// [`Affinity::Upstream`], so the caret stays on that line.
    fn hit_test(&self, x: f32, y: f32) -> TextPosition {
        let Some((i, line)) = self
            .lines
            .iter()
            .position(|l| y < (l.info.y + l.info.height).0)
            .or(self.lines.len().checked_sub(1))
            .and_then(|i| Some((i, self.lines.get(i)?)))
        else {
            return TextPosition::default();
        };
        let boxes = self.line_boxes(line);
        // Distance, the box's offset, the caret goes after it.
        let mut best: Option<(f32, u32, bool)> = None;
        for b in boxes {
            for (edge, right) in [(b.x, false), (b.x + b.w, true)] {
                let d = (x - edge).abs();
                if best.is_none_or(|best| d < best.0) {
                    best = Some((d, b.at, right != b.rtl));
                }
            }
        }
        let offset = match best {
            None => line.info.start,
            Some((_, at, false)) => at,
            Some((_, at, true)) => boxes
                .iter()
                .map(|b| b.at)
                .filter(|&i| i > at)
                .min()
                .unwrap_or(line.info.end),
        };
        let affinity = if offset == line.info.end && self.wraps(i) {
            Affinity::Upstream
        } else {
            Affinity::Downstream
        };
        TextPosition::new(offset, affinity)
    }

    /// The caret at `position` (content coordinates): no width, as high as
    /// its line, at the edge of the box that starts at the offset or, past
    /// the last character of the line, at the end of the last box before it.
    fn caret_rect(&self, position: TextPosition) -> Option<Bounds<Points>> {
        let line = self.lines.get(self.line_of(position)?)?;
        let o = position.offset.max(line.info.start).min(line.info.end);
        let boxes = self.line_boxes(line);
        let x = if let Some(b) = boxes.iter().find(|b| b.at == o) {
            // The edge the characters start at.
            if b.rtl { b.x + b.w } else { b.x }
        } else if let Some(b) = boxes.iter().filter(|b| b.at < o).max_by_key(|b| b.at) {
            // The edge they end at.
            if b.rtl { b.x } else { b.x + b.w }
        } else {
            line.info.x.0
        };
        Some(Bounds::new(
            point(Points(x), line.info.y),
            size(Points::ZERO, line.info.height),
        ))
    }

    /// Calls `f(x, y, width, height, radius, color)` with the boxes
    /// (content coordinates) of the span backgrounds of `text`.
    fn background_rects(
        &self,
        text: &AttributedText,
        mut f: impl FnMut(f32, f32, f32, f32, f32, Color),
    ) {
        for line in &self.lines {
            let pieces = self.boxes[line.boxes.clone()].iter().map(|b| match b.kind {
                BoxKind::Attachment => nsh_core::LinePiece {
                    x: Points(b.x),
                    width: Points(b.w),
                    background: text.background_at(b.style),
                    ascent: Points::ZERO,
                    descent: Points::ZERO,
                },
                _ => nsh_core::LinePiece {
                    x: Points(b.x),
                    width: Points(b.w),
                    background: text.background_at(b.style),
                    ascent: Points(b.ascent),
                    descent: Points(b.descent),
                },
            });
            let clip = (line.info.x, line.info.x + line.info.width);
            nsh_core::BackgroundBox::join(pieces, clip, |b| {
                let top = line.baseline - b.ascent.0;
                f(
                    b.x.0,
                    top,
                    b.width.0,
                    (b.ascent + b.descent).0,
                    b.radius().0,
                    b.background.color,
                );
            });
        }
    }

    /// Calls `f(x, y, width, height)` with the rectangles (content
    /// coordinates) that highlight the characters of `range`: per line,
    /// the spans of selected boxes, line high.
    fn selection_rects(&self, (a, b): (u32, u32), mut f: impl FnMut(f32, f32, f32, f32)) {
        for line in &self.lines {
            let (y, h) = (line.info.y.0, line.info.height.0);
            let mut current: Option<(f32, f32)> = None;
            for bx in &self.boxes[line.boxes.clone()] {
                if bx.kind == BoxKind::Ellipsis || bx.at < a || bx.at >= b {
                    continue;
                }
                let (x0, x1) = (bx.x, bx.x + bx.w);
                current = match current {
                    Some((c0, c1)) if x0 <= c1 + 0.5 => Some((c0, c1.max(x1))),
                    Some((c0, c1)) => {
                        f(c0, y, c1 - c0, h);
                        Some((x0, x1))
                    }
                    None => Some((x0, x1)),
                };
            }
            if let Some((c0, c1)) = current {
                f(c0, y, c1 - c0, h);
            }
        }
    }
}

// --- Drawing --------------------------------------------------------------------------------

/// What a text view draws.
pub(crate) struct DrawnText {
    /// What it says (spans, colors).
    pub(crate) text: Arc<AttributedText>,
    /// The engine's layout of it.
    pub(crate) layout: TextLayout,
    /// Where the layout goes inside the view.
    pub(crate) content: nsh_core::Bounds<Points>,
    /// The selection of `selectable` text, kept across new content.
    selection: Option<Rc<Selection>>,
    /// The part of the selection of the selection area around it that is
    /// this text's ([`crate::selection_area`]).
    pub(crate) area_range: Option<(u32, u32)>,
}

/// `Text`: a text view's content changed.
pub(crate) fn set(
    view: &NshView,
    text: &Arc<AttributedText>,
    layout: &TextLayout,
    content: nsh_core::Bounds<Points>,
) {
    let old = view.state_mut().text.take();
    let was = old.as_ref().is_some_and(|o| o.text.is_selectable());
    // The area's selection is checked against the new content once the
    // batch is applied (`selection_area::batch_applied`).
    let area_range = old
        .as_ref()
        .filter(|o| o.text.text == text.text)
        .and_then(|o| o.area_range);
    let selection = match old.and_then(|o| o.selection.map(|s| (s, o.text))) {
        Some((s, old)) if text.is_selectable() => {
            // Offsets into other text mean nothing.
            if old.text != text.text {
                s.range.set(None);
            }
            Some(s)
        }
        Some(_) => {
            forget_selected(view);
            None
        }
        None if text.is_selectable() => Some(Rc::new(Selection::default())),
        None => None,
    };
    view.state_mut().text = Some(DrawnText {
        text: text.clone(),
        layout: layout.clone(),
        content,
        selection,
        area_range,
    });
    if was != text.is_selectable() {
        // The I-beam.
        crate::input::style_changed(view);
    }
    view.changed();
}

/// The selection highlight's color: `selectionColor` or the system's
/// accent blue, at about 30% (as iOS tints selections).
fn selection_tint(text: &AttributedText) -> Color {
    text.selection_color
        .unwrap_or(Color::rgba(0x35, 0x84, 0xe4, 0xff))
        .with_alpha(0.3)
}

/// A glyph ready to paint: window origin, font, glyph, size, color (`None`
/// for an emoji, painted in its own colors).
type Painted = (
    gpui::Point<gpui::Pixels>,
    FontId,
    GlyphId,
    gpui::Pixels,
    Option<gpui::Hsla>,
);

/// Paints `glyphs`.
fn paint_glyphs(cx: &mut DrawCx<'_>, mut glyphs: Vec<Painted>) {
    // GPUI clips glyphs to rectangles only: under a rounded or rotated
    // clip, a glyph shows when its middle (above the baseline) does.
    if cx.has_clip_polygon() {
        glyphs.retain(|(origin, _, _, size, _)| {
            let s = f32::from(*size);
            cx.shows(
                f32::from(origin.x) + 0.3 * s,
                f32::from(origin.y) - 0.35 * s,
            )
        });
    }
    if glyphs.is_empty() {
        return;
    }
    cx.paint(|window, _| {
        for (origin, font, id, size, color) in glyphs {
            let result = match color {
                Some(c) => window.paint_glyph(origin, font, id, size, c),
                None => window.paint_emoji(origin, font, id, size),
            };
            if let Err(err) = result {
                log::debug!("text: cannot paint a glyph: {err}");
            }
        }
    });
}

/// Draws a text view's text shadow (view coordinates set on `cx`): before
/// the view's content is clipped to its bounds, as a shadow spreads past
/// them.
pub(crate) fn draw_shadow(cx: &mut DrawCx<'_>, state: &ViewState) {
    let Some(drawn) = &state.text else { return };
    let Some(shadow) = drawn.text.shadow else {
        return;
    };
    let Some(layout) = drawn.layout.downcast::<GpuiLayout>() else {
        return;
    };
    if shadow.color.0 & 0xff == 0 || layout.glyphs.is_empty() || cx.culled() {
        return;
    }
    let (ox, oy) = (
        drawn.content.origin.x.0 + shadow.offset_x.0,
        drawn.content.origin.y.0 + shadow.offset_y.0,
    );
    let k = cx.transform_scale();
    // GPUI blurs no glyphs: a blurred shadow is the glyphs painted on
    // rings out to the blur's radius, each faint, which spreads them as a
    // blur does.
    let mut offsets = vec![(0.0f32, 0.0f32)];
    let radius = shadow.radius.0;
    if radius > 0.0 {
        let rings = [(0.25, 6), (0.5, 10), (0.75, 14), (1.0, 18)];
        for (r, count) in rings {
            let r = r * radius * 0.8;
            for i in 0..count {
                let a = (i as f32 + r) / count as f32 * std::f32::consts::TAU;
                offsets.push((r * a.cos(), r * a.sin()));
            }
        }
    }
    let mut color = cx.color(shadow.color);
    if offsets.len() > 1 {
        // Where all copies overlap the shadow has its own alpha, and it
        // fades out to the radius, as a blur's falloff.
        color.a = 1.0 - (1.0 - color.a.min(0.999)).powf(1.0 / offsets.len() as f32);
    }
    let mut glyphs = Vec::with_capacity(layout.glyphs.len() * offsets.len());
    for &(dx, dy) in &offsets {
        for g in &layout.glyphs {
            let o = cx.map(ox + dx + g.x, oy + dy + g.y);
            glyphs.push((o, g.font, g.id, px(g.size * k), Some(color)));
        }
    }
    paint_glyphs(cx, glyphs);
    if radius <= 0.0 {
        decorate(cx, &drawn.text, layout, ox, oy, Some(shadow.color));
    }
}

/// Draws a text view's text (view coordinates set on `cx`).
pub(crate) fn draw(cx: &mut DrawCx<'_>, state: &ViewState) {
    let Some(drawn) = &state.text else { return };
    let Some(layout) = drawn.layout.downcast::<GpuiLayout>() else {
        return;
    };
    if cx.culled() {
        return;
    }
    let text = &drawn.text;
    let (ox, oy) = (drawn.content.origin.x.0, drawn.content.origin.y.0);
    if text.has_backgrounds() {
        layout.background_rects(text, |x, y, w, h, r, color| {
            cx.fill_rect(crate::geom::rect(ox + x, oy + y, w, h), [r; 4], color);
        });
    }
    if let Some(range) = drawn
        .selection
        .as_ref()
        .and_then(|s| s.range.get())
        .or(drawn.area_range)
    {
        let tint = selection_tint(text);
        layout.selection_rects(range, |x, y, w, h| {
            cx.fill_rect(crate::geom::rect(ox + x, oy + y, w, h), [0.0; 4], tint);
        });
    }
    if layout.boxes.is_empty() {
        return;
    }
    let k = cx.transform_scale();
    let default = ResolvedTextStyle::default();
    let style = |index: u32| {
        text.spans
            .get(span_at(&text.spans, index))
            .map_or(&default, |s| &s.style)
    };
    let animated = state.anim.color;
    let mut glyphs = Vec::with_capacity(layout.glyphs.len());
    for g in &layout.glyphs {
        let o = cx.map(ox + g.x, oy + g.y);
        let color = if g.emoji {
            None
        } else {
            let c = animated.unwrap_or(style(g.style).color);
            if c.0 & 0xff == 0 {
                continue;
            }
            Some(cx.color(c))
        };
        glyphs.push((o, g.font, g.id, px(g.size * k), color));
    }
    paint_glyphs(cx, glyphs);
    decorate(cx, text, layout, ox, oy, animated);
}

/// Draws the underlines and strikethroughs of `layout` at `(ox, oy)`, in
/// the spans' colors (or all in `over`): one stroke per run of boxes in one
/// span on a line.
///
/// Thicknesses, gaps and offsets are whole device pixels (at least one): a
/// sub-pixel underline would blur the two lines of `double` into one, and
/// dots and waves into a smudge.
fn decorate(
    cx: &mut DrawCx<'_>,
    text: &AttributedText,
    layout: &GpuiLayout,
    ox: f32,
    oy: f32,
    over: Option<Color>,
) {
    if !text
        .spans
        .iter()
        .any(|s| s.style.decoration.underline || s.style.decoration.line_through)
    {
        return;
    }
    let px1 = 1.0 / (cx.scale * cx.transform_scale()).max(0.01);
    for line in &layout.lines {
        let boxes = &layout.boxes[line.boxes.clone()];
        let mut i = 0;
        while i < boxes.len() {
            let b = boxes[i];
            if b.kind == BoxKind::Attachment {
                i += 1;
                continue;
            }
            let span = span_at(&text.spans, b.style);
            let mut j = i + 1;
            while j < boxes.len()
                && boxes[j].kind != BoxKind::Attachment
                && span_at(&text.spans, boxes[j].style) == span
            {
                j += 1;
            }
            // Whitespace hanging past the line's end is not decorated.
            let x0 = boxes[i].x.max(line.info.x.0);
            let x1 = (boxes[j - 1].x + boxes[j - 1].w).min((line.info.x + line.info.width).0);
            if x1 > x0
                && let Some(s) = text.spans.get(span)
            {
                stroke(
                    cx,
                    &s.style,
                    (ox + x0, x1 - x0),
                    oy + line.baseline,
                    (b.size, b.x_height),
                    over,
                    px1,
                );
            }
            i = j;
        }
    }
}

/// Draws the decorations of `style` over `(x, width)` at `baseline`, for a
/// font of `(size, x height)`; `px1` is one device pixel.
fn stroke(
    cx: &mut DrawCx<'_>,
    style: &ResolvedTextStyle,
    (x, width): (f32, f32),
    baseline: f32,
    (size, x_height): (f32, f32),
    over: Option<Color>,
    px1: f32,
) {
    let d = style.decoration;
    if !d.underline && !d.line_through || width <= 0.0 {
        return;
    }
    let color = over.unwrap_or(style.decoration_color.unwrap_or(style.color));
    if color.0 & 0xff == 0 {
        return;
    }
    let pixels = |v: f32| (v / px1).round().max(1.0) * px1;
    // About what fonts' tables say (a twentieth of an em).
    let t = pixels(style.decoration_thickness.map_or(size / 18.0, |t| t.0));
    let mut line = |top: f32| {
        let top = (top / px1).round() * px1;
        let mid = top + t / 2.0;
        match style.decoration_style {
            DecorationStyle::Solid => {
                cx.fill_rect(crate::geom::rect(x, top, width, t), [0.0; 4], color);
            }
            DecorationStyle::Double => {
                // Two lines of the thickness, as far apart (as CSS),
                // centered where the single line goes.
                for y in [top - t, top + t] {
                    cx.fill_rect(crate::geom::rect(x, y, width, t), [0.0; 4], color);
                }
            }
            DecorationStyle::Dashed => {
                let (dash, gap) = (3.0 * t, 2.0 * t);
                let mut at = x;
                while at < x + width {
                    let w = dash.min(x + width - at);
                    cx.fill_rect(crate::geom::rect(at, top, w, t), [0.0; 4], color);
                    at += dash + gap;
                }
            }
            DecorationStyle::Dotted => {
                // Round dots, a dot apart; thin dots stay square: round
                // ones would only be antialiasing.
                let radius = if t >= 3.0 * px1 { t / 2.0 } else { 0.0 };
                let mut at = x;
                while at + t <= x + width + 0.01 {
                    cx.fill_rect(crate::geom::rect(at, top, t, t), [radius; 4], color);
                    at += 2.0 * t;
                }
            }
            DecorationStyle::Wavy => {
                let amplitude = pixels(t.max(1.5 * px1));
                let step = amplitude * 2.5;
                // A sine, stroked.
                let samples = ((width / step) * 8.0).ceil().max(2.0) as usize;
                let mut path = gpui::PathBuilder::stroke(px(t * cx.transform_scale()));
                for s in 0..=samples {
                    let px_ = x + width * s as f32 / samples as f32;
                    let phase = (px_ - x) / step * std::f32::consts::PI;
                    let p = cx.map(px_, mid - amplitude * phase.sin());
                    if s == 0 {
                        path.move_to(p);
                    } else {
                        path.line_to(p);
                    }
                }
                let c = cx.color(color);
                match path.build() {
                    Ok(path) => cx.paint(|window, _| window.paint_path(path, c)),
                    Err(err) => log::debug!("text: no wavy line: {err}"),
                }
            }
        }
    };
    if d.underline {
        let offset = style
            .underline_offset
            .map_or_else(|| (size * 0.1).max(px1), |o| o.0);
        line(baseline + offset);
    }
    if d.line_through {
        line(baseline - x_height / 2.0 - t / 2.0);
    }
}

/// Paints the view's glyphs all in `color` (with the pass's filters and
/// opacity), moved by each of `offsets` (view coordinates): the
/// silhouette of the text, which shadows of the content are drawn with
/// ([`crate::decor::draw_content_shadow`]).
pub(crate) fn draw_silhouette(
    cx: &mut DrawCx<'_>,
    state: &ViewState,
    offsets: &[(f32, f32)],
    color: nsh_core::Color,
) {
    let Some(drawn) = &state.text else { return };
    let Some(layout) = drawn.layout.downcast::<GpuiLayout>() else {
        return;
    };
    if cx.culled() || color.is_transparent() {
        return;
    }
    let k = cx.transform_scale();
    let (ox, oy) = (drawn.content.origin.x.0, drawn.content.origin.y.0);
    let tint = Some(cx.color(color));
    let mut glyphs = Vec::with_capacity(layout.glyphs.len() * offsets.len());
    // Emoji draw in their own colors: they cast no silhouette.
    for g in layout.glyphs.iter().filter(|g| !g.emoji) {
        for &(dx, dy) in offsets {
            let o = cx.map(ox + g.x + dx, oy + g.y + dy);
            glyphs.push((o, g.font, g.id, px(g.size * k), tint));
        }
    }
    paint_glyphs(cx, glyphs);
}

/// The first rectangle (view coordinates: x, y, width, height) the
/// characters `start..end` of the text view with `state` cover (the test
/// agent's spans).
pub(crate) fn range_rect(state: &ViewState, start: u32, end: u32) -> Option<(f32, f32, f32, f32)> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<GpuiLayout>()?;
    let (cx, cy) = (drawn.content.origin.x.0, drawn.content.origin.y.0);
    let mut first = None;
    layout.selection_rects((start, end), |x, y, w, h| {
        first.get_or_insert((cx + x, cy + y, w, h));
    });
    first
}

/// Draws every visual fragment of the native inline keyboard target.
pub(crate) fn draw_focus(cx: &mut DrawCx<'_>, view: &NshView, state: &ViewState) {
    let Some(link) = crate::text_input::focused_link(view) else {
        return;
    };
    let Some(drawn) = &state.text else { return };
    let Some(layout) = drawn.layout.downcast::<GpuiLayout>() else {
        return;
    };
    let (ox, oy) = (drawn.content.origin.x.0, drawn.content.origin.y.0);
    let color = drawn
        .text
        .span_at(link.start)
        .map_or(ResolvedTextStyle::default().color, |span| span.style.color);
    layout.selection_rects((link.start, link.end), |x, y, w, h| {
        for (x, y, w, h) in [
            (ox + x, oy + y, w, 1.0),
            (ox + x, oy + y + h - 1.0, w, 1.0),
            (ox + x, oy + y, 1.0, h),
            (ox + x + w - 1.0, oy + y, 1.0, h),
        ] {
            cx.fill_rect(crate::geom::rect(x, y, w, h), [0.0; 4], color);
        }
    });
}

/// Union of all visual fragments of a span, in its view's coordinates.
pub(crate) fn range_bounds(
    state: &ViewState,
    start: u32,
    end: u32,
) -> Option<(f32, f32, f32, f32)> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<GpuiLayout>()?;
    let mut bounds: Option<(f32, f32, f32, f32)> = None;
    layout.selection_rects((start, end), |x, y, w, h| {
        bounds = Some(match bounds {
            Some((x0, y0, x1, y1)) => (x0.min(x), y0.min(y), x1.max(x + w), y1.max(y + h)),
            None => (x, y, x + w, y + h),
        });
    });
    bounds.map(|(x0, y0, x1, y1)| {
        (
            drawn.content.origin.x.0 + x0,
            drawn.content.origin.y.0 + y0,
            x1 - x0,
            y1 - y0,
        )
    })
}

/// The UTF-16 offset of the character at `(x, y)` (view coordinates), if
/// any (presses on nested text links).
pub(crate) fn char_at(state: &ViewState, x: f32, y: f32) -> Option<u32> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<GpuiLayout>()?;
    layout.char_at(x - drawn.content.origin.x.0, y - drawn.content.origin.y.0)
}

/// The caret position (UTF-16 offset) nearest `(x, y)` (view
/// coordinates): where a click there puts it.
pub(crate) fn caret_at(state: &ViewState, x: f32, y: f32) -> Option<u32> {
    let drawn = state.text.as_ref()?;
    let layout = drawn.layout.downcast::<GpuiLayout>()?;
    Some(
        layout
            .hit_test(x - drawn.content.origin.x.0, y - drawn.content.origin.y.0)
            .offset,
    )
}

// --- Selection ----------------------------------------------------------------------

/// How far (points) the mouse moves on selectable text before a drag
/// selects: past input's press slop where the press would fire (a link, an
/// `onPress`), so a click never does both.
pub(crate) const SELECT_SLOP: f32 = 3.0;
/// The same over a press target.
pub(crate) const SELECT_SLOP_PRESS: f32 = 10.0;

/// What a drag extends the selection by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Unit {
    #[default]
    Char,
    Word,
    Paragraph,
}

/// The range selection of a `selectable` text view, desktop style: a mouse
/// drag selects characters, a double click words and a triple click the
/// paragraph (and drags on by them), Shift+click extends, Ctrl+C (Cmd+C on
/// macOS) copies, Ctrl+A selects all, Escape or a press anywhere else
/// clears. Offsets are UTF-16, as the layout's clusters.
#[derive(Default)]
pub(crate) struct Selection {
    /// The selected range (`start < end`).
    range: Cell<Option<(u32, u32)>>,
    /// The range a drag started from (a caret, the word or paragraph
    /// pressed), which stays selected while it extends.
    anchor: Cell<(u32, u32)>,
    unit: Cell<Unit>,
    /// Where the button went down, while it is down.
    down: Cell<Option<(f32, f32)>>,
    /// The pressed button moved far enough to select.
    dragging: Cell<bool>,
    /// The press began over a press target (links, `onPress`).
    over_press: Cell<bool>,
}

thread_local! {
    /// The view whose text has a selection, with its surface's key: one
    /// at a time, as on desktops.
    static SELECTED: RefCell<Option<(u64, NshView)>> = const { RefCell::new(None) };
}

/// The selection of `view`'s text, if it is selectable.
fn view_selection(view: &NshView) -> Option<Rc<Selection>> {
    view.state().text.as_ref()?.selection.clone()
}

/// `view` no longer has selectable text.
fn forget_selected(view: &NshView) {
    SELECTED.with_borrow_mut(|s| {
        if s.as_ref().is_some_and(|(_, v)| v == view) {
            *s = None;
        }
    });
}

/// Sets `view`'s selection (`None` or empty clears it).
fn select(surface: u64, view: &NshView, range: Option<(u32, u32)>) {
    let Some(s) = view_selection(view) else {
        return;
    };
    let range = range.filter(|(a, b)| a < b);
    if s.range.replace(range) == range {
        return;
    }
    view.changed();
    if range.is_some() {
        crate::selection_area::clear_all();
    }
    let previous = SELECTED.with_borrow_mut(|selected| match range {
        Some(_) => selected.replace((surface, view.clone())),
        None => {
            if selected.as_ref().is_some_and(|(_, v)| v == view) {
                *selected = None;
            }
            None
        }
    });
    // One selection at a time.
    if let Some((_, other)) = previous
        && other != *view
        && let Some(s) = view_selection(&other)
        && s.range.take().is_some()
    {
        other.changed();
    }
}

/// Clears the selection of a single text, if there is one (a selection
/// area selects: one selection at a time).
pub(crate) fn clear_selection() {
    let Some((_, view)) = SELECTED.with_borrow_mut(Option::take) else {
        return;
    };
    if let Some(s) = view_selection(&view)
        && s.range.take().is_some()
    {
        view.changed();
    }
}

/// True when the text can be selected (`selectable`).
pub(crate) fn selectable(state: &ViewState) -> bool {
    state.text.as_ref().is_some_and(|t| t.text.is_selectable())
}

/// A press anywhere in the window at `(x, y)` (root coordinates), before
/// the views get it: clears a selection the press is not on.
pub(crate) fn window_pressed(surface: &crate::surface::Surface, x: f32, y: f32) {
    let Some(view) = SELECTED.with_borrow(|s| {
        s.as_ref()
            .filter(|(key, _)| *key == surface.key())
            .map(|(_, v)| v.clone())
    }) else {
        return;
    };
    let inside = view
        .to_root()
        .and_then(|m| m.unproject(x, y))
        .is_some_and(|(lx, ly)| {
            let s = view.state();
            lx >= 0.0 && ly >= 0.0 && lx < s.frame.size.width.0 && ly < s.frame.size.height.0
        });
    if !inside {
        select(surface.key(), &view, None);
    }
}

/// A pointer event on selectable text `view` (selecting with the mouse;
/// view coordinates); true when handled. A press over a link or a view
/// with press listeners is left to them (false) and only selects once
/// dragged past a larger slop.
pub(crate) fn pointer(
    surface: &Rc<crate::surface::Surface>,
    view: &NshView,
    event: &crate::view::ItemPointer,
) -> bool {
    use crate::input::PointerKind;
    let Some(s) = view_selection(view) else {
        return false;
    };
    let key = surface.key();
    match event.kind {
        PointerKind::Down => {
            s.down.set(Some((event.x, event.y)));
            pressed(
                key,
                view,
                &s,
                event.clicks,
                event.x,
                event.y,
                event.modifiers.shift,
            );
            !s.over_press.get()
        }
        PointerKind::Move => {
            let Some((x0, y0)) = s.down.get() else {
                return false;
            };
            dragged(key, view, &s, event.x - x0, event.y - y0, event.x, event.y);
            s.dragging.get()
        }
        PointerKind::Up | PointerKind::Cancel => {
            let was = s.down.take().is_some() && s.dragging.replace(false);
            if was {
                set_primary(view);
            }
            was
        }
        PointerKind::Leave => false,
    }
}

/// A press of the primary button (`clicks`: the click count).
fn pressed(key: u64, view: &NshView, s: &Selection, clicks: u32, x: f32, y: f32, shift: bool) {
    let (caret, char_index, text, over_press) = {
        let state = view.state();
        let Some(drawn) = &state.text else { return };
        let Some(layout) = drawn.layout.downcast::<GpuiLayout>() else {
            return;
        };
        let (lx, ly) = (x - drawn.content.origin.x.0, y - drawn.content.origin.y.0);
        let char_index = layout.char_at(lx, ly);
        let press = [EventKind::Press, EventKind::LongPress, EventKind::PressDown];
        let over_press = press.iter().any(|&k| state.events.contains(k))
            || char_index
                .and_then(|i| drawn.text.link_at(i))
                .is_some_and(|l| press.iter().any(|&k| l.events.contains(k)));
        (
            layout.hit_test(lx, ly).offset,
            char_index,
            drawn.text.clone(),
            over_press,
        )
    };
    s.over_press.set(over_press);
    let at = char_index.unwrap_or(caret);
    match clicks {
        0 | 1 if shift => {
            // Extends from the end away from the press.
            let anchor = match s.range.get() {
                Some((a, b)) if caret <= a => (b, b),
                Some((a, _)) => (a, a),
                None => (caret, caret),
            };
            s.anchor.set(anchor);
            s.unit.set(Unit::Char);
            s.dragging.set(true);
            select(
                key,
                view,
                Some(extend(&text.text, anchor, caret, Unit::Char)),
            );
        }
        0 | 1 => {
            s.anchor.set((caret, caret));
            s.unit.set(Unit::Char);
            s.dragging.set(false);
            select(key, view, None);
        }
        n => {
            let unit = if n == 2 { Unit::Word } else { Unit::Paragraph };
            let range = unit_at(&text.text, at, unit);
            s.anchor.set(range);
            s.unit.set(unit);
            s.dragging.set(true);
            select(key, view, Some(range));
        }
    }
}

/// The pressed mouse moved by `(dx, dy)` to `(x, y)` (view coordinates).
fn dragged(key: u64, view: &NshView, s: &Selection, dx: f32, dy: f32, x: f32, y: f32) {
    if !s.dragging.get() {
        let slop = if s.over_press.get() {
            SELECT_SLOP_PRESS
        } else {
            SELECT_SLOP
        };
        if dx.hypot(dy) <= slop {
            return;
        }
        s.dragging.set(true);
    }
    let range = {
        let state = view.state();
        let Some(drawn) = &state.text else { return };
        let Some(layout) = drawn.layout.downcast::<GpuiLayout>() else {
            return;
        };
        let caret = layout
            .hit_test(x - drawn.content.origin.x.0, y - drawn.content.origin.y.0)
            .offset;
        extend(&drawn.text.text, s.anchor.get(), caret, s.unit.get())
    };
    select(key, view, Some(range));
}

/// A finished drag sets the primary selection (Linux: middle-click
/// pastes it).
fn set_primary(view: &NshView) {
    #[cfg(target_os = "linux")]
    if let Some(text) = selected_text(view).filter(|t| !t.is_empty()) {
        crate::rt::on_app(move |cx| cx.write_to_primary(gpui::ClipboardItem::new_string(text)));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = view;
}

/// A right click on selectable text `view`: Copy (its selection) and
/// Select All.
pub(crate) fn context_menu(surface: &Rc<crate::surface::Surface>, view: &NshView) {
    use nsh_core::desktop::MenuRole;

    use crate::chrome::LocalItem;
    let selected = selected_text(view).is_some_and(|t| !t.is_empty());
    let (copy, all) = (view.clone(), view.clone());
    crate::chrome::popup_actions(
        surface,
        vec![
            LocalItem::Item {
                role: Some(MenuRole::Copy),
                label: "",
                enabled: selected,
                action: Rc::new(move |_| {
                    if let Some(text) = selected_text(&copy) {
                        crate::system::set_clipboard_text(&text);
                    }
                }),
            },
            LocalItem::Item {
                role: Some(MenuRole::SelectAll),
                label: "",
                enabled: true,
                action: Rc::new(move |s| select_all(s.key(), &all)),
            },
        ],
    );
}

/// The selected text of `view`, without attachments' placeholders.
fn selected_text(view: &NshView) -> Option<String> {
    let (a, b) = view_selection(view)?.range.get()?;
    let state = view.state();
    let text: Vec<u16> = state.text.as_ref()?.text.text.encode_utf16().collect();
    let part = text.get(a as usize..(b as usize).min(text.len()))?;
    Some(String::from_utf16_lossy(part).replace(ATTACHMENT_CHAR, ""))
}

/// Selects all of `view`'s text.
fn select_all(surface: u64, view: &NshView) {
    let len = view.state().text.as_ref().map_or(0, |t| t.text.len_utf16());
    select(surface, view, Some((0, len)));
}

/// The retained text selection owner, independent of its changing range.
pub(crate) fn keyboard_owner(surface: &crate::surface::Surface) -> Option<NshView> {
    SELECTED.with_borrow(|selected| {
        selected
            .as_ref()
            .filter(|(key, view)| *key == surface.key() && view.attached())
            .map(|(_, view)| view.clone())
    })
}

/// Keys for the text selection (Ctrl+C or Ctrl+Insert, Ctrl+A, Escape;
/// Cmd on macOS); true when handled.
pub(crate) fn key(surface: &Rc<crate::surface::Surface>, event: &crate::input::KeyEvent) -> bool {
    const VK_A: u16 = 0x41;
    const VK_C: u16 = 0x43;
    const VK_INSERT: u16 = 0x2D;
    const VK_ESCAPE: u16 = 0x1B;
    if !event.down {
        return false;
    }
    let Some(view) = keyboard_owner(surface) else {
        return false;
    };
    let m = event.modifiers;
    let command = if surface.environment.get().uses_apple_keys() {
        m.meta && !m.ctrl
    } else {
        m.ctrl
    } && !m.alt;
    match event.vk {
        VK_C | VK_INSERT if command => {
            if let Some(text) = selected_text(&view) {
                crate::system::set_clipboard_text(&text);
            } else {
                return crate::keymap::empty_copy_consumed(surface, event);
            }
        }
        VK_A if command => select_all(surface.key(), &view),
        VK_ESCAPE => select(surface.key(), &view, None),
        _ => return false,
    }
    true
}

/// The selection from `anchor` (a range) to `caret`, by `unit`.
fn extend(text: &str, anchor: (u32, u32), caret: u32, unit: Unit) -> (u32, u32) {
    let (a, b) = match unit {
        Unit::Char => (caret, caret),
        // The unit after the caret going forward, before it going back.
        _ if caret >= anchor.1 => unit_at(text, caret.saturating_sub(1).max(anchor.0), unit),
        _ => unit_at(text, caret, unit),
    };
    (a.min(anchor.0), b.max(anchor.1))
}

/// A character's class for word selection.
fn word_class(c: char) -> u8 {
    if c.is_whitespace() {
        0
    } else if is_cjk(c) && !matches!(c as u32, 0xFF00..=0xFFEF) {
        2
    } else if c.is_alphanumeric() || c == '_' {
        1
    } else {
        3
    }
}

/// The word or paragraph (`unit`) holding the character at `index`
/// (UTF-16): a run of letters and digits (apostrophes inside them too),
/// of CJK characters or of spaces, or one other character.
fn unit_at(text: &str, index: u32, unit: Unit) -> (u32, u32) {
    let chars: Vec<(u32, char)> = text
        .chars()
        .scan(0u32, |at, c| {
            let i = *at;
            *at += c.len_utf16() as u32;
            Some((i, c))
        })
        .collect();
    let len = chars.last().map_or(0, |&(i, c)| i + c.len_utf16() as u32);
    let Some(k) = chars.iter().rposition(|&(i, _)| i <= index) else {
        return (0, 0);
    };
    let end_of = |j: usize| chars.get(j).map_or(len, |&(i, _)| i);
    match unit {
        Unit::Char => (chars[k].0, end_of(k + 1)),
        Unit::Paragraph => {
            let start = chars[..k]
                .iter()
                .rposition(|&(_, c)| is_paragraph_break(c))
                .map_or(0, |j| j + 1);
            let end = chars[k..]
                .iter()
                .position(|&(_, c)| is_paragraph_break(c))
                .map_or(chars.len(), |j| k + j);
            (end_of(start), end_of(end))
        }
        Unit::Word => {
            let class = |j: usize| {
                let c = chars[j].1;
                let word = |j: Option<usize>| {
                    j.and_then(|j| chars.get(j))
                        .is_some_and(|&(_, c)| word_class(c) == 1)
                };
                if matches!(c, '\'' | '\u{2019}') && word(j.checked_sub(1)) && word(Some(j + 1)) {
                    1
                } else {
                    word_class(c)
                }
            };
            let own = class(k);
            if own == 3 {
                return (chars[k].0, end_of(k + 1));
            }
            let mut start = k;
            while start > 0 && class(start - 1) == own {
                start -= 1;
            }
            let mut end = k + 1;
            while end < chars.len() && class(end) == own {
                end += 1;
            }
            (chars[start].0, end_of(end))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::OnceLock;

    use super::*;

    /// The platform's text system, without a window (one per process).
    /// Prints the log to stderr (shown with a failing test's output): GPUI
    /// reports why it could not select a font there only.
    struct TestLogger;

    impl log::Log for TestLogger {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            metadata.level() <= log::Level::Info
        }

        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) {
                eprintln!("{} {}: {}", record.level(), record.target(), record.args());
            }
        }

        fn flush(&self) {}
    }

    fn system() -> Arc<TextSystem> {
        static LOGGER: TestLogger = TestLogger;
        if log::set_logger(&LOGGER).is_ok() {
            log::set_max_level(log::LevelFilter::Info);
        }
        static SYSTEM: OnceLock<Arc<TextSystem>> = OnceLock::new();
        // The platform first: on Windows it puts its thread in an OLE
        // apartment, which COM set up beforehand would refuse.
        let system = SYSTEM
            .get_or_init(|| {
                let platform = gpui_platform::current_platform(true);
                let text = platform.text_system();
                // Its threads serve the text system for the whole run.
                std::mem::forget(platform);
                Arc::new(TextSystem::new(text))
            })
            .clone();
        init_thread();
        system
    }

    /// An engine over the platform's text system, or `None` where tests
    /// cannot make one: macOS makes its platform on the main thread only,
    /// and tests run on others.
    fn engine() -> Option<GpuiTextEngine> {
        if cfg!(target_os = "macos") {
            return None;
        }
        Some(GpuiTextEngine::new(system(), ui_family()))
    }

    /// True when `font` is a color emoji font.
    fn is_emoji_font(font: FontId) -> bool {
        system()
            .get_font_for_id(font)
            .is_some_and(|f| f.family.to_lowercase().contains("emoji"))
    }

    /// True when the text system lists fonts at all: Windows CI machines
    /// list none (DirectWrite enumerates no fonts in their session), and
    /// every font then resolves to GPUI's fallback, so weights and
    /// registered fonts cannot be told apart there.
    fn lists_fonts() -> bool {
        !system().all_font_names().is_empty()
    }

    /// True when a color emoji font is installed (CI machines may have
    /// none).
    fn has_emoji_font() -> bool {
        const EMOJI: &[&str] = &[
            "Noto Color Emoji",
            "Apple Color Emoji",
            "Segoe UI Emoji",
            "Twemoji",
        ];
        let names = system().all_font_names();
        names
            .iter()
            .any(|n| EMOJI.iter().any(|e| n.eq_ignore_ascii_case(e)))
    }

    fn text(parts: &[(&str, ResolvedTextStyle)]) -> AttributedText {
        let mut t = AttributedText::default();
        for (s, style) in parts {
            t.push(s, *style);
        }
        t
    }

    fn plain(size: f32) -> ResolvedTextStyle {
        ResolvedTextStyle {
            font_size: Points(size),
            ..Default::default()
        }
    }

    fn layout_of(
        engine: &GpuiTextEngine,
        t: &AttributedText,
        width: Option<f32>,
    ) -> (Size<Points>, TextLayout) {
        let prepared = engine.prepare(t);
        let size = engine.measure(&prepared, width.map(Points));
        (size, engine.layout(&prepared, size))
    }

    /// The text a layout shows, left to right, line by line (`|` between
    /// lines, `…` for an ellipsis).
    fn shown(t: &AttributedText, layout: &TextLayout) -> String {
        let l = layout.downcast::<GpuiLayout>().unwrap();
        let units: Vec<u16> = t.text.encode_utf16().collect();
        let mut out = String::new();
        for (k, line) in l.lines.iter().enumerate() {
            if k > 0 {
                out.push('|');
            }
            for b in &l.boxes[line.boxes.clone()] {
                if b.kind == BoxKind::Ellipsis {
                    out.push('…');
                    continue;
                }
                let start = b.at as usize;
                let mut end = start + 1;
                while end < units.len() && (units[end] & 0xFC00) == 0xDC00 {
                    end += 1;
                }
                out.push_str(&String::from_utf16_lossy(&units[start..end]));
            }
        }
        out
    }

    /// The lines' texts (by their ranges).
    fn line_texts(t: &AttributedText, layout: &TextLayout) -> Vec<String> {
        let units: Vec<u16> = t.text.encode_utf16().collect();
        engine()
            .expect("an engine")
            .lines(layout)
            .iter()
            .map(|l| String::from_utf16_lossy(&units[l.start as usize..l.end as usize]))
            .collect()
    }

    #[test]
    fn families() {
        assert_eq!(family_candidates("Inter"), ["Inter"]);
        assert_eq!(family_candidates("system-ui"), [""]);
        assert_eq!(family_candidates(" , "), [""]);
        let stack = family_candidates("\"Fira Code\", ui-monospace");
        assert_eq!(stack[0], "Fira Code");
        assert_eq!(&stack[1..], MONOSPACE);
        assert_eq!(&family_candidates("Menlo")[1..], MONOSPACE);
    }

    #[test]
    fn directions() {
        assert_eq!(first_strong("123 hello"), Some(false));
        assert_eq!(first_strong("123 שלום"), Some(true));
        assert_eq!(first_strong("مرحبا hello"), Some(true));
        assert_eq!(first_strong("123 !"), None);
    }

    #[test]
    fn visual_orders() {
        assert_eq!(visual_order(&[0, 0, 0]), [0, 1, 2]);
        assert_eq!(visual_order(&[1, 1, 1]), [2, 1, 0]);
        // Left-to-right text with a right-to-left word.
        assert_eq!(visual_order(&[0, 1, 1, 0]), [0, 2, 1, 3]);
        // Right-to-left text with numbers (level 2) inside.
        assert_eq!(visual_order(&[1, 2, 2, 1]), [3, 1, 2, 0]);
        assert!(visual_order(&[]).is_empty());
    }

    /// What is measured at a width lays out in as many lines at the
    /// measured size (the core sizes text views from `measure`).
    #[test]
    fn layout_matches_measure() {
        let Some(engine) = engine() else {
            return;
        };
        let plain = plain(15.0);
        let texts = [
            text(&[(
                "The quick brown fox jumps over the lazy dog, again and again.",
                plain,
            )]),
            text(&[
                (
                    "Spaced letters ",
                    ResolvedTextStyle {
                        letter_spacing: Points(1.3),
                        ..plain
                    },
                ),
                (
                    "and bold italic",
                    ResolvedTextStyle {
                        font_weight: 700,
                        italic: true,
                        ..plain
                    },
                ),
                (
                    " mixed with big text",
                    ResolvedTextStyle {
                        font_size: Points(31.0),
                        line_height: Points(40.0),
                        ..plain
                    },
                ),
            ]),
            text(&[(
                "中文排版测试：原生文本在引擎线程排版。日本語のテキスト 😀",
                plain,
            )]),
            text(&[(
                "First paragraph\nsecond one, a little longer\n\nthird",
                plain,
            )]),
        ];
        for t in &texts {
            let prepared = engine.prepare(t);
            let natural = engine.measure(&prepared, None);
            let layout = engine.layout(&prepared, natural);
            let paragraphs = t.text.split('\n').count();
            assert_eq!(
                engine.lines(&layout).len(),
                paragraphs,
                "{:?} unwrapped",
                t.text
            );
            for width in (40..400).step_by(7) {
                let size = engine.measure(&prepared, Some(Points(width as f32)));
                let mut measured = 0;
                prepared.break_lines(width as f32, |_| {
                    measured += 1;
                    true
                });
                let lines = engine.lines(&engine.layout(&prepared, size));
                assert_eq!(lines.len(), measured, "{:?} at {width}", t.text);
                let bottom = lines.last().map_or(0.0, |l| l.y.0 + l.height.0);
                assert!(
                    bottom <= size.height.0,
                    "{:?} at {width}: {bottom} > {size:?}",
                    t.text
                );
                for line in &lines {
                    assert!(
                        line.x.0 >= -0.01 && line.x.0 + line.width.0 <= size.width.0 + 0.01,
                        "{:?} at {width}: {line:?} in {size:?}",
                        t.text
                    );
                }
            }
        }
    }

    #[test]
    fn wrapping_widths() {
        let Some(engine) = engine() else {
            return;
        };
        let t = text(&[("The quick brown fox jumps over the lazy dog", plain(15.0))]);
        let prepared = engine.prepare(&t);
        let one = engine.measure(&prepared, None);
        let wrapped = engine.measure(&prepared, Some(one.width / 2.0));
        assert!(wrapped.width <= (one.width / 2.0).ceil(), "{wrapped:?}");
        assert!(wrapped.height >= one.height * 2.0, "{wrapped:?} vs {one:?}");
        // No wrapping: as wide as the text, past the width.
        let mut t = t.clone();
        t.no_wrap = true;
        let prepared = engine.prepare(&t);
        assert_eq!(engine.measure(&prepared, Some(Points(50.0))), one);
    }

    #[test]
    fn breaks_at_opportunities() {
        let Some(engine) = engine() else {
            return;
        };
        let t = text(&[("alpha beta gamma delta", plain(15.0))]);
        let prepared = engine.prepare(&t);
        let word = engine.measure(&engine.prepare(&text(&[("alpha beta", plain(15.0))])), None);
        let (_, layout) = layout_of(&engine, &t, Some(word.width.0 + 2.0));
        // Spaces end lines; the next line starts with a word.
        let lines = line_texts(&t, &layout);
        assert_eq!(lines[0], "alpha beta ", "{lines:?}");
        assert_eq!(lines.concat(), t.text);
        assert!(lines.iter().all(|l| !l.starts_with(' ')), "{lines:?}");
        // A word longer than the line breaks inside.
        let long = text(&[("Supercalifragilistic", plain(15.0))]);
        let (_, layout) = layout_of(&engine, &long, Some(40.0));
        let lines = line_texts(&long, &layout);
        assert!(lines.len() > 2, "{lines:?}");
        assert_eq!(lines.concat(), long.text);
        let _ = prepared;
    }

    #[test]
    fn cjk_lines_keep_closing_punctuation() {
        let Some(engine) = engine() else {
            return;
        };
        let style = plain(16.0);
        let t = text(&[(
            "这是一个测试，看看标点符号会不会出现在行首。再来一句话。",
            style,
        )]);
        let prepared = engine.prepare(&t);
        let natural = engine.measure(&prepared, None).width;
        // Two characters and more a line (narrower, any break goes).
        for width in (40..natural.0 as i32).step_by(5) {
            let (_, layout) = layout_of(&engine, &t, Some(width as f32));
            let lines = line_texts(&t, &layout);
            for l in &lines[1..] {
                let first = l.chars().next().unwrap();
                assert!(
                    !matches!(first, '，' | '。' | '、' | '）'),
                    "{lines:?} at {width}"
                );
            }
            assert_eq!(lines.concat(), t.text);
        }
    }

    #[test]
    fn line_heights() {
        let Some(engine) = engine() else {
            return;
        };
        let t = text(&[(
            "Line height on every line of a paragraph that wraps a few times",
            ResolvedTextStyle {
                font_size: Points(16.0),
                line_height: Points(30.0),
                ..Default::default()
            },
        )]);
        let (size, layout) = layout_of(&engine, &t, Some(150.0));
        let lines = engine.lines(&layout);
        assert!(lines.len() > 2);
        for (i, l) in lines.iter().enumerate() {
            assert!((l.height.0 - 30.0).abs() < 0.01, "{l:?}");
            assert!((l.y.0 - 30.0 * i as f32).abs() < 0.01, "{l:?}");
            // Half-leading: the font's box sits in the middle.
            let half = (30.0 - l.ascender.0 - l.descender.0).abs();
            assert!(half < 0.01, "{l:?}");
        }
        assert_eq!(size.height, Points((30.0 * lines.len() as f32).ceil()));
        // A bigger span only grows its own line.
        let small = plain(14.0);
        let t = text(&[
            ("Small ", small),
            ("Big", plain(32.0)),
            (" and then enough small text to wrap onto more lines", small),
        ]);
        let (_, layout) = layout_of(&engine, &t, Some(180.0));
        let lines = engine.lines(&layout);
        assert!(lines.len() > 2);
        assert!(lines[0].height.0 > lines[1].height.0 * 1.5, "{lines:?}");
        assert!(
            (lines[1].height.0 - lines[2].height.0).abs() < 0.01,
            "{lines:?}"
        );
    }

    #[test]
    fn letter_spacing_widens() {
        let Some(engine) = engine() else {
            return;
        };
        let t = text(&[("Spacing", plain(15.0))]);
        let spaced = text(&[(
            "Spacing",
            ResolvedTextStyle {
                letter_spacing: Points(4.0),
                ..plain(15.0)
            },
        )]);
        let a = engine.measure(&engine.prepare(&t), None);
        let b = engine.measure(&engine.prepare(&spaced), None);
        // Seven letters, four points after each.
        assert!(((b.width - a.width).0 - 28.0).abs() <= 1.0, "{a:?} {b:?}");
        assert_eq!(a.height, b.height);
    }

    #[test]
    fn weights_change_widths() {
        let Some(engine) = engine() else {
            return;
        };
        if !lists_fonts() {
            return;
        }
        let w = |weight: u16| {
            let style = ResolvedTextStyle {
                font_weight: weight,
                ..plain(20.0)
            };
            engine
                .measure(
                    &engine.prepare(&text(&[("Weights and widths", style)])),
                    None,
                )
                .width
        };
        let regular = engine.font(&plain(20.0));
        let bold = engine.font(&ResolvedTextStyle {
            font_weight: 700,
            ..plain(20.0)
        });
        let names = system().all_font_names();
        assert!(
            w(700) > w(400),
            "{} {}; {:?} {:?} -> {:?} {:?}; {} fonts, Segoe UI listed: {}; first: {:?}",
            w(700),
            w(400),
            regular,
            bold,
            system().resolve_font(&regular),
            system().resolve_font(&bold),
            names.len(),
            names.iter().any(|n| n == "Segoe UI"),
            &names[..names.len().min(8)],
        );
    }

    #[test]
    fn attachments_sit_by_vertical_align() {
        let Some(engine) = engine() else {
            return;
        };
        let style = ResolvedTextStyle::default();
        // The first line's top of a 30 pt attachment after "Ax", and the
        // line's extent above and below its baseline.
        let place = |align| {
            let mut t = text(&[("Ax", style)]);
            let mut alignments = nsh_core::AttachmentAlignments::default();
            alignments.push(
                &mut t,
                nsh_core::geometry::size(Points(10.0), Points(30.0)),
                align,
                style,
            );
            let prepared = engine.prepare_aligned(&t, &alignments);
            let size = engine.measure(&prepared, None);
            let layout = engine.layout(&prepared, size);
            let line = engine.lines(&layout).remove(0);
            let top = engine.attachments(&layout)[0].expect("shown").y.0;
            (top, line.ascender.0, line.descender.0)
        };
        let near = |a: f32, b: f32| (a - b).abs() < 0.01;
        // Its bottom on the baseline.
        let (top, up, _) = place(nsh_core::VerticalAlign::Baseline);
        assert!(near(top + 30.0, up), "{top} {up}");
        // Its top at the font's: the line grows below the baseline.
        let (top, up, down) = place(nsh_core::VerticalAlign::TextTop);
        assert!(near(top, 0.0) && near(up + down, 30.0), "{top} {up} {down}");
        // Its bottom at the font's: the line grows above the baseline.
        let (top, up, down) = place(nsh_core::VerticalAlign::TextBottom);
        assert!(
            near(top + 30.0, up + down) && near(top, 0.0),
            "{top} {up} {down}"
        );
        // Its middle above the baseline.
        let (top, up, _) = place(nsh_core::VerticalAlign::Middle);
        assert!(top + 15.0 < up, "{top} {up}");
    }

    #[test]
    fn max_lines_and_attachments() {
        let Some(engine) = engine() else {
            return;
        };
        let style = ResolvedTextStyle::default();
        let mut t = text(&[("Before ", style)]);
        t.push_attachment(nsh_core::geometry::size(Points(20.0), Points(30.0)), style);
        t.push(
            " after the attachment, and long enough to wrap a few times here.",
            style,
        );
        let prepared = engine.prepare(&t);
        let size = engine.measure(&prepared, Some(Points(120.0)));
        let layout = engine.layout(&prepared, size);
        let points = engine.attachments(&layout);
        assert_eq!(points.len(), 1);
        let at = points[0].expect("attachment shown");
        let (x, y) = (at.x.0, at.y.0);
        assert!(x > 0.0 && y >= 0.0, "{x}, {y}");
        let lines = engine.lines(&layout);
        assert!(lines[0].height.0 >= 30.0, "{:?}", lines[0]);
        // On the baseline.
        assert!(
            (y + 30.0 - lines[0].ascender.0).abs() < 0.01,
            "{y} {:?}",
            lines[0]
        );

        t.max_lines = 2;
        t.ellipsize = EllipsizeMode::Tail;
        let prepared = engine.prepare(&t);
        let two = engine.measure(&prepared, Some(Points(120.0)));
        assert!(two.height < size.height);
        let layout = engine.layout(&prepared, two);
        assert_eq!(engine.lines(&layout).len(), 2);
        let s = shown(&t, &layout);
        assert!(s.ends_with('…'), "{s}");
        for line in engine.lines(&layout) {
            assert!(line.x.0 + line.width.0 <= two.width.0 + 0.01, "{line:?}");
        }

        let mut t = text(&[("One\ntwo\nthree", style)]);
        t.max_lines = 2;
        t.ellipsize = EllipsizeMode::Tail;
        let prepared = engine.prepare(&t);
        let size = engine.measure(&prepared, Some(Points(200.0)));
        let layout = engine.layout(&prepared, size);
        // "two" and the ellipsis, which stands for the line break.
        assert_eq!(shown(&t, &layout), "One|two…");
        // Clipped: no ellipsis.
        t.ellipsize = EllipsizeMode::Clip;
        let (_, layout) = layout_of(&engine, &t, Some(200.0));
        assert_eq!(shown(&t, &layout), "One|two");
    }

    #[test]
    fn head_and_middle_ellipses() {
        let Some(engine) = engine() else {
            return;
        };
        let long = "Start of a long line of text that will not fit in the box at all, end";
        for (mode, keeps_start, keeps_end) in [
            (EllipsizeMode::Head, false, true),
            (EllipsizeMode::Middle, true, true),
            (EllipsizeMode::Tail, true, false),
        ] {
            let mut t = text(&[(long, plain(14.0))]);
            t.max_lines = 1;
            t.ellipsize = mode;
            let prepared = engine.prepare(&t);
            let size = engine.measure(&prepared, Some(Points(160.0)));
            assert!(size.width.0 <= 160.0, "{mode:?} {size:?}");
            let layout = engine.layout(&prepared, size);
            let lines = engine.lines(&layout);
            assert_eq!(lines.len(), 1, "{mode:?}");
            assert!(
                lines[0].x.0 + lines[0].width.0 <= 160.01,
                "{mode:?} {:?}",
                lines[0]
            );
            let s = shown(&t, &layout);
            assert!(s.contains('…'), "{mode:?}: {s}");
            assert_eq!(s.starts_with("Start"), keeps_start, "{mode:?}: {s}");
            assert_eq!(s.ends_with(", end"), keeps_end, "{mode:?}: {s}");
        }
        // Text that fits is left alone.
        let mut t = text(&[("Short", plain(14.0))]);
        t.max_lines = 1;
        t.ellipsize = EllipsizeMode::Middle;
        let (_, layout) = layout_of(&engine, &t, Some(160.0));
        assert_eq!(shown(&t, &layout), "Short");
    }

    #[test]
    fn no_wrap_lines_each_get_an_ellipsis() {
        let Some(engine) = engine() else {
            return;
        };
        let mut t = text(&[(
            "A first line that is long enough\nA second one, as long as that",
            plain(14.0),
        )]);
        t.no_wrap = true;
        t.max_lines = 2;
        let prepared = engine.prepare(&t);
        let layout = engine.layout(&prepared, Size::new(Points(80.0), Points(40.0)));
        let s = shown(&t, &layout);
        assert_eq!(s.matches('…').count(), 2, "{s}");
    }

    #[test]
    fn lines_report_metrics() {
        let Some(engine) = engine() else {
            return;
        };
        let t = text(&[("Hx\nsecond line", plain(20.0))]);
        let (_, layout) = layout_of(&engine, &t, None);
        let lines = engine.lines(&layout);
        assert_eq!(lines.len(), 2);
        let (first, second) = (&lines[0], &lines[1]);
        assert_eq!((first.start, first.end), (0, 2));
        assert_eq!((second.start, second.end), (3, 14));
        assert_eq!(first.y.0, 0.0);
        assert!((second.y.0 - first.height.0).abs() < 0.01);
        assert!((first.ascender.0 + first.descender.0 - first.height.0).abs() < 0.01);
        assert!(
            first.ascender.0 > 14.0 && first.descender.0 > 3.0,
            "{first:?}"
        );
        let (cap, x) = (first.cap_height.0, first.x_height.0);
        assert!(cap > 11.0 && cap < 16.0 && x > 8.0 && x < cap, "{cap} {x}");
        assert!(second.width.0 > first.width.0);
    }

    #[test]
    fn alignment() {
        let Some(engine) = engine() else {
            return;
        };
        let mut t = text(&[("Short", plain(15.0))]);
        let size = Size::new(Points(300.0), Points(30.0));
        let x = |t: &AttributedText| {
            let p = engine.prepare(t);
            engine.lines(&engine.layout(&p, size))[0].x.0
        };
        assert!(x(&t) < 1.0);
        t.align = TextAlign::Right;
        assert!(x(&t) > 200.0);
        t.align = TextAlign::Center;
        assert!(x(&t) > 100.0 && x(&t) < 200.0);
        // `auto` in a right-to-left layout is the right side.
        t.align = TextAlign::Auto;
        t.rtl = true;
        assert!(x(&t) > 200.0);
        let mut hebrew = text(&[("שלום", plain(15.0))]);
        assert!(x(&hebrew) > 200.0);
        hebrew.align = TextAlign::Left;
        assert!(x(&hebrew) < 1.0);
    }

    #[test]
    fn justified_lines_fill_the_box() {
        let Some(engine) = engine() else {
            return;
        };
        let mut t = text(&[(
            "Justified text spreads the spaces of every line but the last one of a paragraph",
            plain(15.0),
        )]);
        t.align = TextAlign::Justify;
        let (size, layout) = layout_of(&engine, &t, Some(200.0));
        let lines = engine.lines(&layout);
        assert!(lines.len() > 2);
        for l in &lines[..lines.len() - 1] {
            assert!(
                (l.x.0 + l.width.0 - size.width.0).abs() < 0.5,
                "{l:?} {size:?}"
            );
        }
        let last = lines.last().unwrap();
        assert!(
            last.x.0 < 0.01 && last.width.0 < size.width.0 - 5.0,
            "{last:?}"
        );
    }

    #[test]
    fn right_to_left_text() {
        let Some(engine) = engine() else {
            return;
        };
        let t = text(&[("שלום עולם", plain(15.0))]);
        let (_, layout) = layout_of(&engine, &t, None);
        let l = layout.downcast::<GpuiLayout>().unwrap();
        // The first letter is the rightmost.
        let first = l.boxes.iter().find(|b| b.at == 0).unwrap();
        assert!(l.boxes.iter().all(|b| b.x <= first.x), "{:?}", l.boxes);
        // Mixed: the Hebrew word reads right to left inside English.
        let t = text(&[("abc שלום def", plain(15.0))]);
        let (_, layout) = layout_of(&engine, &t, None);
        let l = layout.downcast::<GpuiLayout>().unwrap();
        let x = |at: u32| l.boxes.iter().find(|b| b.at == at).unwrap().x;
        assert!(x(0) < x(4));
        assert!(x(4) > x(7), "ש right of ם");
        assert!(x(7) < x(9));
    }

    #[test]
    fn right_to_left_ellipsis_is_on_the_left() {
        let Some(engine) = engine() else {
            return;
        };
        let mut t = text(&[(
            "שלום עולם, זהו טקסט ארוך מאוד בעברית שלא נכנס בשורה אחת",
            plain(15.0),
        )]);
        t.max_lines = 1;
        t.ellipsize = EllipsizeMode::Tail;
        let (size, layout) = layout_of(&engine, &t, Some(150.0));
        let l = layout.downcast::<GpuiLayout>().unwrap();
        let ellipsis = l
            .boxes
            .iter()
            .find(|b| b.kind == BoxKind::Ellipsis)
            .unwrap();
        assert!(
            l.boxes.iter().all(|b| b.x >= ellipsis.x - 0.01),
            "{:?}",
            l.boxes
        );
        let line = &engine.lines(&layout)[0];
        assert!(
            line.x.0 >= -0.01 && line.x.0 + line.width.0 <= size.width.0 + 0.01,
            "{line:?}"
        );
    }

    #[test]
    fn mirrors_keep_their_length() {
        for c in "()[]{}<>«»‹›≤≥「」（）《》".chars() {
            let m = mirrored(c).unwrap();
            assert_eq!(c.len_utf8(), m.len_utf8(), "{c}");
            assert_eq!(mirrored(m), Some(c));
        }
        assert_eq!(mirrored('a'), None);
        // A bracket in right-to-left text is drawn as its mirror, in a run
        // with letters (the shaper's) and in a span of its own (ours).
        let Some(engine) = engine() else {
            return;
        };
        let close = engine.prepare(&text(&[(")", plain(15.0))])).glyphs[0].id;
        let bold = ResolvedTextStyle {
            font_weight: 700,
            ..plain(15.0)
        };
        for t in [
            text(&[("שלום (עולם)", plain(15.0))]),
            text(&[("שלום ", plain(15.0)), ("(", plain(15.0)), ("עולם)", bold)]),
        ] {
            let prepared = engine.prepare(&t);
            let open = prepared.clusters.iter().find(|c| c.utf16 == 5).unwrap();
            assert_eq!(open.level, 1);
            assert_eq!(
                prepared.glyphs[open.glyphs.0 as usize].id, close,
                "{:?}",
                t.text
            );
        }
    }

    #[test]
    fn text_symbols_take_a_text_font() {
        assert!(text_symbol('♥') && text_symbol('✓') && text_symbol('©'));
        assert!(!text_symbol('⭐') && !text_symbol('⚡') && !text_symbol('a'));
        let Some(engine) = engine() else {
            return;
        };
        if engine.fonts().symbols.is_empty() {
            return;
        }
        // In the text's color, not an emoji font's.
        let p = engine.prepare(&text(&[("♥ 3", plain(13.0))]));
        assert!(p.glyphs.iter().all(|g| !g.emoji), "{:?}", p.glyphs);
        // With VS16 it asks for the emoji (where there is an emoji font).
        if !has_emoji_font() {
            return;
        }
        let p = engine.prepare(&text(&[("♥\u{FE0F}", plain(13.0))]));
        let from_emoji_font = p.glyphs.iter().any(|g| is_emoji_font(g.font));
        assert!(!from_emoji_font || p.glyphs.iter().any(|g| g.emoji) || p.glyphs.is_empty());
    }

    #[test]
    fn span_backgrounds_box_each_line() {
        let Some(engine) = engine() else {
            return;
        };
        let style = plain(15.0);
        let code = ResolvedTextStyle {
            font_size: Points(13.0),
            background: Some(nsh_core::TextBackground {
                color: Color(0xeeee_eeff),
                radius: Points(4.0),
                node: 4,
            }),
            ..style
        };
        let t = text(&[("Run ", style), ("cargo test --all", code), (" now", style)]);
        let (size, layout) = layout_of(&engine, &t, None);
        let l = layout.downcast::<GpuiLayout>().unwrap();
        let mut rects = Vec::new();
        l.background_rects(&t, |x, y, w, h, r, c| rects.push((x, y, w, h, r, c)));
        assert_eq!(rects.len(), 1, "{rects:?}");
        let (x, y, w, h, r, c) = rects[0];
        // The code's own font: lower than the line, around its baseline.
        assert!(x > 0.0 && x + w < size.width.0, "{rects:?}");
        assert!(y >= 0.0 && h < l.lines[0].info.height.0 + 0.01, "{rects:?}");
        assert_eq!((r, c), (4.0, Color(0xeeee_eeff)));
        // Wrapped: a box on each line the span reaches.
        let (_, layout) = layout_of(&engine, &t, Some(w * 0.7));
        let l = layout.downcast::<GpuiLayout>().unwrap();
        let mut rects = Vec::new();
        l.background_rects(&t, |x, y, w, h, r, c| rects.push((x, y, w, h, r, c)));
        assert!(rects.len() >= 2, "{rects:?}");
        assert!(rects[1].1 > rects[0].1);
    }

    #[test]
    fn carets_and_highlights() {
        let Some(engine) = engine() else {
            return;
        };
        let style = plain(15.0);
        let t = text(&[("First line here\nsecond", style)]);
        let (size, layout) = layout_of(&engine, &t, None);
        let l = layout.downcast::<GpuiLayout>().unwrap();
        assert_eq!(l.lines.len(), 2);
        assert_eq!(l.hit_test(-5.0, 2.0).offset, 0);
        // A hard break: the caret goes before it, on that line.
        assert_eq!(
            l.hit_test(size.width.0 + 20.0, 2.0),
            TextPosition::new(15, Affinity::Downstream)
        );
        // Below the text: the last line.
        assert_eq!(
            l.hit_test(size.width.0 + 20.0, size.height.0 + 50.0).offset,
            22
        );
        let mid = l.hit_test((size.width / 2.0).0, 2.0).offset;
        assert!(mid > 3 && mid < 12, "{mid}");
        // Nearest edge: just right of a box's start is before it.
        let b = l.boxes[l.lines[0].boxes.clone()][2];
        assert_eq!(l.hit_test(b.x + b.w * 0.2, 2.0).offset, b.at);
        assert_eq!(l.hit_test(b.x + b.w * 0.8, 2.0).offset, b.at + 1);
        assert_eq!(l.char_at(b.x + b.w * 0.5, 2.0), Some(b.at));

        let mut rects = Vec::new();
        l.selection_rects((6, 19), |x, y, w, h| rects.push((x, y, w, h)));
        // "line here" on the first line, "sec" on the second.
        assert_eq!(rects.len(), 2, "{rects:?}");
        assert!(rects[0].0 > 0.0 && rects[0].1 == 0.0);
        assert!(rects[1].0.abs() < 0.01);
        assert!(rects[1].1 >= rects[0].3);

        let mut rtl = text(&[("שלום עולם", style)]);
        rtl.rtl = true;
        let (size, layout) = layout_of(&engine, &rtl, None);
        let l = layout.downcast::<GpuiLayout>().unwrap();
        // Right to left: the right edge is the start.
        assert_eq!(l.hit_test(size.width.0 + 5.0, 2.0).offset, 0);
        assert_eq!(l.hit_test(-5.0, 2.0).offset, 9);
    }

    /// The engine's hit testing: the end of a wrapped line is `Upstream`
    /// and its caret stays on that line, carets sit on box edges, and
    /// ranges append a line-high box per line.
    #[test]
    fn engine_hit_testing() {
        let Some(engine) = engine() else {
            return;
        };
        let t = text(&[("alpha beta gamma delta epsilon", plain(15.0))]);
        let (_, layout) = layout_of(&engine, &t, Some(90.0));
        let lines = engine.lines(&layout);
        assert!(lines.len() > 2, "{lines:?}");
        let first = &lines[0];
        assert_eq!(first.end, lines[1].start);

        let past = point(Points(500.0), first.y + first.height / 2.0);
        let end = engine.hit_test(&layout, past);
        assert_eq!(end, TextPosition::new(first.end, Affinity::Upstream));
        let up = engine.caret_rect(&layout, end).unwrap();
        let down = engine
            .caret_rect(&layout, TextPosition::new(first.end, Affinity::Downstream))
            .unwrap();
        assert_eq!((up.origin.y, up.size.width), (first.y, Points::ZERO));
        assert_eq!(up.size.height, first.height);
        assert_eq!(down.origin.y, lines[1].y);
        assert!(up.origin.x.0 > down.origin.x.0 + 20.0, "{up:?} {down:?}");
        // The start of the text and a point above it.
        let start = engine.hit_test(&layout, point(Points(-5.0), Points(-5.0)));
        assert_eq!(start, TextPosition::default());
        assert_eq!(engine.caret_rect(&layout, start).unwrap().origin.x, first.x);

        // A range over two lines appends to what `out` holds.
        let mut out = vec![Bounds::new(
            point(Points(1.0), Points(2.0)),
            size(Points(3.0), Points(4.0)),
        )];
        engine.range_rects(&layout, 2..lines[1].start + 2, &mut out);
        assert_eq!(out.len(), 3, "{out:?}");
        assert_eq!(out[1].origin.y, first.y);
        assert_eq!(out[2].origin.y, lines[1].y);
        assert_eq!(out[1].size.height, first.height);
        engine.range_rects(&layout, 4..4, &mut out);
        assert_eq!(out.len(), 3);

        // Not this engine's layout.
        let other = nsh_core::ApproxTextEngine;
        let foreign = other.layout(&other.prepare(&t), Size::new(Points(90.0), Points(40.0)));
        assert_eq!(engine.hit_test(&foreign, past), TextPosition::default());
        assert!(engine.caret_rect(&foreign, end).is_none());
        engine.range_rects(&foreign, 0..5, &mut out);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn registered_fonts_lay_out() {
        let Some(engine) = engine() else {
            return;
        };
        if !lists_fonts() {
            return;
        }
        let data = include_bytes!("../../../../examples/gallery/fonts/Pacifico-Regular.ttf");
        let style = ResolvedTextStyle {
            font_family: Some(nsh_core::FontFamily::new("Pacifico")),
            font_size: Points(20.0),
            ..Default::default()
        };
        let t = text(&[("Custom fonts", style)]);
        let before = engine.measure(&engine.prepare(&t), None);
        engine.register_font(data).expect("registered");
        // Again (hot reload): nothing new.
        engine.register_font(data).expect("registered again");
        assert!(engine.register_font(b"not a font").is_err());
        let after = engine.measure(&engine.prepare(&t), None);
        let font = engine.font(&style);
        assert_ne!(
            before,
            after,
            "{:?} -> {:?}; Pacifico listed: {}",
            font,
            system().resolve_font(&font),
            system().all_font_names().iter().any(|n| n == "Pacifico"),
        );
        assert_eq!(&*engine.face(&style).font.family, "Pacifico");
        // Pacifico is tall: its lines are more than 1.5 ems.
        assert!(after.height.0 > 30.0, "{after:?}");
    }

    #[test]
    fn fallback_fonts_keep_the_line_height() {
        let Some(engine) = engine() else {
            return;
        };
        let h = |s: &str| {
            engine
                .measure(&engine.prepare(&text(&[(s, plain(16.0))])), None)
                .height
        };
        let latin = h("Grace");
        assert_eq!(h("Grace你好世界"), latin, "CJK");
        assert_eq!(h("Grace😀"), latin, "emoji");
    }

    #[test]
    fn emoji_are_emoji_glyphs() {
        let Some(engine) = engine() else {
            return;
        };
        if !has_emoji_font() {
            return;
        }
        let t = text(&[("a😀", plain(16.0))]);
        let (_, layout) = layout_of(&engine, &t, None);
        let l = layout.downcast::<GpuiLayout>().unwrap();
        // GPUI's fallback may set it in a font with a plain glyph for it
        // (some CI machines): emoji are only marked from an emoji font.
        let from_emoji_font = l.glyphs.iter().any(|g| is_emoji_font(g.font));
        assert!(
            !from_emoji_font || l.glyphs.iter().any(|g| g.emoji),
            "{:?}",
            l.glyphs
        );
    }

    #[test]
    fn empty_text_has_one_line() {
        let Some(engine) = engine() else {
            return;
        };
        let t = AttributedText::default();
        let (size, layout) = layout_of(&engine, &t, Some(100.0));
        assert_eq!(size.width, Points(0.0));
        assert!(size.height.0 > 10.0);
        assert_eq!(engine.lines(&layout).len(), 1);
        // A text ending in a line break has an empty last line.
        let t = text(&[("one\n", plain(14.0))]);
        let (_, layout) = layout_of(&engine, &t, None);
        assert_eq!(engine.lines(&layout).len(), 2);
    }

    /// Spans ending after multi-byte characters (UTF-16 offsets) map to
    /// character boundaries.
    #[test]
    fn multi_byte_spans() {
        let Some(engine) = engine() else {
            return;
        };
        let bold = ResolvedTextStyle {
            font_weight: 700,
            ..plain(15.0)
        };
        let t = text(&[
            ("2×3", plain(15.0)),
            ("×", bold),
            ("中文", plain(15.0)),
            ("😀", bold),
            ("é\u{301}x", plain(15.0)),
        ]);
        let (size, layout) = layout_of(&engine, &t, None);
        assert!(size.width.0 > 0.0);
        let shown = shown(&t, &layout);
        for part in ["2×3×", "中文", "😀"] {
            assert!(shown.contains(part), "{shown}");
        }
        // Wrapped one character a line, nothing breaks.
        let (_, layout) = layout_of(&engine, &t, Some(1.0));
        assert_eq!(line_texts(&t, &layout).concat(), t.text);
    }

    #[test]
    fn spans_by_offset() {
        let style = ResolvedTextStyle::default();
        let spans = [
            TextSpan {
                start: 0,
                end: 2,
                style,
            },
            TextSpan {
                start: 2,
                end: 5,
                style,
            },
        ];
        assert_eq!(span_at(&spans, 0), 0);
        assert_eq!(span_at(&spans, 1), 0);
        assert_eq!(span_at(&spans, 2), 1);
        assert_eq!(span_at(&spans, 4), 1);
        assert_eq!(span_at(&spans, 9), 1);
        assert_eq!(span_at(&[], 3), 0);
    }

    #[test]
    fn word_and_paragraph_units() {
        let s = "Hello, don't stop\n中文字 next  end";
        assert_eq!(unit_at(s, 1, Unit::Word), (0, 5));
        assert_eq!(unit_at(s, 5, Unit::Word), (5, 6));
        // Apostrophes inside a word belong to it.
        assert_eq!(unit_at(s, 8, Unit::Word), (7, 12));
        assert_eq!(unit_at(s, 18, Unit::Word), (18, 21));
        // Runs of spaces are a unit.
        assert_eq!(unit_at(s, 27, Unit::Word), (26, 28));
        assert_eq!(unit_at(s, 3, Unit::Paragraph), (0, 17));
        assert_eq!(unit_at(s, 20, Unit::Paragraph), (18, 31));
        assert_eq!(unit_at(s, 99, Unit::Word), (28, 31));
        assert_eq!(unit_at("", 0, Unit::Word), (0, 0));
        // Surrogate pairs count two units.
        assert_eq!(unit_at("a😀b c", 3, Unit::Word), (3, 4));
    }

    #[test]
    fn extending_by_units() {
        let s = "one two three";
        assert_eq!(extend(s, (5, 5), 2, Unit::Char), (2, 5));
        assert_eq!(extend(s, (5, 5), 9, Unit::Char), (5, 9));
        // From "two": forward to the end of "three", back to "one".
        assert_eq!(extend(s, (4, 7), 10, Unit::Word), (4, 13));
        assert_eq!(extend(s, (4, 7), 1, Unit::Word), (0, 7));
        // A caret at a word's end stays in it.
        assert_eq!(extend(s, (0, 3), 7, Unit::Word), (0, 7));
    }

    #[test]
    fn shaping_is_bounded() {
        let Some(engine) = engine() else {
            return;
        };
        for i in 0..(CACHE_LINES + 10) {
            let t = text(&[(&format!("line {i}"), plain(12.0))]);
            engine.prepare(&t);
        }
        assert!(engine.shaped.get() < CACHE_LINES);
    }
}

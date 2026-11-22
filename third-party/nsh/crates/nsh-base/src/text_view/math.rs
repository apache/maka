//! TeX formulas typeset by RaTeX (KaTeX's parser and layout, in Rust): what
//! a `TextView` shows for a formula without the app's `renderMath`.
//!
//! [`typeset`] parses and lays out the TeX into RaTeX's display list
//! (glyphs of KaTeX's fonts, rules and paths, placed in ems from the
//! formula's top left); [`render`] draws it on a canvas, each glyph as its
//! outline from the KaTeX fonts (`fonts/katex.pack.zst`, OFL; embedded in the
//! native runtimes, the page's on the web: `formula.rs`), so a formula looks
//! the same on every platform and needs no font installed.
//! Glyphs and rules take the text's color (`currentColor`), but where the
//! TeX sets one (`\color`). TeX RaTeX cannot read fails, and the view shows
//! the TeX itself.

use std::{collections::HashMap, sync::OnceLock};

use nsh_core::{SvgPaint, element::Painter, prelude::*};
use ratex_font::FontId;
use ratex_layout::{LayoutOptions, layout, to_display_list, validate_layout};
use ratex_types::{Color as TexColor, DisplayItem, DisplayList, MathStyle, PathCommand};

/// A formula laid out, in ems.
#[derive(Debug, Clone)]
struct Formula {
    list: DisplayList,
}

/// Parses and lays out `tex`; `display` for a block of its own (limits
/// over operators, full-size fractions). `None` for TeX RaTeX cannot read.
fn typeset(tex: &str, display: bool) -> Option<Formula> {
    let nodes = ratex_parser::parse(tex).ok()?;
    let options = LayoutOptions {
        style: if display {
            MathStyle::Display
        } else {
            MathStyle::Text
        },
        color: TexColor::BLACK,
        ..LayoutOptions::default()
    };
    let root = layout(&nodes, &options);
    validate_layout(&root).ok()?;
    let list = to_display_list(&root);
    (list.width.is_finite() && list.height.is_finite() && list.depth.is_finite())
        .then_some(Formula { list })
}

/// The color an item is drawn in: the text's for the default (black),
/// else the TeX's own.
fn paint(p: Painter, color: &TexColor) -> Painter {
    if *color == TexColor::BLACK {
        p.fill_style_from_view(SvgPaint::CurrentColor)
    } else {
        p.fill_style(Hsla::from(Rgba {
            r: color.r,
            g: color.g,
            b: color.b,
            a: color.a,
        }))
    }
}

/// The KaTeX fonts, in the order of `fonts/katex.pack.zst`.
const FONTS: [(FontId, &str); 19] = [
    (FontId::AmsRegular, "AMS-Regular"),
    (FontId::CaligraphicRegular, "Caligraphic-Regular"),
    (FontId::FrakturRegular, "Fraktur-Regular"),
    (FontId::FrakturBold, "Fraktur-Bold"),
    (FontId::MainBold, "Main-Bold"),
    (FontId::MainBoldItalic, "Main-BoldItalic"),
    (FontId::MainItalic, "Main-Italic"),
    (FontId::MainRegular, "Main-Regular"),
    (FontId::MathBoldItalic, "Math-BoldItalic"),
    (FontId::MathItalic, "Math-Italic"),
    (FontId::SansSerifBold, "SansSerif-Bold"),
    (FontId::SansSerifItalic, "SansSerif-Italic"),
    (FontId::SansSerifRegular, "SansSerif-Regular"),
    (FontId::ScriptRegular, "Script-Regular"),
    (FontId::Size1Regular, "Size1-Regular"),
    (FontId::Size2Regular, "Size2-Regular"),
    (FontId::Size3Regular, "Size3-Regular"),
    (FontId::Size4Regular, "Size4-Regular"),
    (FontId::TypewriterRegular, "Typewriter-Regular"),
];

/// The KaTeX fonts in one file ([`crate::MATH_FONTS`]): each font's length
/// (`u32`, little endian), then its bytes, in the order of [`FONTS`].
fn pack() -> &'static [u8] {
    #[cfg(target_arch = "wasm32")]
    return super::formula::fonts();
    #[cfg(not(target_arch = "wasm32"))]
    crate::MATH_FONTS
}

/// The KaTeX font a display list names, unpacked on the first formula.
fn face(font: &str) -> Option<&'static ttf_parser::Face<'static>> {
    static FACES: OnceLock<HashMap<FontId, ttf_parser::Face<'static>>> = OnceLock::new();
    let faces = FACES.get_or_init(|| {
        let Ok(pack) = zstd::decode_all(pack()) else {
            log::error!("the KaTeX fonts do not unpack");
            return HashMap::new();
        };
        // Faces borrow their bytes for good: one buffer, kept for the process.
        let mut rest: &'static [u8] = Vec::leak(pack);
        let mut faces = HashMap::new();
        for (id, _) in FONTS {
            let Some((len, tail)) = rest.split_first_chunk::<4>() else {
                break;
            };
            let len = u32::from_le_bytes(*len) as usize;
            let Some((bytes, tail)) = (len <= tail.len()).then(|| tail.split_at(len)) else {
                break;
            };
            rest = tail;
            if let Ok(face) = ttf_parser::Face::parse(bytes, 0) {
                faces.insert(id, face);
            }
        }
        faces
    });
    faces.get(&FontId::parse(font)?)
}

/// Records a glyph's outline as canvas path commands, from font units
/// (y up) to points (y down) with `scale` points per unit.
struct Outline {
    p: Option<Painter>,
    x: f32,
    y: f32,
    scale: f32,
}

impl Outline {
    fn at(&self, x: f32, y: f32) -> Point<Points> {
        point(px(self.x + x * self.scale), px(self.y - y * self.scale))
    }

    fn with(&mut self, f: impl FnOnce(Painter) -> Painter) {
        let p = self.p.take().expect("painter");
        self.p = Some(f(p));
    }
}

impl ttf_parser::OutlineBuilder for Outline {
    fn move_to(&mut self, x: f32, y: f32) {
        let to = self.at(x, y);
        self.with(|p| p.move_to(to.x.0, to.y.0));
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let to = self.at(x, y);
        self.with(|p| p.line_to(to.x.0, to.y.0));
    }

    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (c, to) = (self.at(x1, y1), self.at(x, y));
        self.with(|p| p.quadratic_curve_to(c, to));
    }

    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        let (c1, c2, to) = (self.at(x1, y1), self.at(x2, y2), self.at(x, y));
        self.with(|p| p.bezier_curve_to(c1, c2, to));
    }

    fn close(&mut self) {
        self.with(Painter::close_path);
    }
}

/// Draws `list` at `size` points per em, its top `top` points below the
/// canvas's.
fn draw(list: &DisplayList, size: f32, top: f32) -> Painter {
    let mut p = Painter::new();
    let pt = |v: f64| v as f32 * size;
    for item in &list.items {
        p = match item {
            DisplayItem::GlyphPath {
                x,
                y,
                scale,
                font,
                char_code,
                color,
            } => {
                let Some(face) = face(font) else {
                    continue;
                };
                let id = FontId::parse(font).unwrap_or(FontId::MainRegular);
                let ch = ratex_font::katex_ttf_glyph_char(id, *char_code);
                let Some(glyph) = face.glyph_index(ch) else {
                    continue;
                };
                let units = f32::from(face.units_per_em());
                let mut outline = Outline {
                    p: Some(paint(p, color).begin_path()),
                    x: pt(*x),
                    y: top + pt(*y),
                    scale: size * *scale as f32 / units,
                };
                face.outline_glyph(glyph, &mut outline);
                outline.p.take().expect("painter").fill()
            }
            DisplayItem::Line {
                x,
                y,
                width,
                thickness,
                color,
                ..
            } => {
                // At least a hairline, centered on the rule's line.
                let t = pt(*thickness).max(1.0);
                paint(p, color).fill_rect(pt(*x), top + pt(*y) - t / 2.0, pt(*width), t)
            }
            DisplayItem::Rect {
                x,
                y,
                width,
                height,
                color,
            } => paint(p, color).fill_rect(pt(*x), top + pt(*y), pt(*width), pt(*height)),
            DisplayItem::Path {
                x,
                y,
                commands,
                fill,
                color,
            } => {
                let (ox, oy) = (pt(*x), top + pt(*y));
                let at = |x: f64, y: f64| point(px(ox + pt(x)), px(oy + pt(y)));
                let mut q = paint(p, color).begin_path();
                for c in commands {
                    q = match *c {
                        PathCommand::MoveTo { x, y } => {
                            let to = at(x, y);
                            q.move_to(to.x.0, to.y.0)
                        }
                        PathCommand::LineTo { x, y } => {
                            let to = at(x, y);
                            q.line_to(to.x.0, to.y.0)
                        }
                        PathCommand::QuadTo { x1, y1, x, y } => {
                            q.quadratic_curve_to(at(x1, y1), at(x, y))
                        }
                        PathCommand::CubicTo {
                            x1,
                            y1,
                            x2,
                            y2,
                            x,
                            y,
                        } => q.bezier_curve_to(at(x1, y1), at(x2, y2), at(x, y)),
                        PathCommand::Close => q.close_path(),
                    };
                }
                if *fill {
                    q.fill()
                } else {
                    q.stroke_style_from_view(SvgPaint::CurrentColor)
                        .line_width((size * 0.04).max(1.0))
                        .stroke()
                }
            }
        };
    }
    p
}

/// How far the math axis is above the baseline, in ems (TeX's
/// `axis_height`, KaTeX's 0.25): where an inline formula's middle goes.
const AXIS: f64 = 0.25;

/// Room above and below a formula's box, in ems. The box comes from KaTeX's
/// metrics, which leave out how far round glyphs like `0` and `6` overshoot
/// the baseline and cap height, and the canvas clips what leaves it.
const OVERSHOOT: f64 = 0.05;

/// `formula` drawn at `size` points per em. Inline (not `display`), the box
/// is padded so its middle is the formula's math axis, which
/// `align-middle` puts at the middle of the text's x height.
fn render(formula: &Formula, size: f32, display: bool) -> AnyElement {
    let list = &formula.list;
    let (above, below) = if display {
        (list.height + OVERSHOOT, list.depth + OVERSHOOT)
    } else {
        let half = (list.height - AXIS).max(list.depth + AXIS) + OVERSHOOT;
        (half + AXIS, half - AXIS)
    };
    let top = ((above - list.height) as f32) * size;
    let width = list.width as f32 * size;
    let height = (above + below) as f32 * size;
    let painter = draw(list, size, top);
    canvas(painter)
        .w(px(width))
        .h(px(height))
        .flex_none()
        .into_element()
}

/// `tex` typeset and drawn at `size` points per em.
pub(super) fn formula(tex: &str, display: bool, size: f32) -> Option<AnyElement> {
    Some(render(&typeset(tex, display)?, size, display))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_formulas_typeset() {
        for tex in [
            "E = mc^2",
            "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
            "\\int_0^\\infty e^{-x^2} \\, dx = \\frac{\\sqrt{\\pi}}{2}",
            "\\lim_{n \\to \\infty} \\left(1 + \\frac{1}{n}\\right)^n = e",
            "\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}",
            "f(x) = \\begin{cases} x^2 & x \\geq 0 \\\\ -x & \\text{otherwise} \\end{cases}",
            "\\mathbb{R}^n \\to \\mathcal{L}",
        ] {
            let formula = typeset(tex, true).unwrap_or_else(|| panic!("{tex}"));
            assert!(formula.list.width > 0.0, "{tex}");
            assert!(!formula.list.items.is_empty(), "{tex}");
        }
    }

    #[test]
    fn glyphs_stay_inside_the_padded_box() {
        for tex in [
            "\\tfrac{1000}{60}",
            "\\frac{1000}{60}",
            "x^2",
            "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}",
            "\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}",
            "\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}",
        ] {
            let list = typeset(tex, true).unwrap_or_else(|| panic!("{tex}")).list;
            for item in &list.items {
                let DisplayItem::GlyphPath {
                    y,
                    scale,
                    font,
                    char_code,
                    ..
                } = item
                else {
                    continue;
                };
                let face = face(font).expect("font");
                let id = FontId::parse(font).unwrap_or(FontId::MainRegular);
                let ch = ratex_font::katex_ttf_glyph_char(id, *char_code);
                let Some(bounds) = face
                    .glyph_index(ch)
                    .and_then(|glyph| face.glyph_bounding_box(glyph))
                else {
                    continue;
                };
                let em = *scale / f64::from(face.units_per_em());
                let top = *y - f64::from(bounds.y_max) * em;
                let bottom = *y - f64::from(bounds.y_min) * em;
                assert!(top >= -OVERSHOOT, "{tex}: {ch:?} top {top}");
                assert!(
                    bottom <= list.height + list.depth + OVERSHOOT,
                    "{tex}: {ch:?} bottom {bottom}"
                );
            }
        }
    }

    #[test]
    fn every_glyph_has_a_font() {
        let formula = typeset(
            "\\sum_{i} \\mathbb{Z} \\mathfrak{g} \\sqrt{x} \\Bigg(",
            true,
        )
        .unwrap();
        for item in &formula.list.items {
            if let DisplayItem::GlyphPath { font, .. } = item {
                assert!(face(font).is_some(), "{font}");
            }
        }
    }

    #[test]
    fn unknown_tex_fails() {
        assert!(typeset("\\frac{a}", false).is_none());
        assert!(typeset("{a", false).is_none());
        assert!(typeset(&"{".repeat(10_000), false).is_none());
    }

    /// Writes `fonts/katex.pack.zst` from KaTeX's fonts:
    /// `KATEX_FONTS=<katex>/fonts cargo test -p nsh-base --features math pack_katex_fonts -- --ignored`.
    #[test]
    #[ignore = "writes the font pack"]
    fn pack_katex_fonts() {
        let dir = std::path::PathBuf::from(
            std::env::var("KATEX_FONTS").expect("KATEX_FONTS: KaTeX's fonts/"),
        );
        let mut pack = Vec::new();
        for (_, name) in FONTS {
            let bytes = std::fs::read(dir.join(format!("KaTeX_{name}.ttf"))).unwrap();
            pack.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            pack.extend_from_slice(&bytes);
        }
        let out = concat!(env!("CARGO_MANIFEST_DIR"), "/fonts/katex.pack.zst");
        std::fs::write(out, zstd::encode_all(&pack[..], 19).unwrap()).unwrap();
    }

    #[test]
    fn every_font_unpacks() {
        for (_, name) in FONTS {
            assert!(face(name).is_some(), "{name}");
        }
    }
}

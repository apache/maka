//! The chat's own line glyphs (as the TSX gallery's
//! `demos/chat/glyphs.tsx`), drawn like the gallery's icons in a 20 × 20
//! box.

use std::f32::consts::PI;

use nsh_core::{
    canvas::{LineCap, LineJoin},
    element::PropEnum,
    geometry::size,
    prelude::*,
};

use crate::ui::{Tint, pt};

/// A glyph of [`Glyph`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum GlyphName {
    #[default]
    Copy,
    Regenerate,
    ThumbUp,
    ThumbDown,
    Stop,
    Globe,
    Sun,
    Terminal,
    Clip,
    Close,
    CaretDown,
    Alert,
    Offline,
    Check,
    Brain,
    File,
}

fn line(p: Painter, points: &[f32]) -> Painter {
    let mut p = p.begin_path().move_to(points[0], points[1]);
    for xy in points[2..].chunks(2) {
        p = p.line_to(xy[0], xy[1]);
    }
    p.stroke()
}

fn rect(p: Painter, x: f32, y: f32, w: f32, h: f32, r: f32, fill: bool) -> Painter {
    let p = p
        .begin_path()
        .round_rect(crate::ui::rect(x, y, w, h), px(r));
    if fill { p.fill() } else { p.stroke() }
}

fn arc(p: Painter, x: f32, y: f32, r: f32, from: f32, to: f32) -> Painter {
    p.begin_path().arc(x, y, r, from, to).stroke()
}

fn circle(p: Painter, x: f32, y: f32, r: f32) -> Painter {
    arc(p, x, y, r, 0.0, PI * 2.0)
}

fn thumb(p: Painter) -> Painter {
    let p = rect(p, 3.0, 9.0, 3.2, 8.0, 1.0, false);
    line(
        p,
        &[
            6.2, 9.5, 9.5, 3.5, 11.2, 4.0, 10.6, 8.0, 15.4, 8.0, 16.6, 9.4, 15.4, 16.0, 14.2, 17.0,
            6.2, 17.0,
        ],
    )
}

impl GlyphName {
    /// Draws the glyph in a 20 × 20 box.
    fn draw(self, c: Painter) -> Painter {
        match self {
            GlyphName::Copy => {
                let c = rect(c, 7.0, 7.0, 10.0, 10.0, 2.5, false);
                line(
                    c,
                    &[
                        13.0, 4.5, 13.0, 4.0, 12.0, 3.0, 4.0, 3.0, 3.0, 4.0, 3.0, 12.0, 4.0, 13.0,
                        4.5, 13.0,
                    ],
                )
            }
            GlyphName::Regenerate => {
                let c = arc(c, 10.0, 10.0, 6.0, -PI * 0.25, PI * 1.45);
                line(c, &[14.5, 2.5, 14.5, 6.0, 11.0, 6.0])
            }
            GlyphName::ThumbUp => thumb(c),
            GlyphName::ThumbDown => thumb(c.translate(0.0, 20.0).scale(1.0, -1.0)),
            GlyphName::Stop => rect(c, 5.0, 5.0, 10.0, 10.0, 2.5, true),
            GlyphName::Globe => {
                let c = circle(c, 10.0, 10.0, 7.0)
                    .begin_path()
                    .ellipse(
                        pt(10.0, 10.0),
                        size(px(3.0), px(7.0)),
                        Radians(0.0),
                        Radians(0.0),
                        Radians(PI * 2.0),
                        false,
                    )
                    .stroke();
                line(c, &[3.0, 10.0, 17.0, 10.0])
            }
            GlyphName::Sun => (0..8).fold(circle(c, 10.0, 10.0, 3.5), |c, i| {
                let a = i as f32 * PI / 4.0;
                line(
                    c,
                    &[
                        10.0 + a.cos() * 6.0,
                        10.0 + a.sin() * 6.0,
                        10.0 + a.cos() * 8.0,
                        10.0 + a.sin() * 8.0,
                    ],
                )
            }),
            GlyphName::Terminal => {
                let c = rect(c, 2.5, 4.0, 15.0, 12.0, 2.5, false);
                let c = line(c, &[6.0, 8.0, 8.5, 10.0, 6.0, 12.0]);
                line(c, &[10.5, 12.5, 14.0, 12.5])
            }
            GlyphName::Clip => line(
                c,
                &[
                    13.5, 6.5, 7.5, 12.5, 7.5, 14.0, 9.0, 14.5, 15.5, 8.0, 15.5, 5.0, 13.0, 3.5,
                    11.0, 3.5, 4.5, 10.0, 4.0, 13.0, 5.0, 15.5, 8.0, 16.5, 11.0, 15.5, 16.0, 10.5,
                ],
            ),
            GlyphName::Close => {
                let c = line(c, &[5.5, 5.5, 14.5, 14.5]);
                line(c, &[14.5, 5.5, 5.5, 14.5])
            }
            GlyphName::CaretDown => line(c, &[6.0, 8.0, 10.0, 12.0, 14.0, 8.0]),
            GlyphName::Alert => {
                let c = circle(c, 10.0, 10.0, 7.0);
                let c = line(c, &[10.0, 6.0, 10.0, 11.0]);
                line(c, &[10.0, 13.8, 10.0, 14.0])
            }
            GlyphName::Offline => {
                let c = arc(c, 10.0, 16.0, 9.0, -PI * 0.78, -PI * 0.22);
                let c = arc(c, 10.0, 16.0, 5.2, -PI * 0.75, -PI * 0.25);
                let c = line(c, &[10.0, 15.5, 10.0, 15.6]);
                line(c, &[3.5, 3.5, 16.5, 16.5])
            }
            GlyphName::Check => line(c, &[4.5, 10.5, 8.5, 14.0, 15.5, 6.0]),
            GlyphName::Brain => {
                let c = c
                    .begin_path()
                    .move_to(10.0, 4.5)
                    .bezier_curve_to(pt(5.0, 2.5), pt(2.5, 7.0), pt(4.5, 10.0))
                    .bezier_curve_to(pt(2.5, 13.5), pt(6.0, 17.0), pt(10.0, 15.5))
                    .bezier_curve_to(pt(14.0, 17.0), pt(17.5, 13.5), pt(15.5, 10.0))
                    .bezier_curve_to(pt(17.5, 7.0), pt(15.0, 2.5), pt(10.0, 4.5))
                    .stroke();
                line(c, &[10.0, 4.5, 10.0, 15.5])
            }
            GlyphName::File => {
                let c = line(
                    c,
                    &[
                        5.0, 3.0, 12.0, 3.0, 15.5, 6.5, 15.5, 17.0, 5.0, 17.0, 5.0, 3.0,
                    ],
                );
                line(c, &[12.0, 3.0, 12.0, 6.5, 15.5, 6.5])
            }
        }
    }
}

/// The props of [`Glyph`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct GlyphProps {
    /// The glyph.
    pub(crate) name: Prop<GlyphName>,
    /// Its width and height, in points.
    #[prop(default = 20.0)]
    pub(crate) size: f32,
    /// Its color.
    pub(crate) tint: Prop<Tint>,
}

/// A chat glyph, stroked with its tint (a canvas drawn in a binding: again
/// when the glyph, its tint or the appearance changes).
#[component]
pub(crate) fn Glyph(props: GlyphProps) -> impl IntoElement {
    let size = props.size;
    view()
        .size(px(size))
        .pointer_events(PointerEvents::None)
        .child(
            canvas(move || {
                let tint = props.tint.get();
                let tint = color(AdaptiveColor::new(tint.light, tint.dark));
                let scale = size / 20.0;
                let painter = Painter::new()
                    .scale(scale, scale)
                    .stroke_color(tint)
                    .fill_color(tint)
                    .line_width(1.6)
                    .line_cap(LineCap::Round)
                    .line_join(LineJoin::Round);
                props.name.get().draw(painter)
            })
            .size_full(),
        )
}

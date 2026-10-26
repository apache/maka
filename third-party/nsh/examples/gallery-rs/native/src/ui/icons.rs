//! The gallery's icons (as the TSX gallery's `icons.tsx`): line glyphs
//! drawn in a 20 × 20 box with the tint as stroke.

use std::f32::consts::{PI, TAU};

use nsh_core::{
    canvas::{LineCap, LineJoin},
    element::{JsObject, PropEnum},
    geometry::size,
    prelude::*,
};

use super::{lengths, pt};

/// A glyph of [`Icon`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum IconName {
    /// A framed landscape.
    Photos,
    /// Bulleted lines.
    Lists,
    /// A phone with an arrow down.
    Scroll,
    /// Two screens over each other.
    Nav,
    /// Two fields.
    Form,
    /// A phone.
    Mobile,
    /// Squares and a circle.
    Components,
    /// A tapping finger.
    Gestures,
    /// A ball over the ground.
    Physics,
    /// An eased curve.
    Animation,
    /// A picture.
    Image,
    /// A pen.
    Canvas,
    /// Two waves.
    Tailwind,
    /// Two overlapping shapes.
    Styles,
    /// A T.
    Text,
    /// A play button on a screen.
    Media,
    /// A cog.
    System,
    /// Two candles.
    Stocks,
    /// A speech bubble.
    Chat,
    /// A cylinder of stacked disks.
    Storage,
    /// `>`.
    #[default]
    Chevron,
    /// A tick.
    Check,
    /// `+`.
    Plus,
    /// An arrow up.
    #[prop(rename = "arrow-up")]
    ArrowUp,
    /// An arrow down.
    #[prop(rename = "arrow-down")]
    ArrowDown,
    /// A filled triangle.
    Play,
    /// Two filled bars.
    Pause,
    /// A magnifier.
    Search,
    /// A star.
    Star,
    /// A bell.
    Bell,
    /// A four-pointed spark.
    Spark,
}

nsh_core::static_reactive!(IconName: IconName);

fn line(p: Painter, points: &[f32]) -> Painter {
    let mut p = p.begin_path().move_to(points[0], points[1]);
    for xy in points[2..].chunks(2) {
        p = p.line_to(xy[0], xy[1]);
    }
    p.stroke()
}

fn rect(p: Painter, x: f32, y: f32, w: f32, h: f32, r: f32) -> Painter {
    p.begin_path()
        .round_rect(super::rect(x, y, w, h), px(r))
        .stroke()
}

fn circle(p: Painter, x: f32, y: f32, r: f32, fill: bool) -> Painter {
    let p = p.begin_path().arc(x, y, r, 0.0, TAU);
    if fill { p.fill() } else { p.stroke() }
}

impl IconName {
    /// Draws the glyph in a 20 × 20 box.
    fn draw(self, c: Painter) -> Painter {
        match self {
            IconName::Photos => {
                let c = rect(c, 3.0, 4.0, 14.0, 12.0, 3.0);
                let c = line(
                    c,
                    &[3.0, 13.0, 8.0, 9.0, 12.0, 12.0, 14.0, 10.0, 17.0, 13.0],
                );
                circle(c, 13.0, 7.5, 1.2, false)
            }
            IconName::Lists => [5.0, 10.0, 15.0].into_iter().fold(c, |c, y| {
                let c = circle(c, 4.5, y, 1.1, true);
                line(c, &[8.0, y, 17.0, y])
            }),
            IconName::Scroll => {
                let c = rect(c, 5.0, 2.5, 10.0, 15.0, 3.0);
                let c = line(c, &[10.0, 6.0, 10.0, 9.0]);
                line(c, &[8.0, 12.0, 10.0, 14.0, 12.0, 12.0])
            }
            IconName::Nav => {
                let c = rect(c, 2.5, 4.0, 9.0, 12.0, 2.5);
                let c = rect(c, 8.5, 4.0, 9.0, 12.0, 2.5);
                line(c, &[12.0, 10.0, 15.0, 10.0])
            }
            IconName::Form => {
                let c = rect(c, 3.0, 4.0, 14.0, 5.0, 2.0);
                let c = rect(c, 3.0, 11.0, 14.0, 5.0, 2.0);
                let c = line(c, &[6.0, 6.5, 6.0, 6.5]);
                line(c, &[5.5, 13.5, 9.0, 13.5])
            }
            IconName::Mobile => {
                let c = rect(c, 5.5, 2.5, 9.0, 15.0, 2.5);
                line(c, &[9.0, 15.0, 11.0, 15.0])
            }
            IconName::Components => {
                let c = rect(c, 3.0, 3.0, 6.0, 6.0, 1.6);
                let c = rect(c, 11.0, 3.0, 6.0, 6.0, 1.6);
                let c = rect(c, 3.0, 11.0, 6.0, 6.0, 1.6);
                circle(c, 14.0, 14.0, 3.0, false)
            }
            IconName::Gestures => {
                let c = line(c, &[8.0, 17.0, 8.0, 7.5, 10.0, 6.0, 11.0, 7.5, 11.0, 11.0]);
                let c = line(
                    c,
                    &[11.0, 10.0, 13.0, 9.5, 14.0, 11.0, 14.0, 14.0, 12.0, 17.0],
                );
                let c = line(c, &[5.0, 4.0, 3.5, 2.5]);
                line(c, &[11.0, 3.0, 12.5, 1.5])
            }
            IconName::Physics => {
                let c = circle(c, 10.0, 6.0, 3.0, false);
                let c = line(c, &[3.0, 16.0, 17.0, 16.0]);
                let c = line(c, &[6.0, 12.0, 6.0, 12.1]);
                let c = line(c.line_dash(&lengths([1.5, 2.0])), &[10.0, 9.0, 10.0, 15.0]);
                c.line_dash(&[])
            }
            IconName::Animation => {
                let c = line(c, &[3.0, 15.0, 7.0, 15.0, 13.0, 5.0, 17.0, 5.0]);
                circle(c, 13.0, 5.0, 1.6, true)
            }
            IconName::Image => {
                let c = rect(c, 3.0, 3.5, 14.0, 13.0, 3.0);
                let c = line(c, &[3.0, 14.0, 8.0, 9.0, 13.0, 14.0]);
                line(c, &[11.0, 12.0, 13.0, 10.0, 17.0, 14.0])
            }
            IconName::Canvas => {
                let c = line(
                    c,
                    &[
                        4.0, 16.0, 6.0, 11.0, 14.0, 3.0, 17.0, 6.0, 9.0, 14.0, 4.0, 16.0,
                    ],
                );
                line(c, &[12.5, 4.5, 15.5, 7.5])
            }
            IconName::Tailwind => {
                let c = line(
                    c,
                    &[
                        3.0, 9.0, 5.0, 6.0, 8.0, 6.0, 10.0, 8.0, 12.0, 10.0, 15.0, 10.0, 17.0, 7.0,
                    ],
                );
                line(
                    c,
                    &[
                        3.0, 14.0, 5.0, 11.0, 8.0, 11.0, 10.0, 13.0, 12.0, 15.0, 15.0, 15.0, 17.0,
                        12.0,
                    ],
                )
            }
            IconName::Styles => {
                let c = rect(c, 3.0, 3.0, 9.0, 9.0, 2.0);
                rect(c, 8.0, 8.0, 9.0, 9.0, 4.5)
            }
            IconName::Text => {
                let c = line(c, &[4.0, 5.0, 16.0, 5.0]);
                let c = line(c, &[10.0, 5.0, 10.0, 16.0]);
                line(c, &[7.5, 16.0, 12.5, 16.0])
            }
            IconName::Media => {
                let c = rect(c, 2.5, 4.0, 15.0, 12.0, 3.0);
                line(c, &[8.5, 7.5, 12.5, 10.0, 8.5, 12.5, 8.5, 7.5])
            }
            IconName::System => (0..8).fold(circle(c, 10.0, 10.0, 3.0, false), |c, i| {
                let a = i as f32 * PI / 4.0;
                let (sin, cos) = a.sin_cos();
                line(
                    c,
                    &[
                        10.0 + cos * 5.5,
                        10.0 + sin * 5.5,
                        10.0 + cos * 7.5,
                        10.0 + sin * 7.5,
                    ],
                )
            }),
            IconName::Stocks => {
                let c = line(c, &[6.0, 4.0, 6.0, 16.0]);
                let c = rect(c, 4.5, 7.0, 3.0, 5.0, 0.8);
                let c = line(c, &[13.0, 3.0, 13.0, 15.0]);
                let c = rect(c, 11.5, 5.0, 3.0, 7.0, 0.8);
                line(c, &[3.0, 17.5, 17.0, 17.5])
            }
            IconName::Chat => {
                let c = line(
                    c,
                    &[
                        6.0, 16.5, 6.0, 14.0, 5.0, 14.0, 3.0, 12.0, 3.0, 6.0, 5.0, 4.0, 15.0, 4.0,
                        17.0, 6.0, 17.0, 12.0, 15.0, 14.0, 9.0, 14.0, 6.0, 16.5,
                    ],
                );
                let c = line(c, &[7.0, 8.0, 13.0, 8.0]);
                line(c, &[7.0, 10.5, 11.0, 10.5])
            }
            IconName::Storage => {
                // The top, then the front edge of two disks under it.
                let c = c
                    .begin_path()
                    .ellipse(
                        pt(10.0, 5.0),
                        size(px(6.0), px(2.2)),
                        Radians(0.0),
                        Radians(0.0),
                        Radians(TAU),
                        false,
                    )
                    .stroke();
                let c = line(c, &[4.0, 5.0, 4.0, 15.0]);
                let c = line(c, &[16.0, 5.0, 16.0, 15.0]);
                [10.0, 15.0].into_iter().fold(c, |c, y| {
                    c.begin_path()
                        .ellipse(
                            pt(10.0, y),
                            size(px(6.0), px(2.2)),
                            Radians(0.0),
                            Radians(0.0),
                            Radians(PI),
                            false,
                        )
                        .stroke()
                })
            }
            IconName::Chevron => line(c, &[7.5, 5.0, 12.5, 10.0, 7.5, 15.0]),
            IconName::Check => line(c, &[4.5, 10.5, 8.5, 14.0, 15.5, 6.0]),
            IconName::Plus => {
                let c = line(c, &[10.0, 4.0, 10.0, 16.0]);
                line(c, &[4.0, 10.0, 16.0, 10.0])
            }
            IconName::ArrowUp => {
                let c = line(c, &[10.0, 16.0, 10.0, 4.0]);
                line(c, &[5.0, 9.0, 10.0, 4.0, 15.0, 9.0])
            }
            IconName::ArrowDown => {
                let c = line(c, &[10.0, 4.0, 10.0, 16.0]);
                line(c, &[5.0, 11.0, 10.0, 16.0, 15.0, 11.0])
            }
            IconName::Play => c
                .begin_path()
                .move_to(6.5, 4.5)
                .line_to(15.5, 10.0)
                .line_to(6.5, 15.5)
                .close_path()
                .fill(),
            IconName::Pause => c
                .fill_rect(5.5, 4.5, 3.0, 11.0)
                .fill_rect(11.5, 4.5, 3.0, 11.0),
            IconName::Search => {
                let c = circle(c, 8.5, 8.5, 5.0, false);
                line(c, &[12.3, 12.3, 16.5, 16.5])
            }
            IconName::Star => {
                let mut c = c.begin_path();
                for i in 0..10 {
                    let r = if i % 2 == 1 { 3.2 } else { 7.0 };
                    let a = -PI / 2.0 + i as f32 * PI / 5.0;
                    let (x, y) = (10.0 + a.cos() * r, 10.5 + a.sin() * r);
                    c = if i == 0 {
                        c.move_to(x, y)
                    } else {
                        c.line_to(x, y)
                    };
                }
                c.close_path().stroke()
            }
            IconName::Bell => {
                let c = line(
                    c,
                    &[
                        5.0, 14.0, 5.0, 9.0, 7.0, 5.5, 10.0, 4.5, 13.0, 5.5, 15.0, 9.0, 15.0, 14.0,
                        5.0, 14.0,
                    ],
                );
                line(c, &[8.5, 16.5, 11.5, 16.5])
            }
            IconName::Spark => line(
                c,
                &[
                    10.0, 3.0, 11.5, 8.5, 17.0, 10.0, 11.5, 11.5, 10.0, 17.0, 8.5, 11.5, 3.0, 10.0,
                    8.5, 8.5, 10.0, 3.0,
                ],
            ),
        }
    }
}

/// A color for each appearance, as a prop.
#[derive(Debug, Clone, Copy, Default, PartialEq, JsObject)]
pub(crate) struct Tint {
    /// In light appearance.
    pub(crate) light: Hsla,
    /// In dark appearance.
    pub(crate) dark: Hsla,
}

impl From<AdaptiveColor> for Tint {
    fn from(c: AdaptiveColor) -> Self {
        Self {
            light: c.light,
            dark: c.dark,
        }
    }
}

/// The props of [`Icon`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct IconProps {
    /// The glyph.
    pub(crate) name: Prop<IconName>,
    /// Its width and height, in points.
    #[prop(default = 20.0)]
    pub(crate) size: Prop<f32>,
    /// Its color.
    pub(crate) tint: Prop<Tint>,
}

/// A glyph, stroked with its tint (a canvas drawn in a binding: again when
/// the glyph, its tint or the appearance changes).
#[component]
pub(crate) fn Icon(props: IconProps) -> impl IntoElement {
    view()
        .size(move || px(props.size.get()))
        .pointer_events(PointerEvents::None)
        .child(
            canvas(move || {
                let tint = props.tint.get();
                let tint = color(AdaptiveColor::new(tint.light, tint.dark));
                let scale = props.size.get() / 20.0;
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

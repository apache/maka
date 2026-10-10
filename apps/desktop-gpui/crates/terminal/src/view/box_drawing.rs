/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Box-drawing (U+2500–U+257F) and block (U+2580–U+259F) characters drawn
//! as quads rather than glyphs: a font draws them to its own line height,
//! so at the terminal's taller lines its strokes would stop short of the
//! cell's edges and leave gaps between rows. Quads span the whole cell.
//!
//! The straight lines (light, heavy, double, and the half lines) and every
//! block and shade are quads; the rounded corners (╭╮╯╰) are quarter arcs
//! on the cell's centre lines, at the light stroke's weight, drawn as the
//! rounded corner of a bordered quad clipped to the cell; the dashed lines
//! and the diagonals stay with the font.

use gpui_kit::{Bounds, Corners, Edges, Pixels, point, px, size};

/// How one arm of a line character is drawn, from the cell's centre to an
/// edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Weight {
    None,
    Light,
    Heavy,
    Double,
}

/// A part of a block character: from `x0`, `y0` to `x1`, `y1` in fractions
/// of the cell, filled at `alpha` of the ink (shades are partial).
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct BlockPart {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub alpha: f32,
}

const fn part(x0: f32, y0: f32, x1: f32, y1: f32) -> BlockPart {
    BlockPart { x0, y0, x1, y1, alpha: 1. }
}

const fn shade(alpha: f32) -> BlockPart {
    BlockPart { x0: 0., y0: 0., x1: 1., y1: 1., alpha }
}

/// A rounded corner: which arms its arc joins.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RoundCorner {
    /// ╭: right and down.
    DownRight,
    /// ╮: left and down.
    DownLeft,
    /// ╯: left and up.
    UpLeft,
    /// ╰: right and up.
    UpRight,
}

/// A character drawn as quads.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum BoxGlyph {
    /// Lines from the centre to the left, right, top and bottom edges.
    Lines {
        left: Weight,
        right: Weight,
        up: Weight,
        down: Weight,
    },
    Blocks(&'static [BlockPart]),
    /// A light line that turns a corner in an arc.
    Arc(RoundCorner),
}

/// The arms of U+2500–U+257F as "left right up down", ` ` none, `l`
/// light, `h` heavy, `d` double; `None` for those the font draws.
const LINES: [Option<&str>; 128] = [
    Some("ll  "),
    Some("hh  "),
    Some("  ll"),
    Some("  hh"), // ─━│┃
    None,
    None,
    None,
    None,
    None,
    None,
    None,
    None, // dashed ┄┅┆┇┈┉┊┋
    Some(" l l"),
    Some(" h l"),
    Some(" l h"),
    Some(" h h"), // ┌┍┎┏
    Some("l  l"),
    Some("h  l"),
    Some("l  h"),
    Some("h  h"), // ┐┑┒┓
    Some(" ll "),
    Some(" hl "),
    Some(" lh "),
    Some(" hh "), // └┕┖┗
    Some("l l "),
    Some("h l "),
    Some("l h "),
    Some("h h "), // ┘┙┚┛
    Some(" lll"),
    Some(" hll"),
    Some(" lhl"),
    Some(" llh"), // ├┝┞┟
    Some(" lhh"),
    Some(" hhl"),
    Some(" hlh"),
    Some(" hhh"), // ┠┡┢┣
    Some("l ll"),
    Some("h ll"),
    Some("l hl"),
    Some("l lh"), // ┤┥┦┧
    Some("l hh"),
    Some("h hl"),
    Some("h lh"),
    Some("h hh"), // ┨┩┪┫
    Some("ll l"),
    Some("hl l"),
    Some("lh l"),
    Some("hh l"), // ┬┭┮┯
    Some("ll h"),
    Some("hl h"),
    Some("lh h"),
    Some("hh h"), // ┰┱┲┳
    Some("lll "),
    Some("hll "),
    Some("lhl "),
    Some("hhl "), // ┴┵┶┷
    Some("llh "),
    Some("hlh "),
    Some("lhh "),
    Some("hhh "), // ┸┹┺┻
    Some("llll"),
    Some("hlll"),
    Some("lhll"),
    Some("hhll"), // ┼┽┾┿
    Some("llhl"),
    Some("lllh"),
    Some("llhh"),
    Some("hlhl"), // ╀╁╂╃
    Some("lhhl"),
    Some("hllh"),
    Some("lhlh"),
    Some("hhhl"), // ╄╅╆╇
    Some("hhlh"),
    Some("hlhh"),
    Some("lhhh"),
    Some("hhhh"), // ╈╉╊╋
    None,
    None,
    None,
    None, // dashed ╌╍╎╏
    Some("dd  "),
    Some("  dd"),
    Some(" d l"),
    Some(" l d"), // ═║╒╓
    Some(" d d"),
    Some("d  l"),
    Some("l  d"),
    Some("d  d"), // ╔╕╖╗
    Some(" dl "),
    Some(" ld "),
    Some(" dd "),
    Some("d l "), // ╘╙╚╛
    Some("l d "),
    Some("d d "),
    Some(" dll"),
    Some(" ldd"), // ╜╝╞╟
    Some(" ddd"),
    Some("d ll"),
    Some("l dd"),
    Some("d dd"), // ╠╡╢╣
    Some("dd l"),
    Some("ll d"),
    Some("dd d"),
    Some("ddl "), // ╤╥╦╧
    Some("lld "),
    Some("ddd "),
    Some("ddll"),
    Some("lldd"), // ╨╩╪╫
    Some("dddd"),
    None,
    None,
    None, // ╬ and the arcs ╭╮╯
    None,
    None,
    None,
    None, // the arc ╰ and the diagonals ╱╲╳
    Some("l   "),
    Some("  l "),
    Some(" l  "),
    Some("   l"), // ╴╵╶╷
    Some("h   "),
    Some("  h "),
    Some(" h  "),
    Some("   h"), // ╸╹╺╻
    Some("lh  "),
    Some("  lh"),
    Some("hl  "),
    Some("  hl"), // ╼╽╾╿
];

const EIGHTH: f32 = 1. / 8.;

/// U+2580–U+259F.
const BLOCKS: [&[BlockPart]; 32] = [
    &[part(0., 0., 1., 0.5)],                          // ▀
    &[part(0., 7. * EIGHTH, 1., 1.)],                  // ▁
    &[part(0., 6. * EIGHTH, 1., 1.)],                  // ▂
    &[part(0., 5. * EIGHTH, 1., 1.)],                  // ▃
    &[part(0., 0.5, 1., 1.)],                          // ▄
    &[part(0., 3. * EIGHTH, 1., 1.)],                  // ▅
    &[part(0., 2. * EIGHTH, 1., 1.)],                  // ▆
    &[part(0., EIGHTH, 1., 1.)],                       // ▇
    &[part(0., 0., 1., 1.)],                           // █
    &[part(0., 0., 7. * EIGHTH, 1.)],                  // ▉
    &[part(0., 0., 6. * EIGHTH, 1.)],                  // ▊
    &[part(0., 0., 5. * EIGHTH, 1.)],                  // ▋
    &[part(0., 0., 0.5, 1.)],                          // ▌
    &[part(0., 0., 3. * EIGHTH, 1.)],                  // ▍
    &[part(0., 0., 2. * EIGHTH, 1.)],                  // ▎
    &[part(0., 0., EIGHTH, 1.)],                       // ▏
    &[part(0.5, 0., 1., 1.)],                          // ▐
    &[shade(0.25)],                                    // ░
    &[shade(0.5)],                                     // ▒
    &[shade(0.75)],                                    // ▓
    &[part(0., 0., 1., EIGHTH)],                       // ▔
    &[part(7. * EIGHTH, 0., 1., 1.)],                  // ▕
    &[part(0., 0.5, 0.5, 1.)],                         // ▖
    &[part(0.5, 0.5, 1., 1.)],                         // ▗
    &[part(0., 0., 0.5, 0.5)],                         // ▘
    &[part(0., 0., 0.5, 1.), part(0.5, 0.5, 1., 1.)],  // ▙
    &[part(0., 0., 0.5, 0.5), part(0.5, 0.5, 1., 1.)], // ▚
    &[part(0., 0., 1., 0.5), part(0., 0.5, 0.5, 1.)],  // ▛
    &[part(0., 0., 1., 0.5), part(0.5, 0.5, 1., 1.)],  // ▜
    &[part(0.5, 0., 1., 0.5)],                         // ▝
    &[part(0.5, 0., 1., 0.5), part(0., 0.5, 0.5, 1.)], // ▞
    &[part(0.5, 0., 1., 1.), part(0., 0.5, 0.5, 1.)],  // ▟
];

/// How `c` is drawn as quads, when it is.
pub(crate) fn glyph(c: char) -> Option<BoxGlyph> {
    let code = u32::from(c);
    match code {
        0x256D => Some(BoxGlyph::Arc(RoundCorner::DownRight)),
        0x256E => Some(BoxGlyph::Arc(RoundCorner::DownLeft)),
        0x256F => Some(BoxGlyph::Arc(RoundCorner::UpLeft)),
        0x2570 => Some(BoxGlyph::Arc(RoundCorner::UpRight)),
        0x2500..=0x257F => {
            let arms = LINES[(code - 0x2500) as usize]?;
            let mut weights = arms.chars().map(|arm| match arm {
                'l' => Weight::Light,
                'h' => Weight::Heavy,
                'd' => Weight::Double,
                _ => Weight::None,
            });
            let mut next = || weights.next().unwrap_or(Weight::None);
            Some(BoxGlyph::Lines { left: next(), right: next(), up: next(), down: next() })
        }
        0x2580..=0x259F => Some(BoxGlyph::Blocks(BLOCKS[(code - 0x2580) as usize])),
        _ => None,
    }
}

/// The quads that draw `glyph` in `cell`, each with the share of the ink
/// it is filled at. `light` is a light stroke's thickness; every edge lands
/// on a device pixel (`scale` of them per point), so adjacent cells meet
/// without a seam and strokes stay crisp.
pub(crate) fn quads(
    glyph: &BoxGlyph,
    cell: Bounds<Pixels>,
    light: Pixels,
    scale: f32,
) -> Vec<(Bounds<Pixels>, f32)> {
    let snap = |value: Pixels| px((f32::from(value) * scale).round() / scale);
    let device = px(1. / scale);
    let span = |x0: Pixels, y0: Pixels, x1: Pixels, y1: Pixels| {
        let (x0, y0) = (snap(x0), snap(y0));
        let (x1, y1) = (snap(x1).max(x0 + device), snap(y1).max(y0 + device));
        Bounds::new(point(x0, y0), size(x1 - x0, y1 - y0))
    };
    match glyph {
        BoxGlyph::Arc(_) => Vec::new(),
        BoxGlyph::Blocks(parts) => parts
            .iter()
            .map(|part| {
                let x = |fraction: f32| cell.origin.x + cell.size.width * fraction;
                let y = |fraction: f32| cell.origin.y + cell.size.height * fraction;
                (span(x(part.x0), y(part.y0), x(part.x1), y(part.y1)), part.alpha)
            })
            .collect(),
        BoxGlyph::Lines { left, right, up, down } => {
            let light = snap(light).max(device);
            let heavy = light * 2.;
            let thickness = |weight: Weight| match weight {
                Weight::None => px(0.),
                Weight::Light | Weight::Double => light,
                Weight::Heavy => heavy,
            };
            // A double line's two strokes, either side of the centre line.
            let gap = light;
            let centre = point(
                snap(cell.origin.x + cell.size.width / 2.),
                snap(cell.origin.y + cell.size.height / 2.),
            );
            // How far past the centre an arm reaches, to meet the arms across
            // it: half the widest of them, past a double's outer stroke.
            let reach = |one: Weight, other: Weight| {
                let width = |weight: Weight| match weight {
                    Weight::Double => gap + light * 1.5,
                    weight => thickness(weight) / 2.,
                };
                width(one).max(width(other))
            };
            let across_vertical = reach(*up, *down);
            let across_horizontal = reach(*left, *right);
            let mut out = Vec::new();
            let mut horizontal = |weight: Weight, x0: Pixels, x1: Pixels| {
                let offsets: &[f32] = match weight {
                    Weight::None => &[],
                    Weight::Double => &[-1., 1.],
                    _ => &[0.],
                };
                let t = thickness(weight);
                for offset in offsets {
                    let y = centre.y + (gap + light) * *offset - t / 2.;
                    out.push((span(x0, y, x1, y + t), 1.));
                }
            };
            // Arms of one weight either side are one stroke across the cell.
            if left == right {
                horizontal(*left, cell.origin.x, cell.right());
            } else {
                horizontal(*left, cell.origin.x, centre.x + across_vertical);
                horizontal(*right, centre.x - across_vertical, cell.right());
            }
            let mut vertical = |weight: Weight, y0: Pixels, y1: Pixels| {
                let offsets: &[f32] = match weight {
                    Weight::None => &[],
                    Weight::Double => &[-1., 1.],
                    _ => &[0.],
                };
                let t = thickness(weight);
                for offset in offsets {
                    let x = centre.x + (gap + light) * *offset - t / 2.;
                    out.push((span(x, y0, x + t, y1), 1.));
                }
            };
            if up == down {
                vertical(*up, cell.origin.y, cell.bottom());
            } else {
                vertical(*up, cell.origin.y, centre.y + across_horizontal);
                vertical(*down, centre.y - across_horizontal, cell.bottom());
            }
            out
        }
    }
}

/// A rounded corner as one bordered quad: the quad's rounded corner is the
/// arc, its two borders the arms. Painted inside `clip` (the cell), which
/// cuts off the rest of the quad.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ArcStroke {
    pub bounds: Bounds<Pixels>,
    pub corner_radii: Corners<Pixels>,
    pub border_widths: Edges<Pixels>,
    pub clip: Bounds<Pixels>,
}

/// The stroke that draws `arc` in `cell`: its arms on the centre lines,
/// where a straight line's stroke lies (snapped the same way, `light`
/// thick), joined by a quarter circle whose centre line has the radius of
/// the shorter arm, so the arc meets one cell edge square and runs straight
/// to the other.
pub(crate) fn arc(
    corner: RoundCorner,
    cell: Bounds<Pixels>,
    light: Pixels,
    scale: f32,
) -> ArcStroke {
    let snap = |value: Pixels| px((f32::from(value) * scale).round() / scale);
    let device = px(1. / scale);
    let light = snap(light).max(device);
    let centre = point(
        snap(cell.origin.x + cell.size.width / 2.),
        snap(cell.origin.y + cell.size.height / 2.),
    );
    let (right, down) = match corner {
        RoundCorner::DownRight => (true, true),
        RoundCorner::DownLeft => (false, true),
        RoundCorner::UpLeft => (false, false),
        RoundCorner::UpRight => (true, false),
    };
    let across = if right { cell.right() - centre.x } else { centre.x - cell.origin.x };
    let along = if down { cell.bottom() - centre.y } else { centre.y - cell.origin.y };
    let radius = across.min(along).max(px(0.));
    // The quad's outer edge is half a stroke outside the centre line, and
    // it reaches a cell past the cell's far edges, which the clip cuts.
    let half = light / 2.;
    let x0 = if right { centre.x - half } else { cell.origin.x - cell.size.width };
    let x1 = if right { cell.right() + cell.size.width } else { centre.x + half };
    let y0 = if down { centre.y - half } else { cell.origin.y - cell.size.height };
    let y1 = if down { cell.bottom() + cell.size.height } else { centre.y + half };
    let outer = radius + half;
    let none = px(0.);
    let corner_radii = Corners {
        top_left: if right && down { outer } else { none },
        top_right: if !right && down { outer } else { none },
        bottom_right: if !right && !down { outer } else { none },
        bottom_left: if right && !down { outer } else { none },
    };
    let border_widths = Edges {
        top: if down { light } else { none },
        bottom: if down { none } else { light },
        left: if right { light } else { none },
        right: if right { none } else { light },
    };
    ArcStroke {
        bounds: Bounds::new(point(x0, y0), size(x1 - x0, y1 - y0)),
        corner_radii,
        border_widths,
        clip: cell,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cell() -> Bounds<Pixels> {
        Bounds::new(point(px(10.), px(20.)), size(px(8.), px(20.)))
    }

    #[test]
    fn lines_blocks_and_shades_are_glyphs_and_dashes_are_the_fonts() {
        assert_eq!(
            glyph('┼'),
            Some(BoxGlyph::Lines {
                left: Weight::Light,
                right: Weight::Light,
                up: Weight::Light,
                down: Weight::Light
            })
        );
        assert_eq!(
            glyph('╔'),
            Some(BoxGlyph::Lines {
                left: Weight::None,
                right: Weight::Double,
                up: Weight::None,
                down: Weight::Double
            })
        );
        assert!(matches!(glyph('█'), Some(BoxGlyph::Blocks(_))));
        assert!(
            matches!(glyph('░'), Some(BoxGlyph::Blocks([BlockPart { alpha, .. }])) if *alpha == 0.25)
        );
        assert_eq!(glyph('╭'), Some(BoxGlyph::Arc(RoundCorner::DownRight)));
        assert_eq!(glyph('╰'), Some(BoxGlyph::Arc(RoundCorner::UpRight)));
        assert_eq!(glyph('┄'), None);
        assert_eq!(glyph('╱'), None);
        assert_eq!(glyph('a'), None);
    }

    #[test]
    fn a_line_spans_its_cell_edge_to_edge() {
        let horizontal = quads(&glyph('─').expect("line"), cell(), px(1.), 2.);
        let [(bar, alpha)] = horizontal.as_slice() else { panic!("{horizontal:?}") };
        assert_eq!(*alpha, 1.);
        assert_eq!((bar.left(), bar.right()), (px(10.), px(18.)), "the whole width");
        assert_eq!(bar.size.height, px(1.));
        let vertical = quads(&glyph('│').expect("line"), cell(), px(1.), 2.);
        assert_eq!((vertical[0].0.top(), vertical[0].0.bottom()), (px(20.), px(40.)));
        // A cross is a stroke each way, through the centre.
        let cross = quads(&glyph('┼').expect("line"), cell(), px(1.), 2.);
        assert_eq!(cross.len(), 2);
        // A corner's arms meet past the centre.
        let corner = quads(&glyph('┌').expect("line"), cell(), px(1.), 2.);
        let (right, down) = (corner[0].0, corner[1].0);
        assert!(right.left() <= down.left() && down.top() <= right.top(), "{right:?} {down:?}");
        assert_eq!((right.right(), down.bottom()), (px(18.), px(40.)));
        // A double line is two strokes.
        assert_eq!(quads(&glyph('═').expect("line"), cell(), px(1.), 2.).len(), 2);
    }

    #[test]
    fn the_four_rounded_corners_are_arcs_on_the_centre_lines_at_the_light_weight() {
        let cell = cell();
        let light = px(1.);
        // The straight lines the arcs join: their strokes lie where the
        // arcs' arms do.
        let horizontal = quads(&glyph('─').expect("line"), cell, light, 2.)[0].0;
        let vertical = quads(&glyph('│').expect("line"), cell, light, 2.)[0].0;
        let cases = [
            ('╭', (true, true)),
            ('╮', (false, true)),
            ('╯', (false, false)),
            ('╰', (true, false)),
        ];
        for (c, (right, down)) in cases {
            let Some(BoxGlyph::Arc(corner)) = glyph(c) else { panic!("{c} is an arc") };
            let stroke = arc(corner, cell, light, 2.);
            assert_eq!(stroke.clip, cell, "{c}: drawn inside its cell");
            // One corner rounded, the one between the two arms.
            let radii = stroke.corner_radii;
            let rounded = [
                (radii.top_left, right && down),
                (radii.top_right, !right && down),
                (radii.bottom_right, !right && !down),
                (radii.bottom_left, right && !down),
            ];
            for (radius, expected) in rounded {
                assert_eq!(radius > px(0.), expected, "{c}: {radii:?}");
            }
            // Its arms are borders of the light weight, on the centre lines.
            let borders = stroke.border_widths;
            let (arm_horizontal, arm_vertical) = (
                if down { borders.top } else { borders.bottom },
                if right { borders.left } else { borders.right },
            );
            assert_eq!(
                (arm_horizontal, arm_vertical),
                (horizontal.size.height, vertical.size.width)
            );
            let edge_y = if down { stroke.bounds.top() } else { stroke.bounds.bottom() };
            let edge_x = if right { stroke.bounds.left() } else { stroke.bounds.right() };
            assert_eq!(edge_y, if down { horizontal.top() } else { horizontal.bottom() }, "{c}");
            assert_eq!(edge_x, if right { vertical.left() } else { vertical.right() }, "{c}");
            // The quad runs past the cell's edges in the arms' directions, so
            // the arms reach them.
            if right {
                assert!(stroke.bounds.right() > cell.right());
            } else {
                assert!(stroke.bounds.left() < cell.left());
            }
            if down {
                assert!(stroke.bounds.bottom() > cell.bottom());
            } else {
                assert!(stroke.bounds.top() < cell.top());
            }
            // The arc's centre line has the radius of the shorter arm: half
            // the cell's width here, so it meets the side edge square.
            let outer = rounded.iter().map(|(radius, _)| *radius).fold(px(0.), Pixels::max);
            assert_eq!(outer - arm_horizontal / 2., px(4.), "{c}");
        }
        // They draw no quads of their own.
        assert!(quads(&glyph('╭').expect("arc"), cell, light, 2.).is_empty());
    }

    #[test]
    fn a_full_block_fills_the_cell_and_halves_meet() {
        let full = quads(&glyph('█').expect("block"), cell(), px(1.), 2.);
        assert_eq!(full, [(cell(), 1.)]);
        let upper = quads(&glyph('▀').expect("block"), cell(), px(1.), 2.)[0].0;
        let lower = quads(&glyph('▄').expect("block"), cell(), px(1.), 2.)[0].0;
        assert_eq!(upper.bottom(), lower.top());
    }
}

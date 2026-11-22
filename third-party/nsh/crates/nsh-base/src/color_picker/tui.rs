//! The terminal forms of a [`ColorPicker`](super::ColorPicker)'s parts
//! ([`crate::terminal`]): a slider is one row of Cells, each filled with the
//! channel's color at that point of the track, the thumb a `│` on the Cell
//! of the value ([`terminal::COLOR_THUMB`]), bold on the accent while the
//! slider has the focus; the area a grid of Cells
//! colored by saturation (across) and brightness (down) filling the area's
//! whole Cells, the picked Cell marked `◆`. The Cells' fills are pictures
//! of colors (role `Image`, hidden from screen readers): the terminal
//! paints them as the colors themselves (quantized where it has fewer),
//! and where it paints no fills the thumb's and the picked Cell's glyphs
//! show the value. The part takes the keyboard focus and is the adjustable
//! control screen readers hear, with the keys of its GUI form; a press or
//! a drag on a Cell picks its value.

use nsh_core::{AccessibilityValue, Color, element::layout_rtl, prelude::*};

use super::{AREA_KEYS, ColorChannel, ColorFormat, ColorSpace, Nudge, Picker, SliderCtl, action};
use crate::{
    keys::bind_while_directed,
    terminal::{self, columns_in, track_cell},
};

/// The most Cells an area's grid has across (wider than any terminal's
/// card): wider areas keep the grid at their start.
pub(super) const AREA_COLUMNS: usize = 240;
/// The most rows of an area's grid.
pub(super) const AREA_ROWS: usize = 64;

/// One Cell's size: the grid's the core lays out on, else as the
/// terminal's text engine measures one glyph.
fn cell_size() -> Size<Points> {
    nsh_core::element::cell_size().unwrap_or_else(|| {
        let metrics = text_metrics("", "0");
        Size::new(metrics.width, metrics.height)
    })
}

/// A Cell of `color` showing `glyph`: a picture of the color, which the
/// terminal fills with it. It is one Cell (`cell`) whatever its glyph
/// measures: the track's and the grid's Cells are counted from the Cell's
/// size, and a glyph measured wider (`━` and `●` are of ambiguous width)
/// would push the last of them out of the row.
fn color_cell(
    cell: Size<Points>,
    glyph: impl Fn() -> &'static str + 'static,
    color: impl Fn() -> Hsla + 'static,
) -> View {
    view()
        .w(cell.width)
        .h(cell.height)
        .flex_shrink(0.0)
        .overflow_hidden()
        .role(AccessibilityRole::Image)
        .style_with(move |s| s.bg(AdaptiveColor::from(color())))
        .child(text(move || SharedString::from(glyph())))
}

/// Where `t` (0 to 1) of a track or an area falls among `n` Cells, and back:
/// the first Cell is 0, the last 1.
fn cell_fraction(cell: usize, n: usize) -> f64 {
    match n {
        0 | 1 => 0.5,
        n => cell as f64 / (n - 1) as f64,
    }
}

/// The Cell under `x` points from the start of a row of `n` Cells `width`
/// wide each.
fn cell_at(x: f64, width: Points, n: usize) -> usize {
    if n == 0 || width.0 <= 0.0 {
        return 0;
    }
    ((x / f64::from(width.0)).floor().max(0.0) as usize).min(n - 1)
}

/// A color slider's terminal form ([`super::ColorSlider`]): the track as a
/// row of colored Cells over the slider's width, the thumb a `│` on the
/// Cell of the value, the slider itself the focusable adjustable control.
pub(super) fn slider(
    ctl: SliderCtl,
    focused: Signal<bool>,
    label: Prop<Option<SharedString>>,
) -> AnyElement {
    let cell = cell_size();
    let columns = signal(0usize);
    // The track's colors on each Cell from its start (`min`), once per
    // change of the color or the width.
    let colors = computed(move || {
        let n = columns.get();
        let (space, channel) = ctl.pair();
        let m = ctl.picker.get();
        (0..n)
            .map(|i| Color::from(m.track(space, channel, cell_fraction(i, n))).0)
            .collect::<Vec<u32>>()
    });
    let thumb = computed(move || track_cell(Percentage(ctl.fraction() as f32), columns.get()));
    // The Cell from the track's start shown `shown` Cells from the left: a
    // mirrored track runs from the right.
    let logical = move |shown: usize| {
        let n = columns.get();
        match ctl.mirrored.get() {
            true => n.saturating_sub(1).saturating_sub(shown),
            false => shown,
        }
    };
    let cells = each(
        move || (0..columns.get()).collect::<Vec<usize>>(),
        |shown: &usize| *shown,
        move |shown: ReadSignal<usize>, _| {
            let at = move || logical(shown.get());
            let color = move || {
                let i = at();
                colors.with(|c| c.get(i).map_or_else(black, |&c| Hsla::from(Color(c))))
            };
            view()
                .w(cell.width)
                .h(cell.height)
                .flex_shrink(0.0)
                .overflow_hidden()
                .role(AccessibilityRole::Image)
                .style_with(move |s| s.bg(AdaptiveColor::from(color())))
                .child(
                    when(move || at() == thumb.get(), move || thumb_mark(cell))
                        .otherwise(|| text(" ")),
                )
        },
    );
    let track = view()
        .flex_grow(1.0)
        .min_w(px(0.0))
        .pointer_events(PointerEvents::None)
        .accessibility_elements_hidden(true)
        .on_layout(move |frame: &Bounds<Points>| {
            ctl.rail.set(*frame);
            let n = columns_in(frame.size.width, cell.width);
            if columns.get_untracked() != n {
                columns.set(n);
            }
        })
        // One row tall by itself; the slider's width is the app's.
        .child(text(" "))
        .child(
            view()
                .absolute()
                .top(px(0.0))
                .left(px(0.0))
                .right(px(0.0))
                .flex_row()
                .direction(LayoutDirection::Ltr)
                .overflow_hidden()
                .child(cells),
        );
    view()
        .flex_row()
        // The thumb's mark follows the slider's focus (`thumb_mark`).
        .group()
        .disabled(move || ctl.disabled())
        .accessible(true)
        .role(AccessibilityRole::Adjustable)
        .optional_label(label)
        .accessibility_value(move || {
            let spec = ctl.spec();
            let now = ctl.value();
            Some(AccessibilityValue {
                min: Some(spec.min as f32),
                max: Some(spec.max as f32),
                now: Some(now as f32),
                text: Some(spec.format(now).into()),
            })
        })
        .accessibility_actions(vec![action("increment"), action("decrement")])
        .on_accessibility_action(move |name: &str| match name {
            "increment" => ctl.nudge(Nudge::X(1.0)),
            "decrement" => ctl.nudge(Nudge::X(-1.0)),
            _ => {}
        })
        // A press makes it a stop of the keyboard focus; the value is the
        // responder's.
        .on_press(|| {})
        .on_focus(move || focused.set(true))
        .on_blur(move || focused.set(false))
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if !untracked(|| ctl.disabled()) {
                request.claim();
            }
        }))
        .keep_touches(true)
        .on_responder_grant(move |e: &ResponderEvent| ctl.press_track(e))
        .on_responder_move(move |e: &ResponderEvent| ctl.drag_to(ctl.offset(e)))
        .on_responder_release(move |_: &ResponderEvent| ctl.release())
        .on_responder_terminate(move |_: &ResponderEvent| ctl.release())
        .child(track)
        .into_element()
}

/// A color slider's thumb, [`terminal::COLOR_THUMB`] on its Cell: while
/// the slider has the focus it stands on the accent, in the background's
/// color and bold, as the terminal marks a focused slider's thumb, so the
/// track keeps showing the value and the mark shows the keys go here.
fn thumb_mark(cell: Size<Points>) -> View {
    view()
        .w(cell.width)
        .h(cell.height)
        .group_focus_within(|s| s.bg(terminal::ACCENT))
        .child(text(terminal::COLOR_THUMB).group_focus_within(|s| {
            s.text_color(|| crate::theme::theme().background)
                .font_weight(FontWeight::BOLD)
        }))
}

/// A color area's terminal form ([`super::ColorArea`]): a grid of Cells
/// as many as the area's size holds (it fills the area's width and its
/// whole rows; at most [`AREA_COLUMNS`] by [`AREA_ROWS`]), the color's hue
/// at the saturation of each column and the brightness of each row, the
/// picked color's Cell marked `◆`.
pub(super) fn area(
    picker: Picker,
    disabled: impl Fn() -> bool + Copy + 'static,
    label: Prop<Option<SharedString>>,
) -> AnyElement {
    let cell = cell_size();
    let grid = signal((0usize, 0usize));
    let focused = signal(false);
    let mirrored = computed(layout_rtl);
    let drag = stored(None::<(f64, f64)>);
    let hsb = move |m: &super::Model| {
        [
            m.channel(ColorSpace::Hsb, ColorChannel::Hue),
            m.channel(ColorSpace::Hsb, ColorChannel::Saturation),
            m.channel(ColorSpace::Hsb, ColorChannel::Brightness),
        ]
    };
    // The column from the least saturation shown `shown` Cells from the
    // left: it runs from the right in a right-to-left layout.
    let column_of = move |shown: usize, columns: usize, mirrored: bool| match mirrored {
        true => columns.saturating_sub(1).saturating_sub(shown),
        false => shown,
    };
    // The saturation and brightness of a column and a row (the top row the
    // brightest).
    let at = move |column: usize, row: usize, (columns, rows): (usize, usize)| {
        (
            cell_fraction(column, columns) * 100.0,
            (1.0 - cell_fraction(row, rows)) * 100.0,
        )
    };
    let picked = computed(move || {
        let (columns, rows) = grid.get();
        let [_, s, b] = hsb(&picker.get());
        let last = |n: usize| n.saturating_sub(1) as f64;
        (
            ((s / 100.0) * last(columns)).round() as usize,
            ((1.0 - b / 100.0) * last(rows)).round() as usize,
        )
    });
    let place = move |x: f64, y: f64| {
        let (columns, rows) = grid.get_untracked();
        if columns == 0 || rows == 0 {
            return;
        }
        let shown = cell_at(x, cell.width, columns);
        let column = column_of(shown, columns, mirrored.get_untracked());
        let row = cell_at(y, cell.height, rows);
        let (s, b) = at(column, row, (columns, rows));
        let now = picker.now();
        let [h, ..] = hsb(&now);
        picker.set(now.with_triple(ColorSpace::Hsb, [h, s.round(), b.round()]));
    };
    let nudge = move |nudge: Nudge| {
        if untracked(disabled) {
            return;
        }
        let now = picker.now();
        let [h, s, b] = hsb(&now);
        let (s, b) = match nudge {
            Nudge::X(by) => ((s + by).round(), b),
            Nudge::Y(by) => (s, (b + by).round()),
            Nudge::Min => (s, 0.0),
            Nudge::Max => (s, 100.0),
        };
        picker.set(now.with_triple(
            ColorSpace::Hsb,
            [h, s.clamp(0.0, 100.0), b.clamp(0.0, 100.0)],
        ));
        picker.end();
    };
    bind_while_directed(move || focused.get(), AREA_KEYS, nudge);
    let release = move || {
        if drag.replace(None).is_some() {
            picker.end();
        }
    };
    let row = move |row: ReadSignal<usize>| {
        let cells = each(
            move || (0..grid.get().0).collect::<Vec<usize>>(),
            |shown: &usize| *shown,
            move |shown: ReadSignal<usize>, _| {
                let column = move || column_of(shown.get(), grid.get().0, mirrored.get());
                color_cell(
                    cell,
                    move || match picked.get() == (column(), row.get()) {
                        true => terminal::AREA_PICKED,
                        false => " ",
                    },
                    move || {
                        let (s, b) = at(column(), row.get(), grid.get());
                        let m = picker.get();
                        m.with_triple(ColorSpace::Hsb, [hsb(&m)[0], s, b]).opaque()
                    },
                )
            },
        );
        view().flex_row().child(cells)
    };
    let rows = each(
        move || (0..grid.get().1).collect::<Vec<usize>>(),
        |row: &usize| *row,
        move |r: ReadSignal<usize>, _| row(r),
    );
    view()
        .disabled(disabled)
        .accessible(true)
        .role(AccessibilityRole::Adjustable)
        .optional_label(label)
        .accessibility_value(move || {
            let m = picker.get();
            Some(AccessibilityValue {
                min: Some(0.0),
                max: Some(100.0),
                now: Some(m.channel(ColorSpace::Hsb, ColorChannel::Brightness) as f32),
                text: Some(m.format(ColorFormat::Hex).into()),
            })
        })
        .accessibility_actions(vec![action("increment"), action("decrement")])
        .on_accessibility_action(move |name: &str| match name {
            "increment" => nudge(Nudge::Y(1.0)),
            "decrement" => nudge(Nudge::Y(-1.0)),
            _ => {}
        })
        .on_press(|| {})
        .on_focus(move || focused.set(true))
        .on_blur(move || focused.set(false))
        .on_layout(move |frame: &Bounds<Points>| {
            let n = (
                columns_in(frame.size.width, cell.width).min(AREA_COLUMNS),
                columns_in(frame.size.height, cell.height).min(AREA_ROWS),
            );
            if grid.get_untracked() != n {
                grid.set(n);
            }
        })
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if !untracked(disabled) {
                request.claim();
            }
        }))
        .keep_touches(true)
        .on_responder_grant(move |e: &ResponderEvent| {
            let at = (f64::from(e.location.x.0), f64::from(e.location.y.0));
            drag.replace(Some(at));
            place(at.0, at.1);
        })
        .on_responder_move(move |e: &ResponderEvent| {
            if let Some((x, y)) = drag.get() {
                let d = e.gesture.delta;
                place(x + f64::from(d.x.0), y + f64::from(d.y.0));
            }
        })
        .on_responder_release(move |_: &ResponderEvent| release())
        .on_responder_terminate(move |_: &ResponderEvent| release())
        .child(
            view()
                .absolute()
                .top(px(0.0))
                .left(px(0.0))
                .direction(LayoutDirection::Ltr)
                .pointer_events(PointerEvents::None)
                .accessibility_elements_hidden(true)
                .child(rows),
        )
        .into_element()
}

/// A swatch's fill in a terminal: a picture of the color, which the
/// terminal fills with it; four Cells by one row unless the app sizes the
/// swatch.
pub(super) fn swatch_fill(color: impl Fn() -> Hsla + 'static) -> View {
    view()
        .absolute()
        .inset_0()
        .pointer_events(PointerEvents::None)
        .role(AccessibilityRole::Image)
        .accessibility_elements_hidden(true)
        .bg(move || AdaptiveColor::from(color()))
}

/// The in-flow content that gives a terminal swatch its size by itself.
pub(super) fn swatch_size() -> Text {
    text(terminal::SWATCH)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cells_map_to_fractions_and_back() {
        assert_eq!(cell_fraction(0, 5), 0.0);
        assert_eq!(cell_fraction(4, 5), 1.0);
        assert_eq!(cell_fraction(0, 1), 0.5);
        assert_eq!(cell_at(0.0, px(8.0), 4), 0);
        assert_eq!(cell_at(17.0, px(8.0), 4), 2);
        assert_eq!(cell_at(100.0, px(8.0), 4), 3);
        assert_eq!(cell_at(-3.0, px(8.0), 4), 0);
    }
}

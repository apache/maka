//! The diff view's view: a vertical scroll view over a box of every row's
//! height, which holds the sides (two side by side, or one) and over them
//! the separators, the app's hunk actions, its annotations and its add
//! control. A side is a gutter of line numbers (which select lines) beside
//! a horizontal scroll view of the text (the split sides scroll together;
//! with soft wrap nothing scrolls sideways). Rows are as tall as their
//! wrapped lines and the annotations under them. Only the rows in view
//! (and a few around them) are made.

use nsh_core::{
    element::{EventKind, EventPayload, Style},
    prelude::*,
};

use super::{
    DiffAnnotation, DiffExpand, DiffIndicators, DiffLayout, DiffSeparator, DiffSide, DiffViewPart,
    DiffViewProps,
    controller::{Dv, RowCell, Span, Tint},
    geometry,
    layout::Row,
    review::HoverPart,
};
use crate::theme;

/// Added lines' green.
pub(crate) const ADDED: AdaptiveColor = AdaptiveColor::rgb(0x16a34a, 0x4ade80);
/// Deleted lines' red.
pub(crate) const DELETED: AdaptiveColor = AdaptiveColor::rgb(0xdc2626, 0xf87171);
/// The width of a bar indicator.
const BAR: f32 = 3.0;
/// The room around a gutter's numbers and before a line's text.
pub(crate) const PAD: f32 = 8.0;

/// `el` with the classes and styles of `list`, in order (later parts win).
fn parts<E: Element>(el: E, props: DiffViewProps, list: Vec<DiffViewPart>) -> E {
    let styles = list.clone();
    el.app_class(move || {
        props.classes.with(|c| {
            let joined: Vec<&str> = list
                .iter()
                .filter_map(|p| c.get(*p).map(|s| s.as_str()))
                .collect();
            (!joined.is_empty()).then(|| SharedString::from(joined.join(" ")))
        })
    })
    .inline_style(move || {
        props.styles.with(|s| {
            Style::from_decls(
                styles
                    .iter()
                    .filter_map(|p| s.get(*p))
                    .flat_map(|s| s.decls().iter().cloned()),
            )
        })
    })
}

pub(crate) fn part<E: Element>(el: E, props: DiffViewProps, part: DiffViewPart) -> E {
    parts(el, props, vec![part])
}

/// Which column a side shows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Column {
    Old,
    New,
    /// Unified: both numbers, either line.
    Both,
}

impl Column {
    /// The side it shows, `None` for both.
    fn side(self) -> Option<DiffSide> {
        match self {
            Column::Old => Some(DiffSide::Old),
            Column::New => Some(DiffSide::New),
            Column::Both => None,
        }
    }
}

/// The diff view.
pub(crate) fn render(dv: Dv) -> impl IntoElement {
    let props = dv.props;
    let (scroll_dv, layout_dv) = (dv.clone(), dv.clone());
    let font = {
        let dv = dv.clone();
        move || {
            dv.rev.get();
            dv.st.borrow().font.clone()
        }
    };
    let (font_a, font_b, font_c) = (font.clone(), font.clone(), font);
    let height = {
        let dv = dv.clone();
        move || dv.rows_height()
    };
    let rows = visible_rows(dv.clone());
    let split_dv = dv.clone();
    let unified_dv = dv.clone();
    view()
        .relative()
        .overflow_hidden()
        .text_color(move || theme().foreground)
        .font_family(move || font_a().family)
        .text_size(move || Length::from(font_b().size))
        .line_height(move || Length::from(font_c().line_height))
        .child(
            scroll()
                .element_ref(&dv.vscroll)
                .absolute()
                .inset_0()
                .on_scroll(move |e: &ScrollEvent| {
                    scroll_dv.scroll_y.set(e.offset.y);
                    scroll_dv.viewport.set(e.size);
                    // Lines scrolled into view far past the parse are guessed.
                    scroll_dv.schedule_highlight();
                    scroll_dv.scrolled_to(e.offset.y);
                })
                .on_layout(move |b: &Bounds<Points>| layout_dv.viewport.set(b.size))
                .child(
                    view()
                        .relative()
                        .h(move || Length::from(height()))
                        .child(
                            when(
                                move || props.layout.get() == DiffLayout::Split,
                                move || {
                                    view()
                                        .absolute()
                                        .inset_0()
                                        .flex_row()
                                        .child(
                                            side(split_dv.clone(), Column::Old, rows)
                                                .border_r_1()
                                                .border_color(move || theme().border),
                                        )
                                        .child(side(split_dv.clone(), Column::New, rows))
                                },
                            )
                            .otherwise(move || {
                                view().absolute().inset_0().flex_row().child(side(
                                    unified_dv.clone(),
                                    Column::Both,
                                    rows,
                                ))
                            }),
                        )
                        .child(separators(dv.clone(), rows))
                        .child(super::files::headers(dv.clone(), rows))
                        .child(hunk_actions(dv.clone(), rows))
                        .child(annotations(dv.clone()))
                        .child(add_controls(dv.clone())),
                ),
        )
}

fn line_height(dv: &Dv) -> impl Fn() -> Points + Clone + 'static {
    let dv = dv.clone();
    move || {
        dv.rev.get();
        dv.st.borrow().font.line_height
    }
}

/// The rows in view.
fn visible_rows(dv: Dv) -> Memo<Vec<usize>> {
    computed(move || {
        dv.rev.get();
        dv.visible_rows().collect()
    })
}

/// A side: its gutter beside its text.
fn side(dv: Dv, column: Column, rows: Memo<Vec<usize>>) -> View {
    let props = dv.props;
    part(
        view().flex_1().flex_row().min_w(px(0.0)).overflow_hidden(),
        props,
        DiffViewPart::Side,
    )
    .child(gutter(dv.clone(), column, rows))
    .child(content(dv, column, rows))
}

/// What a row shows in `column`: its cell, `None` for a separator.
fn row_cell(dv: &Dv, row: usize, column: Column) -> Option<(RowCell, Option<usize>)> {
    let inline = dv.props.inline.get();
    let (old, new) = dv.st.borrow_mut().cells(row, inline)?;
    Some(match column {
        Column::Old => (old, None),
        Column::New => (new, None),
        Column::Both => {
            let old_number = old.number;
            if new.kind == Tint::Filler {
                (old, old_number)
            } else {
                (new, old_number)
            }
        }
    })
}

/// A cell's row, kept up to date.
fn cell_memo(dv: &Dv, row: usize, column: Column) -> Memo<Option<(RowCell, Option<usize>)>> {
    let dv = dv.clone();
    computed(move || {
        dv.rev.get();
        dv.hl_rev.get();
        row_cell(&dv, row, column)
    })
}

/// The width of a number column.
fn number_width(dv: &Dv) -> impl Fn() -> Points + Clone + 'static {
    let dv = dv.clone();
    move || {
        dv.rev.get();
        dv.st.borrow().number_width()
    }
}

/// The width of the `+` / `−` column (`indicators="classic"`).
fn sign_width(dv: &Dv) -> impl Fn() -> Points + Clone + 'static {
    let dv = dv.clone();
    let props = dv.props;
    move || {
        dv.rev.get();
        if props.indicators.get() == DiffIndicators::Classic {
            dv.st.borrow().column * 2.0
        } else {
            px(0.0)
        }
    }
}

/// The width of the gutter of `column`.
fn gutter_width(dv: &Dv, column: Column) -> impl Fn() -> Points + Clone + 'static {
    let props = dv.props;
    let nw = number_width(dv);
    let sw = sign_width(dv);
    move || {
        let numbers = if props.line_numbers.get() {
            let n = if column == Column::Both { 2.0 } else { 1.0 };
            nw() * n + px(PAD * (n + 1.0))
        } else {
            px(0.0)
        };
        numbers + sw() + px(BAR)
    }
}

/// The gutter of a side: numbers and indicators. Pressing it selects
/// lines: a press one, a Shift-press up to it, a drag with the mouse those
/// it goes over (a finger scrolls).
fn gutter(dv: Dv, column: Column, rows: Memo<Vec<usize>>) -> impl IntoElement {
    let props = dv.props;
    let number_width = number_width(&dv);
    let sign_width = sign_width(&dv);
    let width = gutter_width(&dv, column);
    // The side a press at `x` selects on, and whether the other side's
    // line does where it has none (unified rows).
    let pick = {
        let dv = dv.clone();
        move |x: Points| match column {
            Column::Old => (DiffSide::Old, false),
            Column::New => (DiffSide::New, false),
            Column::Both => {
                let numbers = props.line_numbers.get_untracked();
                let edge = px(PAD * 1.5) + dv.st.borrow().number_width();
                if numbers && x < edge {
                    (DiffSide::Old, true)
                } else {
                    (DiffSide::New, true)
                }
            }
        }
    };
    let desktop = is_desktop();
    let (down, tap, mov, up, end) = (dv.clone(), dv.clone(), dv.clone(), dv.clone(), dv.clone());
    let tap_pick = pick.clone();
    let lh = line_height(&dv);
    part(
        view()
            .flex_none()
            .relative()
            .w(move || Length::from(width()))
            .bg(move || theme().background),
        props,
        DiffViewPart::Gutter,
    )
    .on(EventKind::PressDown, move |p: &EventPayload| {
        if let (true, EventPayload::Press(e)) = (desktop, p) {
            let (side, either) = pick(e.position.x);
            let shift = e.modifiers.shift;
            down.line_press(e.position, e.page_position, side, either, shift, true);
        }
    })
    .on(EventKind::Press, move |p: &EventPayload| {
        if desktop {
            return;
        }
        let EventPayload::Press(e) = p else { return };
        let (side, either) = tap_pick(e.position.x);
        tap.line_press(e.position, e.page_position, side, either, false, false);
    })
    // The mouse selects lines as it drags (a finger scrolls): the gutter
    // takes its touches, which the scroll view around it keeps off.
    .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
        if desktop {
            request.claim();
        }
    }))
    .keep_touches(desktop)
    .on_responder_move(move |e: &ResponderEvent| mov.line_drag_to(e.page))
    .on_responder_release(move |_: &ResponderEvent| up.line_release(true))
    .on_responder_terminate(move |_: &ResponderEvent| end.line_release(false))
    .child(each(
        rows,
        |row: &usize| *row,
        move |row, _| {
            let row = row.get_untracked();
            gutter_row(
                dv.clone(),
                row,
                column,
                lh.clone(),
                number_width.clone(),
                sign_width.clone(),
            )
        },
    ))
}

/// The box of row `row`'s lines (its `part`), kept up to date, which
/// reports the pointer over it.
fn row_place(dv: &Dv, row: usize, column: Column, part: HoverPart) -> View {
    let (top, height, hover_in, hover_out) = (dv.clone(), dv.clone(), dv.clone(), dv.clone());
    view()
        .absolute()
        .left_0()
        .right_0()
        .top(move || Length::from(top.row_top(row)))
        .h(move || Length::from(height.row_height(row)))
        .on_hover_in(move || hover_in.hover_in(row, part, column.side()))
        .on_hover_out(move || hover_out.hover_out(row, part))
}

/// The tint of selected lines over row `row` of `column`, while they are.
fn selected_tint(dv: &Dv, row: usize, column: Column) -> impl IntoElement {
    let props = dv.props;
    let selected = {
        let dv = dv.clone();
        computed(move || {
            dv.rev.get();
            dv.row_selected(row, column.side())
        })
    };
    dynamic(move || {
        selected.get().then(|| {
            part(
                view()
                    .absolute()
                    .inset_0()
                    .pointer_events(PointerEvents::None)
                    .bg(move || theme().selection()),
                props,
                DiffViewPart::LineSelected,
            )
        })
    })
}

fn gutter_row(
    dv: Dv,
    row: usize,
    column: Column,
    lh: impl Fn() -> Points + Clone + 'static,
    number_width: impl Fn() -> Points + Clone + 'static,
    sign_width: impl Fn() -> Points + Clone + 'static,
) -> impl IntoElement {
    let props = dv.props;
    let cell = cell_memo(&dv, row, column);
    // A stable view per row: `each` keeps it while the row stays in view,
    // whatever the row shows.
    let place = row_place(&dv, row, column, HoverPart::Gutter);
    let tint_el = selected_tint(&dv, row, column);
    let press_dv = dv.clone();
    place
        .child(dynamic(move || {
            let (cell, old_number) = cell.get()?;
            let tint = cell.kind;
            let mut el = view()
                .absolute()
                .inset_0()
                .bg(move || line_tint(props, tint).unwrap_or(AdaptiveColor::TRANSPARENT));
            // The numbers and signs beside the first wrapped line.
            let lh = lh.clone();
            let mut first = view()
                .absolute()
                .left_0()
                .right_0()
                .top_0()
                .h(move || Length::from(lh()))
                .flex_row()
                .items_center();
            if props.line_numbers.get() {
                let numbers: Vec<Option<usize>> = match column {
                    Column::Old | Column::New => vec![cell.number],
                    Column::Both => {
                        let (old, new) = match tint {
                            Tint::Deleted => (cell.number, None),
                            Tint::Added => (None, cell.number),
                            _ => (old_number, cell.number),
                        };
                        vec![old, new]
                    }
                };
                let sides = match column {
                    Column::Old => [Some(DiffSide::Old), None],
                    Column::New => [Some(DiffSide::New), None],
                    Column::Both => [Some(DiffSide::Old), Some(DiffSide::New)],
                };
                for (number, side) in numbers.into_iter().zip(sides) {
                    let label = number.map(|n| n.to_string()).unwrap_or_default();
                    let pressed = number.and(side).map(|side| (press_dv.clone(), side));
                    let mut list = vec![DiffViewPart::LineNumber];
                    match tint {
                        Tint::Added => list.push(DiffViewPart::LineNumberAdded),
                        Tint::Deleted => list.push(DiffViewPart::LineNumberDeleted),
                        _ => {}
                    }
                    first = first.child(parts(
                        text(label)
                            .w(Length::from(number_width()))
                            .ml(px(PAD))
                            .text_right()
                            .text_color(move || theme().muted_foreground)
                            // The gutter takes the mouse's presses and drags
                            // (a press target here would take them from it);
                            // on touch screens the number takes its tap, so
                            // a tap with no place to read (assistive
                            // technologies) selects its line too.
                            .when_some(pressed.filter(|_| !is_desktop()), |t, (dv, side)| {
                                t.on_press(move || dv.number_press(row, side))
                            }),
                        props,
                        list,
                    ));
                }
            }
            if props.indicators.get() == DiffIndicators::Classic {
                let (sign, which) = match tint {
                    Tint::Added => ("+", Some(DiffViewPart::IndicatorAdded)),
                    Tint::Deleted => ("−", Some(DiffViewPart::IndicatorDeleted)),
                    _ => ("", None),
                };
                let sign = text(sign)
                    .ml(px(PAD))
                    .w(Length::from(sign_width()))
                    .text_color(move || match tint {
                        Tint::Added => ADDED,
                        Tint::Deleted => DELETED,
                        _ => theme().muted_foreground,
                    });
                first = first.child(match which {
                    Some(p) => part(sign, props, p),
                    None => sign,
                });
            }
            el = el.child(first);
            if props.indicators.get() == DiffIndicators::Bars {
                let which = match tint {
                    Tint::Added => Some((DiffViewPart::IndicatorAdded, ADDED)),
                    Tint::Deleted => Some((DiffViewPart::IndicatorDeleted, DELETED)),
                    _ => None,
                };
                if let Some((p, color)) = which {
                    el = el.child(part(
                        view()
                            .absolute()
                            .right_0()
                            .top_0()
                            .bottom_0()
                            .w(px(BAR))
                            .bg(color),
                        props,
                        p,
                    ));
                }
            }
            Some(el)
        }))
        .child(tint_el)
}

/// The tint of a row's background, `None` for none.
fn line_tint(props: DiffViewProps, tint: Tint) -> Option<AdaptiveColor> {
    match tint {
        Tint::Context => None,
        Tint::Filler => Some(theme().muted.opacity(0.5)),
        Tint::Added if props.background.get() => Some(ADDED.opacity(0.12)),
        Tint::Deleted if props.background.get() => Some(DELETED.opacity(0.12)),
        _ => None,
    }
}

/// The text of a side, in a horizontal scroll view (the split sides
/// scroll together; with soft wrap the text is the view's width).
fn content(dv: Dv, column: Column, rows: Memo<Vec<usize>>) -> impl IntoElement {
    let props = dv.props;
    let width = {
        let dv = dv.clone();
        move || {
            dv.rev.get();
            if props.soft_wrap.get() {
                return Length::from(relative(1.0));
            }
            let st = dv.st.borrow();
            // The split sides are as wide as the wider, so they scroll
            // together to the end.
            let text = st
                .text_width(DiffSide::Old)
                .max(st.text_width(DiffSide::New));
            Length::from(text + px(PAD * 2.0))
        }
    };
    let height = {
        let dv = dv.clone();
        move || dv.rows_height()
    };
    let lh = line_height(&dv);
    let (scrolled, laid_out) = (dv.clone(), dv.clone());
    let mut el = scroll().horizontal().flex_1();
    if let Some(side) = column.side() {
        let index = match side {
            DiffSide::Old => 0,
            DiffSide::New => 1,
        };
        el = el
            .element_ref(&dv.hscroll[index])
            .on_scroll(move |e: &ScrollEvent| scrolled.side_scrolled(side, e.offset.x));
    }
    // One side's box tells the width lines wrap at (the split sides are
    // as wide).
    if column != Column::Old {
        el = el.on_layout(move |b: &Bounds<Points>| laid_out.text_box_laid_out(b.size.width));
    }
    el.child(
        part(
            view()
                .relative()
                .min_w(relative(1.0))
                .w(width)
                .h(move || Length::from(height())),
            props,
            DiffViewPart::Content,
        )
        .child(each(
            rows,
            |row: &usize| *row,
            move |row, _| line_row(dv.clone(), row.get_untracked(), column, lh.clone()),
        )),
    )
}

fn line_row(
    dv: Dv,
    row: usize,
    column: Column,
    lh: impl Fn() -> Points + Clone + 'static,
) -> impl IntoElement {
    let props = dv.props;
    let cell = cell_memo(&dv, row, column);
    let place = row_place(&dv, row, column, HoverPart::Text);
    let tint_el = selected_tint(&dv, row, column);
    let wrap = dv.clone();
    place
        .child(dynamic(move || {
            let (cell, _) = cell.get()?;
            let tint = cell.kind;
            let mut list = vec![DiffViewPart::Line];
            match tint {
                Tint::Added => list.push(DiffViewPart::LineAdded),
                Tint::Deleted => list.push(DiffViewPart::LineDeleted),
                Tint::Filler => list.push(DiffViewPart::Filler),
                Tint::Context => {}
            }
            // The columns lines wrap at change with the box's width (`rev`),
            // the cell staying as it was.
            wrap.rev.get();
            let lines = match wrap.st.borrow().wrap_columns {
                Some(columns) => {
                    let joined: String = cell.spans.iter().map(|s| s.text.as_str()).collect();
                    let starts = geometry::wrap_starts(&joined, columns);
                    geometry::wrap_spans(cell.spans, &starts)
                }
                None => vec![cell.spans],
            };
            let mut el = parts(
                view()
                    .absolute()
                    .inset_0()
                    .bg(move || line_tint(props, tint).unwrap_or(AdaptiveColor::TRANSPARENT)),
                props,
                list,
            );
            for (index, spans) in lines.into_iter().enumerate() {
                let spans = spans
                    .into_iter()
                    .map(|span| span_view(props, span, tint))
                    .collect::<Vec<_>>();
                let lh = lh.clone();
                el = el.child(
                    text("")
                        .selection_color(selection_color)
                        .absolute()
                        .top(move || Length::from(lh() * index as f32))
                        .left(px(PAD))
                        .children(spans),
                );
            }
            Some(el)
        }))
        .child(tint_el)
}

/// The highlight of the code's selected text: the lines' selection color.
fn selection_color() -> Hsla {
    let color = theme().selection();
    if nsh_core::element::ambient::dark() {
        color.dark
    } else {
        color.light
    }
}

fn span_view(props: DiffViewProps, span: Span, tint: Tint) -> AnyElement {
    let mut el = text(span.text);
    if let Some(token) = span.token {
        *el.style() = token.style();
    }
    if span.changed {
        let (color, which) = match tint {
            Tint::Deleted => (DELETED, DiffViewPart::WordDeleted),
            _ => (ADDED, DiffViewPart::WordAdded),
        };
        el = part(el.bg(color.opacity(0.3)), props, which);
    }
    el.into_element()
}

/// The separators in view, across the view.
fn separators(dv: Dv, rows: Memo<Vec<usize>>) -> impl IntoElement {
    let lh = line_height(&dv);
    let list = {
        let dv = dv.clone();
        computed(move || {
            dv.rev.get();
            let st = dv.st.borrow();
            rows.get()
                .into_iter()
                .filter_map(|row| match st.rows.get(row)? {
                    Row::Separator {
                        gap,
                        lines,
                        first,
                        last,
                        header,
                    } => Some((
                        row,
                        DiffSeparator {
                            gap: *gap as u32,
                            lines: *lines as u32,
                            first: *first,
                            last: *last,
                            header: header.clone().map(SharedString::from),
                        },
                    )),
                    _ => None,
                })
                .collect::<Vec<_>>()
        })
    };
    each(
        list,
        |(row, sep): &(usize, DiffSeparator)| (*row, sep.clone()),
        move |item, _| {
            let (row, sep) = item.get_untracked();
            separator(dv.clone(), row, sep, lh.clone())
        },
    )
}

fn separator(
    dv: Dv,
    row: usize,
    sep: DiffSeparator,
    lh: impl Fn() -> Points + Clone + 'static,
) -> impl IntoElement {
    let props = dv.props;
    let top = dv.clone();
    let place = move |el: View| {
        el.absolute()
            .left_0()
            .right_0()
            .top(move || Length::from(top.row_top(row)))
            .h(move || Length::from(lh()))
    };
    if let Some(render) = props.render_separator.get_untracked() {
        return place(view())
            .child(render.render(format!("gap:{}", sep.gap), sep).flex_1())
            .into_element();
    }
    let label = match &sep.header {
        Some(header) => header.to_string(),
        None => format!("⋯ {}", sep.lines),
    };
    let gap = sep.gap as usize;
    let expandable = sep.header.is_none();
    part(
        place(view())
            .flex_row()
            .items_center()
            .px(px(PAD))
            .bg(move || theme().muted)
            .text_color(move || theme().muted_foreground)
            .child(text(label)),
        props,
        DiffViewPart::Separator,
    )
    .on_press(move || {
        if expandable {
            dv.expand(gap, DiffExpand::All, 0);
        }
    })
    .into_element()
}

/// The app's actions of the changes whose first row is in view.
fn hunk_actions(dv: Dv, rows: Memo<Vec<usize>>) -> impl IntoElement {
    let props = dv.props;
    let list = {
        let dv = dv.clone();
        computed(move || {
            dv.rev.get();
            if props.render_hunk_actions.get().is_none() {
                return Vec::new();
            }
            let st = dv.st.borrow();
            let hunks = st.hunks();
            rows.get()
                .into_iter()
                .filter_map(|row| {
                    let Row::Line { hunk: Some(h), .. } = st.rows.get(row)? else {
                        return None;
                    };
                    let starts = match row.checked_sub(1).and_then(|r| st.rows.get(r)) {
                        Some(Row::Line { hunk: Some(p), .. }) => p != h,
                        _ => true,
                    };
                    starts
                        .then(|| (row, hunks.get(*h).copied()))
                        .and_then(|(r, h)| Some((r, h?)))
                })
                .collect::<Vec<_>>()
        })
    };
    each(
        list,
        |(row, hunk)| (*row, *hunk),
        move |item, _| {
            let (row, hunk) = item.get_untracked();
            let top = dv.clone();
            // A stable view per change, which `each` keeps while the change
            // stays in view.
            part(
                view()
                    .absolute()
                    .right(px(PAD))
                    .top(move || Length::from(top.row_top(row))),
                props,
                DiffViewPart::HunkActions,
            )
            .child(dynamic(move || {
                let render = props.render_hunk_actions.get()?;
                Some(render.render(format!("hunk:{}", hunk.index), hunk))
            }))
        },
    )
}

/// The app's annotations whose lines show, under their lines across their
/// side (split) or the view, as tall as they lay out.
fn annotations(dv: Dv) -> impl IntoElement {
    let props = dv.props;
    let list = {
        let dv = dv.clone();
        computed(move || {
            dv.rev.get();
            if props.render_annotation.get().is_none() {
                return Vec::new();
            }
            let split = props.layout.get() == DiffLayout::Split;
            let st = dv.st.borrow();
            st.annotations
                .iter()
                .zip(&st.placed)
                .filter(|(_, placed)| placed.is_some())
                .map(|(annotation, _)| (annotation.clone(), split))
                .collect::<Vec<_>>()
        })
    };
    each(
        list,
        |item: &(DiffAnnotation, bool)| item.clone(),
        move |item, _| {
            let (annotation, split) = item.get_untracked();
            let (top, laid_out) = (dv.clone(), dv.clone());
            let (id_top, id_layout) = (annotation.id.clone(), annotation.id.clone());
            let mut el = view()
                .absolute()
                .top(move || Length::from(top.annotation_top(&id_top).unwrap_or_default()))
                .on_layout(move |b: &Bounds<Points>| {
                    laid_out.annotation_laid_out(&id_layout, b.size.height)
                });
            el = match (split, annotation.side) {
                (true, DiffSide::Old) => el.left_0().w(relative(0.5)),
                (true, DiffSide::New) => el.left(relative(0.5)).w(relative(0.5)),
                (false, _) => el.left_0().right_0(),
            };
            part(el, props, DiffViewPart::Annotation).child(dynamic(move || {
                let render = props.render_annotation.get()?;
                let key = format!("annotation:{}", annotation.id);
                Some(render.render(key, annotation.clone()))
            }))
        },
    )
}

/// The app's control to add an annotation, at the right of the gutter of
/// the hovered line and of the last selected line.
fn add_controls(dv: Dv) -> impl IntoElement {
    let props = dv.props;
    let lh = line_height(&dv);
    let list = {
        let dv = dv.clone();
        computed(move || {
            let split = props.layout.get() == DiffLayout::Split;
            dv.add_controls()
                .into_iter()
                .map(|(row, side, key, range)| (row, side, key, range, split))
                .collect::<Vec<_>>()
        })
    };
    each(
        list,
        |item| *item,
        move |item, _| {
            let (row, side, key, range, split) = item.get_untracked();
            let column = match (split, side) {
                (true, DiffSide::Old) => Column::Old,
                (true, DiffSide::New) => Column::New,
                (false, _) => Column::Both,
            };
            let width = gutter_width(&dv, column);
            let (top, keep, out) = (dv.clone(), dv.clone(), dv.clone());
            let lh = lh.clone();
            let mut el = view()
                .absolute()
                .top(move || Length::from(top.row_top(row)))
                .h(move || Length::from(lh()))
                .w(move || Length::from(width()))
                .flex_row()
                .justify_end()
                .items_center()
                // Only the app's control takes presses: the gutter under
                // the rest of the box keeps them.
                .pointer_events(PointerEvents::BoxNone)
                .on_hover_in(move || keep.hover_in(row, HoverPart::Control, Some(side)))
                .on_hover_out(move || out.hover_out(row, HoverPart::Control));
            el = if split && side == DiffSide::New {
                el.left(relative(0.5))
            } else {
                el.left_0()
            };
            part(el, props, DiffViewPart::AddAnnotation).child(dynamic(move || {
                let render = props.render_add_annotation.get()?;
                Some(render.render(key, range))
            }))
        },
    )
}

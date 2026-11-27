//! The table's view, in layers, from the bottom:
//!
//! - the *body*, receiving no pointer: the cells of the rows and columns in
//!   view (and a reach around them), placed where the table last scrolled
//!   to. A scroll view moves its content at once, and the cells a move needs
//!   come with the next commit, which moves the body with them, so no frame
//!   shows the content without its cells. Its three regions are the row
//!   headers, the fixed columns (which move with the rows only) and the
//!   scrolling columns (which move both ways);
//! - the *hit layer* over it: a vertical scroll view of a horizontal one of
//!   an empty box of the content's size (scaled past a few million points:
//!   `axis.rs`). The platforms scroll it, and its box takes presses, hovers
//!   and the context menu. It draws nothing but its scroll bars (the
//!   platform's indicator or the app's built-in `Scrollbar`, children of the
//!   scroll view), which lie over the rows' backgrounds this way; under the
//!   body, the rows would cover them;
//! - the *header* above them, interactive: group labels and titles, in the
//!   same three regions, the columns' resize handles and the drop line of a
//!   column being moved;
//! - on the desktops, a horizontal scroll bar over the body's bottom edge,
//!   which moves the table's horizontal scroll view (whose own bar lies at
//!   the end of a content as tall as all the rows).

use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use nsh_core::{
    TouchEvent, TouchPhase,
    element::{EventKind, EventPayload, Style},
    prelude::*,
};

use super::{
    DataTableAlign, DataTableCell, DataTableCellPosition, DataTableCellRange, DataTableHeaderCell,
    DataTablePart, DataTableProps, DataTableSortDirection,
    columns::Columns,
    controller::{CustomCell, Dt, Geo, MOVE_SLOP, PressRegion, SORT_WIDTH, secondary_modifier},
    selection::Selection,
};
use crate::{HandleEdge, text_view::merge_styles};

/// The thickness of the desktops' horizontal scroll bar's band.
const STRIP: f32 = 12.0;
/// The room the drop line takes.
const DROP_LINE: f32 = 2.0;
/// Rows and columns that scaled content places its rows and columns
/// relative to (`controller.rs`).
const ROW_CHUNK: usize = 1024;
const COLUMN_CHUNK: usize = 256;

/// `el` with the classes and styles of the parts `list` gives, in order
/// (later parts win), kept up to date.
fn parts<E: Element>(
    el: E,
    props: DataTableProps,
    list: impl Fn() -> Vec<DataTablePart> + Clone + 'static,
) -> E {
    parts_with(el, props, list, || None)
}

fn part_styled(props: DataTableProps, which: DataTablePart) -> bool {
    props
        .classes
        .with(|c| c.get(which).is_some_and(|s| !s.is_empty()))
        || props.styles.with(|s| s.get(which).is_some())
}

/// [`parts`], with `own` classes after the parts' (a row's `rowClasses`).
fn parts_with<E: Element>(
    el: E,
    props: DataTableProps,
    list: impl Fn() -> Vec<DataTablePart> + Clone + 'static,
    own: impl Fn() -> Option<SharedString> + 'static,
) -> E {
    let styles = list.clone();
    let own = computed(own);
    el.app_class(move || {
        let own = own.get();
        props.classes.with(|c| {
            let list = list();
            let mut joined: Vec<&str> = list
                .iter()
                .filter_map(|p| c.get(*p).map(|s| s.as_str()))
                .collect();
            if let Some(own) = own.as_ref() {
                joined.push(own.as_str());
            }
            (!joined.is_empty()).then(|| SharedString::from(joined.join(" ")))
        })
    })
    .inline_style(move || {
        props.styles.with(|s| {
            if s.is_empty() {
                return Style::default();
            }
            merge_styles(styles().iter().filter_map(|p| s.get(*p)))
        })
    })
}

fn part<E: Element>(el: E, props: DataTableProps, which: DataTablePart) -> E {
    parts(el, props, move || vec![which])
}

/// `parts` with the column's own classes after the parts', which are the
/// more specific: a title's `headerClass` (`row` is `None`), a cell's
/// `cellClass`, the `positiveClass` or `negativeClass` its value calls
/// for, then the cell's `cellClasses` entry.
fn column_parts<E: Element>(
    el: E,
    dt: &Dt,
    def: Memo<Option<usize>>,
    row: Option<Memo<Option<usize>>>,
    list: impl Fn() -> Vec<DataTablePart> + Clone + 'static,
) -> E {
    let props = dt.props;
    let dt = dt.clone();
    let styles = list.clone();
    let extra = computed(move || {
        dt.layout_rev.get();
        let def = def.get()?;
        let (own, positive, negative) = {
            let st = dt.st.borrow();
            let column = st.defs.get(def)?;
            // A title: `row` is absent. A cell whose row is not known yet
            // keeps the column's cell class only when it has no rise or
            // fall class, and skips the value.
            if row.is_none() {
                return column.header_class.clone();
            }
            (
                column.cell_class.clone(),
                column.positive_class.clone(),
                column.negative_class.clone(),
            )
        };
        let Some(row_index) = row.and_then(|row| row.get()) else {
            return if positive.is_none() && negative.is_none() {
                own
            } else {
                None
            };
        };
        // A column with no rise or fall class skips reading the cell.
        let tone = if positive.is_none() && negative.is_none() {
            None
        } else {
            match dt.cell_sign(row_index, def) {
                Some(true) => positive,
                Some(false) => negative,
                None => None,
            }
        };
        let own = match (own, tone) {
            (Some(a), Some(b)) => Some(format!("{a} {b}").into()),
            (a, b) => a.or(b),
        };
        // After the column's classes: the app's mark for this one cell.
        let marked = dt.cell_class(row_index, def);
        match (own, marked) {
            (Some(a), Some(b)) => Some(format!("{a} {b}").into()),
            (a, b) => a.or(b),
        }
    });
    el.app_class(move || {
        let own = extra.get();
        props.classes.with(|c| {
            let list = list();
            let mut joined: Vec<&str> = list
                .iter()
                .filter_map(|p| c.get(*p).map(|s| s.as_str()))
                .collect();
            if let Some(own) = own.as_ref() {
                joined.push(own.as_str());
            }
            (!joined.is_empty()).then(|| SharedString::from(joined.join(" ")))
        })
    })
    .inline_style(move || {
        props.styles.with(|s| {
            if s.is_empty() {
                return Style::default();
            }
            merge_styles(styles().iter().filter_map(|p| s.get(*p)))
        })
    })
}

/// The table.
pub(crate) fn render(dt: Dt) -> impl IntoElement {
    let props = dt.props;
    let layout = dt.clone();
    let custom_cell = computed(move || props.render_cell.with(Option::is_some));
    let custom_head = computed(move || props.render_header_cell.with(Option::is_some));
    // Which of the desktops' horizontal bar and the table's horizontal
    // scroll view the user moves, shared so the other follows without
    // sending its own moves back.
    let strip_x = Lead::new();
    let (body_dt, header_dt, hit_dt, strip_dt, over_dt) =
        (dt.clone(), dt.clone(), dt.clone(), dt.clone(), dt.clone());
    let bar_dt = dt.clone();
    let (body_dt2, header_dt2) = (dt.clone(), dt.clone());
    let family = move || props.font_family.get();
    part(
        view()
            .role(AccessibilityRole::Grid)
            .optional_label(props.accessibility_label)
            .relative()
            .overflow_hidden()
            .text_size(move || Length::from(props.font_size.get()))
            .map(move |v| match family() {
                Some(f) => v.font_family(f),
                None => v,
            }),
        props,
        DataTablePart::Root,
    )
    .child(
        // The frame is the padding box: the layers lie in it, and its size
        // is the viewport's.
        view()
            .absolute()
            .inset_0()
            // Under `display: none` it has no area, which is no viewport to
            // empty the rows by: they stay until it shows again.
            .on_layout(move |b: &Bounds<Points>| {
                if has_area(b) {
                    layout.viewport.set(b.size);
                }
            })
            .child(
                when(
                    move || custom_cell.get(),
                    move || body(body_dt.clone(), true),
                )
                .otherwise(move || body(body_dt2.clone(), false)),
            )
            // Over the body, which takes no pointer: the scroll view's bars
            // draw above the rows.
            .child(hit_layer(hit_dt, strip_x.clone()))
            .child(
                when(
                    move || custom_head.get(),
                    move || header(header_dt.clone(), true),
                )
                .otherwise(move || header(header_dt2.clone(), false)),
            )
            .child(strip(strip_dt, strip_x))
            .child(projected_vertical_bar(bar_dt))
            .child(overlays(over_dt)),
    )
}

// The hit layer.

/// The width of the content box, whole columns included.
fn content_width(dt: &Dt) -> f32 {
    let g = dt.geo();
    g.lead + g.fixed + g.x.extent() as f32 + g.end
}

#[derive(Clone, Copy)]
struct DragStroke {
    range: DataTableCellRange,
    viewport: Point<Points>,
}

fn range_drag(dt: Dt, hit_view: ElementRef) -> impl Fn(&TouchEvent) + Clone {
    let stroke = Rc::new(Cell::new(None::<DragStroke>));
    let auto_scroll = Rc::new(RefCell::new(None::<Spawned<()>>));
    {
        let auto_scroll = auto_scroll.clone();
        cleanup(move || {
            auto_scroll.borrow_mut().take();
        });
    }
    let apply = {
        let dt = dt.clone();
        move |range| {
            hit_view.cancel_press();
            hit_view.focus();
            dt.set_focus(true);
            dt.select_drag_range(range);
        }
    };
    let advance = {
        let stroke = stroke.clone();
        move |mut drag: DragStroke, end: Option<DataTableCellPosition>| {
            if let Some(end) = end
                && end != drag.range.end
            {
                drag.range.end = end;
                apply(drag.range);
            }
            stroke.set(Some(drag));
        }
    };
    move |event: &TouchEvent| {
        if !dt.props.cell_range_selectable.get_untracked()
            || !dt.props.cell_selectable.get_untracked()
        {
            auto_scroll.borrow_mut().take();
            stroke.set(None);
            return;
        }
        let Some(point) = event
            .points
            .iter()
            .find(|p| p.changed && p.pointer_type == PointerType::Mouse)
        else {
            return;
        };
        let viewport = dt.drag_viewport_point(point.location);
        match event.phase {
            TouchPhase::Start => {
                auto_scroll.borrow_mut().take();
                stroke.set(None);
                let shift = event.modifiers.shift;
                if secondary_modifier(event.modifiers)
                    || (shift && !dt.props.select_on_modifier_press.get_untracked())
                {
                    return;
                }
                let Some(cell) = dt.drag_cell_at(point.location) else {
                    return;
                };
                let range = dt.drag_range(cell, shift);
                stroke.set(Some(DragStroke { range, viewport }));
            }
            TouchPhase::Move => {
                if let Some(mut drag) = stroke.get() {
                    drag.viewport = viewport;
                    advance(drag, dt.drag_cell_at_viewport(viewport));
                    if dt.drag_needs_auto_scroll(viewport) {
                        if auto_scroll.borrow().is_none() {
                            let dt = dt.clone();
                            let stroke = stroke.clone();
                            let advance = advance.clone();
                            *auto_scroll.borrow_mut() =
                                Some(set_interval(Duration::from_millis(16), move || {
                                    if let Some(drag) = stroke.get() {
                                        advance(drag, dt.drag_auto_scroll(drag.viewport));
                                    }
                                }));
                        }
                    } else {
                        auto_scroll.borrow_mut().take();
                    }
                }
            }
            TouchPhase::End | TouchPhase::Cancel => {
                auto_scroll.borrow_mut().take();
                if event.phase == TouchPhase::End
                    && let Some(drag) = stroke.get()
                {
                    advance(drag, dt.drag_cell_at_viewport(viewport));
                }
                stroke.set(None);
            }
        }
    }
}

fn hit_layer(dt: Dt, lead: Lead) -> impl IntoElement {
    let hit_view = element_ref();
    let drag = range_drag(dt.clone(), hit_view);
    let props = dt.props;
    let (scroll_dt, hscroll_dt, strip_dt) = (dt.clone(), dt.clone(), dt.clone());
    let (top_dt, height_dt, width_dt) = (dt.clone(), dt.clone(), dt.clone());
    let (press, hover, menu) = (dt.clone(), dt.clone(), dt.clone());
    let indicator_dt = dt.clone();
    let wheel = dt.clone();
    let (leave, focus, blur) = (dt.clone(), dt.clone(), dt.clone());
    scroll()
        .element_ref(&dt.vscroll)
        .absolute()
        .left_0()
        .right_0()
        .bottom_0()
        .top(move || Length::from(px(top_dt.geo().header)))
        .scrollbar(move || {
            if indicator_dt.web_desktop && indicator_dt.geo().y.scaled() {
                return false;
            }
            props
                .vertical_scrollbar
                .get()
                .unwrap_or(props.scrollbar.get())
        })
        .bounces(move || props.bounces.get())
        .on_scroll(move |e: &ScrollEvent| {
            if scroll_dt
                .wheel_y
                .get_untracked()
                .is_some_and(|to| (to.0 - e.offset.y.0).abs() < 0.5)
            {
                scroll_dt.wheel_y.set(None);
            }
            scroll_dt.scroll_y.set(e.offset.y);
        })
        .on_scroll_drag_start({
            let dt = dt.clone();
            move |offset: &Point<Points>| dt.drag_started(false, *offset)
        })
        .on_scroll_drag_end({
            let dt = dt.clone();
            move |offset: &Point<Points>| dt.drag_ended(false, *offset)
        })
        .on_scroll_end({
            let dt = dt.clone();
            move |_: &Point<Points>| dt.rest()
        })
        .child(
            view()
                .flex_row()
                .items_stretch()
                // No shorter than the viewport: the room below the last row
                // (all of the body, of a table with no rows) is the
                // horizontal scroll view's too, so a wheel or a pan there
                // moves the columns.
                .min_h(relative(1.0))
                .h(move || Length::from(px(height_dt.geo().y.extent() as f32)))
                .on_layout({
                    let dt = dt.clone();
                    move |b: &Bounds<Points>| {
                        if has_area(b) && dt.rows_width.get_untracked() != Some(b.size.width) {
                            dt.rows_width.set(Some(b.size.width));
                        }
                    }
                })
                .child(
                    scroll()
                        .horizontal()
                        .element_ref(&dt.hscroll)
                        .flex_1()
                        .scrollbar(false)
                        .bounces(move || props.bounces.get())
                        .on_scroll_drag_start({
                            let dt = dt.clone();
                            move |offset: &Point<Points>| dt.drag_started(true, *offset)
                        })
                        .on_scroll_drag_end({
                            let dt = dt.clone();
                            move |offset: &Point<Points>| dt.drag_ended(true, *offset)
                        })
                        .on_scroll_end({
                            let dt = dt.clone();
                            move |_: &Point<Points>| dt.rest()
                        })
                        .on_scroll(move |e: &ScrollEvent| {
                            if hscroll_dt
                                .wheel_x
                                .get_untracked()
                                .is_some_and(|to| (to.0 - e.offset.x.0).abs() < 0.5)
                            {
                                hscroll_dt.wheel_x.set(None);
                            }
                            hscroll_dt.scroll_x.set(e.offset.x);
                            // The desktops' bar follows, unless it leads.
                            if lead.take(Side::Table) {
                                hscroll_dt.strip.scroll_to(
                                    Point {
                                        x: e.offset.x,
                                        y: Points::ZERO,
                                    },
                                    false,
                                );
                            }
                        })
                        .child(
                            view()
                                .relative()
                                .min_w(relative(1.0))
                                .w(move || Length::from(px(content_width(&width_dt))))
                                .min_h(relative(1.0))
                                .h(move || Length::from(px(strip_dt.geo().y.extent() as f32)))
                                .element_ref(&hit_view)
                                .on_touch(drag)
                                .on(EventKind::Press, move |p: &EventPayload| {
                                    if let EventPayload::Press(e) = p {
                                        press.press_with(e);
                                    }
                                })
                                // Tab stops at the table here, as at gpui-component's
                                // (a `tab_stop` focus handle): its keys follow.
                                .on_focus(move || focus.set_focus(true))
                                .on_blur(move || blur.set_focus(false))
                                // The hovered row stays put while a drag
                                // selects or moves.
                                .on_mouse_move(move |e: &MouseEvent| {
                                    if e.pressed_button.is_none() {
                                        hover.hover_at(e);
                                    }
                                })
                                .on_mouse_leave(move |_: &MouseEvent| leave.hover_left())
                                .when(is_desktop() && !dt.web_desktop, |v| {
                                    v.on_wheel(move |e: &nsh_core::WheelEvent| {
                                        wheel.pan_by_wheel(e)
                                    })
                                })
                                .on_context_menu(move |e: &ContextMenuEvent| {
                                    menu.context_menu(e.position, e.page_position)
                                }),
                        ),
                ),
        )
}

/// One of two scroll views that follow each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Side {
    /// The table's horizontal scroll view.
    Table,
    /// The desktops' horizontal bar.
    Strip,
}

/// Which of two scroll views that follow each other leads: the one the
/// user moves. The other's scroll events, which arrive after the moves
/// that caused them, are its echoes for a moment after each of the
/// leader's moves, and are not sent back.
#[derive(Clone)]
struct Lead(Rc<Cell<Option<(Side, nsh_core::time::Instant)>>>);

impl Lead {
    /// How long after a move of the leader the other's moves are echoes.
    const ECHO: std::time::Duration = std::time::Duration::from_millis(250);

    fn new() -> Lead {
        Lead(Rc::default())
    }

    /// A scroll of `side`: whether it leads (its move is to be followed).
    fn take(&self, side: Side) -> bool {
        let now = nsh_core::time::now();
        if let Some((leader, at)) = self.0.get()
            && leader != side
            && now.duration_since(at) < Self::ECHO
        {
            return false;
        }
        self.0.set(Some((side, now)));
        true
    }
}

/// The desktops' horizontal scroll bar: a band over the body's bottom edge,
/// under the scrolling columns (between the fixed ones, which do not move),
/// whose own scroll view the bar belongs to, moving the table's.
fn strip(dt: Dt, lead: Lead) -> impl IntoElement {
    let props = dt.props;
    let shown = {
        let dt = dt.clone();
        move || {
            is_desktop()
                && props
                    .horizontal_scrollbar
                    .get()
                    .unwrap_or(props.scrollbar.get())
                && {
                    let g = dt.geo();
                    g.x.extent() > g.x.viewport
                }
        }
    };
    let width_dt = dt.clone();
    when(shown, move || {
        let (scroll_dt, width_dt) = (dt.clone(), width_dt.clone());
        let (left_dt, right_dt) = (dt.clone(), dt.clone());
        let lead = lead.clone();
        scroll()
            .horizontal()
            .element_ref(&dt.strip)
            .test_id("data-table-scrollbar")
            .absolute()
            .left(move || {
                let g = left_dt.geo();
                Length::from(px(g.lead + g.fixed))
            })
            .right(move || {
                let g = right_dt.geo();
                Length::from(px(g.end + g.bar))
            })
            .bottom_0()
            .h(px(STRIP))
            .on_scroll_drag_start({
                let dt = dt.clone();
                move |offset: &Point<Points>| dt.drag_started(true, *offset)
            })
            .on_scroll_drag_end({
                let dt = dt.clone();
                move |offset: &Point<Points>| dt.drag_ended(true, *offset)
            })
            .on_scroll(move |e: &ScrollEvent| {
                // The table follows the bar, unless the table leads (the bar
                // following it): sending that back would fight a drag.
                if lead.take(Side::Strip)
                    && (e.offset.x - scroll_dt.scroll_x.get_untracked()).0.abs() > 0.5
                {
                    scroll_dt.hscroll.scroll_to(
                        Point {
                            x: e.offset.x,
                            y: Points::ZERO,
                        },
                        false,
                    );
                }
            })
            .child(
                view()
                    .h(px(1.0))
                    .w(move || Length::from(px(width_dt.geo().x.extent() as f32))),
            )
    })
}

/// A scaled web table follows wheel input from a local anchor. Its native
/// offset recenters at rest, so that offset cannot also be its visible bar.
/// This separate, bounded scroll view represents the proportional position;
/// recentering the hit layer leaves both its offset and its thumb unchanged.
fn projected_vertical_bar(dt: Dt) -> impl IntoElement {
    let shown_dt = dt.clone();
    when(
        move || {
            shown_dt.web_desktop
                && shown_dt.geo().y.scaled()
                && shown_dt
                    .props
                    .vertical_scrollbar
                    .get()
                    .unwrap_or(shown_dt.props.scrollbar.get())
        },
        move || {
            let bar = element_ref();
            let target = Rc::new(Cell::new(None::<Points>));
            let sync_dt = dt.clone();
            let sync_target = target.clone();
            effect(move || {
                let g = sync_dt.geo();
                let y = g.y.scroll_points(g.cy);
                if sync_target.replace(Some(y)) == Some(y) {
                    return;
                }
                bar.scroll_to(Point { x: Points::ZERO, y }, false);
            });
            let mount_dt = dt.clone();
            let mount_target = target.clone();
            let layout_dt = dt.clone();
            let height_dt = dt.clone();
            let scroll_dt = dt.clone();
            let wheel_dt = dt.clone();
            scroll()
                .element_ref(&bar)
                .test_id("data-table-proportional-scrollbar")
                .on_layout(move |_: &Bounds<Points>| {
                    let g = untracked(|| mount_dt.geo());
                    let y = g.y.scroll_points(g.cy);
                    mount_target.set(Some(y));
                    bar.scroll_to(Point { x: Points::ZERO, y }, false);
                })
                .absolute()
                .right_0()
                .bottom_0()
                .w(px(STRIP))
                .top(move || Length::from(px(layout_dt.geo().header)))
                .bounces(false)
                .on_scroll(move |e: &ScrollEvent| {
                    // Programmatic following must not feed rounding back into
                    // the document's position, including when the bar is hidden.
                    if target
                        .get()
                        .is_some_and(|y| (e.offset.y - y).0.abs() <= 0.5)
                    {
                        return;
                    }
                    let g = untracked(|| scroll_dt.geo());
                    let content = g.y.content_offset(f64::from(e.offset.y.0));
                    scroll_dt.scroll_rows_to(&g, content, false);
                })
                .child(
                    view()
                        .w(relative(1.0))
                        .h(move || Length::from(px(height_dt.geo().y.extent() as f32)))
                        .on_wheel(move |e: &nsh_core::WheelEvent| {
                            let g = untracked(|| wheel_dt.geo());
                            let delta = e.delta.points(px(g.row_height));
                            wheel_dt.scroll_rows_to(&g, g.cy + f64::from(delta.y.0), false);
                        }),
                )
        },
    )
}

// The body.

/// What the three regions of the body share: the windows of rows and
/// columns made, and where they are placed from.
#[derive(Clone, Copy)]
struct Windows {
    /// The rows' slots, over the window of rows.
    row_slots: Slots,
    /// The scrolling columns' slots, over the window of their display
    /// indexes.
    col_slots: Slots,
    scroll_cols: Memo<Vec<usize>>,
    fixed_cols: Memo<Vec<usize>>,
    /// The columns fixed at the end.
    end_cols: Memo<Vec<usize>>,
    /// The first row of the chunk of rows that rows are placed from.
    row_origin: Memo<usize>,
    /// The display index of the first scrolling column of its chunk, whence
    /// the scrolling columns are placed.
    col_origin: Memo<usize>,
    /// How wide the made scrolling columns reach from `col_origin`.
    span: Memo<f32>,
}

fn windows(dt: &Dt) -> Windows {
    let d = dt.clone();
    let row_slots = Slots::new(move || {
        let rows = d.row_window();
        (
            rows.first().copied().unwrap_or(0),
            rows.last().map_or(0, |r| r + 1),
        )
    });
    let d = dt.clone();
    let scroll_cols = computed(move || d.col_window());
    let d = dt.clone();
    let col_slots = Slots::new(move || {
        let defs = scroll_cols.get();
        let st = d.st.borrow();
        let first = defs.first().and_then(|&def| st.columns.display_of(def));
        first.map_or((0, 0), |first| (first, first + defs.len()))
    });
    let d = dt.clone();
    let fixed_cols = computed(move || {
        d.layout_rev.get();
        let st = d.st.borrow();
        (0..st.columns.fixed_len())
            .map(|display| st.columns.def(display))
            .collect()
    });
    let d = dt.clone();
    let end_cols = computed(move || {
        d.layout_rev.get();
        let st = d.st.borrow();
        (st.columns.end_start()..st.columns.len())
            .map(|display| st.columns.def(display))
            .collect()
    });
    let d = dt.clone();
    let row_origin = computed(move || d.visible_rows().start / ROW_CHUNK * ROW_CHUNK);
    let d = dt.clone();
    let col_origin = computed(move || {
        let fixed = d.st.borrow().columns.fixed_len();
        (d.visible_cols().start / COLUMN_CHUNK * COLUMN_CHUNK).max(fixed)
    });
    let d = dt.clone();
    let span = computed(move || {
        d.layout_rev.get();
        let list = scroll_cols.get();
        let origin = col_origin.get();
        let st = d.st.borrow();
        let fixed_width = st.columns.fixed_width();
        let from = st.columns.start(origin.min(st.columns.len())) - fixed_width;
        let end = list
            .iter()
            .filter_map(|&def| st.columns.display_of(def))
            .map(|display| st.columns.start(display) + st.columns.display_width(display) as f64)
            .fold(0.0, f64::max);
        ((end - fixed_width) - from).max(0.0) as f32
    });
    Windows {
        row_slots,
        col_slots,
        scroll_cols,
        fixed_cols,
        end_cols,
        row_origin,
        col_origin,
        span,
    }
}

/// Which of the body's regions a row or a header is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Region {
    /// The row numbers.
    Lead,
    /// The columns fixed at the start.
    Fixed,
    /// The scrolling columns.
    Scroll,
    /// The columns fixed at the end.
    End,
}

impl Dt {
    /// Whether the region `which` of fixed columns has any (tracked).
    fn has_fixed(&self, which: Region) -> bool {
        self.layout_rev.get() > 0 && {
            let st = self.st.borrow();
            match which {
                Region::End => st.columns.end_len() > 0,
                _ => st.columns.fixed_len() > 0,
            }
        }
    }

    /// Where region `which` starts in the table's view (tracked).
    fn region_left(&self, which: Region) -> f32 {
        let g = self.geo();
        match which {
            Region::Lead => 0.0,
            Region::Fixed => g.lead,
            Region::Scroll => g.lead + g.fixed,
            Region::End => {
                g.lead + self.st.borrow().columns.end_left(g.columns_view(), g.cx) as f32
            }
        }
    }
}

/// The width of region `which`, as a style.
fn region_width<E: Element>(el: E, dt: Dt, which: Region) -> E {
    match which {
        Region::Lead => el.w(move || Length::from(px(dt.geo().lead))),
        Region::Fixed => el.w(move || Length::from(px(dt.geo().fixed))),
        Region::End => el.w(move || Length::from(px(dt.geo().end))),
        // Up to the columns fixed at the end, which it passes under.
        Region::Scroll => el.right(move || {
            let g = dt.geo();
            let right = dt.region_left(Region::End) - g.lead;
            let view = g.columns_view() as f32;
            Length::from(px(if g.end > 0.0 {
                (view - right).max(0.0)
            } else {
                0.0
            }))
        }),
    }
}

fn body(dt: Dt, custom: bool) -> impl IntoElement {
    let props = dt.props;
    let w = windows(&dt);
    let top_dt = dt.clone();
    let (lead_dt, fixed_dt, scroll_dt) = (dt.clone(), dt.clone(), dt.clone());
    let end_dt = dt.clone();
    let right_dt = dt.clone();
    view()
        .absolute()
        .left_0()
        // Clear of a terminal's scroll bar column, whose bar is not drawn
        // over content.
        .right(move || Length::from(px(right_dt.geo().bar)))
        .bottom_0()
        .top(move || Length::from(px(top_dt.geo().header)))
        .overflow_hidden()
        .pointer_events(PointerEvents::None)
        .child(region(scroll_dt, Region::Scroll, w, custom))
        .child(edge(dt.clone(), props, Region::Fixed, false))
        .child(edge(dt.clone(), props, Region::End, false))
        .child(region(fixed_dt, Region::Fixed, w, custom))
        .child(region(end_dt, Region::End, w, custom))
        .child(region(lead_dt, Region::Lead, w, custom))
}

/// The line between the scrolling columns and the fixed ones of `which`
/// (`Fixed` or `End`): at the trailing edge of those at the start, the
/// leading edge of those at the end; `in_row`, in a row of that region.
fn edge(dt: Dt, props: DataTableProps, which: Region, in_row: bool) -> impl IntoElement {
    let left_dt = dt.clone();
    let shown = move || dt.has_fixed(which) && part_styled(props, DataTablePart::FixedEdge);
    when(shown, move || {
        let dt = left_dt.clone();
        part(
            view()
                .absolute()
                .top_0()
                .bottom_0()
                .w(px(1.0))
                .left(move || {
                    let g = dt.geo();
                    Length::from(px(match (which, in_row) {
                        (Region::End, true) => 0.0,
                        (Region::End, false) => dt.region_left(Region::End),
                        (_, true) => g.fixed - 1.0,
                        (_, false) => g.lead + g.fixed - 1.0,
                    }))
                }),
            props,
            DataTablePart::FixedEdge,
        )
    })
}

/// Slots for one axis of the body: views made once and kept while the
/// table scrolls, each showing the item of the window whose index leaves
/// its slot number when divided by their count. A scroll that moves the
/// window by `k` items gives `k` slots other items (their texts and
/// places change), so no view is made or dropped while scrolling; this is
/// what drawing only the items in view each frame (gpui-component's
/// `uniform_list`) is to a retained tree.
#[derive(Clone, Copy)]
struct Slots {
    /// How many there are: the most the window has held, so slots are
    /// added as the viewport grows and never dropped.
    count: Memo<usize>,
    /// The window: a range of item indexes, at most `count` long.
    window: Memo<(usize, usize)>,
}

impl Slots {
    fn new(window: impl Fn() -> (usize, usize) + 'static) -> Slots {
        let window = computed(window);
        let most = Rc::new(Cell::new(0usize));
        let count = computed(move || {
            let (start, end) = window.get();
            let n = most.get().max(end - start);
            most.set(n);
            n
        });
        Slots { count, window }
    }

    /// The slots' numbers, for `each`.
    fn list(self) -> Memo<Vec<usize>> {
        computed(move || (0..self.count.get()).collect())
    }

    /// The item slot `slot` shows, `None` while the window has none for it.
    fn item(self, slot: usize) -> Memo<Option<usize>> {
        computed(move || {
            let n = self.count.get();
            let (start, end) = self.window.get();
            if n == 0 {
                return None;
            }
            let item = start + (slot + n - start % n) % n;
            (item < end).then_some(item)
        })
    }
}

/// One region of the body: its box (clipped, holding the rows) and the
/// rows' content.
fn region(dt: Dt, which: Region, w: Windows, custom: bool) -> impl IntoElement {
    let (left_dt, width_dt, content_dt) = (dt.clone(), dt.clone(), dt.clone());
    let rows_dt = dt.clone();
    let shown = {
        let dt = dt.clone();
        move || match which {
            Region::Lead => dt.row_header_shown(),
            Region::Fixed | Region::End => dt.has_fixed(which),
            Region::Scroll => true,
        }
    };
    when(shown, move || {
        let (left_dt, width_dt, content_dt, rows_dt) = (
            left_dt.clone(),
            width_dt.clone(),
            content_dt.clone(),
            rows_dt.clone(),
        );
        let x_dt = content_dt.clone();
        let sel_dt = content_dt.clone();
        view()
            .absolute()
            .top_0()
            .bottom_0()
            .overflow_hidden()
            .left(move || Length::from(px(left_dt.region_left(which))))
            .map(move |v| region_width(v, width_dt.clone(), which))
            .child(
                // The rows' origin: the first row of its chunk, scrolled
                // by the content offsets, on the device pixels layout rounds
                // frames to: at a fraction the cells' texts would round to
                // another pixel in their cells as it changes, and every
                // cell's frame would be sent again at each scroll frame.
                view()
                    .absolute()
                    .top(move || {
                        let g = content_dt.geo();
                        let origin = w.row_origin.get() as f64 * g.row_height as f64;
                        on_pixel(origin - g.cy)
                    })
                    .left(move || match which {
                        Region::Scroll => {
                            let g = x_dt.geo();
                            let origin = x_dt.scroll_start(w.col_origin.get());
                            on_pixel(origin - g.cx)
                        }
                        _ => Length::from(px(0.0)),
                    })
                    .child(each(
                        w.row_slots.list(),
                        |slot: &usize| *slot,
                        move |slot, _| {
                            let row = w.row_slots.item(slot.get_untracked());
                            body_row(rows_dt.clone(), row, which, w, custom)
                        },
                    )),
            )
            .when(which != Region::Lead, |v| {
                v.child(selection_overlay(sel_dt, which))
            })
    })
}

#[derive(Clone, Copy, PartialEq)]
struct RectBox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone, Copy, PartialEq, Default)]
struct SelectionOverlayLayout {
    outline: Option<RectBox>,
    fills: [Option<RectBox>; 4],
}

fn clip_rect(
    (x0, y0, x1, y1): (f64, f64, f64, f64),
    (min_x, min_y, max_x, max_y): (f64, f64, f64, f64),
) -> Option<RectBox> {
    let lx = x0.max(min_x);
    let ly = y0.max(min_y);
    let rx = x1.min(max_x);
    let ry = y1.min(max_y);
    (rx > lx && ry > ly).then_some(RectBox {
        x: lx,
        y: ly,
        w: rx - lx,
        h: ry - ly,
    })
}

/// Styles the selected rectangle in each clipped column region.
fn selection_overlay(dt: Dt, which: Region) -> impl IntoElement {
    let props = dt.props;
    let selected = dt.cell_range;
    let active = move || {
        selected.get().is_some()
            && (part_styled(props, DataTablePart::SelectionFill)
                || part_styled(props, DataTablePart::SelectionOutline))
    };
    when(active, move || {
        let dt = dt.clone();
        let layout = computed(move || {
            let Some(range) = selected.get() else {
                return SelectionOverlayLayout::default();
            };
            let Some(columns) = dt.range_columns(range) else {
                return SelectionOverlayLayout::default();
            };
            let g = dt.geo();
            let st = dt.st.borrow();
            let fixed = st.columns.fixed_len();
            let end = st.columns.end_start();
            let end_left = st.columns.end_left(g.columns_view(), g.cx);
            let (zone, origin, vw) = match which {
                Region::Fixed => (0..fixed, 0.0, f64::from(g.fixed)),
                Region::Scroll => (
                    fixed..end,
                    st.columns.fixed_width() + g.cx,
                    end_left - f64::from(g.fixed),
                ),
                Region::End => (
                    end..st.columns.len(),
                    st.columns.start(end),
                    f64::from(g.end),
                ),
                Region::Lead => unreachable!(),
            };
            if columns.start >= zone.end || columns.end <= zone.start || vw <= 0.0 {
                return SelectionOverlayLayout::default();
            }

            // Extend behind each clipping edge at a region seam so the
            // outline draws only the true edges of the rectangle.
            const PAD: f64 = 16.0;
            let rx0 = if columns.start < zone.start {
                -PAD
            } else {
                st.columns.start(columns.start) - origin
            };
            let rx1 = if columns.end > zone.end {
                vw + PAD
            } else {
                st.columns.start(columns.end) - origin
            };
            let row_h = f64::from(g.row_height);
            let rows = range.rows();
            let ry0 = f64::from(*rows.start()) * row_h - g.cy;
            let ry1 = (f64::from(*rows.end()) + 1.0) * row_h - g.cy;
            let vh = g.y.viewport;
            if rx1 <= 0.0 || rx0 >= vw || ry1 <= 0.0 || ry0 >= vh {
                return SelectionOverlayLayout::default();
            }

            let outline = clip_rect((rx0, ry0, rx1, ry1), (-PAD, -PAD, vw + PAD, vh + PAD));
            let viewport = (0.0, 0.0, vw, vh);
            let active = range.active_cell();
            let active_display = st.columns.display_of(active.column as usize);
            let fills = if let Some(display) = active_display.filter(|d| zone.contains(d)) {
                let ax0 = (st.columns.start(display) - origin).clamp(rx0, rx1);
                let ax1 = (st.columns.start(display + 1) - origin).clamp(rx0, rx1);
                let ay0 = (f64::from(active.row) * row_h - g.cy).clamp(ry0, ry1);
                let ay1 = ((f64::from(active.row) + 1.0) * row_h - g.cy).clamp(ry0, ry1);
                [
                    clip_rect((rx0, ry0, rx1, ay0), viewport),
                    clip_rect((rx0, ay1, rx1, ry1), viewport),
                    clip_rect((rx0, ay0, ax0, ay1), viewport),
                    clip_rect((ax1, ay0, rx1, ay1), viewport),
                ]
            } else {
                [clip_rect((rx0, ry0, rx1, ry1), viewport), None, None, None]
            };

            SelectionOverlayLayout { outline, fills }
        });

        let fill_box = move |index: usize| {
            part(
                view()
                    .absolute()
                    .pointer_events(PointerEvents::None)
                    .style_when(move || layout.get().fills[index].is_none(), |s| s.hidden())
                    .left(move || on_pixel(layout.get().fills[index].map_or(0.0, |b| b.x)))
                    .top(move || on_pixel(layout.get().fills[index].map_or(0.0, |b| b.y)))
                    .w(move || on_pixel(layout.get().fills[index].map_or(0.0, |b| b.w)))
                    .h(move || on_pixel(layout.get().fills[index].map_or(0.0, |b| b.h))),
                props,
                DataTablePart::SelectionFill,
            )
        };

        let show_fill = move || part_styled(props, DataTablePart::SelectionFill);
        let show_outline = move || part_styled(props, DataTablePart::SelectionOutline);

        view()
            .absolute()
            .inset_0()
            .pointer_events(PointerEvents::None)
            .child(when(show_fill, move || {
                view()
                    .absolute()
                    .inset_0()
                    .pointer_events(PointerEvents::None)
                    .child(fill_box(0))
                    .child(fill_box(1))
                    .child(fill_box(2))
                    .child(fill_box(3))
            }))
            .child(when(show_outline, move || {
                part(
                    view()
                        .absolute()
                        .pointer_events(PointerEvents::None)
                        .style_when(move || layout.get().outline.is_none(), |s| s.hidden())
                        .left(move || on_pixel(layout.get().outline.map_or(0.0, |b| b.x)))
                        .top(move || on_pixel(layout.get().outline.map_or(0.0, |b| b.y)))
                        .w(move || on_pixel(layout.get().outline.map_or(0.0, |b| b.w)))
                        .h(move || on_pixel(layout.get().outline.map_or(0.0, |b| b.h))),
                    props,
                    DataTablePart::SelectionOutline,
                )
            }))
    })
}

/// The `cell_state` of a row of the three regions, and its `selected` memo.
fn row_parts(
    dt: &Dt,
    row: Memo<Option<usize>>,
) -> (
    Memo<bool>,
    impl Fn() -> Vec<DataTablePart> + Clone + 'static,
) {
    let props = dt.props;
    let hovered = {
        let hover = dt.hover;
        computed(move || row.get().is_some() && hover.get() == row.get())
    };
    let row_marks = dt.row_marks;
    let selected = computed(move || {
        let r = row.get();
        r.is_some() && row_marks.get().0 == r
    });
    let active = computed(move || {
        let r = row.get();
        r.is_some() && row_marks.get().1 == r
    });
    let list = move || {
        let mut list = vec![DataTablePart::Row];
        if props.stripe.get() && row.get().is_some_and(|r| r % 2 == 1) {
            list.push(DataTablePart::RowOdd);
        }
        if hovered.get() {
            list.push(DataTablePart::RowHover);
        }
        if selected.get() {
            list.push(DataTablePart::RowSelected);
        }
        if active.get() {
            list.push(DataTablePart::RowActive);
        }
        list
    };
    (selected, list)
}

/// How a press in a row of `which` region finds its column.
fn region_of(which: Region, w: Windows) -> PressRegion {
    match which {
        Region::Lead => PressRegion::Lead,
        Region::Fixed => PressRegion::Fixed,
        Region::End => PressRegion::End,
        Region::Scroll => PressRegion::Scroll {
            origin: w.col_origin.get_untracked(),
        },
    }
}

fn body_row(
    dt: Dt,
    row: Memo<Option<usize>>,
    which: Region,
    w: Windows,
    custom: bool,
) -> impl IntoElement {
    let props = dt.props;
    let (top_dt, height_dt, width_dt) = (dt.clone(), dt.clone(), dt.clone());
    let (row_selected, list) = row_parts(&dt, row);
    // Its `hover:` classes and the `group-hover:` classes of the cells in
    // it, in every region, follow the hit layer's hovered row.
    let row_hovered = {
        let hover = dt.hover;
        computed(move || row.get().is_some() && hover.get() == row.get())
    };
    let (press_dt, menu_dt, class_dt) = (dt.clone(), dt.clone(), dt.clone());
    let el = parts_with(
        view()
            .role(AccessibilityRole::Row)
            .absolute()
            .left_0()
            .style_when(move || row.get().is_none(), |s| s.hidden())
            // The table is one stop of Tab, its hit layer.
            .focusable(false)
            .project_hovered(row_hovered)
            .on(EventKind::Press, move |p: &EventPayload| {
                let Some(row) = row.get_untracked() else {
                    return;
                };
                // A press without a position (a script's) lands at the row's start.
                let (x, clicks, modifiers) = match p {
                    EventPayload::Press(e) => (e.position.x, e.clicks, e.modifiers),
                    _ => (Points(0.0), 1, Default::default()),
                };
                press_dt.press_row_with(row, region_of(which, w), x, clicks, modifiers);
            })
            .on_context_menu(move |e: &ContextMenuEvent| {
                if let Some(row) = row.get_untracked() {
                    menu_dt.row_context_menu(
                        row,
                        region_of(which, w),
                        e.position.x,
                        e.page_position,
                    );
                }
            })
            .top(move || {
                let origin = w.row_origin.get() as i64;
                let row = row.get().unwrap_or(0) as i64;
                Length::from(px((row - origin) as f32 * top_dt.row_height()))
            })
            .h(move || Length::from(px(height_dt.row_height())))
            .accessibility_state(move || AccessibilityState {
                selected: row_selected.get(),
                ..AccessibilityState::default()
            }),
        props,
        list,
        move || class_dt.row_class(row.get()?),
    );
    match which {
        Region::Lead => el
            .w(move || Length::from(px(width_dt.geo().lead)))
            .child(row_number(dt, row)),
        Region::Fixed | Region::End => region_width(el, width_dt, which)
            // Above the row background, below the cells: a selected cell's
            // border must cover the fixed-column separator.
            .child(edge(dt.clone(), props, which, true))
            .child(each(
                if which == Region::End {
                    w.end_cols
                } else {
                    w.fixed_cols
                },
                |def: &usize| *def,
                move |def, _| {
                    let def = def.get_untracked();
                    cell(
                        dt.clone(),
                        row,
                        computed(move || Some(def)),
                        which,
                        w,
                        custom,
                    )
                },
            )),
        Region::Scroll => el.w(move || Length::from(px(w.span.get()))).child(each(
            w.col_slots.list(),
            |slot: &usize| *slot,
            move |slot, _| {
                let display = w.col_slots.item(slot.get_untracked());
                let def = {
                    let dt = dt.clone();
                    computed(move || {
                        let display = display.get()?;
                        dt.layout_rev.get();
                        let st = dt.st.borrow();
                        (display < st.columns.len()).then(|| st.columns.def(display))
                    })
                };
                cell(dt.clone(), row, def, which, w, custom)
            },
        )),
    }
}

/// The number of a row, in the row header column.
fn row_number(dt: Dt, row: Memo<Option<usize>>) -> impl IntoElement {
    let props = dt.props;
    let selected = dt.cell_range;
    parts(
        view()
            .absolute()
            .inset_0()
            .flex_row()
            .items_center()
            .justify_center(),
        props,
        move || {
            let mut list = vec![DataTablePart::RowHeader];
            if row.get().is_some_and(|row| {
                selected
                    .get()
                    .is_some_and(|range| range.rows().contains(&(row as u32)))
            }) {
                list.push(DataTablePart::RowHeaderHighlighted);
            }
            list
        },
    )
    .child(
        text(move || row.get().map(|r| format!("{}", r + 1)).unwrap_or_default())
            .number_of_lines(1),
    )
}

/// What marks a cell besides its row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct CellFlags {
    selected: bool,
    column_selected: bool,
    active: bool,
}

/// A number no other cell view of this thread's tables had: its render's
/// key, unique among its table's renders.
fn next_cell_key() -> u64 {
    thread_local! {
        static NEXT: Cell<u64> = const { Cell::new(0) };
    }
    NEXT.with(|n| {
        let k = n.get();
        n.set(k + 1);
        k
    })
}

fn cell(
    dt: Dt,
    row: Memo<Option<usize>>,
    def: Memo<Option<usize>>,
    which: Region,
    w: Windows,
    custom: bool,
) -> impl IntoElement {
    let props = dt.props;
    let align = {
        let dt = dt.clone();
        computed(move || {
            dt.layout_rev.get();
            def.get()
                .and_then(|def| dt.st.borrow().defs.get(def).map(|c| c.align))
                .unwrap_or(DataTableAlign::Start)
        })
    };
    let flags = {
        let cell_marks = dt.cell_marks;
        computed(move || {
            let (sel_cell, sel_col, active_cell) = cell_marks.get();
            let (Some(row), Some(def)) = (row.get(), def.get()) else {
                return CellFlags::default();
            };
            CellFlags {
                selected: sel_cell == Some((row, def)),
                column_selected: sel_col == Some(def),
                active: active_cell == Some((row, def)),
            }
        })
    };
    let list = move || {
        let mut list = vec![DataTablePart::Cell];
        let f = flags.get();
        if f.column_selected {
            list.push(DataTablePart::CellColumnSelected);
        }
        if f.selected {
            list.push(DataTablePart::CellSelected);
        }
        if f.active {
            list.push(DataTablePart::CellActive);
        }
        list
    };
    let left_dt = dt.clone();
    let width_dt = dt.clone();
    let height_dt = dt.clone();
    let col_dt = dt.clone();
    // A cell the app draws gets the presses on its own pressable views,
    // passed on by the hit layer over the body.
    let view_ref = custom.then(|| {
        let view_ref = element_ref();
        let key = dt.custom_cells.borrow_mut().add(CustomCell {
            view: view_ref,
            row,
            def,
        });
        let cells = dt.custom_cells.clone();
        cleanup(move || cells.borrow_mut().remove(key));
        view_ref
    });
    let el = column_parts(
        view()
            .map(move |v| match &view_ref {
                Some(r) => v.element_ref(r),
                None => v,
            })
            .role(AccessibilityRole::Cell)
            .accessibility_state(move || AccessibilityState {
                selected: flags.get().selected || flags.get().column_selected,
                ..AccessibilityState::default()
            })
            // Out of flow at a size of fixed points, as the row is: a text
            // that changes as the table scrolls lays out its cell alone.
            .absolute()
            .top_0()
            .h(move || Length::from(px(height_dt.row_height())))
            .style_when(move || def.get().is_none(), |s| s.hidden())
            .left(move || {
                left_dt.layout_rev.get();
                let st = left_dt.st.borrow();
                let Some(display) = def.get().and_then(|def| st.columns.display_of(def)) else {
                    return Length::from(px(0.0));
                };
                let start = st.columns.start(display);
                let origin = match which {
                    Region::Scroll => st.columns.start(w.col_origin.get().min(st.columns.len())),
                    Region::End => st.columns.start(st.columns.end_start()),
                    _ => 0.0,
                };
                Length::from(px((start - origin) as f32))
            })
            .w(move || {
                width_dt.layout_rev.get();
                let width = def
                    .get()
                    .map_or(0.0, |def| width_dt.st.borrow().columns.width(def));
                Length::from(px(width))
            })
            .overflow_hidden()
            // The content the app draws fills the cell's width, centred
            // across the row, whatever the column's alignment; a text
            // aligns in its cell.
            .map(move |v| {
                if custom {
                    v.flex_col().justify_center()
                } else {
                    v.flex_row()
                        .items_center()
                        .style_when(
                            move || align.get() == DataTableAlign::Center,
                            |s| s.justify_center(),
                        )
                        .style_when(
                            move || align.get() == DataTableAlign::End,
                            |s| s.justify_end(),
                        )
                }
            }),
        &col_dt,
        def,
        Some(row),
        list,
    );
    if custom {
        // The cell holds what the app draws itself: no view of the
        // render's own between them.
        let render_dt = dt.clone();
        // One key per cell view, not per row: a view showing another row
        // as the table scrolls keeps JS's holder, the app's function
        // renders the new row into it.
        let key: SharedString = format!("cell:{}", next_cell_key()).into();
        Renderer::render_into(el, move || {
            let render = props.render_cell.get()?;
            let (row, def) = (row.get()?, def.get()?);
            let value = {
                render_dt.data_rev.get();
                let st = render_dt.st.borrow();
                DataTableCell {
                    row: row as u32,
                    column: def as u32,
                    key: st.defs.get(def)?.key.clone(),
                    text: SharedString::default(),
                    selected: matches!(st.selection, Selection::Row(r) if r == row)
                        || st.selection == Selection::Cell(row, def),
                }
            };
            let value = DataTableCell {
                text: render_dt.cell_text(row, def),
                ..value
            };
            Some((render, key.clone(), value))
        })
        .into_element()
    } else {
        let text_dt = dt;
        let line_dt = text_dt.clone();
        let label = text(move || match (row.get(), def.get()) {
            (Some(row), Some(def)) => text_dt.cell_text(row, def),
            _ => SharedString::default(),
        })
        .number_of_lines(1)
        // The cell's whole box, its one line as tall as the row: a text
        // never resizes it, so a cell whose text changes as the table
        // scrolls is neither measured nor laid out again, only drawn.
        .w_full()
        .h_full()
        .min_w(px(0.0))
        .line_height(move || nsh_core::LineHeight::from(px(line_dt.row_height())))
        .style_when(
            move || align.get() == DataTableAlign::Center,
            |s| s.text_center(),
        )
        .style_when(
            move || align.get() == DataTableAlign::End,
            |s| s.text_right(),
        );
        el.child(label).into_element()
    }
}

// The header.

/// A label over columns, placed from a display index.
#[derive(Debug, Clone, PartialEq)]
struct GroupCell {
    level: usize,
    label: SharedString,
    from: usize,
    to: usize,
}

/// The groups of every level over the columns of region `which`: those
/// over the made scrolling columns (or the chunk they are placed from), or
/// over a column fixed at that side.
fn group_cells(dt: &Dt, which: Region, window: &[usize], origin: usize) -> Vec<GroupCell> {
    let (fixed, end, n) = {
        let st = dt.st.borrow();
        (
            st.columns.fixed_len(),
            st.columns.end_start(),
            st.columns.len(),
        )
    };
    let scroll = which == Region::Scroll;
    let first = window
        .first()
        .and_then(|&d| dt.st.borrow().columns.display_of(d));
    let last = window
        .iter()
        .filter_map(|&d| dt.st.borrow().columns.display_of(d))
        .max();
    let mut cells = Vec::new();
    dt.props.groups.with(|levels| {
        for (level, groups) in levels.iter().enumerate() {
            let mut at = 0usize;
            for group in groups {
                let from = at;
                let to = (at + group.span.max(1) as usize).min(n);
                at = to;
                if from >= n {
                    break;
                }
                let keep = if scroll {
                    // Overlapping the made columns (or the chunk they are
                    // placed from).
                    let low = first.unwrap_or(origin).min(origin);
                    to > fixed.max(low)
                        && from < end
                        && last.is_some_and(|l| from <= l)
                        && from >= low.min(from)
                } else if which == Region::End {
                    to > end
                } else {
                    from < fixed
                };
                if keep {
                    cells.push(GroupCell {
                        level,
                        label: group.label.clone(),
                        from,
                        to,
                    });
                }
            }
        }
    });
    cells
}

fn header(dt: Dt, custom: bool) -> impl IntoElement {
    let props = dt.props;
    let w = windows(&dt);
    let (height_dt, right_dt) = (dt.clone(), dt.clone());
    let (corner_dt, fixed_dt, scroll_dt) = (dt.clone(), dt.clone(), dt.clone());
    let end_dt = dt.clone();
    part(
        view()
            .absolute()
            .top_0()
            .left_0()
            // As wide as the body, its columns over the body's.
            .right(move || Length::from(px(right_dt.geo().bar)))
            .h(move || Length::from(px(height_dt.geo().header)))
            .overflow_hidden(),
        props,
        DataTablePart::Header,
    )
    .child(header_region(scroll_dt, Region::Scroll, w, custom))
    .child(header_region(fixed_dt, Region::Fixed, w, custom))
    .child(header_region(end_dt, Region::End, w, custom))
    .child(corner(corner_dt))
    .child(move_line(dt))
}

/// The corner above the row headers.
fn corner(dt: Dt) -> impl IntoElement {
    let props = dt.props;
    let width_dt = dt.clone();
    when(
        move || dt.row_header_shown(),
        move || {
            let width_dt = width_dt.clone();
            part(
                view()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left_0()
                    .w(move || Length::from(px(width_dt.geo().lead))),
                props,
                DataTablePart::RowHeaderCorner,
            )
        },
    )
}

fn header_region(dt: Dt, which: Region, w: Windows, custom: bool) -> impl IntoElement {
    let (left_dt, width_dt, x_dt, row_dt) = (dt.clone(), dt.clone(), dt.clone(), dt.clone());
    let shown = {
        let dt = dt.clone();
        move || match which {
            Region::Fixed | Region::End => dt.has_fixed(which),
            _ => true,
        }
    };
    let groups = {
        let dt = dt.clone();
        computed(move || {
            dt.layout_rev.get();
            let window = w.scroll_cols.get();
            group_cells(&dt, which, &window, w.col_origin.get())
        })
    };
    let levels = {
        let dt = dt.clone();
        computed(move || (0..dt.header_levels()).collect::<Vec<usize>>())
    };
    when(shown, move || {
        let (left_dt, width_dt, x_dt, row_dt) = (
            left_dt.clone(),
            width_dt.clone(),
            x_dt.clone(),
            row_dt.clone(),
        );
        let list = match which {
            Region::Fixed => w.fixed_cols,
            Region::End => w.end_cols,
            _ => w.scroll_cols,
        };
        view()
            .absolute()
            .top_0()
            .bottom_0()
            .overflow_hidden()
            .left(move || Length::from(px(left_dt.region_left(which))))
            .map(move |v| region_width(v, width_dt.clone(), which))
            .child(
                view()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(move || match which {
                        Region::Scroll => {
                            let g = x_dt.geo();
                            let origin = x_dt.scroll_start(w.col_origin.get());
                            on_pixel(origin - g.cx)
                        }
                        _ => Length::from(px(0.0)),
                    })
                    .child(each(
                        levels,
                        |row: &usize| *row,
                        move |row, _| {
                            header_row(
                                row_dt.clone(),
                                row.get_untracked(),
                                which,
                                w,
                                custom,
                                groups,
                                list,
                            )
                        },
                    )),
            )
    })
}

/// One row of the header: a level of group labels or the titles' row, with
/// the row role, so a column header has a row to belong to.
fn header_row(
    dt: Dt,
    index: usize,
    which: Region,
    w: Windows,
    custom: bool,
    groups: Memo<Vec<GroupCell>>,
    list: Memo<Vec<usize>>,
) -> impl IntoElement {
    let (top_dt, height_dt, width_dt, groups_dt, titles_dt) =
        (dt.clone(), dt.clone(), dt.clone(), dt.clone(), dt.clone());
    let rows = {
        let dt = dt.clone();
        computed(move || {
            let levels = dt.header_levels();
            // Lowest level first: it is the one above the titles.
            let Some(level) = levels.checked_sub(2 + index) else {
                return Vec::new();
            };
            groups
                .get()
                .into_iter()
                .filter(|group| group.level == level)
                .collect()
        })
    };
    let titles = {
        let dt = dt.clone();
        computed(move || index + 1 == dt.header_levels())
    };
    view()
        .role(AccessibilityRole::Row)
        .absolute()
        .left_0()
        .w(move || {
            let width = match which {
                Region::Scroll => w.span.get(),
                Region::Fixed => width_dt.geo().fixed,
                Region::End => width_dt.geo().end,
                Region::Lead => 0.0,
            };
            Length::from(px(width))
        })
        .top(move || {
            let h = top_dt.row_height_for_header();
            Length::from(px(h * index as f32))
        })
        .h(move || Length::from(px(height_dt.row_height_for_header())))
        .child(each(
            rows,
            |group: &GroupCell| (group.level, group.from),
            move |group, _| group_cell(groups_dt.clone(), group.get_untracked(), which, w),
        ))
        .child(when(titles, move || {
            let titles_dt = titles_dt.clone();
            each(
                list,
                |def: &usize| *def,
                move |def, _| title(titles_dt.clone(), def.get_untracked(), which, w, custom),
            )
        }))
}

/// A label over columns.
fn group_cell(dt: Dt, group: GroupCell, which: Region, w: Windows) -> impl IntoElement {
    let props = dt.props;
    let (left_dt, width_dt) = (dt.clone(), dt.clone());
    part(
        view()
            .absolute()
            .top_0()
            .h(relative(1.0))
            .left(move || {
                left_dt.layout_rev.get();
                let st = left_dt.st.borrow();
                let origin = match which {
                    Region::Scroll => st.columns.start(w.col_origin.get().min(st.columns.len())),
                    Region::End => st.columns.start(st.columns.end_start()),
                    _ => 0.0,
                };
                Length::from(px((st.columns.start(group.from) - origin) as f32))
            })
            .w(move || {
                width_dt.layout_rev.get();
                let st = width_dt.st.borrow();
                let end = st.columns.start(group.to.min(st.columns.len()));
                Length::from(px((end - st.columns.start(group.from)) as f32))
            })
            .flex_row()
            .items_center()
            .justify_center()
            .overflow_hidden(),
        props,
        DataTablePart::GroupCell,
    )
    .child(text(group.label.clone()).number_of_lines(1))
}

/// The title of a column.
fn title(dt: Dt, def: usize, which: Region, w: Windows, custom: bool) -> impl IntoElement {
    let props = dt.props;
    let st_dt = dt.clone();
    let (align, sortable) = {
        let st = dt.st.borrow();
        let column = st.defs.get(def);
        (
            column.map_or(DataTableAlign::Start, |c| c.align),
            column.is_some_and(|c| c.sortable),
        )
    };
    let sorted = {
        let dt = dt.clone();
        computed(move || {
            let key = dt.st.borrow().defs.get(def).map(|c| c.key.clone())?;
            props
                .sort
                .get()
                .filter(|s| s.key == key)
                .map(|s| s.direction)
        })
    };
    let range_selected = {
        let dt = dt.clone();
        computed(move || {
            dt.cell_range
                .get()
                .and_then(|range| dt.range_columns(range))
                .is_some_and(|columns| {
                    dt.st
                        .borrow()
                        .columns
                        .display_of(def)
                        .is_some_and(|display| columns.contains(&display))
                })
        })
    };
    let selected = {
        let dt = dt.clone();
        computed(move || dt.selection() == Selection::Column(def))
    };
    let dragging = {
        let dt = dt.clone();
        computed(move || {
            dt.column_drag
                .get()
                .is_some_and(|d| d.moving && dt.st.borrow().columns.display_of(def) == Some(d.from))
        })
    };
    let list = move || {
        let mut list = vec![DataTablePart::HeaderCell];
        if sorted.get().is_some() {
            list.push(DataTablePart::HeaderCellSorted);
        }
        if selected.get() || range_selected.get() {
            list.push(DataTablePart::HeaderCellSelected);
        }
        if dragging.get() {
            list.push(DataTablePart::HeaderCellDragging);
        }
        list
    };
    let (left_dt, width_dt) = (dt.clone(), dt.clone());
    let (press_dt, claim_dt, grant_dt, move_dt, up_dt, end_dt) = (
        dt.clone(),
        dt.clone(),
        dt.clone(),
        dt.clone(),
        dt.clone(),
        dt.clone(),
    );
    let (drag_dt, header_menu_dt) = (dt.clone(), dt.clone());
    let moved = Rc::new(Cell::new(false));
    let (down_moved, up_moved) = (moved.clone(), moved.clone());
    let col_dt = dt.clone();
    let el = column_parts(
        view()
            .role(AccessibilityRole::ColumnHeader)
            .accessibility_state(move || AccessibilityState {
                selected: selected.get(),
                ..AccessibilityState::default()
            })
            .absolute()
            .top_0()
            .h(relative(1.0))
            .left(move || {
                left_dt.layout_rev.get();
                let st = left_dt.st.borrow();
                let Some(display) = st.columns.display_of(def) else {
                    return Length::from(px(0.0));
                };
                let origin = match which {
                    Region::Scroll => st.columns.start(w.col_origin.get().min(st.columns.len())),
                    Region::End => st.columns.start(st.columns.end_start()),
                    _ => 0.0,
                };
                Length::from(px((st.columns.start(display) - origin) as f32))
            })
            .w(move || {
                width_dt.layout_rev.get();
                Length::from(px(width_dt.st.borrow().columns.width(def)))
            })
            .flex_row()
            .items_center()
            .overflow_hidden()
            .map(move |v| match align {
                DataTableAlign::Start => v.justify_start(),
                DataTableAlign::Center => v.justify_center(),
                DataTableAlign::End => v.justify_end(),
            })
            .focusable(false)
            .on(EventKind::Press, move |p: &EventPayload| {
                // A drag that moved the column is not a press.
                if up_moved.replace(false) {
                    return;
                }
                let (clicks, modifiers) = match p {
                    EventPayload::Press(e) => (e.clicks, e.modifiers),
                    _ => (1, Default::default()),
                };
                press_dt.header_press(def, clicks, modifiers);
            })
            .on_context_menu(move |e: &ContextMenuEvent| {
                header_menu_dt.header_context_menu(def, e.page_position)
            })
            .claim_touches(TouchClaim::on_move().ask(move |request: &ClaimRequest| {
                let moving = request.event.gesture.delta.x.0.abs() > MOVE_SLOP
                    && request.event.gesture.delta.x.0.abs()
                        > request.event.gesture.delta.y.0.abs();
                if moving && claim_dt.movable(def) {
                    request.claim();
                }
            }))
            .keep_touches(true)
            .on_responder_grant(move |_: &ResponderEvent| {
                down_moved.set(true);
                let display = grant_dt.st.borrow().columns.display_of(def);
                if let Some(display) = display {
                    grant_dt.move_start(display);
                }
            })
            .on_responder_move(move |e: &ResponderEvent| {
                let g = move_dt.geo();
                let at = {
                    let st = move_dt.st.borrow();
                    let display = st.columns.display_of(def).unwrap_or(0);
                    column_x(&st.columns, &g, display)
                };
                // The pointer in the table: where the title starts and the
                // pointer in it.
                move_dt.move_to(at + e.location.x.0, e.gesture.delta.x.0);
            })
            .on_responder_release(move |_: &ResponderEvent| up_dt.move_end(true))
            .on_responder_terminate(move |_: &ResponderEvent| end_dt.move_end(false)),
        &col_dt,
        computed(move || Some(def)),
        None,
        list,
    );
    let _ = &st_dt;
    let content = title_content(dt.clone(), def, align, sorted, sortable, custom, selected);
    el.child(content).child(resize_handle(drag_dt, def))
}

impl Dt {
    /// The height of one title row.
    pub(crate) fn row_height_for_header(&self) -> f32 {
        self.geo().header / self.header_levels() as f32
    }
}

fn title_content(
    dt: Dt,
    def: usize,
    align: DataTableAlign,
    sorted: Memo<Option<DataTableSortDirection>>,
    sortable: bool,
    custom: bool,
    selected: Memo<bool>,
) -> AnyElement {
    let props = dt.props;
    let make_label = move |dt: Dt| -> AnyElement {
        if custom {
            dynamic(move || {
                let render = props.render_header_cell.get()?;
                let value = DataTableHeaderCell {
                    column: def as u32,
                    key: dt.st.borrow().defs.get(def)?.key.clone(),
                    title: dt.title(def),
                    sort: sorted.get(),
                    selected: selected.get(),
                };
                Some(
                    render
                        .render(format!("head:{def}"), value)
                        .flex_1()
                        .min_w(px(0.0)),
                )
            })
            .into_element()
        } else {
            // The title takes the room the sort button leaves, aligned as the
            // column's cells.
            text(move || dt.title(def))
                .number_of_lines(1)
                .flex_1()
                .min_w(px(0.0))
                // A terminal has no header band to set the titles apart:
                // bold does, as a TUI table's header is.
                .map(|t| {
                    if crate::terminal::is_terminal() {
                        t.font_weight(FontWeight::BOLD)
                    } else {
                        t
                    }
                })
                .map(move |t| match align {
                    DataTableAlign::Start => t.text_left(),
                    DataTableAlign::Center => t.text_center(),
                    DataTableAlign::End => t.text_right(),
                })
                .into_element()
        }
    };
    if !sortable {
        let wrapped = computed(move || part_styled(props, DataTablePart::HeaderContent));
        return dynamic(move || {
            let label = make_label(dt.clone());
            if wrapped.get() {
                part(
                    view().flex_1().flex_row().items_center().min_w(px(0.0)),
                    props,
                    DataTablePart::HeaderContent,
                )
                .child(label)
                .into_element()
            } else {
                label
            }
        })
        .into_element();
    }
    let label = make_label(dt.clone());
    let indicator_dt = dt;
    part(
        view().flex_1().flex_row().items_center().min_w(px(0.0)),
        props,
        DataTablePart::HeaderContent,
    )
    .child(label)
    .child(sort_button(indicator_dt, def, sorted))
    .into_element()
}

/// The sort button at the end of a sortable title: its hit area and
/// direction, pressing which asks for the next sort. The app styles it.
fn sort_button(
    dt: Dt,
    def: usize,
    sorted: Memo<Option<DataTableSortDirection>>,
) -> impl IntoElement {
    let props = dt.props;
    let id = format!("sort:{}", dt.st.borrow().defs[def].key);
    part(
        view()
            .relative()
            .flex_none()
            .w(px(SORT_WIDTH))
            .h(px(SORT_WIDTH))
            .items_center()
            .justify_center()
            .role(AccessibilityRole::Button)
            .test_id(&id)
            .focusable(false)
            .on_press(move || dt.sort_next(def))
            .children(sort_icons(props, sorted)),
        props,
        DataTablePart::SortIndicator,
    )
}

/// The original pair of Lucide chevrons. Paint follows the app's inherited
/// stroke/text color; each direction exposes its selected state for styling.
/// In a terminal, one glyph: `▲` ascending, `▼` descending, `↕` unsorted,
/// each the part of its direction (an unsorted column's `↕` the ascending
/// part's, not selected: as faint as an unsorted chevron).
fn sort_icons(
    props: DataTableProps,
    sorted: Memo<Option<DataTableSortDirection>>,
) -> Vec<AnyElement> {
    // A terminal draws no chevrons: the direction is one Cell's glyph.
    if crate::terminal::is_terminal() {
        return vec![
            dynamic(move || {
                let (glyph, which) = match sorted.get() {
                    Some(DataTableSortDirection::Ascending) => ("▲", DataTablePart::SortAscending),
                    Some(DataTableSortDirection::Descending) => {
                        ("▼", DataTablePart::SortDescending)
                    }
                    None => ("↕", DataTablePart::SortAscending),
                };
                Some(part(
                    text(glyph)
                        .number_of_lines(1)
                        .accessible(false)
                        .accessibility_state(move || AccessibilityState {
                            selected: sorted.get().is_some(),
                            ..AccessibilityState::default()
                        }),
                    props,
                    which,
                ))
            })
            .into_element(),
        ];
    }
    const K: f32 = 12.0 / 24.0;
    let inset = px((SORT_WIDTH - 12.0) * 0.5);
    let chevron = move |points: [f32; 6], direction, which| {
        part(
            canvas(move || {
                Painter::new()
                    .stroke_style_from_view(nsh_core::SvgPaint::CurrentColor)
                    .line_width(2.0 * K)
                    .line_cap(nsh_core::canvas::LineCap::Round)
                    .line_join(nsh_core::canvas::LineJoin::Round)
                    .begin_path()
                    .move_to(points[0] * K, points[1] * K)
                    .line_to(points[2] * K, points[3] * K)
                    .line_to(points[4] * K, points[5] * K)
                    .stroke()
            })
            .absolute()
            .inset(inset)
            .accessible(false)
            .pointer_events(PointerEvents::None)
            .accessibility_state(move || AccessibilityState {
                selected: sorted.get() == Some(direction),
                ..AccessibilityState::default()
            }),
            props,
            which,
        )
        .into_element()
    };
    vec![
        chevron(
            [7.0, 9.0, 12.0, 4.0, 17.0, 9.0],
            DataTableSortDirection::Ascending,
            DataTablePart::SortAscending,
        ),
        chevron(
            [7.0, 15.0, 12.0, 20.0, 17.0, 15.0],
            DataTableSortDirection::Descending,
            DataTablePart::SortDescending,
        ),
    ]
}

/// The band at a title's trailing edge that a drag resizes the column
/// with; a double press fits the column.
fn resize_handle(dt: Dt, def: usize) -> impl IntoElement {
    let props = dt.props;
    let enabled = {
        let dt = dt.clone();
        move || dt.resizable(def)
    };
    let (start, drag, end) = (dt.clone(), dt.clone(), dt.clone());
    when(enabled, move || {
        let (start, drag, end) = (start.clone(), drag.clone(), end.clone());
        handle(props, start, drag, end, def)
    })
}

fn handle(props: DataTableProps, start: Dt, drag: Dt, end: Dt, def: usize) -> impl IntoElement {
    let id = format!("resize:{}", drag.st.borrow().defs[def].key);
    // The mouse's alone, as `gpui-component`'s: a terminal's handle would
    // be a stop of Tab per column after the table.
    provide_context(crate::resizable::PointerOnly);
    resize_handle_component()
        .edge(HandleEdge::Trailing)
        .on_drag_start(move || start.resize_start(def))
        .on_drag_move(move |offset: &Points| drag.resize_move(*offset))
        .on_drag_end(move |offset: &Points| end.resize_end(*offset))
        .child(part(
            view().test_id(&id).w(px(1.0)),
            props,
            DataTablePart::ResizeHandle,
        ))
}

fn resize_handle_component() -> crate::ResizeHandleElement {
    crate::resize_handle()
}

/// The line where a dragged column will drop.
fn move_line(dt: Dt) -> impl IntoElement {
    let props = dt.props;
    let shown = {
        let dt = dt.clone();
        move || dt.column_drag.get().is_some_and(|d| d.moving)
    };
    when(shown, move || {
        let dt = dt.clone();
        part(
            view()
                .absolute()
                .top_0()
                .bottom_0()
                .w(px(DROP_LINE))
                .left(move || {
                    let Some(drag) = dt.column_drag.get() else {
                        return Length::from(px(0.0));
                    };
                    dt.layout_rev.get();
                    let g = dt.geo();
                    let st = dt.st.borrow();
                    // At the trailing edge of the target when moving right.
                    let display = if drag.to > drag.from {
                        drag.to + 1
                    } else {
                        drag.to
                    };
                    let display = display.min(st.columns.len());
                    let x = if display <= st.columns.fixed_len() || display > st.columns.end_start()
                    {
                        column_x(&st.columns, &g, display)
                    } else {
                        let end = st.columns.end_left(g.columns_view(), g.cx) as f32;
                        (g.lead + st.columns.start(display) as f32 - g.cx as f32)
                            .clamp(g.lead + g.fixed, g.lead + end)
                    };
                    Length::from(px(x - DROP_LINE / 2.0))
                }),
            props,
            DataTablePart::MoveIndicator,
        )
    })
}

/// Where the column at `display` (or the columns' end, at their number)
/// starts in the table's view: a fixed one where it stays, a scrolling one
/// where the table scrolled it.
fn column_x(columns: &Columns, g: &Geo, display: usize) -> f32 {
    let start = columns.start(display.min(columns.len()));
    let x = if display < columns.fixed_len() {
        start
    } else if display >= columns.end_start() && columns.end_start() < columns.len() {
        let end = columns.start(columns.end_start());
        columns.end_left(g.columns_view(), g.cx) + (start - end)
    } else {
        start - g.cx
    };
    g.lead + x as f32
}

// What shows over the rows.

fn overlays(dt: Dt) -> impl IntoElement {
    let props = dt.props;
    let empty_dt = dt.clone();
    let top_dt = dt.clone();
    let wheel_dt = dt.clone();
    let is_empty = move || empty_dt.row_count() == 0 && !empty_dt.props.loading.get();
    let loading = move || props.loading.get();
    view()
        .absolute()
        .left_0()
        .right_0()
        .bottom_0()
        .top(move || Length::from(px(top_dt.geo().header)))
        .pointer_events(PointerEvents::BoxNone)
        .child(when(is_empty, move || {
            part(
                view()
                    .absolute()
                    .inset_0()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    // Only what the app put in it takes the pointer: a wheel
                    // or a pan on the room around it is the hit layer's,
                    // which scrolls the columns.
                    .pointer_events(PointerEvents::BoxNone)
                    // What the app put in it lies over the hit layer, not
                    // in it: a wheel there moves the columns from here.
                    .on_wheel({
                        let dt = wheel_dt.clone();
                        move |e: &nsh_core::WheelEvent| {
                            let g = untracked(|| dt.geo());
                            let delta = e.delta.points(px(g.row_height));
                            let max = (g.x.extent() - g.x.viewport).max(0.0) as f32;
                            let x = (dt.scroll_x.get_untracked().0 + delta.x.0).clamp(0.0, max);
                            dt.hscroll.scroll_to(
                                Point {
                                    x: px(x),
                                    y: Points::ZERO,
                                },
                                false,
                            );
                        }
                    }),
                props,
                DataTablePart::Empty,
            )
            .child(props.empty.place(|slot| slot))
        }))
        .child(when(loading, move || {
            view()
                .absolute()
                .inset_0()
                .child(props.loading_view.place(|slot| slot))
        }))
}

/// `points` on the nearest device pixel, as layout rounds frames
/// ([`nsh_core::element::pixel_ratio`]); in `f64` up to there, for
/// the extents of huge tables.
fn on_pixel(points: f64) -> Length {
    let ratio = f64::from(nsh_core::element::pixel_ratio().max(f32::MIN_POSITIVE));
    Length::from(px(((points * ratio).round() / ratio) as f32))
}

/// Whether a view's layout has room for anything: `display: none` around
/// it leaves it none.
fn has_area(b: &Bounds<Points>) -> bool {
    b.size.width > Points::ZERO && b.size.height > Points::ZERO
}

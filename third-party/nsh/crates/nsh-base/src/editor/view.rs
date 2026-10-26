//! The editor's view: a vertical scroll view of a row of the gutter and
//! the text area (a horizontal scroll view without soft wrap), whose box
//! of rows holds, from back to front, the line backgrounds, indent guides,
//! search matches, selections, the rows of text, diagnostics' marks, the
//! carets, the composition and the sink. Only the rows in view (and a few
//! around them) are made, each a text whose spans are highlighted tokens.

use nsh_core::{
    element::{ContextMenuEvent, Cursor, EventKind, EventPayload, Style},
    prelude::*,
};

use super::{
    EditorDiagnosticSeverity, EditorPart, EditorProps,
    controller::Ed,
    state::{RowContent, SpanTags},
};
use crate::{input, theme};

/// The width of a caret.
pub(crate) const CARET_WIDTH: f32 = 2.0;
/// The thickness of a diagnostic's underline, as GPUI Kit draws it.
const MARK_HEIGHT: f32 = 1.0;

/// Search matches' background (amber), and the current match's.
const MATCH: AdaptiveColor = AdaptiveColor::rgb(0xfbbf24, 0xd97706);
/// A warning's mark (amber).
const WARNING: AdaptiveColor = AdaptiveColor::rgb(0xd97706, 0xfbbf24);
/// An information's mark (blue).
const INFO: AdaptiveColor = AdaptiveColor::rgb(0x2563eb, 0x60a5fa);

/// `el` with part `part`'s classes and style, which follow the props.
pub(crate) fn part<E: Element>(el: E, props: EditorProps, part: EditorPart) -> E {
    el.app_class(move || props.classes.with(|c| c.get(part).cloned()))
        .inline_style(move || {
            props
                .styles
                .with(|s| s.get(part).cloned().unwrap_or_default())
        })
}

/// `el` with the classes and styles of `parts`, in order (later parts
/// win).
pub(crate) fn parts<E: Element>(el: E, props: EditorProps, list: &'static [EditorPart]) -> E {
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
                list.iter()
                    .filter_map(|p| s.get(*p))
                    .flat_map(|s| s.decls().iter().cloned()),
            )
        })
    })
}

/// The editor.
pub(crate) fn render(ed: Ed) -> impl IntoElement {
    let lh = {
        let ed = ed.clone();
        move || {
            ed.text_rev.get();
            ed.st.borrow().line_height()
        }
    };
    let font = {
        let ed = ed.clone();
        move || {
            ed.text_rev.get();
            ed.st.borrow().font.clone()
        }
    };
    let (font_a, font_b, font_c) = (font.clone(), font.clone(), font);
    let vscroll_ed = ed.clone();
    let layout_ed = ed.clone();
    let place_ed = ed.clone();
    let grow_ed = ed.clone();
    let content_ed = ed.clone();
    let paint_ed = ed.clone();
    let pointer = GutterPointer {
        hover: signal(None),
        pressed: signal(None),
    };
    view()
        .element_ref(&ed.hooks.outer)
        .on_layout(move |_: &Bounds<Points>| place_ed.measure_place())
        .relative()
        .overflow_hidden()
        .h(move || match grow_height(&grow_ed) {
            Some(height) => Length::from(height),
            None => Length::Auto,
        })
        .text_color(move || theme().foreground)
        .font_family(move || font_a().family)
        .text_size(move || Length::from(font_b().size))
        .line_height(move || Length::from(font_c().line_height))
        .child(
            scroll()
                .element_ref(&ed.vscroll)
                .absolute()
                .inset_0()
                .on_scroll(move |e: &ScrollEvent| {
                    vscroll_ed.scroll_y.set(e.offset.y);
                    vscroll_ed.viewport.set(e.size);
                    // Lines scrolled into view far past the parse are guessed.
                    vscroll_ed.schedule_highlight();
                })
                .on_layout(move |b: &Bounds<Points>| layout_ed.viewport.set(b.size))
                .child(
                    view()
                        .flex_row()
                        .items_stretch()
                        .on_layout(move |b: &Bounds<Points>| {
                            content_ed.content_height.set(b.size.height)
                        })
                        .child(gutter(ed.clone(), Layer::Hit, pointer))
                        .child(text_area(ed.clone(), lh.clone(), Layer::Hit)),
                ),
        )
        // What the scroll views show, drawn over them where the editor last
        // scrolled to: the platforms move a scroll view's content at once,
        // the rows a move needs come with the editor's next commit, which
        // moves this layer with them, so no frame shows the content without
        // its rows.
        .child(
            view()
                .absolute()
                .inset_0()
                .overflow_hidden()
                .pointer_events(PointerEvents::None)
                .child(
                    view()
                        .absolute()
                        .left_0()
                        .right_0()
                        .top(move || Length::from(-paint_ed.scroll_y.get()))
                        .flex_row()
                        .items_stretch()
                        .child(gutter(ed.clone(), Layer::Paint, pointer))
                        .child(text_area(ed.clone(), lh.clone(), Layer::Paint)),
                ),
        )
        .child(super::completion::menu(ed.clone()))
        .child(sink(ed, lh))
}

/// Which of the editor's two trees a part is made for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layer {
    /// In the scroll views: the active-line backgrounds and what the
    /// pointer, wheel, scroll bars and touches reach (the platforms scroll it).
    Hit,
    /// Over the scroll views, receiving no pointer: what shows, placed
    /// where the editor scrolled to. Its views keep their handlers for the
    /// tests that press them by what they show.
    Paint,
}

/// The fold marker the pointer is over and the one pressed (display rows):
/// the hit tree's markers take the pointer, the painted ones show it.
#[derive(Clone, Copy)]
struct GutterPointer {
    hover: Signal<Option<usize>>,
    pressed: Signal<Option<usize>>,
}

/// The gutter: line numbers and fold markers of the rows in view.
fn gutter(ed: Ed, layer: Layer, pointer: GutterPointer) -> impl IntoElement {
    let props = ed.props;
    let shown = move || props.line_numbers.get() || props.folding.get();
    // Memos: every row reads them, and an edit would measure the digit
    // again for each.
    let number_width = {
        let ed = ed.clone();
        let width = computed(move || {
            ed.text_rev.get();
            if !props.line_numbers.get() {
                return px(0.0);
            }
            let st = ed.st.borrow();
            let digits = st.buffer.line_count().max(1).ilog10() as usize + 1;
            let zero = super::controller::text_width(&st.font.css(), "0");
            // Whole points: the text engines of AppKit, UIKit and Win32 round
            // a measured width up, so a number laid out in the exact width
            // of its digits is a fraction too wide and shows as "…".
            (zero * digits.max(2) as f32).ceil()
        });
        move || width.get()
    };
    let fold_width = {
        let ed = ed.clone();
        let width = computed(move || {
            if !props.folding.get() {
                return px(0.0);
            }
            ed.text_rev.get();
            ed.st.borrow().line_height()
        });
        move || width.get()
    };
    let height = {
        let ed = ed.clone();
        move || rows_height(&ed)
    };
    let rows = visible_rows(ed.clone());
    let top = ed.rows_top;
    when(shown, move || {
        let height = height.clone();
        let row_ed = ed.clone();
        let press_ed = ed.clone();
        let inner = view()
            .relative()
            .mt(move || Length::from(top.get()))
            .w(move || Length::from(number_width() + fold_width()))
            .h(move || Length::from(height()));
        let inner = match layer {
            Layer::Paint => inner.child(each(
                rows,
                |row: &usize| *row,
                move |row, _| {
                    gutter_row(
                        row_ed.clone(),
                        row.get_untracked(),
                        number_width,
                        fold_width,
                        pointer,
                    )
                },
            )),
            // A press on a number reports its line; the markers take
            // presses of their own.
            Layer::Hit => inner
                .on(EventKind::Press, move |p: &EventPayload| {
                    let EventPayload::Press(e) = p else { return };
                    if !props.line_numbers.get_untracked() || e.position.x >= number_width() {
                        return;
                    }
                    let row = {
                        let st = press_ed.st.borrow();
                        let row = (e.position.y / st.line_height()).floor().max(0.0) as usize;
                        (row < st.display.row_count()).then_some(row)
                    };
                    if let Some(row) = row {
                        press_ed.line_number_press(row);
                    }
                })
                .child(each(
                    rows,
                    |row: &usize| *row,
                    move |row, _| {
                        fold_hit(
                            row_ed.clone(),
                            row.get_untracked(),
                            number_width,
                            fold_width,
                            pointer,
                        )
                    },
                )),
        };
        part(
            view().flex_none().pl(px(12.0)).pr(px(4.0)),
            props,
            EditorPart::Gutter,
        )
        .child(inner)
    })
}

/// What takes the pointer for the fold marker of display row `row`, when
/// it has one: a clear box over the painted marker.
fn fold_hit(
    ed: Ed,
    row: usize,
    number_width: impl Fn() -> Points + Clone + 'static,
    fold_width: impl Fn() -> Points + Clone + 'static,
    pointer: GutterPointer,
) -> impl IntoElement {
    let props = ed.props;
    let folds = {
        let ed = ed.clone();
        computed(move || {
            ed.text_rev.get();
            ed.marks_rev.get();
            props.folding.get() && ed.st.borrow_mut().gutter_row(row).fold.is_some()
        })
    };
    when(
        move || folds.get(),
        move || {
            let ed = ed.clone();
            let (number_width, fold_width) = (number_width.clone(), fold_width.clone());
            let lh = {
                let ed = ed.clone();
                move || {
                    ed.text_rev.get();
                    ed.st.borrow().line_height()
                }
            };
            let lh2 = lh.clone();
            view()
                .absolute()
                .left(move || {
                    Length::from(if props.line_numbers.get() {
                        number_width()
                    } else {
                        px(0.0)
                    })
                })
                .top(move || Length::from(lh() * row as f32))
                .w(move || Length::from(fold_width()))
                .h(move || Length::from(lh2()))
                .cursor_pointer()
                .on_hover_in(move || pointer.hover.set(Some(row)))
                .on_hover_out(move || {
                    if pointer.hover.get_untracked() == Some(row) {
                        pointer.hover.set(None);
                    }
                })
                .on(EventKind::PressDown, move |_: &EventPayload| {
                    pointer.pressed.set(Some(row))
                })
                .on(EventKind::PressUp, move |_: &EventPayload| {
                    pointer.pressed.set(None)
                })
                .on_press(move || {
                    let line = ed.st.borrow().display.row(row).line;
                    ed.fold(line, None);
                })
        },
    )
}

/// The gutter of display row `row`.
fn gutter_row(
    ed: Ed,
    row: usize,
    number_width: impl Fn() -> Points + Clone + 'static,
    fold_width: impl Fn() -> Points + Clone + 'static,
    pointer: GutterPointer,
) -> impl IntoElement {
    let props = ed.props;
    let info = {
        let ed = ed.clone();
        computed(move || {
            ed.text_rev.get();
            ed.sel_rev.get();
            ed.marks_rev.get();
            ed.st.borrow_mut().gutter_row(row)
        })
    };
    let lh = {
        let ed = ed.clone();
        move || {
            ed.text_rev.get();
            ed.st.borrow().line_height()
        }
    };
    let lh2 = lh.clone();
    let press_ed = ed.clone();
    let fold_ed = ed.clone();
    view()
        .absolute()
        .left_0()
        .right_0()
        .top(move || Length::from(lh() * row as f32))
        .h(move || Length::from(lh2()))
        .flex_row()
        .items_center()
        .child(when(
            move || props.line_numbers.get(),
            move || {
                let info = info;
                let number = move || info.get().number.map(|n| n.to_string()).unwrap_or_default();
                let ed = press_ed.clone();
                let number_width = number_width.clone();
                // The row's number changes with each edit above it: the
                // text follows it, the element is made again only for
                // another part.
                let active = computed(move || info.get().active);
                dynamic(move || {
                    let active = active.get();
                    let el = text(number)
                        .w(Length::from(number_width()))
                        .text_right()
                        .text_color(move || {
                            if active {
                                theme().foreground
                            } else {
                                theme().muted_foreground
                            }
                        })
                        .on_press({
                            let ed = ed.clone();
                            move || ed.line_number_press(row)
                        });
                    if active {
                        parts(
                            el,
                            props,
                            &[EditorPart::LineNumber, EditorPart::ActiveLineNumber],
                        )
                    } else {
                        part(el, props, EditorPart::LineNumber)
                    }
                })
            },
        ))
        .child(when(
            move || props.folding.get(),
            move || {
                let ed = fold_ed.clone();
                let width = fold_width.clone();
                let fold = computed(move || info.get().fold);
                dynamic(move || {
                    let fold = fold.get();
                    let ed = ed.clone();
                    let size = width();
                    let el = view()
                        .w(Length::from(size))
                        .h(Length::from(size))
                        .items_center()
                        .justify_center()
                        .when_some(fold, |v, folded| {
                            let hovered = theme().foreground.opacity(0.08);
                            let pressed = theme().foreground.opacity(0.14);
                            // A ghost button smaller than the line, so
                            // markers on lines next to each other stay apart.
                            let button = (size * 0.7).round();
                            v.child(
                                view()
                                    .w(Length::from(button))
                                    .h(Length::from(button))
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(3.0))
                                    .bg(move || {
                                        if pointer.pressed.get() == Some(row) {
                                            pressed
                                        } else if pointer.hover.get() == Some(row) {
                                            hovered
                                        } else {
                                            AdaptiveColor::TRANSPARENT
                                        }
                                    })
                                    .on_press(move || {
                                        let line = ed.st.borrow().display.row(row).line;
                                        ed.fold(line, None);
                                    })
                                    .child(chevron(size, folded)),
                            )
                        });
                    part(el, props, EditorPart::FoldMarker)
                })
            },
        ))
}

/// A fold marker's chevron, `size` the marker's: two sides of a square
/// turned to point down (open) or right (folded), drawn rather than a
/// glyph so it sits in the middle of the line in every font.
fn chevron(size: Points, folded: bool) -> impl IntoElement {
    let side = (size * 0.3).round();
    // The turned square's corner points one way: half its diagonal is
    // empty on the other side, so it moves back to look centered.
    let shift = px(-(side.0 * std::f32::consts::SQRT_2 / 4.0).round());
    let el = view()
        .w(Length::from(side))
        .h(Length::from(side))
        .border_r(px(1.5))
        .border_b(px(1.5))
        .border_color(move || theme().muted_foreground);
    if folded {
        el.rotate(Radians(-std::f32::consts::FRAC_PI_4))
            .translate_x(shift)
    } else {
        el.rotate(Radians(std::f32::consts::FRAC_PI_4))
            .translate_y(shift)
    }
}

/// The display rows to make, as a list `each` keeps rows of.
fn visible_rows(ed: Ed) -> Memo<Vec<usize>> {
    computed(move || {
        ed.text_rev.get();
        ed.visible_rows().collect()
    })
}

/// The height of the rows' box: every row, and a screen more past the end
/// when the text scrolls beyond its last line.
fn rows_height(ed: &Ed) -> Points {
    ed.text_rev.get();
    let (content, lh) = {
        let st = ed.st.borrow();
        (st.content_size().height, st.line_height())
    };
    // An editor growing with its text has no room past it.
    let grows = ed.props.min_rows.get().is_some() || ed.props.max_rows.get().is_some();
    let beyond = if grows {
        px(0.0)
    } else {
        let beyond = ed.props.scroll_beyond_last_line.get();
        beyond.room(ed.viewport.get().height, lh)
    };
    content.max(lh) + beyond
}

/// The height of an editor growing with its text (`minRows` /
/// `maxRows`): its rows within their bounds, and the room its parts' padding
/// takes around them; `None` when the app sizes it.
fn grow_height(ed: &Ed) -> Option<Points> {
    let (min, max) = (ed.props.min_rows.get(), ed.props.max_rows.get());
    if min.is_none() && max.is_none() {
        return None;
    }
    ed.text_rev.get();
    let (rows, lh) = {
        let st = ed.st.borrow();
        (st.display.row_count(), st.line_height())
    };
    let rows_h = super::layout::grow_height(rows, lh, min, max)?;
    // What the content holds besides the rows (the parts' padding), as
    // last laid out.
    let padding = (ed.content_height.get() - rows_height(ed)).max(px(0.0));
    Some(rows_h + padding)
}

/// The text area: the rows' box, in a horizontal scroll view unless lines
/// wrap.
fn text_area(ed: Ed, lh: impl Fn() -> Points + Clone + 'static, layer: Layer) -> impl IntoElement {
    let props = ed.props;
    let wrap = move || props.soft_wrap.get();
    let a = ed.clone();
    let b = ed.clone();
    let c = lh.clone();
    when(wrap, move || {
        let ed = a.clone();
        part(view().flex_1().pl(px(4.0)), props, EditorPart::Content).child(rows_box(
            ed,
            c.clone(),
            layer,
        ))
    })
    .otherwise(move || {
        let ed = b.clone();
        if layer == Layer::Paint {
            // The horizontal scroll view's content, where it scrolled to.
            let (x_ed, h_ed) = (ed.clone(), ed.clone());
            return view()
                .flex_1()
                .relative()
                .overflow_hidden()
                .h(move || Length::from(rows_height(&h_ed)))
                .child(
                    part(
                        view()
                            .absolute()
                            .top_0()
                            .left(move || Length::from(-x_ed.scroll_x.get()))
                            .min_w(relative(1.0))
                            .pl(px(4.0)),
                        props,
                        EditorPart::Content,
                    )
                    .child(rows_box(ed, lh.clone(), layer)),
                )
                .into_element();
        }
        let scroll_ed = ed.clone();
        let layout_ed = ed.clone();
        scroll()
            .horizontal()
            .flex_1()
            .element_ref(&ed.hscroll)
            .on_scroll(move |e: &ScrollEvent| scroll_ed.scroll_x.set(e.offset.x))
            .on_layout(move |bounds: &Bounds<Points>| layout_ed.text_width.set(bounds.size.width))
            .child(
                part(
                    view().min_w(relative(1.0)).pl(px(4.0)),
                    props,
                    EditorPart::Content,
                )
                .child(rows_box(ed, lh.clone(), layer)),
            )
            .into_element()
    })
}

/// The box of the rows and everything drawn over and under them.
fn rows_box(ed: Ed, lh: impl Fn() -> Points + Clone + 'static, layer: Layer) -> impl IntoElement {
    let props = ed.props;
    let width = {
        let ed = ed.clone();
        move || {
            ed.text_rev.get();
            if props.soft_wrap.get() {
                return None;
            }
            let rows = ed.visible_rows();
            let st = ed.st.borrow();
            st.display.measure_rows(rows);
            Some(st.content_size().width)
        }
    };
    let height = {
        let ed = ed.clone();
        move || rows_height(&ed)
    };
    let desktop = is_desktop();
    let down = ed.clone();
    let tap = ed.clone();
    let long = ed.clone();
    let mov = ed.clone();
    let up = ed.clone();
    let end = ed.clone();
    let menu = ed.clone();
    let layout = ed.clone();
    let (hover, hover_end) = (ed.clone(), ed.clone());
    let el = view().relative().h(move || Length::from(height()));
    let el = match layer {
        Layer::Hit => el
            .element_ref(&ed.hooks.rows)
            .cursor(Cursor::Text)
            // A hand over the definition link (the pointer leaving it hides
            // it).
            .style_when(
                {
                    let link = ed.definition.link;
                    move || link.get().is_some()
                },
                |s| s.cursor(Cursor::Pointer),
            )
            .on_layout(move |b: &Bounds<Points>| {
                layout.rows_top.set(b.origin.y);
                layout.rows_left.set(b.origin.x);
                if props.soft_wrap.get_untracked() {
                    layout.text_width.set(b.size.width);
                }
                layout.measure_place();
            }),
        Layer::Paint => el,
    };
    let mut el = el
        .on(EventKind::PressDown, move |p: &EventPayload| {
            if let (true, EventPayload::Press(e)) = (desktop, p) {
                // A Mod-click on the definition link keeps the caret where
                // it is.
                if down.on_definition_link(e.position, e.modifiers, e.clicks) {
                    down.focus();
                } else {
                    down.press(e.position, e.page_position, e.modifiers, e.clicks);
                }
                down.text_press(e.position, e.page_position, e.modifiers, e.clicks);
                down.definition_press(e.position, e.modifiers, e.clicks);
            }
        })
        .on(EventKind::Press, move |p: &EventPayload| {
            if desktop {
                return;
            }
            let EventPayload::Press(e) = p else { return };
            tap.tap(e.position, e.page_position, e.clicks);
            tap.text_press(
                e.position,
                e.page_position,
                Default::default(),
                e.clicks.max(1),
            );
        })
        // A long press selects the word under the finger (touch screens;
        // the mouse drags instead).
        .when(!desktop, |v| {
            v.on(EventKind::LongPress, move |p: &EventPayload| {
                if let EventPayload::Press(e) = p {
                    long.long_press(e.position, e.page_position);
                }
            })
        })
        .on_hover_move(move |e: &HoverEvent| hover.hover_move(e))
        .on_hover_out(move || hover_end.hover_out())
        // The mouse selects as it drags (a finger scrolls): the rows take
        // its touches, which the scroll views around them keep off.
        .claim_touches(TouchClaim::on_start().ask(move |request: &ClaimRequest| {
            if desktop {
                request.claim();
            }
        }))
        .keep_touches(desktop)
        .on_responder_move(move |e: &ResponderEvent| mov.drag_to(e.page))
        .on_responder_release(move |_: &ResponderEvent| up.release())
        .on_responder_terminate(move |_: &ResponderEvent| end.release())
        .on_context_menu(move |e: &ContextMenuEvent| {
            menu.context_menu(e.position, e.page_position)
        });
    el = el.w(move || match width() {
        Some(w) => Length::from(w),
        None => Length::Auto,
    });
    let el = el.min_w(relative(1.0));
    if layer == Layer::Hit {
        // Backgrounds belong to the scroll content, below its native
        // indicators. The paint overlay above it holds the foreground.
        // The selection's handles take touches of their own.
        return el
            .child(active_lines(ed.clone(), lh))
            .child(super::touch::handles(ed))
            .into_element();
    }
    el.child(rulers(ed.clone()))
        .child(indent_guides(ed.clone(), lh.clone()))
        .child(match_rects(ed.clone()))
        .child(selection_rects(ed.clone()))
        .child(bracket_rects(ed.clone()))
        .child(rows(ed.clone(), lh.clone()))
        .child(whitespace_marks(ed.clone()))
        .child(diagnostic_marks(ed.clone()))
        .child(super::definition::link_marks(ed.clone()))
        .child(placeholder(ed.clone()))
        .child(carets(ed.clone(), lh.clone()))
        .child(composition(ed.clone(), lh.clone()))
        .child(super::completion::marks(ed))
        .into_element()
}

/// A rectangle of the rows' box, absolutely placed.
fn rect(b: Bounds<Points>) -> View {
    view()
        .absolute()
        .left(Length::from(b.origin.x))
        .top(Length::from(b.origin.y))
        .w(Length::from(b.size.width))
        .h(Length::from(b.size.height))
        .pointer_events(PointerEvents::None)
}

/// The backgrounds of the active lines' rows.
fn active_lines(ed: Ed, lh: impl Fn() -> Points + Clone + 'static) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        if !props.active_line.get() {
            return Vec::new();
        }
        ed.text_rev.get();
        ed.sel_rev.get();
        let rows = ed.visible_rows();
        let active = ed.st.borrow().active_rows(rows);
        let lh = lh();
        active
            .into_iter()
            .map(|row| {
                part(
                    view()
                        .absolute()
                        .left_0()
                        .right_0()
                        .top(Length::from(lh * row as f32))
                        .h(Length::from(lh))
                        .pointer_events(PointerEvents::None)
                        .bg(move || theme().muted.opacity(0.6)),
                    props,
                    EditorPart::ActiveLine,
                )
            })
            .collect::<Vec<_>>()
    })
}

/// The indent guides of the rows in view.
fn indent_guides(ed: Ed, lh: impl Fn() -> Points + Clone + 'static) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        if !props.indent_guides.get() {
            return Vec::new();
        }
        ed.text_rev.get();
        let rows = ed.visible_rows();
        let guides = ed.st.borrow().indent_guides(rows);
        let lh = lh();
        guides
            .into_iter()
            .map(|(x, rows)| {
                part(
                    rect(Bounds::new(
                        Point::new(x, lh * rows.start as f32),
                        Size::new(px(1.0), lh * rows.len() as f32),
                    ))
                    .bg(move || theme().border),
                    props,
                    EditorPart::IndentGuide,
                )
            })
            .collect::<Vec<_>>()
    })
}

/// The search's matches in view.
fn match_rects(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        ed.text_rev.get();
        ed.marks_rev.get();
        ed.sel_rev.get();
        let rows = ed.visible_rows();
        let rects = ed.st.borrow().match_rects(rows);
        rects
            .into_iter()
            .map(|(b, current)| {
                let el = rect(b).bg(move || MATCH.opacity(if current { 0.55 } else { 0.25 }));
                if current {
                    parts(
                        el,
                        props,
                        &[EditorPart::SearchMatch, EditorPart::CurrentSearchMatch],
                    )
                } else {
                    part(el, props, EditorPart::SearchMatch)
                }
            })
            .collect::<Vec<_>>()
    })
}

/// The selections in view.
fn selection_rects(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        ed.text_rev.get();
        ed.sel_rev.get();
        let rows = ed.visible_rows();
        let rects = ed.st.borrow().selection_rects(rows);
        rects
            .into_iter()
            .map(|b| {
                part(
                    rect(b).bg(move || theme().selection()),
                    props,
                    EditorPart::Selection,
                )
            })
            .collect::<Vec<_>>()
    })
}

/// The bracket at the caret and its partner.
fn bracket_rects(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        ed.text_rev.get();
        ed.sel_rev.get();
        if !ed.focused.get() {
            return Vec::new();
        }
        let rows = ed.visible_rows();
        let rects = ed.st.borrow().bracket_rects(rows);
        rects
            .into_iter()
            .map(|b| {
                part(
                    rect(b)
                        .border_1()
                        .border_color(move || theme().muted_foreground.opacity(0.6)),
                    props,
                    EditorPart::MatchingBracket,
                )
            })
            .collect::<Vec<_>>()
    })
}

/// The rows of text in view.
fn rows(ed: Ed, lh: impl Fn() -> Points + Clone + 'static) -> impl IntoElement {
    let list = visible_rows(ed.clone());
    each(
        list,
        |row: &usize| *row,
        move |row, _| row_view(ed.clone(), row.get_untracked(), lh.clone()),
    )
}

/// Display row `row`.
fn row_view(ed: Ed, row: usize, lh: impl Fn() -> Points + Clone + 'static) -> impl IntoElement {
    let props = ed.props;
    let content = {
        let ed = ed.clone();
        computed(move || {
            ed.text_rev.get();
            ed.hl_rev.get();
            ed.marks_rev.get();
            ed.st.borrow().row_content(row)
        })
    };
    let indent = {
        let ed = ed.clone();
        move || {
            ed.text_rev.get();
            let st = ed.st.borrow();
            if row < st.display.row_count() {
                st.display.row(row).indent
            } else {
                px(0.0)
            }
        }
    };
    let lh2 = lh.clone();
    let line_ed = ed.clone();
    let line = part(
        view()
            .absolute()
            .left_0()
            .right_0()
            .top(move || Length::from(lh() * row as f32))
            .h(move || Length::from(lh2()))
            .pointer_events(PointerEvents::None),
        props,
        EditorPart::Line,
    );
    // The line backgrounds of the decorations over the row.
    let line = line
        .app_class(move || {
            let st = line_ed.st.borrow();
            let classes: Vec<String> = content
                .with(|c| c.line_decorations.clone())
                .into_iter()
                .filter_map(|i| {
                    st.decoration_items
                        .get(i)
                        .and_then(|d| d.line_class.clone())
                })
                .map(|c| c.to_string())
                .collect();
            (!classes.is_empty()).then(|| SharedString::from(classes.join(" ")))
        })
        .inline_style({
            let ed = ed.clone();
            move || {
                let st = ed.st.borrow();
                let styles: Vec<Style> = content
                    .with(|c| c.line_decorations.clone())
                    .into_iter()
                    .filter_map(|i| {
                        st.decoration_items
                            .get(i)
                            .and_then(|d| d.line_style.clone())
                    })
                    .collect();
                Style::from_decls(styles.iter().flat_map(|s| s.decls().iter().cloned()))
            }
        });
    let span_ed = ed.clone();
    line.child(
        text("")
            .absolute()
            .top_0()
            .left(move || Length::from(indent()))
            .pointer_events(PointerEvents::Auto)
            .child(dynamic(move || spans(span_ed.clone(), row, content.get()))),
    )
}

/// The spans of a row's content.
fn spans(ed: Ed, row: usize, content: RowContent) -> Vec<AnyElement> {
    let props = ed.props;
    let mut out: Vec<AnyElement> = Vec::with_capacity(content.spans.len() + 1);
    {
        let st = ed.st.borrow();
        for span in content.spans {
            let mut el = text(span.text);
            if let Some(token) = span.token {
                *el.style() = token.style();
            }
            let tags = span.tags;
            if tags.unnecessary {
                el = el.text_color(move || theme().muted_foreground);
            }
            if tags.deprecated {
                el = el.line_through();
            }
            if let Some(severity) = tags.severity {
                let (color, _) = severity_look(severity);
                // `line_through` and `underline` are one decoration: both
                // lines, in the mark's color.
                el = if tags.deprecated {
                    el.underline().line_through()
                } else {
                    el.underline()
                }
                .text_decoration_wavy()
                .text_decoration_color(color)
                .text_decoration_thickness(px(MARK_HEIGHT));
            }
            let classes: Vec<String> = span
                .decorations
                .iter()
                .filter_map(|i| st.decoration_items.get(*i).and_then(|d| d.class.clone()))
                .map(|c| c.to_string())
                .collect();
            let styles: Vec<Style> = span
                .decorations
                .iter()
                .filter_map(|i| st.decoration_items.get(*i).and_then(|d| d.style.clone()))
                .collect();
            if tags.is_empty() {
                if !classes.is_empty() {
                    el = el.app_class(Some(SharedString::from(classes.join(" "))));
                }
                if !styles.is_empty() {
                    el = el.inline_style(Style::from_decls(
                        styles.iter().flat_map(|s| s.decls().iter().cloned()),
                    ));
                }
            } else {
                el = tagged(el, props, tags, classes, styles);
            }
            out.push(el.into_element());
        }
    }
    if content.folded {
        let ed = ed.clone();
        let placeholder = text(" ⋯ ")
            .text_color(move || theme().muted_foreground)
            .on_press(move || {
                let line = ed.st.borrow().display.row(row).line;
                ed.fold(line, Some(false));
            });
        out.push(part(placeholder, props, EditorPart::FoldPlaceholder).into_element());
    }
    out
}

/// Span `el` under tagged diagnostics: the classes and styles of the
/// tags' parts, then its decorations' (`classes`, `styles`), which are
/// about this range alone.
fn tagged(
    el: Text,
    props: EditorProps,
    tags: SpanTags,
    classes: Vec<String>,
    styles: Vec<Style>,
) -> Text {
    let list: Vec<EditorPart> = tags
        .severity
        .map(|s| severity_look(s).1)
        .into_iter()
        .chain(tags.unnecessary.then_some(EditorPart::UnnecessaryText))
        .chain(tags.deprecated.then_some(EditorPart::DeprecatedText))
        .collect();
    let style_list = list.clone();
    let classes = classes.join(" ");
    el.app_class(move || {
        props.classes.with(|c| {
            let joined: Vec<&str> = list
                .iter()
                .filter_map(|p| c.get(*p).map(|s| s.as_str()))
                .chain((!classes.is_empty()).then_some(classes.as_str()))
                .collect();
            (!joined.is_empty()).then(|| SharedString::from(joined.join(" ")))
        })
    })
    .inline_style(move || {
        props.styles.with(|s| {
            Style::from_decls(
                style_list
                    .iter()
                    .filter_map(|p| s.get(*p))
                    .chain(styles.iter())
                    .flat_map(|s| s.decls().iter().cloned()),
            )
        })
    })
}

/// A severity's color and part.
fn severity_look(severity: EditorDiagnosticSeverity) -> (fn() -> AdaptiveColor, EditorPart) {
    match severity {
        EditorDiagnosticSeverity::Error => (|| theme().destructive, EditorPart::DiagnosticError),
        EditorDiagnosticSeverity::Warning => (|| WARNING, EditorPart::DiagnosticWarning),
        EditorDiagnosticSeverity::Info => (|| INFO, EditorPart::DiagnosticInfo),
        EditorDiagnosticSeverity::Hint => (|| theme().muted_foreground, EditorPart::DiagnosticHint),
    }
}

/// The marks in view of the diagnostics on empty lines (the others
/// underline their text).
fn diagnostic_marks(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        ed.text_rev.get();
        ed.marks_rev.get();
        let rows = ed.visible_rows();
        let marks = ed.st.borrow().diagnostic_rects(rows);
        marks
            .into_iter()
            .map(|(b, severity)| {
                let bar = Bounds::new(
                    Point::new(b.origin.x, b.origin.y + b.size.height - px(MARK_HEIGHT)),
                    Size::new(b.size.width, px(MARK_HEIGHT)),
                );
                let (color, which) = severity_look(severity);
                part(rect(bar).bg(color), props, which)
            })
            .collect::<Vec<_>>()
    })
}

/// The placeholder, while the text is empty.
fn placeholder(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        ed.text_rev.get();
        let empty = ed.st.borrow().buffer.is_empty();
        let text_ = props.placeholder.get()?;
        if !empty {
            return None;
        }
        Some(part(
            text(text_.to_string())
                .absolute()
                .top_0()
                .left_0()
                .pointer_events(PointerEvents::None)
                .text_color(move || theme().muted_foreground),
            props,
            EditorPart::Placeholder,
        ))
    })
}

/// The carets in view, blinking while the editor has the focus.
fn carets(ed: Ed, lh: impl Fn() -> Points + Clone + 'static) -> impl IntoElement {
    let props = ed.props;
    let blink = ed.blink;
    let focused = ed.focused;
    dynamic(move || {
        ed.text_rev.get();
        ed.sel_rev.get();
        let rows = ed.visible_rows();
        let (points, composing) = {
            let st = ed.st.borrow();
            (st.caret_points(rows), st.composition.is_some())
        };
        if composing {
            return Vec::new();
        }
        let lh = lh();
        points
            .into_iter()
            .map(|p| {
                part(
                    rect(Bounds::new(
                        Point::new(p.x - px(CARET_WIDTH / 2.0), p.y),
                        Size::new(px(CARET_WIDTH), lh),
                    ))
                    .bg(move || theme().foreground)
                    .opacity(move || {
                        if focused.get() && blink.get() {
                            1.0_f32
                        } else {
                            0.0
                        }
                    }),
                    props,
                    EditorPart::Caret,
                )
            })
            .collect::<Vec<_>>()
    })
}

/// What an input method is composing, drawn at the primary caret over the
/// text.
fn composition(ed: Ed, lh: impl Fn() -> Points + Clone + 'static) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        ed.sel_rev.get();
        ed.text_rev.get();
        let (text_, at) = {
            let st = ed.st.borrow();
            let text_ = st.composition.clone()?;
            (text_, st.caret_point(st.primary_head()))
        };
        Some(part(
            text(text_)
                .absolute()
                .left(Length::from(at.x))
                .top(Length::from(at.y))
                .h(Length::from(lh()))
                .pointer_events(PointerEvents::None)
                .bg(move || theme().background)
                .underline(),
            props,
            EditorPart::Composition,
        ))
    })
}

/// The native input that takes typed text and input methods, kept at the
/// primary caret (where the input method's candidates open), invisible.
/// It lies over the scroll views, not in them, and inside the editor's box:
/// the platforms scroll a focused field into view, which the editor does
/// itself for its caret, and would scroll the text from under it.
fn sink(ed: Ed, lh: impl Fn() -> Points + Clone + 'static) -> impl IntoElement {
    let at = {
        let ed = ed.clone();
        let lh = lh.clone();
        computed(move || {
            ed.text_rev.get();
            ed.sel_rev.get();
            let caret = {
                let st = ed.st.borrow();
                st.caret_point(st.primary_head())
            };
            let at = ed.in_editor(caret);
            let size = ed.viewport.get();
            Point::new(
                at.x.min(size.width - px(1.0)).max(px(0.0)),
                at.y.min(size.height - lh()).max(px(0.0)),
            )
        })
    };
    let props = ed.props;
    let (change, composition, key, paste, focus, blur) = (
        ed.clone(),
        ed.clone(),
        ed.clone(),
        ed.clone(),
        ed.clone(),
        ed.clone(),
    );
    let value = ed.sink_value;
    input()
        .element_ref(&ed.input)
        .absolute()
        .left(move || Length::from(at.get().x))
        .top(move || Length::from(at.get().y))
        .w(px(1.0))
        .h(move || Length::from(lh()))
        // Presses at the caret are the rows' (a click there places it).
        .pointer_events(PointerEvents::None)
        .p_0()
        .border(px(0.0))
        .bg(AdaptiveColor::TRANSPARENT)
        .text_color(AdaptiveColor::TRANSPARENT)
        .caret(false)
        .multiline(true)
        .auto_correct(false)
        .auto_capitalize(AutoCapitalize::None)
        .paste_behavior(PasteBehavior::Report)
        .value(move || value.get())
        .label(move || props.accessibility_label.get().unwrap_or_default())
        .on_change(move |text: &str| change.sink_changed(text))
        .on_composition_change(move |c: &Composition| composition.composition(c.composing, &c.text))
        .on_key_press(move |k: &str| key.sink_key(k))
        .on_paste(move |p: &PasteEvent| paste.paste(&p.text))
        .on_focus(move || focus.focus_changed(true))
        .on_blur(move || blur.focus_changed(false))
}

/// The lines of `rulers`, the rows' box's height.
fn rulers(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        let columns = props.rulers.get();
        if columns.is_empty() {
            return Vec::new();
        }
        ed.text_rev.get();
        let xs = ed.st.borrow().ruler_xs(&columns);
        xs.into_iter()
            .map(|x| {
                part(
                    view()
                        .absolute()
                        .top_0()
                        .bottom_0()
                        .left(Length::from(x))
                        .w(px(1.0))
                        .pointer_events(PointerEvents::None)
                        .bg(move || theme().border),
                    props,
                    EditorPart::Ruler,
                )
            })
            .collect::<Vec<_>>()
    })
}

/// The marks of the spaces and tabs in view, while `showWhitespaces` is
/// set.
fn whitespace_marks(ed: Ed) -> impl IntoElement {
    let props = ed.props;
    dynamic(move || {
        if !props.show_whitespaces.get() {
            return Vec::new();
        }
        ed.text_rev.get();
        let rows = ed.visible_rows();
        let marks = ed.st.borrow().whitespace_marks(rows);
        marks
            .into_iter()
            .map(|(b, mark)| {
                part(
                    text(mark)
                        .absolute()
                        .left(Length::from(b.origin.x))
                        .top(Length::from(b.origin.y))
                        .w(Length::from(b.size.width))
                        .h(Length::from(b.size.height))
                        .number_of_lines(1)
                        .overflow_hidden()
                        .pointer_events(PointerEvents::None)
                        .text_color(move || theme().muted_foreground.opacity(0.6)),
                    props,
                    EditorPart::Whitespace,
                )
            })
            .collect::<Vec<_>>()
    })
}

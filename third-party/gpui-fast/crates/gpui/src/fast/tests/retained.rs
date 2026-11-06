//! Tests of views drawn again from what they drew on the last frame. See
//! [`crate::fast::retained`].

use crate::{
    AppContext as _, Context, Entity, InteractiveElement as _, IntoElement, ParentElement as _,
    Render, StyleRefinement, Styled as _, TestAppContext, Window, WindowHandle, div,
    prelude::FluentBuilder as _, px,
};
use std::{cell::Cell, rc::Rc};

struct Row {
    label: u32,
    builds: Rc<Cell<usize>>,
}

impl Render for Row {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        div()
            .size_full()
            .bg(crate::black())
            .hover(|style| style.bg(crate::white()))
            .child(format!("row {}", self.label))
    }
}

struct Rows {
    row: Entity<Row>,
    covered: bool,
}

impl Render for Rows {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .relative()
            .size(px(300.))
            .child(
                self.row
                    .clone()
                    .cached(StyleRefinement::default().w(px(100.)).h(px(20.))),
            )
            .when(self.covered, |this| {
                this.child(div().absolute().top_0().left_0().size(px(200.)).occlude())
            })
    }
}

fn window(cx: &mut TestAppContext) -> (WindowHandle<Rows>, Entity<Row>, Rc<Cell<usize>>) {
    let builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let builds = builds.clone();
        move |_, cx| Rows {
            row: cx.new(|_| Row { label: 0, builds }),
            covered: false,
        }
    });
    let row = window.update(cx, |rows, _, _| rows.row.clone()).unwrap();
    (window, row, builds)
}

fn draw(cx: &mut TestAppContext, window: WindowHandle<Rows>) -> Vec<String> {
    cx.update_window(window.into(), |_, window, cx| {
        window.draw(cx).clear(cx);
        window.describe_rendered_frame()
    })
    .unwrap()
}

fn notify_parent(cx: &mut TestAppContext, window: WindowHandle<Rows>) {
    window.update(cx, |_, _, cx| cx.notify()).unwrap();
}

fn move_mouse(cx: &mut TestAppContext, window: WindowHandle<Rows>, x: f32, y: f32) {
    cx.update_window(window.into(), |_, window, cx| {
        window.simulate_mouse_move(crate::point(px(x), px(y)), cx);
    })
    .unwrap();
}

/// A cached view painted while the pointer was over something in it that
/// has a hover style is rendered again once the pointer leaves, even
/// though the element never saw the pointer arrive.
#[test]
fn a_cached_view_is_rendered_again_when_a_hover_it_was_painted_by_changes() {
    let mut cx = TestAppContext::single();
    let (window, _, builds) = window(&mut cx);
    move_mouse(&mut cx, window, 10., 10.);
    let hovered = draw(&mut cx, window);
    notify_parent(&mut cx, window);
    draw(&mut cx, window);
    let builds_before = builds.get();

    move_mouse(&mut cx, window, 250., 250.);
    let left = draw(&mut cx, window);
    assert_eq!(builds.get(), builds_before + 1);
    assert_ne!(hovered, left);
}

/// A cached view reused for a while keeps the layout nodes it was laid
/// out with, so rendering it again finds them all.
#[test]
fn a_reused_cached_view_keeps_its_layout_nodes() {
    let mut cx = TestAppContext::single();
    let (window, row, builds) = window(&mut cx);
    draw(&mut cx, window);
    for _ in 0..3 {
        notify_parent(&mut cx, window);
        draw(&mut cx, window);
    }
    assert_eq!(
        builds.get(),
        1,
        "the view is reused while its parent renders"
    );

    cx.update_window(window.into(), |_, window, _| window.reset_layout_stats())
        .unwrap();
    row.update(&mut cx, |row, cx| {
        row.label = 7;
        cx.notify();
    });
    draw(&mut cx, window);
    assert_eq!(builds.get(), 2);
    let stats = cx
        .update_window(window.into(), |_, window, _| window.layout_stats())
        .unwrap();
    assert_eq!(
        stats.nodes_created, 0,
        "the view's nodes should have been kept while it was reused"
    );
    assert!(stats.nodes_reused > 0);
}

/// Something drawn over a hovered cached view is found out only when the
/// view paints; it is rendered on the next frame, which is asked for.
#[test]
fn a_cached_view_covered_while_hovered_is_rendered_on_the_next_frame() {
    let mut cx = TestAppContext::single();
    let (window, _, builds) = window(&mut cx);
    move_mouse(&mut cx, window, 10., 10.);
    let hovered = draw(&mut cx, window);
    notify_parent(&mut cx, window);
    draw(&mut cx, window);
    let builds_before = builds.get();

    window
        .update(&mut cx, |rows, _, cx| {
            rows.covered = true;
            cx.notify();
        })
        .unwrap();
    let frame_asked_for = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, _| {
            !window.next_frame_callbacks.borrow().is_empty()
        })
        .unwrap()
    };
    let mut asked_for_a_frame = frame_asked_for(&mut cx);
    let mut look = None;
    for _ in 0..3 {
        if builds.get() > builds_before {
            break;
        }
        asked_for_a_frame |= frame_asked_for(&mut cx);
        look = Some(draw(&mut cx, window));
    }
    assert_eq!(builds.get(), builds_before + 1);
    assert!(
        asked_for_a_frame,
        "a frame should be asked for to render it"
    );
    assert_ne!(Some(hovered), look);
}

struct Counted {
    label: usize,
    model: Option<Entity<Model>>,
    builds: Rc<Cell<usize>>,
}

struct Model(usize);

impl Render for Counted {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let model = self.model.as_ref().map_or(0, |model| model.read(cx).0);
        div()
            .flex()
            .flex_row()
            .child(format!("{} {}", self.label, model))
    }
}

struct Siblings {
    first: Entity<Counted>,
    second: Entity<Counted>,
    spacer: f32,
}

impl Render for Siblings {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .child(div().h(px(self.spacer)))
            .child(self.first.clone())
            .child(self.second.clone())
    }
}

struct SiblingsWindow {
    window: WindowHandle<Siblings>,
    first: Entity<Counted>,
    model: Entity<Model>,
    first_builds: Rc<Cell<usize>>,
    second_builds: Rc<Cell<usize>>,
}

fn siblings(cx: &mut TestAppContext) -> SiblingsWindow {
    let first_builds = Rc::new(Cell::new(0));
    let second_builds = Rc::new(Cell::new(0));
    let model = cx.new(|_| Model(0));
    let window = cx.add_window({
        let (first_builds, second_builds, model) =
            (first_builds.clone(), second_builds.clone(), model.clone());
        move |_, cx| Siblings {
            first: cx.new(|_| Counted {
                label: 1,
                model: None,
                builds: first_builds,
            }),
            second: cx.new(|_| Counted {
                label: 2,
                model: Some(model),
                builds: second_builds,
            }),
            spacer: 10.,
        }
    });
    let first = window.update(cx, |view, _, _| view.first.clone()).unwrap();
    SiblingsWindow {
        window,
        first,
        model,
        first_builds,
        second_builds,
    }
}

fn draw_siblings(cx: &mut TestAppContext, window: WindowHandle<Siblings>) -> Vec<String> {
    cx.update_window(window.into(), |_, window, cx| {
        window.draw(cx).clear(cx);
        window.describe_rendered_frame()
    })
    .unwrap()
}

/// A view that is not cached is drawn again from the
/// last frame while nothing it read changed, even when the view around it
/// is rendered again, and rendered again once something it read did.
#[test]
fn a_view_is_rendered_again_only_when_something_it_read_changed() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (1, 1));

    s.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    draw_siblings(&mut cx, s.window);
    assert_eq!(
        (s.first_builds.get(), s.second_builds.get()),
        (1, 1),
        "notifying the parent leaves its children alone"
    );

    s.first.update(&mut cx, |first, cx| {
        first.label = 3;
        cx.notify();
    });
    draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (2, 1));

    s.model.update(&mut cx, |model, cx| {
        model.0 = 5;
        cx.notify();
    });
    draw_siblings(&mut cx, s.window);
    assert_eq!(
        (s.first_builds.get(), s.second_builds.get()),
        (2, 2),
        "a model the view read changing renders it again, unobserved"
    );

    cx.update_window(s.window.into(), |_, window, _| window.refresh())
        .unwrap();
    draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (3, 3));
}

/// A view that moved is built again where it went, at the layout nodes it
/// kept, and draws what a window drawing from scratch draws.
#[test]
fn a_moved_view_is_built_again_at_its_layout() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    draw_siblings(&mut cx, s.window);
    s.window
        .update(&mut cx, |view, _, cx| {
            view.spacer = 30.;
            cx.notify();
        })
        .unwrap();
    cx.update_window(s.window.into(), |_, window, _| window.reset_layout_stats())
        .unwrap();
    let moved = draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (2, 2));
    let stats = cx
        .update_window(s.window.into(), |_, window, _| window.layout_stats())
        .unwrap();
    assert_eq!(stats.nodes_created, 0, "the moved views keep their nodes");

    cx.update_window(s.window.into(), |_, window, _| {
        window.forget_retained_state()
    })
    .unwrap();
    assert_eq!(moved, draw_siblings(&mut cx, s.window));
}

/// With retention turned off, every view is rendered every frame.
#[test]
fn views_are_rendered_every_frame_without_retention() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    cx.update_window(s.window.into(), |_, window, _| {
        window.set_view_retention(false)
    })
    .unwrap();
    draw_siblings(&mut cx, s.window);
    let before = (s.first_builds.get(), s.second_builds.get());
    s.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    draw_siblings(&mut cx, s.window);
    assert!(s.first_builds.get() > before.0 && s.second_builds.get() > before.1);
}

struct Sized {
    row: Entity<Row>,
    width: f32,
}

impl Render for Sized {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().child(
            self.row
                .clone()
                .cached(StyleRefinement::default().w(px(self.width)).h(px(20.))),
        )
    }
}

/// A cached view is rendered again when its bounds change or the window is
/// refreshed, and otherwise reused, showing what it showed.
#[test]
fn a_cached_view_is_rendered_again_only_when_it_has_to_be() {
    let mut cx = TestAppContext::single();
    let builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let builds = builds.clone();
        move |_, cx| Sized {
            row: cx.new(|_| Row { label: 0, builds }),
            width: 100.,
        }
    });
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    let change = |cx: &mut TestAppContext, f: fn(&mut Sized)| {
        window
            .update(cx, |view, _, cx| {
                f(view);
                cx.notify();
            })
            .unwrap()
    };

    let first = draw(&mut cx);
    assert_eq!(builds.get(), 1);
    change(&mut cx, |_| {});
    assert_eq!(first, draw(&mut cx), "a reused view shows what it showed");
    assert_eq!(builds.get(), 1);

    change(&mut cx, |view| view.width = 150.);
    draw(&mut cx);
    assert_eq!(builds.get(), 2, "new bounds render it again");

    cx.update_window(window.into(), |_, window, _| window.refresh())
        .unwrap();
    draw(&mut cx);
    assert_eq!(builds.get(), 3, "a refreshed window renders every view");

    cx.simulate_window_resize(window.into(), crate::size(px(800.), px(600.)));
    draw(&mut cx);
    change(&mut cx, |_| {});
    draw(&mut cx);
    assert_eq!(
        builds.get(),
        4,
        "a resize refreshes once, then it is reused"
    );
}

struct PopoverRow {
    builds: Rc<Cell<usize>>,
}

impl Render for PopoverRow {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        div().size_full().child(crate::deferred(
            div()
                .id("popover")
                .w(px(50.))
                .h(px(20.))
                .bg(crate::black())
                .hover(|style| style.bg(crate::white())),
        ))
    }
}

struct WithPopover {
    row: Entity<PopoverRow>,
}

impl Render for WithPopover {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().child(
            self.row
                .clone()
                .cached(StyleRefinement::default().w(px(100.)).h(px(20.))),
        )
    }
}

/// Something a cached view draws deferred, such as a popover, is prepainted
/// and painted after the view, but is part of what the view drew: the pointer
/// moving over it changes how the view looks.
#[test]
fn a_cached_view_is_rendered_again_when_the_pointer_moves_over_what_it_deferred() {
    let mut cx = TestAppContext::single();
    let builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let builds = builds.clone();
        move |_, cx| WithPopover {
            row: cx.new(|_| PopoverRow { builds }),
        }
    });
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    let move_to = |cx: &mut TestAppContext, x: f32, y: f32| {
        cx.update_window(window.into(), |_, window, cx| {
            window.simulate_mouse_move(crate::point(px(x), px(y)), cx);
        })
        .unwrap();
    };

    // The pointer starts out at the origin, over the popover.
    draw(&mut cx);
    assert_eq!(builds.get(), 1);
    move_to(&mut cx, 500., 500.);
    let away = draw(&mut cx);
    assert_eq!(
        builds.get(),
        2,
        "the pointer leaving the popover changes its look"
    );
    window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    draw(&mut cx);
    assert_eq!(builds.get(), 2, "and nothing else does");

    move_to(&mut cx, 10., 10.);
    let over = draw(&mut cx);
    assert_eq!(builds.get(), 3, "the pointer coming back changes it again");
    assert_ne!(away, over);

    move_to(&mut cx, 500., 500.);
    let away_again = draw(&mut cx);
    assert_eq!(builds.get(), 4);
    assert_eq!(away, away_again);
}

/// An input handler that answers every question about its text with its
/// name, so a test can tell which one the platform was handed.
struct NamedInput(&'static str, bool);

impl crate::InputHandler for NamedInput {
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<crate::UTF16Selection> {
        None
    }
    fn marked_text_range(
        &mut self,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<std::ops::Range<usize>> {
        self.1.then_some(0..1)
    }
    fn text_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: &mut Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<String> {
        Some(self.0.to_string())
    }
    fn replace_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        _: &str,
        _: &mut Window,
        _: &mut crate::App,
    ) {
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        _: &str,
        _: Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut crate::App,
    ) {
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut crate::App) {}
    fn bounds_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<crate::Bounds<crate::Pixels>> {
        None
    }
    fn character_index_for_point(
        &mut self,
        _: crate::Point<crate::Pixels>,
        _: &mut Window,
        _: &mut crate::App,
    ) -> Option<usize> {
        None
    }
}

pub(super) fn text_input(focus: crate::FocusHandle, name: &'static str) -> impl IntoElement {
    crate::canvas(
        |_, _, _| {},
        move |_, _, window, cx| window.handle_input(&focus, NamedInput(name, false), cx),
    )
    .size_full()
}

struct Field {
    focus: crate::FocusHandle,
    builds: Rc<Cell<usize>>,
}

impl Render for Field {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        text_input(self.focus.clone(), "inside")
    }
}

struct Inputs {
    field: Entity<Field>,
    outside: crate::FocusHandle,
    cached_first: bool,
}

impl Render for Inputs {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let cached = self
            .field
            .clone()
            .cached(StyleRefinement::default().w(px(100.)).h(px(20.)))
            .into_any_element();
        let outside = div()
            .w(px(100.))
            .h(px(20.))
            .child(text_input(self.outside.clone(), "outside"))
            .into_any_element();
        let children = if self.cached_first {
            [cached, outside]
        } else {
            [outside, cached]
        };
        div().children(children)
    }
}

/// The input handler of a focused field inside a reused cached view is
/// handed to the platform on every frame, and a field focused elsewhere
/// takes over.
#[test]
fn a_reused_cached_view_hands_the_platform_its_input_handler() {
    for cached_first in [true, false] {
        let mut cx = TestAppContext::single();
        let builds = Rc::new(Cell::new(0));
        let window = cx.add_window({
            let builds = builds.clone();
            move |_, cx| Inputs {
                field: cx.new(|cx| Field {
                    focus: cx.focus_handle(),
                    builds,
                }),
                outside: cx.focus_handle(),
                cached_first,
            }
        });
        let (inside, outside) = window
            .update(&mut cx, |view, _, cx| {
                (view.field.read(cx).focus.clone(), view.outside.clone())
            })
            .unwrap();
        let draw = |cx: &mut TestAppContext| {
            cx.update_window(window.into(), |_, window, cx| window.draw(cx).clear(cx))
                .unwrap()
        };
        // Asked outside of any update, as the platform asks it.
        let handed = |cx: &mut TestAppContext| {
            let mut handler = cx
                .update_window(window.into(), |_, window, _| {
                    window.platform_window.take_input_handler()
                })
                .unwrap()?;
            let name = handler.text_for_range(0..1, &mut None);
            cx.update_window(window.into(), |_, window, _| {
                window.platform_window.set_input_handler(handler)
            })
            .unwrap();
            name
        };
        let focus = |cx: &mut TestAppContext, handle: &crate::FocusHandle| {
            cx.update_window(window.into(), |_, window, cx| window.focus(handle, cx))
                .unwrap()
        };

        focus(&mut cx, &inside);
        draw(&mut cx);
        assert_eq!(handed(&mut cx).as_deref(), Some("inside"));
        let builds_then = builds.get();
        for _ in 0..3 {
            window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
            draw(&mut cx);
            assert_eq!(handed(&mut cx).as_deref(), Some("inside"));
        }
        assert_eq!(builds.get(), builds_then, "the cached view was reused");

        focus(&mut cx, &outside);
        draw(&mut cx);
        assert_eq!(handed(&mut cx).as_deref(), Some("outside"));
        window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        draw(&mut cx);
        assert_eq!(handed(&mut cx).as_deref(), Some("outside"));

        focus(&mut cx, &inside);
        draw(&mut cx);
        window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        draw(&mut cx);
        assert_eq!(handed(&mut cx).as_deref(), Some("inside"));
    }
}

/// A card whose width comes from the column it sits in, not from its content.
struct Card;

impl Render for Card {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .items_center()
            .child(div().h(px(10.)).bg(crate::black()).child("card"))
    }
}

struct Stretched {
    card: Entity<Card>,
    spacer: f32,
}

impl Render for Stretched {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .w(px(300.))
            .child(div().h(px(self.spacer)))
            .child(self.card.clone())
    }
}

/// A view stretched by the column it is in keeps that width when it moves,
/// as when a scrolled list moves every view in it: it is laid out again at
/// the size its parent gave it, not at the size its content asks for.
#[test]
fn a_moved_view_keeps_the_size_its_parent_gave_it() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, cx| Stretched {
        card: cx.new(|_| Card),
        spacer: 10.,
    });
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    draw(&mut cx);
    window
        .update(&mut cx, |view, _, cx| {
            view.spacer = 30.;
            cx.notify();
        })
        .unwrap();
    let moved = draw(&mut cx);
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(moved, draw(&mut cx));
}

/// A view that read a model updated without being notified is built again
/// when the view around it is, as upstream builds every view under a
/// notified one again: a view often changes a model it renders and notifies
/// only itself.
#[test]
fn a_view_is_rendered_again_when_a_model_it_read_was_updated_without_a_notify() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    draw_siblings(&mut cx, s.window);
    assert_eq!((s.first_builds.get(), s.second_builds.get()), (1, 1));

    s.model.update(&mut cx, |model, _| model.0 = 7);
    s.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    let updated = draw_siblings(&mut cx, s.window);
    assert_eq!(
        (s.first_builds.get(), s.second_builds.get()),
        (1, 2),
        "only the view that read the model is built again"
    );

    s.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    draw_siblings(&mut cx, s.window);
    assert_eq!(
        (s.first_builds.get(), s.second_builds.get()),
        (1, 2),
        "an update is seen once"
    );

    cx.update_window(s.window.into(), |_, window, _| {
        window.forget_retained_state()
    })
    .unwrap();
    assert_eq!(updated, draw_siblings(&mut cx, s.window));
}

/// A view built again keeps the measurements of the text that did not
/// change, rather than measuring and laying it out again. Text that changed
/// is measured again, but leaves its node clean when it measures the same
/// under every constraint Taffy measured it under, and dirties it otherwise.
#[test]
fn text_that_did_not_change_keeps_its_measurement() {
    let mut cx = TestAppContext::single();
    let s = siblings(&mut cx);
    draw_siblings(&mut cx, s.window);
    let stats = |cx: &mut TestAppContext| {
        cx.update_window(s.window.into(), |_, window, _| window.layout_stats())
            .unwrap()
    };
    let reset = |cx: &mut TestAppContext| {
        cx.update_window(s.window.into(), |_, window, _| window.reset_layout_stats())
            .unwrap()
    };

    reset(&mut cx);
    s.window
        .update(&mut cx, |view, _, cx| {
            view.spacer = 30.;
            cx.notify();
        })
        .unwrap();
    draw_siblings(&mut cx, s.window);
    let after_move = stats(&mut cx);
    assert_eq!(
        after_move.measure_rebinds, 0,
        "moved text is not measured again"
    );
    assert_eq!(after_move.measurements_kept, 2);

    reset(&mut cx);
    s.first.update(&mut cx, |first, cx| {
        first.label = 9;
        cx.notify();
    });
    draw_siblings(&mut cx, s.window);
    let after_change = stats(&mut cx);
    assert_eq!(
        (
            after_change.measure_rebinds,
            after_change.measurements_replayed
        ),
        (0, 1),
        "changed text of the same size leaves its node clean"
    );

    reset(&mut cx);
    s.first.update(&mut cx, |first, cx| {
        first.label = 12345;
        cx.notify();
    });
    let changed = draw_siblings(&mut cx, s.window);
    let after_change = stats(&mut cx);
    assert_eq!(
        (
            after_change.measure_rebinds,
            after_change.measurements_replayed
        ),
        (1, 0),
        "changed text of another size is measured again"
    );

    cx.update_window(s.window.into(), |_, window, _| {
        window.forget_retained_state()
    })
    .unwrap();
    assert_eq!(changed, draw_siblings(&mut cx, s.window));
}

/// A view that reads what a nested view holds, as a gallery reads the name of
/// the page it shows.
struct Reader {
    child: Entity<Counted>,
    builds: Rc<Cell<usize>>,
}

impl Render for Reader {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let label = self.child.read(cx).label;
        div()
            .flex()
            .flex_col()
            .child(format!("showing {label}"))
            .child(self.child.clone())
    }
}

/// A view notified without being updated, as a scroll wheel or a dragged
/// scrollbar notifies it, is drawn again on its own: a view that read it is
/// drawn around it from last frame. Once it is updated, what that view read
/// may have changed, and it is built again.
#[test]
fn a_view_that_read_a_notified_view_is_built_again_only_if_it_was_updated() {
    let mut cx = TestAppContext::single();
    let reader_builds = Rc::new(Cell::new(0));
    let child_builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let (reader_builds, child_builds) = (reader_builds.clone(), child_builds.clone());
        move |_, cx| Reader {
            child: cx.new(|_| Counted {
                label: 1,
                model: None,
                builds: child_builds,
            }),
            builds: reader_builds,
        }
    });
    let child = window.read_with(&cx, |view, _| view.child.clone()).unwrap();
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    draw(&mut cx);
    let first = (reader_builds.get(), child_builds.get());

    cx.update(|cx| cx.notify(child.entity_id()));
    draw(&mut cx);
    assert_eq!(
        (reader_builds.get(), child_builds.get()),
        (first.0, first.1 + 1),
        "a notification alone changes nothing the reader read"
    );

    child.update(&mut cx, |child, cx| {
        child.label = 2;
        cx.notify();
    });
    let updated = draw(&mut cx);
    assert_eq!(
        (reader_builds.get(), child_builds.get()),
        (first.0 + 1, first.1 + 2)
    );
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(updated, draw(&mut cx));
}

/// The state of a view a component renders, written by the component as it
/// is rendered, the way a list or tree component hands its item renderer to
/// the view that draws the items.
struct Painter {
    color: crate::Hsla,
}

impl Render for Painter {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(px(40.)).bg(self.color)
    }
}

/// A component that writes what it was given into its view's state, without
/// notifying it, and renders the view.
#[derive(IntoElement)]
struct Paint {
    painter: Entity<Painter>,
    color: crate::Hsla,
}

impl crate::RenderOnce for Paint {
    fn render(self, _: &mut Window, cx: &mut crate::App) -> impl IntoElement {
        let color = self.color;
        self.painter.update(cx, |painter, _| painter.color = color);
        self.painter
    }
}

struct PaintHost {
    painter: Entity<Painter>,
    red: bool,
}

impl Render for PaintHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(px(300.)).child(Paint {
            painter: self.painter.clone(),
            color: if self.red {
                crate::red()
            } else {
                crate::blue()
            },
        })
    }
}

fn backgrounds(cx: &mut TestAppContext, window: crate::AnyWindowHandle) -> Vec<String> {
    cx.update_window(window, |_, window, cx| {
        window.draw(cx).clear(cx);
        window
            .painted_quads()
            .iter()
            .map(|quad| format!("{:?} {:?}", quad.bounds, quad.background))
            .collect()
    })
    .unwrap()
}

/// A view whose state a component wrote while the window drew, as it was
/// rendered, is drawn with what was written: the write changed what the view
/// reads, notified or not.
#[test]
fn a_view_written_while_the_window_draws_is_rendered_again() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, cx| PaintHost {
        painter: cx.new(|_| Painter {
            color: crate::blue(),
        }),
        red: false,
    });
    let blue = backgrounds(&mut cx, window.into());
    assert_eq!(blue, backgrounds(&mut cx, window.into()));

    window
        .update(&mut cx, |host, _, cx| {
            host.red = true;
            cx.notify();
        })
        .unwrap();
    let red = backgrounds(&mut cx, window.into());
    assert_ne!(blue, red, "the painter was drawn with the color written");
    let again = backgrounds(&mut cx, window.into());
    assert_eq!(red, again, "and nothing wrote it since");

    // The host writing its painter as it is built is part of building it:
    // it does not make the host itself out of date.
    let reused = cx
        .update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.draw(cx).clear(cx);
            window.next_frame.retained.reused_any() || window.rendered_frame.retained.reused_any()
        })
        .unwrap();
    assert!(reused, "a frame where nothing changed reuses the views");
}

/// An element of its own that asks whether its hitbox is hovered while it is
/// painted — not a hover style — makes the view it is in depend on the answer.
struct HoverProbe;

impl Render for HoverProbe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(px(300.)).child(
            crate::canvas(
                |bounds, window, _| window.insert_hitbox(bounds, crate::HitboxBehavior::Normal),
                |bounds, hitbox, window, _| {
                    let color = if hitbox.is_hovered(window) {
                        crate::red()
                    } else {
                        crate::blue()
                    };
                    window.paint_quad(crate::fill(bounds, color));
                },
            )
            .size(px(100.)),
        )
    }
}

#[test]
fn a_view_is_rendered_again_when_a_hover_an_element_asked_about_changes() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, _| HoverProbe);
    let move_to = |cx: &mut TestAppContext, x: f32, y: f32| {
        cx.update_window(window.into(), |_, window, cx| {
            window.simulate_mouse_move(crate::point(px(x), px(y)), cx);
        })
        .unwrap();
    };
    move_to(&mut cx, 250., 250.);
    backgrounds(&mut cx, window.into());
    let away = backgrounds(&mut cx, window.into());
    move_to(&mut cx, 10., 10.);
    let over = backgrounds(&mut cx, window.into());
    assert_ne!(
        away, over,
        "the pointer over the element changes how it looks"
    );
    move_to(&mut cx, 250., 250.);
    assert_eq!(away, backgrounds(&mut cx, window.into()));
}

/// A view that reads where the pointer is, or which modifiers are held, as it
/// renders depends on it.
struct PointerProbe;

impl Render for PointerProbe {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let x = window.mouse_position().x;
        let wide = window.modifiers().shift;
        div().size(px(300.)).child(
            div()
                .w(if wide { px(80.) } else { x })
                .h(px(10.))
                .bg(crate::red()),
        )
    }
}

#[test]
fn a_view_that_read_the_pointer_or_modifiers_is_rendered_again_when_they_change() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, _| PointerProbe);
    let at = |cx: &mut TestAppContext, x: f32, modifiers: crate::Modifiers| {
        cx.update_window(window.into(), |_, window, cx| {
            window.dispatch_event(
                crate::PlatformInput::MouseMove(crate::MouseMoveEvent {
                    position: crate::point(px(x), px(5.)),
                    pressed_button: None,
                    modifiers,
                }),
                cx,
            );
        })
        .unwrap();
        backgrounds(cx, window.into())
    };
    let first = at(&mut cx, 20., crate::Modifiers::default());
    let moved = at(&mut cx, 60., crate::Modifiers::default());
    assert_ne!(first, moved, "the view reads where the pointer is");
    let shifted = at(
        &mut cx,
        60.,
        crate::Modifiers {
            shift: true,
            ..Default::default()
        },
    );
    assert_ne!(moved, shifted, "and which modifiers are held");
}

/// A text field that hands the platform its own input handler, and can
/// notify itself once while the window asks it whether it accepts text.
struct TextField {
    focus: crate::FocusHandle,
    notify_when_asked: Cell<bool>,
    builds: Rc<Cell<usize>>,
}

impl Render for TextField {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let (focus, field) = (self.focus.clone(), cx.entity());
        crate::canvas(
            |_, _, _| {},
            move |bounds, _, window, cx| {
                window.handle_input(&focus, crate::ElementInputHandler::new(bounds, field), cx)
            },
        )
        .w(px(100.))
        .h(px(20.))
    }
}

/// Native cleanup may keep its window state alive after the GPUI window closes.
/// Its published input handler must not keep the painted view alive with it.
#[test]
fn closing_a_painted_window_releases_its_input_handler_and_view_before_native_cleanup() {
    let mut cx = TestAppContext::single();
    cx.update(|cx| cx.set_quit_mode(crate::QuitMode::Explicit));
    let released = Rc::new(Cell::new(false));
    let window = cx.add_window(|_, cx| TextField {
        focus: cx.focus_handle(),
        notify_when_asked: Cell::new(false),
        builds: Rc::new(Cell::new(0)),
    });
    let weak = cx
        .update_window(window.into(), |_, window, cx| {
            let field = window.root::<TextField>().unwrap().unwrap();
            cx.observe_release(&field, {
                let released = released.clone();
                move |_, _| released.set(true)
            })
            .detach();
            let focus = field.read(cx).focus.clone();
            window.focus(&focus, cx);
            window.draw(cx).clear(cx);
            field.downgrade()
        })
        .unwrap();
    let mut native = cx.test_window(window.into());
    let handler = crate::PlatformWindow::take_input_handler(&mut native)
        .expect("painting the focused field must publish its input handler");
    crate::PlatformWindow::set_input_handler(&mut native, handler);

    cx.update_window(window.into(), |_, window, _| window.remove_window())
        .unwrap();

    assert!(
        released.get(),
        "closing must release the view before native cleanup"
    );
    assert!(weak.upgrade().is_none());
    assert!(crate::PlatformWindow::take_input_handler(&mut native).is_none());
}

impl crate::EntityInputHandler for TextField {
    fn text_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: &mut Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<String> {
        None
    }
    fn selected_text_range(
        &mut self,
        _: bool,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<crate::UTF16Selection> {
        None
    }
    fn marked_text_range(
        &self,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<std::ops::Range<usize>> {
        None
    }
    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {}
    fn replace_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        _: &str,
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
    }
    fn replace_and_mark_text_in_range(
        &mut self,
        _: Option<std::ops::Range<usize>>,
        _: &str,
        _: Option<std::ops::Range<usize>>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) {
    }
    fn bounds_for_range(
        &mut self,
        _: std::ops::Range<usize>,
        _: crate::Bounds<crate::Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<crate::Bounds<crate::Pixels>> {
        None
    }
    fn character_index_for_point(
        &mut self,
        _: crate::Point<crate::Pixels>,
        _: &mut Window,
        _: &mut Context<Self>,
    ) -> Option<usize> {
        None
    }
    fn accepts_text_input(&self, _: &mut Window, cx: &mut Context<Self>) -> bool {
        if self.notify_when_asked.take() {
            cx.notify();
        }
        true
    }
}

/// A view that reads the text field it shows, as a form reads whether its
/// field is empty.
struct Form {
    field: Entity<TextField>,
    builds: Rc<Cell<usize>>,
}

impl Render for Form {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let asks = self.field.read(cx).notify_when_asked.get();
        div()
            .flex()
            .flex_col()
            .child(format!("form {asks}"))
            .child(self.field.clone())
    }
}

/// A view around another, counting its builds.
struct Shell {
    child: crate::AnyView,
    builds: Rc<Cell<usize>>,
}

impl Render for Shell {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        div()
            .flex()
            .flex_col()
            .child("shell")
            .child(self.child.clone())
    }
}

/// The window asks the focused text field whether it accepts text, and how
/// it is configured, on every frame. That is not a change to the field: a
/// view that read it is not built again, even inside a notified view. A
/// field that notifies while it is asked has changed, and the view that read
/// it is built again.
#[test]
fn asking_the_focused_text_field_is_not_a_change_unless_it_notifies() {
    let mut cx = TestAppContext::single();
    let (form_builds, field_builds) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(0)));
    let window = cx.add_window({
        let (form_builds, field_builds) = (form_builds.clone(), field_builds.clone());
        move |_, cx| {
            let field = cx.new(|cx| TextField {
                focus: cx.focus_handle(),
                notify_when_asked: Cell::new(false),
                builds: field_builds,
            });
            Shell {
                child: cx
                    .new(|_| Form {
                        field,
                        builds: form_builds,
                    })
                    .into(),
                builds: Rc::new(Cell::new(0)),
            }
        }
    });
    let field = cx.update(|cx| {
        window
            .read(cx)
            .unwrap()
            .child
            .clone()
            .downcast::<Form>()
            .unwrap()
            .read(cx)
            .field
            .clone()
    });
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    let focus = field.read_with(&cx, |field, _| field.focus.clone());
    cx.update_window(window.into(), |_, window, cx| window.focus(&focus, cx))
        .unwrap();
    draw(&mut cx);
    draw(&mut cx);
    let before = (form_builds.get(), field_builds.get());

    for _ in 0..3 {
        window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        draw(&mut cx);
    }
    assert_eq!(
        (form_builds.get(), field_builds.get()),
        before,
        "being asked every frame changes nothing the form read"
    );

    // This assertion separates the querying frame from its notified redraw.
    // Production-mode publication may notify after drawing has finished.
    cx.with_paused_automatic_drawing(|cx| {
        field.read_with(cx, |field, _| field.notify_when_asked.set(true));
        draw(cx);
        let asked = (form_builds.get(), field_builds.get());
        let notified = draw(cx);
        assert_eq!(
            (form_builds.get(), field_builds.get()),
            (asked.0 + 1, asked.1 + 1),
            "a field that notified while asked is built again, with the form that read it"
        );
        cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
            .unwrap();
        assert_eq!(notified, draw(cx));
    });
}

struct Ping;

impl crate::EventEmitter<Ping> for Model {}

/// A view that subscribes to a model it shows and ignores what it emits.
struct Subscriber {
    model: Entity<Model>,
    builds: Rc<Cell<usize>>,
    _subscription: crate::Subscription,
}

impl Render for Subscriber {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        div().child(format!("model {}", self.model.read(cx).0))
    }
}

struct Subscribers {
    first: Entity<Subscriber>,
    second: Entity<Subscriber>,
    bystander: Entity<Counted>,
}

impl Render for Subscribers {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .child(self.first.clone())
            .child(self.second.clone())
            .child(self.bystander.clone())
    }
}

/// Every subscriber of a model is updated for each event it emits, whether
/// it cares or not. A view updated that way, and not notified, is not built
/// again, nor is a view that read a model emitting without being notified,
/// unless it is inside a view notified since. A model updated and notified
/// is a change wherever it was read.
#[test]
fn a_view_updated_without_a_notify_is_built_again_only_inside_a_notified_view() {
    let mut cx = TestAppContext::single();
    let builds = Rc::new(Cell::new(0));
    let model = cx.new(|_| Model(0));
    let window = cx.add_window({
        let (builds, model) = (builds.clone(), model.clone());
        move |_, cx| {
            let mut subscriber = || {
                cx.new(|cx| Subscriber {
                    _subscription: cx.subscribe(&model, |_, _, _: &Ping, _| {}),
                    model: model.clone(),
                    builds: builds.clone(),
                })
            };
            Subscribers {
                first: subscriber(),
                second: subscriber(),
                bystander: cx.new(|_| Counted {
                    label: 0,
                    model: None,
                    builds: Rc::new(Cell::new(0)),
                }),
            }
        }
    });
    let bystander = window
        .read_with(&cx, |view, _| view.bystander.clone())
        .unwrap();
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    let emit = |cx: &mut TestAppContext| model.update(cx, |_, cx| cx.emit(Ping));
    draw(&mut cx);
    assert_eq!(builds.get(), 2);

    emit(&mut cx);
    draw(&mut cx);
    assert_eq!(builds.get(), 2, "an ignored event changes nothing drawn");

    emit(&mut cx);
    bystander.update(&mut cx, |bystander, cx| {
        bystander.label += 1;
        cx.notify();
    });
    draw(&mut cx);
    assert_eq!(
        builds.get(),
        2,
        "nor does it when a sibling is notified and the parent is drawn around it"
    );

    emit(&mut cx);
    window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
    draw(&mut cx);
    assert_eq!(
        builds.get(),
        4,
        "inside a notified view, what was updated since is built again"
    );

    model.update(&mut cx, |model, cx| {
        model.0 = 3;
        cx.emit(Ping);
        cx.notify();
    });
    let changed = draw(&mut cx);
    assert_eq!(builds.get(), 6, "a model updated and notified has changed");
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(changed, draw(&mut cx));
}

struct Theme(usize);

impl crate::Global for Theme {}

/// A view that only asks whether the theme is set.
struct AsksForTheme(Rc<Cell<usize>>);

impl Render for AsksForTheme {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.0.set(self.0.get() + 1);
        div().child(format!("themed {}", cx.has_global::<Theme>()))
    }
}

/// A view that reads the theme.
struct ReadsTheme(Rc<Cell<usize>>);

impl Render for ReadsTheme {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.0.set(self.0.get() + 1);
        let theme = cx.try_global::<Theme>().map_or(0, |theme| theme.0);
        div().child(format!("theme {theme}"))
    }
}

struct Themed {
    asks: Entity<AsksForTheme>,
    reads: Entity<ReadsTheme>,
}

impl Render for Themed {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .child(self.asks.clone())
            .child(self.reads.clone())
    }
}

/// A view that only asked whether a global is set depends on that, not on
/// the global: writing to the global builds again the views that read it,
/// but not that one, which is built again when the global is set where it
/// was not or removed.
#[test]
fn a_view_that_asked_whether_a_global_is_set_is_built_again_only_when_that_changes() {
    let mut cx = TestAppContext::single();
    let (asks, reads) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(0)));
    cx.update(|cx| cx.set_global(Theme(0)));
    let window = cx.add_window({
        let (asks, reads) = (asks.clone(), reads.clone());
        move |_, cx| Themed {
            asks: cx.new(|_| AsksForTheme(asks)),
            reads: cx.new(|_| ReadsTheme(reads)),
        }
    });
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    let builds = || (asks.get(), reads.get());
    draw(&mut cx);
    assert_eq!(builds(), (1, 1));

    cx.update(|cx| cx.global_mut::<Theme>().0 = 1);
    draw(&mut cx);
    assert_eq!(builds(), (1, 2), "global_mut writes the theme");

    cx.update_global::<Theme, _>(|theme, _| theme.0 = 2);
    draw(&mut cx);
    assert_eq!(builds(), (1, 3), "update_global writes the theme");

    cx.update(|cx| cx.set_global(Theme(3)));
    draw(&mut cx);
    assert_eq!(builds(), (1, 4), "setting a theme that was set writes it");

    cx.update(|cx| cx.remove_global::<Theme>());
    draw(&mut cx);
    assert_eq!(builds(), (2, 5), "removing it changes whether it is set");

    cx.update(|cx| cx.set_global(Theme(4)));
    let set = draw(&mut cx);
    assert_eq!(builds(), (3, 6), "setting it again changes that back");
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(set, draw(&mut cx));
}

/// Makes a window whose root is a counted [`Shell`] around `child`, and
/// returns it with the shell's build count.
fn shell(
    cx: &mut TestAppContext,
    child: impl FnOnce(&mut crate::App) -> crate::AnyView + 'static,
) -> (WindowHandle<Shell>, Rc<Cell<usize>>) {
    let builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let builds = builds.clone();
        move |_, cx| Shell {
            child: child(cx),
            builds,
        }
    });
    (window, builds)
}

fn draw_shell(cx: &mut TestAppContext, window: WindowHandle<Shell>) -> Vec<String> {
    cx.update_window(window.into(), |_, window, cx| {
        window.draw(cx).clear(cx);
        window.describe_rendered_frame()
    })
    .unwrap()
}

/// A view of a fixed size whose colour comes from its tint and a model, so
/// a change to either repaints it without laying it out again.
struct Tinted {
    tint: usize,
    model: Option<Entity<Model>>,
    builds: Rc<Cell<usize>>,
}

impl Render for Tinted {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let model = self.model.as_ref().map_or(0, |model| model.read(cx).0);
        let color = if (self.tint + model).is_multiple_of(2) {
            crate::black()
        } else {
            crate::white()
        };
        div().w(px(50.)).h(px(20.)).bg(color)
    }
}

/// A nested view that read a model changed since, with nothing notified
/// but the model, is built again on its own: the view around it, which read
/// the model only through it, is drawn around it from last frame.
#[test]
fn a_view_around_one_whose_model_changed_is_drawn_around_it() {
    let mut cx = TestAppContext::single();
    let inner_builds = Rc::new(Cell::new(0));
    let model = cx.new(|_| Model(0));
    let (window, outer_builds) = shell(&mut cx, {
        let (inner_builds, model) = (inner_builds.clone(), model.clone());
        move |cx| {
            cx.new(|_| Tinted {
                tint: 0,
                model: Some(model),
                builds: inner_builds,
            })
            .into()
        }
    });
    let before = draw_shell(&mut cx, window);
    assert_eq!((outer_builds.get(), inner_builds.get()), (1, 1));

    // The window draws as the update is flushed.
    model.update(&mut cx, |model, cx| {
        model.0 = 1;
        cx.notify();
    });
    assert_eq!((outer_builds.get(), inner_builds.get()), (1, 2));
    let changed = describe_shell(&mut cx, window);
    assert_ne!(before, changed);
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(changed, draw_shell(&mut cx, window));
}

/// A view drawn around a nested view hangs it off the dispatch node its
/// element had, copied from last frame, as building the view around it
/// would: drawn around it frame after frame, its dispatch tree is the one a
/// build gives, rather than a node deeper each frame.
#[test]
fn a_view_drawn_around_a_nested_view_keeps_its_dispatch_tree() {
    let mut cx = TestAppContext::single();
    let inner_builds = Rc::new(Cell::new(0));
    let model = cx.new(|_| Model(0));
    let (window, outer_builds) = shell(&mut cx, {
        let (inner_builds, model) = (inner_builds.clone(), model.clone());
        move |cx| {
            cx.new(|_| Tinted {
                tint: 0,
                model: Some(model),
                builds: inner_builds,
            })
            .into()
        }
    });
    let describe = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, _| {
            let tree = &window.rendered_frame.dispatch_tree;
            tree.nodes
                .iter()
                .map(|node| (node.parent.map(|parent| parent.0), node.view_id))
                .collect::<Vec<_>>()
        })
        .unwrap()
    };
    draw_shell(&mut cx, window);
    let built = describe(&mut cx);
    for value in 1..4 {
        model.update(&mut cx, |model, cx| {
            model.0 = value;
            cx.notify();
        });
        assert_eq!(
            describe(&mut cx),
            built,
            "after {value} frames drawn around"
        );
    }
    assert_eq!((outer_builds.get(), inner_builds.get()), (1, 4));
}

fn describe_shell(cx: &mut TestAppContext, window: WindowHandle<Shell>) -> Vec<String> {
    cx.update_window(window.into(), |_, window, _| {
        window.describe_rendered_frame()
    })
    .unwrap()
}

/// Two views side by side.
struct Pair {
    left: crate::AnyView,
    right: crate::AnyView,
}

impl Render for Pair {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .child(self.left.clone())
            .child(self.right.clone())
    }
}

/// A view drawn around a nested view built again has read what that view
/// read as of that frame: on a later frame, with nothing it read changed
/// since, it is drawn from last frame rather than built again, as when a
/// view beside it is notified.
#[test]
fn a_view_drawn_around_a_nested_view_is_reused_on_a_later_frame() {
    let mut cx = TestAppContext::single();
    let (outer_builds, inner_builds) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(0)));
    let model = cx.new(|_| Model(0));
    let tinted = |cx: &mut crate::App, model: Option<Entity<Model>>, builds| {
        cx.new(|_| Tinted {
            tint: 0,
            model,
            builds,
        })
    };
    let window = cx.add_window({
        let (outer_builds, inner_builds, model) =
            (outer_builds.clone(), inner_builds.clone(), model.clone());
        move |_, cx| {
            let inner = tinted(cx, Some(model), inner_builds);
            Pair {
                left: cx
                    .new(|_| Shell {
                        child: inner.into(),
                        builds: outer_builds,
                    })
                    .into(),
                right: tinted(cx, None, Rc::new(Cell::new(0))).into(),
            }
        }
    });
    let right = window
        .read_with(&cx, |pair, _| {
            pair.right.clone().downcast::<Tinted>().unwrap()
        })
        .unwrap();
    let draw = |cx: &mut TestAppContext| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.describe_rendered_frame()
        })
        .unwrap()
    };
    draw(&mut cx);
    // The window draws as each update is flushed.
    model.update(&mut cx, |model, cx| {
        model.0 = 1;
        cx.notify();
    });
    let builds_then = (outer_builds.get(), inner_builds.get());
    assert_eq!(builds_then, (1, 2), "the shell is drawn around the view");

    right.update(&mut cx, |right, cx| {
        right.tint = 1;
        cx.notify();
    });
    let later = cx
        .update_window(window.into(), |_, window, _| {
            window.describe_rendered_frame()
        })
        .unwrap();
    assert_eq!(
        (outer_builds.get(), inner_builds.get()),
        builds_then,
        "nothing the shell read changed since the frame it was drawn around the view"
    );
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(later, draw(&mut cx));
}

/// A view with something in it that has a hover style.
struct Hoverable(Rc<Cell<usize>>);

impl Render for Hoverable {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.0.set(self.0.get() + 1);
        div().child(
            div()
                .id("hoverable")
                .w(px(50.))
                .h(px(20.))
                .bg(crate::black())
                .hover(|style| style.bg(crate::white())),
        )
    }
}

/// The pointer moving onto or off something with a hover style builds again
/// the view it is in, and only that one: the views around it are drawn
/// around it from last frame.
#[test]
fn a_hover_inside_a_nested_view_builds_only_that_view_again() {
    let mut cx = TestAppContext::single();
    let inner_builds = Rc::new(Cell::new(0));
    let (window, outer_builds) = shell(&mut cx, {
        let inner_builds = inner_builds.clone();
        move |cx| cx.new(|_| Hoverable(inner_builds)).into()
    });
    let move_to = |cx: &mut TestAppContext, x: f32, y: f32| {
        cx.update_window(window.into(), |_, window, cx| {
            window.simulate_mouse_move(crate::point(px(x), px(y)), cx);
        })
        .unwrap();
    };
    move_to(&mut cx, 500., 500.);
    let away = draw_shell(&mut cx, window);
    let before = (outer_builds.get(), inner_builds.get());

    // The shell draws a line of text above the hoverable view.
    let hoverable = cx
        .update_window(window.into(), |_, window, _| {
            window
                .rendered_frame
                .hitboxes
                .last()
                .map(|hitbox| hitbox.bounds.center())
        })
        .unwrap()
        .expect("the hoverable element has a hitbox");
    move_to(&mut cx, hoverable.x.into(), hoverable.y.into());
    let over = draw_shell(&mut cx, window);
    assert_eq!(
        (outer_builds.get(), inner_builds.get()),
        (before.0, before.1 + 1)
    );
    assert_ne!(away, over);
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(over, draw_shell(&mut cx, window));

    move_to(&mut cx, 500., 500.);
    let away_again = draw_shell(&mut cx, window);
    assert_eq!(
        outer_builds.get(),
        before.0 + 1,
        "only the forgetting built it"
    );
    assert_eq!(away, away_again);
}

/// A view around a nested view, cached by the style it is cached with or
/// not.
struct AroundNested {
    child: Entity<Tinted>,
    cached: bool,
    builds: Rc<Cell<usize>>,
}

impl Render for AroundNested {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let child = if self.cached {
            self.child
                .clone()
                .cached(StyleRefinement::default().w(px(50.)).h(px(20.)))
                .into_any_element()
        } else {
            self.child.clone().into_any_element()
        };
        div()
            .flex()
            .flex_col()
            .child("around")
            .child(child)
            .child("after")
    }
}

/// A nested view notified on its own, cached or not, is built again in the
/// gap where it was, a cached one at the style it is cached with: the view
/// around it is drawn around it from last frame, frame after frame, and the
/// frame is what one drawn from scratch is.
#[test]
fn a_view_around_a_notified_nested_view_is_drawn_around_it() {
    for cached in [false, true] {
        let mut cx = TestAppContext::single();
        let (outer_builds, child_builds) = (Rc::new(Cell::new(0)), Rc::new(Cell::new(0)));
        let window = cx.add_window({
            let (outer_builds, child_builds) = (outer_builds.clone(), child_builds.clone());
            move |_, cx| AroundNested {
                child: cx.new(|_| Tinted {
                    tint: 0,
                    model: None,
                    builds: child_builds,
                }),
                cached,
                builds: outer_builds,
            }
        });
        let child = window.read_with(&cx, |view, _| view.child.clone()).unwrap();
        let draw = |cx: &mut TestAppContext| {
            cx.update_window(window.into(), |_, window, cx| {
                window.draw(cx).clear(cx);
                window.describe_rendered_frame()
            })
            .unwrap()
        };
        let mut last = draw(&mut cx);
        assert_eq!((outer_builds.get(), child_builds.get()), (1, 1));

        for tint in 1..4 {
            // The window draws as the update is flushed.
            child.update(&mut cx, |child, cx| {
                child.tint = tint;
                cx.notify();
            });
            let changed = cx
                .update_window(window.into(), |_, window, _| {
                    window.describe_rendered_frame()
                })
                .unwrap();
            assert_eq!(
                (outer_builds.get(), child_builds.get()),
                (1, tint + 1),
                "cached: {cached}, notified {tint} times"
            );
            assert_ne!(last, changed);
            last = changed;
        }
        cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
            .unwrap();
        assert_eq!(last, draw(&mut cx), "cached: {cached}");
    }
}

#[test]
fn untracked_retained_input_keeps_its_original_marked_handler_during_reveal_paint() {
    struct MarkedField(crate::FocusHandle, bool, Rc<Cell<usize>>);
    impl Render for MarkedField {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let focus = self.0.clone();
            let marked = self.1;
            let paints = self.2.clone();
            crate::canvas(
                |_, _, _| {},
                move |_, _, window, cx| {
                    paints.set(paints.get() + 1);
                    window.handle_input(&focus, NamedInput("original", marked), cx);
                },
            )
            .size_full()
        }
    }
    struct Reveal {
        original: Entity<MarkedField>,
        candidate: crate::FocusHandle,
        offer: bool,
        original_first: bool,
    }
    impl Render for Reveal {
        fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
            let original = self
                .original
                .clone()
                .cached(StyleRefinement::default().w(px(100.)).h(px(20.)))
                .into_any_element();
            let focus = self.candidate.clone();
            let offer = self.offer;
            let candidate = div()
                .w(px(100.))
                .h(px(20.))
                .track_focus(&self.candidate)
                .child(
                    crate::canvas(
                        |_, _, _| {},
                        move |_, _, window, cx| {
                            if offer {
                                window.focus_on_reveal(&focus, cx);
                            }
                            window.handle_input(&focus, NamedInput("candidate", false), cx);
                        },
                    )
                    .size_full(),
                )
                .into_any_element();
            div().children(if self.original_first {
                [original, candidate]
            } else {
                [candidate, original]
            })
        }
    }
    for (original_first, marked) in [(true, false), (false, false), (true, true), (false, true)] {
        let mut cx = TestAppContext::single();
        let window = cx.add_window(move |_, cx| Reveal {
            original: cx.new(|cx| MarkedField(cx.focus_handle(), marked, Rc::new(Cell::new(0)))),
            candidate: cx.focus_handle(),
            offer: false,
            original_first,
        });
        let original = window
            .update(&mut cx, |view, _, cx| view.original.read(cx).0.clone())
            .unwrap();
        cx.update_window(window.into(), |_, window, cx| {
            window.focus(&original, cx);
            window.draw(cx).clear(cx);
        })
        .unwrap();
        window
            .update(&mut cx, |view, _, cx| {
                view.offer = true;
                cx.notify();
            })
            .unwrap();
        let (paints, candidate) = window
            .update(&mut cx, |view, _, cx| {
                (view.original.read(cx).2.clone(), view.candidate.clone())
            })
            .unwrap();
        let before_paint = paints.get();
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            assert_eq!(
                paints.get(),
                before_paint,
                "original native handler's subtree actually reuses paint"
            );
            assert!(if marked {
                original.is_focused(window)
            } else {
                candidate.is_focused(window)
            });
            assert_eq!(window.has_marked_text(cx), marked);
        })
        .unwrap();
        let expected = if marked { "original" } else { "candidate" };
        for _ in 0..3 {
            let mut handler = cx
                .update_window(window.into(), |_, window, _| {
                    window.platform_window.take_input_handler()
                })
                .unwrap()
                .expect("actual published handler");
            assert_eq!(
                handler.text_for_range(0..1, &mut None).as_deref(),
                Some(expected)
            );
            cx.update_window(window.into(), |_, window, cx| {
                window.platform_window.set_input_handler(handler);
                window.draw(cx).clear(cx);
                assert_eq!(window.has_marked_text(cx), marked);
            })
            .unwrap();
        }
    }
}

/// A child outside its parent's Taffy tree, laid out during prepaint like
/// a uniform_list item. Keeping its parent must still run this placement.
struct RootPlacer(crate::AnyElement);

impl IntoElement for RootPlacer {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}

impl crate::Element for RootPlacer {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<crate::ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&crate::GlobalElementId>,
        _: Option<&crate::InspectorElementId>,
        window: &mut Window,
        cx: &mut crate::App,
    ) -> (crate::LayoutId, ()) {
        let mut style = crate::Style::default();
        style.size.width = crate::relative(1.).into();
        style.size.height = crate::relative(1.).into();
        (window.request_layout(style, None, cx), ())
    }
    fn prepaint(
        &mut self,
        _: Option<&crate::GlobalElementId>,
        _: Option<&crate::InspectorElementId>,
        bounds: crate::Bounds<crate::Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut crate::App,
    ) {
        self.0
            .prepaint_as_root(bounds.origin, bounds.size.into(), window, cx);
    }
    fn paint(
        &mut self,
        _: Option<&crate::GlobalElementId>,
        _: Option<&crate::InspectorElementId>,
        _: crate::Bounds<crate::Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut crate::App,
    ) {
        self.0.paint(window, cx);
    }
}

struct RootPlacedStatus(crate::SharedString);
impl Render for RootPlacedStatus {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .child(self.0.clone())
    }
}

#[derive(Clone, Copy)]
enum StatusPlacement {
    Flow,
    Root,
    List,
    VariableList,
    ContainerQuery,
    Deferred,
    Anchored,
}

struct StatusHost {
    status: Entity<RootPlacedStatus>,
    placement: StatusPlacement,
    list: crate::ListState,
}
impl Render for StatusHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let child = div()
            .size_full()
            .child(self.status.clone())
            .into_any_element();
        let body = match self.placement {
            StatusPlacement::Flow => child,
            StatusPlacement::Root => RootPlacer(child).into_any_element(),
            StatusPlacement::VariableList => {
                let status = self.status.clone();
                crate::list(self.list.clone(), move |_, _, _| {
                    div().h(px(40.)).child(status.clone()).into_any_element()
                })
                .size_full()
                .into_any_element()
            }
            StatusPlacement::ContainerQuery => {
                crate::container_query(move |_, _, _| child).into_any_element()
            }
            StatusPlacement::Deferred => crate::deferred(child).into_any_element(),
            StatusPlacement::Anchored => crate::anchored()
                .position(crate::point(px(30.), px(40.)))
                .child(child)
                .into_any_element(),
            StatusPlacement::List => {
                let status = self.status.clone();
                crate::uniform_list("status-list", 1, move |_, _, _| {
                    vec![div().h(px(40.)).child(status.clone()).into_any_element()]
                })
                .size_full()
                .into_any_element()
            }
        };
        div()
            .size_full()
            .flex()
            .flex_col()
            .child("header")
            .child(div().flex_1().child(body))
    }
}

fn status_change_at_placement(placement: StatusPlacement) {
    let mut cx = TestAppContext::single();
    let status = cx.new(|_| RootPlacedStatus("Starting…".into()));
    // The shell exercises a splice around another splice, as in the real
    // application's WindowBorder / WorkspaceView / editor hierarchy.
    let (window, _) = shell(&mut cx, {
        let status = status.clone();
        move |cx| {
            cx.new(|_| StatusHost {
                status,
                placement,
                list: crate::ListState::new(1, crate::ListAlignment::Top, px(0.)),
            })
            .into()
        }
    });
    let before = draw_shell(&mut cx, window);
    for text in [
        "Session unavailable: a longer status",
        "Ready",
        "Another longer status",
    ] {
        status.update(&mut cx, |status, cx| {
            status.0 = text.into();
            cx.notify();
        });
        let changed = describe_shell(&mut cx, window);
        assert_ne!(before, changed);
        cx.update_window(window.into(), |_, window, _| {
            window.set_view_retention(false)
        })
        .unwrap();
        assert_eq!(
            changed,
            draw_shell(&mut cx, window),
            "retained output must match a full render"
        );
        cx.update_window(window.into(), |_, window, _| {
            window.set_view_retention(true)
        })
        .unwrap();
        draw_shell(&mut cx, window);
    }
}

#[test]
fn status_change_in_normal_flow_is_measured() {
    status_change_at_placement(StatusPlacement::Flow);
}
#[test]
fn status_change_under_prepaint_as_root_is_measured() {
    status_change_at_placement(StatusPlacement::Root);
}
#[test]
fn status_change_in_uniform_list_is_measured() {
    status_change_at_placement(StatusPlacement::List);
}

#[test]
fn status_change_in_variable_list_is_measured() {
    status_change_at_placement(StatusPlacement::VariableList);
}
#[test]
fn status_change_under_container_query_is_measured() {
    status_change_at_placement(StatusPlacement::ContainerQuery);
}
#[test]
fn status_change_under_deferred_is_measured() {
    status_change_at_placement(StatusPlacement::Deferred);
}
#[test]
fn status_change_under_anchored_is_measured() {
    status_change_at_placement(StatusPlacement::Anchored);
}

struct MixedDeferredViews {
    flow: Entity<Tinted>,
    overlay: Entity<Tinted>,
}

impl Render for MixedDeferredViews {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .child(self.flow.clone())
            .child(crate::deferred(
                crate::anchored()
                    .position(crate::point(px(10.), px(10.)))
                    .child(div().w(px(200.)).h(px(40.)).child(self.overlay.clone())),
            ))
    }
}

/// Deferred view records follow the closed ancestor's subtree. Check the
/// notification frame itself: an extra draw can hide a stale copied overlay.
fn changed_flow_and_deferred_views_match_full_render(idle_first: bool) {
    let mut cx = TestAppContext::single();
    let flow_builds = Rc::new(Cell::new(0));
    let overlay_builds = Rc::new(Cell::new(0));
    let flow = cx.new(|_| Tinted {
        tint: 0,
        model: None,
        builds: flow_builds.clone(),
    });
    let overlay = cx.new(|_| Tinted {
        tint: 0,
        model: None,
        builds: overlay_builds.clone(),
    });
    let (window, _) = shell(&mut cx, {
        let (flow, overlay) = (flow.clone(), overlay.clone());
        move |cx| cx.new(|_| MixedDeferredViews { flow, overlay }).into()
    });
    draw_shell(&mut cx, window);
    if idle_first {
        draw_shell(&mut cx, window);
    }
    for tint in [1, 0, 1] {
        let before = (flow_builds.get(), overlay_builds.get());
        cx.update(|cx| {
            flow.update(cx, |view, cx| {
                view.tint = tint;
                cx.notify();
            });
            overlay.update(cx, |view, cx| {
                view.tint = tint;
                cx.notify();
            });
        });
        assert_eq!(
            flow_builds.get(),
            before.0 + 1,
            "the flow child rebuilt in the notification frame"
        );
        assert_eq!(
            overlay_builds.get(),
            before.1 + 1,
            "the deferred child must rebuild in the same frame"
        );
        let changed = describe_shell(&mut cx, window);
        cx.update_window(window.into(), |_, window, _| {
            window.set_view_retention(false)
        })
        .unwrap();
        assert_eq!(
            changed,
            draw_shell(&mut cx, window),
            "a splice must not replay a dirty deferred view"
        );
        cx.update_window(window.into(), |_, window, _| {
            window.set_view_retention(true)
        })
        .unwrap();
        draw_shell(&mut cx, window);
    }
}

#[test]
fn simultaneously_changed_flow_and_deferred_views_match_full_render() {
    changed_flow_and_deferred_views_match_full_render(false);
}

#[test]
fn simultaneously_changed_flow_and_reused_deferred_views_match_full_render() {
    changed_flow_and_deferred_views_match_full_render(true);
}

struct OffsetDependentParent {
    scroll: crate::ScrollHandle,
    child: Entity<Tinted>,
    builds: Rc<Cell<usize>>,
}

impl Render for OffsetDependentParent {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let color = if self.scroll.offset().y < px(0.) {
            crate::white()
        } else {
            crate::black()
        };
        div().size_full().bg(color).child(self.child.clone())
    }
}

#[test]
fn a_parent_whose_scroll_offset_read_changed_is_not_spliced() {
    if !crate::fast::layers::COMPILED {
        return;
    }
    let mut cx = TestAppContext::single();
    let builds = Rc::new(Cell::new(0));
    let child = cx.new(|_| Tinted {
        tint: 0,
        model: None,
        builds: Rc::new(Cell::new(0)),
    });
    let scroll = crate::ScrollHandle::new();
    let (window, _) = shell(&mut cx, {
        let (scroll, child, builds) = (scroll.clone(), child.clone(), builds.clone());
        move |cx| {
            cx.new(|_| OffsetDependentParent {
                scroll,
                child,
                builds,
            })
            .into()
        }
    });
    draw_shell(&mut cx, window);
    let before = builds.get();
    cx.update(|cx| {
        scroll.set_offset(crate::point(px(0.), px(-20.)));
        child.update(cx, |child, cx| {
            child.tint = 1;
            cx.notify();
        });
    });
    let changed = describe_shell(&mut cx, window);
    assert_eq!(
        builds.get(),
        before + 1,
        "the parent's own offset read changed"
    );
    cx.update_window(window.into(), |_, window, _| {
        window.set_view_retention(false)
    })
    .unwrap();
    assert_eq!(changed, draw_shell(&mut cx, window));
}

struct GrowingFixedView {
    extra: Rc<Cell<bool>>,
    builds: Rc<Cell<usize>>,
}

impl Render for GrowingFixedView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        div()
            .relative()
            .w(px(100.))
            .h(px(40.))
            .child(div().id("base").size_full())
            .when(self.extra.get(), |this| {
                this.child(
                    div()
                        .id("extra")
                        .absolute()
                        .top_0()
                        .left_0()
                        .size(px(10.))
                        .bg(crate::white()),
                )
            })
    }
}

#[test]
fn new_layout_nodes_in_a_spliced_gap_survive_idle_frames() {
    let mut cx = TestAppContext::single();
    let builds = Rc::new(Cell::new(0));
    let extra = Rc::new(Cell::new(false));
    let child = cx.new(|_| GrowingFixedView {
        extra: extra.clone(),
        builds: builds.clone(),
    });
    let (window, outer_builds) = shell(&mut cx, {
        let child = child.clone();
        move |_| child.into()
    });
    draw_shell(&mut cx, window);
    extra.set(true);
    cx.update(|cx| cx.notify(child.entity_id()));
    let added = describe_shell(&mut cx, window);
    let nodes = cx
        .update_window(window.into(), |_, window, _| {
            window.layout_engine.as_ref().unwrap().node_count()
        })
        .unwrap();
    for _ in 0..3 {
        assert_eq!(added, draw_shell(&mut cx, window));
        assert_eq!(
            nodes,
            cx.update_window(window.into(), |_, window, _| window
                .layout_engine
                .as_ref()
                .unwrap()
                .node_count())
                .unwrap(),
            "a reused parent must retain the gap's new nodes"
        );
    }
    assert_eq!(
        outer_builds.get(),
        1,
        "the fixed-size parent can be spliced"
    );
    extra.set(false);
    cx.update(|cx| cx.notify(child.entity_id()));
    let removed = describe_shell(&mut cx, window);
    assert_ne!(added, removed);
    for _ in 0..3 {
        assert_eq!(removed, draw_shell(&mut cx, window));
        cx.update_window(window.into(), |_, window, _| {
            assert!(
                window
                    .rendered_frame
                    .element_states
                    .keys()
                    .all(|(id, _)| id.last() != Some(&crate::ElementId::from("extra"))),
                "removed element state must not be replayed by the parent"
            );
            assert_eq!(
                window.layout_engine.as_ref().unwrap().node_count(),
                nodes - 1
            );
        })
        .unwrap();
    }
    assert_eq!(outer_builds.get(), 1);
    assert_eq!(builds.get(), 3);
}

/// What a [`HandingHost`] hands the view [`Handed`] draws in it.
struct Shown(bool);

/// A view drawn inside [`Handed`], reading what its host hands it.
struct ShownReader {
    shown: Entity<Shown>,
    builds: Rc<Cell<usize>>,
}

impl Render for ShownReader {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let color = if self.shown.read(cx).0 {
            crate::red()
        } else {
            crate::blue()
        };
        div().size(px(10.)).bg(color)
    }
}

/// A cached view whose host writes into it, as it renders, whether it is
/// active, as a window hands its panes whether they show.
struct Handed {
    active: bool,
    reader: Entity<ShownReader>,
    builds: Rc<Cell<usize>>,
}

impl Render for Handed {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        let color = if self.active {
            crate::green()
        } else {
            crate::black()
        };
        div().size_full().bg(color).child(self.reader.clone())
    }
}

/// A view that writes into the cached view it draws, and into a model a
/// view drawn in that one reads, on every render, notifying the cached view
/// if `notify` and the model never.
struct HandingHost {
    handed: Entity<Handed>,
    shown: Entity<Shown>,
    active: bool,
    notify: bool,
}

impl Render for HandingHost {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let (active, notify) = (self.active, self.notify);
        self.handed.update(cx, |handed, cx| {
            handed.active = active;
            if notify {
                cx.notify();
            }
        });
        self.shown.update(cx, |shown, _| shown.0 = active);
        div().size(px(300.)).child(
            self.handed
                .clone()
                .cached(StyleRefinement::default().w(px(100.)).h(px(20.))),
        )
    }
}

struct Handing {
    window: WindowHandle<HandingHost>,
    handed_builds: Rc<Cell<usize>>,
    reader_builds: Rc<Cell<usize>>,
}

fn handing(cx: &mut TestAppContext, notify: bool) -> Handing {
    let handed_builds = Rc::new(Cell::new(0));
    let reader_builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let handed_builds = handed_builds.clone();
        let reader_builds = reader_builds.clone();
        move |_, cx| {
            let shown = cx.new(|_| Shown(true));
            let reader = cx.new(|_| ShownReader {
                shown: shown.clone(),
                builds: reader_builds,
            });
            HandingHost {
                handed: cx.new(|_| Handed {
                    active: true,
                    reader,
                    builds: handed_builds,
                }),
                shown,
                active: true,
                notify,
            }
        }
    });
    Handing {
        window,
        handed_builds,
        reader_builds,
    }
}

fn draw_handing(cx: &mut TestAppContext, window: WindowHandle<HandingHost>) -> Vec<String> {
    cx.update_window(window.into(), |_, window, cx| {
        window.draw(cx).clear(cx);
        window.describe_rendered_frame()
    })
    .unwrap()
}

/// A cached view whose host writes into it as it renders, without
/// notifying it, is drawn from last frame while what was written is what it
/// holds, as upstream draws a cached view again only when it is notified: a
/// pane told on every render of the window around it whether it shows is
/// not built again for it, nor is a view drawn in it reading a model the
/// host writes the same way. The frame is the one drawn from scratch.
#[test]
fn a_cached_view_its_host_writes_without_notifying_is_drawn_from_last_frame() {
    let mut cx = TestAppContext::single();
    let h = handing(&mut cx, false);
    let first = draw_handing(&mut cx, h.window);
    assert_eq!((h.handed_builds.get(), h.reader_builds.get()), (1, 1));

    for _ in 0..5 {
        h.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        assert_eq!(first, draw_handing(&mut cx, h.window));
    }
    assert_eq!(
        (h.handed_builds.get(), h.reader_builds.get()),
        (1, 1),
        "the cached view, and the view in it, were drawn from last frame"
    );
    let reused = cx
        .update_window(h.window.into(), |_, window, _| {
            window.layout_stats().views_reused
        })
        .unwrap();
    assert!(reused > 0, "views were reused");

    cx.update_window(h.window.into(), |_, window, _| {
        window.forget_retained_state()
    })
    .unwrap();
    assert_eq!(first, draw_handing(&mut cx, h.window));
    assert_eq!(h.handed_builds.get(), 2, "drawn from scratch");

    let off = handing(&mut cx, false);
    cx.update_window(off.window.into(), |_, window, _| {
        window.set_view_retention(false)
    })
    .unwrap();
    for _ in 0..3 {
        off.window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        assert_eq!(first, draw_handing(&mut cx, off.window));
    }
}

/// A cached view its host writes into and notifies as it renders is built
/// again, and shows what was written.
#[test]
fn a_cached_view_its_host_writes_and_notifies_is_built_again() {
    let mut cx = TestAppContext::single();
    let h = handing(&mut cx, true);
    let active = draw_handing(&mut cx, h.window);
    let builds = h.handed_builds.get();

    h.window
        .update(&mut cx, |host, _, cx| {
            host.active = false;
            cx.notify();
        })
        .unwrap();
    let inactive = draw_handing(&mut cx, h.window);
    assert_ne!(active, inactive, "what was written shows");
    assert!(
        h.handed_builds.get() > builds,
        "the cached view was built again"
    );

    cx.update_window(h.window.into(), |_, window, _| {
        window.forget_retained_state()
    })
    .unwrap();
    assert_eq!(inactive, draw_handing(&mut cx, h.window));
}

/// A root drawing a [`PaintHost`] as a cached view.
struct CachedPaintHost {
    host: Entity<PaintHost>,
}

impl Render for CachedPaintHost {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size(px(400.)).child(
            self.host
                .clone()
                .cached(StyleRefinement::default().w(px(300.)).h(px(300.))),
        )
    }
}

/// A component writing into the view it renders, inside a cached view, as
/// GPUI Kit's `Tree` writes its item renderer, writes as part of building
/// the cached view: notified, the cached view is built again and the view
/// written is drawn with what was written.
#[test]
fn a_view_written_inside_a_cached_view_is_rendered_again_with_it() {
    let mut cx = TestAppContext::single();
    let host = Rc::new(std::cell::RefCell::new(None));
    let window = cx.add_window({
        let host = host.clone();
        move |_, cx| {
            let painter = cx.new(|_| Painter {
                color: crate::blue(),
            });
            let paint_host = cx.new(|_| PaintHost {
                painter,
                red: false,
            });
            *host.borrow_mut() = Some(paint_host.clone());
            CachedPaintHost { host: paint_host }
        }
    });
    let paint_host = host.borrow().clone().unwrap();
    let blue = backgrounds(&mut cx, window.into());

    paint_host.update(&mut cx, |host, cx| {
        host.red = true;
        cx.notify();
    });
    let red = backgrounds(&mut cx, window.into());
    assert_ne!(blue, red, "the painter was drawn with the color written");
    assert_eq!(red, backgrounds(&mut cx, window.into()));
    cx.update_window(window.into(), |_, window, _| window.forget_retained_state())
        .unwrap();
    assert_eq!(red, backgrounds(&mut cx, window.into()));
}

/// A view that draws a box tests find by its selector, counting its builds.
struct Labelled {
    builds: Rc<Cell<usize>>,
}

impl Render for Labelled {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        self.builds.set(self.builds.get() + 1);
        div()
            .debug_selector(|| "kept".into())
            .size(px(40.))
            .bg(crate::blue())
    }
}

/// A root holding a [`Labelled`] view, and a box of its own while `shown`.
struct Shelf {
    kept: Entity<Labelled>,
    shown: bool,
}

impl Render for Shelf {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size(px(300.))
            .child(self.kept.clone())
            .when(self.shown, |this| {
                this.child(
                    div()
                        .debug_selector(|| "gone".into())
                        .size(px(20.))
                        .bg(crate::red()),
                )
            })
    }
}

/// An element the frame no longer draws is gone from the frame's debug
/// bounds, though a view beside it was drawn again from the last frame, and
/// that view's elements are still found where they are drawn.
#[test]
fn an_element_no_longer_drawn_leaves_the_debug_bounds_of_a_retained_frame() {
    let mut cx = TestAppContext::single();
    let builds = Rc::new(Cell::new(0));
    let window = cx.add_window({
        let builds = builds.clone();
        move |_, cx| Shelf {
            kept: cx.new(|_| Labelled { builds }),
            shown: true,
        }
    });
    let bounds = |cx: &mut TestAppContext, selector: &str| {
        cx.update_window(window.into(), |_, window, cx| {
            window.draw(cx).clear(cx);
            window.rendered_frame.debug_bounds.get(selector).copied()
        })
        .unwrap()
    };
    let kept = bounds(&mut cx, "kept").expect("the view's box is drawn");
    assert!(bounds(&mut cx, "gone").is_some(), "the root's box is drawn");
    let builds_before = builds.get();

    window
        .update(&mut cx, |shelf, _, cx| {
            shelf.shown = false;
            cx.notify();
        })
        .unwrap();
    assert_eq!(
        bounds(&mut cx, "gone"),
        None,
        "the root's box is no longer drawn"
    );
    assert_eq!(
        builds.get(),
        builds_before,
        "the view beside it was drawn from the last frame"
    );
    assert_eq!(bounds(&mut cx, "kept"), Some(kept));
}

//! Tests of how text is measured and kept across frames. See
//! [`crate::fast::text`].

use crate::{
    AnyWindowHandle, AppContext as _, Context, IntoElement, LayoutStats, ParentElement as _,
    Render, SharedString, Styled as _, TestAppContext, Window, div, px,
};

/// Rows that each show text of their own, matched to their nodes by
/// position.
struct ShiftingRows {
    row_ids: Vec<u64>,
}

impl Render for ShiftingRows {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .children(self.row_ids.iter().map(|id| {
                div()
                    .h(px(20.))
                    .child(SharedString::from(format!("row {id}")))
            }))
    }
}

fn draw(cx: &mut TestAppContext, window: AnyWindowHandle) -> LayoutStats {
    cx.update_window(window, |_, window, cx| {
        window.draw(cx).clear(cx);
        window.layout_stats()
    })
    .unwrap()
}

fn change_and_draw(
    cx: &mut TestAppContext,
    window: crate::WindowHandle<ShiftingRows>,
    change: impl FnOnce(&mut ShiftingRows),
) -> LayoutStats {
    // Counted from before the change, which can draw a frame of its own.
    cx.update_window(window.into(), |_, window, _| window.reset_layout_stats())
        .unwrap();
    window
        .update(cx, |view, _, cx| {
            change(view);
            cx.notify();
        })
        .unwrap();
    draw(cx, window.into())
}

/// A text node that takes over last frame's measurement answers from the
/// lines it already holds and never asks the line layout cache for them.
/// Those lines still have to stay in the cache: when unidentified rows shift
/// by one, every row lands on a neighbour's node, and the text it brings was
/// on screen all along.
#[test]
fn text_kept_by_its_node_is_not_reshaped_when_rows_shift_onto_other_nodes() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, _| ShiftingRows {
        row_ids: (0..8).collect(),
    });
    // Enough frames for anything only the first frame asked the cache for
    // to have been forgotten, had nobody asked since.
    for _ in 0..3 {
        window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        draw(&mut cx, window.into());
    }

    let shifted = change_and_draw(&mut cx, window, |view| {
        view.row_ids.remove(0);
    });
    assert!(
        shifted.measure_calls > 0,
        "rows should have moved onto other nodes for this to test anything: {shifted:?}"
    );
    assert_eq!(
        shifted.lines_shaped, 0,
        "every row's text was on screen the frame before and should come from the cache: {shifted:?}"
    );
}

/// Lines outlive the frames that asked for them only while something holds
/// them. Once the text is gone from the tree, and with it the nodes that held
/// its lines, the cache has to let them go too.
#[test]
fn text_nothing_holds_any_more_leaves_the_line_layout_cache() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, _| ShiftingRows {
        row_ids: (0..8).collect(),
    });
    draw(&mut cx, window.into());
    change_and_draw(&mut cx, window, |view| view.row_ids.clear());
    for _ in 0..3 {
        window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        draw(&mut cx, window.into());
    }
    // Lines shaped lately are also kept apart from the cache, so that text
    // coming back is not shaped again; forget them, to see the cache alone.
    cx.update_window(window.into(), |_, window, _| window.forget_recent_shapes())
        .unwrap();

    let shown_again = change_and_draw(&mut cx, window, |view| {
        view.row_ids = (0..8).collect();
    });
    assert_eq!(
        shown_again.lines_shaped, 8,
        "text removed frames ago should have left the cache: {shown_again:?}"
    );
}

const PROBED_TEXT: &str = "the quick brown fox jumps over the lazy dog";

/// A line of text in one color, in a box of a given width, which keeps the
/// layout its text is measured into for the test to look at.
struct Probed {
    color: crate::Hsla,
    width: crate::Pixels,
    ellipsis: bool,
    layout: std::rc::Rc<std::cell::RefCell<Option<crate::TextLayout>>>,
}

impl Render for Probed {
    fn render(&mut self, window: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        use crate::prelude::FluentBuilder as _;
        let run = crate::TextRun {
            color: self.color,
            ..window.text_style().to_run(PROBED_TEXT.len())
        };
        let text = crate::StyledText::new(PROBED_TEXT).with_runs(vec![run]);
        *self.layout.borrow_mut() = Some(text.layout().clone());
        div()
            .w(self.width)
            .when(self.ellipsis, |this| this.text_ellipsis())
            .child(text)
    }
}

fn probed(cx: &mut TestAppContext, width: f32, ellipsis: bool) -> crate::WindowHandle<Probed> {
    cx.add_window(move |_, _| Probed {
        color: crate::black(),
        width: px(width),
        ellipsis,
        layout: Default::default(),
    })
}

/// The lines the probed text ended up as, with the colors they are painted in.
fn probed_lines(
    cx: &mut TestAppContext,
    window: crate::WindowHandle<Probed>,
) -> (Vec<String>, Vec<crate::Hsla>) {
    window
        .update(cx, |view, _, _| {
            let layout = view.layout.borrow().clone().unwrap();
            let inner = layout.0.borrow();
            let lines = &inner.as_ref().unwrap().lines;
            (
                lines.iter().map(|line| line.text.to_string()).collect(),
                lines
                    .iter()
                    .flat_map(|line| line.decoration_runs.iter().map(|run| run.color))
                    .collect(),
            )
        })
        .unwrap()
}

fn change_probed(
    cx: &mut TestAppContext,
    window: crate::WindowHandle<Probed>,
    change: impl FnOnce(&mut Probed),
) -> LayoutStats {
    cx.update_window(window.into(), |_, window, _| window.reset_layout_stats())
        .unwrap();
    window
        .update(cx, |view, _, cx| {
            change(view);
            cx.notify();
        })
        .unwrap();
    draw(cx, window.into())
}

/// A color changes nothing about how much room text takes: recolored text
/// keeps its measurement, is not shaped again, and is painted in the new
/// color.
#[test]
fn recolored_text_keeps_its_measurement_and_shows_the_new_color() {
    let mut cx = TestAppContext::single();
    let window = probed(&mut cx, 1000., false);
    draw(&mut cx, window.into());
    draw(&mut cx, window.into());

    let blue = crate::blue();
    let stats = change_probed(&mut cx, window, |view| view.color = blue);
    assert!(
        stats.measurements_kept > 0 && stats.measure_calls == 0,
        "a recolor should keep the measurement: {stats:?}"
    );
    assert_eq!(stats.lines_shaped, 0, "nor shape anything: {stats:?}");
    let (_, colors) = probed_lines(&mut cx, window);
    assert!(
        !colors.is_empty() && colors.iter().all(|color| *color == blue),
        "the text should be painted in the new color: {colors:?}"
    );
}

/// Text recolored and then measured again, because it was offered another
/// width, is shaped in the new color, not the one it was first shaped in.
#[test]
fn text_measured_again_after_a_recolor_is_shaped_in_the_new_color() {
    let mut cx = TestAppContext::single();
    let window = probed(&mut cx, 1000., false);
    draw(&mut cx, window.into());
    let blue = crate::blue();
    change_probed(&mut cx, window, |view| view.color = blue);
    change_probed(&mut cx, window, |view| view.width = px(60.));

    let (lines, colors) = probed_lines(&mut cx, window);
    let wraps: usize = window
        .update(&mut cx, |view, _, _| {
            let layout = view.layout.borrow().clone().unwrap();
            let inner = layout.0.borrow();
            inner
                .as_ref()
                .unwrap()
                .lines
                .iter()
                .map(|line| line.wrap_boundaries.len())
                .sum()
        })
        .unwrap();
    assert!(wraps > 0, "the narrow box should wrap the text: {lines:?}");
    assert!(
        colors.iter().all(|color| *color == blue),
        "text measured again should keep the new color: {colors:?}"
    );
}

/// Unchanged text leaves its node the closure and inputs of the element that
/// measured it first. Measured again, because it was offered another width,
/// it has to be measured into the layout of the element drawn now, which is
/// the one painted and asked for positions.
#[test]
fn text_kept_as_it_was_and_measured_again_lands_in_the_new_elements_layout() {
    let mut cx = TestAppContext::single();
    let window = probed(&mut cx, 1000., false);
    draw(&mut cx, window.into());
    for _ in 0..3 {
        let stats = change_probed(&mut cx, window, |_| {});
        assert!(
            stats.measurements_kept > 0 && stats.lines_shaped == 0,
            "unchanged text should keep its measurement: {stats:?}"
        );
        let (lines, _) = probed_lines(&mut cx, window);
        assert_eq!(lines, vec![PROBED_TEXT.to_string()]);
    }

    change_probed(&mut cx, window, |view| view.width = px(60.));
    let (narrow, _) = probed_lines(&mut cx, window);
    assert!(
        narrow.len() == 1 && narrow[0] == PROBED_TEXT,
        "one line of text, wrapped: {narrow:?}"
    );
    let wraps: usize = window
        .update(&mut cx, |view, _, _| {
            let layout = view.layout.borrow().clone().unwrap();
            let inner = layout.0.borrow();
            let inner = inner.as_ref().unwrap();
            assert!(inner.size.unwrap().width <= px(60.));
            inner
                .lines
                .iter()
                .map(|line| line.wrap_boundaries.len())
                .sum()
        })
        .unwrap();
    assert!(wraps > 0, "the narrow box should wrap the text");

    change_probed(&mut cx, window, |view| view.width = px(1000.));
    let wraps: usize = window
        .update(&mut cx, |view, _, _| {
            let layout = view.layout.borrow().clone().unwrap();
            let inner = layout.0.borrow();
            inner
                .as_ref()
                .unwrap()
                .lines
                .iter()
                .map(|line| line.wrap_boundaries.len())
                .sum()
        })
        .unwrap();
    assert_eq!(wraps, 0, "the wide box should not wrap the text");
}

/// Only truncating text takes a line wrapper, so the one path that does has
/// to go on truncating: cut short with an ellipsis in a box too narrow for
/// it, and whole again once the box is wide enough.
#[test]
fn text_that_truncates_is_truncated_and_widening_it_shows_it_whole() {
    let mut cx = TestAppContext::single();
    let window = probed(&mut cx, 30., true);
    draw(&mut cx, window.into());
    let (narrow, _) = probed_lines(&mut cx, window);
    assert_eq!(
        narrow.len(),
        1,
        "truncated text stays on one line: {narrow:?}"
    );
    assert!(
        narrow[0].ends_with('…') && narrow[0].len() < PROBED_TEXT.len(),
        "text in a narrow box should be cut short with an ellipsis: {narrow:?}"
    );

    change_probed(&mut cx, window, |view| view.width = px(1000.));
    let (wide, _) = probed_lines(&mut cx, window);
    assert_eq!(
        wide,
        vec![PROBED_TEXT.to_string()],
        "text in a box wide enough for it should be shown whole"
    );
}

/// Replacing decorations in place has to land exactly where shaping the same
/// text with the new runs would have; otherwise recolored text paints the
/// wrong colors on the wrong characters, and nothing in the layout shows it.
#[test]
fn replacing_decorations_in_place_lands_where_reshaping_would() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, _| crate::Empty);
    cx.update_window(window.into(), |_, window, _| {
        let text = SharedString::from("hello\nworld wide");
        let font = window.text_style().font();
        let run = |len, color| crate::TextRun {
            len,
            font: font.clone(),
            color,
            background_color: None,
            underline: None,
            strikethrough: None,
        };
        let (red, blue, green) = (crate::red(), crate::blue(), crate::green());
        // Same lengths and boundaries, other colors.
        let before = [run(6, red), run(10, blue)];
        let after = [run(6, green), run(10, red)];
        let system = window.text_system();
        let mut recolored = system
            .shape_text(text.clone(), px(14.), &before, None, None)
            .unwrap();
        let reshaped = system
            .shape_text(text, px(14.), &after, None, None)
            .unwrap();
        crate::fast::text::update_decoration_runs(&mut recolored, &after);

        assert_eq!(recolored.len(), reshaped.len());
        for (recolored, reshaped) in recolored.iter().zip(reshaped.iter()) {
            assert_eq!(recolored.text, reshaped.text);
            assert_eq!(recolored.decoration_runs, reshaped.decoration_runs);
        }
    })
    .unwrap();
}

/// A layout something still holds from an earlier frame keeps what it was
/// measured to, though the next frame's element takes the measurement over.
#[test]
fn a_text_layout_held_from_an_earlier_frame_keeps_its_lines() {
    let mut cx = TestAppContext::single();
    let window = probed(&mut cx, 1000., false);
    draw(&mut cx, window.into());
    let held = window
        .update(&mut cx, |view, _, _| view.layout.borrow().clone().unwrap())
        .unwrap();
    let stats = change_probed(&mut cx, window, |_| {});
    assert!(
        stats.measurements_kept > 0,
        "the next frame should take the measurement over: {stats:?}"
    );
    let lines = held
        .0
        .borrow()
        .as_ref()
        .map(|inner| inner.lines.len())
        .unwrap_or(0);
    assert_eq!(lines, 1, "the held layout should still have its line");
}

/// Text in a box that is either as wide as its text, or of a fixed width.
struct Fitted {
    text: &'static str,
    width: Option<crate::Pixels>,
    layout: std::rc::Rc<std::cell::RefCell<Option<crate::TextLayout>>>,
}

impl Render for Fitted {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        use crate::prelude::FluentBuilder as _;
        let text = crate::StyledText::new(self.text);
        *self.layout.borrow_mut() = Some(text.layout().clone());
        div().flex().items_start().child(
            div()
                .when_some(self.width, |this, width| this.w(width))
                .child(text),
        )
    }
}

fn fitted(
    cx: &mut TestAppContext,
    text: &'static str,
    width: Option<crate::Pixels>,
) -> crate::WindowHandle<Fitted> {
    let window = cx.add_window(move |_, _| Fitted {
        text,
        width,
        layout: Default::default(),
    });
    draw(cx, window.into());
    window
}

fn fitted_lines(cx: &mut TestAppContext, window: crate::WindowHandle<Fitted>) -> Vec<String> {
    window
        .update(cx, |view, _, _| {
            let layout = view.layout.borrow().clone().unwrap();
            let inner = layout.0.borrow();
            let lines = &inner.as_ref().unwrap().lines;
            lines
                .iter()
                .map(|line| format!("{} ({} wraps)", line.text, line.wrap_boundaries().len()))
                .collect()
        })
        .unwrap()
}

/// New text on a node is measured under the constraints the node's last text
/// was, to find whether it takes the same room. When it does not, it has to
/// be laid out as though it had never been measured. The last text wrapped
/// in a narrow box: had the new text kept its measurement in that box, it
/// would have answered Taffy's probe for its unwrapped width with the box's
/// width, and wrapped there once the box let it be as wide as it likes.
#[test]
fn new_text_measured_under_the_last_texts_constraints_is_laid_out_afresh() {
    // As long as each other unwrapped, in a font whose characters are all
    // one width, and breaking into lines of other lengths in a narrow box.
    const WRAPPED: &str = "aaaa bbbb cccc dddd";
    const NEW: &str = "aaaaaaa bbbbbbbbbbb";
    let mut cx = TestAppContext::single();
    let window = fitted(&mut cx, WRAPPED, Some(px(100.)));
    assert_ne!(
        fitted_lines(&mut cx, window),
        [format!("{WRAPPED} (0 wraps)")],
        "the box should wrap the first text"
    );
    window
        .update(&mut cx, |view, _, cx| {
            view.text = NEW;
            view.width = None;
            cx.notify();
        })
        .unwrap();
    draw(&mut cx, window.into());

    let fresh = fitted(&mut cx, NEW, None);
    assert_eq!(fitted_lines(&mut cx, fresh), [format!("{NEW} (0 wraps)")]);
    assert_eq!(fitted_lines(&mut cx, window), fitted_lines(&mut cx, fresh));
}

const FLEXED_TEXT: &str =
    "a heading long enough to wrap onto several lines in the narrow column it is laid out in";

/// Text that takes the rest of a row (`flex_1`, allowed to shrink to nothing),
/// in a column capped at a width, beside a line that changes every frame.
struct FlexedText {
    tick: u32,
    layout: std::rc::Rc<std::cell::RefCell<Option<crate::TextLayout>>>,
}

impl Render for FlexedText {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        let text = crate::StyledText::new(FLEXED_TEXT);
        *self.layout.borrow_mut() = Some(text.layout().clone());
        let content = div()
            .flex()
            .flex_col()
            .child(div().flex().child(div().flex_1().min_w_0().child(text)))
            .child(SharedString::from(format!("frame {}", self.tick)));
        div().flex().child(
            div().w_full().max_w(px(300.)).child(
                div().flex().flex_col().child(
                    div()
                        .flex()
                        .flex_col()
                        .w_full()
                        .child(div().flex().flex_col().min_w_0().w_full().child(content)),
                ),
            ),
        )
    }
}

/// A measured leaf paints what its last measurement produced, and Taffy, which
/// places a retained node from its cache, can still measure the leaf under
/// other constraints when a node above it is laid out again. Here the line
/// beside the row changes, the row is sized to its content once more, and the
/// text, measured at width zero for it, would be painted one glyph to a line
/// in the box it was laid out in. It has to be painted in as many lines as its
/// box is tall, every frame.
#[test]
fn text_laid_out_from_the_cache_paints_the_lines_of_its_box() {
    let mut cx = TestAppContext::single();
    let window = cx.add_window(|_, _| FlexedText {
        tick: 0,
        layout: Default::default(),
    });
    for frame in 0..3 {
        window
            .update(&mut cx, |view, _, cx| {
                view.tick = frame;
                cx.notify();
            })
            .unwrap();
        draw(&mut cx, window.into());
        let (lines, bounds, line_height) = window
            .update(&mut cx, |view, _, _| {
                let layout = view.layout.borrow().clone().unwrap();
                (
                    layout.wrapped_text().lines().count(),
                    layout.bounds(),
                    layout.line_height(),
                )
            })
            .unwrap();
        assert!(lines > 1, "the text should wrap in its column: {lines}");
        assert_eq!(
            bounds.size.height,
            line_height * lines as f32,
            "frame {frame}: {lines} lines painted in {bounds:?}"
        );
    }
}

const DETACHED_TEXT: &str = "laid out where no layout reaches it";

/// Lays text out without making its node a child of its own, so that no
/// layout computed this frame reaches the text's node and Taffy never
/// measures it, then prepaints and paints the text in its own bounds all the
/// same: text reaching prepaint unmeasured, as a gap in retention left it.
struct Detached {
    text: Option<crate::StyledText>,
    layout: std::rc::Rc<std::cell::RefCell<Option<crate::TextLayout>>>,
}

impl crate::Element for Detached {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<crate::ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&crate::GlobalElementId>,
        _: Option<&crate::InspectorElementId>,
        window: &mut Window,
        cx: &mut crate::App,
    ) -> (crate::LayoutId, ()) {
        let mut text = crate::StyledText::new(DETACHED_TEXT);
        *self.layout.borrow_mut() = Some(text.layout().clone());
        crate::Element::request_layout(&mut text, None, None, window, cx);
        self.text = Some(text);
        let mut style = crate::Style::default();
        style.size.width = px(120.).into();
        style.size.height = px(40.).into();
        (window.request_layout(style, [], cx), ())
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
        let text = self.text.as_mut().unwrap();
        crate::Element::prepaint(text, None, None, bounds, &mut (), window, cx);
    }

    fn paint(
        &mut self,
        _: Option<&crate::GlobalElementId>,
        _: Option<&crate::InspectorElementId>,
        bounds: crate::Bounds<crate::Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut crate::App,
    ) {
        let text = self.text.as_mut().unwrap();
        crate::Element::paint(text, None, None, bounds, &mut (), &mut (), window, cx);
    }
}

impl IntoElement for Detached {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

struct DetachedView {
    layout: std::rc::Rc<std::cell::RefCell<Option<crate::TextLayout>>>,
}

impl Render for DetachedView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(Detached {
            text: None,
            layout: self.layout.clone(),
        })
    }
}

/// Text that reaches prepaint unmeasured panics upstream. It is measured
/// there instead, as plain text at the width it is prepainted at, and
/// painted.
#[test]
fn text_reaching_prepaint_unmeasured_is_measured_there_and_painted() {
    let mut cx = TestAppContext::single();
    let layout = std::rc::Rc::default();
    let window = cx.add_window(|_, _| DetachedView {
        layout: std::rc::Rc::clone(&layout),
    });
    for _ in 0..3 {
        window.update(&mut cx, |_, _, cx| cx.notify()).unwrap();
        draw(&mut cx, window.into());

        let layout = layout.borrow().clone().unwrap();
        assert_eq!(layout.text(), DETACHED_TEXT);
        assert_eq!(
            layout.0.borrow().as_ref().unwrap().wrap_width,
            Some(px(120.))
        );
        // Paint goes ahead only for text that was measured and prepainted.
        assert_eq!(layout.bounds().size.width, px(120.));
    }
}

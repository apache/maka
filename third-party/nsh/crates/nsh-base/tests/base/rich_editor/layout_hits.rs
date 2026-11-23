//! Presses and shift-presses land on character edges when a mark is in a
//! larger font with inline padding (including on lines with inline
//! attachments): the editor hit tests with the text engine's layout, whose
//! padding placeholders are not document offsets.

use nsh_base::rich_editor::view::RichEditorClasses;

use super::*;

/// `ab` `cd` (inline code: a larger font, padded) `ef`: positions 1..7.
fn mixed_doc() -> Value {
    json!({"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "ab"},
        {"type": "text", "text": "cd", "marks": [{"type": "code"}]},
        {"type": "text", "text": "ef"},
    ]}]})
}

/// `ab` + 80pt inline image + `cd` (padded 24px code) + `ef`: positions 1..8.
fn mixed_with_image_doc() -> Value {
    json!({"type": "doc", "content": [{"type": "paragraph", "content": [
        {"type": "text", "text": "ab"},
        {"type": "image", "attrs": {"src": "data:image/png;base64,", "width": 80, "height": 16}},
        {"type": "text", "text": "cd", "marks": [{"type": "code"}]},
        {"type": "text", "text": "ef"},
    ]}]})
}

#[derive(Clone, PartialEq, Props)]
struct MixedProps {
    session: Option<EditorSession>,
}

#[component]
fn Mixed(props: MixedProps) -> impl IntoElement {
    let session = props.session.clone().expect("a session");
    let asked = session.clone();
    let read = {
        let session = session.clone();
        move || {
            let state = session.state();
            let s = state.selection();
            format!("Sel {}-{}", s.from(), s.to())
        }
    };
    let shown = signal(read());
    let measured = signal(String::new());
    view()
        .child(
            view().test_id("editor").w(px(600.0)).h(px(400.0)).child(
                rich_editor()
                    .editor(session)
                    .classes({
                        let mut classes = RichEditorClasses::default();
                        classes.nodes = Some([("paragraph".into(), "text-[16px]".into())].into());
                        classes.marks = Some([("code".into(), "px-2 text-[24px]".into())].into());
                        classes
                    })
                    .size_full()
                    .on_selection_change(move |_: &_| shown.set(read())),
            ),
        )
        .child(
            view()
                .on_press(move || {
                    let img = asked.node_rect(3).map(|b| b.size.width.0.round());
                    let x3 = asked.coords_at_pos(3).map_or(-1.0, |b| b.origin.x.0);
                    let x4 = asked.coords_at_pos(4).map_or(-1.0, |b| b.origin.x.0);
                    measured.set(format!("Img {:?} gap {}", img, (x4 - x3).round()));
                })
                .child(text("Measure")),
        )
        .child(text(move || shown.get()))
        .child(text(move || measured.get()))
        .child(text("Ready"))
}

fn start_mixed_doc(doc: Value) -> Headless {
    let session = session(doc);
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<Mixed>(move || {
            MixedProps {
                session: Some(session.clone()),
            }
        }))
    };
    config.environment.os = Os::Linux;
    config.environment.apple_keyboard = false;
    config.environment.idiom = Idiom::Desktop;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
    app
}

/// The paragraph's laid-out text (padding placeholders included) and its
/// headless layout (characters at `0.55 × font_size`, attachments at their
/// own widths).
fn laid(app: &Headless) -> (String, Arc<nsh_core::AttributedText>, nsh_core::TextLayout) {
    use nsh_core::TextEngine as _;
    let paragraph = app
        .screen()
        .layout_nodes()
        .into_iter()
        .find_map(|node| {
            node.text
                .filter(|t| t.text.text.replace(nsh_core::ATTACHMENT_CHAR, "") == "abcdef")
        })
        .expect("the paragraph's text");
    let engine = nsh_core::ApproxTextEngine;
    let prepared = engine.prepare(&paragraph.text);
    let layout = engine.layout(&prepared, paragraph.content.size);
    (paragraph.text.text.to_string(), paragraph.text, layout)
}

/// A press at `at`, apart from the last one (not a double click).
fn press(app: &mut Headless, selector: &str, at: Point<Points>) {
    app.wait(Duration::from_millis(600)).unwrap();
    app.press_at(selector, at).unwrap();
}

/// Just after the left edge of laid-out character `k`.
fn edge(layout: &nsh_core::TextLayout, k: u32) -> Point<Points> {
    use nsh_core::{Affinity, TextEngine as _, TextPosition};
    let x = nsh_core::ApproxTextEngine
        .caret_rect(layout, TextPosition::new(k, Affinity::Downstream))
        .expect("laid-out character edge")
        .origin
        .x;
    Point::new(x + px(1.0), px(2.0))
}

#[test]
fn presses_in_a_padded_larger_mark_land_on_character_edges() {
    let mut app = start_mixed_doc(mixed_doc());
    let (text, attributed, layout) = laid(&app);
    let ph = nsh_core::ATTACHMENT_CHAR;
    // The core pads the code span with a placeholder on each side.
    assert_eq!(text, format!("ab{ph}cd{ph}ef"), "{attributed:?}");
    // Laid-out index → document position: each placeholder before it is
    // no offset of the text.
    for (k, pos) in [(0, 1), (1, 2), (3, 3), (4, 4), (6, 5), (7, 6), (8, 7)] {
        press(&mut app, "text:abcdef", edge(&layout, k));
        see(&mut app, &format!("Sel {pos}-{pos}"));
    }
    // "d" (laid 4, after a placeholder) to "f" (laid 7, after both: position 6): a
    // shift-press extends to the character edge, not past the padding.
    press(&mut app, "text:abcdef", edge(&layout, 4));
    see(&mut app, "Sel 4-4");
    app.hold_keys("shift", true).unwrap();
    press(&mut app, "text:abcdef", edge(&layout, 7));
    app.hold_keys("shift", false).unwrap();
    see(&mut app, "Sel 4-6");
}

/// A paragraph with both an inline image (80pt) and a padded larger-font mark
/// stays on `TextGeometry` instead of falling back to an estimator: the image's
/// `node_rect` excludes adjacent padding spacers, and presses after both the
/// image and the spacers land on the matching character edges.
#[test]
fn presses_and_carets_stay_aligned_with_an_inline_image_and_padded_mark() {
    let mut app = start_mixed_doc(mixed_with_image_doc());
    let (text, attributed, layout) = laid(&app);
    let ph = nsh_core::ATTACHMENT_CHAR;
    // `ab` + image attachment + left pad + `cd` + right pad + `ef`.
    assert_eq!(text, format!("ab{ph}{ph}cd{ph}ef"), "{attributed:?}");
    app.press("text:Measure").unwrap();
    // Image's own box is 80pt; caret after it steps past both the 80pt image
    // and the 8pt `px-2` left spacer before `cd`.
    see(&mut app, "Img Some(80.0) gap 88");
    let selector = format!("text:ab{ph}cdef");
    for (k, pos) in [(0, 1), (1, 2), (4, 4), (5, 5), (7, 6), (8, 7), (9, 8)] {
        press(&mut app, &selector, edge(&layout, k));
        see(&mut app, &format!("Sel {pos}-{pos}"));
    }
    press(&mut app, &selector, edge(&layout, 5));
    see(&mut app, "Sel 5-5");
    app.hold_keys("shift", true).unwrap();
    press(&mut app, &selector, edge(&layout, 8));
    app.hold_keys("shift", false).unwrap();
    see(&mut app, "Sel 5-7");
}

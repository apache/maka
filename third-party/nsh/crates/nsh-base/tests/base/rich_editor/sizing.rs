//! An editor without a height is as tall as its document, as a block with
//! `height: auto`: it grows with each line, stops at its `max-height` and
//! scrolls past it, holds its `min-height`; a set height stays.

use nsh_testing::LayoutNode;

use super::*;

#[derive(Clone, PartialEq, Props)]
struct SizedProps {
    sessions: Vec<EditorSession>,
}

/// Four editors in a column 300 points wide: `auto` without a height,
/// `capped` at 60 points at most, `held` at 50 points at least, `fixed` 120
/// points tall.
#[component]
fn Sized(props: SizedProps) -> impl IntoElement {
    let Ok([auto, capped, held, fixed]) = <[EditorSession; 4]>::try_from(props.sessions.clone())
    else {
        panic!("four sessions");
    };
    view()
        .w(px(300.0))
        .child(view().test_id("auto").child(rich_editor().editor(auto)))
        .child(
            view()
                .test_id("capped")
                .child(rich_editor().editor(capped).max_h(px(60.0))),
        )
        .child(
            view()
                .test_id("held")
                .child(rich_editor().editor(held).min_h(px(50.0))),
        )
        .child(
            view()
                .test_id("fixed")
                .child(rich_editor().editor(fixed).h(px(120.0))),
        )
        .child(text("Ready"))
}

fn start_sized() -> Headless {
    let config = EngineConfig {
        viewport: Size::new(px(800.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Sized>(|| SizedProps {
            sessions: (0..4).map(|_| session(paragraphs(&["one"]))).collect(),
        }))
    };
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Ready").unwrap();
    app
}

fn node(app: &Headless, test_id: &str) -> LayoutNode {
    app.screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.test_id.as_deref() == Some(test_id))
        .unwrap_or_else(|| panic!("no view {test_id}"))
}

fn height(app: &Headless, test_id: &str) -> f32 {
    node(app, test_id).bounds.size.height.0
}

/// The bounds of the text view `text`.
fn text_bounds(app: &Headless, text: &str) -> Bounds<Points> {
    app.screen()
        .layout_nodes()
        .into_iter()
        .find(|n| n.text.as_ref().is_some_and(|t| t.text.text == text))
        .unwrap_or_else(|| panic!("no text {text}"))
        .bounds
}

/// Types `lines` new lines at the end of editor `test_id`.
fn add_lines(app: &mut Headless, test_id: &str, lines: &[&str]) {
    app.type_text(&format!("id:{test_id}"), "").unwrap();
    keys(app, &["ctrl+end"]);
    for line in lines {
        keys(app, &["enter"]);
        app.type_text(&format!("id:{test_id}"), line).unwrap();
    }
    app.wait(Duration::from_millis(50)).unwrap();
}

#[test]
fn an_editor_without_a_height_is_as_tall_as_its_document() {
    let mut app = start_sized();
    let line = height(&app, "auto");
    assert!(line > 0.0, "one line shows");
    add_lines(&mut app, "auto", &["two", "three"]);
    let grown = height(&app, "auto");
    assert!(
        (grown - 3.0 * line).abs() < 1.0,
        "three lines: {grown} for lines of {line}"
    );
    keys(
        &mut app,
        &[
            "backspace",
            "backspace",
            "backspace",
            "backspace",
            "backspace",
            "backspace",
        ],
    );
    see(&mut app, "two");
    app.wait(Duration::from_millis(50)).unwrap();
    let shrunk = height(&app, "auto");
    assert!(
        (shrunk - 2.0 * line).abs() < 1.0,
        "back to two lines: {shrunk}"
    );
}

#[test]
fn past_its_max_height_an_editor_scrolls() {
    let mut app = start_sized();
    let line = height(&app, "auto");
    add_lines(&mut app, "capped", &["two", "three", "four", "five", "six"]);
    let editor = node(&app, "capped").bounds;
    assert_eq!(editor.size.height.0, 60.0);
    let content = app
        .screen()
        .layout_nodes()
        .into_iter()
        .filter(|n| n.bounds.origin == editor.origin)
        .find_map(|n| n.scroll)
        .and_then(|s| s.content_size)
        .expect("the editor's scroll view");
    assert!(content.height.0 >= 6.0 * line - 1.0, "{content:?}");
    // Scrolled to the caret: the last line inside, the first above.
    let last = text_bounds(&app, "six");
    assert!(
        last.bottom() <= editor.bottom() + px(0.5),
        "{last:?} in {editor:?}"
    );
    assert!(text_bounds(&app, "one").top() < editor.top());
}

#[test]
fn an_editor_holds_its_min_height_and_keeps_a_set_height() {
    let mut app = start_sized();
    let line = height(&app, "auto");
    assert_eq!(height(&app, "held"), 50.0);
    assert_eq!(height(&app, "fixed"), 120.0);
    add_lines(&mut app, "held", &["two", "three", "four", "five"]);
    assert!((height(&app, "held") - 5.0 * line).abs() < 1.0);
    add_lines(
        &mut app,
        "fixed",
        &["two", "three", "four", "five", "six", "seven", "eight"],
    );
    assert_eq!(height(&app, "fixed"), 120.0);
}

//! Touch selection on a phone: a long press selects the word under the
//! finger and opens the system's edit menu, whose actions edit through the
//! editor's own transactions (undo takes them back); a long press on blank
//! space places the caret with the caret's menu. The menu leaves out what
//! cannot apply.

use super::*;

/// One line, with `beta` at 6..10 (7..11 in the document).
const LINE: &str = "alpha beta gamma";

fn phone(doc: Value) -> Headless {
    start_with(doc, Os::Ios, true, Idiom::Phone)
}

/// The selection the app last heard (`from`, `to`).
fn selection(app: &Headless) -> (usize, usize) {
    let line = app
        .screen()
        .texts()
        .into_iter()
        .find_map(|t| t.strip_prefix("Sel ").map(str::to_owned))
        .expect("the selection's line");
    let (from, to) = line.split_once('-').unwrap();
    (from.parse().unwrap(), to.parse().unwrap())
}

fn labels(app: &Headless) -> Vec<String> {
    app.menu()
        .unwrap_or_default()
        .into_iter()
        .map(|e| e.label)
        .collect()
}

#[test]
fn a_long_press_selects_a_word_and_its_menu_copies_and_cuts_it() {
    let mut app = phone(paragraphs(&[LINE]));
    let at = char_point(&app, LINE, 7);
    app.long_press_at(&format!("text:{LINE}"), at).unwrap();
    assert_eq!(selection(&app), (7, 11));
    // Nothing on the clipboard: no Paste.
    assert_eq!(labels(&app), ["Cut", "Copy", "Select All"]);
    app.choose_menu_item("Copy").unwrap();
    assert_eq!(app.screen().clipboard(), Some("beta"));
    // With its HTML, as a keyboard copy writes it.
    assert_eq!(
        app.screen()
            .clipboard_item()
            .and_then(|item| item.html.as_deref()),
        Some(r#"<p data-pm-slice="1 1 []">beta</p>"#)
    );
    assert!(app.menu().is_none());
    // Cut, then undo: the word comes back.
    app.long_press_at(&format!("text:{LINE}"), at).unwrap();
    assert_eq!(labels(&app), ["Cut", "Copy", "Paste", "Select All"]);
    app.choose_menu_item("Cut").unwrap();
    see(&mut app, &doc("alpha  gamma"));
    keys(&mut app, &["cmd+z"]);
    see(&mut app, &doc(LINE));
}

#[test]
fn select_all_from_the_menu_selects_the_document() {
    let mut app = phone(paragraphs(&[LINE, "end"]));
    app.long_press(&format!("text:{LINE}")).unwrap();
    app.choose_menu_item("Select All").unwrap();
    see(&mut app, &format!("Sel 0-{}", LINE.len() + 2 + 5));
    // The menu opens again over everything, without Select All.
    assert_eq!(labels(&app), ["Cut", "Copy"]);
}

#[test]
fn a_long_press_on_blank_space_places_the_caret_with_its_menu() {
    // The middle of the line is in the spaces between its words.
    let line = "ab          cd";
    let mut app = phone(paragraphs(&[line]));
    let at = char_point(&app, line, 7);
    app.long_press_at(&format!("text:{line}"), at).unwrap();
    let (from, to) = selection(&app);
    assert!(
        from == to && from > 3 && from < 13,
        "the caret in the spaces: {from}-{to}"
    );
    // Nothing on the clipboard: no Paste.
    assert_eq!(labels(&app), ["Select All"]);
    app.choose_menu_item("Select All").unwrap();
    see(&mut app, &format!("Sel 0-{}", line.len() + 2));
    assert_eq!(labels(&app), ["Cut", "Copy"]);
}

#[test]
fn a_long_press_selects_with_the_pointer_meta() {
    let (mut app, noted) =
        super::selection::start_noting_pointer(paragraphs(&[LINE]), Os::Ios, Idiom::Phone);
    let at = char_point(&app, LINE, 7);
    app.long_press_at(&format!("text:{LINE}"), at).unwrap();
    see(&mut app, "Sel 7-11");
    assert_eq!(noted.lock().unwrap().last(), Some(&true));
}

/// An editor on a phone whose selection handles' knobs have typed styles
/// (`StyleRefinement`, as a Rust app types them): 17 points square, the
/// start's 23 wide (`selectionHandleStart` comes after `selectionHandle`).
#[component]
fn TypedKnobs(props: HarnessProps) -> impl IntoElement {
    use nsh_base::{rich_editor::view::RichEditorStyles, text_view::PartStyle};
    use nsh_core::element::StyleRefinement;

    let mut styles = RichEditorStyles::default();
    styles.selection_handle = Some(PartStyle(
        StyleRefinement::default().w(px(17.0)).h(px(17.0)).into(),
    ));
    styles.selection_handle_start = Some(PartStyle(StyleRefinement::default().w(px(23.0)).into()));
    view()
        .child(
            view().test_id("editor").w(px(360.0)).h(px(400.0)).child(
                rich_editor()
                    .editor(props.session.clone().expect("a session"))
                    .styles(styles)
                    .size_full(),
            ),
        )
        .child(text("Ready"))
}

#[test]
fn typed_selection_handle_styles_merge_in_order_the_later_winning() {
    let mut config = EngineConfig {
        viewport: Size::new(px(400.0), px(800.0)),
        ..EngineConfig::new(nsh_testing::windowed_root_with::<TypedKnobs>(|| {
            HarnessProps {
                session: Some(session(paragraphs(&[LINE]))),
            }
        }))
    };
    config.environment.os = Os::Ios;
    config.environment.apple_keyboard = true;
    config.environment.idiom = Idiom::Phone;
    let mut app = Headless::start(config).expect("the engine starts");
    see(&mut app, "Ready");
    let at = char_point(&app, LINE, 7);
    app.long_press_at(&format!("text:{LINE}"), at).unwrap();
    let sizes: Vec<(f32, f32)> = app
        .screen()
        .layout_nodes()
        .iter()
        .map(|n| (n.bounds.size.width.0, n.bounds.size.height.0))
        .collect();
    assert!(sizes.contains(&(23.0, 17.0)), "the start's knob: {sizes:?}");
    assert!(sizes.contains(&(17.0, 17.0)), "the end's knob: {sizes:?}");
}

//! Touch selection on a phone: a long press selects the word under the
//! finger and opens the system's edit menu, whose actions edit through the
//! editor's own transactions (undo takes them back); a long press on blank
//! space places the caret with the caret's menu. The menu leaves out what
//! cannot apply.

use super::*;

/// One line, whose middle is on `beta` (7..11).
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
    app.long_press(&format!("text:{LINE}")).unwrap();
    assert_eq!(selection(&app), (7, 11));
    // Nothing on the clipboard: no Paste.
    assert_eq!(labels(&app), ["Cut", "Copy", "Select All"]);
    app.choose_menu_item("Copy").unwrap();
    assert_eq!(app.screen().clipboard(), Some("beta"));
    assert!(app.menu().is_none());
    // Cut, then undo: the word comes back.
    app.long_press(&format!("text:{LINE}")).unwrap();
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
    app.long_press(&format!("text:{line}")).unwrap();
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

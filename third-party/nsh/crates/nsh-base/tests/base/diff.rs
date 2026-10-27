//! `DiffView`: a modified line shows side by side (or one over the other,
//! unified), unchanged lines between changes collapse into separators that
//! a press or the ref expands; the ref gives the changes and their stats,
//! and reverts or keeps a change, reporting the texts; a patch's lines are
//! numbered as in its file; a long text makes only the rows in view; line
//! numbers select lines, which the ref reads and sets; the ref moves from
//! change to change; the app's annotations show under their lines; and
//! several files show each under a header that collapses it.

use nsh_base::{
    DiffAnnotation, DiffChange, DiffExpand, DiffFile, DiffHunk, DiffLayout, DiffLineRange,
    DiffSide, DiffView, DiffViewApi, diff_view,
};
use nsh_core::{
    Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// The first old text.
    old: String,
    /// The first new text.
    new: String,
    /// A patch, shown instead of the texts.
    patch: Option<String>,
    /// The view's `layout`.
    layout: DiffLayout,
    /// The view's `annotations`, each drawn as `Note <id>`.
    annotations: Vec<DiffAnnotation>,
    /// The view's `softWrap`.
    soft_wrap: bool,
}

fn texts(old: &str, new: &str) -> HarnessProps {
    HarnessProps {
        old: old.into(),
        new: new.into(),
        patch: None,
        layout: DiffLayout::Split,
        annotations: Vec::new(),
        soft_wrap: false,
    }
}

/// An annotation `id` under `line` of `side`.
fn annotation(id: &str, side: DiffSide, line: u32) -> DiffAnnotation {
    let mut a = DiffAnnotation::default();
    a.id = id.to_string().into();
    a.side = side;
    a.line = line;
    a
}

/// `side start-end`, or `none`.
fn range_text(range: Option<DiffLineRange>) -> String {
    match range {
        Some(r) => format!("{:?} {}-{}", r.side, r.start, r.end),
        None => "none".into(),
    }
}

/// `line 1` to `line <count>`, a line each.
fn numbered(count: usize) -> Vec<String> {
    (1..=count).map(|i| format!("line {i}")).collect()
}

/// The hunks as text: `old_start,old_lines>new_start,new_lines` each.
fn hunks_text(hunks: &[DiffHunk]) -> String {
    hunks
        .iter()
        .map(|h| {
            format!(
                "{},{}>{},{}",
                h.old_start, h.old_lines, h.new_start, h.new_lines
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A diff view of 800 × 400 at the top left (in a view `diff`); the app
/// keeps the texts it reports (`Old "…"`, `New "…"` while short), counts
/// its changes and has buttons for the ref's methods.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let old = signal(props.old.clone());
    let new = signal(props.new.clone());
    let changes = signal(0u32);
    let stats = signal(String::from("-"));
    let hunks = signal(String::from("-"));
    let selection = signal(String::from("-"));
    let selected = signal(String::from("-"));
    let hunk = signal(String::from("-"));
    let pressed = signal(String::from("-"));
    let files = signal(String::from("-"));
    let toggled = signal(String::from("-"));
    let dv = component_ref::<DiffView>();
    let api = move |f: &dyn Fn(&DiffViewApi)| {
        if let Some(api) = dv.api::<DiffViewApi>() {
            f(&api);
        }
    };
    let button = move |id: &str, f: Box<dyn Fn(&DiffViewApi)>| {
        view()
            .test_id(id)
            .w(px(20.0))
            .h(px(20.0))
            .on_press(move || api(&*f))
    };
    let mut el = diff_view()
        .layout(props.layout)
        .soft_wrap(props.soft_wrap)
        .on_change(move |c: &DiffChange| {
            old.set(c.old_value.clone());
            new.set(c.new_value.clone());
            changes.update(|n| *n += 1);
        })
        .on_line_selection_change(move |r: &Option<DiffLineRange>| selection.set(range_text(*r)))
        .on_line_number_press(move |l: &nsh_base::DiffLine| {
            pressed.set(format!("{:?} {}", l.side, l.line))
        })
        .annotations(props.annotations.clone())
        .render_annotation(|a: &DiffAnnotation| text(format!("Note {}", a.id)))
        .on_file_toggle(move |f: &DiffFile| toggled.set(format!("{} {}", f.index, f.collapsed)))
        .component_ref(&dv)
        .size_full();
    el = match props.patch.clone() {
        Some(patch) => el.patch(patch),
        None => el
            .old_value(move || SharedString::from(old.get()))
            .new_value(move || SharedString::from(new.get())),
    };
    // Long texts would be measured as one text: only short ones show.
    let shown = |s: String| {
        if s.len() < 2000 {
            format!("{s:?}")
        } else {
            "…".into()
        }
    };
    view()
        .child(view().test_id("diff").w(px(800.0)).h(px(400.0)).child(el))
        .child(text(move || format!("Old {}", shown(old.get()))))
        .child(text(move || format!("New {}", shown(new.get()))))
        .child(text(move || format!("Changes {}", changes.get())))
        .child(text(move || format!("Stats {}", stats.get())))
        .child(text(move || format!("Hunks {}", hunks.get())))
        .child(text(move || format!("Selection {}", selection.get())))
        .child(text(move || format!("Selected {:?}", selected.get())))
        .child(text(move || format!("Hunk {}", hunk.get())))
        .child(text(move || format!("Pressed {}", pressed.get())))
        .child(text(move || format!("Files {}", files.get())))
        .child(text(move || format!("Toggled {}", toggled.get())))
        .child(
            view()
                .flex_row()
                .child(button(
                    "read",
                    Box::new(move |a| {
                        let s = a.stats();
                        stats.set(format!("{} {} {}", s.added, s.deleted, s.hunks));
                        hunks.set(hunks_text(&a.hunks()));
                    }),
                ))
                .child(button("revert-0", Box::new(|a| a.revert_hunk(0))))
                .child(button("revert-1", Box::new(|a| a.revert_hunk(1))))
                .child(button("accept-0", Box::new(|a| a.accept_hunk(0))))
                .child(button(
                    "expand-1-down",
                    Box::new(|a| a.expand(1, Some(DiffExpand::Down), Some(2))),
                ))
                .child(button("expand-all", Box::new(|a| a.expand_all())))
                .child(button("collapse-all", Box::new(|a| a.collapse_all())))
                .child(button(
                    "select-old",
                    Box::new(move |a| {
                        let mut range = DiffLineRange::default();
                        range.side = DiffSide::Old;
                        range.start = 8;
                        range.end = 9;
                        a.set_selected_lines(Some(range));
                        selection.set(range_text(a.selected_lines()));
                        selected.set(a.selected_text());
                    }),
                ))
                .child(button(
                    "next",
                    Box::new(move |a| {
                        let next = a.next_hunk();
                        hunk.set(format!("{next:?}"));
                    }),
                ))
                .child(button(
                    "current",
                    Box::new(move |a| hunk.set(format!("{:?} now", a.current_hunk()))),
                ))
                .child(button(
                    "files",
                    Box::new(move |a| {
                        let list: Vec<String> = a
                            .files()
                            .iter()
                            .map(|f| {
                                format!("{}:+{}-{}@{}", f.index, f.added, f.deleted, f.first_hunk)
                            })
                            .collect();
                        files.set(list.join(" "));
                    }),
                ))
                .child(button(
                    "toggle-a",
                    Box::new(|a| a.toggle_file("a.rs".into())),
                )),
        )
}

/// The harness of `props` on a Linux desktop's headless surface, shown.
fn start(props: HarnessProps) -> Headless {
    start_on(props, Os::Linux, Idiom::Desktop)
}

/// The harness of `props` on `os` in `idiom`, shown.
fn start_on(props: HarnessProps, os: Os, idiom: Idiom) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(900.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = os;
    config.environment.idiom = idiom;
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Changes 0").unwrap();
    app
}

fn see(app: &mut Headless, text: &str) {
    app.wait_for(&format!("text:{text}")).unwrap();
}

/// How many texts on screen read `text` (spaces around them aside).
fn count(app: &Headless, text: &str) -> usize {
    app.screen()
        .texts()
        .iter()
        .filter(|t| t.trim() == text)
        .count()
}

/// The texts on screen that start with `prefix`.
fn count_starting(app: &Headless, prefix: &str) -> usize {
    app.screen()
        .texts()
        .iter()
        .filter(|t| t.trim_start().starts_with(prefix))
        .count()
}

/// Twenty lines, line 10 changed to `line ten`: one hunk, 6 unchanged
/// lines collapsed above it and 7 below (3 of context on each side).
fn one_change() -> HarnessProps {
    let old = numbered(20);
    let mut new = old.clone();
    new[9] = "line ten".into();
    texts(&old.join("\n"), &new.join("\n"))
}

/// Twenty lines, line 3 changed to `line three` and line 15 deleted.
fn two_changes() -> (String, String) {
    let old = numbered(20);
    let mut new = old.clone();
    new[2] = "line three".into();
    new.remove(14);
    (old.join("\n"), new.join("\n"))
}

#[test]
fn a_modified_line_shows_side_by_side() {
    let mut app = start(one_change());
    see(&mut app, "line ten");
    // The old line on the left, the new one on the right, in one row.
    assert_eq!(count(&app, "line 10"), 1);
    assert_eq!(count(&app, "line ten"), 1);
    // Context lines show on both sides, numbered on both.
    assert_eq!(count(&app, "line 7"), 2);
    assert_eq!(count(&app, "line 13"), 2);
    assert_eq!(count(&app, "10"), 2);
    assert_eq!(count(&app, "7"), 2);
    // Lines further away are collapsed.
    assert!(!app.shows("line 1") && !app.shows("line 6"));
    assert!(!app.shows("line 14") && !app.shows("line 20"));
    assert!(app.shows("⋯ 6") && app.shows("⋯ 7"));
}

#[test]
fn unified_shows_the_deleted_line_above_the_added_one() {
    let mut app = start(HarnessProps {
        layout: DiffLayout::Unified,
        ..one_change()
    });
    see(&mut app, "line ten");
    // One column: each line once.
    assert_eq!(count(&app, "line 10"), 1);
    assert_eq!(count(&app, "line ten"), 1);
    assert_eq!(count(&app, "line 7"), 1);
    // A context row numbers both sides; the deleted row its old number,
    // the added row its new one.
    assert_eq!(count(&app, "7"), 2);
    assert_eq!(count(&app, "10"), 2);
    // The deleted line's row is above the added line's.
    let texts = app.screen().texts().join("\n");
    let deleted = texts.find("line 10").unwrap();
    let added = texts.find("line ten").unwrap();
    assert!(deleted < added, "the deleted line comes first");
    assert!(app.shows("⋯ 6") && app.shows("⋯ 7"));
}

#[test]
fn a_press_on_a_separator_shows_its_lines() {
    let mut app = start(one_change());
    see(&mut app, "⋯ 6");
    app.press("text:⋯ 6").unwrap();
    see(&mut app, "line 1");
    see(&mut app, "line 6");
    assert!(!app.shows("⋯ 6"));
    assert!(app.shows("⋯ 7"));
}

#[test]
fn the_ref_expands_part_of_a_gap_everything_and_collapses_again() {
    let mut app = start(one_change());
    see(&mut app, "⋯ 7");
    // Two lines below the change above the last separator.
    app.press("id:expand-1-down").unwrap();
    see(&mut app, "⋯ 5");
    see(&mut app, "line 15");
    assert!(!app.shows("line 16"));
    app.press("id:expand-all").unwrap();
    see(&mut app, "line 20");
    see(&mut app, "line 1");
    assert_eq!(count_starting(&app, "⋯"), 0);
    app.press("id:collapse-all").unwrap();
    see(&mut app, "⋯ 6");
    see(&mut app, "⋯ 7");
    assert!(!app.shows("line 1") && !app.shows("line 20"));
}

#[test]
fn the_ref_gives_the_hunks_and_stats() {
    let (old, new) = two_changes();
    let mut app = start(texts(&old, &new));
    see(&mut app, "line three");
    app.press("id:read").unwrap();
    see(&mut app, "Stats 1 2 2");
    see(&mut app, "Hunks 2,1>2,1 14,1>14,0");
}

#[test]
fn reverting_a_hunk_puts_its_old_lines_back_and_reports_the_texts() {
    let (old, new) = two_changes();
    let mut app = start(texts(&old, &new));
    see(&mut app, "line three");
    app.press("id:revert-1").unwrap();
    see(&mut app, "Changes 1");
    // The old text stays; the new one has line 15 again.
    let mut expected = numbered(20);
    expected[2] = "line three".into();
    see(&mut app, &format!("Old {old:?}"));
    see(&mut app, &format!("New {:?}", expected.join("\n")));
    app.press("id:read").unwrap();
    see(&mut app, "Stats 1 1 1");
    see(&mut app, "Hunks 2,1>2,1");
}

#[test]
fn accepting_a_hunk_makes_its_new_lines_the_old_text_s() {
    let (old, new) = two_changes();
    let mut app = start(texts(&old, &new));
    see(&mut app, "line three");
    app.press("id:accept-0").unwrap();
    see(&mut app, "Changes 1");
    // The old text has `line three` now, and still line 15.
    let mut expected = numbered(20);
    expected[2] = "line three".into();
    see(&mut app, &format!("Old {:?}", expected.join("\n")));
    see(&mut app, &format!("New {new:?}"));
    app.press("id:read").unwrap();
    see(&mut app, "Stats 0 1 1");
    // The change shows no more: `line 3` is on neither side.
    assert!(!app.shows("line 3"));
}

#[test]
fn a_patch_numbers_its_lines_as_in_its_file() {
    let patch = "\
--- a/src/main.rs
+++ b/src/main.rs
@@ -10,3 +10,4 @@ fn main() {
     let a = 1;
-    let b = 2;
+    let b = 3;
+    let c = 4;
     println!(\"{a}\");
";
    let mut app = start(HarnessProps {
        patch: Some(patch.into()),
        ..texts("", "")
    });
    see(&mut app, "let c = 4;");
    // The hunk's header is its separator.
    see(&mut app, "fn main() {");
    for shown in [
        "let a = 1;",
        "let b = 2;",
        "let b = 3;",
        "println!(\"{a}\");",
    ] {
        assert!(app.shows(shown), "{shown} shows");
    }
    // Old lines 10–12, new lines 10–13.
    assert_eq!(count(&app, "10"), 2);
    assert_eq!(count(&app, "11"), 2);
    assert_eq!(count(&app, "12"), 2);
    assert_eq!(count(&app, "13"), 1);
    assert_eq!(count(&app, "1"), 0);
    assert_eq!(count(&app, "9"), 0);
    // A patch's lines are excerpts: nothing reverts.
    app.press("id:revert-0").unwrap();
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    assert!(app.shows("Changes 0"));
}

#[test]
fn a_long_text_makes_only_the_rows_in_view() {
    let old = numbered(20_000);
    let mut new = old.clone();
    for i in [99, 9_999, 19_899] {
        new[i] = format!("changed {}", i + 1);
    }
    let mut app = start(texts(&old.join("\n"), &new.join("\n")));
    see(&mut app, "changed 100");
    app.press("id:read").unwrap();
    see(&mut app, "Stats 3 3 3");
    // Collapsed: the changes and their context, each change's rows once.
    assert!(app.shows("changed 10000") && app.shows("changed 19900"));
    assert!(count_starting(&app, "line ") < 60);
    // Every line shown: still only the rows in view (400 points of 20-point
    // rows and a viewport and a half ahead, on two sides).
    app.press("id:expand-all").unwrap();
    see(&mut app, "line 1");
    let rows = count_starting(&app, "line ");
    assert!((20..300).contains(&rows), "{rows} line texts made");
    assert!(!app.shows("changed 10000"));
    assert!(!app.shows("line 19999"));
    app.scroll("id:diff", px(1000.0)).unwrap();
    see(&mut app, "line 60");
    assert!(!app.shows("line 1"));
    let rows = count_starting(&app, "line ");
    assert!(
        (20..300).contains(&rows),
        "{rows} line texts made after scrolling"
    );
}

#[test]
fn a_press_on_a_line_number_selects_its_line() {
    let mut app = start(one_change());
    see(&mut app, "line ten");
    // A press on the left gutter's number 13: line 12.
    assert_eq!(count(&app, "13"), 2);
    app.press("text:13 >> nth=0").unwrap();
    see(&mut app, "Selection Old 12-12");
    see(&mut app, "Pressed Old 12");
}

#[test]
fn a_tap_on_a_line_number_selects_its_line_on_a_phone() {
    let mut app = start_on(one_change(), Os::Ios, Idiom::Phone);
    see(&mut app, "line ten");
    // The number itself takes the tap: number 13 is line 12.
    app.press("text:13 >> nth=0").unwrap();
    see(&mut app, "Selection Old 12-12");
    see(&mut app, "Pressed Old 12");
}

#[test]
fn a_tap_on_a_wrapped_patch_line_number_selects_it_on_a_phone() {
    let long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron \
                pi rho sigma tau upsilon phi chi psi omega alpha beta gamma delta epsilon zeta \
                eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi";
    // Taller than the view, wrapped: the view scrolls.
    let long = long.repeat(12);
    let patch = format!("--- a/notes.txt\n+++ b/notes.txt\n@@ -41,0 +42 @@\n+{long}\n");
    let mut app = start_on(
        HarnessProps {
            patch: Some(patch),
            soft_wrap: true,
            ..texts("", "")
        },
        Os::Ios,
        Idiom::Phone,
    );
    see(&mut app, "42");
    app.press("text:42").unwrap();
    see(&mut app, "Selection New 0-0");
}

#[test]
fn the_ref_sets_the_selected_lines_and_reads_their_text() {
    let mut app = start(one_change());
    see(&mut app, "line ten");
    app.press("id:select-old").unwrap();
    // Setting them reports nothing: the harness reads them back.
    see(&mut app, "Selection Old 8-9");
    see(&mut app, "Selected \"line 9\\nline 10\"");
}

#[test]
fn the_ref_moves_from_change_to_change() {
    let (old, new) = two_changes();
    let mut app = start(texts(&old, &new));
    see(&mut app, "line three");
    // Nothing navigated yet: the first change in view.
    app.press("id:current").unwrap();
    see(&mut app, "Hunk Some(0) now");
    // The first below the top of the view, then on from it, though the
    // short diff never scrolls.
    app.press("id:next").unwrap();
    see(&mut app, "Hunk Some(0)");
    app.press("id:next").unwrap();
    see(&mut app, "Hunk Some(1)");
    app.press("id:current").unwrap();
    see(&mut app, "Hunk Some(1) now");
    // From the last, back to the first.
    app.press("id:next").unwrap();
    see(&mut app, "Hunk Some(0)");
}

#[test]
fn annotations_show_under_their_lines_while_they_show() {
    let mut app = start(HarnessProps {
        annotations: vec![
            annotation("a", DiffSide::New, 9),
            // Line 1 is collapsed: its annotation waits.
            annotation("b", DiffSide::Old, 0),
        ],
        ..one_change()
    });
    see(&mut app, "Note a");
    assert!(!app.shows("Note b"));
    app.press("id:expand-all").unwrap();
    see(&mut app, "Note b");
}

#[test]
fn a_patch_of_several_files_shows_each_under_its_header() {
    let patch = "\
diff --git a/a.rs b/a.rs
--- a/a.rs
+++ b/a.rs
@@ -1,2 +1,2 @@
 keep a
-old a
+new a
diff --git a/b.rs b/b.rs
--- a/b.rs
+++ b/b.rs
@@ -5,1 +5,2 @@
 keep b
+added b
";
    let mut app = start(HarnessProps {
        patch: Some(patch.into()),
        ..texts("", "")
    });
    see(&mut app, "added b");
    // Each file under its header (the path), numbered as in it.
    assert!(app.shows("a.rs") && app.shows("b.rs"));
    assert!(app.shows("new a") && app.shows("old a"));
    assert_eq!(count(&app, "5"), 2);
    assert_eq!(count(&app, "6"), 1);
    // Hunks count across the files, their lines in their files' texts.
    app.press("id:read").unwrap();
    see(&mut app, "Stats 2 1 2");
    see(&mut app, "Hunks 1,1>1,1 1,0>1,1");
    app.press("id:files").unwrap();
    see(&mut app, "Files 0:+1-1@0 1:+1-0@1");
    // A press on a header collapses its file; the ref expands it.
    app.press("text:a.rs").unwrap();
    see(&mut app, "Toggled 0 true");
    assert!(!app.shows("new a"));
    assert!(app.shows("added b") && app.shows("a.rs"));
    app.press("id:toggle-a").unwrap();
    see(&mut app, "Toggled 0 false");
    see(&mut app, "new a");
}

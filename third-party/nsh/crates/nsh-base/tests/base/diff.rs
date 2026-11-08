//! `DiffView`: a modified line shows side by side (or one over the other,
//! unified), unchanged lines between changes collapse into separators that
//! a press or the ref expands; the ref gives the changes and their stats,
//! and reverts or keeps a change, reporting the texts; a patch's lines are
//! numbered as in its file; a long text makes only the rows in view; line
//! numbers select lines, which the ref reads and sets; the ref moves from
//! change to change; the app's annotations show under their lines;
//! several files show each under a header that collapses it; and the view
//! reports where its rows are scrolled, gives where each change is and
//! scrolls to an offset, as an overview ruler needs.

use std::sync::{Arc, Mutex};

use nsh_base::{
    DiffAnnotation, DiffChange, DiffExpand, DiffFile, DiffHunk, DiffHunkBounds, DiffLayout,
    DiffLineRange, DiffSide, DiffView, DiffViewApi, DiffViewEvent, diff_view,
};
use nsh_core::{
    MountItem, Size,
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
    /// Use the app-provided file header.
    custom_header: bool,
    /// Draw each change's actions as `Act <index>`.
    hunk_actions: bool,
}

fn texts(old: &str, new: &str) -> HarnessProps {
    HarnessProps {
        old: old.into(),
        new: new.into(),
        patch: None,
        layout: DiffLayout::Split,
        annotations: Vec::new(),
        soft_wrap: false,
        custom_header: false,
        hunk_actions: false,
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
    let scrolled = signal(String::from("-"));
    let scrolls = signal(0u32);
    let marks = signal(String::from("-"));
    let moved = signal(String::from("-"));
    let moves = signal(0u32);
    let offset = signal(String::from("-"));
    let height = signal(px(400.0));
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
        .on_scroll(move |e: &DiffViewEvent| {
            if let DiffViewEvent::Scroll(offset, content, size) = e {
                scrolled.set(format!(
                    "{} {} {} {} {}",
                    offset.x.0, offset.y.0, content.width.0, content.height.0, size.height.0
                ));
                scrolls.update(|n| *n += 1);
            }
        })
        .on_hunk_bounds_change(move |list: &Vec<DiffHunkBounds>| {
            moved.set(marks_text(list));
            moves.update(|n| *n += 1);
        })
        .component_ref(&dv)
        .size_full();
    if props.custom_header {
        el = el.render_file_header(|file: &DiffFile| text(file.path.clone()));
    }
    if props.hunk_actions {
        el = el.render_hunk_actions(|h: &DiffHunk| text(format!("Act {}", h.index)));
    }
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
        .child(
            view()
                .test_id("diff")
                .w(px(800.0))
                .h(move || Length::from(height.get()))
                .child(el),
        )
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
        .child(text(move || format!("Scrolled {}", scrolled.get())))
        .child(text(move || format!("Offset {}", offset.get())))
        .child(text(move || format!("Scrolls {}", scrolls.get())))
        .child(text(move || format!("Marks {}", marks.get())))
        .child(text(move || format!("Moved {}", moved.get())))
        .child(text(move || format!("Moves {}", moves.get())))
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
                ))
                .child(button(
                    "marks",
                    Box::new(move |a| marks.set(marks_text(&a.hunk_bounds()))),
                ))
                // The change moves from the first line to the last: the
                // rows keep their height.
                .child(button(
                    "relocate",
                    Box::new(move |_| {
                        batch(|| {
                            old.set("a\nb\nc\nd".into());
                            new.set("a\nb\nc\nD".into());
                        })
                    }),
                ))
                .child(button(
                    "scroll-40",
                    Box::new(|a| a.set_scroll_offset(point(px(500.0), px(40.0)))),
                ))
                .child(button(
                    "read-offset",
                    Box::new(move |a| {
                        let o = a.scroll_offset();
                        offset.set(format!("{} {}", o.x.0, o.y.0));
                    }),
                ))
                .child(button(
                    "scroll-far",
                    Box::new(|a| a.set_scroll_offset(point(px(0.0), px(100_000.0)))),
                ))
                .child(button("shrink", Box::new(move |_| height.set(px(300.0))))),
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

/// Sixty lines, lines 10 and 50 changed: two hunks, 17 rows collapsed.
fn two_far_changes() -> HarnessProps {
    let old = numbered(60);
    let mut new = old.clone();
    new[9] = "line ten".into();
    new[49] = "line fifty".into();
    texts(&old.join("\n"), &new.join("\n"))
}

/// The changes' boxes as text: `index@x,y+widthxheight` each.
fn marks_text(list: &[DiffHunkBounds]) -> String {
    list.iter()
        .map(|m| {
            let b = m.bounds;
            format!(
                "{}@{},{}+{}x{}",
                m.index, b.origin.x.0, b.origin.y.0, b.size.width.0, b.size.height.0
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// How many times the view reported its scrolling.
fn scrolls(app: &Headless) -> u32 {
    app.screen()
        .texts()
        .iter()
        .find_map(|t| t.trim().strip_prefix("Scrolls "))
        .expect("the count shows")
        .parse()
        .unwrap()
}

/// The hunk bounds the harness read last: `(index, top, height, width)`.
fn marks(app: &Headless) -> Vec<(u32, f32, f32, f32)> {
    let texts = app.screen().texts().join("\n");
    let line = texts
        .lines()
        .find_map(|l| l.trim().strip_prefix("Marks "))
        .expect("the marks show")
        .to_string();
    line.split(' ')
        .map(|m| {
            let (index, rest) = m.split_once('@').unwrap();
            let (origin, size) = rest.split_once('+').unwrap();
            let (x, top) = origin.split_once(',').unwrap();
            let (width, height) = size.split_once('x').unwrap();
            assert_eq!(x, "0", "a change's box starts at the left");
            (
                index.parse().unwrap(),
                top.parse().unwrap(),
                height.parse().unwrap(),
                width.parse().unwrap(),
            )
        })
        .collect()
}

#[test]
fn the_view_reports_where_its_rows_are_scrolled() {
    let mut app = start(two_far_changes());
    see(&mut app, "line fifty");
    // Once laid out: 17 rows of 20 in a viewport of 400 (`x` is 0 and the
    // rows are as wide as the view).
    see(&mut app, "Scrolled 0 0 800 340 400");
    // Every line shown: the rows are taller.
    app.press("id:expand-all").unwrap();
    see(&mut app, "Scrolled 0 0 800 1200 400");
    app.scroll("id:diff", px(100.0)).unwrap();
    see(&mut app, "Scrolled 0 100 800 1200 400");
    // A smaller viewport.
    app.press("id:shrink").unwrap();
    see(&mut app, "Scrolled 0 100 800 1200 300");
    // Nothing moved: nothing more is reported.
    let before = scrolls(&app);
    app.press("id:read").unwrap();
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    assert_eq!(scrolls(&app), before);
    // Collapsed again, the rows are short again (the scroll view clamps
    // its offset to them).
    app.press("id:collapse-all").unwrap();
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    let shown = app
        .screen()
        .texts()
        .iter()
        .find_map(|t| t.trim().strip_prefix("Scrolled ").map(str::to_string))
        .unwrap();
    assert!(shown.ends_with(" 800 340 300"), "{shown}");
}

/// In a terminal a row is one Cell, as the text engine measures a line,
/// whatever the app's `lineHeight`: rows on another step would land on
/// the Cell grid unevenly, a blank row every few lines.
#[test]
fn in_a_terminal_a_row_is_one_line_of_the_grid() {
    let mut app = start_on(two_far_changes(), Os::Linux, Idiom::Terminal);
    see(&mut app, "line fifty");
    let height = |app: &Headless| -> f32 {
        let shown = app
            .screen()
            .texts()
            .iter()
            .find_map(|t| t.trim().strip_prefix("Scrolled ").map(str::to_string))
            .unwrap();
        shown.split(' ').nth(3).unwrap().parse().unwrap()
    };
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    // 17 rows collapsed, 60 expanded, on one step that is not the
    // default 20.
    let collapsed = height(&app);
    app.press("id:expand-all").unwrap();
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    let expanded = height(&app);
    let cell = expanded / 60.0;
    assert!((cell - 20.0).abs() > 0.1, "{expanded}");
    assert!(
        (collapsed - cell * 17.0).abs() < 0.1,
        "{collapsed} {expanded}"
    );
}

/// A terminal's hunk actions take a row of their own after each change,
/// so they never cover its code; elsewhere they overlay its first row.
#[test]
fn in_a_terminal_hunk_actions_take_a_row_after_their_change() {
    let height = |idiom: Idiom, actions: bool| -> f32 {
        let mut app = start_on(
            HarnessProps {
                hunk_actions: actions,
                ..two_far_changes()
            },
            Os::Linux,
            idiom,
        );
        see(&mut app, "line fifty");
        if actions {
            see(&mut app, "Act 0");
        }
        app.wait(std::time::Duration::from_millis(100)).unwrap();
        let shown = app
            .screen()
            .texts()
            .iter()
            .find_map(|t| t.trim().strip_prefix("Scrolled ").map(str::to_string))
            .unwrap();
        shown.split(' ').nth(3).unwrap().parse().unwrap()
    };
    // 17 rows, then one more for each of the two changes' actions.
    let plain = height(Idiom::Terminal, false);
    let cell = plain / 17.0;
    let with = height(Idiom::Terminal, true);
    assert!((with - cell * 19.0).abs() < 0.1, "{plain} {with}");
    assert_eq!(height(Idiom::Desktop, true), height(Idiom::Desktop, false));
}

#[test]
fn the_ref_scrolls_to_an_offset_at_once() {
    let mut app = start(two_far_changes());
    app.press("id:expand-all").unwrap();
    see(&mut app, "Scrolled 0 0 800 1200 400");
    // Its `y` (the horizontal offset is the sides'), in one step: the
    // scroll view reporting it back reports nothing more.
    let before = scrolls(&app);
    app.press("id:scroll-40").unwrap();
    see(&mut app, "Scrolled 0 40 800 1200 400");
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    assert_eq!(scrolls(&app), before + 1);
    // The ref reads it back.
    app.press("id:read-offset").unwrap();
    see(&mut app, "Offset 0 40");
    // As far as the rows go: their height less the viewport's.
    app.press("id:scroll-far").unwrap();
    see(&mut app, "Scrolled 0 800 800 1200 400");
    see(&mut app, "line 60");
}

#[test]
fn hunk_bounds_follow_wrapped_rows_and_skip_collapsed_files() {
    let long = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron \
                pi rho sigma tau upsilon phi chi psi omega alpha beta gamma delta epsilon zeta \
                eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi";
    let patch = format!(
        "\
diff --git a/a.rs b/a.rs
--- a/a.rs
+++ b/a.rs
@@ -1,2 +1,2 @@
 keep a
-old a
+{long}
diff --git a/b.rs b/b.rs
--- a/b.rs
+++ b/b.rs
@@ -5,1 +5,2 @@
 keep b
+added b
"
    );
    let mut app = start(HarnessProps {
        patch: Some(patch),
        soft_wrap: true,
        ..texts("", "")
    });
    see(&mut app, "added b");
    app.press("id:marks").unwrap();
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    let both = marks(&app);
    assert_eq!(both.len(), 2, "{both:?}");
    let (first, second) = (both[0], both[1]);
    assert_eq!((first.0, second.0), (0, 1));
    // The changed line wraps: its change is several rows tall, the other
    // one row; each is as wide as the view.
    assert!(first.2 > 20.0 && first.2 % 20.0 == 0.0, "{both:?}");
    assert_eq!((second.2, first.3, second.3), (20.0, 800.0, 800.0));
    assert!(second.1 >= first.1 + first.2, "{both:?}");
    // File a collapsed: its change has no rows, the other moves up by
    // them.
    app.press("id:toggle-a").unwrap();
    see(&mut app, "Toggled 0 true");
    app.press("id:marks").unwrap();
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    let one = marks(&app);
    assert_eq!(one.len(), 1, "{one:?}");
    assert_eq!(one[0].0, 1);
    assert!(one[0].1 <= second.1 - first.2, "{one:?} after {both:?}");
}

/// How many times the view reported where its changes are.
fn moves(app: &Headless) -> u32 {
    app.screen()
        .texts()
        .iter()
        .find_map(|t| t.trim().strip_prefix("Moves "))
        .expect("the count shows")
        .parse()
        .unwrap()
}

#[test]
fn the_view_reports_a_change_moved_within_rows_of_the_same_height() {
    let mut app = start(texts("A\nb\nc\nd", "a\nb\nc\nd"));
    // Once laid out: the change is the first row, of the four (split:
    // the changed line beside its old one).
    see(&mut app, "Moved 0@0,0+800x20");
    see(&mut app, "Scrolled 0 0 800 80 400");
    let scrolls_before = scrolls(&app);
    // The change moves to the last line: the rows keep their height, so
    // `onScroll` has nothing to report, and the moved change is reported.
    app.press("id:relocate").unwrap();
    see(&mut app, "Moved 0@0,60+800x20");
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    assert_eq!(scrolls(&app), scrolls_before);
    // What the ref gives agrees.
    app.press("id:marks").unwrap();
    see(&mut app, "Marks 0@0,60+800x20");
    // Nothing moved: nothing more is reported, a new viewport height
    // included.
    let before = moves(&app);
    app.press("id:shrink").unwrap();
    see(&mut app, "Scrolled 0 0 800 80 300");
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    assert_eq!(moves(&app), before);
}

/// Both header renderers must occupy the row immediately after the first
/// file's change, including the extra visual rows introduced by wrapping.
#[test]
fn file_headers_follow_wrapped_rows() {
    for layout in [DiffLayout::Unified, DiffLayout::Split] {
        for custom_header in [false, true] {
            for soft_wrap in [false, true] {
                let long = "long text ".repeat(30);
                let props = HarnessProps {
                    patch: Some(format!(
                        "diff --git a/a.rs b/a.rs\n--- a/a.rs\n+++ b/a.rs\n@@ -1 +1 @@\n-old a\n+{long}\ndiff --git a/b.rs b/b.rs\n--- a/b.rs\n+++ b/b.rs\n@@ -1 +1 @@\n-old b\n+new b\n"
                    )),
                    layout,
                    soft_wrap,
                    custom_header,
                    ..texts("", "")
                };
                let mut app = Headless::start(EngineConfig {
                    viewport: Size::new(px(900.0), px(900.0)),
                    ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
                })
                .unwrap();
                let items = Arc::new(Mutex::new(Vec::new()));
                let into = items.clone();
                app.observe(move |_, batch| into.lock().unwrap().extend(batch.items.clone()));
                see(&mut app, "new b");
                app.press("id:marks").unwrap();
                app.wait(std::time::Duration::from_millis(100)).unwrap();
                let bounds = marks(&app);
                let first = bounds[0];
                let unwrapped_height = if layout == DiffLayout::Unified {
                    40.0
                } else {
                    20.0
                };
                if soft_wrap {
                    assert!(first.2 > unwrapped_height, "{bounds:?}");
                } else {
                    assert_eq!(first.2, unwrapped_height);
                }
                let items = items.lock().unwrap();
                let mut id = items
                    .iter()
                    .rev()
                    .find_map(|item| match item {
                        MountItem::Text { id, text, .. } if text.text == "b.rs" => Some(*id),
                        _ => None,
                    })
                    .expect("second file title");
                // Walk through the renderer's content to the full-width header.
                let mut header = None;
                while let Some(parent) = items.iter().rev().find_map(|item| match item {
                    MountItem::Insert { parent, child, .. } if *child == id => Some(*parent),
                    _ => None,
                }) {
                    id = parent;
                    if let Some(frame) = items.iter().rev().find_map(|item| match item {
                        MountItem::Frame { id: at, frame } if *at == id => Some(*frame),
                        _ => None,
                    }) && frame.size.width == px(800.0)
                        && frame.size.height == px(20.0)
                    {
                        header = Some(frame);
                    }
                }
                let header = header.expect("full-width header");
                assert_eq!(
                    header.origin.y.0,
                    first.1 + first.2,
                    "layout={layout:?}, custom={custom_header}, wrap={soft_wrap}"
                );
            }
        }
    }
}

#[test]
fn the_code_is_selectable_text_and_the_numbers_and_separators_are_not() {
    let mut app = start(one_change());
    see(&mut app, "line ten");
    let screen = app.screen();
    // Both sides' code is in a selectable area (each side its own).
    assert_eq!(screen.in_selectable_view("text:line 10"), Ok(true));
    assert_eq!(screen.in_selectable_view("text:line ten"), Ok(true));
    // The separators sit outside the sides' text.
    assert_eq!(screen.in_selectable_view("text:⋯ 6"), Ok(false));

    // A line number only the new side has (the gutter is outside the
    // text's area).
    let mut app = start(texts("keep\nold\n", "keep\nnew\nmore\n"));
    see(&mut app, "more");
    let screen = app.screen();
    assert_eq!(screen.in_selectable_view("text:more"), Ok(true));
    assert_eq!(screen.in_selectable_view("text:3"), Ok(false));
}

#[test]
fn a_wrapped_lines_later_parts_continue_its_first_for_a_copy() {
    let long = "long text ".repeat(30);
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(900.0), px(900.0)),
        ..EngineConfig::new(Root::new::<Harness>({
            let long = long.clone();
            move || HarnessProps {
                soft_wrap: true,
                ..texts("short\n", &format!("short\n{long}\n"))
            }
        }))
    })
    .unwrap();
    let items = Arc::new(Mutex::new(Vec::new()));
    let into = items.clone();
    app.observe(move |_, batch| into.lock().unwrap().extend(batch.items.clone()));
    see(&mut app, "short");
    app.wait(std::time::Duration::from_millis(100)).unwrap();
    let items = items.lock().unwrap();
    // The parts of the long line, in order, each with whether it
    // continues the one before.
    let mut parts: Vec<(nsh_core::NodeId, String)> = Vec::new();
    for item in items.iter() {
        let MountItem::Text { id, text, .. } = item else {
            continue;
        };
        let part = text.text.trim();
        if part.is_empty() || !long.contains(part) {
            continue;
        }
        match parts.iter_mut().find(|(at, _)| at == id) {
            Some(known) => known.1 = text.text.clone(),
            None => parts.push((*id, text.text.clone())),
        }
    }
    assert!(parts.len() > 1, "the line wraps: {parts:?}");
    let continues = |id: nsh_core::NodeId| {
        items.iter().rev().find_map(|item| match item {
            MountItem::ViewProps { id: at, props } if *at == id => Some(props.continues_text),
            _ => None,
        })
    };
    assert!(!continues(parts[0].0).unwrap_or(false), "{parts:?}");
    for (id, _) in &parts[1..] {
        assert_eq!(continues(*id), Some(true), "{parts:?}");
    }
    let joined: String = parts.iter().map(|(_, t)| t.as_str()).collect();
    assert_eq!(joined.trim_end(), long.trim_end());
}

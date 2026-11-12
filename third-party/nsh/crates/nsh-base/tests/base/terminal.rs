//! `nsh/base`'s controls in a terminal (`Idiom::Terminal`): each shows its
//! terminal-native form, text the terminal draws (`nsh_base::terminal`),
//! in place of the app's indicator parts; elsewhere they show none of it.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{
    ColorChannel, ColorPickerEvent, ColorSpace, SelectItem, TreeEntry, TreeItem, accordion,
    accordion_header, accordion_item, accordion_panel, accordion_trigger, checkbox, color_area,
    color_picker, color_slider, color_swatch, number_input, progress, radio, radio_group, select,
    slider, switch,
    terminal::{self, PROGRESS_EMPTY, PROGRESS_FILL, SLIDER_FILL, SLIDER_TRACK},
    text_view, tree,
};
use nsh_core::{
    MountItem, NodeId, Size,
    element::Root,
    geometry::point,
    platform::{Environment, Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, Screen};

fn start<C: Component<Props = ()>>(idiom: Idiom) -> Headless {
    let viewport = Size::new(px(390.0), px(844.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom,
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<C>())
    };
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app
}

/// The texts on screen, spaces kept.
fn texts(app: &Headless) -> Vec<String> {
    app.screen()
        .texts()
        .into_iter()
        .map(str::to_owned)
        .collect()
}

fn shows_exactly(app: &Headless, text: &str) -> bool {
    app.screen().texts().contains(&text)
}

/// A checkbox, a radio set and a switch the app owns the values of.
#[component]
fn Marks() -> impl IntoElement {
    let agree = signal(false);
    let mixed = signal(true);
    let plan = signal("free");
    let wifi = signal(false);
    view()
        .child(
            checkbox()
                .checked(agree)
                .on_change(move |next: &bool| agree.set(*next))
                .indicator_class("w-4 h-4")
                .child(text("Agree")),
        )
        .child(
            checkbox()
                .indeterminate(mixed)
                .checked(move || !mixed.get())
                .on_change(move |_: &bool| mixed.set(false))
                .child(text("All")),
        )
        .child(
            radio_group()
                .child(
                    radio()
                        .checked(move || plan.get() == "free")
                        .on_change(move |_: &bool| plan.set("free"))
                        .child(text("Free")),
                )
                .child(
                    radio()
                        .checked(move || plan.get() == "pro")
                        .on_change(move |_: &bool| plan.set("pro"))
                        .child(text("Pro")),
                ),
        )
        .child(
            switch()
                .checked(wifi)
                .on_change(move |next: &bool| wifi.set(*next))
                .child(text("Wi-Fi")),
        )
}

/// The screen's texts joined in order: a mark's parts are texts of their
/// own (each in its tone), so the marks and their labels read as one row
/// here ("[ ] Agree").
fn joined(app: &Headless) -> String {
    texts(app).concat()
}

#[test]
fn checkboxes_radios_and_switches_show_the_terminals_marks() {
    let mut app = start::<Marks>(Idiom::Terminal);
    // Agree unchecked, All mixed, Free checked, Pro not, Wi-Fi off.
    let shown = joined(&app);
    for row in ["[ ] Agree", "[–] All", "(●) Free", "( ) Pro", "[ ] Wi-Fi"] {
        assert!(shown.contains(row), "{row} not in {shown:?}");
    }
    app.press("text:Agree").unwrap();
    app.press("text:All").unwrap();
    app.press("text:Pro").unwrap();
    app.press("text:Wi-Fi").unwrap();
    app.wait_until("Wi-Fi on", Duration::from_secs(5), |s| {
        s.texts().concat().contains("[✓] Wi-Fi")
    })
    .unwrap();
    let shown = joined(&app);
    for row in ["[✓] Agree", "[✓] All", "( ) Free", "(●) Pro", "[✓] Wi-Fi"] {
        assert!(shown.contains(row), "{row} not in {shown:?}");
    }
}

#[test]
fn the_marks_take_the_accent_when_on_and_are_muted_when_off() {
    use terminal::{Tone, checkbox_mark, radio_mark, switch_mark};
    for on in [
        checkbox_mark(true, false),
        checkbox_mark(false, true),
        radio_mark(true),
    ] {
        assert_eq!(on[1].1, Tone::Accent, "{on:?}");
    }
    assert_eq!(switch_mark(true)[1].1, Tone::Accent);
    for off in [
        checkbox_mark(false, false),
        radio_mark(false),
        switch_mark(false),
    ] {
        assert!(off.iter().all(|(_, tone)| *tone == Tone::Muted), "{off:?}");
    }
}

#[test]
fn outside_a_terminal_the_controls_show_no_marks() {
    let app = start::<Marks>(Idiom::Desktop);
    let shown = joined(&app);
    for mark in ["[ ]", "[–]", "(●)", "( )", "[ ]"] {
        assert!(!shown.contains(mark), "{mark} in {shown:?}");
    }
    assert!(app.screen().shows("Agree"));
}

/// A progress bar at a value the app sets with F5.
#[component]
fn Bar() -> impl IntoElement {
    let value = signal(50.0f32);
    on_key("f5", move |_| value.set(100.0));
    view().child(progress().value(value).w(px(200.0)))
}

/// The texts made of `glyphs` only, joined in order (the terminal's bar,
/// whose filled run is a text of its own, or a track).
fn row_of(app: &Headless, glyphs: &[char]) -> String {
    let row: String = texts(app)
        .into_iter()
        .filter(|t| !t.is_empty() && t.chars().all(|c| glyphs.contains(&c)))
        .collect();
    assert!(!row.is_empty(), "no row of {glyphs:?} in {:?}", texts(app));
    row
}

#[test]
fn a_progress_bar_is_a_heavy_line_over_a_light_one() {
    let mut app = start::<Bar>(Idiom::Terminal);
    let glyphs = [PROGRESS_FILL, PROGRESS_EMPTY];
    let bar = row_of(&app, &glyphs);
    let columns = bar.chars().count();
    assert!(columns > 2, "{bar:?}");
    // Half the Cells are the heavy line, as the terminal's own bar draws it.
    assert_eq!(bar, terminal::progress_bar(Percentage(0.5), columns));
    app.press_key("f5").unwrap();
    assert_eq!(
        row_of(&app, &glyphs),
        terminal::progress_bar(Percentage(1.0), columns)
    );
}

/// A slider at 25 of 0 to 100.
#[component]
fn Volume() -> impl IntoElement {
    view().child(
        slider()
            .default_value(25.0)
            .accessibility_label("Volume")
            .w(px(200.0)),
    )
}

#[test]
fn a_slider_is_a_track_of_rules_with_a_thumb() {
    let app = start::<Volume>(Idiom::Terminal);
    let track = row_of(&app, &[SLIDER_TRACK, SLIDER_FILL]);
    let columns = track.chars().count();
    assert!(columns > 2, "{track:?}");
    let at = terminal::track_cell(Percentage(0.25), columns);
    assert_eq!(track, terminal::slider_track(columns, 0, at));
    assert!(shows_exactly(&app, terminal::SLIDER_THUMB));
}

/// A select, an accordion item and a tree.
#[component]
fn Lists() -> impl IntoElement {
    let open = signal(Vec::<SharedString>::new());
    view()
        .child(
            select()
                .items(vec![
                    SelectItem::new("apple", "Apple"),
                    SelectItem::new("pear", "Pear"),
                ])
                .accessibility_label("Fruit")
                .trigger(view().child(text("Pick"))),
        )
        .child(
            accordion()
                .value(open)
                .on_change(move |next: &Vec<SharedString>| open.set(next.clone()))
                .child(
                    accordion_item()
                        .value("one")
                        .child(accordion_header().child(accordion_trigger().child(text("One"))))
                        .child(accordion_panel().child(text("One details"))),
                ),
        )
        .child(
            tree()
                .items(vec![
                    TreeItem::new("src", "src").child(TreeItem::new("src/lib.rs", "lib.rs")),
                    TreeItem::new("README.md", "README.md"),
                ])
                .default_expanded(vec![SharedString::from("src")])
                .w(px(300.0))
                .h(px(200.0)),
        )
}

#[test]
fn triggers_disclosures_and_tree_rows_show_the_terminals_marks() {
    let mut app = start::<Lists>(Idiom::Terminal);
    let shown = texts(&app);
    assert!(
        shown
            .iter()
            .any(|t| t == terminal::SELECT_ARROW.trim_start()),
        "{shown:?}"
    );
    assert!(shown.iter().any(|t| t == "▸ "), "{shown:?}");
    assert!(shown.iter().any(|t| t == "▾ src"), "{shown:?}");
    // A leaf one level down: two Cells of indent, two of no disclosure.
    assert!(shown.iter().any(|t| t == "    lib.rs"), "{shown:?}");
    assert!(shown.iter().any(|t| t == "  README.md"), "{shown:?}");
    app.press("text:One").unwrap();
    app.wait_for("text:One details").unwrap();
    assert!(texts(&app).iter().any(|t| t == "▾ "));
}

/// A select with nothing chosen and a `placeholder`, and one whose trigger
/// the app makes.
#[component]
fn Placeholder() -> impl IntoElement {
    let items = || {
        vec![
            SelectItem::new("design", "Design"),
            SelectItem::new("build", "Build"),
        ]
    };
    view()
        .child(select().items(items()).placeholder("Choose a team"))
        .child(
            select()
                .items(items())
                .value("build")
                .trigger(view().child(text("Owner: Build team"))),
        )
}

#[test]
fn a_terminals_select_shows_its_placeholder_or_the_apps_trigger() {
    let app = start::<Placeholder>(Idiom::Terminal);
    let shown = texts(&app);
    assert!(shown.iter().any(|t| t == "Choose a team"), "{shown:?}");
    assert!(shown.iter().any(|t| t == "Owner: Build team"), "{shown:?}");
    // The app's trigger, not the chosen title.
    assert!(!shown.iter().any(|t| t == "Build"), "{shown:?}");
    let arrows = shown
        .iter()
        .filter(|t| *t == terminal::SELECT_ARROW.trim_start())
        .count();
    assert_eq!(arrows, 2, "{shown:?}");
}

/// An accordion item open from the start and a tree whose rows the app
/// draws (`renderItem`), indented by depth as apps do.
#[component]
fn Drawn() -> impl IntoElement {
    let open = signal(vec![SharedString::from("one")]);
    view()
        .child(
            accordion()
                .value(open)
                .on_change(move |next: &Vec<SharedString>| open.set(next.clone()))
                .child(
                    accordion_item()
                        .value("one")
                        .child(
                            accordion_header().child(
                                accordion_trigger()
                                    .gap(px(10.0))
                                    .child(text("Shipping"))
                                    .child(text("1 day")),
                            ),
                        )
                        .child(accordion_panel().child(text("Same day before 2 pm"))),
                ),
        )
        .child(
            tree()
                .items(vec![
                    TreeItem::new("src", "src").child(TreeItem::new("src/lib.rs", "lib.rs")),
                ])
                .default_expanded(vec![SharedString::from("src")])
                .render_item(|e: &TreeEntry| {
                    view()
                        .pl(px(e.depth as f32 * 14.0))
                        .child(text(e.label.clone()))
                })
                .w(px(300.0))
                .h(px(200.0)),
        )
}

/// The text shown just before `label`.
fn before(app: &Headless, label: &str) -> Option<String> {
    let shown = texts(app);
    let at = shown.iter().position(|t| t == label)?;
    at.checked_sub(1).map(|at| shown[at].clone())
}

#[test]
fn an_accordions_disclosure_leads_its_title_and_the_panel_lines_up_under_it() {
    let app = start::<Drawn>(Idiom::Terminal);
    // The trigger's disclosure, then its children a column apart: the
    // trigger's own gap does not part the disclosure from the title.
    assert_eq!(before(&app, "Shipping").as_deref(), Some("▾ "));
    assert_eq!(before(&app, "1 day").as_deref(), Some("Shipping"));
    // The panel's content past the disclosure, under the title.
    assert_eq!(
        before(&app, "Same day before 2 pm").as_deref(),
        Some(terminal::DISCLOSURE_NONE)
    );
    // An app's row is the app's: the terminal's layout leads a folder's.
    assert_eq!(before(&app, "src").as_deref(), Some("Same day before 2 pm"));
    let gui = start::<Drawn>(Idiom::Desktop);
    assert_eq!(before(&gui, "Shipping"), None);
    assert_eq!(before(&gui, "src").as_deref(), Some("Same day before 2 pm"));
}

/// Where each text starts across the window in a terminal, from the
/// frames and parents the batches set.
fn text_starts<C: Component<Props = ()>>() -> std::collections::HashMap<String, f32> {
    text_origins::<C>()
        .into_iter()
        .map(|(t, (x, _))| (t, x))
        .collect()
}

/// A row of [`text_bounds`]'s terminal, in points.
const CELL: f32 = 21.0;
/// A column of [`text_bounds`]'s terminal, in points.
const COLUMN: f32 = 8.0;

/// Where each text starts in the window in a terminal (x, y), from the
/// frames and parents the batches set.
fn text_origins<C: Component<Props = ()>>() -> std::collections::HashMap<String, (f32, f32)> {
    text_bounds::<C>()
        .into_iter()
        .map(|(t, b)| (t, (b.origin.x.0, b.origin.y.0)))
        .collect()
}

/// Where each text is in the window in a terminal, its size with it.
fn text_bounds<C: Component<Props = ()>>() -> std::collections::HashMap<String, Bounds<Points>> {
    let viewport = Size::new(px(390.0), px(844.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom: Idiom::Terminal,
            // A terminal's Cells, so the core lays out on its grid as the
            // TUI's does. The headless text engine's lines are 1.2 × the
            // font size: the body's 18pt, a code block's 15.6, a level-3
            // heading's 20.4 and the canvas font's 12, which components
            // measure as a Cell, are each one row of 21pt (nearest), as a
            // terminal's line is.
            cell: Some(Size::new(px(8.0), px(21.0))),
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<C>())
    };
    let mut app = Headless::start(config).unwrap();
    type Seen = (
        std::collections::HashMap<NodeId, String>,
        std::collections::HashMap<NodeId, Bounds<Points>>,
        std::collections::HashMap<NodeId, NodeId>,
    );
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Text { id, text, .. } => {
                    seen.0.insert(*id, text.text.to_string());
                }
                MountItem::Frame { id, frame } => {
                    seen.1.insert(*id, *frame);
                }
                MountItem::Insert { parent, child, .. } => {
                    seen.2.insert(*child, *parent);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    let seen = seen.lock().unwrap();
    // Where a view is, and whether it shows: a view never laid out (hidden
    // from the start, as a calendar's sixth week or a pagination's spare
    // ellipsis) or inside an empty one does not.
    let at = |mut id: NodeId| {
        let (mut x, mut y) = (0.0, 0.0);
        let size = seen.1.get(&id).map_or_else(Size::default, |f| f.size);
        let mut shows = seen.1.contains_key(&id);
        loop {
            if let Some(f) = seen.1.get(&id) {
                x += f.origin.x.0;
                y += f.origin.y.0;
                shows &= f.size.width.0 > 0.0 && f.size.height.0 > 0.0;
            }
            match seen.2.get(&id) {
                Some(parent) => id = *parent,
                None => {
                    return (
                        Bounds {
                            origin: point(px(x), px(y)),
                            size,
                        },
                        shows,
                    );
                }
            }
        }
    };
    // A text shown twice (a day of two months) is where it shows.
    let mut origins = std::collections::HashMap::new();
    let mut shown = std::collections::HashSet::new();
    for (id, t) in &seen.0 {
        let (origin, shows) = at(*id);
        if shows || !shown.contains(t) {
            origins.insert(t.clone(), origin);
            if shows {
                shown.insert(t.clone());
            }
        }
    }
    origins
}

#[test]
fn an_accordion_triggers_own_mark_takes_no_disclosure_lead_of_the_cores() {
    // The trigger is a disclosure (a button with `expanded`), but its first
    // text is its mark: the core keeps no columns before it, so the mark
    // starts where the panel's lead does, and the title under the panel's.
    let starts = text_starts::<Drawn>();
    let at = |label: &str| {
        *starts
            .get(label)
            .unwrap_or_else(|| panic!("no {label:?} in {starts:?}"))
    };
    assert_eq!(at("▾ "), at(terminal::DISCLOSURE_NONE), "{starts:?}");
    assert_eq!(at("Shipping"), at("Same day before 2 pm"), "{starts:?}");
}

/// A document with lists, tasks, a footnote and a table.
#[component]
fn Document() -> impl IntoElement {
    text_view().markdown(
        "1. First\n2. Second\n   - nested\n\n- [ ] Open task\n- [x] Done task\n\n\
         Numbers from benchmarks[^1].\n\n\
         | Platform | Views |\n|---|---|\n| iOS | UIKit |\n\n[^1]: A note.",
    )
}

#[test]
fn a_documents_markers_rules_and_notes_are_the_terminals_text() {
    let app = start::<Document>(Idiom::Terminal);
    let shown = joined(&app);
    // Markers a column before their content, nested ones indented by them.
    for row in [
        "1. First",
        "2. Second",
        "◦ nested",
        "☐ Open task",
        "☑ Done task",
    ] {
        assert!(shown.contains(row), "{row} not in {shown:?}");
    }
    // The reference apart from its word.
    assert!(shown.contains("benchmarks[1]"), "{shown:?}");
    // The table ruled in box drawing, its cells between bars.
    let lines = texts(&app);
    for (start, end) in [('┌', '┐'), ('├', '┤'), ('└', '┘')] {
        assert!(
            lines
                .iter()
                .any(|l| l.starts_with(start) && l.ends_with(end) && l.contains('─')),
            "no {start}…{end} rule in {lines:?}"
        );
    }
    assert!(shown.contains("│ Platform"), "{shown:?}");
    assert!(shown.contains("│ iOS"), "{shown:?}");
    // Elsewhere, none of it.
    let gui = start::<Document>(Idiom::Desktop);
    let shown = joined(&gui);
    assert!(!shown.contains('☐') && !shown.contains('┌'), "{shown:?}");
}

/// A paragraph with a formula in it and a display formula.
#[component]
fn Formulas() -> impl IntoElement {
    text_view().markdown(
        "Each frame takes $16.7\\,\\text{ms}$.\n\n$$\nt_{\\text{frame}} = \\tfrac{1000}{60}\n$$",
    )
}

#[test]
fn a_terminal_reads_a_formula_as_text_not_its_tex() {
    let app = start::<Formulas>(Idiom::Terminal);
    let shown = joined(&app);
    assert!(shown.contains("16.7 ms"), "{shown:?}");
    assert!(shown.contains("t_frame = 1000/60"), "{shown:?}");
    assert!(!shown.contains("\\text"), "{shown:?}");
    // Elsewhere the TeX as written, for want of a renderer; `math` is one.
    let gui = start::<Formulas>(Idiom::Desktop);
    assert_eq!(joined(&gui).contains("\\text{ms}"), !cfg!(feature = "math"));
}

/// A paragraph, then a heading and its paragraph.
#[component]
fn Sections() -> impl IntoElement {
    text_view().markdown("Intro text.\n\n### How it works\n\nBody text.")
}

#[test]
fn a_terminals_heading_is_a_blank_row_from_the_blocks_around_it() {
    let at = text_origins::<Sections>();
    let row = |t: &str| at.get(t).unwrap_or_else(|| panic!("no {t} in {at:?}")).1;
    // One blank row before the heading and one after it, as any block.
    assert_eq!(
        row("How it works") - row("Intro text."),
        2.0 * CELL,
        "{at:?}"
    );
    assert_eq!(
        row("Body text.") - row("How it works"),
        2.0 * CELL,
        "{at:?}"
    );
}

/// Two alerts in a row, then two paragraphs.
#[component]
fn Alerts() -> impl IntoElement {
    text_view().markdown("> [!TIP]\n> One.\n\n> [!WARNING]\n> Two.\n\nThree.\n\nFour.")
}

#[test]
fn a_terminals_alerts_in_a_row_are_a_blank_row_apart_as_other_blocks() {
    // An alert of one line is one row, its band no rows taller, so one
    // blank row lies between it and each block around it.
    let at = text_bounds::<Alerts>();
    let row = |t: &str| {
        at.get(t)
            .unwrap_or_else(|| panic!("no {t} in {at:?}"))
            .origin
            .y
            .0
    };
    assert_eq!(row("Two.") - row("One."), 2.0 * CELL, "{at:?}");
    assert_eq!(row("Three.") - row("Two."), 2.0 * CELL, "{at:?}");
    assert_eq!(row("Four.") - row("Three."), 2.0 * CELL, "{at:?}");
}

/// A paragraph, then an alert.
#[component]
fn Tip() -> impl IntoElement {
    text_view().markdown("Intro.\n\n> [!TIP]\n> Long-press to copy.")
}

#[test]
fn a_terminals_alert_is_its_icon_and_its_text_in_a_band_from_the_texts_edge() {
    // Its band from the text's left edge, a Cell of padding, the icon and
    // the text right after it.
    let at = text_bounds::<Tip>();
    let x = |t: &str| {
        at.get(t)
            .unwrap_or_else(|| panic!("no {t} in {at:?}"))
            .origin
            .x
            .0
    };
    assert_eq!(x("✓") - x("Intro."), COLUMN, "{at:?}");
    // Right after the icon, whatever the text engine measures it as.
    let icon = at["✓"];
    assert_eq!(
        x("Long-press to copy.") - x("✓"),
        icon.size.width.0,
        "{at:?}"
    );
}

/// Blocks after blocks, and a list whose items hold blocks of their own.
#[component]
fn Blocks() -> impl IntoElement {
    text_view().markdown("One.\n\n```\ncode\n```\n\nTwo.\n\n- first\n  - nested\n- second")
}

#[test]
fn a_terminals_blocks_are_a_blank_row_apart_but_a_lists_are_not() {
    let at = text_origins::<Blocks>();
    let row = |t: &str| at.get(t).unwrap_or_else(|| panic!("no {t} in {at:?}")).1;
    // An item's blocks one under the other, as the list's items are.
    let cell = row("nested") - row("first");
    assert!(cell > 0.0, "{at:?}");
    assert_eq!(row("second") - row("nested"), cell, "{at:?}");
    // A paragraph, a code block and a paragraph: a blank row between each.
    assert_eq!(row("code") - row("One."), 2.0 * cell, "{at:?}");
    assert_eq!(row("Two.") - row("code"), 2.0 * cell, "{at:?}");
    assert_eq!(row("first") - row("Two."), 2.0 * cell, "{at:?}");
}

/// A quote between two paragraphs, a rule after it.
#[component]
fn Quote() -> impl IntoElement {
    text_view().markdown("Intro.\n\n> Quoted\n\n---\n\nAfter.")
}

#[test]
fn a_terminals_quote_has_a_bar_and_its_rule_draws_nothing() {
    let app = start::<Quote>(Idiom::Terminal);
    let lines = texts(&app);
    let rule = |t: &String| !t.is_empty() && t.chars().all(|c| c == '─');
    assert!(lines.iter().any(|t| t == "▎"), "no quote bar in {lines:?}");
    assert!(!lines.iter().any(rule), "a rule in {lines:?}");
    // The bar a Cell before the quote's text; the rule no row, the blank
    // row between the quote and the paragraph the only one.
    let at = text_origins::<Quote>();
    let origin = |t: &str| *at.get(t).unwrap_or_else(|| panic!("no {t} in {at:?}"));
    let (intro, quoted, after) = (origin("Intro."), origin("Quoted"), origin("After."));
    // The bar is one text, a `▎` per row of the quote, its Cells as wide
    // as the text engine measures the glyph.
    let bar = text_bounds::<Quote>()
        .into_iter()
        .find(|(t, _)| t.starts_with('▎'))
        .map(|(_, b)| b)
        .unwrap_or_else(|| panic!("no quote bar in {at:?}"));
    assert_eq!(quoted.1 - intro.1, 2.0 * CELL, "{at:?}");
    assert_eq!(
        (bar.origin.x.0, bar.origin.y.0),
        (intro.0, quoted.1),
        "{at:?}"
    );
    assert_eq!(
        quoted.0 - bar.origin.x.0,
        bar.size.width.0 + COLUMN,
        "{at:?}"
    );
    assert_eq!(after.1 - quoted.1, 2.0 * CELL, "{at:?}");
    // Elsewhere, the border and the hairline.
    let gui = start::<Quote>(Idiom::Desktop);
    let lines = texts(&gui);
    assert!(!lines.iter().any(|t| t == "▎" || rule(t)), "{lines:?}");
}

/// An image alone in its paragraph, between two paragraphs.
#[component]
fn Picture() -> impl IntoElement {
    text_view().markdown("Intro.\n\n![Green mountains](https://example.com/a.png)\n\nAfter.")
}

#[test]
fn a_terminals_block_image_reads_as_its_alt_text_on_a_line() {
    let at = text_origins::<Picture>();
    let row = |t: &str| at.get(t).unwrap_or_else(|| panic!("no {t} in {at:?}")).1;
    // A line of its own, a blank row on each side as any block has.
    let image = row("[Green mountains]");
    assert!(image > row("Intro."), "{at:?}");
    assert_eq!(image - row("Intro."), row("After.") - image, "{at:?}");
}

/// The same with an image without alt text.
#[component]
fn Unlabeled() -> impl IntoElement {
    text_view().markdown("Intro.\n\n![](https://example.com/a.png)\n\nNext.\n\nAfter.")
}

#[test]
fn a_terminal_leaves_out_an_image_without_alt_text_and_its_row() {
    let at = text_origins::<Unlabeled>();
    let row = |t: &str| at.get(t).unwrap_or_else(|| panic!("no {t} in {at:?}")).1;
    assert!(!at.keys().any(|t| t.contains('[')), "{at:?}");
    // One blank row from Intro to Next, as from Next to After.
    assert_eq!(
        row("Next.") - row("Intro."),
        row("After.") - row("Next."),
        "{at:?}"
    );
}

/// A heading of each level after the document's title, a paragraph and a
/// rule between them.
#[component]
fn Outline() -> impl IntoElement {
    text_view().markdown(
        "# Native *Shell*\n\nIntro.\n\n---\n\n## Two\n\n### Three\n\n#### Four `x`\n\nAfter.",
    )
}

#[test]
fn a_terminals_headings_drop_their_marks_and_only_the_title_is_ruled() {
    let app = start::<Outline>(Idiom::Terminal);
    let lines = texts(&app);
    // Each heading one text, its inline styles given way to its own.
    for heading in ["Native Shell", "Two", "Three", "Four x"] {
        assert!(
            lines.iter().any(|t| t == heading),
            "no {heading:?} in {lines:?}"
        );
    }
    assert!(!lines.iter().any(|t| t.contains('#')), "{lines:?}");
    let rule = |t: &String| !t.is_empty() && t.chars().all(|c| c == '─');
    assert_eq!(lines.iter().filter(|t| rule(t)).count(), 1, "{lines:?}");
    let at = text_bounds::<Outline>();
    let bounds = |t: &str| *at.get(t).unwrap_or_else(|| panic!("no {t} in {at:?}"));
    let row = |t: &str| bounds(t).origin.y.0;
    // The title's rule under it across the text's width, a blank row, the
    // paragraph; the rule between the paragraph and `Two` no row: one
    // blank row between every two blocks.
    let (title, ruled) = at
        .iter()
        .find(|(t, _)| rule(t))
        .map(|(t, b)| (bounds("Native Shell"), (t.chars().count(), *b)))
        .unwrap();
    assert_eq!(ruled.1.origin.y.0 - title.origin.y.0, CELL, "{at:?}");
    assert_eq!(ruled.1.origin.x, title.origin.x, "{at:?}");
    assert_eq!(ruled.0 as f32 * COLUMN, ruled.1.size.width.0, "{at:?}");
    assert_eq!(row("Intro.") - row("Native Shell"), 3.0 * CELL, "{at:?}");
    for (a, b) in [
        ("Intro.", "Two"),
        ("Two", "Three"),
        ("Three", "Four x"),
        ("Four x", "After."),
    ] {
        assert_eq!(row(b) - row(a), 2.0 * CELL, "{a} to {b}: {at:?}");
    }
}

/// A paragraph, then a code block in TypeScript, one with a line too long
/// for the view, and one of the first's longest line alone.
#[component]
fn Listing() -> impl IntoElement {
    text_view().markdown(
        "Intro.\n\n```ts\nlet a = 1;\nconst longer = a;\n```\n\nThen a long one.\n\n\
         ```\nconst a = \"one two three four five six seven eight nine ten eleven twelve\";\n```\n\n\
         ```\nconst longer = a;\n```",
    )
}

#[test]
fn a_terminals_code_block_is_a_band_as_wide_as_its_longest_line_under_its_language() {
    let at = text_bounds::<Listing>();
    let bounds = |t: &str| {
        *at.iter()
            .find(|(k, _)| k.starts_with(t))
            .unwrap_or_else(|| panic!("no {t} in {at:?}"))
            .1
    };
    let intro = bounds("Intro.");
    // Its language reversed on its own row, from the text's left edge, a
    // blank row after the paragraph.
    let language = bounds(" ts ");
    assert_eq!(language.origin.x, intro.origin.x, "{at:?}");
    assert_eq!(language.origin.y.0 - intro.origin.y.0, 2.0 * CELL, "{at:?}");
    // The code a Cell into its band, right under it, no rows of padding.
    let code = bounds("let a = 1;");
    assert_eq!(code.origin.x.0 - intro.origin.x.0, COLUMN, "{at:?}");
    assert_eq!(code.origin.y.0 - language.origin.y.0, CELL, "{at:?}");
    // As wide as its longest line: as the block of that line alone.
    assert_eq!(code.size.width, bounds("const longer").size.width, "{at:?}");
    assert!(code.size.width.0 < 390.0 - 2.0 * COLUMN, "{at:?}");
    assert_eq!(code.size.height.0, 2.0 * CELL, "{at:?}");
    assert_eq!(
        bounds("Then a long one.").origin.y.0 - code.origin.y.0,
        3.0 * CELL,
        "{at:?}"
    );
    // A line longer than the view wraps inside its band, a Cell before
    // the view's end: 390pt is 49 columns on the grid (392pt).
    let long = bounds("const a");
    let view = (390.0 / COLUMN).ceil() * COLUMN;
    assert!(long.size.height.0 >= 2.0 * CELL, "{at:?}");
    assert!(
        long.origin.x.0 + long.size.width.0 <= view - COLUMN,
        "{at:?}"
    );
}

/// A table too wide for the view: a short column and a long one.
#[component]
fn WideTable() -> impl IntoElement {
    text_view().markdown(
        "| Name | Description |\n|---|---|\n\
         | iOS | UIKit views laid out by Taffy and drawn by Core Animation layers |",
    )
}

/// A table that cannot fit: ten columns of ten letters.
#[component]
fn HugeTable() -> impl IntoElement {
    let row = ["abcdefghij"; 10].join(" | ");
    text_view().markdown(format!("| {row} |\n|{}\n| {row} |", "---|".repeat(10)))
}

#[test]
fn a_terminals_table_narrows_its_widest_column_to_fit_and_wraps_its_cells() {
    // 390pt is 49 columns on the grid (392pt): the description narrows to
    // what the rules and the name leave (49 - 7 - 4), wrapping over two
    // rows.
    let at = text_bounds::<WideTable>();
    let top = at
        .keys()
        .find(|t| t.starts_with('┌'))
        .unwrap_or_else(|| panic!("no top rule in {at:?}"));
    assert_eq!(top.chars().count(), 49, "{top}");
    let cell = at
        .iter()
        .find(|(t, _)| t.starts_with("UIKit"))
        .map(|(_, b)| *b)
        .unwrap_or_else(|| panic!("no description in {at:?}"));
    assert_eq!(cell.size.height.0, 2.0 * CELL, "{at:?}");
    // Columns narrow to 6 Cells at most: past that the table scrolls.
    let at = text_bounds::<HugeTable>();
    let top = at.keys().find(|t| t.starts_with('┌')).unwrap();
    assert_eq!(top.chars().count(), 1 + 10 * (6 + 2) + 9 + 1, "{top}");
}

#[component]
fn SpanningTable() -> impl IntoElement {
    text_view().html(
        "<table><tr><th>Platform</th><th>Views</th></tr>\
         <tr><td>iOS</td><td>UIKit views laid out by Taffy</td></tr>\
         <tr><td colspan=2>A cell spanning both columns for wrapping</td></tr></table>",
    )
}

#[test]
fn a_terminals_table_keeps_its_rules_and_spanning_cell_in_step_through_resizes() {
    let rules = |app: &Headless| {
        texts(app)
            .into_iter()
            .filter(|t| t.starts_with(['┌', '├', '└']))
            .collect::<Vec<_>>()
    };
    let mut app = start::<SpanningTable>(Idiom::Terminal);
    let original = rules(&app);
    assert_eq!(original.len(), 3);
    let mut narrow = Vec::new();
    for width in [240.0, 160.0, 160.0, 32.0, 390.0] {
        app.set_viewport(Size::new(px(width), px(844.0))).unwrap();
        let at = rules(&app);
        assert_eq!(at.len(), 3, "{at:?}");
        let columns = at[0].chars().count();
        assert!(at.iter().all(|r| r.chars().count() == columns), "{at:?}");
        assert!(app.shows("A cell spanning both columns for wrapping"));
        if width == 240.0 {
            assert!(columns < original[0].chars().count());
        }
        if width == 32.0 {
            assert_eq!(columns, 1 + 2 * (6 + 2) + 1 + 1);
        }
        if width == 160.0 {
            if !narrow.is_empty() {
                assert_eq!(at, narrow);
            }
            narrow = at;
        }
    }
    assert_eq!(rules(&app), original);
}

/// An item whose text wraps in a narrow view.
#[component]
fn Narrow() -> impl IntoElement {
    view()
        .w(px(96.0))
        .child(text_view().markdown("1. alpha beta gamma delta epsilon"))
}

#[test]
fn a_terminals_list_marker_stays_on_its_items_first_row() {
    let at = text_bounds::<Narrow>();
    let at_ = |t: &str| *at.get(t).unwrap_or_else(|| panic!("no {t} in {at:?}"));
    let (marker, item) = (at_("1. "), at_("alpha beta gamma delta epsilon"));
    assert_eq!(marker.origin.y, item.origin.y, "{at:?}");
    // The text right after the marker's Cells.
    assert_eq!(
        item.origin.x.0 - marker.origin.x.0,
        marker.size.width.0,
        "{at:?}"
    );
}

/// A number input with both buttons at the field's end.
#[component]
fn Stepper() -> impl IntoElement {
    view().child(
        number_input()
            .value(2.0)
            .controls_right(true)
            .increment_button(text("Up"))
            .decrement_button(text("Down")),
    )
}

#[test]
fn a_terminals_number_input_sets_its_end_buttons_side_by_side() {
    let at = text_origins::<Stepper>();
    let (up, down) = (at["Up"], at["Down"]);
    // On the field's row, − then + as a row reads, not one over the other.
    assert_eq!(up.1, down.1, "{at:?}");
    assert!(down.0 < up.0, "{at:?}");
}

/// A picker of `#3b82f6` (HSB hue 217) with an area, a hue slider and a
/// swatch of the picked color; the color in hex as the app keeps it.
#[component]
fn Colors() -> impl IntoElement {
    let color = signal(Hsla::from(rgb(0x3b82f6)));
    let hex = signal(String::from("#3b82f6"));
    view()
        .child(
            color_picker()
                .value(move || Some(color.get()))
                .on_change(move |e: &ColorPickerEvent| {
                    if let ColorPickerEvent::Change(value, formatted) = e {
                        color.set(*value);
                        hex.set(formatted.to_string());
                    }
                })
                .child(
                    color_area()
                        .accessibility_label("Area")
                        .w(px(200.0))
                        .h(px(200.0)),
                )
                .child(
                    color_slider()
                        .color_space(ColorSpace::Hsb)
                        .channel(ColorChannel::Hue)
                        .accessibility_label("Hue")
                        .w(px(200.0))
                        // What shows the slider has the keyboard focus.
                        .focus(|s| s.opacity(0.5)),
                )
                .child(color_swatch().accessibility_label("Current")),
        )
        .child(text(move || format!("Color {}", hex.get())))
}

/// A picker of `#3b82f6` (HSB hue 217) with a hue slider alone, the color
/// in hex as the app keeps it.
#[component]
fn Hue() -> impl IntoElement {
    let color = signal(Hsla::from(rgb(0x3b82f6)));
    let hex = signal(String::from("#3b82f6"));
    view()
        .child(
            color_picker()
                .value(move || Some(color.get()))
                .on_change(move |e: &ColorPickerEvent| {
                    if let ColorPickerEvent::Change(value, formatted) = e {
                        color.set(*value);
                        hex.set(formatted.to_string());
                    }
                })
                .child(
                    color_slider()
                        .color_space(ColorSpace::Hsb)
                        .channel(ColorChannel::Hue)
                        .accessibility_label("Hue")
                        .w(px(200.0))
                        // What shows the slider has the keyboard focus.
                        .focus(|s| s.opacity(0.5)),
                ),
        )
        .child(text(move || format!("Color {}", hex.get())))
}

/// The hue slider's track, its Cells' glyphs joined from the start: a
/// blank Cell of each color but the thumb's. The track's own blank text,
/// which makes it one row tall, comes before its Cells.
fn hue_track(screen: &Screen) -> String {
    screen
        .texts()
        .into_iter()
        .filter(|t| *t == " " || *t == terminal::COLOR_THUMB)
        .skip(1)
        .collect()
}

#[test]
fn a_color_slider_is_a_row_of_its_colors_with_a_thumb() {
    let mut app = start::<Hue>(Idiom::Terminal);
    let track = hue_track(app.screen());
    let columns = track.chars().count();
    assert!(columns > 2, "{track:?}");
    // One thumb, a bar on the Cell of 217 of 360, no line along the track.
    let at = terminal::track_cell(Percentage(217.0 / 360.0), columns);
    let expected: String = (0..columns)
        .map(|i| if i == at { '│' } else { ' ' })
        .collect();
    assert_eq!(track, expected);
    // The slider is one adjustable control; its Cells are pictures hidden
    // from screen readers.
    assert_eq!(app.screen().count("label:Hue").unwrap(), 1);
    // A drag to the start picks the smallest hue, its thumb on the first
    // Cell; End the largest, on the last.
    app.drag("label:Hue", point(px(-400.0), px(0.0))).unwrap();
    let wait = Duration::from_secs(1);
    app.wait_until("the thumb at the start", wait, |s| {
        hue_track(s).starts_with('│')
    })
    .unwrap();
    // A drag gives no keyboard focus: Tab to the slider (its `focus:`
    // style says when it has it), then End: the largest hue, on the last
    // Cell.
    let slider = app
        .screen()
        .press_target("label:Hue")
        .unwrap()
        .expect("the slider takes presses");
    let opacity = Arc::new(Mutex::new(1.0_f32));
    let into = opacity.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { id, style } = item
                && *id == slider
            {
                *into.lock().unwrap() = style.opacity;
            }
        }
    });
    let mut tabs = 0;
    while *opacity.lock().unwrap() == 1.0 {
        assert!(tabs < 3, "Tab never reached the slider");
        app.press_key("tab").unwrap();
        let o = opacity.clone();
        let _ = app.wait_until(
            "Tab moves the focus",
            Duration::from_millis(200),
            move |_| *o.lock().unwrap() < 1.0,
        );
        tabs += 1;
    }
    app.press_key("end").unwrap();
    let at_end = |s: &Screen| {
        let track = hue_track(s);
        track.ends_with('│') && track.chars().filter(|&c| c == ' ').count() == columns - 1
    };
    app.wait_until("the thumb at the end", wait, at_end)
        .unwrap();
}

#[test]
fn a_focused_color_sliders_thumb_stands_bold_on_the_accent() {
    let mut app = start::<Hue>(Idiom::Terminal);
    let thumb = format!("text:{}", terminal::COLOR_THUMB);
    let at_rest = app.screen().span_style(&thumb).unwrap();
    assert_ne!(at_rest.font_weight, 700, "not bold at rest");
    // The views the slider's focus fills from here on.
    let fills = Arc::new(Mutex::new(Vec::new()));
    let into = fills.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { style, .. } = item {
                into.lock().unwrap().push(style.background_color);
            }
        }
    });
    let bold = |s: &Screen| {
        s.span_style(&format!("text:{}", terminal::COLOR_THUMB))
            .is_ok_and(|style| style.font_weight == 700)
    };
    let mut tabs = 0;
    while !bold(app.screen()) {
        assert!(tabs < 3, "Tab never reached the slider");
        app.press_key("tab").unwrap();
        let _ = app.wait_until("Tab moves the focus", Duration::from_millis(200), bold);
        tabs += 1;
    }
    let focused = app.screen().span_style(&thumb).unwrap();
    assert_ne!(
        focused.color, at_rest.color,
        "the thumb in the background's color"
    );
    assert!(
        fills
            .lock()
            .unwrap()
            .contains(&nsh_core::Color::from(terminal::ACCENT)),
        "the thumb's Cell on the accent"
    );
}

#[test]
fn a_color_area_is_a_grid_of_cells_with_the_picked_one_marked() {
    let mut app = start::<Colors>(Idiom::Terminal);
    let picked = |app: &Headless| {
        texts(app)
            .iter()
            .filter(|t| t.as_str() == terminal::AREA_PICKED)
            .count()
    };
    assert_eq!(picked(&app), 1, "{:?}", texts(&app));
    // A press at the area's top left: no saturation, full brightness.
    app.press_at("label:Area", point(px(1.0), px(1.0))).unwrap();
    app.wait_for("text:Color #ffffff").unwrap();
    assert_eq!(picked(&app), 1);
    // The swatch: four Cells of the color by itself.
    assert!(shows_exactly(&app, terminal::SWATCH), "{:?}", texts(&app));
}

#[test]
fn outside_a_terminal_the_color_parts_draw_no_cells() {
    let app = start::<Colors>(Idiom::Desktop);
    let shown = joined(&app);
    assert!(!shown.contains(terminal::AREA_PICKED), "{shown:?}");
    assert!(!shown.contains(terminal::COLOR_THUMB), "{shown:?}");
}

/// A color area 380 points wide and 210 high, as a card's content.
#[component]
fn WideArea() -> impl IntoElement {
    color_picker()
        .default_value(Hsla::from(rgb(0x3b82f6)))
        .child(
            color_area()
                .accessibility_label("Area")
                .w(px(380.0))
                .h(px(210.0)),
        )
}

#[test]
fn a_color_area_fills_its_width_and_its_rows_with_cells() {
    let viewport = Size::new(px(390.0), px(844.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom: Idiom::Terminal,
            // Cells of 8 × 21 points, as `text_origins`: the area holds 47
            // of them across and 10 down.
            cell: Some(Size::new(px(8.0), px(21.0))),
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<WideArea>())
    };
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    let cells = texts(&app)
        .iter()
        .filter(|t| *t == " " || *t == terminal::AREA_PICKED)
        .count();
    assert_eq!(cells, 47 * 10, "{:?}", texts(&app));
}

/// A choice card: a checkbox whose children are a title over a
/// description, as the app lays them out.
#[component]
fn Choice() -> impl IntoElement {
    let on = signal(false);
    view().child(
        checkbox()
            .checked(on)
            .on_change(move |next: &bool| on.set(*next))
            .w(px(300.0))
            .child(text("Push"))
            .child(text("As it happens")),
    )
}

#[test]
fn a_checkboxs_children_keep_their_column_beside_the_mark() {
    let viewport = Size::new(px(390.0), px(844.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom: Idiom::Terminal,
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<Choice>())
    };
    let mut app = Headless::start(config).unwrap();
    // Each text's frame, in its parent, as the batches set it.
    let seen = Arc::new(Mutex::new((
        std::collections::HashMap::<NodeId, String>::new(),
        std::collections::HashMap::<NodeId, Bounds<Points>>::new(),
    )));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::Text { id, text, .. } => {
                    seen.0.insert(*id, text.text.to_string());
                }
                MountItem::Frame { id, frame } => {
                    seen.1.insert(*id, *frame);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    let seen = seen.lock().unwrap();
    let frame = |label: &str| {
        let id = seen
            .0
            .iter()
            .find(|(_, t)| t.as_str() == label)
            .map(|(id, _)| *id)
            .unwrap_or_else(|| panic!("no text {label:?} in {:?}", seen.0));
        seen.1[&id]
    };
    let (title, description) = (frame("Push"), frame("As it happens"));
    // The description under the title, at its start: a column, not a row.
    assert!(
        description.origin.y >= title.origin.y + title.size.height,
        "{title:?} {description:?}"
    );
    assert_eq!(description.origin.x, title.origin.x);
    // The mark is still beside them.
    assert!(joined(&app).starts_with("[ ] Push"), "{:?}", joined(&app));
}

/// A command whose rows the app paints red, green while highlighted.
#[component]
fn Painted() -> impl IntoElement {
    nsh_base::command()
        .items(vec![
            nsh_base::CommandItem::new("new", "New File"),
            nsh_base::CommandItem::new("open", "Open File"),
        ])
        .item_class("bg-[#ff0000] focus:bg-[#00ff00]")
        .h(px(200.0))
}

/// The backgrounds of the views the first render mounts in `idiom`.
fn backgrounds<C: Component<Props = ()>>(idiom: Idiom) -> Vec<nsh_core::Color> {
    let viewport = Size::new(px(390.0), px(844.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom,
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<C>())
    };
    let mut app = Headless::start(config).unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewStyle { style, .. } = item {
                into.lock().unwrap().push(style.background_color);
            }
        }
    });
    app.first_render().unwrap();
    app.wait_for("text:New File").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    seen.lock().unwrap().clone()
}

#[test]
fn a_terminals_command_rows_leave_the_highlight_to_the_terminal() {
    // The terminal bands the highlighted row itself (its projected
    // focus): the app's row look would paint a band beside it.
    const RED: nsh_core::Color = nsh_core::Color(0xff0000ff);
    const GREEN: nsh_core::Color = nsh_core::Color(0x00ff00ff);
    let desktop = backgrounds::<Painted>(Idiom::Desktop);
    assert!(desktop.contains(&RED), "{desktop:?}");
    let terminal = backgrounds::<Painted>(Idiom::Terminal);
    assert!(
        !terminal.contains(&RED) && !terminal.contains(&GREEN),
        "{terminal:?}"
    );
}

/// November 2026 (it starts on a Sunday), its days drawn by the app as
/// `d<n>`.
#[component]
fn Month() -> impl IntoElement {
    let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 6);
    nsh_base::calendar()
        .default_value(nsh_base::Date::Single(day))
        .item_class("p-4 m-2")
        .render_item(|e: &nsh_base::CalendarEntry| match e.kind {
            nsh_base::CalendarItemKind::Day => text(format!("d{}", e.value)),
            _ => text(format!("k{}", e.value)),
        })
}

#[test]
fn a_terminals_calendar_is_a_grid_of_right_aligned_numbers() {
    // `cal`'s month: the calendar draws the days as their numbers, two
    // Cells each, right-aligned, two blank Cells apart (controls side by
    // side read as words); the app's item look and drawings are left out.
    let at = text_starts::<Month>();
    assert!(!at.keys().any(|t| t.starts_with('d')), "{at:?}");
    let x = |t: &str| *at.get(t).unwrap_or_else(|| panic!("no {t:?}: {at:?}"));
    // A day column is four Cells (32pt) from the next.
    assert_eq!(x("9") - x("8"), 32.0);
    assert_eq!(x("16"), x("23"));
    // Two digits take the column's both Cells, one its last.
    assert_eq!(x("10"), x("9") + 24.0);
    // A week is seven columns.
    assert_eq!(x("15"), x("22"));
    assert_eq!(x("21") - x("15"), 6.0 * 32.0);
    // The weekdays (the app's `k<n>`, labels, not buttons) head their
    // columns: Sunday over the 8th, each four Cells from the next.
    assert_eq!(x("k0"), x("8") - 8.0);
    assert_eq!(x("k1") - x("k0"), 32.0);
    assert_eq!(x("k6") - x("k0"), 6.0 * 32.0);
}

/// Page 1 of 24, its items in the app's padded boxes.
#[component]
fn Pages() -> impl IntoElement {
    nsh_base::pagination()
        .page(1u32)
        .total_pages(24u32)
        .previous_accessibility_label("Previous")
        .next_accessibility_label("Next")
        .item_class("px-6 border")
}

#[test]
fn a_terminals_pagination_is_a_row_of_words_two_cells_apart() {
    // Previous  1  2  3  …  24  Next: the app's item boxes are left out,
    // the pages and the ellipsis two blank Cells apart.
    let at = text_starts::<Pages>();
    let x = |t: &str| *at.get(t).unwrap_or_else(|| panic!("no {t:?}: {at:?}"));
    assert_eq!(x("1") - x("Previous"), (8.0 + 2.0) * 8.0);
    assert_eq!(x("2") - x("1"), 3.0 * 8.0);
    assert_eq!(x("3") - x("2"), 3.0 * 8.0);
    assert_eq!(x("…") - x("3"), 3.0 * 8.0);
    assert_eq!(x("24") - x("…"), 3.0 * 8.0);
    assert_eq!(x("Next") - x("24"), 4.0 * 8.0);
}

/// A progress bar whose indicator the app colors red, as a level low on
/// charge.
#[component]
fn Low() -> impl IntoElement {
    let red = nsh_core::Color(0xff0000ff);
    view().child(
        progress()
            .value(50.0)
            .indicator_style(move |s| s.bg(red))
            .w(px(200.0)),
    )
}

#[test]
fn a_terminals_progress_bar_takes_the_indicators_color() {
    let glyphs = [PROGRESS_FILL, PROGRESS_EMPTY];
    let filled = |app: &Headless| {
        let run: String = row_of(app, &glyphs)
            .chars()
            .filter(|&c| c != PROGRESS_EMPTY)
            .collect();
        app.screen()
            .span_style(&format!("text:{run}"))
            .unwrap()
            .color
    };
    let red = start::<Low>(Idiom::Terminal);
    assert_eq!(filled(&red), nsh_core::Color(0xff0000ff));
    // Without one, the terminal's accent.
    let plain = start::<Bar>(Idiom::Terminal);
    assert_eq!(filled(&plain), terminal::ACCENT.into());
    // The track beside the fill, in a color of its own (the line's).
    let track: String = row_of(&red, &glyphs)
        .chars()
        .filter(|&c| c == PROGRESS_EMPTY)
        .collect();
    assert!(!track.is_empty());
    let track = red
        .screen()
        .span_style(&format!("text:{track}"))
        .unwrap()
        .color;
    assert_ne!(track, filled(&red), "the track reads apart from the fill");
}

/// A diff of a long line left as it was and one changed.
#[component]
fn LongDiff() -> impl IntoElement {
    nsh_base::diff_view()
        .old_value("/** Formats a number for the badge beside the title */\nconst STEP = 1;\n")
        .new_value("/** Formats a number for the badge beside the title */\nconst STEP = 2;\n")
        .w(px(240.0))
        .h(px(200.0))
}

#[test]
fn a_terminals_diff_cuts_every_line_alike() {
    // Changed and unchanged lines alike are one line cut short with `…`
    // at their side's edge (no side scrolls across in a terminal).
    let viewport = Size::new(px(390.0), px(844.0));
    let config = EngineConfig {
        viewport,
        environment: Environment {
            window: viewport,
            os: Os::Linux,
            idiom: Idiom::Terminal,
            cell: Some(Size::new(px(8.0), px(16.0))),
            ..Environment::default()
        },
        ..EngineConfig::new(Root::of::<LongDiff>())
    };
    let mut app = Headless::start(config).unwrap();
    let lines = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let into = lines.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::Text { id, text, .. } = item {
                into.lock()
                    .unwrap()
                    .insert(*id, (text.text.to_string(), text.max_lines));
            }
        }
    });
    app.first_render().unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    let lines = lines.lock().unwrap();
    let limits: Vec<_> = lines
        .values()
        .filter(|(t, _)| t.contains("Formats") || t.contains("STEP"))
        .collect();
    assert!(limits.len() >= 4, "{lines:?}");
    assert!(limits.iter().all(|(_, max)| *max == 1), "{limits:?}");
}

/// A masked one-time code holding two digits of four.
#[component]
fn MaskedCode() -> impl IntoElement {
    view().child(
        nsh_base::otp_input()
            .length(4u32)
            .masked(true)
            .default_value("12"),
    )
}

#[test]
fn a_terminals_masked_code_shows_a_dot_a_digit_and_a_slot_an_empty_cell() {
    let app = start::<MaskedCode>(Idiom::Terminal);
    let shown = texts(&app);
    let count = |glyph: &str| shown.iter().filter(|t| *t == glyph).count();
    assert_eq!(count(terminal::OTP_MASK), 2, "{shown:?}");
    assert_eq!(count(terminal::OTP_EMPTY), 2, "{shown:?}");
    assert!(!shown.iter().any(|t| t == "1" || t == "2"), "{shown:?}");
    // Elsewhere the platforms' bullet.
    let app = start::<MaskedCode>(Idiom::Desktop);
    let shown = texts(&app);
    assert_eq!(
        shown.iter().filter(|t| *t == "\u{2022}").count(),
        2,
        "{shown:?}"
    );
}

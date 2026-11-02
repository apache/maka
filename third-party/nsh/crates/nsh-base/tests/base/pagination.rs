//! `Pagination`: the pages it shows (`gpui-base`'s algorithm: the first
//! and the last, the current one's neighbours, ellipses for the runs left
//! out); a press on a page, Previous or Next reports the page it goes to,
//! which the app sets; Previous and Next take no press at the ends, nothing
//! does while disabled; the navigation landmark and the current page as
//! screen readers get them; the keyboard focus stays on a page pressed from
//! it; a page change makes no views. On macOS, where Tab stops at views
//! that take presses.

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use nsh_base::{
    PaginationItem::{self, Ellipsis, Page},
    PaginationItemKind, PaginationItemState, pagination, pagination_items,
};
use nsh_core::{AccessibilityCurrent, MountItem, Size, element::Root, platform::Os, prelude::*};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

// The pages shown.

fn pages(page: u32, total: u32, visible: u32) -> Vec<PaginationItem> {
    pagination_items(page, total, visible)
}

#[test]
fn a_single_page_or_none_shows_no_items() {
    assert!(pages(1, 0, 5).is_empty());
    assert!(pages(1, 1, 5).is_empty());
    assert!(pages(7, 1, 5).is_empty());
}

#[test]
fn pages_that_fit_all_show() {
    assert_eq!(pages(1, 2, 5), [Page(1), Page(2)]);
    assert_eq!(pages(3, 5, 5), (1..=5).map(Page).collect::<Vec<_>>());
    assert_eq!(pages(4, 7, 7), (1..=7).map(Page).collect::<Vec<_>>());
}

#[test]
fn the_current_page_has_its_siblings_between_the_boundaries() {
    // `gpui-base`'s own case: seven pages shown, two on each side.
    assert_eq!(
        pages(5, 10, 7),
        [
            Page(1),
            Ellipsis(2..3),
            Page(3),
            Page(4),
            Page(5),
            Page(6),
            Page(7),
            Ellipsis(8..10),
            Page(10),
        ]
    );
    // Five shown (the default): one on each side.
    assert_eq!(
        pages(50, 100, 5),
        [
            Page(1),
            Ellipsis(2..49),
            Page(49),
            Page(50),
            Page(51),
            Ellipsis(52..100),
            Page(100)
        ]
    );
}

#[test]
fn near_an_end_one_ellipsis_shows() {
    assert_eq!(
        pages(1, 10, 5),
        [Page(1), Page(2), Page(3), Ellipsis(4..10), Page(10)]
    );
    assert_eq!(
        pages(2, 10, 5),
        [Page(1), Page(2), Page(3), Ellipsis(4..10), Page(10)]
    );
    assert_eq!(
        pages(3, 10, 5),
        [
            Page(1),
            Page(2),
            Page(3),
            Page(4),
            Ellipsis(5..10),
            Page(10)
        ]
    );
    assert_eq!(
        pages(10, 10, 5),
        [Page(1), Ellipsis(2..8), Page(8), Page(9), Page(10)]
    );
    assert_eq!(
        pages(8, 10, 5),
        [Page(1), Ellipsis(2..7), Page(7), Page(8), Page(9), Page(10)]
    );
}

#[test]
fn out_of_range_values_are_held() {
    // A page past the last is the last, page 0 the first.
    assert_eq!(pages(20, 10, 5), pages(10, 10, 5));
    assert_eq!(pages(0, 10, 5), pages(1, 10, 5));
    // Fewer than five visible pages are five.
    assert_eq!(pages(5, 10, 1), pages(5, 10, 5));
}

#[test]
fn no_item_list_is_longer_than_the_visible_pages_and_two_ellipses() {
    for visible in [5, 6, 7, 9] {
        for total in [1, 2, 5, 9, 10, 11, 40] {
            for page in 1..=total {
                let items = pages(page, total, visible);
                assert!(
                    items.len() <= visible as usize + 2,
                    "{page}/{total} of {visible}"
                );
                let shown = items.iter().filter(|i| matches!(i, Page(_))).count();
                assert!(shown <= visible as usize, "{page}/{total} of {visible}");
                if total > 1 {
                    assert_eq!(items.first(), Some(&Page(1)));
                    assert_eq!(items.last(), Some(&Page(total)));
                    assert!(items.contains(&Page(page)));
                }
            }
        }
    }
}

#[test]
fn ten_thousand_pages_show_seven_items() {
    assert_eq!(
        pages(5_000, 10_000, 5),
        [
            Page(1),
            Ellipsis(2..4_999),
            Page(4_999),
            Page(5_000),
            Page(5_001),
            Ellipsis(5_002..10_000),
            Page(10_000),
        ]
    );
}

// The component.

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    page: u32,
    total: u32,
    visible: u32,
    controlled: bool,
    disabled: bool,
    compact: bool,
    drawn: bool,
}

fn props() -> HarnessProps {
    HarnessProps {
        page: 1,
        total: 10,
        visible: 5,
        controlled: true,
        disabled: false,
        compact: false,
        drawn: false,
    }
}

/// An item as text: what it is and its page, `*` on the current page, `!`
/// on what takes no press, an ellipsis's hidden pages.
fn item(s: &PaginationItemState) -> String {
    let marks = match (s.current, s.disabled) {
        (true, true) => "*!",
        (true, false) => "*",
        (false, true) => "!",
        (false, false) => "",
    };
    match s.kind {
        PaginationItemKind::Previous => format!("prev{}{marks}", s.page),
        PaginationItemKind::Next => format!("next{}{marks}", s.page),
        PaginationItemKind::Page => format!("p{}{marks}", s.page),
        PaginationItemKind::Ellipsis => {
            format!("…{}-{}", s.start.unwrap_or(0), s.end.unwrap_or(0))
        }
    }
}

/// A button before the pagination, the pagination (the app's page when
/// `controlled`, else it never moves), the page and what `onChange`
/// reported.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let page = signal(props.page);
    let log = signal(Vec::<String>::new());
    let controlled = props.controlled;
    let mut el = pagination()
        .page(move || page.get())
        .total_pages(props.total)
        .visible_pages(props.visible)
        .disabled(props.disabled)
        .compact(props.compact)
        .accessibility_label("Results pages")
        .previous_accessibility_label("Previous")
        .next_accessibility_label("Next")
        .on_change(move |p: &u32| {
            log.update(|l| l.push(p.to_string()));
            if controlled {
                page.set(*p);
            }
        })
        .child(text(move || format!("{} of {}", page.get(), props.total)));
    if props.drawn {
        el = el.render_item(|s: &PaginationItemState| text(item(s)));
    }
    view()
        .child(view().on_press(|| {}).child(text("Before")))
        .child(el)
        .child(text(move || format!("Log: {}", log.get().join(" "))))
}

fn start(props: HarnessProps) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(400.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || props.clone()))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app.wait_for("role:button[Next]").unwrap();
    app
}

fn log(app: &Headless) -> String {
    app.screen()
        .texts()
        .into_iter()
        .find_map(|t| t.strip_prefix("Log: ").map(str::to_owned))
        .unwrap_or_default()
}

/// The pages and ellipses shown, in order.
fn row(app: &Headless) -> Vec<String> {
    app.screen()
        .texts()
        .into_iter()
        .filter(|t| *t == "…" || t.parse::<u32>().is_ok())
        .map(str::to_owned)
        .collect()
}

#[test]
fn a_press_on_a_page_reports_it_and_the_app_sets_it() {
    let mut app = start(props());
    assert_eq!(row(&app), ["1", "2", "3", "…", "10"]);
    app.press("role:button[3]").unwrap();
    app.wait_for("text:3 of 10").unwrap();
    assert_eq!(log(&app), "3");
    assert_eq!(row(&app), ["1", "2", "3", "4", "…", "10"]);
    // The last page, past the ellipsis.
    app.press("role:button[10]").unwrap();
    app.wait_for("text:10 of 10").unwrap();
    assert_eq!(row(&app), ["1", "…", "8", "9", "10"]);
    assert_eq!(log(&app), "3 10");
}

#[test]
fn previous_and_next_report_the_pages_around_the_current_one() {
    let mut app = start(HarnessProps { page: 5, ..props() });
    app.press("role:button[Next]").unwrap();
    app.wait_for("text:6 of 10").unwrap();
    app.press("role:button[Previous]").unwrap();
    app.wait_for("text:5 of 10").unwrap();
    app.press("role:button[Previous]").unwrap();
    app.wait_for("text:4 of 10").unwrap();
    assert_eq!(log(&app), "6 5 4");
}

#[test]
fn the_current_page_reports_nothing() {
    let mut app = start(HarnessProps { page: 2, ..props() });
    app.press("role:button[2]").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(log(&app), "");
}

#[test]
fn a_controlled_page_moves_only_when_the_app_sets_it() {
    let mut app = start(HarnessProps {
        page: 4,
        controlled: false,
        ..props()
    });
    app.press("role:button[5]").unwrap();
    app.press("role:button[Next]").unwrap();
    app.wait_for("Log: 5 5").unwrap();
    // The app kept page 4: it stays current, Next still goes to 5.
    assert!(
        app.screen()
            .accessibility_state("role:button[4]")
            .unwrap()
            .selected
    );
    assert!(app.screen().matches("text:4 of 10").unwrap());
}

#[test]
fn previous_and_next_take_no_press_at_the_ends() {
    let mut app = start(props());
    assert!(!app.screen().enabled("role:button[Previous]").unwrap());
    assert!(
        app.screen()
            .accessibility_state("role:button[Previous]")
            .unwrap()
            .disabled
    );
    assert!(app.screen().enabled("role:button[Next]").unwrap());
    assert!(app.press("role:button[Previous]").is_err());
    app.press("role:button[10]").unwrap();
    app.wait_for("text:10 of 10").unwrap();
    assert!(app.screen().enabled("role:button[Previous]").unwrap());
    assert!(!app.screen().enabled("role:button[Next]").unwrap());
    assert!(app.press("role:button[Next]").is_err());
    assert_eq!(log(&app), "10");
}

#[test]
fn a_disabled_pagination_takes_no_press() {
    let mut app = start(HarnessProps {
        page: 5,
        disabled: true,
        ..props()
    });
    for name in ["Previous", "4", "5", "6", "Next"] {
        let selector = format!("role:button[{name}]");
        assert!(!app.screen().enabled(&selector).unwrap(), "{name}");
        assert!(app.press(&selector).is_err(), "{name}");
    }
    assert_eq!(log(&app), "");
}

#[test]
fn the_root_is_a_named_navigation_and_the_current_page_is_the_current_one() {
    let app = start(HarnessProps { page: 3, ..props() });
    assert!(
        app.screen()
            .matches("role:navigation[Results pages]")
            .unwrap()
    );
    let current = app.screen().accessibility_state("role:button[3]").unwrap();
    assert_eq!(current.current, Some(AccessibilityCurrent::Page));
    assert!(current.selected, "`selected:` classes style it");
    let other = app.screen().accessibility_state("role:button[4]").unwrap();
    assert_eq!(other.current, None);
    assert!(!other.selected);
}

#[test]
fn compact_shows_previous_the_children_and_next() {
    let mut app = start(HarnessProps {
        page: 3,
        compact: true,
        ..props()
    });
    assert!(row(&app).is_empty(), "{:?}", row(&app));
    assert!(app.screen().matches("text:3 of 10").unwrap());
    app.press("role:button[Next]").unwrap();
    app.wait_for("text:4 of 10").unwrap();
    assert!(row(&app).is_empty());
}

#[test]
fn render_item_draws_every_item_with_its_state() {
    let mut app = start(HarnessProps {
        page: 5,
        drawn: true,
        ..props()
    });
    for shown in [
        "prev4", "p1", "…2-4", "p4", "p5*", "p6", "…7-10", "p10", "next6",
    ] {
        app.wait_for(&format!("text:{shown}")).unwrap();
    }
    app.press("role:button[Next]").unwrap();
    app.wait_for("text:p6*").unwrap();
    app.wait_for("text:…2-5").unwrap();
    assert!(!app.screen().matches("text:p5*").unwrap());
}

#[test]
fn the_ends_are_drawn_disabled() {
    let mut app = start(HarnessProps {
        drawn: true,
        ..props()
    });
    app.wait_for("text:prev1!").unwrap();
    app.wait_for("text:next2").unwrap();
}

// The keyboard.

#[test]
fn every_page_previous_and_next_is_a_stop_of_tab() {
    let mut app = start(HarnessProps { page: 5, ..props() });
    // Before, Previous, 1, 4, 5 (the current page), 6, 10, Next: the
    // sixth stop is 6.
    for _ in 0..6 {
        app.press_key("tab").unwrap();
    }
    app.press_key("enter").unwrap();
    app.wait_for("text:6 of 10").unwrap();
    assert_eq!(log(&app), "6");
}

#[test]
fn a_page_pressed_from_the_keyboard_keeps_the_focus_where_it_lands() {
    let mut app = start(HarnessProps { page: 5, ..props() });
    // Before, Previous, 1, 4, 5, 6: the focus on 6, which then shows at
    // the place 5 had.
    for _ in 0..6 {
        app.press_key("tab").unwrap();
    }
    app.press_key("space").unwrap();
    app.wait_for("text:6 of 10").unwrap();
    assert_eq!(row(&app), ["1", "…", "5", "6", "7", "…", "10"]);
    // Return presses what has the focus: 6 again (nothing), then Tab
    // moves on to 7.
    app.press_key("enter").unwrap();
    app.wait(Duration::from_millis(50)).unwrap();
    assert_eq!(log(&app), "6");
    app.press_key("tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:7 of 10").unwrap();
    assert_eq!(log(&app), "6 7");
}

#[test]
fn next_onto_the_last_page_gives_it_the_focus() {
    let mut app = start(HarnessProps { page: 9, ..props() });
    // Before, Previous, 1, 8, 9, 10, Next.
    for _ in 0..7 {
        app.press_key("tab").unwrap();
    }
    app.press_key("enter").unwrap();
    app.wait_for("text:10 of 10").unwrap();
    // Next went disabled: the focus is on 10, so Shift+Tab reaches 9.
    app.press_key("shift+tab").unwrap();
    app.press_key("enter").unwrap();
    app.wait_for("text:9 of 10").unwrap();
    assert_eq!(log(&app), "10 9");
}

// The cost of a page change.

#[derive(Clone, PartialEq, Props)]
struct CountedProps {
    total: u32,
    visible: u32,
    drawn: bool,
    /// `renderItem` notes what it draws in [`DRAWN`] (one test at a time).
    noted: bool,
}

/// The item states `renderItem` drew, since the test took them.
static DRAWN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// A pagination whose page the app sets, as plain numbers or drawn by a
/// Rust `renderItem`.
#[component]
fn Counted(props: CountedProps) -> impl IntoElement {
    let page = signal(1u32);
    let mut el = pagination()
        .page(move || page.get())
        .total_pages(props.total)
        .visible_pages(props.visible)
        .previous_accessibility_label("Previous")
        .next_accessibility_label("Next")
        // Items of a fixed size, as an app's: a number of another width
        // moves no frame.
        .item_class("w-8 h-8")
        .on_change(move |p: &u32| page.set(*p));
    if props.drawn {
        let noted = props.noted;
        el = el.render_item(move |s: &PaginationItemState| {
            if noted {
                DRAWN.lock().unwrap().push(item(s));
            }
            text(item(s))
        });
    }
    view()
        .child(el)
        .child(text(move || format!("page {}", page.get())))
}

/// The views made and dropped, and the mount items sent, since the count
/// was reset.
#[derive(Default)]
struct Cost {
    made: AtomicUsize,
    items: AtomicUsize,
}

impl Cost {
    fn reset(&self) {
        self.made.store(0, Ordering::Relaxed);
        self.items.store(0, Ordering::Relaxed);
    }
}

fn start_counted(props: CountedProps) -> (Headless, Arc<Cost>) {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(400.0)),
        ..EngineConfig::new(Root::new::<Counted>(move || props.clone()))
    };
    config.environment.os = Os::MacOs;
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    let cost = Arc::new(Cost::default());
    let seen = cost.clone();
    app.observe(move |_, batch| {
        let made = batch
            .items
            .iter()
            .filter(|i| matches!(i, MountItem::Create { .. } | MountItem::Delete { .. }))
            .count();
        seen.made.fetch_add(made, Ordering::Relaxed);
        seen.items.fetch_add(batch.items.len(), Ordering::Relaxed);
    });
    app.wait_for("role:button[Next]").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    (app, cost)
}

/// Pages from the first to the last of 20 with Next, `visible` pages
/// shown, the items plain (`itemClass` only) or `drawn`: the ellipses come
/// and go, the current page moves through every place. Checks each page
/// change against `made` (views made and dropped) and `items` (mount
/// items), bounds of the places there are.
fn page_through(visible: u32, drawn: bool, made: fn(usize) -> usize, items: fn(usize) -> usize) {
    let (mut app, cost) = start_counted(CountedProps {
        total: 20,
        visible,
        drawn,
        noted: false,
    });
    // The pages and ellipses, Previous and Next.
    let places = visible as usize + 2 + 2;
    cost.reset();
    for page in 2..=20 {
        app.press("role:button[Next]").unwrap();
        app.wait_for(&format!("text:page {page}")).unwrap();
        app.idle(Duration::from_millis(20)).unwrap();
        let (m, n) = (
            cost.made.load(Ordering::Relaxed),
            cost.items.load(Ordering::Relaxed),
        );
        println!(
            "{visible} visible, drawn {drawn}, page {page}: {n} mount items, {m} views made or dropped"
        );
        assert!(m <= made(places), "page {page}: {m} views made or dropped");
        assert!(n <= items(places), "page {page}: {n} mount items");
        cost.reset();
    }
}

#[test]
fn a_page_change_makes_no_views() {
    for visible in [5, 7] {
        // Plain items (`itemClass`, the component's own numbers): the
        // app's text, and per place whose number, state or visibility
        // changed its text, the text's frame and its props; Previous and
        // Next at the ends. No view is made or dropped.
        page_through(visible, false, |_| 0, |places| 3 * places + 8);
    }
}

#[test]
fn a_page_change_with_a_rust_render_item_stays_bounded() {
    for visible in [5, 7] {
        // A Rust `renderItem` makes the content of each item whose state
        // changed again (a page change shifts most places' pages): at most
        // one content made and one dropped per item, and their props and
        // frames.
        page_through(visible, true, |places| 2 * places, |places| 8 * places + 8);
    }
}

#[test]
fn a_page_change_draws_only_the_items_it_changes() {
    let (mut app, cost) = start_counted(CountedProps {
        total: 10_000,
        visible: 5,
        drawn: true,
        noted: true,
    });
    // Page 1 to 2: page 1 and 2 change state, Previous and Next their
    // targets; the other places stay.
    DRAWN.lock().unwrap().clear();
    cost.reset();
    app.press("role:button[Next]").unwrap();
    app.wait_for("text:page 2").unwrap();
    app.idle(Duration::from_millis(20)).unwrap();
    let mut drawn = std::mem::take(&mut *DRAWN.lock().unwrap());
    drawn.sort();
    assert_eq!(drawn, ["next3", "p1", "p2*", "prev1"]);
    // A Rust closure makes its content again for each state it draws (the
    // app's JS function renders into the place's holder instead).
    println!(
        "drawn, page 2: {} mount items",
        cost.items.load(Ordering::Relaxed)
    );
    // A jump to the last page: every place shows another page.
    app.press("role:button[p10000]").unwrap();
    app.wait_for("text:page 10000").unwrap();
    app.idle(Duration::from_millis(20)).unwrap();
    assert!(app.screen().matches("text:…2-9998").unwrap());
    assert!(
        DRAWN.lock().unwrap().len() <= 7,
        "{:?}",
        DRAWN.lock().unwrap()
    );
}

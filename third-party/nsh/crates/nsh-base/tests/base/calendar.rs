//! `Calendar`: a press picks a day (a range from two), the value the app's
//! or the calendar's own; Previous / Next turn the month; the toggles show
//! the months and years to pick from; disabled dates take no press; the
//! days are one stop of Tab whose arrows move the keyboard; several months
//! show side by side from the week's first day; a turn of the months and
//! the keys' moves make no views and draw only the days they change. Today
//! is 2026-10-28 (the engine's manual clock).

use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};

use chrono::NaiveDate;
use nsh_base::{CalendarItemKind, CalendarItemState, Date, Matcher, calendar};
use nsh_core::{MountItem, Size, element::Root, platform::Os, prelude::*, time::Clock};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    value: Date,
    controlled: bool,
    range: bool,
    months: u32,
    first_day: u32,
    weekends_disabled: bool,
}

fn props() -> HarnessProps {
    HarnessProps {
        value: Date::Single(None),
        controlled: false,
        range: false,
        months: 1,
        first_day: 0,
        weekends_disabled: false,
    }
}

fn d(y: i32, m: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, day).unwrap()
}

fn show(v: &Date) -> String {
    let f = |d: Option<NaiveDate>| d.map(|d| d.to_string()).unwrap_or("-".into());
    match v {
        Date::Single(a) => f(*a),
        Date::Range(a, b) => format!("{}..{}", f(*a), f(*b)),
    }
}

/// An item as text: what it is, its number, and marks for its state (`*`
/// active, `~` in the range, `!` disabled, `@` today, `^` the keyboard's).
fn item(s: &CalendarItemState) -> String {
    let kind = match s.kind {
        CalendarItemKind::Previous => "prev".to_owned(),
        CalendarItemKind::Next => "next".to_owned(),
        CalendarItemKind::MonthToggle => format!("M{}/{}", s.value, s.year),
        CalendarItemKind::YearToggle => format!("Y{}", s.value),
        CalendarItemKind::Weekday => format!("w{}", s.value),
        CalendarItemKind::Day => format!("{}-{}", s.month, s.value),
        CalendarItemKind::Month => format!("m{}", s.value),
        CalendarItemKind::Year => format!("y{}", s.value),
    };
    let marks: String = [
        (s.active, '*'),
        (s.in_range, '~'),
        (s.disabled && s.kind == CalendarItemKind::Day, '!'),
        (s.today, '@'),
        (s.focused, '^'),
    ]
    .iter()
    .filter(|(on, _)| *on)
    .map(|(_, c)| *c)
    .collect();
    format!("{kind}{marks}")
}

#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let value = signal(props.value);
    let log = signal(Vec::<String>::new());
    let controlled = props.controlled;
    let mut el = calendar()
        .range(props.range)
        .number_of_months(props.months)
        .first_day_of_week(props.first_day)
        .previous_accessibility_label("Previous month")
        .next_accessibility_label("Next month")
        .render_item(|s: &CalendarItemState| text(item(s)))
        .on_change(move |v: &Date| {
            log.update(|l| l.push(show(v)));
            if controlled {
                value.set(*v);
            }
        });
    if props.weekends_disabled {
        el = el.disabled_matcher(Matcher::DayOfWeek(vec![0, 6]));
    }
    if props.controlled {
        el = el.value(move || value.get());
    } else {
        el = el.default_value(value.get_untracked());
    }
    view()
        .child(el)
        .child(text(move || format!("Log: {}", log.get().join(" "))))
}

/// On a Mac (a pointer, Tab stops at pressables), at noon UTC on
/// 2026-10-28.
fn start(props: HarnessProps) -> Headless {
    let mut app = launch(Root::new::<Harness>(move || props.clone()));
    app.wait_for("text:prev").unwrap();
    app
}

/// `root` on a Mac at noon UTC on 2026-10-28, rendered.
fn launch(root: Root) -> Headless {
    let mut config = EngineConfig {
        viewport: Size::new(px(800.0), px(844.0)),
        ..EngineConfig::new(root)
    };
    config.environment.os = Os::MacOs;
    config.clock = Clock::manual(SystemTime::UNIX_EPOCH + Duration::from_secs(1_793_188_800));
    let mut app = Headless::start(config).expect("the engine starts");
    app.first_render().unwrap();
    app
}

fn log(app: &Headless) -> String {
    app.screen()
        .texts()
        .into_iter()
        .find_map(|t| t.strip_prefix("Log: ").map(str::to_owned))
        .unwrap_or_default()
}

fn see(app: &mut Headless, text: &str) {
    if let Err(e) = app.wait_for(&format!("text:{text}")) {
        panic!("{e}; shown: {:?}", app.screen().texts());
    }
}

#[test]
fn a_press_picks_a_day_and_the_header_turns_the_month() {
    for controlled in [false, true] {
        let mut app = start(HarnessProps {
            controlled,
            ..props()
        });
        // Today's month, today marked.
        see(&mut app, "M10/2026");
        see(&mut app, "10-28@");
        app.press("label:2026-10-14").unwrap();
        see(&mut app, "10-14*");
        assert_eq!(log(&app), "2026-10-14");
        app.press("label:Next month").unwrap();
        see(&mut app, "M11/2026");
        see(&mut app, "11-30");
        // A day of the month after belongs to it: picking it turns there.
        app.press("label:2026-12-01").unwrap();
        see(&mut app, "M12/2026");
        see(&mut app, "12-1*");
        app.press("label:Previous month").unwrap();
        app.press("label:Previous month").unwrap();
        see(&mut app, "M10/2026");
        assert_eq!(log(&app), "2026-10-14 2026-12-01");
    }
}

#[test]
fn a_value_the_app_sets_shows_its_month() {
    let mut app = start(HarnessProps {
        value: d(2027, 3, 9).into(),
        controlled: true,
        ..props()
    });
    see(&mut app, "M3/2027");
    see(&mut app, "3-9*");
    assert_eq!(log(&app), "", "the app's value is not reported");
}

#[test]
fn a_range_takes_two_presses_and_reports_once_complete() {
    for controlled in [false, true] {
        let mut app = start(HarnessProps {
            value: Date::Range(None, None),
            controlled,
            range: true,
            ..props()
        });
        app.press("label:2026-10-20").unwrap();
        see(&mut app, "10-20*");
        assert_eq!(log(&app), "", "half a range is not reported");
        app.press("label:2026-10-23").unwrap();
        see(&mut app, "10-23*~");
        see(&mut app, "10-21~");
        see(&mut app, "10-20*~");
        assert_eq!(log(&app), "2026-10-20..2026-10-23");
        // A third press starts again.
        app.press("label:2026-10-05").unwrap();
        see(&mut app, "10-5*");
        see(&mut app, "10-21");
        assert_eq!(log(&app), "2026-10-20..2026-10-23");
    }
}

#[test]
fn disabled_dates_take_no_press() {
    let mut app = start(HarnessProps {
        weekends_disabled: true,
        ..props()
    });
    // 2026-10-24 is a Saturday.
    see(&mut app, "10-24!");
    assert!(app.press("label:2026-10-24").is_err(), "it takes no press");
    app.press("label:2026-10-23").unwrap();
    see(&mut app, "10-23*");
    assert_eq!(log(&app), "2026-10-23");
}

#[test]
fn the_toggles_pick_a_month_and_a_year() {
    let mut app = start(props());
    app.press("text:M10/2026").unwrap();
    see(&mut app, "m10*");
    see(&mut app, "m1");
    app.press("text:m3").unwrap();
    see(&mut app, "M3/2026");
    see(&mut app, "3-31");
    app.press("text:Y2026").unwrap();
    see(&mut app, "y2026*");
    // The page of twenty years with 2026: 2016 to 2035 from 1976.
    see(&mut app, "y2016");
    see(&mut app, "y2035");
    assert!(!app.shows("y2036"));
    app.press("label:Next month").unwrap();
    see(&mut app, "y2036");
    app.press("text:y2040").unwrap();
    see(&mut app, "M3/2040");
}

#[test]
fn the_days_are_one_stop_whose_arrows_move_the_keyboard() {
    let mut app = start(HarnessProps {
        value: d(2026, 10, 30).into(),
        ..props()
    });
    // Previous, the toggles and Next come first; then the selected day.
    for _ in 0..5 {
        app.press_key("tab").unwrap();
    }
    see(&mut app, "10-30*^");
    app.press_key("right").unwrap();
    see(&mut app, "10-31^");
    // Past the month: the next one shows.
    app.press_key("right").unwrap();
    see(&mut app, "M11/2026");
    see(&mut app, "11-1^");
    app.press_key("up").unwrap();
    see(&mut app, "M10/2026");
    see(&mut app, "10-25^");
    app.press_key("pagedown").unwrap();
    see(&mut app, "11-25^");
    app.press_key("enter").unwrap();
    see(&mut app, "11-25*^");
    assert_eq!(log(&app), "2026-11-25");
}

#[test]
fn several_months_show_side_by_side_from_the_first_day_of_the_week() {
    let mut app = start(HarnessProps {
        months: 2,
        first_day: 1,
        ..props()
    });
    see(&mut app, "M10/2026");
    see(&mut app, "M11/2026");
    let texts = app.screen().texts();
    let first = texts.iter().position(|t| t.starts_with('w')).unwrap();
    assert_eq!(texts[first], "w1", "the week starts on Monday");
    assert_eq!(texts[first + 6], "w0");
    app.press("label:Next month").unwrap();
    see(&mut app, "M12/2026");
}

// The cost of turns and keys.

#[derive(Clone, PartialEq, Props)]
struct PlainProps {
    months: u32,
    value: Date,
}

/// A calendar without `renderItem`: its items show their numbers.
#[component]
fn Plain(props: PlainProps) -> impl IntoElement {
    view().child(
        calendar()
            .number_of_months(props.months)
            .default_value(props.value)
            .previous_accessibility_label("Previous month")
            .next_accessibility_label("Next month"),
    )
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

    fn made(&self) -> usize {
        self.made.load(Ordering::Relaxed)
    }

    fn items(&self) -> usize {
        self.items.load(Ordering::Relaxed)
    }
}

/// A plain calendar of `months` showing `value`, with its cost counted.
fn start_plain(months: u32, value: Date) -> (Headless, Arc<Cost>) {
    let mut app = launch(Root::new::<Plain>(move || PlainProps { months, value }));
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
    app.wait_for("label:Next month").unwrap();
    (app, cost)
}

#[test]
fn a_turn_of_the_months_makes_no_views() {
    for months in [1, 2] {
        let (mut app, cost) = start_plain(months, d(2026, 10, 10).into());
        app.wait_for("label:2026-10-31").unwrap();
        app.idle(Duration::from_millis(50)).unwrap();
        cost.reset();
        // November and December take five weeks from Sunday, January 2027
        // six, February five: the cells stay, the sixth row hides and shows.
        for (turn, last) in ["2026-11-30", "2026-12-31", "2027-01-31", "2027-02-28"]
            .into_iter()
            .enumerate()
        {
            app.press("label:Next month").unwrap();
            app.wait_for(&format!("label:{last}")).unwrap();
            app.idle(Duration::from_millis(50)).unwrap();
            println!(
                "{months} month(s), turn {}: {} mount items",
                turn + 1,
                cost.items()
            );
            assert_eq!(cost.made(), 0, "a turn makes and drops no view");
            cost.reset();
        }
        if months == 1 {
            // The rows past the month's weeks are hidden: February 2027's
            // grid ends on Saturday, March 6.
            assert!(app.screen().matches("label:2027-03-06").unwrap());
            assert!(!app.screen().matches("label:2027-03-07").unwrap());
        }
    }
}

#[test]
fn held_page_keys_make_no_views() {
    let (mut app, cost) = start_plain(1, d(2026, 10, 10).into());
    // Previous, the toggles and Next, then the selected day.
    for _ in 0..5 {
        app.press_key("tab").unwrap();
    }
    app.idle(Duration::from_millis(50)).unwrap();
    cost.reset();
    // Each moves the focus to a cell of the next month: the keys stay
    // bound all the way to February.
    for _ in 0..4 {
        app.press_key("pagedown").unwrap();
    }
    app.wait_for("label:2027-02-10").unwrap();
    app.idle(Duration::from_millis(50)).unwrap();
    println!("four Page Downs: {} mount items", cost.items());
    assert_eq!(cost.made(), 0, "Page Down makes and drops no view");
}

/// The day states `renderItem` drew, since the test took them.
static DRAWN: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// A calendar whose `renderItem` notes each day state it draws.
#[component]
fn Noting() -> impl IntoElement {
    view().child(
        calendar()
            .default_value(d(2026, 10, 14))
            .render_item(|s: &CalendarItemState| {
                if s.kind == CalendarItemKind::Day {
                    DRAWN.lock().unwrap().push(item(s));
                }
                text(item(s))
            }),
    )
}

#[test]
fn an_arrow_draws_only_the_days_it_leaves_and_reaches() {
    let mut app = launch(Root::of::<Noting>());
    app.wait_for("text:prev").unwrap();
    for _ in 0..5 {
        app.press_key("tab").unwrap();
    }
    see(&mut app, "10-14*^");
    app.press_key("right").unwrap();
    see(&mut app, "10-15^");
    app.idle(Duration::from_millis(50)).unwrap();
    DRAWN.lock().unwrap().clear();
    // The focus moves from the 15th to the 16th: the keys stay bound, and
    // the selected day is not the stop on the way.
    app.press_key("right").unwrap();
    see(&mut app, "10-16^");
    app.idle(Duration::from_millis(50)).unwrap();
    let mut drawn = DRAWN.lock().unwrap().clone();
    drawn.sort();
    assert_eq!(drawn, ["10-15", "10-16^"]);
    // Across a week, the same.
    DRAWN.lock().unwrap().clear();
    app.press_key("down").unwrap();
    see(&mut app, "10-23^");
    app.idle(Duration::from_millis(50)).unwrap();
    let mut drawn = DRAWN.lock().unwrap().clone();
    drawn.sort();
    assert_eq!(drawn, ["10-16", "10-23^"]);
}

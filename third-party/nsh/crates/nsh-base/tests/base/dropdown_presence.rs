//! The presence of the dropdowns of `Select`, `Combobox` and `DatePicker`
//! on the desktops, as a popover's: opened, the popup has its starting look
//! (`popupStartingClass` / `popupStartingStyle`) in its first frame;
//! closed, it stays with its ending look for as long as its transitions
//! then run, taking no presses, and `onClose` comes after; the keyboard
//! focus is the trigger's again as it starts to go; a press outside it on
//! its way out is no attempt to close it; opened again on its way out, it
//! is taken back, unless the choice that closed it moved the focus out of
//! it (an `onChange` that focuses the next field); a searchable list keeps
//! its rows and query until it is gone. Without looks, or with reduced motion, it goes at once and nothing
//! more is sent. On a manual clock: time moves only as the test says.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use nsh_base::{
    CalendarEntry, CalendarItemKind, ComboboxEvent, DatePickerEvent, PickedDate, SelectEntry,
    SelectEvent, SelectItem, combobox, date_picker, select,
};
use nsh_core::{
    Color, Command, MountItem, NodeId, Size,
    element::Root,
    platform::{Idiom, Os},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// The popup's own background (`bg-black`), which tells it from the views
/// inside it.
const POPUP: Color = Color(0x0000_00ff);

/// What the platform was sent: the opacities of each view's styles in
/// order, whether it takes presses, and which view is the popup.
#[derive(Default)]
struct Seen {
    styles: HashMap<NodeId, Vec<f32>>,
    inert: HashMap<NodeId, bool>,
    popup: Option<NodeId>,
}

struct App {
    app: Headless,
    seen: Arc<Mutex<Seen>>,
}

impl App {
    fn popup(&self) -> NodeId {
        self.seen.lock().unwrap().popup.expect("a popup was made")
    }

    /// The opacities the popup was sent.
    fn popup_styles(&self) -> Vec<f32> {
        let popup = self.popup();
        let seen = self.seen.lock().unwrap();
        seen.styles.get(&popup).cloned().unwrap_or_default()
    }

    /// The opacity the popup was last sent.
    fn popup_opacity(&self) -> f32 {
        *self.popup_styles().last().expect("styled")
    }

    /// Whether the popup takes no presses.
    fn popup_inert(&self) -> bool {
        let popup = self.popup();
        let seen = self.seen.lock().unwrap();
        seen.inert.get(&popup).copied().unwrap_or(false)
    }

    /// Whether a view `selector` names is on screen.
    fn has(&self, selector: &str) -> bool {
        self.app.screen().matches(selector).unwrap()
    }

    /// Whether the calendar is on screen (its previous month button).
    fn shows_calendar(&self) -> bool {
        self.app.shows("prev")
    }

    /// Whether the view `selector` names was told to take the focus.
    fn focus_sent(&self, selector: &str) -> bool {
        self.focus_count(selector) > 0
    }

    /// How many times the view `selector` names was told to take the
    /// focus.
    fn focus_count(&self, selector: &str) -> usize {
        let screen = self.app.screen();
        let to = screen
            .press_target(selector)
            .unwrap()
            .unwrap_or_else(|| panic!("no `{selector}`"));
        screen
            .commands()
            .iter()
            .filter(|(id, c)| *id == to && *c == Command::Focus)
            .count()
    }
}

/// `root` on a Mac on a manual clock; `reduce_motion`: the user asked for
/// less motion.
fn start(root: Root, reduce_motion: bool) -> App {
    start_on(root, Os::MacOs, Idiom::Desktop, reduce_motion)
}

/// [`start`] on `os` in `idiom`.
fn start_on(root: Root, os: Os, idiom: Idiom, reduce_motion: bool) -> App {
    let mut config = EngineConfig {
        viewport: Size::new(px(390.0), px(844.0)),
        clock: nsh_engine::Clock::manual(std::time::SystemTime::now()),
        ..EngineConfig::new(root)
    };
    config.environment.os = os;
    config.environment.idiom = idiom;
    config.environment.reduce_motion = reduce_motion;
    let mut app = Headless::start(config).expect("the engine starts");
    let seen = Arc::new(Mutex::new(Seen::default()));
    let into = seen.clone();
    app.observe(move |_, batch| {
        let mut seen = into.lock().unwrap();
        for item in &batch.items {
            match item {
                MountItem::ViewProps { id, props } => {
                    seen.inert
                        .insert(*id, props.pointer_events == PointerEvents::None);
                }
                MountItem::ViewStyle { id, style } => {
                    if style.background_color == POPUP {
                        seen.popup = Some(*id);
                    }
                    seen.styles.entry(*id).or_default().push(style.opacity);
                }
                _ => {}
            }
        }
    });
    app.first_render().unwrap();
    App { app, seen }
}

#[derive(Clone, PartialEq, Props)]
struct ScreenProps {
    /// The popup's starting and ending looks set.
    looks: bool,
}

/// What the app heard, as `Log: …`.
fn log_text(log: Signal<Vec<&'static str>>) -> impl IntoElement {
    text(move || format!("Log: {}", log.get().join(" ")))
}

/// A view outside the dropdown that takes presses.
fn elsewhere() -> impl IntoElement {
    view()
        .test_id("elsewhere")
        .w(px(40.0))
        .h(px(40.0))
        .on_press(|| {})
}

/// A select whose popup fades for 200 ms between its look and its
/// starting and ending looks (styles), and the select's lifecycle.
#[component]
fn SelectScreen(props: ScreenProps) -> impl IntoElement {
    let log = signal(Vec::<&str>::new());
    let push = move |s| log.update(|l| l.push(s));
    let looks = props.looks;
    let mut el = select()
        .items(vec![
            SelectItem::new("apple", "Apple"),
            SelectItem::new("pear", "Pear"),
        ])
        .accessibility_label("Fruit")
        .popup_class("bg-black transition-opacity duration-200")
        .render_item(|e: &SelectEntry| text(e.title.clone()))
        .trigger(
            view()
                .test_id("trigger")
                .w(px(160.0))
                .h(px(30.0))
                .child(text("Pick")),
        )
        .on_open_change(move |e: &SelectEvent| {
            if let SelectEvent::OpenChange(next, _) = e {
                push(if *next {
                    "openChange:true"
                } else {
                    "openChange:false"
                });
            }
        })
        .on_open(move || push("open"))
        .on_close(move || push("close"))
        .on_cancel(move || push("cancel"))
        .w(px(200.0));
    if looks {
        el = el
            .popup_starting_style(|s| s.opacity(0.0))
            .popup_ending_style(|s| s.opacity(0.0));
    }
    view()
        .pt(px(40.0))
        .pl(px(20.0))
        .child(el)
        .child(elsewhere())
        .child(log_text(log))
}

fn select_app(looks: bool, reduce_motion: bool) -> App {
    start(
        Root::new::<SelectScreen>(move || ScreenProps { looks }),
        reduce_motion,
    )
}

#[test]
fn a_select_list_has_its_starting_look_in_its_first_frame() {
    let mut app = select_app(true, false);
    app.app.press("role:combobox").unwrap();
    app.app.wait_for("role:listbox").unwrap();
    assert_eq!(
        app.popup_styles().first(),
        Some(&0.0),
        "made with its starting look"
    );
    app.app.run_for(Duration::from_millis(50)).unwrap();
    assert_eq!(app.popup_opacity(), 1.0, "its look from its first frame on");
}

#[test]
fn a_select_list_stays_with_its_ending_look_until_its_exit_ran() {
    let mut app = select_app(true, false);
    app.app.press("role:combobox").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.wait_for("Log: openChange:true open").unwrap();
    app.app.press("role:option[Pear]").unwrap();
    app.app.run_for(Duration::from_millis(100)).unwrap();
    assert!(app.app.shows("Pear"), "kept while it goes");
    assert_eq!(app.popup_opacity(), 0.0, "with its ending look");
    assert!(app.popup_inert(), "taking no presses");
    assert!(
        app.focus_sent("role:combobox"),
        "the trigger has the keyboard again as the list starts to go"
    );
    assert!(
        app.app.shows("Log: openChange:true open openChange:false"),
        "not closed yet"
    );
    app.app.run_for(Duration::from_millis(150)).unwrap();
    assert!(!app.has("role:listbox"), "gone once its 200 ms ran");
    app.app
        .wait_for("Log: openChange:true open openChange:false close")
        .unwrap();
}

#[test]
fn a_press_outside_a_select_list_on_its_way_out_is_no_attempt() {
    let mut app = select_app(true, false);
    app.app.press("role:combobox").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.press_key("escape").unwrap();
    app.app
        .wait_for("Log: openChange:true open cancel openChange:false")
        .unwrap();
    app.app.press("id:elsewhere").unwrap();
    app.app.run_for(Duration::from_millis(500)).unwrap();
    app.app
        .wait_for("Log: openChange:true open cancel openChange:false close")
        .unwrap();
}

#[test]
fn reopening_a_select_list_on_its_way_out_takes_it_back() {
    let mut app = select_app(true, false);
    app.app.press("role:combobox").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.press("role:combobox").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.press("role:combobox").unwrap();
    app.app.run_for(Duration::from_millis(500)).unwrap();
    assert!(app.has("role:listbox"), "an old exit does not take it away");
    assert_eq!(app.popup_opacity(), 1.0, "back to its look");
    assert!(
        app.app
            .shows("Log: openChange:true open openChange:false openChange:true"),
        "never gone: neither closed nor opened again"
    );
}

#[test]
fn with_reduced_motion_a_select_list_goes_at_once() {
    let mut app = select_app(true, true);
    app.app.press("role:combobox").unwrap();
    app.app.wait_for("role:listbox").unwrap();
    assert_eq!(app.popup_opacity(), 1.0, "no starting look");
    app.app.press("role:combobox").unwrap();
    assert!(!app.has("role:listbox"));
    app.app
        .wait_for("Log: openChange:true open openChange:false close")
        .unwrap();
}

#[test]
fn a_select_list_without_looks_goes_at_once_and_sends_nothing_more() {
    let mut app = select_app(false, false);
    app.app.press("role:combobox").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    let styled = app.popup_styles().len();
    app.app.press("role:combobox").unwrap();
    assert!(!app.has("role:listbox"), "gone in the turn that closed it");
    app.app
        .wait_for("Log: openChange:true open openChange:false close")
        .unwrap();
    assert_eq!(
        app.popup_styles().len(),
        styled,
        "no style sent to the popup as it closes"
    );
}

/// A searchable select whose popup fades out for 200 ms (its ending look).
#[component]
fn SearchScreen(_props: ScreenProps) -> impl IntoElement {
    view().pt(px(40.0)).pl(px(20.0)).child(
        select()
            .items(vec![
                SelectItem::new("apple", "Apple"),
                SelectItem::new("pear", "Pear"),
            ])
            .searchable(true)
            .search_placeholder("Search")
            .accessibility_label("Fruit")
            .popup_class("bg-black transition-opacity duration-200")
            .popup_ending_style(|s| s.opacity(0.0))
            .render_item(|e: &SelectEntry| text(e.title.clone()))
            .trigger(view().w(px(160.0)).h(px(30.0)).child(text("Pick")))
            .w(px(200.0)),
    )
}

/// [`SearchScreen`] with its list open and "pe" typed in its search
/// field: only Pear shows.
fn searched() -> App {
    let mut app = start(
        Root::new::<SearchScreen>(|| ScreenProps { looks: true }),
        false,
    );
    app.app.press("role:combobox").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    app.app.type_text("Search", "pe").unwrap();
    app.app.run_for(Duration::from_millis(16)).unwrap();
    assert!(app.has("role:option[Pear]"));
    assert!(!app.has("role:option[Apple]"), "filtered while open");
    app
}

#[test]
fn a_searchable_list_keeps_its_rows_while_it_goes() {
    let mut app = searched();
    app.app.press_key("escape").unwrap();
    app.app.run_for(Duration::from_millis(100)).unwrap();
    assert!(app.has("role:listbox"), "still going");
    assert_eq!(app.popup_opacity(), 0.0, "with its ending look");
    assert!(app.has("role:option[Pear]"));
    assert!(
        !app.has("role:option[Apple]"),
        "the rows it showed stay while it fades"
    );
    app.app.run_for(Duration::from_millis(150)).unwrap();
    assert!(!app.has("role:listbox"), "gone once its 200 ms ran");
}

#[test]
fn a_searchable_list_opened_again_shows_every_row() {
    // Once it is gone.
    let mut app = searched();
    app.app.press_key("escape").unwrap();
    app.app.run_for(Duration::from_millis(500)).unwrap();
    assert!(!app.has("role:listbox"));
    app.app.press("role:combobox").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    assert!(app.has("role:option[Apple]"), "the query starts again");
    assert!(app.has("role:option[Pear]"));
    // On its way out: taken back, with the query started again too.
    let mut app = searched();
    app.app.press_key("escape").unwrap();
    app.app.run_for(Duration::from_millis(50)).unwrap();
    assert!(app.has("role:listbox"), "still going");
    app.app.press("role:combobox").unwrap();
    app.app.run_for(Duration::from_millis(500)).unwrap();
    assert!(app.has("role:listbox"), "taken back");
    assert!(app.has("role:option[Apple]"), "the query starts again");
    assert!(app.has("role:option[Pear]"));
}

/// A combobox whose popup fades for 200 ms between its look and its
/// starting and ending looks (classes).
#[component]
fn ComboboxScreen(props: ScreenProps) -> impl IntoElement {
    let log = signal(Vec::<&str>::new());
    let push = move |s| log.update(|l| l.push(s));
    let mut el = combobox()
        .items(vec![
            SelectItem::new("rust", "Rust"),
            SelectItem::new("swift", "Swift"),
        ])
        .accessibility_label("Language")
        .trigger_button(text("Pick"))
        .popup_class("bg-black transition-opacity duration-200")
        .render_item(|e: &SelectEntry| text(e.title.clone()))
        .on_open_change(move |e: &ComboboxEvent| {
            if let ComboboxEvent::OpenChange(next, _) = e {
                push(if *next {
                    "openChange:true"
                } else {
                    "openChange:false"
                });
            }
        })
        .on_open(move || push("open"))
        .on_close(move || push("close"))
        .w(px(200.0));
    if props.looks {
        el = el
            .popup_starting_class("opacity-0")
            .popup_ending_class("opacity-0");
    }
    view()
        .pt(px(40.0))
        .pl(px(20.0))
        .child(el)
        .child(elsewhere())
        .child(log_text(log))
}

#[test]
fn a_combobox_list_comes_in_and_goes_with_its_looks() {
    let mut app = start(
        Root::new::<ComboboxScreen>(|| ScreenProps { looks: true }),
        false,
    );
    app.app.press("text:Pick").unwrap();
    app.app.wait_for("role:listbox").unwrap();
    assert_eq!(
        app.popup_styles().first(),
        Some(&0.0),
        "made with its starting look"
    );
    app.app.run_for(Duration::from_millis(50)).unwrap();
    assert_eq!(app.popup_opacity(), 1.0, "its look from its first frame on");
    app.app.press_key("escape").unwrap();
    app.app.run_for(Duration::from_millis(100)).unwrap();
    assert!(app.app.shows("Swift"), "kept while it goes");
    assert_eq!(app.popup_opacity(), 0.0, "with its ending look");
    assert!(app.popup_inert(), "taking no presses");
    assert!(app.app.shows("Log: openChange:true open openChange:false"));
    app.app.run_for(Duration::from_millis(150)).unwrap();
    assert!(!app.has("role:listbox"), "gone once its 200 ms ran");
    app.app
        .wait_for("Log: openChange:true open openChange:false close")
        .unwrap();
}

/// A date picker whose popup fades for 200 ms between its look and its
/// starting and ending looks (classes).
#[component]
fn DatePickerScreen(props: ScreenProps) -> impl IntoElement {
    let log = signal(Vec::<&str>::new());
    let push = move |s| log.update(|l| l.push(s));
    let mut el = date_picker()
        .accessibility_label("Due")
        .popup_class("bg-black transition-opacity duration-200")
        .render_item(|e: &CalendarEntry| {
            text(match e.kind {
                CalendarItemKind::Previous => "prev".into(),
                _ => format!("{}-{}", e.month, e.value),
            })
        })
        .trigger(
            view()
                .test_id("trigger")
                .w(px(160.0))
                .h(px(30.0))
                .child(text("Pick")),
        )
        .on_open_change(move |e: &DatePickerEvent| {
            if let DatePickerEvent::OpenChange(next, _) = e {
                push(if *next {
                    "openChange:true"
                } else {
                    "openChange:false"
                });
            }
        })
        .on_open(move || push("open"))
        .on_close(move || push("close"));
    if props.looks {
        el = el
            .popup_starting_class("opacity-0")
            .popup_ending_class("opacity-0");
    }
    view()
        .pt(px(40.0))
        .pl(px(20.0))
        .child(el)
        .child(elsewhere())
        .child(log_text(log))
}

#[test]
fn a_date_picker_calendar_comes_in_and_goes_with_its_looks() {
    let mut app = start(
        Root::new::<DatePickerScreen>(|| ScreenProps { looks: true }),
        false,
    );
    app.app.press("id:trigger").unwrap();
    app.app.wait_for("text:prev").unwrap();
    assert_eq!(
        app.popup_styles().first(),
        Some(&0.0),
        "made with its starting look"
    );
    app.app.run_for(Duration::from_millis(50)).unwrap();
    assert_eq!(app.popup_opacity(), 1.0, "its look from its first frame on");
    app.app.press_key("escape").unwrap();
    app.app.run_for(Duration::from_millis(100)).unwrap();
    assert!(app.shows_calendar(), "kept while it goes");
    assert_eq!(app.popup_opacity(), 0.0, "with its ending look");
    assert!(app.popup_inert(), "taking no presses");
    assert!(
        app.focus_sent("id:trigger"),
        "the trigger has the keyboard again as the calendar starts to go"
    );
    app.app.run_for(Duration::from_millis(150)).unwrap();
    assert!(!app.shows_calendar(), "gone once its 200 ms ran");
    app.app
        .wait_for("Log: openChange:true open openChange:false close")
        .unwrap();
}

/// A dropdown chosen in, and the next field of the form beside it.
#[derive(Clone, PartialEq, Props)]
struct ChoiceProps {
    /// The app owns `open`, following `onOpenChange`: the choice's focus
    /// and the closing come in one turn.
    controlled: bool,
    /// The app's `onChange` focuses the next field.
    moves: bool,
}

/// The view outside the dropdown an app's `onChange` focuses (the next
/// field of a form).
fn next_field(field: ElementRef) -> impl IntoElement {
    view()
        .element_ref(&field)
        .test_id("field")
        .focusable(true)
        .w(px(120.0))
        .h(px(30.0))
        .on_press(|| {})
}

/// For a dropdown left to itself and one whose `open` the app owns, with
/// and without an `onChange` that focuses the next field: `open` opens
/// it, `choose` chooses in it. The focus goes back to `back` (the trigger,
/// a combobox's input) only when the choice moved it nowhere.
fn a_choice_gives_the_focus_back_unless_it_moved_it(
    root: fn(ChoiceProps) -> Root,
    back: &str,
    open: fn(&mut Headless),
    choose: fn(&mut Headless),
) {
    for controlled in [false, true] {
        for moves in [false, true] {
            let case = format!("controlled {controlled}, moves {moves}");
            let mut app = start(root(ChoiceProps { controlled, moves }), false);
            open(&mut app.app);
            app.app.run_for(Duration::from_millis(50)).unwrap();
            let (given_back, field) = (app.focus_count(back), app.focus_count("id:field"));
            choose(&mut app.app);
            app.app.run_for(Duration::from_millis(50)).unwrap();
            if moves {
                assert!(
                    app.focus_count("id:field") > field,
                    "{case}: the field took the focus"
                );
                assert_eq!(
                    app.focus_count(back),
                    given_back,
                    "{case}: the focus stays on the field"
                );
            } else {
                assert!(
                    app.focus_count(back) > given_back,
                    "{case}: the focus goes back to `{back}`"
                );
            }
        }
    }
}

/// A select whose `onChange` focuses the next field when `moves`.
#[component]
fn SelectChoice(props: ChoiceProps) -> impl IntoElement {
    let field = element_ref();
    let open = signal(false);
    let moves = props.moves;
    let mut el = select()
        .items(vec![
            SelectItem::new("apple", "Apple"),
            SelectItem::new("pear", "Pear"),
        ])
        .accessibility_label("Fruit")
        .render_item(|e: &SelectEntry| text(e.title.clone()))
        .trigger(
            view()
                .test_id("trigger")
                .w(px(160.0))
                .h(px(30.0))
                .child(text("Pick")),
        )
        .on_change(move |_: &Option<SharedString>| {
            if moves {
                field.focus();
            }
        })
        .w(px(200.0));
    if props.controlled {
        el = el
            .open(move || Some(open.get()))
            .on_open_change(move |e: &SelectEvent| {
                if let SelectEvent::OpenChange(next, _) = e {
                    open.set(*next);
                }
            });
    }
    view()
        .pt(px(40.0))
        .pl(px(20.0))
        .child(el)
        .child(next_field(field))
}

#[test]
fn a_select_choice_that_focuses_another_field_keeps_the_focus_there() {
    a_choice_gives_the_focus_back_unless_it_moved_it(
        |p| Root::new::<SelectChoice>(move || p.clone()),
        "role:combobox",
        |app| {
            app.press("role:combobox").unwrap();
            app.wait_for("role:listbox").unwrap();
        },
        |app| {
            app.press("role:option[Pear]").unwrap();
            assert!(!app.screen().matches("role:listbox").unwrap(), "closed");
        },
    );
}

/// A combobox whose `onChange` focuses the next field when `moves`.
#[component]
fn ComboboxChoice(props: ChoiceProps) -> impl IntoElement {
    let field = element_ref();
    let open = signal(false);
    let moves = props.moves;
    let mut el = combobox()
        .items(vec![
            SelectItem::new("rust", "Rust"),
            SelectItem::new("swift", "Swift"),
        ])
        .accessibility_label("Language")
        .trigger_button(text("Pick"))
        .render_item(|e: &SelectEntry| text(e.title.clone()))
        .on_change(move |_: &Vec<SharedString>| {
            if moves {
                field.focus();
            }
        })
        .w(px(200.0));
    if props.controlled {
        el = el
            .open(move || Some(open.get()))
            .on_open_change(move |e: &ComboboxEvent| {
                if let ComboboxEvent::OpenChange(next, _) = e {
                    open.set(*next);
                }
            });
    }
    view()
        .pt(px(40.0))
        .pl(px(20.0))
        .child(el)
        .child(next_field(field))
}

#[test]
fn a_combobox_choice_that_focuses_another_field_keeps_the_focus_there() {
    // The focus goes back to the combobox's input.
    a_choice_gives_the_focus_back_unless_it_moved_it(
        |p| Root::new::<ComboboxChoice>(move || p.clone()),
        "role:combobox",
        |app| {
            app.press("text:Pick").unwrap();
            app.wait_for("role:listbox").unwrap();
        },
        |app| {
            app.press("role:option[Swift]").unwrap();
            assert!(!app.screen().matches("role:listbox").unwrap(), "closed");
        },
    );
}

/// A date picker whose `onChange` focuses the next field when `moves`.
#[component]
fn DatePickerChoice(props: ChoiceProps) -> impl IntoElement {
    let field = element_ref();
    let open = signal(false);
    let moves = props.moves;
    let mut el = date_picker()
        .accessibility_label("Due")
        .render_item(|e: &CalendarEntry| {
            text(match e.kind {
                CalendarItemKind::Previous => "prev".into(),
                _ => format!("{}-{}", e.month, e.value),
            })
        })
        .trigger(
            view()
                .test_id("trigger")
                .w(px(160.0))
                .h(px(30.0))
                .child(text("Pick")),
        )
        .on_change(move |_: &PickedDate| {
            if moves {
                field.focus();
            }
        });
    if props.controlled {
        el = el
            .open(move || Some(open.get()))
            .on_open_change(move |e: &DatePickerEvent| {
                if let DatePickerEvent::OpenChange(next, _) = e {
                    open.set(*next);
                }
            });
    }
    view()
        .pt(px(40.0))
        .pl(px(20.0))
        .child(el)
        .child(next_field(field))
}

#[test]
fn a_date_picker_choice_that_focuses_another_field_keeps_the_focus_there() {
    // From the keyboard: Return opens the calendar with the keyboard on
    // today's day, and Return again chooses it.
    a_choice_gives_the_focus_back_unless_it_moved_it(
        |p| Root::new::<DatePickerChoice>(move || p.clone()),
        "id:trigger",
        |app| {
            app.press_key("tab").unwrap();
            app.press_key("enter").unwrap();
            app.wait_for("text:prev").unwrap();
        },
        |app| {
            app.press_key("enter").unwrap();
            assert!(!app.shows("prev"), "closed");
        },
    );
}

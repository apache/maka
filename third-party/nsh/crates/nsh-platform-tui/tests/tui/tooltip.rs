//! A tooltip in a terminal shows at once next to its trigger while the
//! keyboard focus or the pointer is on it, the pointer's over the focus's,
//! and leaves the bottom row (the toasts' status line) alone.

use nsh_base::{button, tooltip};
use nsh_core::prelude::*;
use nsh_platform_tui::{App, MouseKind, Root};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::{
    app::{draw_until, mouse, surface},
    dock::{dump, find},
};

/// Two buttons with tooltips (delays far too long to wait for, which a
/// terminal does not wait), a third without, and a line at the top.
#[component]
fn Toolbar() -> impl IntoElement {
    let tip = |says: &'static str| tooltip().delay(100_000.0).child(text(says));
    view().flex_1().child(text("ready")).child(
        view()
            .flex_row()
            .gap(px(16.0))
            .child(
                view()
                    .tooltip(tip("Saves it"))
                    .child(button().child(text("Save"))),
            )
            .child(
                view()
                    .tooltip(tip("Opens one"))
                    .child(button().child(text("Open"))),
            )
            .child(button().child(text("Quit"))),
    )
}

/// The text of row `y`.
fn row(terminal: &Terminal<TestBackend>, y: u16) -> String {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.width)
        .map(|x| buffer[(x, y)].symbol())
        .collect::<String>()
}

fn press_tab(view: &mut nsh_platform_tui::AppView, shift: bool) {
    view.handle(nsh_platform_tui::Input::Key {
        key: "tab".into(),
        modifiers: nsh_platform_tui::Modifiers {
            shift,
            ..Default::default()
        },
        release: false,
    });
}

/// The row holding `needle`, if any.
fn row_of(terminal: &Terminal<TestBackend>, needle: &str) -> Option<u16> {
    (0..terminal.backend().buffer().area.height).find(|&y| row(terminal, y).contains(needle))
}

#[test]
fn a_tooltip_shows_next_to_its_trigger_for_the_focus_and_the_pointer() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<Toolbar>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Quit");
    let bottom = 9;

    // The focus on Save: its tooltip next to the button, off the bottom
    // row.
    press_tab(&mut view, false);
    draw_until(&mut view, &mut terminal, &rx, "Saves it");
    let (_, buttons) = find(&terminal, "Save").unwrap();
    let at = row_of(&terminal, "Saves it").unwrap();
    assert!(at != bottom, "off the status line\n{}", dump(&terminal));
    assert!(
        at.abs_diff(buttons) <= 3,
        "next to its trigger\n{}",
        dump(&terminal)
    );

    // The pointer on Open, at once: its tooltip shows instead; off it,
    // the focus's comes back.
    let (open, y) = find(&terminal, "Open").unwrap();
    view.handle(mouse(MouseKind::Move, open + 1, y));
    draw_until(&mut view, &mut terminal, &rx, "Opens one");
    assert!(
        !dump(&terminal).contains("Saves it"),
        "one at a time\n{}",
        dump(&terminal)
    );
    view.handle(mouse(MouseKind::Move, 39, 0));
    draw_until(&mut view, &mut terminal, &rx, "Saves it");
    assert!(
        !dump(&terminal).contains("Opens one"),
        "{}",
        dump(&terminal)
    );

    // The focus on Open, then on Quit, which has none: it goes.
    press_tab(&mut view, false);
    draw_until(&mut view, &mut terminal, &rx, "Opens one");
    press_tab(&mut view, false);
    super::app::draw_until_gone(&mut view, &mut terminal, &rx, "Opens one");
}

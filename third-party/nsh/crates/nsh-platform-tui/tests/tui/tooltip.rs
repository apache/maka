//! A tooltip in a terminal is a line, not a bubble: what it says shows at
//! once on the bottom row of the viewport while the keyboard focus or the
//! pointer is on its trigger, the pointer's over the focus's, and nothing
//! takes Cells by the trigger.

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

#[test]
fn a_tooltip_shows_on_the_bottom_row_for_the_focus_and_the_pointer() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<Toolbar>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Quit");
    let bottom = 9;

    // The focus on Save: its tooltip on the bottom row, from its start,
    // and nothing by the button.
    press_tab(&mut view, false);
    draw_until(&mut view, &mut terminal, &rx, "Saves it");
    assert!(
        row(&terminal, bottom).starts_with("Saves it"),
        "on the bottom row\n{}",
        dump(&terminal)
    );
    let (_, buttons) = find(&terminal, "Save").unwrap();
    for y in 0..bottom {
        assert!(
            !row(&terminal, y).contains("Saves it"),
            "only there\n{}",
            dump(&terminal)
        );
        if y != buttons {
            assert!(
                row(&terminal, y).trim().is_empty() || row(&terminal, y).contains("ready"),
                "no bubble by the trigger\n{}",
                dump(&terminal)
            );
        }
    }

    // The pointer on Open, at once: its tooltip takes the line; off it,
    // the focus's comes back.
    let (open, y) = find(&terminal, "Open").unwrap();
    view.handle(mouse(MouseKind::Move, open + 1, y));
    draw_until(&mut view, &mut terminal, &rx, "Opens one");
    assert!(
        row(&terminal, bottom).starts_with("Opens one"),
        "{}",
        dump(&terminal)
    );
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

    // The focus on Open, then on Quit, which has none: the line clears.
    press_tab(&mut view, false);
    draw_until(&mut view, &mut terminal, &rx, "Opens one");
    assert!(
        row(&terminal, bottom).starts_with("Opens one"),
        "{}",
        dump(&terminal)
    );
    press_tab(&mut view, false);
    super::app::draw_until_gone(&mut view, &mut terminal, &rx, "Opens one");
    assert!(
        row(&terminal, bottom).trim().is_empty(),
        "{}",
        dump(&terminal)
    );
}

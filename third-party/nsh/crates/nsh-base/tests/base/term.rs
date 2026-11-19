//! `Terminal`: reports its size in cells once it is laid out, whatever that
//! size is, the one its emulator starts at (80 × 24) included.

use nsh_base::{TerminalEvent, terminal};
use nsh_core::{
    Size,
    element::{Root, measure_text},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

#[derive(Clone, PartialEq, Props)]
struct HarnessProps {
    /// How many of the terminal's columns its box is wide.
    cols: u16,
}

/// A terminal in a box `cols` of its cells wide and 24 rows high (half a
/// cell over each way, so rounding never loses one), and the sizes it
/// reported.
#[component]
fn Harness(props: HarnessProps) -> impl IntoElement {
    let sizes = signal(Vec::<String>::new());
    let cell = measure_text("13px monospace", "0000000000") / 10.0;
    view()
        .child(
            view()
                .w(Length::from(cell * (props.cols as f32 + 0.5)))
                .h(px(18.0 * 24.5))
                .child(terminal().font_family("monospace").flex_1().on_resize(
                    move |e: &TerminalEvent| {
                        if let TerminalEvent::Resize(cols, rows) = e {
                            sizes.update(|s| s.push(format!("{cols}x{rows}")));
                        }
                    },
                )),
        )
        .child(text(move || format!("Sizes {}", sizes.get().join(", "))))
}

fn start(cols: u16) -> Headless {
    let config = EngineConfig {
        viewport: Size::new(px(1200.0), px(800.0)),
        ..EngineConfig::new(Root::new::<Harness>(move || HarnessProps { cols }))
    };
    Headless::start(config).expect("the engine starts")
}

#[test]
fn the_first_layout_reports_the_size_even_at_the_one_the_emulator_starts_at() {
    let mut app = start(80);
    app.wait_for("text:Sizes 80x24").unwrap();
    let mut wider = start(81);
    wider.wait_for("text:Sizes 81x24").unwrap();
}

/// A terminal whose box widens a column every 10ms from 80 to 90, as a
/// split's handle dragged across it does, and the sizes it reported.
#[component]
fn Dragged(_props: HarnessProps) -> impl IntoElement {
    let sizes = signal(Vec::<String>::new());
    let cols = signal(80u16);
    let cell = measure_text("13px monospace", "0000000000") / 10.0;
    let _drag = set_interval(std::time::Duration::from_millis(10), move || {
        if cols.get_untracked() < 90 {
            cols.update(|c| *c += 1);
        }
    });
    view()
        .child(
            view()
                .w(move || Length::from(cell * (cols.get() as f32 + 0.5)))
                .h(px(18.0 * 24.5))
                .child(terminal().font_family("monospace").flex_1().on_resize(
                    move |e: &TerminalEvent| {
                        if let TerminalEvent::Resize(cols, rows) = e {
                            sizes.update(|s| s.push(format!("{cols}x{rows}")));
                        }
                    },
                )),
        )
        .child(text(move || format!("Sizes {}", sizes.get().join(", "))))
}

#[test]
fn a_drag_resizes_the_terminal_once_it_settles_not_at_every_column() {
    let config = EngineConfig {
        viewport: Size::new(px(1200.0), px(800.0)),
        ..EngineConfig::new(Root::new::<Dragged>(|| HarnessProps { cols: 80 }))
    };
    let mut app = Headless::start(config).expect("the engine starts");
    app.wait_for("text:Sizes 80x24, 90x24").unwrap();
}

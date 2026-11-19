//! `Terminal` draws a line by cell: a wide character and the text after
//! it sit on the columns the emulator gave them, as the backgrounds and
//! the cursor do, whatever the font's own advances; the segments a line is
//! drawn in continue each other, so a selection copies the line whole.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU32, Ordering},
};

use nsh_base::{TerminalEmulator, TerminalEmulatorFactory, VtEmulator, terminal};
use nsh_core::{
    MountItem, Size, ViewKind,
    element::{Root, measure_text},
    prelude::*,
};
use nsh_engine::EngineConfig;
use nsh_testing::Headless;

/// A cell's width and a CJK character's advance, as the harness measured
/// them.
static CELL: AtomicU32 = AtomicU32::new(0);
static ZHONG: AtomicU32 = AtomicU32::new(0);

/// A terminal 400 wide and five rows of 18 high, whose emulator has
/// `ab中cd|` on its first line.
#[component]
fn Harness() -> impl IntoElement {
    let cell = measure_text("13px monospace", "0000000000") / 10.0;
    CELL.store(cell.0.to_bits(), Ordering::Relaxed);
    ZHONG.store(
        measure_text("13px monospace", "中").0.to_bits(),
        Ordering::Relaxed,
    );
    provide_context(TerminalEmulatorFactory::new(|size, scrollback| {
        let mut vt = VtEmulator::new(size, scrollback);
        vt.feed("ab中cd|".as_bytes());
        Box::new(vt)
    }));
    view()
        .w(px(400.0))
        .h(px(18.0 * 5.0))
        .child(terminal().font_family("monospace").flex_1())
}

fn load(at: &AtomicU32) -> f32 {
    f32::from_bits(at.load(Ordering::Relaxed))
}

#[test]
fn a_wide_character_and_the_text_after_it_sit_on_their_columns() {
    let config = EngineConfig {
        viewport: Size::new(px(400.0), px(400.0)),
        ..EngineConfig::new(Root::of::<Harness>())
    };
    let mut app = Headless::start(config).expect("the engine starts");
    let continued = Arc::new(Mutex::new(0usize));
    let into = continued.clone();
    app.observe(move |_, batch| {
        for item in &batch.items {
            if let MountItem::ViewProps { props, .. } = item
                && props.continues_text
            {
                *into.lock().unwrap() += 1;
            }
        }
    });
    app.wait_for("text:cd|").unwrap();
    let (cell, zhong) = (load(&CELL), load(&ZHONG));
    let mut texts: Vec<f32> = app
        .screen()
        .layout_nodes()
        .into_iter()
        .filter(|n| n.kind == ViewKind::Text && n.bounds.origin.y.0 < 18.0)
        .map(|n| n.bounds.origin.x.0)
        .collect();
    texts.sort_by(f32::total_cmp);
    // `ab` at column 0; 中 on columns 2 and 3, centered; `cd|` at column 4,
    // where a flowing line would have it at 2 cells plus 中's own advance.
    let want = [0.0, 2.0 * cell + (2.0 * cell - zhong) / 2.0, 4.0 * cell];
    assert_eq!(texts.len(), 3, "{texts:?}");
    for (got, want) in texts.iter().zip(want) {
        // Layout places views on whole points.
        assert!((got - want).abs() < 0.5, "{texts:?}, want {want:?}");
    }
    assert_eq!(
        *continued.lock().unwrap(),
        2,
        "the two segments after the first continue it"
    );
}

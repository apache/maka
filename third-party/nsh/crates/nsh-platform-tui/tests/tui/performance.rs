use nsh_platform_tui::{AppOptions, AppView};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

#[test]
fn monitoring_is_opt_in_and_stops_collecting_when_hidden() {
    let mut view = AppView::default();
    let mut terminal = Terminal::new(view.measure_backend(TestBackend::new(200, 60))).unwrap();
    view.draw_terminal(&mut terminal).unwrap();
    assert!(view.frame_metrics().is_none());
    assert!(view.next_frame_deadline().is_none());

    view.set_fps_monitor(true);
    view.draw_terminal(&mut terminal).unwrap();
    let sample = view.frame_metrics().unwrap();
    assert!(sample.cells.is_some_and(|n| n > 0));
    assert_eq!(sample.bytes, None, "an in-memory terminal writes no bytes");
    let contents: String = terminal
        .backend()
        .inner()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    for label in ["idle", "p95", "apply", "draw", "flush", "B/f", "Cells/f"] {
        assert!(contents.contains(label), "{contents}");
    }
    view.set_fps_monitor(false);
    view.draw_terminal(&mut terminal).unwrap();
    assert!(view.frame_metrics().is_none());
    assert!(view.next_frame_deadline().is_none());
    assert!(
        terminal
            .backend()
            .inner()
            .buffer()
            .content
            .iter()
            .all(|c| c.symbol() == " ")
    );
}

#[cfg(feature = "dev")]
#[test]
fn the_development_prefix_toggles_performance_beside_diagnostics() {
    use nsh_platform_tui::{Handled, Input, Modifiers};
    let mut view = AppView::default();
    view.set_dev_log_path(std::env::temp_dir().join("nsh-tui-perf-test-unused.log"));
    let mut terminal = Terminal::new(TestBackend::new(200, 60)).unwrap();
    for enabled in [true, false] {
        for (key, ctrl) in [("h", true), ("p", false)] {
            let modifiers = Modifiers {
                ctrl,
                ..Default::default()
            };
            assert_eq!(
                view.handle(Input::Key {
                    key: key.into(),
                    modifiers,
                    release: false
                }),
                Handled::Yes
            );
        }
        view.draw_terminal(&mut terminal).unwrap();
        assert_eq!(view.frame_metrics().is_some(), enabled);
    }
}

#[test]
fn fps_option_enables_the_surface_monitor() {
    let mut options = AppOptions::default();
    options.fps = true;
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(200, 60)).unwrap();
    view.draw_terminal(&mut terminal).unwrap();
    assert!(view.frame_metrics().is_some());
}

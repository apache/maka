use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_core::clipboard::{ClipboardBackend, MemoryClipboard};
use nsh_platform_tui::{AppOptions, AppView, Bundle, RunEvent};
use ratatui_core::{backend::TestBackend, terminal::Terminal};
use ratatui_crossterm::crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};

#[test]
fn the_host_delivers_control_shift_c_to_a_field_instead_of_exiting() {
    let clipboard = Arc::new(MemoryClipboard::default());
    let (tx, rx) = std::sync::mpsc::channel();
    let mut options = AppOptions::default();
    options.clipboard = Some(clipboard.clone());
    options.cache = nsh_platform_tui::CacheOptions::off();
    options.wake = Some(Arc::new(move || {
        let _ = tx.send(());
    }));
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(20, 4)).unwrap();
    let code = nsh_bundler::compile_module("App.tsx", r#"
        import { mount, Text, View, signal } from "nsh";
        import { Input } from "nsh/base";
        const focused = signal(false);
        mount(() => <View><Input autoFocus defaultValue="Ada" onFocus={() => focused.set(true)}
            style={{ width: 160, height: 16 }} /><Text>{focused() ? "ready" : "waiting"}</Text></View>);
    "#, &[]).unwrap();
    view.load(Bundle::source(code)).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|cell| cell.symbol())
            .collect::<String>()
            .contains("ready")
        {
            break;
        }
        rx.recv_timeout(deadline.saturating_duration_since(Instant::now()))
            .unwrap();
    }
    for character in ['a', 'c'] {
        let event = Event::Key(KeyEvent::new(
            KeyCode::Char(character),
            KeyModifiers::CONTROL | KeyModifiers::SHIFT,
        ));
        let RunEvent::Input(input) = nsh_tui_host::convert(event) else {
            panic!("editing shortcut must reach the surface");
        };
        view.handle(input);
    }
    assert_eq!(clipboard.text().as_deref(), Some("Ada"));
}

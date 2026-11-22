use std::{
    cell::RefCell,
    convert::Infallible,
    fs,
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use nsh_platform_tui::{AppOptions, AppView, Bundle, CacheOptions, Limits, RunEvent, run_app};
use ratatui_core::{
    backend::{Backend, ClearType, TestBackend, WindowSize},
    buffer::{Buffer, Cell},
    layout::{Position, Size},
    terminal::Terminal,
};
use ratatui_crossterm::crossterm::event::{
    Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};

// Sharing the transport lets the scripted terminal user read only flushed cells,
// without reaching into AppView or manually rendering between input events.
struct ObservedBackend(Rc<RefCell<TestBackend>>);

impl Backend for ObservedBackend {
    type Error = Infallible;

    fn draw<'a, I>(&mut self, content: I) -> Result<(), Self::Error>
    where
        I: Iterator<Item = (u16, u16, &'a Cell)>,
    {
        self.0.borrow_mut().draw(content)
    }

    fn hide_cursor(&mut self) -> Result<(), Self::Error> {
        self.0.borrow_mut().hide_cursor()
    }
    fn show_cursor(&mut self) -> Result<(), Self::Error> {
        self.0.borrow_mut().show_cursor()
    }
    fn get_cursor_position(&mut self) -> Result<Position, Self::Error> {
        self.0.borrow_mut().get_cursor_position()
    }
    fn set_cursor_position<P: Into<Position>>(&mut self, position: P) -> Result<(), Self::Error> {
        self.0.borrow_mut().set_cursor_position(position)
    }
    fn clear(&mut self) -> Result<(), Self::Error> {
        self.0.borrow_mut().clear()
    }
    fn clear_region(&mut self, region: ClearType) -> Result<(), Self::Error> {
        self.0.borrow_mut().clear_region(region)
    }
    fn size(&self) -> Result<Size, Self::Error> {
        self.0.borrow().size()
    }
    fn window_size(&mut self) -> Result<WindowSize, Self::Error> {
        self.0.borrow_mut().window_size()
    }
    fn flush(&mut self) -> Result<(), Self::Error> {
        self.0.borrow_mut().flush()
    }
}

fn find_text(buffer: &Buffer, text: &str) -> Option<Position> {
    let length = u16::try_from(text.chars().count()).unwrap();
    for y in buffer.area.y..buffer.area.bottom() {
        for x in buffer.area.x..=buffer.area.right().saturating_sub(length) {
            let shown: String = (x..x + length).map(|x| buffer[(x, y)].symbol()).collect();
            if shown == text {
                return Some(Position::new(x, y));
            }
        }
    }
    None
}

fn has_value(buffer: &Buffer, value: &str) -> bool {
    (buffer.area.y..buffer.area.bottom()).any(|y| {
        let row: String = (buffer.area.x..buffer.area.right())
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        row.trim() == value
    })
}

struct BundleDirectory(PathBuf);

impl Drop for BundleDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn counter_bundle() -> (BundleDirectory, Bundle) {
    let entry = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../examples/counter/App.tsx");
    let built = nsh_bundler::bundle(&nsh_bundler::BundleOptions {
        entry: entry.clone(),
        minify: false,
        split: false,
        ui_sets: Vec::new(),
        ..Default::default()
    })
    .unwrap();
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "nsh-tui-host-counter-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&path).unwrap();
    let directory = BundleDirectory(path);
    let bundle_path = directory.0.join("bundle.js");
    fs::write(&bundle_path, built.code).unwrap();
    if let Some(map) = built.source_map {
        fs::write(directory.0.join("bundle.js.map"), map).unwrap();
    }
    if let Some(capabilities) = built.capabilities {
        fs::write(
            directory.0.join("capabilities.json"),
            capabilities.to_json().to_string(),
        )
        .unwrap();
    }
    fs::copy(
        entry.with_file_name("nsh.json"),
        directory.0.join("app.json"),
    )
    .unwrap();
    let bundle = Bundle::read(&bundle_path).unwrap();
    (directory, bundle)
}

#[test]
fn prebuilt_counter_accepts_converted_mouse_events_in_the_standalone_loop() {
    let (_files, bundle) = counter_bundle();
    let mut options = AppOptions::default();
    options.limits = Limits::standalone();
    options.cache = CacheOptions::off();
    let mut view = AppView::new(options);
    let errors = Rc::new(RefCell::new(Vec::new()));
    let reported = errors.clone();
    view.on_app_error(move |error| reported.borrow_mut().push(error.to_string()));
    let backend = Rc::new(RefCell::new(TestBackend::new(100, 40)));
    let mut terminal = Terminal::new(ObservedBackend(backend.clone())).unwrap();
    // Match the host: establish the area, then load from disk, then enter run_app.
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    view.load(bundle).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut button = None;
    let mut events_sent = 0;
    run_app(&mut terminal, &mut view, |wait| {
        assert!(
            errors.borrow().is_empty(),
            "app errors: {:?}",
            errors.borrow()
        );
        {
            let backend = backend.borrow();
            let buffer = backend.buffer();
            if button.is_none() && has_value(buffer, "0") {
                button = find_text(buffer, "+1");
            }
            if events_sent == 2
                && has_value(buffer, "1")
                && find_text(buffer, "Recent values: 1").is_some()
            {
                return Ok(RunEvent::Exit);
            }
        }
        if Instant::now() >= deadline {
            return Ok(RunEvent::Exit);
        }
        if let Some(position) = button
            && events_sent < 2
        {
            let kind = if events_sent == 0 {
                MouseEventKind::Down(MouseButton::Left)
            } else {
                MouseEventKind::Up(MouseButton::Left)
            };
            events_sent += 1;
            return Ok(nsh_tui_host::convert(Event::Mouse(MouseEvent {
                kind,
                column: position.x,
                row: position.y,
                modifiers: KeyModifiers::NONE,
            })));
        }
        std::thread::sleep(wait);
        Ok(RunEvent::Idle)
    })
    .unwrap();
    let backend = backend.borrow();
    assert!(
        has_value(backend.buffer(), "1"),
        "value did not become 1 after {events_sent} events at {button:?}; cells:\n{:?}",
        backend.buffer()
    );
    assert!(find_text(backend.buffer(), "Recent values: 1").is_some());
}

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use nsh_dev::{AppInfo, DevServer};
use nsh_platform_tui::{AppOptions, AppView, CacheOptions};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

fn server() -> DevServer {
    DevServer::start("127.0.0.1:0".parse().unwrap(), "source-only", None, |_| {}).unwrap()
}

fn publish(server: &DevServer, label: &str) {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        &format!(r#"import {{ mount, Text }} from 'nsh'; mount(() => <Text>{label}</Text>);"#),
        &[],
    )
    .unwrap();
    server.publish(Vec::new(), code, None, AppInfo::default(), None, Vec::new());
}

fn draw_until(
    view: &mut AppView,
    terminal: &mut Terminal<TestBackend>,
    wakes: &std::sync::mpsc::Receiver<()>,
    text: &str,
) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        terminal.draw(|f| view.render(f, f.area())).unwrap();
        let shown: String = terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect();
        if shown.contains(text) {
            return;
        }
        assert!(
            wakes
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .is_ok(),
            "expected {text:?}, got {shown:?}"
        );
    }
}

#[test]
fn dev_server_loads_and_replaces_the_app_without_reconnecting() {
    let server = server();
    publish(&server, "first build");
    let (sender, wakes) = std::sync::mpsc::channel();
    let mut options = AppOptions::default();
    options.cache = CacheOptions::off();
    options.wake = Some(Arc::new(move || {
        let _ = sender.send(());
    }));
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    view.connect_dev_server(format!("ws://{}/ws", server.local_addr()))
        .unwrap();
    draw_until(&mut view, &mut terminal, &wakes, "first build");
    publish(&server, "second build");
    draw_until(&mut view, &mut terminal, &wakes, "second build");
}

#[test]
fn apps_read_bundled_fonts_from_the_dev_server() {
    let root = std::env::temp_dir().join(format!("nsh-tui-dev-assets-{}", std::process::id()));
    let fonts = root.join("fonts");
    std::fs::create_dir_all(&fonts).unwrap();
    std::fs::write(
        fonts.join("Pacifico-Regular.ttf"),
        include_bytes!("../../../../examples/gallery/fonts/Pacifico-Regular.ttf"),
    )
    .unwrap();
    let server = DevServer::start(
        "127.0.0.1:0".parse().unwrap(),
        "source-only",
        Some(root.clone()),
        |_| {},
    )
    .unwrap();
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, Text } from 'nsh';
        import { font } from 'nsh:rt';
        const family = font('asset:/fonts/Pacifico-Regular.ttf', 'Pacifico');
        setTimeout(() => mount(() => <Text style={{ fontFamily: family }}>Font ready</Text>), 100);
        "#,
        &[],
    )
    .unwrap();
    server.publish(Vec::new(), code, None, AppInfo::default(), None, Vec::new());
    let (sender, wakes) = std::sync::mpsc::channel();
    let mut options = AppOptions::default();
    options.cache = CacheOptions::off();
    options.wake = Some(Arc::new(move || {
        let _ = sender.send(());
    }));
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    view.connect_dev_server(format!("ws://{}/ws", server.local_addr()))
        .unwrap();
    draw_until(&mut view, &mut terminal, &wakes, "Font ready");
    let shown: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|c| c.symbol())
        .collect();
    assert!(!shown.contains("App error"), "{shown}");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn hot_updates_keep_state_and_a_rejected_patch_loads_its_bundle() {
    let dir = std::env::temp_dir().join(format!("nsh-tui-hot-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let entry = dir.join("App.tsx");
    let source = |label: &str| {
        format!(
            r#"
        import {{ mount, signal, Text }} from 'nsh';
        const count = signal(0);
        mount(() => <Text onPress={{() => count.set(count() + 1)}}>{label} {{count()}}</Text>);
    "#
        )
    };
    std::fs::write(&entry, source("Count")).unwrap();
    let initial = nsh_bundler::bundle_hot(&entry, &[]).unwrap();
    let server = server();
    server.publish(
        Vec::new(),
        initial.script().0,
        None,
        AppInfo::default(),
        None,
        Vec::new(),
    );
    let (sender, wakes) = std::sync::mpsc::channel();
    let mut options = AppOptions::default();
    options.cache = CacheOptions::off();
    options.wake = Some(Arc::new(move || {
        let _ = sender.send(());
    }));
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    view.connect_dev_server(format!("ws://{}/ws", server.local_addr()))
        .unwrap();
    draw_until(&mut view, &mut terminal, &wakes, "Count 0");
    for kind in [
        nsh_platform_tui::MouseKind::Down(nsh_platform_tui::MouseButton::Left),
        nsh_platform_tui::MouseKind::Up(nsh_platform_tui::MouseButton::Left),
    ] {
        let mut mouse = nsh_platform_tui::MouseInput::default();
        mouse.kind = kind;
        view.handle(nsh_platform_tui::Input::Mouse(mouse));
    }
    draw_until(&mut view, &mut terminal, &wakes, "Count 1");
    std::fs::write(&entry, source("Updated")).unwrap();
    let next = nsh_bundler::bundle_hot(&entry, &[]).unwrap();
    let nsh_bundler::HotPatch::Update { code, source_map } = next.patch(&initial) else {
        panic!("expected hot update");
    };
    server.publish(
        Vec::new(),
        next.script().0,
        None,
        AppInfo::default(),
        Some((code, source_map)),
        Vec::new(),
    );
    draw_until(&mut view, &mut terminal, &wakes, "Updated 1");
    server.publish(
        Vec::new(),
        next.script().0,
        None,
        AppInfo::default(),
        Some(("false".into(), None)),
        Vec::new(),
    );
    draw_until(&mut view, &mut terminal, &wakes, "Updated 0");
    view.stop();
    std::fs::remove_dir_all(dir).unwrap();
}

fn key(view: &mut AppView, name: &str, ctrl: bool) {
    let modifiers = nsh_platform_tui::Modifiers {
        ctrl,
        ..Default::default()
    };
    view.handle(nsh_platform_tui::Input::Key {
        key: name.into(),
        modifiers,
        release: false,
    });
}

#[test]
fn errors_are_dismissible_and_logs_open_only_on_request() {
    let server = server();
    publish(&server, "app fills the terminal");
    let log_path = std::env::temp_dir().join(format!("nsh-tui-dev-log-{}", std::process::id()));
    std::fs::write(&log_path, "compiler log from the CLI\n").unwrap();
    let (sender, wakes) = std::sync::mpsc::channel();
    let mut options = AppOptions::default();
    options.cache = CacheOptions::off();
    options.wake = Some(Arc::new(move || {
        let _ = sender.send(());
    }));
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    view.set_dev_log_path(log_path.clone());
    view.connect_dev_server(format!("ws://{}/ws", server.local_addr()))
        .unwrap();
    draw_until(&mut view, &mut terminal, &wakes, "app fills the terminal");
    key(&mut view, "h", true);
    key(&mut view, "e", false);
    draw_until(
        &mut view,
        &mut terminal,
        &wakes,
        "compiler log from the CLI",
    );
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &wakes, "app fills the terminal");
    server.publish_error("broken TSX syntax");
    draw_until(&mut view, &mut terminal, &wakes, "broken TSX syntax");
    key(&mut view, "Escape", false);
    draw_until(&mut view, &mut terminal, &wakes, "app fills the terminal");
    server.publish(
        Vec::new(),
        "throw new Error('runtime failure')".into(),
        None,
        AppInfo::default(),
        None,
        Vec::new(),
    );
    draw_until(&mut view, &mut terminal, &wakes, "runtime failure");
    publish(&server, "fixed app");
    draw_until(&mut view, &mut terminal, &wakes, "fixed app");
    key(&mut view, "h", true);
    key(&mut view, "e", false);
    draw_until(&mut view, &mut terminal, &wakes, "runtime failure");
    view.stop();
    std::fs::remove_file(log_path).unwrap();
}

#[test]
fn a_linked_rust_root_loads_and_can_be_reloaded_from_the_panel() {
    use nsh_core::prelude::*;
    #[component]
    fn RootCounter() -> impl IntoElement {
        let count = signal(0);
        text(move || format!("Rust count {}", count.get()))
            .on_press(move |_: &()| count.update(|count| *count += 1))
    }
    let server = server();
    server.publish_root();
    let (sender, wakes) = std::sync::mpsc::channel();
    let mut options = AppOptions::default();
    options.cache = CacheOptions::off();
    options.root = Some(nsh_platform_tui::Root::new::<RootCounter>(|| ()));
    options.wake = Some(Arc::new(move || {
        let _ = sender.send(());
    }));
    let mut view = AppView::new(options);
    let mut terminal = Terminal::new(TestBackend::new(80, 20)).unwrap();
    view.connect_dev_server(format!("ws://{}/ws", server.local_addr()))
        .unwrap();
    draw_until(&mut view, &mut terminal, &wakes, "Rust count 0");
    for kind in [
        nsh_platform_tui::MouseKind::Down(nsh_platform_tui::MouseButton::Left),
        nsh_platform_tui::MouseKind::Up(nsh_platform_tui::MouseButton::Left),
    ] {
        let mut mouse = nsh_platform_tui::MouseInput::default();
        mouse.kind = kind;
        view.handle(nsh_platform_tui::Input::Mouse(mouse));
    }
    draw_until(&mut view, &mut terminal, &wakes, "Rust count 1");
    key(&mut view, "h", true);
    key(&mut view, "e", false);
    key(&mut view, "r", false);
    draw_until(&mut view, &mut terminal, &wakes, "Rust count 0");
}

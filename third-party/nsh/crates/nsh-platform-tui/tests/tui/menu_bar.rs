//! The application menu as a menu bar on the surface's top row.

use nsh_platform_tui::{Bundle, Handled, Input, Modifiers, MouseButton, MouseKind};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::app::{draw_until, mouse, surface};

/// An app with `File`, `Edit` and `View` menus, which writes what was
/// chosen under `top` (its first row).
fn app(menu: bool) -> Bundle {
    let set = if menu {
        r#"Menu.setApplicationMenu([
            { label: "File", submenu: [
                { label: "Open", shortcut: "ctrl+o", onSelect: () => log.set("open") },
                { type: "separator" },
                { role: "minimize" },
                { label: "Save", disabled: true },
            ] },
            { label: "Edit", submenu: [{ label: "Find", shortcut: "ctrl+f", onSelect: () => log.set("find") }] },
            { label: "View", submenu: [{ label: "Zoom In", onSelect: () => log.set("zoom") }] },
        ]);"#
    } else {
        ""
    };
    let code = nsh_bundler::compile_module(
        "App.tsx",
        &format!(
            r#"
        import {{ mount, signal, View, Text }} from "nsh";
        import {{ Menu }} from "nsh/desktop";
        const log = signal("none");
        {set}
        mount(() => <View>
            <Text>top</Text>
            <Text>chose {{log()}}</Text>
        </View>);
    "#
        ),
        &[],
    )
    .unwrap();
    Bundle::source(code)
}

fn key(name: &str) -> Input {
    Input::Key {
        key: name.into(),
        modifiers: Default::default(),
        release: false,
    }
}

fn row(terminal: &Terminal<TestBackend>, y: u16) -> String {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.width)
        .map(|x| buffer[(x, y)].symbol())
        .collect()
}

fn screen(terminal: &Terminal<TestBackend>) -> String {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height)
        .map(|y| row(terminal, y) + "\n")
        .collect()
}

#[test]
fn an_application_menu_is_a_bar_on_the_top_row_above_the_app() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(app(true)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "File");
    draw_until(&mut view, &mut terminal, &rx, "chose none");
    assert!(
        row(&terminal, 0).starts_with("  File  Edit  View "),
        "{}",
        screen(&terminal)
    );
    assert!(
        row(&terminal, 1).starts_with("top"),
        "{}",
        screen(&terminal)
    );
    // Without one the app has every row.
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(app(false)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "chose none");
    assert!(
        row(&terminal, 0).starts_with("top"),
        "{}",
        screen(&terminal)
    );
}

#[test]
fn f10_gives_the_bar_the_keys_and_its_menus_open_below_their_titles() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(app(true)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "chose none");
    assert_eq!(view.handle(key("F10")), Handled::Yes);
    // Right to Edit, Down opens its menu below the title.
    view.handle(key("ArrowRight"));
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "Find");
    assert_eq!(
        terminal.backend().buffer()[(7, 1)].symbol(),
        "╭",
        "{}",
        screen(&terminal)
    );
    // Left opens File's: its shortcut at the right, the window's roles
    // left out.
    view.handle(key("ArrowLeft"));
    draw_until(&mut view, &mut terminal, &rx, "Open");
    let shortcut = if cfg!(target_os = "macos") {
        "⌃O"
    } else {
        "Ctrl+O"
    };
    let open = screen(&terminal)
        .lines()
        .find(|line| line.contains("Open"))
        .unwrap()
        .to_string();
    assert!(open.contains(shortcut), "{}", screen(&terminal));
    assert!(
        !screen(&terminal).contains("Minimize"),
        "{}",
        screen(&terminal)
    );
    // Escape closes the menu and the bar keeps the keys; Enter chooses
    // in the menu Down opened again.
    view.handle(key("Escape"));
    draw_until(&mut view, &mut terminal, &rx, "top");
    assert!(!screen(&terminal).contains("Open"), "{}", screen(&terminal));
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "Open");
    view.handle(key("Enter"));
    draw_until(&mut view, &mut terminal, &rx, "chose open");
    assert!(!screen(&terminal).contains("Open"), "{}", screen(&terminal));
    // A title's initial opens it; Escape twice gives the keys back.
    view.handle(key("F10"));
    view.handle(key("v"));
    draw_until(&mut view, &mut terminal, &rx, "Zoom In");
    view.handle(key("Escape"));
    view.handle(key("Escape"));
    draw_until(&mut view, &mut terminal, &rx, "top");
    assert!(!screen(&terminal).contains("Zoom In"));
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "top");
    assert!(
        !screen(&terminal).contains("Open"),
        "the bar let the keys go"
    );
}

#[test]
fn a_press_on_a_title_opens_its_menu_and_its_shortcut_chooses_without_it() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(app(true)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "chose none");
    let click = |view: &mut nsh_platform_tui::AppView, x, y| {
        view.handle(mouse(MouseKind::Down(MouseButton::Left), x, y));
        view.handle(mouse(MouseKind::Up(MouseButton::Left), x, y));
    };
    // ` Edit ` is Cells 7 to 12.
    click(&mut view, 8, 0);
    draw_until(&mut view, &mut terminal, &rx, "Find");
    // The pointer over View opens its menu; a press on its row chooses.
    view.handle(mouse(MouseKind::Move, 14, 0));
    draw_until(&mut view, &mut terminal, &rx, "Zoom In");
    let (x, y) = screen(&terminal)
        .lines()
        .enumerate()
        .find_map(|(y, line)| line.find("Zoom").map(|_| (14 + 2, y as u16)))
        .unwrap();
    click(&mut view, x, y);
    draw_until(&mut view, &mut terminal, &rx, "chose zoom");
    // A press on the open menu's title closes it.
    click(&mut view, 2, 0);
    draw_until(&mut view, &mut terminal, &rx, "Open");
    click(&mut view, 2, 0);
    draw_until(&mut view, &mut terminal, &rx, "chose zoom");
    assert!(!screen(&terminal).contains("Open"), "{}", screen(&terminal));
    // Ctrl+O chooses Open with no menu open.
    view.handle(Input::Key {
        key: "o".into(),
        modifiers: Modifiers {
            ctrl: true,
            ..Default::default()
        },
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "chose open");
}

/// A surface whose terminal reports Command (`command_key`) or not.
fn surface_with(command_key: bool) -> (nsh_platform_tui::AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = nsh_platform_tui::AppOptions::default();
    options.wake = Some(std::sync::Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    options.capabilities.command_key = command_key;
    (nsh_platform_tui::AppView::new(options), rx)
}

#[test]
fn shortcuts_show_the_keys_to_press_where_ctrl_stands_in_for_command() {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, View, Text, keymap } from "nsh";
        import { Menu } from "nsh/desktop";
        const log = signal("none");
        Menu.setApplicationMenu([
            { label: "File", submenu: [{ label: "Open", shortcut: "mod+o", onSelect: () => log.set("open") }] },
        ]);
        mount(() => <View>
            <Text>hint {keymap.label("mod+shift+p")}</Text>
            <Text>chose {log()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let mac = cfg!(target_os = "macos");
    for command_key in [false, true] {
        let (mut view, rx) = surface_with(command_key);
        let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
        view.load(Bundle::source(code.clone())).unwrap();
        // A macOS terminal that cannot report Command: Ctrl stands in.
        let (open, hint) = match (mac, command_key) {
            (true, false) => ("⌃O", "⌃⇧P"),
            (true, true) => ("⌘O", "⇧⌘P"),
            (false, _) => ("Ctrl+O", "Ctrl+Shift+P"),
        };
        draw_until(&mut view, &mut terminal, &rx, &format!("hint {hint}"));
        view.handle(key("F10"));
        view.handle(key("ArrowDown"));
        draw_until(&mut view, &mut terminal, &rx, "Open");
        let line = screen(&terminal)
            .lines()
            .find(|line| line.contains("Open"))
            .unwrap()
            .to_string();
        assert!(
            line.contains(open),
            "command_key {command_key}: {}",
            screen(&terminal)
        );
        view.handle(key("Escape"));
        view.handle(key("Escape"));
        draw_until(&mut view, &mut terminal, &rx, "chose none");
        // The key the hint shows chooses the item.
        let pressed = if mac && command_key {
            Modifiers {
                cmd: true,
                ..Default::default()
            }
        } else {
            Modifiers {
                ctrl: true,
                ..Default::default()
            }
        };
        view.handle(Input::Key {
            key: "o".into(),
            modifiers: pressed,
            release: false,
        });
        draw_until(&mut view, &mut terminal, &rx, "chose open");
    }
}

fn ctrl(name: &str) -> Input {
    Input::Key {
        key: name.into(),
        modifiers: Modifiers {
            ctrl: true,
            ..Default::default()
        },
        release: false,
    }
}

#[test]
fn a_shortcut_with_a_modifier_chooses_while_the_bar_has_the_keys_and_alt_escape_is_escape() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(app(true)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "chose none");
    // The bar has the keys: Ctrl+O chooses Open and folds the bar up, so
    // Down reaches the app again rather than opening a menu.
    view.handle(key("F10"));
    view.handle(ctrl("o"));
    draw_until(&mut view, &mut terminal, &rx, "chose open");
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "chose open");
    assert!(!screen(&terminal).contains("Save"), "{}", screen(&terminal));
    // With a menu open, a shortcut wins over the menu's Ctrl+F (Right).
    view.handle(key("F10"));
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "Save");
    view.handle(ctrl("f"));
    draw_until(&mut view, &mut terminal, &rx, "chose find");
    assert!(!screen(&terminal).contains("Save"), "{}", screen(&terminal));
    // Two quick Escapes arrive as Alt+Escape: each is an Escape.
    let alt_escape = || Input::Key {
        key: "Escape".into(),
        modifiers: Modifiers {
            alt: true,
            ..Default::default()
        },
        release: false,
    };
    view.handle(key("F10"));
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "Save");
    view.handle(alt_escape());
    draw_until(&mut view, &mut terminal, &rx, "top");
    assert!(!screen(&terminal).contains("Save"), "{}", screen(&terminal));
    // Still the bar's: Down opens File's menu again.
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "Save");
    view.handle(alt_escape());
    view.handle(alt_escape());
    draw_until(&mut view, &mut terminal, &rx, "top");
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "top");
    assert!(
        !screen(&terminal).contains("Save"),
        "the bar let the keys go"
    );
}

/// An app whose application menu has the edit roles, with selectable text
/// and a field (`id:field`) that reports its value.
fn edit_app() -> Bundle {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, View, Text } from "nsh";
        import { Input } from "nsh/base";
        import { Menu } from "nsh/desktop";
        const value = signal("");
        Menu.setApplicationMenu([
            { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { role: "copy" }] },
        ]);
        mount(() => <View>
            <View selectable><Text>select me</Text></View>
            <Input value={value()} style={{ width: 160, height: 16 }}
                onChange={({ value: v }) => value.set(v)} />
            <Text>value:{value()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    Bundle::source(code)
}

/// A surface that copies into `clipboard`.
fn surface_copying(
    clipboard: std::sync::Arc<nsh_core::clipboard::MemoryClipboard>,
) -> (nsh_platform_tui::AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = nsh_platform_tui::AppOptions::default();
    options.wake = Some(std::sync::Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    options.clipboard = Some(clipboard);
    (nsh_platform_tui::AppView::new(options), rx)
}

#[test]
fn ctrl_c_still_copies_a_selection_or_quits_with_a_copy_role_in_the_menu() {
    use nsh_core::clipboard::{ClipboardBackend, MemoryClipboard};
    // The copy role's ⌘C is what Ctrl+C stands in for on macOS (and its
    // Ctrl+C elsewhere): the key stays the selection's, then the quit.
    let clipboard = std::sync::Arc::new(MemoryClipboard::default());
    let (mut view, rx) = surface_copying(clipboard.clone());
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(edit_app()).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "select me");
    let me = screen(&terminal)
        .lines()
        .position(|line| line.contains("select me"))
        .unwrap() as u16;
    view.handle(mouse(MouseKind::Down(MouseButton::Left), 0, me));
    view.handle(mouse(MouseKind::Move, 6, me));
    view.handle(mouse(MouseKind::Up(MouseButton::Left), 6, me));
    view.handle(ctrl("c"));
    assert_eq!(clipboard.text().as_deref(), Some("select"));
    assert!(!view.exit_requested(), "a copy does not quit");
    // Nothing selected now (Escape clears it): Ctrl+C quits.
    view.handle(key("Escape"));
    assert!(!view.exit_requested());
    view.handle(ctrl("c"));
    assert!(view.exit_requested(), "{}", screen(&terminal));
}

#[test]
fn undo_from_the_menu_or_its_key_returns_and_undoes_the_field() {
    let cmd = |name: &str| Input::Key {
        key: name.into(),
        modifiers: Modifiers {
            cmd: true,
            ..Default::default()
        },
        release: false,
    };
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(edit_app()).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "value:");
    // Nothing focused: Undo chosen from the bar, and Cmd+Z, return (the
    // role's key is not the role's shortcut again).
    view.handle(key("F10"));
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "Redo");
    assert_eq!(view.handle(key("Enter")), Handled::Yes);
    view.handle(cmd("z"));
    draw_until(&mut view, &mut terminal, &rx, "value:");
    assert!(!screen(&terminal).contains("Redo"), "{}", screen(&terminal));
    // In the field, Cmd+Z undoes its edit, and so does the menu's Undo.
    view.handle(key("Tab"));
    view.handle(key("a"));
    draw_until(&mut view, &mut terminal, &rx, "value:a");
    view.handle(cmd("z"));
    draw_until(&mut view, &mut terminal, &rx, "value: ");
    view.handle(key("b"));
    draw_until(&mut view, &mut terminal, &rx, "value:b");
    view.handle(key("F10"));
    view.handle(key("ArrowDown"));
    draw_until(&mut view, &mut terminal, &rx, "Redo");
    view.handle(key("Enter"));
    draw_until(&mut view, &mut terminal, &rx, "value: ");
}

#[test]
fn app_quit_ends_the_app_as_a_quit_role_does() {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, Text } from "nsh";
        import { Application } from "nsh/desktop";
        mount(() => <Text>ready</Text>);
        Application.quit();
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "ready");
    assert!(view.exit_requested(), "{}", screen(&terminal));
}

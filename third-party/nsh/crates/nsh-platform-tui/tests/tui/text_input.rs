#![cfg(feature = "js")]

use nsh_platform_tui::{Bundle, Handled, Input, Modifiers};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::app::{draw_until, surface};

fn key(name: &str) -> Input {
    Input::Key {
        key: name.into(),
        modifiers: Modifiers::default(),
        release: false,
    }
}

#[test]
fn tab_enters_a_field_and_typing_moves_the_caret_and_reports_text() {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, View, Text } from "nsh";
        import { Input } from "nsh/base";
        const value = signal(""), focus = signal("idle");
        mount(() => <View>
            <Input value={value()} placeholder="Name" style={{ width: 160, height: 16 }}
                onChange={({ value: text }) => value.set(text)} onFocus={() => focus.set("editing")}
                onBlur={() => focus.set("idle")} />
            <Text>{focus()}:{value()}</Text>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "idle:");
    assert_eq!(view.handle(key("Tab")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "editing:");
    assert_eq!(view.handle(key("A")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "editing:A");
    assert_eq!(terminal.backend().buffer()[(0, 0)].symbol(), "A");
    terminal.backend_mut().assert_cursor_position((1, 0));
    assert_eq!(view.handle(key("Escape")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "idle:A");
    assert!(!terminal.backend().cursor_visible());
}

fn modified(name: &str, ctrl: bool, alt: bool, shift: bool) -> Input {
    let modifiers = Modifiers {
        ctrl,
        alt,
        shift,
        ..Default::default()
    };
    Input::Key {
        key: name.into(),
        modifiers,
        release: false,
    }
}

fn field(
    props: &str,
) -> (
    nsh_platform_tui::AppView,
    Terminal<TestBackend>,
    crossbeam_channel::Receiver<()>,
) {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        &format!(
            r##"
        import {{ mount, signal, View, Text }} from "nsh";
        import {{ Input }} from "nsh/base";
        const value = signal(""), changes = signal(0), selection = signal("0-0");
        const submitted = signal("no"), pressed = signal("none");
        mount(() => <View>
            <Input {props} style={{{{ width: 160, height: 48, placeholderColor: "#123456" }}}}
                onChange={{({{ value: v }}) => {{ value.set(v); changes.set(changes()+1); }}}}
                onSelectionChange={{(e) => selection.set(`${{e.start}}-${{e.end}}`)}}
                onKeyPress={{(e) => pressed.set(e.key)}} onSubmit={{() => submitted.set("yes")}} />
            <Text>{{JSON.stringify(value())}}</Text>
            <Text>changes:{{changes()}} sel:{{selection()}}</Text>
            <Text>submit:{{submitted()}} key:{{pressed()}}</Text>
        </View>);
    "##
        ),
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 12)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "changes:0");
    view.handle(key("Tab"));
    (view, terminal, rx)
}

#[test]
fn readline_moves_kills_yanks_and_transposes_through_the_core_editor() {
    let (mut view, mut terminal, rx) = field("");
    view.handle(Input::Paste("one two".into()));
    view.handle(modified("a", true, false, false));
    view.handle(modified("f", false, true, false));
    view.handle(modified("d", false, true, false));
    draw_until(&mut view, &mut terminal, &rx, "\"one\"");
    view.handle(modified("y", true, false, false));
    view.handle(modified("w", true, false, false));
    draw_until(&mut view, &mut terminal, &rx, "\"one \"");
    view.handle(modified("y", true, false, false));
    view.handle(modified("u", true, false, false));
    draw_until(&mut view, &mut terminal, &rx, "\"\"");
    view.handle(modified("y", true, false, false));
    view.handle(modified("a", true, false, false));
    view.handle(modified("f", true, false, false));
    view.handle(modified("t", true, false, false));
    draw_until(&mut view, &mut terminal, &rx, "\"noe two\"");
    view.handle(modified("k", true, false, false));
    draw_until(&mut view, &mut terminal, &rx, "\"no\"");
    view.handle(modified("b", true, false, false));
    view.handle(modified("d", true, false, false));
    view.handle(modified("h", true, false, false));
    draw_until(&mut view, &mut terminal, &rx, "\"\"");
}

#[test]
fn paste_is_one_edit_and_selection_uses_utf16_while_cells_use_display_width() {
    let (mut view, mut terminal, rx) = field("maxLength={7}");
    view.handle(Input::Paste("界🙂e\u{301}abc".into()));
    draw_until(&mut view, &mut terminal, &rx, "changes:1 sel:7-7");
    terminal.backend_mut().assert_cursor_position((7, 0));
    view.handle(modified("Left", false, false, true));
    view.handle(modified("Left", false, false, true));
    draw_until(&mut view, &mut terminal, &rx, "sel:5-7");
    assert!(
        terminal.backend().buffer()[(5, 0)]
            .modifier
            .contains(ratatui_core::style::Modifier::REVERSED)
    );
    view.handle(key("X"));
    draw_until_text(&mut view, &mut terminal, &rx, "\"界🙂éX\"");
    draw_until(&mut view, &mut terminal, &rx, "changes:2 sel:6-6");
}

#[test]
fn multiline_moves_between_lines_and_enter_obeys_submit_behavior() {
    let (mut view, mut terminal, rx) = field("multiline submitBehavior=\"submit\"");
    view.handle(Input::Paste("abcd\nx\n1234".into()));
    view.handle(modified("p", true, false, false));
    view.handle(modified("p", true, false, false));
    view.handle(key("!"));
    draw_until(&mut view, &mut terminal, &rx, "\"abcd!\\nx\\n1234\"");
    view.handle(modified("n", true, false, false));
    view.handle(key("Enter"));
    draw_until(&mut view, &mut terminal, &rx, "submit:yes key:Enter");
    assert!(terminal.backend().cursor_visible());
    view.handle(modified("Enter", false, false, true));
    draw_until(&mut view, &mut terminal, &rx, "\"abcd!\\nx\\n\\n1234\"");
}

#[test]
fn placeholder_and_masked_text_draw_in_the_content_box_and_click_places_the_caret() {
    let (mut view, mut terminal, rx) = field("placeholder=\"Password\" masked");
    draw_until(&mut view, &mut terminal, &rx, "Password");
    assert_eq!(
        terminal.backend().buffer()[(0, 0)].fg,
        ratatui_core::style::Color::Blue
    );
    view.handle(Input::Paste("界🙂abc".into()));
    draw_until(&mut view, &mut terminal, &rx, "•••••");
    terminal.backend_mut().assert_cursor_position((5, 0));
    for kind in [
        nsh_platform_tui::MouseKind::Down(nsh_platform_tui::MouseButton::Left),
        nsh_platform_tui::MouseKind::Up(nsh_platform_tui::MouseButton::Left),
    ] {
        view.handle(super::app::mouse(kind, 2, 0));
    }
    view.handle(key("X"));
    draw_until_text(&mut view, &mut terminal, &rx, "\"界🙂Xabc\"");
}

#[test]
fn a_long_field_scrolls_the_caret_into_view_and_home_reveals_the_start() {
    let (mut view, mut terminal, rx) = field("");
    view.handle(Input::Paste("01234567890123456789012345".into()));
    draw_until(&mut view, &mut terminal, &rx, "changes:1");
    terminal.backend_mut().assert_cursor_position((19, 0));
    assert_eq!(terminal.backend().buffer()[(0, 0)].symbol(), "7");
    view.handle(key("Home"));
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    terminal.backend_mut().assert_cursor_position((0, 0));
    assert_eq!(terminal.backend().buffer()[(0, 0)].symbol(), "0");
}

#[test]
fn dragging_selects_text_and_replacing_it_is_one_edit() {
    use nsh_platform_tui::{MouseButton::Left, MouseKind};
    let (mut view, mut terminal, rx) = field("defaultValue=\"abcdef\"");
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    for (kind, column) in [
        (MouseKind::Down(Left), 1),
        (MouseKind::Move, 4),
        (MouseKind::Up(Left), 4),
    ] {
        view.handle(super::app::mouse(kind, column, 0));
    }
    draw_until(&mut view, &mut terminal, &rx, "sel:1-4");
    view.handle(Input::Paste("X".into()));
    draw_until(&mut view, &mut terminal, &rx, "\"aXef\"");
    draw_until(&mut view, &mut terminal, &rx, "changes:1 sel:2-2");
}

#[test]
fn controlled_round_trips_do_not_erase_a_burst_of_typing() {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, signal, View, Text } from "nsh";
        import { Input } from "nsh/base";
        const value = signal("");
        mount(() => <View><Input value={value()} onChange={({ value: v }) => value.set(v.toUpperCase())}
            style={{ width: 160, height: 16 }} /><Text>value:{value()}</Text></View>);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "value:");
    view.handle(key("Tab"));
    for character in ["a", "b", "c", "d"] {
        view.handle(key(character));
    }
    draw_until(&mut view, &mut terminal, &rx, "value:ABCD");
    assert_eq!(
        (0..4)
            .map(|x| terminal.backend().buffer()[(x, 0)].symbol())
            .collect::<String>(),
        "ABCD"
    );
}

#[cfg(feature = "dev")]
#[test]
fn control_h_deletes_in_a_field_instead_of_opening_the_log_prefix() {
    let (mut view, mut terminal, rx) = field("defaultValue=\"abc\"");
    view.set_dev_log_path(std::env::temp_dir().join("nsh-text-input-no-log"));
    view.handle(modified("h", true, false, false));
    view.handle(key("e"));
    draw_until(&mut view, &mut terminal, &rx, "\"abe\"");
    assert!(
        !terminal
            .backend()
            .buffer()
            .content
            .iter()
            .map(|c| c.symbol())
            .collect::<String>()
            .contains("Logs and errors")
    );
}

#[test]
fn input_content_padding_and_embedding_origin_position_the_real_cursor() {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, View, Text, signal } from "nsh";
        import { Input } from "nsh/base";
        const value = signal("界a");
        mount(() => <View><Input autoFocus value={value()} onChange={({ value: v }) => value.set(v)}
            style={{ width: 160, height: 48, paddingLeft: 8, paddingTop: 16 }} />
            <Text>{value()}</Text></View>);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let area = ratatui_core::layout::Rect::new(4, 2, 30, 8);
    loop {
        terminal.draw(|frame| view.render(frame, area)).unwrap();
        if terminal.backend().buffer()[(5, 2)].symbol() == "界"
            && terminal.backend().cursor_visible()
        {
            break;
        }
        rx.recv_deadline(deadline).unwrap();
    }
    terminal.backend_mut().assert_cursor_position((8, 2));
    view.handle(super::app::mouse(
        nsh_platform_tui::MouseKind::Down(nsh_platform_tui::MouseButton::Left),
        7,
        2,
    ));
    view.handle(super::app::mouse(
        nsh_platform_tui::MouseKind::Up(nsh_platform_tui::MouseButton::Left),
        7,
        2,
    ));
    view.handle(key("X"));
    loop {
        terminal.draw(|frame| view.render(frame, area)).unwrap();
        if terminal.backend().buffer()[(7, 2)].symbol() == "X" {
            break;
        }
        rx.recv_deadline(deadline).unwrap();
    }
    terminal.backend_mut().assert_cursor_position((8, 2));
}

#[test]
fn multiline_wrapping_keeps_the_caret_visible_and_shift_up_selects_a_visual_line() {
    let (mut view, mut terminal, rx) = field("multiline");
    // 160pt is 20 columns: 19 for the text and the column the layout keeps
    // after it, where the caret of a full line stays.
    view.handle(Input::Paste("abcdefghijklmnopqrs".into()));
    draw_until(&mut view, &mut terminal, &rx, "changes:1");
    terminal.backend_mut().assert_cursor_position((19, 0));
    view.handle(Input::Paste("t".into()));
    draw_until(&mut view, &mut terminal, &rx, "changes:2");
    // The 20th character wraps; the field is one row, scrolled to the caret.
    terminal.backend_mut().assert_cursor_position((1, 0));
    view.handle(modified("Up", false, false, true));
    draw_until(&mut view, &mut terminal, &rx, "sel:1-20");
    view.handle(key("X"));
    draw_until(&mut view, &mut terminal, &rx, "\"aX\"");
}

fn draw_until_text(
    view: &mut nsh_platform_tui::AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    expected: &str,
) {
    use unicode_width::UnicodeWidthStr;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let mut text = String::new();
        for y in buffer.area.y..buffer.area.bottom() {
            let mut x = buffer.area.x;
            while x < buffer.area.right() {
                let symbol = buffer[(x, y)].symbol();
                text.push_str(symbol);
                x += symbol.width().max(1) as u16;
            }
            text.push('\n');
        }
        if text.contains(expected) {
            return;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "expected {expected:?}, got {text:?}"
        );
    }
}

#[test]
fn wide_input_glyphs_do_not_emit_spaces_over_their_continuation_cells() {
    let (mut view, mut terminal, rx) = field("");
    view.handle(Input::Paste("界🙂X".into()));
    draw_until(&mut view, &mut terminal, &rx, "changes:1");
    let buffer = terminal.backend().buffer();
    let mut previous = ratatui_core::buffer::Buffer::empty(buffer.area);
    previous.set_string(0, 0, "abcdef", ratatui_core::style::Style::default());
    let updates: Vec<_> = previous
        .diff_iter(buffer)
        .filter(|(_, y, _)| *y == 0)
        .map(|(x, _, cell)| (x, cell.symbol().to_owned()))
        .collect();
    assert!(updates.contains(&(0, "界".to_owned())));
    assert!(updates.contains(&(2, "🙂".to_owned())));
    assert!(updates.contains(&(4, "X".to_owned())));
    assert!(!updates.iter().any(|(x, _)| *x == 1 || *x == 3));
}

#[test]
fn readline_words_and_whitespace_kills_keep_their_distinct_boundaries() {
    let (mut view, mut terminal, rx) = field("");
    view.handle(Input::Paste("foo.bar baz".into()));
    view.handle(modified("b", false, true, false));
    draw_until(&mut view, &mut terminal, &rx, "sel:8-8");
    view.handle(modified("b", false, true, false));
    draw_until(&mut view, &mut terminal, &rx, "sel:4-4");
    view.handle(modified("a", true, false, false));
    view.handle(modified("f", false, true, false));
    draw_until(&mut view, &mut terminal, &rx, "sel:3-3");
    view.handle(modified("d", false, true, false));
    draw_until(&mut view, &mut terminal, &rx, "\"foo baz\"");
    view.handle(modified("a", true, false, false));
    view.handle(modified("y", true, false, false));
    view.handle(modified("e", true, false, false));
    view.handle(modified("w", true, false, false));
    view.handle(modified("w", true, false, false));
    draw_until(&mut view, &mut terminal, &rx, "\"\"");
}

#[test]
fn input_accessories_stay_unmounted_as_on_the_desktops() {
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount, View, Text } from "nsh";
        import { InputAccessoryView } from "nsh/mobile";
        mount(() => <View>
            <Text>page</Text>
            <InputAccessoryView nativeID="bar" style={{ backgroundColor: "blue" }}>
                <View focusable onPress={() => {}}><Text>accessory</Text></View>
            </InputAccessoryView>
        </View>);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "page");
    let contents: String = terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect();
    assert_eq!(contents.trim(), "page");
    assert_eq!(view.handle(key("Tab")), Handled::Ignored);
}

#[test]
fn single_line_text_and_caret_stay_inside_the_form_focus_border() {
    let code = nsh_bundler::compile_module("Form.tsx", r##"
        import { mount, signal, View, Text } from 'nsh';
        import { Input } from 'nsh/base';
        const focused = signal(false);
        mount(() => <View style={{ padding: 16 }}>
            <View style={{ width: 240, flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderWidth: 1, borderColor: '#888888' }}>
                <Input placeholder="Name" onFocus={() => focused.set(true)} onBlur={() => focused.set(false)}
                    style={{ flex: 1, height: 46, paddingHorizontal: 14 }} />
                <View style={{ position: 'absolute', top: -1, left: -1, right: -1, bottom: -1,
                    borderWidth: 2, borderColor: '#123456', pointerEvents: 'none', opacity: focused() ? 1 : 0 }} />
            </View>
            <Text>{focused() ? 'focused' : 'blurred'}</Text>
        </View>);
    "##, &[]).unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "blurred");
    // A row holding only a field is a box of text: one row, no border Cells,
    // whether its focus ring (a bare overlay) shows or not. The field's text
    // starts after the page's column and its own padding column.
    let (x, y) = (2, 0);
    let symbol = |terminal: &Terminal<TestBackend>, dx: u16| {
        terminal.backend().buffer()[(x + dx, y)].symbol().to_owned()
    };
    assert_eq!(symbol(&terminal, 0), "N");
    assert_eq!(terminal.backend().buffer()[(1, 1)].symbol(), "b");
    view.handle(key("Tab"));
    draw_until(&mut view, &mut terminal, &rx, "focused");
    terminal.backend_mut().assert_cursor_position((x, y));
    assert_eq!(terminal.backend().buffer()[(1, 1)].symbol(), "f");
    view.handle(Input::Paste("Audit".into()));
    draw_until(&mut view, &mut terminal, &rx, "Audit");
    terminal.backend_mut().assert_cursor_position((x + 5, y));
    for kind in [
        nsh_platform_tui::MouseKind::Down(nsh_platform_tui::MouseButton::Left),
        nsh_platform_tui::MouseKind::Up(nsh_platform_tui::MouseButton::Left),
    ] {
        view.handle(super::app::mouse(kind, x + 2, y));
    }
    view.handle(key("X"));
    draw_until(&mut view, &mut terminal, &rx, "AuXdit");
    terminal.backend_mut().assert_cursor_position((x + 3, y));
    view.handle(key("Escape"));
    draw_until(&mut view, &mut terminal, &rx, "blurred");
    assert_eq!(symbol(&terminal, 0), "A");
}

#[test]
fn double_and_triple_clicks_select_the_word_and_the_line() {
    use nsh_platform_tui::{MouseButton::Left, MouseKind};
    let (mut view, mut terminal, rx) = field("defaultValue=\"one two three\"");
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    let click = |view: &mut nsh_platform_tui::AppView| {
        view.handle(super::app::mouse(MouseKind::Down(Left), 5, 0));
        view.handle(super::app::mouse(MouseKind::Up(Left), 5, 0));
    };
    click(&mut view);
    draw_until(&mut view, &mut terminal, &rx, "sel:5-5");
    click(&mut view);
    draw_until(&mut view, &mut terminal, &rx, "sel:4-7");
    click(&mut view);
    draw_until(&mut view, &mut terminal, &rx, "sel:0-13");
}

#[test]
fn a_double_click_drag_extends_the_selection_by_words() {
    use nsh_platform_tui::{MouseButton::Left, MouseKind};
    let (mut view, mut terminal, rx) = field("defaultValue=\"one two three\"");
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    view.handle(super::app::mouse(MouseKind::Down(Left), 5, 0));
    view.handle(super::app::mouse(MouseKind::Up(Left), 5, 0));
    view.handle(super::app::mouse(MouseKind::Down(Left), 5, 0));
    draw_until(&mut view, &mut terminal, &rx, "sel:4-7");
    // Into "three": the selection grows to whole words, keeping "two".
    view.handle(super::app::mouse(MouseKind::Move, 10, 0));
    draw_until(&mut view, &mut terminal, &rx, "sel:4-13");
    // Back over "one": the anchor word stays selected.
    view.handle(super::app::mouse(MouseKind::Move, 1, 0));
    draw_until(&mut view, &mut terminal, &rx, "sel:0-7");
    view.handle(super::app::mouse(MouseKind::Up(Left), 1, 0));
}

#[test]
fn the_cursor_is_a_bar_while_a_field_is_edited() {
    use std::{cell::Cell, rc::Rc};

    use nsh_platform_tui::CursorStyle;
    let (mut view, mut terminal, rx) = field("");
    let changes = Rc::new(Cell::new(Vec::<CursorStyle>::new()));
    let seen = changes.clone();
    view.on_cursor_style_changed(move |style| {
        let mut all = seen.take();
        all.push(style);
        seen.set(all);
    });
    view.handle(key("A"));
    draw_until(&mut view, &mut terminal, &rx, "\"A\"");
    assert_eq!(view.cursor_style(), CursorStyle::Bar);
    view.handle(key("Escape"));
    terminal
        .draw(|frame| view.render(frame, frame.area()))
        .unwrap();
    assert_eq!(view.cursor_style(), CursorStyle::Default);
    assert_eq!(changes.take(), [CursorStyle::Bar, CursorStyle::Default]);
}

/// A field with a clear `×` and a mask toggle after its text, each in a
/// slot as the gallery's field buttons are in a terminal: one Cell blank
/// each side of the mark (` × `, ` Show `), the whole slot pressable.
const FIELD_MARKS: &str = r##"
    import { mount, signal, View, Text } from "nsh";
    import { Input } from "nsh/base";
    const value = signal("Ada"), shown = signal(false);
    function Mark(props: { text: string; label: string; onPress: () => void }) {
        return (
            <View role="button" accessibilityLabel={props.label} onPress={props.onPress}
                style={{ width: props.text.length === 1 ? 24 : undefined, height: 16, flexShrink: 0,
                    alignItems: "center", justifyContent: "center" }}>
                <Text>{props.text.length === 1 ? props.text : ` ${props.text} `}</Text>
            </View>
        );
    }
    mount(() => <View style={{ width: 320 }}>
        <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: "#333333" }}>
            <Input value={value()} masked={!shown()} style={{ flex: 1, height: 16 }}
                onChange={({ value: text }) => value.set(text)} />
            <Mark text="×" label="Clear" onPress={() => value.set("")} />
            <Mark text={shown() ? "Hide" : "Show"} label="Reveal" onPress={() => shown.set(!shown())} />
        </View>
        <Text>{`value:${value()} shown:${shown()}`}</Text>
    </View>);
"##;

/// A press on `(x, y)` with the left button.
fn press_cell(view: &mut nsh_platform_tui::AppView, x: u16, y: u16) {
    use nsh_platform_tui::{MouseButton, MouseKind};
    view.handle(super::app::mouse(MouseKind::Down(MouseButton::Left), x, y));
    view.handle(super::app::mouse(MouseKind::Up(MouseButton::Left), x, y));
}

#[test]
fn a_field_s_clear_and_mask_marks_take_a_press_on_the_blank_cells_beside_them() {
    let code = nsh_bundler::compile_module("Marks.tsx", FIELD_MARKS, &[]).unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(48, 6)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "value:Ada shown:false");
    let dump = super::dock::dump(&terminal);
    let (clear, y) = super::dock::find(&terminal, "×").expect(&dump);
    let (show, _) = super::dock::find(&terminal, "Show").expect(&dump);
    // The blank Cell after `Show` reveals the text.
    press_cell(&mut view, show + 4, y);
    draw_until(&mut view, &mut terminal, &rx, "shown:true");
    // The blank Cell before `Hide` masks it again.
    let (hide, _) = super::dock::find(&terminal, "Hide").unwrap();
    press_cell(&mut view, hide - 1, y);
    draw_until(&mut view, &mut terminal, &rx, "shown:false");
    // The blank Cells either side of `×` clear the field.
    press_cell(&mut view, clear + 1, y);
    draw_until(&mut view, &mut terminal, &rx, "value: shown:false");
}

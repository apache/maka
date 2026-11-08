use nsh_core::{AttributedText, Points, TextEngine};
use nsh_platform_tui::CellTextEngine;

#[test]
fn wide_and_combining_graphemes_use_display_cells_at_any_font_size() {
    let engine = CellTextEngine::default();
    let mut text = AttributedText::default();
    text.push("A界e\u{301}👩‍💻", Default::default());
    let prepared = engine.prepare(&text);
    let measured = engine.measure(&prepared, None);
    assert_eq!(measured.width, Points(48.0));
    assert_eq!(measured.height, Points(16.0));
    text.spans[0].style.font_size = Points(64.0);
    assert_eq!(engine.measure(&engine.prepare(&text), None), measured);
}

#[test]
fn wrapping_prefers_spaces_and_keeps_utf16_grapheme_ranges() {
    let engine = CellTextEngine::default();
    let mut text = AttributedText::default();
    text.push("ab 界👩‍💻z", Default::default());
    let prepared = engine.prepare(&text);
    let measured = engine.measure(&prepared, Some(Points(32.0)));
    assert_eq!(measured, nsh_core::Size::new(Points(32.0), Points(48.0)));
    let lines = engine.lines(&engine.layout(&prepared, measured));
    assert_eq!(
        lines.iter().map(|l| (l.start, l.end)).collect::<Vec<_>>(),
        [(0, 2), (3, 9), (9, 10)]
    );
    assert_eq!(lines[1].y, Points(16.0));
}

#[test]
fn line_limit_and_alignment_use_cell_metrics() {
    let engine = CellTextEngine::default();
    let mut text = AttributedText::default();
    text.push("ab cd ef", Default::default());
    text.max_lines = 1;
    text.align = nsh_core::TextAlign::Right;
    let prepared = engine.prepare(&text);
    assert_eq!(
        engine.measure(&prepared, Some(Points(32.0))).height,
        Points(16.0)
    );
    let lines =
        engine.lines(&engine.layout(&prepared, nsh_core::Size::new(Points(32.0), Points(16.0))));
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0].width, Points(24.0));
    assert_eq!((lines[0].start, lines[0].end), (0, 2));
    assert_eq!(lines[0].x, Points(8.0));
}

#[test]
fn explicit_lines_empty_text_and_narrow_boxes_are_finite() {
    let engine = CellTextEngine::default();
    for (value, height) in [("", 16.0), ("a\n", 32.0), ("\n\n", 48.0), ("界", 16.0)] {
        let mut text = AttributedText::default();
        text.push(value, Default::default());
        assert_eq!(
            engine
                .measure(&engine.prepare(&text), Some(Points::ZERO))
                .height,
            Points(height)
        );
    }
    assert!(nsh_platform_tui::CellSize::new(Points::ZERO, Points(16.0)).is_err());
    assert!(nsh_platform_tui::CellSize::new(Points(f32::NAN), Points(16.0)).is_err());
}

#[test]
fn a_space_at_the_wrap_boundary_does_not_start_an_extra_row() {
    let engine = CellTextEngine::default();
    let mut text = AttributedText::default();
    text.push("ab cd", Default::default());
    let prepared = engine.prepare(&text);
    let size = engine.measure(&prepared, Some(Points(16.0)));
    assert_eq!(size, nsh_core::Size::new(Points(16.0), Points(32.0)));
    let lines = engine.lines(&engine.layout(&prepared, size));
    assert_eq!((lines[1].start, lines[1].end), (3, 5));
}

#[test]
fn empty_lines_after_crlf_keep_their_utf16_offsets() {
    let engine = CellTextEngine::default();
    let mut text = AttributedText::default();
    text.push("a\r\n\r\nb", Default::default());
    let prepared = engine.prepare(&text);
    let size = engine.measure(&prepared, None);
    let lines = engine.lines(&engine.layout(&prepared, size));
    assert_eq!(
        lines
            .iter()
            .map(|line| (line.start, line.end))
            .collect::<Vec<_>>(),
        [(0, 1), (3, 3), (5, 6)]
    );
}

#[test]
fn inline_attachments_reserve_cells_wrap_and_keep_utf16_positions() {
    use nsh_core::{Point, Size};
    let engine = CellTextEngine::default();
    let mut text = AttributedText::default();
    text.push("🙂", Default::default());
    text.push_attachment(Size::new(Points(17.0), Points(30.0)), Default::default());
    text.push("xy", Default::default());
    let prepared = engine.prepare(&text);
    let measured = engine.measure(&prepared, Some(Points(40.0)));
    assert_eq!(measured, Size::new(Points(40.0), Points(48.0)));
    let layout = engine.layout(&prepared, measured);
    assert_eq!(
        engine.attachments(&layout),
        vec![Some(Point::new(Points(16.0), Points(0.0)))]
    );
    let lines = engine.lines(&layout);
    assert_eq!(
        (lines[0].start, lines[0].end, lines[0].height),
        (0, 3, Points(32.0))
    );
    assert_eq!((lines[1].start, lines[1].y), (3, Points(32.0)));

    text.max_lines = 1;
    let prepared = engine.prepare(&text);
    let layout = engine.layout(&prepared, Size::new(Points(40.0), Points(32.0)));
    assert_eq!(engine.attachments(&layout), vec![None]);
}

#[test]
fn a_one_cell_attachment_at_a_wrap_boundary_is_not_discarded_as_space() {
    use nsh_core::{Point, Size};
    let engine = CellTextEngine::default();
    let mut text = AttributedText::default();
    text.push("ab", Default::default());
    text.push_attachment(Size::new(Points(8.0), Points(16.0)), Default::default());
    text.push("c", Default::default());
    let prepared = engine.prepare(&text);
    let size = engine.measure(&prepared, Some(Points(16.0)));
    let layout = engine.layout(&prepared, size);
    assert_eq!(
        engine.attachments(&layout),
        vec![Some(Point::new(Points(0.0), Points(16.0)))]
    );
}

#[cfg(feature = "js")]
#[test]
fn inline_mentions_and_math_draw_their_content_and_mentions_can_be_pressed() {
    use nsh_platform_tui::{Bundle, MouseButton, MouseKind};
    use ratatui_core::{backend::TestBackend, terminal::Terminal};

    use super::app::{draw_until, mouse, surface};
    let code = nsh_bundler::compile_module("App.tsx", r#"
        import { mount, signal, Text, View } from 'nsh';
        import { TextView } from 'nsh/base';
        const pressed = signal('waiting');
        mount(() => <View>
            <Text>Thanks <View onPress={() => pressed.set('pressed')}><Text>@Ada</Text></View>!</Text>
            <TextView markdown={'Inline $60$ frames.'} />
            <Text>{pressed()}</Text>
        </View>);
    "#, &[]).unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Thanks @Ada!");
    draw_until(&mut view, &mut terminal, &rx, "60");
    let buffer = terminal.backend().buffer();
    assert!(
        !buffer
            .content
            .iter()
            .any(|cell| cell.symbol().contains('\u{fffc}'))
    );
    let at = buffer
        .content
        .iter()
        .position(|cell| cell.symbol() == "@")
        .unwrap();
    let (x, y) = (at as u16 % 60, at as u16 / 60);
    for kind in [
        MouseKind::Down(MouseButton::Left),
        MouseKind::Up(MouseButton::Left),
    ] {
        view.handle(mouse(kind, x, y));
    }
    draw_until(&mut view, &mut terminal, &rx, "pressed");
}

#[cfg(feature = "js")]
#[test]
fn text_view_code_fences_draw_distinct_syntax_token_colors() {
    use nsh_platform_tui::Bundle;
    use ratatui_core::{backend::TestBackend, terminal::Terminal};

    use super::app::{draw_until, surface};
    let code = nsh_bundler::compile_module(
        "App.tsx",
        r#"
        import { mount } from 'nsh';
        import { TextView } from 'nsh/base';
        mount(() => <TextView markdown={'```tsx\nconst answer = "hello";\n```'} />);
    "#,
        &[],
    )
    .unwrap();
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 16)).unwrap();
    view.load(Bundle::source(code)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "const answer");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let at = buffer
            .content
            .iter()
            .position(|cell| cell.symbol() == "c")
            .unwrap();
        if buffer.content[at].fg != buffer.content[at + 16].fg {
            break;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "keyword and string need distinct syntax colors"
        );
    }
}

#[test]
fn wrapping_indented_code_keeps_content_on_the_first_visual_row() {
    let engine = CellTextEngine::default();
    let mut text = AttributedText::default();
    text.push("    hopper::run(App::default());", Default::default());
    let prepared = engine.prepare(&text);
    let size = engine.measure(&prepared, Some(Points(160.0)));
    let lines = engine.lines(&engine.layout(&prepared, size));
    assert_eq!(
        lines
            .iter()
            .map(|line| (line.start, line.end))
            .collect::<Vec<_>>(),
        [(0, 20), (20, 32)]
    );
}

#[test]
fn aligned_attachments_grow_the_line_above_and_below_its_cell_baseline() {
    use nsh_core::{AttachmentAlignments, Point, Size, VerticalAlign};
    let engine = CellTextEngine::default();
    for (align, height, ascent, small_top) in [
        (VerticalAlign::Baseline, 48.0, 48.0, 32.0),
        (VerticalAlign::TextTop, 48.0, 16.0, 0.0),
        (VerticalAlign::TextBottom, 48.0, 48.0, 32.0),
        (VerticalAlign::Middle, 64.0, 32.0, 16.0),
    ] {
        let mut text = AttributedText::default();
        text.push("A", Default::default());
        text.push_attachment(Size::new(Points(16.0), Points(48.0)), Default::default());
        text.push_attachment(Size::new(Points(8.0), Points(16.0)), Default::default());
        let mut alignments = AttachmentAlignments::default();
        alignments.set(1, align);
        let prepared = engine.prepare_aligned(&text, &alignments);
        let measured = engine.measure(&prepared, None);
        assert_eq!(
            measured,
            Size::new(Points(32.0), Points(height)),
            "{align:?}"
        );
        let layout = engine.layout(&prepared, measured);
        assert_eq!(
            engine.lines(&layout)[0].ascender,
            Points(ascent),
            "{align:?}"
        );
        assert_eq!(
            engine.attachments(&layout),
            vec![
                Some(Point::new(Points(8.0), Points(0.0))),
                Some(Point::new(Points(24.0), Points(small_top))),
            ],
            "{align:?}"
        );
    }
}

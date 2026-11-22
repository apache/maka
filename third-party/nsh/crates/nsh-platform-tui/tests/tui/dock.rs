//! Resizable panes in a terminal: the handle between two panes is the
//! line between them, one Cell across, dragged and stepped a Cell at a
//! time. A dock area's tab dragged over a group outlines where it would
//! land, over what is there.

use nsh_base::{
    dock::{DockAreaLayout, DockLayout, DockNode, DockPlacement, DockRegion, DockTab, dock_area},
    h_resizable, resizable_panel,
};
use nsh_core::prelude::*;
use nsh_platform_tui::{App, Handled, Input, Modifiers, MouseButton, MouseKind, Root};
use ratatui_core::{
    backend::TestBackend,
    style::{Color, Modifier},
    terminal::Terminal,
};

use super::app::{draw_until, draw_until_true, mouse, surface};

/// The row of the panes (the status is on row 0).
const ROW: u16 = 2;

/// Two panes side by side: a sidebar of 80 points (10 Cells), the rest
/// for the editor; what the group reports when a drag ends.
#[component]
fn Panes() -> impl IntoElement {
    let reported = signal(String::from("none"));
    view()
        .flex_1()
        .child(text(move || format!("sizes {}", reported.get())))
        .child(
            view().flex_1().child(
                h_resizable()
                    .on_resize(move |sizes: &Vec<Points>| {
                        let sizes: Vec<String> = sizes
                            .iter()
                            .map(|s| (s.0.round() as i32).to_string())
                            .collect();
                        reported.set(sizes.join(","));
                    })
                    .child(
                        resizable_panel()
                            .size(px(80.0))
                            .min_size(px(40.0))
                            .child(text("left\n1\n2\n3")),
                    )
                    .child(resizable_panel().min_size(px(40.0)).child(text("right"))),
            ),
        )
}

fn open() -> (
    nsh_platform_tui::AppView,
    Terminal<TestBackend>,
    crossbeam_channel::Receiver<()>,
) {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<Panes>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "sizes none");
    draw_until(&mut view, &mut terminal, &rx, "│");
    (view, terminal, rx)
}

/// The column of the handle's line on row [`ROW`].
fn handle_column(terminal: &Terminal<TestBackend>) -> u16 {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.width)
        .find(|&x| buffer[(x, ROW)].symbol() == "│")
        .expect("the handle's line is drawn")
}

/// The column where `word` starts on row 1 (the panes' first row).
fn column_of(terminal: &Terminal<TestBackend>, word: &str) -> u16 {
    let buffer = terminal.backend().buffer();
    let row: String = (0..buffer.area.width)
        .map(|x| buffer[(x, 1)].symbol())
        .collect();
    // Cells, not bytes: the handle's `│` is three bytes.
    let at = row.find(word).expect("the word is drawn");
    row[..at].chars().count() as u16
}

/// Draws until the handle's line is at column `x`.
fn draw_until_handle_at(
    view: &mut nsh_platform_tui::AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    x: u16,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if terminal.backend().buffer()[(x, ROW)].symbol() == "│" {
            return;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "the handle did not move to column {x}"
        );
    }
}

#[test]
fn the_handle_is_the_line_in_the_cell_between_the_panes() {
    let (_view, terminal, _rx) = open();
    // The sidebar is its 10 Cells, the line the Cell after it, the editor
    // the rest.
    assert_eq!(handle_column(&terminal), 10);
    assert_eq!(column_of(&terminal, "left"), 0);
    assert_eq!(column_of(&terminal, "right"), 11);
    let buffer = terminal.backend().buffer();
    for y in 1..8 {
        assert_eq!(
            buffer[(10, y)].symbol(),
            "│",
            "the line runs down the panes at row {y}"
        );
    }
}

#[test]
fn dragging_the_handle_five_cells_resizes_the_panes_by_five_cells() {
    let (mut view, mut terminal, rx) = open();
    assert_eq!(
        view.handle(mouse(MouseKind::Down(MouseButton::Left), 10, ROW)),
        Handled::Yes
    );
    // The panes follow the pointer Cell by Cell while it moves.
    for x in 11..=15 {
        assert_eq!(view.handle(mouse(MouseKind::Move, x, ROW)), Handled::Yes);
        draw_until_handle_at(&mut view, &mut terminal, &rx, x);
    }
    assert_eq!(
        view.handle(mouse(MouseKind::Up(MouseButton::Left), 15, ROW)),
        Handled::Yes
    );
    // 80 + 5 Cells of 8 points; the editor gave them up.
    draw_until(&mut view, &mut terminal, &rx, "sizes 120,192");
    assert_eq!(handle_column(&terminal), 15);
    assert_eq!(column_of(&terminal, "right"), 16);
}

#[test]
fn arrows_step_a_focused_handle_one_cell() {
    let (mut view, mut terminal, rx) = open();
    // The handle is the only stop of the keyboard focus.
    let key = |name: &str| Input::Key {
        key: name.into(),
        modifiers: Modifiers::default(),
        release: false,
    };
    assert_eq!(view.handle(key("Tab")), Handled::Yes);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    // The focus lights the line (the accent) and binds the arrows.
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if terminal.backend().buffer()[(10, ROW)].fg != Color::Reset
            && !terminal.backend().buffer()[(10, ROW)]
                .modifier
                .contains(Modifier::DIM)
        {
            break;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "the handle did not take the focus"
        );
    }
    assert_eq!(view.handle(key("Right")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "sizes 88,224");
    draw_until_handle_at(&mut view, &mut terminal, &rx, 11);
    assert_eq!(view.handle(key("Left")), Handled::Yes);
    assert_eq!(view.handle(key("Left")), Handled::Yes);
    draw_until(&mut view, &mut terminal, &rx, "sizes 72,240");
    draw_until_handle_at(&mut view, &mut terminal, &rx, 9);
}

#[test]
fn hovering_the_handle_lights_its_line() {
    let (mut view, mut terminal, rx) = open();
    let idle = terminal.backend().buffer()[(10, ROW)].clone();
    view.handle(mouse(MouseKind::Move, 10, ROW));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let cell = &terminal.backend().buffer()[(10, ROW)];
        if cell.fg != idle.fg && !cell.modifier.contains(Modifier::DIM) {
            break;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "hover did not light the line"
        );
    }
    // Off the handle, it is muted again.
    view.handle(mouse(MouseKind::Move, 30, ROW));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let cell = &terminal.backend().buffer()[(10, ROW)];
        if cell.fg == idle.fg && cell.modifier == idle.modifier {
            break;
        }
        assert!(rx.recv_deadline(deadline).is_ok(), "the line stayed lit");
    }
}

/// The handle's states change its line's color alone: hovered, held and
/// focused it is the same line in the accent on the ground it rests on,
/// no band under it and no weight.
#[test]
fn a_lit_handle_changes_its_lines_color_and_nothing_under_it() {
    let (mut view, mut terminal, rx) = open();
    let idle = terminal.backend().buffer()[(10, ROW)].clone();
    let lit = |t: &Terminal<TestBackend>| {
        let cell = &t.backend().buffer()[(10, ROW)];
        cell.fg != idle.fg && !cell.modifier.contains(Modifier::DIM)
    };
    let check = |t: &Terminal<TestBackend>, state: &str| {
        let cell = t.backend().buffer()[(10, ROW)].clone();
        assert_eq!(cell.symbol(), "│", "{state}: the line\n{}", dump(t));
        assert_eq!(
            cell.bg,
            idle.bg,
            "{state}: a band under the line\n{}",
            dump(t)
        );
        assert!(
            !cell.modifier.contains(Modifier::BOLD),
            "{state}: the line is bold\n{}",
            dump(t)
        );
        cell.fg
    };
    // Hovered.
    view.handle(mouse(MouseKind::Move, 10, ROW));
    draw_until_true(&mut view, &mut terminal, &rx, "hover lit the line", lit);
    let accent = check(&terminal, "hovered");
    // Held, then dragged.
    view.handle(mouse(MouseKind::Down(MouseButton::Left), 10, ROW));
    draw_until_true(&mut view, &mut terminal, &rx, "the press lit the line", lit);
    assert_eq!(check(&terminal, "pressed"), accent);
    view.handle(mouse(MouseKind::Up(MouseButton::Left), 10, ROW));
    view.handle(mouse(MouseKind::Move, 30, ROW));
    // The release gave it the focus: off the pointer it stays lit.
    draw_until_true(
        &mut view,
        &mut terminal,
        &rx,
        "the line stays lit while focused",
        lit,
    );
    assert_eq!(check(&terminal, "focused"), accent);
}

/// A dock layout as text: `h(..)` / `v(..)` of its children, a tab group
/// `[a *b]` with its displayed tab starred.
fn node_text(node: &DockNode) -> String {
    match node {
        DockNode::Split { axis, children, .. } => {
            let children: Vec<String> = children.iter().map(node_text).collect();
            let axis = if *axis == nsh_core::geometry::Axis::Horizontal {
                "h"
            } else {
                "v"
            };
            format!("{axis}({})", children.join(" "))
        }
        DockNode::Tabs {
            panels,
            active_index,
            ..
        } => {
            let tabs: Vec<String> = panels
                .iter()
                .enumerate()
                .map(|(ix, p)| match ix == *active_index {
                    true => format!("*{p}"),
                    false => p.to_string(),
                })
                .collect();
            format!("[{}]", tabs.join(" "))
        }
    }
}

/// Two groups side by side, `a b` 240 points (30 Cells) wide and `c`; the
/// layout the area reports, shown.
#[component]
fn Docked() -> impl IntoElement {
    let layout = signal(DockAreaLayout::new(
        DockLayout::h_split()
            .child(DockLayout::tabs().panel("a").panel("b"), Some(px(240.0)))
            .child(DockLayout::tabs().panel("c"), None),
    ));
    view()
        .flex_1()
        .child(text(move || {
            format!("Layout {}", node_text(&layout.get().center))
        }))
        .child(
            view().flex_1().child(
                dock_area()
                    .layout(move || layout.get())
                    .compact(Some(false))
                    .tab_bar_class("flex-row gap-2")
                    .render_tab(|tab: &DockTab| text(format!("Tab {}", tab.panel)))
                    // Shows that a drag started (in the dump of a failure).
                    .render_drag_preview(|tab: &DockTab| text(format!("drag {}", tab.panel)))
                    .render_panel(|panel: &nsh_base::dock::DockPanel| {
                        view()
                            .flex_1()
                            .child(text(format!("Panel {}\nmore\nmore", panel.id)))
                    })
                    .on_layout_change(move |next: &DockAreaLayout| layout.set(next.clone()))
                    .size_full(),
            ),
        )
}

/// The buffer's rows, each with its number, and the Cells drawn in a color.
pub(super) fn dump(terminal: &Terminal<TestBackend>) -> String {
    let buffer = terminal.backend().buffer();
    let mut out = String::new();
    for y in 0..buffer.area.height {
        let row: String = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        let colored: Vec<String> = (0..buffer.area.width)
            .filter(|&x| buffer[(x, y)].fg != Color::Reset && buffer[(x, y)].symbol() != " ")
            .map(|x| format!("{x}{}", buffer[(x, y)].symbol()))
            .collect();
        out += &format!("{y:>2}|{row}| {}\n", colored.join(" "));
    }
    out
}

/// Where `word` starts, in Cells.
pub(super) fn find(terminal: &Terminal<TestBackend>, word: &str) -> Option<(u16, u16)> {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height).find_map(|y| {
        let row: String = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        row.find(word)
            .map(|at| (row[..at].chars().count() as u16, y))
    })
}

/// The Cells of a frame's top right corner in the accent's place: what
/// only the drop preview draws in this layout.
fn outline_corner(terminal: &Terminal<TestBackend>) -> Option<(u16, u16)> {
    let buffer = terminal.backend().buffer();
    (0..buffer.area.height).find_map(|y| {
        (0..buffer.area.width)
            .find(|&x| matches!(buffer[(x, y)].symbol(), "╮" | "┐"))
            .map(|x| (x, y))
    })
}

#[test]
fn a_tab_dragged_to_a_group_s_right_edge_outlines_the_half_and_splits_there() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(80, 12)).unwrap();
    view.load(App::Rust(Root::new::<Docked>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel c");
    assert!(
        outline_corner(&terminal).is_none(),
        "no preview before a drag"
    );
    let (tab_x, tab_y) = find(&terminal, "Tab a").expect("tab a is drawn");
    let (panel_x, panel_y) = find(&terminal, "Panel c").expect("c's panel is drawn");
    // A terminal's pointer is a mouse, so the drag arms at once; it moves
    // to the right edge of c's content.
    view.handle(mouse(MouseKind::Down(MouseButton::Left), tab_x + 1, tab_y));
    let (to_x, to_y) = (78, panel_y + 1);
    for x in (tab_x + 2..=to_x).step_by(4).chain([to_x]) {
        view.handle(mouse(MouseKind::Move, x, to_y));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let corner = loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if let Some(corner) = outline_corner(&terminal) {
            break corner;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "the drop preview's outline did not show (tab a at {:?}, Panel c at {:?}, pointer at {:?}):\n{}",
            (tab_x, tab_y),
            (panel_x, panel_y),
            (to_x, to_y),
            dump(&terminal)
        );
    };
    // The right half of c's content, its corner at the area's right edge.
    assert!(
        corner.0 > panel_x,
        "the outline is over c's right half: {corner:?}"
    );
    let buffer = terminal.backend().buffer();
    assert_ne!(
        buffer[corner].fg,
        Color::Reset,
        "the outline is in the accent"
    );
    // What the group shows stays under the outline: nothing is cleared.
    assert_eq!(find(&terminal, "Panel c"), Some((panel_x, panel_y)));
    view.handle(mouse(MouseKind::Up(MouseButton::Left), to_x, to_y));
    draw_until(&mut view, &mut terminal, &rx, "Layout h([*b] [*c] [*a])");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while outline_corner(&terminal).is_some() {
        assert!(rx.recv_deadline(deadline).is_ok(), "the preview stayed");
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
    }
}

/// The dragged tab's label is drawn over the drop preview's outline, not
/// under it: with the label on the outline's bottom row, every character
/// of it stays (the outline through it read "dr─g a").
#[test]
fn the_dragged_tabs_label_stays_whole_over_the_drop_preview() {
    dragged_label_over_the_outline(12);
}

/// The same with the outline's bottom row above the screen's last one.
#[test]
fn the_dragged_tabs_label_stays_whole_over_the_drop_preview_on_a_tall_screen() {
    dragged_label_over_the_outline(40);
}

fn dragged_label_over_the_outline(rows: u16) {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(80, rows)).unwrap();
    view.load(App::Rust(Root::new::<Docked>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel c");
    let (tab_x, tab_y) = find(&terminal, "Tab a").expect("tab a is drawn");
    let (panel_x, panel_y) = find(&terminal, "Panel c").expect("c's panel is drawn");
    view.handle(mouse(MouseKind::Down(MouseButton::Left), tab_x + 1, tab_y));
    for x in (tab_x + 2..=panel_x + 3).step_by(4).chain([panel_x + 3]) {
        view.handle(mouse(MouseKind::Move, x, panel_y + 1));
    }
    draw_until_true(
        &mut view,
        &mut terminal,
        &rx,
        "the drop preview's outline did not show",
        |t| outline_corner(t).is_some(),
    );
    // The preview opened again over the indicator: the label is drawn
    // beside the pointer, inside the outline.
    draw_until_true(
        &mut view,
        &mut terminal,
        &rx,
        &format!(
            "the label shows by the pointer at {:?}",
            (panel_x + 3, panel_y + 1)
        ),
        |t| find(t, "drag a").is_some(),
    );
    // The outline around all of c's content: its middle column and its
    // bottom row.
    let (right, top) = outline_corner(&terminal).expect("the outline's corner");
    let buffer = terminal.backend().buffer();
    let bottom = (top + 1..buffer.area.height)
        .find(|&y| matches!(buffer[(right, y)].symbol(), "╯" | "┘"))
        .expect("the outline's bottom corner");
    let left = (0..right)
        .rev()
        .find(|&x| matches!(buffer[(x, top)].symbol(), "╭" | "┌"))
        .expect("the outline's left corner");
    let middle = (left + right) / 2;
    // A pointer is at its Cell's middle, so the preview's corner is the
    // Cell below and to the right of it: the label lies on the outline's
    // bottom row with the pointer on the row above.
    view.handle(mouse(MouseKind::Move, middle, bottom - 1));
    let what = format!(
        "the label is whole on the outline's row {bottom} (pointer at {:?}, outline {left}..={right}, rows {top}..={bottom})",
        (middle, bottom - 1)
    );
    draw_until_true(&mut view, &mut terminal, &rx, &what, |t| {
        find(t, "drag a").is_some_and(|(_, y)| y == bottom)
    });
    view.handle(mouse(MouseKind::Up(MouseButton::Left), middle, bottom - 1));
}

#[test]
fn a_tab_dragged_onto_a_group_s_tabs_outlines_it_over_what_it_shows() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(80, 12)).unwrap();
    view.load(App::Rust(Root::new::<Docked>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel c");
    let (tab_x, tab_y) = find(&terminal, "Tab a").expect("tab a is drawn");
    let (c_x, c_y) = find(&terminal, "Tab c").expect("tab c is drawn");
    let (panel_x, panel_y) = find(&terminal, "Panel c").expect("c's panel is drawn");
    // The handle's line between the groups, on c's panel row.
    let buffer = terminal.backend().buffer();
    let line = (0..panel_x)
        .rev()
        .find(|&x| buffer[(x, panel_y)].symbol() == "│")
        .expect("the handle's line is drawn");
    // Over c's tabs the drop merges into c: the outline is around all of
    // c's content.
    view.handle(mouse(MouseKind::Down(MouseButton::Left), tab_x + 1, tab_y));
    for x in (tab_x + 2..=c_x + 4).step_by(4).chain([c_x + 4]) {
        view.handle(mouse(MouseKind::Move, x, c_y));
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        if outline_corner(&terminal).is_some() {
            break;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "the drop preview's outline did not show:\n{}",
            dump(&terminal)
        );
    }
    // The outline only draws its lines, on the content's outer Cells: c's
    // text inside them and the handle beside them stay.
    let buffer = terminal.backend().buffer();
    let inside: String = (panel_x + 1..panel_x + 4)
        .map(|x| buffer[(x, panel_y + 1)].symbol())
        .collect();
    assert_eq!(inside, "ore", "{}", dump(&terminal));
    assert_eq!(
        terminal.backend().buffer()[(line, panel_y)].symbol(),
        "│",
        "the handle's line beside the outline\n{}",
        dump(&terminal)
    );
    view.handle(mouse(MouseKind::Up(MouseButton::Left), c_x + 4, c_y));
    // a left its group for c's: b is all its group has.
    draw_until(&mut view, &mut terminal, &rx, "Layout h([*b] [");
}

/// A center `c` over a bottom dock `t` of 160 points (10 rows) in a
/// 24-row terminal.
#[component]
fn BottomDocked() -> impl IntoElement {
    let mut bottom = DockRegion::new(DockLayout::tabs().panel("t"));
    bottom.size = Some(px(160.0));
    let layout = signal(
        DockAreaLayout::new(DockLayout::tabs().panel("c")).with_dock(DockPlacement::Bottom, bottom),
    );
    view().flex_1().child(
        dock_area()
            .layout(move || layout.get())
            .compact(Some(false))
            .tab_bar_class("flex-row gap-2")
            .render_tab(|tab: &DockTab| text(format!("Tab {}", tab.panel)))
            .render_panel(|panel: &nsh_base::dock::DockPanel| {
                view()
                    .flex_1()
                    .child(text(format!("Panel {}\nmore", panel.id)))
            })
            .on_layout_change(move |next: &DockAreaLayout| layout.set(next.clone()))
            .size_full(),
    )
}

#[test]
fn a_bottom_dock_keeps_its_size_in_rows() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
    view.load(App::Rust(Root::new::<BottomDocked>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel t");
    let (_, center) = find(&terminal, "Panel c").expect("the center's panel is drawn");
    let (_, tab) = find(&terminal, "Tab t").expect("the dock's tab is drawn");
    let (_, panel) = find(&terminal, "Panel t").expect("the dock's panel is drawn");
    // 160 points are 10 rows at the bottom of the 24: the dock starts on
    // row 14 with its handle's line, its tab below it, then its panel.
    assert_eq!(
        terminal.backend().buffer()[(5, 14)].symbol(),
        "─",
        "{}",
        dump(&terminal)
    );
    assert_eq!(tab, 15, "the dock's tab row\n{}", dump(&terminal));
    assert_eq!(panel, 16, "the dock's panel row\n{}", dump(&terminal));
    // The center takes the rest above it.
    assert!(center < tab, "{}", dump(&terminal));
    assert!(find(&terminal, "more").is_some_and(|(_, y)| y == center + 1));
}

/// A surface on a dark terminal whose own colors are known, so its frames
/// and fills are steps of them.
fn surfaces() -> (nsh_platform_tui::AppView, crossbeam_channel::Receiver<()>) {
    let (tx, rx) = crossbeam_channel::unbounded();
    let mut options = nsh_platform_tui::AppOptions::default();
    options.capabilities.colors = nsh_platform_tui::ColorDepth::TrueColor;
    options.capabilities.background_color = Some([24; 3]);
    options.capabilities.foreground_color = Some([224; 3]);
    options.wake = Some(std::sync::Arc::new(move || {
        let _ = tx.send(());
    }));
    options.cache = nsh_engine::CacheOptions::off();
    (nsh_platform_tui::AppView::new(options), rx)
}

/// Two groups one above the other in a frame: `a`, its panel longer than
/// its place, over `b`.
#[component]
fn Stacked() -> impl IntoElement {
    let layout = signal(DockAreaLayout::new(
        DockLayout::v_split()
            .child(DockLayout::tabs().panel("a"), Some(px(96.0)))
            .child(DockLayout::tabs().panel("b"), None),
    ));
    let rows: String = (1..=30)
        .map(|row| format!("row {row}"))
        .collect::<Vec<_>>()
        .join("\n");
    view().flex_1().p(px(8.0)).child(
        view()
            .flex_1()
            .border(px(1.0))
            .border_color(nsh_base::theme().border)
            .child(
                dock_area()
                    .layout(move || layout.get())
                    .compact(Some(false))
                    .tab_bar_class("flex-row gap-2")
                    .render_tab(|tab: &DockTab| text(format!("Tab {}", tab.panel)))
                    .render_panel(move |panel: &nsh_base::dock::DockPanel| {
                        let body = match panel.id.as_ref() {
                            "a" => rows.clone(),
                            _ => format!("Panel {}", panel.id),
                        };
                        view().flex_1().overflow_hidden().child(text(body))
                    })
                    .on_layout_change(move |next: &DockAreaLayout| layout.set(next.clone()))
                    .size_full(),
            ),
    )
}

#[test]
fn the_line_between_stacked_groups_has_no_blank_rows_and_is_the_frame_s_color() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(60, 24)).unwrap();
    view.load(App::Rust(Root::new::<Stacked>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel b");
    let (tab_x, tab_y) = find(&terminal, "Tab b").expect("b's tab is drawn");
    let buffer = terminal.backend().buffer();
    let line = (tab_x, tab_y - 1);
    // The line is right above b's tab, and a's rows run down to it.
    assert_eq!(
        buffer[line].symbol(),
        "─",
        "the line is the row above b's tab\n{}",
        dump(&terminal)
    );
    let above: String = (0..buffer.area.width)
        .map(|x| buffer[(x, tab_y - 2)].symbol())
        .collect();
    assert!(
        above.contains("row "),
        "a's rows reach the line: no blank row above it\n{}",
        dump(&terminal)
    );
    // The frame's top left corner, drawn in the border's step: the line
    // between the groups is drawn in it too.
    let corner = (0..buffer.area.height)
        .find_map(|y| {
            (0..buffer.area.width)
                .find(|&x| matches!(buffer[(x, y)].symbol(), "╭" | "┌"))
                .map(|x| (x, y))
        })
        .expect("the frame is drawn");
    assert_eq!(
        buffer[line].fg,
        buffer[corner].fg,
        "the line is the frame's color\n{}",
        dump(&terminal)
    );
}

/// A dock area's handle as a group's: hovered, its line turns the accent
/// on the ground it rests on, no band under it.
#[test]
fn a_hovered_dock_handle_changes_its_lines_color_and_nothing_under_it() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(80, 12)).unwrap();
    view.load(App::Rust(Root::new::<Docked>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel c");
    let (panel_x, panel_y) = find(&terminal, "Panel c").expect("c's panel is drawn");
    let buffer = terminal.backend().buffer();
    let line = (0..panel_x)
        .rev()
        .find(|&x| buffer[(x, panel_y)].symbol() == "│")
        .expect("the handle's line is drawn");
    let idle = buffer[(line, panel_y)].clone();
    view.handle(mouse(MouseKind::Move, line, panel_y));
    draw_until_true(&mut view, &mut terminal, &rx, "hover lit the line", |t| {
        t.backend().buffer()[(line, panel_y)].fg != idle.fg
    });
    let cell = terminal.backend().buffer()[(line, panel_y)].clone();
    assert_eq!(cell.symbol(), "│", "{}", dump(&terminal));
    assert_eq!(
        cell.bg,
        idle.bg,
        "a band under the line\n{}",
        dump(&terminal)
    );
    assert!(
        !cell.modifier.contains(Modifier::BOLD),
        "{}",
        dump(&terminal)
    );
}

#[test]
fn a_drop_preview_is_an_accent_line_over_a_faint_accent_band() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(80, 12)).unwrap();
    view.load(App::Rust(Root::new::<Docked>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel c");
    let (tab_x, tab_y) = find(&terminal, "Tab a").expect("tab a is drawn");
    let (c_x, c_y) = find(&terminal, "Tab c").expect("tab c is drawn");
    let (panel_x, panel_y) = find(&terminal, "Panel c").expect("c's panel is drawn");
    // The accent, as the terminal draws it: the handle's line while the
    // pointer is over it.
    let buffer = terminal.backend().buffer();
    let line = (0..panel_x)
        .rev()
        .find(|&x| buffer[(x, panel_y)].symbol() == "│")
        .expect("the handle's line is drawn");
    let idle = buffer[(line, panel_y)].fg;
    view.handle(mouse(MouseKind::Move, line, panel_y));
    draw_until_true(&mut view, &mut terminal, &rx, "hover lit the line", |t| {
        t.backend().buffer()[(line, panel_y)].fg != idle
    });
    let accent = terminal.backend().buffer()[(line, panel_y)].fg;
    view.handle(mouse(MouseKind::Move, panel_x + 10, panel_y + 1));
    draw_until_true(&mut view, &mut terminal, &rx, "the line stayed lit", |t| {
        t.backend().buffer()[(line, panel_y)].fg == idle
    });
    let inner = (panel_x + 1, panel_y + 1);
    let ground = terminal.backend().buffer()[inner].bg;
    // Over c's tabs the drop merges into c: the preview is around all of
    // c's content.
    view.handle(mouse(MouseKind::Down(MouseButton::Left), tab_x + 1, tab_y));
    for x in (tab_x + 2..=c_x + 4).step_by(4).chain([c_x + 4]) {
        view.handle(mouse(MouseKind::Move, x, c_y));
    }
    draw_until_true(
        &mut view,
        &mut terminal,
        &rx,
        "the drop preview's outline did not show",
        |t| outline_corner(t).is_some(),
    );
    let buffer = terminal.backend().buffer();
    let corner = outline_corner(&terminal).unwrap();
    assert_eq!(
        buffer[corner].fg,
        accent,
        "the outline is in the accent\n{}",
        dump(&terminal)
    );
    // Inside it, c's text stays over a band of the accent: a mark laid
    // over the content, its Cells keeping their symbols.
    let inside: String = (panel_x + 1..panel_x + 4)
        .map(|x| buffer[(x, panel_y + 1)].symbol())
        .collect();
    assert_eq!(inside, "ore", "{}", dump(&terminal));
    assert_ne!(
        buffer[inner].bg,
        ground,
        "the preview bands its Cells\n{}",
        dump(&terminal)
    );
    view.handle(mouse(MouseKind::Up(MouseButton::Left), c_x + 4, c_y));
    draw_until(&mut view, &mut terminal, &rx, "Layout h([*b] [");
}

/// A framed workspace whose lines meet: `a` beside `b` over `c`, and a
/// bottom dock `t` under them all.
#[component]
fn Crossing() -> impl IntoElement {
    let mut bottom = DockRegion::new(DockLayout::tabs().panel("t"));
    bottom.size = Some(px(64.0));
    let layout = signal(
        DockAreaLayout::new(
            DockLayout::h_split()
                .child(DockLayout::tabs().panel("a"), Some(px(160.0)))
                .child(
                    DockLayout::v_split()
                        .child(DockLayout::tabs().panel("b"), Some(px(80.0)))
                        .child(DockLayout::tabs().panel("c"), None),
                    None,
                ),
        )
        .with_dock(DockPlacement::Bottom, bottom),
    );
    view().flex_1().child(
        view()
            .flex_1()
            .border(px(1.0))
            .border_color(nsh_base::theme().border)
            .child(
                dock_area()
                    .layout(move || layout.get())
                    .compact(Some(false))
                    .tab_bar_class("flex-row gap-2")
                    .render_tab(|tab: &DockTab| text(format!("Tab {}", tab.panel)))
                    .render_panel(|panel: &nsh_base::dock::DockPanel| {
                        view().flex_1().child(text(format!("Panel {}", panel.id)))
                    })
                    .on_layout_change(move |next: &DockAreaLayout| layout.set(next.clone()))
                    .size_full(),
            ),
    )
}

#[test]
fn lines_that_meet_are_joined_with_each_other_and_with_the_frame() {
    let (mut view, rx) = surfaces();
    let mut terminal = Terminal::new(TestBackend::new(70, 24)).unwrap();
    view.load(App::Rust(Root::new::<Crossing>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel t");
    let buffer = terminal.backend().buffer();
    let symbol = |x: u16, y: u16| buffer[(x, y)].symbol().to_string();
    // The frame's corners: its left and right columns, its top row.
    let (left, top) = (0..buffer.area.height)
        .find_map(|y| {
            (0..buffer.area.width)
                .find(|&x| matches!(buffer[(x, y)].symbol(), "╭" | "┌"))
                .map(|x| (x, y))
        })
        .expect("the frame is drawn");
    let right = (left + 1..buffer.area.width)
        .rev()
        .find(|&x| matches!(buffer[(x, top)].symbol(), "╮" | "┐"))
        .expect("the frame's top right corner is drawn");
    // a's line down the workspace, b's and c's across the right column,
    // the dock's across it all.
    let (a_x, a_y) = find(&terminal, "Panel a").expect("a is drawn");
    let column = (a_x..right)
        .find(|&x| buffer[(x, a_y)].symbol() == "│")
        .expect("the line beside a is drawn");
    let (_, c_tab) = find(&terminal, "Tab c").expect("c's tab is drawn");
    let between = c_tab - 1;
    let (_, t_tab) = find(&terminal, "Tab t").expect("the dock's tab is drawn");
    let dock = t_tab - 1;
    let joins = [
        // a's line meets the frame's top, b's and c's line, the dock's.
        ((column, top), "┬"),
        ((column, between), "├"),
        ((column, dock), "┴"),
        // b's and c's line meets the frame's right side.
        ((right, between), "┤"),
        // The dock's line meets the frame's sides.
        ((left, dock), "├"),
        ((right, dock), "┤"),
    ];
    let wrong: Vec<String> = joins
        .iter()
        .filter(|&&((x, y), join)| symbol(x, y) != join)
        .map(|&((x, y), join)| format!("({x}, {y}) is {:?}, not {join:?}", symbol(x, y)))
        .collect();
    assert!(
        wrong.is_empty(),
        "lines that meet are joined: {wrong:?}\n{}",
        dump(&terminal)
    );
    // The line beside a runs down to the dock's line: no gap between
    // them.
    for y in top + 1..dock {
        assert!(
            matches!(symbol(column, y).as_str(), "│" | "├"),
            "the line beside a reaches the dock's ({column}, {y})\n{}",
            dump(&terminal)
        );
    }
}

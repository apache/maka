//! Anchored popups in a terminal: a dropdown, a menu and a date picker's
//! calendar go on the row after their trigger's (or the rows above it
//! when there is no room below), never over it, as tall as their rows; a
//! dialog's popup with `auto` side margins is centered, its top margin
//! kept; a command's search field has a rule under it, and so has a
//! searchable select's. A popup the terminal frames outside its box is
//! placed with that frame: beside its trigger, never on its row, lined up
//! with its start or end. A sheet is a solid panel the height of the
//! screen over a cleared page; a toast shows on the status line, the
//! bottom row, the newest alone.

use nsh_base::{
    Anchor, CommandItem, SelectItem, combobox, command, date_picker, menu, menu_item, select,
    sheet, toast, toast_stack,
};
use nsh_core::{
    geometry::{auto, relative},
    overlay::{Align, Placement},
    prelude::*,
};
use nsh_platform_tui::{App, Input, Modifiers, MouseKind, Root};
use ratatui_core::{backend::TestBackend, terminal::Terminal};

use super::{
    app::{draw_until, draw_until_gone, draw_until_still, mouse, surface},
    dock::{dump, find},
};

fn tags() -> Vec<SelectItem> {
    vec![
        SelectItem::new("rust", "Rust"),
        SelectItem::new("go", "Go"),
        SelectItem::new("ruby", "Ruby"),
        SelectItem::new("swift", "Swift"),
    ]
}

/// An open combobox of four tags with a footer `Done`, its field `Pick`.
fn tag_box() -> impl IntoElement {
    combobox()
        .items(tags())
        .placeholder("Pick")
        .accessibility_label("Tags")
        .default_open(true)
        .footer(text("Done"))
        .w(px(160.0))
}

/// The combobox on row 1, the screen's rows below it.
#[component]
fn DropdownBelow() -> impl IntoElement {
    view().flex_1().child(text("above")).child(tag_box())
}

/// The combobox on the last row: the room is above it.
#[component]
fn DropdownAbove() -> impl IntoElement {
    view()
        .flex_1()
        .child(text("above"))
        .child(view().flex_1())
        .child(tag_box())
}

/// The combobox of tags 20 Cells wide after a margin of two Cells, its
/// list aligned with the field's `align` edge.
fn aligned_box(align: Align) -> impl IntoElement {
    view().flex_1().child(text("above")).child(
        view().flex_row().child(view().w(px(16.0))).child(
            combobox()
                .items(tags())
                .placeholder("Pick")
                .accessibility_label("Tags")
                .default_open(true)
                .footer(text("Done"))
                .align(align)
                .w(px(160.0)),
        ),
    )
}

#[component]
fn DropdownStart() -> impl IntoElement {
    aligned_box(Align::Start)
}

#[component]
fn DropdownEnd() -> impl IntoElement {
    aligned_box(Align::End)
}

/// The rows of `words`, in order: where each first shows.
fn rows_of(terminal: &Terminal<TestBackend>, words: &[&str]) -> Vec<u16> {
    words
        .iter()
        .map(|w| {
            find(terminal, w)
                .unwrap_or_else(|| panic!("{w:?} shows\n{}", dump(terminal)))
                .1
        })
        .collect()
}

/// `rows` follow one another, one row each.
fn consecutive(terminal: &Terminal<TestBackend>, rows: &[u16]) {
    for pair in rows.windows(2) {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "one row each, no rows between: {rows:?}\n{}",
            dump(terminal)
        );
    }
}

#[test]
fn a_dropdown_goes_on_the_rows_below_its_trigger_as_tall_as_its_rows() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<DropdownBelow>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Swift");
    let (_, trigger) =
        find(&terminal, "Pick").unwrap_or_else(|| panic!("the trigger shows\n{}", dump(&terminal)));
    let rows = rows_of(&terminal, &["Rust", "Go", "Ruby", "Swift", "Done"]);
    assert!(
        rows[0] > trigger && rows[0] <= trigger + 2,
        "the first row right below the trigger's (row {trigger}): {rows:?}\n{}",
        dump(&terminal)
    );
    consecutive(&terminal, &rows);
}

#[test]
fn a_dropdowns_frame_runs_from_its_triggers_first_column_to_its_last() {
    // The terminal draws the list's line a Cell outside its box: the list
    // is two Cells narrower than its field, so its frame, lines included,
    // is the field's columns whichever edge the app aligns it on.
    for root in [
        Root::new::<DropdownStart>(|| ()),
        Root::new::<DropdownEnd>(|| ()),
    ] {
        let (mut view, rx) = surface();
        let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
        view.load(App::Rust(root)).unwrap();
        draw_until(&mut view, &mut terminal, &rx, "Swift");
        let (x, y) = find(&terminal, "Pick")
            .unwrap_or_else(|| panic!("the trigger shows\n{}", dump(&terminal)));
        assert_eq!(x, 2, "the field after its margin\n{}", dump(&terminal));
        let start = find(&terminal, "╭").unwrap_or_else(|| panic!("a frame\n{}", dump(&terminal)));
        let end = find(&terminal, "╮").unwrap_or_else(|| panic!("a frame\n{}", dump(&terminal)));
        assert_eq!(
            (start, end),
            ((x, y + 1), (x + 19, y + 1)),
            "the frame's corners in the field's first and last columns, on the row after it\n{}",
            dump(&terminal)
        );
    }
}

#[test]
fn a_dropdown_without_room_below_goes_above_its_trigger() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 16)).unwrap();
    view.load(App::Rust(Root::new::<DropdownAbove>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Swift");
    let (_, trigger) =
        find(&terminal, "Pick").unwrap_or_else(|| panic!("the trigger shows\n{}", dump(&terminal)));
    let rows = rows_of(&terminal, &["Rust", "Go", "Ruby", "Swift", "Done"]);
    let last = *rows.last().unwrap();
    assert!(
        last < trigger && last + 2 >= trigger,
        "the last row right above the trigger's (row {trigger}): {rows:?}\n{}",
        dump(&terminal)
    );
    consecutive(&terminal, &rows);
}

/// An open menu of two items under a trigger `View` on row 1.
#[component]
fn OpenMenu() -> impl IntoElement {
    view().flex_1().child(text("above")).child(
        menu()
            .default_open(true)
            .trigger(view().child(text("View")))
            .child(
                menu_item()
                    .accessibility_label("About")
                    .child(text("About")),
            )
            .child(menu_item().accessibility_label("Quit").child(text("Quit"))),
    )
}

#[test]
fn a_menu_goes_on_the_rows_below_its_trigger() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<OpenMenu>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Quit");
    let rows = rows_of(&terminal, &["View", "About", "Quit"]);
    assert!(
        rows[1] > rows[0] && rows[1] <= rows[0] + 2,
        "the first item right below the trigger's row: {rows:?}\n{}",
        dump(&terminal)
    );
    consecutive(&terminal, &rows[1..]);
}

/// The open menu with its first item filled (a highlighted row's look,
/// the app's): the item is not the popup's box.
#[component]
fn FilledFirstItem() -> impl IntoElement {
    view().flex_1().child(text("above")).child(
        menu()
            .default_open(true)
            .trigger(view().child(text("View")))
            .child(
                menu_item()
                    .accessibility_label("About")
                    .bg(nsh_core::color::rgb(0x2563eb))
                    .child(text("About")),
            )
            .child(menu_item().accessibility_label("Quit").child(text("Quit"))),
    )
}

#[test]
fn a_menu_s_filled_first_item_leaves_the_frame_around_the_whole_menu() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<FilledFirstItem>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Quit");
    let rows = rows_of(&terminal, &["View", "About", "Quit"]);
    let (_, top) =
        find(&terminal, "╭").unwrap_or_else(|| panic!("the menu is framed\n{}", dump(&terminal)));
    let (_, bottom) = find(&terminal, "╰").unwrap();
    assert!(
        top > rows[0] && top < rows[1] && bottom > rows[2],
        "one frame around both items, below the trigger's row: {rows:?}, \
         frame rows {top}..={bottom}\n{}",
        dump(&terminal)
    );
    consecutive(&terminal, &rows[1..]);
}

/// An open menu of a group of choices, its items rows with a gap of the
/// app's: the first checked.
#[component]
fn CheckedMenu() -> impl IntoElement {
    let item = |label: &'static str, on: bool| {
        menu_item()
            .checked(Some(on))
            .accessibility_label(label)
            .flex_row()
            .gap(px(8.0))
            .child(text(label))
    };
    view().flex_1().child(text("above")).child(
        menu()
            .default_open(true)
            .trigger(view().child(text("Block")))
            .child(item("Paragraph", true))
            .child(item("Heading", false)),
    )
}

/// An open menu of a group of radio choices, as [`CheckedMenu`]'s: the
/// first checked.
#[component]
fn RadioMenu() -> impl IntoElement {
    let item = |label: &'static str, on: bool| {
        menu_item()
            .checked(Some(on))
            .role(Some(AccessibilityRole::MenuItemRadio))
            .accessibility_label(label)
            .flex_row()
            .gap(px(8.0))
            .child(text(label))
    };
    view().flex_1().child(text("above")).child(
        menu()
            .default_open(true)
            .trigger(view().child(text("Block")))
            .child(item("Paragraph", true))
            .child(item("Heading", false)),
    )
}

/// The column of the frame's right line on row `y`, the first after `x`.
fn frame_after(terminal: &Terminal<TestBackend>, x: u16, y: u16) -> u16 {
    let buffer = terminal.backend().buffer();
    (x..buffer.area.width)
        .find(|&c| buffer[(c, y)].symbol() == "│")
        .unwrap_or_else(|| panic!("no frame after ({x}, {y})\n{}", dump(terminal)))
}

/// The first occurrence of `word` below row `after`.
fn find_below(terminal: &Terminal<TestBackend>, word: &str, after: u16) -> Option<(u16, u16)> {
    let buffer = terminal.backend().buffer();
    (after + 1..buffer.area.height).find_map(|y| {
        let line: String = (0..buffer.area.width)
            .map(|x| buffer[(x, y)].symbol())
            .collect();
        line.find(word)
            .map(|byte| (line[..byte].chars().count() as u16, y))
    })
}

/// A list's or a menu's marks: the titles start in one column on every row,
/// nothing before them, and the chosen row's `mark` is its last Cell inside
/// the frame, the other row blank there.
fn marks_at_the_rows_end(
    terminal: &Terminal<TestBackend>,
    (chosen, chosen_row): (u16, u16),
    (other, other_row): (u16, u16),
    mark: &str,
) -> u16 {
    let buffer = terminal.backend().buffer();
    assert_eq!(
        chosen,
        other,
        "the titles in one column\n{}",
        dump(terminal)
    );
    for (x, y) in [(chosen, chosen_row), (other, other_row)] {
        let before = buffer[(x - 1, y)].symbol();
        assert!(
            before == " " || before == "│",
            "no mark before a title: {before:?}\n{}",
            dump(terminal)
        );
    }
    let frame = frame_after(terminal, chosen, chosen_row);
    assert_eq!(
        frame_after(terminal, other, other_row),
        frame,
        "one frame\n{}",
        dump(terminal)
    );
    let end = (chosen..frame)
        .rev()
        .find(|&x| buffer[(x, chosen_row)].symbol() != " ")
        .unwrap();
    assert_eq!(
        buffer[(end, chosen_row)].symbol(),
        mark,
        "the mark is the chosen row's last Cell\n{}",
        dump(terminal)
    );
    assert_eq!(
        buffer[(end, other_row)].symbol(),
        " ",
        "the other row blank in the mark's column\n{}",
        dump(terminal)
    );
    end
}

#[test]
fn a_menu_s_checks_are_at_the_rows_end_and_its_labels_line_up() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<CheckedMenu>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Heading");
    let paragraph = find(&terminal, "Paragraph").unwrap();
    let heading = find(&terminal, "Heading").unwrap();
    let mark = marks_at_the_rows_end(&terminal, paragraph, heading, "✓");
    assert!(
        mark > paragraph.0 + "Paragraph".len() as u16,
        "after the label\n{}",
        dump(&terminal)
    );
}

#[test]
fn a_menu_s_radio_items_show_a_dot_at_the_rows_end() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<RadioMenu>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Heading");
    let paragraph = find(&terminal, "Paragraph").unwrap();
    let heading = find(&terminal, "Heading").unwrap();
    marks_at_the_rows_end(&terminal, paragraph, heading, "●");
    assert!(
        find(&terminal, "✓").is_none(),
        "no check\n{}",
        dump(&terminal)
    );
}

/// An open date picker under a trigger `Pick` on row 1.
#[component]
fn OpenPicker() -> impl IntoElement {
    view().flex_1().child(text("above")).child(
        date_picker()
            .accessibility_label("Due")
            .default_open(true)
            .trigger(view().w(px(160.0)).child(text("Pick"))),
    )
}

#[test]
fn a_date_picker_s_calendar_shows_its_days_below_its_trigger() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 24)).unwrap();
    view.load(App::Rust(Root::new::<OpenPicker>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "28");
    let rows = rows_of(&terminal, &["Pick", "‹", "28"]);
    assert!(
        rows[1] > rows[0],
        "the calendar's header below the trigger's row: {rows:?}\n{}",
        dump(&terminal)
    );
    assert!(
        rows[2] > rows[1],
        "its days below its header: {rows:?}\n{}",
        dump(&terminal)
    );
}

/// The Cells of row `y` from `from` to `to` (both kept), as text.
fn cells_of(terminal: &Terminal<TestBackend>, y: u16, from: u16, to: u16) -> String {
    let buffer = terminal.backend().buffer();
    (from..=to).map(|x| buffer[(x, y)].symbol()).collect()
}

/// Draws until the row under the calendar's header shows something else
/// than `before`, then until it is still.
fn draw_until_changed(
    view: &mut nsh_platform_tui::AppView,
    terminal: &mut Terminal<TestBackend>,
    rx: &crossbeam_channel::Receiver<()>,
    (y, from, to): (u16, u16, u16),
    before: &str,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        draw_until_still(view, terminal, rx);
        if cells_of(terminal, y, from, to) != before {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the view never changed\n{}",
            dump(terminal)
        );
        let _ = rx.recv_timeout(std::time::Duration::from_millis(20));
    }
}

/// The first and the last Cell with a glyph on row `y` between `from` and
/// `to`.
fn ink(terminal: &Terminal<TestBackend>, y: u16, from: u16, to: u16) -> (u16, u16) {
    let buffer = terminal.backend().buffer();
    let inked: Vec<u16> = (from..=to)
        .filter(|&x| buffer[(x, y)].symbol() != " ")
        .collect();
    (
        *inked
            .first()
            .unwrap_or_else(|| panic!("row {y} blank\n{}", dump(terminal))),
        *inked.last().unwrap(),
    )
}

#[test]
fn a_date_picker_s_month_and_year_views_are_centered_in_its_days_width() {
    use nsh_platform_tui::MouseButton;
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(60, 24)).unwrap();
    view.load(App::Rust(Root::new::<OpenPicker>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "28");
    draw_until_still(&mut view, &mut terminal, &rx);
    let (start, header) = find(&terminal, "‹").unwrap();
    let (end, _) = find(&terminal, "›").unwrap();
    // The days span the header, its arrows over their first and last
    // columns (a day of one digit on its column's last Cell).
    let days = ink(&terminal, header + 2, start, end);
    assert!(
        days.0 <= start + 1 && days.1 == end,
        "the days under the header: {days:?}\n{}",
        dump(&terminal)
    );
    let click = |view: &mut nsh_platform_tui::AppView, x: u16, y: u16| {
        view.handle(mouse(MouseKind::Down(MouseButton::Left), x, y));
        view.handle(mouse(MouseKind::Up(MouseButton::Left), x, y));
    };
    // The header's toggles (numbers without `renderItem`): the month's,
    // then the year's.
    let (month, year) = ink(&terminal, header, start + 1, end - 1);
    let below = (header + 1, start, end);
    let centered = |terminal: &Terminal<TestBackend>, what: &str| {
        assert_eq!(
            (find(terminal, "‹").unwrap(), find(terminal, "›").unwrap().0),
            ((start, header), end),
            "the header as wide as the days, its arrows at the ends: {what}\n{}",
            dump(terminal)
        );
        let (first, last) = ink(terminal, header + 1, start, end);
        let (left, right) = (first - start, end - last);
        assert!(
            left.abs_diff(right) <= 1 && left > 1,
            "the {what} centered under the header: {left} and {right} blank Cells\n{}",
            dump(terminal)
        );
    };
    let before = cells_of(&terminal, below.0, below.1, below.2);
    click(&mut view, year, header);
    draw_until_changed(&mut view, &mut terminal, &rx, below, &before);
    centered(&terminal, "years");
    // Four years a row, two blank Cells apart.
    let row = cells_of(&terminal, header + 1, start, end);
    assert_eq!(
        row.split_whitespace().count(),
        4,
        "four years a row: {row:?}\n{}",
        dump(&terminal)
    );
    // A year chosen goes back to the days; the month toggle opens the
    // months.
    let before = cells_of(&terminal, below.0, below.1, below.2);
    let (first, _) = ink(&terminal, header + 1, start, end);
    click(&mut view, first, header + 1);
    draw_until_changed(&mut view, &mut terminal, &rx, below, &before);
    let before = cells_of(&terminal, below.0, below.1, below.2);
    click(&mut view, month, header);
    draw_until_changed(&mut view, &mut terminal, &rx, below, &before);
    centered(&terminal, "months");
}

/// A dialog whose popup is 30 Cells wide, centered by `auto` side
/// margins, 12% of the width below the top.
#[component]
fn CenteredDialog() -> impl IntoElement {
    view().flex_1().child(text("page")).child(
        nsh_base::dialog().child(
            view()
                .mx(auto())
                .mt(relative(0.12))
                .w(px(240.0))
                .child(text("Palette")),
        ),
    )
}

#[test]
fn a_dialog_s_popup_with_auto_margins_is_centered_below_its_top_margin() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(80, 40)).unwrap();
    view.load(App::Rust(Root::new::<CenteredDialog>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Palette");
    let (x, y) = find(&terminal, "Palette").unwrap();
    // 25 Cells each side of 30 in 80 (the popup's border or padding
    // before its text at most).
    assert!(
        (25..=28).contains(&x),
        "centered: x {x}\n{}",
        dump(&terminal)
    );
    // 12% of 640 points is 76.8: about 5 rows, not the one row a margin
    // between two boxes of a column takes.
    assert!(
        (4..=7).contains(&y),
        "below its margin: y {y}\n{}",
        dump(&terminal)
    );
}

/// A command over two items with its search field `Find`.
#[component]
fn InlineCommand() -> impl IntoElement {
    view().flex_1().child(
        command()
            .items(vec![
                CommandItem::new("a", "Alpha"),
                CommandItem::new("b", "Beta"),
            ])
            .placeholder("Find")
            .accessibility_label("Commands"),
    )
}

#[test]
fn a_command_s_search_field_has_a_rule_under_it() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<InlineCommand>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Beta");
    let (x, field) = find(&terminal, "Find").unwrap();
    let rows = rows_of(&terminal, &["Alpha", "Beta"]);
    assert_eq!(
        terminal.backend().buffer()[(x, field + 1)].symbol(),
        "─",
        "a rule under the field\n{}",
        dump(&terminal)
    );
    assert_eq!(
        rows[0],
        field + 2,
        "the rows under the rule\n{}",
        dump(&terminal)
    );
}

/// A dropdown's frame without a component: an overlay under `Pick` holding
/// a scroll view over a list of four rows virtualized against it, and a
/// footer; the heights each reports, in points.
#[component]
fn BarePopup() -> impl IntoElement {
    let anchor = element_ref();
    let heights = signal([0.0f32; 3]);
    let report = move |at: usize| {
        move |frame: &Bounds<Points>| heights.update(|h| h[at] = frame.size.height.0)
    };
    view()
        .flex_1()
        .child(text(move || {
            let [o, s, l] = heights.get();
            format!("heights {o} {s} {l}")
        }))
        .child(view().w(px(160.0)).element_ref(&anchor).child(text("Pick")))
        .child(
            overlay()
                .anchor(&anchor)
                .placement(nsh_core::overlay::Placement::Bottom)
                .offset(px(4.0))
                .w(px(160.0))
                .max_h(px(400.0))
                .on_layout(report(0))
                .child(
                    scroll()
                        .flex_shrink(1.0)
                        .min_h(px(0.0))
                        .on_layout(report(1))
                        .child(
                            virtual_list(4usize, |at| text(format!("row {}", at.index())))
                                .viewport(ListViewport::Parent)
                                .on_layout(report(2)),
                        ),
                )
                .child(text("Done")),
        )
}

#[test]
fn a_popup_s_virtualized_list_is_as_tall_as_its_rows() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<BarePopup>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "row 3");
    let rows = rows_of(
        &terminal,
        &["Pick", "row 0", "row 1", "row 2", "row 3", "Done"],
    );
    consecutive(&terminal, &rows);
}

/// A trigger `Pick` 20 Cells wide after a margin (two Cells: a margin is
/// spacing in a terminal, [`framed`] reports where it starts), on row 1 or
/// (`low`) the last row, and an anchored overlay with a fill of its own (no border or
/// padding: the terminal frames it outside its box) 10 Cells wide,
/// aligned with the trigger's `align` edge.
fn framed_popup(align: Align, low: bool) -> impl IntoElement {
    let anchor = element_ref();
    view()
        .flex_1()
        .child(text("above"))
        .child(view().when(low, |v| v.flex_1()))
        .child(
            view()
                .ml(px(80.0))
                .w(px(160.0))
                .element_ref(&anchor)
                .child(text("Pick")),
        )
        .child(
            overlay()
                .anchor(&anchor)
                .placement(Placement::Bottom)
                .align(align)
                .w(px(80.0))
                .bg(nsh_core::color::rgb(0x333333))
                .child(text("Item")),
        )
}

#[component]
fn FramedStart() -> impl IntoElement {
    framed_popup(Align::Start, false)
}

#[component]
fn FramedEnd() -> impl IntoElement {
    framed_popup(Align::End, false)
}

#[component]
fn FramedLow() -> impl IntoElement {
    framed_popup(Align::Start, true)
}

/// Draws `root` on a 40 × 16 terminal until `Item` shows: the trigger's
/// Cell, and the terminal.
fn framed(root: Root) -> ((u16, u16), Terminal<TestBackend>) {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 16)).unwrap();
    view.load(App::Rust(root)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Item");
    let trigger = find(&terminal, "Pick")
        .unwrap_or_else(|| panic!("the trigger's row shows\n{}", dump(&terminal)));
    (trigger, terminal)
}

#[test]
fn a_framed_popup_s_frame_goes_below_its_trigger_s_row_at_its_start() {
    let ((x, y), terminal) = framed(Root::new::<FramedStart>(|| ()));
    assert_eq!(x, 2, "the trigger after its margin\n{}", dump(&terminal));
    let corner = find(&terminal, "╭").unwrap_or_else(|| panic!("a frame\n{}", dump(&terminal)));
    assert_eq!(
        corner,
        (x, y + 1),
        "the frame's corner on the row after the trigger's, at its start\n{}",
        dump(&terminal)
    );
    let (_, item) = find(&terminal, "Item").unwrap();
    assert_eq!(
        item,
        y + 2,
        "the content inside the frame\n{}",
        dump(&terminal)
    );
}

#[test]
fn a_framed_popup_aligned_with_its_trigger_s_end_ends_its_frame_there() {
    let ((x, y), terminal) = framed(Root::new::<FramedEnd>(|| ()));
    let corner = find(&terminal, "╮").unwrap_or_else(|| panic!("a frame\n{}", dump(&terminal)));
    assert_eq!(
        corner,
        (x + 19, y + 1),
        "the frame's corner in the trigger's last column\n{}",
        dump(&terminal)
    );
}

#[test]
fn a_framed_popup_without_room_below_ends_its_frame_above_its_trigger_s_row() {
    let ((x, y), terminal) = framed(Root::new::<FramedLow>(|| ()));
    let corner = find(&terminal, "╰").unwrap_or_else(|| panic!("a frame\n{}", dump(&terminal)));
    assert_eq!(
        corner,
        (x, y - 1),
        "the frame's bottom on the row before the trigger's\n{}",
        dump(&terminal)
    );
}

/// A trigger `Pick` 20 Cells wide after a margin on row 3 and, beside it
/// at its right aligned with its start, an overlay with a fill of its own
/// (a submenu beside its item) of two rows, `Item` and `Next`.
#[component]
fn FramedBeside() -> impl IntoElement {
    let anchor = element_ref();
    view()
        .flex_1()
        .child(text("above"))
        .child(text("more"))
        .child(text("again"))
        .child(
            view()
                .ml(px(80.0))
                .w(px(160.0))
                .element_ref(&anchor)
                .child(text("Pick")),
        )
        .child(
            overlay()
                .anchor(&anchor)
                .placement(Placement::Right)
                .align(Align::Start)
                .w(px(64.0))
                .bg(nsh_core::color::rgb(0x333333))
                .child(text("Item"))
                .child(text("Next")),
        )
}

#[test]
fn a_framed_popup_beside_its_trigger_starts_its_rows_on_the_trigger_s_row() {
    let ((start, y), terminal) = framed(Root::new::<FramedBeside>(|| ()));
    let (x, item) = find(&terminal, "Item").unwrap();
    assert_eq!(
        item,
        y,
        "the first row on the trigger's row, the frame on the row above\n{}",
        dump(&terminal)
    );
    assert!(
        x > start + 20,
        "beside the trigger (its 20 columns)\n{}",
        dump(&terminal)
    );
    let corner = find(&terminal, "╭").unwrap_or_else(|| panic!("a frame\n{}", dump(&terminal)));
    assert_eq!(
        corner,
        (start + 20, y - 1),
        "the frame's corner after the trigger's last column, a row above it\n{}",
        dump(&terminal)
    );
}

/// A page with a row of `zzz` words across the screen, under a sheet at the right
/// with a panel 10 Cells wide: a fill, a line on its leading edge.
#[component]
fn RightSheet() -> impl IntoElement {
    view()
        .flex_1()
        .child(text("top"))
        // Words, as an overlay's box leaves out a word it cuts: one word
        // across the screen would go whole.
        .child(text("zzz ".repeat(10)))
        .child(
            sheet()
                .open(|| Some(true))
                .side(Placement::Right)
                .popup_style(|s| {
                    s.w(px(80.0))
                        .p(px(16.0))
                        .border_l_1()
                        .bg(nsh_core::color::rgb(0x333333))
                })
                .child(text("Panel")),
        )
}

#[test]
fn a_sheet_is_a_solid_panel_the_height_of_the_screen_over_a_cleared_page() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<RightSheet>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Panel");
    // It slides in from the edge: look once it is in place.
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    let (panel, _) = find(&terminal, "Panel").unwrap();
    let buffer = terminal.backend().buffer();
    // Its leading line: the column before its text where every row has
    // one.
    let edge = (0..panel)
        .rev()
        .find(|&x| (0..12).all(|y| buffer[(x, y)].symbol() == "│"))
        .unwrap_or_else(|| panic!("a line down the panel's edge\n{}", dump(&terminal)));
    assert!(edge >= 28, "the panel at the right\n{}", dump(&terminal));
    for y in 0..12 {
        for x in edge..40 {
            assert_ne!(
                buffer[(x, y)].symbol(),
                "z",
                "the page cleared under the panel at {x},{y}\n{}",
                dump(&terminal)
            );
        }
    }
    let (_, row) = find(&terminal, "zzz ")
        .unwrap_or_else(|| panic!("the page's row beside the panel\n{}", dump(&terminal)));
    assert!(
        (edge - 4..edge).any(|x| buffer[(x, row)].symbol() == "z"),
        "the page beside it\n{}",
        dump(&terminal)
    );
}

/// A toast in a stack at the bottom right of the screen, in an overlay
/// along the bottom edge, with a fill the desktops would show.
#[component]
fn BottomToast() -> impl IntoElement {
    view().flex_1().child(text("page")).child(
        overlay().left_0().right_0().bottom_0().items_end().child(
            toast_stack()
                .placement(Anchor::BottomRight)
                .w(px(160.0))
                .child(
                    toast()
                        .bg(nsh_core::color::rgb(0x333333))
                        .px(px(8.0))
                        .child(text("Saved")),
                ),
        ),
    )
}

#[test]
fn a_toast_shows_on_the_status_line_with_no_frame() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<BottomToast>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Saved");
    let (_, saved) = find(&terminal, "Saved").unwrap();
    assert_eq!(
        saved,
        11,
        "the toast on the bottom row\n{}",
        dump(&terminal)
    );
    assert!(
        find(&terminal, "╭").is_none() && find(&terminal, "┌").is_none(),
        "no frame around it\n{}",
        dump(&terminal)
    );
    assert!(
        find(&terminal, "page").is_some(),
        "the page above it\n{}",
        dump(&terminal)
    );
}
/// A bottom sheet as wide as the screen in an overlay of its own, as a
/// compact `DockArea` presents its bottom dock: a fill, rounded top
/// corners and a line along its top only.
#[component]
fn BottomSheet() -> impl IntoElement {
    view().flex_1().child(text("page")).child(
        overlay()
            .left_0()
            .right_0()
            .bottom_0()
            .rounded_t(px(16.0))
            .border_t_1()
            .bg(nsh_core::color::rgb(0x333333))
            .child(text("Sheet")),
    )
}

#[test]
fn a_sheet_as_wide_as_the_screen_stays_on_its_bottom_edge_with_no_line_under_it() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<BottomSheet>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Sheet");
    let (_, sheet) = find(&terminal, "Sheet").unwrap();
    let buffer = terminal.backend().buffer();
    let row = |y: u16| (0..40).map(|x| buffer[(x, y)].symbol()).collect::<String>();
    // Docked to the bottom edge: its last row is the screen's, and the
    // frame's bottom side is off the screen, so no line is drawn under it.
    assert_eq!(
        sheet,
        11,
        "the sheet on the screen's last row\n{}",
        dump(&terminal)
    );
    assert!(
        !row(11).contains('─'),
        "no line under the sheet\n{}",
        dump(&terminal)
    );
    assert!(
        !row(10).trim().is_empty() && row(10).trim().chars().all(|c| c == '─'),
        "a line along its top\n{}",
        dump(&terminal)
    );
}

/// Two toasts in a stack at the top of the screen, the newer last.
#[component]
fn TwoToasts() -> impl IntoElement {
    let item = |label: &'static str| toast().child(text(label));
    view().flex_1().child(text("page")).child(
        overlay().left_0().right_0().top_0().items_start().child(
            toast_stack()
                .placement(Anchor::TopLeft)
                .w(px(160.0))
                .child(item("Older"))
                .child(item("Newer")),
        ),
    )
}

#[test]
fn the_newer_toast_takes_the_status_line_and_nothing_expands() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 16)).unwrap();
    view.load(App::Rust(Root::new::<TwoToasts>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Newer");
    let (_, newer) = find(&terminal, "Newer").unwrap();
    assert_eq!(
        newer,
        15,
        "the newer on the bottom row\n{}",
        dump(&terminal)
    );
    assert!(
        find(&terminal, "Older").is_none(),
        "the older hidden\n{}",
        dump(&terminal)
    );
    // The pointer where a desktop's stack would be, and on the line.
    view.handle(mouse(MouseKind::Move, 4, 1));
    view.handle(mouse(MouseKind::Move, 4, 15));
    draw_until_still(&mut view, &mut terminal, &rx);
    assert!(
        find(&terminal, "Older").is_none() && find(&terminal, "Newer").is_some(),
        "still one toast, nothing spread\n{}",
        dump(&terminal)
    );
}

/// Two toasts the app keeps in a list, the newest closed on Escape (the
/// stack's `Cancel`).
#[component]
fn CancelledToasts() -> impl IntoElement {
    let shown = signal(vec!["Older", "Newer"]);
    view().flex_1().child(text("page")).child(
        toast_stack()
            .on_cancel(move || {
                shown.update(|v| {
                    v.pop();
                })
            })
            .child(each(
                shown,
                |label| *label,
                |label, _| toast().child(text(move || label.get())),
            )),
    )
}

#[test]
fn escape_closes_the_toast_on_the_line_and_the_one_before_takes_it() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 12)).unwrap();
    view.load(App::Rust(Root::new::<CancelledToasts>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Newer");
    view.handle(Input::Key {
        key: "Escape".into(),
        modifiers: Modifiers::default(),
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "Older");
    assert!(
        find(&terminal, "Newer").is_none(),
        "the newer closed\n{}",
        dump(&terminal)
    );
    view.handle(Input::Key {
        key: "Escape".into(),
        modifiers: Modifiers::default(),
        release: false,
    });
    draw_until_gone(&mut view, &mut terminal, &rx, "Older");
    assert!(
        find(&terminal, "Older").is_none() && find(&terminal, "page").is_some(),
        "no toast left, the line the page's again\n{}",
        dump(&terminal)
    );
}

/// An open searchable select of four tags, its search field `Search tags`.
#[component]
fn SearchSelect() -> impl IntoElement {
    view().flex_1().child(text("above")).child(
        select()
            .items(tags())
            .searchable(true)
            .search_placeholder("Search tags")
            .accessibility_label("Tags")
            .default_open(true)
            .w(px(200.0)),
    )
}

#[test]
fn a_searchable_select_s_search_field_has_a_rule_under_it() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<SearchSelect>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Swift");
    let (x, field) = find(&terminal, "Search tags")
        .unwrap_or_else(|| panic!("the search field\n{}", dump(&terminal)));
    assert_eq!(
        terminal.backend().buffer()[(x, field + 1)].symbol(),
        "─",
        "a rule under the field\n{}",
        dump(&terminal)
    );
    let (_, first) = find(&terminal, "Rust").unwrap();
    assert_eq!(
        first,
        field + 2,
        "the rows under the rule\n{}",
        dump(&terminal)
    );
}

/// An open select of four tags at its natural width, `Go` chosen: its
/// trigger `Go ▾` is narrower than the other titles.
#[component]
fn ChosenSelect() -> impl IntoElement {
    view().flex_1().child(text("above")).child(
        view().flex_row().child(
            select()
                .items(tags())
                .default_value(SharedString::from("go"))
                .accessibility_label("Tags")
                .default_open(true),
        ),
    )
}

#[test]
fn a_select_s_chosen_row_has_a_check_at_its_end_and_its_list_fits_the_widest_title() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<ChosenSelect>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Swift");
    // The trigger `Go ▾` first, then the list's rows.
    let (_, trigger) = find(&terminal, "Go").unwrap();
    let go = find_below(&terminal, "Go", trigger)
        .unwrap_or_else(|| panic!("the chosen row\n{}", dump(&terminal)));
    let swift = find(&terminal, "Swift").unwrap();
    assert!(
        swift.1 > go.1,
        "Swift on a row of its own\n{}",
        dump(&terminal)
    );
    let mark = marks_at_the_rows_end(&terminal, go, swift, "✓");
    assert_eq!(
        (mark, frame_after(&terminal, swift.0, swift.1)),
        (swift.0 + 6, swift.0 + 7),
        "the list as wide as its widest title, a blank Cell and the mark\n{}",
        dump(&terminal)
    );
}

#[test]
fn a_select_s_highlighted_row_is_an_accent_band() {
    // The option is focused only as a part of the list (the keys stay
    // with the select): the core mounts that for the terminal to mark. The
    // accent band is the look with surfaces (the terminal's background
    // known); bandless, the row is reversed.
    let (mut view, rx) = {
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
    };
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<ChosenSelect>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Swift");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        // The row's title, not the trigger's above it.
        let (x, y) = find(&terminal, "✓").unwrap();
        if terminal.backend().buffer()[(x, y)].bg == ratatui_core::style::Color::Blue {
            break;
        }
        assert!(
            rx.recv_deadline(deadline).is_ok(),
            "the chosen row, highlighted as the list opens, on the accent\n{}",
            dump(&terminal)
        );
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
    }
    let (x, y) = find(&terminal, "Swift").unwrap();
    assert_ne!(
        terminal.backend().buffer()[(x, y)].bg,
        ratatui_core::style::Color::Blue,
        "the other rows off it\n{}",
        dump(&terminal)
    );
}

/// A box in an overlay over rows of page text it cuts across, centered
/// (a margin is at most two Cells in a terminal: spacing, not a place).
#[component]
fn OverWords() -> impl IntoElement {
    let mut page = view().flex_1();
    for _ in 0..6 {
        page = page.child(text("alpha bravo charlie delta echo foxtrot"));
    }
    page.child(
        overlay().left_0().right_0().top_0().child(
            view().mt(px(32.0)).flex_row().justify_center().child(
                view()
                    .w(px(120.0))
                    .bg(nsh_core::color::rgb(0x333333))
                    .child(text("Box")),
            ),
        ),
    )
}

#[test]
fn an_overlay_s_box_leaves_out_the_words_it_cuts_at_its_sides() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<OverWords>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Box");
    let (_, y) = find(&terminal, "Box").unwrap();
    let buffer = terminal.backend().buffer();
    let line: String = (0..40).map(|x| buffer[(x, y)].symbol()).collect();
    let cells: Vec<&str> = (0..40).map(|x| buffer[(x, y)].symbol()).collect();
    let first = cells.iter().position(|c| *c == "│").expect(&line) as u16;
    let last = cells.iter().rposition(|c| *c == "│").expect(&line) as u16;
    assert!(first > 0 && last + 1 < 40, "{line}");
    for x in [first - 1, last + 1] {
        assert_eq!(
            buffer[(x, y)].symbol(),
            " ",
            "no half word on the frame: {line}"
        );
    }
    assert!(
        line.starts_with("alpha"),
        "whole words before it stay: {line}"
    );
}

/// A box in an overlay over rows of one long unbroken run (a URL), which
/// it cuts in the middle.
#[component]
fn OverUrl() -> impl IntoElement {
    let mut page = view().flex_1();
    for _ in 0..6 {
        page = page.child(text("https://example.com/abcdefghijklmnop/q"));
    }
    page.child(
        overlay().left_0().right_0().top_0().child(
            view().mt(px(32.0)).flex_row().justify_center().child(
                view()
                    .w(px(80.0))
                    .bg(nsh_core::color::rgb(0x333333))
                    .child(text("Box")),
            ),
        ),
    )
}

#[test]
fn an_overlay_s_box_keeps_the_shown_part_of_a_long_run_it_cuts_with_an_ellipsis() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<OverUrl>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Box");
    let (_, y) = find(&terminal, "Box").unwrap();
    let buffer = terminal.backend().buffer();
    let line: String = (0..40).map(|x| buffer[(x, y)].symbol()).collect();
    let cells: Vec<&str> = (0..40).map(|x| buffer[(x, y)].symbol()).collect();
    let first = cells.iter().position(|c| *c == "│").expect(&line) as u16;
    let last = cells.iter().rposition(|c| *c == "│").expect(&line) as u16;
    assert!(
        line.starts_with("https://exam"),
        "the part before the box stays: {line}"
    );
    assert_eq!(
        buffer[(first - 1, y)].symbol(),
        "…",
        "ending in an ellipsis by the frame: {line}"
    );
    assert_eq!(
        buffer[(last + 1, y)].symbol(),
        "…",
        "and starting in one after it: {line}"
    );
    assert_ne!(
        buffer[(last + 2, y)].symbol(),
        " ",
        "the part after the box stays: {line}"
    );
}

/// A box in an overlay over rows of a rule drawn in text (a split's `─`).
#[component]
fn OverRule() -> impl IntoElement {
    let mut page = view().flex_1();
    for _ in 0..6 {
        page = page.child(text("────────────────────────────────────────"));
    }
    page.child(
        overlay().left_0().right_0().top_0().child(
            view().mt(px(32.0)).flex_row().justify_center().child(
                view()
                    .w(px(80.0))
                    .bg(nsh_core::color::rgb(0x333333))
                    .child(text("Box")),
            ),
        ),
    )
}

#[test]
fn an_overlay_s_box_covers_a_rule_it_meets_without_an_ellipsis() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<OverRule>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Box");
    let (_, y) = find(&terminal, "Box").unwrap();
    let buffer = terminal.backend().buffer();
    let line: String = (0..40).map(|x| buffer[(x, y)].symbol()).collect();
    assert!(!line.contains('…'), "a line is no word to cut: {line}");
    assert!(
        line.starts_with("────") && line.ends_with("────"),
        "the rule stays up to the box on both sides: {line}"
    );
}

/// A page with a badge the overlay's box covers but for its end (a count
/// beside a section's title under an open list).
#[component]
fn OverBadge() -> impl IntoElement {
    view()
        .flex_1()
        .child(
            view()
                .absolute()
                .left(px(176.0))
                .top(px(32.0))
                .px(px(8.0))
                .bg(nsh_core::color::rgb(0x3f3f46))
                .child(text("2 of 4")),
        )
        .child(
            overlay().left_0().right_0().top_0().child(
                view().mt(px(32.0)).flex_row().justify_center().child(
                    view()
                        .w(px(80.0))
                        .bg(nsh_core::color::rgb(0x333333))
                        .child(text("Box")),
                ),
            ),
        )
}

#[test]
fn an_overlay_s_box_leaves_out_a_badge_it_cuts_with_its_fill() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<OverBadge>(|| ()))).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Box");
    let (_, y) = find(&terminal, "Box").unwrap();
    let buffer = terminal.backend().buffer();
    let line: String = (0..40).map(|x| buffer[(x, y)].symbol()).collect();
    let right = line.rfind('│').map(|at| line[..at].chars().count() as u16);
    let right = right.unwrap_or_else(|| panic!("framed: {line}"));
    // Past the frame: none of the badge, neither its words nor its fill.
    for x in right + 1..40 {
        let cell = &buffer[(x, y)];
        assert_eq!(
            (cell.symbol(), cell.bg),
            (" ", ratatui_core::style::Color::Reset),
            "({x}, {y}) of the cut badge: {line}"
        );
    }
}

/// An overlay whose box holds a filled chip before a name (a tooltip's
/// avatar and reviewer).
#[component]
fn ChipInOverlay() -> impl IntoElement {
    view().flex_1().child(text("page")).child(
        overlay().left_0().right_0().top_0().child(
            view().mt(px(32.0)).flex_row().justify_center().child(
                view()
                    .bg(nsh_core::color::rgb(0x333333))
                    .flex_row()
                    .child(view().bg(nsh_core::color::rgb(0x555555)).child(text("MC")))
                    .child(text(" Mira Chen")),
            ),
        ),
    )
}

#[test]
fn a_surface_inside_an_overlay_cuts_no_word_of_the_overlay_s_own() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 8)).unwrap();
    view.load(App::Rust(Root::new::<ChipInOverlay>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Chen");
    let (_, y) = find(&terminal, "Chen").unwrap();
    let buffer = terminal.backend().buffer();
    let line: String = (0..40).map(|x| buffer[(x, y)].symbol()).collect();
    assert!(
        line.contains("MC Mira Chen"),
        "the name stays whole: {line}"
    );
}

/// A select, a combobox and a button after them, each reporting the
/// keyboard focus, and the lists' last open changes.
#[component]
fn FieldsThenNext() -> impl IntoElement {
    let focused = signal("none");
    let changed = signal(String::from("-"));
    view()
        .flex_1()
        .child(text(move || {
            format!("focused {} {}", focused.get(), changed.get())
        }))
        .child(
            view().flex_row().child(
                select()
                    .items(tags())
                    .placeholder("Lang")
                    .accessibility_label("Lang")
                    .on_open_change(move |e: &nsh_base::SelectEvent| {
                        if let nsh_base::SelectEvent::OpenChange(open, reason) = e {
                            changed.set(format!("select {open} {reason:?}"));
                        }
                    }),
            ),
        )
        .child(
            combobox()
                .items(tags())
                .placeholder("Pick")
                .accessibility_label("Tags")
                .on_open_change(move |e: &nsh_base::ComboboxEvent| {
                    if let nsh_base::ComboboxEvent::OpenChange(open, reason) = e {
                        changed.set(format!("combobox {open} {reason:?}"));
                    }
                })
                .w(px(160.0)),
        )
        .child(
            view()
                .on_focus(move |_: &()| focused.set("Next"))
                .on_press(|_: &()| {})
                .child(text("Next")),
        )
}

fn press_key(view: &mut nsh_platform_tui::AppView, name: &str, shift: bool) {
    view.handle(nsh_platform_tui::Input::Key {
        key: name.into(),
        modifiers: nsh_platform_tui::Modifiers {
            shift,
            ..Default::default()
        },
        release: false,
    });
}

#[test]
fn tab_out_of_an_open_select_or_combobox_closes_its_list() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 16)).unwrap();
    view.load(App::Rust(Root::new::<FieldsThenNext>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "focused none -");

    // The select: focused, opened with Down, then Tab goes on to the
    // combobox and the list closes for the focus.
    press_key(&mut view, "tab", false);
    press_key(&mut view, "down", false);
    draw_until(&mut view, &mut terminal, &rx, "Swift");
    press_key(&mut view, "tab", false);
    draw_until(&mut view, &mut terminal, &rx, "select false Focus");
    draw_until_gone(&mut view, &mut terminal, &rx, "Swift");

    // The combobox, now focused: opened with Down, then Tab goes on to
    // the button, and the focus stays there.
    press_key(&mut view, "down", false);
    draw_until(&mut view, &mut terminal, &rx, "Swift");
    press_key(&mut view, "tab", false);
    draw_until(
        &mut view,
        &mut terminal,
        &rx,
        "focused Next combobox false Focus",
    );
    draw_until_gone(&mut view, &mut terminal, &rx, "Swift");
    super::app::draw_until_still(&mut view, &mut terminal, &rx);
    assert!(
        dump(&terminal).contains("focused Next"),
        "the focus stays where Tab took it\n{}",
        dump(&terminal)
    );
}

/// An open menu whose panel is the app's line (a terminal popup's look), a
/// separator between its two items filled in the app's line color, as
/// the gallery's.
#[component]
fn SeparatedMenu() -> impl IntoElement {
    let line = nsh_base::theme().border;
    view().flex_1().child(text("above")).child(
        menu()
            .default_open(true)
            .trigger(view().child(text("View")))
            .child(
                view()
                    .border(px(1.0))
                    .border_color(line)
                    .p(px(4.0))
                    .child(
                        menu_item()
                            .accessibility_label("About")
                            .child(text("About")),
                    )
                    .child(nsh_base::menu_separator().h(px(1.0)).bg(line))
                    .child(menu_item().accessibility_label("Quit").child(text("Quit"))),
            ),
    )
}

/// A dark terminal whose own colors are known: its fills are steps of
/// them.
fn known_colors() -> (nsh_platform_tui::AppView, crossbeam_channel::Receiver<()>) {
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

#[test]
fn a_menu_s_separator_is_a_line_of_the_menu_s_frame_joined_with_it_on_no_band() {
    let (mut view, rx) = known_colors();
    let mut terminal = Terminal::new(TestBackend::new(40, 20)).unwrap();
    view.load(App::Rust(Root::new::<SeparatedMenu>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Quit");
    let rows = rows_of(&terminal, &["About", "Quit"]);
    let buffer = terminal.backend().buffer();
    // The menu's frame: its left and right columns, on About's row.
    let (left, right) = {
        let lines: Vec<u16> = (0..buffer.area.width)
            .filter(|&x| buffer[(x, rows[0])].symbol() == "│")
            .collect();
        assert!(lines.len() >= 2, "the menu is framed\n{}", dump(&terminal));
        (lines[0], lines[lines.len() - 1])
    };
    let separator = (rows[0] + 1..rows[1])
        .find(|&y| buffer[(left + 1, y)].symbol() == "─")
        .unwrap_or_else(|| panic!("a row of ─ between the items\n{}", dump(&terminal)));
    let row: String = (left..=right)
        .map(|x| buffer[(x, separator)].symbol())
        .collect();
    let inner = "─".repeat(usize::from(right - left - 1));
    assert_eq!(
        row,
        format!("├{inner}┤"),
        "the separator runs across the menu and joins its frame\n{}",
        dump(&terminal)
    );
    // In the frame's color, on the menu's own ground: the line is no
    // band.
    let frame = buffer[(left, rows[0])].fg;
    let ground = buffer[(left, rows[0])].bg;
    for x in left + 1..right {
        let cell = &buffer[(x, separator)];
        assert_eq!(cell.fg, frame, "({x}, {separator})\n{}", dump(&terminal));
        assert_eq!(cell.bg, ground, "({x}, {separator})\n{}", dump(&terminal));
    }
}

/// A page of text on a raised panel, and a dialog Ctrl+O opens: the app's
/// backdrop (a translucent black across the screen, as the gallery's
/// `bg-black/50`) and a framed card in the middle.
#[component]
fn ScrimDialog() -> impl IntoElement {
    let open = signal(false);
    on_key("ctrl+o", move |_| open.set(true));
    view()
        .flex_1()
        .bg(nsh_core::color::rgb(0x27272a))
        .child(text(move || format!("open {}", open.get())))
        .children((0..8).map(|n| text(format!("line {n} of the page behind"))))
        .child(when(open, move || {
            nsh_base::dialog()
                .child(
                    view()
                        .absolute()
                        .top(px(0.0))
                        .left(px(0.0))
                        .right(px(0.0))
                        .bottom(px(0.0))
                        .bg(nsh_core::color::rgba(0x00000080)),
                )
                .child(
                    view()
                        .absolute()
                        .top(px(96.0))
                        .left(px(96.0))
                        .w(px(160.0))
                        .border(px(1.0))
                        .border_color(nsh_base::theme().border)
                        .bg(nsh_core::color::rgb(0x18181b))
                        .child(text("Card")),
                )
        }))
}

#[test]
fn a_modal_leaves_the_page_around_it_as_it_was() {
    let (mut view, rx) = known_colors();
    let mut terminal = Terminal::new(TestBackend::new(48, 16)).unwrap();
    view.load(App::Rust(Root::new::<ScrimDialog>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "line 7");
    draw_until_still(&mut view, &mut terminal, &rx);
    let before = terminal.backend().buffer().clone();
    view.handle(nsh_platform_tui::Input::Key {
        key: "o".into(),
        modifiers: nsh_platform_tui::Modifiers {
            ctrl: true,
            ..Default::default()
        },
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "Card");
    draw_until_still(&mut view, &mut terminal, &rx);
    let after = terminal.backend().buffer();
    let (x, y) = find(&terminal, "Card").unwrap();
    // The card: the box its frame draws around its text, found from the
    // corner up and to the left of it. Everything else is the page,
    // untouched: no scrim, no fade, no band.
    let symbol = |column: u16, row: u16| after[(column, row)].symbol();
    let (left, top) = (0..y)
        .rev()
        .find_map(|row| {
            (0..=x)
                .rev()
                .find(|&c| symbol(c, row) == "╭")
                .map(|c| (c, row))
        })
        .unwrap_or_else(|| panic!("the card is framed\n{}", dump(&terminal)));
    let right = (left..after.area.width)
        .find(|&c| symbol(c, top) == "╮")
        .unwrap();
    let bottom = (top..after.area.height)
        .find(|&r| symbol(left, r) == "╰")
        .unwrap();
    let card_x = left..=right;
    let card_y = top..=bottom;
    for row in 0..after.area.height {
        for column in 0..after.area.width {
            if row == 0 || (card_x.contains(&column) && card_y.contains(&row)) {
                continue;
            }
            let (old, new) = (&before[(column, row)], &after[(column, row)]);
            assert_eq!(
                (old.symbol(), old.fg, old.bg, old.modifier),
                (new.symbol(), new.fg, new.bg, new.modifier),
                "({column}, {row}) is as it was\n{}",
                dump(&terminal)
            );
        }
    }
}

/// A page of text and a sheet at its right edge Ctrl+O opens, over the
/// app's backdrop (the gallery's `rgba(0,0,0,0.45)`), which covers only
/// what the panel leaves.
#[component]
fn ScrimSheet() -> impl IntoElement {
    let open = signal(false);
    on_key("ctrl+o", move |_| open.set(true));
    view()
        .flex_1()
        .child(text(move || format!("open {}", open.get())))
        .children((0..8).map(|n| text(format!("line {n} of the page behind"))))
        .child(
            nsh_base::sheet()
                .open(move || Some(open.get()))
                .side(nsh_core::overlay::Placement::Right)
                .on_open_change(move |_: &nsh_base::SheetEvent| open.set(false))
                .backdrop_style(|s| s.bg(nsh_core::color::rgba(0x00000073)))
                .popup_style(|s| {
                    s.w(px(120.0))
                        .border_l(px(1.0))
                        .border_color(nsh_base::theme().border)
                        .bg(nsh_core::color::rgb(0x222222))
                })
                .child(text("Panel")),
        )
}

#[test]
fn a_sheet_leaves_the_page_beside_it_as_it_was_under_the_pointer_too() {
    let (mut view, rx) = known_colors();
    let mut terminal = Terminal::new(TestBackend::new(48, 12)).unwrap();
    view.load(App::Rust(Root::new::<ScrimSheet>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "line 7");
    draw_until_still(&mut view, &mut terminal, &rx);
    let before = terminal.backend().buffer().clone();
    view.handle(nsh_platform_tui::Input::Key {
        key: "o".into(),
        modifiers: nsh_platform_tui::Modifiers {
            ctrl: true,
            ..Default::default()
        },
        release: false,
    });
    draw_until(&mut view, &mut terminal, &rx, "Panel");
    // The pointer over the backdrop: it takes presses, but shows no hover.
    view.handle(mouse(MouseKind::Move, 2, 4));
    draw_until_still(&mut view, &mut terminal, &rx);
    let after = terminal.backend().buffer();
    let (panel, _) = find(&terminal, "Panel").unwrap();
    // Left of the panel's line, everything is the page as it was: no
    // scrim, no band, no recolored text.
    let edge = panel.saturating_sub(2);
    for row in 1..after.area.height {
        for column in 0..edge {
            let (old, new) = (&before[(column, row)], &after[(column, row)]);
            assert_eq!(
                (old.symbol(), old.fg, old.bg, old.modifier),
                (new.symbol(), new.fg, new.bg, new.modifier),
                "({column}, {row}) is as it was\n{}",
                dump(&terminal)
            );
        }
    }
}

/// A dialog's palette, as the gallery's command palette: a framed card
/// whose search row has a rule of `─` under it, over a list of 20 commands that
/// scrolls, inside the card's padding and a box of its own.
#[component]
fn ScrollingPalette() -> impl IntoElement {
    let line = nsh_base::theme().border;
    view().flex_1().child(text("page")).child(
        nsh_base::dialog().child(
            view()
                .mx(auto())
                .mt(px(16.0))
                .w(px(240.0))
                .border(px(1.0))
                .border_color(line)
                .child(view().child(text("Search")))
                // A terminal's rule under the field, as `nsh-base`'s
                // command draws it: a box of text has no border Cell.
                .child(
                    view().child(text(" ")).child(
                        text("─".repeat(80))
                            .absolute()
                            .top(px(0.0))
                            .left(px(0.0))
                            .right(px(0.0))
                            .number_of_lines(1u32)
                            .text_overflow(nsh_core::EllipsizeMode::Clip)
                            .text_color(line),
                    ),
                )
                .child(
                    view()
                        .pr(px(8.0))
                        .child(scroll().h(px(96.0)).children((0..20).map(|n| {
                            view()
                                .h(px(16.0))
                                .flex_shrink_0()
                                .child(text(format!("Command {n}")))
                        }))),
                ),
        ),
    )
}

#[test]
fn a_modal_s_list_draws_its_bar_on_the_frame_and_its_rule_joins_the_frame() {
    let (mut view, rx) = known_colors();
    let mut terminal = Terminal::new(TestBackend::new(50, 16)).unwrap();
    view.load(App::Rust(Root::new::<ScrollingPalette>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "Command 0");
    draw_until_still(&mut view, &mut terminal, &rx);
    let buffer = terminal.backend().buffer();
    let (_, search) = find(&terminal, "Search").unwrap();
    let (_, first) = find(&terminal, "Command 0").unwrap();
    // The frame's sides, on the search row.
    let sides: Vec<u16> = (0..buffer.area.width)
        .filter(|&x| buffer[(x, search)].symbol() == "│")
        .collect();
    assert_eq!(sides.len(), 2, "the card is framed\n{}", dump(&terminal));
    let (left, right) = (sides[0], sides[1]);
    // The rule under the search row reaches the frame and joins it.
    let rule = (search + 1..first)
        .find(|&y| buffer[(left + 1, y)].symbol() == "─")
        .unwrap_or_else(|| panic!("a rule under the search row\n{}", dump(&terminal)));
    assert_eq!(
        (
            buffer[(left, rule)].symbol(),
            buffer[(right, rule)].symbol()
        ),
        ("├", "┤"),
        "the rule joins the frame\n{}",
        dump(&terminal)
    );
    // The list's bar is on the frame's right line, its thumb over it at
    // the top, and takes no column inside the frame.
    assert_eq!(
        buffer[(right, first)].symbol(),
        "┃",
        "the thumb is on the line\n{}",
        dump(&terminal)
    );
    for y in first..first + 6 {
        assert_ne!(
            buffer[(right - 1, y)].symbol(),
            "┃",
            "no bar inside the frame ({y})\n{}",
            dump(&terminal)
        );
        assert_ne!(buffer[(right - 2, y)].symbol(), "┃");
    }
}

/// A box overlay: an outline of the accent, rows 2 to 5, columns 0 to 19,
/// laid out where the drop indicator of a dock area is (a translucent
/// fill, pointer events none).
fn outline_overlay() -> Overlay {
    overlay()
        .pointer_events(PointerEvents::None)
        .focusable(false)
        .left(px(0.0))
        .top(px(32.0))
        .w(px(160.0))
        .h(px(64.0))
        .border(px(1.0))
        .border_color(nsh_base::terminal::ACCENT)
        .bg(nsh_base::terminal::ACCENT.alpha(0.12))
        .rounded(px(4.0))
}

/// A label overlay on the outline's top row (row 2, from column 4), as a
/// dock area's drag preview is: at the origin, moved by a translation.
fn label_overlay() -> impl IntoElement {
    overlay()
        .pointer_events(PointerEvents::None)
        .focusable(false)
        .left(px(0.0))
        .top(px(0.0))
        .translate_x(px(32.0))
        .translate_y(px(32.0))
        .child(text("LABEL"))
}

/// `open`, pressed, shows the second overlay; `first` is there from the
/// start.
fn opened_in_turn(first: AnyElement, later: fn() -> AnyElement) -> impl IntoElement {
    let second = signal(false);
    view()
        .flex_1()
        .child(
            view()
                .on_press(move || second.set(true))
                .child(text("open")),
        )
        .child(first)
        .child(when(move || second.get(), later))
}

/// The outline, then the label.
#[component]
fn OutlineThenLabel() -> impl IntoElement {
    opened_in_turn(outline_overlay().into_element(), || {
        label_overlay().into_element()
    })
}

/// The label, then the outline.
#[component]
fn LabelThenOutline() -> impl IntoElement {
    opened_in_turn(label_overlay().into_element(), || {
        outline_overlay().into_element()
    })
}

fn paint_two(label_first: bool) -> (Terminal<TestBackend>, String) {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    let root = match label_first {
        true => Root::new::<LabelThenOutline>(|| ()),
        false => Root::new::<OutlineThenLabel>(|| ()),
    };
    view.load(App::Rust(root)).unwrap();
    draw_until(&mut view, &mut terminal, &rx, "open");
    view.handle(mouse(
        MouseKind::Down(nsh_platform_tui::MouseButton::Left),
        1,
        0,
    ));
    view.handle(mouse(
        MouseKind::Up(nsh_platform_tui::MouseButton::Left),
        1,
        0,
    ));
    // Both shown: the outline's corner and the label's text, or the
    // outline's top row where the label would be.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
        let shown = find(&terminal, "╭").is_some()
            && (label_first
                || find(&terminal, "LABEL").is_some()
                || std::time::Instant::now() > deadline);
        if shown {
            break;
        }
        let _ = rx.recv_deadline(deadline);
        if std::time::Instant::now() > deadline {
            break;
        }
    }
    // A few more frames: what opens in a later commit is in.
    for _ in 0..5 {
        let _ = rx.recv_timeout(std::time::Duration::from_millis(50));
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
    }
    let row: String = (0..40)
        .map(|x| terminal.backend().buffer()[(x, 2)].symbol())
        .collect();
    (terminal, row)
}

/// Overlays opened one after the other: the one opened later is painted
/// above the other where they meet (its text over the outline's line).
#[test]
fn an_overlay_opened_later_is_painted_above_one_opened_before() {
    let (terminal, row) = paint_two(false);
    assert!(
        row.contains("LABEL"),
        "the label opened after the outline is under it: {row:?}\n{}",
        dump(&terminal)
    );
}

/// The other way around: the outline opened after the label covers it.
#[test]
fn an_outline_opened_after_a_label_covers_it() {
    let (terminal, row) = paint_two(true);
    assert!(
        !row.contains("LABEL"),
        "the outline opened after the label is under it: {row:?}\n{}",
        dump(&terminal)
    );
}

/// As a dock area's drag: the label is shown first, the outline opens
/// later, and once the outline is laid out the label is mounted again (a
/// row keyed by the outline's openings: a new node, opened after it).
#[component]
fn LabelRemountedOverOutline() -> impl IntoElement {
    let outlined = signal(false);
    let laid_out = signal(0u32);
    view()
        .flex_1()
        .child(
            view()
                .on_press(move || outlined.set(true))
                .child(text("open")),
        )
        .child(each(
            move || vec![laid_out.get()],
            |&opened: &u32| opened,
            |_, _| label_overlay(),
        ))
        .child(when(
            move || outlined.get(),
            move || {
                let opened = std::cell::Cell::new(false);
                outline_overlay().on_layout(move |_: &Bounds<Points>| {
                    if !opened.replace(true) {
                        laid_out.update(|n| *n += 1);
                    }
                })
            },
        ))
}

/// An overlay mounted again after another opened (a new node for it) is
/// painted above that one, though it first opened before it.
#[test]
fn a_remounted_overlay_paints_above() {
    let (mut view, rx) = surface();
    let mut terminal = Terminal::new(TestBackend::new(40, 10)).unwrap();
    view.load(App::Rust(Root::new::<LabelRemountedOverOutline>(|| ())))
        .unwrap();
    draw_until(&mut view, &mut terminal, &rx, "LABEL");
    view.handle(mouse(
        MouseKind::Down(nsh_platform_tui::MouseButton::Left),
        1,
        0,
    ));
    view.handle(mouse(
        MouseKind::Up(nsh_platform_tui::MouseButton::Left),
        1,
        0,
    ));
    draw_until(&mut view, &mut terminal, &rx, "╭");
    for _ in 0..10 {
        let _ = rx.recv_timeout(std::time::Duration::from_millis(50));
        terminal
            .draw(|frame| view.render(frame, frame.area()))
            .unwrap();
    }
    let row: String = (0..40)
        .map(|x| terminal.backend().buffer()[(x, 2)].symbol())
        .collect();
    assert!(
        row.contains("LABEL"),
        "the label mounted again is under the outline: {row:?}\n{}",
        dump(&terminal)
    );
}

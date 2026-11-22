//! The terminal-native forms of `nsh/base`'s controls.
//!
//! In the Terminal idiom ([`Idiom::Terminal`]) a control shows the
//! terminal's own form of itself, as system UI keeps the platform's look
//! elsewhere: text the terminal draws in its own palette, laid out at its
//! natural size on the Cell grid (one row), so the painter draws it as it
//! draws any text and never guesses a control from GUI geometry. The app's
//! indicator parts (a checkbox's box and mark, a switch's track and thumb,
//! a slider's or a progress bar's parts) are not mounted there; the app's
//! `class` and `style` on the control and its children (a label) stay. The
//! state the terminal shows natively (the focused control, the selected
//! row, the hovered item, a disabled control) is the painter's, drawn from
//! the roles and states these components report.
//!
//! The glyphs live here, in one place, so the components, the terminal
//! painter and the documentation (`docs/dev/components.md` "In a
//! terminal") agree on them.

use nsh_core::{EllipsizeMode, platform::Idiom, prelude::*};

/// Whether the components show their terminal-native forms: the app runs
/// in a terminal ([`Idiom::Terminal`]).
pub fn is_terminal() -> bool {
    idiom() == Idiom::Terminal
}

/// The height of one Cell, as the terminal's text engine measures one
/// glyph: a row of text in a terminal (a code view's line).
pub(crate) fn cell_height() -> Points {
    text_metrics("", "0").height
}

/// The width of one Cell: the grid's the core lays out on, else as the
/// terminal's text engine measures one glyph.
pub(crate) fn cell_width() -> Points {
    nsh_core::element::cell_size().map_or_else(|| text_metrics("", "0").width, |c| c.width)
}

/// The height of a code view's row (an editor's, a diff's): the app's
/// `line_height`, or one Cell in a terminal, where a row is one line of
/// the grid (a height of another step would land rows on Cells unevenly,
/// leaving blank rows between).
pub(crate) fn row_height(line_height: Points) -> Points {
    match is_terminal() {
        true => cell_height(),
        false => line_height,
    }
}

/// How many whole Cells `width` holds, Cells `cell` wide.
pub(crate) fn columns_in(width: Points, cell: Points) -> usize {
    match cell.0 > 0.0 {
        // A hair over, as frames on the grid are whole Cells to rounding.
        true => (width.0 / cell.0 + 0.01).floor().max(0.0) as usize,
        false => 0,
    }
}

/// A row of glyphs as wide as the view the app gives it: `content` gets
/// how many Cells that is and returns the row (tracked: the row follows
/// what it reads). The row is one line, clipped at the view's width; the
/// view's own size is one Cell, stretched by its parent (a slider's or a
/// progress bar's width is the app's).
pub(crate) fn line(content: impl Fn(usize) -> String + 'static) -> View {
    line_colored(content, None)
}

/// A [`rule`] across the view's width in the theme's border color: the
/// line a terminal draws between two parts a GUI sets apart with a border
/// (a command's search field and its rows).
pub(crate) fn rule_line() -> View {
    line_colored(rule, Some(|| crate::theme::theme().border))
}

/// A column of [`QUOTE_BAR`]s as tall as the view its parent stretches it
/// to (a row's height): one glyph a row, in the [`ACCENT`].
/// By itself it is one Cell, so it never makes its row taller.
pub(crate) fn quote_bar() -> View {
    let cell = cell_height();
    let rows = signal(0usize);
    view()
        .flex_none()
        .overflow_hidden()
        .on_layout(move |frame: &Bounds<Points>| {
            let n = columns_in(frame.size.height, cell);
            if rows.get_untracked() != n {
                rows.set(n);
            }
        })
        .child(text(" "))
        .child(
            text(move || {
                SharedString::from(vec![QUOTE_BAR.to_string(); rows.get().max(1)].join("\n"))
            })
            .absolute()
            .top(px(0.0))
            .left(px(0.0))
            .bottom(px(0.0))
            .text_overflow(EllipsizeMode::Clip)
            .pointer_events(PointerEvents::None)
            .text_color(ACCENT),
        )
}

/// `content` after a [`quote_bar`] down its left side and a Cell's gap: a
/// quote's terminal form.
pub(crate) fn quoted(content: impl IntoElement) -> View {
    view().flex_row().gap(px(1.0)).child(quote_bar()).child(
        view()
            .flex_grow(1.0)
            .flex_shrink(1.0)
            .min_w(px(0.0))
            .child(content),
    )
}

/// A [`line`], its glyphs in `color` when one is given.
fn line_colored(
    content: impl Fn(usize) -> String + 'static,
    color: Option<fn() -> AdaptiveColor>,
) -> View {
    let cell = cell_width();
    let columns = signal(0usize);
    view()
        .on_layout(move |frame: &Bounds<Points>| {
            let n = columns_in(frame.size.width, cell);
            if columns.get_untracked() != n {
                columns.set(n);
            }
        })
        // One row tall, one Cell wide by itself.
        .child(text(" "))
        .child(
            text(move || SharedString::from(content(columns.get())))
                .absolute()
                .top(px(0.0))
                .left(px(0.0))
                .right(px(0.0))
                .number_of_lines(1u32)
                .text_overflow(EllipsizeMode::Clip)
                .pointer_events(PointerEvents::None)
                .when_some(color, |t, color| t.text_color(color)),
        )
}

/// A [`line`] whose filled glyphs are drawn in `color`: `content`'s row
/// is split around its run of glyphs other than [`PROGRESS_EMPTY`] (a
/// progress bar's filled part, an indeterminate bar's segment), which takes
/// `color`; the empty track around it is in the theme's line color.
pub(crate) fn filled_line(
    content: impl Fn(usize) -> String + 'static,
    color: impl Fn() -> AdaptiveColor + 'static,
) -> View {
    let cell = cell_width();
    let columns = signal(0usize);
    let parts = computed(move || split_filled(&content(columns.get())));
    let part = |at: usize| {
        text(move || SharedString::from(parts.with(|p| p[at].clone())))
            .number_of_lines(1u32)
            .text_overflow(EllipsizeMode::Clip)
    };
    view()
        .on_layout(move |frame: &Bounds<Points>| {
            let n = columns_in(frame.size.width, cell);
            if columns.get_untracked() != n {
                columns.set(n);
            }
        })
        .child(text(" "))
        .child(
            view()
                .absolute()
                .top(px(0.0))
                .left(px(0.0))
                .right(px(0.0))
                .flex_row()
                .overflow_hidden()
                .pointer_events(PointerEvents::None)
                .child(part(0).text_color(|| crate::theme::theme().border))
                .child(part(1).text_color(color))
                .child(part(2).text_color(|| crate::theme::theme().border)),
        )
}

/// A bar split into its leading empty track, its filled run and the rest.
pub(crate) fn split_filled(bar: &str) -> [String; 3] {
    split_run(bar, PROGRESS_EMPTY)
}

/// A row split into its leading `empty` glyphs, the run of other glyphs
/// after them and the rest.
pub(crate) fn split_run(bar: &str, empty: char) -> [String; 3] {
    let start = bar.find(|c| c != empty).unwrap_or(bar.len());
    let end = bar[start..].find(empty).map_or(bar.len(), |e| start + e);
    [
        bar[..start].into(),
        bar[start..end].into(),
        bar[end..].into(),
    ]
}

/// The terminal controls' accent: a saturated blue, which the terminal
/// draws as its own palette's blue. A checked checkbox's or radio's mark, an
/// on switch's track, a slider's filled part and a progress bar's filled
/// Cells are drawn in it.
pub const ACCENT: Hsla = hsla(217.0 / 360.0, 0.91, 0.6, 1.0);

/// How a part of a control's mark is drawn. Every state also reads by
/// shape alone (`[✓]` / `[ ]`, a knob's side), for a terminal without
/// colors.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Tone {
    /// The text's color.
    Text,
    /// The text's color, bold: an on switch's knob.
    Strong,
    /// The theme's muted foreground: what is off.
    Muted,
    /// [`ACCENT`]: what is on.
    Accent,
}

/// A control's mark: its glyphs in three parts, each in its tone (a part
/// may be empty).
pub type Mark = [(&'static str, Tone); 3];

/// A mark's glyphs, its parts joined.
pub fn mark_text(mark: &Mark) -> String {
    mark.iter().map(|(glyphs, _)| *glyphs).collect()
}

/// The color of `tone`.
pub(crate) fn tone_color(tone: Tone) -> AdaptiveColor {
    match tone {
        Tone::Text | Tone::Strong => crate::theme::theme().foreground,
        Tone::Muted => crate::theme::theme().muted_foreground,
        Tone::Accent => ACCENT.into(),
    }
}

/// The marks at the right end of a trigger's band in a terminal (a
/// select's, a combobox's, a date picker's): `clear` (the `×`'s slot while
/// there is a value to clear, or nothing) and the [`SELECT_ARROW`]'s slot
/// ([`mark_slot`]), side by side over the band's last Cells: the arrow on
/// the one before the last, the band's last Cell blank as its first is,
/// the `×` three Cells before it. The app's trigger leaves those Cells
/// free (three, six with the clear: [`trigger_marks_width`]), as it leaves
/// room for its own chevron elsewhere; the band and its padding stay the
/// app's. The marks are muted, in the accent while `lit` (the trigger
/// focused or its list open) or under the pointer; a disabled trigger dims
/// them with the rest of its band. A press anywhere on the arrow's slot is
/// `press` (it opens or closes the list, as the trigger does), which also
/// keeps the marks a control the terminal's layout places over the band's
/// text.
pub(crate) fn trigger_marks(
    clear: impl IntoElement,
    lit: impl Fn() -> bool + Copy + 'static,
    press: impl Fn() + 'static,
) -> View {
    view()
        .absolute()
        .top(px(0.0))
        .bottom(px(0.0))
        .right(px(0.0))
        .flex_row()
        .items_center()
        .child(clear)
        .child(mark_slot(
            view()
                .role(AccessibilityRole::Button)
                .accessibility_elements_hidden(true)
                .on_press(press),
            SELECT_ARROW.trim_start(),
            lit,
        ))
}

/// How many Cells wide a terminal's [`mark_slot`] is: the mark and a blank
/// Cell either side.
pub const MARK_SLOT: usize = 3;

/// The group a [`mark_slot`]'s mark follows the pointer of.
const MARK_GROUP: &str = "nsh-mark-slot";

/// A pressable mark of a terminal (a trigger's `▾`, a clear button's
/// `×`): `button`, the press target, made a slot [`MARK_SLOT`] Cells wide
/// and one row high with `glyph` in its middle, so a press on any of its
/// Cells is a press on the mark, and two slots side by side keep a blank
/// Cell either side of each mark. The mark is muted, in the accent while
/// `lit`, while the pointer is over the slot and while it is pressed; the
/// slot itself has no band. It is never a stop of Tab.
pub(crate) fn mark_slot(
    button: View,
    glyph: &'static str,
    lit: impl Fn() -> bool + 'static,
) -> View {
    button
        .group_named(MARK_GROUP)
        .focusable(false)
        .flex_shrink_0()
        .w(cell_width() * MARK_SLOT as f32)
        .h(cell_height())
        .flex_row()
        .items_center()
        .justify_center()
        .child(
            text(glyph)
                .text_color(tone_color(Tone::Muted))
                .style_when(lit, |s| s.text_color(ACCENT))
                .group_hover_named(MARK_GROUP, |s| s.text_color(ACCENT))
                .group_active_named(MARK_GROUP, |s| s.text_color(ACCENT)),
        )
}

/// How many Cells a trigger's [`trigger_marks`] take: the arrow's slot,
/// and the clear's too.
pub(crate) fn trigger_marks_width(clear: bool) -> Points {
    cell_width() * (MARK_SLOT * if clear { 2 } else { 1 }) as f32
}

/// A control's children after its mark: in a terminal, in a view of
/// their own beside the mark (the control is a row there), laid out in a
/// column as they would be in the control (a choice card's title over its
/// description); elsewhere, as they are.
pub(crate) fn beside_mark(terminal: bool, children: Prop<Children>) -> AnyElement {
    match terminal {
        true => view()
            .flex_grow(1.0)
            .flex_shrink(1.0)
            .min_w(px(0.0))
            .child(children)
            .into_element(),
        false => children.into_element(),
    }
}

/// `content` after `lead` (a disclosure, or blank Cells as wide), in a
/// row: the content in a view of its own that takes the rest of it, laid
/// out as it would be without the lead.
pub(crate) fn after_lead(
    lead: impl Fn() -> SharedString + 'static,
    content: impl IntoElement,
) -> View {
    view().flex_row().child(text(lead)).child(
        view()
            .flex_grow(1.0)
            .flex_shrink(1.0)
            .min_w(px(0.0))
            .child(content),
    )
}

/// A mark in a row, its parts in their tones (tracked: `mark` follows the
/// control's state), then [`MARK_GAP`] before the label.
pub(crate) fn mark_view(mark: impl Fn() -> Mark + Copy + 'static) -> View {
    let part = move |at: usize| {
        text(move || SharedString::from(mark()[at].0)).style_with(move |s| {
            let tone = mark()[at].1;
            let s = s.text_color(tone_color(tone));
            match tone {
                Tone::Strong => s.font_weight(FontWeight::BOLD),
                _ => s,
            }
        })
    };
    view()
        .flex_row()
        .child(part(0))
        .child(part(1))
        .child(part(2))
        .child(text(MARK_GAP))
}

/// A checked checkbox: the mark in [`ACCENT`].
pub const CHECKBOX_CHECKED: Mark = [("[", Tone::Text), ("✓", Tone::Accent), ("]", Tone::Text)];
/// An unchecked checkbox: muted brackets.
pub const CHECKBOX_UNCHECKED: Mark = [("[", Tone::Muted), (" ", Tone::Muted), ("]", Tone::Muted)];
/// A checkbox neither checked nor unchecked: the dash in [`ACCENT`].
pub const CHECKBOX_MIXED: Mark = [("[", Tone::Text), ("–", Tone::Accent), ("]", Tone::Text)];
/// A selected radio: the dot in [`ACCENT`].
pub const RADIO_CHECKED: Mark = [("(", Tone::Text), ("●", Tone::Accent), (")", Tone::Text)];
/// An unselected radio: muted parentheses.
pub const RADIO_UNCHECKED: Mark = [("(", Tone::Muted), (" ", Tone::Muted), (")", Tone::Muted)];
/// An on switch: a checked checkbox, as terminal apps show an on / off
/// setting (a knob on a track would read as a slider).
pub const SWITCH_ON: Mark = CHECKBOX_CHECKED;
/// An off switch: an unchecked checkbox.
pub const SWITCH_OFF: Mark = CHECKBOX_UNCHECKED;
/// A color area's picked Cell.
pub const AREA_PICKED: &str = "◆";
/// A color slider's thumb: a bar on the Cell of the value, over the
/// channel's color there (the other Cells are the colors alone).
pub const COLOR_THUMB: &str = "│";
/// A color swatch by itself: four Cells of its color.
pub const SWATCH: &str = "    ";
/// What separates a control's mark from its label: one Cell.
pub const MARK_GAP: &str = " ";

/// A slider's track where no value is.
pub const SLIDER_TRACK: char = '─';
/// A slider's track between `min` and the value (a range: between its
/// thumbs).
pub const SLIDER_FILL: char = '━';
/// A slider's thumb.
pub const SLIDER_THUMB: &str = "●";

/// A progress bar's filled Cell (also an indeterminate bar's segment): a
/// heavy line, as ratatui's `LineGauge` draws one.
pub const PROGRESS_FILL: char = '━';
/// A progress bar's empty Cell (also an indeterminate bar's track): a
/// light line, which reads apart from the fill without colors too.
pub const PROGRESS_EMPTY: char = '─';
/// How many Cells the segment of an indeterminate progress bar is.
pub const PROGRESS_SEGMENT: usize = 4;

/// After a select's or a combobox's trigger content: it opens a list.
pub const SELECT_ARROW: &str = " ▾";
/// After a select's or a combobox's trigger while it has a value to
/// clear (`cleanable`): pressed, it clears it.
pub const CLEAR: &str = " ×";
/// After a menu item that opens a submenu.
pub const SUBMENU_ARROW: &str = " ›";
/// At the end of a checked menu item, and of a select's or a combobox's
/// chosen row.
pub const MENU_CHECK: &str = "✓";
/// At the end of a checked radio menu item (`"menuitemradio"`).
pub const MENU_RADIO: &str = "●";
/// At the end of an unchecked item of a menu whose items check, and of a
/// list's other rows: as wide as [`MENU_CHECK`], so the marks line up.
pub const MENU_UNCHECKED: &str = " ";
/// The line of a resize handle between two panes side by side, one per
/// row of its Cell column (`ResizablePanelGroup`'s, `DockArea`'s).
pub const DIVIDER_VERTICAL: char = '│';
/// The line of a resize handle between two panes one above the other,
/// repeated along its row.
pub const DIVIDER_HORIZONTAL: char = '─';
/// The glyph of a separator row (a menu's), repeated across its width.
pub const RULE: char = '─';
/// What an empty cell of a one-time code shows, muted: the slot a digit
/// goes in (`OtpInput`'s).
pub const OTP_EMPTY: &str = "·";
/// What a one-time code's filled cell shows while `masked`: a dot a whole
/// Cell wide, as the terminal's password prompts' bullets read.
pub const OTP_MASK: &str = "●";
/// The bar down a quote's left side, one per row of its text (a Markdown
/// quote's `>`), a Cell before the text: TextView's and RichEditor's
/// blockquotes.
pub const QUOTE_BAR: char = '▎';

/// Before a closed disclosure (an accordion item's trigger, a collapsible's
/// trigger, a tree item with children).
pub const DISCLOSURE_CLOSED: &str = "▸ ";
/// Before an open disclosure.
pub const DISCLOSURE_OPEN: &str = "▾ ";
/// Before a tree item without children: as wide as the disclosure, so the
/// labels of one level line up.
pub const DISCLOSURE_NONE: &str = "  ";
/// How many Cells a tree indents each level.
pub const TREE_INDENT: usize = 2;

/// The mark of a checkbox.
pub fn checkbox_mark(checked: bool, indeterminate: bool) -> Mark {
    match (indeterminate, checked) {
        (true, _) => CHECKBOX_MIXED,
        (false, true) => CHECKBOX_CHECKED,
        (false, false) => CHECKBOX_UNCHECKED,
    }
}

/// The mark of a radio.
pub fn radio_mark(checked: bool) -> Mark {
    if checked {
        RADIO_CHECKED
    } else {
        RADIO_UNCHECKED
    }
}

/// The mark of a switch.
pub fn switch_mark(on: bool) -> Mark {
    if on { SWITCH_ON } else { SWITCH_OFF }
}

/// The marker of a disclosure.
pub fn disclosure(open: bool) -> &'static str {
    if open {
        DISCLOSURE_OPEN
    } else {
        DISCLOSURE_CLOSED
    }
}

/// A rule `columns` Cells wide.
pub fn rule(columns: usize) -> String {
    std::iter::repeat_n(RULE, columns).collect()
}

/// The Cell `fraction` (0 to 1) of a track `columns` Cells wide falls on:
/// `min` on the first, `max` on the last.
pub fn track_cell(fraction: Percentage, columns: usize) -> usize {
    let fraction = fraction.0;
    let last = columns.saturating_sub(1);
    let fraction = if fraction.is_nan() {
        0.0
    } else {
        fraction.clamp(0.0, 1.0)
    };
    ((fraction * last as f32).round() as usize).min(last)
}

/// A slider's track `columns` Cells wide: [`SLIDER_FILL`] from Cell `from`
/// to Cell `to` (both included; a single value fills from the first Cell),
/// [`SLIDER_TRACK`] elsewhere. The thumbs are views of their own over it.
pub fn slider_track(columns: usize, from: usize, to: usize) -> String {
    (0..columns)
        .map(|cell| match from <= cell && cell <= to {
            true => SLIDER_FILL,
            false => SLIDER_TRACK,
        })
        .collect()
}

/// A determinate progress bar `columns` Cells wide at `fraction` (0 to 1):
/// [`PROGRESS_FILL`] up to the nearest whole Cell, then
/// [`PROGRESS_EMPTY`], the two contiguous.
pub fn progress_bar(fraction: Percentage, columns: usize) -> String {
    let fraction = fraction.0;
    let fraction = if fraction.is_nan() {
        0.0
    } else {
        fraction.clamp(0.0, 1.0)
    };
    let full = (fraction * columns as f32).round() as usize;
    (0..columns)
        .map(|cell| match cell < full {
            true => PROGRESS_FILL,
            false => PROGRESS_EMPTY,
        })
        .collect()
}

/// An indeterminate progress bar `columns` Cells wide at animation step
/// `step`: a [`PROGRESS_SEGMENT`]-Cell segment of [`PROGRESS_FILL`] that
/// moves one Cell a step and comes back in at the start, over
/// [`PROGRESS_EMPTY`].
pub fn progress_indeterminate(columns: usize, step: usize) -> String {
    if columns == 0 {
        return String::new();
    }
    let segment = PROGRESS_SEGMENT.min(columns);
    // The segment enters from the left edge and leaves past the right one.
    let at = step % (columns + segment);
    (0..columns)
        .map(|cell| match cell + segment > at && cell < at {
            true => PROGRESS_FILL,
            false => PROGRESS_EMPTY,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bars_split_around_their_filled_run() {
        assert_eq!(
            split_filled("━━──"),
            ["".to_string(), "━━".into(), "──".into()]
        );
        assert_eq!(
            split_filled("──━━━─"),
            ["──".to_string(), "━━━".into(), "─".into()]
        );
        assert_eq!(
            split_filled("───"),
            ["───".to_string(), "".into(), "".into()]
        );
    }

    #[test]
    fn marks() {
        let t = |m: Mark| mark_text(&m);
        assert_eq!(t(checkbox_mark(true, false)), "[✓]");
        assert_eq!(t(checkbox_mark(false, false)), "[ ]");
        assert_eq!(t(checkbox_mark(true, true)), "[–]");
        assert_eq!(t(radio_mark(true)), "(●)");
        assert_eq!(t(radio_mark(false)), "( )");
        assert_eq!(t(switch_mark(true)), "[✓]");
        assert_eq!(t(switch_mark(false)), "[ ]");
        // On is the accent, off is muted.
        assert_eq!(checkbox_mark(true, false)[1].1, Tone::Accent);
        assert!(
            checkbox_mark(false, false)
                .iter()
                .all(|p| p.1 == Tone::Muted)
        );
        assert_eq!(switch_mark(true)[1], ("✓", Tone::Accent));
        assert!(switch_mark(false).iter().all(|p| p.1 == Tone::Muted));
    }

    #[test]
    fn progress_bars_fill_whole_cells() {
        assert_eq!(progress_bar(Percentage(0.0), 4), "────");
        assert_eq!(progress_bar(Percentage(1.0), 4), "━━━━");
        assert_eq!(progress_bar(Percentage(0.5), 4), "━━──");
        // 0.3 of 4 Cells is 1.2: one Cell.
        assert_eq!(progress_bar(Percentage(0.3), 4), "━───");
        // 0.4 of 4 Cells is 1.6: two.
        assert_eq!(progress_bar(Percentage(0.4), 4), "━━──");
        assert_eq!(progress_bar(Percentage(f32::NAN), 2), "──");
        assert_eq!(progress_bar(Percentage(0.5), 0), "");
    }

    #[test]
    fn indeterminate_bars_move() {
        assert_eq!(progress_indeterminate(6, 0), "──────");
        assert_eq!(progress_indeterminate(6, 2), "━━────");
        assert_eq!(progress_indeterminate(6, 5), "──━━━─");
        assert_eq!(progress_indeterminate(6, 7), "────━━");
        assert_eq!(progress_indeterminate(6, 10), "──────");
    }

    #[test]
    fn slider_tracks() {
        assert_eq!(track_cell(Percentage(0.0), 5), 0);
        assert_eq!(track_cell(Percentage(1.0), 5), 4);
        assert_eq!(track_cell(Percentage(0.5), 5), 2);
        assert_eq!(track_cell(Percentage(0.5), 0), 0);
        assert_eq!(slider_track(5, 0, 2), "━━━──");
        assert_eq!(slider_track(5, 1, 3), "─━━━─");
        assert_eq!(rule(3), "───");
    }
}

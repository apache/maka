//! `OtpInput`: a fixed-length numeric one-time code (an SMS code, an
//! authenticator's), entered into cells, with no look of its own.
//!
//! `gpui-base`'s `OtpState` keeps the code and edits it from key presses
//! (`otp_input.rs`); its styled counterpart draws the cells. Here one native
//! text field, transparent and over the cells, owns the keyboard: the
//! platform's typing, input methods, paste, the numeric keypad, the
//! one-time-code autofill of iOS and Android and the text field screen
//! readers know. The cells are parts that show the code.
//!
//! - **Edits** are read from what the field reports: the characters it lost
//!   at its end are removed from the code (Backspace removes the last
//!   digit), the digits it gained are added at the end while the code is
//!   shorter than `length` (full-width digits as ASCII ones, anything else
//!   dropped), and text bringing `length` digits or more at once (a paste,
//!   an autofilled code) replaces the code with its first `length`. The
//!   caret stays at the end, as in `gpui-base`, so nothing is edited in the
//!   middle.
//! - **Edits build on the code as the user typed it**: a controlled
//!   `value` comes back a JS turn after `onChange`, maybe after the next
//!   key; the changes the input reported coming back are not set again, a
//!   `value` the app sets otherwise is.
//! - **The field holds the code**: what the edit dropped is taken out of it
//!   again, in a task of its own, since the field's text has already moved
//!   on to what the user typed and the binding's last value is the code.
//! - **The cells**: the one that takes the next digit (`min(len, length -
//!   1)`) is `focus:` while the field has the focus, with a blinking caret
//!   while it is empty (`gpui-base`'s `BlinkCursor`: 500 ms, held for 300 ms
//!   after an edit; steady with reduced motion).

use std::time::Duration;

use nsh_core::{
    AutoFill,
    element::{Style, TextPartStyle},
    prelude::*,
};

use crate::input;

/// How long the caret shows and hides while it blinks (`gpui-base`'s
/// `BlinkCursor` `INTERVAL`).
const BLINK: Duration = Duration::from_millis(500);
/// How long the caret holds after an edit before it blinks again
/// (`BlinkCursor`'s `PAUSE_DELAY`).
const BLINK_PAUSE: Duration = Duration::from_millis(300);
/// What a filled cell shows while `masked`: the bullet the platforms' secure
/// fields show.
const MASK: &str = "\u{2022}";

/// The props of [`OtpInput`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct OtpInputProps {
    /// How many digits the code has: one cell each.
    pub length: Prop<u32>,
    /// The code (controlled): the app owns it and sets it in `onChange`.
    /// Shown as it is, unfiltered (as `gpui-base`'s `set_value`). Without
    /// it the input keeps its own code.
    pub value: Prop<Option<SharedString>>,
    /// The code at first, while `value` is not set.
    pub default_value: Prop<Option<SharedString>>,
    /// Filled cells show a bullet instead of their digit, and the field is
    /// a secure one: screen readers do not read the code, and the system
    /// keeps it out of its suggestions.
    #[prop(default)]
    pub masked: Prop<bool>,
    /// No focus and no editing; `disabled:` styles apply to the input and
    /// its parts, and screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// How many groups the cells are split into, as evenly as they go
    /// (`gpui-component`'s `OtpInput::groups`): 3 + 3 for six digits in two.
    /// At least one, at most one per cell.
    #[prop(default = 1)]
    pub groups: Prop<u32>,
    /// What screen readers say for the field: what the code is for, and how
    /// many digits it has (the cells are hidden from them).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The Tailwind classes of each cell: its size, border and text.
    /// `focus:` styles the cell that takes the next digit while the input
    /// has the focus, `disabled:` follows the input.
    pub cell_class: Prop<Option<SharedString>>,
    /// The style of each cell, over `cellClass`: its text styles too
    /// (`color`, `fontSize`), which its digit inherits.
    #[prop(default)]
    pub cell_style: Prop<TextPartStyle>,
    /// The Tailwind classes of each group of cells (`flex-row gap-2`).
    /// `disabled:` follows the input.
    pub group_class: Prop<Option<SharedString>>,
    /// The style of each group, over `groupClass`.
    #[prop(default)]
    pub group_style: Prop<Style>,
    /// The Tailwind classes of the caret, in the empty cell that takes the
    /// next digit while the input has the focus: its width, height and
    /// color (`h-5 w-0.5 bg-foreground`). It blinks unless the user asked
    /// for less motion.
    pub caret_class: Prop<Option<SharedString>>,
    /// The style of the caret, over `caretClass`.
    #[prop(default)]
    pub caret_style: Prop<Style>,
}

/// What [`OtpInputEvent::Complete`] reports.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct OtpInputCompleteEvent {
    /// The code, `length` digits.
    pub value: SharedString,
}

/// The events of an [`OtpInput`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum OtpInputEvent {
    /// The user changed the code (typed, deleted, pasted, autofilled): the
    /// new code. A `value` the app passes is never reported.
    #[args(value)]
    Change(SharedString),
    /// The user's change filled the last cell, after its `onChange`: the
    /// code, to verify.
    #[args(event)]
    Complete(OtpInputCompleteEvent),
    /// The input took the keyboard focus.
    Focus,
    /// The input lost the keyboard focus.
    Blur,
}

/// The methods of an [`OtpInput`]'s ref.
pub struct OtpInputApi {
    field: ElementRef,
}

#[methods]
impl OtpInputApi {
    /// Takes the keyboard focus (showing the software keyboard), as a
    /// press on the input does (`gpui-base`'s `OtpState::focus`).
    pub fn focus(&self) {
        self.field.focus();
    }
}

/// The code, the app's or the input's own.
#[derive(Clone, Copy)]
struct Code {
    controlled: Prop<Option<SharedString>>,
    own: Signal<SharedString>,
}

impl Code {
    fn get(self) -> SharedString {
        self.controlled.get().unwrap_or_else(|| self.own.get())
    }

    fn get_untracked(self) -> SharedString {
        self.controlled
            .get_untracked()
            .unwrap_or_else(|| self.own.get_untracked())
    }
}

/// How many reported codes the input waits to see come back as `value`:
/// a few keys a JS turn behind, not an app that keeps its code.
const ECHOES: usize = 16;

/// Takes `value` out of `echoes`, the codes the input reported and has not
/// seen come back, with those reported before it: whether it is one of
/// them (the app took the user's change, maybe a key or more behind).
fn echoed(echoes: &mut Vec<String>, value: &str) -> bool {
    match echoes.iter().position(|e| e == value) {
        Some(at) => {
            echoes.drain(..=at);
            true
        }
        None => false,
    }
}

/// The caret's blinking (`gpui-base`'s `BlinkCursor`).
#[derive(Clone, Copy)]
struct Blink {
    visible: Signal<bool>,
    task: Stored<Option<Spawned<()>>>,
}

impl Blink {
    fn new() -> Self {
        Self {
            visible: signal(false),
            task: stored(None),
        }
    }

    fn cancel(self) {
        if let Some(task) = self.task.replace(None) {
            task.cancel();
        }
    }

    /// Shows the caret, then blinks it after `hold` (none with reduced
    /// motion).
    fn start(self, hold: Duration) {
        self.cancel();
        self.visible.set(true);
        if untracked(reduce_motion) {
            return;
        }
        let visible = self.visible;
        let task = spawn(async move {
            timer(hold).await;
            loop {
                visible.update(|v| *v = !*v);
                timer(BLINK).await;
            }
        });
        self.task.replace(Some(task));
    }

    /// Hides the caret (the input lost the focus).
    fn stop(self) {
        self.cancel();
        self.visible.set(false);
    }
}

/// A one-time-code input: a fixed number of digits entered into cells (a
/// verification code from a text message, an authenticator's code). It owns
/// its behavior (typing, Backspace, paste and the system's code autofill,
/// digits only, the length, the focus, the caret, the masked state, one
/// text field for screen readers) and leaves its look to the app: no
/// colors, sizes, borders or label of its own. The code is the app's
/// (`value` and `onChange`) or its own (`defaultValue`); `onComplete` tells
/// when the user filled it. Its parts are the cells (`cellClass` /
/// `cellStyle`, `focus:` on the one that takes the next digit while
/// focused), the groups they are split into (`groups`, `groupClass` /
/// `groupStyle`) and the caret (`caretClass` / `caretStyle`); the app's
/// `class` and `style` lay out and style the input (`flex-row gap-4` for
/// its groups in a row). A press anywhere on it focuses it.
#[component(methods = OtpInputApi)]
pub fn OtpInput(props: OtpInputProps, cx: Scope<OtpInputEvent>) -> impl IntoElement {
    let code = Code {
        controlled: props.value,
        own: signal(props.default_value.get_untracked().unwrap_or_default()),
    };
    // What the field holds, as far as the input knows: the code, or what
    // the user just typed until it is taken back to the code.
    let field = signal(code.get_untracked().to_string());
    // The code as the user edited it: what the next edit applies to. A
    // controlled `value` comes back a JS turn later, so keys typed before
    // it does build on this, not on the `value` shown.
    let typed = stored(code.get_untracked().to_string());
    // The codes reported and not yet seen come back as `value`.
    let echoes = stored(Vec::<String>::new());
    let correction = stored(None::<Spawned<()>>);
    let focused = signal(false);
    let blink = Blink::new();
    let field_ref = element_ref();
    cx.methods(OtpInputApi { field: field_ref });

    // A code the app sets (or the own one) is the code edits apply to and
    // the field's text, unless it is a change the user made coming back:
    // newer keys may have built on it already.
    effect(move || {
        let value = code.get().to_string();
        untracked(move || {
            if echoes.with(|echoes| echoed(echoes, &value)) {
                return;
            }
            echoes.with(Vec::clear);
            typed.replace(value.clone());
            if field.get() != value {
                field.set(value);
            }
        });
    });

    let parts = Cells {
        length: props.length,
        masked: props.masked,
        disabled: props.disabled,
        class: props.cell_class,
        style: props.cell_style,
        caret_class: props.caret_class,
        caret_style: props.caret_style,
        code,
        focused,
        blink,
    };

    let changed = move |text: &str| {
        if let Some(task) = correction.replace(None) {
            task.cancel();
        }
        let before = field.get_untracked();
        let (deleted, inserted) = diff(&before, text);
        let shown = typed.get();
        let next = edit(
            &shown,
            deleted,
            inserted,
            props.length.get_untracked() as usize,
        );
        if next != shown {
            typed.replace(next.clone());
            echoes.with(|echoes| {
                if echoes.len() == ECHOES {
                    echoes.remove(0);
                }
                echoes.push(next.clone());
            });
            if code.controlled.get_untracked().is_none() {
                code.own.set(next.clone().into());
            }
            if focused.get_untracked() {
                blink.start(BLINK_PAUSE);
            }
            cx.emit(OtpInputEvent::Change(next.clone().into()));
            if next.chars().count() == props.length.get_untracked() as usize {
                cx.emit(OtpInputEvent::Complete(OtpInputCompleteEvent {
                    value: next.clone().into(),
                }));
            }
        }
        if next == text {
            field.set(next);
        } else if next != before {
            // The binding's last value differs: setting it sends it.
            field.set(next.clone());
            field_ref.set_selection(utf16_len(&next), utf16_len(&next));
        } else {
            // The binding's last value is the code already (the edit
            // changed nothing): the field's text goes there first, then
            // back, in a run of its own, so the field gets the code.
            field.set(text.to_owned());
            let task = spawn(async move {
                field.set(next.clone());
                field_ref.set_selection(utf16_len(&next), utf16_len(&next));
            });
            correction.replace(Some(task));
        }
    };

    let (groups, group_class, group_style) = (props.groups, props.group_class, props.group_style);
    let cells = dynamic(move || {
        let length = parts.length.get() as usize;
        let per_group = length
            .div_ceil(group_count(length, groups.get() as usize))
            .max(1);
        let mut rows: Vec<Vec<AnyElement>> = Vec::new();
        for ix in 0..length {
            if ix % per_group == 0 {
                rows.push(Vec::new());
            }
            rows.last_mut().expect("a group").push(parts.cell(ix));
        }
        rows.into_iter()
            .map(|cells| {
                // The field tells screen readers the code.
                view()
                    .accessibility_elements_hidden(true)
                    .project_disabled(parts.disabled)
                    .app_class(group_class)
                    .inline_style(group_style)
                    .children(cells)
            })
            .collect::<Vec<_>>()
    });

    view().disabled(props.disabled).child(cells).child(
        input()
            .element_ref(&field_ref)
            .absolute()
            .inset_0()
            .p_0()
            .border(px(0.0))
            .bg(AdaptiveColor::TRANSPARENT)
            .text_color(AdaptiveColor::TRANSPARENT)
            .selection_color(transparent_black())
            .caret(false)
            .keyboard_type(KeyboardType::Number)
            .auto_fill(AutoFill::OneTimeCode)
            .auto_correct(false)
            .auto_capitalize(AutoCapitalize::None)
            .masked(props.masked)
            .disabled(props.disabled)
            .optional_label(props.accessibility_label)
            .value(move || field.get())
            .on_change(move |text: &str| changed(text))
            .on_selection_change(move |selection: &Selection| {
                // The caret stays at the end: nothing is edited in the
                // middle.
                let end = utf16_len(&field.get_untracked());
                if (selection.start, selection.end) != (end, end) {
                    field_ref.set_selection(end, end);
                }
            })
            .on_focus(move || {
                focused.set(true);
                blink.start(BLINK);
                cx.emit(OtpInputEvent::Focus);
            })
            .on_blur(move || {
                focused.set(false);
                blink.stop();
                cx.emit(OtpInputEvent::Blur);
            }),
    )
}

/// What the cells show and read.
#[derive(Clone, Copy)]
struct Cells {
    length: Prop<u32>,
    masked: Prop<bool>,
    disabled: Prop<bool>,
    class: Prop<Option<SharedString>>,
    style: Prop<TextPartStyle>,
    caret_class: Prop<Option<SharedString>>,
    caret_style: Prop<Style>,
    code: Code,
    focused: Signal<bool>,
    blink: Blink,
}

impl Cells {
    /// The cell that takes the next digit (`gpui-component`'s `cursor_ix`).
    fn active(self) -> usize {
        let length = self.length.get() as usize;
        self.code
            .get()
            .chars()
            .count()
            .min(length.saturating_sub(1))
    }

    /// Cell `ix`: its digit (a bullet while masked), or the caret while it
    /// is the empty cell that takes the next digit and the input has the
    /// focus.
    fn cell(self, ix: usize) -> AnyElement {
        let digit = move || self.code.get().chars().nth(ix);
        view()
            .project_focused(move || {
                self.focused.get() && !self.disabled.get() && self.active() == ix
            })
            .project_disabled(self.disabled)
            .app_class(self.class)
            .inline_style(move || self.style.get())
            .child(
                when(
                    move || digit().is_some(),
                    move || {
                        text(move || match digit() {
                            Some(_) if self.masked.get() => MASK.to_owned(),
                            Some(c) => c.to_string(),
                            None => String::new(),
                        })
                    },
                )
                .otherwise(move || {
                    when(
                        move || {
                            self.focused.get() && self.blink.visible.get() && self.active() == ix
                        },
                        move || {
                            view()
                                .app_class(self.caret_class)
                                .inline_style(self.caret_style)
                        },
                    )
                }),
            )
            .into_element()
    }
}

/// How many groups `requested` splits `length` cells into (`gpui-component`'s
/// `OtpInput::resolved_groups`): at least one, at most one per cell.
fn group_count(length: usize, requested: usize) -> usize {
    requested.max(1).min(length.max(1))
}

/// `c` as an ASCII digit: itself, or a full-width digit's (`０`–`９`, an
/// East Asian input method's) as `gpui-base`'s `to_digit_char` maps them.
fn digit(c: char) -> Option<char> {
    if c.is_ascii_digit() {
        return Some(c);
    }
    let n = (c as u32).checked_sub('０' as u32)?;
    char::from_digit(n, 10)
}

/// What the field lost at its end (characters) and what it gained, from
/// `before` to `after`.
fn diff<'a>(before: &str, after: &'a str) -> (usize, &'a str) {
    let prefix = before
        .char_indices()
        .zip(after.chars())
        .find(|((_, a), b)| a != b)
        .map_or_else(|| before.len().min(after.len()), |((i, _), _)| i);
    // `prefix` is a boundary of both: the strings agree up to it.
    let deleted = before[prefix..].chars().count();
    (deleted, &after[prefix..])
}

/// The code after an edit of `shown` that removed `deleted` characters at
/// its end and inserted `inserted`: its digits appended while the code is
/// shorter than `length`, or, `length` of them at once, the code replaced
/// by the first `length`.
fn edit(shown: &str, deleted: usize, inserted: &str, length: usize) -> String {
    let digits: Vec<char> = inserted.chars().filter_map(digit).collect();
    if length > 0 && digits.len() >= length {
        return digits[..length].iter().collect();
    }
    let mut chars: Vec<char> = shown.chars().collect();
    chars.truncate(chars.len().saturating_sub(deleted));
    for d in digits {
        if chars.len() >= length {
            break;
        }
        chars.push(d);
    }
    chars.into_iter().collect()
}

/// `text`'s length in UTF-16 units, as inputs count their selection.
fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

#[cfg(test)]
mod tests {
    use super::{diff, digit, echoed, edit, group_count};

    #[test]
    fn a_reported_code_coming_back_late_is_an_echo() {
        let mut echoes = vec!["1".to_owned(), "13".to_owned(), "135".to_owned()];
        // The app took "1" while "13" and "135" were typed.
        assert!(echoed(&mut echoes, "1"));
        assert_eq!(echoes, ["13", "135"]);
        assert!(echoed(&mut echoes, "135"));
        assert!(echoes.is_empty());
        // A code the app sets itself is none.
        assert!(!echoed(&mut echoes, ""));
    }

    #[test]
    fn keys_append_digits_up_to_the_length_and_backspace_removes_the_last() {
        // `gpui-base`'s `keyboard_editing_backspaces_and_stops_at_length`.
        assert_eq!(edit("12", 1, "", 4), "1");
        assert_eq!(edit("12", 0, "３", 4), "123");
        assert_eq!(edit("1234", 0, "5", 4), "1234");
        assert_eq!(edit("12", 0, "a", 4), "12");
        assert_eq!(edit("", 1, "", 4), "");
    }

    #[test]
    fn a_whole_code_at_once_replaces_the_code() {
        assert_eq!(edit("12", 0, "987-654", 6), "987654");
        assert_eq!(edit("123456", 0, "9876543", 6), "987654");
        // Fewer digits than the length are appended.
        assert_eq!(edit("12", 0, "3-4", 6), "1234");
        assert_eq!(edit("1234", 0, "5678", 6), "123456");
    }

    #[test]
    fn full_width_digits_are_ascii_and_nothing_else_is_a_digit() {
        assert_eq!(digit('０'), Some('0'));
        assert_eq!(digit('９'), Some('9'));
        assert_eq!(digit('7'), Some('7'));
        assert_eq!(digit('a'), None);
        assert_eq!(digit('٣'), None);
        assert_eq!(digit('-'), None);
    }

    #[test]
    fn the_field_reports_what_it_lost_and_gained_at_its_end() {
        assert_eq!(diff("12", "123"), (0, "3"));
        assert_eq!(diff("123", "12"), (1, ""));
        assert_eq!(diff("12", "12"), (0, ""));
        assert_eq!(diff("123", ""), (3, ""));
        assert_eq!(diff("1２", "1２3"), (0, "3"));
        assert_eq!(diff("1２", "13"), (1, "3"));
        // A secure field typed in again starts over.
        assert_eq!(diff("1234", "5"), (4, "5"));
    }

    #[test]
    fn invalid_group_counts_are_safely_clamped() {
        // `gpui-component`'s test of `resolved_groups`.
        assert_eq!(group_count(6, 0), 1);
        assert_eq!(group_count(6, 20), 6);
        assert_eq!(group_count(0, 0), 1);
        assert_eq!(group_count(5, 2), 2);
    }
}

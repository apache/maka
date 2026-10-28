//! `NumberInput`: a number typed in a field or stepped with buttons and
//! keys, with no look of its own (`gpui-base`'s `number_input.rs`, with the
//! number rules of its `InputState`: the step, `min` / `max` and the number
//! mask).

use nsh_core::{
    AccessibilityActionDef, AccessibilityValue,
    element::{InputPartStyle, Style, input},
    keymap::When,
    prelude::*,
};

use crate::{keys::bind_while_when, numeric};

/// The props of [`NumberInput`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct NumberInputProps {
    /// The value (controlled): a number, or `null` for an empty field.
    /// The app owns it and sets the one `onChange` reports; whenever it
    /// sets one the input did not report, the field shows it. Without it
    /// the input keeps its own, from `defaultValue`.
    pub value: Prop<Option<f64>>,
    /// The value at first while `value` is not set (default none: an
    /// empty field).
    pub default_value: Prop<Option<f64>>,
    /// The smallest value (default none). Steps stop at it; a typed value
    /// below it is held to it when the field is left or Enter is pressed.
    pub min: Prop<Option<f64>>,
    /// The largest value (default none); one below `min` is `min`. As
    /// `min`, from above.
    pub max: Prop<Option<f64>>,
    /// How far a step goes (default `1`): a button, Up / Down, a screen
    /// reader's increment and decrement. Page Up / Page Down go ten
    /// steps. One that is not a positive number is `1`.
    #[prop(default = 1.0)]
    pub step: Prop<f64>,
    /// No typing, steps or focus; `disabled:` styles apply to the input
    /// and its parts, and screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The text can be selected and copied but not changed, by typing or
    /// by steps; the buttons are disabled.
    #[prop(default)]
    pub readonly: Prop<bool>,
    /// Shown while the field is empty (the app's words).
    pub placeholder: Prop<Option<SharedString>>,
    /// What screen readers say for the field, when no visible label names
    /// it.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// Both buttons on the right of the field, the increment over the
    /// decrement, in the `controls` part (`gpui-base`'s `controls_right`);
    /// else the decrement before the field and the increment after it.
    /// Read when the input is made.
    #[prop(default)]
    pub controls_right: Prop<bool>,
    /// The Tailwind classes of the text field (`flex-1 text-center`);
    /// `focus:` while it edits, `disabled:` with the input.
    pub input_class: Prop<Option<SharedString>>,
    /// The style of the text field, over `inputClass`: its text styles too
    /// (`color`, `fontSize`, `textAlign`, `placeholderColor`).
    #[prop(default)]
    pub input_style: Prop<InputPartStyle>,
    /// The Tailwind classes of the decrement button; `hover:`, `active:`
    /// while pressed, `disabled:` with the input and at `min` (where a step
    /// down does nothing).
    pub decrement_button_class: Prop<Option<SharedString>>,
    /// The style of the decrement button, over `decrementButtonClass`.
    #[prop(default)]
    pub decrement_button_style: Prop<Style>,
    /// The content of the decrement button: a minus sign, an icon.
    pub decrement_button: Prop<Option<Slot>>,
    /// The Tailwind classes of the increment button; as the decrement's,
    /// disabled at `max`.
    pub increment_button_class: Prop<Option<SharedString>>,
    /// The style of the increment button, over `incrementButtonClass`.
    #[prop(default)]
    pub increment_button_style: Prop<Style>,
    /// The content of the increment button: a plus sign, an icon.
    pub increment_button: Prop<Option<Slot>>,
    /// The Tailwind classes of the column that holds both buttons with
    /// `controlsRight`.
    pub controls_class: Prop<Option<SharedString>>,
    /// The style of the controls column, over `controlsClass`.
    #[prop(default)]
    pub controls_style: Prop<Style>,
    /// Content before the field, after the button on its left: a currency
    /// sign, an icon (`gpui-component`'s `prefix`).
    pub prefix: Prop<Option<Slot>>,
    /// Content after the field, before the buttons on its right: a unit,
    /// a currency (`gpui-component`'s `suffix`).
    pub suffix: Prop<Option<Slot>>,
}

/// The events of a [`NumberInput`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum NumberInputEvent {
    /// The number changed (typing, a step, a screen reader's increment or
    /// decrement, the field left with a value out of range): the number
    /// the field reads as, `null` while it reads as none (empty, `-`).
    /// While the user types it may be outside `min` / `max`; leaving the
    /// field or Enter holds it to them and reports that.
    #[args(value)]
    Change(Option<f64>),
    /// Return / Enter in the field: its value, held to `min` and `max`.
    #[args(value)]
    Submit(Option<f64>),
    /// The field took the keyboard focus.
    Focus,
    /// The field lost the keyboard focus (its value is held to `min` and
    /// `max` first).
    Blur,
}

/// What a key, a button or a screen reader's action does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Nudge {
    Up,
    Down,
    PageUp,
    PageDown,
}

/// The keys of a focused number input: WAI-ARIA's spin button keys,
/// repeating while held. They fire while its field edits ([`When::Always`]),
/// where Up and Down would move the caret. Home and End stay the field's:
/// they move the caret in the text the user edits.
const KEYS: &[(&str, bool, Nudge)] = &[
    ("up", true, Nudge::Up),
    ("down", true, Nudge::Down),
    ("pageup", true, Nudge::PageUp),
    ("pagedown", true, Nudge::PageDown),
];

/// How many steps Page Up and Page Down go.
const PAGE_STEPS: f64 = 10.0;

/// What the input's parts and listeners share.
#[derive(Clone, Copy)]
struct Ctl {
    value: Prop<Option<f64>>,
    min: Prop<Option<f64>>,
    max: Prop<Option<f64>>,
    step: Prop<f64>,
    disabled: Prop<bool>,
    readonly: Prop<bool>,
    /// What the field shows: its `value` binding's last text.
    text: Signal<String>,
    /// The run that takes a refused edit back to the field's text.
    correction: Stored<Option<Spawned<()>>>,
    /// The number the field holds: the last it reported, or the app's.
    held: Stored<Option<f64>>,
    /// The app passed a number as `value`: it owns the value from then on
    /// (its `null` is an empty field).
    controlled: Stored<bool>,
    /// A step's text, shown once the app's value follows the step.
    pending: Stored<Option<(f64, String)>>,
    cx: Scope<NumberInputEvent>,
}

impl Ctl {
    /// `min` and `max` (tracked), each a finite number or none, `max` not
    /// below `min`.
    fn bounds(self) -> (Option<f64>, Option<f64>) {
        let min = self.min.get().filter(|v| v.is_finite());
        let max = self.max.get().filter(|v| v.is_finite());
        let max = match (min, max) {
            (Some(min), Some(max)) if max < min => Some(min),
            _ => max,
        };
        (min, max)
    }

    /// The step (tracked): a positive number.
    fn step_size(self) -> f64 {
        let step = self.step.get();
        if step.is_finite() && step > 0.0 {
            step
        } else {
            1.0
        }
    }

    /// The text a step makes of the field's (tracked); none when it does
    /// nothing (at a bound).
    fn stepped(self, nudge: Nudge) -> Option<String> {
        let (up, n) = match nudge {
            Nudge::Up => (true, 1.0),
            Nudge::Down => (false, 1.0),
            Nudge::PageUp => (true, PAGE_STEPS),
            Nudge::PageDown => (false, PAGE_STEPS),
        };
        let (min, max) = self.bounds();
        let step = numeric::steps(self.step_size(), n);
        self.text
            .with(|text| numeric::step_text(text, up, step, min, max))
    }

    /// Whether a step can change the value (tracked).
    fn can_step(self, nudge: Nudge) -> bool {
        !self.disabled.get() && !self.readonly.get() && self.stepped(nudge).is_some()
    }

    /// Reports `n` when it is not the number the field holds.
    fn report(self, n: Option<f64>) {
        if self.held.get() != n {
            self.held.replace(n);
            self.cx.emit(NumberInputEvent::Change(n));
        }
    }

    /// The field's text changed: kept when it is a number or on the way to
    /// one (other keyboards' digits and signs made ASCII), else the field
    /// goes back to its text.
    fn edit(self, typed: &str) {
        if let Some(task) = self.correction.replace(None) {
            task.cancel();
        }
        let normalized = numeric::normalize_number_text(typed);
        let before = self.text.get_untracked();
        if !numeric::is_number_text(&normalized) {
            self.show(typed, before);
            return;
        }
        let n = numeric::parse_number(&normalized);
        self.pending.replace(None);
        self.show(typed, normalized);
        self.report(n);
    }

    /// The field, whose text the user just made `typed`, shows `text`. The
    /// `value` binding sends only what differs from its last text: when
    /// that is `text` already (an edit taken back to the text it had), it
    /// takes the field's text first, then `text` in a run of its own, so
    /// the field gets it.
    fn show(self, typed: &str, text: String) {
        if text == typed || text != self.text.get_untracked() {
            self.text.set(text);
            return;
        }
        self.text.set(typed.to_owned());
        let field = self.text;
        let task = spawn(async move { field.set(text) });
        self.correction.replace(Some(task));
    }

    /// A key, a button or a screen reader's step. The app that owns the
    /// value hears it and moves the field by setting its value; else the
    /// field moves at once.
    fn nudge(self, nudge: Nudge) {
        if self.disabled.get_untracked() || self.readonly.get_untracked() {
            return;
        }
        let Some(next) = untracked(|| self.stepped(nudge)) else {
            return;
        };
        let n = numeric::parse_number(&next);
        if self.controlled.get() {
            if let Some(n) = n {
                self.pending.replace(Some((n, next)));
            }
            self.cx.emit(NumberInputEvent::Change(n));
        } else {
            self.text.set(next);
            self.report(n);
        }
    }

    /// The field was left or Enter pressed: a value out of range is held to
    /// `min` / `max` and reported, and the field shows the app's value (an
    /// edit the app did not take goes); a text that reads as no number
    /// stays as it is. Returns the number the field committed, held to the
    /// range (none for a text that reads as none).
    fn commit(self) -> Option<f64> {
        let text = self.text.get_untracked();
        let typed = numeric::parse_number(&text);
        let (min, max) = untracked(|| self.bounds());
        let held = typed.map(|v| numeric::clamp_to(v, min, max));
        if held.is_some() {
            self.report(held);
        }
        self.pending.replace(None);
        if self.controlled.get() {
            let value = self.value.get_untracked().filter(|v| v.is_finite());
            self.held.replace(value);
            if typed != value {
                self.text
                    .set(value.map(numeric::number_text).unwrap_or_default());
            }
        } else if let (Some(typed), Some(held)) = (typed, held)
            && typed != held
        {
            self.text.set(numeric::number_text(held));
        }
        held
    }

    /// The app set `value`: the field shows it, unless it is the number
    /// the field holds (what the user is typing stays: `1.`, `0.50`).
    fn follow(self, value: Option<f64>) {
        if value.is_some() {
            self.controlled.replace(true);
        }
        if !self.controlled.get() || self.held.get() == value {
            return;
        }
        self.held.replace(value);
        let shown = match self.pending.replace(None) {
            Some((n, text)) if Some(n) == value => text,
            _ => value.map(numeric::number_text).unwrap_or_default(),
        };
        self.text.set(shown);
    }

    /// What screen readers get of the field: the number it reads as
    /// between `min` and `max`, and its text (tracked).
    fn accessibility_value(self) -> AccessibilityValue {
        let (min, max) = self.bounds();
        let text = self.text.get();
        AccessibilityValue {
            min: min.map(|v| v as f32),
            max: max.map(|v| v as f32),
            now: numeric::parse_number(&text).map(|v| v as f32),
            text: (!text.is_empty()).then(|| text.into()),
        }
    }
}

/// A field for a number with buttons that step it: a quantity, a price, a
/// size. It owns its behavior (what the field takes as the user types,
/// other keyboards' digits included; the step and its decimals, held to
/// `min` and `max`; WAI-ARIA's spin button keys while the field edits; its
/// role, value and increment / decrement for screen readers) and leaves its
/// look to the app: no colors, sizes, borders, icons or strings of its own.
/// Its parts are the decrement button, the field between the `prefix` and
/// `suffix` slots, and the increment button (with `controlsRight`: the
/// field between them and a column with the increment over the decrement);
/// the app's `class` and `style` style the input (`focus-within:` for a
/// ring around it all), `<part>Class` / `<part>Style` the parts, the
/// `incrementButton` and `decrementButton` slots fill the buttons.
#[component]
pub fn NumberInput(props: NumberInputProps, cx: Scope<NumberInputEvent>) -> impl IntoElement {
    let initial = props.value.get_untracked().filter(|v| v.is_finite());
    let controlled = initial.is_some();
    let start = if controlled {
        initial
    } else {
        props
            .default_value
            .get_untracked()
            .filter(|v| v.is_finite())
    };
    let ctl = Ctl {
        value: props.value,
        min: props.min,
        max: props.max,
        step: props.step,
        disabled: props.disabled,
        readonly: props.readonly,
        text: signal(start.map(numeric::number_text).unwrap_or_default()),
        correction: stored(None),
        held: stored(start),
        controlled: stored(controlled),
        pending: stored(None),
        cx,
    };
    effect(move || ctl.follow(props.value.get().filter(|v| v.is_finite())));
    let focused = signal(false);
    bind_while_when(
        move || focused.get(),
        When::Always,
        KEYS,
        move |nudge| ctl.nudge(nudge),
    );
    let field = element_ref();
    let action = |name: &str| AccessibilityActionDef {
        name: name.into(),
        label: None,
    };
    let text_field = input()
        .element_ref(&field)
        .value(move || ctl.text.get())
        .placeholder(move || {
            props
                .placeholder
                .get()
                .map(|p| p.to_string())
                .unwrap_or_default()
        })
        .keyboard_type(move || match ctl.bounds().0 {
            // Phones' decimal pads have no minus sign.
            Some(min) if min >= 0.0 => KeyboardType::Decimal,
            _ => KeyboardType::NumbersAndPunctuation,
        })
        .auto_correct(false)
        // A disabled field takes no edits either (the platforms' text
        // fields stay editable under a disabled view).
        .readonly(move || props.readonly.get() || props.disabled.get())
        .disabled(props.disabled)
        .role(AccessibilityRole::Spinbutton)
        .optional_label(props.accessibility_label)
        .accessibility_value(move || Some(ctl.accessibility_value()))
        .accessibility_actions(vec![action("increment"), action("decrement")])
        .on_accessibility_action(move |name: &str| match name {
            "increment" => ctl.nudge(Nudge::Up),
            "decrement" => ctl.nudge(Nudge::Down),
            _ => {}
        })
        .on_change(move |text: &str| ctl.edit(text))
        .on_focus(move || {
            focused.set(true);
            cx.emit(NumberInputEvent::Focus);
        })
        .on_blur(move || {
            focused.set(false);
            let _ = ctl.commit();
            cx.emit(NumberInputEvent::Blur);
        })
        .on_submit(move |_: &str| {
            let value = ctl.commit();
            cx.emit(NumberInputEvent::Submit(value));
        })
        .app_class(props.input_class)
        .inline_style(move || props.input_style.get());
    // The buttons step the field from wherever the focus is and never take
    // it (the field keeps its caret and its keys); on the desktops a press
    // moves the focus to the field, as `gpui-base`'s, and on touch screens
    // it leaves it, so no keyboard comes up. Screen readers step the field
    // itself, so the buttons are hidden from them.
    let button = move |nudge: Nudge| {
        let (class, style, content) = match nudge {
            Nudge::Up => (
                props.increment_button_class,
                props.increment_button_style,
                props.increment_button,
            ),
            _ => (
                props.decrement_button_class,
                props.decrement_button_style,
                props.decrement_button,
            ),
        };
        view()
            .focusable(false)
            .accessibility_elements_hidden(true)
            .disabled(move || !ctl.can_step(nudge))
            .on_press(move || {
                ctl.nudge(nudge);
                if is_desktop() && !focused.get_untracked() {
                    field.focus();
                }
            })
            .app_class(class)
            .inline_style(style)
            .child(content.place(|c| c))
    };
    let root = view().disabled(props.disabled);
    let prefix = props.prefix.place(|c| c);
    let suffix = props.suffix.place(|c| c);
    if props.controls_right.get_untracked() {
        root.child(prefix).child(text_field).child(suffix).child(
            view()
                .project_disabled(props.disabled)
                .app_class(props.controls_class)
                .inline_style(props.controls_style)
                .child(button(Nudge::Up))
                .child(button(Nudge::Down)),
        )
    } else {
        root.child(button(Nudge::Down))
            .child(prefix)
            .child(text_field)
            .child(suffix)
            .child(button(Nudge::Up))
    }
}

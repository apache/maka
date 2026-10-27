//! A UI set of the tests' own (`test/ui`): small components that exercise
//! the machinery of Rust components (slots, children placed one by one,
//! virtualized `items`, `#[prop(lazy)]` children, `#[methods]` refs, events,
//! inputs) as an app's crate would, with no UI set of nsh's.

use std::{rc::Rc, time::Duration};

use nsh_base::{dialog, input, theme};
use nsh_core::{element::Registry, prelude::*};

/// The module the tests' apps import these components from.
pub(crate) const SPECIFIER: &str = "test/ui";

/// The set, for the bundler, the compiler and the engine.
pub(crate) fn registry() -> Registry {
    let mut registry = Registry::ui_set(SPECIFIER);
    registry
        .register::<Button>()
        .register::<Card>()
        .register::<Disclosure>()
        .register::<Group>()
        .register::<ListView>()
        .register::<Stepper>()
        .register::<TextField>()
        .register::<Sheet>()
        .register::<Shortcut>();
    registry
}

// --- Button: a press target with a label, and its event --------------------

/// A press target with a label, drawn in full: the component benchmarks
/// compare it with the same Button written in TSX.
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct ButtonProps {
    /// The label.
    pub(crate) title: Prop<SharedString>,
    /// `primary` (default): filled; `secondary`: tinted; `danger`: a
    /// destructive action; `plain`: text only.
    #[prop(default)]
    pub(crate) variant: Prop<ButtonVariant>,
    /// No presses, no feedback, dimmed.
    #[prop(default)]
    pub(crate) disabled: Prop<bool>,
    /// For screen readers, when `title` is not enough.
    pub(crate) accessibility_label: Prop<Option<SharedString>>,
}

/// How a [`Button`] looks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum ButtonVariant {
    /// Filled with the primary color.
    #[default]
    Primary,
    /// Filled with the secondary color.
    Secondary,
    /// Filled with the danger color.
    Danger,
    /// Text only; a background while pressed.
    Plain,
}

/// The events of a [`Button`].
#[derive(Debug, Clone, PartialEq, Event)]
pub(crate) enum ButtonEvent {
    /// The button was pressed.
    Press,
}

/// The background, the background while pressed and the label's color of
/// `variant`.
fn colors(variant: ButtonVariant) -> (AdaptiveColor, AdaptiveColor, AdaptiveColor) {
    let theme = theme();
    match variant {
        // shadcn's buttons: the role's color, 90% (80%) of it pressed.
        ButtonVariant::Primary => (
            theme.primary,
            theme.primary.opacity(0.9),
            theme.primary_foreground,
        ),
        ButtonVariant::Secondary => (
            theme.secondary,
            theme.secondary.opacity(0.8),
            theme.secondary_foreground,
        ),
        ButtonVariant::Danger => (
            theme.destructive,
            theme.destructive.opacity(0.9),
            AdaptiveColor::rgb(0xffffff, 0xffffff),
        ),
        ButtonVariant::Plain => (AdaptiveColor::TRANSPARENT, theme.accent, theme.foreground),
    }
}

/// A press target with a label ([`ButtonProps`]).
#[component]
pub(crate) fn Button(props: ButtonProps, cx: Scope<ButtonEvent>) -> impl IntoElement {
    let colors = computed(move || colors(props.variant.get()));
    view()
        .flex_row()
        .items_center()
        .justify_center()
        .px_4()
        .py_3()
        .rounded(move || theme().radius)
        .bg(move || colors.get().0)
        .active(|s| s.bg(move || colors.get().1))
        .style_when(props.disabled, |v| v.opacity(0.5))
        .disabled(props.disabled)
        .role(AccessibilityRole::Button)
        .label(move || {
            props
                .accessibility_label
                .get()
                .unwrap_or_else(|| props.title.get())
        })
        .on_press(move |_: &()| cx.emit(ButtonEvent::Press))
        .child(
            text(props.title)
                .text_size(px(16.0))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(move || colors.get().2),
        )
}

// --- Card: named slots placed around the children --------------------------

/// A surface with an optional header and footer around its content.
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct CardProps {
    /// Above the content.
    pub(crate) header: Prop<Option<Slot>>,
    /// Below the content.
    pub(crate) footer: Prop<Option<Slot>>,
    /// The content.
    pub(crate) children: Prop<Children>,
}

/// A surface ([`CardProps`]): the header in its slot's holder, the
/// children in a padded box.
#[component]
pub(crate) fn Card(props: CardProps) -> impl IntoElement {
    view()
        .border_1()
        .child(props.header.place(|header| header.px_4().pt_4()))
        .child(view().gap_2().p_4().child(props.children))
        .child(
            props
                .footer
                .place(|footer| footer.flex_row().justify_end().px_4().py_3()),
        )
}

// --- Disclosure: a slot the view makes a button ------------------------------

/// A trigger the app passes, made a disclosure button.
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct DisclosureProps {
    /// No presses.
    #[prop(default)]
    pub(crate) disabled: Prop<bool>,
    /// What the user presses.
    pub(crate) trigger: Prop<Option<Slot>>,
}

/// A trigger the view gives a role, the keyboard focus, `disabled`, an
/// expanded state and presses that flip it ([`DisclosureProps`]), as a
/// popup's trigger: they are the app's element's own, so its state classes
/// follow them.
#[component]
pub(crate) fn Disclosure(props: DisclosureProps) -> impl IntoElement {
    let open = signal(false);
    view().child(props.trigger.place(move |trigger| {
        trigger
            .role(AccessibilityRole::Button)
            .focusable(true)
            .disabled(props.disabled)
            .accessibility_state(move || AccessibilityState {
                expanded: Some(open.get()),
                ..AccessibilityState::default()
            })
            .on_press(move |_: &()| open.update(|o| *o = !*o))
    }))
}

// --- Group: children placed one by one --------------------------------------

/// Rows, each JSX child one, divided by hairlines.
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct GroupProps {
    /// The rows, one per child.
    pub(crate) children: Prop<Children>,
}

/// Rows in a box ([`GroupProps`]): every row but the first has a top
/// border.
#[component]
pub(crate) fn Group(props: GroupProps) -> impl IntoElement {
    view().children_each(props.children, move |row, at| {
        view()
            .px_4()
            .py_3()
            .style_when(
                move || !at.is_first(),
                |s| s.border_t_1().border_color(move || theme().border),
            )
            .child(row)
    })
}

// --- ListView: a virtualized list of the app's rows -------------------------

/// A scrolling list of the app's rows, padded and divided.
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct ListViewProps {
    /// The rows.
    pub(crate) items: Items,
    /// `plain` (default): full-width rows; `inset`: rows in a rounded box.
    #[prop(default)]
    pub(crate) variant: Prop<ListViewVariant>,
}

/// How a [`ListView`] shows its rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum ListViewVariant {
    /// Full-width rows.
    #[default]
    Plain,
    /// Rows in a rounded box: the first rounds its top corners, the last
    /// its bottom ones.
    Inset,
}

/// A scrolling list of rows ([`ListViewProps`]): each row in a wrapper of
/// the list's (its padding, its divider, its corners).
#[component]
pub(crate) fn ListView(props: ListViewProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let inset = computed(move || props.variant.get() == ListViewVariant::Inset);
    view().flex_1().list(
        props.items,
        move |list| {
            list.flex_1()
                .estimated_item_size(px(48.0))
                .content_padding(move || if inset.get() { 16.0_f32 } else { 0.0 })
        },
        move |row, at| {
            let radius = move || px(12.0);
            view()
                .px_4()
                .py_3()
                .min_h(px(48.0))
                .style_when(
                    move || !at.is_first(),
                    |v| v.border_t_1().border_color(move || theme().border),
                )
                .style_when(
                    move || inset.get() && at.is_first(),
                    |v| v.rounded_t(radius),
                )
                .style_when(move || inset.get() && at.is_last(), |v| v.rounded_b(radius))
                .child(row)
        },
    )
}

// --- Stepper: own state, timers, and methods on a ref -----------------------

/// A number with − and + buttons, within `min`–`max`; holding a button
/// keeps stepping.
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub(crate) struct StepperProps {
    /// The first value.
    #[prop(default)]
    pub(crate) default_value: Prop<f64>,
    /// The smallest value.
    #[prop(default = 0.0)]
    pub(crate) min: Prop<f64>,
    /// The largest value.
    #[prop(default = 100.0)]
    pub(crate) max: Prop<f64>,
}

/// The events of a [`Stepper`].
#[derive(Debug, Clone, PartialEq, Event)]
pub(crate) enum StepperEvent {
    /// The value changed (the new one).
    Change(f64),
}

/// How long a press is held before it repeats, and how fast it repeats.
const HOLD: Duration = Duration::from_millis(400);
const REPEAT: Duration = Duration::from_millis(80);

/// What JS (and Rust, through a `ComponentRef`) calls on a stepper.
pub(crate) struct StepperApi {
    value: Signal<f64>,
    change: Rc<dyn Fn(f64)>,
}

#[methods]
impl StepperApi {
    /// Sets the value (rounded, within the bounds) and reports it as a
    /// press would.
    pub(crate) fn set_value(&self, value: f64) {
        (self.change)(value);
    }

    /// The value shown.
    pub(crate) fn value(&self) -> f64 {
        self.value.get_untracked()
    }
}

/// A number with − and + buttons ([`StepperProps`]).
#[component(methods = StepperApi)]
pub(crate) fn Stepper(props: StepperProps, cx: Scope<StepperEvent>) -> impl IntoElement {
    let fit = move |value: f64| {
        let (min, max) = (props.min.get_untracked(), props.max.get_untracked());
        value.round().clamp(min.min(max), min.max(max))
    };
    let value = signal(untracked(|| fit(props.default_value.get())));
    let repeat = stored(None::<Spawned<()>>);
    let stop = move || {
        if let Some(task) = repeat.replace(None) {
            task.cancel();
        }
    };
    let change = move |next: f64| {
        let next = fit(next);
        if next == value.get_untracked() {
            stop();
            return;
        }
        value.set(next);
        cx.emit(StepperEvent::Change(next));
    };
    let step = move |direction: f64| change(value.get_untracked() + direction);
    // A press: one step now, more while it is held.
    let press = move |direction: f64| {
        stop();
        step(direction);
        repeat.replace(Some(spawn(async move {
            timer(HOLD).await;
            loop {
                step(direction);
                timer(REPEAT).await;
            }
        })));
    };
    cx.methods(StepperApi {
        value,
        change: Rc::new(change),
    });
    let button = move |label: &'static str, direction: f64| {
        view()
            .size_10()
            .items_center()
            .justify_center()
            .role(AccessibilityRole::Button)
            .on(EventKind::PressDown, move |_: &EventPayload| {
                press(direction)
            })
            .on(EventKind::PressUp, move |_: &EventPayload| stop())
            .child(text(label))
    };
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .child(button("−", -1.0))
        .child(text(move || format!("{}", value.get())))
        .child(button("+", 1.0))
}

// --- TextField: an input the component controls -----------------------------

/// A text input with a clear button; the app controls the text.
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct TextFieldProps {
    /// The text.
    #[prop(default)]
    pub(crate) value: Prop<SharedString>,
}

/// The events of a [`TextField`].
#[derive(Debug, Clone, PartialEq, Event)]
pub(crate) enum TextFieldEvent {
    /// The text changed (the new text).
    Change(String),
}

/// A text input ([`TextFieldProps`]): the clear button comes and goes
/// after the input as the text does.
#[component]
pub(crate) fn TextField(props: TextFieldProps, cx: Scope<TextFieldEvent>) -> impl IntoElement {
    let field = element_ref();
    let change = move |text: String| cx.emit(TextFieldEvent::Change(text));
    view()
        .flex_row()
        .items_center()
        .min_h(px(44.0))
        .px_3()
        .child(
            input()
                .element_ref(&field)
                .flex_1()
                .value(move || props.value.get().as_str().to_owned())
                .on_change(move |text: &str| change(text.to_owned())),
        )
        .child(when(
            move || !props.value.with(|v| v.is_empty()),
            move || {
                view()
                    .size_6()
                    .role(AccessibilityRole::Button)
                    .label("Clear")
                    .on_press(move |_: &()| {
                        change(String::new());
                        field.focus();
                    })
                    .child(text("×"))
            },
        ))
}

// --- Shortcut: a binding of the view's own ---------------------------------

/// Counts the presses of a keystroke the view binds itself.
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct ShortcutProps {
    /// The keystroke, as `on_key` takes it.
    pub(crate) keys: Prop<SharedString>,
}

/// `<keys> <count>` ([`ShortcutProps`]), counted by the view's own binding.
#[component]
pub(crate) fn Shortcut(props: ShortcutProps) -> impl IntoElement {
    let keys = props.keys.get();
    let count = signal(0);
    on_key(&keys, move |_| count.update(|c| *c += 1));
    text(move || format!("{keys} {}", count.get()))
}

// --- Sheet: lazy children, made while it is open ----------------------------

/// A panel over the screen while `open`.
#[derive(Debug, Clone, PartialEq, Props)]
pub(crate) struct SheetProps {
    /// Shown.
    #[prop(default)]
    pub(crate) open: Prop<bool>,
    /// The content: made when the sheet opens and released when it closes.
    #[prop(lazy)]
    pub(crate) children: Children,
}

/// A panel in a modal ([`SheetProps`]).
#[component]
pub(crate) fn Sheet(props: SheetProps) -> impl IntoElement {
    let children = props.children;
    view().child(when(props.open, move || {
        dialog().animation(ModalAnimation::None).child(
            view()
                .absolute()
                .left_0()
                .right_0()
                .bottom_0()
                .p_4()
                .child(children),
        )
    }))
}

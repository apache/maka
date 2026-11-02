//! `Select`: one value chosen from a list of items, with no look of its
//! own.
//!
//! The app's `trigger` opens the list (`listbox.rs`, which `Combobox`
//! shares): a popup anchored to the trigger on the desktops, a sheet at the
//! bottom on touch screens. The select owns the behavior `gpui-base`'s
//! thin `Select` root leaves to `gpui-component`'s styled
//! `SearchableList` (`docs/dev/api-naming.md`): the value (controlled or
//! not), the open state (`Menu`'s: `OpenState`, `onOpenChange` with its
//! reason, `onOpen` / `onClose` / `onCancel`), the keyboard, typeahead,
//! search, sections and accessibility.
//!
//! - **The trigger** is the combobox for screen readers (expanded while
//!   open, its value the chosen item's title, `accessibilityLabel` its
//!   name) and a stop of the keyboard focus unless `disabled`. A press
//!   toggles the list; while it has the keyboard focus (the desktops),
//!   Down, Up, Return and Space open it, and letters and digits choose by
//!   typeahead without opening it, as a native select does.
//! - **Opening** highlights the chosen item; with none, Down (Return,
//!   Space) highlights the first enabled item, Up the last, and a press
//!   nothing until a key or the pointer moves it. The highlighted item is
//!   revealed.
//! - **While open** the keys move the highlight (`Listbox::bind_keys`),
//!   Return chooses it, and Escape, the back button, a press outside or on
//!   the backdrop close it (`onCancel`, then `onOpenChange(false, …)`).
//!   Choosing closes it with `"select"` and reports `onChange` when the
//!   value changes (choosing the chosen item again only closes it: `onChange`
//!   observes changes, as `gpui-kit`'s guides say). Once closed (but by a
//!   press outside, which goes on to what is under the pointer), the
//!   keyboard focus returns to the trigger on the desktops.
//!
//! Typeahead binds one key per character, `a`–`z` and `0`–`9`: the
//! letters and digits of a US layout, without input methods.

use std::rc::Rc;

use nsh_core::{
    element::{
        InputPartStyle, JsHost, JsIn, JsKind, JsOwned, PropError, Style, TextPartStyle, TsTypes,
    },
    keymap::When,
    prelude::*,
};

use crate::{
    listbox::{self, Hooks, Listbox, Move, Parts, Query, Shown},
    popup::{DropdownFrame, OpenChangeReason, OpenState},
};

/// An item of a [`Select`]'s or a `Combobox`'s list.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct SelectItem {
    /// What choosing it sets the value to (`value`, `onChange`): unique
    /// among the items.
    pub value: SharedString,
    /// Its title: what its row shows (unless `renderItem` draws it), what
    /// screen readers say, what search and typeahead match, and the
    /// trigger's value for screen readers while it is chosen.
    pub title: SharedString,
    /// It cannot be chosen: the keys pass over it, presses do nothing,
    /// `disabled:` styles apply and screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: bool,
    /// Its section: adjacent items of one group show under a header with
    /// this title (`renderGroup` draws it otherwise).
    #[prop(skip_none)]
    pub group: Option<SharedString>,
}

impl SelectItem {
    /// An item of `value`, titled `title`.
    pub fn new(value: impl Into<SharedString>, title: impl Into<SharedString>) -> Self {
        Self {
            value: value.into(),
            title: title.into(),
            ..Self::default()
        }
    }

    /// Whether it cannot be chosen ([`SelectItem::disabled`]).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Its section ([`SelectItem::group`]).
    pub fn group(mut self, group: impl Into<SharedString>) -> Self {
        self.group = Some(group.into());
        self
    }
}

/// An item's row as `renderItem` draws it: the item and its state.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct SelectItemState {
    /// The item's `value`.
    pub value: SharedString,
    /// The item's `title`.
    pub title: SharedString,
    /// The item cannot be chosen.
    pub disabled: bool,
    /// It is selected: the select's value, one of the combobox's.
    pub selected: bool,
    /// The keys or the pointer are on it: Return or a press chooses it.
    pub highlighted: bool,
    /// Its index among the `items`.
    pub index: u32,
    /// The item's `group`.
    #[prop(skip_none)]
    pub group: Option<SharedString>,
}

/// A section's header as `renderGroup` draws it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct SelectGroup {
    /// The section's `group`.
    pub title: SharedString,
}

/// A select's `value` prop (TS: `string | null`): left out, the select
/// keeps its own value; `null`, nothing is chosen; a string, the item of
/// that value is.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum SelectValue {
    /// Not set: the select keeps its own value (from `defaultValue`).
    #[default]
    Uncontrolled,
    /// Set by the app: the value of the chosen item, `None` for nothing.
    Controlled(Option<SharedString>),
}

impl From<Option<SharedString>> for SelectValue {
    fn from(value: Option<SharedString>) -> Self {
        Self::Controlled(value)
    }
}

impl From<SharedString> for SelectValue {
    fn from(value: SharedString) -> Self {
        Self::Controlled(Some(value))
    }
}

impl From<&'static str> for SelectValue {
    fn from(value: &'static str) -> Self {
        Self::Controlled(Some(value.into()))
    }
}

impl From<String> for SelectValue {
    fn from(value: String) -> Self {
        Self::Controlled(Some(value.into()))
    }
}

impl JsValue for SelectValue {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string | null".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::Undefined => Ok(Self::Uncontrolled),
            JsKind::Null => Ok(Self::Controlled(None)),
            _ => value
                .as_string()
                .map(|s| Self::Controlled(Some(s.into())))
                .ok_or_else(|| value.expected("a string or null")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Self::Uncontrolled => Ok(JsOwned::new(host, host.undefined())),
            Self::Controlled(value) => value.to_js(host),
        }
    }
}

/// The props of [`Select`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SelectProps {
    /// The items, in order.
    #[prop(default)]
    pub items: Prop<Vec<SelectItem>>,
    /// The chosen item's `value` (controlled), `null` for none: the app
    /// owns it and sets it in `onChange`. Without it the select keeps its
    /// own value.
    #[prop(default)]
    pub value: Prop<SelectValue>,
    /// The value at first, while `value` is not set.
    pub default_value: Prop<Option<SharedString>>,
    /// Open (controlled): the app owns the value and changes it in
    /// `onOpenChange`. Without it the select keeps its own state.
    pub open: Prop<Option<bool>>,
    /// Open at first, while `open` is not set.
    #[prop(default)]
    pub default_open: Prop<bool>,
    /// A search field above the items filters them by title (ignoring
    /// case); `empty` shows while none matches.
    #[prop(default)]
    pub searchable: Prop<bool>,
    /// The search field's placeholder.
    pub search_placeholder: Prop<Option<SharedString>>,
    /// A clear button while an item is chosen (`gpui-component`'s
    /// `cleanable`): a press clears the value, reported by
    /// `onChange(null)`, and leaves the list closed.
    #[prop(default)]
    pub cleanable: Prop<bool>,
    /// It does not open: no presses, no keyboard focus, `disabled:` styles
    /// apply to the trigger and screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers call it: what the choice is about.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// Desktops: the side of the trigger the list goes on (default
    /// `"bottom"`); the other side when only that one has room.
    #[prop(default)]
    pub placement: Prop<Placement>,
    /// Desktops: how it lines up with the trigger (default `"start"`).
    #[prop(default = Align::Start)]
    pub align: Prop<Align>,
    /// Desktops: the gap between the trigger and the list.
    #[prop(default)]
    pub offset: Prop<Points>,
    /// Desktops: the distance it keeps from the edges of the safe area.
    #[prop(default)]
    pub margin: Prop<Points>,
    /// The classes of the popup (desktops: at least as wide as the
    /// trigger, never taller than the room beside it) or of the sheet
    /// (touch screens) the list is in.
    pub popup_class: Prop<Option<SharedString>>,
    /// The inline style of the popup or sheet, over its classes.
    #[prop(default)]
    pub popup_style: Prop<Style>,
    /// Touch screens: the classes of the backdrop behind the sheet
    /// (pressing it closes the list).
    pub backdrop_class: Prop<Option<SharedString>>,
    /// The inline style of the backdrop, over its classes.
    #[prop(default)]
    pub backdrop_style: Prop<Style>,
    /// The classes of the list, the scroll view of the rows.
    pub list_class: Prop<Option<SharedString>>,
    /// The inline style of the list, over its classes.
    #[prop(default)]
    pub list_style: Prop<Style>,
    /// The classes of each item's row: `focus:` while highlighted (the keys
    /// or the pointer are on it), `selected:` while chosen, `disabled:`
    /// while it cannot be.
    pub item_class: Prop<Option<SharedString>>,
    /// The inline style of each item's row, over its classes: its text
    /// styles too (`color`, `fontSize`), which its title inherits.
    #[prop(default)]
    pub item_style: Prop<TextPartStyle>,
    /// The classes of each section's header.
    pub group_class: Prop<Option<SharedString>>,
    /// The inline style of each section's header, over its classes.
    #[prop(default)]
    pub group_style: Prop<Style>,
    /// The classes of the search field.
    pub search_class: Prop<Option<SharedString>>,
    /// The inline style of the search field, over its classes: its text
    /// styles too (`color`, `fontSize`, `placeholderColor`).
    #[prop(default)]
    pub search_style: Prop<InputPartStyle>,
    /// The classes of the clear button (with `cleanable`, while an item is
    /// chosen); `disabled:` with the select. It comes after the trigger,
    /// which it is not part of: the app places it, over the trigger's end
    /// (`absolute`) or beside it.
    pub clear_button_class: Prop<Option<SharedString>>,
    /// The inline style of the clear button, over its classes.
    #[prop(default)]
    pub clear_button_style: Prop<Style>,
    /// The content of the clear button: a cross, an icon.
    pub clear_button: Prop<Option<Slot>>,
    /// What screen readers call the clear button (the app's words).
    pub clear_button_accessibility_label: Prop<Option<SharedString>>,
    /// What opens the list when pressed: the app's element, which the
    /// list is placed against.
    pub trigger: Prop<Option<Slot>>,
    /// What the list shows while no item does (a search that matches
    /// nothing, no items).
    pub empty: Prop<Option<Slot>>,
    /// An item's row drawn by the app, for the rows in view; without it
    /// a row shows the item's title.
    pub render_item: Prop<Option<Renderer<SelectItemState>>>,
    /// A section's header drawn by the app; without it a header shows its
    /// title.
    pub render_group: Prop<Option<Renderer<SelectGroup>>>,
}

/// The events of a [`Select`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum SelectEvent {
    /// The user chose another item (a press, Return or Space, typeahead on
    /// the trigger): its value; `null` when the clear button cleared it.
    /// Set `value` to follow it.
    #[args(value)]
    Change(Option<SharedString>),
    /// The list opened or closed (by the trigger or its keys, a choice, a
    /// press outside or on the backdrop, Escape or back), with why: set
    /// `open` to follow it.
    #[args(open, reason)]
    OpenChange(bool, OpenChangeReason),
    /// The list is shown (a sheet once it came in).
    Open,
    /// The list is gone (a sheet once it went; also when the app closed
    /// it).
    Close,
    /// The user tried to close the list without choosing (Escape or back,
    /// a press outside or on the backdrop).
    Cancel,
}

/// The value, the app's when it sets one, else the select's own.
#[derive(Clone, Copy)]
struct ValueState {
    controlled: Prop<SelectValue>,
    own: Signal<Option<SharedString>>,
}

impl ValueState {
    fn new(value: Prop<SelectValue>, default_value: Prop<Option<SharedString>>) -> Self {
        Self {
            controlled: value,
            own: signal(default_value.get_untracked()),
        }
    }

    /// The chosen value (tracked).
    fn get(self) -> Option<SharedString> {
        match self.controlled.get() {
            SelectValue::Uncontrolled => self.own.get(),
            SelectValue::Controlled(value) => value,
        }
    }

    fn get_untracked(self) -> Option<SharedString> {
        match self.controlled.get_untracked() {
            SelectValue::Uncontrolled => self.own.get_untracked(),
            SelectValue::Controlled(value) => value,
        }
    }

    /// The user chose `value` (`None`: cleared it): its own value follows
    /// when the app does not control it; whether it is a change to report.
    fn choose(self, value: Option<SharedString>) -> bool {
        if self.get_untracked() == value {
            return false;
        }
        if self.controlled.get_untracked() == SelectValue::Uncontrolled {
            self.own.set(value);
        }
        true
    }
}

/// What asked for the list to open, which says what it highlights when
/// no item is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Opening {
    /// A press (or the app): nothing.
    Press,
    /// Down, Return or Space: the first enabled item.
    Down,
    /// Up: the last.
    Up,
}

/// One value chosen from a list of items (`items`: a value and a title
/// each, optionally disabled or in a section): the app's `trigger` opens
/// the list, as a popup at the trigger on the desktops (at least as wide,
/// never taller than the room beside it) and as a sheet at the bottom on
/// phones and tablets. The keys move the highlight (Up, Down, Home, End,
/// Page Up and Down; letters and digits by typeahead), Return, Space or a
/// press choose, Escape, back and a press outside close it; with
/// `searchable` a field above the items filters them, with `cleanable` a
/// button after the trigger clears the value. The value is `value` and
/// `onChange` (or the select's own, from `defaultValue`), the open state
/// `open` and `onOpenChange` (or its own). It looks like
/// nothing: the app styles the trigger, the popup (`popupClass`), the list
/// (`listClass`), the rows (`itemClass`, with `focus:` for the highlighted
/// row and `selected:` for the chosen one) and the headers (`groupClass`),
/// or draws them (`renderItem`, `renderGroup`).
#[component]
pub fn Select(props: SelectProps, cx: Scope<SelectEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    let value = ValueState::new(props.value, props.default_value);
    let current = computed(move || value.get());
    let lb = Listbox::new(props.items, props.searchable, Query::own());
    // The app's element in the slot (or the view around what a Rust parent
    // fills it with): the combobox, what takes the keyboard, and what the
    // list is placed against.
    let anchor = element_ref();
    // Its width, once it is laid out.
    let width = signal(None::<Points>);
    let focused = signal(false);
    let opening = stored(Opening::Press);
    // Why it closed last: a press outside leaves the focus where it went.
    let closed_by = stored(None::<OpenChangeReason>);
    let change: Rc<dyn Fn(bool, OpenChangeReason)> = Rc::new(move |next, reason| {
        if next && props.disabled.get_untracked() {
            return;
        }
        if open.get_untracked() == next {
            return;
        }
        if !next {
            closed_by.replace(Some(reason));
        }
        // Reported before the state follows: the popup has no motion on
        // the desktops, so `onOpen` / `onClose` come in this same turn,
        // after it (as `Menu`'s order says: `onCancel`, `onOpenChange`,
        // then the lifecycle).
        open.request(next, || cx.emit(SelectEvent::OpenChange(next, reason)));
    });
    // The value of item `item`, if it can be chosen.
    let choosable = move |item: usize| {
        props.items.with_untracked(|items| {
            items
                .get(item)
                .filter(|i| !i.disabled)
                .map(|i| i.value.clone())
        })
    };
    let choose: Rc<dyn Fn(usize)> = {
        let change = change.clone();
        Rc::new(move |item| {
            let Some(next) = choosable(item) else {
                return;
            };
            if value.choose(Some(next.clone())) {
                cx.emit(SelectEvent::Change(Some(next)));
            }
            change(false, OpenChangeReason::Select);
        })
    };
    let dismiss: Rc<dyn Fn(OpenChangeReason)> = {
        let change = change.clone();
        Rc::new(move |reason| {
            cx.emit(SelectEvent::Cancel);
            change(false, reason);
        })
    };

    // Each opening starts on the chosen item, else as it was asked for.
    let was = stored(false);
    effect(move || {
        let now = open.get();
        if was.replace(now) == now {
            return;
        }
        untracked(|| {
            if !now {
                lb.closed();
                return;
            }
            let how = opening.replace(Opening::Press);
            let chosen = value.get_untracked();
            lb.opened(|shown: &Shown, items: &[SelectItem]| {
                let chosen = chosen.and_then(|v| {
                    items
                        .iter()
                        .position(|i| i.value == v && !i.disabled)
                        .filter(|&i| shown.row_of(i).is_some())
                });
                chosen.or_else(|| match how {
                    Opening::Press => None,
                    Opening::Down => shown.step(None, Move::First),
                    Opening::Up => shown.step(None, Move::Last),
                })
            });
        });
    });
    lb.bind_keys(move || open.get(), choose.clone());

    // The trigger's keys while it has the keyboard focus and the list is
    // closed: open it.
    {
        let change = change.clone();
        effect(move || {
            if !focused.get() || open.get() || props.disabled.get() {
                return;
            }
            let keys = [
                ("down", Opening::Down),
                ("up", Opening::Up),
                ("enter", Opening::Down),
                ("space", Opening::Down),
            ];
            for (key, how) in keys {
                let change = change.clone();
                on_key_with(
                    key,
                    KeyOptions {
                        when: When::NotEditing,
                        repeat: false,
                    },
                    move |_| {
                        opening.replace(how);
                        change(true, OpenChangeReason::TriggerPress);
                    },
                );
            }
        });
    }
    // Typeahead: on the focused trigger it chooses, in the open list
    // without a search field it highlights. One binding for both, so
    // opening and closing the list binds nothing again.
    listbox::bind_typeahead(
        move || {
            if open.get() {
                !props.searchable.get()
            } else {
                focused.get() && !props.disabled.get()
            }
        },
        Rc::new(move |c| {
            if open.get_untracked() {
                lb.type_ahead(c);
                return;
            }
            let from = value.get_untracked().and_then(|v| {
                props
                    .items
                    .with_untracked(|items| items.iter().position(|i| i.value == v))
            });
            let Some(next) = lb.typed(c, from).and_then(choosable) else {
                return;
            };
            if value.choose(Some(next.clone())) {
                cx.emit(SelectEvent::Change(Some(next)));
            }
        }),
    );

    let hooks = Hooks {
        open: Rc::new(move || open.get()),
        selected: Rc::new(move |v| current.with(|c| c.as_ref() == Some(v))),
        choose,
        // Its query is the search field's own.
        query_changed: Rc::new(|_| {}),
        dismiss,
        shown: Rc::new(move |shown| {
            if shown {
                cx.emit(SelectEvent::Open);
                return;
            }
            cx.emit(SelectEvent::Close);
            // The keyboard goes back to the trigger, unless a press outside
            // took it somewhere else.
            if is_desktop() && closed_by.replace(None) != Some(OpenChangeReason::PressOutside) {
                anchor.focus();
            }
        }),
    };
    let parts = Parts {
        frame: DropdownFrame {
            placement: props.placement,
            align: props.align,
            offset: props.offset,
            margin: props.margin,
            popup_class: props.popup_class,
            popup_style: props.popup_style,
            backdrop_class: props.backdrop_class,
            backdrop_style: props.backdrop_style,
        },
        list_class: props.list_class,
        list_style: props.list_style,
        item_class: props.item_class,
        item_style: props.item_style,
        group_class: props.group_class,
        group_style: props.group_style,
        search_class: props.search_class,
        search_style: props.search_style,
        search_placeholder: props.search_placeholder,
        render_item: props.render_item,
        render_group: props.render_group,
        empty: props.empty,
        footer: None,
    };
    let toggle = change;
    // Bound on the slot: in a TSX app they go to the app's element in it
    // (`docs/dev/components.md` "Named slots"), so its own `active:`,
    // `focus:` and `disabled:` classes follow the select.
    let trigger = props.trigger.place(move |t| {
        let toggle = toggle.clone();
        t.element_ref(&anchor)
            .role(AccessibilityRole::Combobox)
            .optional_label(props.accessibility_label)
            .disabled(props.disabled)
            .focusable(move || !props.disabled.get())
            .accessibility_state(move || AccessibilityState {
                expanded: Some(open.get()),
                disabled: props.disabled.get(),
                ..AccessibilityState::default()
            })
            .accessibility_value(move || {
                current.with(|v| {
                    props
                        .items
                        .with(|items| listbox::selected_titles(items, v.as_slice()))
                })
            })
            .on_layout(move |frame: &Bounds<Points>| width.set(Some(frame.size.width)))
            .on_focus(move || focused.set(true))
            .on_blur(move || focused.set(false))
            .on_press(move || {
                opening.replace(Opening::Press);
                toggle(!open.get_untracked(), OpenChangeReason::TriggerPress);
            })
    });
    // A sibling of the trigger, so a press on it never opens the list; not
    // a stop of Tab (`gpui-component`'s `tab_stop(false)`).
    let clear = when(
        move || props.cleanable.get() && current.with(Option::is_some),
        move || {
            view()
                .role(AccessibilityRole::Button)
                .optional_label(props.clear_button_accessibility_label)
                .focusable(false)
                .disabled(props.disabled)
                .on_press(move || {
                    if value.choose(None) {
                        cx.emit(SelectEvent::Change(None));
                    }
                })
                .app_class(props.clear_button_class)
                .inline_style(props.clear_button_style)
                .child(props.clear_button.place(|c| c))
        },
    );
    view()
        .child(trigger)
        .child(clear)
        .child(listbox::present(lb, anchor, width, parts, hooks))
}

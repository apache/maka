//! `Combobox`: one value or several chosen from a list of items, with no
//! look of its own (`gpui-component`'s `Combobox`).
//!
//! It is `Select`'s sibling: the same list (`listbox.rs`: rows, sections,
//! search, the highlight, typeahead, the popup or sheet), the same open
//! state (`OpenState`, `onOpenChange` with its reason, `onOpen` / `onClose`
//! / `onCancel`) and the same trigger, the app's. What differs:
//!
//! - **The value is a list** (`value: string[]`). With `multiple`, a
//!   choice toggles the item in it and the list stays open; without, it
//!   replaces it and the list closes. `onChange({ value })` reports each
//!   change; `onConfirm({ value })` the value as it is when the list closes
//!   (every close, once per opening, as `gpui-component`'s `Confirm`).
//!   Cmd+Return (Ctrl+Return off Apple's) confirms and closes, as
//!   `gpui-base`'s secondary `Confirm`.
//! - **The query is the app's** when it sets `query`, reported with
//!   `onQueryChange({ query })` (`gpui-component`'s `query` / `set_query`);
//!   each opening starts from `defaultQuery`, else empty.
//! - **A footer** (`footer`) shows below the rows.
//! - The trigger takes no typeahead while closed: its keys open the list.

use std::rc::Rc;

use nsh_core::{
    element::{InputPartStyle, Style, TextPartStyle},
    keymap::When,
    prelude::*,
};

use crate::{
    SelectGroup, SelectItem, SelectItemState,
    listbox::{self, Footer, Hooks, Listbox, Move, Parts, Query, Row},
    popup::{OpenChangeReason, OpenState},
};

/// The props of [`Combobox`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct ComboboxProps {
    /// The items, in order.
    #[prop(default)]
    pub items: Prop<Vec<SelectItem>>,
    /// Several values: a choice toggles the item in the value and the list
    /// stays open. Without it a choice replaces the value and closes it.
    #[prop(default)]
    pub multiple: Prop<bool>,
    /// The selected items' values (controlled): the app owns them and sets
    /// the ones `onChange` reports. Without it the combobox keeps its own.
    pub value: Prop<Option<Vec<SharedString>>>,
    /// The value at first, while `value` is not set.
    #[prop(default)]
    pub default_value: Prop<Vec<SharedString>>,
    /// Open (controlled): the app owns it and changes it in
    /// `onOpenChange`. Without it the combobox keeps its own state.
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
    /// The query (controlled): the app owns it and sets the one
    /// `onQueryChange` reports. Without it the search field keeps its own.
    pub query: Prop<Option<SharedString>>,
    /// The query each opening starts with, while `query` is not set.
    pub default_query: Prop<Option<SharedString>>,
    /// A clear button while an item is selected (`gpui-component`'s
    /// `cleanable`): a press clears the value, reported by
    /// `onChange({ value: [] })`, and leaves the list as it is.
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
    /// or the pointer are on it), `selected:` while selected, `disabled:`
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
    /// The classes of the footer, below the rows.
    pub footer_class: Prop<Option<SharedString>>,
    /// The inline style of the footer, over its classes.
    #[prop(default)]
    pub footer_style: Prop<Style>,
    /// The classes of the clear button (with `cleanable`, while an item is
    /// selected); `disabled:` with the combobox. It comes after the
    /// trigger, which it is not part of: the app places it.
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
    /// What shows below the rows (`gpui-component`'s `footer`): an action,
    /// a count.
    pub footer: Prop<Option<Slot>>,
    /// An item's row drawn by the app, for the rows in view; without it
    /// a row shows the item's title.
    pub render_item: Prop<Option<Renderer<SelectItemState>>>,
    /// A section's header drawn by the app; without it a header shows its
    /// title.
    pub render_group: Prop<Option<Renderer<SelectGroup>>>,
}

/// The events of a [`Combobox`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum ComboboxEvent {
    /// The value changed (a choice, a toggle, the clear button): the
    /// selected items' values. Set `value` to follow it.
    #[args(value)]
    Change(Vec<SharedString>),
    /// The list closed (`gpui-component`'s `Confirm`): the value as it is
    /// then, once per opening.
    #[args(value)]
    Confirm(Vec<SharedString>),
    /// The user typed in the search field: the query. Set `query` to
    /// follow it.
    #[args(query)]
    QueryChange(SharedString),
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
    /// The user tried to close the list without a choice that closes it
    /// (Escape or back, a press outside or on the backdrop).
    Cancel,
}

/// The value, the app's when it sets one, else the combobox's own.
#[derive(Clone, Copy)]
struct ValueState {
    controlled: Prop<Option<Vec<SharedString>>>,
    own: Signal<Vec<SharedString>>,
}

impl ValueState {
    fn new(value: Prop<Option<Vec<SharedString>>>, default: Prop<Vec<SharedString>>) -> Self {
        Self {
            controlled: value,
            own: signal(default.get_untracked()),
        }
    }

    /// The value (tracked).
    fn get(self) -> Vec<SharedString> {
        self.controlled.get().unwrap_or_else(|| self.own.get())
    }

    fn get_untracked(self) -> Vec<SharedString> {
        self.controlled
            .get_untracked()
            .unwrap_or_else(|| self.own.get_untracked())
    }

    /// The user set the value to `next`: its own follows when the app does
    /// not control it.
    fn set(self, next: Vec<SharedString>) {
        if self.controlled.get_untracked().is_none() {
            self.own.set(next);
        }
    }
}

/// What asked for the list to open, which says what it highlights when
/// no item is selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Opening {
    /// A press (or the app): nothing.
    Press,
    /// Down, Return or Space: the first enabled item.
    Down,
    /// Up: the last.
    Up,
}

/// One value or several chosen from a list of items (`items`: a value and
/// a title each, optionally disabled or in a section): the app's `trigger`
/// opens the list, as a popup at the trigger on the desktops and as a sheet
/// at the bottom on phones and tablets. The keys move the highlight (Up,
/// Down, Home, End, Page Up and Down; letters and digits by typeahead
/// without a search field), Return, Space or a press choose (with
/// `multiple`, toggle and stay open), Cmd+Return confirms and closes,
/// Escape, back and a press outside close it; with `searchable` a field
/// above the items filters them, with `cleanable` a button after the
/// trigger clears the value, and `footer` shows below the rows. The value
/// is `value` and `onChange` (or the combobox's own, from `defaultValue`),
/// `onConfirm` tells it as the list closes. It looks like nothing: the app
/// styles every part or draws the rows (`renderItem`, `renderGroup`).
#[component]
pub fn Combobox(props: ComboboxProps, cx: Scope<ComboboxEvent>) -> impl IntoElement {
    let open = OpenState::new(props.open, props.default_open);
    let value = ValueState::new(props.value, props.default_value);
    let current = computed(move || value.get());
    // The value as the user last left it: what toggles start from and what
    // closing confirms. The app's value reaches the props a turn after its
    // `onChange` handler set it; until then this is ahead of it, and a
    // value the app sets is taken as it comes.
    let latest = stored(value.get_untracked());
    effect(move || {
        let now = current.get();
        latest.replace(now);
    });
    let lb = Listbox::new(
        props.items,
        props.searchable,
        Query {
            controlled: props.query,
            default: props.default_query,
        },
    );
    // The app's element in the slot: the combobox, what takes the
    // keyboard, and what the list is placed against.
    let anchor = element_ref();
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
        open.request(next, || {
            cx.emit(ComboboxEvent::OpenChange(next, reason));
        });
    });
    let report = move |next: Vec<SharedString>| {
        if latest.with(|l| *l == next) {
            return;
        }
        latest.replace(next.clone());
        value.set(next.clone());
        cx.emit(ComboboxEvent::Change(next));
    };
    // Item `item`'s value, if it can be chosen.
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
            let Some(chosen) = choosable(item) else {
                return;
            };
            if props.multiple.get_untracked() {
                let mut next = latest.with(|l| l.clone());
                match next.iter().position(|v| *v == chosen) {
                    Some(at) => {
                        next.remove(at);
                    }
                    None => next.push(chosen),
                }
                report(next);
            } else {
                report(vec![chosen]);
                change(false, OpenChangeReason::Select);
            }
        })
    };
    let dismiss: Rc<dyn Fn(OpenChangeReason)> = {
        let change = change.clone();
        Rc::new(move |reason| {
            cx.emit(ComboboxEvent::Cancel);
            change(false, reason);
        })
    };

    // Each opening starts on the first selected item shown, else as it was
    // asked for; each close confirms the value.
    let was = stored(false);
    effect(move || {
        let now = open.get();
        if was.replace(now) == now {
            return;
        }
        untracked(|| {
            if !now {
                lb.closed();
                cx.emit(ComboboxEvent::Confirm(latest.with(|l| l.clone())));
                return;
            }
            let how = opening.replace(Opening::Press);
            let selected = value.get_untracked();
            lb.opened(|rows: &[Row], items: &[SelectItem]| {
                let first = items.iter().enumerate().position(|(at, i)| {
                    !i.disabled
                        && selected.contains(&i.value)
                        && listbox::row_of(rows, at).is_some()
                });
                first.or_else(|| match how {
                    Opening::Press => None,
                    Opening::Down => listbox::step(rows, items, None, Move::First),
                    Opening::Up => listbox::step(rows, items, None, Move::Last),
                })
            });
        });
    });
    lb.bind_keys(move || open.get(), choose.clone());
    // Cmd+Return (Ctrl+Return off Apple's): the value as it is, and close
    // (`gpui-base`'s secondary `Confirm`).
    {
        let change = change.clone();
        effect(move || {
            if !open.get() {
                return;
            }
            let change = change.clone();
            on_key_with(
                "mod+enter",
                KeyOptions {
                    when: When::Always,
                    repeat: false,
                },
                move |_| change(false, OpenChangeReason::Select),
            );
        });
    }

    // The trigger's keys while it has the keyboard focus and the list is
    // closed: they open it.
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

    let hooks = Hooks {
        open: Rc::new(move || open.get()),
        selected: Rc::new(move |v| current.with(|c| c.contains(v))),
        choose,
        query_changed: Rc::new(move |query: &str| {
            cx.emit(ComboboxEvent::QueryChange(query.to_owned().into()));
        }),
        dismiss,
        shown: Rc::new(move |shown| {
            if shown {
                cx.emit(ComboboxEvent::Open);
                return;
            }
            cx.emit(ComboboxEvent::Close);
            if is_desktop() && closed_by.replace(None) != Some(OpenChangeReason::PressOutside) {
                anchor.focus();
            }
        }),
    };
    let parts = Parts {
        placement: props.placement,
        align: props.align,
        offset: props.offset,
        margin: props.margin,
        popup_class: props.popup_class,
        popup_style: props.popup_style,
        backdrop_class: props.backdrop_class,
        backdrop_style: props.backdrop_style,
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
        footer: Some(Footer {
            content: props.footer,
            class: props.footer_class,
            style: props.footer_style,
        }),
    };
    let toggle = change;
    // Bound on the slot: in a TSX app they go to the app's element in it,
    // so its own `active:`, `focus:` and `disabled:` classes follow.
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
        move || props.cleanable.get() && current.with(|v| !v.is_empty()),
        move || {
            view()
                .role(AccessibilityRole::Button)
                .optional_label(props.clear_button_accessibility_label)
                .focusable(false)
                .disabled(props.disabled)
                .on_press(move || report(Vec::new()))
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

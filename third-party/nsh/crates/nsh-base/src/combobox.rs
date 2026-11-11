//! `Combobox`: one value or several chosen from a list of items, with no
//! look of its own (`gpui-component`'s `Combobox`).
//!
//! It is `Select`'s sibling: the same list (`listbox.rs`: rows, sections,
//! search, the highlight, typeahead, the popup or sheet), the same open
//! state (`OpenState`, `onOpenChange` with its reason, `onOpen` / `onClose`
//! / `onCancel`). What differs:
//!
//! - **The trigger is an input** (shadcn/ui's `ComboboxInput`): a text
//!   field in the root's row, between the app's `prefix` (chips, an icon)
//!   and `suffix`, with the clear button and the app's `triggerButton` (a
//!   chevron) after it. Typing opens the list and filters it, Down and Up
//!   open it, a press on the input or the trigger button opens and closes
//!   it in every idiom (`gpui-component`'s trigger click); a tap that
//!   focuses the input on a touch screen opens it once. With one value the input shows
//!   its title, selected while it gets the focus, so typing replaces it.
//!   Tab or Shift+Tab while the list is open closes it with `"focus"`, and
//!   the focus moves on as the key moves it (as `Select`'s). The list is as
//!   wide as the root.
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

use std::rc::Rc;

use nsh_core::{
    element::{InputPartStyle, Style, TextPartStyle, input},
    keymap::When,
    prelude::*,
};

use crate::{
    SelectEntry, SelectGroup, SelectItem,
    listbox::{self, Footer, Hooks, Listbox, Move, Parts, Query, Shown},
    popup::{DropdownFrame, OpenChangeReason, OpenState},
    terminal::{CLEAR, SELECT_ARROW, is_terminal, mark_slot},
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
    /// What the input shows while it is empty.
    pub placeholder: Prop<Option<SharedString>>,
    /// The query (controlled): what the user typed in the input, which
    /// filters the items by title (ignoring case; `empty` shows while none
    /// matches). The app owns it and sets the one `onQueryChange` reports.
    /// Without it the input keeps its own.
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
    /// while it cannot be; with `group`, its content follows them
    /// (`group-focus:`, `group-selected:`, `group-disabled:`).
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
    /// The classes of the input, the text field typing filters the items
    /// with: `focus:` while it edits, `disabled:` with the combobox.
    pub input_class: Prop<Option<SharedString>>,
    /// The inline style of the input, over its classes: its text styles
    /// too (`color`, `fontSize`, `placeholderColor`).
    #[prop(default)]
    pub input_style: Prop<InputPartStyle>,
    /// The id UI tests find the input by (TS `inputTestID`, as `testID`
    /// names the combobox's own view).
    #[prop(rename = "inputTestID")]
    pub input_test_id: Prop<Option<SharedString>>,
    /// The classes of the footer, below the rows.
    pub footer_class: Prop<Option<SharedString>>,
    /// The inline style of the footer, over its classes.
    #[prop(default)]
    pub footer_style: Prop<Style>,
    /// The classes of the clear button (with `cleanable`, while an item is
    /// selected), after the input; `disabled:` with the combobox.
    pub clear_button_class: Prop<Option<SharedString>>,
    /// The inline style of the clear button, over its classes.
    #[prop(default)]
    pub clear_button_style: Prop<Style>,
    /// The content of the clear button: a cross, an icon.
    pub clear_button: Prop<Option<Slot>>,
    /// What screen readers call the clear button (the app's words).
    pub clear_button_accessibility_label: Prop<Option<SharedString>>,
    /// The trigger button, after the input and the clear button: the
    /// app's element (a chevron), which a press makes open and close the
    /// list (shadcn/ui's `ComboboxTrigger`); its `active:` and `disabled:`
    /// classes follow. Without it typing and the arrow keys open the list.
    pub trigger_button: Prop<Option<Slot>>,
    /// Content before the input: the chosen items as chips (with
    /// `multiple`), an icon (`gpui-component`'s `prefix`).
    pub prefix: Prop<Option<Slot>>,
    /// Content after the trigger button (`gpui-component`'s `suffix`).
    pub suffix: Prop<Option<Slot>>,
    /// What the list shows while no item does (a search that matches
    /// nothing, no items).
    pub empty: Prop<Option<Slot>>,
    /// What shows below the rows (`gpui-component`'s `footer`): an action,
    /// a count.
    pub footer: Prop<Option<Slot>>,
    /// An item's row drawn by the app from what the item is, never its
    /// state (the row's classes are), once per item in view; without it a
    /// row shows the item's title.
    pub render_item: Prop<Option<Renderer<SelectEntry>>>,
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
    /// The user typed in the input: the query. Set `query` to
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
/// a title each, optionally disabled or in a section), typed into an input
/// that filters them: typing, Down or Up, or a press on `triggerButton`
/// opens the list, as a popup under the field and as wide as it on the
/// desktops and as a sheet at the bottom on phones and tablets. The keys move the highlight (Up,
/// Down, Home, End, Page Up and Down), Return or a press choose (with
/// `multiple`, toggle and stay open), Cmd+Return confirms and closes,
/// Escape, back and a press outside close it; with `cleanable` a button
/// after the input clears the value, and `footer` shows below the rows. The value
/// is `value` and `onChange` (or the combobox's own, from `defaultValue`),
/// `onConfirm` tells it as the list closes. It looks like nothing: the app
/// styles every part or draws the rows (`renderItem`, `renderGroup`).
///
/// In a terminal the input is one row as wide as the room left (no
/// `inputClass` / `inputStyle`), then the terminal's own ` ×` in place of
/// `clearButton` and ` ▾` in place of `triggerButton`, on the input's row;
/// the list's rows are the items' titles from the row's start, with `✓` at
/// the row's end while chosen, one full-width row each, which the terminal marks while highlighted (no
/// `renderItem`, `renderGroup` or row classes there) ([`crate::terminal`]).
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
    // The input is the search field: the keys work while it edits.
    let lb = Listbox::new(
        props.items,
        Prop::new(true),
        Query {
            controlled: props.query,
            default: props.default_query,
        },
    );
    // The combobox's box, which the list is placed against and as wide as;
    // the input in it takes the keyboard.
    let anchor = element_ref();
    let field = element_ref();
    // Something was typed since the list opened: the input shows the
    // query, else (one value) the chosen item's title.
    let typed = signal(false);
    // What was typed while the list was closed, for it once it opens.
    let pending = stored(None::<String>);
    // The chosen title the first typed characters followed: while the
    // input still holds it (its value not written back yet), it is not
    // part of the query.
    let replaced = stored(None::<String>);
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
                typed.set(false);
                replaced.replace(None);
                cx.emit(ComboboxEvent::Confirm(latest.with(|l| l.clone())));
                return;
            }
            let how = opening.replace(Opening::Press);
            let selected = value.get_untracked();
            lb.opened(|shown: &Shown, items: &[SelectItem]| {
                let first = items.iter().enumerate().position(|(at, i)| {
                    !i.disabled && selected.contains(&i.value) && shown.row_of(at).is_some()
                });
                first.or_else(|| match how {
                    Opening::Press => None,
                    Opening::Down => shown.step(None, Move::First),
                    Opening::Up => shown.step(None, Move::Last),
                })
            });
            // Typing opened it: the query is what was typed.
            typed.set(false);
            if let Some(text) = pending.replace(None) {
                typed.set(true);
                lb.edited(&text);
            }
        });
    });
    lb.bind_keys(move || open.get(), choose.clone());
    listbox::bind_typeahead(
        move || open.get() && !lb.searchable.get(),
        Rc::new(move |c| lb.type_ahead(c)),
    );
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
                    ..Default::default()
                },
                move |_| change(false, OpenChangeReason::Select),
            );
        });
    }

    // The input's arrows while the list is closed: they open it (Return
    // and Space are the input's).
    {
        let change = change.clone();
        effect(move || {
            if !focused.get() || open.get() || props.disabled.get() {
                return;
            }
            let keys = [("down", Opening::Down), ("up", Opening::Up)];
            for (key, how) in keys {
                let change = change.clone();
                on_key_with(
                    key,
                    KeyOptions {
                        when: When::Always,
                        repeat: false,
                        ..Default::default()
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
            // Back to the input, unless a press outside or Tab took the
            // keyboard somewhere else.
            let by = closed_by.replace(None);
            if is_desktop()
                && !matches!(
                    by,
                    Some(OpenChangeReason::PressOutside | OpenChangeReason::Focus)
                )
            {
                field.focus();
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
        search: None,
        render_item: props.render_item,
        render_group: props.render_group,
        empty: props.empty,
        footer: Some(Footer {
            content: props.footer,
            class: props.footer_class,
            style: props.footer_style,
        }),
        cover: None,
    };
    // The input: the chosen item's title (one value) until the user types,
    // then the query, which filters the items.
    let chosen_title = move || {
        current.with(|v| {
            props.items.with(|items| {
                v.first()
                    .and_then(|v| items.iter().find(|i| i.value == *v))
                    .map(|i| i.title.to_string())
                    .unwrap_or_default()
            })
        })
    };
    let shown_text = move || {
        if typed.get() || props.multiple.get() {
            lb.query()
        } else {
            chosen_title()
        }
    };
    let input_change = change.clone();
    let focus_change = change.clone();
    let press_change = change.clone();
    // The focus a press gave opened the list (a touch screen): that
    // press's own report does not close it again.
    let focus_opened = stored(false);
    let terminal = is_terminal();
    let text_field = input()
        .element_ref(&field)
        .value(shown_text)
        .placeholder(move || {
            props
                .placeholder
                .get()
                .map(|p| p.to_string())
                .unwrap_or_default()
        })
        .auto_correct(false)
        .readonly(move || props.disabled.get())
        .disabled(props.disabled)
        .role(AccessibilityRole::Combobox)
        .optional_label(props.accessibility_label)
        .when_some(props.input_test_id.get_untracked(), |f, id| f.test_id(&id))
        .accessibility_state(move || AccessibilityState {
            expanded: Some(open.get()),
            has_popup: true,
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
        .on_focus(move || {
            focused.set(true);
            // A tap on the input opens the list on a touch screen (Base UI's
            // `openOnInputClick`); with a keyboard, focus alone (Tab) does
            // not, and typing or the arrow keys do.
            if !is_desktop() && !open.get_untracked() && !props.disabled.get_untracked() {
                opening.replace(Opening::Press);
                focus_opened.replace(true);
                focus_change(true, OpenChangeReason::TriggerPress);
            }
            // The chosen title, selected: typing replaces it.
            if !props.multiple.get_untracked() && !typed.get_untracked() {
                let title = untracked(chosen_title);
                if !title.is_empty() {
                    field.set_selection(0, title.chars().count() as u32);
                }
            }
        })
        .on_blur(move || {
            focused.set(false);
            focus_opened.replace(false);
        })
        // A press on the input opens and closes the list in every idiom,
        // as `gpui-component`'s trigger does (after the focus it gave,
        // which the platforms report first).
        .on_press(move || {
            if focus_opened.replace(false) || props.disabled.get_untracked() {
                return;
            }
            opening.replace(Opening::Press);
            press_change(!open.get_untracked(), OpenChangeReason::TriggerPress);
        })
        .on_change(move |text: &str| {
            // Typed after the chosen title (the caret at its end): the
            // characters typed replace it, as they would the selection.
            let title = if props.multiple.get_untracked() {
                String::new()
            } else if typed.get_untracked() {
                replaced.with(|r| r.clone()).unwrap_or_default()
            } else {
                untracked(chosen_title)
            };
            let text = match text.strip_prefix(title.as_str()) {
                Some(rest) if !title.is_empty() && !rest.is_empty() => {
                    replaced.replace(Some(title.clone()));
                    rest
                }
                _ => {
                    replaced.replace(None);
                    text
                }
            };
            typed.set(true);
            if open.get_untracked() {
                lb.edited(text);
            } else {
                pending.replace(Some(text.to_owned()));
                opening.replace(Opening::Press);
                input_change(true, OpenChangeReason::InputChange);
            }
            cx.emit(ComboboxEvent::QueryChange(text.to_owned().into()));
        })
        .map(|i| match terminal {
            // The terminal's field: one row, as wide as the room left.
            true => i.flex_grow(1.0).min_w(px(0.0)),
            false => i
                .app_class(props.input_class)
                .inline_style(move || props.input_style.get()),
        });
    // Not a stop of Tab (`gpui-component`'s `tab_stop(false)`): the input
    // keeps the keyboard.
    let clear = when(
        move || props.cleanable.get() && current.with(|v| !v.is_empty()),
        move || {
            view()
                .role(AccessibilityRole::Button)
                .optional_label(props.clear_button_accessibility_label)
                .focusable(false)
                .disabled(props.disabled)
                .on_press(move || {
                    report(Vec::new());
                    field.focus();
                })
                .map(|v| match terminal {
                    // The terminal's own `×`, in place of the app's button:
                    // a mark in a slot of three Cells (`mark_slot`), muted
                    // or lit as the `▾`.
                    true => mark_slot(v, CLEAR.trim_start(), move || focused.get() || open.get()),
                    false => v
                        .app_class(props.clear_button_class)
                        .inline_style(props.clear_button_style)
                        .child(props.clear_button.place(|c| c)),
                })
        },
    );
    // The input says whether the list is open: the button is hidden from
    // screen readers, and leaves the keyboard on the input.
    // Tab past the input closes the list and moves the focus on.
    {
        let change = change.clone();
        listbox::bind_tab_out(
            move || open.get(),
            Rc::new(move || change(false, OpenChangeReason::Focus)),
        );
    }
    let toggle = change;
    let press = move || {
        let toggle = toggle.clone();
        move || {
            opening.replace(Opening::Press);
            toggle(!open.get_untracked(), OpenChangeReason::TriggerPress);
            if is_desktop() {
                field.focus();
            }
        }
    };
    let trigger_button = match terminal {
        // The terminal's own button, in place of the app's: `▾` in a slot
        // of three Cells (`mark_slot`).
        true => mark_slot(
            view()
                .role(AccessibilityRole::Button)
                .accessibility_elements_hidden(true)
                .disabled(props.disabled)
                .on_press(press()),
            SELECT_ARROW.trim_start(),
            move || focused.get() || open.get(),
        )
        .into_element(),
        false => props.trigger_button.place(move |t| {
            t.role(AccessibilityRole::Button)
                .focusable(false)
                .accessibility_elements_hidden(true)
                .disabled(props.disabled)
                .on_press(press())
        }),
    };
    view()
        .element_ref(&anchor)
        .flex_row()
        .on_layout(move |frame: &Bounds<Points>| width.set(Some(frame.size.width)))
        // A terminal keeps a column between the field and the app's
        // prefix and suffix (a `⌘K` after the ` ▾`).
        .child(
            props
                .prefix
                .place(move |p| if terminal { p.mr(px(8.0)) } else { p }),
        )
        .child(text_field)
        .child(clear)
        .child(trigger_button)
        .child(
            props
                .suffix
                .place(move |s| if terminal { s.ml(px(8.0)) } else { s }),
        )
        .child(listbox::present(lb, anchor, width, parts, hooks))
}

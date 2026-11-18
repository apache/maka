//! `MenuButton`: content that opens the system's own menu when pressed.
//!
//! On iOS the content is covered by a native component
//! ([`MENU_BUTTON_COMPONENT`]): a transparent `UIButton` whose `UIMenu`
//! is its primary action, so a tap opens the menu natively, without
//! waiting for JS, and the system draws, places and animates it (Liquid
//! Glass on iOS 26). The menu is made from the mounted `items`, and a
//! chosen item comes back as the component's `select` event with the
//! app's id. On a desktop OS the content is a button whose press shows the
//! same items as the platform's context menu ([`popup_menu`]). Elsewhere
//! (Android, the web) it is that button with nothing to show: the app
//! uses `Menu` there.

use nsh_core::{
    JsonValue,
    element::{
        NativeEvent,
        desktop::{MenuItem as DesktopMenuItem, popup_menu},
        native,
    },
    platform::{MENU_BUTTON_COMPONENT, Os},
    prelude::*,
};

use crate::roving::bar_item;

/// One item of a [`MenuButton`]'s menu: an action, a submenu (with
/// `items`), or a section shown in place (`items` with `inline`).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct MenuButtonItem {
    /// What identifies it in `onSelect`: the app's, unique in the menu,
    /// never its label. A submenu's or a section's is never reported.
    pub id: SharedString,
    /// What it shows and what VoiceOver says; a section's is its title
    /// (none when empty).
    pub label: SharedString,
    /// Its icon, an SF Symbol's name (`"gearshape"`), on iOS; the desktops
    /// show none.
    #[prop(skip_none)]
    pub icon: Option<SharedString>,
    /// A check mark: `Some` makes it a checkable item, checked or not; the
    /// app owns the value and changes it from `onSelect`.
    #[prop(skip_none)]
    pub checked: Option<bool>,
    /// It cannot be chosen (or opened): the system dims it.
    #[prop(default)]
    pub disabled: bool,
    /// It destroys or removes something: iOS draws it in red; the desktops
    /// show it as any item.
    #[prop(default)]
    pub destructive: bool,
    /// The items under it, in order: with any, it is a submenu (or a
    /// section, with `inline`).
    #[prop(default)]
    pub items: Vec<MenuButtonItem>,
    /// With `items`, a section shown in place of a submenu: on iOS
    /// `UIMenuOptions.displayInline`, titled by its `label`; on the
    /// desktops its items between separators.
    #[prop(default)]
    pub inline: bool,
}

impl MenuButtonItem {
    /// An action of `id`, labelled `label`.
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            ..Self::default()
        }
    }

    /// A submenu labelled `label` holding `items`.
    pub fn submenu(
        label: impl Into<SharedString>,
        items: impl IntoIterator<Item = MenuButtonItem>,
    ) -> Self {
        Self {
            label: label.into(),
            items: items.into_iter().collect(),
            ..Self::default()
        }
    }

    /// A section of `items` shown in place, titled `label` (none when
    /// empty).
    pub fn section(
        label: impl Into<SharedString>,
        items: impl IntoIterator<Item = MenuButtonItem>,
    ) -> Self {
        Self {
            inline: true,
            ..Self::submenu(label, items)
        }
    }

    /// Its icon, an SF Symbol's name ([`MenuButtonItem::icon`]).
    pub fn icon(mut self, name: impl Into<SharedString>) -> Self {
        self.icon = Some(name.into());
        self
    }

    /// A check mark, checked or not ([`MenuButtonItem::checked`]).
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
        self
    }

    /// Whether it cannot be chosen ([`MenuButtonItem::disabled`]).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Whether it destroys or removes something
    /// ([`MenuButtonItem::destructive`]).
    pub fn destructive(mut self, destructive: bool) -> Self {
        self.destructive = destructive;
        self
    }
}

/// The props of [`MenuButton`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct MenuButtonProps {
    /// The menu's items, in order. New items change the menu the next time
    /// it opens; one open keeps the items it opened with.
    #[prop(default)]
    pub items: Prop<Vec<MenuButtonItem>>,
    /// The menu's title, above its items on iOS (an account's address, a
    /// file's name); the desktops show none.
    pub title: Prop<Option<SharedString>>,
    /// It cannot be pressed and opens nothing; `disabled:` styles apply and
    /// screen readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers say for the button: on iOS the content is
    /// covered by the system's button, which only this names.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// The content: what the button shows, laid out by its `class` and
    /// `style` as a view's children.
    pub children: Prop<Children>,
}

/// The events of a [`MenuButton`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum MenuButtonEvent {
    /// The user chose an item: its `id`. The menu has closed.
    #[args(id)]
    Select(SharedString),
}

/// Content that opens the system's own menu: on iOS a `UIMenu` (the
/// system's pull-down menu, Liquid Glass on iOS 26 and later), shown by a
/// tap, VoiceOver's activation or the keyboard's, with the system's
/// placement, motion, checks, submenus, sections and destructive items; on
/// a desktop OS the platform's context menu (`Menu.popup`'s) at the
/// pointer. The app gives the items as data (`items`, each with an `id` of
/// its own), hears the choice (`onSelect({ id })`) and draws the content
/// with its children, `class` and `style`, which stay the app's on every
/// platform. The system's menus show no app content: rows of the app's own
/// look are `Menu`'s. Android and the web have no system menu for a view:
/// there the content shows and opens nothing, and the app uses `Menu`.
#[component]
pub fn MenuButton(props: MenuButtonProps, cx: Scope<MenuButtonEvent>) -> impl IntoElement {
    let (view, disabled) = bar_item(view(), None, props.disabled);
    let items = props.items;
    if os() == Os::Ios {
        // The content is the app's; the system's button covers it and is
        // what touches, VoiceOver and the keyboard reach.
        return view
            .disabled(disabled)
            .child(props.children)
            .child(
                native(MENU_BUTTON_COMPONENT)
                    .absolute()
                    .inset_0()
                    .prop("items", move || items.with(|items| menu_json(items)))
                    .prop("title", move || {
                        props
                            .title
                            .get()
                            .map_or(JsonValue::Null, |t| JsonValue::from(t.as_ref()))
                    })
                    .prop("disabled", move || JsonValue::Bool(disabled.get()))
                    .prop("accessibilityLabel", move || {
                        props
                            .accessibility_label
                            .get()
                            .map_or(JsonValue::Null, |t| JsonValue::from(t.as_ref()))
                    })
                    .on_native_event(move |event: &NativeEvent| {
                        if &*event.name == "select"
                            && let Some(id) = event.data.as_str()
                        {
                            cx.emit(MenuButtonEvent::Select(SharedString::from(id.to_owned())));
                        }
                    }),
            )
            .into_element();
    }
    view.disabled(disabled)
        .role(AccessibilityRole::Button)
        .optional_label(props.accessibility_label)
        .on_press(move |_: &()| {
            if os().is_desktop() {
                let select = move |id: SharedString| cx.emit(MenuButtonEvent::Select(id));
                let menu = items.with_untracked(|items| desktop_items(items, select));
                // The answer only says it closed: the choice is the item's.
                drop(popup_menu(menu));
            }
        })
        .child(props.children)
        .into_element()
}

/// The items as the iOS components read them (`MenuButton`'s, and
/// `ContextMenu`'s with `items`): `[{ id, label, icon?, checked?,
/// disabled?, destructive?, items?, inline? }]`.
pub(crate) fn menu_json(items: &[MenuButtonItem]) -> JsonValue {
    items
        .iter()
        .map(|item| {
            let mut entry = serde_json::Map::new();
            entry.insert("id".into(), item.id.as_ref().into());
            entry.insert("label".into(), item.label.as_ref().into());
            if let Some(icon) = &item.icon {
                entry.insert("icon".into(), icon.as_ref().into());
            }
            if let Some(checked) = item.checked {
                entry.insert("checked".into(), checked.into());
            }
            if item.disabled {
                entry.insert("disabled".into(), true.into());
            }
            if item.destructive {
                entry.insert("destructive".into(), true.into());
            }
            if !item.items.is_empty() {
                entry.insert("items".into(), menu_json(&item.items));
                if item.inline {
                    entry.insert("inline".into(), true.into());
                }
            }
            JsonValue::Object(entry)
        })
        .collect()
}

/// The items as the desktops' context menu: a section's items between
/// separators (never two in a row, none at either end), each action
/// reporting its id.
fn desktop_items(
    items: &[MenuButtonItem],
    select: impl Fn(SharedString) + Clone + 'static,
) -> Vec<DesktopMenuItem> {
    desktop_entries(items, select)
        .into_iter()
        .map(|entry| match entry {
            Entry::Item(item) => item,
            Entry::Separator => DesktopMenuItem::separator(),
        })
        .collect()
}

/// A desktop menu's item, or the line between two sections.
enum Entry {
    Item(DesktopMenuItem),
    Separator,
}

/// One level's entries, sections flattened between separators and the
/// separators trimmed.
fn desktop_entries(
    items: &[MenuButtonItem],
    select: impl Fn(SharedString) + Clone + 'static,
) -> Vec<Entry> {
    let mut entries = Vec::new();
    for item in items {
        if item.items.is_empty() {
            let id = item.id.clone();
            let select = select.clone();
            let mut action = DesktopMenuItem::new(item.label.to_string())
                .disabled(item.disabled)
                .on_select(move || select(id.clone()));
            if let Some(checked) = item.checked {
                action = action.checked(checked);
            }
            entries.push(Entry::Item(action));
        } else if item.inline {
            entries.push(Entry::Separator);
            entries.extend(desktop_entries(&item.items, select.clone()));
            entries.push(Entry::Separator);
        } else {
            let submenu = desktop_items(&item.items, select.clone());
            entries.push(Entry::Item(
                DesktopMenuItem::submenu(item.label.to_string(), submenu).disabled(item.disabled),
            ));
        }
    }
    let mut trimmed: Vec<Entry> = Vec::with_capacity(entries.len());
    for entry in entries {
        let separator = matches!(entry, Entry::Separator);
        if separator && !matches!(trimmed.last(), Some(Entry::Item(_))) {
            continue;
        }
        trimmed.push(entry);
    }
    if matches!(trimmed.last(), Some(Entry::Separator)) {
        trimmed.pop();
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Entry, MenuButtonItem, desktop_entries, menu_json};

    #[test]
    fn items_reach_ios_with_sections_submenus_and_states() {
        let items = [
            MenuButtonItem::new("settings", "Settings").icon("gearshape"),
            MenuButtonItem::new("read", "Mark all as read").disabled(true),
            MenuButtonItem::submenu(
                "Language",
                [
                    MenuButtonItem::new("en", "English").checked(true),
                    MenuButtonItem::new("zh", "中文").checked(false),
                ],
            ),
            MenuButtonItem::section(
                "",
                [MenuButtonItem::new("delete", "Delete").destructive(true)],
            ),
        ];
        assert_eq!(
            menu_json(&items),
            json!([
                { "id": "settings", "label": "Settings", "icon": "gearshape" },
                { "id": "read", "label": "Mark all as read", "disabled": true },
                { "id": "", "label": "Language", "items": [
                    { "id": "en", "label": "English", "checked": true },
                    { "id": "zh", "label": "中文", "checked": false },
                ] },
                { "id": "", "label": "", "inline": true, "items": [
                    { "id": "delete", "label": "Delete", "destructive": true },
                ] },
            ])
        );
    }

    /// Sections become items between separators on the desktops, with no
    /// separator at either end or two in a row.
    #[test]
    fn sections_are_separated_on_the_desktops() {
        let items = [
            MenuButtonItem::section("", [MenuButtonItem::new("a", "A")]),
            MenuButtonItem::section("", [MenuButtonItem::new("b", "B")]),
            MenuButtonItem::new("c", "C"),
            MenuButtonItem::section("Last", [MenuButtonItem::new("d", "D")]),
        ];
        let kinds: Vec<_> = desktop_entries(&items, |_| {})
            .iter()
            .map(|e| matches!(e, Entry::Separator))
            .collect();
        assert_eq!(kinds, [false, true, false, true, false, true, false]);
    }
}

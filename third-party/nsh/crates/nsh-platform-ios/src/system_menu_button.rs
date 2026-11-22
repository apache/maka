//! `nsh/base`'s `MenuButton` on iOS: a transparent `UIButton` over the
//! app's content whose `UIMenu` is its primary action
//! (`showsMenuAsPrimaryAction`, iOS 14), so a tap, VoiceOver's activation
//! or a hardware keyboard's opens the system's menu at once, without asking
//! JS. The menu is made from the `items` prop as it changes; a chosen
//! action emits `select` with the app's id.
//!
//! The button is what VoiceOver reaches inside the element (named by
//! `accessibilityLabel`): the app's content under it is drawn, not read
//! twice.

use std::{ptr::NonNull, rc::Rc};

use block2::RcBlock;
use nsh_core::JsonValue;
use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained};
use objc2_foundation::{NSArray, NSObject, NSString};
use objc2_ui_kit::{
    UIAction, UIButton, UIButtonType, UIControl, UIImage, UIMenu, UIMenuElement,
    UIMenuElementAttributes, UIMenuElementState, UIMenuOptions, UIResponder, UIView, UIWindow,
};

use crate::component::{ComponentContext, ComponentFactory, NativeComponent};

/// One entry of the menu as the props give it (`ContextMenu`'s system menu
/// reads the same items: `system_context_menu.rs`).
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Entry {
    id: String,
    label: String,
    icon: String,
    checked: Option<bool>,
    disabled: bool,
    destructive: bool,
    items: Vec<Entry>,
    inline: bool,
}

/// How deep submenus nest: past it, an entry's `items` are dropped, so a
/// prop nested without end cannot exhaust the main thread's stack while the
/// menu is parsed and made.
const MAX_DEPTH: usize = 8;

/// The entries of an `items` prop; anything but objects is skipped.
pub(crate) fn parse_items(items: &[JsonValue]) -> Vec<Entry> {
    parse_level(items, 0)
}

fn parse_level(items: &[JsonValue], depth: usize) -> Vec<Entry> {
    items
        .iter()
        .filter_map(JsonValue::as_object)
        .map(|item| {
            let text = |key: &str| {
                item.get(key)
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_owned()
            };
            let flag = |key: &str| item.get(key).and_then(JsonValue::as_bool).unwrap_or(false);
            Entry {
                id: text("id"),
                label: text("label"),
                icon: text("icon"),
                checked: item.get("checked").and_then(JsonValue::as_bool),
                disabled: flag("disabled"),
                destructive: flag("destructive"),
                items: if depth + 1 < MAX_DEPTH {
                    parse_level(
                        item.get("items")
                            .and_then(JsonValue::as_array)
                            .map_or(&[], |v| v),
                        depth + 1,
                    )
                } else {
                    Vec::new()
                },
                inline: flag("inline"),
            }
        })
        .collect()
}

/// An action's attributes: a disabled submenu disables what it holds.
fn attributes(entry: &Entry, disabled: bool) -> UIMenuElementAttributes {
    let mut attributes = UIMenuElementAttributes::empty();
    if entry.disabled || disabled {
        attributes |= UIMenuElementAttributes::Disabled;
    }
    if entry.destructive {
        attributes |= UIMenuElementAttributes::Destructive;
    }
    attributes
}

fn symbol(name: &str) -> Option<Retained<UIImage>> {
    if name.is_empty() {
        return None;
    }
    let image = UIImage::systemImageNamed(&NSString::from_str(name));
    if image.is_none() {
        log::warn!(target: "js", "menu: no SF Symbol is named `{name}`");
    }
    image
}

/// What a chosen action does with its id.
pub(crate) type Choose = Rc<dyn Fn(String)>;

/// The menu's elements for `entries`; each action passes its id to
/// `choose`.
pub(crate) fn elements(
    entries: &[Entry],
    disabled: bool,
    choose: &Choose,
    mtm: MainThreadMarker,
) -> Retained<NSArray<UIMenuElement>> {
    let made: Vec<Retained<UIMenuElement>> = entries
        .iter()
        .map(|entry| {
            let image = symbol(&entry.icon);
            if entry.items.is_empty() {
                let id = entry.id.clone();
                let choose = choose.clone();
                let handler = RcBlock::new(move |_: NonNull<UIAction>| choose(id.clone()));
                // SAFETY: the handler is a block UIKit copies and runs on
                // the main thread once the menu closes with this action.
                let action = unsafe {
                    UIAction::actionWithTitle_image_identifier_handler(
                        &NSString::from_str(&entry.label),
                        image.as_deref(),
                        None,
                        RcBlock::as_ptr(&handler),
                        mtm,
                    )
                };
                action.setAttributes(attributes(entry, disabled));
                if let Some(checked) = entry.checked {
                    action.setState(if checked {
                        UIMenuElementState::On
                    } else {
                        UIMenuElementState::Off
                    });
                }
                Retained::into_super(action)
            } else {
                let options = if entry.inline {
                    UIMenuOptions::DisplayInline
                } else {
                    UIMenuOptions::empty()
                };
                let children = elements(&entry.items, disabled || entry.disabled, choose, mtm);
                let menu = UIMenu::menuWithTitle_image_identifier_options_children(
                    &NSString::from_str(&entry.label),
                    image.as_deref(),
                    None,
                    options,
                    &children,
                    mtm,
                );
                Retained::into_super(menu)
            }
        })
        .collect();
    NSArray::from_retained_slice(&made)
}

define_class!(
    /// The transparent button over a `MenuButton`'s content: inside its
    /// element it is all VoiceOver reaches.
    #[unsafe(super(UIButton, UIControl, UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    struct NshMenuButton;

    impl NshMenuButton {
        #[unsafe(method(didMoveToWindow))]
        fn did_move_to_window(&self) {
            // SAFETY: calling the superclass implementation.
            let () = unsafe { msg_send![super(self), didMoveToWindow] };
            // Its superview is the component's container, whose superview
            // is the element holding the app's content beside it.
            if self.window().is_some()
                && let Some(element) = self.superview().and_then(|c| c.superview())
            {
                let me: &UIView = self;
                let only = NSArray::<UIView>::from_slice(&[me]);
                // SAFETY: `accessibilityElements` is UIAccessibilityContainer's
                // NSArray property, which every NSObject has.
                let () = unsafe { msg_send![&*element, setAccessibilityElements: &*only] };
            }
        }

        // Leaving the window (the component removed while its element
        // stays, or the element itself going): the element must stop
        // listing the button, or it keeps it alive and VoiceOver keeps
        // reaching a button no longer there. Its superviews are still
        // attached here, unlike in `didMoveToWindow`.
        #[unsafe(method(willMoveToWindow:))]
        fn will_move_to_window(&self, window: Option<&UIWindow>) {
            if window.is_none()
                && let Some(element) = self.superview().and_then(|c| c.superview())
            {
                // SAFETY: `accessibilityElements` is UIAccessibilityContainer's
                // NSArray property, which every NSObject has.
                let listed: Option<Retained<NSArray<NSObject>>> =
                    unsafe { msg_send![&*element, accessibilityElements] };
                let listed: Vec<*const NSObject> = listed
                    .map(|a| a.iter().map(|o| Retained::as_ptr(&o)).collect())
                    .unwrap_or_default();
                let me: &NSObject = self;
                if lists_only(&listed, me) {
                    // Nil gives the element back UIKit's own derivation.
                    let none: Option<&NSArray<NSObject>> = None;
                    // SAFETY: as above; nil is the property's default.
                    let () = unsafe { msg_send![&*element, setAccessibilityElements: none] };
                }
            }
            // SAFETY: calling the superclass implementation.
            let () = unsafe { msg_send![super(self), willMoveToWindow: window] };
        }
    }
);

/// Whether `listed` (an element's `accessibilityElements`) is exactly the
/// list the button set: only then is it the button's to clear, so a list
/// the app or another view set since is left alone.
fn lists_only<T>(listed: &[*const T], me: *const T) -> bool {
    matches!(listed, [only] if *only == me)
}

struct SystemMenuButton {
    button: Retained<NshMenuButton>,
    entries: Vec<Entry>,
    title: String,
    context: ComponentContext,
    mtm: MainThreadMarker,
}

impl SystemMenuButton {
    /// Gives the button the menu of its entries and title.
    fn make_menu(&self) {
        let context = self.context.clone();
        let choose: Choose = Rc::new(move |id| context.emit("select", JsonValue::from(id)));
        let children = elements(&self.entries, false, &choose, self.mtm);
        let menu =
            UIMenu::menuWithTitle_children(&NSString::from_str(&self.title), &children, self.mtm);
        self.button.setMenu(Some(&menu));
    }
}

impl NativeComponent for SystemMenuButton {
    fn view(&self) -> &UIView {
        &self.button
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        match name {
            "items" => {
                let entries = parse_items(value.and_then(JsonValue::as_array).map_or(&[], |v| v));
                if entries != self.entries {
                    self.entries = entries;
                    self.make_menu();
                }
            }
            "title" => {
                let title = value
                    .and_then(JsonValue::as_str)
                    .unwrap_or_default()
                    .to_owned();
                if title != self.title {
                    self.title = title;
                    self.make_menu();
                }
            }
            "disabled" => {
                let disabled = value.and_then(JsonValue::as_bool).unwrap_or(false);
                self.button.setEnabled(!disabled);
            }
            "accessibilityLabel" => {
                let label = value.and_then(JsonValue::as_str).map(NSString::from_str);
                // SAFETY: `accessibilityLabel` is UIAccessibility's NSString
                // property, which every NSObject has.
                let () =
                    unsafe { msg_send![&*self.button, setAccessibilityLabel: label.as_deref()] };
            }
            _ => {}
        }
    }
}

/// Makes the button of each `MenuButton` element
/// (`nsh_core::platform::MENU_BUTTON_COMPONENT`), which every surface has
/// (`Components::default`).
pub(crate) fn factory() -> ComponentFactory {
    Rc::new(|context: ComponentContext| {
        let mtm = MainThreadMarker::new().expect("the menu button is made on the main thread");
        // SAFETY: a `UIButton` subclass with no state of its own, made as
        // `buttonWithType:` makes a custom one.
        let button: Retained<NshMenuButton> =
            unsafe { msg_send![NshMenuButton::class(), buttonWithType: UIButtonType::Custom] };
        button.setShowsMenuAsPrimaryAction(true);
        let component = SystemMenuButton {
            button,
            entries: Vec::new(),
            title: String::new(),
            context,
            mtm,
        };
        component.make_menu();
        Box::new(component) as Box<dyn NativeComponent>
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{Entry, MAX_DEPTH, lists_only, parse_items};

    #[test]
    fn only_the_buttons_own_list_is_cleared_on_removal() {
        let (me, other) = (1u8, 2u8);
        let (me, other) = (&me as *const u8, &other as *const u8);
        assert!(lists_only(&[me], me));
        assert!(!lists_only(&[], me));
        assert!(!lists_only(&[other], me));
        assert!(!lists_only(&[me, other], me));
    }

    #[test]
    fn submenus_past_the_depth_limit_are_dropped() {
        let mut items = json!([{ "id": "leaf", "label": "Leaf" }]);
        for level in 0..MAX_DEPTH * 4 {
            items = json!([{ "id": format!("m{level}"), "label": "More", "items": items }]);
        }
        let mut entries = parse_items(items.as_array().unwrap());
        let mut depth = 0;
        while let Some(entry) = entries.first() {
            depth += 1;
            entries = entry.items.clone();
        }
        assert_eq!(depth, MAX_DEPTH);
    }

    #[test]
    fn entries_carry_sections_submenus_and_states() {
        let entries = parse_items(&[
            json!({ "id": "settings", "label": "Settings", "icon": "gearshape" }),
            json!({ "id": "", "label": "Language", "items": [
                { "id": "en", "label": "English", "checked": true },
            ] }),
            json!({ "id": "", "label": "", "inline": true, "items": [
                { "id": "delete", "label": "Delete", "destructive": true, "disabled": true },
            ] }),
        ]);
        assert_eq!(entries[0].icon, "gearshape");
        assert_eq!(entries[1].items[0].checked, Some(true));
        assert!(!entries[1].inline);
        assert!(entries[2].inline);
        assert_eq!(
            entries[2].items[0],
            Entry {
                id: "delete".into(),
                label: "Delete".into(),
                destructive: true,
                disabled: true,
                ..Entry::default()
            }
        );
    }
}

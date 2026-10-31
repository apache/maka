//! The context menu an app showed (`Menu.popup`, `DesktopCommand::PopupMenu`),
//! as tests read it and choose from it: its actions by label, a submenu's
//! as `"Share > Mail"`.

use nsh_core::desktop::{MenuAction, MenuItem};

/// One action of a menu, as `app.menu()` lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    any(feature = "agent", feature = "js"),
    derive(serde::Serialize, serde::Deserialize)
)]
pub struct Entry {
    /// Its label; a submenu's actions after the submenu's (`"Share > Mail"`).
    pub label: String,
    /// It cannot be chosen (it, or a submenu around it, is disabled).
    pub disabled: bool,
    /// Its check mark, when it is a checkable item.
    pub checked: Option<bool>,
}

/// The actions of `items`, in order, those of submenus after their path.
pub(crate) fn entries(items: &[MenuItem]) -> Vec<Entry> {
    let mut out = Vec::new();
    collect(items, "", true, &mut out);
    out
}

fn collect(items: &[MenuItem], prefix: &str, enabled: bool, out: &mut Vec<Entry>) {
    for item in items {
        match item {
            MenuItem::Separator => {}
            MenuItem::Action(action) => out.push(Entry {
                label: format!("{prefix}{}", action.label),
                disabled: !(enabled && action.enabled),
                checked: action.checked,
            }),
            MenuItem::Submenu {
                label,
                enabled: open,
                items,
            } => collect(items, &format!("{prefix}{label} > "), enabled && *open, out),
        }
    }
}

/// The labels along the way to an item (`"Share > Mail"`: the submenu's,
/// then the action's).
#[cfg(feature = "agent")]
pub(crate) fn path(label: &str) -> Vec<String> {
    label.split(" > ").map(str::to_owned).collect()
}

/// The action of `items` labelled `label` (a submenu's: `"Share > Mail"`)
/// that can be chosen.
pub(crate) fn find<'a>(items: &'a [MenuItem], label: &str) -> Result<&'a MenuAction, String> {
    let mut level = items;
    let parts: Vec<&str> = label.split(" > ").collect();
    for (n, part) in parts.iter().enumerate() {
        let last = n == parts.len() - 1;
        let found = level.iter().find(|item| match item {
            MenuItem::Action(action) => last && action.label == *part,
            MenuItem::Submenu { label, .. } => !last && label == part,
            MenuItem::Separator => false,
        });
        let Some(item) = found else {
            let shown: Vec<String> = entries(items).into_iter().map(|e| e.label).collect();
            return Err(format!(
                "{}; it has {shown:?}",
                crate::failure::no_menu_item(label)
            ));
        };
        match item {
            MenuItem::Action(action) if !action.enabled => {
                return Err(crate::failure::menu_disabled(label, false));
            }
            MenuItem::Action(action) => return Ok(action),
            MenuItem::Submenu { enabled: false, .. } => {
                return Err(crate::failure::menu_disabled(part, true));
            }
            MenuItem::Submenu { items, .. } => level = items,
            MenuItem::Separator => unreachable!("not found"),
        }
    }
    Err(crate::failure::no_menu_item(label))
}

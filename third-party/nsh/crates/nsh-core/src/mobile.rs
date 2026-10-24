//! Capabilities specific to iOS and Android (TS
//! `nsh/mobile`): the system's tab bar ([`TabBar`]), a native component the
//! two backends register themselves ([`TAB_BAR_COMPONENT`]). Elsewhere a
//! component takes no room and shows nothing. Common controls belong to
//! `nsh/base`; this module exposes mobile-specific semantics rather than
//! a parallel set of system-styled controls.

use crate::{
    JsonValue,
    platform::{Os, TAB_BAR_COMPONENT},
    ui::{NativeEvent, native, prelude::*},
};

/// One tab of a [`TabBar`].
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct TabBarItem {
    /// Its title.
    pub title: SharedString,
    /// Its icon, by the platform's name for it: an SF Symbol on iOS
    /// (`"house"`), a drawable of the app on Android (`res/drawable/home.xml`
    /// is `"home"`, `"android:ic_menu_search"` the system's); TS's
    /// `platform.select` picks one per platform.
    #[prop(skip_none)]
    pub icon: Option<SharedString>,
}

impl TabBarItem {
    /// A tab titled `title`, with no icon.
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            ..Self::default()
        }
    }

    /// Its icon, by the platform's name for it ([`TabBarItem::icon`]).
    pub fn icon(mut self, name: impl Into<SharedString>) -> Self {
        self.icon = Some(name.into());
        self
    }
}

/// The props of [`TabBar`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct TabBarProps {
    /// The tabs, in order.
    #[prop(default)]
    pub items: Prop<Vec<TabBarItem>>,
    /// The selected tab, by index (default 0; one past the tabs selects
    /// none). The app owns it: the user's choice is reported with
    /// `onChange`.
    #[prop(default)]
    pub selected_index: Prop<u32>,
}

/// The events of a [`TabBar`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum TabBarEvent {
    /// The user chose a tab: its index. The bar shows the choice at once,
    /// as the system's does; the app shows the tab's content and sets
    /// `selectedIndex`.
    #[args(index)]
    Change(u32),
}

/// The system's tab bar: `UITabBar` on iOS (Liquid Glass on iOS 26), a
/// Material 3 navigation bar on Android, each in the system's look. The app
/// gives the tabs (`items`), says which is selected (`selectedIndex`), hears
/// the user's choice (`onChange`), places the bar with its `class` and
/// `style` and shows the selected tab's content; the bar's height is the
/// system's where the style leaves it open. The desktops and the web have no
/// system tab bar: there it takes no room and shows nothing, and the app
/// shows its tabs with `nsh/base`'s `Tabs`.
#[component]
pub fn TabBar(props: TabBarProps, cx: Scope<TabBarEvent>) -> impl IntoElement {
    if !matches!(os(), Os::Ios | Os::Android) {
        return view().hidden().into_element();
    }
    let items = props.items;
    native(TAB_BAR_COMPONENT)
        .prop("items", move || items.with(|items| tabs_json(items)))
        .prop("selectedIndex", move || {
            JsonValue::from(props.selected_index.get())
        })
        .on_native_event(move |event: &NativeEvent| {
            if &*event.name == "change"
                && let Some(index) = event.data.as_u64()
            {
                cx.emit(TabBarEvent::Change(index as u32));
            }
        })
        .into_element()
}

/// The tabs as the platforms read them: `[{ title, icon? }]`.
fn tabs_json(items: &[TabBarItem]) -> JsonValue {
    items
        .iter()
        .map(|item| {
            let mut tab = serde_json::Map::new();
            tab.insert("title".into(), item.title.as_ref().into());
            if let Some(icon) = &item.icon {
                tab.insert("icon".into(), icon.as_ref().into());
            }
            JsonValue::Object(tab)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{TabBarItem, tabs_json};

    #[test]
    fn tabs_reach_the_platform_as_titles_and_icons() {
        let tabs = [
            TabBarItem::new("Records").icon("list.bullet"),
            TabBarItem::new("Stats"),
        ];
        assert_eq!(
            tabs_json(&tabs),
            json!([{ "title": "Records", "icon": "list.bullet" }, { "title": "Stats" }])
        );
    }
}

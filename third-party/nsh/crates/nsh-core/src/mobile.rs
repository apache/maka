//! Capabilities specific to iOS and Android (TS
//! `nsh/mobile`): the system's tab bar ([`TabBar`]), a native component the
//! two backends register themselves ([`TAB_BAR_COMPONENT`]). Elsewhere, and
//! on a platform built outside NSH without a tab bar
//! ([`crate::platform::Environment::tab_bar`]), it takes no room and shows
//! nothing. Common controls belong to `nsh/base`, with one cross-platform
//! API; the tab bar is here because it is the app's top-level navigation,
//! not a form control. System-styled form controls are not part of the
//! runtime: an app that wants them adds them as an nshm.
//!
//! It also opens the app's own page in the system's settings
//! ([`open_app_settings`], TS `AppSettings.open`), where the user turns
//! back on a permission they denied: iOS's Settings app at the app,
//! Android's App info. The core sends [`crate::Command::OpenAppSettings`]
//! to a platform whose [`crate::platform::Environment::app_settings`] is
//! set, which reports whether the system opened the page as
//! [`crate::EventKind::OpenAppSettings`]. Elsewhere (the desktops, the web,
//! a terminal, and an iPhone or iPad app running on a Mac, which has no
//! page of the app's own) it fails at once with
//! [`AppSettingsError::Unavailable`]. It acts on the application as a whole
//! (the embedding app's page, for an embedded view), so an app that
//! declares capabilities needs `application`.

use crate::{
    JsonValue,
    element::{NativeEvent, native},
    platform::TAB_BAR_COMPONENT,
    prelude::*,
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
    /// Its badge: a text (`"3"`, `"New"`), or `""` for a badge with no
    /// text (Material 3's small dot on Android, UIKit's empty badge on iOS).
    /// `None` (the default) shows none. The badge is the system's
    /// (`badgeValue` on iOS, Material 3's on Android), and screen readers
    /// say its text with the title.
    #[prop(skip_none)]
    pub badge: Option<SharedString>,
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

    /// Its badge ([`TabBarItem::badge`]): a text, or `""` for a badge with
    /// no text.
    pub fn badge(mut self, text: impl Into<SharedString>) -> Self {
        self.badge = Some(text.into());
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
    /// Out of sight, without a transition (default false): the app sets it when
    /// it switches tabs, whose pages are kept and shown again as they were.
    #[prop(default)]
    pub hidden: Prop<bool>,
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
/// system's where the style leaves it open. The selected tab takes the
/// theme's `primary` (the other tabs keep the system's). The desktops and
/// the web have no system tab bar: there it takes no room and shows
/// nothing, and the app shows its tabs with `nsh/base`'s `Tabs`.
#[component]
pub fn TabBar(props: TabBarProps, cx: Scope<TabBarEvent>) -> impl IntoElement {
    if !crate::element::has_tab_bar() {
        return view().hidden().into_element();
    }
    let items = props.items;
    native(TAB_BAR_COMPONENT)
        // The bar's own view fills the element and takes every press it
        // wants; the element must not take the strip it leaves once it is
        // out of sight (`hidden`, or the navigation stack's
        // `hidesBottomBarWhenPushed`), where an app draws controls of its
        // own.
        .pointer_events(PointerEvents::BoxNone)
        .prop("items", move || items.with(|items| tabs_json(items)))
        .prop("selectedIndex", move || {
            JsonValue::from(props.selected_index.get())
        })
        .prop("hidden", move || JsonValue::Bool(props.hidden.get()))
        // One color, for the appearance shown: sent again when either changes.
        .prop("tint", || {
            tokens()
                .color("primary")
                .map_or(JsonValue::Null, |primary| color(primary).to_hex().into())
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

/// The tabs as the platforms read them: `[{ title, icon?, badge? }]`.
fn tabs_json(items: &[TabBarItem]) -> JsonValue {
    items
        .iter()
        .map(|item| {
            let mut tab = serde_json::Map::new();
            tab.insert("title".into(), item.title.as_ref().into());
            if let Some(icon) = &item.icon {
                tab.insert("icon".into(), icon.as_ref().into());
            }
            if let Some(badge) = &item.badge {
                tab.insert("badge".into(), badge.as_ref().into());
            }
            JsonValue::Object(tab)
        })
        .collect()
}

// --- The app's page in the system's settings ---------------------------------

/// Why [`open_app_settings`] failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum AppSettingsError {
    /// The platform has no settings page of the app's own (TS:
    /// `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`): only iOS and Android have
    /// one ([`app_settings_available`]).
    Unavailable,
    /// The app declares capabilities without `application` (TS:
    /// `ERR_ACCESS_DENIED`, `permission` `"application"`).
    Denied,
}

impl std::fmt::Display for AppSettingsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable => f.write_str(
                "AppSettings.open: this platform has no settings page of the app's own (iOS and \
                 Android have one)",
            ),
            Self::Denied => f.write_str(
                "AppSettings.open: the application is not granted: add `\"application\": true` to \
                 capabilities in nsh.json",
            ),
        }
    }
}

impl std::error::Error for AppSettingsError {}

impl AppSettingsError {
    /// The error JS gets: an `Error` with the code to branch on.
    pub(crate) fn js(self) -> crate::element::JsError {
        match self {
            Self::Unavailable => crate::element::JsError::Error(self.to_string())
                .with_code(crate::element::codes::UNAVAILABLE),
            Self::Denied => {
                crate::element::JsError::access_denied(self.to_string(), "application", "")
            }
        }
    }
}

/// Opens the app's own page in the system's settings (TS:
/// `AppSettings.open` of `nsh/mobile`): where the user turns back on a
/// permission they denied, as an "Open Settings" button beside the app's
/// explanation does. To await in a task: whether the system opened the
/// page; it fails with [`AppSettingsError::Unavailable`] where the platform
/// has no such page (all but iOS and Android; [`app_settings_available`])
/// and with [`AppSettingsError::Denied`] for an app that declares
/// capabilities without `application`. Drop it when the answer does not
/// matter.
pub fn open_app_settings() -> crate::element::Answer<Result<bool, AppSettingsError>> {
    let (answer, slot) = crate::element::Answer::new();
    crate::element::act(crate::element::Action::OpenAppSettings(slot));
    answer
}

/// Whether [`open_app_settings`] opens the app's page in the system's
/// settings here (TS: `AppSettings.available()` of `nsh/mobile`): on iOS
/// and Android, when the app's capabilities grant `application`. To await
/// in a task, before showing an "Open Settings" button.
pub fn app_settings_available() -> crate::element::Answer<bool> {
    let (answer, slot) = crate::element::Answer::new();
    crate::element::act(crate::element::Action::AppSettingsAvailable(slot));
    answer
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AppSettingsError, TabBarItem, tabs_json};

    #[test]
    fn app_settings_errors_carry_their_codes() {
        let unavailable = AppSettingsError::Unavailable.js();
        assert_eq!(
            unavailable.code(),
            Some("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM")
        );
        assert!(
            unavailable.message().contains("AppSettings.open"),
            "{unavailable:?}"
        );
        let denied = AppSettingsError::Denied.js();
        assert_eq!(denied.code(), Some("ERR_ACCESS_DENIED"));
        assert!(
            denied.message().contains("\"application\": true"),
            "{denied:?}"
        );
    }

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

    #[test]
    fn badges_reach_the_platform_as_texts_and_empty_ones() {
        let tabs = [
            TabBarItem::new("Inbox").badge("3"),
            TabBarItem::new("Brain").badge(""),
            TabBarItem::new("Stats"),
        ];
        assert_eq!(
            tabs_json(&tabs),
            json!([
                { "title": "Inbox", "badge": "3" },
                { "title": "Brain", "badge": "" },
                { "title": "Stats" },
            ])
        );
    }
}

//! Capabilities specific to iOS and Android (TS
//! `nsh/mobile`): the system's tab bar ([`TabBar`]), a native component the
//! two backends register themselves ([`TAB_BAR_COMPONENT`]), and the
//! system's segmented control ([`SegmentedControl`],
//! [`SEGMENTED_CONTROL_COMPONENT`], iOS's), switch ([`Switch`],
//! [`SWITCH_COMPONENT`]), and the system's date and time picker
//! ([`DateTimePicker`], [`DATE_TIME_PICKER_COMPONENT`], iOS's and
//! Android's). Elsewhere, and on a platform built outside NSH without a tab
//! bar ([`crate::platform::Environment::tab_bar`]), a component takes no room
//! and shows nothing. Common controls belong to `nsh/base`; this module
//! exposes the system's own controls where an app needs the platform's
//! exact look and behavior, rather than a parallel set of styled controls.
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

use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, Timelike};

use crate::{
    JsonValue,
    element::{JsHost, JsIn, JsOwned, JsValue, NativeEvent, PropError, TsTypes, native},
    platform::{
        DATE_TIME_PICKER_COMPONENT, Os, SEGMENTED_CONTROL_COMPONENT, SWITCH_COMPONENT,
        TAB_BAR_COMPONENT,
    },
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

/// One segment of a [`SegmentedControl`].
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct SegmentedControlItem {
    /// Its title: what the segment shows and what VoiceOver says (with an
    /// icon, only what VoiceOver says).
    pub title: SharedString,
    /// Its icon, an SF Symbol's name (`"sun.max"`), shown in place of the
    /// title.
    #[prop(skip_none)]
    pub icon: Option<SharedString>,
    /// The user cannot choose it (default false): the system dims it.
    #[prop(default)]
    pub disabled: bool,
}

impl SegmentedControlItem {
    /// A segment titled `title`, with no icon.
    pub fn new(title: impl Into<SharedString>) -> Self {
        Self {
            title: title.into(),
            ..Self::default()
        }
    }

    /// Its icon, an SF Symbol's name ([`SegmentedControlItem::icon`]).
    pub fn icon(mut self, name: impl Into<SharedString>) -> Self {
        self.icon = Some(name.into());
        self
    }

    /// Whether the user cannot choose it
    /// ([`SegmentedControlItem::disabled`]).
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// The props of [`SegmentedControl`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SegmentedControlProps {
    /// The segments, in order.
    #[prop(default)]
    pub items: Prop<Vec<SegmentedControlItem>>,
    /// The selected segment, by index (default 0; one past the segments
    /// selects none). The app owns it: the user's choice is reported with
    /// `onChange`.
    #[prop(default)]
    pub selected_index: Prop<u32>,
    /// No segment can be chosen (default false): the system dims the
    /// control and VoiceOver says it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
}

/// The events of a [`SegmentedControl`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum SegmentedControlEvent {
    /// The user chose another segment: its index. The control shows the
    /// choice at once, as the system's does; the app sets
    /// `selectedIndex`.
    #[args(index)]
    Change(u32),
}

/// The system's segmented control: a `UISegmentedControl` on iOS (Liquid
/// Glass on iOS 26 and later, the system's earlier look before), in the
/// system's look, behavior, VoiceOver and keyboard focus. The app gives
/// the segments (`items`), says which is selected (`selectedIndex`), hears
/// the user's choice (`onChange`) and places the control with its `class`
/// and `style`; its size is the system's where the style leaves it open (a
/// width the style gives is shared by the segments). New `items` change
/// the segments in place, and the selection follows `selectedIndex`. Other
/// platforms have no such control: there it takes no room and shows
/// nothing, and the app shows its choice with `nsh/base`'s `ToggleGroup` or
/// `RadioGroup`.
#[component]
pub fn SegmentedControl(
    props: SegmentedControlProps,
    cx: Scope<SegmentedControlEvent>,
) -> impl IntoElement {
    if os() != Os::Ios {
        return view().hidden().into_element();
    }
    let items = props.items;
    native(SEGMENTED_CONTROL_COMPONENT)
        .prop("items", move || items.with(|items| segments_json(items)))
        .prop("selectedIndex", move || {
            JsonValue::from(props.selected_index.get())
        })
        .prop("disabled", move || JsonValue::Bool(props.disabled.get()))
        .on_native_event(move |event: &NativeEvent| {
            if &*event.name == "change"
                && let Some(index) = event.data.as_u64()
            {
                cx.emit(SegmentedControlEvent::Change(index as u32));
            }
        })
        .into_element()
}

/// The segments as the platform reads them: `[{ title, icon?, disabled? }]`.
fn segments_json(items: &[SegmentedControlItem]) -> JsonValue {
    items
        .iter()
        .map(|item| {
            let mut segment = serde_json::Map::new();
            segment.insert("title".into(), item.title.as_ref().into());
            if let Some(icon) = &item.icon {
                segment.insert("icon".into(), icon.as_ref().into());
            }
            if item.disabled {
                segment.insert("disabled".into(), true.into());
            }
            JsonValue::Object(segment)
        })
        .collect()
}

/// The props of [`Switch`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SwitchProps {
    /// On or off (default off). The app owns the value: the user's flip is
    /// reported with `onChange`, and the switch shows the value the app
    /// passes back.
    #[prop(default)]
    pub checked: Prop<bool>,
    /// It cannot be flipped (default false): the system dims it and screen
    /// readers say it is dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers say with the switch's state: the setting it
    /// turns on (`"Notifications"`).
    pub accessibility_label: Prop<Option<SharedString>>,
}

/// The events of a [`Switch`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum SwitchEvent {
    /// The user flipped the switch: the value it asks for. The switch moves
    /// at once, as the system's does; the app sets `checked`, and a value
    /// the app keeps moves it back.
    #[args(checked)]
    Change(bool),
}

/// The system's switch, in the system's look, motion, haptics and
/// accessibility: a `UISwitch` on iOS (Liquid Glass on iOS 26 and later),
/// Material 3's switch on Android. The app says whether it is on
/// (`checked`), hears the user's flip (`onChange`), names it for screen
/// readers (`accessibilityLabel`) and places it with its `class` and
/// `style`; its size is the system's where the style leaves it open. It
/// is on in its style's `accentColor` (`accent-*`), else in the theme's
/// `primary` (the system's color without either). The
/// desktops and the web have no such control: there it takes no room and
/// shows nothing, and the app shows the setting with `nsh/base`'s
/// `Switch`.
#[component]
pub fn Switch(props: SwitchProps, cx: Scope<SwitchEvent>) -> impl IntoElement {
    if !matches!(os(), Os::Ios | Os::Android) {
        return view().hidden().into_element();
    }
    // The control moves itself under the finger. Each flip bumps
    // `revision` after the app has heard it, and the switch then shows
    // `checked` again: a value the app keeps (it turned the flip down)
    // moves it back, as an unchanged `checked` is not sent again.
    let flips = signal(0u32);
    native(SWITCH_COMPONENT)
        .prop("checked", move || JsonValue::Bool(props.checked.get()))
        .prop("revision", move || JsonValue::from(flips.get()))
        .prop("disabled", move || JsonValue::Bool(props.disabled.get()))
        .prop("accessibilityLabel", move || {
            props
                .accessibility_label
                .get()
                .map_or(JsonValue::Null, |label| label.as_ref().into())
        })
        // One color, for the appearance shown: sent again when either changes.
        .prop("tint", || {
            tokens()
                .color("primary")
                .map_or(JsonValue::Null, |primary| color(primary).to_hex().into())
        })
        .on_native_event(move |event: &NativeEvent| {
            if &*event.name == "change"
                && let Some(checked) = event.data.as_bool()
            {
                cx.emit(SwitchEvent::Change(checked));
                flips.update(|n| *n = n.wrapping_add(1));
            }
        })
        .into_element()
}

/// What a [`DateTimePicker`] picks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum DateTimePickerMode {
    /// A day (default).
    #[default]
    Date,
    /// A time of day, in hours and minutes.
    Time,
    /// A day and a time of day.
    DateTime,
}

/// A [`DateTimePicker`]'s value: a day, a time of day or both, as the
/// picker shows them (a wall-clock time, in no time zone: the app gives
/// the one it means). TS: an ISO string, as HTML's date and time inputs
/// take it: `"2026-11-17"`, `"09:30"`, `"2026-11-17T09:30"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DateTimePickerValue {
    /// A day, `"2026-11-17"` (the `date` mode's).
    Date(NaiveDate),
    /// A time of day, `"09:30"` (the `time` mode's).
    Time(NaiveTime),
    /// A day and a time of day, `"2026-11-17T09:30"` (the `dateTime`
    /// mode's).
    DateTime(NaiveDateTime),
}

impl From<NaiveDate> for DateTimePickerValue {
    fn from(value: NaiveDate) -> Self {
        Self::Date(value)
    }
}

impl From<NaiveTime> for DateTimePickerValue {
    fn from(value: NaiveTime) -> Self {
        Self::Time(value)
    }
}

impl From<NaiveDateTime> for DateTimePickerValue {
    fn from(value: NaiveDateTime) -> Self {
        Self::DateTime(value)
    }
}

impl DateTimePickerValue {
    /// The value an ISO string (`"2026-11-17"`, `"09:30"`,
    /// `"2026-11-17T09:30"`) gives; `None` for anything else, seconds
    /// included: the pickers show minutes.
    pub fn parse(text: &str) -> Option<Self> {
        if let Ok(v) = NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M") {
            Some(Self::DateTime(v))
        } else if let Ok(v) = NaiveDate::parse_from_str(text, "%Y-%m-%d") {
            Some(Self::Date(v))
        } else {
            NaiveTime::parse_from_str(text, "%H:%M")
                .ok()
                .map(Self::Time)
        }
    }

    /// The value as an ISO string.
    pub fn iso(&self) -> String {
        match self {
            Self::Date(v) => v.format("%Y-%m-%d").to_string(),
            Self::Time(v) => v.format("%H:%M").to_string(),
            Self::DateTime(v) => v.format("%Y-%m-%dT%H:%M").to_string(),
        }
    }

    /// The mode whose values it is.
    pub fn mode(&self) -> DateTimePickerMode {
        match self {
            Self::Date(_) => DateTimePickerMode::Date,
            Self::Time(_) => DateTimePickerMode::Time,
            Self::DateTime(_) => DateTimePickerMode::DateTime,
        }
    }

    /// The value as the platforms read it: its fields
    /// (`{ year, month, day }`, `{ hour, minute }` or all five).
    fn fields(&self) -> JsonValue {
        let mut fields = serde_json::Map::new();
        let date = match self {
            Self::Date(d) => Some(*d),
            Self::DateTime(v) => Some(v.date()),
            Self::Time(_) => None,
        };
        let time = match self {
            Self::Time(t) => Some(*t),
            Self::DateTime(v) => Some(v.time()),
            Self::Date(_) => None,
        };
        if let Some(date) = date {
            fields.insert("year".into(), date.year().into());
            fields.insert("month".into(), date.month().into());
            fields.insert("day".into(), date.day().into());
        }
        if let Some(time) = time {
            fields.insert("hour".into(), time.hour().into());
            fields.insert("minute".into(), time.minute().into());
        }
        JsonValue::Object(fields)
    }

    /// The value of `mode` a platform's `{ year, month, day, hour, minute }`
    /// gives; `None` when a field is missing or out of range.
    fn of_fields(mode: DateTimePickerMode, fields: &JsonValue) -> Option<Self> {
        let field = |name: &str| -> Option<u32> { fields.get(name)?.as_u64()?.try_into().ok() };
        let date = || {
            NaiveDate::from_ymd_opt(
                field("year")?.try_into().ok()?,
                field("month")?,
                field("day")?,
            )
        };
        let time = || NaiveTime::from_hms_opt(field("hour")?, field("minute")?, 0);
        Some(match mode {
            DateTimePickerMode::Date => Self::Date(date()?),
            DateTimePickerMode::Time => Self::Time(time()?),
            DateTimePickerMode::DateTime => Self::DateTime(date()?.and_time(time()?)),
        })
    }
}

impl JsValue for DateTimePickerValue {
    fn ts_type(_types: &mut TsTypes) -> String {
        "string".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        value
            .as_string()
            .and_then(|s| Self::parse(&s))
            .ok_or_else(|| {
                value.expected(
                    "an ISO date or time (`\"2026-11-17\"`, `\"09:30\"`, `\"2026-11-17T09:30\"`)",
                )
            })
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        SharedString::from(self.iso()).to_js(host)
    }
}

/// The props of [`DateTimePicker`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct DateTimePickerProps {
    /// What it picks: a day (default), a time of day or both.
    #[prop(default)]
    pub mode: Prop<DateTimePickerMode>,
    /// The value shown, in the mode's form (`"2026-11-17"`, `"09:30"`,
    /// `"2026-11-17T09:30"`); none shows the present day and time, as the
    /// system's pickers do. The app owns it: the user's pick is reported
    /// with `onChange`.
    pub value: Prop<Option<DateTimePickerValue>>,
    /// The earliest value the user can pick, in the mode's form.
    pub min: Prop<Option<DateTimePickerValue>>,
    /// The latest value the user can pick, in the mode's form.
    pub max: Prop<Option<DateTimePickerValue>>,
    /// The minutes offered are this many apart (default 1): 1 to 30, a
    /// divisor of 60 (`5`, `15`, `30`).
    #[prop(default = 1)]
    pub minute_interval: Prop<u32>,
    /// It cannot be changed (default false): the system dims it.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers say with its value: what it sets (`"Due
    /// date"`). The picker shows only the value, so a label beside it
    /// names it for sighted users alone.
    pub accessibility_label: Prop<Option<SharedString>>,
}

/// The events of a [`DateTimePicker`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum DateTimePickerEvent {
    /// The user picked a value, in the mode's form. The picker shows it at
    /// once, as the system's does; the app sets `value`.
    #[args(value)]
    Change(DateTimePickerValue),
}

/// The system's date and time picker, in the system's look, behavior and
/// accessibility: on iOS a `UIDatePicker` in its compact style (a value in
/// a capsule that opens the system's calendar or time wheels; a day and a
/// time are two), on Android the value in a field that opens the system's
/// date or time dialog. The app says what it picks (`mode`), gives the
/// value (`value`, a wall-clock time the app ties to its time zone), its
/// bounds (`min`, `max`) and the minutes' step (`minuteInterval`), names it
/// for screen readers (`accessibilityLabel`), hears the user's pick
/// (`onChange`) and places the picker with its `class` and `style`; its
/// size is the system's where the style leaves it open. The desktops and
/// the web have no such control: there it takes no room and shows
/// nothing, and the app picks with `nsh/base`'s `DatePicker` and
/// `TimeField`.
#[component]
pub fn DateTimePicker(
    props: DateTimePickerProps,
    cx: Scope<DateTimePickerEvent>,
) -> impl IntoElement {
    if !matches!(os(), Os::Ios | Os::Android) {
        return view().hidden().into_element();
    }
    let mode = props.mode;
    // A value of another mode's form is not shown as something else: the
    // picker shows the present, as with none.
    let fields = move |value: Option<DateTimePickerValue>, prop: &str| match value {
        Some(value) if value.mode() == mode.get() => value.fields(),
        Some(value) => {
            log::warn!(
                target: "js",
                "DateTimePicker: `{prop}` {:?} is not a value of mode `{}`",
                value.iso(),
                mode.get().js_name()
            );
            JsonValue::Null
        }
        None => JsonValue::Null,
    };
    native(DATE_TIME_PICKER_COMPONENT)
        .prop("mode", move || JsonValue::from(mode.get().js_name()))
        .prop("value", move || fields(props.value.get(), "value"))
        .prop("min", move || fields(props.min.get(), "min"))
        .prop("max", move || fields(props.max.get(), "max"))
        .prop("minuteInterval", move || {
            let interval = props.minute_interval.get();
            if (1..=30).contains(&interval) && 60 % interval == 0 {
                JsonValue::from(interval)
            } else {
                log::warn!(
                    target: "js",
                    "DateTimePicker: `minuteInterval` {interval} is not a divisor of 60 from 1 to 30; the minutes step by 1"
                );
                JsonValue::from(1)
            }
        })
        .prop("disabled", move || JsonValue::Bool(props.disabled.get()))
        .prop("accessibilityLabel", move || {
            props
                .accessibility_label
                .get()
                .map_or(JsonValue::Null, |label| label.as_ref().into())
        })
        .on_native_event(move |event: &NativeEvent| {
            if &*event.name == "change"
                && let Some(value) = DateTimePickerValue::of_fields(mode.get_untracked(), &event.data)
            {
                cx.emit(DateTimePickerEvent::Change(value));
            }
        })
        .into_element()
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
    use chrono::{NaiveDate, NaiveTime};
    use serde_json::json;

    use super::{
        AppSettingsError, DateTimePickerMode, DateTimePickerValue, SegmentedControlItem,
        TabBarItem, segments_json, tabs_json,
    };

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
    fn picker_values_are_iso_strings_of_minutes() {
        let day = NaiveDate::from_ymd_opt(2026, 11, 17).unwrap();
        let time = NaiveTime::from_hms_opt(9, 30, 0).unwrap();
        for (text, value) in [
            ("2026-11-17", DateTimePickerValue::Date(day)),
            ("09:30", DateTimePickerValue::Time(time)),
            (
                "2026-11-17T09:30",
                DateTimePickerValue::DateTime(day.and_time(time)),
            ),
        ] {
            assert_eq!(DateTimePickerValue::parse(text), Some(value), "{text}");
            assert_eq!(value.iso(), text);
        }
        for text in [
            "09:30:15",
            "2026-11-17T09:30:00",
            "2026-02-30",
            "25:00",
            "",
            "today",
        ] {
            assert_eq!(DateTimePickerValue::parse(text), None, "{text}");
        }
    }

    #[test]
    fn picker_values_reach_the_platform_as_fields_and_come_back_in_the_mode() {
        let value = DateTimePickerValue::parse("2026-11-17T09:30").unwrap();
        let fields = json!({ "year": 2026, "month": 11, "day": 17, "hour": 9, "minute": 30 });
        assert_eq!(value.fields(), fields);
        assert_eq!(
            DateTimePickerValue::parse("2026-11-17").unwrap().fields(),
            json!({ "year": 2026, "month": 11, "day": 17 })
        );
        assert_eq!(
            DateTimePickerValue::parse("09:30").unwrap().fields(),
            json!({ "hour": 9, "minute": 30 })
        );
        assert_eq!(
            DateTimePickerValue::of_fields(DateTimePickerMode::DateTime, &fields),
            Some(value)
        );
        assert_eq!(
            DateTimePickerValue::of_fields(DateTimePickerMode::Date, &fields),
            DateTimePickerValue::parse("2026-11-17")
        );
        assert_eq!(
            DateTimePickerValue::of_fields(DateTimePickerMode::Time, &fields),
            DateTimePickerValue::parse("09:30")
        );
        let bad = json!({ "year": 2026, "month": 2, "day": 30, "hour": 9, "minute": 30 });
        assert_eq!(
            DateTimePickerValue::of_fields(DateTimePickerMode::Date, &bad),
            None
        );
        assert_eq!(
            DateTimePickerValue::of_fields(DateTimePickerMode::Time, &json!({ "hour": 9 })),
            None
        );
    }

    #[test]
    fn segments_reach_the_platform_as_titles_icons_and_disabled() {
        let segments = [
            SegmentedControlItem::new("Light").icon("sun.max"),
            SegmentedControlItem::new("Dark").disabled(true),
        ];
        assert_eq!(
            segments_json(&segments),
            json!([
                { "title": "Light", "icon": "sun.max" },
                { "title": "Dark", "disabled": true },
            ])
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

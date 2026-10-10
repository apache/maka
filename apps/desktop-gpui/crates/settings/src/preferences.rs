/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Client preferences: the interface language, the appearance (theme,
//! palette, UI font size, the app icon for each appearance), the custom pet
//! the main window shows, whether a finished task posts a system
//! notification, and the settings section last shown. They belong to this
//! client, not to the Runtime Host, so they live in a small file in the
//! client's config directory, not in the State Root; Maka Desktop keeps the
//! same choices in its own settings file (`appearance`, `notifications`,
//! `personalization.uiLocale` and `selectedPetId` in
//! packages/core/src/settings.ts) and the section in local storage
//! (`maka-settings-section-v1`).
//!
//! The language may follow the system: [`Language::System`] resolves to the
//! first supported language in the operating system's preferred list
//! ([`resolve_system_locale`]), read at startup and again whenever it is
//! chosen, as Maka Desktop's `auto` does. A change of the system language
//! reaches the app at its next launch, as it does every macOS app.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::ops::RangeInclusive;
use std::path::PathBuf;
use std::rc::Rc;

use futures_lite::future::Boxed;
use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::{App, AppContext as _, Context, Entity, Global, Task, Window, WindowAppearance};
use pet::PetPackId;
use serde::{Deserialize, Serialize};
use shared::copy::settings as copy;
use shared::copy::{Locale, Text};
use shared::palette::ThemePalette;
use shared::theme::{DEFAULT_UI_FONT_SIZE, set_theme_palette, set_ui_font_size};
use workspace::{client_config_file, read_config_file, write_config_file};

use crate::app_icon::{AppIconChoice, AppIconTarget, DEFAULT_APP_ICON, DEFAULT_APP_ICON_DARK};
use crate::section::SettingsSection;
use crate::usage_page::UsageView;

/// The file under the client's config directory that keeps the preferences.
pub const PREFERENCES_FILE: &str = "preferences.json";

/// Preferences are a few words and a few task ids (the changes panel's);
/// a larger file is not ours.
const MAX_PREFERENCES_BYTES: u64 = 64 * 1024;

/// The interface language, as the preference file records it: one of the
/// copy table's [`Locale`]s, or the system's.
///
/// A fresh install follows the system, as Maka Desktop's (`uiLocale: 'auto'`
/// in `createDefaultSettings`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub enum Language {
    /// The system's preferred language, when the app speaks it; else English.
    #[default]
    #[serde(rename = "system")]
    System,
    #[serde(rename = "en")]
    English,
    #[serde(rename = "zh-Hans")]
    SimplifiedChinese,
    #[serde(rename = "zh-Hant")]
    TraditionalChinese,
}

impl Language {
    /// Every language, in the order the menus list them: Follow system
    /// first, as in Maka Desktop's language picker.
    pub const ALL: [Self; 4] =
        [Self::System, Self::English, Self::SimplifiedChinese, Self::TraditionalChinese];

    /// The language's name as language pickers show it: each language in
    /// itself, so a person finds theirs whatever the interface speaks;
    /// Follow system in `locale`.
    pub fn label(self, locale: Locale) -> &'static str {
        match self {
            Self::System => copy::LANGUAGE_SYSTEM.in_locale(locale),
            Self::English => "English",
            Self::SimplifiedChinese => "简体中文",
            Self::TraditionalChinese => "繁體中文",
        }
    }

    /// The copy table's locale for this language; `None` for the system's,
    /// which [`AppPreferences`] resolves.
    pub fn locale(self) -> Option<Locale> {
        match self {
            Self::System => None,
            Self::English => Some(Locale::English),
            Self::SimplifiedChinese => Some(Locale::SimplifiedChinese),
            Self::TraditionalChinese => Some(Locale::TraditionalChinese),
        }
    }

    /// The language of a copy table locale.
    pub fn of(locale: Locale) -> Self {
        match locale {
            Locale::English => Self::English,
            Locale::SimplifiedChinese => Self::SimplifiedChinese,
            Locale::TraditionalChinese => Self::TraditionalChinese,
        }
    }

    /// A stable key for element ids.
    pub fn key(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::English => "en",
            Self::SimplifiedChinese => "zh-Hans",
            Self::TraditionalChinese => "zh-Hant",
        }
    }
}

/// The interface locale for the operating system's preferred `languages`
/// (BCP 47 tags, most preferred first): the first Chinese or English one,
/// Traditional for `zh-Hant` and the Taiwan, Hong Kong, and Macau regions;
/// English when none is. Mirrors `resolveSystemUiLocale` in
/// packages/core/src/ui-locale.ts.
pub fn resolve_system_locale<S: AsRef<str>>(languages: &[S]) -> Locale {
    for language in languages {
        let tag = language.as_ref().trim().replace('_', "-").to_ascii_lowercase();
        let mut subtags = tag.split(['-', '.']);
        match subtags.next() {
            Some("zh") => {
                return match subtags.next() {
                    Some("tw" | "hk" | "mo" | "hant") => Locale::TraditionalChinese,
                    _ => Locale::SimplifiedChinese,
                };
            }
            Some("en") => return Locale::English,
            _ => {}
        }
    }
    Locale::English
}

/// The operating system's preferred languages, most preferred first.
fn system_languages() -> Vec<String> {
    sys_locale::get_locales().collect()
}

/// Light or dark, or whatever the system uses.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl Appearance {
    /// Every appearance, in the order the menus list them.
    pub const ALL: [Self; 3] = [Self::System, Self::Light, Self::Dark];

    pub fn label(self) -> Text {
        match self {
            Self::System => copy::APPEARANCE_SYSTEM,
            Self::Light => copy::APPEARANCE_LIGHT,
            Self::Dark => copy::APPEARANCE_DARK,
        }
    }

    /// A stable key for element ids.
    pub fn key(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

/// The UI font sizes offered, Maka Desktop's in its steps of one pixel
/// (`UI_FONT_SIZE_MIN` to `UI_FONT_SIZE_MAX` in packages/core/src/settings.ts).
/// The whole type scale follows the size, so at the smallest the 12px
/// supporting text (ages, captions, details) is drawn at about 9.4px, as
/// Desktop draws it.
pub const UI_FONT_SIZES: RangeInclusive<u8> = 11..=22;

/// A one-pixel change of the UI font size, or the default again: View ›
/// Zoom In, Zoom Out and Actual Size (Desktop's Electron `zoomIn`,
/// `zoomOut` and `resetZoom`), and the Appearance stepper's buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontSizeStep {
    Larger,
    Smaller,
    Default,
}

/// What the sidebar becomes when the window is too narrow for it beside the
/// composer, and when the person collapses it (the toggle, ⌘B): a rail of
/// its icons, or nothing. This client's own; Desktop has no such choice.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum NarrowSidebar {
    /// A rail of the sidebar's icons.
    #[default]
    Icons,
    /// Nothing: the plate takes the window, and the sidebar opens over it.
    Hide,
}

impl NarrowSidebar {
    /// Both, in the order the setting lists them.
    pub const ALL: [Self; 2] = [Self::Icons, Self::Hide];

    pub fn label(self) -> Text {
        match self {
            Self::Icons => copy::NARROW_SIDEBAR_ICONS,
            Self::Hide => copy::NARROW_SIDEBAR_HIDE,
        }
    }

    /// A stable key for element ids.
    pub fn key(self) -> &'static str {
        match self {
            Self::Icons => "icons",
            Self::Hide => "hide",
        }
    }
}

/// The widths the expanded sidebar can be dragged to, in pixels at the
/// default UI font size: Desktop's (`SESSION_LIST_EXPANDED_MIN_WIDTH` and
/// `_MAX_WIDTH` in
/// apps/desktop/src/renderer/features/session-navigation/model/session-list-layout.ts).
pub const SIDEBAR_WIDTHS: RangeInclusive<u16> = 180..=480;

/// The changes panel's widths in the preferences' pixels: from Desktop's
/// `SESSION_WORKBAR_MIN_WIDTH`, with no ceiling of their own (Desktop's
/// 600 was too narrow to review in); the window sets one, as the panel
/// leaves the conversation its least width.
pub const REVIEW_WIDTHS: RangeInclusive<u16> = 340..=u16::MAX;

/// The changes panel's width until it is dragged, and after a double-click
/// on its edge: Desktop's `SESSION_WORKBAR_DEFAULT_WIDTH`.
pub const DEFAULT_REVIEW_WIDTH: u16 = 480;

/// The sidebar's width until it is dragged, and after a double-click on its
/// edge: this client's 256 (Desktop's is 260), the width it was reviewed at.
pub const DEFAULT_SIDEBAR_WIDTH: u16 = 256;

/// The kind of face a task's workbar shows: the changes, the task's files,
/// a terminal (which one is not kept: terminals are the Host's, and a task
/// shown again shows its first live one), or the task's trace.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum WorkbarFace {
    #[default]
    Changes,
    Files,
    Terminal,
    Inspector,
    /// One of the task's side chats (which one is not kept, nor are they:
    /// a task shown again in a new run of the app has none, so its panel
    /// shows its first open face).
    SideChat,
}

/// What the person chose. Missing or unknown values read as the defaults,
/// so a file from a newer or older client never stops the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
#[non_exhaustive]
pub struct Preferences {
    #[serde(deserialize_with = "or_default")]
    pub language: Language,
    #[serde(deserialize_with = "or_default")]
    pub appearance: Appearance,
    /// Desktop's `appearance.palette`, by its id.
    #[serde(with = "palette_id")]
    pub palette: ThemePalette,
    /// Desktop's `appearance.uiFontSize`: the base font size in pixels,
    /// one of [`UI_FONT_SIZES`].
    #[serde(deserialize_with = "font_size")]
    pub ui_font_size: u8,
    /// Desktop's `notifications.runComplete`: a task that finishes, fails,
    /// or waits for an answer while the window is in the background posts
    /// a system notification. On by default.
    #[serde(deserialize_with = "on_unless_false")]
    pub run_notifications: bool,
    /// The section settings open on: the one shown last, Models at first.
    #[serde(with = "section_key")]
    pub settings_section: SettingsSection,
    /// Desktop's `appearance.appIcon`: the icon the Dock shows, in both
    /// appearances unless [`Self::app_icon_dark`] is set.
    #[serde(deserialize_with = "app_icon", skip_serializing_if = "is_default_app_icon")]
    pub app_icon: AppIconChoice,
    /// Desktop's `appearance.appIconDark`: a separate icon while the app is
    /// dark; none for one icon everywhere.
    #[serde(deserialize_with = "dark_app_icon", skip_serializing_if = "Option::is_none")]
    pub app_icon_dark: Option<AppIconChoice>,
    /// Desktop's `personalization.selectedPetId`: the pet the main window
    /// shows, from the State Root's library; none shows no pet.
    #[serde(
        rename = "selectedPetId",
        deserialize_with = "pet_id",
        skip_serializing_if = "Option::is_none"
    )]
    pub selected_pet: Option<PetPackId>,
    /// Desktop's `usage`: the Usage page's range, tab, status filter, and
    /// whether its detailed records show.
    #[serde(deserialize_with = "or_default", skip_serializing_if = "UsageView::is_default")]
    pub usage: UsageView,
    /// What the sidebar collapses to when the window narrows or the person
    /// collapses it.
    #[serde(deserialize_with = "or_default", skip_serializing_if = "is_default_narrow_sidebar")]
    pub narrow_sidebar: NarrowSidebar,
    /// The expanded sidebar's width, as dragged (Desktop's
    /// `maka-chat-list-width-v1`), within [`SIDEBAR_WIDTHS`], in pixels at
    /// the default UI font size: the sidebar scales with the font as the
    /// rest of the window does.
    #[serde(deserialize_with = "sidebar_width", skip_serializing_if = "is_default_sidebar_width")]
    pub sidebar_width: u16,
    /// The tasks whose changes panel is open (Desktop's per-Session
    /// `maka-session-workbar-collapsed-v2`; a task not listed has it
    /// closed).
    #[serde(deserialize_with = "or_default", skip_serializing_if = "BTreeSet::is_empty")]
    pub review_open: BTreeSet<String>,
    /// The changes panel's width, as dragged (Desktop's
    /// `maka-session-workbar-width-v1`), within [`REVIEW_WIDTHS`], in pixels
    /// at the default UI font size, as the sidebar's.
    #[serde(deserialize_with = "review_width", skip_serializing_if = "is_default_review_width")]
    pub review_width: u16,
    /// The branch each task's changes are compared against, as a fully
    /// qualified ref, when the person picked one (Desktop's
    /// `maka-session-review-base-branch-v1`).
    #[serde(deserialize_with = "or_default", skip_serializing_if = "BTreeMap::is_empty")]
    pub review_base_branches: BTreeMap<String, String>,
    /// The tasks whose changes panel fills the plate in the conversation's
    /// place while it is open (Desktop's per-Session focused Workbar tool).
    #[serde(deserialize_with = "or_default", skip_serializing_if = "BTreeSet::is_empty")]
    pub review_maximized: BTreeSet<String>,
    /// The face each task's workbar shows, where it is not the changes.
    #[serde(deserialize_with = "or_default", skip_serializing_if = "BTreeMap::is_empty")]
    pub workbar_faces: BTreeMap<String, WorkbarFace>,
    /// The tasks whose workbar has its Changes face closed (open unless
    /// listed: Desktop persists the `review` tool's tab).
    #[serde(deserialize_with = "or_default", skip_serializing_if = "BTreeSet::is_empty")]
    pub workbar_changes_closed: BTreeSet<String>,
    /// The tasks whose workbar has its Files face open (closed unless
    /// listed; Desktop persists the `files` tool's tab).
    #[serde(deserialize_with = "or_default", skip_serializing_if = "BTreeSet::is_empty")]
    pub workbar_files_open: BTreeSet<String>,
    /// The tasks whose workbar has its Trace face open (closed unless
    /// listed; Desktop persists the `inspector` tool's tab).
    #[serde(deserialize_with = "or_default", skip_serializing_if = "BTreeSet::is_empty")]
    pub workbar_inspector_open: BTreeSet<String>,
    /// Whether Option sends Meta (Escape and the key) to a terminal's
    /// program rather than compose text, as macOS terminals offer. Off.
    #[serde(deserialize_with = "or_default", skip_serializing_if = "is_false")]
    pub terminal_option_as_meta: bool,
    /// Whether a terminal's cursor blinks where the program has not chosen
    /// a style. On.
    #[serde(deserialize_with = "on_unless_false", skip_serializing_if = "is_true")]
    pub terminal_cursor_blink: bool,
    /// Whether closing a side chat that has a conversation goes without
    /// asking (its confirmation's "Don't ask again"; Desktop's
    /// `maka-skip-side-chat-close-confirmation-v1`). Off.
    #[serde(deserialize_with = "or_default", skip_serializing_if = "is_false")]
    pub side_chat_close_unconfirmed: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            language: Language::default(),
            appearance: Appearance::default(),
            palette: ThemePalette::Default,
            ui_font_size: DEFAULT_UI_FONT_SIZE,
            run_notifications: true,
            settings_section: SettingsSection::Models,
            app_icon: AppIconChoice::Shipped(DEFAULT_APP_ICON),
            app_icon_dark: None,
            selected_pet: None,
            usage: UsageView::default(),
            narrow_sidebar: NarrowSidebar::default(),
            sidebar_width: DEFAULT_SIDEBAR_WIDTH,
            review_open: BTreeSet::new(),
            review_width: DEFAULT_REVIEW_WIDTH,
            review_base_branches: BTreeMap::new(),
            review_maximized: BTreeSet::new(),
            workbar_faces: BTreeMap::new(),
            workbar_changes_closed: BTreeSet::new(),
            workbar_files_open: BTreeSet::new(),
            workbar_inspector_open: BTreeSet::new(),
            terminal_option_as_meta: false,
            terminal_cursor_blink: true,
            side_chat_close_unconfirmed: false,
        }
    }
}

impl Preferences {
    /// `language` and `appearance`, with every other preference at its
    /// default.
    pub fn new(language: Language, appearance: Appearance) -> Self {
        Self { language, appearance, ..Self::default() }
    }

    pub fn with_palette(mut self, palette: ThemePalette) -> Self {
        self.palette = palette;
        self
    }

    pub fn with_ui_font_size(mut self, size: u8) -> Self {
        self.ui_font_size = clamp_font_size(size);
        self
    }

    pub fn with_run_notifications(mut self, on: bool) -> Self {
        self.run_notifications = on;
        self
    }

    pub fn with_settings_section(mut self, section: SettingsSection) -> Self {
        self.settings_section = remembered_section(section);
        self
    }

    /// `light` in light appearance, and `dark` (or `light` again when none)
    /// in dark.
    pub fn with_app_icon(mut self, light: AppIconChoice, dark: Option<AppIconChoice>) -> Self {
        self.app_icon = light;
        self.app_icon_dark = dark;
        self
    }

    pub fn with_selected_pet(mut self, pet: Option<PetPackId>) -> Self {
        self.selected_pet = pet;
        self
    }

    pub fn with_narrow_sidebar(mut self, narrow: NarrowSidebar) -> Self {
        self.narrow_sidebar = narrow;
        self
    }

    pub fn with_sidebar_width(mut self, width: u16) -> Self {
        self.sidebar_width = clamp_sidebar_width(width);
        self
    }
}

/// `size` within [`UI_FONT_SIZES`].
fn clamp_font_size(size: u8) -> u8 {
    size.clamp(*UI_FONT_SIZES.start(), *UI_FONT_SIZES.end())
}

/// `width` within [`SIDEBAR_WIDTHS`].
pub fn clamp_sidebar_width(width: u16) -> u16 {
    width.clamp(*SIDEBAR_WIDTHS.start(), *SIDEBAR_WIDTHS.end())
}

/// `width` within [`REVIEW_WIDTHS`].
pub fn clamp_review_width(width: u16) -> u16 {
    width.clamp(*REVIEW_WIDTHS.start(), *REVIEW_WIDTHS.end())
}

/// The section to remember for `section`: Models for one this client has
/// not built (Desktop's `readLastSettingsSection` reads an unknown one as
/// Models).
fn remembered_section(section: SettingsSection) -> SettingsSection {
    if section.implemented() { section } else { SettingsSection::Models }
}

/// A palette by Desktop's id; an id Desktop does not know reads as the
/// default palette, as Desktop's `isThemePalette` check does.
mod palette_id {
    use serde::{Deserialize as _, Deserializer, Serializer};
    use shared::palette::ThemePalette;

    pub(super) fn serialize<S: Serializer>(
        palette: &ThemePalette,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(palette.id())
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<ThemePalette, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(value.as_str().and_then(ThemePalette::from_id).unwrap_or_default())
    }
}

/// A section by its key; one this client has not built reads as Models.
mod section_key {
    use serde::{Deserialize as _, Deserializer, Serializer};

    use crate::section::SettingsSection;

    pub(super) fn serialize<S: Serializer>(
        section: &SettingsSection,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(section.key())
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<SettingsSection, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        let named = value
            .as_str()
            .and_then(|key| SettingsSection::listed().find(|section| section.key() == key));
        Ok(named.unwrap_or(SettingsSection::Models))
    }
}

/// Desktop's `normalizeUiFontSize`: a number is rounded and clamped into
/// [`UI_FONT_SIZES`]; anything else reads as the default.
fn font_size<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u8, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let size = match value.as_f64().filter(|size| size.is_finite()) {
        Some(size) => {
            let (low, high) = (*UI_FONT_SIZES.start(), *UI_FONT_SIZES.end());
            // Within u8 once clamped.
            size.round().clamp(f64::from(low), f64::from(high)) as u8
        }
        None => DEFAULT_UI_FONT_SIZE,
    };
    Ok(size)
}

/// Desktop's `readSessionListWidth`: a positive number is rounded and
/// clamped into [`SIDEBAR_WIDTHS`]; anything else reads as the default.
fn sidebar_width<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u16, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let width = match value.as_f64().filter(|width| width.is_finite() && *width > 0.) {
        Some(width) => {
            let (low, high) = (*SIDEBAR_WIDTHS.start(), *SIDEBAR_WIDTHS.end());
            // Within u16 once clamped.
            width.round().clamp(f64::from(low), f64::from(high)) as u16
        }
        None => DEFAULT_SIDEBAR_WIDTH,
    };
    Ok(width)
}

fn is_default_sidebar_width(width: &u16) -> bool {
    *width == DEFAULT_SIDEBAR_WIDTH
}

/// Desktop's `readSessionWorkbarWidth` and its clamp: a positive number is
/// rounded and clamped into [`REVIEW_WIDTHS`]; anything else reads as the
/// default.
fn review_width<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u16, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let width = match value.as_f64().filter(|width| width.is_finite() && *width > 0.) {
        Some(width) => {
            let (low, high) = (*REVIEW_WIDTHS.start(), *REVIEW_WIDTHS.end());
            // Within u16 once clamped.
            width.round().clamp(f64::from(low), f64::from(high)) as u16
        }
        None => DEFAULT_REVIEW_WIDTH,
    };
    Ok(width)
}

fn is_default_review_width(width: &u16) -> bool {
    *width == DEFAULT_REVIEW_WIDTH
}

fn is_false(value: &bool) -> bool {
    !value
}

fn is_true(value: &bool) -> bool {
    *value
}

fn is_default_narrow_sidebar(narrow: &NarrowSidebar) -> bool {
    *narrow == NarrowSidebar::default()
}

fn is_default_app_icon(icon: &AppIconChoice) -> bool {
    *icon == AppIconChoice::Shipped(DEFAULT_APP_ICON)
}

/// Desktop's `appIcon` normalization: an id it does not know reads as the
/// default icon.
fn app_icon<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<AppIconChoice, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_str().and_then(AppIconChoice::parse).unwrap_or_default())
}

/// Desktop's `normalizedDarkAppIcon`: absent is one icon everywhere (the
/// field's default); present but not an icon reads as the shipped dark
/// recommendation, never as absent.
fn dark_app_icon<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<AppIconChoice>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    let icon = value.as_str().and_then(AppIconChoice::parse);
    Ok(Some(icon.unwrap_or(AppIconChoice::Shipped(DEFAULT_APP_ICON_DARK))))
}

/// Desktop's `normalizeSelectedPetId`: a canonical pack id, or no pet.
fn pet_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<PetPackId>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_str().and_then(PetPackId::parse))
}

/// A switch that is on unless the file says `false` (Desktop reads a
/// non-boolean `runComplete` as on).
fn on_unless_false<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(value.as_bool().unwrap_or(true))
}

/// A value this client does not know reads as the default.
fn or_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned + Default,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// Keeps the preferences across launches.
pub trait PreferencesStore: 'static {
    /// The saved preferences, or `None` when nothing was saved (yet).
    fn load(&self) -> Boxed<io::Result<Option<Preferences>>>;
    fn save(&self, preferences: Preferences) -> Boxed<io::Result<()>>;
}

/// Keeps the preferences in a small JSON file, for example
/// `{"language": "en", "appearance": "system", "palette": "nord",
/// "uiFontSize": 15, "runNotifications": true, "settingsSection": "general"}`.
#[derive(Debug, Clone)]
pub struct PreferencesFile {
    path: PathBuf,
}

impl PreferencesFile {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// [`PREFERENCES_FILE`] in the client's config directory, beside
    /// `state-root.json`.
    pub fn default_location() -> Option<Self> {
        client_config_file(PREFERENCES_FILE).map(Self::new)
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl PreferencesStore for PreferencesFile {
    /// A missing, oversized, or unreadable file counts as no preferences.
    fn load(&self) -> Boxed<io::Result<Option<Preferences>>> {
        let path = self.path.clone();
        Box::pin(async move {
            let Some(bytes) = read_config_file(&path, MAX_PREFERENCES_BYTES).await? else {
                return Ok(None);
            };
            match serde_json::from_slice::<Preferences>(&bytes) {
                Ok(preferences) => Ok(Some(preferences)),
                Err(error) => {
                    log::warn!("ignoring {}: {error}", path.display());
                    Ok(None)
                }
            }
        })
    }

    fn save(&self, preferences: Preferences) -> Boxed<io::Result<()>> {
        let path = self.path.clone();
        Box::pin(async move {
            let mut contents = serde_json::to_vec(&preferences).map_err(io::Error::other)?;
            contents.push(b'\n');
            write_config_file(path, contents).await
        })
    }
}

/// The app's preferences: one per app, shared by every window. The footer
/// menu and the settings surface read and change them here; a change applies
/// at once (the appearance through gpui-kit's theme, the language through
/// the copy table's [`Locale`] global) and is saved in the background, the
/// newest save replacing one in flight. Observe the entity
/// ([`AppPreferences::global`]) for changes.
///
/// It also knows where the system's preferred languages come from, which
/// [`Language::System`] resolves against whenever the preferences are
/// restored or the language is chosen (never while rendering).
pub struct AppPreferences {
    current: Preferences,
    store: Option<Rc<dyn PreferencesStore>>,
    system_languages: SystemLanguages,
    _save: Option<Task<()>>,
}

/// Reads the system's preferred languages, most preferred first.
type SystemLanguages = Rc<dyn Fn() -> Vec<String>>;

impl std::fmt::Debug for AppPreferences {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppPreferences").field("current", &self.current).finish_non_exhaustive()
    }
}

struct GlobalPreferences(Entity<AppPreferences>);

impl Global for GlobalPreferences {}

impl AppPreferences {
    /// Installs the defaults, with nothing saved, unless preferences exist.
    /// [`crate::init`] calls it; the app then calls [`Self::restore`].
    pub fn init(cx: &mut App) {
        if cx.has_global::<GlobalPreferences>() {
            return;
        }
        let entity = cx.new(|_| Self {
            current: Preferences::default(),
            store: None,
            system_languages: Rc::new(system_languages),
            _save: None,
        });
        cx.set_global(GlobalPreferences(entity));
    }

    /// The app's preferences. Panics before [`crate::init`].
    pub fn global(cx: &App) -> Entity<Self> {
        cx.global::<GlobalPreferences>().0.clone()
    }

    /// The preferences as they stand.
    pub fn current(cx: &App) -> Preferences {
        Self::global(cx).read(cx).current.clone()
    }

    /// Takes over preferences read at startup and the store that keeps
    /// later changes, and applies the appearance and the language (reading
    /// the system's when it is followed).
    ///
    /// The palette and the UI font size are applied with the appearance, so
    /// a window opened afterwards draws its first frame in them.
    pub fn restore(
        &mut self,
        preferences: Preferences,
        store: Option<Rc<dyn PreferencesStore>>,
        cx: &mut Context<Self>,
    ) {
        let (palette, font_size, appearance) =
            (preferences.palette, preferences.ui_font_size, preferences.appearance);
        self.current = preferences;
        self.store = store;
        set_theme_palette(palette, cx);
        set_ui_font_size(font_size, cx);
        apply_appearance(appearance, None, cx);
        self.resolved_locale().apply(cx);
        cx.notify();
    }

    pub fn preferences(&self) -> Preferences {
        self.current.clone()
    }

    /// The locale the interface speaks: the chosen language's, or the
    /// system's while it is followed.
    /// Reads the system's languages when they are followed, so call it on
    /// an event, not while rendering.
    pub fn resolved_locale(&self) -> Locale {
        match self.current.language.locale() {
            Some(locale) => locale,
            None => resolve_system_locale(&(self.system_languages)()),
        }
    }

    /// Takes `languages` as the system's preferred languages from now on
    /// instead of asking the system (tests), and applies them while the
    /// system is followed.
    pub fn set_system_languages(&mut self, languages: Vec<String>, cx: &mut Context<Self>) {
        self.system_languages = Rc::new(move || languages.clone());
        if self.current.language == Language::System {
            self.resolved_locale().apply(cx);
            cx.notify();
        }
    }

    /// Switches every window to `language` now and records it. Choosing
    /// Follow system reads the system's language again.
    pub fn set_language(&mut self, language: Language, cx: &mut Context<Self>) {
        if self.current.language != language {
            self.current.language = language;
            self.resolved_locale().apply(cx);
            self.save(cx);
        }
    }

    /// Applies the appearance to every window now and records it.
    pub fn set_appearance(&mut self, appearance: Appearance, cx: &mut Context<Self>) {
        if self.current.appearance != appearance {
            self.current.appearance = appearance;
            apply_appearance(appearance, None, cx);
            self.save(cx);
        }
    }

    /// Paints every window in `palette` now and records it.
    pub fn set_palette(&mut self, palette: ThemePalette, cx: &mut Context<Self>) {
        if self.current.palette != palette {
            self.current.palette = palette;
            set_theme_palette(palette, cx);
            self.save(cx);
        }
    }

    /// Draws every window at the UI font size `size` (clamped into
    /// [`UI_FONT_SIZES`]) now and records it.
    pub fn set_ui_font_size(&mut self, size: u8, cx: &mut Context<Self>) {
        let size = clamp_font_size(size);
        if self.current.ui_font_size != size {
            self.current.ui_font_size = size;
            set_ui_font_size(size, cx);
            self.save(cx);
        }
    }

    /// Whether closing a side chat that has a conversation goes without
    /// asking.
    pub fn is_side_chat_close_unconfirmed(&self) -> bool {
        self.current.side_chat_close_unconfirmed
    }

    /// "Don't ask again" in a side chat's close confirmation.
    pub fn set_side_chat_close_unconfirmed(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.current.side_chat_close_unconfirmed != on {
            self.current.side_chat_close_unconfirmed = on;
            self.save(cx);
        }
    }

    /// Whether a task that ends while the window is in the background posts
    /// a system notification.
    pub fn set_run_notifications(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.current.run_notifications != on {
            self.current.run_notifications = on;
            self.save(cx);
        }
    }

    /// Chooses `icon` for `target` (Desktop's `app:selectIcon`): the dark
    /// slot, the light one, or one icon everywhere, which clears the dark
    /// slot. The Dock follows ([`crate::DockIcon`]).
    pub fn set_app_icon(
        &mut self,
        icon: AppIconChoice,
        target: AppIconTarget,
        cx: &mut Context<Self>,
    ) {
        let (light, dark) = match target {
            AppIconTarget::Dark => (self.current.app_icon, Some(icon)),
            AppIconTarget::Light => (icon, self.current.app_icon_dark),
            AppIconTarget::Both => (icon, None),
        };
        if (light, dark) != (self.current.app_icon, self.current.app_icon_dark) {
            self.current.app_icon = light;
            self.current.app_icon_dark = dark;
            self.save(cx);
        }
    }

    /// Lets go of an imported icon that is about to be deleted (Desktop's
    /// `app:removeIcon`): a light slot naming it goes back to the default
    /// icon, and a dark slot naming it is cleared, so the icon inherited is
    /// the one that needs no further choice.
    pub fn forget_app_icon(&mut self, icon: AppIconChoice, cx: &mut Context<Self>) {
        let mut changed = false;
        if self.current.app_icon == icon {
            self.current.app_icon = AppIconChoice::Shipped(DEFAULT_APP_ICON);
            changed = true;
        }
        if self.current.app_icon_dark == Some(icon) {
            self.current.app_icon_dark = None;
            changed = true;
        }
        if changed {
            self.save(cx);
        }
    }

    /// Shows `pet` in the main window, or no pet (Desktop's `pets:select`).
    pub fn set_selected_pet(&mut self, pet: Option<PetPackId>, cx: &mut Context<Self>) {
        if self.current.selected_pet != pet {
            self.current.selected_pet = pet;
            self.save(cx);
        }
    }

    /// Remembers the Usage page's display choices.
    pub fn set_usage(&mut self, usage: UsageView, cx: &mut Context<Self>) {
        if self.current.usage != usage {
            self.current.usage = usage;
            self.save(cx);
        }
    }

    /// Makes the sidebar collapse to `narrow` from now on.
    pub fn set_narrow_sidebar(&mut self, narrow: NarrowSidebar, cx: &mut Context<Self>) {
        if self.current.narrow_sidebar != narrow {
            self.current.narrow_sidebar = narrow;
            self.save(cx);
        }
    }

    /// Remembers the expanded sidebar's width (clamped into
    /// [`SIDEBAR_WIDTHS`]).
    pub fn set_sidebar_width(&mut self, width: u16, cx: &mut Context<Self>) {
        let width = clamp_sidebar_width(width);
        if self.current.sidebar_width != width {
            self.current.sidebar_width = width;
            self.save(cx);
        }
    }

    /// Opens or closes the changes panel of task `session`.
    pub fn set_review_open(&mut self, session: &str, open: bool, cx: &mut Context<Self>) {
        let changed = if open {
            self.current.review_open.insert(session.to_owned())
        } else {
            self.current.review_open.remove(session)
        };
        if changed {
            self.save(cx);
        }
    }

    /// Whether task `session`'s changes panel is open.
    pub fn is_review_open(&self, session: &str) -> bool {
        self.current.review_open.contains(session)
    }

    /// Remembers the changes panel's width (clamped into [`REVIEW_WIDTHS`]).
    pub fn set_review_width(&mut self, width: u16, cx: &mut Context<Self>) {
        let width = clamp_review_width(width);
        if self.current.review_width != width {
            self.current.review_width = width;
            self.save(cx);
        }
    }

    /// Remembers the branch task `session`'s changes compare against, or
    /// forgets it.
    pub fn set_review_base_branch(
        &mut self,
        session: &str,
        branch: Option<String>,
        cx: &mut Context<Self>,
    ) {
        let changed = match branch {
            Some(branch) => {
                self.current.review_base_branches.insert(session.to_owned(), branch.clone())
                    != Some(branch)
            }
            None => self.current.review_base_branches.remove(session).is_some(),
        };
        if changed {
            self.save(cx);
        }
    }

    /// The branch task `session`'s changes compare against, when one was
    /// picked.
    pub fn review_base_branch(&self, session: &str) -> Option<String> {
        self.current.review_base_branches.get(session).cloned()
    }

    /// Maximizes task `session`'s changes panel, or gives the conversation
    /// its place back.
    pub fn set_review_maximized(&mut self, session: &str, maximized: bool, cx: &mut Context<Self>) {
        let changed = if maximized {
            self.current.review_maximized.insert(session.to_owned())
        } else {
            self.current.review_maximized.remove(session)
        };
        if changed {
            self.save(cx);
        }
    }

    /// Whether task `session`'s changes panel fills the plate while open.
    pub fn is_review_maximized(&self, session: &str) -> bool {
        self.current.review_maximized.contains(session)
    }

    /// The face task `session`'s workbar shows.
    pub fn workbar_face(&self, session: &str) -> WorkbarFace {
        self.current.workbar_faces.get(session).copied().unwrap_or_default()
    }

    /// Remembers the face task `session`'s workbar shows.
    pub fn set_workbar_face(&mut self, session: &str, face: WorkbarFace, cx: &mut Context<Self>) {
        let changed = match face {
            WorkbarFace::Changes => self.current.workbar_faces.remove(session).is_some(),
            face => self.current.workbar_faces.insert(session.to_owned(), face) != Some(face),
        };
        if changed {
            self.save(cx);
        }
    }

    /// Whether task `session`'s workbar has its Changes face open.
    pub fn is_changes_face_open(&self, session: &str) -> bool {
        !self.current.workbar_changes_closed.contains(session)
    }

    /// Opens or closes task `session`'s Changes face.
    pub fn set_changes_face_open(&mut self, session: &str, open: bool, cx: &mut Context<Self>) {
        let changed = if open {
            self.current.workbar_changes_closed.remove(session)
        } else {
            self.current.workbar_changes_closed.insert(session.to_owned())
        };
        if changed {
            self.save(cx);
        }
    }

    /// Whether task `session`'s workbar has its Files face open.
    pub fn is_files_face_open(&self, session: &str) -> bool {
        self.current.workbar_files_open.contains(session)
    }

    /// Opens or closes task `session`'s Files face.
    pub fn set_files_face_open(&mut self, session: &str, open: bool, cx: &mut Context<Self>) {
        let changed = if open {
            self.current.workbar_files_open.insert(session.to_owned())
        } else {
            self.current.workbar_files_open.remove(session)
        };
        if changed {
            self.save(cx);
        }
    }

    /// Whether task `session`'s workbar has its Trace face open.
    pub fn is_inspector_face_open(&self, session: &str) -> bool {
        self.current.workbar_inspector_open.contains(session)
    }

    /// Opens or closes task `session`'s Trace face.
    pub fn set_inspector_face_open(&mut self, session: &str, open: bool, cx: &mut Context<Self>) {
        let changed = if open {
            self.current.workbar_inspector_open.insert(session.to_owned())
        } else {
            self.current.workbar_inspector_open.remove(session)
        };
        if changed {
            self.save(cx);
        }
    }

    /// Whether Option sends Meta to a terminal's program.
    pub fn terminal_option_as_meta(&self) -> bool {
        self.current.terminal_option_as_meta
    }

    pub fn set_terminal_option_as_meta(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.current.terminal_option_as_meta != on {
            self.current.terminal_option_as_meta = on;
            self.save(cx);
        }
    }

    /// Whether a terminal's cursor blinks where the program has not chosen
    /// a style.
    pub fn terminal_cursor_blink(&self) -> bool {
        self.current.terminal_cursor_blink
    }

    pub fn set_terminal_cursor_blink(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.current.terminal_cursor_blink != on {
            self.current.terminal_cursor_blink = on;
            self.save(cx);
        }
    }

    /// Forgets the changes panel's state of every task but `sessions`
    /// (Desktop's `retain-sessions`), so the file keeps only live tasks.
    pub fn retain_review_tasks(&mut self, sessions: &BTreeSet<String>, cx: &mut Context<Self>) {
        let count = |current: &Preferences| {
            let open = current.review_open.len();
            (
                open,
                current.review_base_branches.len(),
                current.review_maximized.len(),
                current.workbar_faces.len(),
                current.workbar_changes_closed.len(),
                current.workbar_files_open.len(),
                current.workbar_inspector_open.len(),
            )
        };
        let before = count(&self.current);
        self.current.review_open.retain(|id| sessions.contains(id));
        self.current.review_base_branches.retain(|id, _| sessions.contains(id));
        self.current.review_maximized.retain(|id| sessions.contains(id));
        self.current.workbar_faces.retain(|id, _| sessions.contains(id));
        self.current.workbar_changes_closed.retain(|id| sessions.contains(id));
        self.current.workbar_files_open.retain(|id| sessions.contains(id));
        self.current.workbar_inspector_open.retain(|id| sessions.contains(id));
        if before != count(&self.current) {
            self.save(cx);
        }
    }

    /// Remembers `section` as the one settings open on next.
    pub fn set_settings_section(&mut self, section: SettingsSection, cx: &mut Context<Self>) {
        let section = remembered_section(section);
        if self.current.settings_section != section {
            self.current.settings_section = section;
            self.save(cx);
        }
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        cx.notify();
        let Some(store) = self.store.clone() else {
            return;
        };
        let save = store.save(self.current.clone());
        self._save = Some(cx.background_spawn(async move {
            if let Err(error) = save.await {
                log::warn!("couldn’t save the preferences: {error}");
            }
        }));
    }
}

/// Chooses the interface language from a menu, the command palette, or
/// the settings surface. Every window redraws in it at once.
pub fn choose_language(language: Language, cx: &mut App) {
    AppPreferences::global(cx).update(cx, |preferences, cx| preferences.set_language(language, cx));
}

/// Chooses the appearance from a menu, the command palette, or the
/// settings surface.
pub fn choose_appearance(appearance: Appearance, cx: &mut App) {
    AppPreferences::global(cx)
        .update(cx, |preferences, cx| preferences.set_appearance(appearance, cx));
}

/// Chooses the palette every window paints in.
pub fn choose_palette(palette: ThemePalette, cx: &mut App) {
    AppPreferences::global(cx).update(cx, |preferences, cx| preferences.set_palette(palette, cx));
}

/// Chooses the UI font size every window draws at.
pub fn choose_ui_font_size(size: u8, cx: &mut App) {
    AppPreferences::global(cx).update(cx, |preferences, cx| preferences.set_ui_font_size(size, cx));
}

/// Chooses what the sidebar collapses to, in every window.
pub fn choose_narrow_sidebar(narrow: NarrowSidebar, cx: &mut App) {
    AppPreferences::global(cx)
        .update(cx, |preferences, cx| preferences.set_narrow_sidebar(narrow, cx));
}

/// Changes the UI font size every window draws at by `step`, within
/// [`UI_FONT_SIZES`]: at a bound a step leaves it as it is. The size is
/// saved like one chosen on the stepper.
pub fn step_ui_font_size(step: FontSizeStep, cx: &mut App) {
    let size = AppPreferences::current(cx).ui_font_size;
    let size = match step {
        FontSizeStep::Larger => size.saturating_add(1),
        FontSizeStep::Smaller => size.saturating_sub(1),
        FontSizeStep::Default => DEFAULT_UI_FONT_SIZE,
    };
    choose_ui_font_size(size, cx);
}

/// The section settings open on (Maka Desktop's `readLastSettingsSection`):
/// the one shown last, Models before any was.
pub fn remembered_settings_section(cx: &App) -> SettingsSection {
    AppPreferences::current(cx).settings_section
}

/// Applies `appearance` to gpui-kit's theme: light or dark as chosen, or
/// the system's (read from `window` when given), in Maka's palette. Every
/// window redraws.
///
/// The app's native appearance follows the choice too, so the window's own
/// chrome (the traffic lights of an inactive window, the scrollers the
/// system draws) matches the palette instead of the system setting. It is
/// set first: with no override, the system's appearance is what `System`
/// reads.
pub fn apply_appearance(appearance: Appearance, window: Option<&mut Window>, cx: &mut App) {
    cx.set_window_appearance(match appearance {
        Appearance::System => None,
        Appearance::Light => Some(WindowAppearance::Light),
        Appearance::Dark => Some(WindowAppearance::Dark),
    });
    match appearance {
        Appearance::System => Theme::sync_system_appearance(window, cx),
        Appearance::Light => Theme::change(ThemeMode::Light, window, cx),
        Appearance::Dark => Theme::change(ThemeMode::Dark, window, cx),
    }
    shared::theme::apply_kit_theme(cx);
    cx.refresh_windows();
}

/// For a window's appearance observer: follows the system's change only
/// while the preference is System.
pub fn follow_system_appearance(window: &mut Window, cx: &mut App) {
    if AppPreferences::current(cx).appearance == Appearance::System {
        Theme::sync_system_appearance(Some(window), cx);
        shared::theme::apply_kit_theme(cx);
        cx.refresh_windows();
    }
}

/// The theme mode in effect, for tests and readers that need the answer
/// rather than the preference.
pub fn theme_mode(cx: &App) -> ThemeMode {
    Theme::global(cx).mode
}

#[cfg(test)]
// Test setup writes fixture files synchronously; no UI thread is involved.
#[allow(clippy::disallowed_methods)]
mod tests {
    use std::fs;

    use futures_lite::future::block_on;

    use shared::theme::{ActiveMakaPalette as _, MakaPalette};

    use super::*;

    #[test]
    fn the_file_round_trips_and_damage_or_unknown_values_read_as_defaults() {
        let dir = std::env::temp_dir().join(format!(
            "settings-preferences-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or_default()
        ));
        let store = PreferencesFile::new(dir.join("maka-gpui").join(PREFERENCES_FILE));
        assert_eq!(block_on(store.load()).expect("missing"), None);

        let chosen = Preferences::new(Language::TraditionalChinese, Appearance::Dark)
            .with_palette(ThemePalette::TokyoNight)
            .with_ui_font_size(17)
            .with_run_notifications(false)
            .with_settings_section(SettingsSection::Appearance);
        block_on(store.save(chosen.clone())).expect("save");
        assert_eq!(block_on(store.load()).expect("load"), Some(chosen));
        let text = fs::read_to_string(store.path()).expect("text");
        assert_eq!(
            text,
            "{\"language\":\"zh-Hant\",\"appearance\":\"dark\",\"palette\":\"tokyo-night\",\
             \"uiFontSize\":17,\"runNotifications\":false,\"settingsSection\":\"appearance\"}\n"
        );

        // A newer or older file: unknown values read as the defaults, a size
        // out of range as the nearest one, as Desktop's normalizers do.
        fs::write(
            store.path(),
            r#"{"language":"fr","appearance":"light","extra":1,"palette":"neon",
                "uiFontSize":40.4,"runNotifications":"yes","settingsSection":"external-agents"}"#,
        )
        .expect("newer file");
        assert_eq!(
            block_on(store.load()).expect("load"),
            Some(Preferences::new(Language::System, Appearance::Light).with_ui_font_size(22))
        );
        fs::write(
            store.path(),
            r#"{"uiFontSize":11,"palette":"nord","settingsSection":"general"}"#,
        )
        .expect("smallest");
        assert_eq!(
            block_on(store.load()).expect("load"),
            Some(
                Preferences::default()
                    .with_palette(ThemePalette::Nord)
                    .with_ui_font_size(11)
                    .with_settings_section(SettingsSection::General)
            )
        );
        for (size, read) in [("9", 11), ("10.6", 11), ("\"12\"", 14), ("null", 14)] {
            let file = format!(r#"{{"uiFontSize":{size}}}"#);
            fs::write(store.path(), file).expect("size");
            let loaded = block_on(store.load()).expect("load").expect("preferences");
            assert_eq!(loaded.ui_font_size, read, "{size}");
        }
        fs::write(store.path(), "not json").expect("damage");
        assert_eq!(block_on(store.load()).expect("load"), None);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn the_system_language_resolves_as_maka_desktops_does() {
        for (languages, expected) in [
            (&["zh-Hans-CN", "en-US"][..], Locale::SimplifiedChinese),
            (&["zh-Hant-TW"], Locale::TraditionalChinese),
            (&["zh-HK"], Locale::TraditionalChinese),
            (&["zh_TW.UTF-8"], Locale::TraditionalChinese),
            (&["zh-Hans-TW"], Locale::SimplifiedChinese),
            (&["zh"], Locale::SimplifiedChinese),
            (&["fr-FR", "de", "zh-Hant-MO", "en"], Locale::TraditionalChinese),
            (&["fr-FR", "en-GB", "zh-CN"], Locale::English),
            (&["english", "zhx"], Locale::English),
            (&[], Locale::English),
        ] {
            assert_eq!(resolve_system_locale(languages), expected, "{languages:?}");
        }
    }

    #[test]
    fn the_app_icon_and_the_pet_round_trip_and_read_as_desktop_normalizes_them() {
        use crate::app_icon::AppIcon;
        let custom = AppIconChoice::parse("custom:0123456789abcdef0123456789abcdef");
        let pet = PetPackId::parse("likun.maodie");
        let chosen = Preferences::default()
            .with_app_icon(AppIcon::Ink.into(), custom)
            .with_selected_pet(pet);
        let text = serde_json::to_string(&chosen).expect("encode");
        assert!(
            text.ends_with(
                r#""appIcon":"ink","appIconDark":"custom:0123456789abcdef0123456789abcdef","selectedPetId":"likun.maodie"}"#
            ),
            "{text}"
        );
        assert_eq!(serde_json::from_str::<Preferences>(&text).expect("decode"), chosen);
        // The defaults are left out: one icon everywhere, the fresh install's, and no pet.
        let fresh = serde_json::to_string(&Preferences::default()).expect("encode");
        assert!(!fresh.contains("appIcon") && !fresh.contains("selectedPetId"), "{fresh}");

        let read = |text: &str| serde_json::from_str::<Preferences>(text).expect("decode");
        let odd = read(r#"{"appIcon":"neon","appIconDark":"bogus","selectedPetId":"Not An Id"}"#);
        assert_eq!(
            (odd.app_icon, odd.app_icon_dark, odd.selected_pet),
            (AppIcon::Sky.into(), Some(AppIcon::Ink.into()), None),
            "an unknown icon is the default; a present but unknown dark one is the dark recommendation"
        );
        assert_eq!(read(r#"{"appIconDark":null}"#).app_icon_dark, Some(AppIcon::Ink.into()));
        assert_eq!(read("{}").app_icon_dark, None, "absent is one icon everywhere");
    }

    #[test]
    fn the_sidebar_choices_round_trip_and_the_width_reads_as_desktop_normalizes_it() {
        let chosen =
            Preferences::default().with_narrow_sidebar(NarrowSidebar::Hide).with_sidebar_width(320);
        let text = serde_json::to_string(&chosen).expect("encode");
        assert!(text.ends_with(r#""narrowSidebar":"hide","sidebarWidth":320}"#), "{text}");
        assert_eq!(serde_json::from_str::<Preferences>(&text).expect("decode"), chosen);
        // The defaults are left out: icons, and the reviewed width.
        let fresh = serde_json::to_string(&Preferences::default()).expect("encode");
        assert!(!fresh.contains("narrowSidebar") && !fresh.contains("sidebarWidth"), "{fresh}");
        assert_eq!(Preferences::default().sidebar_width, DEFAULT_SIDEBAR_WIDTH);
        assert_eq!(Preferences::default().with_sidebar_width(900).sidebar_width, 480);

        let read = |text: &str| serde_json::from_str::<Preferences>(text).expect("decode");
        for (width, expected) in [
            ("100", 180),
            ("999", 480),
            ("300.6", 301),
            ("0", DEFAULT_SIDEBAR_WIDTH),
            ("-5", DEFAULT_SIDEBAR_WIDTH),
            ("\"300\"", DEFAULT_SIDEBAR_WIDTH),
            ("null", DEFAULT_SIDEBAR_WIDTH),
        ] {
            let file = format!(r#"{{"sidebarWidth":{width}}}"#);
            assert_eq!(read(&file).sidebar_width, expected, "{width}");
        }
        assert_eq!(read(r#"{"narrowSidebar":"drawer"}"#).narrow_sidebar, NarrowSidebar::Icons);
    }

    #[test]
    fn the_changes_panel_state_round_trips_and_its_width_reads_as_desktop_clamps_it() {
        let mut chosen = Preferences::default();
        chosen.review_open.insert("s1".to_owned());
        chosen.review_width = 400;
        chosen.review_base_branches.insert("s1".to_owned(), "refs/heads/main".to_owned());
        let text = serde_json::to_string(&chosen).expect("encode");
        assert!(
            text.ends_with(
                r#""reviewOpen":["s1"],"reviewWidth":400,"reviewBaseBranches":{"s1":"refs/heads/main"}}"#
            ),
            "{text}"
        );
        assert_eq!(serde_json::from_str::<Preferences>(&text).expect("decode"), chosen);
        chosen.review_maximized.insert("s1".to_owned());
        let text = serde_json::to_string(&chosen).expect("encode");
        assert!(text.ends_with(r#""reviewMaximized":["s1"]}"#), "{text}");
        assert_eq!(serde_json::from_str::<Preferences>(&text).expect("decode"), chosen);
        chosen.workbar_faces.insert("s1".to_owned(), WorkbarFace::Terminal);
        chosen.workbar_changes_closed.insert("s1".to_owned());
        chosen.workbar_files_open.insert("s2".to_owned());
        chosen.workbar_faces.insert("s2".to_owned(), WorkbarFace::Files);
        chosen.workbar_inspector_open.insert("s3".to_owned());
        chosen.workbar_faces.insert("s3".to_owned(), WorkbarFace::Inspector);
        chosen.terminal_option_as_meta = true;
        chosen.terminal_cursor_blink = false;
        let text = serde_json::to_string(&chosen).expect("encode");
        assert!(
            text.ends_with(
                r#""workbarFaces":{"s1":"terminal","s2":"files","s3":"inspector"},"workbarChangesClosed":["s1"],"workbarFilesOpen":["s2"],"workbarInspectorOpen":["s3"],"terminalOptionAsMeta":true,"terminalCursorBlink":false}"#
            ),
            "{text}"
        );
        assert_eq!(serde_json::from_str::<Preferences>(&text).expect("decode"), chosen);
        let fresh = serde_json::to_string(&Preferences::default()).expect("encode");
        assert!(!fresh.contains("review"), "the defaults are left out: {fresh}");
        assert!(!fresh.contains("workbar") && !fresh.contains("terminal"), "{fresh}");
        assert_eq!(Preferences::default().review_width, DEFAULT_REVIEW_WIDTH);

        let read = |text: &str| serde_json::from_str::<Preferences>(text).expect("decode");
        assert!(read("{}").terminal_cursor_blink, "the cursor blinks unless the file says not");
        assert!(read(r#"{"terminalCursorBlink":"off"}"#).terminal_cursor_blink);
        assert!(!read(r#"{"terminalCursorBlink":false}"#).terminal_cursor_blink);
        for (width, expected) in [
            ("100", 340),
            ("999", 999),
            ("1e9", u16::MAX),
            ("480.4", 480),
            ("0", DEFAULT_REVIEW_WIDTH),
            ("\"x\"", 480),
        ] {
            let file = format!(r#"{{"reviewWidth":{width}}}"#);
            assert_eq!(read(&file).review_width, expected, "{width}");
        }
        assert!(
            read(r#"{"reviewOpen":7}"#).review_open.is_empty(),
            "a malformed set reads as none"
        );
    }

    #[test]
    fn follow_system_is_saved_as_system() {
        let chosen = Preferences::new(Language::System, Appearance::System);
        let text = serde_json::to_string(&chosen).expect("encode");
        assert!(text.starts_with(r#"{"language":"system","appearance":"system","#), "{text}");
        assert_eq!(Preferences::default(), chosen, "a fresh install follows the system");
        assert_eq!(serde_json::from_str::<Preferences>(&text).expect("decode"), chosen);
        assert_eq!(Language::System.locale(), None);
        assert_eq!(Language::System.label(Locale::SimplifiedChinese), "跟随系统");
    }

    #[gpui_kit::test]
    fn following_the_system_speaks_its_language(cx: &mut gpui_kit::TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
        });
        let store = Rc::new(Recorded::default());
        let preferences = cx.update(|cx| AppPreferences::global(cx));
        let locale = |cx: &mut gpui_kit::TestAppContext| cx.update(|cx| Locale::current(cx));
        preferences.update(cx, |preferences, cx| {
            preferences.set_system_languages(vec!["zh-Hant-TW".into(), "en-US".into()], cx);
            preferences.restore(
                Preferences::new(Language::English, Appearance::Light),
                Some(store.clone()),
                cx,
            );
        });
        assert_eq!(locale(cx), Locale::English, "a chosen language wins over the system's");
        cx.update(|cx| choose_language(Language::System, cx));
        assert_eq!(locale(cx), Locale::TraditionalChinese, "Follow system speaks the system's");
        assert_eq!(
            *store.0.borrow(),
            [Preferences::new(Language::System, Appearance::Light)],
            "saved as the choice, not as the language it resolved to"
        );
        // While it is followed, the system's language applies as it is read.
        preferences.update(cx, |preferences, cx| {
            preferences.set_system_languages(vec!["fr".into(), "en-GB".into()], cx)
        });
        assert_eq!(locale(cx), Locale::English);
        // A launch that restores Follow system reads the system's language.
        preferences.update(cx, |preferences, cx| {
            preferences.set_system_languages(vec!["zh-CN".into()], cx);
            preferences.restore(Preferences::new(Language::System, Appearance::Light), None, cx);
        });
        assert_eq!(locale(cx), Locale::SimplifiedChinese);
    }

    #[gpui_kit::test]
    fn the_palette_and_font_size_apply_at_restore_and_are_saved(cx: &mut gpui_kit::TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
        });
        let store = Rc::new(Recorded::default());
        let restored = Preferences::new(Language::English, Appearance::Light)
            .with_palette(ThemePalette::Nord)
            .with_ui_font_size(21);
        cx.update(|cx| {
            AppPreferences::global(cx).update(cx, |preferences, cx| {
                preferences.restore(restored, Some(store.clone()), cx)
            })
        });
        let applied = |cx: &mut gpui_kit::TestAppContext| {
            cx.update(|cx| {
                (shared::theme::theme_palette(cx), Theme::global(cx).font_size, cx.maka().plate)
            })
        };
        let nord =
            MakaPalette::for_palette(ThemePalette::Nord, gpui_kit::component::ThemeMode::Light);
        assert_eq!(applied(cx), (ThemePalette::Nord, gpui_kit::px(24.), nord.plate));
        assert!(store.0.borrow().is_empty(), "restoring saves nothing");

        cx.update(|cx| {
            choose_palette(ThemePalette::Default, cx);
            choose_ui_font_size(30, cx);
        });
        cx.run_until_parked();
        let default = MakaPalette::light();
        assert_eq!(
            applied(cx),
            (ThemePalette::Default, gpui_kit::px(16. * 22. / 14.), default.plate)
        );
        let saved = store.0.borrow().last().expect("saved").clone();
        assert_eq!((saved.palette, saved.ui_font_size), (ThemePalette::Default, 22), "clamped");
        // An appearance change keeps both.
        cx.update(|cx| choose_appearance(Appearance::Dark, cx));
        assert_eq!(cx.update(|cx| Theme::global(cx).font_size), gpui_kit::px(16. * 22. / 14.));
        cx.update(|cx| {
            AppPreferences::global(cx).update(cx, |preferences, cx| {
                preferences.set_settings_section(SettingsSection::ExternalAgents, cx);
            })
        });
        assert_eq!(
            cx.update(|cx| remembered_settings_section(cx)),
            SettingsSection::Models,
            "a section not built is remembered as Models"
        );
    }

    /// Records every save.
    #[derive(Default)]
    struct Recorded(std::cell::RefCell<Vec<Preferences>>);

    impl PreferencesStore for Recorded {
        fn load(&self) -> Boxed<io::Result<Option<Preferences>>> {
            Box::pin(async { Ok(None) })
        }

        fn save(&self, preferences: Preferences) -> Boxed<io::Result<()>> {
            self.0.borrow_mut().push(preferences);
            Box::pin(async { Ok(()) })
        }
    }

    #[gpui_kit::test]
    fn a_change_applies_at_once_and_is_saved(cx: &mut gpui_kit::TestAppContext) {
        cx.update(|cx| {
            gpui_kit::init(cx);
            crate::init(cx);
        });
        let store = Rc::new(Recorded::default());
        let restored = Preferences::new(Language::English, Appearance::Dark);
        cx.update(|cx| {
            AppPreferences::global(cx).update(cx, |preferences, cx| {
                preferences.restore(restored, Some(store.clone()), cx)
            })
        });
        assert!(cx.update(|cx| theme_mode(cx).is_dark()), "restoring applies the appearance");
        assert!(store.0.borrow().is_empty(), "restoring saves nothing");

        let overlay = |cx: &mut gpui_kit::TestAppContext| cx.update(|cx| Theme::global(cx).overlay);
        let plate = |cx: &mut gpui_kit::TestAppContext| {
            cx.update(|cx| {
                let theme = Theme::global(cx);
                assert_eq!(theme.tokens.background.color, theme.background, "tokens follow");
                theme.background
            })
        };
        assert!(overlay(cx).a >= 0.5, "the dark backdrop dims visibly");
        assert_eq!(plate(cx), MakaPalette::dark().plate, "kit colours are Maka's");
        cx.update(|cx| choose_appearance(Appearance::Light, cx));
        cx.run_until_parked();
        assert!(!cx.update(|cx| theme_mode(cx).is_dark()));
        assert!(overlay(cx).a >= 0.2, "and the light one");
        assert_eq!(plate(cx), MakaPalette::light().plate, "in either mode");
        assert_eq!(*store.0.borrow(), [Preferences::new(Language::English, Appearance::Light)]);
        // Choosing what is already chosen saves nothing.
        cx.update(|cx| choose_appearance(Appearance::Light, cx));
        cx.run_until_parked();
        assert_eq!(store.0.borrow().len(), 1);
    }
}

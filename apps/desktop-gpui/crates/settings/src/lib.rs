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

//! Model connections and preferences, on Maka Desktop's full-window
//! settings surface.
//!
//! - [`SettingsView`] is the surface: a section navigation ("Back to app",
//!   a section search, Desktop's groups) that the shell puts in the
//!   sidebar's place, and the chosen section's page, which it puts on the
//!   plate. [`SettingsSection`] carries all seventeen of Desktop's sections;
//!   the ones built are General ([`GeneralPage`]: identity, privacy and
//!   notifications, task defaults, the Bash tool's shell, and the network
//!   proxy in [`NetworkSection`]), Appearance ([`AppearancePage`]: theme,
//!   palette, UI font size, the app icon in [`AppIconSection`], custom
//!   pets in [`PetSection`]), Workspace ([`ProjectsPane`]: the Host's
//!   projects, renamed, archived, restored, relinked, or added from a
//!   folder), Models ([`ConnectionsPane`]: the Host's model connections,
//!   the provider catalog ([`ProviderCatalog`]), the form that connects a
//!   provider ([`AddConnectionForm`]), and a connection's detail
//!   ([`ConnectionDetail`]: its key, service URL, test, models and their
//!   parameters, request headers and body), and About. The shell opens
//!   it for the `OpenSettings`, `AddConnection`, and `OpenProjectSettings`
//!   commands (Settings… on the section shown last,
//!   [`remembered_settings_section`]) and closes it on
//!   [`SettingsEvent::BackToApp`].
//! - [`rows`] is the kit pages are built from: groups, rows with a toggle,
//!   a dropdown, a text field, a value or a path, blocks of labeled fields,
//!   action rows, status lines, and placeholders.
//! - [`HostPolicy`] reads the Host's runtime policy once for every page and
//!   writes a change to it (`runtime.policy.mutate`, and
//!   `runtime.policy.network-proxy.update` for the proxy and its password),
//!   retrying once after a revision conflict.
//! - [`AddConnectionForm`] adds a model connection: the Host verifies the
//!   key by discovering the provider's models (`connection.onboarding.verify`),
//!   the user picks the models to enable, and the Host saves the connection
//!   (`connection.onboarding.save`); a provider without a key, or custom
//!   request settings, take Desktop's create path
//!   (`connection.catalog.create`, `credential.vault.set`,
//!   `connection.request-headers.replace`, `connection.models.fetch`).
//! - [`AppPreferences`] keeps the client's own preferences (the interface
//!   language, which may follow the system's, the appearance, the palette,
//!   the UI font size, run notifications, the last settings section) for
//!   every window, applies them, and saves them in [`PreferencesFile`].
//! - [`RunNotifier`] posts a window's system notification when a task's run
//!   ends while the window is in the background.
//! - [`app_icon`] is Desktop's app icon set and the icons a person imports;
//!   [`DockIcon`] applies the chosen one through the shell's platform call
//!   ([`install_app_icons`]).

mod about_page;
mod add_connection;
pub mod app_icon;
mod app_icon_section;
mod appearance_page;
mod archived_page;
mod bot_chat_page;
mod bot_chat_view;
mod bot_onboarding;
mod config_transfer;
mod connection_detail;
mod connection_ops;
mod connections_pane;
mod daily_review_page;
mod data_page;
mod general_page;
mod health_page;
mod host_picker;
mod manual_host_form;
mod memory_page;
mod memory_preview;
mod memory_store;
mod model_parameters;
mod network_section;
mod notifications;
mod page_kit;
mod pet_section;
mod policy;
mod preferences;
mod projects_pane;
mod provider_catalog;
mod remote_directory_dialog;
mod request_customization;
pub mod rows;
mod runtime_host_section;
mod section;
mod subagents_page;
mod surface;
mod transfer_page;
mod usage_page;
mod web_search_page;

use gpui_kit::App;

pub use about_page::AboutPage;
pub use add_connection::{AddConnectionEvent, AddConnectionForm, AddConnectionPhase, FormFields};
pub use app_icon::{
    AppIcon, AppIconChoice, AppIconTarget, CUSTOM_ICON_DIRECTORY, DockIcon, DockIconSink,
    custom_icons, install_app_icons,
};
pub use app_icon_section::AppIconSection;
pub use appearance_page::AppearancePage;
pub use archived_page::{ArchivedTask, ArchivedTasksPage};
pub use bot_chat_page::BotChatPage;
pub use config_transfer::{ConfigCategory, ConflictStrategy};
pub use connection_detail::{ConnectionDetail, ConnectionDetailEvent, EditingRow};
pub use connections_pane::{ConnectionFilter, ConnectionsPane};
pub use daily_review_page::{DailyReviewPage, DailyReviewSettings};
pub use data_page::{DataNotice, DataPage, DataTransfer};
pub use general_page::{DefaultModel, GeneralPage};
pub use health_page::{HealthLayer, HealthPage, HealthSignal, HealthStatus};
pub use host_picker::{HostPicker, section_shows_host_picker};
pub use manual_host_form::{ManualField, ManualHostForm, SshHostChoice, TransportChoice};
pub use memory_page::MemoryPage;
pub use memory_store::{MemoryAccess, MemorySnapshot};
pub use network_section::NetworkSection;
pub use notifications::{
    HiddenSessions, RunNotifier, TaskNames, notification_content, should_notify,
};
pub use pet_section::PetSection;
pub use policy::{HostPolicy, ProxyPassword, Refusal};
pub use preferences::{
    AppPreferences, Appearance, DEFAULT_REVIEW_WIDTH, DEFAULT_SIDEBAR_WIDTH, FontSizeStep,
    Language, NarrowSidebar, PREFERENCES_FILE, Preferences, PreferencesFile, PreferencesStore,
    REVIEW_WIDTHS, SIDEBAR_WIDTHS, UI_FONT_SIZES, WorkbarFace, apply_appearance, choose_appearance,
    choose_language, choose_narrow_sidebar, choose_palette, choose_ui_font_size,
    clamp_review_width, clamp_sidebar_width, follow_system_appearance, remembered_settings_section,
    resolve_system_locale, step_ui_font_size, theme_mode,
};
pub use projects_pane::{CancelProjectRename, PROJECT_RENAME_CONTEXT, ProjectsPane};
pub use provider_catalog::{ProviderCatalog, ProviderCatalogEvent};
pub use remote_directory_dialog::RemoteDirectoryDialog;
pub use runtime_host_section::{RuntimeHostEvent, RuntimeHostSection, host_refusal_text};
pub use section::{NavGroup, SettingsSection};
pub use subagents_page::{SubagentEditor, SubagentRoute, SubagentsPage};
pub use surface::{
    AboutFacts, BackToApp, OpenSection, OpenTask, PAGE_MAX_WIDTH_REMS, SETTINGS_NAV_CONTEXT,
    SETTINGS_SURFACE_CONTEXT, SelectFirstSection, SelectLastSection, SelectNextSection,
    SelectPreviousSection, SettingsContext, SettingsEvent, SettingsView, SwitchHost,
};
pub use transfer_page::{BUNDLE_SOURCE, TransferEvent, TransferMode, TransferPage};
pub use usage_page::{
    USAGE_PAGE_SIZE, UsagePage, UsagePageEvent, UsageRange, UsageStatus, UsageTab, UsageView,
    compact_count,
};
pub use web_search_page::{KeyCheck, WebSearchPage};

/// Installs the default preferences and binds the settings surface's keys.
/// Call once after `gpui_kit::init`, before building menus.
pub fn init(cx: &mut App) {
    AppPreferences::init(cx);
    surface::bind_keys(cx);
    rows::bind_keys(cx);
    general_page::bind_keys(cx);
    projects_pane::bind_keys(cx);
    notifications::init(cx);
    shared::menu::init(cx);
}

#[cfg(test)]
mod appearance_tests;
#[cfg(test)]
mod archived_tests;
#[cfg(test)]
mod bot_chat_tests;
#[cfg(test)]
mod daily_review_tests;
#[cfg(test)]
mod data_tests;
#[cfg(test)]
mod health_tests;
#[cfg(test)]
mod memory_tests;
#[cfg(test)]
mod models_tests;
#[cfg(test)]
mod rows_tests;
#[cfg(test)]
mod runtime_host_tests;
#[cfg(test)]
mod subagents_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod transfer_tests;
#[cfg(test)]
mod usage_tests;
#[cfg(test)]
mod web_search_tests;

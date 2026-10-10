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

//! The settings surface's sections: Maka Desktop's seventeen pages in its
//! order and groups (`SETTINGS_NAV` in
//! apps/desktop/src/renderer/settings/settings-nav.ts), with the ones this
//! client has built switched on.

use gpui_kit::assets::IconName as AssetIcon;
use gpui_kit::component::{Icon, IconName};
use shared::copy::bots;
use shared::copy::settings as copy;
use shared::copy::{Locale, Text, memory, subagents, web_search};
use shared::copy::{health, system, tasks, usage};
use shared::icons::MakaIcon;

/// A group of the navigation, in Desktop's order (`NAV_GROUP_ORDER` in
/// apps/desktop/src/renderer/settings/nav-group-summary.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum NavGroup {
    Preferences,
    Capabilities,
    Activity,
    System,
}

impl NavGroup {
    pub const ALL: [Self; 4] =
        [Self::Preferences, Self::Capabilities, Self::Activity, Self::System];

    pub fn label(self) -> Text {
        match self {
            Self::Preferences => copy::GROUP_PREFERENCES,
            Self::Capabilities => copy::GROUP_CAPABILITIES,
            Self::Activity => copy::GROUP_ACTIVITY,
            Self::System => copy::GROUP_SYSTEM,
        }
    }

    /// A stable key for element ids: Desktop's `SettingsNavGroup`.
    pub fn key(self) -> &'static str {
        match self {
            Self::Preferences => "preferences",
            Self::Capabilities => "capabilities",
            Self::Activity => "activity",
            Self::System => "system",
        }
    }
}

/// A page of the settings surface: every section Maka Desktop has, by its
/// id (`SettingsSection` in packages/core/src/settings.ts). Only the ones
/// [`implemented`](Self::implemented) are listed, opened, or searched; a
/// later change builds a page and switches it on there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SettingsSection {
    General,
    Appearance,
    /// Desktop's `projects`, shown as Workspace.
    Projects,
    Models,
    ExternalAgents,
    Subagents,
    Memory,
    /// Desktop's `bot-chat`, shown as Remote Access.
    BotChat,
    /// Web search.
    Search,
    Usage,
    ArchivedTasks,
    ImportTasks,
    DailyReview,
    Data,
    /// Permissions & Capabilities: the system grants Desktop's native
    /// features need.
    Permissions,
    Health,
    About,
}

impl SettingsSection {
    /// Every section, in Desktop's order.
    pub const ALL: [Self; 17] = [
        Self::General,
        Self::Appearance,
        Self::Projects,
        Self::Models,
        Self::ExternalAgents,
        Self::Subagents,
        Self::Memory,
        Self::BotChat,
        Self::Search,
        Self::Usage,
        Self::ArchivedTasks,
        Self::ImportTasks,
        Self::DailyReview,
        Self::Data,
        Self::Permissions,
        Self::Health,
        Self::About,
    ];

    /// Whether this client has the page. The navigation lists, and
    /// `--open-settings` opens, only these.
    pub fn implemented(self) -> bool {
        matches!(
            self,
            Self::General
                | Self::Appearance
                | Self::Projects
                | Self::Models
                | Self::Subagents
                | Self::Memory
                | Self::BotChat
                | Self::Search
                | Self::Usage
                | Self::ArchivedTasks
                | Self::ImportTasks
                | Self::DailyReview
                | Self::Data
                | Self::Health
                | Self::About
        )
    }

    /// The sections this client has, in Desktop's order.
    pub fn listed() -> impl Iterator<Item = Self> {
        Self::ALL.into_iter().filter(|section| section.implemented())
    }

    pub fn group(self) -> NavGroup {
        match self {
            Self::General | Self::Appearance | Self::Projects => NavGroup::Preferences,
            Self::Models
            | Self::ExternalAgents
            | Self::Subagents
            | Self::Memory
            | Self::BotChat
            | Self::Search => NavGroup::Capabilities,
            Self::Usage | Self::ArchivedTasks | Self::ImportTasks | Self::DailyReview => {
                NavGroup::Activity
            }
            Self::Data | Self::Permissions | Self::Health | Self::About => NavGroup::System,
        }
    }

    pub fn label(self) -> Text {
        match self {
            Self::General => copy::SECTION_GENERAL,
            Self::Appearance => copy::SECTION_APPEARANCE,
            Self::Projects => copy::SECTION_WORKSPACE,
            Self::Models => copy::SECTION_MODELS,
            Self::ExternalAgents => copy::SECTION_EXTERNAL_AGENTS,
            Self::Subagents => copy::SECTION_SUBAGENTS,
            Self::Memory => copy::SECTION_MEMORY,
            Self::BotChat => copy::SECTION_BOT_CHAT,
            Self::Search => copy::SECTION_SEARCH,
            Self::Usage => copy::SECTION_USAGE,
            Self::ArchivedTasks => copy::SECTION_ARCHIVED_TASKS,
            Self::ImportTasks => copy::SECTION_IMPORT_TASKS,
            Self::DailyReview => copy::SECTION_DAILY_REVIEW,
            Self::Data => copy::SECTION_DATA,
            Self::Permissions => copy::SECTION_PERMISSIONS,
            Self::Health => copy::SECTION_HEALTH,
            Self::About => copy::SECTION_ABOUT,
        }
    }

    /// The line under the page's title.
    pub fn description(self) -> Text {
        match self {
            Self::General => copy::SECTION_GENERAL_HELP,
            Self::Appearance => copy::SECTION_APPEARANCE_HELP,
            Self::Projects => copy::SECTION_WORKSPACE_HELP,
            Self::Models => copy::SECTION_MODELS_HELP,
            Self::ExternalAgents => copy::SECTION_EXTERNAL_AGENTS_HELP,
            Self::Subagents => copy::SECTION_SUBAGENTS_HELP,
            Self::Memory => copy::SECTION_MEMORY_HELP,
            Self::BotChat => copy::SECTION_BOT_CHAT_HELP,
            Self::Search => copy::SECTION_SEARCH_HELP,
            Self::Usage => copy::SECTION_USAGE_HELP,
            Self::ArchivedTasks => copy::SECTION_ARCHIVED_TASKS_HELP,
            Self::ImportTasks => copy::SECTION_IMPORT_TASKS_HELP,
            Self::DailyReview => copy::SECTION_DAILY_REVIEW_HELP,
            Self::Data => copy::SECTION_DATA_HELP,
            Self::Permissions => copy::SECTION_PERMISSIONS_HELP,
            Self::Health => copy::SECTION_HEALTH_HELP,
            Self::About => copy::SECTION_ABOUT_HELP,
        }
    }

    /// The badge after the label in the navigation: "Beta" on Web Search,
    /// as in Desktop.
    pub fn badge(self) -> Option<Text> {
        matches!(self, Self::Search).then_some(copy::BADGE_BETA)
    }

    /// The settings the page holds, by their titles: the section search
    /// finds a section by them too (so "API key" leads to Models), and by the
    /// names the section went by before (Connections, Projects).
    fn contents(self) -> &'static [Text] {
        match self {
            Self::General => &[
                copy::IDENTITY,
                copy::DISPLAY_NAME,
                copy::INTERFACE_LANGUAGE,
                copy::LANGUAGE,
                copy::LANGUAGE_SYSTEM,
                copy::ASSISTANT_TONE,
                copy::PRIVACY,
                copy::INCOGNITO,
                copy::NOTIFICATIONS,
                copy::WORKSPACE_INSTRUCTIONS,
                copy::TASK_DEFAULTS,
                copy::CODE_MODE,
                copy::DEFAULT_MODEL,
                copy::DEFAULT_PERMISSION,
                copy::SHELL,
                copy::SHELL_PREFERENCE,
                copy::SHELL_EXECUTABLE,
                copy::TERMINAL,
                copy::TERMINAL_OPTION_AS_META,
                copy::TERMINAL_CURSOR_BLINK,
                copy::NETWORK,
                copy::PROXY,
                copy::PROXY_PROTOCOL,
                copy::PROXY_HOST,
                copy::PROXY_PORT,
                copy::PROXY_AUTH,
                copy::PROXY_USERNAME,
                copy::PROXY_PASSWORD,
                copy::PROXY_BYPASS,
                copy::PROXY_TEST,
            ],
            Self::Appearance => &[
                copy::THEME,
                copy::APPEARANCE_LIGHT,
                copy::APPEARANCE_DARK,
                copy::APPEARANCE_SYSTEM,
                copy::PALETTE,
                copy::PALETTE_GROUP_EDITOR,
                copy::PALETTE_GROUP_PRODUCT,
                copy::PALETTE_DEFAULT,
                copy::PALETTE_ONEDARK,
                copy::PALETTE_CATPPUCCIN,
                copy::PALETTE_TOKYO_NIGHT,
                copy::PALETTE_NORD,
                copy::PALETTE_CORAL,
                copy::PALETTE_AZURE,
                copy::PALETTE_FOREST,
                copy::PALETTE_DUSK,
                copy::PALETTE_SAND,
                copy::PALETTE_MONO,
                copy::FONT_SIZE,
                copy::UI_FONT_SIZE,
                copy::SIDEBAR,
                copy::NARROW_SIDEBAR,
            ],
            Self::Projects => &[copy::SECTION_PROJECTS, copy::PROJECT_NAME, copy::ADD_PROJECT],
            Self::Models => &[
                copy::SECTION_CONNECTIONS,
                copy::MODELS,
                copy::PROVIDER,
                copy::API_KEY,
                copy::SERVICE_URL,
                copy::ADD_CONNECTION_TITLE,
            ],
            Self::Usage => &[
                usage::TOTAL_REQUESTS,
                usage::TOTAL_COST,
                usage::TOTAL_TOKENS,
                usage::CACHE_TOKENS,
                usage::TAB_ACTIVITY,
                usage::TAB_PRICING,
            ],
            Self::ArchivedTasks => &[tasks::ARCHIVED_SEARCH, tasks::ARCHIVED_PURGE_ALL],
            Self::ImportTasks => &[
                tasks::TRANSFER_IMPORT,
                tasks::TRANSFER_EXPORT,
                tasks::SOURCE_BUNDLE,
                tasks::INCLUDE_ARCHIVED,
            ],
            Self::DailyReview => &[
                system::REVIEW_SCHEDULE,
                system::REVIEW_ENABLED,
                system::REVIEW_TIME,
                system::REVIEW_ANALYSIS,
                system::REVIEW_MODEL,
            ],
            Self::Data => &[
                system::DATA_LOCATION,
                system::DATA_BACKUP,
                system::DATA_CONFIG,
                system::DATA_EXPORT,
                system::DATA_IMPORT,
            ],
            Self::Subagents => &[
                subagents::APPROVED,
                subagents::ADD,
                subagents::PROFILE,
                subagents::PROFILE_LOCAL_READ,
                subagents::PROFILE_WEB_RESEARCH,
                subagents::PROFILE_IMPLEMENTATION,
                subagents::DESCRIPTION,
                subagents::THINKING,
            ],
            Self::Memory => &[
                memory::LOCAL_FILE,
                memory::AGENT_READABLE,
                memory::ENTRIES,
                memory::MANUAL_ADD,
                memory::DOCUMENT,
                memory::BACKUP_CANDIDATES,
                memory::PROMPT_PREVIEW,
            ],
            Self::BotChat => &[
                bots::PROVIDER_TELEGRAM,
                bots::PROVIDER_FEISHU,
                bots::PROVIDER_LARK,
                bots::PROVIDER_WECOM,
                bots::PROVIDER_WECHAT,
                bots::PROVIDER_DISCORD,
                bots::PROVIDER_DINGTALK,
                bots::PROVIDER_SLACK,
            ],
            Self::Search => &[
                web_search::SEARCH_PROVIDER,
                web_search::PROVIDER,
                web_search::ENABLED,
                web_search::KEY,
                web_search::TEST_SEARCH,
            ],
            Self::Health => {
                &[health::LAYER_CONFIGURATION, health::LAYER_VALIDATION, health::LAYER_RUNTIME]
            }
            Self::About => &[
                copy::ABOUT_VERSION,
                copy::ABOUT_CLIENT,
                copy::ABOUT_HOST,
                copy::ABOUT_PROTOCOL,
                copy::ABOUT_STATE_ROOT,
                copy::ABOUT_MAKA_CHECKOUT,
            ],
            _ => &[],
        }
    }

    /// Whether the section search's `query` (lowercase) finds the section:
    /// its name or one of its settings, in `locale` or English.
    pub(crate) fn matches(self, query: &str, locale: Locale) -> bool {
        std::iter::once(self.label()).chain(self.contents().iter().copied()).any(|text| {
            [text.in_locale(locale), text.en()]
                .iter()
                .any(|words| words.to_lowercase().contains(query))
        })
    }

    /// Desktop's id: a stable key for element ids and `--open-settings`.
    pub fn key(self) -> &'static str {
        match self {
            Self::General => "general",
            Self::Appearance => "appearance",
            Self::Projects => "projects",
            Self::Models => "models",
            Self::ExternalAgents => "external-agents",
            Self::Subagents => "subagents",
            Self::Memory => "memory",
            Self::BotChat => "bot-chat",
            Self::Search => "search",
            Self::Usage => "usage",
            Self::ArchivedTasks => "archived-tasks",
            Self::ImportTasks => "import-tasks",
            Self::DailyReview => "daily-review",
            Self::Data => "data",
            Self::Permissions => "permissions",
            Self::Health => "health",
            Self::About => "about",
        }
    }

    /// The implemented section named `key`, or the one that took over what
    /// an earlier id named, so scripts written against the settings dialog
    /// keep working: `connections` is Models, and `permissions` (the default
    /// permission mode) is General while Desktop's Permissions page is not
    /// built.
    pub fn from_key(key: &str) -> Option<Self> {
        let named = Self::ALL.into_iter().find(|section| section.key() == key);
        if let Some(section) = named.filter(|section| section.implemented()) {
            return Some(section);
        }
        match key {
            "connections" => Some(Self::Models),
            "permissions" => Some(Self::General),
            _ => None,
        }
    }

    /// The section's icon in the navigation: Maka's own glyph where the set
    /// has one, else the Lucide glyph Desktop draws.
    pub fn icon(self) -> Icon {
        match self {
            Self::General => Icon::new(MakaIcon::Settings),
            Self::Appearance => Icon::new(IconName::Palette),
            Self::Projects => Icon::new(MakaIcon::Folder),
            Self::Models => Icon::new(AssetIcon::Cpu),
            Self::ExternalAgents | Self::BotChat => Icon::new(AssetIcon::Bot),
            Self::Subagents => Icon::new(AssetIcon::Workflow),
            Self::Memory => Icon::new(AssetIcon::Brain),
            Self::Search => Icon::new(MakaIcon::Search),
            Self::Usage => Icon::new(AssetIcon::ChartColumn),
            Self::ArchivedTasks => Icon::new(AssetIcon::ListTodo),
            Self::ImportTasks => Icon::new(AssetIcon::Upload),
            Self::DailyReview => Icon::new(AssetIcon::CalendarDays),
            Self::Data => Icon::new(AssetIcon::Database),
            Self::Permissions => Icon::new(AssetIcon::ShieldCheck),
            Self::Health => Icon::new(AssetIcon::Activity),
            Self::About => Icon::new(IconName::Info),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sections_are_desktops_in_its_order_and_groups() {
        let keys: Vec<&str> = SettingsSection::ALL.iter().map(|section| section.key()).collect();
        assert_eq!(
            keys,
            [
                "general",
                "appearance",
                "projects",
                "models",
                "external-agents",
                "subagents",
                "memory",
                "bot-chat",
                "search",
                "usage",
                "archived-tasks",
                "import-tasks",
                "daily-review",
                "data",
                "permissions",
                "health",
                "about",
            ]
        );
        // Each group's sections are contiguous, in the groups' order.
        let groups: Vec<NavGroup> = SettingsSection::ALL.iter().map(|s| s.group()).collect();
        let mut order = groups.clone();
        order.dedup();
        assert_eq!(order, NavGroup::ALL);
        assert_eq!(groups.iter().filter(|g| **g == NavGroup::Capabilities).count(), 6);
        let badged: Vec<_> =
            SettingsSection::ALL.into_iter().filter(|s| s.badge().is_some()).collect();
        assert_eq!(badged, [SettingsSection::Search]);
        let listed: Vec<_> = SettingsSection::listed().collect();
        assert_eq!(
            listed,
            [
                SettingsSection::General,
                SettingsSection::Appearance,
                SettingsSection::Projects,
                SettingsSection::Models,
                SettingsSection::Subagents,
                SettingsSection::Memory,
                SettingsSection::BotChat,
                SettingsSection::Search,
                SettingsSection::Usage,
                SettingsSection::ArchivedTasks,
                SettingsSection::ImportTasks,
                SettingsSection::DailyReview,
                SettingsSection::Data,
                SettingsSection::Health,
                SettingsSection::About,
            ]
        );
    }

    #[test]
    fn the_dialogs_ids_still_open_their_settings() {
        for section in SettingsSection::listed() {
            assert_eq!(SettingsSection::from_key(section.key()), Some(section));
        }
        assert_eq!(SettingsSection::from_key("connections"), Some(SettingsSection::Models));
        assert_eq!(SettingsSection::from_key("permissions"), Some(SettingsSection::General));
        assert_eq!(SettingsSection::from_key("projects"), Some(SettingsSection::Projects));
        assert_eq!(SettingsSection::from_key("external-agents"), None, "not built yet");
        assert_eq!(SettingsSection::from_key("nope"), None);
    }

    fn zh_hans() -> Locale {
        Locale::SimplifiedChinese
    }

    #[test]
    fn the_search_finds_a_section_by_name_or_by_what_it_holds() {
        let found = |query: &str, locale| -> Vec<SettingsSection> {
            SettingsSection::listed().filter(|s| s.matches(query, locale)).collect()
        };
        let en = Locale::English;
        assert_eq!(found("appearance", en), [SettingsSection::Appearance]);
        assert_eq!(found("api key", en), [SettingsSection::Models]);
        assert_eq!(found("conn", en), [SettingsSection::Models], "by the old name");
        assert_eq!(found("permission", en), [SettingsSection::General]);
        // Every row of General and Appearance, by its title.
        for title in [
            copy::DISPLAY_NAME,
            copy::ASSISTANT_TONE,
            copy::INCOGNITO,
            copy::NOTIFICATIONS,
            copy::WORKSPACE_INSTRUCTIONS,
            copy::CODE_MODE,
            copy::DEFAULT_MODEL,
            copy::SHELL_PREFERENCE,
            copy::PROXY,
            copy::PROXY_BYPASS,
        ] {
            let query = title.en().to_lowercase();
            assert!(found(&query, en).contains(&SettingsSection::General), "{query}");
        }
        for title in [copy::PALETTE, copy::PALETTE_TOKYO_NIGHT, copy::UI_FONT_SIZE] {
            let query = title.en().to_lowercase();
            assert!(found(&query, en).contains(&SettingsSection::Appearance), "{query}");
        }
        assert_eq!(found("代理", zh_hans()), [SettingsSection::General]);
        assert_eq!(found("follow system", en).len(), 2, "language and theme");
        // In the interface's language, and in English whatever it is.
        let zh = Locale::SimplifiedChinese;
        assert_eq!(found("工作区", zh), [SettingsSection::Projects]);
        assert_eq!(found("theme", zh), [SettingsSection::Appearance]);
    }

    #[test]
    fn the_capability_pages_are_found_by_what_they_hold() {
        let found = |query: &str, locale| -> Vec<SettingsSection> {
            SettingsSection::listed().filter(|s| s.matches(query, locale)).collect()
        };
        let en = Locale::English;
        assert_eq!(found("tavily", en), [SettingsSection::Search]);
        assert_eq!(found("memory.md", en), [SettingsSection::Memory]);
        assert_eq!(found("capability profile", en), [SettingsSection::Subagents]);
        assert_eq!(found("联网搜索", zh_hans()), [SettingsSection::Search]);
        assert_eq!(found("记忆", zh_hans()), [SettingsSection::Memory]);
    }
}

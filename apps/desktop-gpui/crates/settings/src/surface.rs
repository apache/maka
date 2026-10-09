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

//! The settings surface, after Maka Desktop's (settings-surface.tsx): a
//! section navigation that takes the sidebar's place, and the chosen
//! section's page, which takes the plate's. The shell draws the window
//! around both ([`SettingsView::render_nav`], [`SettingsView::render_page`]).

use std::path::PathBuf;

use bots::BotService;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::scroll::Scrollbar;
use gpui_kit::component::{
    ActiveTheme as _, Disableable as _, Icon, Sizable as _, StyledExt as _, ThemeStyled as _,
    h_flex, v_flex,
};
use gpui_kit::{
    AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter, FocusHandle,
    Focusable, InteractiveElement as _, IntoElement, KeyBinding, MouseButton, MouseDownEvent,
    ParentElement as _, Render, Role, ScrollHandle, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, TestSupportExt as _, Window, div, point,
    prelude::FluentBuilder as _, px, rems,
};
use shared::copy::Locale;
use shared::copy::settings as settings_copy;
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, DISPLAY_LINE_REMS, DISPLAY_TEXT_REMS, badge, selectable_row,
};
use workspace::actions::FocusSearch;
use workspace::{ConnectionCatalog, HostSession, ProjectSelection, configured_maka_checkout};

use crate::about_page::AboutPage;
use crate::appearance_page::AppearancePage;
use crate::archived_page::ArchivedTasksPage;
use crate::bot_chat_page::BotChatPage;
use crate::connections_pane::ConnectionsPane;
use crate::daily_review_page::DailyReviewPage;
use crate::data_page::DataPage;
use crate::general_page::GeneralPage;
use crate::health_page::HealthPage;
use crate::host_picker::{HostPicker, section_shows_host_picker};
use crate::memory_page::MemoryPage;
use crate::policy::HostPolicy;
use crate::preferences::AppPreferences;
use crate::projects_pane::ProjectsPane;
use crate::rows::SettingsGroup;
use crate::runtime_host_section::{RuntimeHostEvent, RuntimeHostSection};
use crate::section::{NavGroup, SettingsSection};
use crate::subagents_page::SubagentsPage;
use crate::transfer_page::{TransferEvent, TransferPage};
use crate::usage_page::{UsagePage, UsagePageEvent};
use crate::web_search_page::WebSearchPage;

/// Key context of the section list: arrows, Home, and End move through the
/// sections while it has focus, and Enter moves focus to the page.
pub const SETTINGS_NAV_CONTEXT: &str = "SettingsNav";

/// Key context of the whole surface (the navigation and the page): Escape
/// goes back to the app unless a text field has focus.
pub const SETTINGS_SURFACE_CONTEXT: &str = "SettingsSurface";

/// The readable width of a page: Desktop's 920px content column
/// (`contentWidth={920}`), its 24px side padding included, one width for
/// every page so the left edge does not move between them.
pub const PAGE_MAX_WIDTH_REMS: f32 = 57.5;

/// A group label's line in the navigation: the sidebar's (28px).
const GROUP_LABEL_HEIGHT_REMS: f32 = 1.75;

gpui_kit::actions!(
    settings_nav,
    [
        /// Show the section above.
        SelectPreviousSection,
        /// Show the section below.
        SelectNextSection,
        /// Show the first section.
        SelectFirstSection,
        /// Show the last section.
        SelectLastSection,
        /// Move focus from the section list to the page.
        OpenSection,
        /// Leave settings for the task that was showing.
        BackToApp,
    ]
);

/// Binds the surface's keys. Called by [`crate::init`].
pub(crate) fn bind_keys(cx: &mut App) {
    let nav = Some(SETTINGS_NAV_CONTEXT);
    cx.bind_keys([
        KeyBinding::new("up", SelectPreviousSection, nav),
        KeyBinding::new("down", SelectNextSection, nav),
        KeyBinding::new("home", SelectFirstSection, nav),
        KeyBinding::new("end", SelectLastSection, nav),
        KeyBinding::new("enter", OpenSection, nav),
        // A field being edited keeps Escape (it may cancel the edit).
        KeyBinding::new("escape", BackToApp, Some("SettingsSurface && !Input")),
        // Anywhere in the surface, a field included: a text field's own
        // ⌘F (the kit's find) passes on unless it searches its text.
        KeyBinding::new("secondary-f", FocusSearch, Some(SETTINGS_SURFACE_CONTEXT)),
    ]);
}

/// Facts the About page shows that only the shell knows.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct AboutFacts {
    /// The app's version, from Cargo.
    pub app_version: SharedString,
    /// The Maka checkout Hosts are started from.
    pub maka_checkout: Option<PathBuf>,
}

impl AboutFacts {
    /// The app's `version` and the configured Maka checkout.
    pub fn new(app_version: impl Into<SharedString>) -> Self {
        Self { app_version: app_version.into(), maka_checkout: configured_maka_checkout() }
    }
}

/// What the surface works on: the window's Host session, connection
/// catalog, and projects, the facts About shows, and the chat bots of its
/// State Root. Cheap to clone.
#[derive(Clone)]
pub struct SettingsContext {
    host: Entity<HostSession>,
    connections: Entity<ConnectionCatalog>,
    projects: Entity<ProjectSelection>,
    about: AboutFacts,
    bots: Option<Entity<BotService>>,
}

impl std::fmt::Debug for SettingsContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsContext").field("about", &self.about).finish_non_exhaustive()
    }
}

impl SettingsContext {
    pub fn new(
        host: Entity<HostSession>,
        connections: Entity<ConnectionCatalog>,
        projects: Entity<ProjectSelection>,
        about: AboutFacts,
    ) -> Self {
        Self { host, connections, projects, about, bots: None }
    }

    /// The chat bots Remote access configures; without them the page says
    /// it has none.
    pub fn with_bots(mut self, bots: Entity<BotService>) -> Self {
        self.bots = Some(bots);
        self
    }
}

/// What the surface asks of the shell that shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum SettingsEvent {
    /// "Back to app" or Escape: show the app as it was.
    BackToApp,
}

/// One line of the navigation: a group's label or a section.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NavEntry {
    Group(NavGroup),
    Section(SettingsSection),
}

/// Behavior owner of the settings surface: the section shown, the section
/// search, and the pages' entities (General's [`GeneralPage`], Workspace's
/// [`ProjectsPane`], Models' [`ConnectionsPane`], the runtime policy they
/// share in [`HostPolicy`]); Appearance and About render from the
/// preferences and the Host session directly. It lives while the surface
/// shows; the shell drops it on [`SettingsEvent::BackToApp`].
///
/// Keyboard: Tab walks "Back to app", the search field, the section list
/// (one Tab stop: Up, Down, Home, and End change the section at once, as
/// switching needs no loading; Enter moves focus to the page's title), and
/// then the page, its title first. Escape anywhere but in a text field
/// goes back to the app, unless a change a page sent is unanswered. ⌘F
/// anywhere moves focus to the page's own search or filter field while it
/// shows one (Memory, Models, Archived tasks, Usage, Import), else to the
/// section search.
pub struct SettingsView {
    section: SettingsSection,
    nav_search: Entity<InputState>,
    nav_focus: FocusHandle,
    /// The page's title region: where Enter on the list takes focus.
    page_focus: FocusHandle,
    nav_scroll: ScrollHandle,
    page_scroll: ScrollHandle,
    policy: Entity<HostPolicy>,
    general: Entity<GeneralPage>,
    subagents: Entity<SubagentsPage>,
    memory: Entity<MemoryPage>,
    web_search: Entity<WebSearchPage>,
    bot_chat: Entity<BotChatPage>,
    appearance: Entity<AppearancePage>,
    connections: Entity<ConnectionsPane>,
    projects: Entity<ProjectsPane>,
    daily_review: Entity<DailyReviewPage>,
    archived: Entity<ArchivedTasksPage>,
    usage: Entity<UsagePage>,
    health: Entity<HealthPage>,
    about: Entity<AboutPage>,
    transfer: Entity<TransferPage>,
    data: Entity<DataPage>,
    /// Workspace's Runtime Host block and the header's Host picker, when
    /// the app keeps a Host directory.
    hosts: Option<(Entity<RuntimeHostSection>, Entity<HostPicker>)>,
    /// A target of [`Self::open_target`] that waits for the policy to be
    /// read, and the observation that opens it then.
    pending_target: Option<(SharedString, Subscription)>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for SettingsView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SettingsView").field("section", &self.section).finish_non_exhaustive()
    }
}

impl EventEmitter<SettingsEvent> for SettingsView {}

/// A task the surface asks the shell to show: one the Usage page's
/// activity log names.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct OpenTask {
    pub session_id: SharedString,
}

impl EventEmitter<OpenTask> for SettingsView {}

/// The Host the surface asks the shell to switch the window to: chosen as
/// the default, from a Host's menu, or in the header's picker.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct SwitchHost {
    /// `local` or a remote profile's id.
    pub profile_id: SharedString,
}

impl EventEmitter<SwitchHost> for SettingsView {}

impl SettingsView {
    /// The surface on `section` (General when it is not built).
    pub fn new(
        context: SettingsContext,
        section: SettingsSection,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let nav_search = cx.new(|cx| {
            InputState::new(window, cx).placeholder(settings_copy::SETTINGS_SEARCH.get(cx))
        });
        let policy = cx.new(|cx| HostPolicy::new(context.host.clone(), cx));
        let general = cx.new(|cx| {
            let (host, catalog) = (context.host.clone(), context.connections.clone());
            GeneralPage::new(host, policy.clone(), catalog, window, cx)
        });
        let subagents = cx.new(|cx| {
            let (host, catalog) = (context.host.clone(), context.connections.clone());
            SubagentsPage::new(host, policy.clone(), catalog, cx)
        });
        let memory = cx.new(|cx| MemoryPage::new(context.host.clone(), policy.clone(), window, cx));
        let web_search =
            cx.new(|cx| WebSearchPage::new(context.host.clone(), policy.clone(), window, cx));
        let bot_chat = cx.new(|cx| BotChatPage::new(context.bots.clone(), window, cx));
        let page_scroll = ScrollHandle::new();
        let appearance = cx.new(|cx| AppearancePage::new(&context.host, &page_scroll, window, cx));
        let connections = cx.new(|cx| {
            ConnectionsPane::new(context.host.clone(), context.connections.clone(), window, cx)
        });
        let projects = cx.new(|cx| ProjectsPane::new(context.projects.clone(), cx));
        let daily_review = cx.new(|cx| {
            DailyReviewPage::new(context.host.clone(), context.connections.clone(), window, cx)
        });
        let archived = cx.new(|cx| {
            ArchivedTasksPage::new(context.host.clone(), context.projects.clone(), window, cx)
        });
        let usage = cx.new(|cx| UsagePage::new(context.host.clone(), window, cx));
        let health = cx.new(|cx| HealthPage::new(context.host.clone(), cx));
        let about = cx.new(|cx| AboutPage::new(context.host.clone(), context.about.clone(), cx));
        let transfer = cx.new(|cx| {
            TransferPage::new(context.host.clone(), context.projects.clone(), window, cx)
        });
        let data = cx.new(|cx| {
            let (host, catalog) = (context.host.clone(), context.connections.clone());
            let version = context.about.app_version.clone();
            DataPage::new(host, policy.clone(), catalog, version, window, cx)
        });
        let hosts = workspace::HostDirectory::global(cx).map(|directory| {
            let host = context.host.clone();
            let section =
                cx.new(|cx| RuntimeHostSection::new(directory.clone(), host.clone(), window, cx));
            let picker = cx.new(|cx| HostPicker::new(directory, host, window, cx));
            (section, picker)
        });
        let mut subscriptions = vec![
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let placeholder = settings_copy::SETTINGS_SEARCH.get(cx);
                this.nav_search
                    .update(cx, |search, cx| search.set_placeholder(placeholder, window, cx));
            }),
            cx.subscribe(&nav_search, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.observe(&policy, |_, _, cx| cx.notify()),
            cx.observe(&general, |_, _, cx| cx.notify()),
            cx.observe(&subagents, |_, _, cx| cx.notify()),
            cx.observe(&memory, |_, _, cx| cx.notify()),
            cx.observe(&web_search, |_, _, cx| cx.notify()),
            cx.observe(&bot_chat, |_, _, cx| cx.notify()),
            cx.observe(&appearance, |_, _, cx| cx.notify()),
            cx.observe(&connections, |_, _, cx| cx.notify()),
            cx.observe(&projects, |_, _, cx| cx.notify()),
            cx.observe(&daily_review, |_, _, cx| cx.notify()),
            cx.observe(&archived, |_, _, cx| cx.notify()),
            cx.observe(&usage, |_, _, cx| cx.notify()),
            cx.observe(&health, |_, _, cx| cx.notify()),
            cx.observe(&about, |_, _, cx| cx.notify()),
            cx.observe(&transfer, |_, _, cx| cx.notify()),
            cx.observe(&data, |_, _, cx| cx.notify()),
            cx.subscribe(&transfer, |_, _, event: &TransferEvent, cx| match event {
                TransferEvent::OpenTask(id) => cx.emit(OpenTask { session_id: id.clone() }),
            }),
            cx.subscribe(&usage, |_, _, event: &UsagePageEvent, cx| match event {
                UsagePageEvent::OpenTask(id) => cx.emit(OpenTask { session_id: id.clone() }),
            }),
            cx.observe(&context.host, |_, _, cx| cx.notify()),
            cx.observe(&AppPreferences::global(cx), |_, _, cx| cx.notify()),
        ];
        if let Some((section, picker)) = &hosts {
            let switch =
                |_: &mut Self, event: &RuntimeHostEvent, cx: &mut Context<Self>| match event {
                    RuntimeHostEvent::SwitchHost(id) => {
                        cx.emit(SwitchHost { profile_id: id.clone() })
                    }
                };
            subscriptions.extend([
                cx.observe(section, |_, _, cx| cx.notify()),
                cx.observe(picker, |_, _, cx| cx.notify()),
                cx.subscribe(section, move |this, _, event, cx| switch(this, event, cx)),
                cx.subscribe(picker, move |this, _, event, cx| switch(this, event, cx)),
            ]);
        }
        let section = if section.implemented() { section } else { SettingsSection::General };
        remember_section(section, cx);
        let mut this = Self {
            section,
            nav_search,
            nav_focus: cx.focus_handle().tab_stop(true),
            page_focus: cx.focus_handle().tab_stop(true),
            nav_scroll: ScrollHandle::new(),
            page_scroll,
            policy,
            general,
            subagents,
            memory,
            web_search,
            bot_chat,
            appearance,
            connections,
            projects,
            daily_review,
            archived,
            usage,
            health,
            about,
            transfer,
            data,
            hosts,
            pending_target: None,
            _subscriptions: subscriptions,
        };
        this.activate_section(cx);
        this
    }

    pub fn section(&self) -> SettingsSection {
        self.section
    }

    /// The section search above the navigation.
    pub fn section_search(&self) -> &Entity<InputState> {
        &self.nav_search
    }

    pub fn general(&self) -> &Entity<GeneralPage> {
        &self.general
    }

    pub fn subagents(&self) -> &Entity<SubagentsPage> {
        &self.subagents
    }

    pub fn memory(&self) -> &Entity<MemoryPage> {
        &self.memory
    }

    pub fn bot_chat(&self) -> &Entity<BotChatPage> {
        &self.bot_chat
    }

    pub fn web_search(&self) -> &Entity<WebSearchPage> {
        &self.web_search
    }

    pub fn appearance(&self) -> &Entity<AppearancePage> {
        &self.appearance
    }

    pub fn policy(&self) -> &Entity<HostPolicy> {
        &self.policy
    }

    pub fn connections(&self) -> &Entity<ConnectionsPane> {
        &self.connections
    }

    pub fn projects(&self) -> &Entity<ProjectsPane> {
        &self.projects
    }

    pub fn daily_review(&self) -> &Entity<DailyReviewPage> {
        &self.daily_review
    }

    pub fn archived(&self) -> &Entity<ArchivedTasksPage> {
        &self.archived
    }

    pub fn usage(&self) -> &Entity<UsagePage> {
        &self.usage
    }

    pub fn health(&self) -> &Entity<HealthPage> {
        &self.health
    }

    /// Workspace's Runtime Host block, when the app keeps a Host directory.
    pub fn hosts(&self) -> Option<&Entity<RuntimeHostSection>> {
        self.hosts.as_ref().map(|(section, _)| section)
    }

    /// The header's Host picker, when the app keeps a Host directory.
    pub fn host_picker(&self) -> Option<&Entity<HostPicker>> {
        self.hosts.as_ref().map(|(_, picker)| picker)
    }

    pub fn transfer(&self) -> &Entity<TransferPage> {
        &self.transfer
    }

    pub fn data(&self) -> &Entity<DataPage> {
        &self.data
    }

    /// Tells the page shown that it shows: a page that reads the Host reads
    /// it then, not when settings open.
    fn activate_section(&mut self, cx: &mut Context<Self>) {
        match self.section {
            SettingsSection::Memory => self.memory.update(cx, |page, cx| page.activate(cx)),
            SettingsSection::Search => self.web_search.update(cx, |page, cx| page.activate(cx)),
            SettingsSection::BotChat => self.bot_chat.update(cx, |page, cx| page.activate(cx)),
            SettingsSection::DailyReview => {
                self.daily_review.update(cx, |page, cx| page.activate(cx));
            }
            SettingsSection::ArchivedTasks => {
                self.archived.update(cx, |page, cx| page.activate(cx));
            }
            SettingsSection::Usage => self.usage.update(cx, |page, cx| page.activate(cx)),
            SettingsSection::Health => self.health.update(cx, |page, cx| page.activate(cx)),
            SettingsSection::ImportTasks => {
                self.transfer.update(cx, |page, cx| page.activate(cx));
            }
            _ => {}
        }
    }

    /// Shows `section`, from its top, and remembers it as the one settings
    /// open on next. A section not built yet is ignored.
    pub fn select(&mut self, section: SettingsSection, cx: &mut Context<Self>) {
        if self.section != section && section.implemented() {
            self.section = section;
            self.page_scroll.set_offset(point(px(0.), px(0.)));
            remember_section(section, cx);
            self.activate_section(cx);
            cx.notify();
        }
    }

    /// Scrolls the page to its end, for screenshots of its last groups
    /// (`--open-settings <section>:end`).
    pub fn scroll_page_to_end(&self) {
        self.page_scroll.scroll_to_bottom();
    }

    /// Keeps `target` for [`Self::open_target`] until the policy is read,
    /// then opens it.
    fn wait_for_policy(&mut self, target: &str, window: &mut Window, cx: &mut Context<Self>) {
        let waiting = cx.observe_in(&self.policy, window, |this, policy, window, cx| {
            if policy.read(cx).policy().is_some()
                && let Some((target, _)) = this.pending_target.take()
                && !this.open_target(&target, window, cx)
            {
                log::warn!("settings: nothing to open at {target:?}");
            }
        });
        self.pending_target = Some((target.to_owned().into(), waiting));
    }

    /// Opens a place inside the page, for screenshots
    /// (`--open-settings <section>:<target>`): `end` scrolls the page to its
    /// end once the policy is read; on Models, `catalog` shows the provider catalog, `add:<provider>`
    /// a provider's form (by `providerType`), `connection:<slug>` a
    /// connection's detail (`connection:<slug>:end` scrolled to its end),
    /// `parameters:<slug>:<model>` a model's parameters, and
    /// `add-model:<slug>` the Add model dialog; on General, `full-access`
    /// asks the Full access question; on Appearance, `font-size`, `app-icon`
    /// and `pets` scroll to those sections and `app-icon-end` to the last
    /// group of app icons. Returns whether the target was one
    /// of these (a connection it names must be in the catalog).
    pub fn open_target(
        &mut self,
        target: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        // The page's rows come with the policy: until it is read, `end`
        // would scroll to the end of a page still growing.
        if target == "end" && self.policy.read(cx).policy().is_none() {
            self.wait_for_policy(target, window, cx);
            return true;
        }
        if target == "end" {
            self.scroll_page_to_end();
            return true;
        }
        match (self.section, target.split(':').collect::<Vec<_>>().as_slice()) {
            (SettingsSection::Appearance, [target]) => {
                self.appearance.update(cx, |page, cx| page.reveal(target, window, cx))
            }
            // Subagents: `add` a new preset's editor, `edit:<id>` a preset's;
            // Memory: `add` the add form, `details` (`details-end` scrolled
            // to its end) the file and its backups. The presets and the
            // default mode come with the policy: until it is read, a
            // Subagents target and General's `full-access` wait for it.
            (SettingsSection::Subagents, ["add"] | ["edit", ..])
            | (SettingsSection::General, ["full-access"])
                if self.policy.read(cx).policy().is_none() =>
            {
                self.wait_for_policy(target, window, cx);
                true
            }
            (SettingsSection::General, ["full-access"]) => {
                self.general.update(cx, |page, cx| page.ask_full_access(window, cx));
                true
            }
            (SettingsSection::Subagents, ["add"]) => {
                self.subagents.update(cx, |page, cx| page.open_create(window, cx));
                self.subagents.read(cx).editor(cx).is_some()
            }
            // A preset id may hold colons itself.
            (SettingsSection::Subagents, ["edit", id @ ..]) if !id.is_empty() => {
                let id = id.join(":");
                self.subagents.update(cx, |page, cx| page.open_editor(&id, window, cx))
            }
            // Remote access: `<provider>` a platform's detail, then
            // `manual`, `lark`, `scan`, `bridge` (see `BotChatPage::reveal`).
            (SettingsSection::BotChat, target) => {
                self.bot_chat.update(cx, |page, cx| page.reveal(target, window, cx))
            }
            (SettingsSection::Memory, ["add" | "details" | "details-end"]) => {
                self.memory.update(cx, |page, cx| page.reveal(target, window, cx));
                if target == "details-end" {
                    self.scroll_page_to_end();
                }
                true
            }
            (SettingsSection::Models, ["catalog"]) => {
                self.show_add_connection(window, cx);
                true
            }
            (SettingsSection::Models, ["add", provider]) => self
                .connections
                .update(cx, |pane, cx| pane.show_setup(provider, true, window, cx))
                .is_some(),
            (SettingsSection::Models, ["connection", slug, rest @ ..]) => {
                let opened =
                    self.connections.update(cx, |pane, cx| pane.show_detail_of(slug, window, cx));
                if opened && rest == ["end"] {
                    self.scroll_page_to_end();
                }
                opened && (rest.is_empty() || rest == ["end"])
            }
            // A model id may hold colons itself (`qwen2.5:7b`).
            (SettingsSection::Models, ["parameters", slug, model @ ..]) if !model.is_empty() => {
                let detail = self.connections.update(cx, |pane, cx| {
                    pane.show_detail_of(slug, window, cx).then(|| pane.detail().cloned()).flatten()
                });
                let model = SharedString::from(model.join(":"));
                detail.is_some_and(|detail| {
                    detail.update(cx, |detail, cx| detail.open_parameters(Some(model), window, cx));
                    true
                })
            }
            (SettingsSection::Models, ["add-model", slug]) => {
                let detail = self.connections.update(cx, |pane, cx| {
                    pane.show_detail_of(slug, window, cx).then(|| pane.detail().cloned()).flatten()
                });
                detail.is_some_and(|detail| {
                    detail.update(cx, |detail, cx| detail.open_parameters(None, window, cx));
                    true
                })
            }
            // Workspace: `directory` the remote project browser, and the
            // Runtime Host block's `manual`, `manual-ssh`, `manual-operator`,
            // `manual-plaintext` (see `RuntimeHostSection::reveal`).
            (SettingsSection::Projects, ["directory"]) => {
                self.projects.update(cx, |pane, cx| pane.open_remote_directory(window, cx))
            }
            (SettingsSection::Projects, [target]) => self.hosts().cloned().is_some_and(|hosts| {
                hosts.update(cx, |hosts, cx| hosts.reveal(target, window, cx))
            }),
            _ => false,
        }
    }

    /// Shows Models with the provider catalog ("Add connection"), its
    /// search focused.
    pub fn show_add_connection(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.select(SettingsSection::Models, cx);
        self.connections.update(cx, |pane, cx| pane.show_catalog(window, cx));
    }

    /// Moves focus to the section list.
    pub fn focus_nav(&self, window: &mut Window, cx: &mut App) {
        self.nav_focus.focus(window, cx);
    }

    /// Whether a change a page sent is unanswered: leaving would hide its
    /// outcome.
    pub fn is_busy(&self, cx: &App) -> bool {
        self.connections.read(cx).is_busy(cx)
            || self.projects.read(cx).is_busy(cx)
            || self.general.read(cx).is_busy(cx)
            || self.subagents.read(cx).is_busy()
            || self.memory.read(cx).is_busy()
            || self.web_search.read(cx).is_busy()
            || self.bot_chat.read(cx).is_busy()
            || self.daily_review.read(cx).is_busy(cx)
            || self.archived.read(cx).is_busy()
            || self.transfer.read(cx).is_busy()
            || self.data.read(cx).is_busy()
            || self.hosts().is_some_and(|hosts| hosts.read(cx).is_busy(cx))
    }

    /// Asks the shell to show the app again, unless a change is unanswered.
    pub fn back_to_app(&mut self, cx: &mut Context<Self>) {
        if !self.is_busy(cx) {
            cx.emit(SettingsEvent::BackToApp);
        }
    }

    fn on_back_to_app(&mut self, _: &BackToApp, _: &mut Window, cx: &mut Context<Self>) {
        self.back_to_app(cx);
    }

    /// ⌘F, from the navigation or the page: the page's own search or
    /// filter field while it shows one, else the section search, with its
    /// text selected.
    fn focus_search(&mut self, _: &FocusSearch, window: &mut Window, cx: &mut Context<Self>) {
        let field = self.page_search(cx).unwrap_or_else(|| self.nav_search.clone());
        field.update(cx, |field, cx| {
            field.focus(window, cx);
            field.select_all(window, cx);
        });
    }

    /// The one search or filter field of the page shown, while it shows.
    fn page_search(&self, cx: &App) -> Option<Entity<InputState>> {
        match self.section {
            SettingsSection::Models => self.connections.read(cx).search_field(cx),
            SettingsSection::Memory => self.memory.read(cx).search_field(cx),
            SettingsSection::ArchivedTasks => self.archived.read(cx).search_field(),
            SettingsSection::Usage => self.usage.read(cx).search_field(cx),
            SettingsSection::ImportTasks => self.transfer.read(cx).search_field(),
            _ => None,
        }
    }

    /// The sections the search finds, in the navigation's order.
    fn listed_sections(&self, cx: &App) -> Vec<SettingsSection> {
        let query = self.nav_search.read(cx).value().trim().to_lowercase();
        SettingsSection::listed()
            .filter(|section| query.is_empty() || section.matches(&query, Locale::current(cx)))
            .collect()
    }

    /// The navigation's lines: each group that has a listed section, by its
    /// label, then its sections.
    fn nav_entries(listed: &[SettingsSection]) -> Vec<NavEntry> {
        let mut entries = Vec::with_capacity(listed.len() + NavGroup::ALL.len());
        for group in NavGroup::ALL {
            let mut sections = listed.iter().filter(|section| section.group() == group).peekable();
            if sections.peek().is_some() {
                entries.push(NavEntry::Group(group));
                entries.extend(sections.map(|section| NavEntry::Section(*section)));
            }
        }
        entries
    }

    /// Shows `section` and scrolls its line into view.
    fn select_listed(
        &mut self,
        section: SettingsSection,
        listed: &[SettingsSection],
        cx: &mut Context<Self>,
    ) {
        self.select(section, cx);
        let entries = Self::nav_entries(listed);
        if let Some(ix) = entries.iter().position(|entry| *entry == NavEntry::Section(section)) {
            self.nav_scroll.scroll_to_item(ix);
        }
    }

    fn step(&mut self, forward: bool, cx: &mut Context<Self>) {
        let listed = self.listed_sections(cx);
        let Some(last) = listed.len().checked_sub(1) else {
            return;
        };
        let target = match (listed.iter().position(|s| *s == self.section), forward) {
            (Some(ix), true) => (ix + 1).min(last),
            (Some(ix), false) => ix.saturating_sub(1),
            (None, _) => 0,
        };
        self.select_listed(listed[target], &listed, cx);
    }

    fn select_previous(
        &mut self,
        _: &SelectPreviousSection,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.step(false, cx);
    }

    fn select_next(&mut self, _: &SelectNextSection, _: &mut Window, cx: &mut Context<Self>) {
        self.step(true, cx);
    }

    fn select_first(&mut self, _: &SelectFirstSection, _: &mut Window, cx: &mut Context<Self>) {
        let listed = self.listed_sections(cx);
        if let Some(first) = listed.first().copied() {
            self.select_listed(first, &listed, cx);
        }
    }

    fn select_last(&mut self, _: &SelectLastSection, _: &mut Window, cx: &mut Context<Self>) {
        let listed = self.listed_sections(cx);
        if let Some(last) = listed.last().copied() {
            self.select_listed(last, &listed, cx);
        }
    }

    fn open_section(&mut self, _: &OpenSection, window: &mut Window, cx: &mut Context<Self>) {
        self.page_focus.focus(window, cx);
    }

    /// The navigation, for the sidebar's place: "Back to app", the section
    /// search, and the sections under their groups' labels, in the
    /// sidebar's row geometry.
    pub fn render_nav(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let listed = self.listed_sections(cx);
        let entries = Self::nav_entries(&listed);
        let keyboard_focus = self.nav_focus.is_focused(window) && window.last_input_was_keyboard();
        let maka = cx.maka();
        let busy = self.is_busy(cx);
        let rows: Vec<AnyElement> = entries
            .iter()
            .enumerate()
            .map(|(ix, entry)| match *entry {
                NavEntry::Group(group) => div()
                    .id(domain_element_id("settings-nav-group", group.key()))
                    .test_support()
                    .aria_label(group.label().get(cx))
                    .when(ix > 0, |this| this.mt_2())
                    .h(rems(GROUP_LABEL_HEIGHT_REMS))
                    .flex()
                    .items_center()
                    .px_2()
                    // Desktop's settings nav group title, 12/600 in every
                    // locale (the 14 lift is the task list's alone).
                    .text_xs()
                    .font_semibold()
                    .text_color(maka.ink_muted)
                    .child(group.label().get(cx))
                    .into_any_element(),
                NavEntry::Section(section) => {
                    let selected = section == self.section;
                    self.render_nav_row(section, selected, selected && keyboard_focus, window, cx)
                }
            })
            .collect();
        let back = Button::new("settings-back")
            .ghost()
            .small()
            .w_full()
            .h_8()
            .px_2()
            .justify_start()
            .accessibility_label(settings_copy::BACK_TO_APP.get(cx))
            .disabled(busy)
            .child(
                h_flex().size_4().mr_1().flex_shrink_0().justify_center().child(
                    Icon::new(gpui_kit::assets::IconName::ArrowLeft)
                        .size_4()
                        .text_color(maka.ink_muted),
                ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_sm()
                    .text_color(maka.ink)
                    .child(settings_copy::BACK_TO_APP.get(cx)),
            )
            .on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.back_to_app(cx)));
        v_flex()
            .id("settings-nav-pane")
            .test_support()
            .key_context(SETTINGS_SURFACE_CONTEXT)
            .on_action(cx.listener(Self::on_back_to_app))
            .on_action(cx.listener(Self::focus_search))
            .size_full()
            .min_h_0()
            .px_2()
            .gap_2()
            .child(back)
            .child(
                Input::new(&self.nav_search)
                    .field_fill(cx)
                    .id("settings-search")
                    .aria_label(settings_copy::SETTINGS_SEARCH.get(cx))
                    .prefix(Icon::new(MakaIcon::Search).small())
                    .cleanable(true),
            )
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .child(
                        v_flex()
                            .id("settings-nav")
                            .test_support()
                            .role(Role::List)
                            .aria_label(settings_copy::SETTINGS_NAVIGATION.get(cx))
                            .track_focus(&self.nav_focus)
                            .key_context(SETTINGS_NAV_CONTEXT)
                            .on_action(cx.listener(Self::select_previous))
                            .on_action(cx.listener(Self::select_next))
                            .on_action(cx.listener(Self::select_first))
                            .on_action(cx.listener(Self::select_last))
                            .on_action(cx.listener(Self::open_section))
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.nav_scroll)
                            .pb_2()
                            .gap_0p5()
                            .children(rows)
                            .when(listed.is_empty(), |this| {
                                this.child(
                                    div()
                                        .px_2()
                                        .text_sm()
                                        .text_color(maka.ink_muted)
                                        .child(settings_copy::SETTINGS_NO_MATCH.get(cx)),
                                )
                            }),
                    )
                    .child(Scrollbar::vertical(&self.nav_scroll)),
            )
            .into_any_element()
    }

    /// One section's line: its icon, its label, and its badge, in the
    /// sidebar's task-row geometry; the selected fill on the one shown.
    fn render_nav_row(
        &self,
        section: SettingsSection,
        selected: bool,
        cursor: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let nav_focus = self.nav_focus.clone();
        h_flex()
            .id(domain_element_id("settings-nav", section.key()))
            .test_support()
            .role(Role::ListItem)
            .aria_selected(selected)
            .aria_label(section.label().get(cx))
            .flex_shrink_0()
            .h_8()
            .px_2()
            .gap_2()
            .rounded(cx.theme().radius)
            .text_sm()
            .text_color(maka.ink)
            .when(cursor, |this| this.focus_ring_style(window, cx))
            .when(selected, |this| this.font_medium())
            .map(|this| selectable_row(this, selected, cx))
            .on_mouse_down(MouseButton::Left, move |_: &MouseDownEvent, window, cx| {
                // Keep focus on the list's Tab stop, not on the row.
                window.prevent_default();
                nav_focus.focus(window, cx);
            })
            .on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
                this.select(section, cx);
            }))
            .child(section.icon().size_4().text_color(maka.ink_muted))
            .child(div().flex_1().min_w_0().truncate().child(section.label().get(cx)))
            .children(section.badge().map(|label| badge(label.get(cx), cx)))
            .into_any_element()
    }

    /// The page, for the plate's place: the section's title and its line of
    /// description, then its groups, in one readable column that scrolls
    /// inside the plate (the scroll owner is the whole plate width, so a
    /// wheel over either margin scrolls it too).
    pub fn render_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let title = self.section.label().get(cx);
        let keyboard_focus = self.page_focus.is_focused(window) && window.last_input_was_keyboard();
        let body = self.render_body(cx);
        let host_picker = self
            .host_picker()
            .filter(|_| section_shows_host_picker(self.section))
            .and_then(|picker| picker.read(cx).render_picker(cx));
        let header = v_flex()
            .flex_1()
            .min_w_0()
            .gap_1p5()
            .child(
                div()
                    .id("settings-title")
                    .test_support()
                    .role(Role::Heading)
                    .aria_label(title)
                    .track_focus(&self.page_focus)
                    .rounded(cx.theme().radius)
                    .when(keyboard_focus, |this| this.focus_ring_style(window, cx))
                    .text_size(rems(DISPLAY_TEXT_REMS))
                    .line_height(rems(DISPLAY_LINE_REMS))
                    .text_color(maka.ink)
                    .child(title),
            )
            .child(
                div()
                    .id("settings-description")
                    .test_support()
                    .aria_label(self.section.description().get(cx))
                    .text_sm()
                    .text_color(maka.ink_muted)
                    .child(self.section.description().get(cx)),
            );
        let header = h_flex()
            .w_full()
            .items_start()
            .justify_between()
            .gap_4()
            .child(header)
            .children(host_picker);
        div()
            .id("settings-page")
            .test_support()
            .key_context(SETTINGS_SURFACE_CONTEXT)
            .on_action(cx.listener(Self::on_back_to_app))
            .on_action(cx.listener(Self::focus_search))
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(
                div()
                    .id("settings-body")
                    .test_support()
                    .size_full()
                    .overflow_y_scroll()
                    .track_scroll(&self.page_scroll)
                    .child(
                        v_flex()
                            .id(domain_element_id("settings-section", self.section.key()))
                            .test_support()
                            .w_full()
                            .max_w(rems(PAGE_MAX_WIDTH_REMS))
                            .mx_auto()
                            .px_6()
                            // The scroll runs to the plate's edge, so a row
                            // in view is cut there, never 24 above it in
                            // mid-air (review round 14); the page's end keeps
                            // its 48 inside the content (review round 11).
                            .pb_12()
                            .gap_12()
                            .child(header)
                            .child(body),
                    ),
            )
            .child(Scrollbar::vertical(&self.page_scroll))
            .into_any_element()
    }

    fn render_body(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let body = match self.section {
            SettingsSection::General => self.general.clone().into_any_element(),
            SettingsSection::Appearance => self.appearance.clone().into_any_element(),
            SettingsSection::Projects => {
                let action = self.projects.update(cx, |pane, cx| pane.render_actions(cx));
                // Desktop's group has no heading; after the Host groups
                // here it needs one, its nav name.
                let projects = SettingsGroup::new("projects")
                    .title(settings_copy::SECTION_PROJECTS.get(cx))
                    .description(settings_copy::PROJECTS_HELP.get(cx))
                    .action(action)
                    .bare()
                    .child(self.projects.clone());
                // Desktop's page: the Runtime Host block, then the projects.
                v_flex()
                    .w_full()
                    .gap_12()
                    .children(self.hosts().cloned())
                    .child(projects)
                    .into_any_element()
            }
            SettingsSection::Models => self.connections.clone().into_any_element(),
            SettingsSection::Subagents => self.subagents.clone().into_any_element(),
            SettingsSection::Memory => self.memory.clone().into_any_element(),
            SettingsSection::Search => self.web_search.clone().into_any_element(),
            SettingsSection::BotChat => self.bot_chat.clone().into_any_element(),
            SettingsSection::DailyReview => self.daily_review.clone().into_any_element(),
            SettingsSection::ArchivedTasks => self.archived.clone().into_any_element(),
            SettingsSection::Usage => self.usage.clone().into_any_element(),
            SettingsSection::Health => self.health.clone().into_any_element(),
            SettingsSection::ImportTasks => self.transfer.clone().into_any_element(),
            SettingsSection::Data => self.data.clone().into_any_element(),
            SettingsSection::About => self.about.clone().into_any_element(),
            _ => div().into_any_element(),
        };
        v_flex().w_full().gap_8().child(body).into_any_element()
    }
}

/// Remembers `section` as the one settings open on (Desktop's
/// `maka-settings-section-v1`).
fn remember_section(section: SettingsSection, cx: &mut App) {
    AppPreferences::global(cx)
        .update(cx, |preferences, cx| preferences.set_settings_section(section, cx));
}

impl Focusable for SettingsView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.nav_focus.clone()
    }
}

/// The surface on its own, the navigation beside the page, as previews and
/// tests draw it; the shell places the two halves itself.
impl Render for SettingsView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let nav = self.render_nav(window, cx);
        let page = self.render_page(window, cx);
        h_flex()
            .id("settings")
            .test_support()
            .size_full()
            .items_stretch()
            .text_color(cx.theme().foreground)
            .child(v_flex().w_64().h_full().flex_shrink_0().pt_2().child(nav))
            .child(v_flex().flex_1().min_w_0().h_full().pt_12().child(page))
    }
}

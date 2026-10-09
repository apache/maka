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

//! The Models page, after Maka Desktop's `ProvidersPanel`
//! (apps/desktop/src/renderer/settings/providers-panel.tsx): four levels
//! in one place, each with one way back.
//!
//! ```text
//! list ─┬─ catalog ── setup
//!       ├─ setup (from the empty list's recommended rows)
//!       └─ detail
//! ```
//!
//! The list is the Host's connections (Desktop's rows: the provider's mark,
//! the name with its Default badge, provider · models · default model, the
//! status, a chevron), with a search and an All / Enabled / Disabled
//! filter once there are two. "Add connection" opens the catalog; picking
//! a provider opens its setup form; adding it opens its detail.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::spinner::Spinner;
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, FontWeight, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, Role, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, TestSupportExt as _, Window, div, prelude::FluentBuilder as _, rems,
};
use host_protocol::ProviderDefinition;
use shared::copy::models as copy;
use shared::copy::providers::provider_name;
use shared::copy::settings as settings_copy;
use shared::copy::{Locale, Text, failure};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, HEADING_LINE_REMS, HEADING_TEXT_REMS, badge, control_button,
    quiet_button, route_header, segment, segmented_track,
};
use workspace::{
    ConnectionCatalog, ConnectionCatalogStatus, ConnectionEntry, ConnectionList, HostSession,
};

use crate::add_connection::{AddConnectionEvent, AddConnectionForm};
use crate::connection_detail::{
    ConnectionDetail, ConnectionDetailEvent, connection_status, status_badge,
};
use crate::provider_catalog::{ProviderCatalog, ProviderCatalogEvent};
use crate::rows::{list_row, row_rule};

/// Which connections the list shows.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum ConnectionFilter {
    #[default]
    All,
    Enabled,
    Disabled,
}

impl ConnectionFilter {
    pub const ALL: [Self; 3] = [Self::All, Self::Enabled, Self::Disabled];

    fn label(self) -> Text {
        match self {
            Self::All => settings_copy::FILTER_ALL,
            Self::Enabled => settings_copy::FILTER_ENABLED,
            Self::Disabled => settings_copy::FILTER_DISABLED,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Enabled => "enabled",
            Self::Disabled => "disabled",
        }
    }

    fn admits(self, connection: &ConnectionEntry) -> bool {
        match self {
            Self::All => true,
            Self::Enabled => connection.enabled,
            Self::Disabled => !connection.enabled,
        }
    }
}

/// Where the page is (Desktop's `PanelRoute`).
enum Route {
    List,
    Catalog,
    /// One provider being set up; `from_catalog` is where Back returns.
    Setup {
        form: Entity<AddConnectionForm>,
        from_catalog: bool,
        _events: Subscription,
    },
    /// A connection just added, until the catalog lists it.
    Adopting {
        connection_id: SharedString,
        models_error: Option<SharedString>,
    },
    Detail {
        detail: Entity<ConnectionDetail>,
        _events: Subscription,
    },
}

/// Behavior and presentation owner of the Models page: the route, the
/// list's search and filter, and the catalog (which lives with the page,
/// so its search survives a round trip to a provider's form).
pub struct ConnectionsPane {
    host: Entity<HostSession>,
    catalog: Entity<ConnectionCatalog>,
    providers: Entity<ProviderCatalog>,
    search: Entity<InputState>,
    filter: ConnectionFilter,
    route: Route,
    /// Said once, above the list or the detail: the detail's connection
    /// went away, or the models of the one just added could not be listed.
    notice: Option<SharedString>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ConnectionsPane {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConnectionsPane")
            .field("filter", &self.filter)
            .field("notice", &self.notice)
            .finish_non_exhaustive()
    }
}

impl ConnectionsPane {
    pub fn new(
        host: Entity<HostSession>,
        catalog: Entity<ConnectionCatalog>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search = cx.new(|cx| {
            InputState::new(window, cx).placeholder(settings_copy::CONNECTIONS_SEARCH.get(cx))
        });
        let providers = cx.new(|cx| ProviderCatalog::new(catalog.clone(), window, cx));
        let subscriptions = vec![
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let placeholder = settings_copy::CONNECTIONS_SEARCH.get(cx);
                this.search
                    .update(cx, |search, cx| search.set_placeholder(placeholder, window, cx));
            }),
            cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.subscribe_in(
                &providers,
                window,
                |this, _, event: &ProviderCatalogEvent, window, cx| {
                    let ProviderCatalogEvent::Picked(provider_type) = event;
                    let from_catalog = matches!(this.route, Route::Catalog);
                    this.show_setup(provider_type, from_catalog, window, cx);
                },
            ),
            cx.observe_in(&catalog, window, |this, _, window, cx| this.catalog_changed(window, cx)),
        ];
        Self {
            host,
            catalog,
            providers,
            search,
            filter: ConnectionFilter::All,
            route: Route::List,
            notice: None,
            _subscriptions: subscriptions,
        }
    }

    /// Whether leaving now would hide a step's outcome.
    pub fn is_busy(&self, cx: &App) -> bool {
        match &self.route {
            Route::Setup { form, .. } => form.read(cx).is_busy(),
            Route::Detail { detail, .. } => detail.read(cx).is_busy(),
            _ => false,
        }
    }

    pub fn filter(&self) -> ConnectionFilter {
        self.filter
    }

    pub fn set_filter(&mut self, filter: ConnectionFilter, cx: &mut Context<Self>) {
        if self.filter != filter {
            self.filter = filter;
            cx.notify();
        }
    }

    /// The provider catalog.
    pub fn providers(&self) -> &Entity<ProviderCatalog> {
        &self.providers
    }

    /// Whether the catalog shows.
    pub fn catalog_open(&self) -> bool {
        matches!(self.route, Route::Catalog)
    }

    /// The one search or filter field of what the page shows: the list's
    /// search once it has something to narrow, the catalog's, or the
    /// models' filter of a provider's setup or a connection's detail.
    pub fn search_field(&self, cx: &App) -> Option<Entity<InputState>> {
        match &self.route {
            Route::List => self.shows_list_tools(cx).then(|| self.search.clone()),
            Route::Catalog => Some(self.providers.read(cx).search().clone()),
            Route::Setup { form, .. } => form.read(cx).search_field(),
            Route::Detail { detail, .. } => detail.read(cx).search_field(cx),
            Route::Adopting { .. } => None,
        }
    }

    /// Whether the list's search and filter show: a search or a filter
    /// over one connection has nothing to narrow, so they show once there
    /// are two, or while either is in use.
    fn shows_list_tools(&self, cx: &App) -> bool {
        let total = self.catalog.read(cx).list().map_or(0, |list| list.connections.len());
        let narrowing =
            !self.search.read(cx).value().trim().is_empty() || self.filter != ConnectionFilter::All;
        total > 1 || narrowing
    }

    /// The setup form, while it shows.
    pub fn form(&self) -> Option<&Entity<AddConnectionForm>> {
        match &self.route {
            Route::Setup { form, .. } => Some(form),
            _ => None,
        }
    }

    /// The detail, while it shows.
    pub fn detail(&self) -> Option<&Entity<ConnectionDetail>> {
        match &self.route {
            Route::Detail { detail, .. } => Some(detail),
            _ => None,
        }
    }

    /// What the page says once, above the list or the detail.
    pub fn notice(&self) -> Option<&SharedString> {
        self.notice.as_ref()
    }

    /// The ids of the connections the list shows, in order.
    pub fn listed(&self, cx: &App) -> Vec<SharedString> {
        self.visible_connections(cx).into_iter().map(|connection| connection.id).collect()
    }

    /// Shows the provider catalog with its search focused ("Add
    /// connection").
    pub fn show_catalog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_busy(cx) {
            return;
        }
        self.route = Route::Catalog;
        self.notice = None;
        self.providers.update(cx, |providers, cx| providers.focus(window, cx));
        cx.notify();
    }

    /// Shows the setup form of the provider `provider_type`.
    pub fn show_setup(
        &mut self,
        provider_type: &str,
        from_catalog: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<Entity<AddConnectionForm>> {
        let provider = ProviderDefinition::find(provider_type)?;
        if self.is_busy(cx) {
            return None;
        }
        let (host, catalog) = (self.host.clone(), self.catalog.clone());
        let form = cx.new(|cx| AddConnectionForm::new(host, catalog, provider, window, cx));
        let events =
            cx.subscribe_in(&form, window, |this, _, event: &AddConnectionEvent, window, cx| {
                match event {
                    AddConnectionEvent::Added { connection_id, models_error } => {
                        this.adopt(connection_id.clone(), models_error.clone(), window, cx)
                    }
                    AddConnectionEvent::Cancelled => this.back(window, cx),
                    AddConnectionEvent::ShowList => this.show_list(cx),
                }
            });
        form.update(cx, |form, cx| form.focus_first_field(window, cx));
        self.route = Route::Setup { form: form.clone(), from_catalog, _events: events };
        self.notice = None;
        cx.notify();
        Some(form)
    }

    /// Returns to the list.
    pub fn show_list(&mut self, cx: &mut Context<Self>) {
        if self.is_busy(cx) {
            return;
        }
        self.route = Route::List;
        cx.notify();
    }

    /// One level up: the setup back to where it came from, anything else to
    /// the list.
    pub fn back(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &self.route {
            Route::Setup { from_catalog: true, .. } => self.show_catalog(window, cx),
            _ => self.show_list(cx),
        }
    }

    /// Opens the detail of the connection `id`.
    pub fn show_detail(&mut self, id: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        if self.is_busy(cx) {
            return;
        }
        let (host, catalog) = (self.host.clone(), self.catalog.clone());
        let detail = cx.new(|cx| ConnectionDetail::new(host, catalog, id, window, cx));
        let events =
            cx.subscribe_in(&detail, window, |this, _, event: &ConnectionDetailEvent, _, cx| {
                match event {
                    ConnectionDetailEvent::Back => this.show_list(cx),
                    ConnectionDetailEvent::Removed => {
                        this.route = Route::List;
                        this.notice = None;
                        cx.notify();
                    }
                }
            });
        self.route = Route::Detail { detail, _events: events };
        self.notice = None;
        cx.notify();
    }

    /// Opens the detail of the connection whose identifier is `slug`, if
    /// the catalog lists one.
    pub fn show_detail_of(
        &mut self,
        slug: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let id = self.catalog.read(cx).list().and_then(|list| {
            list.connections.iter().find(|connection| connection.slug == slug).map(|c| c.id.clone())
        });
        match id {
            Some(id) => {
                self.show_detail(id, window, cx);
                true
            }
            None => false,
        }
    }

    /// A connection was just added: its detail, as soon as the catalog
    /// lists it (the new connection's detail rather than the list: every
    /// next step is there).
    fn adopt(
        &mut self,
        connection_id: SharedString,
        models_error: Option<SharedString>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.route = Route::Adopting { connection_id, models_error };
        self.catalog_changed(window, cx);
    }

    fn catalog_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let list = self.catalog.read(cx).list().cloned();
        match &self.route {
            Route::Adopting { connection_id, models_error } => {
                if list.as_ref().and_then(|list| list.connection(connection_id)).is_some() {
                    let (id, error) = (connection_id.clone(), models_error.clone());
                    self.route = Route::List;
                    self.show_detail(id, window, cx);
                    self.notice = error;
                }
            }
            Route::Detail { detail, .. } => {
                let id = detail.read(cx).connection_id().clone();
                // Removed elsewhere: the list, and say so.
                if list.as_ref().is_some_and(|list| list.connection(&id).is_none())
                    && !detail.read(cx).is_busy()
                {
                    self.route = Route::List;
                    self.notice = Some(copy::CONNECTION_REMOVED.get(cx).into());
                }
            }
            _ => {}
        }
        cx.notify();
    }

    fn visible_connections(&self, cx: &App) -> Vec<ConnectionEntry> {
        let query = self.search.read(cx).value().trim().to_lowercase();
        let Some(list) = self.catalog.read(cx).list() else {
            return Vec::new();
        };
        let locale = Locale::current(cx);
        list.connections
            .iter()
            .filter(|connection| self.filter.admits(connection))
            .filter(|connection| {
                query.is_empty()
                    || [
                        connection.name.as_ref(),
                        connection.slug.as_ref(),
                        provider_name(locale, &connection.provider_type),
                    ]
                    .iter()
                    .any(|text| text.to_lowercase().contains(&query))
            })
            .cloned()
            .collect()
    }
}

/// The providers Desktop draws a brand mark for (`ProviderBrandMark` in
/// provider-brand-marks.tsx), which this client draws as the initial of
/// the provider's name. Every other provider, a custom connection's
/// included, takes Desktop's `GenericProviderMark`, the Cpu glyph.
const BRANDED_PROVIDERS: &[&str] = &[
    "nvidia",
    "cerebras",
    "xai",
    "xai-oauth",
    "togetherai",
    "deepinfra",
    "groq",
    "openrouter",
    "alibaba",
    "alibaba-cn",
    "alibaba-coding-plan-cn",
    "alibaba-coding-plan",
    "alibaba-token-plan-cn",
    "alibaba-token-plan",
    "cloudflare-workers-ai",
    "fireworks-ai",
    "siliconflow",
    "vercel",
    "opencode",
    "opencode-go",
    "opencode-free",
    "anthropic",
    "claude-subscription",
    "openai",
    "openai-codex",
    "google",
    "deepseek",
    "moonshot",
    "moonshot-global",
    "kimi-coding-plan",
    "xiaomi-token-plan-cn",
    "xiaomi-token-plan-sgp",
    "xiaomi-token-plan-ams",
    "xiaomi",
    "zai",
    "zai-coding-plan",
    "minimax-coding-plan",
    "MiniMax",
    "MiniMax-cn",
    "ollama",
    "ollama-cloud",
    "lm-studio",
    "localai",
    "mistral",
    "cohere",
    "huggingface",
    "zenmux",
    "tencent-tokenhub",
    "tencent-coding-plan",
    "tencent-token-plan",
    "stepfun-ai-step-plan",
    "stepfun-step-plan",
    "stepfun-ai",
    "stepfun",
    "volcengine-ark",
    "volcengine-coding-plan",
    "volcengine-agent-plan",
];

/// A provider's mark, sized like the two-line row beside it: a named
/// brand's initial in a disc, or the generic Cpu glyph in it (see
/// [`BRANDED_PROVIDERS`]). It paints in palette roles (the chip fill and
/// ink), so it follows the theme; the name beside it identifies the
/// provider, not a hue.
pub(crate) fn provider_mark(provider_type: &str, cx: &App) -> gpui_kit::Div {
    if BRANDED_PROVIDERS.contains(&provider_type) {
        letter_mark(&mark_letter(provider_name(Locale::current(cx), provider_type)), cx)
    } else {
        generic_mark(cx)
    }
}

/// A connection's mark: its provider's. A brand's initial is its
/// accessible label; the generic glyph is decoration (the row names the
/// connection).
pub(crate) fn connection_mark(connection: &ConnectionEntry, cx: &App) -> impl IntoElement {
    let provider_type = connection.provider_type.as_str();
    let letter = BRANDED_PROVIDERS
        .contains(&provider_type)
        .then(|| mark_letter(provider_name(Locale::current(cx), provider_type)));
    provider_mark(provider_type, cx)
        .id(domain_element_id("connection-mark", &connection.id))
        .test_support()
        .when_some(letter, |this, letter| this.aria_label(letter))
}

/// The first letter or digit of `name`, in upper case.
fn mark_letter(name: &str) -> String {
    name.chars()
        .find(|c| c.is_alphanumeric())
        .map(|c| c.to_uppercase().collect())
        .unwrap_or_default()
}

/// The disc a mark sits in.
fn mark_disc(cx: &App) -> gpui_kit::Div {
    h_flex().size_8().flex_shrink_0().justify_center().rounded_full().bg(cx.maka().chip)
}

/// The disc with `letter`.
fn letter_mark(letter: &str, cx: &App) -> gpui_kit::Div {
    mark_disc(cx)
        .text_color(cx.maka().ink)
        .text_sm()
        .font_weight(FontWeight::SEMIBOLD)
        .child(letter.to_owned())
}

/// The disc with Desktop's `GenericProviderMark`: the Cpu glyph, 16 muted.
fn generic_mark(cx: &App) -> gpui_kit::Div {
    mark_disc(cx)
        .child(Icon::new(gpui_kit::assets::IconName::Cpu).size_4().text_color(cx.maka().ink_muted))
}

/// The name a row shows: the connection's, with its identifier when
/// another connection of the provider has the same name
/// (`connectionDisplayName`).
pub(crate) fn connection_display_name(
    connection: &ConnectionEntry,
    list: &ConnectionList,
) -> String {
    let ambiguous = list.connections.iter().any(|other| {
        other.id != connection.id
            && other.provider_type == connection.provider_type
            && other.name == connection.name
    });
    if ambiguous {
        format!("{} · {}", connection.name, connection.slug)
    } else {
        connection.name.to_string()
    }
}

/// The row's second line and the detail's subtitle: the provider, the
/// enabled model count past one, and the default model when this is the
/// default connection (`connectionSubtitle`).
pub(crate) fn connection_subtitle(
    connection: &ConnectionEntry,
    list: Option<&ConnectionList>,
    locale: Locale,
) -> String {
    let mut parts = vec![provider_name(locale, &connection.provider_type).to_owned()];
    if connection.models.len() > 1 {
        parts.push(settings_copy::model_count(locale, connection.models.len()));
    }
    if let Some(target) = list
        .and_then(|list| list.default_target.as_ref())
        .filter(|target| target.connection_id == connection.id.as_ref())
    {
        parts.push(target.model_id.clone());
    }
    parts.join(" · ")
}

/// A group heading (16/600) with its line and one action, as
/// [`crate::rows::SettingsGroup`] draws it, for the page's own levels.
fn heading(
    key: &'static str,
    title: &str,
    description: &str,
    action: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let maka = cx.maka();
    h_flex()
        .flex_1()
        .min_w_0()
        .items_start()
        .justify_between()
        .flex_wrap()
        .gap_3()
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap_0p5()
                .child(
                    div()
                        .id(domain_element_id("settings-group-title", key))
                        .test_support()
                        .role(Role::Heading)
                        .aria_label(SharedString::from(title.to_owned()))
                        .text_size(rems(HEADING_TEXT_REMS))
                        .line_height(rems(HEADING_LINE_REMS))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(maka.ink)
                        .child(SharedString::from(title.to_owned())),
                )
                .child(
                    div()
                        .text_xs()
                        .text_color(maka.ink_muted)
                        .child(SharedString::from(description.to_owned())),
                ),
        )
        .children(action)
        .into_any_element()
}

impl ConnectionsPane {
    /// A sub-page's header (Desktop's `SettingsRouteHeader`): the way
    /// back beside `heading`.
    fn render_route_header(
        &self,
        label: Text,
        heading: impl IntoElement,
        cx: &mut Context<Self>,
    ) -> impl IntoElement {
        route_header(
            Button::new("connections-back")
                .disabled(self.is_busy(cx))
                .on_click(cx.listener(|this, _, window, cx| this.back(window, cx))),
            label.get(cx),
            heading,
            cx,
        )
    }

    /// The All / Enabled / Disabled switch: the sidebar's segmented
    /// control, each segment a Tab stop with Enter or Space.
    fn render_filter(&self, cx: &mut Context<Self>) -> impl IntoElement {
        segmented_track(cx)
            .id("connections-filter")
            .test_support()
            .aria_label(settings_copy::CONNECTIONS_FILTER.get(cx))
            .flex_shrink_0()
            .children(ConnectionFilter::ALL.map(|filter| {
                let button = Button::new(domain_element_id("connections-filter", filter.key()));
                segment(button, filter.label().get(cx), self.filter == filter, cx)
                    .flex_none()
                    .px_3()
                    .on_click(cx.listener(move |this, _, _, cx| this.set_filter(filter, cx)))
            }))
    }

    fn render_list(&self, cx: &mut Context<Self>) -> AnyElement {
        let catalog = self.catalog.read(cx);
        let status = catalog.status().clone();
        let list = catalog.list().cloned();
        let total = list.as_ref().map_or(0, |list| list.connections.len());
        let connections = self.visible_connections(cx);
        let connected = self.host.read(cx).is_connected();
        let maka = cx.maka();
        let locale = Locale::current(cx);
        let add = control_button(Button::new("settings-add-connection").primary())
            .label(settings_copy::ADD_CONNECTION_TITLE.get(cx))
            .disabled(!connected)
            .on_click(cx.listener(|this, _, window, cx| this.show_catalog(window, cx)));
        let header = heading(
            "connections",
            settings_copy::SECTION_CONNECTIONS.get(cx),
            copy::CONNECTIONS_HELP.get(cx),
            Some(add.into_any_element()),
            cx,
        );
        let mut rows = Vec::with_capacity(connections.len() * 2);
        let len = connections.len();
        for (ix, connection) in connections.iter().enumerate() {
            if ix > 0 {
                rows.push(row_rule(cx));
            }
            rows.push(self.render_row(connection, list.as_ref(), ix, len, cx));
        }
        let read = list.is_some();
        let note = |child: AnyElement| {
            div()
                .id("connections-note")
                .test_support()
                .py_4()
                .text_sm()
                .text_color(maka.ink_muted)
                .child(child)
                .into_any_element()
        };
        let body: Option<AnyElement> = match (read, &status) {
            (false, ConnectionCatalogStatus::Failed(message)) => Some(note(
                v_flex()
                    .gap_2()
                    .items_start()
                    .child(div().text_color(maka.destructive).child(failure(
                        locale,
                        settings_copy::CONNECTIONS_LOAD_FAILED.in_locale(locale),
                        message,
                    )))
                    .child(
                        quiet_button(Button::new("connections-retry"), cx)
                            .label(settings_copy::RETRY.get(cx))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.catalog.update(cx, |catalog, cx| catalog.reload(cx));
                            })),
                    )
                    .into_any_element(),
            )),
            (false, _) => Some(note(
                h_flex()
                    .gap_2()
                    .child(Spinner::new().small())
                    .child(settings_copy::CONNECTIONS_LOADING.get(cx))
                    .into_any_element(),
            )),
            (true, _) if total == 0 => Some(self.render_empty(cx)),
            (true, _) if connections.is_empty() => Some(note(
                div().child(settings_copy::CONNECTIONS_NO_MATCH.get(cx)).into_any_element(),
            )),
            _ => None,
        };
        let tools = self.shows_list_tools(cx);
        v_flex()
            .id("connections-list")
            .test_support()
            .w_full()
            .gap_4()
            .children(self.render_notice(cx))
            .child(
                v_flex()
                    .w_full()
                    .gap_2()
                    .child(header)
                    .child(div().h_px().w_full().bg(maka.border_soft)),
            )
            .when(tools, |this| {
                this.child(
                    h_flex()
                        .gap_3()
                        .child(
                            div().flex_1().max_w(rems(20.)).child(
                                Input::new(&self.search)
                                    .field_fill(cx)
                                    .id("connections-search")
                                    .aria_label(settings_copy::CONNECTIONS_SEARCH.get(cx))
                                    .prefix(Icon::new(MakaIcon::Search).small())
                                    .cleanable(true),
                            ),
                        )
                        .child(div().ml_auto().child(self.render_filter(cx))),
                )
            })
            .children(body)
            .child(v_flex().w_full().children(rows))
            .when(read && total == 0, |this| {
                this.child(
                    self.providers.update(cx, |providers, cx| providers.render_shortlist(cx)),
                )
            })
            .into_any_element()
    }

    fn render_notice(&self, cx: &App) -> Option<AnyElement> {
        let notice = self.notice.clone()?;
        Some(
            div()
                .id("connections-notice")
                .test_support()
                .aria_label(notice.clone())
                .text_sm()
                .text_color(cx.maka().warning)
                .child(notice)
                .into_any_element(),
        )
    }

    /// The first run: no connections yet, and the way to the catalog.
    fn render_empty(&self, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        v_flex()
            .id("connections-empty")
            .test_support()
            .w_full()
            .items_center()
            .gap_2()
            .py_6()
            .child(Icon::new(gpui_kit::assets::IconName::Cpu).size_6().text_color(maka.ink_muted))
            .child(
                div()
                    .text_sm()
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(maka.ink)
                    .child(copy::EMPTY.get(cx)),
            )
            .child(div().text_xs().text_color(maka.ink_muted).child(copy::EMPTY_HELP.get(cx)))
            .child(
                quiet_button(Button::new("connections-browse-all"), cx)
                    .label(copy::BROWSE_ALL.get(cx))
                    .disabled(!self.host.read(cx).is_connected())
                    .on_click(cx.listener(|this, _, window, cx| this.show_catalog(window, cx))),
            )
            .into_any_element()
    }

    /// A list row: the provider's mark, the name with its Default badge,
    /// provider · models · default model, the status, and a chevron. A
    /// ghost Button, so it is a Tab stop that Enter or Space opens.
    fn render_row(
        &self,
        connection: &ConnectionEntry,
        list: Option<&ConnectionList>,
        ix: usize,
        len: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let id = connection.id.clone();
        let default = list.is_some_and(|list| list.is_default(&connection.id));
        let name = list.map_or_else(
            || connection.name.to_string(),
            |list| connection_display_name(connection, list),
        );
        let subtitle = connection_subtitle(connection, list, locale);
        let status = connection_status(connection);
        let provider = provider_name(locale, &connection.provider_type);
        let label = copy::row_label(
            locale,
            &name,
            provider,
            default,
            status.map(|(text, _)| text.in_locale(locale)),
        );
        let row = Button::new(domain_element_id("connection-row", &connection.id))
            .ghost()
            .w_full()
            .h_auto()
            .px_0()
            .py_2p5()
            .justify_start()
            .accessibility_label(label)
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_3()
                    .child(connection_mark(connection, cx))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .items_start()
                            .gap_0p5()
                            .child(
                                h_flex()
                                    .gap_2()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .truncate()
                                            .text_sm()
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(maka.ink)
                                            .child(name),
                                    )
                                    .when(default, |this| {
                                        this.child(badge(settings_copy::DEFAULT_BADGE.get(cx), cx))
                                    }),
                            )
                            .child(
                                div()
                                    .w_full()
                                    .truncate()
                                    .text_xs()
                                    .text_color(maka.ink_muted)
                                    .child(subtitle),
                            ),
                    )
                    .children(
                        status.map(|(text, tone)| {
                            status_badge(&connection.id, text.get(cx), tone, cx)
                        }),
                    )
                    .child(Icon::new(MakaIcon::ChevronRight).small().text_color(maka.ink_muted)),
            )
            .on_click(
                cx.listener(move |this, _, window, cx| this.show_detail(id.clone(), window, cx)),
            );
        list_row(row, ix, len).into_any_element()
    }

    fn render_catalog(&self, cx: &mut Context<Self>) -> AnyElement {
        v_flex()
            .w_full()
            .gap_5()
            .child(self.render_route_header(
                copy::BACK_TO_LIST,
                heading(
                    "add-connection",
                    settings_copy::ADD_CONNECTION_TITLE.get(cx),
                    copy::CATALOG_HELP.get(cx),
                    None,
                    cx,
                ),
                cx,
            ))
            .child(self.providers.clone())
            .into_any_element()
    }

    fn render_setup(
        &self,
        form: &Entity<AddConnectionForm>,
        from_catalog: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let provider = form.read(cx).provider();
        let name = provider_name(locale, provider.provider_type);
        let back = if from_catalog { copy::BACK_TO_CATALOG } else { copy::BACK_TO_LIST };
        v_flex()
            .w_full()
            .gap_5()
            .child(
                self.render_route_header(
                    back,
                    h_flex()
                        .w_full()
                        .items_center()
                        .gap_3()
                        .child(provider_mark(provider.provider_type, cx))
                        .child(heading(
                            "setup",
                            &copy::connect_title(locale, provider.provider_type, name),
                            copy::CREATE_SUBTITLE.get(cx),
                            None,
                            cx,
                        )),
                    cx,
                ),
            )
            .child(form.clone())
            .into_any_element()
    }
}

impl Render for ConnectionsPane {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let body = match &self.route {
            Route::List => self.render_list(cx),
            Route::Catalog => self.render_catalog(cx),
            Route::Setup { form, from_catalog, .. } => {
                let (form, from_catalog) = (form.clone(), *from_catalog);
                self.render_setup(&form, from_catalog, cx)
            }
            Route::Adopting { .. } => h_flex()
                .id("connections-adopting")
                .test_support()
                .gap_2()
                .text_sm()
                .text_color(cx.maka().ink_muted)
                .child(Spinner::new().small())
                .child(copy::CONNECTED_LOADING.get(cx))
                .into_any_element(),
            Route::Detail { detail, .. } => v_flex()
                .w_full()
                .gap_4()
                .children(self.render_notice(cx))
                .child(detail.clone())
                .into_any_element(),
        };
        div().id("connections-pane").test_support().w_full().child(body)
    }
}

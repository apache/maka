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

//! The provider catalog, after Maka Desktop's (provider-catalog-page.tsx):
//! one search field over every provider, and below it the providers in
//! Desktop's groups (推荐 / 订阅计划 / API / 聚合服务 / 本地), each a row
//! with its mark, name, and line of description. Typing collapses the
//! groups into one list. The recommended group also lists the account
//! sign-ins (OpenAI Codex, GitHub Copilot, xAI Grok), which this client
//! leaves to Maka Desktop: those rows come after the providers that work,
//! in the disabled ink with a "Needs Maka Desktop" badge, and open nothing.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::component::{Icon, Sizable as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, Role, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, TestSupportExt as _, Window, div,
    prelude::FluentBuilder as _, rems,
};
use host_protocol::{ProviderDefinition, ProviderGroup};
use shared::copy::models as copy;
use shared::copy::providers::{ACCOUNT_CARDS, provider_description, provider_name};
use shared::copy::{Locale, Text};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::{
    ActiveMakaPalette as _, HEADING_LINE_REMS, HEADING_TEXT_REMS, badge, quiet_button,
};
use workspace::ConnectionCatalog;

use crate::connections_pane::provider_mark;
use crate::rows::{filter_field, list_row, row_rule};

/// What the catalog reports to the pane that shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProviderCatalogEvent {
    /// A provider was chosen, by its `providerType`.
    Picked(&'static str),
}

/// A group of the catalog, in page order (`CATALOG_GROUPS`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Group {
    Recommended,
    Listed(ProviderGroup),
}

const GROUPS: [Group; 5] = [
    Group::Recommended,
    Group::Listed(ProviderGroup::Plans),
    Group::Listed(ProviderGroup::Api),
    Group::Listed(ProviderGroup::Aggregators),
    Group::Listed(ProviderGroup::Local),
];

impl Group {
    fn title(self) -> Text {
        match self {
            Self::Recommended => copy::GROUP_RECOMMENDED,
            Self::Listed(ProviderGroup::Plans) => copy::GROUP_PLANS,
            Self::Listed(ProviderGroup::Api) => copy::GROUP_API,
            Self::Listed(ProviderGroup::Aggregators) => copy::GROUP_AGGREGATORS,
            Self::Listed(_) => copy::GROUP_LOCAL,
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Recommended => "recommended",
            Self::Listed(ProviderGroup::Plans) => "plans",
            Self::Listed(ProviderGroup::Api) => "api",
            Self::Listed(ProviderGroup::Aggregators) => "aggregators",
            Self::Listed(_) => "local",
        }
    }

    fn providers(self) -> impl Iterator<Item = &'static ProviderDefinition> {
        ProviderDefinition::catalog().filter(move |provider| match self {
            Self::Recommended => provider.is_recommended(),
            Self::Listed(group) => provider.group == Some(group),
        })
    }
}

/// Behavior and presentation owner of the provider catalog. It lives with
/// the Models page, so a search typed before a provider was picked is
/// still there on the way back, as in Desktop.
///
/// Keyboard: Tab walks the search field and the provider rows (buttons:
/// Enter or Space picks one); the account rows are text, not Tab stops.
pub struct ProviderCatalog {
    catalog: Entity<ConnectionCatalog>,
    search: Entity<InputState>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ProviderCatalog {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderCatalog").finish_non_exhaustive()
    }
}

impl EventEmitter<ProviderCatalogEvent> for ProviderCatalog {}

impl ProviderCatalog {
    pub fn new(
        catalog: Entity<ConnectionCatalog>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::SEARCH_PROVIDERS.get(cx)));
        let subscriptions = vec![
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let placeholder = copy::SEARCH_PROVIDERS.get(cx);
                this.search
                    .update(cx, |search, cx| search.set_placeholder(placeholder, window, cx));
            }),
            cx.subscribe(&search, |_, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
            }),
            cx.observe(&catalog, |_, _, cx| cx.notify()),
        ];
        Self { catalog, search, _subscriptions: subscriptions }
    }

    /// Moves focus to the search field.
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.search.update(cx, |search, cx| search.focus(window, cx));
    }

    /// The search field.
    pub fn search(&self) -> &Entity<InputState> {
        &self.search
    }

    /// Types `query` into the search field.
    pub fn set_query(&mut self, query: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.search.update(cx, |search, cx| search.set_value(query.to_owned(), window, cx));
        cx.notify();
    }

    fn query(&self, cx: &App) -> String {
        self.search.read(cx).value().trim().to_lowercase()
    }

    /// Picks the provider `provider_type`, as a click on its row does.
    pub fn pick(&mut self, provider_type: &'static str, cx: &mut Context<Self>) {
        cx.emit(ProviderCatalogEvent::Picked(provider_type));
    }

    /// The providers the search finds, in catalog order (all of them for
    /// an empty search): by `providerType`, name, description, or the
    /// registry's label. An account sign-in is found as its account row
    /// instead.
    pub fn matching(&self, cx: &App) -> Vec<&'static ProviderDefinition> {
        let query = self.query(cx);
        let locale = Locale::current(cx);
        ProviderDefinition::catalog()
            .filter(|provider| !provider.is_account())
            .filter(|provider| {
                query.is_empty()
                    || [
                        provider.provider_type,
                        provider_name(locale, provider.provider_type),
                        provider_description(locale, provider.provider_type),
                        provider.label,
                    ]
                    .iter()
                    .any(|text| text.to_lowercase().contains(&query))
            })
            .collect()
    }

    /// The account sign-ins the search finds, with how many connections
    /// each already has.
    fn matching_accounts(&self, cx: &App) -> Vec<AccountCard> {
        let query = self.query(cx);
        let catalog = self.catalog.read(cx);
        ACCOUNT_CARDS
            .iter()
            .map(|(provider_type, name)| {
                let count = catalog.list().map_or(0, |list| {
                    list.connections
                        .iter()
                        .filter(|connection| connection.provider_type == *provider_type)
                        .count()
                });
                AccountCard { provider_type, name, count }
            })
            .filter(|card| {
                let description = card.description(Locale::current(cx));
                query.is_empty()
                    || [card.provider_type, card.name, description.as_str()]
                        .iter()
                        .any(|text| text.to_lowercase().contains(&query))
            })
            .collect()
    }

    /// The recommended group alone, under its own heading and without the
    /// search: what the empty connection list offers.
    pub(crate) fn render_shortlist(&self, cx: &mut Context<Self>) -> AnyElement {
        let accounts = self.matching_accounts(cx);
        let providers: Vec<_> = Group::Recommended.providers().collect();
        self.render_rows(
            "shortlist",
            Some(copy::RECOMMENDED_PROVIDERS.get(cx)),
            &accounts,
            &providers,
            cx,
        )
    }

    fn render_rows(
        &self,
        key: &str,
        title: Option<&'static str>,
        accounts: &[AccountCard],
        providers: &[&'static ProviderDefinition],
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maka = cx.maka();
        let mut rows: Vec<AnyElement> = Vec::new();
        let len = providers.len() + accounts.len();
        // What works first; the sign-ins this client cannot add last.
        for (ix, provider) in providers.iter().enumerate() {
            if ix > 0 {
                rows.push(row_rule(cx));
            }
            rows.push(self.render_provider(provider, ix, len, cx));
        }
        for card in accounts {
            if !rows.is_empty() {
                rows.push(row_rule(cx));
            }
            rows.push(card.render(cx));
        }
        v_flex()
            .id(domain_element_id("provider-group", key))
            .test_support()
            .role(Role::List)
            .w_full()
            .gap_2()
            .when_some(title, |this, title| {
                this.aria_label(title).child(
                    div()
                        .id(domain_element_id("provider-group-title", key))
                        .test_support()
                        .role(Role::Heading)
                        .aria_label(title)
                        .text_size(rems(HEADING_TEXT_REMS))
                        .line_height(rems(HEADING_LINE_REMS))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(maka.ink)
                        .child(title),
                )
            })
            .child(v_flex().w_full().children(rows))
            .into_any_element()
    }

    fn render_provider(
        &self,
        provider: &'static ProviderDefinition,
        ix: usize,
        len: usize,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let name = provider_name(locale, provider.provider_type);
        let description = provider_description(locale, provider.provider_type);
        let provider_type = provider.provider_type;
        let row = Button::new(domain_element_id("provider-row", provider_type))
            .ghost()
            .w_full()
            // One geometry for every catalog row, 56 tall, whatever its end
            // holds (review round 12).
            .h(rems(3.5))
            .px_0()
            .justify_start()
            .accessibility_label(format!("{name}, {description}"))
            .child(
                h_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_3()
                    .child(provider_mark(provider_type, cx))
                    .child(two_lines(name, description, Ink::Live, cx))
                    .child(
                        Icon::new(MakaIcon::ChevronRight).small().text_color(cx.maka().ink_muted),
                    ),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.pick(provider_type, cx)));
        list_row(row, ix, len).into_any_element()
    }
}

/// An account sign-in the catalog lists.
struct AccountCard {
    provider_type: &'static str,
    name: &'static str,
    count: usize,
}

impl AccountCard {
    /// Desktop's line: what the account adds, or how many connections it
    /// already has.
    fn description(&self, locale: Locale) -> String {
        if self.count > 0 {
            return copy::accounts_configured(locale, self.count);
        }
        let text = match self.provider_type {
            "openai-codex" => copy::CODEX_DESCRIPTION,
            "github-copilot" => copy::COPILOT_DESCRIPTION,
            _ => copy::XAI_DESCRIPTION,
        };
        text.in_locale(locale).to_owned()
    }

    /// Its mark, name, and line in the disabled ink, then the "Needs Maka
    /// Desktop" badge where a provider row has its chevron, faded with the
    /// row as the mark is (a disabled row fades whole on Desktop). It is
    /// text, not a control: no hover, no Tab stop.
    fn render(&self, cx: &App) -> AnyElement {
        let locale = Locale::current(cx);
        let description = self.description(locale);
        let needs = copy::ACCOUNT_NEEDS_DESKTOP.get(cx);
        h_flex()
            .id(domain_element_id("account-row", self.provider_type))
            .test_support()
            .role(Role::ListItem)
            .aria_label(format!("{}, {description}, {needs}", self.name))
            .w_full()
            // A provider row's 56: the badge adds no height.
            .h(rems(3.5))
            .gap_3()
            .child(div().opacity(0.5).child(provider_mark(self.provider_type, cx)))
            .child(two_lines(self.name, &description, Ink::Disabled, cx))
            .child(
                div()
                    .id(domain_element_id("account-note", self.provider_type))
                    .test_support()
                    .aria_label(needs)
                    .opacity(0.5)
                    .child(badge(needs, cx)),
            )
            .into_any_element()
    }
}

/// Which ink a row's text takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Ink {
    Live,
    Disabled,
}

/// A name (14/500) over its line (12 muted), each on one line; both in the
/// disabled ink for a row that cannot be picked.
fn two_lines(name: &str, line: &str, ink: Ink, cx: &App) -> impl IntoElement {
    let maka = cx.maka();
    let (title, muted) = match ink {
        Ink::Live => (maka.ink, maka.ink_muted),
        Ink::Disabled => (maka.ink_disabled, maka.ink_disabled),
    };
    v_flex()
        .flex_1()
        .min_w_0()
        .items_start()
        .gap_0p5()
        .child(
            div()
                .w_full()
                .truncate()
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .text_color(title)
                .child(SharedString::from(name.to_owned())),
        )
        .child(
            div()
                .w_full()
                .truncate()
                .text_xs()
                .text_color(muted)
                .child(SharedString::from(line.to_owned())),
        )
}

impl Render for ProviderCatalog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let searching = !self.query(cx).is_empty();
        let search =
            filter_field(&self.search, "provider-search", copy::SEARCH_PROVIDERS.get(cx), cx);
        let body = if searching {
            let accounts = self.matching_accounts(cx);
            let providers = self.matching(cx);
            if accounts.is_empty() && providers.is_empty() {
                v_flex()
                    .id("provider-no-match")
                    .test_support()
                    .items_start()
                    .gap_2()
                    .py_4()
                    .child(
                        div()
                            .text_sm()
                            .text_color(cx.maka().ink_muted)
                            .child(copy::NO_MATCHING_PROVIDERS.get(cx)),
                    )
                    .child(
                        quiet_button(Button::new("provider-clear-search"), cx)
                            .label(copy::CLEAR_SEARCH.get(cx))
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.set_query("", window, cx);
                            })),
                    )
                    .into_any_element()
            } else {
                self.render_rows("results", None, &accounts, &providers, cx)
            }
        } else {
            let accounts = self.matching_accounts(cx);
            let groups: Vec<AnyElement> = GROUPS
                .iter()
                .filter_map(|group| {
                    let providers: Vec<_> = group.providers().collect();
                    let accounts: &[AccountCard] =
                        if *group == Group::Recommended { &accounts } else { &[] };
                    (!providers.is_empty() || !accounts.is_empty()).then(|| {
                        self.render_rows(
                            group.key(),
                            Some(group.title().get(cx)),
                            accounts,
                            &providers,
                            cx,
                        )
                    })
                })
                .collect();
            v_flex().w_full().gap_8().children(groups).into_any_element()
        };
        v_flex()
            .id("provider-catalog")
            .test_support()
            .w_full()
            .gap_4()
            .child(div().w_full().child(search))
            .child(body)
    }
}

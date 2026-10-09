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

//! The Daily Review page, after Maka Desktop's
//! (apps/desktop/src/renderer/settings/daily-review-settings-page.tsx):
//! whether the Host analyzes the previous day on a schedule, at which local
//! time, and with which model. It reads the Host's settings with
//! `daily-review.query` (`config`) and writes a change with
//! `daily-review.mutate` (`update_config`) the way Desktop's preload does
//! (`updateDailyReviewConfig`): the settings read again, the change laid on
//! them, sent at their revision, up to three times.

use gpui_kit::component::input::InputEvent;
use gpui_kit::component::select::{SearchableVec, Select, SelectEvent, SelectState};
use gpui_kit::component::v_flex;
use gpui_kit::{
    App, AppContext as _, Context, Entity, IntoElement, ParentElement as _, Render, SharedString,
    Styled as _, Subscription, Task, Window, div, prelude::FluentBuilder as _, rems,
};
use host_protocol::{
    DailyReviewConfig, DailyReviewMutate, DailyReviewMutateInput, DailyReviewMutateResult,
    DailyReviewQuery, DailyReviewQueryInput, DailyReviewQueryResult,
};
use shared::copy::automations::TIME_PLACEHOLDER;
use shared::copy::providers::provider_name;
use shared::copy::settings as settings_copy;
use shared::copy::system as copy;
use shared::copy::{Locale, Text, failure};
use workspace::{ConnectionCatalog, ConnectionList, HostRequester, HostSession, HostSessionEvent};

use crate::policy::host_error_reason;
use crate::rows::{
    Choice, SettingsGroup, SettingsRow, StatusLine, TextSetting, TextSettingEvent, settings_button,
};

/// How often a change is laid on freshly read settings before it gives up
/// (Desktop's three attempts).
const SAVE_ATTEMPTS: usize = 3;

/// The run time field's width: Desktop's 110px.
const TIME_FIELD_WIDTH_REMS: f32 = 6.875;

/// The separator of a model key, `connectionSlug::modelId`.
const MODEL_KEY_SEPARATOR: &str = "::";

/// The page's status line and every row's key prefix.
const PAGE_KEY: &str = "daily-review";

/// Which setting a change is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Field {
    Enabled,
    Time,
    Model,
}

impl Field {
    fn key(self) -> &'static str {
        match self {
            Self::Enabled => "daily-review-enabled",
            Self::Time => "daily-review-time",
            Self::Model => "daily-review-model",
        }
    }
}

/// Where reading the settings stands. Settings read once stay while they
/// are read again.
#[derive(Debug, Clone, PartialEq)]
enum ReviewState {
    Idle,
    Loading,
    Loaded { revision: u64, config: DailyReviewConfig },
    Failed(SharedString),
}

type ModelSelect = SelectState<SearchableVec<Choice<String>>>;

/// Behavior owner of the Host's Daily Review settings for the page: reads
/// them when the page is shown (and again on a new connection while it
/// has been), and sends one change at a time. The settings read stay while
/// they are read again; a refusal keeps them and says why for the row the
/// change came from.
pub struct DailyReviewSettings {
    host: Entity<HostSession>,
    state: ReviewState,
    saving: Option<Field>,
    error: Option<(Field, SharedString)>,
    /// Whether the page has been shown: it reads the Host only then.
    active: bool,
    _load: Option<Task<()>>,
    _save: Option<Task<()>>,
    _subscription: Subscription,
}

impl std::fmt::Debug for DailyReviewSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DailyReviewSettings")
            .field("state", &self.state)
            .field("saving", &self.saving)
            .finish_non_exhaustive()
    }
}

impl DailyReviewSettings {
    pub fn new(host: Entity<HostSession>, cx: &mut Context<Self>) -> Self {
        let subscription = cx.subscribe(&host, |this, _, event: &HostSessionEvent, cx| {
            if matches!(event, HostSessionEvent::Connected { .. }) && this.active {
                this.reload(cx);
            }
        });
        Self {
            host,
            state: ReviewState::Idle,
            saving: None,
            error: None,
            active: false,
            _load: None,
            _save: None,
            _subscription: subscription,
        }
    }

    /// The page is shown: reads the settings.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.active = true;
        self.reload(cx);
    }

    /// The Host's settings as last read.
    pub fn config(&self) -> Option<&DailyReviewConfig> {
        match &self.state {
            ReviewState::Loaded { config, .. } => Some(config),
            _ => None,
        }
    }

    /// Whether a change it sent is unanswered.
    pub fn is_busy(&self) -> bool {
        self.saving.is_some()
    }

    /// Whether the first read is in flight.
    fn is_loading(&self) -> bool {
        matches!(self.state, ReviewState::Idle | ReviewState::Loading)
    }

    fn requester(&self, cx: &App) -> HostRequester {
        self.host.read(cx).requester()
    }

    /// Reads the settings, unless there is no connection or a change is in
    /// flight.
    pub fn reload(&mut self, cx: &mut Context<Self>) {
        if !self.host.read(cx).is_connected() || self.saving.is_some() {
            return;
        }
        if !matches!(self.state, ReviewState::Loaded { .. }) {
            self.state = ReviewState::Loading;
        }
        let request =
            self.requester(cx).request::<DailyReviewQuery>(&DailyReviewQueryInput::Config);
        let locale = Locale::current(cx);
        self._load = Some(cx.spawn(async move |this, cx| {
            let result = request.await;
            this.update(cx, |this, cx| {
                this._load = None;
                match result {
                    Ok(DailyReviewQueryResult::Config { revision, config }) => {
                        this.state = ReviewState::Loaded { revision, config };
                    }
                    other => {
                        let reason = match other {
                            Err(error) => {
                                log::warn!("daily-review.query config failed: {error}");
                                host_error_reason(&error, locale)
                            }
                            Ok(_) => settings_copy::UNEXPECTED.in_locale(locale).to_owned(),
                        };
                        if !matches!(this.state, ReviewState::Loaded { .. }) {
                            this.state = ReviewState::Failed(reason.into());
                        }
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    /// Lays `change` on the settings as the Host has them and sends it,
    /// unless another change is in flight or the settings are unread.
    fn save(
        &mut self,
        field: Field,
        change: impl Fn(&mut DailyReviewConfig) + 'static,
        cx: &mut Context<Self>,
    ) {
        if self.saving.is_some() || self.config().is_none() || !self.host.read(cx).is_connected() {
            return;
        }
        let requester = self.requester(cx);
        let locale = Locale::current(cx);
        self.saving = Some(field);
        self.error = None;
        self._save = Some(cx.spawn(async move |this, cx| {
            let result = save_config(&requester, &change, locale).await;
            this.update(cx, |this, cx| {
                this._save = None;
                this.saving = None;
                match result {
                    Ok((revision, config)) => {
                        this.state = ReviewState::Loaded { revision, config };
                    }
                    Err(reason) => {
                        let what = copy::REVIEW_SAVE_FAILED.in_locale(locale);
                        this.error = Some((field, failure(locale, what, &reason).into()));
                    }
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }
}

/// Behavior and presentation owner of the Daily Review page.
///
/// A switch or the model saves as soon as it changes, the run time when
/// the field is left or Enter is pressed and it reads as a 24-hour time
/// (else the row says so and nothing is sent). The controls keep the
/// Host's value until the Host answers, as in Desktop; one change runs at
/// a time, and while it does the controls wait. A refusal puts the Host's
/// value back and says why under the row.
pub struct DailyReviewPage {
    host: Entity<HostSession>,
    connections: Entity<ConnectionCatalog>,
    settings: Entity<DailyReviewSettings>,
    time: Entity<TextSetting>,
    /// The run time last committed does not read as `HH:mm`.
    time_invalid: bool,
    model: Entity<ModelSelect>,
    /// What the controls were last given, so an unrelated change leaves an
    /// open dropdown alone.
    synced: Option<(Option<DailyReviewConfig>, Vec<Choice<String>>)>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for DailyReviewPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DailyReviewPage").finish_non_exhaustive()
    }
}

impl DailyReviewPage {
    pub fn new(
        host: Entity<HostSession>,
        connections: Entity<ConnectionCatalog>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let settings = cx.new(|cx| DailyReviewSettings::new(host.clone(), cx));
        let time = cx.new(|cx| {
            let mut field = TextSetting::new(copy::REVIEW_TIME, "", window, cx);
            field.set_placeholder(TIME_PLACEHOLDER.get(cx), window, cx);
            field
        });
        let model = cx.new(|cx| {
            SelectState::new(SearchableVec::new(Vec::new()), None, window, cx).searchable(true)
        });
        let time_input = time.read(cx).input().clone();
        let subscriptions = vec![
            cx.subscribe_in(&time, window, |this, _, event: &TextSettingEvent, window, cx| {
                let TextSettingEvent::Committed(value) = event;
                this.commit_time(value.clone(), window, cx);
            }),
            cx.subscribe(&time_input, |this, _, event: &InputEvent, cx| {
                if matches!(event, InputEvent::Change) && this.time_invalid {
                    this.time_invalid = false;
                    cx.notify();
                }
            }),
            cx.subscribe_in(
                &model,
                window,
                |this, _, event: &SelectEvent<SearchableVec<Choice<String>>>, window, cx| {
                    if let SelectEvent::Confirm(Some(key)) = event {
                        this.choose_model(key.clone(), window, cx);
                    }
                },
            ),
            cx.observe_in(&settings, window, |this, _, window, cx| {
                this.sync_controls(window, cx);
                this.sync_editable(cx);
                cx.notify();
            }),
            cx.observe_in(&connections, window, |this, _, window, cx| {
                this.sync_controls(window, cx);
                cx.notify();
            }),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                this.sync_controls(window, cx);
            }),
            cx.observe(&host, |this, _, cx| {
                this.sync_editable(cx);
                cx.notify();
            }),
        ];
        Self {
            host,
            connections,
            settings,
            time,
            time_invalid: false,
            model,
            synced: None,
            _subscriptions: subscriptions,
        }
    }

    /// The page is shown: reads the Host's settings.
    pub fn activate(&mut self, cx: &mut Context<Self>) {
        self.settings.update(cx, |settings, cx| settings.activate(cx));
    }

    pub fn settings(&self) -> &Entity<DailyReviewSettings> {
        &self.settings
    }

    /// The run time field.
    #[cfg(test)]
    pub(crate) fn time_field(&self) -> &Entity<TextSetting> {
        &self.time
    }

    /// The model dropdown's choices, by value and label.
    #[cfg(test)]
    pub(crate) fn choices(&self, _: &App) -> Vec<(String, String)> {
        use gpui_kit::component::select::SelectItem as _;
        let choices = self.synced.iter().flat_map(|(_, choices)| choices);
        choices.map(|choice| (choice.value().clone(), choice.title().to_string())).collect()
    }

    /// Whether a change it sent is unanswered.
    pub fn is_busy(&self, cx: &App) -> bool {
        self.settings.read(cx).is_busy()
    }

    fn config(&self, cx: &App) -> Option<DailyReviewConfig> {
        self.settings.read(cx).config().cloned()
    }

    fn set_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.config(cx).is_some_and(|config| config.enabled != enabled) {
            self.settings.update(cx, |settings, cx| {
                settings.save(Field::Enabled, move |config| config.enabled = enabled, cx)
            });
        }
    }

    fn commit_time(&mut self, value: SharedString, window: &mut Window, cx: &mut Context<Self>) {
        let value = value.trim().to_owned();
        if !is_execute_time(&value) {
            self.time_invalid = true;
            cx.notify();
            return;
        }
        self.time_invalid = false;
        if self.config(cx).is_some_and(|config| config.execute_time != value) {
            self.settings.update(cx, |settings, cx| {
                settings.save(Field::Time, move |config| config.execute_time = value.clone(), cx)
            });
        } else {
            self.synced = None;
            self.sync_controls(window, cx);
        }
        cx.notify();
    }

    fn choose_model(&mut self, key: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.config(cx).is_some_and(|config| config.model_key.trim() != key) {
            self.settings.update(cx, |settings, cx| {
                settings.save(Field::Model, move |config| config.model_key = key.clone(), cx)
            });
        } else {
            self.synced = None;
            self.sync_controls(window, cx);
        }
    }

    /// Puts the Host's values in the run time field and the model dropdown,
    /// and gives the dropdown the models the catalog offers now. A refused
    /// change puts the Host's value back too.
    fn sync_controls(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let config = self.config(cx);
        let locale = Locale::current(cx);
        let current = config.as_ref().map_or("", |config| config.model_key.as_str());
        let choices = model_choices(self.connections.read(cx).list(), current, locale);
        let synced = (config.clone(), choices.clone());
        let refused = self.settings.read(cx).error.is_some();
        if !refused && self.synced.as_ref() == Some(&synced) {
            return;
        }
        if let Some(config) = &config {
            let time = config.execute_time.clone();
            if refused {
                self.time.update(cx, |field, cx| field.reset(time, window, cx));
            } else {
                self.time.update(cx, |field, cx| field.set_committed(time, window, cx));
            }
        }
        let selected = current.trim().to_owned();
        self.model.update(cx, |select, cx| {
            select.set_items(SearchableVec::new(choices), window, cx);
            select.set_selected_value(&selected, window, cx);
        });
        self.synced = Some(synced);
    }

    /// Whether the controls take a change now: connected, and no change in
    /// flight.
    fn editable(&self, cx: &App) -> bool {
        self.host.read(cx).is_connected() && !self.settings.read(cx).is_busy()
    }

    fn sync_editable(&mut self, cx: &mut Context<Self>) {
        let editable = self.editable(cx);
        self.time.update(cx, |field, cx| field.set_disabled(!editable, cx));
    }

    fn status(&self, field: Field, cx: &App) -> Option<StatusLine> {
        self.settings
            .read(cx)
            .error
            .as_ref()
            .filter(|(failed, _)| *failed == field)
            .map(|(_, message)| StatusLine::error(field.key(), message.clone()))
    }

    /// Why the rows cannot show or change: offline, or the settings unread.
    fn page_status(&self, cx: &mut Context<Self>) -> Option<StatusLine> {
        if !self.host.read(cx).is_connected() {
            return Some(StatusLine::info(PAGE_KEY, copy::REVIEW_OFFLINE.get(cx)));
        }
        let ReviewState::Failed(message) = &self.settings.read(cx).state else {
            return None;
        };
        let reason = failure(Locale::current(cx), copy::REVIEW_LOAD_FAILED.get(cx), message);
        let retry = settings_button("daily-review-retry", settings_copy::RETRY.get(cx), cx)
            .on_click(cx.listener(|this, _, _, cx| {
                this.settings.update(cx, |settings, cx| settings.reload(cx));
            }));
        Some(StatusLine::error(PAGE_KEY, reason).action(retry))
    }
}

/// The model dropdown's choices, as Desktop's `buildDailyReviewModelOptions`:
/// "Follow task default" first, then every enabled model each enabled
/// connection can hold a chat on, by its name (with the provider after it
/// when two connections offer a model of the same name), and last the saved
/// model when no connection offers it any more, marked unavailable.
fn model_choices(
    connections: Option<&ConnectionList>,
    current: &str,
    locale: Locale,
) -> Vec<Choice<String>> {
    let mut candidates: Vec<(String, String, String)> = Vec::new();
    let offering: Vec<_> = connections
        .map(|list| list.enabled().filter(|connection| !connection.provider_type.is_empty()))
        .into_iter()
        .flatten()
        .collect();
    for connection in &offering {
        let same_provider =
            offering.iter().filter(|other| other.provider_type == connection.provider_type).count();
        let provider = provider_name(locale, &connection.provider_type);
        let source = if same_provider > 1 {
            format!("{provider} · {}", connection.slug)
        } else {
            provider.to_owned()
        };
        for entry in &connection.catalog_entries {
            let enabled = connection.models.iter().any(|model| model.id == entry.id.as_str());
            if !entry.can_use_as_chat_default || !enabled {
                continue;
            }
            let key = format!("{}{MODEL_KEY_SEPARATOR}{}", connection.slug, entry.id);
            if candidates.iter().any(|(existing, _, _)| *existing == key) {
                continue;
            }
            let label =
                entry.display_name.as_deref().map(str::trim).filter(|name| !name.is_empty());
            candidates.push((key, label.unwrap_or(&entry.id).to_owned(), source.clone()));
        }
    }
    let mut choices =
        vec![Choice::new(String::new(), copy::REVIEW_MODEL_DEFAULT.in_locale(locale))];
    for (key, label, source) in &candidates {
        let twins = candidates.iter().filter(|(_, other, _)| other == label).count();
        let label = if twins > 1 { format!("{label} · {source}") } else { label.clone() };
        choices.push(Choice::new(key.clone(), label));
    }
    let current = current.trim();
    if !current.is_empty() && !candidates.iter().any(|(key, _, _)| key == current) {
        let (slug, model) = match current.split_once(MODEL_KEY_SEPARATOR) {
            Some((slug, model)) if !slug.is_empty() && !model.is_empty() => (Some(slug), model),
            _ => (None, current.rsplit(MODEL_KEY_SEPARATOR).next().unwrap_or(current)),
        };
        let source = slug.map(|slug| format!(" · {slug}")).unwrap_or_default();
        let unavailable = copy::REVIEW_MODEL_UNAVAILABLE.in_locale(locale);
        choices.push(Choice::new(current.to_owned(), format!("{model}{source} · {unavailable}")));
    }
    choices
}

/// Whether `value` is a 24-hour `HH:mm` time (`isDailyReviewExecuteTime`).
fn is_execute_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' || !value.is_char_boundary(2) {
        return false;
    }
    let (Ok(hours), Ok(minutes)) = (value[..2].parse::<u8>(), value[3..].parse::<u8>()) else {
        return false;
    };
    bytes.iter().enumerate().all(|(ix, byte)| ix == 2 || byte.is_ascii_digit())
        && hours < 24
        && minutes < 60
}

/// Reads the settings, lays `change` on them, and sends them at their
/// revision; after a conflict, reads them again, up to [`SAVE_ATTEMPTS`]
/// times. The settings as the Host now has them, or the reason in `locale`.
async fn save_config(
    requester: &HostRequester,
    change: &dyn Fn(&mut DailyReviewConfig),
    locale: Locale,
) -> Result<(u64, DailyReviewConfig), String> {
    let reason = |error: workspace::HostRequestError| {
        log::warn!("daily-review config update failed: {error}");
        host_error_reason(&error, locale)
    };
    let unexpected = || settings_copy::UNEXPECTED.in_locale(locale).to_owned();
    for _ in 0..SAVE_ATTEMPTS {
        let read = requester
            .request::<DailyReviewQuery>(&DailyReviewQueryInput::Config)
            .await
            .map_err(reason)?;
        let DailyReviewQueryResult::Config { revision, mut config } = read else {
            return Err(unexpected());
        };
        change(&mut config);
        let input = DailyReviewMutateInput::UpdateConfig { expected_revision: revision, config };
        match requester.request::<DailyReviewMutate>(&input).await.map_err(reason)? {
            DailyReviewMutateResult::ConfigCommitted { revision, config }
            | DailyReviewMutateResult::ConfigUnchanged { revision, config } => {
                return Ok((revision, config));
            }
            DailyReviewMutateResult::RevisionConflict { .. } => continue,
            _ => return Err(unexpected()),
        }
    }
    Err(copy::REVIEW_KEPT_CHANGING.in_locale(locale).to_owned())
}

impl Render for DailyReviewPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let connected = self.host.read(cx).is_connected();
        let config = self.config(cx);
        let editable = self.editable(cx);
        let loading = connected && self.settings.read(cx).is_loading();
        let (enabled, time, model) = match &config {
            Some(config) => {
                let this = cx.weak_entity();
                let enabled = SettingsRow::toggle(
                    Field::Enabled.key(),
                    copy::REVIEW_ENABLED.get(cx),
                    config.enabled,
                    !editable,
                    move |on, _, cx| {
                        this.update(cx, |this, cx| this.set_enabled(*on, cx)).ok();
                    },
                )
                .detail(copy::REVIEW_ENABLED_HELP.get(cx))
                .status(self.status(Field::Enabled, cx));
                let time_status = if self.time_invalid {
                    Some(StatusLine::error(Field::Time.key(), copy::REVIEW_TIME_INVALID.get(cx)))
                } else {
                    self.status(Field::Time, cx)
                };
                let time = SettingsRow::new(Field::Time.key(), copy::REVIEW_TIME.get(cx))
                    .detail(copy::REVIEW_TIME_HELP.get(cx))
                    .end(div().w(rems(TIME_FIELD_WIDTH_REMS)).child(self.time.clone()))
                    .status(time_status);
                let select = Select::new(&self.model)
                    .search_placeholder(settings_copy::SETTINGS_SEARCH.get(cx))
                    .disabled(!editable);
                let model =
                    SettingsRow::select(Field::Model.key(), copy::REVIEW_MODEL.get(cx), select)
                        .detail(copy::REVIEW_MODEL_HELP.get(cx))
                        .status(self.status(Field::Model, cx));
                (Some(enabled), Some(time), Some(model))
            }
            None if loading => {
                let placeholder = |field: Field, title: Text, help: Text, width, cx: &App| {
                    SettingsRow::loading(field.key(), title.get(cx), width, cx).detail(help.get(cx))
                };
                (
                    Some(placeholder(
                        Field::Enabled,
                        copy::REVIEW_ENABLED,
                        copy::REVIEW_ENABLED_HELP,
                        2.5,
                        cx,
                    )),
                    Some(placeholder(
                        Field::Time,
                        copy::REVIEW_TIME,
                        copy::REVIEW_TIME_HELP,
                        TIME_FIELD_WIDTH_REMS,
                        cx,
                    )),
                    Some(placeholder(
                        Field::Model,
                        copy::REVIEW_MODEL,
                        copy::REVIEW_MODEL_HELP,
                        10.,
                        cx,
                    )),
                )
            }
            None => (None, None, None),
        };
        let shown = enabled.is_some();
        v_flex().w_full().gap_8().children(self.page_status(cx)).when(shown, |this| {
            this.child(
                SettingsGroup::new("daily-review-schedule")
                    .title(copy::REVIEW_SCHEDULE.get(cx))
                    .description(copy::REVIEW_SCHEDULE_HELP.get(cx))
                    .children(enabled)
                    .children(time),
            )
            .child(
                SettingsGroup::new("daily-review-analysis")
                    .title(copy::REVIEW_ANALYSIS.get(cx))
                    .description(copy::REVIEW_ANALYSIS_HELP.get(cx))
                    .children(model),
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_time_is_a_24_hour_time() {
        for good in ["00:00", "08:00", "23:59", "12:30"] {
            assert!(is_execute_time(good), "{good}");
        }
        for bad in ["24:00", "8:00", "08:60", "08-00", "0800", "", "08:00 ", "ab:cd", "０8:00"] {
            assert!(!is_execute_time(bad), "{bad}");
        }
    }
}

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

//! The Subagents page, after Maka Desktop's (subagent-settings-page.tsx,
//! subagent-preset-presentation.ts): the approved model routes the main
//! agent may delegate to, in two levels on one page, the list and a
//! preset's editor (new or existing), with one way back.
//!
//! The presets are the Host's runtime policy (`subagents`), written whole
//! with `set_subagents` as Desktop writes them. The Host's normalizer drops
//! a preset it cannot accept rather than refusing the write, so the editor
//! holds every field inside the Host's limits, and after a save the page
//! reads the policy again to be sure the preset is there (Desktop's
//! `expectPresent`).

use std::collections::HashSet;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::select::{Select, SelectEvent, SelectItem, SelectState};
use gpui_kit::component::switch::Switch;
use gpui_kit::component::{Disableable as _, Icon, Sizable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, Focusable as _, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, Task, TestSupportExt as _, Window, div, rems,
};
use host_protocol::{
    ProviderDefinition, RuntimePolicyMutation, RuntimePolicyQuery, RuntimePolicyQueryInput,
    SubagentPreset, SubagentProfile, SubagentSettings, ThinkingLevel,
};
use shared::copy::subagents as copy;
use shared::copy::{Locale, Text};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::icons::MakaIcon;
use shared::theme::FadedSwitch;
use shared::theme::FieldFill as _;
use shared::theme::{
    ActiveMakaPalette as _, HEADING_LINE_REMS, HEADING_TEXT_REMS, control_button, floating_surface,
    quiet_button, route_header, row_icon_button,
};
use workspace::{ConnectionCatalog, ConnectionEntry, HostSession};

use crate::page_kit::{Tone, empty_state, policy_status, status_dot, titled, warning_line};
use crate::policy::HostPolicy;
use crate::rows::{
    ActionRow, Choice, ChoiceSelect, FieldBlock, SettingsGroup, SettingsRow, StatusLine,
    destructive_button, sync_choices,
};

/// At most this many presets (`MAX_SUBAGENT_PRESETS`).
pub const MAX_SUBAGENT_PRESETS: usize = 64;
/// The id's longest length (`SUBAGENT_PRESET_ID_MAX_CHARS`).
pub const SUBAGENT_ID_MAX_CHARS: usize = 128;
/// The name's longest length once trimmed (`SUBAGENT_PRESET_NAME_MAX_CHARS`).
const NAME_MAX_CHARS: usize = 128;
/// The guidance's longest length once trimmed
/// (`SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS`).
const DESCRIPTION_MAX_CHARS: usize = 1_000;

/// The key of the page's own status line (offline, or the policy unread).
const PAGE_KEY: &str = "subagents";

/// Where the page is (Desktop's `SubagentPageRoute`): the list, a new
/// preset's editor, or an existing one's. An editor whose preset went away
/// shows as the list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubagentRoute {
    List,
    Create,
    Edit(String),
}

/// Whether the id is one the Host keeps (`isSafeSubagentPresetId`): 1 to
/// 128 characters of letters, digits, `.`, `_`, `:`, and `-`.
pub fn is_safe_subagent_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= SUBAGENT_ID_MAX_CHARS
        && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

/// The id a new preset takes from its name until the id is typed
/// (`suggestSubagentPresetId`): lowercase, runs of anything but ASCII
/// letters and digits as one `-`, at most 96 characters, `subagent` when
/// nothing is left, and a numeric suffix when taken. Desktop decomposes
/// accented letters first (NFKD), which this client does not: an accented
/// letter becomes a `-` here.
pub fn suggest_subagent_id(name: &str, existing: &HashSet<String>) -> String {
    let mut normalized = String::new();
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            normalized.push(c);
        } else if !normalized.ends_with('-') {
            normalized.push('-');
        }
    }
    let normalized: String = normalized.trim_matches('-').chars().take(96).collect();
    let base = if normalized.is_empty() { "subagent".to_owned() } else { normalized };
    if !existing.contains(&base) {
        return base;
    }
    (2..10_000)
        .map(|suffix| format!("{base}-{suffix}"))
        .find(|candidate| !existing.contains(candidate))
        .unwrap_or(base)
}

/// Whether the editor may route a preset through `connection`
/// (`isSelectableSubagentConnection`): enabled, and not a retired provider.
fn is_selectable(connection: &ConnectionEntry) -> bool {
    connection.enabled && !is_retired(connection)
}

fn is_retired(connection: &ConnectionEntry) -> bool {
    ProviderDefinition::find(&connection.provider_type).is_some_and(|p| p.is_retired())
}

/// The models a preset may run on (`offerableCatalogEntries`): the
/// connection's enabled models the Host allows a chat on, of a provider it
/// knows.
fn offerable_models(connection: &ConnectionEntry) -> Vec<&host_protocol::ModelCatalogEntry> {
    if !connection.enabled || ProviderDefinition::find(&connection.provider_type).is_none() {
        return Vec::new();
    }
    let enabled = connection.enabled_model_ids();
    connection
        .catalog_entries
        .iter()
        .filter(|entry| entry.can_use_as_chat_default && enabled.contains(&entry.id))
        .collect()
}

/// Why the main agent cannot take a preset's route, when it cannot
/// (`subagentPresetAvailability`); a disabled preset has no problem to
/// show, its switch says it.
fn problem(preset: &SubagentPreset, connections: &[ConnectionEntry]) -> Option<(Text, Tone)> {
    if !preset.enabled {
        return None;
    }
    let Some(connection) = connections.iter().find(|c| c.slug == preset.connection_slug) else {
        return Some((copy::MISSING_CONNECTION, Tone::Error));
    };
    if is_retired(connection) {
        return Some((copy::PROVIDER_RETIRED, Tone::Error));
    }
    if !connection.enabled {
        return Some((copy::CONNECTION_DISABLED, Tone::Attention));
    }
    if !connection.enabled_model_ids().contains(&preset.model) {
        return Some((copy::MODEL_DISABLED, Tone::Attention));
    }
    None
}

fn profile_label(profile: &SubagentProfile) -> (Text, Text) {
    match profile {
        SubagentProfile::WebResearch => {
            (copy::PROFILE_WEB_RESEARCH, copy::PROFILE_WEB_RESEARCH_HELP)
        }
        SubagentProfile::Implementation => {
            (copy::PROFILE_IMPLEMENTATION, copy::PROFILE_IMPLEMENTATION_HELP)
        }
        _ => (copy::PROFILE_LOCAL_READ, copy::PROFILE_LOCAL_READ_HELP),
    }
}

fn thinking_label(level: &ThinkingLevel) -> Text {
    match level {
        ThinkingLevel::Off => copy::THINKING_OFF,
        ThinkingLevel::Minimal => copy::THINKING_MINIMAL,
        ThinkingLevel::Low => copy::THINKING_LOW,
        ThinkingLevel::High => copy::THINKING_HIGH,
        ThinkingLevel::Xhigh => copy::THINKING_XHIGH,
        ThinkingLevel::Max => copy::THINKING_MAX,
        _ => copy::THINKING_MEDIUM,
    }
}

const PROFILES: [SubagentProfile; 3] =
    [SubagentProfile::LocalRead, SubagentProfile::WebResearch, SubagentProfile::Implementation];

fn profile_choices(locale: Locale) -> Vec<Choice<SubagentProfile>> {
    PROFILES.map(|p| Choice::new(p.clone(), profile_label(&p).0.in_locale(locale))).into()
}

/// A dropdown option that may be shown but not chosen: a connection the
/// preset cannot route through, or a model no longer enabled, each saying
/// why in its label.
#[derive(Debug, Clone, PartialEq)]
pub struct Offered {
    value: SharedString,
    label: SharedString,
    disabled: bool,
}

impl SelectItem for Offered {
    type Value = SharedString;

    fn title(&self) -> SharedString {
        self.label.clone()
    }

    fn value(&self) -> &SharedString {
        &self.value
    }

    fn disabled(&self) -> bool {
        self.disabled
    }
}

type OfferedSelect = SelectState<Vec<Offered>>;

/// The preset as the editor holds it: the route chosen so far.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Draft {
    profile: SubagentProfile,
    connection_slug: String,
    model: String,
    thinking_level: Option<ThinkingLevel>,
    enabled: bool,
}

/// Behavior and presentation owner of one preset's editor: its fields,
/// the route chosen, and whether Save was pressed (only then do the
/// fields say what is missing). It lives while the editor shows; the page
/// builds a new one for each preset it opens.
pub struct SubagentEditor {
    /// The preset being edited; `None` for a new one.
    preset: Option<SubagentPreset>,
    /// The other presets' ids, which a new id must not take.
    taken: HashSet<String>,
    connections: Entity<ConnectionCatalog>,
    name: Entity<InputState>,
    description: Entity<TextareaState>,
    id: Entity<InputState>,
    /// Once the id is typed it no longer follows the name.
    id_edited: bool,
    profile: Entity<ChoiceSelect<SubagentProfile>>,
    connection: Entity<OfferedSelect>,
    model: Entity<OfferedSelect>,
    thinking: Entity<ChoiceSelect<Option<ThinkingLevel>>>,
    draft: Draft,
    submitted: bool,
    saving: bool,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for SubagentEditor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SubagentEditor")
            .field("preset", &self.preset.as_ref().map(|p| &p.id))
            .field("draft", &self.draft)
            .finish_non_exhaustive()
    }
}

/// How many characters a value spends on leading whitespace the Host
/// trims (Desktop's `leadingSpace`), so a cap counts only what is kept.
fn leading_space(value: &str) -> usize {
    value.chars().count() - value.trim_start().chars().count()
}

/// `value` cut to `max` characters after its leading whitespace, or
/// `None` when it is within the cap.
fn capped(value: &str, max: usize) -> Option<String> {
    let limit = max + leading_space(value);
    (value.chars().count() > limit).then(|| value.chars().take(limit).collect())
}

impl SubagentEditor {
    /// The editor of `preset`, or of a new preset when `None`, among
    /// `presets`.
    pub fn new(
        preset: Option<SubagentPreset>,
        presets: &[SubagentPreset],
        connections: Entity<ConnectionCatalog>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let locale = Locale::current(cx);
        let taken = presets
            .iter()
            .filter(|p| Some(&p.id) != preset.as_ref().map(|preset| &preset.id))
            .map(|p| p.id.clone())
            .collect();
        let list =
            connections.read(cx).list().map(|list| list.connections.clone()).unwrap_or_default();
        let first_usable = list.iter().find(|c| is_selectable(c));
        let draft = match &preset {
            Some(preset) => Draft {
                profile: preset.profile.clone(),
                connection_slug: preset.connection_slug.clone(),
                model: preset.model.clone(),
                thinking_level: preset.thinking_level.clone(),
                enabled: preset.enabled,
            },
            None => Draft {
                profile: SubagentProfile::LocalRead,
                connection_slug: first_usable.map(|c| c.slug.to_string()).unwrap_or_default(),
                model: first_usable
                    .and_then(|c| offerable_models(c).first().map(|entry| entry.id.clone()))
                    .unwrap_or_default(),
                thinking_level: None,
                enabled: true,
            },
        };
        let name = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(copy::NAME_PLACEHOLDER.get(cx))
                .default_value(preset.as_ref().map(|p| p.name.clone()).unwrap_or_default())
        });
        let description = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(3, 8)
                .placeholder(copy::DESCRIPTION_PLACEHOLDER.get(cx))
                .default_value(preset.as_ref().map(|p| p.description.clone()).unwrap_or_default())
        });
        let id =
            cx.new(|cx| InputState::new(window, cx).placeholder(copy::SUBAGENT_ID_PLACEHOLDER));
        let profile = cx.new(|cx| ChoiceSelect::new(profile_choices(locale), None, window, cx));
        let connection = cx.new(|cx| OfferedSelect::new(Vec::new(), None, window, cx));
        let model = cx.new(|cx| OfferedSelect::new(Vec::new(), None, window, cx).searchable(true));
        let thinking = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let subscriptions = vec![
            cx.subscribe_in(&name, window, |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    this.name_changed(window, cx);
                }
            }),
            cx.subscribe_in(&description, window, |_, input, event: &InputEvent, window, cx| {
                // Capped where the Host would cut it.
                if matches!(event, InputEvent::Change) {
                    let value = input.read(cx).value();
                    if let Some(cut) = capped(&value, DESCRIPTION_MAX_CHARS) {
                        input.update(cx, |input, cx| input.set_value(cut, window, cx));
                    }
                }
            }),
            cx.subscribe_in(&id, window, |this, input, event: &InputEvent, window, cx| {
                // Typed, not filled in from the name.
                if matches!(event, InputEvent::Change)
                    && input.read(cx).focus_handle(cx).is_focused(window)
                {
                    this.id_edited = true;
                    cx.notify();
                }
            }),
            cx.subscribe_in(
                &profile,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<SubagentProfile>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(profile)) = event {
                        this.draft.profile = profile.clone();
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &connection,
                window,
                |this, _, event: &SelectEvent<Vec<Offered>>, window, cx| {
                    if let SelectEvent::Confirm(Some(slug)) = event {
                        this.select_connection(slug.to_string(), window, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &model,
                window,
                |this, _, event: &SelectEvent<Vec<Offered>>, window, cx| {
                    if let SelectEvent::Confirm(Some(model)) = event {
                        this.draft.model = model.to_string();
                        this.draft.thinking_level = None;
                        this.sync(window, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &thinking,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<Option<ThinkingLevel>>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(level)) = event {
                        this.draft.thinking_level = level.clone();
                        cx.notify();
                    }
                },
            ),
            cx.observe_in(&connections, window, |this, _, window, cx| this.sync(window, cx)),
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                let (name, description) =
                    (copy::NAME_PLACEHOLDER.get(cx), copy::DESCRIPTION_PLACEHOLDER.get(cx));
                this.name.update(cx, |input, cx| input.set_placeholder(name, window, cx));
                this.description
                    .update(cx, |input, cx| input.set_placeholder(description, window, cx));
                this.sync(window, cx);
            }),
        ];
        let mut this = Self {
            preset,
            taken,
            connections,
            name,
            description,
            id,
            id_edited: false,
            profile,
            connection,
            model,
            thinking,
            draft,
            submitted: false,
            saving: false,
            _subscriptions: subscriptions,
        };
        this.sync(window, cx);
        this
    }

    /// The field the editor opens with focus in: the name.
    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.name.update(cx, |input, cx| input.focus(window, cx));
    }

    /// The preset being edited, `None` for a new one.
    pub fn preset(&self) -> Option<&SubagentPreset> {
        self.preset.as_ref()
    }

    pub fn name_input(&self) -> &Entity<InputState> {
        &self.name
    }

    pub fn id_input(&self) -> &Entity<InputState> {
        &self.id
    }

    pub fn description_input(&self) -> &Entity<TextareaState> {
        &self.description
    }

    fn set_saving(&mut self, saving: bool, cx: &mut Context<Self>) {
        if self.saving != saving {
            self.saving = saving;
            cx.notify();
        }
    }

    fn connection_list(&self, cx: &App) -> Vec<ConnectionEntry> {
        self.connections.read(cx).list().map(|list| list.connections.clone()).unwrap_or_default()
    }

    /// The name as typed, capped where the Host would drop the preset, and
    /// a new preset's id following it until the id is typed
    /// (`nextSubagentDraftForName`).
    fn name_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let value = self.name.read(cx).value();
        if let Some(cut) = capped(&value, NAME_MAX_CHARS) {
            self.name.update(cx, |input, cx| input.set_value(cut, window, cx));
            return;
        }
        if self.preset.is_none() && !self.id_edited {
            let id = suggest_subagent_id(&value, &self.taken);
            if self.id.read(cx).value() != id {
                self.id.update(cx, |input, cx| input.set_value(id, window, cx));
            }
        }
        cx.notify();
    }

    /// Picks `slug`, its first model, and the model's own thinking level
    /// (Desktop's `selectConnection`).
    fn select_connection(&mut self, slug: String, window: &mut Window, cx: &mut Context<Self>) {
        let list = self.connection_list(cx);
        let first = list
            .iter()
            .find(|c| c.slug == slug.as_str() && is_selectable(c))
            .and_then(|c| offerable_models(c).first().map(|entry| entry.id.clone()));
        self.draft.connection_slug = slug;
        self.draft.model = first.unwrap_or_default();
        self.draft.thinking_level = None;
        self.sync(window, cx);
    }

    /// The thinking levels the chosen model offers.
    fn thinking_levels(&self, cx: &App) -> Vec<ThinkingLevel> {
        let list = self.connection_list(cx);
        list.iter()
            .find(|c| c.slug == self.draft.connection_slug.as_str())
            .and_then(|c| c.catalog_entries.iter().find(|entry| entry.id == self.draft.model))
            .map(|entry| entry.thinking_levels.clone())
            .unwrap_or_default()
    }

    /// Brings the dropdowns up to the draft and the catalog: every
    /// connection (the ones a preset cannot use say why and cannot be
    /// chosen), the chosen connection's models, and the model's levels.
    fn sync(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let list = self.connection_list(cx);
        let mut connections: Vec<Offered> = list
            .iter()
            .map(|c| {
                let retired = c.enabled && !is_selectable(c);
                Offered {
                    value: c.slug.clone(),
                    label: if retired {
                        copy::unavailable(locale, &c.name, copy::PROVIDER_RETIRED).into()
                    } else {
                        c.name.clone()
                    },
                    disabled: !is_selectable(c),
                }
            })
            .collect();
        let slug = SharedString::from(self.draft.connection_slug.clone());
        if !slug.is_empty() && !list.iter().any(|c| c.slug == slug) {
            connections.insert(
                0,
                Offered {
                    value: slug.clone(),
                    label: copy::unavailable(locale, &slug, copy::MISSING_CONNECTION).into(),
                    disabled: true,
                },
            );
        }
        let chosen = list.iter().find(|c| c.slug == slug);
        let mut models: Vec<Offered> = chosen
            .map(|c| offerable_models(c))
            .unwrap_or_default()
            .into_iter()
            .map(|entry| Offered {
                value: entry.id.clone().into(),
                label: entry.label().to_owned().into(),
                disabled: false,
            })
            .collect();
        let model = SharedString::from(self.draft.model.clone());
        if !model.is_empty() && !models.iter().any(|m| m.value == model) {
            models.insert(
                0,
                Offered {
                    value: model.clone(),
                    label: copy::unavailable(locale, &model, copy::MODEL_DISABLED).into(),
                    disabled: true,
                },
            );
        }
        let levels = self.thinking_levels(cx);
        let mut thinking = vec![Choice::new(None, copy::DEFAULT_THINKING.in_locale(locale))];
        thinking.extend(levels.iter().map(|level| {
            Choice::new(Some(level.clone()), thinking_label(level).in_locale(locale))
        }));
        let level = self.draft.thinking_level.clone().filter(|level| levels.contains(level));
        let profile = self.draft.profile.clone();
        sync_choices(&self.profile, profile_choices(locale), Some(&profile), window, cx);
        sync_choices(&self.thinking, thinking, Some(&level), window, cx);
        self.connection.update(cx, |select, cx| {
            select.set_items(connections, window, cx);
            select.set_selected_value(&slug, window, cx);
        });
        self.model.update(cx, |select, cx| {
            select.set_items(models, window, cx);
            select.set_selected_value(&model, window, cx);
        });
        cx.notify();
    }

    fn set_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        self.draft.enabled = enabled;
        cx.notify();
    }

    /// What is wrong with the draft, field by field: the name, the id, the
    /// connection, and the model (Desktop's `canSave` and its statuses).
    fn problems(&self, cx: &App) -> Problems {
        let list = self.connection_list(cx);
        let id = self.id.read(cx).value().trim().to_owned();
        let connection = list.iter().find(|c| c.slug == self.draft.connection_slug.as_str());
        let valid_connection = connection.is_some_and(is_selectable);
        let valid_model = connection
            .is_some_and(|c| offerable_models(c).iter().any(|entry| entry.id == self.draft.model));
        Problems {
            name: self.name.read(cx).value().trim().is_empty(),
            id: match &self.preset {
                Some(_) => None,
                None if !is_safe_subagent_id(&id) => Some(IdProblem::Invalid),
                None if self.taken.contains(&id) => Some(IdProblem::Taken),
                None => None,
            },
            connection: !valid_connection,
            model: valid_connection && !valid_model,
            no_connection: !list.iter().any(is_selectable),
        }
    }

    /// Presses Save: the preset to write, or `None` when a field is wrong
    /// (the fields then say what is missing).
    pub fn submit(&mut self, cx: &mut Context<Self>) -> Option<SubagentPreset> {
        self.submitted = true;
        cx.notify();
        let problems = self.problems(cx);
        if problems.name || problems.id.is_some() || problems.connection || problems.model {
            return None;
        }
        let levels = self.thinking_levels(cx);
        // An existing preset's id is settled: task history keys on it.
        let id = match &self.preset {
            Some(preset) => preset.id.clone(),
            None => self.id.read(cx).value().trim().to_owned(),
        };
        let mut preset = SubagentPreset::new(
            id,
            self.name.read(cx).value().trim(),
            self.draft.profile.clone(),
            self.draft.connection_slug.clone(),
            self.draft.model.clone(),
        );
        preset.description = self.description.read(cx).value().trim().to_owned();
        // Only a level the model still offers, as the row shows it.
        preset.thinking_level = self.draft.thinking_level.clone().filter(|l| levels.contains(l));
        preset.enabled = self.draft.enabled;
        Some(preset)
    }
}

/// What keeps a draft from being saved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Problems {
    name: bool,
    id: Option<IdProblem>,
    connection: bool,
    model: bool,
    no_connection: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IdProblem {
    Invalid,
    Taken,
}

impl Render for SubagentEditor {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let locale = Locale::current(cx);
        let saving = self.saving;
        let problems = self.problems(cx);
        let submitted = self.submitted;
        let error = |key: &'static str, shown: bool, text: Text| {
            (submitted && shown).then(|| StatusLine::error(key, text.in_locale(locale)))
        };
        let name = FieldBlock::new("subagent-name")
            .field(
                copy::NAME.get(cx),
                Input::new(&self.name)
                    .field_fill(cx)
                    .id("subagent-name-field")
                    .aria_label(copy::NAME.get(cx))
                    .disabled(saving),
            )
            .status(error("subagent-name", problems.name, copy::REQUIRED_NAME));
        let description = FieldBlock::new("subagent-description").field(
            copy::DESCRIPTION.get(cx),
            div().id("subagent-description-field").test_support().w_full().child(
                Textarea::new(&self.description)
                    .field_fill(cx)
                    .aria_label(copy::DESCRIPTION.get(cx))
                    .disabled(saving),
            ),
        );
        let purpose = SettingsGroup::new("subagent-purpose")
            .title(copy::GROUP_PURPOSE.get(cx))
            .description(copy::GROUP_PURPOSE_HELP.get(cx))
            .field(name)
            .field(description);
        let purpose = match &self.preset {
            Some(preset) => purpose.child(
                SettingsRow::path("subagent-id", copy::SUBAGENT_ID, preset.id.clone())
                    .detail(copy::ID_HELP.get(cx)),
            ),
            None => {
                let status = match (submitted, problems.id) {
                    (true, Some(IdProblem::Invalid)) => Some(StatusLine::error(
                        "subagent-id",
                        copy::invalid_id(locale, SUBAGENT_ID_MAX_CHARS),
                    )),
                    (true, Some(IdProblem::Taken)) => {
                        Some(StatusLine::error("subagent-id", copy::DUPLICATE_ID.get(cx)))
                    }
                    _ => None,
                };
                let block = FieldBlock::new("subagent-id")
                    .field(
                        copy::SUBAGENT_ID,
                        Input::new(&self.id)
                            .field_fill(cx)
                            .id("subagent-id-field")
                            .aria_label(copy::SUBAGENT_ID)
                            .disabled(saving),
                    )
                    .help(copy::ID_HELP.get(cx))
                    .status(status);
                purpose.field(block)
            }
        };
        let (_, profile_help) = profile_label(&self.draft.profile);
        let profile = SettingsRow::select(
            "subagent-profile",
            copy::PROFILE.get(cx),
            Select::new(&self.profile).disabled(saving),
        )
        .detail(profile_help.get(cx));
        let warning = (self.draft.profile == SubagentProfile::Implementation).then(|| {
            warning_line("subagent-implementation", copy::IMPLEMENTATION_WARNING.get(cx), cx)
        });
        let connection_status = if submitted && problems.connection && !problems.no_connection {
            Some(StatusLine::error("subagent-connection", copy::INVALID_CONNECTION.get(cx)))
        } else if problems.no_connection {
            Some(StatusLine::info("subagent-connection", copy::NO_CONNECTION.get(cx)))
        } else {
            None
        };
        let connection = SettingsRow::select(
            "subagent-connection",
            copy::CONNECTION.get(cx),
            Select::new(&self.connection).disabled(saving || problems.no_connection),
        )
        .status(connection_status);
        let has_models = self.model.read(cx).selected_value().is_some()
            || self.connection_list(cx).iter().any(|c| {
                c.slug == self.draft.connection_slug.as_str() && !offerable_models(c).is_empty()
            });
        let model_status = if submitted && problems.model {
            Some(StatusLine::error("subagent-model", copy::INVALID_MODEL.get(cx)))
        } else if !problems.no_connection && !has_models {
            Some(StatusLine::info("subagent-model", copy::NO_MODEL.get(cx)))
        } else {
            None
        };
        let model = SettingsRow::select(
            "subagent-model",
            copy::MODEL.get(cx),
            Select::new(&self.model).disabled(saving || !has_models),
        )
        .status(model_status);
        let thinking = (!self.thinking_levels(cx).is_empty()).then(|| {
            SettingsRow::select(
                "subagent-thinking",
                copy::THINKING.get(cx),
                Select::new(&self.thinking).disabled(saving),
            )
        });
        let editor = cx.weak_entity();
        let enabled = SettingsRow::toggle(
            "subagent-enabled",
            copy::ENABLED.get(cx),
            self.draft.enabled,
            saving,
            move |on, _, cx| {
                editor.update(cx, |editor, cx| editor.set_enabled(*on, cx)).ok();
            },
        )
        .detail(copy::ENABLED_HELP.get(cx));
        v_flex().w_full().gap_8().child(purpose).child(
            SettingsGroup::new("subagent-route")
                .title(copy::GROUP_ROUTE.get(cx))
                .description(copy::GROUP_ROUTE_HELP.get(cx))
                .child(profile)
                .children(warning)
                .child(connection)
                .child(model)
                .children(thinking)
                .child(enabled),
        )
    }
}

/// Behavior and presentation owner of the Subagents page: which level
/// shows, the editor while one is open, and the one write in flight.
///
/// A list row's switch saves at once; the editor saves the whole preset
/// with Save (Create for a new one) and goes back to the list once the
/// Host has it; Remove asks first. While a write runs every control
/// waits and the way back is closed, since leaving would lose the draft a
/// refused write gives back. A refusal says why above the list or under
/// the editor's buttons.
pub struct SubagentsPage {
    host: Entity<HostSession>,
    policy: Entity<HostPolicy>,
    connections: Entity<ConnectionCatalog>,
    route: SubagentRoute,
    editor: Option<Entity<SubagentEditor>>,
    saving: bool,
    error: Option<SharedString>,
    _save: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for SubagentsPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SubagentsPage")
            .field("route", &self.route)
            .field("saving", &self.saving)
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

/// Where a write leaves the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum After {
    Stay,
    List,
}

impl SubagentsPage {
    pub fn new(
        host: Entity<HostSession>,
        policy: Entity<HostPolicy>,
        connections: Entity<ConnectionCatalog>,
        cx: &mut Context<Self>,
    ) -> Self {
        let subscriptions = vec![
            cx.observe(&policy, |_, _, cx| cx.notify()),
            cx.observe(&connections, |_, _, cx| cx.notify()),
            cx.observe(&host, |_, _, cx| cx.notify()),
        ];
        Self {
            host,
            policy,
            connections,
            route: SubagentRoute::List,
            editor: None,
            saving: false,
            error: None,
            _save: None,
            _subscriptions: subscriptions,
        }
    }

    fn presets(&self, cx: &App) -> Vec<SubagentPreset> {
        self.policy.read(cx).policy().map(|p| p.subagents.presets.clone()).unwrap_or_default()
    }

    /// The level that shows: an editor whose preset went away is the list.
    pub fn route(&self, cx: &App) -> SubagentRoute {
        match &self.route {
            SubagentRoute::Edit(id) if !self.presets(cx).iter().any(|p| &p.id == id) => {
                SubagentRoute::List
            }
            route => route.clone(),
        }
    }

    /// The editor, while one shows.
    pub fn editor(&self, cx: &App) -> Option<&Entity<SubagentEditor>> {
        (self.route(cx) != SubagentRoute::List).then_some(self.editor.as_ref()).flatten()
    }

    /// Whether a write is unanswered.
    pub fn is_busy(&self) -> bool {
        self.saving
    }

    /// Why the last write was refused.
    pub fn error(&self) -> Option<&SharedString> {
        self.error.as_ref()
    }

    /// Opens the editor of a new preset, unless the list is full or the
    /// policy is not read.
    pub fn open_create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let presets = self.presets(cx);
        if self.saving
            || self.policy.read(cx).policy().is_none()
            || presets.len() >= MAX_SUBAGENT_PRESETS
        {
            return;
        }
        self.open(SubagentRoute::Create, None, &presets, window, cx);
    }

    /// Opens the editor of the preset `id`; returns whether it exists.
    pub fn open_editor(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let presets = self.presets(cx);
        let Some(preset) = presets.iter().find(|p| p.id == id).cloned() else {
            return false;
        };
        if !self.saving {
            self.open(SubagentRoute::Edit(preset.id.clone()), Some(preset), &presets, window, cx);
        }
        true
    }

    fn open(
        &mut self,
        route: SubagentRoute,
        preset: Option<SubagentPreset>,
        presets: &[SubagentPreset],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let connections = self.connections.clone();
        let editor = cx.new(|cx| SubagentEditor::new(preset, presets, connections, window, cx));
        editor.update(cx, |editor, cx| editor.focus(window, cx));
        self.error = None;
        self.route = route;
        self.editor = Some(editor);
        cx.notify();
    }

    /// Back to the list, unless a write is unanswered.
    pub fn show_list(&mut self, cx: &mut Context<Self>) {
        if !self.saving {
            self.route = SubagentRoute::List;
            self.editor = None;
            self.error = None;
            cx.notify();
        }
    }

    /// Writes the presets `change` makes of the list as the Host has it
    /// (`None`: nothing to change). With `expect`, reads the policy again
    /// afterwards and says the preset was not saved when it is not there.
    fn persist(
        &mut self,
        change: impl Fn(&[SubagentPreset]) -> Option<Vec<SubagentPreset>> + 'static,
        expect: Option<String>,
        after: After,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let locale = Locale::current(cx);
        let mutation = move |policy: &host_protocol::RuntimePolicy| {
            change(&policy.subagents.presets).map(|presets| RuntimePolicyMutation::SetSubagents {
                value: SubagentSettings::new(presets),
            })
        };
        let Some(task) = self.policy.update(cx, |policy, cx| policy.mutate(mutation, locale, cx))
        else {
            return;
        };
        let requester = self.host.read(cx).requester();
        self.saving = true;
        self.error = None;
        self.set_editor_saving(true, cx);
        self._save = Some(cx.spawn_in(window, async move |this, cx| {
            let what = copy::SAVE_FAILED.in_locale(locale);
            let mut result = task.await.map_err(|refusal| titled(locale, what, refusal.reason()));
            if let (Ok(()), Some(id)) = (&result, &expect) {
                // The normalizer drops a preset it cannot keep instead of
                // refusing the write: a committed write is not a saved preset.
                let read =
                    requester.request::<RuntimePolicyQuery>(&RuntimePolicyQueryInput {}).await;
                if read.is_ok_and(|snapshot| {
                    !snapshot.policy.subagents.presets.iter().any(|p| &p.id == id)
                }) {
                    result = Err(titled(locale, what, copy::REJECTED.in_locale(locale)));
                }
            }
            this.update_in(cx, |this, _, cx| {
                this._save = None;
                this.saving = false;
                this.set_editor_saving(false, cx);
                match result {
                    Ok(()) if after == After::List => this.show_list(cx),
                    Ok(()) => {}
                    Err(reason) => {
                        log::warn!("set_subagents was not saved: {reason}");
                        this.error = Some(reason.into());
                    }
                }
                if expect.is_some() {
                    // Show the list as the Host normalized it.
                    this.policy.update(cx, |policy, cx| policy.reload(cx));
                }
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn set_editor_saving(&self, saving: bool, cx: &mut Context<Self>) {
        if let Some(editor) = &self.editor {
            editor.update(cx, |editor, cx| editor.set_saving(saving, cx));
        }
    }

    /// Turns the preset `id` on or off from its row.
    pub fn set_enabled(
        &mut self,
        id: String,
        enabled: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let change = move |presets: &[SubagentPreset]| {
            let mut next = presets.to_vec();
            let preset = next.iter_mut().find(|p| p.id == id)?;
            if preset.enabled == enabled {
                return None;
            }
            preset.enabled = enabled;
            Some(next)
        };
        self.persist(change, None, After::Stay, window, cx);
    }

    /// Save (or Create) in the editor: the whole preset, replacing the one
    /// it edits or added at the end.
    pub fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(editor) = self.editor.clone() else {
            return;
        };
        if self.saving {
            return;
        }
        let Some(preset) = editor.update(cx, |editor, cx| editor.submit(cx)) else {
            return;
        };
        let editing = editor.read(cx).preset().is_some();
        let id = preset.id.clone();
        let change = move |presets: &[SubagentPreset]| {
            let mut next = presets.to_vec();
            match next.iter().position(|p| p.id == preset.id) {
                Some(ix) if editing => {
                    if next[ix] == preset {
                        return None;
                    }
                    next[ix] = preset.clone();
                }
                _ => next.push(preset.clone()),
            }
            Some(next)
        };
        self.persist(change, Some(id), After::List, window, cx);
    }

    /// Remove in the editor: asks first, then writes the list without it.
    pub fn confirm_remove(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(preset) = self.editor.as_ref().and_then(|e| e.read(cx).preset().cloned()) else {
            return;
        };
        if self.saving || window.has_active_dialog(cx) {
            return;
        }
        let page = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let page = page.clone();
            let id = preset.id.clone();
            let locale = Locale::current(cx);
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(copy::named(
                    locale,
                    copy::REMOVE_TITLE,
                    &preset.name,
                )))
                .description(shared::dialog::confirmation_text(copy::REMOVE_DESCRIPTION.get(cx)))
                .footer(shared::dialog::confirmation_answers(
                    copy::CANCEL.get(cx),
                    copy::REMOVE_CONFIRM.get(cx),
                    true,
                    cx,
                ))
                .on_ok(move |_, window, cx| {
                    let id = id.clone();
                    page.update(cx, |page, cx| page.remove(id, window, cx)).ok();
                    true
                })
        });
    }

    fn remove(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        let change = move |presets: &[SubagentPreset]| {
            presets
                .iter()
                .any(|p| p.id == id)
                .then(|| presets.iter().filter(|p| p.id != id).cloned().collect())
        };
        self.persist(change, None, After::List, window, cx);
    }

    fn render_error(&self) -> Option<StatusLine> {
        self.error.as_ref().map(|error| StatusLine::error("subagents-save", error.clone()))
    }

    fn render_list(&self, cx: &mut Context<Self>) -> AnyElement {
        let locale = Locale::current(cx);
        let connected = self.host.read(cx).is_connected();
        let (presets, unread, policy_saving) = {
            let policy = self.policy.read(cx);
            let presets = policy.policy().map(|policy| policy.subagents.presets.clone());
            (presets, policy.load_error().is_none(), policy.is_saving())
        };
        let group = SettingsGroup::new("subagents").title(copy::APPROVED.get(cx));
        let Some(presets) = presets else {
            let loading = connected && unread;
            let title = copy::APPROVED.get(cx);
            return group
                .children(
                    loading.then(|| SettingsRow::loading("subagents-loading", title, 12., cx)),
                )
                .into_any_element();
        };
        let editable = connected && !self.saving && !policy_saving;
        let add = |id: &'static str, cx: &mut Context<Self>| {
            control_button(Button::new(id).primary())
                .label(copy::ADD.get(cx))
                .disabled(!editable || presets.len() >= MAX_SUBAGENT_PRESETS)
                .on_click(cx.listener(|this, _, window, cx| this.open_create(window, cx)))
        };
        let group = group.description(copy::preset_count(locale, presets.len()));
        if presets.is_empty() {
            let action = add("subagents-add-empty", cx).into_any_element();
            return group
                .bare()
                .children(self.render_error())
                .child(empty_state(
                    "subagents",
                    Icon::new(gpui_kit::assets::IconName::Workflow),
                    copy::EMPTY_TITLE.get(cx),
                    Some(copy::EMPTY_DESCRIPTION.get(cx).into()),
                    Some(action),
                    cx,
                ))
                .into_any_element();
        }
        let connections = self
            .connections
            .read(cx)
            .list()
            .map(|list| list.connections.clone())
            .unwrap_or_default();
        let rows: Vec<AnyElement> = presets
            .iter()
            .map(|preset| self.render_row(preset, &connections, editable, cx))
            .collect();
        group
            .action(add("subagents-add", cx))
            .children(self.render_error().map(|line| div().py_2().child(line)))
            .children(rows)
            .into_any_element()
    }

    /// A preset's row: its name (and what keeps the main agent from its
    /// route), its guidance, its switch, and the way into its editor.
    fn render_row(
        &self,
        preset: &SubagentPreset,
        connections: &[ConnectionEntry],
        editable: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let locale = Locale::current(cx);
        let key = format!("subagent-{}", preset.id);
        let name = SharedString::from(preset.name.clone());
        let problem = problem(preset, connections)
            .map(|(text, tone)| status_dot(&key, text.get(cx), tone, cx));
        let page = cx.weak_entity();
        let id = preset.id.clone();
        let switch = {
            let (checked, disabled) = (preset.enabled, !editable);
            FadedSwitch::new(
                Switch::new(domain_element_id("settings-toggle", &key))
                    .checked(checked)
                    .disabled(disabled)
                    .accessibility_label(copy::named(locale, copy::ROW_ENABLED_LABEL, &preset.name))
                    .on_change(move |on, window, cx| {
                        let id = id.clone();
                        page.update(cx, |page, cx| page.set_enabled(id, *on, window, cx)).ok();
                    }),
                checked,
                disabled,
            )
        };
        let configure_label = copy::named(locale, copy::CONFIGURE, &preset.name);
        let id = preset.id.clone();
        let configure =
            row_icon_button(Button::new(domain_element_id("subagent-configure", &preset.id)), cx)
                .small()
                .size_7()
                .icon(Icon::new(MakaIcon::ChevronRight).size_4())
                .accessibility_label(configure_label.clone())
                .tooltip(configure_label)
                .disabled(self.saving)
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_editor(&id, window, cx);
                }));
        let detail = if preset.description.is_empty() {
            copy::FALLBACK_DESCRIPTION.get(cx).into()
        } else {
            SharedString::from(preset.description.clone())
        };
        let maka = cx.maka();
        let title = h_flex()
            .flex_wrap()
            .gap_2()
            .child(
                div()
                    .text_sm()
                    .font_weight(gpui_kit::FontWeight::MEDIUM)
                    .text_color(maka.ink)
                    .child(name.clone()),
            )
            .children(problem);
        h_flex()
            .id(domain_element_id("settings-row", &key))
            .test_support()
            .aria_label(name)
            .w_full()
            .items_start()
            .gap_4()
            .py_2()
            .child(v_flex().flex_1().min_w_0().child(title).child(
                div().text_xs().line_height(rems(1.25)).text_color(maka.ink_muted).child(detail),
            ))
            .child(h_flex().flex_shrink_0().gap_2().child(switch).child(configure))
            .into_any_element()
    }

    fn render_editor(&self, editor: &Entity<SubagentEditor>, cx: &mut Context<Self>) -> AnyElement {
        let maka = cx.maka();
        let preset = editor.read(cx).preset().cloned();
        let saving = self.saving;
        let (title, subtitle) = match &preset {
            Some(preset) => (SharedString::from(preset.name.clone()), copy::EDIT_SUBTITLE),
            None => (copy::ADD.get(cx).into(), copy::CREATE_SUBTITLE),
        };
        let back = Button::new("subagent-back")
            .disabled(saving)
            .on_click(cx.listener(|this, _, _, cx| this.show_list(cx)));
        let header = div().id("subagent-header").test_support().w_full().child(route_header(
            back,
            copy::BACK_TO_LIST.get(cx),
            v_flex()
                .gap_0p5()
                .child(
                    div()
                        .id("subagent-title")
                        .test_support()
                        .aria_label(title.clone())
                        .text_size(rems(HEADING_TEXT_REMS))
                        .line_height(rems(HEADING_LINE_REMS))
                        .font_weight(gpui_kit::FontWeight::SEMIBOLD)
                        .text_color(maka.ink)
                        .child(title),
                )
                .child(div().text_xs().text_color(maka.ink_muted).child(subtitle.get(cx))),
            cx,
        ));
        let label = match (&preset, saving) {
            (_, true) => copy::SAVING,
            (Some(_), false) => copy::SAVE,
            (None, false) => copy::CREATE,
        };
        let save = control_button(Button::new("subagent-save").primary())
            .label(label.get(cx))
            .loading(saving)
            .disabled(saving)
            .on_click(cx.listener(|this, _, window, cx| this.save(window, cx)));
        let cancel = quiet_button(Button::new("subagent-cancel"), cx)
            .label(copy::CANCEL.get(cx))
            .disabled(saving)
            .on_click(cx.listener(|this, _, _, cx| this.show_list(cx)));
        let danger = preset.is_some().then(|| {
            let remove = destructive_button("subagent-remove", copy::DELETE.get(cx), cx)
                .disabled(saving)
                .on_click(cx.listener(|this, _, window, cx| this.confirm_remove(window, cx)));
            SettingsGroup::new("subagent-danger")
                .title(copy::DANGER_ZONE.get(cx))
                .description(copy::DANGER_ZONE_HELP.get(cx))
                .bare()
                .child(ActionRow::new("subagent-danger").child(remove))
        });
        v_flex()
            .id("subagent-detail")
            .test_support()
            .w_full()
            .gap_8()
            .child(header)
            .child(editor.clone())
            .child(
                v_flex()
                    .w_full()
                    .gap_1()
                    .child(ActionRow::new("subagent-editor").child(save).child(cancel))
                    .children(self.render_error()),
            )
            .children(danger)
            .into_any_element()
    }
}

impl Render for SubagentsPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let status = policy_status(PAGE_KEY, &self.host, &self.policy, cx);
        let body = match (self.route(cx), self.editor.clone()) {
            (SubagentRoute::List, _) | (_, None) => self.render_list(cx),
            (_, Some(editor)) => self.render_editor(&editor, cx),
        };
        v_flex().w_full().gap_8().children(status).child(body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_id_follows_the_name_and_steps_around_taken_ones() {
        let taken: HashSet<String> = ["fast-reader".to_owned(), "fast-reader-2".to_owned()].into();
        assert_eq!(suggest_subagent_id("Fast  Reader!", &HashSet::new()), "fast-reader");
        assert_eq!(suggest_subagent_id("Fast reader", &taken), "fast-reader-3");
        assert_eq!(suggest_subagent_id("  ", &HashSet::new()), "subagent");
        assert_eq!(suggest_subagent_id("代码阅读", &HashSet::new()), "subagent");
        assert_eq!(suggest_subagent_id(&"a".repeat(200), &HashSet::new()).len(), 96);
    }

    #[test]
    fn an_id_is_what_the_host_keeps() {
        for id in ["fast-reader", "a.b_c:d-1", &"x".repeat(128)] {
            assert!(is_safe_subagent_id(id), "{id}");
        }
        for id in ["", "has space", "slash/no", "中文", &"x".repeat(129)] {
            assert!(!is_safe_subagent_id(id), "{id}");
        }
    }

    #[test]
    fn a_cap_counts_what_the_host_keeps() {
        assert_eq!(capped("  abc", 3), None, "leading spaces cost nothing");
        assert_eq!(capped("abcd", 3).as_deref(), Some("abc"));
        assert_eq!(capped("  文字字", 2).as_deref(), Some("  文字"));
    }
}

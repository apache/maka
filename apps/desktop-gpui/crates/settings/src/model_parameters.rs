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

//! A model's parameters on one connection, in a dialog over the
//! connection's detail: Maka Desktop's `CapabilityEditor` inside its
//! `ModelParametersDialog` and `AddModelDialog`
//! (apps/desktop/src/renderer/features/connection-settings/provider-capability-editor.tsx,
//! provider-add-model-dialog.tsx). "Add model" asks for the model's id
//! first; "Set parameters" edits one listed model.
//!
//! The fields are Desktop's: the request protocol (custom connections), a
//! display name, whether images are sent, ApplyPatch file editing, the
//! context window, the input limit, the compaction threshold, the output
//! limit (read-only where the provider refuses one), the thinking levels
//! (custom connections), the default thinking level, and the Fast tier
//! (custom models that take it). A count takes `128000`, `128K`, or
//! `1.5M`.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::dialog::Dialog;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::component::{Disableable as _, WindowExt as _, h_flex, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Subscription, TestSupportExt as _, Window, div,
};
use host_protocol::{
    DECLARABLE_THINKING_LEVELS, FAST_SERVICE_TIER, ModelApiProtocol, ModelOverride,
    ProviderDefinition, ThinkingLevel, apply_patch_by_default, parse_token_count,
    supports_fast_service_tier,
};
use shared::copy::Locale;
use shared::copy::models as copy;
use shared::copy::settings as settings_copy;
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, control_button, quiet_button};

use crate::rows::{Choice, ChoiceSelect, FieldBlock, sync_choices};

/// What the dialog edits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ParametersMode {
    /// A model added by hand, by its id.
    Add,
    /// The parameters of the listed model with this id.
    Edit(SharedString),
}

/// What the dialog asks of the detail that opened it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ParametersEvent {
    /// Save `declared` for `model`; `expected` is the declaration it was
    /// opened on (`None` for a new model), which must still stand.
    Submit { model: SharedString, declared: ModelOverride, expected: Option<ModelOverride> },
}

/// A tri-state choice: follow the model's information, or on, or off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tri {
    Auto,
    On,
    Off,
}

impl Tri {
    fn of(value: Option<bool>) -> Self {
        match value {
            None => Self::Auto,
            Some(true) => Self::On,
            Some(false) => Self::Off,
        }
    }

    fn value(self) -> Option<bool> {
        match self {
            Self::Auto => None,
            Self::On => Some(true),
            Self::Off => Some(false),
        }
    }
}

/// The facts the Host knows of the model, which the fields show as their
/// defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ModelFacts {
    pub(crate) default_context_window: Option<u64>,
    pub(crate) default_input_limit: Option<u64>,
    pub(crate) default_vision: Option<bool>,
    pub(crate) thinking_levels: Vec<ThinkingLevel>,
    /// The protocol discovery found for the model.
    pub(crate) discovered_protocol: Option<ModelApiProtocol>,
}

/// One count field of the editor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Count {
    ContextWindow,
    InputLimit,
    CompactionThreshold,
    MaxOutputTokens,
}

const COUNTS: [Count; 4] =
    [Count::ContextWindow, Count::InputLimit, Count::CompactionThreshold, Count::MaxOutputTokens];

impl Count {
    fn key(self) -> &'static str {
        match self {
            Self::ContextWindow => "context-window",
            Self::InputLimit => "input-limit",
            Self::CompactionThreshold => "compaction-threshold",
            Self::MaxOutputTokens => "max-output",
        }
    }

    fn get(self, declared: &ModelOverride) -> Option<u64> {
        match self {
            Self::ContextWindow => declared.context_window,
            Self::InputLimit => declared.input_limit,
            Self::CompactionThreshold => declared.compaction_threshold,
            Self::MaxOutputTokens => declared.max_output_tokens,
        }
    }

    fn set(self, declared: &mut ModelOverride, value: Option<u64>) {
        match self {
            Self::ContextWindow => declared.context_window = value,
            Self::InputLimit => declared.input_limit = value,
            Self::CompactionThreshold => declared.compaction_threshold = value,
            Self::MaxOutputTokens => declared.max_output_tokens = value,
        }
    }
}

/// Behavior and presentation owner of one model's parameters while the
/// dialog shows. It keeps a draft of the declaration; a count typed out of
/// shape stays visible (with why) and never replaces a valid one. Saving is
/// the detail's: the dialog stays, with its draft, until the Host has it.
///
/// Keyboard: Tab walks the fields and the buttons; Enter in a text field
/// saves; Escape closes the dialog without saving.
pub(crate) struct ModelParameters {
    mode: ParametersMode,
    provider_type: SharedString,
    /// A custom connection's default protocol; `None` for any other.
    custom_protocol: Option<ModelApiProtocol>,
    facts: ModelFacts,
    /// The ids the connection already lists.
    existing: Vec<SharedString>,
    expected: Option<ModelOverride>,
    declared: ModelOverride,
    id: Entity<InputState>,
    display_name: Entity<InputState>,
    counts: Vec<(Count, Entity<InputState>)>,
    protocol: Entity<ChoiceSelect<Option<ModelApiProtocol>>>,
    vision: Entity<ChoiceSelect<Tri>>,
    apply_patch: Entity<ChoiceSelect<Tri>>,
    default_thinking: Entity<ChoiceSelect<Option<ThinkingLevel>>>,
    fast: Entity<ChoiceSelect<bool>>,
    submit_attempted: bool,
    saving: bool,
    error: Option<SharedString>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for ModelParameters {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelParameters")
            .field("mode", &self.mode)
            .field("declared", &self.declared)
            .finish_non_exhaustive()
    }
}

impl EventEmitter<ParametersEvent> for ModelParameters {}

impl ModelParameters {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        mode: ParametersMode,
        provider_type: SharedString,
        custom_protocol: Option<ModelApiProtocol>,
        facts: ModelFacts,
        existing: Vec<SharedString>,
        declared: Option<ModelOverride>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let expected = match mode {
            ParametersMode::Add => None,
            ParametersMode::Edit(_) => Some(declared.clone().unwrap_or_default()),
        };
        let declared = declared.unwrap_or_default();
        let id = cx.new(|cx| InputState::new(window, cx).placeholder("deepseek-v4-flash-0731"));
        let display_name = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value(declared.display_name.clone().unwrap_or_default())
        });
        let counts: Vec<(Count, Entity<InputState>)> = COUNTS
            .iter()
            .map(|count| {
                let value = count.get(&declared).map(|value| value.to_string()).unwrap_or_default();
                let placeholder = match count {
                    Count::ContextWindow => facts
                        .default_context_window
                        .map_or("128000 / 128K / 1M".to_owned(), |value| value.to_string()),
                    Count::InputLimit => facts
                        .default_input_limit
                        .map_or("128000 / 128K / 1M".to_owned(), |value| value.to_string()),
                    Count::MaxOutputTokens => "8192 / 8K".to_owned(),
                    Count::CompactionThreshold => "128000 / 128K / 1M".to_owned(),
                };
                let input = cx.new(|cx| {
                    InputState::new(window, cx).placeholder(placeholder).default_value(value)
                });
                (*count, input)
            })
            .collect();
        let protocol = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let vision = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let apply_patch = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let default_thinking = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let fast = cx.new(|cx| ChoiceSelect::new(Vec::new(), None, window, cx));
        let mut subscriptions = vec![
            cx.subscribe_in(&id, window, |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::Change => this.id_changed(window, cx),
                InputEvent::PressEnter { .. } => this.submit(cx),
                _ => {}
            }),
            cx.subscribe_in(&display_name, window, |this, input, event: &InputEvent, _, cx| {
                match event {
                    InputEvent::Change => {
                        let name = input.read(cx).value();
                        this.declared.display_name =
                            (!name.trim().is_empty()).then(|| name.to_string());
                        cx.notify();
                    }
                    InputEvent::PressEnter { .. } => this.submit(cx),
                    _ => {}
                }
            }),
            cx.subscribe_in(
                &protocol,
                window,
                |this,
                 _,
                 event: &SelectEvent<Vec<Choice<Option<ModelApiProtocol>>>>,
                 window,
                 cx| {
                    if let SelectEvent::Confirm(Some(protocol)) = event {
                        this.declared.api_protocol = protocol.clone();
                        this.sync_selects(window, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &vision,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<Tri>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(tri)) = event {
                        this.declared.vision = tri.value();
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &apply_patch,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<Tri>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(tri)) = event {
                        this.declared.apply_patch = tri.value();
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &default_thinking,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<Option<ThinkingLevel>>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(level)) = event {
                        this.declared.default_thinking_level = level.clone();
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &fast,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<bool>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(fast)) = event {
                        this.declared.service_tier = fast.then(|| FAST_SERVICE_TIER.to_owned());
                        cx.notify();
                    }
                },
            ),
        ];
        for (count, input) in &counts {
            let count = *count;
            subscriptions.push(cx.subscribe_in(
                input,
                window,
                move |this, input, event: &InputEvent, _, cx| match event {
                    InputEvent::Change => {
                        let text = input.read(cx).value();
                        // Invalid text stays visible but never replaces a
                        // valid declaration.
                        if text.trim().is_empty() {
                            count.set(&mut this.declared, None);
                        } else if let Some(value) = parse_token_count(&text) {
                            count.set(&mut this.declared, Some(value));
                        }
                        cx.notify();
                    }
                    InputEvent::PressEnter { .. } => this.submit(cx),
                    _ => {}
                },
            ));
        }
        let mut this = Self {
            mode,
            provider_type,
            custom_protocol,
            facts,
            existing,
            expected,
            declared,
            id,
            display_name,
            counts,
            protocol,
            vision,
            apply_patch,
            default_thinking,
            fast,
            submit_attempted: false,
            saving: false,
            error: None,
            _subscriptions: subscriptions,
        };
        this.sync_selects(window, cx);
        this
    }

    /// The model the dialog is about: the listed one, or the id typed.
    fn model_id(&self, cx: &App) -> SharedString {
        match &self.mode {
            ParametersMode::Edit(id) => id.clone(),
            ParametersMode::Add => self.id.read(cx).value().trim().to_owned().into(),
        }
    }

    fn id_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.error = None;
        // The ApplyPatch default and the Fast tier depend on the id.
        self.sync_selects(window, cx);
    }

    /// The protocol the model speaks: its own declaration, discovery's, or
    /// the connection's (`declaredModelApiProtocol`).
    fn effective_protocol(&self) -> Option<ModelApiProtocol> {
        self.declared
            .api_protocol
            .clone()
            .or_else(|| self.facts.discovered_protocol.clone())
            .or_else(|| self.custom_protocol.clone())
    }

    /// The levels the default thinking level chooses from: a custom
    /// connection's declaration, else the model's own.
    fn thinking_choices(&self) -> Vec<ThinkingLevel> {
        match (&self.custom_protocol, &self.declared.thinking_levels) {
            (Some(_), Some(levels)) => levels.clone(),
            _ => self.facts.thinking_levels.clone(),
        }
    }

    fn shows_fast(&self, cx: &App) -> bool {
        let protocol = self.effective_protocol();
        supports_fast_service_tier(&self.provider_type, protocol.as_ref(), &self.model_id(cx))
    }

    /// Brings every dropdown up to the draft, their labels in the current
    /// language. For the handlers that change the draft, never for render.
    fn sync_selects(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        if let Some(default) = &self.custom_protocol {
            let mut choices =
                vec![Choice::new(None, copy::api_protocol_default(locale, default.label()))];
            choices.extend(
                ModelApiProtocol::ALL.into_iter().map(|protocol| {
                    Choice::new(Some(protocol.clone()), protocol.label().to_owned())
                }),
            );
            let current = self.declared.api_protocol.clone();
            sync_choices(&self.protocol, choices, Some(&current), window, cx);
        }
        let auto = match self.facts.default_vision {
            None => copy::VISION_AUTO,
            Some(true) => copy::VISION_AUTO_ON,
            Some(false) => copy::VISION_AUTO_OFF,
        };
        let vision = vec![
            Choice::new(Tri::Auto, auto.in_locale(locale)),
            Choice::new(Tri::On, copy::VISION_ON.in_locale(locale)),
            Choice::new(Tri::Off, copy::VISION_OFF.in_locale(locale)),
        ];
        sync_choices(&self.vision, vision, Some(&Tri::of(self.declared.vision)), window, cx);
        let auto = if apply_patch_by_default(&self.model_id(cx)) {
            copy::APPLY_PATCH_AUTO_ON
        } else {
            copy::APPLY_PATCH_AUTO_OFF
        };
        let apply_patch = vec![
            Choice::new(Tri::Auto, auto.in_locale(locale)),
            Choice::new(Tri::On, copy::APPLY_PATCH_ON.in_locale(locale)),
            Choice::new(Tri::Off, copy::APPLY_PATCH_OFF.in_locale(locale)),
        ];
        let current = Tri::of(self.declared.apply_patch);
        sync_choices(&self.apply_patch, apply_patch, Some(&current), window, cx);
        let levels = self.thinking_choices();
        if self
            .declared
            .default_thinking_level
            .as_ref()
            .is_some_and(|level| !levels.contains(level))
        {
            self.declared.default_thinking_level = None;
        }
        let mut thinking =
            vec![Choice::new(None, copy::PROVIDER_DEFAULT_THINKING.in_locale(locale))];
        thinking.extend(levels.into_iter().map(|level| {
            let label = level.as_str().to_owned();
            Choice::new(Some(level), label)
        }));
        let current = self.declared.default_thinking_level.clone();
        sync_choices(&self.default_thinking, thinking, Some(&current), window, cx);
        let fast = vec![
            Choice::new(false, copy::FAST_AUTO.in_locale(locale)),
            Choice::new(true, copy::FAST_ON.in_locale(locale)),
        ];
        let current = self.declared.service_tier.is_some();
        sync_choices(&self.fast, fast, Some(&current), window, cx);
        cx.notify();
    }

    /// Declares or drops the thinking level `level` (custom connections).
    pub(crate) fn set_thinking_level(
        &mut self,
        level: ThinkingLevel,
        on: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut levels = self.declared.thinking_levels.clone().unwrap_or_default();
        levels.retain(|existing| *existing != level);
        if on {
            levels.push(level);
        }
        let ordered: Vec<ThinkingLevel> =
            DECLARABLE_THINKING_LEVELS.iter().filter(|l| levels.contains(l)).cloned().collect();
        self.declared.thinking_levels = (!ordered.is_empty()).then_some(ordered);
        self.sync_selects(window, cx);
    }

    /// Why the id cannot be added, once a save was tried.
    fn id_error(&self, cx: &App) -> Option<&'static str> {
        if self.mode != ParametersMode::Add {
            return None;
        }
        let id = self.model_id(cx);
        if id.is_empty() {
            Some(copy::MODEL_ID_REQUIRED.get(cx))
        } else if self.existing.contains(&id) {
            Some(copy::MODEL_ID_DUPLICATE.get(cx))
        } else {
            None
        }
    }

    /// Whether the count field `count` holds text that is not a count.
    fn count_invalid(&self, count: Count, cx: &App) -> bool {
        self.counts.iter().find(|(c, _)| *c == count).is_some_and(|(_, input)| {
            let text = input.read(cx).value();
            !text.trim().is_empty() && parse_token_count(&text).is_none()
        })
    }

    fn limits_conflict(&self) -> bool {
        self.declared
            .limits_conflict(self.facts.default_context_window, self.facts.default_input_limit)
    }

    /// The declaration to save: the draft normalized, without a Fast tier
    /// the model no longer takes.
    fn to_save(&self, cx: &App) -> ModelOverride {
        let mut declared = self.declared.normalized();
        if !self.shows_fast(cx) {
            declared.service_tier = None;
        }
        declared
    }

    /// Whether Save would change anything (an added model always does).
    fn has_changes(&self, cx: &App) -> bool {
        match (&self.mode, &self.expected) {
            (ParametersMode::Edit(_), Some(expected)) => self.to_save(cx) != expected.normalized(),
            _ => true,
        }
    }

    fn can_submit(&self, cx: &App) -> bool {
        !self.saving
            && self.has_changes(cx)
            && !COUNTS.iter().any(|count| self.count_invalid(*count, cx))
            && !self.limits_conflict()
            && (self.mode != ParametersMode::Add
                || self.id_error(cx).is_none()
                || !self.submit_attempted)
    }

    /// Asks the detail to save the draft.
    pub(crate) fn submit(&mut self, cx: &mut Context<Self>) {
        self.submit_attempted = true;
        if self.id_error(cx).is_some() || !self.can_submit(cx) {
            cx.notify();
            return;
        }
        let event = ParametersEvent::Submit {
            model: self.model_id(cx),
            declared: self.to_save(cx),
            expected: self.expected.clone(),
        };
        cx.emit(event);
    }

    /// While the detail saves, the fields wait.
    pub(crate) fn set_saving(&mut self, saving: bool, cx: &mut Context<Self>) {
        self.saving = saving;
        cx.notify();
    }

    /// The save was refused, with why; the draft stays.
    pub(crate) fn fail(&mut self, error: impl Into<SharedString>, cx: &mut Context<Self>) {
        self.saving = false;
        self.error = Some(error.into());
        cx.notify();
    }

    /// Types `value` into the field `key` (`id`, `display-name`, or a
    /// count's key), as typing does.
    #[cfg(test)]
    pub(crate) fn fill(
        &mut self,
        key: &str,
        value: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let input = match key {
            "id" => Some(self.id.clone()),
            "display-name" => Some(self.display_name.clone()),
            _ => self
                .counts
                .iter()
                .find(|(count, _)| count.key() == key)
                .map(|(_, input)| input.clone()),
        };
        if let Some(input) = input {
            input.update(cx, |input, cx| input.set_value(value.to_owned(), window, cx));
            // `set_value` emits no change event: take it as typed.
            let text = input.read(cx).value();
            match key {
                "id" => self.id_changed(window, cx),
                "display-name" => {
                    self.declared.display_name = (!text.trim().is_empty()).then(|| text.to_string())
                }
                _ => {
                    if let Some((count, _)) = self.counts.iter().find(|(c, _)| c.key() == key) {
                        let count = *count;
                        if text.trim().is_empty() {
                            count.set(&mut self.declared, None);
                        } else if let Some(value) = parse_token_count(&text) {
                            count.set(&mut self.declared, Some(value));
                        }
                    }
                }
            }
            cx.notify();
        }
    }

    /// The dialog around the editor: the title (the model's id under it
    /// when editing), the fields, and Cancel and Save.
    pub(crate) fn dialog(&mut self, dialog: Dialog, cx: &mut Context<Self>) -> Dialog {
        let (title, confirm) = match &self.mode {
            ParametersMode::Add => (copy::ADD_MODEL.get(cx), copy::ADD_MODEL_CONFIRM.get(cx)),
            ParametersMode::Edit(_) => {
                (copy::SET_PARAMETERS.get(cx), settings_copy::SAVE_CHANGE.get(cx))
            }
        };
        let subtitle = match &self.mode {
            ParametersMode::Edit(id) => Some(id.clone()),
            ParametersMode::Add => None,
        };
        let footer = h_flex()
            .w_full()
            .justify_end()
            .gap_2()
            .child(
                quiet_button(Button::new("model-parameters-cancel"), cx)
                    .label(settings_copy::CANCEL.get(cx))
                    .disabled(self.saving)
                    .on_click(|_, window, cx| window.close_dialog(cx)),
            )
            .child(
                control_button(Button::new("model-parameters-save").primary())
                    .label(confirm)
                    .loading(self.saving)
                    .disabled(!self.can_submit(cx))
                    .on_click(cx.listener(|this, _, _, cx| this.submit(cx))),
            );
        dialog
            .with_header(match subtitle {
                Some(id) => DialogHeader::new(title).subtitle(id),
                None => DialogHeader::new(title),
            })
            .child(cx.entity())
            .with_footer(footer)
    }
}

/// A field's error line.
fn field_note(key: &str, message: &'static str, error: bool, cx: &App) -> AnyElement {
    let maka = cx.maka();
    div()
        .id(domain_element_id("model-parameters-note", key))
        .test_support()
        .aria_label(message)
        .text_xs()
        .text_color(if error { maka.destructive } else { maka.warning })
        .child(message)
        .into_any_element()
}

impl Render for ModelParameters {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let disabled = self.saving;
        let provider = ProviderDefinition::find(&self.provider_type);
        let accepts_limit = provider.is_none_or(ProviderDefinition::accepts_output_token_limit);
        let mut fields = Vec::new();
        if self.mode == ParametersMode::Add {
            let error = self.submit_attempted.then(|| self.id_error(cx)).flatten();
            fields.push(
                FieldBlock::new("model-parameters-id")
                    .field(
                        copy::MODEL_ID.get(cx),
                        v_flex()
                            .w_full()
                            .gap_2()
                            .child(
                                Input::new(&self.id)
                                    .field_fill(cx)
                                    .px_3()
                                    .id("model-parameters-id")
                                    .aria_label(copy::MODEL_ID.get(cx))
                                    .disabled(disabled),
                            )
                            .children(error.map(|message| field_note("id", message, true, cx))),
                    )
                    .required(true)
                    .help(copy::MODEL_ID_HELP.get(cx)),
            );
        }
        if self.custom_protocol.is_some() {
            fields.push(
                FieldBlock::new("model-parameters-protocol")
                    .field(
                        copy::API_PROTOCOL.get(cx),
                        Select::new(&self.protocol)
                            .px_3()
                            .id("model-parameters-protocol")
                            .accessibility_label(copy::API_PROTOCOL.get(cx))
                            .disabled(disabled),
                    )
                    .help(copy::API_PROTOCOL_HELP.get(cx)),
            );
        }
        fields.push(
            FieldBlock::new("model-parameters-display-name")
                .field(
                    copy::MODEL_DISPLAY_NAME.get(cx),
                    Input::new(&self.display_name)
                        .field_fill(cx)
                        .px_3()
                        .id("model-parameters-display-name")
                        .aria_label(copy::MODEL_DISPLAY_NAME.get(cx))
                        .cleanable(true)
                        .disabled(disabled),
                )
                .help(copy::MODEL_DISPLAY_NAME_HELP.get(cx)),
        );
        fields.push(
            FieldBlock::new("model-parameters-vision")
                .field(
                    copy::VISION.get(cx),
                    Select::new(&self.vision)
                        .px_3()
                        .id("model-parameters-vision")
                        .accessibility_label(copy::VISION.get(cx))
                        .disabled(disabled),
                )
                .help(copy::VISION_HELP.get(cx)),
        );
        fields.push(
            FieldBlock::new("model-parameters-apply-patch")
                .field(
                    copy::APPLY_PATCH.get(cx),
                    Select::new(&self.apply_patch)
                        .px_3()
                        .id("model-parameters-apply-patch")
                        .accessibility_label(copy::APPLY_PATCH.get(cx))
                        .disabled(disabled),
                )
                .help(copy::APPLY_PATCH_HELP.get(cx)),
        );
        for (count, input) in &self.counts {
            let (label, help) = match count {
                Count::ContextWindow => (copy::CONTEXT_WINDOW, copy::CONTEXT_WINDOW_HELP),
                Count::InputLimit => (copy::INPUT_LIMIT, copy::INPUT_LIMIT_HELP),
                Count::CompactionThreshold => {
                    (copy::COMPACTION_THRESHOLD, copy::COMPACTION_THRESHOLD_HELP)
                }
                Count::MaxOutputTokens => (copy::MAX_OUTPUT_TOKENS, copy::MAX_OUTPUT_TOKENS_HELP),
            };
            let unsupported = *count == Count::MaxOutputTokens && !accepts_limit;
            let note = if unsupported {
                Some(field_note(
                    count.key(),
                    copy::MAX_OUTPUT_TOKENS_UNSUPPORTED.get(cx),
                    false,
                    cx,
                ))
            } else if self.count_invalid(*count, cx) {
                Some(field_note(count.key(), copy::TOKEN_COUNT_INVALID.get(cx), true, cx))
            } else if *count == Count::InputLimit && self.limits_conflict() {
                Some(field_note(count.key(), copy::LIMITS_CONFLICT.get(cx), true, cx))
            } else {
                None
            };
            fields.push(
                FieldBlock::new(format!("model-parameters-{}", count.key()))
                    .field(
                        label.get(cx),
                        v_flex()
                            .w_full()
                            .gap_2()
                            .child(
                                Input::new(input)
                                    .field_fill(cx)
                                    .px_3()
                                    .id(domain_element_id("model-parameters", count.key()))
                                    .aria_label(label.get(cx))
                                    .cleanable(true)
                                    .disabled(disabled || unsupported),
                            )
                            .children(note),
                    )
                    .help(help.get(cx)),
            );
        }
        if self.custom_protocol.is_some() {
            let declared = self.declared.thinking_levels.clone().unwrap_or_default();
            let boxes = DECLARABLE_THINKING_LEVELS.iter().map(|level| {
                let level = level.clone();
                let key = format!("thinking-{}", level.as_str());
                Checkbox::new(domain_element_id("model-parameters", &key))
                    .label(level.as_str().to_owned())
                    // The row text size; the kit's medium label is 16px.
                    .text_sm()
                    .checked(declared.contains(&level))
                    .disabled(disabled)
                    .on_click(cx.listener(move |this, checked: &bool, window, cx| {
                        this.set_thinking_level(level.clone(), *checked, window, cx)
                    }))
            });
            fields.push(
                FieldBlock::new("model-parameters-thinking-levels")
                    .field(
                        copy::THINKING_LEVELS.get(cx),
                        h_flex().flex_wrap().gap_3().children(boxes),
                    )
                    .help(copy::THINKING_LEVELS_HELP.get(cx)),
            );
        }
        if !self.thinking_choices().is_empty() {
            fields.push(
                FieldBlock::new("model-parameters-default-thinking")
                    .field(
                        copy::DEFAULT_THINKING_LEVEL.get(cx),
                        Select::new(&self.default_thinking)
                            .px_3()
                            .id("model-parameters-default-thinking")
                            .accessibility_label(copy::DEFAULT_THINKING_LEVEL.get(cx))
                            .disabled(disabled),
                    )
                    .help(copy::DEFAULT_THINKING_LEVEL_HELP.get(cx)),
            );
        }
        if self.shows_fast(cx) {
            fields.push(
                FieldBlock::new("model-parameters-fast")
                    .field(
                        copy::FAST_MODE.get(cx),
                        Select::new(&self.fast)
                            .px_3()
                            .id("model-parameters-fast")
                            .accessibility_label(copy::FAST_MODE.get(cx))
                            .disabled(disabled),
                    )
                    .help(copy::FAST_MODE_HELP.get(cx)),
            );
        }
        let maka = cx.maka();
        v_flex()
            .id("model-parameters")
            .test_support()
            .w_full()
            .gap_3()
            .child(
                div().text_xs().text_color(maka.ink_muted).child(copy::CAPABILITIES_HELP.get(cx)),
            )
            .child(v_flex().w_full().children(fields))
            .children(self.error.clone().map(|error| {
                div()
                    .id("model-parameters-error")
                    .test_support()
                    .aria_label(error.clone())
                    .text_sm()
                    .text_color(maka.destructive)
                    .child(error)
            }))
    }
}

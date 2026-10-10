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

//! The General page, in Maka Desktop's order and wording
//! (general-settings-page.tsx, personalization-settings-section.tsx):
//! Identity (the display name, the interface language, the assistant's
//! tone), Privacy and notifications (incognito, the system notification a
//! task posts when it ends in the background, project instructions), Task
//! defaults (Code Mode, the default model, the permission mode new tasks
//! start in), Command environment (the shell the Host's Bash tool runs),
//! Terminal (how the workbar's terminals take Option and draw their
//! cursor; Desktop has no such group, its xterm fixes both), and Network
//! ([`NetworkSection`]).
//!
//! The interface language, the notification switch and the Terminal group
//! are the client's own preferences; everything else is the Host's runtime
//! policy, except the
//! default model, which is the connection catalog's default (the one the
//! Models page marks). Desktop's WorkHub switch is held back (it enables
//! nothing yet, upstream), and its Jev section is not part of this page's
//! package.

use std::collections::HashMap;
use std::time::Duration;

use gpui_kit::component::IndexPath;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::select::{Select, SelectDelegate, SelectEvent, SelectItem, SelectState};
use gpui_kit::component::{Disableable as _, WindowExt as _, v_flex};
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, FocusHandle, Focusable as _,
    InteractiveElement as _, IntoElement, KeyBinding, ParentElement as _, Render, SharedString,
    Styled as _, Subscription, Task, TestSupportExt as _, Window, div, prelude::FluentBuilder as _,
};
use host_protocol::{
    ChatDefaultPermissionMode, ConnectionTarget, HostOperationErrorCode, PersonalizationPolicy,
    PrivacyPolicy, RuntimePolicy, RuntimePolicyMutation, ShellPolicy, ShellPreference,
    WorkspaceInstructionsPolicy,
};
use shared::copy::conversation as modes;
use shared::copy::settings as copy;
use shared::copy::{Locale, Text, failure};
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, control_button, floating_surface, quiet_button};
use workspace::{ConnectionCatalog, ConnectionCatalogStatus, HostSession};

use crate::add_connection::set_default_target;
use crate::network_section::NetworkSection;
use crate::policy::{HostPolicy, Refusal};
use crate::preferences::{AppPreferences, Language, choose_language};
use crate::rows::{
    ActionRow, Choice, ChoiceSelect, FieldBlock, SettingsGroup, SettingsRow, StatusLine,
    settings_button, sync_choices,
};

/// The modes a new task can start in, in the composer's order, by the
/// composer's names. Read only is chosen per task, so it is not offered.
const DEFAULT_MODES: [ChatDefaultPermissionMode; 2] =
    [ChatDefaultPermissionMode::Ask, ChatDefaultPermissionMode::Bypass];

/// Where Git Bash usually is, filled in when Git Bash is chosen with no
/// executable (Desktop's `DEFAULT_GIT_BASH_EXECUTABLE`).
const DEFAULT_GIT_BASH: &str = "C:\\Program Files\\Git\\bin\\bash.exe";

/// Desktop cuts the display name at 60 characters and the tone at 500.
const DISPLAY_NAME_MAX_CHARS: usize = 60;
const TONE_MAX_CHARS: usize = 500;

/// The tone saves this long after the typing stops; leaving the field
/// saves it at once (Desktop's `TONE_AUTOSAVE_DEBOUNCE_MS`).
pub(crate) const TONE_SAVE_DELAY: Duration = Duration::from_millis(800);

/// The key of the page's own status line (offline, or the policy unread).
const PAGE_KEY: &str = "general";

/// Key context of the display name's field: Escape puts the name back and
/// closes the editor.
const DISPLAY_NAME_CONTEXT: &str = "SettingsDisplayName";

gpui_kit::actions!(
    settings_general,
    [
        /// Close the display name's editor without saving.
        CancelDisplayName,
    ]
);

/// Binds the page's keys. Called by [`crate::init`].
pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("escape", CancelDisplayName, Some(DISPLAY_NAME_CONTEXT))]);
}

fn language_choices(locale: Locale) -> Vec<Choice<Language>> {
    Language::ALL.map(|language| Choice::new(language, language.label(locale))).into()
}

fn mode_choices(locale: Locale) -> Vec<Choice<ChatDefaultPermissionMode>> {
    DEFAULT_MODES
        .map(|mode| {
            let label = match mode {
                ChatDefaultPermissionMode::Ask => modes::PERMISSION_AUTO,
                _ => modes::PERMISSION_FULL_ACCESS,
            };
            Choice::new(mode, label.in_locale(locale))
        })
        .into()
}

fn shell_choices(locale: Locale) -> Vec<Choice<ShellPreference>> {
    vec![
        Choice::new(ShellPreference::Auto, copy::SHELL_AUTO.in_locale(locale)),
        Choice::new(ShellPreference::GitBash, copy::SHELL_GIT_BASH.in_locale(locale)),
    ]
}

/// A choice of the default model dropdown: none, or one enabled model of an
/// enabled connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DefaultModel {
    NotSet,
    Model { connection: SharedString, model: SharedString },
}

/// The default model dropdown's choices, as Desktop's `ModelPicker` with its
/// leading "Not set": that first, then each enabled connection's enabled
/// models under the connection's name.
pub struct ModelChoices {
    not_set: Choice<DefaultModel>,
    groups: Vec<(SharedString, Vec<Choice<DefaultModel>>)>,
}

impl ModelChoices {
    /// The choices the catalog offers, "Not set" in `locale`.
    fn new(connections: &ConnectionCatalog, locale: Locale) -> Self {
        let not_set =
            Choice::new(DefaultModel::NotSet, copy::DEFAULT_MODEL_NOT_SET.in_locale(locale));
        let groups = connections
            .list()
            .into_iter()
            .flat_map(|list| list.enabled())
            .filter(|connection| !connection.models.is_empty())
            .map(|connection| {
                let models = connection
                    .models
                    .iter()
                    .map(|model| {
                        let value = DefaultModel::Model {
                            connection: connection.id.clone(),
                            model: model.id.clone(),
                        };
                        Choice::new(value, model.label.clone())
                    })
                    .collect();
                (connection.name.clone(), models)
            })
            .collect();
        Self { not_set, groups }
    }

    /// The catalog default, when it names one of the choices.
    fn current(&self, connections: &ConnectionCatalog) -> DefaultModel {
        let target = connections.list().and_then(|list| list.default_target.as_ref());
        let named = target.map(|target| DefaultModel::Model {
            connection: target.connection_id.clone().into(),
            model: target.model_id.clone().into(),
        });
        named
            .filter(|named| {
                self.groups.iter().flat_map(|(_, models)| models).any(|m| m.value() == named)
            })
            .unwrap_or(DefaultModel::NotSet)
    }
}

impl SelectDelegate for ModelChoices {
    type Item = Choice<DefaultModel>;

    fn sections_count(&self, _: &App) -> usize {
        1 + self.groups.len()
    }

    fn items_count(&self, section: usize) -> usize {
        match section {
            0 => 1,
            _ => self.groups.get(section - 1).map_or(0, |(_, models)| models.len()),
        }
    }

    fn item(&self, ix: IndexPath) -> Option<&Self::Item> {
        match ix.section {
            0 => (ix.row == 0).then_some(&self.not_set),
            section => self.groups.get(section - 1)?.1.get(ix.row),
        }
    }

    fn position<V>(&self, value: &V) -> Option<IndexPath>
    where
        Self::Item: SelectItem<Value = V>,
        V: PartialEq,
    {
        if self.not_set.value() == value {
            return Some(IndexPath::new(0));
        }
        self.groups.iter().enumerate().find_map(|(ix, (_, models))| {
            let row = models.iter().position(|model| model.value() == value)?;
            Some(IndexPath::new(row).section(ix + 1))
        })
    }

    /// Each connection's name over its models, as the composer's model menu
    /// heads them; "Not set" has none.
    fn render_section_header(
        &self,
        section: usize,
        _: &mut Window,
        cx: &mut App,
    ) -> Option<AnyElement> {
        let (name, _) = self.groups.get(section.checked_sub(1)?)?;
        Some(
            div()
                .px_2()
                .py_0p5()
                .text_xs()
                .font_weight(gpui_kit::FontWeight::MEDIUM)
                .text_color(cx.maka().ink_muted)
                .child(name.clone())
                .into_any_element(),
        )
    }
}

/// Behavior and presentation owner of the General page.
///
/// A switch or a dropdown saves as soon as it changes, a text when it is
/// committed (the display name with Save or Enter, the tone 800 ms after
/// the typing stops or when the field is left), and the shell with its
/// Save button, as in Desktop. The new value shows at once (the policy's
/// pending copy, see [`HostPolicy`]); a refusal puts the saved one back and
/// says why under the row. One change runs at a time: the Host's rows wait
/// while one is in flight. Before the policy is read the Host's rows hold
/// placeholders; when it cannot be read, or the Host is not connected, the
/// line at the top of the page says so, with Retry.
pub struct GeneralPage {
    host: Entity<HostSession>,
    policy: Entity<HostPolicy>,
    connections: Entity<ConnectionCatalog>,
    network: Entity<NetworkSection>,
    language: Entity<ChoiceSelect<Language>>,
    permission: Entity<ChoiceSelect<ChatDefaultPermissionMode>>,
    default_model: Entity<SelectState<ModelChoices>>,
    /// While the default model's change is sent, the dropdown keeps it.
    default_model_saving: bool,
    /// The display name's editor, open or not; focus rests on the row when
    /// it closes.
    name_editing: bool,
    name_input: Entity<InputState>,
    name_focus: FocusHandle,
    tone: Entity<TextareaState>,
    /// A tone waiting to be saved: typed, or held while another change ran.
    tone_unsaved: bool,
    _tone_timer: Option<Task<()>>,
    /// The shell as chosen on the page, until Save sends it.
    shell: Entity<ChoiceSelect<ShellPreference>>,
    shell_preference: ShellPreference,
    shell_executable: Entity<InputState>,
    /// Whether the shell was chosen or its path typed here since it was
    /// last saved: the Host's shell shows until then.
    shell_edited: bool,
    /// Why a row's last change was refused, by the row's key.
    errors: HashMap<&'static str, SharedString>,
    /// The row whose change is in flight.
    saving: Option<&'static str>,
    _save: Option<Task<()>>,
    _model_save: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl std::fmt::Debug for GeneralPage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GeneralPage")
            .field("errors", &self.errors)
            .field("saving", &self.saving)
            .finish_non_exhaustive()
    }
}

impl GeneralPage {
    pub fn new(
        host: Entity<HostSession>,
        policy: Entity<HostPolicy>,
        connections: Entity<ConnectionCatalog>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let locale = Locale::current(cx);
        let language = cx.new(|cx| ChoiceSelect::new(language_choices(locale), None, window, cx));
        let permission = cx.new(|cx| ChoiceSelect::new(mode_choices(locale), None, window, cx));
        let shell = cx.new(|cx| ChoiceSelect::new(shell_choices(locale), None, window, cx));
        let choices = ModelChoices::new(connections.read(cx), locale);
        let default_model = cx.new(|cx| SelectState::new(choices, None, window, cx));
        let name_input = cx.new(|cx| {
            InputState::new(window, cx).placeholder(copy::DISPLAY_NAME_PLACEHOLDER.get(cx))
        });
        let tone = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(4, 8)
                .placeholder(copy::ASSISTANT_TONE_PLACEHOLDER.get(cx))
        });
        let shell_executable =
            cx.new(|cx| InputState::new(window, cx).placeholder(DEFAULT_GIT_BASH));
        let network = cx.new(|cx| NetworkSection::new(host.clone(), policy.clone(), window, cx));
        let preferences = AppPreferences::global(cx);
        let subscriptions = vec![
            cx.subscribe_in(
                &language,
                window,
                |_, _, event: &SelectEvent<Vec<Choice<Language>>>, _, cx| {
                    if let SelectEvent::Confirm(Some(language)) = event {
                        choose_language(*language, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &permission,
                window,
                |this,
                 _,
                 event: &SelectEvent<Vec<Choice<ChatDefaultPermissionMode>>>,
                 window,
                 cx| {
                    if let SelectEvent::Confirm(Some(mode)) = event {
                        this.choose_default_mode(mode.clone(), window, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &default_model,
                window,
                |this, _, event: &SelectEvent<ModelChoices>, window, cx| {
                    if let SelectEvent::Confirm(Some(model)) = event {
                        this.set_default_model(model.clone(), window, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &shell,
                window,
                |this, _, event: &SelectEvent<Vec<Choice<ShellPreference>>>, window, cx| {
                    if let SelectEvent::Confirm(Some(preference)) = event {
                        this.choose_shell(preference.clone(), window, cx);
                    }
                },
            ),
            cx.subscribe_in(&name_input, window, |this, _, event: &InputEvent, window, cx| {
                match event {
                    InputEvent::PressEnter { .. } => this.save_display_name(window, cx),
                    InputEvent::Change => cx.notify(),
                    _ => {}
                }
            }),
            cx.subscribe_in(&tone, window, |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::Change => this.tone_changed(window, cx),
                InputEvent::Blur => this.save_tone(window, cx),
                _ => {}
            }),
            cx.subscribe_in(
                &shell_executable,
                window,
                |this, input, event: &InputEvent, window, cx| {
                    if matches!(event, InputEvent::Change) {
                        // Typed, not put there by the page.
                        if input.read(cx).focus_handle(cx).is_focused(window) {
                            this.shell_edited = true;
                        }
                        cx.notify();
                    }
                },
            ),
            cx.observe_in(&preferences, window, |this, _, window, cx| {
                this.sync_language(window, cx);
                cx.notify();
            }),
            // The choices and placeholders are in the interface's language.
            cx.observe_global_in::<Locale>(window, |this, window, cx| {
                this.relocalize(window, cx);
            }),
            cx.observe_in(&policy, window, |this, policy, window, cx| {
                this.sync_from_policy(window, cx);
                let idle = !policy.read(cx).is_saving();
                if this.tone_unsaved && this._tone_timer.is_none() && idle {
                    this.save_tone(window, cx);
                }
                cx.notify();
            }),
            cx.observe_in(&connections, window, |this, _, window, cx| {
                if !this.default_model_saving {
                    this.sync_default_model(window, cx);
                }
                cx.notify();
            }),
            cx.observe(&network, |_, _, cx| cx.notify()),
            cx.observe(&host, |_, _, cx| cx.notify()),
        ];
        let mut this = Self {
            host,
            policy,
            connections,
            network,
            language,
            permission,
            default_model,
            default_model_saving: false,
            name_editing: false,
            name_input,
            name_focus: cx.focus_handle(),
            tone,
            tone_unsaved: false,
            _tone_timer: None,
            shell,
            shell_preference: ShellPreference::Auto,
            shell_executable,
            shell_edited: false,
            errors: HashMap::new(),
            saving: None,
            _save: None,
            _model_save: None,
            _subscriptions: subscriptions,
        };
        this.sync_language(window, cx);
        this.sync_from_policy(window, cx);
        this.sync_default_model(window, cx);
        this
    }

    /// The default mode as last read, once read.
    pub fn default_mode(&self, cx: &App) -> Option<ChatDefaultPermissionMode> {
        let policy = self.policy.read(cx).policy()?;
        Some(policy.chat_defaults.permission_mode.clone())
    }

    /// The Network group.
    pub fn network(&self) -> &Entity<NetworkSection> {
        &self.network
    }

    /// Whether a change is in flight.
    pub fn is_busy(&self, cx: &App) -> bool {
        self.policy.read(cx).is_saving()
            || self.default_model_saving
            || self.network.read(cx).is_busy()
    }

    /// Why the row `key`'s last change was refused.
    pub fn error(&self, key: &str) -> Option<&SharedString> {
        self.errors.get(key)
    }

    fn relocalize(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = copy::DISPLAY_NAME_PLACEHOLDER.get(cx);
        let tone = copy::ASSISTANT_TONE_PLACEHOLDER.get(cx);
        self.name_input.update(cx, |input, cx| input.set_placeholder(name, window, cx));
        self.tone.update(cx, |input, cx| input.set_placeholder(tone, window, cx));
        self.sync_language(window, cx);
        self.sync_from_policy(window, cx);
        self.sync_default_model(window, cx);
    }

    fn sync_language(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let current = AppPreferences::current(cx).language;
        let choices = language_choices(Locale::current(cx));
        sync_choices(&self.language, choices, Some(&current), window, cx);
    }

    /// Brings the Host's rows up to the policy (as a change in flight
    /// leaves it): the dropdowns, the tone unless it is being typed, and the
    /// shell unless it has unsaved choices.
    fn sync_from_policy(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let locale = Locale::current(cx);
        let policy = self.policy.read(cx).policy().cloned();
        let mode = policy.as_ref().map(|policy| policy.chat_defaults.permission_mode.clone());
        sync_choices(&self.permission, mode_choices(locale), mode.as_ref(), window, cx);
        let Some(policy) = policy else {
            sync_choices(&self.shell, shell_choices(locale), None, window, cx);
            return;
        };
        let editing_tone = self.tone.read(cx).focus_handle(cx).is_focused(window);
        let tone = policy.personalization.assistant_tone.clone();
        if !editing_tone && !self.tone_unsaved && self.tone.read(cx).value() != tone {
            self.tone.update(cx, |input, cx| input.set_value(tone, window, cx));
        }
        // Unsaved choices stay until Save; a refused one stays to be fixed.
        if !self.shell_edited {
            self.shell_preference = policy.shell.preference.clone();
            let executable = policy.shell.executable.clone();
            if self.shell_executable.read(cx).value() != executable {
                self.shell_executable
                    .update(cx, |input, cx| input.set_value(executable, window, cx));
            }
        }
        let preference = self.shell_preference.clone();
        sync_choices(&self.shell, shell_choices(locale), Some(&preference), window, cx);
    }

    fn sync_default_model(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let choices = ModelChoices::new(self.connections.read(cx), Locale::current(cx));
        let current = choices.current(self.connections.read(cx));
        self.default_model.update(cx, |select, cx| {
            select.set_items(choices, window, cx);
            select.set_selected_value(&current, window, cx);
        });
    }

    /// Sends the policy change `change` builds for the row `key`; `what`
    /// names what failed when the Host refuses it, and `done` runs with the
    /// outcome. Returns whether it was sent: not before the policy is read
    /// or while another change runs.
    fn save_policy(
        &mut self,
        key: &'static str,
        what: Text,
        change: impl Fn(&RuntimePolicy) -> Option<RuntimePolicyMutation> + 'static,
        done: impl FnOnce(&mut Self, &Result<(), Refusal>, &mut Window, &mut Context<Self>) + 'static,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let locale = Locale::current(cx);
        let Some(task) = self.policy.update(cx, |policy, cx| policy.mutate(change, locale, cx))
        else {
            return false;
        };
        self.errors.remove(key);
        self.saving = Some(key);
        self._save = Some(cx.spawn_in(window, async move |this, cx| {
            let result = task.await;
            this.update_in(cx, |this, window, cx| {
                this._save = None;
                this.saving = None;
                if let Err(refusal) = &result {
                    let what = what.in_locale(locale);
                    this.errors.insert(key, failure(locale, what, refusal.reason()).into());
                }
                done(this, &result, window, cx);
                this.sync_from_policy(window, cx);
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
        true
    }

    /// The mode chosen in the dropdown: Full access asks first, as Desktop
    /// does (`persistPermissionMode`), and is saved only once confirmed; any
    /// other mode is saved at once.
    pub fn choose_default_mode(
        &mut self,
        mode: ChatDefaultPermissionMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let bypass = ChatDefaultPermissionMode::Bypass;
        if mode == bypass && self.default_mode(cx).as_ref() != Some(&bypass) {
            // The dropdown shows the saved mode until the question is answered.
            self.sync_from_policy(window, cx);
            self.confirm_full_access(window, cx);
            return;
        }
        self.set_default_mode(mode, window, cx);
    }

    /// Asks the Full access question, as choosing Full access does (for a
    /// screenshot of it). Nothing is asked when Full access is the default.
    pub fn ask_full_access(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let bypass = ChatDefaultPermissionMode::Bypass;
        if self.default_mode(cx).is_some_and(|mode| mode != bypass) {
            self.confirm_full_access(window, cx);
        }
    }

    /// Asks before Full access becomes the default: what it lets local
    /// tools do. "Turn on full access" saves it; "Keep Auto" and Escape
    /// keep the mode there was.
    fn confirm_full_access(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if window.has_active_dialog(cx) {
            return;
        }
        let page = cx.weak_entity();
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let page = page.clone();
            floating_surface(alert, cx)
                .with_header(DialogHeader::new(copy::FULL_ACCESS_CONFIRM_TITLE.get(cx)))
                .description(shared::dialog::confirmation_text(
                    copy::FULL_ACCESS_CONFIRM_BODY.get(cx),
                ))
                .footer(shared::dialog::confirmation_answers(
                    copy::FULL_ACCESS_KEEP_AUTO.get(cx),
                    copy::FULL_ACCESS_CONFIRM.get(cx),
                    true,
                    cx,
                ))
                .on_ok(move |_, window, cx| {
                    let bypass = ChatDefaultPermissionMode::Bypass;
                    page.update(cx, |page, cx| page.set_default_mode(bypass, window, cx)).ok();
                    true
                })
        });
    }

    /// Makes `mode` the default for new tasks.
    pub fn set_default_mode(
        &mut self,
        mode: ChatDefaultPermissionMode,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        log::info!("default permission mode: {}", mode.as_str());
        let change = move |policy: &RuntimePolicy| {
            (policy.chat_defaults.permission_mode != mode).then(|| {
                RuntimePolicyMutation::SetChatDefaults {
                    value: policy.chat_defaults.clone().with_permission_mode(mode.clone()),
                }
            })
        };
        let what = copy::PERMISSION_SAVE_FAILED;
        if !self.save_policy("default-permission", what, change, |_, _, _, _| {}, window, cx) {
            // Nothing to send on: the dropdown shows the policy again.
            self.sync_from_policy(window, cx);
        }
    }

    fn set_incognito(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        let change = move |policy: &RuntimePolicy| {
            (policy.privacy.incognito_active != on)
                .then(|| RuntimePolicyMutation::SetPrivacy { value: PrivacyPolicy::new(on) })
        };
        self.save_policy("incognito", copy::INCOGNITO_FAILED, change, |_, _, _, _| {}, window, cx);
    }

    fn set_workspace_instructions(
        &mut self,
        on: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let change = move |policy: &RuntimePolicy| {
            (policy.workspace_instructions.enabled != on).then(|| {
                RuntimePolicyMutation::SetWorkspaceInstructions {
                    value: WorkspaceInstructionsPolicy::new(on),
                }
            })
        };
        let what = copy::WORKSPACE_INSTRUCTIONS_FAILED;
        self.save_policy("workspace-instructions", what, change, |_, _, _, _| {}, window, cx);
    }

    fn set_code_mode(&mut self, on: bool, window: &mut Window, cx: &mut Context<Self>) {
        let change = move |policy: &RuntimePolicy| {
            (policy.chat_defaults.code_mode_enabled.unwrap_or(false) != on).then(|| {
                RuntimePolicyMutation::SetChatDefaults {
                    value: policy.chat_defaults.clone().with_code_mode(on),
                }
            })
        };
        let what = copy::SETTING_NOT_APPLIED;
        self.save_policy("code-mode", what, change, |_, _, _, _| {}, window, cx);
    }

    fn set_run_notifications(&mut self, on: bool, cx: &mut Context<Self>) {
        AppPreferences::global(cx)
            .update(cx, |preferences, cx| preferences.set_run_notifications(on, cx));
    }

    /// The Terminal group: the client's own switches, saved as they change.
    fn render_terminal(&self, cx: &mut Context<Self>) -> SettingsGroup {
        let preferences = AppPreferences::global(cx).read(cx);
        let (option_as_meta, cursor_blink) =
            (preferences.terminal_option_as_meta(), preferences.terminal_cursor_blink());
        let option_as_meta = SettingsRow::toggle(
            "terminal-option-as-meta",
            copy::TERMINAL_OPTION_AS_META.get(cx),
            option_as_meta,
            false,
            |on, _, cx| {
                AppPreferences::global(cx)
                    .update(cx, |preferences, cx| preferences.set_terminal_option_as_meta(*on, cx));
            },
        )
        .detail(copy::TERMINAL_OPTION_AS_META_HELP.get(cx));
        let cursor_blink = SettingsRow::toggle(
            "terminal-cursor-blink",
            copy::TERMINAL_CURSOR_BLINK.get(cx),
            cursor_blink,
            false,
            |on, _, cx| {
                AppPreferences::global(cx)
                    .update(cx, |preferences, cx| preferences.set_terminal_cursor_blink(*on, cx));
            },
        );
        SettingsGroup::new("terminal")
            .title(copy::TERMINAL.get(cx))
            .child(option_as_meta)
            .child(cursor_blink)
    }

    /// Opens the display name's editor on the name as saved, focused.
    pub fn edit_display_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let policy = self.policy.read(cx).policy();
        let Some(name) = policy.map(|policy| policy.personalization.display_name.clone()) else {
            return;
        };
        self.errors.remove("display-name");
        self.name_editing = true;
        self.name_input.update(cx, |input, cx| {
            input.set_value(name, window, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }

    fn cancel_display_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.errors.remove("display-name");
        self.close_display_name(window, cx);
    }

    fn on_cancel_display_name(
        &mut self,
        _: &CancelDisplayName,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.cancel_display_name(window, cx);
    }

    fn close_display_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.name_editing = false;
        self.name_focus.focus(window, cx);
        cx.notify();
    }

    /// Whether the display name's editor is open.
    pub fn is_editing_display_name(&self) -> bool {
        self.name_editing
    }

    /// The name typed in the editor, as it would be saved: trimmed, at most
    /// 60 characters.
    fn typed_display_name(&self, cx: &App) -> String {
        self.name_input.read(cx).value().trim().chars().take(DISPLAY_NAME_MAX_CHARS).collect()
    }

    /// Saves the typed name and closes the editor once the Host has it; a
    /// refusal keeps the editor open with the reason.
    pub fn save_display_name(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.name_editing || self.saving.is_some() {
            return;
        }
        let name = self.typed_display_name(cx);
        let policy = self.policy.read(cx).policy();
        let saved = policy.map(|policy| policy.personalization.display_name.clone());
        if saved.as_deref() == Some(name.as_str()) {
            self.close_display_name(window, cx);
            return;
        }
        let change = move |policy: &RuntimePolicy| {
            (policy.personalization.display_name != name).then(|| {
                RuntimePolicyMutation::SetPersonalization {
                    value: PersonalizationPolicy::new(
                        name.clone(),
                        policy.personalization.assistant_tone.clone(),
                    ),
                }
            })
        };
        let done = |this: &mut Self,
                    result: &Result<(), Refusal>,
                    window: &mut Window,
                    cx: &mut Context<Self>| {
            if result.is_ok() {
                this.close_display_name(window, cx);
            }
        };
        let what = copy::PERSONALIZATION_SAVE_FAILED;
        self.save_policy("display-name", what, change, done, window, cx);
    }

    fn tone_changed(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let typed = self.tone.read(cx).value();
        let policy = self.policy.read(cx).policy();
        let saved = policy.map(|policy| policy.personalization.assistant_tone.clone());
        if saved.as_deref() == Some(typed.as_ref()) {
            return;
        }
        self.tone_unsaved = true;
        self._tone_timer = Some(cx.spawn_in(window, async move |this, cx| {
            cx.background_executor().timer(TONE_SAVE_DELAY).await;
            this.update_in(cx, |this, window, cx| {
                this._tone_timer = None;
                this.save_tone(window, cx);
            })
            .ok();
        }));
    }

    /// Saves the tone as typed (trimmed, at most 500 characters). While
    /// another change runs it waits, and the policy's observer saves it once
    /// that one is answered.
    fn save_tone(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self._tone_timer = None;
        let tone: String = self.tone.read(cx).value().trim().chars().take(TONE_MAX_CHARS).collect();
        let Some(policy) = self.policy.read(cx).policy() else {
            return;
        };
        if policy.personalization.assistant_tone == tone {
            self.tone_unsaved = false;
            return;
        }
        let change = move |policy: &RuntimePolicy| {
            (policy.personalization.assistant_tone != tone).then(|| {
                RuntimePolicyMutation::SetPersonalization {
                    value: PersonalizationPolicy::new(
                        policy.personalization.display_name.clone(),
                        tone.clone(),
                    ),
                }
            })
        };
        let what = copy::PERSONALIZATION_SAVE_FAILED;
        let done =
            |this: &mut Self, _: &Result<(), Refusal>, _: &mut Window, _: &mut Context<Self>| {
                this.tone_unsaved = false;
            };
        self.save_policy("assistant-tone", what, change, done, window, cx);
    }

    fn choose_shell(
        &mut self,
        preference: ShellPreference,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if preference == ShellPreference::GitBash
            && self.shell_executable.read(cx).value().trim().is_empty()
        {
            self.shell_executable
                .update(cx, |input, cx| input.set_value(DEFAULT_GIT_BASH, window, cx));
        }
        self.shell_preference = preference;
        self.shell_edited = true;
        self.errors.remove("shell");
        cx.notify();
    }

    /// Whether the shell as chosen here differs from the Host's.
    fn shell_dirty(&self, cx: &App) -> bool {
        let Some(policy) = self.policy.read(cx).snapshot().map(|snapshot| &snapshot.policy) else {
            return false;
        };
        self.shell_preference != policy.shell.preference
            || self.shell_executable.read(cx).value().trim() != policy.shell.executable
    }

    fn can_save_shell(&self, cx: &App) -> bool {
        self.shell_dirty(cx)
            && self.saving.is_none()
            && (self.shell_preference == ShellPreference::Auto
                || !self.shell_executable.read(cx).value().trim().is_empty())
    }

    /// Saves the shell as chosen here.
    pub fn save_shell(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.can_save_shell(cx) {
            return;
        }
        let value = ShellPolicy::new(
            self.shell_preference.clone(),
            self.shell_executable.read(cx).value().trim().to_owned(),
        );
        let change = move |policy: &RuntimePolicy| {
            (policy.shell != value)
                .then(|| RuntimePolicyMutation::SetShell { value: value.clone() })
        };
        // Desktop's reading of the Host's refusal of a path it cannot run
        // as GNU Bash (`isRejectedShellPreference`).
        let done = |this: &mut Self,
                    result: &Result<(), Refusal>,
                    _: &mut Window,
                    cx: &mut Context<Self>| {
            match result {
                Ok(()) => this.shell_edited = false,
                Err(refusal) if refusal.code() == Some(&HostOperationErrorCode::InvalidRequest) => {
                    this.errors.insert("shell", copy::SHELL_EXECUTABLE_REJECTED.get(cx).into());
                }
                Err(_) => {}
            }
        };
        self.save_policy("shell", copy::SAVE_SHELL_FAILED, change, done, window, cx);
    }

    /// Makes `model` the catalog default (the Models page's), or clears it.
    pub fn set_default_model(
        &mut self,
        model: DefaultModel,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let choices = ModelChoices::new(self.connections.read(cx), Locale::current(cx));
        if self.default_model_saving || choices.current(self.connections.read(cx)) == model {
            self.sync_default_model(window, cx);
            return;
        }
        let (target, label) = match &model {
            DefaultModel::NotSet => (None, "none".to_owned()),
            DefaultModel::Model { connection, model } => (
                Some(ConnectionTarget::new(connection.to_string(), model.to_string())),
                format!("{connection} {model}"),
            ),
        };
        let requester = self.host.read(cx).requester();
        let locale = Locale::current(cx);
        self.errors.remove("default-model");
        self.default_model_saving = true;
        self._model_save = Some(cx.spawn_in(window, async move |this, cx| {
            let result = set_default_target(&requester, target, &label, locale).await;
            this.update_in(cx, |this, window, cx| {
                this._model_save = None;
                this.default_model_saving = false;
                if let Err(reason) = result {
                    let what = copy::DEFAULT_MODEL_FAILED.in_locale(locale);
                    this.errors.insert("default-model", failure(locale, what, &reason).into());
                    this.sync_default_model(window, cx);
                }
                this.connections.update(cx, |catalog, cx| catalog.reload(cx));
                cx.notify();
            })
            .ok();
        }));
        cx.notify();
    }

    fn status(&self, key: &'static str) -> Option<StatusLine> {
        self.errors.get(key).map(|error| StatusLine::error(key, error.clone()))
    }

    /// A row of the Host's policy: `ready` builds it from the policy and
    /// whether it can change now. Before the policy is read, a placeholder
    /// `width` rems wide stands in while it loads, and nothing when it
    /// cannot be read (the page's status line says why).
    fn host_row(
        &self,
        key: &'static str,
        title: Text,
        detail: Option<Text>,
        width: f32,
        cx: &App,
        ready: impl FnOnce(&RuntimePolicy, bool) -> SettingsRow,
    ) -> Option<SettingsRow> {
        let connected = self.host.read(cx).is_connected();
        let policy = self.policy.read(cx);
        let row = match policy.policy() {
            Some(read) => {
                let editable = connected && !policy.is_saving();
                ready(read, editable).status(self.status(key))
            }
            None if connected && policy.load_error().is_none() => {
                SettingsRow::loading(key, title.get(cx), width, cx)
            }
            None => return None,
        };
        Some(match detail {
            Some(detail) => row.detail(detail.get(cx)),
            None => row,
        })
    }

    /// A switch of the Host's policy for the row `key`.
    fn host_toggle(
        &self,
        key: &'static str,
        title: Text,
        detail: Text,
        checked: impl FnOnce(&RuntimePolicy) -> bool,
        set: fn(&mut Self, bool, &mut Window, &mut Context<Self>),
        cx: &mut Context<Self>,
    ) -> Option<SettingsRow> {
        let this = cx.weak_entity();
        let label = title.get(cx);
        self.host_row(key, title, Some(detail), 2.5, cx, move |policy, editable| {
            SettingsRow::toggle(key, label, checked(policy), !editable, move |on, window, cx| {
                this.update(cx, |this, cx| set(this, *on, window, cx)).ok();
            })
        })
    }

    /// Why the Host's rows cannot change: offline, or the policy unread.
    fn page_status(&self, cx: &mut Context<Self>) -> Option<StatusLine> {
        if !self.host.read(cx).is_connected() {
            return Some(StatusLine::info(PAGE_KEY, copy::PERMISSIONS_OFFLINE.get(cx)));
        }
        let policy = self.policy.read(cx);
        let message = policy.load_error().filter(|_| policy.policy().is_none())?.clone();
        let reason = failure(Locale::current(cx), copy::GENERAL_LOAD_FAILED.get(cx), &message);
        let retry = settings_button("general-retry", copy::RETRY.get(cx), cx).on_click(
            cx.listener(|this, _, _, cx| {
                this.policy.update(cx, |policy, cx| policy.reload(cx));
            }),
        );
        Some(StatusLine::error(PAGE_KEY, reason).action(retry))
    }

    fn render_display_name(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        const KEY: &str = "display-name";
        if self.name_editing {
            let saving = self.saving == Some(KEY);
            let policy = self.policy.read(cx).policy();
            let saved = policy.map(|policy| policy.personalization.display_name.clone());
            let typed = self.typed_display_name(cx);
            let can_save = !saving && saved.as_deref() != Some(typed.as_str());
            let field = div()
                .key_context(DISPLAY_NAME_CONTEXT)
                .on_action(cx.listener(Self::on_cancel_display_name))
                .w_full()
                .child(
                    Input::new(&self.name_input)
                        .field_fill(cx)
                        .id("display-name-field")
                        .aria_label(copy::DISPLAY_NAME.get(cx))
                        .disabled(saving),
                );
            let save = control_button(Button::new("display-name-save"))
                .primary()
                .label(copy::SAVE_CHANGE.get(cx))
                .loading(saving)
                .disabled(!can_save)
                .on_click(cx.listener(|this, _, window, cx| this.save_display_name(window, cx)));
            let cancel = quiet_button(Button::new("display-name-cancel"), cx)
                .label(copy::CANCEL.get(cx))
                .disabled(saving)
                .on_click(cx.listener(|this, _, window, cx| this.cancel_display_name(window, cx)));
            let editor = FieldBlock::new(KEY)
                .field(copy::DISPLAY_NAME.get(cx), field)
                .help(copy::DISPLAY_NAME_HELP.get(cx))
                .status(self.status(KEY))
                .action(save)
                .action(cancel);
            let block = div().w_full().track_focus(&self.name_focus).child(editor);
            return Some(block.into_any_element());
        }
        let this = cx.weak_entity();
        let (set, change) = (copy::DISPLAY_NAME_SET.get(cx), copy::DISPLAY_NAME_CHANGE.get(cx));
        let unset = copy::DISPLAY_NAME_UNSET.get(cx);
        let title = copy::DISPLAY_NAME.get(cx);
        let edit = quiet_button(Button::new("display-name-edit"), cx);
        let row =
            self.host_row(KEY, copy::DISPLAY_NAME, None, 7., cx, move |policy, editable| {
                let name = &policy.personalization.display_name;
                let (value, action) = if name.is_empty() {
                    (SharedString::from(unset), set)
                } else {
                    (SharedString::from(name.clone()), change)
                };
                let edit = edit.label(action).disabled(!editable).on_click(move |_, window, cx| {
                    this.update(cx, |this, cx| this.edit_display_name(window, cx)).ok();
                });
                SettingsRow::new(KEY, title).detail(value).end(edit)
            })?;
        Some(div().w_full().track_focus(&self.name_focus).child(row).into_any_element())
    }

    fn render_tone(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        const KEY: &str = "assistant-tone";
        let connected = self.host.read(cx).is_connected();
        let policy = self.policy.read(cx);
        if policy.policy().is_none() {
            let loading = connected && policy.load_error().is_none();
            return loading.then(|| {
                SettingsRow::loading(KEY, copy::ASSISTANT_TONE.get(cx), 10., cx)
                    .detail(copy::ASSISTANT_TONE_HELP.get(cx))
                    .into_any_element()
            });
        }
        let field = Textarea::new(&self.tone)
            .field_fill(cx)
            .aria_label(copy::ASSISTANT_TONE.get(cx))
            .disabled(!connected);
        let field = div().id("assistant-tone-field").test_support().w_full().child(field);
        Some(
            FieldBlock::new(KEY)
                .field(copy::ASSISTANT_TONE.get(cx), field)
                .help(copy::ASSISTANT_TONE_HELP.get(cx))
                .status(self.status(KEY))
                .into_any_element(),
        )
    }

    fn render_default_model(&self, cx: &mut Context<Self>) -> Option<SettingsRow> {
        const KEY: &str = "default-model";
        let connected = self.host.read(cx).is_connected();
        let title = copy::DEFAULT_MODEL.get(cx);
        let detail = copy::DEFAULT_MODEL_HELP.get(cx);
        let catalog = self.connections.read(cx);
        if catalog.list().is_none() {
            return match catalog.status().clone() {
                ConnectionCatalogStatus::Failed(message) if connected => {
                    let locale = Locale::current(cx);
                    let what = copy::CONNECTIONS_LOAD_FAILED.in_locale(locale);
                    let reason = failure(locale, what, &message);
                    let retry = settings_button("default-model-retry", copy::RETRY.get(cx), cx)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.connections.update(cx, |catalog, cx| catalog.reload(cx));
                        }));
                    Some(
                        SettingsRow::new(KEY, title)
                            .detail(detail)
                            .end(retry)
                            .status(StatusLine::error(KEY, reason)),
                    )
                }
                _ if connected => Some(SettingsRow::loading(KEY, title, 8., cx).detail(detail)),
                _ => None,
            };
        }
        let select = Select::new(&self.default_model)
            .placeholder(copy::DEFAULT_MODEL_NOT_SET.get(cx))
            .disabled(!connected || self.default_model_saving);
        Some(SettingsRow::select(KEY, title, select).detail(detail).status(self.status(KEY)))
    }

    fn render_permission(&self, cx: &mut Context<Self>) -> Option<SettingsRow> {
        let select = Select::new(&self.permission);
        let title = copy::DEFAULT_PERMISSION.get(cx);
        let help = Some(copy::DEFAULT_PERMISSION_HELP);
        self.host_row("default-permission", copy::DEFAULT_PERMISSION, help, 7., cx, move |_, on| {
            SettingsRow::select("default-permission", title, select.disabled(!on))
        })
    }

    fn render_shell(&self, cx: &mut Context<Self>) -> Option<SettingsGroup> {
        let select = Select::new(&self.shell);
        let title = copy::SHELL_PREFERENCE.get(cx);
        let help = Some(copy::SHELL_PREFERENCE_HELP);
        let row = self.host_row("shell", copy::SHELL_PREFERENCE, help, 6., cx, move |_, on| {
            SettingsRow::select("shell", title, select.disabled(!on))
        })?;
        let loaded = self.policy.read(cx).policy().is_some();
        let editable = loaded && self.host.read(cx).is_connected() && self.saving.is_none();
        let git_bash = loaded && self.shell_preference == ShellPreference::GitBash;
        let saving = self.saving == Some("shell");
        let dirty = self.shell_dirty(cx);
        let label = if saving { copy::SAVING_SHELL } else { copy::SAVE_SHELL };
        let save = settings_button("shell-save", label.get(cx), cx)
            .loading(saving)
            .disabled(!editable || !self.can_save_shell(cx))
            .on_click(cx.listener(|this, _, window, cx| this.save_shell(window, cx)));
        let executable = git_bash.then(|| {
            FieldBlock::new("shell-executable")
                .field(
                    copy::SHELL_EXECUTABLE.get(cx),
                    Input::new(&self.shell_executable)
                        .field_fill(cx)
                        .id("shell-executable-field")
                        .aria_label(copy::SHELL_EXECUTABLE.get(cx))
                        .disabled(!editable),
                )
                .help(copy::SHELL_EXECUTABLE_HELP.get(cx))
        });
        Some(
            SettingsGroup::new("shell")
                .title(copy::SHELL.get(cx))
                .description(copy::SHELL_HELP.get(cx))
                .child(row)
                .field(executable)
                // Only an unsaved change has anything to save: the shell
                // or the Git Bash path differs from the Host's.
                .when(loaded && (dirty || saving), |group| {
                    group.child(ActionRow::new("shell").child(save))
                }),
        )
    }
}

impl Render for GeneralPage {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let language = SettingsRow::select(
            "language",
            copy::INTERFACE_LANGUAGE.get(cx),
            Select::new(&self.language),
        )
        .detail(copy::INTERFACE_LANGUAGE_HELP.get(cx));
        let this = cx.weak_entity();
        let notifications = SettingsRow::toggle(
            "notifications",
            copy::NOTIFICATIONS.get(cx),
            AppPreferences::current(cx).run_notifications,
            false,
            move |on, _, cx| {
                this.update(cx, |this, cx| this.set_run_notifications(*on, cx)).ok();
            },
        )
        .detail(copy::NOTIFICATIONS_HELP.get(cx));
        let incognito = self.host_toggle(
            "incognito",
            copy::INCOGNITO,
            copy::INCOGNITO_HELP,
            |policy| policy.privacy.incognito_active,
            Self::set_incognito,
            cx,
        );
        let instructions = self.host_toggle(
            "workspace-instructions",
            copy::WORKSPACE_INSTRUCTIONS,
            copy::WORKSPACE_INSTRUCTIONS_HELP,
            |policy| policy.workspace_instructions.enabled,
            Self::set_workspace_instructions,
            cx,
        );
        let code_mode = self.host_toggle(
            "code-mode",
            copy::CODE_MODE,
            copy::CODE_MODE_HELP,
            |policy| policy.chat_defaults.code_mode_enabled.unwrap_or(false),
            Self::set_code_mode,
            cx,
        );
        let policy = self.policy.read(cx);
        let network_shown = policy.policy().is_some()
            || self.host.read(cx).is_connected() && policy.load_error().is_none();
        v_flex()
            .w_full()
            .gap_8()
            .children(self.page_status(cx))
            .child(
                SettingsGroup::new("identity")
                    .title(copy::IDENTITY.get(cx))
                    .description(copy::IDENTITY_HELP.get(cx))
                    .children(self.render_display_name(cx))
                    .child(language)
                    .children(self.render_tone(cx)),
            )
            .child(
                SettingsGroup::new("privacy")
                    .title(copy::PRIVACY.get(cx))
                    .description(copy::PRIVACY_HELP.get(cx))
                    .children(incognito)
                    .child(notifications)
                    .children(instructions),
            )
            .child(
                SettingsGroup::new("task-defaults")
                    .title(copy::TASK_DEFAULTS.get(cx))
                    .description(copy::TASK_DEFAULTS_HELP.get(cx))
                    .children(code_mode)
                    .children(self.render_default_model(cx))
                    .children(self.render_permission(cx)),
            )
            .children(self.render_shell(cx))
            .child(self.render_terminal(cx))
            .when(network_shown, |this| this.child(self.network.clone()))
    }
}

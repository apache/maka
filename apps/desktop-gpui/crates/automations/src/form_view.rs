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

//! The create and edit form in its dialog, after Desktop's
//! `ScheduledTaskFormDialog` (packages/ui/src/scheduled-task-form-dialog.tsx):
//! the title and notes, the task time with its quick presets, the repeat
//! rule (a cron expression when chosen), the delivery (a local
//! notification, or a bot chat with its platform and chat id), and one
//! button that creates or saves. Desktop's one date-time field is a date
//! picker and an `HH:mm` field here (gpui-kit has no time picker).
//!
//! The form owns its fields and the submission in flight; the page owns
//! the dialog and closes it when the form is done.

use chrono::Local;
use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::date_picker::{DatePicker, DatePickerEvent, DatePickerState};
use gpui_kit::component::dialog::Dialog;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::select::{Select, SelectEvent};
use gpui_kit::component::{Disableable as _, StyledExt as _, h_flex, v_flex};
use gpui_kit::{
    Anchor, AnyElement, App, AppContext as _, ClickEvent, Context, Entity, EventEmitter,
    InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, TestSupportExt as _, Window,
    div, prelude::FluentBuilder as _, rems,
};
use host_protocol::{
    SCHEDULED_TASK_CHAT_ID_MAX_CHARS, SCHEDULED_TASK_CRON_MAX_CHARS,
    SCHEDULED_TASK_INTENT_MAX_CHARS, SCHEDULED_TASK_TITLE_MAX_CHARS, ScheduledTaskBotPlatform,
    ScheduledTaskMutateInput,
};
use shared::copy::Locale;
use shared::copy::automations as copy;
use shared::dialog::{DialogHeader, DialogHeaderExt as _};
use shared::domain_element_id;
use shared::rows::{FieldBlock, StatusLine};
use shared::theme::FieldFill as _;
use shared::theme::{ActiveMakaPalette as _, control_button, floating_surface, quiet_button};

use crate::catalog::{ActionFailure, ScheduledTasks};
use crate::form::{
    Field, FormSeed, FormValues, Method, Preset, Recurrence, Submission, TEMPLATES, submission,
    validate,
};
use crate::model::{delivery_providers, platform_label};
use crate::widgets::{Choice, ChoiceSelect, failure};

/// The dialog's width (Desktop's 480px).
const FORM_WIDTH_REMS: f32 = 30.;

/// What the form reports to the page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TaskFormEvent {
    /// The task was created or saved: the dialog closes.
    Done,
}

/// Behavior and presentation owner of one form session: its fields, its
/// values as the submission reads them, whether the title has been typed
/// in (its message waits until then, as Desktop's), and the submission in
/// flight, during which nothing can be changed and the dialog stays.
pub struct TaskForm {
    catalog: Entity<ScheduledTasks>,
    seed: FormSeed,
    values: FormValues,
    title: Entity<InputState>,
    title_touched: bool,
    note: Entity<TextareaState>,
    date: Entity<DatePickerState>,
    clock: Entity<InputState>,
    recurrence: Entity<ChoiceSelect<Recurrence>>,
    cron: Entity<InputState>,
    method: Entity<ChoiceSelect<Method>>,
    platform: Entity<ChoiceSelect<ScheduledTaskBotPlatform>>,
    chat_id: Entity<InputState>,
    /// "Now" as of the last change, for the time's validation.
    now_ms: i64,
    submitting: bool,
    failure: Option<ActionFailure>,
    _submit: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<TaskFormEvent> for TaskForm {}

impl std::fmt::Debug for TaskForm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TaskForm")
            .field("editing", &self.seed.editing)
            .field("submitting", &self.submitting)
            .finish_non_exhaustive()
    }
}

impl TaskForm {
    pub fn new(
        catalog: Entity<ScheduledTasks>,
        seed: FormSeed,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let locale = Locale::current(cx);
        let text = |value: &str, placeholder: &'static str, window: &mut Window, cx: &mut App| {
            let value = value.to_owned();
            cx.new(|cx| {
                let mut input = InputState::new(window, cx).placeholder(placeholder);
                input.set_value(value, window, cx);
                input
            })
        };
        let title = text(&seed.title, copy::TITLE_PLACEHOLDER.in_locale(locale), window, cx);
        let clock =
            text(&seed.run_at.clock(), copy::TIME_PLACEHOLDER.in_locale(locale), window, cx);
        let cron = text(&seed.cron, copy::CRON_PLACEHOLDER.in_locale(locale), window, cx);
        let chat_id = text(&seed.chat_id, copy::CHAT_ID_PLACEHOLDER.in_locale(locale), window, cx);
        let note = cx.new(|cx| {
            let mut note = TextareaState::new(window, cx)
                .auto_grow(3, 6)
                .placeholder(copy::NOTE_PLACEHOLDER.in_locale(locale));
            note.set_value(seed.note.clone(), window, cx);
            note
        });
        let run_date = seed.run_at.date;
        let date = cx.new(|cx| {
            let mut date = DatePickerState::new(window, cx).date_format("%Y-%m-%d");
            date.set_date(run_date, window, cx);
            date
        });
        let recurrence_choices = if seed.recurrence == Recurrence::Interval {
            vec![Recurrence::Interval]
        } else {
            Recurrence::CHOOSABLE.to_vec()
        };
        let recurrence = choice_select(
            recurrence_choices
                .into_iter()
                .map(|value| Choice::new(value, value.label().in_locale(locale)))
                .collect(),
            &seed.recurrence,
            window,
            cx,
        );
        let method_choices = if seed.method == Method::AgentRun {
            vec![Method::AgentRun]
        } else {
            Method::CHOOSABLE.to_vec()
        };
        let method = choice_select(
            method_choices
                .into_iter()
                .map(|value| Choice::new(value, value.label().in_locale(locale)))
                .collect(),
            &seed.method,
            window,
            cx,
        );
        let platform = choice_select(
            ScheduledTaskBotPlatform::DELIVERY
                .into_iter()
                .map(|value| {
                    let label = platform_label(&value, locale);
                    Choice::new(value, label)
                })
                .collect(),
            &seed.platform,
            window,
            cx,
        );
        let values = FormValues::of_seed(&seed, &Local);
        let limited = |limit: usize| {
            move |this: &mut Self,
                  input: &Entity<InputState>,
                  event: &InputEvent,
                  window: &mut Window,
                  cx: &mut Context<Self>| {
                match event {
                    InputEvent::Change => {
                        cap(input, limit, window, cx);
                        this.read_fields(cx);
                    }
                    InputEvent::PressEnter { .. } => this.submit(window, cx),
                    _ => {}
                }
            }
        };
        let subscriptions = vec![
            cx.subscribe_in(&title, window, {
                let read = limited(SCHEDULED_TASK_TITLE_MAX_CHARS);
                move |this, input, event: &InputEvent, window, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.title_touched = true;
                    }
                    read(this, input, event, window, cx);
                }
            }),
            cx.subscribe_in(&clock, window, limited(5)),
            cx.subscribe_in(&cron, window, limited(SCHEDULED_TASK_CRON_MAX_CHARS)),
            cx.subscribe_in(&chat_id, window, limited(SCHEDULED_TASK_CHAT_ID_MAX_CHARS)),
            cx.subscribe_in(&note, window, |this, note, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::Change) {
                    let value = note.read(cx).value();
                    if value.chars().count() > SCHEDULED_TASK_INTENT_MAX_CHARS {
                        let kept: String =
                            value.chars().take(SCHEDULED_TASK_INTENT_MAX_CHARS).collect();
                        note.update(cx, |note, cx| note.set_value(kept, window, cx));
                    }
                    this.read_fields(cx);
                }
            }),
            cx.subscribe(&date, |this, _, _: &DatePickerEvent, cx| this.read_fields(cx)),
            cx.subscribe(
                &recurrence,
                |this, _, event: &SelectEvent<Vec<Choice<Recurrence>>>, cx| {
                    if let SelectEvent::Confirm(Some(_)) = event {
                        this.read_fields(cx);
                    }
                },
            ),
            cx.subscribe(&method, |this, _, event: &SelectEvent<Vec<Choice<Method>>>, cx| {
                if let SelectEvent::Confirm(Some(_)) = event {
                    this.read_fields(cx);
                }
            }),
            cx.subscribe(
                &platform,
                |this, _, event: &SelectEvent<Vec<Choice<ScheduledTaskBotPlatform>>>, cx| {
                    if let SelectEvent::Confirm(Some(_)) = event {
                        this.read_fields(cx);
                    }
                },
            ),
        ];
        Self {
            catalog,
            seed,
            values,
            title,
            title_touched: false,
            note,
            date,
            clock,
            recurrence,
            cron,
            method,
            platform,
            chat_id,
            now_ms: Local::now().timestamp_millis(),
            submitting: false,
            failure: None,
            _submit: None,
            _subscriptions: subscriptions,
        }
    }

    pub fn seed(&self) -> &FormSeed {
        &self.seed
    }

    pub fn values(&self) -> &FormValues {
        &self.values
    }

    pub fn is_submitting(&self) -> bool {
        self.submitting
    }

    /// The title field, which has focus when the dialog opens.
    pub fn title_input(&self) -> &Entity<InputState> {
        &self.title
    }

    pub fn clock_input(&self) -> &Entity<InputState> {
        &self.clock
    }

    pub fn cron_input(&self) -> &Entity<InputState> {
        &self.cron
    }

    pub fn chat_id_input(&self) -> &Entity<InputState> {
        &self.chat_id
    }

    pub fn note_input(&self) -> &Entity<TextareaState> {
        &self.note
    }

    pub fn recurrence_select(&self) -> &Entity<ChoiceSelect<Recurrence>> {
        &self.recurrence
    }

    pub fn method_select(&self) -> &Entity<ChoiceSelect<Method>> {
        &self.method
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.title.update(cx, |title, cx| title.focus(window, cx));
    }

    /// The first thing wrong with the form, as its fields say it.
    pub fn validation(&self) -> Option<(Field, shared::copy::Text)> {
        validate(&self.values, self.now_ms)
    }

    /// Reads every field into the values the submission sends.
    fn read_fields(&mut self, cx: &mut Context<Self>) {
        self.now_ms = Local::now().timestamp_millis();
        let date = self.date.read(cx).date().start();
        let clock = self.clock.read(cx).value();
        let values = &mut self.values;
        values.title = self.title.read(cx).value().to_string();
        values.note = self.note.read(cx).value().to_string();
        values.set_run_at(&Local, date, &clock);
        values.cron = self.cron.read(cx).value().to_string();
        values.chat_id = self.chat_id.read(cx).value().to_string();
        if let Some(recurrence) = self.recurrence.read(cx).selected_value() {
            values.recurrence = *recurrence;
        }
        if let Some(method) = self.method.read(cx).selected_value() {
            values.method = *method;
        }
        if let Some(platform) = self.platform.read(cx).selected_value() {
            values.platform = platform.clone();
        }
        cx.notify();
    }

    /// A preset writes the task time's date and clock; the repeat rule
    /// stays as it is.
    pub fn apply_preset(&mut self, preset: Preset, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitting {
            return;
        }
        let at = crate::form::LocalTime::of(&preset.run_at(&Local::now()));
        self.set_run_at(at, window, cx);
    }

    fn set_run_at(
        &mut self,
        at: crate::form::LocalTime,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.date.update(cx, |date, cx| date.set_date(at.date, window, cx));
        self.clock.update(cx, |clock, cx| clock.set_value(at.clock(), window, cx));
        self.read_fields(cx);
    }

    /// Use template: the template's title, notes, cron rule, and next run.
    pub fn apply_template(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(template) = TEMPLATES.get(index) else {
            return;
        };
        if self.submitting {
            return;
        }
        let locale = Locale::current(cx);
        let seed = FormSeed::template(template, &Local::now(), locale);
        self.title.update(cx, |title, cx| title.set_value(seed.title.clone(), window, cx));
        self.note.update(cx, |note, cx| note.set_value(seed.note.clone(), window, cx));
        self.cron.update(cx, |cron, cx| cron.set_value(seed.cron.clone(), window, cx));
        self.chat_id.update(cx, |chat_id, cx| chat_id.set_value(seed.chat_id.clone(), window, cx));
        self.recurrence
            .update(cx, |select, cx| select.set_selected_value(&seed.recurrence, window, cx));
        self.method.update(cx, |select, cx| select.set_selected_value(&seed.method, window, cx));
        self.platform
            .update(cx, |select, cx| select.set_selected_value(&seed.platform, window, cx));
        self.title_touched = true;
        self.set_run_at(seed.run_at, window, cx);
    }

    /// Create or Save: once, while the form is valid; the dialog stays
    /// until the Host has answered.
    pub fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.submitting {
            return;
        }
        self.read_fields(cx);
        let Some(submission) = submission(&self.seed, &self.values, self.now_ms) else {
            self.title_touched = true;
            return;
        };
        let input = match submission {
            Submission::Create(input) => ScheduledTaskMutateInput::Create { input },
            Submission::Update { task_id, patch } => {
                ScheduledTaskMutateInput::Update { task_id, patch }
            }
        };
        self.submitting = true;
        self.failure = None;
        cx.notify();
        let sent = self.catalog.update(cx, |catalog, cx| catalog.submit(input, cx));
        self._submit = Some(cx.spawn_in(window, async move |this, cx| {
            let outcome = sent.await;
            this.update(cx, |this, cx| {
                this.submitting = false;
                match outcome {
                    Ok(()) => cx.emit(TaskFormEvent::Done),
                    Err(failure) => this.failure = Some(failure),
                }
                cx.notify();
            })
            .ok();
        }));
    }

    /// The dialog, built every time it draws, so it follows the fields.
    pub fn dialog(
        &mut self,
        dialog: Dialog,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Dialog {
        let width = window.rem_size() * FORM_WIDTH_REMS;
        let editing = self.seed.is_editing();
        let busy = self.submitting;
        let locale = Locale::current(cx);
        let maka = cx.maka();
        let validation = self.validation();
        let message = |field: Field| {
            validation
                .filter(|(invalid, _)| *invalid == field)
                .filter(|_| field != Field::Title || self.title_touched)
                .map(|(_, text)| {
                    StatusLine::error(
                        format!("scheduled-task-error-{}", field_key(field)),
                        text.in_locale(locale),
                    )
                })
        };
        let title_text = if editing { copy::FORM_EDIT_TITLE } else { copy::FORM_CREATE_TITLE };
        let templates = (!editing).then(|| {
            let form = cx.entity().downgrade();
            // Desktop's ghost button: no fill at rest.
            control_button(Button::new("scheduled-task-template").ghost())
                .label(copy::USE_TEMPLATE.get(cx))
                .disabled(busy)
                .dropdown_menu_with_anchor(Anchor::TopRight, move |mut menu, window, cx| {
                    menu = menu.min_w(window.rem_size() * 15.);
                    for (index, template) in TEMPLATES.iter().enumerate() {
                        let form = form.clone();
                        let label = template.title.get(cx);
                        let when = template.when.get(cx);
                        menu = menu.item(
                            PopupMenuItem::element(move |_, cx| {
                                h_flex()
                                    .w_full()
                                    .gap_3()
                                    .child(div().flex_1().min_w_0().truncate().child(label))
                                    .child(
                                        div()
                                            .flex_shrink_0()
                                            .text_xs()
                                            .text_color(cx.maka().ink_muted)
                                            .child(when),
                                    )
                            })
                            .on_click(move |_, window, cx| {
                                form.update(cx, |form, cx| form.apply_template(index, window, cx))
                                    .ok();
                            }),
                        );
                    }
                    menu
                })
        });
        let interval = self.values.recurrence == Recurrence::Interval;
        let agent = self.values.method == Method::AgentRun;
        let presets = h_flex()
            .id("scheduled-task-presets")
            .test_support()
            .aria_label(copy::PRESETS.get(cx))
            .flex_wrap()
            .gap_2()
            .children(Preset::ALL.map(|preset| {
                quiet_button(
                    Button::new(domain_element_id("scheduled-task-preset", preset.key())),
                    cx,
                )
                .h_7()
                .label(preset.label().get(cx))
                .disabled(busy || interval)
                .on_click(cx.listener(move |this, _: &ClickEvent, window, cx| {
                    this.apply_preset(preset, window, cx)
                }))
            }));
        let time = h_flex()
            .gap_2()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(DatePicker::new(&self.date).disabled(busy || interval)),
            )
            .child(
                div().w(rems(6.)).child(
                    Input::new(&self.clock)
                        .field_fill(cx)
                        .px_3()
                        .aria_label(copy::FIELD_CLOCK.get(cx))
                        .disabled(busy || interval),
                ),
            );
        // Desktop's FormLayout of plain labelled fields: one `FieldBlock`
        // each, 16px apart, the required ones marked as Desktop's
        // `isRequired`; the two group labels are supporting text at 500.
        let block = |key: &'static str| FieldBlock::new(key).domain("scheduled-task-field");
        let mut content = v_flex()
            .id("scheduled-task-form")
            .test_support()
            .child(
                block("title")
                    .field(
                        copy::FIELD_TITLE.get(cx),
                        Input::new(&self.title)
                            .field_fill(cx)
                            .id("scheduled-task-title-input")
                            .px_3()
                            .aria_label(copy::FIELD_TITLE.get(cx))
                            .disabled(busy),
                    )
                    .required(true)
                    .status(message(Field::Title)),
            )
            .child(
                block("note").field(
                    copy::FIELD_NOTE.get(cx),
                    Textarea::new(&self.note)
                        .field_fill(cx)
                        .aria_label(copy::FIELD_NOTE.get(cx))
                        .disabled(busy),
                ),
            )
            .child(group_label("schedule", copy::GROUP_SCHEDULE.get(cx), cx))
            .child(
                block("time")
                    .field(copy::FIELD_TIME.get(cx), time)
                    .required(true)
                    .status(message(Field::Time)),
            )
            .child(div().py_2().child(presets))
            .child(
                block("recurrence").field(
                    copy::FIELD_RECURRENCE.get(cx),
                    Select::new(&self.recurrence)
                        .px_3()
                        .accessibility_label(copy::FIELD_RECURRENCE.get(cx))
                        .disabled(busy || interval),
                ),
            );
        if self.values.recurrence == Recurrence::Cron {
            content = content.child(
                block("cron")
                    .field(
                        copy::FIELD_CRON.get(cx),
                        Input::new(&self.cron)
                            .field_fill(cx)
                            .px_3()
                            .aria_label(copy::FIELD_CRON.get(cx))
                            .disabled(busy),
                    )
                    .required(true)
                    .status(message(Field::Cron)),
            );
        }
        content = content.child(group_label("delivery", copy::GROUP_DELIVERY.get(cx), cx)).child(
            block("method").field(
                copy::FIELD_CHANNEL.get(cx),
                Select::new(&self.method)
                    .px_3()
                    .accessibility_label(copy::FIELD_CHANNEL.get(cx))
                    .disabled(busy || agent),
            ),
        );
        if self.values.method == Method::Bot {
            content = content
                .child(
                    block("platform")
                        .field(
                            copy::FIELD_PLATFORM.get(cx),
                            Select::new(&self.platform)
                                .px_3()
                                .accessibility_label(copy::FIELD_PLATFORM.get(cx))
                                .disabled(busy),
                        )
                        .help(copy::delivery_help(locale, &delivery_providers(locale))),
                )
                .child(
                    block("chat-id")
                        .field(
                            copy::FIELD_CHAT_ID.get(cx),
                            Input::new(&self.chat_id)
                                .field_fill(cx)
                                .px_3()
                                .aria_label(copy::FIELD_CHAT_ID.get(cx))
                                .disabled(busy),
                        )
                        .required(true)
                        .status(message(Field::ChatId)),
                );
        }
        if matches!(self.values.method, Method::Local | Method::Bot) {
            content = content.child(
                div()
                    .id("scheduled-task-form-desktop")
                    .test_support()
                    .py_2()
                    .text_xs()
                    .line_height(rems(1.25))
                    .text_color(maka.ink_muted)
                    .child(copy::DESKTOP_DELIVERS.get(cx)),
            );
        }
        let failure = self.failure.as_ref().map(|failure| failure_line(failure, cx));
        let content = content.children(failure);
        let can_send = submission(&self.seed, &self.values, self.now_ms).is_some();
        let label = match (editing, busy) {
            (true, true) => copy::SAVING,
            (true, false) => copy::SAVE,
            (false, true) => copy::CREATING,
            (false, false) => copy::CREATE_BUTTON,
        };
        let footer = h_flex().w_full().justify_end().child(
            control_button(Button::new("scheduled-task-submit").primary())
                .label(label.get(cx))
                .loading(busy)
                .disabled(!can_send || busy)
                .on_click(cx.listener(|this, _: &ClickEvent, window, cx| this.submit(window, cx))),
        );
        let header = DialogHeader::new(title_text.get(cx))
            .id("scheduled-task-form-title")
            .when_some(templates, |header, templates| header.action(templates))
            .closable(!busy);
        floating_surface(dialog, cx)
            .w(width)
            .overlay_closable(false)
            .keyboard(!busy)
            .with_header(header)
            .child(content)
            .with_footer(footer)
    }
}

fn failure_line(failure_value: &ActionFailure, cx: &App) -> AnyElement {
    failure("scheduled-task-form-failure", failure_value, cx)
}

/// A group label of the form (Desktop's `Text type="supporting"
/// weight="medium"`): 12/20 at 500, muted, in the fields' rhythm.
fn group_label(key: &'static str, label: &str, cx: &App) -> AnyElement {
    div()
        .id(domain_element_id("scheduled-task-group", key))
        .test_support()
        .aria_label(label.to_owned())
        .py_2()
        .text_xs()
        .line_height(rems(1.25))
        .font_medium()
        .text_color(cx.maka().ink_muted)
        .child(label.to_owned())
        .into_any_element()
}

fn field_key(field: Field) -> &'static str {
    match field {
        Field::Title => "title",
        Field::Time => "time",
        Field::Cron => "cron",
        Field::ChatId => "chat-id",
    }
}

/// Cuts `input` to `limit` characters, as Desktop's fields do.
fn cap(input: &Entity<InputState>, limit: usize, window: &mut Window, cx: &mut App) {
    let value = input.read(cx).value();
    if value.chars().count() > limit {
        let kept: SharedString = value.chars().take(limit).collect::<String>().into();
        input.update(cx, |input, cx| input.set_value(kept, window, cx));
    }
}

fn choice_select<V: Clone + PartialEq + 'static>(
    choices: Vec<Choice<V>>,
    selected: &V,
    window: &mut Window,
    cx: &mut App,
) -> Entity<ChoiceSelect<V>> {
    let selected = selected.clone();
    cx.new(|cx| {
        let mut select = ChoiceSelect::new(choices, None, window, cx);
        select.set_selected_value(&selected, window, cx);
        select
    })
}

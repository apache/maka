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

mod view;
use super::catalog::Model;
use crate::editor::Editor;
use maka_protocol::{configuration::ModelOverride, session::ThinkingLevel};
use serde_json::{Value, json};
pub(super) use view::{draw, input, sheet};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Back,
    Field(usize),
    Adjust(usize, bool),
    Default(usize),
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Back => "model-profile-back",
            Self::Default(_) => "thinking-default",
            _ => "connection-model-overrides",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Field {
    Text(&'static str),
    Number(&'static str),
    Boolean(&'static str),
    Protocol,
    Level(ThinkingLevel),
    Advanced,
    Capability(&'static str),
    Modalities,
    Modality(&'static str, &'static str),
    ServiceTier,
}
impl Field {
    fn key(self) -> &'static str {
        match self {
            Self::Text(key) | Self::Number(key) | Self::Boolean(key) => key,
            Self::Protocol => "apiProtocol",
            Self::Level(_) => "thinkingLevels",
            Self::Advanced => "advanced",
            Self::Capability(key) => key,
            Self::Modalities | Self::Modality(_, _) => "modalities",
            Self::ServiceTier => "serviceTier",
        }
    }
    fn label(self) -> &'static str {
        match self.key() {
            "displayName" => "model-profile-name",
            "contextWindow" => "model-profile-context",
            "inputLimit" => "model-profile-input",
            "compactionThreshold" => "model-profile-compaction",
            "maxOutputTokens" => "model-profile-output",
            "vision" => "model-profile-vision",
            "codeMode" => "model-profile-code",
            "applyPatch" => "model-profile-patch",
            "description" => "model-profile-description",
            "knowledgeCutoff" => "model-profile-cutoff",
            "apiProtocol" => "model-profile-protocol",
            "advanced" => "model-profile-advanced",
            "chat" => "model-profile-chat",
            "reasoning" => "model-profile-reasoning",
            "functionCalling" => "model-profile-tools",
            "parallelToolCalls" => "model-profile-parallel",
            "imageGeneration" => "model-profile-images",
            "webSearch" => "model-profile-web",
            "modalities" => "model-profile-modalities",
            "serviceTier" => "model-profile-tier",
            _ => "session-thinking",
        }
    }
    fn editable(self) -> bool {
        matches!(self, Self::Text(_) | Self::Number(_))
    }
}
struct Text {
    field: Field,
    original: String,
    editor: Editor,
}
pub(super) struct Draft {
    pub id: String,
    fields: Vec<Field>,
    values: Value,
    texts: Vec<Text>,
    default_context: Option<u64>,
    default_input: Option<u64>,
}
const LEVELS: [ThinkingLevel; 7] = [
    ThinkingLevel::Off,
    ThinkingLevel::Minimal,
    ThinkingLevel::Low,
    ThinkingLevel::Medium,
    ThinkingLevel::High,
    ThinkingLevel::Xhigh,
    ThinkingLevel::Max,
];
impl Draft {
    pub fn new(model: &Model, profile: ModelOverride) -> Self {
        use Field::*;
        let mut fields = vec![
            Text("displayName"),
            Number("contextWindow"),
            Number("inputLimit"),
            Number("maxOutputTokens"),
            Number("compactionThreshold"),
            Boolean("vision"),
            Boolean("codeMode"),
            Boolean("applyPatch"),
            Protocol,
        ];
        fields.extend(LEVELS.map(Level));
        fields.extend([Text("description"), Text("knowledgeCutoff")]);
        fields.push(Advanced);
        let values = serde_json::to_value(profile).expect("model override");
        let texts = fields
            .iter()
            .filter(|field| field.editable())
            .map(|&field| {
                let original = match &values[field.key()] {
                    Value::String(s) => s.clone(),
                    Value::Number(n) => n.to_string(),
                    _ => String::new(),
                };
                let mut editor = Editor::bounded(8192, "model-profile-text-limit");
                editor.insert(&original);
                super::profile::Text {
                    field,
                    original,
                    editor,
                }
            })
            .collect();
        Self {
            id: model.id.clone(),
            fields,
            values,
            texts,
            default_context: model.default_context,
            default_input: model.default_input,
        }
    }
    pub fn invalidate_geometry(&mut self) {
        for text in &mut self.texts {
            text.editor.invalidate_geometry();
        }
    }
    pub fn accepts(&self, command: &Command) -> bool {
        match command {
            Command::Back => true,
            Command::Field(index) | Command::Default(index) => *index < self.fields.len(),
            Command::Adjust(index, _) => self.fields.get(*index).is_some_and(|field| {
                !field.editable()
                    && (!matches!(field, Field::Modality(_, _))
                        || self.values["modalities"].is_object())
            }),
        }
    }
    pub fn apply(&mut self, command: Command) {
        if !self.accepts(&command) {
            return;
        }
        let (Command::Field(index) | Command::Adjust(index, _) | Command::Default(index)) = command
        else {
            return;
        };
        let field = self.fields[index];
        if field == Field::Advanced {
            if matches!(command, Command::Adjust(_, _)) {
                if self.fields.len() > index + 1 {
                    self.fields.truncate(index + 1);
                } else {
                    self.fields.extend(
                        [
                            "chat",
                            "reasoning",
                            "functionCalling",
                            "parallelToolCalls",
                            "imageGeneration",
                            "webSearch",
                        ]
                        .map(Field::Capability),
                    );
                    self.fields.push(Field::Modalities);
                    for direction in ["input", "output"] {
                        self.fields.extend(
                            ["text", "image", "audio", "pdf", "video"]
                                .map(|kind| Field::Modality(direction, kind)),
                        );
                    }
                    self.fields.push(Field::ServiceTier);
                }
                self.invalidate_geometry();
            }
            return;
        }
        if matches!(command, Command::Default(_)) {
            if let Some(text) = self.texts.iter_mut().find(|text| text.field == field) {
                text.editor = Editor::bounded(8192, "model-profile-text-limit");
            }
            if let Field::Modality(direction, kind) = field {
                self.set_modality(direction, kind, false);
            } else {
                self.set_value(field, Value::Null);
            }
        } else if let Command::Adjust(_, forward) = command {
            match field {
                Field::Level(level) => {
                    let mut levels: Vec<ThinkingLevel> =
                        serde_json::from_value(self.values["thinkingLevels"].clone())
                            .unwrap_or_default();
                    if let Some(i) = levels.iter().position(|old| *old == level) {
                        levels.remove(i);
                    } else {
                        levels.push(level);
                    }
                    let ordered: Vec<_> = LEVELS
                        .into_iter()
                        .filter(|level| levels.contains(level))
                        .collect();
                    if ordered.is_empty() {
                        self.values
                            .as_object_mut()
                            .unwrap()
                            .remove("thinkingLevels");
                    } else {
                        self.values["thinkingLevels"] = json!(ordered);
                    }
                }
                Field::Boolean(_) | Field::Capability(_) => {
                    let choices = [Value::Null, json!(true), json!(false)];
                    self.cycle(field, &choices, forward);
                }
                Field::Protocol => self.cycle(
                    field,
                    &[
                        Value::Null,
                        json!("openai-chat"),
                        json!("openai-responses"),
                        json!("anthropic-messages"),
                    ],
                    forward,
                ),
                Field::ServiceTier => self.cycle(field, &[Value::Null, json!("fast")], forward),
                Field::Modalities => {
                    let value = if self.values["modalities"].is_object() {
                        Value::Null
                    } else {
                        json!({"input":[],"output":[]})
                    };
                    self.set_value(field, value);
                }
                Field::Modality(direction, kind) => {
                    let selected = self.values["modalities"][direction]
                        .as_array()
                        .is_some_and(|items| items.contains(&json!(kind)));
                    self.set_modality(direction, kind, !selected);
                }
                _ => {}
            }
        }
    }
    fn field_value(&self, field: Field) -> &Value {
        if let Field::Capability(key) = field {
            &self.values["capabilities"][key]
        } else {
            &self.values[field.key()]
        }
    }
    fn set_value(&mut self, field: Field, value: Value) {
        if let Field::Capability(key) = field {
            if !value.is_null() && !self.values["capabilities"].is_object() {
                self.values["capabilities"] = json!({});
            }
            if let Some(caps) = self.values["capabilities"].as_object_mut() {
                if value.is_null() {
                    caps.remove(key);
                } else {
                    caps.insert(key.into(), value);
                }
                if caps.is_empty() {
                    self.values.as_object_mut().unwrap().remove("capabilities");
                }
            }
        } else if value.is_null() {
            self.values.as_object_mut().unwrap().remove(field.key());
        } else {
            self.values[field.key()] = value;
        }
    }
    fn set_modality(&mut self, direction: &str, kind: &str, selected: bool) {
        if let Some(items) = self
            .values
            .get_mut("modalities")
            .and_then(|modalities| modalities.get_mut(direction))
            .and_then(Value::as_array_mut)
        {
            items.retain(|item| item != kind);
            if selected {
                items.push(json!(kind));
            }
        }
    }
    fn cycle(&mut self, field: Field, choices: &[Value], forward: bool) {
        let current = choices
            .iter()
            .position(|v| v == self.field_value(field))
            .unwrap_or(0);
        let next = (current + if forward { 1 } else { choices.len() - 1 }) % choices.len();
        self.set_value(field, choices[next].clone());
    }
    pub fn value(&self) -> Result<ModelOverride, &'static str> {
        let mut values = self.values.clone();
        for text in &self.texts {
            let value = text.editor.text();
            if value == text.original {
                continue;
            }
            if value.trim().is_empty() {
                values.as_object_mut().unwrap().remove(text.field.key());
            } else {
                values[text.field.key()] = if matches!(text.field, Field::Number(_)) {
                    json!(tokens(value).ok_or("model-profile-number-invalid")?)
                } else {
                    json!(value)
                };
            }
        }
        let profile: ModelOverride =
            serde_json::from_value(values).map_err(|_| "model-profile-invalid")?;
        let context = profile.context_window.or(self.default_context);
        let input = profile.input_limit.or(self.default_input);
        if matches!((context,input),(Some(context),Some(input)) if input>context) {
            return Err("model-profile-limits-conflict");
        }
        maka_protocol::configuration::validation::profiles(&std::collections::BTreeMap::from([(
            self.id.clone(),
            profile.clone(),
        )]))
        .map_err(|_| "model-profile-invalid")?;
        Ok(profile)
    }
}

// Decimal token units, not bytes. Shift digits exactly; never round fractional tokens.
fn tokens(text: &str) -> Option<u64> {
    let text = text.trim();
    let (digits, places) = match text.as_bytes().last()? {
        b'k' | b'K' => (&text[..text.len() - 1], 3),
        b'm' | b'M' => (&text[..text.len() - 1], 6),
        _ => (text, 0),
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    if whole.is_empty()
        || !whole.bytes().all(|b| b.is_ascii_digit())
        || !fraction.bytes().all(|b| b.is_ascii_digit())
        || (digits.contains('.') && fraction.is_empty())
    {
        return None;
    }
    if fraction.bytes().skip(places).any(|b| b != b'0') {
        return None;
    }
    let mut shifted = whole.parse::<u64>().ok()?;
    for i in 0..places {
        shifted = shifted.checked_mul(10)?.checked_add(u64::from(
            fraction.as_bytes().get(i).copied().unwrap_or(b'0') - b'0',
        ))?;
    }
    (shifted > 0 && shifted <= 9_007_199_254_740_991).then_some(shifted)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_dialog_keeps_full_inventory_and_keyboard_mouse_geometry_across_sizes() {
        use crate::{
            Locale, LocalePreference,
            app::{Action, App, ConnectionState},
            i18n::I18n,
            navigation::Route,
            pages::manage::{Command as Manage, Kind, connection::Change},
        };
        use crossterm::event::{
            Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
        };
        use ratatui::{Terminal, backend::TestBackend};
        for locale in Locale::ALL {
            let mut app = App::new(
                "/fixture".into(),
                I18n::new(LocalePreference::Explicit(locale), locale),
            );
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "epoch".into(),
            };
            app.apply(Action::Visit(Route::Connections));
            app.connections.query().unwrap();
            let page = json!({"kind":"page","revision":9,"connectionCount":1,"defaultTarget":null,"nextCursor":null,"items":[
                {"kind":"connection","connectionIndex":0,"connectionId":"c","revision":3,"slug":"fixture","name":"Fixture","provider":crate::providers::fixtures::entry("openai-compatible", false).identity,"configuration":{"baseUrl":"http://127.0.0.1/v1"},"enabled":true,"enabledModelIdCount":1,"catalogEntryCount":2},
                {"kind":"enabled_model_id","connectionIndex":0,"itemIndex":0,"modelId":"m"},
                {"kind":"catalog_entry","connectionIndex":0,"itemIndex":0,"entry":{"id":"m","defaultContextWindow":128000,"defaultInputLimit":64000},"modelOverride":{"contextWindow":256000,"modalities":{"input":["text"],"output":["text"]}}},
                {"kind":"catalog_entry","connectionIndex":0,"itemIndex":1,"entry":{"id":"neighbor"},"modelOverride":{"vision":false,"codeMode":false}}
            ]});
            app.connections.complete(Ok(page.clone()));
            let action = app
                .management_commands()
                .into_iter()
                .find(|(action, _)| {
                    matches!(
                        action,
                        Action::Manage(Manage::Open(_, Kind::Connection(Change::ModelOverrides)))
                    )
                })
                .unwrap()
                .0;
            app.apply(action);
            let mut screen = Terminal::new(TestBackend::new(120, 40)).unwrap();
            screen
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            let request = app.enabled_models_request().unwrap();
            app.enabled_models_completed(request, Ok(page));
            screen
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            app.apply(Action::Manage(Manage::EnabledModels(
                super::super::Command::Toggle("m".into()),
            )));
            assert!(!app.management_enabled(&Manage::Save));
            // Opening advanced controls is presentation only and keeps drafts.
            app.apply(Action::Manage(Manage::EnabledModels(
                super::super::Command::Profile(Command::Adjust(18, true)),
            )));
            assert!(!app.management_enabled(&Manage::Save));
            for (width, height) in [(48, 22), (80, 24), (120, 40)] {
                screen = Terminal::new(TestBackend::new(width, height)).unwrap();
                screen
                    .draw(|frame| crate::view::draw(frame, &mut app))
                    .unwrap();
                // Every setting, advanced ones included, can take focus and be seen.
                for index in 0..37 {
                    let path = format!("fields/rows/{index}");
                    app.layer.focus_path(&path);
                    screen
                        .draw(|frame| crate::view::draw(frame, &mut app))
                        .unwrap();
                    assert!(app.management.dialog.as_ref().unwrap().visible);
                    assert!(
                        app.layer.rect(&path).is_some_and(|rect| !rect.is_empty()),
                        "focused setting {index} is scrolled into view at {width}x{height}"
                    );
                }
                assert!(
                    app.i18n.diagnostics().is_empty(),
                    "{:?}",
                    app.i18n.diagnostics()
                );
                // Choosing a visible setting never jumps the viewport.
                let before = app.layer.rect("fields/rows/30");
                app.apply(Action::Manage(Manage::EnabledModels(
                    super::super::Command::Profile(Command::Field(30)),
                )));
                screen
                    .draw(|frame| crate::view::draw(frame, &mut app))
                    .unwrap();
                assert_eq!(app.layer.rect("fields/rows/30"), before);
            }
            app.layer.focus_path("fields/rows/1");
            screen
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Char('a'),
                KeyModifiers::CONTROL,
            )));
            app.input(Event::Paste("128K".into()));
            assert!(app.management_enabled(&Manage::Save));
            screen
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            let area = app.layer.rect("fields/rows/1").unwrap();
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: area.x + 20,
                row: area.y,
                modifiers: KeyModifiers::NONE,
            }));
            screen
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Drag(MouseButton::Left),
                column: area.x + 22,
                row: area.y,
                modifiers: KeyModifiers::NONE,
            }));
            assert!(
                app.management
                    .dialog
                    .as_ref()
                    .unwrap()
                    .enabled_models
                    .as_ref()
                    .unwrap()
                    .profile
                    .as_ref()
                    .unwrap()
                    .texts
                    .iter()
                    .find(|t| t.field == Field::Number("contextWindow"))
                    .unwrap()
                    .editor
                    .dragging()
            );
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Up(MouseButton::Left),
                column: area.x + 22,
                row: area.y,
                modifiers: KeyModifiers::NONE,
            }));
            let ticket = app.management_request().unwrap();
            let profiles = ticket.model_overrides.as_ref().unwrap();
            assert_eq!(profiles["m"].context_window, Some(128000));
            assert!(profiles["m"].modalities.is_some());
            assert_eq!(profiles["neighbor"].vision, Some(false));
            assert_eq!(profiles["neighbor"].code_mode, Some(false));
            assert!(ticket.enabled_model_ids.is_none());
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: 0,
                row: 0,
                modifiers: KeyModifiers::NONE,
            }));
            assert!(app.management.dialog.is_none());
            assert!(app.management_request().is_none());
        }
    }
    #[test]
    fn profile_edits_are_exact_preserve_unexposed_fields_and_distinguish_default_from_false() {
        for (input, expected) in [
            ("128K", 128000),
            ("1.001K", 1001),
            ("1M", 1000000),
            ("1.0000000", 1),
        ] {
            assert_eq!(tokens(input), Some(expected));
        }
        for invalid in [
            "0",
            "-1",
            "1.1",
            "1.0001K",
            "1e3",
            "1.K",
            "NaN",
            "9007199254740992",
            "１２Ｋ",
        ] {
            assert_eq!(tokens(invalid), None);
        }
        let model = Model {
            id: "m".into(),
            name: "Model".into(),
            default_context: Some(128000),
            default_input: Some(100000),
        };
        let original: ModelOverride = serde_json::from_value(json!({"vision":false,"contextWindow":256000,"capabilities":{"parallelToolCalls":false},"modalities":{"input":["text","image"],"output":["text"]},"serviceTier":"fast"})).unwrap();
        let mut draft = Draft::new(&model, original.clone());
        assert_eq!(draft.value().unwrap(), original);
        let index = draft
            .fields
            .iter()
            .position(|field| *field == Field::Number("contextWindow"))
            .unwrap();
        draft.apply(Command::Default(index));
        assert_eq!(draft.value().unwrap().context_window, None);
        let editor = &mut draft
            .texts
            .iter_mut()
            .find(|text| text.field == Field::Number("contextWindow"))
            .unwrap()
            .editor;
        editor.insert("64K");
        assert_eq!(draft.value().unwrap_err(), "model-profile-limits-conflict");
        let editor = &mut draft
            .texts
            .iter_mut()
            .find(|text| text.field == Field::Number("inputLimit"))
            .unwrap()
            .editor;
        editor.insert("32K");
        let edited = draft.value().unwrap();
        assert_eq!(edited.context_window, Some(64000));
        assert_eq!(edited.input_limit, Some(32000));
        assert_eq!(edited.capabilities, original.capabilities);
        assert_eq!(edited.modalities, original.modalities);
        assert_eq!(edited.service_tier, original.service_tier);
        let index = draft
            .fields
            .iter()
            .position(|field| *field == Field::Boolean("vision"))
            .unwrap();
        draft.apply(Command::Adjust(index, true));
        assert_eq!(draft.value().unwrap().vision, None);
        draft.apply(Command::Adjust(index, true));
        assert_eq!(draft.value().unwrap().vision, Some(true));
        let index = draft
            .fields
            .iter()
            .position(|field| *field == Field::Level(ThinkingLevel::Off))
            .unwrap();
        draft.apply(Command::Adjust(index, true));
        assert_eq!(
            draft.value().unwrap().thinking_levels,
            Some(vec![ThinkingLevel::Off])
        );
        draft.apply(Command::Adjust(index, true));
        assert_eq!(draft.value().unwrap().thinking_levels, None);
        let before_advanced = draft.value().unwrap();
        let advanced = draft
            .fields
            .iter()
            .position(|field| *field == Field::Advanced)
            .unwrap();
        draft.apply(Command::Adjust(advanced, true));
        assert_eq!(draft.value().unwrap(), before_advanced);
        let index = draft
            .fields
            .iter()
            .position(|field| *field == Field::Capability("parallelToolCalls"))
            .unwrap();
        draft.apply(Command::Adjust(index, true));
        assert_eq!(draft.value().unwrap().capabilities, None);
        draft.apply(Command::Adjust(index, false));
        assert_eq!(
            draft
                .value()
                .unwrap()
                .capabilities
                .unwrap()
                .parallel_tool_calls,
            Some(false)
        );
        let index = draft
            .fields
            .iter()
            .position(|field| *field == Field::Modality("output", "audio"))
            .unwrap();
        draft.apply(Command::Adjust(index, true));
        let modalities = draft.value().unwrap().modalities.unwrap();
        assert_eq!(
            serde_json::to_value(modalities).unwrap(),
            json!({"input":["text","image"],"output":["text","audio"]})
        );
        let mode = draft
            .fields
            .iter()
            .position(|field| *field == Field::Modalities)
            .unwrap();
        draft.apply(Command::Default(mode));
        assert_eq!(draft.value().unwrap().modalities, None);
        assert!(!draft.accepts(&Command::Adjust(index, true)));
        draft.apply(Command::Default(index));
        assert_eq!(
            draft.value().unwrap().modalities,
            None,
            "clearing an inherited checkbox must not create a declaration"
        );
        draft.apply(Command::Adjust(mode, true));
        assert_eq!(
            serde_json::to_value(draft.value().unwrap().modalities).unwrap(),
            json!({"input":[],"output":[]})
        );
        let tier = draft
            .fields
            .iter()
            .position(|field| *field == Field::ServiceTier)
            .unwrap();
        draft.apply(Command::Default(tier));
        assert!(draft.value().unwrap().service_tier.is_none());
        draft.apply(Command::Adjust(tier, true));
        assert_eq!(
            serde_json::to_value(draft.value().unwrap().service_tier).unwrap(),
            json!("fast")
        );
        let edited = draft.value().unwrap();
        draft.apply(Command::Adjust(advanced, true));
        assert_eq!(
            draft.value().unwrap(),
            edited,
            "collapsing advanced settings must preserve edits"
        );
        assert!(
            !draft.accepts(&Command::Adjust(tier, true)),
            "collapsed controls are not actionable"
        );
    }
}

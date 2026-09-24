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
pub(super) use view::VALUE;

use super::Command;
use crate::editor::Editor;
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use maka_protocol::capability::form::{
    FormField, FormFieldSpec, FormRequester, FormResult, FormValue,
};
use std::collections::BTreeMap;

struct Draft {
    value: Option<FormValue>,
    editor: Editor,
    present: bool,
}
pub struct Form {
    message: String,
    requester: FormRequester,
    fields: Vec<FormField>,
    drafts: Vec<Draft>,
    current: usize,
}
impl Form {
    pub fn new(message: String, requester: FormRequester, fields: Vec<FormField>) -> Self {
        let drafts = fields
            .iter()
            .map(|field| {
                let value = match &field.spec {
                    FormFieldSpec::String { default, .. }
                    | FormFieldSpec::SingleSelect { default, .. } => {
                        default.clone().map(FormValue::String)
                    }
                    FormFieldSpec::Number { default, .. }
                    | FormFieldSpec::Integer { default, .. } => default.map(FormValue::Number),
                    FormFieldSpec::Boolean { default } => default.map(FormValue::Boolean),
                    FormFieldSpec::MultiSelect { default, .. } => {
                        default.clone().map(FormValue::Strings)
                    }
                };
                let mut editor = Editor::bounded(2048, "form-too-large");
                if matches!(
                    field.spec,
                    FormFieldSpec::String { .. }
                        | FormFieldSpec::Number { .. }
                        | FormFieldSpec::Integer { .. }
                ) {
                    match &value {
                        Some(FormValue::String(text)) => {
                            editor.insert(text);
                        }
                        Some(FormValue::Number(number)) => {
                            editor.insert(&number.to_string());
                        }
                        _ => {}
                    }
                }
                let present = match &value {
                    Some(FormValue::String(text))
                        if matches!(field.spec, FormFieldSpec::String { .. }) =>
                    {
                        editor.text() == text
                    }
                    _ => value.is_some(),
                };
                Draft {
                    present,
                    value,
                    editor,
                }
            })
            .collect();
        Self {
            message,
            requester,
            fields,
            drafts,
            current: 0,
        }
    }
    pub fn invalidate_geometry(&mut self) {
        for draft in &mut self.drafts {
            draft.editor.invalidate_geometry();
        }
    }
    fn editable(&self) -> bool {
        self.fields.get(self.current).is_some_and(|field| {
            matches!(
                field.spec,
                FormFieldSpec::String { .. }
                    | FormFieldSpec::Number { .. }
                    | FormFieldSpec::Integer { .. }
            )
        })
    }
    fn options(&self) -> usize {
        let Some(field) = self.fields.get(self.current) else {
            return 0;
        };
        match &field.spec {
            FormFieldSpec::Boolean { .. } => 2,
            FormFieldSpec::SingleSelect { options, .. }
            | FormFieldSpec::MultiSelect { options, .. } => options.len(),
            _ => 0,
        }
    }
    fn controls(&self) -> Vec<Command> {
        let mut controls = vec![Command::Close];
        if self.current > 0 {
            controls.push(Command::Field(self.current - 1));
        }
        if self.current + 1 < self.fields.len() {
            controls.push(Command::Field(self.current + 1));
        }
        if self.editable() {
            controls.push(Command::FreeText);
        }
        controls.extend((0..self.options()).map(Command::Option));
        if self.fields.get(self.current).is_some_and(|field| {
            matches!(
                field.spec,
                FormFieldSpec::String { .. } | FormFieldSpec::MultiSelect { .. }
            )
        }) {
            controls.push(Command::Empty);
        }
        if !self.fields.is_empty() {
            controls.push(Command::Omit);
        }
        controls.extend([
            Command::FormSubmit,
            Command::FormDecline,
            Command::FormCancel,
        ]);
        controls
    }
    pub fn accepts(&self, command: Command) -> bool {
        self.controls().contains(&command)
    }
    fn value(&self, index: usize) -> Result<Option<FormValue>, &'static str> {
        let field = &self.fields[index];
        let draft = &self.drafts[index];
        if !draft.present {
            return if field.required {
                Err("form-required")
            } else {
                Ok(None)
            };
        }
        let value = match &field.spec {
            FormFieldSpec::String { .. } => FormValue::String(draft.editor.text().into()),
            FormFieldSpec::Number { .. } | FormFieldSpec::Integer { .. } => {
                // Use JSON number syntax, not Rust-only spellings such as inf or NaN.
                let number = serde_json::from_str::<serde_json::Number>(draft.editor.text())
                    .ok()
                    .and_then(|number| number.as_f64())
                    .filter(|number| number.is_finite())
                    .ok_or("form-invalid")?;
                FormValue::Number(number)
            }
            _ => draft.value.clone().ok_or("form-required")?,
        };
        let one = FormResult::Accept {
            values: BTreeMap::from([(field.name.clone(), value.clone())]),
        };
        one.validate_for_fields(std::slice::from_ref(field))
            .map_err(|_| "form-invalid")?;
        Ok(Some(value))
    }
    pub fn result(&self) -> Option<FormResult> {
        let mut values = BTreeMap::new();
        for (index, field) in self.fields.iter().enumerate() {
            if let Some(value) = self.value(index).ok()? {
                values.insert(field.name.clone(), value);
            }
        }
        let result = FormResult::Accept { values };
        result.validate().ok()?;
        result.validate_for_fields(&self.fields).ok()?;
        Some(result)
    }
    pub fn status(&self, i18n: &crate::i18n::I18n) -> String {
        if let Some(error) = self
            .drafts
            .get(self.current)
            .and_then(|draft| draft.editor.error)
        {
            return i18n.text(error);
        }
        let invalid = (0..self.fields.len())
            .find_map(|index| self.value(index).err().map(|error| (index, error)));
        if let Some((index, error)) = invalid {
            i18n.format(
                "form-error",
                &[
                    ("field", &self.fields[index].label),
                    ("error", &i18n.text(error)),
                ],
            )
        } else if self.result().is_none() {
            i18n.text("form-budget")
        } else {
            i18n.text("form-valid")
        }
    }
    pub fn apply(&mut self, command: Command) {
        if !self.accepts(command) {
            return;
        }
        let editable = self.editable();
        let Some(draft) = self.drafts.get_mut(self.current) else {
            return;
        };
        draft.editor.error = None;
        match command {
            Command::Field(index) => {
                self.current = index;
                self.invalidate_geometry();
            }
            Command::Option(index) => {
                draft.value = match &self.fields[self.current].spec {
                    FormFieldSpec::Boolean { .. } => Some(FormValue::Boolean(index == 0)),
                    FormFieldSpec::SingleSelect { options, .. } => {
                        Some(FormValue::String(options[index].value.clone()))
                    }
                    FormFieldSpec::MultiSelect { options, .. } => {
                        let mut values = match &draft.value {
                            Some(FormValue::Strings(values)) if draft.present => values.clone(),
                            _ => vec![],
                        };
                        let value = &options[index].value;
                        if let Some(position) = values.iter().position(|item| item == value) {
                            values.remove(position);
                        } else {
                            values.push(value.clone());
                        }
                        Some(FormValue::Strings(values))
                    }
                    _ => return,
                };
                draft.present = true;
            }
            Command::FreeText => draft.present = true,
            Command::Omit => draft.present = false,
            Command::Empty => {
                if editable {
                    draft.editor.key(crossterm::event::KeyEvent::new(
                        KeyCode::Char('a'),
                        KeyModifiers::CONTROL,
                    ));
                    draft.editor.key(crossterm::event::KeyEvent::new(
                        KeyCode::Backspace,
                        KeyModifiers::NONE,
                    ));
                    draft.value = Some(FormValue::String(String::new()));
                } else {
                    draft.value = Some(FormValue::Strings(vec![]));
                }
                draft.present = true;
            }
            _ => {}
        }
    }
    /// The value field's keys and pastes: writing sets the value.
    pub fn edit(&mut self, event: &Event) -> Option<bool> {
        if !self.editable() {
            return None;
        }
        let draft = &mut self.drafts[self.current];
        let before = draft.editor.text().to_owned();
        let dirty = match event {
            Event::Key(key)
                if key.kind != KeyEventKind::Release
                    && !matches!(
                        key.code,
                        KeyCode::Esc
                            | KeyCode::Tab
                            | KeyCode::BackTab
                            | KeyCode::Up
                            | KeyCode::Down
                    )
                    && !(key.modifiers.contains(KeyModifiers::CONTROL)
                        && matches!(key.code, KeyCode::Char('q' | 's'))) =>
            {
                draft.editor.key(*key)
            }
            Event::Paste(text) => draft.editor.insert(text),
            _ => return None,
        };
        if draft.editor.text() != before {
            draft.present = true;
        }
        Some(dirty)
    }

    /// The value field, when the current field is written rather than chosen.
    pub fn editor(&mut self) -> Option<&mut Editor> {
        self.editable()
            .then(|| &mut self.drafts[self.current].editor)
    }

    /// The field shown, of those in the form.
    #[cfg(test)]
    pub(super) fn position(&self) -> usize {
        self.current
    }

    /// A press in the value field includes the value.
    pub fn choose_text(&mut self) {
        if let Some(draft) = self.drafts.get_mut(self.current) {
            draft.present = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        State,
        tests::{draw, fixture},
    };
    use super::*;
    use crate::app::Action;
    use crate::{Locale, LocalePreference, app::App};
    use crossterm::event::{KeyEvent, MouseButton, MouseEvent, MouseEventKind};
    use maka_protocol::{capability::form::decode_form_input, interaction};
    use serde_json::{Value, json};

    fn fields() -> Value {
        json!([
            {"name":"text","label":"Text 中文","kind":"string","required":true,"minLength":1,"maxLength":64},
            {"name":"number","label":"Ratio","kind":"number","required":true,"minimum":0,"maximum":1,"default":0.5},
            {"name":"integer","label":"Count","kind":"integer","required":true,"minimum":1,"maximum":3,"default":2},
            {"name":"boolean","label":"Enabled","kind":"boolean","required":true,"default":false},
            {"name":"single","label":"Destination","kind":"single_select","required":true,"options":[{"label":"Shown label","value":"wire-id"},{"label":"Empty identifier","value":""}],"default":""},
            {"name":"multi","label":"Features","kind":"multi_select","required":true,"options":[{"label":"Alpha","value":"a"},{"label":"Beta","value":"b"}],"minItems":1,"maxItems":1,"default":["a"]},
            {"name":"optional","label":"Notes","kind":"string","required":false,"maxLength":64}
        ])
    }
    fn form(fields: Value) -> Form {
        let input = decode_form_input(
            &json!({"message":"Review settings","requester":{"name":"Test"},"fields":fields}),
        )
        .unwrap();
        Form::new(input.message, input.requester, input.fields)
    }
    fn edit(form: &mut Form, index: usize, text: &str) {
        form.current = index;
        form.apply(Command::FreeText);
        form.edit(&Event::Key(KeyEvent::new(
            KeyCode::Char('a'),
            KeyModifiers::CONTROL,
        )));
        form.edit(&Event::Paste(text.into()));
    }
    #[test]
    fn canonical_field_validation_preserves_defaults_omission_empty_and_wire_option_values() {
        let mut form = form(fields());
        assert!(form.result().is_none());
        edit(&mut form, 0, "中文🦀e\u{301}");
        let value = serde_json::to_value(form.result().unwrap()).unwrap();
        assert_eq!(
            value,
            json!({"action":"accept","values":{"text":"中文🦀e\u{301}","number":0.5,"integer":2.0,"boolean":false,"single":"","multi":["a"]}})
        );
        for invalid in ["1.5", "4", "9007199254740992", "NaN", "01", ""] {
            edit(&mut form, 2, invalid);
            assert!(form.result().is_none(), "{invalid}");
        }
        edit(&mut form, 2, "3");
        edit(&mut form, 1, "1e309");
        assert!(form.result().is_none());
        edit(&mut form, 1, "0.25");
        form.current = 5;
        form.apply(Command::Option(1));
        assert!(form.result().is_none(), "maximum items");
        form.apply(Command::Option(0));
        assert_eq!(
            form.value(5).unwrap(),
            Some(FormValue::Strings(vec!["b".into()]))
        );
        form.apply(Command::Empty);
        assert!(form.result().is_none(), "minimum items");
        form.apply(Command::Option(0));
        form.current = 6;
        form.apply(Command::Empty);
        assert_eq!(
            form.value(6).unwrap(),
            Some(FormValue::String(String::new()))
        );
        form.apply(Command::Omit);
        assert_eq!(form.value(6).unwrap(), None);
        form.current = 3;
        form.apply(Command::Omit);
        assert!(form.result().is_none(), "required false is not absent");
        form.apply(Command::Option(1));
        form.current = 4;
        form.apply(Command::Option(0));
        assert_eq!(
            form.value(4).unwrap(),
            Some(FormValue::String("wire-id".into()))
        );
        assert!(form.result().is_some());
        let before = form.drafts[0].editor.text().to_owned();
        form.current = 0;
        form.apply(Command::FreeText);
        form.edit(&Event::Paste("🦀".repeat(513)));
        assert_eq!(form.drafts[0].editor.text(), before);
        form.apply(Command::Omit);
        assert!(form.result().is_none());
        form.apply(Command::FreeText);
        assert!(form.result().is_some(), "unset retains recoverable draft");

        for (format, max, valid, invalid) in [
            ("date", 10, "2024-02-29", "2025-02-29"),
            (
                "date-time",
                32,
                "2026-09-22T12:00:00Z",
                "2026-09-22T25:00:00Z",
            ),
            ("email", 64, "a@b.co", "a@b"),
            ("uri", 64, "https://example.test", "relative-path"),
        ] {
            let mut form = self::form(
                json!([{"kind":"string","name":"v","label":"Value","required":true,"format":format,"maxLength":max}]),
            );
            edit(&mut form, 0, invalid);
            assert!(form.result().is_none(), "{format}");
            edit(&mut form, 0, valid);
            assert!(form.result().is_some(), "{format}");
        }
        let empty = self::form(json!([]));
        assert_eq!(
            serde_json::to_value(empty.result().unwrap()).unwrap(),
            json!({"action":"accept","values":{}})
        );
    }
    fn click(app: &mut App, command: Command) {
        draw(app, 100, 30);
        if let Some(Action::Interaction(command)) = super::super::tests::press(app, command) {
            assert!(app.interaction_request(command).is_none());
        }
    }
    #[test]
    fn form_mouse_keyboard_resize_later_and_uncertain_submission_keep_one_original_draft() {
        let mut app = fixture();
        let snapshot = app.chat.snapshot.as_mut().unwrap();
        let mut pending = serde_json::to_value(&snapshot.interactions.pending()[0]).unwrap();
        pending["request"] = json!({"kind":"form","toolUseId":"call","message":"Review settings","requester":{"name":"Fixture"},"fields":fields()});
        snapshot.interactions =
            interaction::decode_session_projection(&json!({"pending":[pending]}), "a").unwrap();
        app.open_interaction();
        let text = draw(&mut app, 100, 30);
        assert!(text.contains("Text 中文") && text.contains("required"));
        assert!(!app.interaction_enabled(Command::FormSubmit));
        assert_eq!(
            app.input(Event::Key(KeyEvent::new(
                KeyCode::Enter,
                KeyModifiers::NONE
            )))
            .1,
            Some(Action::Interaction(Command::Close))
        );
        click(&mut app, Command::FreeText);
        app.input(Event::Paste("自由填写🦀".into()));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Backspace,
            KeyModifiers::NONE,
        )));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char('z'),
            KeyModifiers::CONTROL,
        )));
        assert!(app.interaction_enabled(Command::FormSubmit));
        click(&mut app, Command::Field(1));
        click(&mut app, Command::Field(2));
        click(&mut app, Command::Field(3));
        click(&mut app, Command::Option(0));
        let (_, close) = app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert_eq!(close, Some(Action::Interaction(Command::Close)));
        assert!(
            app.interaction_request(Command::Close).is_none(),
            "dismissal sends no answer"
        );
        assert!(!app.interactions.visible);
        app.open_interaction();
        assert_eq!(
            app.interactions
                .review
                .as_ref()
                .unwrap()
                .form
                .as_ref()
                .unwrap()
                .current,
            3
        );
        for locale in Locale::ALL {
            app.i18n.preference = LocalePreference::Explicit(locale);
            for index in 0..7 {
                app.interactions
                    .review
                    .as_mut()
                    .unwrap()
                    .form
                    .as_mut()
                    .unwrap()
                    .current = index;
                for (width, height) in [(1, 1), (29, 9), (30, 10), (80, 24), (120, 40)] {
                    let text = draw(&mut app, width, height);
                    // Too small for a sheet, it only says so.
                    if width >= 80 {
                        let lines: Vec<_> = text.lines().collect();
                        let top = lines
                            .iter()
                            .position(|line| line.contains('╭'))
                            .unwrap_or_else(|| {
                                panic!("{locale:?}, field {index}, {width}x{height}:\n{text}")
                            });
                        let bottom = lines.iter().position(|line| line.contains('╰')).unwrap();
                        assert!(
                            top.abs_diff(usize::from(height) - bottom - 1) <= 1,
                            "natural-height review must remain centered after field/locale/size changes"
                        );
                    }
                }
            }
            assert!(app.i18n.diagnostics().is_empty());
        }
        let (ticket, answer) = app.interaction_request(Command::FormSubmit).unwrap();
        let answer = answer.unwrap();
        answer
            .validate_for_request(ticket.snapshot.request())
            .unwrap();
        let value = serde_json::to_value(&answer).unwrap();
        assert_eq!(value["values"]["text"], "自由填写🦀");
        assert_eq!(value["values"]["boolean"], true);
        assert_eq!(app.drafts["a"].text(), "keep draft");
        assert!(app.interaction_request(Command::FormSubmit).is_none());
        app.interaction_completed(
            ticket.clone(),
            Err(maka_client::RequestFailure::Unknown(
                maka_client::ClientError::Timeout,
            )),
        );
        assert_eq!(
            app.interactions.review.as_ref().unwrap().state,
            State::Unknown
        );
        app.interaction_request(Command::Close);
        app.open_interaction();
        assert!(app.interaction_request(Command::FormCancel).is_none());
        let (query, none) = app.interaction_request(Command::Check).unwrap();
        assert!(none.is_none());
        app.interaction_completed(query, Ok(ticket.snapshot.clone()));
        assert_eq!(
            serde_json::to_value(
                app.interactions
                    .review
                    .as_ref()
                    .unwrap()
                    .form
                    .as_ref()
                    .unwrap()
                    .result()
                    .unwrap()
            )
            .unwrap()["values"],
            value["values"]
        );
        for command in [Command::FormDecline, Command::FormCancel] {
            let (query, answer) = app.interaction_request(command).unwrap();
            assert_eq!(
                serde_json::to_value(answer.unwrap()).unwrap()["action"],
                if command == Command::FormDecline {
                    "decline"
                } else {
                    "cancel"
                }
            );
            app.interaction_completed(query, Ok(ticket.snapshot.clone()));
        }
        app.chat.snapshot.as_mut().unwrap().interactions = Default::default();
        app.sync_interaction();
        assert!(!app.interaction_enabled(Command::FormSubmit));
    }
}

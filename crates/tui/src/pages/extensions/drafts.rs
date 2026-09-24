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

use super::*;
use crate::ui::{Node, On, Size, Tone};

pub(super) struct Conflict {
    id: String,
    draft: Value,
    pub mine: Option<bool>,
}
pub(super) struct Review {
    entry: TerminalViewProjection,
    view: View,
    values: BTreeMap<String, Value>,
    pub conflicts: Vec<Conflict>,
}
impl Review {
    pub fn resolved(&self) -> bool {
        self.conflicts.iter().all(|field| field.mine.is_some())
    }
}
pub(super) fn value(control: &Control) -> Value {
    match control {
        Control::Toggle { value } => Value::Bool(*value),
        Control::Text { value, .. } | Control::Choice { value, .. } => Value::String(value.clone()),
    }
}
fn replace(control: &mut Control, draft: &Value) -> Result<(), ()> {
    match (control, draft) {
        (Control::Toggle { value }, Value::Bool(draft)) => *value = *draft,
        (Control::Text { value, .. } | Control::Choice { value, .. }, Value::String(draft)) => {
            *value = draft.clone()
        }
        _ => return Err(()),
    }
    Ok(())
}
/// Whether anything a form shows besides its values changed.
fn context_changed(old: &View, new: &View) -> bool {
    old.title != new.title || old.root != new.root
}
impl State {
    fn merge(&self, entry: TerminalViewProjection, view: View) -> Result<Review, ()> {
        let original = self.view.as_ref().ok_or(())?;
        let mut review = Review {
            entry,
            values: view
                .fields
                .iter()
                .map(|field| (field.id.clone(), value(&field.control)))
                .collect(),
            view,
            conflicts: vec![],
        };
        let mut all_drafts = review.view.clone();
        for old in &original.fields {
            let draft = self.drafts.get(&old.id).ok_or(())?;
            if draft == &value(&old.control) {
                continue;
            }
            // Never silently discard a changed field after removal, disablement,
            // a control-type change, or a tighter input constraint.
            let field = all_drafts
                .fields
                .iter_mut()
                .find(|field| field.id == old.id && field.enabled)
                .ok_or(())?;
            let current = value(&field.control);
            replace(&mut field.control, draft)?;
            if current == value(&old.control) || current == *draft {
                review.values.insert(old.id.clone(), draft.clone());
            } else {
                review.conflicts.push(Conflict {
                    id: old.id.clone(),
                    draft: draft.clone(),
                    mine: None,
                });
            }
        }
        all_drafts.validate().map_err(|_| ())?;
        Ok(review)
    }
    pub fn reload_draft(&mut self, entry: TerminalViewProjection, view: View) {
        self.blocked = true;
        let Ok(review) = self.merge(entry, view) else {
            self.message = Some(Message::Local("extensions-draft-shape-changed"));
            return;
        };
        let changed = self
            .view
            .as_ref()
            .is_some_and(|old| context_changed(old, &review.view));
        self.review = Some(review);
        if !changed && self.review.as_ref().unwrap().conflicts.is_empty() {
            self.accept_draft();
        } else {
            self.message = None;
        }
    }
    pub fn accept_draft(&mut self) {
        let Some(mut review) = self.review.take() else {
            return;
        };
        for conflict in &review.conflicts {
            if conflict.mine == Some(true) {
                review
                    .values
                    .insert(conflict.id.clone(), conflict.draft.clone());
            }
        }
        let cursors: BTreeMap<_, _> = self
            .editors
            .iter()
            .filter(|(id, editor)| {
                review.values.get(*id).and_then(Value::as_str) == Some(editor.text())
            })
            .map(|(id, editor)| (id.clone(), editor.cursor()))
            .collect();
        self.install(review.view);
        self.entry = Some(review.entry);
        self.drafts = review.values;
        for (id, editor) in &mut self.editors {
            let initial = editor.text().to_owned();
            editor.clear_if_unchanged(&initial);
            editor.insert(self.drafts[id].as_str().expect("validated text field"));
            editor.clear_history();
            if let Some(cursor) = cursors.get(id) {
                editor
                    .restore_cursor(*cursor)
                    .expect("unchanged text cursor");
            }
        }
        self.message = Some(Message::Local("extensions-draft-ready"));
    }
}

/// Reviewing a draft against the form it now belongs to: what changed
/// around it, then each conflicting field with both values to choose from.
pub(super) fn nodes(app: &App) -> Vec<Node<Command>> {
    let state = &app.extensions;
    let (Some(review), Some(original)) = (&state.review, &state.view) else {
        return vec![];
    };
    let i18n = &app.i18n;
    let lines = |key: &str, text: &str, tone: Tone| {
        Node::column(
            key.to_owned(),
            text.lines()
                .enumerate()
                .map(|(index, line)| Node::text(index.to_string(), vec![(line.to_owned(), tone)]))
                .collect(),
        )
    };
    let mut nodes = vec![Node::text(
        "review",
        vec![(i18n.text("extensions-draft-review"), Tone::Strong)],
    )];
    if context_changed(original, &review.view) {
        for (key, label, view) in [
            ("previous", "extensions-previous-form", original),
            ("current", "extensions-current-form", &review.view),
        ] {
            nodes.push(Node::column(
                key,
                vec![
                    Node::text("label", vec![(i18n.text(label), Tone::Muted)]),
                    lines("text", &tree::prose(view), Tone::Normal),
                ],
            ));
        }
    }
    let (chosen, open) = if app.chrome.ascii {
        ("(*)", "( )")
    } else {
        ("●", "○")
    };
    for (index, conflict) in review.conflicts.iter().enumerate() {
        let Some(field) = review.view.field(&conflict.id) else {
            continue;
        };
        let current = value(&field.control);
        let mut choices = vec![Node::text(
            "field",
            vec![(
                tree::label(&review.view, &conflict.id).unwrap_or_else(|| conflict.id.clone()),
                Tone::Accent,
            )],
        )];
        for mine in [true, false] {
            let command = Command::DraftChoice(index, mine);
            let content = if mine { &conflict.draft } else { &current };
            let content = content
                .as_str()
                .map_or_else(|| content.to_string(), str::to_owned);
            let mark = if conflict.mine == Some(mine) {
                chosen
            } else {
                open
            };
            choices.push(
                Node::column(
                    if mine { "mine" } else { "theirs" },
                    vec![
                        Node::text(
                            "choice",
                            vec![(
                                format!("{mark} {}", i18n.text(command.label())),
                                Tone::Normal,
                            )],
                        ),
                        lines("value", &content, Tone::Muted),
                    ],
                )
                .on(On::Activate(command))
                .current(conflict.mine == Some(mine)),
            );
        }
        nodes.push(Node::column(format!("conflict-{index}"), choices).gap(1));
        nodes.push(Node::text(format!("gap-{index}"), vec![]).size(Size::Fixed(1)));
    }
    nodes
}

#[cfg(test)]
mod tests {
    use super::super::tests::{draw, save};
    use super::*;
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    use serde_json::json;

    fn draft() -> App {
        let mut app = super::super::tests::app();
        let editor = app.extensions.editors.get_mut("name").unwrap();
        editor.clear_if_unchanged("My notes");
        editor.insert("本地草稿🦀");
        app.extensions
            .drafts
            .insert("name".into(), json!(editor.text()));
        app.extensions.disconnect();
        app
    }
    fn reload(app: &mut App, view: View) {
        app.extensions_action(Command::ResumeDraft);
        let request = app.extensions_request().unwrap();
        assert!(!request.needs_checkpoint());
        assert!(matches!(
            request.work,
            Work::Rebind {
                input: Input::Read { .. },
                ..
            }
        ));
        let mut entry = app.extensions.entry.clone().unwrap();
        entry.target.registration = uuid::Uuid::new_v4();
        app.extensions_complete(
            request,
            Ok(Output::Rebound {
                entry: Box::new(entry),
                reply: Reply::View { view },
            }),
        );
    }
    fn text(value: &str, max_bytes: usize) -> Control {
        Control::Text {
            value: value.into(),
            max_bytes,
            multiline: false,
            placeholder: String::new(),
        }
    }
    #[test]
    fn draft_reload_merges_disjoint_edits_and_keeps_new_revision_without_saving() {
        let mut app = draft();
        let saved = app.extensions.checkpoint("root").unwrap();
        app.extensions = State::new("en");
        app.extensions.restore(saved).unwrap();
        assert!(app.extensions_request().is_none());
        let cursor = app.extensions.editors["name"].cursor();
        let mut current = app.extensions.view.clone().unwrap();
        current.revision = "two".into();
        current.fields[0].control = Control::Toggle { value: false };
        reload(&mut app, current);
        assert!(app.extensions.review.is_none());
        assert!(app.extensions_enabled(&save()));
        assert_eq!(app.extensions.drafts["enabled"], json!(false));
        assert_eq!(app.extensions.drafts["name"], json!("本地草稿🦀"));
        assert_eq!(app.extensions.editors["name"].cursor(), cursor);
        assert!(app.extensions_request().is_none(), "resume never submits");
        app.extensions
            .checkpoint("root")
            .unwrap()
            .validate("root")
            .unwrap();
        app.extensions_action(save());
        let request = app.extensions_request().unwrap();
        assert!(
            matches!(&request.work, Work::Call { input: Input::Submit { revision, fields, .. }, .. } if revision == "two" && fields["name"] == json!("本地草稿🦀") && fields["enabled"] == json!(false))
        );
        assert!(!app.extensions_enabled(&Command::ResumeDraft));
    }

    #[test]
    fn conflicting_fields_need_explicit_choice_and_cancel_or_disconnect_keeps_original_draft() {
        let mut app = draft();
        let mut current = app.extensions.view.clone().unwrap();
        current.revision = "two".into();
        current.fields[1].control = text("Changed remotely", 128);
        reload(&mut app, current.clone());
        assert!(!app.extensions_enabled(&Command::ApplyDraft));
        let screen = draw(&mut app, 58, 24);
        assert!(
            screen.replace(' ', "").contains("本地草稿🦀") && screen.contains("Changed remotely"),
            "{screen}"
        );
        // The entire value is clickable, not only the choice marker.
        let theirs = app
            .extensions
            .surface
            .rect("extensions/body/frame/content/conflict-0/theirs")
            .unwrap();
        app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: theirs.x + 3,
            row: theirs.y + 1,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(app.extensions_enabled(&Command::ApplyDraft));
        app.input(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
        assert!(app.extensions.review.is_none());
        assert_eq!(app.extensions.drafts["name"], json!("本地草稿🦀"));
        reload(&mut app, current.clone());
        app.extensions_action(Command::DraftChoice(0, true));
        app.extensions_action(Command::ApplyDraft);
        assert_eq!(app.extensions.drafts["name"], json!("本地草稿🦀"));
        assert_eq!(app.extensions.view.as_ref().unwrap().revision, "two");
        assert!(app.extensions_request().is_none());

        app.extensions.disconnect();
        current.title = "Changed context".into();
        reload(&mut app, current);
        assert!(app.extensions.review.is_some());
        let screen = draw(&mut app, 58, 24);
        assert!(screen.contains("Previous form") && screen.contains("Current form"));
        app.extensions.disconnect();
        assert!(app.extensions.review.is_none());
        assert!(app.extensions.blocked);
        assert_eq!(app.extensions.drafts["name"], json!("本地草稿🦀"));
    }

    #[test]
    fn field_removal_disable_type_and_capacity_changes_never_truncate_a_dirty_value() {
        for change in 0..4 {
            let mut app = draft();
            let before = app.extensions.drafts.clone();
            let mut current = app.extensions.view.clone().unwrap();
            current.revision = "two".into();
            match change {
                0 => {
                    current.fields.remove(1);
                    current.actions[0].fields.pop();
                    current.root = maka_plugins::terminal_ui::view::build::column(
                        "root",
                        vec![maka_plugins::terminal_ui::view::build::input(
                            "enabled", "enabled", "Enabled",
                        )],
                    );
                }
                1 => current.fields[1].enabled = false,
                2 => current.fields[1].control = Control::Toggle { value: false },
                _ => current.fields[1].control = text("", 1),
            }
            reload(&mut app, current);
            assert!(app.extensions.review.is_none());
            assert!(app.extensions.blocked);
            assert_eq!(app.extensions.drafts, before);
            assert_eq!(app.extensions.view.as_ref().unwrap().revision, "one");
            assert!(app.extensions_request().is_none());
        }
    }
}

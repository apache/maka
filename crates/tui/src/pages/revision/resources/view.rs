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

use super::Resource;
use crate::{
    app::{Action, App},
    pages::revision::{Command, draft::Input},
    ui::{Node, On, Tone},
    view::safe,
};

/// One row per resource of the input: a checkbox deciding whether it goes
/// into the revision, and what it is. Inline references stay, since their
/// token lives in the text.
pub(in crate::pages::revision) fn rows(app: &App, input: &Input) -> Vec<Node<Action>> {
    input
        .resources()
        .into_iter()
        .enumerate()
        .map(|(index, resource)| {
            let included = input.included(&resource);
            let immutable = matches!(resource, Resource::Inline { .. });
            let (title, detail) = describe(app, input, &resource);
            let mark = if immutable {
                "·"
            } else if included {
                app.chrome.symbol("✓", "x")
            } else {
                " "
            };
            let text = if immutable {
                format!(" {mark}  {}", safe(&title))
            } else {
                format!("[{mark}] {}", safe(&title))
            };
            let command = Command::ToggleResource(resource);
            Node::column(
                index.to_string(),
                vec![
                    Node::text(
                        "title",
                        vec![(text, if included { Tone::Normal } else { Tone::Muted })],
                    )
                    .clip(),
                    Node::text(
                        "detail",
                        vec![(format!("    {}", safe(&detail)), Tone::Muted)],
                    )
                    .clip(),
                ],
            )
            .enabled(app.revision_enabled(&command))
            .on(On::Activate(Action::Revision(command)))
        })
        .collect()
}

fn describe(app: &App, input: &Input, resource: &Resource) -> (String, String) {
    match resource {
        Resource::Attachment { index } => {
            let file = &input.original.content.attachments.as_ref().unwrap()[*index];
            let size = if file.bytes < 1024 {
                format!("{} B", file.bytes)
            } else if file.bytes < 1024 * 1024 {
                format!("{:.1} KiB", file.bytes as f64 / 1024.0)
            } else {
                format!("{:.1} MiB", file.bytes as f64 / (1024.0 * 1024.0))
            };
            let mut detail = format!("{} · {size}", file.mime_type);
            match &file.storage_ref {
                maka_protocol::turn::StorageRef::WorkspaceFile { relative_path } => {
                    detail.push_str(&format!(" · {relative_path}"))
                }
                maka_protocol::turn::StorageRef::ExternalFile { absolute_path } => {
                    detail.push_str(&format!(" · {absolute_path}"))
                }
                _ => {}
            }
            (file.name.clone(), detail)
        }
        Resource::Quote { index } => {
            let quote = &input.original.content.quotes.as_ref().unwrap()[*index];
            (
                quote
                    .label
                    .clone()
                    .unwrap_or_else(|| app.i18n.text("revision-resource-quote")),
                quote.text.clone(),
            )
        }
        Resource::Directory { index } => {
            let directory = &input
                .original
                .content
                .directory_references
                .as_ref()
                .unwrap()[*index];
            (directory.path.clone(), directory.host_id.clone())
        }
        Resource::Selection { provider, index } => (
            input.original.input_selections[provider][*index].clone(),
            provider.clone(),
        ),
        Resource::Inline { index } => {
            let reference = &input.content.inline_references.as_ref().unwrap()[*index];
            (
                reference.label.clone(),
                app.i18n.text("revision-resource-inline"),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pages::revision::{
        Output,
        tests::{frame, sources},
    };
    use crossterm::event::{
        Event, KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
    };
    #[test]
    fn resource_list_scrolls_toggles_and_keeps_edits_without_touching_inline_tokens() {
        let (mut app, basis) = crate::pages::branch::tests::fixture();
        app.apply(Action::Revision(Command::Open(basis)));
        let request = app.revision_request().unwrap();
        let mut source = sources("source");
        source.messages[1].input_selections.insert(
            "skills".into(),
            (0..12).map(|i| format!("skill-{i}")).collect(),
        );
        app.revision_completed(request, Ok(Output::Sources(source)));
        frame(&mut app, 80, 30);
        app.apply(Action::Revision(Command::Resources));
        frame(&mut app, 80, 30);
        assert!(!app.revision_enabled(&Command::ToggleResource(Resource::Inline { index: 0 })));
        app.apply(Action::Revision(Command::Select(1)));
        frame(&mut app, 80, 30);
        app.apply(Action::Revision(Command::Resources));
        frame(&mut app, 80, 30);
        app.input(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        let screen = frame(&mut app, 80, 30);
        assert!(screen.contains("skill-11"));
        app.input(Event::Key(KeyEvent::new(
            KeyCode::Char(' '),
            KeyModifiers::NONE,
        )));
        assert_eq!(
            app.revision.saved.as_ref().unwrap().inputs[1].excluded,
            [Resource::Selection {
                provider: "skills".into(),
                index: 11
            }]
        );
        // The thumb, just right of the rows, dragged back to the top of the
        // viewport.
        let shown: Vec<_> = (0..13)
            .filter_map(|index| app.layer.rect(&format!("resources/rows/{index}")))
            .filter(|rect| !rect.is_empty())
            .collect();
        let top = shown.iter().map(|rect| rect.y).min().unwrap();
        let bar = shown[0].right();
        for kind in [
            MouseEventKind::Down(MouseButton::Left),
            MouseEventKind::Up(MouseButton::Left),
        ] {
            app.input(Event::Mouse(MouseEvent {
                kind,
                column: bar,
                row: top,
                modifiers: KeyModifiers::NONE,
            }));
        }
        frame(&mut app, 80, 30);
        let hit = app.layer.rect("resources/rows/0").unwrap();
        assert!(!hit.is_empty(), "the first resource is back in view");
        app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: hit.x + 6,
            row: hit.y + 1,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(
            app.revision.saved.as_ref().unwrap().inputs[1]
                .message()
                .content
                .attachments
                .is_none()
        );
        let saved = app.revision.checkpoint().unwrap();
        saved.validate("root").unwrap();
        app.revision.restore(saved);
        assert!(!app.revision.visible);
        assert!(
            app.revision.saved.as_ref().unwrap().inputs[1]
                .message()
                .content
                .attachments
                .is_none()
        );
        app.apply(Action::Revision(Command::Resume));
        frame(&mut app, 80, 24);
        app.apply(Action::Revision(Command::Resources));
        frame(&mut app, 80, 24);
        app.input(Event::Mouse(MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(!app.revision.visible);
        assert!(
            app.revision.saved.as_ref().unwrap().inputs[1]
                .message()
                .content
                .attachments
                .is_none()
        );
    }
}

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
use crate::pages::sending::Delivery;

/// Presentation only: ownership and recovery remain with the canonical operation.
pub(super) struct Feedback {
    pub key: &'static str,
    pub detail: Option<String>,
    pub warning: bool,
}

fn items(app: &App) -> Vec<Feedback> {
    let Route::Session(id) = app.navigation.current() else {
        return vec![];
    };
    let mut items = vec![];
    if let Some(error) = &app.state_error {
        items.push(Feedback {
            key: "state-save-failed",
            detail: Some(safe(error)),
            warning: true,
        });
    }
    if let Some(key) = app.drafts.get(&id).and_then(|editor| editor.error) {
        items.push(Feedback {
            key,
            detail: None,
            warning: true,
        });
    }
    if let Some(sent) = app.sending.get(&id) {
        let (key, detail, warning) = match &sent.delivery {
            Delivery::Pending | Delivery::Retrying => ("chat-sending", None, false),
            Delivery::Checking => ("chat-checking", None, false),
            Delivery::Accepted => ("", None, false),
            Delivery::Cancelled => ("chat-send-cancelled", None, false),
            Delivery::NotAdmitted => ("chat-send-not-admitted", None, false),
            Delivery::Unknown(error) => (
                "feedback-send-unknown",
                Some(app.i18n.format(
                    if app.enabled(&Action::RetrySubmission) {
                        "chat-send-unknown-retry"
                    } else {
                        "chat-send-unknown"
                    },
                    &[
                        ("id", &sent.request.id),
                        ("error", &safe(error.as_deref().unwrap_or(""))),
                    ],
                )),
                true,
            ),
            Delivery::Failed(error) => (
                "feedback-send-failed",
                Some(
                    app.i18n
                        .format("chat-send-failed", &[("error", &safe(error))]),
                ),
                true,
            ),
        };
        if !key.is_empty() {
            items.push(Feedback {
                key,
                detail,
                warning,
            });
        }
    }
    if let Some((target, key, error)) = &app.queue.error
        && target.session == id
        && matches!(&app.connection, ConnectionState::Connected { root_id, epoch } if root_id == &target.root && epoch == &target.epoch)
    {
        items.push(Feedback {
            key: if *key == "queue-unknown" {
                "feedback-queue-unknown"
            } else {
                "feedback-queue-failed"
            },
            detail: Some(app.i18n.format(key, &[("error", &safe(error))])),
            warning: true,
        });
    }
    if let Some(target) = app.stop_target()
        && let Some((key, error)) = app.chat.stop.status(&target)
    {
        items.push(Feedback {
            key: match key {
                "chat-stop-unknown" => "feedback-stop-unknown",
                "chat-stop-failed" => "feedback-stop-failed",
                _ => key,
            },
            detail: (!error.is_empty()).then(|| app.i18n.format(key, &[("error", &safe(error))])),
            warning: key != "chat-stopping",
        });
    }
    if let Some(error) = &app.chat.error {
        items.push(Feedback {
            key: "feedback-chat-failed",
            detail: Some(safe(error)),
            warning: true,
        });
    }
    if let Some(error) = app
        .chat
        .history
        .as_ref()
        .filter(|_| app.chat.history_scope())
        .and_then(|history| history.error.as_ref())
    {
        items.push(Feedback {
            key: "chat-search-history-failed",
            detail: Some(safe(error)),
            warning: true,
        });
    }
    items
}

pub(super) fn current(app: &App) -> Option<Feedback> {
    let mut items = items(app);
    // A transient "Sending…" must not mask an actionable failure.
    let index = items.iter().position(|item| item.warning).unwrap_or(0);
    if items.is_empty() {
        None
    } else {
        Some(items.remove(index))
    }
}

pub(super) fn details(app: &App) -> Vec<String> {
    items(app)
        .into_iter()
        .filter_map(|item| item.detail)
        .flat_map(|detail| [String::new(), detail])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{I18n, Locale, LocalePreference};
    use crossterm::event::{Event, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn failures_are_local_and_concise_with_opt_in_details_and_no_unsafe_resend() {
        for locale in Locale::ALL {
            let mut app = App::new(
                "/fixture".into(),
                I18n::new(LocalePreference::Explicit(locale), locale),
            );
            app.connection = ConnectionState::Connected {
                root_id: "root".into(),
                epoch: "epoch".into(),
            };
            app.apply(Action::Visit(Route::Session("chat".into())));
            app.drafts
                .get_mut("chat")
                .unwrap()
                .insert("keep my draft 中文");
            let request = app.submission().unwrap();
            app.submitted(
                request.clone(),
                Err(maka_client::RequestFailure::Unknown(
                    maka_client::ClientError::Protocol("diagnostic-only-marker\u{1b}[31m".into()),
                )),
            );
            let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            let text = |terminal: &Terminal<TestBackend>| {
                let buffer = terminal.backend().buffer();
                let mut text = String::new();
                for row in buffer.content.chunks(usize::from(buffer.area.width)) {
                    let mut column = 0;
                    while column < row.len() {
                        let symbol = row[column].symbol();
                        text.push_str(symbol);
                        // Covered cells behind a wide glyph are not terminal output.
                        column += unicode_width::UnicodeWidthStr::width(symbol).max(1);
                    }
                    text.push('\n');
                }
                text
            };
            let screen = text(&terminal);
            assert!(screen.contains("Ctrl+R"));
            assert!(!screen.contains("diagnostic-only-marker"));
            assert!(!screen.contains(&request.id));
            assert!(!app.enabled(&Action::SendMessage));
            let hit = app
                .hits
                .iter()
                .filter(|hit| hit.action == Action::ToggleDetails)
                .max_by_key(|hit| hit.area.y)
                .unwrap();
            let point = hit.area;
            app.input(Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column: point.x + point.width / 2,
                row: point.y,
                modifiers: KeyModifiers::NONE,
            }));
            assert!(app.chrome.details);
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            assert!(text(&terminal).contains("diagnostic-only-marker"));
            assert!(details(&app).iter().all(|line| !line.contains('\u{1b}')));
            assert_eq!(app.drafts["chat"].text(), "keep my draft 中文");
            app.apply(Action::Visit(Route::Session("other".into())));
            assert!(
                current(&app).is_none(),
                "errors must not leak across sessions"
            );
            app.state_error = Some("storage-only-marker".into());
            app.chrome.details = false;
            terminal
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            let screen = text(&terminal);
            let visible: String = screen.chars().filter(|c| !c.is_whitespace()).collect();
            let summary: String = app
                .i18n
                .text("state-save-failed")
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            assert_eq!(
                visible.matches(&summary).count(),
                1,
                "storage failure must not repeat in the footer and composer: {locale:?} {screen}"
            );
            assert!(!screen.contains("storage-only-marker"));
        }
    }
}

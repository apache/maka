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

use super::{Action, App, Command, Receipt};
use crate::{
    ui::{Node, On, Role, Sheet, Size, Tone},
    view::safe,
};

/// The session's recap: what it is, the saved summary in a viewer that
/// scrolls with the arrows once focused (and gives up rows on a short
/// terminal), then Close, Refresh recap, and
/// Generate new or Retry original. Generating may incur charges, so the
/// sheet opens on Close. Forgetting an unresolved retry is its own step.
pub(crate) fn sheet(app: &App) -> Option<Sheet<Action>> {
    let state = &app.recap;
    if !state.visible {
        return None;
    }
    let session = state
        .target
        .as_ref()
        .map(|target| target.session.as_str())
        .unwrap_or_default();
    let button = |sheet: Sheet<Action>, key, command: Command, role| {
        sheet.button(
            key,
            app.i18n.text(command.label()),
            role,
            Action::Recap(command.clone()),
            app.recap_offered(&command),
        )
    };
    if state.discarding {
        let sheet = Sheet::new(
            format!("recap:{session}:forget"),
            app.i18n.text("recap-forget"),
        )
        .text("note", &app.i18n.text("recap-forget-note"), Tone::Subtle)
        .back(Action::Recap(Command::Keep));
        let sheet = button(sheet, "cancel", Command::Keep, Role::Normal);
        let sheet = button(sheet, "forget", Command::ConfirmForget, Role::Destructive);
        return Some(sheet.focus("cancel"));
    }
    let mut sheet = Sheet::new(format!("recap:{session}"), app.i18n.text("recap-title"));
    if !session.is_empty() {
        sheet = sheet.text("session", &safe(session), Tone::Normal);
    }
    sheet = sheet.text("note", &app.i18n.text("recap-note"), Tone::Subtle);
    if state.pending.is_some() {
        sheet = sheet.text("working", &app.i18n.text("recap-working"), Tone::Subtle);
    }
    if state.saved.is_some() {
        // Forgetting belongs to the unresolved request it abandons.
        sheet = sheet.body(Node::column(
            "unresolved",
            vec![
                Node::text(
                    "note",
                    vec![(app.i18n.text("recap-unresolved"), Tone::Warning)],
                ),
                Node::row(
                    "actions",
                    vec![
                        Node::button("forget", app.i18n.text("recap-forget"), Role::Caution)
                            .on(On::Activate(Action::Recap(Command::Forget)))
                            .enabled(app.recap_offered(&Command::Forget)),
                    ],
                ),
            ],
        ));
    }
    if let Some(error) = &state.error {
        sheet = sheet.text("error", &safe(error), Tone::Warning);
    }
    if let Some(lines) = receipt(app) {
        let height = app.frame_size.map_or(24, |(_, height)| height);
        // Keyed by the request, so a new recap reads from its start.
        let key = state.receipt.as_ref().map_or_else(
            || "recap".into(),
            |receipt| format!("recap-{}", receipt.operation()),
        );
        sheet = sheet.body(
            Node::scroll(key, Node::column("lines", lines))
                .on(On::Scroll)
                .size(Size::Upto(height.saturating_sub(12).max(3))),
        );
    }
    sheet = button(sheet, "close", Command::Close, Role::Normal);
    sheet = button(sheet, "read", Command::Read, Role::Normal);
    sheet = if state.saved.is_some() {
        button(sheet, "retry", Command::Retry, Role::Primary)
    } else {
        button(sheet, "generate", Command::Generate, Role::Primary)
    };
    Some(sheet.focus("close"))
}

/// The saved recap, or what became of the request, one node per line.
fn receipt(app: &App) -> Option<Vec<Node<Action>>> {
    let line = |index: usize, text: &str, tone| {
        Node::text(index.to_string(), vec![(text.to_owned(), tone)])
    };
    let lines: Vec<(String, Tone)> = match &app.recap.receipt {
        Some(Receipt::Ready { text, model_id, .. }) => text
            .lines()
            .map(|line| (safe(line), Tone::Normal))
            .chain([
                (String::new(), Tone::Normal),
                (safe(model_id), Tone::Subtle),
            ])
            .collect(),
        Some(Receipt::Pending { .. }) => vec![(app.i18n.text("recap-pending"), Tone::Subtle)],
        Some(Receipt::Failed { reason, .. }) => vec![
            (app.i18n.text("recap-failed"), Tone::Warning),
            (safe(reason), Tone::Subtle),
        ],
        None if app.recap.loaded => vec![(app.i18n.text("recap-empty"), Tone::Subtle)],
        None => return None,
    };
    Some(
        lines
            .iter()
            .enumerate()
            .map(|(index, (text, tone))| line(index, text, *tone))
            .collect(),
    )
}

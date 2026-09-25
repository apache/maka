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
use crate::ui::transcript::search::Command;
mod history;

pub(super) fn body(frame: &mut Frame<'_>, app: &mut App, area: Rect) -> bool {
    let available = app.chat.subscription.is_some() && app.chat.error.is_none();
    app.chat.sync_history();
    let Some(history) = app.chat.history.as_mut() else {
        return false;
    };
    app.hits.extend(history::draw(
        frame,
        history,
        area,
        &app.i18n,
        app.chrome.ascii,
        app.theme.colors(),
        available,
    ));
    true
}

pub(super) fn draw(frame: &mut Frame<'_>, app: &mut App, area: Rect) {
    if area.is_empty() || app.chat.view.search.is_none() {
        return;
    }
    let search = app.chat.view.search.as_ref().unwrap();
    let count = app
        .chat
        .history
        .as_ref()
        .map_or_else(|| search.count(), |history| history.count());
    let count_width = (count.width() as u16).min(area.width / 3);
    let controls = 9;
    let label = if area.width >= 60 {
        app.i18n.text(if search.history {
            "chat-search-all"
        } else {
            "chat-search-scope"
        })
    } else {
        String::new()
    };
    let prefix = format!(
        "{} {label} ",
        if search.history {
            app.chrome.symbol("∞", "*")
        } else {
            app.chrome.symbol("⌕", "/")
        }
    );
    let prefix_width = (prefix.width() as u16).min(area.width / 2);
    frame.render_widget(
        Paragraph::new(prefix).style(Style::default().fg(app.theme.colors().subtle)),
        Rect::new(area.x, area.y, prefix_width, 1),
    );
    app.hits.push(Hit {
        area: Rect::new(area.x, area.y, prefix_width, 1),
        action: Action::Search(Command::Scope),
    });
    let input = Rect::new(
        area.x + prefix_width,
        area.y,
        area.width
            .saturating_sub(prefix_width + count_width + controls + 1),
        1,
    );
    let focused = app.palette.is_none()
        && app.theme.editor.is_none()
        && app.attachments.dialog.is_none()
        && app.skills.dialog.is_none()
        && !app.branch.visible
        && !app.revision.visible
        && !app.recap.visible
        && !app.interactions.visible
        && app.management.dialog.is_none()
        && app.onboarding.dialog.is_none()
        && app.queue.edit.is_none();
    app.chat
        .view
        .search
        .as_mut()
        .unwrap()
        .editor
        .draw(frame, input, focused, app.theme.colors());
    let count_area = Rect::new(
        area.right().saturating_sub(controls + count_width),
        area.y,
        count_width,
        1,
    );
    frame.render_widget(
        Paragraph::new(count).style(Style::default().fg(app.theme.colors().subtle)),
        count_area,
    );
    for (index, command) in [Command::Previous, Command::Next, Command::Close]
        .into_iter()
        .enumerate()
    {
        super::super::icon_button(
            frame,
            app,
            Rect::new(
                area.right().saturating_sub(controls) + index as u16 * 3,
                area.y,
                3,
                1,
            ),
            Action::Search(command),
            false,
        );
    }
}

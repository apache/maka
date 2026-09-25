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
    let scope = app.i18n.text(if search.history {
        "chat-search-all"
    } else {
        "chat-search-scope"
    });
    let scope_hint = app.i18n.text("chat-search-scope-toggle");
    let hints = [
        "chat-search-previous",
        "chat-search-next",
        "chat-search-close",
    ]
    .map(|key| app.i18n.text(key));
    let context = crate::ui::Context {
        colors: app.theme.colors(),
        ascii: app.chrome.ascii,
        focused: app.overlay().is_none(),
    };
    app.chat.view.search.as_mut().unwrap().draw_bar(
        frame,
        area,
        context,
        &count,
        Some((&scope, &scope_hint)),
        [&hints[0], &hints[1], &hints[2]],
    );
}

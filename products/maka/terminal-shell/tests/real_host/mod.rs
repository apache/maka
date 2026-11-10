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

mod keyboard;
#[allow(dead_code)]
pub(crate) mod support;

use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use nsh_platform_tui::AppView;
use serde_json::json;
use std::time::Duration;
use support::{Fixture, wait_view, wait_view_state};

trait TerminalInputExt {
    fn handle_event(&mut self, event: Event) -> bool;
}

impl TerminalInputExt for AppView {
    fn handle_event(&mut self, event: Event) -> bool {
        maka_terminal_shell::terminal::handle_event(self, event)
    }
}

fn shortcut(view: &mut AppView, key: char) {
    view.handle_event(Event::Key(KeyEvent::new(
        KeyCode::Char(key),
        KeyModifiers::CONTROL,
    )));
}

async fn tab_to_label(view: &mut AppView, label: &str) {
    wait_enabled_node(view, label).await;
    let mut visited = Vec::new();
    for _ in 0..=view.accessibility_snapshot().len() {
        let nodes = view.accessibility_snapshot();
        if nodes.iter().any(|node| node.focused && node.label == label) {
            return;
        }
        visited.push(
            nodes
                .iter()
                .find(|node| node.focused)
                .map(|node| (node.id, node.label.clone())),
        );
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
        support::tick(view);
    }
    let target: Vec<_> = view
        .accessibility_snapshot()
        .into_iter()
        .filter(|node| node.label == label)
        .map(|node| (node.id, node.role, node.state, node.frame))
        .collect();
    panic!(
        "native Tab did not reach {label:?}:\nvisited={visited:?}\ntarget={target:?}\n{}",
        view.snapshot()
    );
}

async fn wait_enabled_node(view: &mut AppView, label: &str) {
    wait_view_state(view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == label && !node.state.disabled)
    })
    .await;
}

async fn editable(view: &mut AppView, label: &str) {
    wait_view_state(view, |view, _| {
        view.input_context().is_some_and(|input| {
            input.editable
                && view
                    .accessibility_snapshot()
                    .iter()
                    .any(|node| node.id == input.node && node.focused && node.label == label)
        })
    })
    .await;
}

async fn wait_editable_composer(view: &mut AppView) {
    wait_enabled_node(view, "Focus message composer").await;
    editable(view, "Message composer").await;
    commit_native_events(view).await;
}

async fn commit_native_events(view: &mut AppView) {
    // Native edits precede their JS callbacks; advance past those callbacks
    // before the next interaction reads or activates the resulting state.
    let (done, committed) = tokio::sync::oneshot::channel();
    view.control()
        .unwrap()
        .advance_clock(Duration::ZERO, move || {
            let _ = done.send(());
        });
    tokio::time::timeout(support::WAIT_TIMEOUT, committed)
        .await
        .unwrap()
        .unwrap();
    support::tick(view);
}

fn model_menu_closed(view: &AppView) -> bool {
    !view.accessibility_snapshot().iter().any(|node| {
        node.label == "Close model selection" || node.label == "Search models and sources"
    })
}

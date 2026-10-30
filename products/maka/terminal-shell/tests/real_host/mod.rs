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

mod attachments;
mod catalog_association;
mod components;
mod keyboard;
mod send_hold;
mod support;
mod ui_plugins;

use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use nsh_platform_tui::{AccessibleNode, AppView};
use serde_json::{Value, json};
use std::{sync::atomic::Ordering, time::Duration};
use support::{EDITOR, Fixture, ReplyGate, wait_view, wait_view_state};
use uuid::Uuid;
fn shortcut(view: &mut AppView, key: char) {
    view.handle_event(Event::Key(KeyEvent::new(
        KeyCode::Char(key),
        KeyModifiers::CONTROL,
    )));
}

async fn tab_to_label(view: &mut AppView, label: &str) {
    wait_enabled_node(view, label).await;
    for _ in 0..=view.accessibility_snapshot().len() {
        if view
            .accessibility_snapshot()
            .iter()
            .any(|node| node.focused && node.label == label)
        {
            return;
        }
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE)));
    }
    panic!("native Tab did not reach {label:?}");
}

async fn wait_enabled_node(view: &mut AppView, label: &str) {
    wait_view_state(view, |view, _| {
        view.accessibility_snapshot()
            .iter()
            .any(|node| node.label == label && !node.state.disabled)
    })
    .await;
}

async fn wait_focused_input(view: &mut AppView, label: &str) {
    wait_view_state(view, |view, _| {
        view.surface().input_context().is_some_and(|input| {
            view.accessibility_snapshot()
                .iter()
                .any(|node| node.id == input.node && node.focused && node.label == label)
        })
    })
    .await;
}

async fn editable(view: &mut AppView, label: &str) {
    wait_view_state(view, |view, _| {
        view.surface().input_context().is_some_and(|input| {
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
    editable(view, "Message composer").await;
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
    tokio::time::timeout(Duration::from_secs(20), committed)
        .await
        .unwrap()
        .unwrap();
    support::tick(view);
}

async fn activate(view: &mut AppView, label: &str) {
    support::click_button(view, label).await;
    commit_native_events(view).await;
}
async fn fill(view: &mut AppView, label: &str, value: &str) {
    tab_to_label(view, label).await;
    editable(view, label).await;
    shortcut(view, 'a');
    view.handle_event(Event::Paste(value.into()));
    commit_native_events(view).await;
}
fn model_menu_closed(view: &AppView) -> bool {
    !view
        .accessibility_snapshot()
        .iter()
        .any(|node| node.label == "Close model selection" || node.label == "Search models")
}
fn selected_command<'a>(nodes: &'a [AccessibleNode], title: &str) -> Option<&'a AccessibleNode> {
    nodes.iter().find(|button| {
        button.role == nsh_core::AccessibilityRole::Button
            && !button.state.disabled
            && button.state.selected
            && nodes.iter().any(|text| {
                text.label == title
                    && text.frame.origin.x.0 >= button.frame.origin.x.0
                    && text.frame.origin.y.0 >= button.frame.origin.y.0
                    && text.frame.origin.x.0 < button.frame.origin.x.0 + button.frame.size.width.0
                    && text.frame.origin.y.0 < button.frame.origin.y.0 + button.frame.size.height.0
            })
    })
}

async fn select_command(view: &mut AppView, command: &str) {
    fill(view, "Search commands", command).await;
    wait_view_state(view, |view, _| {
        selected_command(&view.accessibility_snapshot(), command).is_some()
    })
    .await;
    view.handle_event(Event::Key(KeyEvent::new(
        KeyCode::Enter,
        KeyModifiers::NONE,
    )));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn product_composition_sends_streams_and_restores_history_with_a_later_draft() {
    let mut fixture = Fixture::open().await;
    let client = fixture.client().await;
    support::mutate(&client,"selectBackend",json!({"sessionId":fixture.session,"backend":{"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model","thinkingLevel":null}})).await;
    let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
    wait_editable_composer(&mut view).await;
    view.handle_event(Event::Paste("One original message 你好".into()));
    support::click_button(&mut view, "Send message").await;
    let mut request = fixture.next_request().await;
    assert_eq!(request.body["model"], "fixture-model");
    assert!(
        request.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|message| message["role"] == "user"
                && message["content"]
                    .to_string()
                    .contains("One original message 你好"))
    );
    request.delta("Original **streamed** answer").await;
    wait_view(&mut view, |screen| {
        screen.contains("Original") && screen.contains("streamed")
    })
    .await;
    tab_to_label(&mut view, "Message composer").await;
    view.handle_event(Event::Paste("A later draft remains private".into()));
    support::wait_draft(&client, &fixture.session, "A later draft remains private").await;
    request.finish().await;
    fixture.idle(&client, &fixture.session).await;
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
    drop(view);
    bindings.close().await.unwrap();
    let reopened = fixture.client().await;
    let (mut view, bindings) = fixture.view(reopened.clone(), Some(fixture.session.clone()));
    wait_view(&mut view, |screen| {
        screen.contains("Original")
            && screen.contains("streamed")
            && screen.contains("A later draft remains private")
    })
    .await;
    wait_editable_composer(&mut view).await;
    assert_eq!(
        view.surface().input_context().unwrap().text.as_deref(),
        Some("A later draft remains private")
    );
    support::click_button(&mut view, "Copy message").await;
    wait_view(&mut view, |screen| screen.contains("Message copied")).await;
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
    drop(view);
    bindings.close().await.unwrap();
    fixture.finish().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn provider_failure_is_visible_and_does_not_consume_the_next_draft() {
    let mut fixture = Fixture::open().await;
    let client = fixture.client().await;
    support::mutate(&client,"selectBackend",json!({"sessionId":fixture.session,"backend":{"kind":"model","connectionId":fixture.selection["connectionId"],"modelId":"fixture-model","thinkingLevel":null}})).await;
    let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
    wait_editable_composer(&mut view).await;
    view.handle_event(Event::Paste("Show the provider failure".into()));
    support::click_button(&mut view, "Send message").await;
    let request = fixture.next_request().await;
    tab_to_label(&mut view, "Message composer").await;
    view.handle_event(Event::Paste("My next draft".into()));
    request.http_error(json!({"error":{"type":"invalid_request_error","message":"The selected model is unavailable"}})).await;
    fixture.idle(&client, &fixture.session).await;
    wait_view(&mut view, |screen| {
        screen.contains("The selected model is unavailable")
    })
    .await;
    support::wait_draft(&client, &fixture.session, "My next draft").await;
    assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
    drop(view);
    bindings.close().await.unwrap();
    fixture.finish().await;
}

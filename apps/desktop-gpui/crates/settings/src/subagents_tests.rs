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

//! UI integration tests of the Subagents page against the scripted Host of
//! [`crate::tests`]: the list with what keeps a preset from its route, a
//! row's switch, the editor's create, edit, and remove, the id the name
//! suggests, what the editor refuses before sending, and a preset the
//! Host's normalizer dropped. Answers follow `decodeRuntimePolicySnapshot`
//! and `decodeRuntimePolicyMutationResult`
//! (packages/runtime-host/src/protocol/runtime-policy.ts).

use std::sync::Arc;

use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{ElementId, Entity, TestAppContext};
use serde_json::{Value, json};
use shared::copy::subagents as copy;
use shared::domain_element_id;
use workspace::HostRequestError;

use crate::tests::{Harness, ScriptedHost, header, policy};
use crate::{SettingsSection, SubagentEditor, SubagentRoute};

fn preset(id: &str, name: &str, slug: &str, model: &str, enabled: bool) -> Value {
    json!({"id": id, "name": name, "description": "", "profile": "local_read",
           "connectionSlug": slug, "model": model, "enabled": enabled})
}

/// Four presets: one the main agent can take, one on a model the
/// connection has not enabled, one on a connection that is gone, and one
/// switched off (which shows no problem).
fn presets() -> Vec<Value> {
    let mut reader = preset("reader", "Reader", "deepseek-a", "deepseek-v4", true);
    reader["description"] = json!("Reads large repositories");
    vec![
        reader,
        preset("web", "Researcher", "deepseek-a", "deepseek-old", true),
        preset("gone", "Gone", "vanished", "m", true),
        preset("off", "Off one", "off", "deepseek-v9", false),
    ]
}

fn policy_with(revision: u64, presets: &[Value]) -> Value {
    let mut value = policy(revision, "ask");
    value["policy"]["subagents"] = json!({"presets": presets});
    value
}

fn catalog_entry(index: u64, item: u64, id: &str, chat: bool, levels: &[&str]) -> Value {
    json!({"kind": "catalog_entry", "connectionIndex": index, "itemIndex": item, "entry": {
        "id": id, "canUseAsChatDefault": chat, "isDefault": item == 0, "supportsVision": false,
        "thinkingLevels": levels}})
}

fn enabled_model(index: u64, item: u64, id: &str) -> Value {
    json!({"kind": "enabled_model_id", "connectionIndex": index, "itemIndex": item, "modelId": id})
}

/// DeepSeek A (two enabled models, one a chat model with thinking levels,
/// and a chat model not enabled), and a disabled connection.
fn catalog() -> Value {
    json!({"kind": "page", "revision": 4, "defaultTarget": null, "connectionCount": 2,
           "nextCursor": null, "items": [
        header(0, "c-a", "deepseek-a", "DeepSeek A", "deepseek", true),
        enabled_model(0, 0, "deepseek-v4"),
        enabled_model(0, 1, "deepseek-embed"),
        catalog_entry(0, 0, "deepseek-v4", true, &["low", "high"]),
        catalog_entry(0, 1, "deepseek-embed", false, &[]),
        catalog_entry(0, 2, "deepseek-old", true, &[]),
        header(1, "c-off", "off", "Off", "deepseek", false),
        enabled_model(1, 0, "deepseek-v9"),
        catalog_entry(1, 0, "deepseek-v9", true, &[]),
    ]})
}

fn open(presets: &[Value], cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("runtime.policy.query", Ok(policy_with(3, presets)));
    transport.reply("connection.catalog.query", Ok(catalog()));
    transport.always("connection.catalog.query", Ok(catalog()));
    Harness::open_with_transport(SettingsSection::Subagents, transport, cx)
}

fn set(revision: u64, presets: &[Value]) -> Value {
    json!({"expectedRevision": revision,
           "operation": {"kind": "set_subagents", "value": {"presets": presets}}})
}

fn committed(revision: u64) -> Result<Value, HostRequestError> {
    Ok(json!({"kind": "committed", "revision": revision}))
}

fn label(harness: &Harness, id: impl Into<ElementId>, cx: &mut TestAppContext) -> Option<String> {
    let id = id.into();
    harness
        .with_window(cx, |window, _| window.try_find(id).and_then(|e| e.label().map(str::to_owned)))
}

impl Harness {
    fn subagent_route(&self, cx: &mut TestAppContext) -> SubagentRoute {
        self.view.read_with(cx, |view, cx| view.subagents().read(cx).route(cx))
    }

    fn subagent_editor(&self, cx: &mut TestAppContext) -> Entity<SubagentEditor> {
        self.view
            .read_with(cx, |view, cx| view.subagents().read(cx).editor(cx).cloned())
            .expect("the editor shows")
    }

    fn type_in(&self, id: &'static str, text: &str, cx: &mut TestAppContext) {
        self.with_window(cx, |window, cx| {
            window.click(id, cx);
            window.press("cmd-a", cx);
            window.input(text, cx);
        });
    }
}

#[gpui_kit::test]
fn the_add_target_waits_for_the_policy_then_opens_the_editor(cx: &mut TestAppContext) {
    let transport = Arc::new(ScriptedHost::default());
    let policy_reply = transport.hold("runtime.policy.query");
    transport.always("connection.catalog.query", Ok(catalog()));
    let harness = Harness::open_with_transport(SettingsSection::Subagents, transport, cx);
    let view = harness.view.clone();
    let opened = harness.with_window(cx, |window, cx| {
        view.update(cx, |view, cx| view.open_target("add", window, cx))
    });
    assert!(opened, "the target is taken, to open once the page has loaded");
    let subagents = harness.view.read_with(cx, |view, _| view.subagents().clone());
    assert!(subagents.read_with(cx, |page, cx| page.editor(cx).is_none()), "nothing read yet");
    policy_reply.try_send(Ok(policy_with(3, &presets()))).expect("send");
    harness.with_window(cx, |_, _| {});
    assert!(
        subagents.read_with(cx, |page, cx| page.editor(cx).is_some()),
        "the new preset's editor"
    );
}

#[gpui_kit::test]
fn the_list_says_what_keeps_a_preset_from_its_route_and_a_switch_saves_at_once(
    cx: &mut TestAppContext,
) {
    let harness = open(&presets(), cx);
    let row = |id: &str| domain_element_id("settings-row", &format!("subagent-{id}"));
    let problem = |id: &str| domain_element_id("settings-state", &format!("subagent-{id}"));
    assert_eq!(label(&harness, row("reader"), cx).as_deref(), Some("Reader"));
    assert_eq!(label(&harness, problem("reader"), cx), None, "it can be taken");
    assert_eq!(label(&harness, problem("web"), cx).as_deref(), Some(copy::MODEL_DISABLED.en()));
    assert_eq!(
        label(&harness, problem("gone"), cx).as_deref(),
        Some(copy::MISSING_CONNECTION.en())
    );
    assert_eq!(label(&harness, problem("off"), cx), None, "its switch says it is off");
    let group = domain_element_id("settings-group-title", "subagents");
    assert_eq!(label(&harness, group, cx).as_deref(), Some(copy::APPROVED.en()));
    assert!(harness.with_window(cx, |window, _| window.find("subagents-add").visible()));

    // The switch writes the whole list, the others as read.
    harness.transport.reply("runtime.policy.mutate", committed(4));
    harness.click(domain_element_id("settings-toggle", "subagent-reader"), cx);
    let mut expected = presets();
    expected[0]["enabled"] = json!(false);
    assert_eq!(harness.transport.requests("runtime.policy.mutate"), [set(3, &expected)]);
    harness.with_window(cx, |window, _| {
        let switch = window.find(domain_element_id("settings-toggle", "subagent-reader"));
        assert_eq!(switch.checked(), Some(false));
    });

    // A refusal puts it back and says why above the list.
    harness
        .transport
        .reply("runtime.policy.mutate", Err(HostRequestError::Transport("closed".into())));
    harness.click(domain_element_id("settings-toggle", "subagent-web"), cx);
    let line = label(&harness, domain_element_id("settings-status", "subagents-save"), cx);
    assert!(
        line.as_deref().is_some_and(|line| line.starts_with(copy::SAVE_FAILED.en())),
        "{line:?}"
    );
    harness.with_window(cx, |window, _| {
        let switch = window.find(domain_element_id("settings-toggle", "subagent-web"));
        assert_eq!(switch.checked(), Some(true));
    });
}

#[gpui_kit::test]
fn a_new_preset_takes_its_id_from_its_name_and_is_read_back_after_saving(cx: &mut TestAppContext) {
    let harness = open(&presets(), cx);
    harness.click("subagents-add", cx);
    assert_eq!(harness.subagent_route(cx), SubagentRoute::Create);
    assert_eq!(label(&harness, "subagent-title", cx).as_deref(), Some(copy::ADD.en()));
    harness.type_in("subagent-name-field", "Fast Reader", cx);
    let editor = harness.subagent_editor(cx);
    let id = editor.read_with(cx, |editor, cx| editor.id_input().read(cx).value());
    assert_eq!(id, "fast-reader");
    // The first usable connection and its first chat model.
    assert_eq!(harness.chosen("subagent-connection", cx).as_deref(), Some("DeepSeek A"));
    assert_eq!(harness.chosen("subagent-model", cx).as_deref(), Some("deepseek-v4"));
    assert_eq!(
        harness.chosen("subagent-thinking", cx).as_deref(),
        Some(copy::DEFAULT_THINKING.en())
    );
    // Implementation warns what it can do.
    harness.choose("subagent-profile", &["down", "down"], cx);
    let warning = domain_element_id("settings-warning", "subagent-implementation");
    assert_eq!(label(&harness, warning, cx).as_deref(), Some(copy::IMPLEMENTATION_WARNING.en()));
    harness.choose("subagent-thinking", &["down", "down"], cx);

    let created = json!({"id": "fast-reader", "name": "Fast Reader", "description": "",
        "profile": "implementation", "connectionSlug": "deepseek-a", "model": "deepseek-v4",
        "thinkingLevel": "high", "enabled": true});
    let mut after = presets();
    after.push(created);
    harness.transport.reply("runtime.policy.mutate", committed(4));
    harness.transport.always("runtime.policy.query", Ok(policy_with(4, &after)));
    harness.click("subagent-save", cx);
    assert_eq!(harness.transport.requests("runtime.policy.mutate"), [set(3, &after)]);
    assert_eq!(harness.subagent_route(cx), SubagentRoute::List, "back to the list once saved");
    assert!(
        harness.transport.requests("runtime.policy.query").len() >= 2,
        "read back to be sure the Host kept it"
    );
    let row = domain_element_id("settings-row", "subagent-fast-reader");
    assert_eq!(label(&harness, row, cx).as_deref(), Some("Fast Reader"));
}

#[gpui_kit::test]
fn the_editor_says_what_is_missing_and_sends_nothing(cx: &mut TestAppContext) {
    let harness = open(&presets(), cx);
    harness.click("subagents-add", cx);
    let status = |key: &str| domain_element_id("settings-status", key);
    harness.click("subagent-save", cx);
    let required = label(&harness, status("subagent-name"), cx);
    assert_eq!(required.as_deref(), Some(copy::REQUIRED_NAME.en()));
    let invalid = copy::invalid_id(shared::copy::Locale::English, 128);
    assert_eq!(
        label(&harness, status("subagent-id"), cx).as_deref(),
        Some(invalid.as_str()),
        "an empty id is not one the Host keeps"
    );
    harness.type_in("subagent-name-field", "Reader", cx);
    // The id follows the name until it is typed.
    harness.type_in("subagent-id-field", "reader", cx);
    harness.type_in("subagent-name-field", "Something else", cx);
    let editor = harness.subagent_editor(cx);
    assert_eq!(editor.read_with(cx, |editor, cx| editor.id_input().read(cx).value()), "reader");
    harness.click("subagent-save", cx);
    let duplicate = label(&harness, status("subagent-id"), cx);
    assert_eq!(duplicate.as_deref(), Some(copy::DUPLICATE_ID.en()));
    harness.type_in("subagent-id-field", "has space", cx);
    harness.click("subagent-save", cx);
    assert_eq!(label(&harness, status("subagent-id"), cx).as_deref(), Some(invalid.as_str()));
    assert!(harness.transport.requests("runtime.policy.mutate").is_empty());
    // A name past the Host's limit is cut where the Host would drop it.
    harness.type_in("subagent-name-field", &"n".repeat(140), cx);
    let name = editor.read_with(cx, |editor, cx| editor.name_input().read(cx).value());
    assert_eq!(name.chars().count(), 128);
    harness.click("subagent-cancel", cx);
    assert_eq!(harness.subagent_route(cx), SubagentRoute::List);
}

#[gpui_kit::test]
fn a_preset_the_host_dropped_is_not_taken_for_saved(cx: &mut TestAppContext) {
    let harness = open(&presets(), cx);
    harness.click("subagents-add", cx);
    harness.type_in("subagent-name-field", "Dropped", cx);
    harness.transport.reply("runtime.policy.mutate", committed(4));
    // The Host committed the list, but its normalizer left the preset out.
    harness.transport.always("runtime.policy.query", Ok(policy_with(4, &presets())));
    harness.click("subagent-save", cx);
    assert_eq!(harness.subagent_route(cx), SubagentRoute::Create, "the draft stays");
    let line = label(&harness, domain_element_id("settings-status", "subagents-save"), cx);
    let expected = format!("{}. {}", copy::SAVE_FAILED.en(), copy::REJECTED.en());
    assert_eq!(line.as_deref(), Some(expected.as_str()));
}

#[gpui_kit::test]
fn an_existing_preset_keeps_its_id_and_is_removed_after_the_question(cx: &mut TestAppContext) {
    let harness = open(&presets(), cx);
    harness.click(domain_element_id("subagent-configure", "gone"), cx);
    assert_eq!(harness.subagent_route(cx), SubagentRoute::Edit("gone".into()));
    // The id is a settled fact; the vanished connection says why it cannot
    // be chosen.
    let id = domain_element_id("settings-value", "subagent-id");
    assert_eq!(label(&harness, id, cx).as_deref(), Some("gone"));
    assert_eq!(
        harness.chosen("subagent-connection", cx).as_deref(),
        Some("vanished · Connection missing")
    );
    harness.click("subagent-back", cx);
    assert_eq!(harness.subagent_route(cx), SubagentRoute::List);

    harness.click(domain_element_id("subagent-configure", "reader"), cx);
    harness.type_in("subagent-name-field", "Reader two", cx);
    let mut edited = presets();
    edited[0]["name"] = json!("Reader two");
    harness.transport.reply("runtime.policy.mutate", committed(4));
    harness.transport.always("runtime.policy.query", Ok(policy_with(4, &edited)));
    harness.click("subagent-save", cx);
    assert_eq!(harness.transport.requests("runtime.policy.mutate"), [set(3, &edited)]);
    assert_eq!(harness.subagent_route(cx), SubagentRoute::List);

    harness.click(domain_element_id("subagent-configure", "reader"), cx);
    harness.click("subagent-remove", cx);
    assert_eq!(harness.transport.requests("runtime.policy.mutate").len(), 1, "it asks first");
    harness.transport.reply("runtime.policy.mutate", committed(5));
    harness.with_window(cx, |window, cx| window.click("ok", cx));
    let requests = harness.transport.requests("runtime.policy.mutate");
    assert_eq!(requests.last(), Some(&set(4, &edited[1..])));
    assert_eq!(harness.subagent_route(cx), SubagentRoute::List);
}

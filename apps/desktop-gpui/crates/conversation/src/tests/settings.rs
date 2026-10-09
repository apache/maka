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

//! The composer's model picker: what it lists, the exact
//! `session.configuration.update` a choice sends, and how conflicts and
//! refusals end.

use super::*;
use host_protocol::HostOperationErrorCode;

const OLLAMA: &str = "c-ollama";

/// A `session.catalog.query` `get` answer for the synthetic session on the
/// `ollama-local` connection.
fn catalog_projection(model: &str, permission_mode: &str, revision: u64) -> Value {
    let mut answer = catalog_session(model, permission_mode);
    let session = &mut answer["session"];
    session["revision"] = json!(revision);
    session["llmConnectionId"] = json!(OLLAMA);
    session["llmConnectionSlug"] = json!("ollama-local");
    answer
}

/// The committed `session.configuration.update` answer for `projection`.
fn committed(projection: &Value) -> Value {
    json!({"kind": "committed", "session": projection["session"]})
}

/// One page of `connection.catalog.query` with two connections: the
/// DeepSeek environment connection and the local Ollama one
/// (`catalogPageItem` in `packages/runtime-host/src/protocol/runtime-policy.ts`).
fn connection_catalog() -> Value {
    let header = |index: u64, id: &str, slug: &str, name: &str, models: u64| {
        json!({"kind": "connection", "connectionIndex": index, "connectionId": id,
               "revision": 1, "slug": slug, "name": name, "providerType": "openai-compatible",
               "enabled": true, "enabledModelIdCount": models, "modelCount": 0,
               "catalogEntryCount": 0})
    };
    let enabled = |index: u64, item: u64, model: &str| {
        json!({"kind": "enabled_model_id", "connectionIndex": index, "itemIndex": item,
               "modelId": model})
    };
    json!({"kind": "page", "revision": 6,
           "defaultTarget": {"connectionId": OLLAMA, "modelId": "qwen2.5:7b"},
           "connectionCount": 2,
           "items": [
               header(0, "c-deepseek", "env-deepseek", "DeepSeek (env)", 1),
               enabled(0, 0, "deepseek-v4-flash"),
               header(1, OLLAMA, "ollama-local", "Ollama (local)", 2),
               enabled(1, 0, "qwen2.5:7b"),
               enabled(1, 1, "phi4:latest"),
           ],
           "nextCursor": null})
}

/// The synthetic session, idle, on `qwen2.5:7b` at revision 3, with the
/// composer under it and the two-connection catalog read.
fn open_settings(cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    transport.reply("session.catalog.query", Ok(catalog_projection("qwen2.5:7b", "ask", 3)));
    transport.reply("connection.catalog.query", Ok(connection_catalog()));
    let harness = Harness::open_with_composer(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness
}

fn model_label(harness: &Harness, cx: &mut TestAppContext) -> Option<String> {
    harness.with_window(cx, |window, _| window.find("composer-model").label().map(str::to_owned))
}

/// A model switch: the explicit target, and the thinking level back to the
/// model's default (Desktop's `modelConfigurationIntentForModel`).
fn explicit_update(expected_revision: u64, model: &str) -> Value {
    json!({"sessionId": SESSION, "expectedRevision": expected_revision, "patch": {
        "modelTarget": {"kind": "explicit", "connectionId": OLLAMA,
                        "connectionSlug": "ollama-local", "model": model},
        "thinkingLevel": null
    }})
}

fn item(ix: u64) -> ElementId {
    ElementId::Integer(ix)
}

/// Opens the model menu and chooses its item `ix`.
fn choose_model(harness: &Harness, ix: u64, cx: &mut TestAppContext) {
    harness.with_window(cx, |window, cx| {
        window.click("composer-model", cx);
        window.within("popup-menu").click(item(ix), cx);
    });
    cx.run_until_parked();
}

#[gpui_kit::test]
fn the_model_menu_groups_models_by_connection_and_checks_the_current_one(cx: &mut TestAppContext) {
    let harness = open_settings(cx);
    assert_eq!(harness.transport.requests("connection.catalog.query"), [json!({"kind": "start"})]);
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: qwen2.5:7b"));
    harness.with_window(cx, |window, cx| {
        window.click("composer-model", cx);
        let menu = window.within("popup-menu");
        let labels: Vec<Option<String>> =
            (0..8).map(|ix| menu.find(item(ix)).label().map(str::to_owned)).collect();
        assert_eq!(
            labels,
            [
                Some("DeepSeek (env)".to_owned()),
                Some("deepseek-v4-flash".to_owned()),
                None, // the separator between the groups
                Some("Ollama (local)".to_owned()),
                Some("qwen2.5:7b".to_owned()),
                Some("phi4:latest".to_owned()),
                None,
                Some(copy::ADD_CONNECTION.en().to_owned()),
            ]
        );
        window.press("escape", cx);
    });
    assert!(harness.transport.requests("session.configuration.update").is_empty());
    // Choosing the model the session already runs sends nothing.
    choose_model(&harness, 4, cx);
    assert!(harness.transport.requests("session.configuration.update").is_empty());
}

#[gpui_kit::test]
fn choosing_a_model_sends_the_explicit_target_at_the_session_revision(cx: &mut TestAppContext) {
    let harness = open_settings(cx);
    let answer = harness.transport.hold("session.configuration.update");
    choose_model(&harness, 5, cx);
    assert_eq!(
        harness.transport.requests("session.configuration.update"),
        [explicit_update(3, "phi4:latest")]
    );
    // Until the Host commits, the picker keeps the old model, shows
    // progress, and opens no menu for a second choice.
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: qwen2.5:7b"));
    harness.state.read_with(cx, |state, _| assert!(state.is_configuring()));
    harness.with_window(cx, |window, cx| {
        window.click("composer-model", cx);
        assert!(window.try_find("popup-menu").is_none());
    });
    assert_eq!(harness.transport.requests("session.configuration.update").len(), 1);

    answer.try_send(Ok(committed(&catalog_projection("phi4:latest", "ask", 4)))).expect("answer");
    settle(cx);
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: phi4:latest"));
    harness.state.read_with(cx, |state, _| {
        let settings = state.settings().expect("settings");
        assert_eq!(settings.revision, 4, "the next change names the committed revision");
        assert!(!state.is_configuring());
    });
    harness.with_window(cx, |window, cx| {
        window.click("composer-model", cx);
        let menu = window.within("popup-menu");
        assert_eq!(menu.find(item(5)).label(), Some("phi4:latest"));
        window.press("escape", cx);
    });
}

#[gpui_kit::test]
fn a_revision_conflict_reads_the_session_again_and_retries_once(cx: &mut TestAppContext) {
    let harness = open_settings(cx);
    let transport = &harness.transport;
    transport.reply(
        "session.configuration.update",
        Ok(json!({"kind": "revision_conflict", "expectedRevision": 3, "actualRevision": 5})),
    );
    transport.reply("session.catalog.query", Ok(catalog_projection("qwen2.5:7b", "ask", 5)));
    transport.reply(
        "session.configuration.update",
        Ok(committed(&catalog_projection("phi4:latest", "ask", 6))),
    );
    choose_model(&harness, 5, cx);
    settle(cx);
    assert_eq!(
        transport.requests("session.configuration.update"),
        [explicit_update(3, "phi4:latest"), explicit_update(5, "phi4:latest")]
    );
    assert_eq!(
        transport.requests("session.catalog.query").last(),
        Some(&json!({"kind": "get", "sessionId": SESSION}))
    );
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: phi4:latest"));
    harness.with_window(cx, |window, _| {
        assert!(window.find("composer-note").label().is_none(), "no error after the retry");
    });

    // A second conflict in a row is reported, not retried again.
    transport.reply(
        "session.configuration.update",
        Ok(json!({"kind": "revision_conflict", "expectedRevision": 6, "actualRevision": 7})),
    );
    transport.reply("session.catalog.query", Ok(catalog_projection("phi4:latest", "ask", 7)));
    transport.reply(
        "session.configuration.update",
        Ok(json!({"kind": "revision_conflict", "expectedRevision": 7, "actualRevision": 8})),
    );
    choose_model(&harness, 4, cx);
    settle(cx);
    assert_eq!(transport.requests("session.configuration.update").len(), 4);
    harness.with_window(cx, |window, _| {
        assert_eq!(window.find("composer-error").label(), Some(copy::CONFIGURE_CONFLICT.en()));
    });
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: phi4:latest"));
}

#[gpui_kit::test]
fn a_refused_switch_keeps_the_model_and_says_why(cx: &mut TestAppContext) {
    let harness = open_settings(cx);
    harness.transport.reply(
        "session.configuration.update",
        Err(HostRequestError::Operation {
            operation: "session.configuration.update",
            code: HostOperationErrorCode::SessionBusy,
            message: "Session configuration cannot change while a linked Turn is active".into(),
        }),
    );
    choose_model(&harness, 1, cx);
    settle(cx);
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: qwen2.5:7b"));
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("composer-error").label(),
            Some(
                "Couldn’t switch the model. Session configuration cannot change while a linked \
                 Turn is active."
            )
        );
    });
    // Typing clears the reason.
    fill(&harness, "hello", cx);
    harness.with_window(cx, |window, _| assert!(window.try_find("composer-error").is_none()));
}

#[gpui_kit::test]
fn the_model_picker_waits_while_a_turn_runs(cx: &mut TestAppContext) {
    let harness = open_settings(cx);
    run_turn(&harness, Frames::new(), cx);
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("composer-model").label(), Some("Model: qwen2.5:7b"));
        window.click("composer-model", cx);
        assert!(window.try_find("popup-menu").is_none(), "no menu while a turn runs");
    });
    assert!(harness.transport.requests("session.configuration.update").is_empty());
}

fn mode_label(harness: &Harness, cx: &mut TestAppContext) -> Option<String> {
    harness.with_window(cx, |window, _| {
        window.find("composer-permission-mode").label().map(str::to_owned)
    })
}

#[gpui_kit::test]
fn choosing_a_permission_mode_sends_it_alone(cx: &mut TestAppContext) {
    let harness = open_settings(cx);
    assert_eq!(mode_label(&harness, cx).as_deref(), Some("Permission mode: Auto"));
    // The menu offers Maka's three modes, each named over its description.
    harness.with_window(cx, |window, cx| {
        window.click("composer-permission-mode", cx);
        let menu = window.within("popup-menu");
        for (mode, label) in [
            ("explore", copy::PERMISSION_READ_ONLY.en()),
            ("ask", copy::PERMISSION_AUTO.en()),
            ("bypass", copy::PERMISSION_FULL_ACCESS.en()),
        ] {
            assert_eq!(menu.find(format!("permission-mode-{mode}")).label(), Some(label));
        }
        // The session's own mode is no change.
        window.within("popup-menu").click("permission-mode-ask", cx);
    });
    cx.run_until_parked();
    assert!(harness.transport.requests("session.configuration.update").is_empty());

    let answer = harness.transport.hold("session.configuration.update");
    harness.with_window(cx, |window, cx| {
        window.click("composer-permission-mode", cx);
        window.within("popup-menu").click("permission-mode-bypass", cx);
    });
    cx.run_until_parked();
    assert_eq!(
        harness.transport.requests("session.configuration.update"),
        [json!({"sessionId": SESSION, "expectedRevision": 3,
                "patch": {"permissionMode": "bypass"}})]
    );
    assert_eq!(mode_label(&harness, cx).as_deref(), Some("Permission mode: Auto"));
    answer.try_send(Ok(committed(&catalog_projection("qwen2.5:7b", "bypass", 4)))).expect("answer");
    settle(cx);
    assert_eq!(mode_label(&harness, cx).as_deref(), Some("Permission mode: Full access"));
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: qwen2.5:7b"));
}

#[gpui_kit::test]
fn the_permission_mode_stays_switchable_while_a_turn_runs(cx: &mut TestAppContext) {
    let harness = open_settings(cx);
    run_turn(&harness, Frames::new(), cx);
    // Narrowing mid-turn is the Host's to refuse; its reason is shown.
    harness.transport.reply(
        "session.configuration.update",
        Err(HostRequestError::Operation {
            operation: "session.configuration.update",
            code: HostOperationErrorCode::SessionBusy,
            message: "Session configuration cannot change while a linked Turn is active".into(),
        }),
    );
    harness.with_window(cx, |window, cx| {
        window.click("composer-permission-mode", cx);
        window.within("popup-menu").click("permission-mode-explore", cx);
    });
    settle(cx);
    assert_eq!(
        harness.transport.requests("session.configuration.update"),
        [json!({"sessionId": SESSION, "expectedRevision": 3,
                "patch": {"permissionMode": "explore"}})]
    );
    assert_eq!(mode_label(&harness, cx).as_deref(), Some("Permission mode: Auto"));
    harness.with_window(cx, |window, _| {
        assert_eq!(
            window.find("composer-error").label(),
            Some(
                "Couldn’t change the permission mode. Session configuration cannot change while \
                 a linked Turn is active."
            )
        );
    });
}

const KIMI: &str = "c-kimi";

/// The Kimi coding plan: Kimi for Coding offers off, low, high, and max
/// (as the person's own catalog lists it), Kimi K2 offers none.
fn kimi_catalog() -> Value {
    let entry = |item: u64, id: &str, name: &str, levels: &[&str]| {
        json!({"kind": "catalog_entry", "connectionIndex": 0, "itemIndex": item,
               "entry": {"id": id, "displayName": name, "canUseAsChatDefault": true,
                         "isDefault": item == 0, "supportsVision": false,
                         "thinkingLevels": levels}})
    };
    json!({"kind": "page", "revision": 2,
           "defaultTarget": {"connectionId": KIMI, "modelId": "kimi-for-coding"},
           "connectionCount": 1,
           "items": [
               {"kind": "connection", "connectionIndex": 0, "connectionId": KIMI,
                "revision": 1, "slug": "kimi-coding-plan", "name": "Kimi Coding Plan",
                "providerType": "moonshot", "enabled": true, "enabledModelIdCount": 2,
                "modelCount": 0, "catalogEntryCount": 2},
               {"kind": "enabled_model_id", "connectionIndex": 0, "itemIndex": 0,
                "modelId": "kimi-for-coding"},
               {"kind": "enabled_model_id", "connectionIndex": 0, "itemIndex": 1,
                "modelId": "kimi-k2"},
               entry(0, "kimi-for-coding", "Kimi for Coding", &["off", "low", "high", "max"]),
               entry(1, "kimi-k2", "Kimi K2", &[]),
           ],
           "nextCursor": null})
}

/// The synthetic session on the Kimi connection, on `model` at the
/// thinking level `thinking` (absent: the model's default).
fn kimi_session(model: &str, thinking: Option<&str>, revision: u64) -> Value {
    let mut answer = catalog_session(model, "ask");
    let session = &mut answer["session"];
    session["revision"] = json!(revision);
    session["llmConnectionId"] = json!(KIMI);
    session["llmConnectionSlug"] = json!("kimi-coding-plan");
    if let Some(level) = thinking {
        session["thinkingLevel"] = json!(level);
    }
    answer
}

fn open_kimi(model: &str, thinking: Option<&str>, cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    transport.reply("session.catalog.query", Ok(kimi_session(model, thinking, 3)));
    transport.reply("connection.catalog.query", Ok(kimi_catalog()));
    let harness = Harness::open_with_composer(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness
}

fn thinking_label(harness: &Harness, cx: &mut TestAppContext) -> Option<String> {
    harness.with_window(cx, |window, _| {
        window.try_find("composer-thinking-level").and_then(|chip| chip.label().map(str::to_owned))
    })
}

fn kimi_update(model: &str, thinking: Value) -> Value {
    json!({"sessionId": SESSION, "expectedRevision": 3, "patch": {
        "modelTarget": {"kind": "explicit", "connectionId": KIMI,
                        "connectionSlug": "kimi-coding-plan", "model": model},
        "thinkingLevel": thinking
    }})
}

#[gpui_kit::test]
fn the_thinking_level_lists_the_models_levels_and_sends_them_with_its_target(
    cx: &mut TestAppContext,
) {
    let harness = open_kimi("kimi-for-coding", Some("high"), cx);
    assert_eq!(thinking_label(&harness, cx).as_deref(), Some("Thinking level: High"));
    harness.with_window(cx, |window, cx| {
        // Right after the model picker.
        let model = window.find("composer-model").bounds();
        let thinking = window.find("composer-thinking-level").bounds();
        let mode = window.find("composer-permission-mode").bounds();
        assert!(model.right() <= thinking.left() && thinking.right() <= mode.left());
        window.click("composer-thinking-level", cx);
        let menu = window.within("popup-menu");
        let labels: Vec<Option<String>> =
            (0..5).map(|ix| menu.find(item(ix)).label().map(str::to_owned)).collect();
        assert_eq!(
            labels,
            ["Model default", "Off", "Low", "High", "Maximum"].map(|label| Some(label.to_owned()))
        );
        window.within("popup-menu").click(item(2), cx);
    });
    cx.run_until_parked();
    assert_eq!(
        harness.transport.requests("session.configuration.update"),
        [kimi_update("kimi-for-coding", json!("low"))]
    );
    harness.transport.reply(
        "session.configuration.update",
        Ok(committed(&kimi_session("kimi-for-coding", None, 4))),
    );
    // Model default asks for none: `null`.
    harness.with_window(cx, |window, cx| {
        window.click("composer-thinking-level", cx);
        window.within("popup-menu").click(item(0), cx);
    });
    settle(cx);
    let updates = harness.transport.requests("session.configuration.update");
    assert_eq!(updates[1]["patch"]["thinkingLevel"], Value::Null);
    assert_eq!(updates[1]["patch"]["modelTarget"]["model"], "kimi-for-coding");
    assert_eq!(thinking_label(&harness, cx).as_deref(), Some("Thinking level: Model default"));
}

#[gpui_kit::test]
fn a_model_without_levels_has_no_thinking_level_picker(cx: &mut TestAppContext) {
    let harness = open_kimi("kimi-k2", None, cx);
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: Kimi K2"));
    assert_eq!(thinking_label(&harness, cx), None);
}

#[gpui_kit::test]
fn switching_the_model_drops_a_level_the_new_one_does_not_offer(cx: &mut TestAppContext) {
    let harness = open_kimi("kimi-for-coding", Some("max"), cx);
    assert_eq!(thinking_label(&harness, cx).as_deref(), Some("Thinking level: Maximum"));
    harness
        .transport
        .reply("session.configuration.update", Ok(committed(&kimi_session("kimi-k2", None, 4))));
    choose_model(&harness, 2, cx);
    settle(cx);
    assert_eq!(
        harness.transport.requests("session.configuration.update"),
        [kimi_update("kimi-k2", Value::Null)],
        "the level goes back to the model's default with the switch"
    );
    assert_eq!(thinking_label(&harness, cx), None, "Kimi K2 offers none");
}

#[gpui_kit::test]
fn the_thinking_level_waits_while_a_turn_runs(cx: &mut TestAppContext) {
    let harness = open_kimi("kimi-for-coding", Some("low"), cx);
    run_turn(&harness, Frames::new(), cx);
    harness.with_window(cx, |window, cx| {
        assert_eq!(window.find("composer-thinking-level").label(), Some("Thinking level: Low"));
        window.click("composer-thinking-level", cx);
        assert!(window.try_find("popup-menu").is_none(), "no menu while a turn runs");
    });
    assert!(harness.transport.requests("session.configuration.update").is_empty());
}

/// The Kimi session as Maka Desktop left it: its connection id is
/// Desktop's, which this Host's catalog does not list; its slug is the
/// catalog's.
fn desktop_kimi_session(thinking: Option<&str>) -> Value {
    let mut answer = kimi_session("kimi-for-coding", thinking, 3);
    answer["session"]["llmConnectionId"] = json!("desktop-kimi");
    answer
}

fn open_desktop_kimi(catalog: Value, cx: &mut TestAppContext) -> Harness {
    let transport = Arc::new(ScriptedHost::default());
    transport.reply("subscription.open", Ok(open_result(SUBSCRIPTION)));
    transport.reply("session.catalog.query", Ok(desktop_kimi_session(Some("high"))));
    transport.reply("connection.catalog.query", Ok(catalog));
    let harness = Harness::open_with_composer(transport, EPOCH, cx);
    harness.select(SESSION, cx);
    harness
}

/// A task moved over from Maka Desktop names a connection id the catalog
/// does not list: the one connection with its slug is the one it runs on.
/// The thinking level offers that model's levels with the task's checked,
/// and a choice names the catalog's connection, as a model choice does;
/// the Host would refuse Desktop's id.
#[gpui_kit::test]
fn a_task_from_maka_desktop_finds_its_connection_by_slug(cx: &mut TestAppContext) {
    let harness = open_desktop_kimi(kimi_catalog(), cx);
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: Kimi for Coding"));
    assert_eq!(thinking_label(&harness, cx).as_deref(), Some("Thinking level: High"));
    // The model menu has the model it runs as the current one: choosing
    // it sends nothing, so the level stays.
    choose_model(&harness, 1, cx);
    assert!(harness.transport.requests("session.configuration.update").is_empty());
    harness.with_window(cx, |window, cx| {
        window.click("composer-thinking-level", cx);
        let menu = window.within("popup-menu");
        let labels: Vec<Option<String>> =
            (0..5).map(|ix| menu.find(item(ix)).label().map(str::to_owned)).collect();
        assert_eq!(
            labels,
            ["Model default", "Off", "Low", "High", "Maximum"].map(|label| Some(label.to_owned()))
        );
        window.within("popup-menu").click(item(2), cx);
    });
    cx.run_until_parked();
    assert_eq!(
        harness.transport.requests("session.configuration.update"),
        [kimi_update("kimi-for-coding", json!("low"))]
    );
}

/// When two connections share the slug, neither is the task's: no
/// thinking level picker, and the model chip names the model by its id.
#[gpui_kit::test]
fn a_slug_two_connections_share_finds_no_connection(cx: &mut TestAppContext) {
    let mut catalog = kimi_catalog();
    let items = catalog["items"].as_array_mut().expect("items");
    items.push(json!({"kind": "connection", "connectionIndex": 1, "connectionId": "c-kimi-2",
                      "revision": 1, "slug": "kimi-coding-plan", "name": "Kimi again",
                      "providerType": "moonshot", "enabled": true, "enabledModelIdCount": 0,
                      "modelCount": 0, "catalogEntryCount": 0}));
    catalog["connectionCount"] = json!(2);
    let harness = open_desktop_kimi(catalog, cx);
    assert_eq!(model_label(&harness, cx).as_deref(), Some("Model: kimi-for-coding"));
    assert_eq!(thinking_label(&harness, cx), None);
}

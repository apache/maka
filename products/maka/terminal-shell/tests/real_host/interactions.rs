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

use super::{
    activate, commit_native_events, shortcut, support, tab_to_label, wait_enabled_node,
    wait_focused_input,
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
use maka_agent_api::session::StoredSessionConfiguration;
use maka_agent_facts::interaction::{Decision, InteractionOutcome, InteractionRecord};
use maka_app_client::{Client, Operation};
use maka_plugin_core::operation::{OperationOutcome, Receipt};
use nsh_platform_tui::AppView;
use serde_json::{Value, json};
use std::{sync::atomic::Ordering, time::Duration};
use support::{Fixture, ReplyGate, wait_view, wait_view_state};

const PRIVATE_NOTE: &str = "PRIVATE_FORM_VALUE_门口";

async fn publish(fixture: &Fixture, id: &str, mut request: Value) -> InteractionRecord {
    let projection = fixture
        .store
        .session(&fixture.session)
        .await
        .unwrap()
        .session_projection::<StoredSessionConfiguration>(&fixture.session)
        .await
        .unwrap()
        .unwrap();
    if matches!(
        request["kind"].as_str(),
        Some("client_capability" | "computer_app")
    ) {
        let configuration = &projection.session.configuration;
        let binding = projection
            .session
            .workspace_binding
            .as_ref()
            .unwrap()
            .stamp();
        request["basis"] = json!(maka_agent_facts::workspace::PermissionBasis {
            boundary_revision: configuration
                .workspace
                .boundary_revision(configuration.boundary_revision, binding)
                .unwrap(),
            binding,
        });
    }
    // Use the live physical Run, including its invocation identity, rather than
    // the stable logical Turn identity used to present continuations.
    let invocation = projection.root_turn.unwrap().invocation;
    let record: InteractionRecord = serde_json::from_value(json!({
        "sessionId":invocation.session_id,
        "turnId":invocation.turn_id,
        "runId":invocation.run_id,
        "requestId":id,
        "createdAt":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64,
        "request":request,
        "outcome":null
    }))
    .unwrap();
    let established = fixture
        .store
        .session(&fixture.session)
        .await
        .unwrap()
        .establish_run_interaction(&invocation, &record)
        .await
        .unwrap();
    assert!(established.matches);
    established.record
}

fn computer_request() -> Value {
    json!({
        "kind":"client_capability",
        "toolUseId":"original_computer_call",
        "target":maka_workspace_api::computer::target()
    })
}

fn computer_app_request(operation: &str, allow_always: bool) -> Value {
    let mut target = maka_workspace_api::computer::target();
    target.scope = maka_agent_facts::interaction::GrantScope::ComputerApp {
        platform: maka_agent_facts::interaction::ComputerAppPlatform::Macos,
        application_id: "org.example.ConsentFixture".into(),
    };
    json!({
        "kind":"computer_app",
        "toolUseId":"original_computer_app_call",
        "nativeOperationId":operation,
        "target":target,
        "display":{
            "name":"Trusted consent fixture",
            "appPath":"/Volumes/Test/Consent Fixture.app",
            "risk":if allow_always { json!("low") } else { Value::Null },
            "warning":null
        },
        "allowAlways":allow_always,
        "authorityRevision":0
    })
}

fn form_request() -> Value {
    json!({
        "kind":"form", "toolUseId":"original_form_call",
        "message":"Review the original delivery form", "requester":{"name":"Trusted fixture"},
        "fields":[
            {"kind":"string","name":"private_note","label":"Private note","required":true,"default":"Existing delivery note","maxLength":64},
            {"kind":"number","name":"ratio","label":"Ratio","required":true,"default":1.25,"minimum":0,"maximum":2},
            {"kind":"string","name":"optional_note","label":"Optional note","required":false,"maxLength":64},
            {"kind":"integer","name":"copies","label":"Copies","required":true,"default":0,"minimum":0,"maximum":5},
            {"kind":"boolean","name":"confirm","label":"Confirm","required":true,"default":false},
            {"kind":"single_select","name":"plan","label":"Plan","required":true,"default":"basic","options":[{"value":"basic","label":"Basic"},{"value":"full","label":"Full"}]},
            {"kind":"multi_select","name":"extras","label":"Extras","required":true,"default":["logs"],"options":[{"value":"logs","label":"Logs"},{"value":"metrics","label":"Metrics"}]},
            {"kind":"boolean","name":"optional_confirm","label":"Optional confirm","required":false},
            {"kind":"multi_select","name":"optional_extras","label":"Optional extras","required":false,"options":[{"value":"email","label":"Email copy"}]}
        ]
    })
}

async fn wait_request(view: &mut AppView, title: &str, content: &str) {
    wait_view(view, |screen| {
        screen.contains(title) && screen.contains(content)
    })
    .await;
    support::wait_enabled_button(view, "Refresh status").await;
}

fn escape(view: &mut AppView) {
    view.handle_event(Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)));
}

async fn await_response_gate(view: &mut AppView, gate: &ReplyGate) {
    tokio::time::timeout(Duration::from_secs(20), async {
        let held = gate.held.notified();
        tokio::pin!(held);
        loop {
            support::tick(view);
            tokio::select! {
                () = &mut held => break,
                () = tokio::time::sleep(Duration::from_millis(5)) => {}
            }
        }
    })
    .await
    .expect("the single native click did not reach the real respond receipt");
}

async fn original_response(client: &Client, request_id: &str) -> Operation {
    let mut originals = client.pending_controls().await.unwrap();
    assert_eq!(
        originals.len(),
        1,
        "one physical click must reserve one attempt"
    );
    let original = originals.remove(0);
    let target = client.describe("agent").await.unwrap();
    assert_eq!(original.method, "respond");
    assert_eq!(
        original.correlation,
        json!({"kind":"agent-control","owner":{"namespace":target.provider,"export":target.export},"requestId":request_id})
    );
    assert!(original.reference.is_some());
    assert!(original.receipt.is_none());
    original
}

async fn assert_response_receipt(
    client: &Client,
    original: &Operation,
    record: &InteractionRecord,
) {
    let settled = client.operation_for_control(original.id).await.unwrap();
    assert_eq!(settled.reference, original.reference);
    assert_eq!(
        settled.session_id.as_deref(),
        Some(record.session_id.as_str())
    );
    let Some(Receipt::Recorded {
        outcome: OperationOutcome::Returned { value },
        ..
    }) = settled.receipt
    else {
        panic!("the original response did not retain its real recorded receipt");
    };
    assert_eq!(value, json!({"kind":"recorded","record":record}));
    assert!(client.pending_controls().await.unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn computer_consent_keeps_the_original_target_boundary_and_single_click_receipt() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let gate = ReplyGate::respond(fixture.directory.path(), fixture.address.clone());
        let client = fixture.client_at(&gate.address).await;
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Keep the original consent Run active","model":fixture.selection})).await;
        let request = fixture.next_request().await;
        let denied = publish(&fixture, "native_computer_deny", computer_request()).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_request(&mut view, "Capability request", "Computer access for this session").await;
        wait_view(&mut view, |screen| screen.contains("Computer access for this session") && screen.contains("cua_repl") && screen.contains("Permission boundary: 0")).await;
        wait_focused_input(&mut view, "Message composer").await;
        let composer = view.surface().focused().unwrap();
        view.handle_event(Event::Paste("The original consent draft stays here".into()));
        commit_native_events(&mut view).await;
        let caret = view.surface().input_context().unwrap().selection;
        tab_to_label(&mut view, "Deny").await;
        escape(&mut view);
        wait_focused_input(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("The original consent draft stays here"));
        assert_eq!(view.surface().input_context().unwrap().selection, caret);
        // Returning to the resident editor keeps the independent request
        // reader's position. Read its beginning and complete original target
        // through the real native Scroll rather than requiring both ends at once.
        tab_to_label(&mut view, "Request content").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE)));
        wait_request(&mut view, "Capability request", "Computer access for this session").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| {
            screen.contains("Request details")
                && screen.contains("Provider: maka_workspace_computer")
                && screen.contains("Contract: maka_workspace_computer_v1")
                && screen.contains("Server: maka_workspace_computer")
                && screen.contains("Tool: cua_repl")
                && screen.contains("Capability: computer_use")
                && screen.contains("Scope: {\"kind\":\"capability\"}")
                && screen.contains("Permission boundary: 0")
        }).await;
        assert!(view.accessibility_snapshot().iter().any(|node| node.label == format!("Session: {}", fixture.session)));
        assert!(fixture.store.session(&fixture.session).await.unwrap().interaction(&denied.request_id).await.unwrap().unwrap().outcome.is_none());
        assert!(client.pending_controls().await.unwrap().is_empty());

        wait_enabled_node(&mut view, "Deny").await;
        support::click_button(&mut view, "Deny").await;
        wait_view(&mut view, |screen| screen.contains("Capability denied")).await;
        assert!(matches!(fixture.store.session(&fixture.session).await.unwrap().interaction(&denied.request_id).await.unwrap().unwrap().outcome, Some(InteractionOutcome::ClientCapabilityDecision { decision: Decision::Deny, .. })));
        let target = maka_workspace_api::computer::target();
        assert!(fixture.store.session(&fixture.session).await.unwrap().client_capability_grant(&fixture.session, &target).await.unwrap().is_none());
        wait_view(&mut view, |screen| !screen.contains("Capability request")).await;

        let allowed = publish(&fixture, "native_computer_allow", computer_request()).await;
        wait_request(&mut view, "Capability request", "Computer access for this session").await;
        wait_enabled_node(&mut view, "Allow").await;
        gate.arm();
        support::click_button(&mut view, "Allow").await;
        await_response_gate(&mut view, &gate).await;
        let original = original_response(&client, &allowed.request_id).await;
        wait_view_state(&mut view, |view, screen| {
            screen.contains("Confirming action")
                && !view.accessibility_snapshot().iter().any(|node| node.label == "Pending request")
        }).await;
        let canonical = fixture.store.session(&fixture.session).await.unwrap().interaction(&allowed.request_id).await.unwrap().unwrap();
        assert!(matches!(canonical.outcome, Some(InteractionOutcome::ClientCapabilityDecision { decision: Decision::Allow, .. })));
        let grant = fixture.store.session(&fixture.session).await.unwrap().client_capability_grant(&fixture.session, &target).await.unwrap().unwrap();
        assert_eq!(grant.session_id, fixture.session);
        assert_eq!(grant.target, target);
        assert_eq!(grant.basis.unwrap().boundary_revision, 0);
        assert_eq!(serde_json::to_value(grant.basis).unwrap(), serde_json::to_value(&allowed.request).unwrap()["basis"]);
        gate.release();
        wait_view(&mut view, |screen| screen.contains("Capability allowed")).await;
        assert_response_receipt(&client, &original, &canonical).await;

        let roots = client.query("agent", "directories", json!({"kind":"roots"})).await.unwrap();
        let other = support::mutate(&client, "create", json!({"title":"Other consent owner","labels":[],"workspace":{"kind":"directory","selection":roots["roots"][0]["selection"]}})).await;
        assert!(fixture.store.session(other["session"]["id"].as_str().unwrap()).await.unwrap().client_capability_grant(other["session"]["id"].as_str().unwrap(), &target).await.unwrap().is_none());
        let mut other_provider = target.clone();
        other_provider.provider_id = "other_computer_provider".into();
        assert!(fixture.store.session(&fixture.session).await.unwrap().client_capability_grant(&fixture.session, &other_provider).await.unwrap().is_none());
        let before = fixture.store.get_session::<StoredSessionConfiguration>(&fixture.session).await.unwrap().unwrap();
        let changed = support::mutate(&client, "metadata", json!({
            "sessionId":fixture.session,"expectedRevision":before.revision,
            "title":before.configuration.title,"labels":before.configuration.labels,
            "permissions":{"settings":before.configuration.permissions,"revokeGrants":true}
        })).await;
        assert_eq!(changed["kind"], "committed");
        assert!(fixture.store.session(&fixture.session).await.unwrap().client_capability_grant(&fixture.session, &target).await.unwrap().is_none());
        assert_eq!(fixture.store.session(&fixture.session).await.unwrap().interaction(&allowed.request_id).await.unwrap().unwrap(), canonical);
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1, "consent must not send another model request");
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host computer consent workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn app_consent_ui_shows_trusted_identity_and_commits_only_offered_choices() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Keep the app consent fixture Run active","model":fixture.selection})).await;
        let original = fixture.next_request().await;
        let pending = publish(&fixture, "app_consent_unknown", computer_app_request("native_unknown", false)).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_request(&mut view, "Application access request", "Trusted consent fixture").await;
        wait_view(&mut view, |screen| screen.contains("/Volumes/Test/Consent Fixture.app") && screen.contains("org.example.ConsentFixture")).await;
        tab_to_label(&mut view, "Request content").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        wait_view(&mut view, |screen| screen.contains("Application risk is unknown.")).await;
        for choice in ["Allow once", "Allow for this session", "Deny", "Cancel request"] {
            wait_enabled_node(&mut view, choice).await;
        }
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "Always allow"));
        let rejected = support::mutate(&client, "respond", json!({
            "sessionId":fixture.session,"requestId":pending.request_id,
            "answer":{"kind":"computer_app","decision":"always"}
        })).await;
        assert_eq!(rejected, json!({"kind":"rejected","reason":"invalid_answer"}));
        assert!(fixture.store.session(&fixture.session).await.unwrap().interaction(&pending.request_id).await.unwrap().unwrap().outcome.is_none());
        support::click_button(&mut view, "Deny").await;
        wait_view(&mut view, |screen| screen.contains("Application access denied")).await;
        assert!(matches!(fixture.store.session(&fixture.session).await.unwrap().interaction(&pending.request_id).await.unwrap().unwrap().outcome,
            Some(InteractionOutcome::ComputerAppDecision { decision:maka_agent_facts::interaction::ComputerAppDecision::Deny, .. })));

        for (id, button, expected) in [
            ("app_consent_once", "Allow once", "once"),
            ("app_consent_session", "Allow for this session", "session"),
            ("app_consent_always", "Always allow", "always"),
            ("app_consent_cancel", "Cancel request", "cancel"),
        ] {
            let record = publish(&fixture, id, computer_app_request(id, true)).await;
            wait_request(&mut view, "Application access request", "Trusted consent fixture").await;
            wait_enabled_node(&mut view, "Always allow").await;
            support::click_button(&mut view, button).await;
            let canonical = loop {
                view.poll().unwrap();
                support::tick(&mut view);
                assert!(view.last_error().is_none(), "{:?}", view.last_error());
                let current = fixture.store.session(&fixture.session).await.unwrap().interaction(&record.request_id).await.unwrap().unwrap();
                if current.outcome.is_some() {
                    break current;
                }
                tokio::task::yield_now().await;
            };
            wait_view(&mut view, |screen| screen.contains(if expected == "cancel" { "Request closed" } else { "Application access allowed" })).await;
            let outcome = serde_json::to_value(canonical.outcome.unwrap()).unwrap();
            if expected == "cancel" {
                assert_eq!(outcome["kind"], "closure");
                assert_eq!(outcome["reason"], "producer_cancelled");
            } else {
                assert_eq!(outcome["kind"], "computer_app_decision");
                assert_eq!(outcome["decision"], expected);
            }
            assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1, "consent must not issue another model request");
        }
        original.finish().await;
        fixture.idle(&client, &fixture.session).await;
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host app consent UI workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn computer_audio_consent_is_an_independent_session_capability() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Keep the audio consent fixture Run active","model":fixture.selection})).await;
        let original = fixture.next_request().await;
        let target = maka_workspace_api::computer::audio_target();
        let pending = publish(&fixture, "computer_audio_consent", json!({
            "kind":"client_capability","toolUseId":"original_output_audio_call","target":target
        })).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_request(&mut view, "Capability request", "Computer output audio for this session").await;
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.label.contains("record audio played by the computer"))).await;
        wait_enabled_node(&mut view, "Allow").await;
        assert!(!view.accessibility_snapshot().iter().any(|node| node.label == "Always allow"));
        support::click_button(&mut view, "Allow").await;
        wait_view(&mut view, |screen| screen.contains("Capability allowed")).await;
        let store = fixture.store.session(&fixture.session).await.unwrap();
        assert!(matches!(store.interaction(&pending.request_id).await.unwrap().unwrap().outcome,
            Some(InteractionOutcome::ClientCapabilityDecision { decision:Decision::Allow, .. })));
        let audio = store.client_capability_grant(&fixture.session, &target).await.unwrap().unwrap();
        assert_eq!(audio.target, target);
        assert_eq!(audio.basis.unwrap().boundary_revision, 0);
        assert!(store.client_capability_grant(&fixture.session, &maka_workspace_api::computer::target()).await.unwrap().is_none());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        original.finish().await;
        fixture.idle(&client, &fixture.session).await;
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host computer output audio consent workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn app_stop_controls_remain_independent_while_another_original_receipt_is_held() {
    tokio::time::timeout(Duration::from_secs(90), async {
        use maka_agent_api::contract::WorkspaceAccess;
        use maka_agent_facts::event::{
            EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent,
        };
        use maka_agent_facts::execution::{
            ApprovalPolicy, BehaviorId, InvocationConfiguration, SandboxMode, ToolMode,
            WorkspaceOrigin,
        };
        use maka_agent_facts::interaction::{
            ComputerAppDecision, ComputerAppDisplay, ComputerAppPlatform, GrantScope,
            InteractionRequest,
        };
        let fixture = Fixture::open().await;
        let store = fixture.store.session(&fixture.session).await.unwrap();
        let configuration = store
            .get::<StoredSessionConfiguration>()
            .await
            .unwrap()
            .unwrap();
        let stamp = configuration.workspace_binding.as_ref().unwrap().stamp();
        let basis = maka_agent_facts::workspace::PermissionBasis {
            boundary_revision: configuration
                .configuration
                .workspace
                .boundary_revision(configuration.configuration.boundary_revision, stamp)
                .unwrap(),
            binding: stamp,
        };
        let invocation = Invocation {
            session_id: fixture.session.clone(),
            turn_id: "ui-stop-turn".into(),
            run_id: "ui-stop-run".into(),
            invocation_id: "ui-stop-invocation".into(),
        };
        store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::InvocationOpened {
                        configuration: Some(Box::new(InvocationConfiguration {
                            language: maka_agent_facts::language::Language::En,
                            compaction_prompt: None,
                            editing_tools: None,
                            tool_discovery: false,
                            tool_composition: None,
                            system_prompt: None,
                            cwd: fixture
                                .directory
                                .path()
                                .join("workspace")
                                .to_string_lossy()
                                .into_owned(),
                            workspace_identity: None,
                            workspace_binding: Some(stamp),
                            workspace_origin: WorkspaceOrigin::Selected,
                            sandbox_mode: match configuration.configuration.permissions.access {
                                WorkspaceAccess::ReadOnly => SandboxMode::ReadOnly,
                                WorkspaceAccess::WorkspaceWrite => SandboxMode::WorkspaceWrite,
                                WorkspaceAccess::DangerFullAccess => SandboxMode::DangerFullAccess,
                            },
                            approval_policy: if configuration
                                .configuration
                                .permissions
                                .request_permissions
                            {
                                ApprovalPolicy::OnRequest
                            } else {
                                ApprovalPolicy::Never
                            },
                            boundary_revision: basis.boundary_revision,
                            collaboration_mode: configuration.configuration.collaboration_mode,
                            orchestration_mode: BehaviorId::default(),
                            tool_mode: ToolMode::Direct,
                            code_language: Default::default(),
                            model: None,
                            thinking_level: None,
                        })),
                        input: InvocationInput::Message {
                            source_messages: Vec::new(),
                            content: "Host app Stop UI fixture".into(),
                            request_fingerprint: None,
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::ExecutorStarted {
                        binding: maka_agent_facts::executor::Binding {
                            executor_id: "fixture".to_owned().try_into().unwrap(),
                            package_id: "fixture".into(),
                            entry_id: "computer-access".into(),
                            activation: "ui-stop-executor".into(),
                        },
                        settings: Default::default(),
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        let broad = maka_workspace_api::computer::target();
        let consent = |id: &str, request| InteractionRecord {
            session_id: fixture.session.clone(),
            turn_id: invocation.turn_id.clone(),
            run_id: invocation.run_id.clone(),
            request_id: id.into(),
            created_at: 1,
            request,
            outcome: None,
        };
        store
            .establish_run_interaction(
                &invocation,
                &consent(
                    "ui-stop-broad",
                    InteractionRequest::ClientCapability {
                        tool_use_id: "ui-stop-tool".into(),
                        target: broad.clone(),
                        basis: Some(basis),
                    },
                ),
            )
            .await
            .unwrap();
        store
            .commit_interaction_outcome(
                "ui-stop-broad",
                InteractionOutcome::ClientCapabilityDecision {
                    decision: Decision::Allow,
                    committed_at: 2,
                },
            )
            .await
            .unwrap();
        for (id, name) in [
            ("first", "First controlled app"),
            ("second", "Second controlled app"),
        ] {
            let mut target = broad.clone();
            target.scope = GrantScope::ComputerApp {
                platform: ComputerAppPlatform::Macos,
                application_id: format!("org.example.{id}"),
            };
            let display = ComputerAppDisplay {
                name: name.into(),
                app_path: format!("/{id}.app"),
                risk: None,
                warning: None,
            };
            store
                .establish_run_interaction(
                    &invocation,
                    &consent(
                        id,
                        InteractionRequest::ComputerApp {
                            tool_use_id: "ui-stop-tool".into(),
                            native_operation_id: id.into(),
                            target: target.clone(),
                            basis,
                            display: display.clone(),
                            allow_always: false,
                            authority_revision: 0,
                        },
                    ),
                )
                .await
                .unwrap();
            store
                .commit_interaction_outcome(
                    id,
                    InteractionOutcome::ComputerAppDecision {
                        decision: ComputerAppDecision::Session,
                        committed_at: 2,
                    },
                )
                .await
                .unwrap();
            let event = EventWrite::plain(RuntimeEvent::new(
                invocation.clone(),
                Fact::ToolDispatched {
                    presentation: None,
                    title: None,
                    operation_id: id.into(),
                    call: maka_agent_facts::tool_call::ToolCallIdentity {
                        tool_call_id: format!("call-{id}"),
                        origin: maka_agent_facts::tool_call::ToolOrigin::HostSdk {
                            package_id: "workspace.computer".into(),
                            entry_id: "computer".into(),
                            activation: format!("ui-stop-{id}"),
                            parent: None,
                        },
                    },
                    name: "native-fixture".into(),
                    input: json!({}),
                },
            ))
            .unwrap();
            store
                .append_computer_app_dispatch(
                    &event,
                    std::slice::from_ref(&broad),
                    &target,
                    &display,
                    &basis,
                )
                .await
                .unwrap();
            let (settled, _) = EventWrite::tool_success(
                format!("settled-{id}"),
                std::time::SystemTime::now(),
                invocation.clone(),
                id.into(),
                maka_agent_facts::tool_output::ToolOutput::Text(
                    "Completed fixture without native input".into(),
                )
                .into(),
            )
            .unwrap();
            store.append(&settled).await.unwrap();
        }
        let gate = ReplyGate::stop_computer_app(fixture.directory.path(), fixture.address.clone());
        let client = fixture.client_at(&gate.address).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_enabled_node(&mut view, "Stop access to First controlled app").await;
        wait_enabled_node(&mut view, "Stop access to Second controlled app").await;
        gate.arm();
        support::click_button(&mut view, "Stop access to First controlled app").await;
        await_response_gate(&mut view, &gate).await;
        wait_view_state(&mut view, |view, _| {
            view.accessibility_snapshot().iter().any(|node| {
                node.label == "Stop access to First controlled app" && node.state.disabled
            })
        })
        .await;
        let originals = client.pending_controls().await.unwrap();
        let first = originals
            .iter()
            .find(|operation| {
                operation.method == "stopComputerApp"
                    && operation.correlation["operationId"] == "first"
            })
            .expect("original app Stop receipt missing");
        let target = client.describe("agent").await.unwrap();
        assert_eq!(
            first.correlation,
            json!({"kind":"agent-control","owner":{"namespace":target.provider,"export":target.export},"operationId":"first"})
        );
        wait_enabled_node(&mut view, "Stop access to Second controlled app").await;
        tab_to_label(&mut view, "Computer application access").await;
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE)));
        support::click_button(&mut view, "Stop access to Second controlled app").await;
        wait_view_state(&mut view, |view, _| {
            view.accessibility_snapshot().iter().any(|node| {
                node.label == "Stop access to Second controlled app" && node.state.disabled
            })
        })
        .await;
        let stopped: std::collections::BTreeMap<_, _> = store
            .computer_apps(&fixture.session)
            .await
            .unwrap()
            .into_iter()
            .map(|(activity, stopped)| (activity.operation_id, stopped))
            .collect();
        assert_eq!(
            stopped,
            std::collections::BTreeMap::from([
                ("first".to_owned(), true),
                ("second".to_owned(), true)
            ])
        );
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 0);
        gate.release();
        store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::ExecutorCompleted {
                        text: "Completed computer application access fixture".into(),
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation,
                    Fact::InvocationEnded {
                        outcome: InvocationOutcome::Completed,
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        wait_view(&mut view, |screen| {
            !screen.contains("Computer access this turn")
        })
        .await;
        bindings.close().await.unwrap();
        fixture.finish().await;
    })
    .await
    .expect("real Host app Stop controls workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn inline_questions_keep_their_draft_and_submit_only_from_the_request_seat() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let gate = ReplyGate::respond(fixture.directory.path(), fixture.address.clone());
        let client = fixture.client_at(&gate.address).await;
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Keep the original question Run active","model":fixture.selection})).await;
        let request = fixture.next_request().await;
        let question = publish(&fixture, "inline_question_original", json!({
            "kind":"question", "toolUseId":"original_question_call",
            "questions":[
                {"question":"Which release should we use?","options":[{"label":"Stable"},{"label":"Preview"}]},
                {"question":"Add diagnostics?","options":[{"label":"Collect"},{"label":"Omit"}]}
            ]
        })).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_request(&mut view, "A question for you", "Which release should we use?").await;
        wait_focused_input(&mut view, "Message composer").await;
        let composer = view.surface().focused().unwrap();
        view.handle_event(Event::Paste("The message draft remains separate".into()));
        commit_native_events(&mut view).await;
        let composer_caret = view.surface().input_context().unwrap().selection;
        activate(&mut view, "Other answer").await;
        tab_to_label(&mut view, "Other answer 1").await;
        wait_focused_input(&mut view, "Other answer 1").await;
        let original_answer = format!("原始答案 · 门口 {}", "完整答案保持原文 ".repeat(512));
        view.handle_event(Event::Paste(original_answer.clone()));
        commit_native_events(&mut view).await;
        let answer_editor = view.surface().focused().unwrap();
        let answer_caret = view.surface().input_context().unwrap().selection;

        let next = publish(&fixture, "inline_question_next_capability", computer_request()).await;
        let pending = client.query("agent", "pendingInteractions", json!({"sessionId":fixture.session})).await.unwrap();
        assert_eq!(pending["entries"].as_array().unwrap().len(), 2);
        shortcut(&mut view, 'r');
        commit_native_events(&mut view).await;
        support::wait_enabled_button(&mut view, "Refresh status").await;
        assert_eq!(view.surface().focused(), Some(answer_editor));
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(original_answer.as_str()));
        assert_eq!(view.surface().input_context().unwrap().selection, answer_caret);
        activate(&mut view, "Skip").await;
        wait_enabled_node(&mut view, "Submit answers").await;
        view.resize(80, 24);
        escape(&mut view);
        wait_focused_input(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().selection, composer_caret);
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("The message draft remains separate"));
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL)));
        commit_native_events(&mut view).await;
        assert!(fixture.store.session(&fixture.session).await.unwrap().interaction(&question.request_id).await.unwrap().unwrap().outcome.is_none());
        assert!(client.pending_controls().await.unwrap().is_empty());
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);

        gate.arm();
        support::click_button(&mut view, "Submit answers").await;
        await_response_gate(&mut view, &gate).await;
        let original = original_response(&client, &question.request_id).await;
        let canonical = fixture.store.session(&fixture.session).await.unwrap().interaction(&question.request_id).await.unwrap().unwrap();
        assert_eq!(serde_json::to_value(&canonical).unwrap()["outcome"]["answers"], json!([original_answer, null]));
        wait_request(&mut view, "Capability request", "Computer access for this session").await;
        assert!(view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Allow" && node.state.disabled));
        tab_to_label(&mut view, "Message composer").await;
        wait_focused_input(&mut view, "Message composer").await;
        assert_eq!(view.surface().focused(), Some(composer));
        assert_eq!(view.surface().input_context().unwrap().selection, composer_caret);
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("The message draft remains separate"));
        gate.release();
        wait_view(&mut view, |screen| screen.contains("Answers submitted")).await;
        assert_response_receipt(&client, &original, &canonical).await;
        wait_enabled_node(&mut view, "Deny").await;
        support::click_button(&mut view, "Deny").await;
        wait_view(&mut view, |screen| screen.contains("Capability denied")).await;
        assert!(matches!(fixture.store.session(&fixture.session).await.unwrap().interaction(&next.request_id).await.unwrap().unwrap().outcome, Some(InteractionOutcome::ClientCapabilityDecision { decision: Decision::Deny, .. })));
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host inline question workflow timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn structured_form_defaults_omission_validation_masking_and_receipt_are_real() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::open().await;
        let gate = ReplyGate::respond(fixture.directory.path(), fixture.address.clone());
        let client = fixture.client_at(&gate.address).await;
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Keep the original form Run active","model":fixture.selection})).await;
        let request = fixture.next_request().await;
        let record = publish(&fixture, "native_structured_form", form_request()).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_request(&mut view, "Form request", "Review the original delivery form").await;
        wait_enabled_node(&mut view, "Submit form").await;
        for (label, selected) in [("No · Confirm", true), ("Basic", true), ("Logs", true), ("Include Optional confirm", false), ("Include Optional extras", false)] {
            assert!(view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == label && node.state.selected == selected && !node.state.disabled), "the original defaults or omission state were not presented: {label} selected={selected}");
        }
        tab_to_label(&mut view, "Ratio").await;
        wait_focused_input(&mut view, "Ratio").await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("1.25"));
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste("invalid-number".into()));
        commit_native_events(&mut view).await;
        assert!(view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Submit form" && node.state.disabled));
        view.handle_event(Event::Key(KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL)));
        commit_native_events(&mut view).await;
        assert!(fixture.store.session(&fixture.session).await.unwrap().interaction(&record.request_id).await.unwrap().unwrap().outcome.is_none());
        assert!(client.pending_controls().await.unwrap().is_empty());
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste("1.25".into()));
        commit_native_events(&mut view).await;
        wait_enabled_node(&mut view, "Submit form").await;

        activate(&mut view, "Include Optional note").await;
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Omit Optional note" && node.state.selected && !node.state.disabled)).await;
        tab_to_label(&mut view, "Optional note").await;
        wait_focused_input(&mut view, "Optional note").await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some(""));
        tab_to_label(&mut view, "Copies").await;
        wait_focused_input(&mut view, "Copies").await;
        assert_eq!(view.surface().input_context().unwrap().text.as_deref(), Some("0"));
        for (label, before, after) in [("Full", false, true), ("Metrics", false, true), ("Logs", true, false)] {
            wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == label && node.state.selected == before && !node.state.disabled)).await;
            activate(&mut view, label).await;
            wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == label && node.state.selected == after && !node.state.disabled)).await;
        }
        activate(&mut view, "Hide Private note").await;
        wait_enabled_node(&mut view, "Reveal Private note").await;
        tab_to_label(&mut view, "Private note").await;
        wait_focused_input(&mut view, "Private note").await;
        shortcut(&mut view, 'a');
        view.handle_event(Event::Paste(PRIVATE_NOTE.into()));
        commit_native_events(&mut view).await;
        let context = view.surface().input_context().unwrap();
        assert!(context.secure);
        assert_eq!(context.text, None);
        let masked = wait_view_state(&mut view, |view, screen| view.accessibility_snapshot().iter().any(|node| node.role == nsh_core::AccessibilityRole::Button && node.label == "Reveal Private note" && !node.state.disabled) && !screen.contains(PRIVATE_NOTE)).await;
        assert!(!format!("{:?}", view.accessibility_snapshot()).contains(PRIVATE_NOTE));
        support::evidence("structured-form-masked", &masked);
        let private_editor = view.surface().focused().unwrap();
        let private_caret = view.surface().input_context().unwrap().selection;
        shortcut(&mut view, 'r');
        commit_native_events(&mut view).await;
        support::wait_enabled_button(&mut view, "Refresh status").await;
        assert_eq!(view.surface().focused(), Some(private_editor));
        let refreshed = view.surface().input_context().unwrap();
        assert_eq!(refreshed.selection, private_caret);
        assert!(refreshed.secure);
        assert_eq!(refreshed.text, None);
        assert!(!format!("{:?}", view.accessibility_snapshot()).contains(PRIVATE_NOTE));

        wait_enabled_node(&mut view, "Submit form").await;
        gate.arm();
        support::click_button(&mut view, "Submit form").await;
        await_response_gate(&mut view, &gate).await;
        let original = original_response(&client, &record.request_id).await;
        let canonical = fixture.store.session(&fixture.session).await.unwrap().interaction(&record.request_id).await.unwrap().unwrap();
        let encoded = serde_json::to_value(&canonical).unwrap();
        assert_eq!(encoded["outcome"]["action"], "accept");
        assert_eq!(encoded["outcome"]["values"], json!({
            "private_note":PRIVATE_NOTE,"ratio":1.25,"optional_note":"","copies":0.0,
            "confirm":false,"plan":"full","extras":["metrics"]
        }));
        gate.release();
        let submitted = wait_view(&mut view, |screen| screen.contains("Form submitted · 7 fields")).await;
        assert!(!submitted.contains(PRIVATE_NOTE));
        assert!(!format!("{:?}", view.accessibility_snapshot()).contains(PRIVATE_NOTE));
        assert_response_receipt(&client, &original, &canonical).await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        support::evidence("structured-form-submitted", &submitted);
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host structured form workflow timed out");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_production_pty_leaves_requests_unanswered_then_records_cancel_and_decline() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut fixture = Fixture::configured(support::Options { registered: true, ..Default::default() }).await;
        let client = fixture.client().await;
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Keep physical form decisions active","model":fixture.selection})).await;
        let request = fixture.next_request().await;
        let prompt = json!({"kind":"form","toolUseId":"physical_form_call","message":"Physical form decision","requester":{"name":"Trusted fixture"},"fields":[]});
        let cancelled = publish(&fixture, "physical_form_cancel", prompt.clone()).await;
        let mut terminal = support::pty::Pty::spawn(env!("CARGO_BIN_EXE_maka"), &fixture.directory.path().join("host"), Some(&fixture.session));
        terminal.wait_for("Physical form decision").await;
        // Reading the original detail enters this request's keyboard scope.
        // Escape returns to the editor without answering or stopping the Run.
        terminal.click_text("Physical form decision");
        terminal.send(b"\x1b");
        terminal.wait_for("Physical form decision").await;
        assert!(fixture.store.session(&fixture.session).await.unwrap().interaction(&cancelled.request_id).await.unwrap().unwrap().outcome.is_none());
        assert!(client.pending_controls().await.unwrap().is_empty());
        terminal.wait_for("Cancel request").await;
        terminal.click_text("Cancel request");
        terminal.wait_for("Form cancelled").await;
        assert_eq!(serde_json::to_value(fixture.store.session(&fixture.session).await.unwrap().interaction(&cancelled.request_id).await.unwrap().unwrap()).unwrap()["outcome"]["action"], "cancel");
        terminal.wait_for_absent("Form request").await;

        let declined = publish(&fixture, "physical_form_decline", prompt).await;
        terminal.wait_for("Physical form decision").await;
        terminal.wait_for("Decline").await;
        terminal.click_text("Decline");
        let screen = terminal.wait_for("Form declined").await;
        assert_eq!(serde_json::to_value(fixture.store.session(&fixture.session).await.unwrap().interaction(&declined.request_id).await.unwrap().unwrap()).unwrap()["outcome"]["action"], "decline");
        support::evidence("production-pty-form-declined", &screen);
        terminal.wait_for_absent("Form request").await;
        assert_eq!(fixture.request_count.load(Ordering::SeqCst), 1);
        request.finish().await;
        fixture.idle(&client, &fixture.session).await;
        terminal.send(b"\x11");
        terminal.finish().await;
        client.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("production PTY form decisions timed out");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn browser_file_download_consent_is_visible_and_does_not_grant_page_access() {
    tokio::time::timeout(Duration::from_secs(90), async {
        use maka_agent_facts::interaction::{GrantCapability, GrantScope};
        let mut fixture = Fixture::open().await;
        let client = fixture.client().await;
        support::mutate(&client, "send", json!({"sessionId":fixture.session,"message":"Keep the download consent fixture Run active","model":fixture.selection})).await;
        let original = fixture.next_request().await;
        let mut target = maka_workspace_api::computer::target();
        target.capability = GrantCapability::BrowserDownload;
        target.scope = GrantScope::BrowserOrigin { origin: "https://download.example".into() };
        let pending = publish(&fixture, "browser_download_consent", json!({
            "kind":"client_capability", "toolUseId":"original_download_call", "target":target
        })).await;
        let (mut view, bindings) = fixture.view(client.clone(), Some(fixture.session.clone()));
        wait_request(&mut view, "Capability request", "Browser file downloads for this session").await;
        wait_view_state(&mut view, |view, _| view.accessibility_snapshot().iter().any(|node|
            node.label.contains("download files from the displayed browser origin"))).await;
        wait_enabled_node(&mut view, "Allow").await;
        support::click_button(&mut view, "Allow").await;
        wait_view(&mut view, |screen| screen.contains("Capability allowed")).await;
        let store = fixture.store.session(&fixture.session).await.unwrap();
        let download = store.client_capability_grant(&fixture.session, &target).await.unwrap().unwrap();
        assert_eq!(download.target, target);
        let mut page = target.clone();
        page.capability = GrantCapability::Browser;
        assert!(store.client_capability_grant(&fixture.session, &page).await.unwrap().is_none());
        assert!(matches!(store.interaction(&pending.request_id).await.unwrap().unwrap().outcome,
            Some(InteractionOutcome::ClientCapabilityDecision { decision: Decision::Allow, .. })));
        original.finish().await;
        fixture.idle(&client, &fixture.session).await;
        bindings.close().await.unwrap();
        fixture.finish().await;
    }).await.expect("real Host browser file download consent workflow timed out");
}

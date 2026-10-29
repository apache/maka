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
use maka_agent_facts::event::{EventWrite, Fact, Invocation, InvocationInput, RuntimeEvent};
use maka_agent_facts::interaction::{ComputerAppDisplay, ComputerAppPlatform, Decision};
use maka_agent_facts::workspace::BindingStamp;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::oneshot;

#[tokio::test]
async fn app_stop_cancels_only_its_original_promise_and_waits_for_real_cleanup() {
    for unknown in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let owner = maka_event_log::root::RootOwner::create(
            &dir.path().join("root"),
            &maka_event_log::root::RootNamespaces {
                ownership: dir.path().join("ownership"),
                control: dir.path().join("control"),
            },
        )
        .unwrap();
        let root = maka_event_log::RootStore::open(Arc::new(owner))
            .await
            .unwrap();
        let reference = root
            .attach_workspace("fixture", &serde_json::json!({"path":"/fixture"}))
            .await
            .unwrap();
        let basis = PermissionBasis {
            boundary_revision: 0,
            binding: BindingStamp {
                id: reference.id,
                permission_epoch: 0,
            },
        };
        let store = root
            .create_session(
                "session",
                "fixture",
                &serde_json::json!({"workspace":reference,"boundary_revision":0}),
                1,
            )
            .await
            .unwrap();
        let invocation = Invocation {
            session_id: "session".into(),
            turn_id: "turn".into(),
            run_id: "run".into(),
            invocation_id: "invocation".into(),
        };
        store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    invocation.clone(),
                    Fact::InvocationOpened {
                        configuration: None,
                        input: InvocationInput::Message {
                            source_messages: Vec::new(),
                            content: "fixture".into(),
                            request_fingerprint: None,
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        let display = ComputerAppDisplay {
            name: "Fixture application".into(),
            app_path: "/Applications/Fixture.app".into(),
            risk: None,
            warning: None,
        };
        let app = GrantTarget {
            scope: GrantScope::ComputerApp {
                platform: ComputerAppPlatform::Macos,
                application_id: "fixture.app".into(),
            },
            ..api::target()
        };
        let record = |id: &str, request| InteractionRecord {
            session_id: invocation.session_id.clone(),
            turn_id: invocation.turn_id.clone(),
            run_id: invocation.run_id.clone(),
            request_id: id.into(),
            created_at: 2,
            request,
            outcome: None,
        };
        store
            .establish_run_interaction(
                &invocation,
                &record(
                    "broad",
                    InteractionRequest::ClientCapability {
                        tool_use_id: "repl".into(),
                        target: api::target(),
                        basis: Some(basis),
                    },
                ),
            )
            .await
            .unwrap();
        store
            .commit_interaction_outcome(
                "broad",
                InteractionOutcome::ClientCapabilityDecision {
                    decision: Decision::Allow,
                    committed_at: 3,
                },
            )
            .await
            .unwrap();
        store
            .establish_run_interaction(
                &invocation,
                &record(
                    "app",
                    InteractionRequest::ComputerApp {
                        tool_use_id: "repl".into(),
                        native_operation_id: "native".into(),
                        target: app.clone(),
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
                "app",
                InteractionOutcome::ComputerAppDecision {
                    decision: ComputerAppDecision::Once,
                    committed_at: 3,
                },
            )
            .await
            .unwrap();
        let dispatch = EventWrite::plain(RuntimeEvent::new(
            invocation.clone(),
            Fact::ToolDispatched {
                presentation: None,
                title: None,
                operation_id: "native".into(),
                call: maka_agent_facts::tool_call::ToolCallIdentity::standalone(
                    "native-call".into(),
                ),
                name: "native-fixture".into(),
                input: serde_json::json!({}),
            },
        ))
        .unwrap();
        store
            .append_computer_app_dispatch(&[], &dispatch, &[api::target()], &app, &display, &basis)
            .await
            .unwrap();
        let parent = CancellationToken::new();
        let selected = Some((app.clone(), display.clone()));
        let (entered, started) = oneshot::channel();
        let (cleaning, cleanup_started) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let task_store = store.clone();
        let task_invocation = invocation.clone();
        let task_parent = parent.clone();
        let task_selected = selected.clone();
        let running = tokio::spawn(async move {
            settle(
                &task_store,
                &task_invocation,
                task_selected.as_ref(),
                task_parent,
                move |cancellation| async move {
                    let _ = entered.send(());
                    cancellation.cancelled().await;
                    let _ = cleaning.send(());
                    released.await.map_err(failed)?;
                    if unknown {
                        Err(ToolError::OutcomeUnknown(
                            "native effect outcome is unknown".into(),
                        ))
                    } else {
                        Err(failed("native promise cancelled and cleaned"))
                    }
                },
            )
            .await
        });
        started.await.unwrap();
        assert!(
            store
                .stop_computer_app_operation("native", 4)
                .await
                .unwrap()
        );
        tokio::time::timeout(std::time::Duration::from_secs(5), cleanup_started)
            .await
            .unwrap()
            .unwrap();
        assert!(
            !running.is_finished(),
            "Stop cannot acknowledge a promise before its cleanup completes"
        );
        assert!(
            !parent.is_cancelled(),
            "per-app Stop must not cancel the parent evaluation"
        );
        release.send(()).unwrap();
        let result = running.await.unwrap();
        if unknown {
            assert!(matches!(result, Err(ToolError::OutcomeUnknown(_))));
        } else {
            assert!(
                matches!(result,Err(ToolError::Failed(message)) if message.contains("stopped for this app"))
            );
        }
        let called = Arc::new(AtomicBool::new(false));
        let action_called = called.clone();
        assert!(
            settle(
                &store,
                &invocation,
                selected.as_ref(),
                parent.clone(),
                move |_| async move {
                    action_called.store(true, Ordering::Release);
                    Ok(Value::Null)
                }
            )
            .await
            .is_err()
        );
        assert!(
            !called.load(Ordering::Acquire),
            "a preexisting Stop must reject before invoking native work"
        );
        assert!(!parent.is_cancelled());
        root.close().await.unwrap();
    }
}

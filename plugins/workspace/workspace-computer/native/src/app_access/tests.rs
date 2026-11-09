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
use maka_agent_api::contract::{WorkspaceAccess, WorkspacePermissions};
use maka_agent_authority::computer::ComputerAppObservation;
use maka_agent_facts::interaction::{ComputerAppDisplay, ComputerAppPlatform, Decision};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::oneshot;

#[tokio::test]
async fn app_stop_cancels_only_its_original_promise_and_waits_for_real_cleanup() {
    for unknown in [false, true] {
        let fixture =
            crate::browser_access::tests::Fixture::with_permissions(WorkspacePermissions {
                access: WorkspaceAccess::WorkspaceWrite,
                request_permissions: true,
            })
            .await;
        fixture
            .decision("broad", api::target(), Decision::Allow, 2)
            .await;
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
        let original = fixture.call.operation.as_ref().unwrap();
        let operation = original.operation.to_string();
        fixture
            .call
            .authority
            .observe_app(
                original,
                ComputerAppObservation {
                    native_operation_id: operation.clone(),
                    target: app,
                    display,
                    allow_always: false,
                    capture: serde_json::json!({"adapter":"app-stop-fixture","nativeInput":false}),
                },
            )
            .await
            .unwrap();
        let record = fixture
            .call
            .authority
            .request_app(&operation)
            .await
            .unwrap();
        let answer = fixture
            .host
            .mutation_value(
                "respond",
                serde_json::json!({
                    "sessionId":fixture.execution.session_id,"requestId":record.request_id,
                    "answer":{"kind":"computer_app","decision":"once"}
                }),
            )
            .await
            .unwrap();
        assert_eq!(answer["kind"], "recorded");
        assert!(
            fixture
                .call
                .authority
                .authorize_app(&operation)
                .await
                .unwrap()
        );
        assert!(
            fixture
                .call
                .authority
                .app_status(&operation)
                .await
                .unwrap()
                .granted
        );
        let parent = fixture.call.scope.cancellation.child_token();
        let (entered, started) = oneshot::channel();
        let (cleaning, cleanup_started) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let task_call = fixture.call.clone();
        let task_operation = operation.clone();
        let task_parent = parent.clone();
        let running = tokio::spawn(async move {
            settle(
                &task_call,
                &task_operation,
                true,
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
        let stopped = fixture
            .host
            .mutation_value(
                "stopComputerApp",
                serde_json::json!({
                    "sessionId":fixture.execution.session_id,"operationId":operation
                }),
            )
            .await
            .unwrap();
        assert_eq!(stopped, serde_json::json!({"requested":true}));
        assert!(
            fixture
                .call
                .authority
                .app_status(&operation)
                .await
                .unwrap()
                .stopped
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
                &fixture.call,
                &operation,
                true,
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
        fixture.close().await;
    }
}
